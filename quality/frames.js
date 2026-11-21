'use strict';
/**
 * quality/frames.js —— 抽帧 + 四路指标（**一次** ffmpeg 调用全部算完）
 *
 * 为什么必须一次调用：
 *   逐帧起进程 = 每帧 30~80ms 启动开销，120 帧就要 5~10s，长片直接爆炸。
 *   这里用 split 把同一条解码流分两路，一次进程同时产出：
 *     ① signalstats + blackdetect + freezedetect：逐帧 YAVG/YDIF/SATAVG 与黑帧/冻结区间
 *     ② 160 宽灰度原始帧（pipe:1）：用来在 Node 里算**真·拉普拉斯方差**和帧间差
 *   选择"② 在 Node 里算"而不是"全用滤镜"的原因：
 *     ffmpeg 没有"求方差"的滤镜；convolution+signalstats 只能给均值（负值被 clamp，
 *     得到的不是方差）。下采样后自己算，数学口径干净、可解释，也拿到了逐帧帧号。
 *
 * 指标口径（与 inspector/index.html 的 frames[] 契约一一对应）：
 *   sharp        拉普拉斯方差 log 归一化到 0..1（越大越锐）
 *   flicker      |ΔYAVG|，单位 0..255 亮度级（越大越闪）
 *   flowResidual 下采样灰度帧的相邻帧平均绝对差，按 FLOW_RAW 映射到 0..0.32
 *                （对齐 inspector 折线的除数 0.32；注意它是"帧差代理"，不是真光流，见 docs 缺口）
 *   score        0..100 加权分 + 结构性缺陷封顶
 *   status       >=80 ok / >=65 warn / else bad（阈值与 inspector 第 286 行完全一致）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const WORK_DIR = path.join(CACHE_ROOT, 'avp', 'qc', 'work');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

/** 默认参数；所有阈值都在 docs/06-quality.md 里有出处与实测依据 */
const DEFAULTS = {
  width: 160,            // 分析宽度：160 宽已足够反映锐度/帧差，raw 体积可控（720p→284 高，45KB/帧）
  scaleFlags: 'area',    // 下采样算法：area=盒式平均（抗锯齿但会抹掉高频，需实测选型）
  blackY: 24,            // 黑帧：YAVG<=24（limited range 黑=16，留 8 级编码噪声余量；blackdetect 默认 pix_th=0.10≈25.5 同级）
  whiteY: 235,           // 白帧：YAVG>=235（limited range 白=235）
  flickerHard: 20,       // 闪烁硬阈值：相邻帧 YAVG 跳变 >=20 级（≈8% 画幅亮度）就是可感知的闪/切
  flowRaw: 3,            // 帧差显示映射：平均绝对差 3 级 → flowResidual 顶格 0.32（实测正常运动约 0.2-0.7 级）
  flowHard: 6,           // 帧差打分硬阈值：平均绝对差 6 级（≈硬切/大幅运动）时运动项归零
  flowCap: 0.32,         // inspector 折线除数，保持一致
  sharpLo: 6,            // 拉普拉斯方差 log 归一化下界（实测模糊段方差≈2.5，正常帧 130-190）
  sharpHi: 400,          // 上界（实测 720p 网格素材正常帧方差≈190）
  sharpBlurAt: 0.22,     // 锐度归一值低于此判模糊
  freezeMinSec: 0.1,     // 连续静止 >=0.1s 才算冻结（30fps 即 3 帧；单帧重复是正常动画）
  blackMinSec: 0.02,     // 黑场最短时长，1 帧也要抓
  staticEps: 0.05,       // 相邻帧平均绝对差 <0.05 级视为"完全相同"（仅用于判定锚点未变，实测同源静帧=0）
  anchorEps: 0.4,        // 与锚点的平均绝对差 <0.4 级视为"画面没动"（实测静帧噪声 0~0.2，慢运动每帧 0.13 但会累计超限）
  timeoutMs: 600000,
  statsFile: 'stats.txt',
};

const round = (v, n = 3) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerpInv = (v, lo, hi) => clamp01((v - lo) / (hi - lo || 1));

function meanDiff(a, b) {
  let acc = 0;
  for (let i = 0; i < a.length; i++) acc += Math.abs(a[i] - b[i]);
  return acc / a.length;
}

/** 拉普拉斯方差 + 相邻帧平均绝对差；返回原始值（未归一化） */
function frameMath(buf, w, h, prev) {
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      // 4 邻域拉普拉斯：中心 x4 减四邻。对边缘/纹理敏感，对整体亮度/渐变不敏感——这正是"清晰度"要的
      const v = 4 * buf[i] - buf[i - 1] - buf[i + 1] - buf[i - w] - buf[i + w];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  const lapVar = sum2 / n - mean * mean;
  let diff = 0;
  if (prev) {
    const len = w * h;
    let acc = 0;
    for (let i = 0; i < len; i++) acc += Math.abs(buf[i] - prev[i]);
    diff = acc / len;
  }
  return { lapVar, meanAbsDiff: diff };
}

/** 把 stderr 里的 blackdetect / freezedetect 区间解析出来（秒） */
function parseDetectors(err) {
  const black = [];
  const freeze = [];
  const reB = /black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g;
  const reS = /lavfi\.freezedetect\.freeze_start: ([\d.]+)/g;
  const reD = /lavfi\.freezedetect\.freeze_duration: ([\d.]+)/g;
  const reE = /lavfi\.freezedetect\.freeze_end: ([\d.]+)/g;
  let m;
  while ((m = reB.exec(err))) black.push({ start: +m[1], end: +m[2], duration: +m[3] });
  // freezedetect 三行是配套的，按出现顺序配对；注意"冻结延续到文件末尾"时 ffmpeg 只打 freeze_start，
  // 不打 duration/end（实测本机 9.0.2 就是如此），这种情况标记 open=true，由上层用末帧时间补 end
  const starts = [];
  while ((m = reS.exec(err))) starts.push(+m[1]);
  const durs = [];
  while ((m = reD.exec(err))) durs.push(+m[1]);
  const ends = [];
  while ((m = reE.exec(err))) ends.push(+m[1]);
  for (let k = 0; k < starts.length; k++) {
    const hasEnd = ends[k] !== undefined;
    const dur = durs[k] ?? (hasEnd ? ends[k] - starts[k] : null);
    freeze.push({ start: starts[k], end: hasEnd ? ends[k] : null, duration: dur, open: !hasEnd });
  }
  return { black, freeze };
}

/** 解析 metadata=print 输出：逐帧 YAVG/YDIF/SATAVG 等 */
function parseStats(file) {
  const rows = [];
  let cur = null;
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const fh = /^frame:(\d+)\s+pts:\S+\s+pts_time:([\d.]+)/.exec(line);
    if (fh) {
      cur = { frame: +fh[1], t: +fh[2] };
      rows.push(cur);
      continue;
    }
    const kv = /^lavfi\.signalstats\.([A-Z]+)=(-?[\d.]+)/.exec(line);
    if (kv && cur) cur[kv[1]] = +kv[2];
  }
  return rows;
}

/** 时间 -> 帧号（取 pts_time 不大于 t 的最后一帧） */
function timeToFrame(ptsTimes, t) {
  let lo = 0;
  let hi = ptsTimes.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ptsTimes[mid] <= t + 1e-6) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * 主入口：抽帧 + 指标 + 打分
 * @param {string} file
 * @param {object} opts 覆盖 DEFAULTS；另有 probe（复用已探针结果）与 fps/frameCount 兜底
 * @returns {Promise<object>}
 */
async function analyze(file, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const t0 = Date.now();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const statsPath = path.join(WORK_DIR, o.statsFile);
  try { fs.unlinkSync(statsPath); } catch { /* 首次运行没有旧文件，忽略 */ }

  const vf = [
    `[0:v]split=2[st][raw]`,
    `[st]signalstats,blackdetect=d=${o.blackMinSec}:pic_th=0.98:pix_th=0.10,` +
      `freezedetect=n=-60dB:d=${o.freezeMinSec},metadata=print:file=${o.statsFile}[stats]`,
    `[raw]scale=${o.width}:-2:flags=${o.scaleFlags},format=gray[gray]`,
  ].join(';');
  // 注意：statsFile 用相对路径 + cwd，绕开 Windows 盘符 "D:" 在 filtergraph 里被当成选项分隔符的坑
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'info', '-nostats', '-y', '-i', file,
    '-filter_complex', vf,
    '-map', '[stats]', '-f', 'null', '-',
    '-map', '[gray]', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ];

  const res = await new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { cwd: WORK_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let pending = 0;
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, o.timeoutMs);
    child.stdout.on('data', (b) => { chunks.push(b); pending += b.length; });
    child.stderr.on('data', (b) => { if (err.length < 4 * 1024 * 1024) err += b.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, err, spawnError: e }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, err, timedOut, stdout: Buffer.concat(chunks, pending) }); });
  });

  if (res.spawnError) {
    const code = res.spawnError.code === 'ENOENT' ? 'E_FFMPEG_MISSING' : 'E_FFMPEG_SPAWN';
    return { ok: false, code, message: '启动 ffmpeg 失败：' + res.spawnError.message,
      hint: '安装 ffmpeg 并加入 PATH，或 set FFMPEG_BIN=D:\\path\\ffmpeg.exe' };
  }
  if (res.timedOut) return { ok: false, code: 'E_FFMPEG_TIMEOUT', message: `ffmpeg 超时（${o.timeoutMs}ms）`, hint: '长片调大 opts.timeoutMs 或先切片' };
  if (res.status !== 0) {
    return { ok: false, code: 'E_FFMPEG_FAILED', message: `ffmpeg 退出码 ${res.status}`,
      hint: (res.err || '').trim().split(/\r?\n/).slice(-3).join(' | ') };
  }
  if (!fs.existsSync(statsPath)) return { ok: false, code: 'E_NO_STATS', message: '没有生成 signalstats 输出', hint: '检查 filter_complex 是否被平台转义破坏' };

  const stats = parseStats(statsPath);
  if (!stats.length) return { ok: false, code: 'E_NO_FRAMES', message: 'signalstats 没有产出任何帧', hint: '文件可能没有可解码的视频帧' };

  const raw = res.stdout;
  const frameCount = stats.length;
  if (raw.length % frameCount !== 0) {
    return { ok: false, code: 'E_RAW_MISALIGN', message: `raw 字节数 ${raw.length} 不能被帧数 ${frameCount} 整除`, hint: 'scale 输出高宽可能变了，检查 -2 对齐' };
  }
  const frameSize = raw.length / frameCount;
  const aw = o.width;
  const ah = frameSize / aw;
  if (!Number.isInteger(ah)) {
    return { ok: false, code: 'E_RAW_MISALIGN', message: `raw 帧尺寸 ${frameSize} 不是 ${aw} 的整数倍`, hint: '检查 scale 参数' };
  }

  const ptsTimes = stats.map((s) => s.t);
  const fps = o.fps || (ptsTimes.length > 1 ? Math.round((1 / (ptsTimes[ptsTimes.length - 1] - ptsTimes[0])) * (ptsTimes.length - 1) * 1000) / 1000 : 0);
  const det = parseDetectors(res.err);

  // ---- 逐帧指标 ----
  const frames = [];
  let prev = null;
  // 锚点静止检测的状态：anchor=当前"静止候选段"的基准帧
  let anchor = null;
  let runAnchor = -1;
  const rawRuns = [];
  for (let i = 0; i < frameCount; i++) {
    const buf = raw.subarray(i * frameSize, (i + 1) * frameSize);
    const m = frameMath(buf, aw, ah, prev);
    // 与段起点比，而不是只跟上一帧比：编码量化会让"同源静帧"的相邻差在 0~0.2 之间抖，
    // 慢速运动每帧也只差 0.13——只看相邻差无法区分，累计到锚点才分得开
    const dAnchor = anchor ? meanDiff(buf, anchor) : Infinity;
    if (dAnchor >= o.anchorEps) {
      if (runAnchor >= 0) rawRuns.push({ anchor: runAnchor, end: i - 1 });
      runAnchor = i;
      anchor = Buffer.from(buf);   // 必须复制：buf 是 raw 的视图，不复制会被后续帧覆盖
    }
    const st = stats[i];
    const yavg = st.YAVG ?? 0;
    const flicker = i === 0 ? 0 : Math.abs(yavg - (stats[i - 1].YAVG ?? yavg));
    // 锐度归一：log10(1+方差) 线性映射——方差跨两个数量级，线性映射会把清晰帧全压到 1
    const sharpNorm = lerpInv(Math.log10(1 + m.lapVar), Math.log10(1 + o.sharpLo), Math.log10(1 + o.sharpHi));
    const flowResidual = Math.min(o.flowCap, (m.meanAbsDiff / o.flowRaw) * o.flowCap);
    const flowNorm = clamp01(1 - m.meanAbsDiff / o.flowHard);
    const flickerNorm = clamp01(1 - flicker / o.flickerHard);
    // 权重来源：锐度是"能不能用"的第一判据(0.45)，闪烁是"能不能播"的硬伤(0.35)，运动残差只做辅助(0.20)
    let score = 100 * (0.45 * sharpNorm + 0.35 * flickerNorm + 0.20 * flowNorm);
    const reasons = [];
    let defect = null;

    if (yavg <= o.blackY) { score = Math.min(score, 10); defect = 'dark'; reasons.push('黑帧'); }
    if (yavg >= o.whiteY) { score = Math.min(score, 15); defect = 'white'; reasons.push('白帧'); }
    if (sharpNorm < o.sharpBlurAt && defect !== 'dark' && defect !== 'white') { score = Math.min(score, 45); defect = 'blur'; reasons.push('模糊'); }
    else if (sharpNorm < o.sharpBlurAt) { reasons.push('模糊'); }
    if (flicker >= o.flickerHard) { score = Math.min(score, 60); if (!defect) defect = 'flicker'; reasons.push(`亮度跳变 ${flicker.toFixed(1)}`); }
    score = Math.round(Math.min(99, Math.max(1, score)));
    const status = score >= 80 ? 'ok' : score >= 65 ? 'warn' : 'bad';

    frames.push({
      frame: i,
      score,
      sharp: round(sharpNorm, 4),
      flicker: round(flicker, 2),
      flowResidual: round(flowResidual, 4),
      defect,
      status,
      repaired: false,
      extra: {
        yavg: round(yavg, 2),
        ymin: st.YMIN ?? null,
        ymax: st.YMAX ?? null,
        satavg: round(st.SATAVG ?? 0, 2),
        ydif: round(st.YDIF ?? 0, 2),
        lapVar: round(m.lapVar, 2),
        meanAbsDiff: round(m.meanAbsDiff, 3),
        diffAnchor: Number.isFinite(dAnchor) ? round(dAnchor, 3) : null,
        reasons,
      },
    });
    prev = buf;
  }
  if (runAnchor >= 0) rawRuns.push({ anchor: runAnchor, end: frameCount - 1 });

  // ---- 静止/冻结：与锚点几乎一致的连续段（>=freezeMinSec），逐帧落到帧号 ----
  // 为什么不用 freezedetect 的结果直接打标：它按 -60dB 判"近乎不动"，对缓慢运镜会误报
  // （本项目的正常素材就出现了 5 段 0.1s 假冻结），所以它只做交叉验证，见 detect.freeze。
  const minStaticFrames = Math.max(3, Math.round(fps * o.freezeMinSec));
  const staticRuns = [];
  for (const r of rawRuns) {
    const duplicated = r.end - r.anchor;   // 与锚点相同的帧数（不含锚点本身）
    if (duplicated >= minStaticFrames) {
      staticRuns.push({ start: r.anchor + 1, end: r.end, frames: duplicated, anchor: r.anchor });
    }
  }
  const frozen = new Set();
  for (const r of staticRuns) for (let i = r.start; i <= r.end; i++) frozen.add(i);
  for (const i of frozen) {
    const f = frames[i];
    f.extra.freeze = true;
    f.extra.reasons.push('冻结');
    f.score = Math.min(f.score, 30);
    if (f.defect !== 'dark' && f.defect !== 'white') f.defect = 'freeze';
    f.status = f.score >= 80 ? 'ok' : f.score >= 65 ? 'warn' : 'bad';
  }

  // 区间映射回帧号（blackdetect / freezedetect 作为交叉验证，写进 detect 而不是覆盖逐帧结论）
  // 区间是半开区间 [start,end)：end - 1e-3 才能落到最后一帧而不是下一帧（fps<=100 时半帧>5ms）
  const lastPts = ptsTimes[ptsTimes.length - 1];
  const toRange = (iv) => {
    const end = iv.end === null || iv.end === undefined ? lastPts : iv.end;
    return {
      startFrame: timeToFrame(ptsTimes, iv.start + 1e-4),
      // 延续到末尾的冻结直接收到最后一帧（用 end-1e-3 会因为末帧时间被截掉一帧）
      endFrame: iv.open ? frameCount - 1 : timeToFrame(ptsTimes, end - 1e-3),
      start: round(iv.start, 3),
      end: round(end, 3),
      duration: round(iv.duration !== null && iv.duration !== undefined ? iv.duration : end - iv.start, 3),
      open: !!iv.open,
    };
  };

  return {
    ok: true,
    code: 'OK',
    file,
    analysis: { width: aw, height: ah, frameSize, frames: frameCount, fps },
    detect: {
      black: det.black.map(toRange),
      freeze: det.freeze.map(toRange),
      white: frames.filter((f) => f.extra.yavg >= o.whiteY).map((f) => f.frame),
      staticRuns,
      blackFrames: frames.filter((f) => f.extra.yavg <= o.blackY).map((f) => f.frame),
      frozenFrames: [...frozen].sort((a, b) => a - b),
    },
    thresholds: { blackY: o.blackY, whiteY: o.whiteY, flickerHard: o.flickerHard, sharpBlurAt: o.sharpBlurAt,
      sharpLo: o.sharpLo, sharpHi: o.sharpHi, flowRaw: o.flowRaw, flowCap: o.flowCap,
      freezeMinSec: o.freezeMinSec, staticEps: o.staticEps,
      scoreWeights: { sharp: 0.45, flicker: 0.35, flow: 0.20 },
      statusCut: { ok: 80, warn: 65 } },
    frames,
    timing: { ffmpegMs: Date.now() - t0, totalMs: Date.now() - t0 },
  };
}

module.exports = { analyze, DEFAULTS, WORK_DIR, frameMath };

if (require.main === module) {
  (async () => {
    const file = process.argv[2];
    const r = await analyze(file, {});
    if (!r.ok) {
      console.error(`[frames] ${r.code}: ${r.message}` + (r.hint ? `\n         ${r.hint}` : ''));
      process.exit(2);
    }
    const f = r.frames;
    const avg = (k) => (f.reduce((a, b) => a + b[k], 0) / f.length).toFixed(3);
    console.log(`${path.basename(file)}  ${r.analysis.width}x${r.analysis.height} 灰阶 · ${r.analysis.frames} 帧 · ${r.timing.totalMs}ms`);
    console.log(`  score 均值 ${avg('score')} · sharp 均值 ${avg('sharp')} · flicker 均值 ${avg('flicker')} · flow 均值 ${avg('flowResidual')}`);
    console.log(`  黑帧 ${r.detect.blackFrames.length} · 白帧 ${r.detect.white.length} · 冻结 ${r.detect.frozenFrames.length} · 静止段 ${r.detect.staticRuns.map((x) => `${x.start}-${x.end}`).join(',') || '无'}`);
    console.log(`  blackdetect ${JSON.stringify(r.detect.black)}`);
    console.log(`  freezedetect ${JSON.stringify(r.detect.freeze)}`);
  })();
}