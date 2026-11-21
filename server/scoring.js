/**
 * scoring.js —— 四维度本地量化评价器（改造规格 §4.5，无云端、全本地）
 *
 *   Sface  人脸/主体帧间稳定性      ·  固定中心区域结构代理（旁路人脸检测不参与此公式）
 *   Sflow  光流抖动/异常运动         ·  可用时实测 OpenCV Farneback，否则 ±10px SAD 块匹配代理
 *   Sstyle 首帧 Muse 电影风格相似度  ·  HSV 饱和度/对比度/青橙占比 与参考区间的距离
 *   Sbad   畸形/崩坏自动惩罚        ·  黑屏/过曝/纯色/闪烁/分辨率异常的规则检测
 *
 * 输出全部 0~1 归一化 + CSV 可用明细。
 * provenance 逐项标注：只有实际参与公式的已测光流可标 measured；
 * 中心结构、风格、惩罚、细节稳定度均为 rule-proxy，不代表身份/真实细节保真度。
 */
'use strict';

const fs = require('node:fs');
const QUALITY = require('./quality.js');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FFMPEG = process.env.AVP_FFMPEG || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';
const PYTHON = process.env.AVP_PYTHON || 'python';
const DETAIL = require('./detail.js');
const CV_SCRIPT = path.join(__dirname, '..', 'tools', 'score_cv.py');

/**
 * OpenCV 真实光流指标（可选增强后端）。
 * 为什么走 Python：Node 没有 OpenCV；系统 Python 已装 cv2 5.0，且不污染 ComfyUI venv。
 * 失败返回 null，调用方回退到块匹配代理 —— 不因为可选后端失败而让整个评分挂掉。
 */
function cvMetrics(file) {
  try {
    const r = spawnSync(PYTHON, ['-X', 'utf8', CV_SCRIPT, file, '24'], {
      encoding: 'utf8', timeout: 120000, env: { ...process.env, PYTHONUTF8: '1' },
    });
    if (r.status !== 0 || !r.stdout) return null;
    const j = JSON.parse(r.stdout);
    return j && j.flow ? j : null;
  } catch { return null; }
}
const FFPROBE = process.env.AVP_FFPROBE || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffprobe.exe';
const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,r_frame_rate,duration:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw Object.assign(new Error('ffprobe 失败：' + (r.stderr || '').slice(0, 200)), { code: 'SCORE_PROBE_FAILED' });
  const j = JSON.parse(r.stdout || '{}');
  const st = (j.streams && j.streams[0]) || {};
  const rate = (s) => { const [a, b = 1] = String(s || '').split('/').map(Number); const n = a / b; return Number.isFinite(n) && n > 0 ? n : null; };
  const fps = rate(st.avg_frame_rate) || rate(st.r_frame_rate); // 读取失败不编造 24fps
  return { width: Number(st.width) || 0, height: Number(st.height) || 0, fps, duration: Number(st.duration || (j.format && j.format.duration) || 0) };
}

/**
 * 抽帧为 rgb24 原始像素（不落盘，直接读 stdout）。
 * @returns {{w:number,h:number,frames:Buffer[],meta:object}}
 */
function extract(file, opts = {}) {
  const meta = probe(file);
  const count = Math.max(2, Number(opts.count || 12));
  const W = Math.max(64, Number(opts.width || 240));
  const dur = meta.duration || 1;
  const fps = Math.max(0.5, count / dur);
  const h = Math.max(2, Math.round(meta.height * W / meta.width / 2) * 2);
  if (!Number.isFinite(h)) throw Object.assign(new Error('视频尺寸不可读'), { code: 'SCORE_BAD_DIMENSIONS' });
  const args = ['-v', 'error', '-i', file, '-vf', `fps=${fps.toFixed(3)},scale=${W}:${h}`, '-frames:v', String(count), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  const r = spawnSync(FFMPEG, args, { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw Object.assign(new Error('ffmpeg 抽帧失败：' + String(r.stderr || '').slice(0, 200)), { code: 'SCORE_EXTRACT_FAILED' });
  const buf = r.stdout;
  const frameSize = W * h * 3;
  if (buf.length % frameSize) throw Object.assign(new Error('抽帧像素数据不完整'), { code: 'SCORE_EXTRACT_FAILED' });
  const frames = [];
  for (let i = 0; i < count; i += 1) {
    const s = i * frameSize;
    if (s + frameSize <= buf.length) frames.push(buf.subarray(s, s + frameSize));
  }
  return { w: W, h, frames, meta };
}

function lumaAt(f, w, h, x, y) { const i = (y * w + x) * 3; return 0.2126 * f[i] + 0.7152 * f[i + 1] + 0.0722 * f[i + 2]; }

/** 全局亮度统计 + 过曝/黑屏占比。 */
function statsFrame(f, w, h) {
  let sum = 0, sum2 = 0, dark = 0, over = 0, n = 0;
  const step = 3;
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const L = lumaAt(f, w, h, x, y);
    sum += L; sum2 += L * L; n += 1;
    if (L < 12) dark += 1;
    if (L > 244) over += 1;
  }
  const mean = sum / n;
  const varr = Math.max(0, sum2 / n - mean * mean);
  return { mean, std: Math.sqrt(varr), dark: dark / n, over: over / n };
}

/** 抽样像素的边缘强度/拉普拉斯 RMS；仅规则代理，不是重建保真度。 */
function sharpnessFrame(f, w, h) {
  let edges = 0, lap2 = 0, n = 0;
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
    const c = lumaAt(f, w, h, x, y);
    const l = lumaAt(f, w, h, x - 1, y), r = lumaAt(f, w, h, x + 1, y);
    const u = lumaAt(f, w, h, x, y - 1), d = lumaAt(f, w, h, x, y + 1);
    edges += Math.hypot(r - l, d - u) / 2;
    lap2 += (l + r + u + d - 4 * c) ** 2;
    n++;
  }
  return { edge: edges / Math.max(1, n), sharpness: Math.sqrt(lap2 / Math.max(1, n)) };
}

/** 中心区域结构稳定度：中心 40% 区域逐像素差 + 边缘密度稳定。 */
function centerStability(fa, fb, w, h) {
  const x0 = Math.round(w * 0.3), x1 = Math.round(w * 0.7), y0 = Math.round(h * 0.2), y1 = Math.round(h * 0.85);
  let diff = 0, n = 0;
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    diff += Math.abs(lumaAt(fa, w, h, x, y) - lumaAt(fb, w, h, x, y)); n += 1;
  }
  const madDiff = diff / Math.max(1, n);   // 0..255
  const edgeDensity = (f) => {
    let e = 0, m = 0;
    for (let y = y0; y < y1 - 2; y += 2) for (let x = x0; x < x1 - 2; x += 2) {
      const gx = lumaAt(f, w, h, x + 2, y) - lumaAt(f, w, h, x, y);
      const gy = lumaAt(f, w, h, x, y + 2) - lumaAt(f, w, h, x, y);
      e += Math.hypot(gx, gy); m += 1;
    }
    return e / Math.max(1, m);
  };
  const e1 = edgeDensity(fa), e2 = edgeDensity(fb);
  const edgeStable = 1 - Math.min(1, Math.abs(e1 - e2) / Math.max(1, (e1 + e2) / 2 + 1e-6));
  const structure = Math.max(0, 1 - madDiff / 48);  // 中心区域 MAD 越小越稳
  return { structure, edgeStable, madDiff, edge1: e1, edge2: e2 };
}

/** 块匹配位移：中心块在 ±r 内找最小 SAD。 */
function blockShift(fa, fb, w, h, r = 10) {
  const bx = Math.round(w * 0.35), by = Math.round(h * 0.3), bw = Math.round(w * 0.3), bh = Math.round(h * 0.4);
  let best = { sad: Infinity, dx: 0, dy: 0 };
  for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
    let sad = 0, n = 0;
    for (let y = by; y < by + bh; y += 3) for (let x = bx; x < bx + bw; x += 3) {
      const x2 = x + dx, y2 = y + dy;
      if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
      sad += Math.abs(lumaAt(fa, w, h, x, y) - lumaAt(fb, w, h, x2, y2)); n += 1;
    }
    sad /= Math.max(1, n);
    if (sad < best.sad) best = { sad, dx, dy };
  }
  return best;
}

function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let hh = 0;
  if (d > 1e-6) {
    if (mx === r) hh = ((g - b) / d) % 6;
    else if (mx === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60; if (hh < 0) hh += 360;
  }
  return { h: hh, s: mx === 0 ? 0 : d / mx, v: mx / 255 };
}

/** Muse 青橙参考：低饱和、暖肤冷背景、轻颗粒。返回相似度 0..1。 */
function styleScore(f, w, h) {
  let sSum = 0, vSum = 0, v2 = 0, teal = 0, orange = 0, n = 0;
  for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
    const i = (y * w + x) * 3;
    const { h: hh, s, v } = rgb2hsv(f[i], f[i + 1], f[i + 2]);
    sSum += s; vSum += v; v2 += v * v; n += 1;
    if (s > 0.08) {
      if (hh >= 160 && hh <= 210) teal += 1;
      if (hh >= 15 && hh <= 45) orange += 1;
    }
  }
  const sat = sSum / n, v = vSum / n, contrast = Math.sqrt(Math.max(0, v2 / n - v * v));
  const tealR = teal / n, orangeR = orange / n;
  // 参考区间（来自 Muse 成片观感，非实测阈值）：sat .12–.38 / contrast .12–.45 / 青橙 >0.04
  const band = (x, lo, hi) => (x < lo ? Math.max(0, 1 - (lo - x) / (lo || 1)) : x > hi ? Math.max(0, 1 - (x - hi) / (hi || 1)) : 1);
  const s1 = band(sat, 0.12, 0.38), s2 = band(contrast, 0.12, 0.45);
  const s3 = Math.min(1, (tealR + orangeR) / 0.12);
  const score = 0.4 * s1 + 0.3 * s2 + 0.3 * s3;
  return { score, sat, contrast, teal: tealR, orange: orangeR };
}

/**
 * 给一个视频打分。
 * @param {{file:string, weights?:object, count?:number}} o
 */
function scoreVideo(o = {}) {
  if (String(o.sample_kind || '').toLowerCase() === 'enhanced') throw Object.assign(new Error('实验评分只接受原生纯净样本，禁止增强版参与目标函数'), { code: 'SCORE_ENHANCED_FORBIDDEN' });
  const job = o.job || {};
  const file = o.pure_output || job.pure_output || o.raw_file || o.file;
  if (!file || !fs.existsSync(file)) throw Object.assign(new Error('视频不存在：' + file), { code: 'SCORE_NO_FILE' });
  const { w, h, frames, meta } = extract(file, { count: o.count || 12 });
  if (frames.length < 2) throw Object.assign(new Error('抽帧不足 2 张，无法评分'), { code: 'SCORE_TOO_FEW_FRAMES' });

  const cv = o.useCV === false ? null : cvMetrics(file);
  // 退化检测：解决「纯噪声被判高分」（2026-11-20 实测：噪声 F=0.68 > 好片 F=0.35）
  const det = (o.detail === false || process.env.AVP_DETAIL === '0') ? null : (() => { try { return DETAIL.inspectVideo(file); } catch { return null; } })();
  const st = frames.map((f) => statsFrame(f, w, h));
  const stabs = [];
  const shifts = [];
  for (let i = 1; i < frames.length; i += 1) {
    stabs.push(centerStability(frames[i - 1], frames[i], w, h));
    shifts.push(blockShift(frames[i - 1], frames[i], w, h, 10));
  }
  const meanSlit = stabs.reduce((a, b) => a + b.structure, 0) / stabs.length;
  const meanEdge = stabs.reduce((a, b) => a + b.edgeStable, 0) / stabs.length;
  const Sface = Math.max(0, Math.min(1, 0.7 * meanSlit + 0.3 * meanEdge));

  const dxs = shifts.map((s) => s.dx), dys = shifts.map((s) => s.dy);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  const varr = (a) => { const m = mean(a); return mean(a.map((x) => (x - m) ** 2)); };
  const jitter = Math.sqrt(varr(dxs) + varr(dys));          // px
  const drift = Math.abs(mean(dxs));
  let Sflow, flowProv = 'rule-proxy';
  const measuredFlow = !!(cv && cv.flow && Number.isFinite(cv.flow.jitter) && cv.flow.jitter >= 0 && Number.isFinite(cv.flow.big_ratio) && cv.flow.big_ratio >= 0);
  if (measuredFlow) {
    // 真光流：抖动小 + 异常大位移少 → 高。阈值来自 H3 实拍样片（jitter 0.4–3，big_ratio 0.1–0.8）。
    Sflow = Math.max(0, Math.min(1, Math.exp(-cv.flow.jitter / 1.5) * Math.exp(-Math.max(0, cv.flow.big_ratio - 0.55) / 0.35)));
    flowProv = 'measured(opencv-farneback)';
  } else {
    Sflow = Math.max(0, Math.min(1, Math.exp(-jitter / 2.5) * Math.exp(-Math.max(0, drift - 6) / 12)));
  }

  const sty = styleScore(frames[0], w, h);
  const Sstyle = Math.max(0, Math.min(1, sty.score));

  // Sbad：黑屏 / 过曝 / 纯色 / 闪烁
  const darkMean = mean(st.map((s) => s.dark));
  const overMean = mean(st.map((s) => s.over));
  const stdMean = mean(st.map((s) => s.std));
  const flick = mean(st.slice(1).map((s, i) => Math.abs(s.mean - st[i].mean)));
  let Sbad = 0;
  if (darkMean > 0.5) Sbad += 0.4;
  if (overMean > 0.4) Sbad += 0.3;
  if (stdMean < 6) Sbad += 0.3;
  if (flick > 22) Sbad += 0.3;
  Sbad = Math.min(1, Sbad);
  // 画面退化（噪声/无结构）属灾难性崩坏：抬到 0.95，F 随之下压 —— 这是修正「奖励噪声」的关键一项。
  const SbadFinal = det && det.degenerate ? Math.max(Sbad, 0.95) : Sbad;

  const sharp = frames.map((f) => sharpnessFrame(f, w, h));
  const edge = mean(sharp.map((s) => s.edge)), sharpness = mean(sharp.map((s) => s.sharpness));
  const stability = (key) => 1 - Math.min(1, mean(sharp.slice(1).map((s, i) => Math.abs(s[key] - sharp[i][key]) / Math.max(1, (s[key] + sharp[i][key]) / 2))));
  const edgeStable = stability('edge'), sharpStable = stability('sharpness');
  const detailScore = Math.max(0, Math.min(1, (Math.min(1, edge / 24) + Math.min(1, sharpness / 64)) / 2 * (edgeStable + sharpStable) / 2));
  const BAYES = require('./bayes.js');
  const policyWeights = QUALITY.scoringWeights();
  const weights = Object.fromEntries(['Sface', 'Sflow', 'Sstyle', 'Sbad'].map((key, i) => {
    const legacy = 'w' + (i + 1);
    const value = Number((o.weights || {})[key] ?? (o.weights || {})[legacy] ?? policyWeights[key] ?? policyWeights[legacy]);
    if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error('评分权重无效：' + key), { code: 'SCORE_BAD_WEIGHTS' });
    return [legacy, value];
  }));
  let F = BAYES.objective({ Sface, Sflow, Sstyle, Sbad: SbadFinal }, weights);
  // 退化（噪声/无结构）不是扣一点分，而是没有资格参与排名：总分压到 <=0.15。
  if (det && det.degenerate) F = Math.min(F, 0.15);
  const suppliedOutputFps = Number(o.output_fps ?? (job.enhanced && job.enhanced.output_fps));
  const outputFps = Number.isFinite(suppliedOutputFps) && suppliedOutputFps > 0 ? suppliedOutputFps : null;

  return {
    file, meta, sample_kind: 'native', frames: frames.length, size: { w, h },
    resolution: { width: meta.width, height: meta.height }, native_fps: meta.fps, output_fps: outputFps,
    detail_score: detailScore, temporal_stability_score: Sflow,
    scores: { Sface, Sflow, Sstyle, Sbad: SbadFinal }, F, weights,
    detail: {
      sharpness: { edge, sharpness, edge_stable: edgeStable, sharpness_stable: sharpStable, sample_resolution: { width: w, height: h }, note: '抽样缩放帧的边缘/锐度及帧间稳定规则代理；无参考真值，噪声也可能增加锐度，不代表真实细节保真度' },
      face: { structure: meanSlit, edge_stable: meanEdge, mad_px: mean(stabs.map((s) => s.madDiff)) },
      flow: { jitter_px: jitter, drift_px: drift, mean_sad: mean(shifts.map((s) => s.sad)), cv: cv ? cv.flow : null },
      style: sty,
      bad: { dark_ratio: darkMean, over_ratio: overMean, std: stdMean, flicker: flick },
      degeneration: det,
    },
    cv: cv ? { flow: cv.flow, luma: cv.luma, faces: cv.faces, backend: cv.backend, version: cv.cv_version } : null,
    degeneration: det,
    provenance: {
      Sface: 'rule-proxy', // cv.faces 仅旁路诊断；Sface 公式仍是中心区域代理。
      Sflow: flowProv, Sstyle: 'rule-proxy', Sbad: det ? 'measured(ffmpeg-gray+sobel)' : 'rule-proxy',
      detail_score: 'rule-proxy', temporal_stability_score: flowProv,
    },
    not_measured: ['68 点人脸关键点/身份保真度（未用于 Sface）', ...(!measuredFlow ? ['稠密光流（当前为块匹配近似）'] : []), 'VL 风格打分（需视觉模型）', '真实细节保真度（无参考真值）'],
    note: measuredFlow ? 'Sflow/temporal_stability_score 来自实测 OpenCV Farneback 光流的规则归一化；Sface 仍为中心区域代理（未用 faces），Sstyle/Sbad/detail_score 为规则代理。增强版不得参与实验评分。' : 'Sface/Sflow/Sstyle/Sbad/detail_score 均为本地规则代理，非人脸身份/真实细节保真度；temporal_stability_score=Sflow。增强版不得参与实验评分。',
  };
}

/** 批量评分并写 CSV（打分器相关性预校验与实验表格共用）。 */
function scoreMany(items, outCsv) {
  const rows = items.map((it) => scoreVideo(it));
  const header = ['file', 'Sface', 'Sflow', 'Sstyle', 'Sbad', 'F', 'jitter_px', 'drift_px', 'sat', 'contrast', 'dark', 'over', 'flicker'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.file, r.scores.Sface.toFixed(4), r.scores.Sflow.toFixed(4), r.scores.Sstyle.toFixed(4), r.scores.Sbad.toFixed(4), r.F.toFixed(4), r.detail.flow.jitter_px.toFixed(2), r.detail.flow.drift_px.toFixed(2), r.detail.style.sat.toFixed(3), r.detail.style.contrast.toFixed(3), r.detail.bad.dark_ratio.toFixed(3), r.detail.bad.over_ratio.toFixed(3), r.detail.bad.flicker.toFixed(2)].join(','));
  }
  if (outCsv) { fs.mkdirSync(path.dirname(outCsv), { recursive: true }); fs.writeFileSync(outCsv, lines.join('\n') + '\n', 'utf8'); }
  return { rows, csv: outCsv || null, text: lines.join('\n') };
}

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
function scoreVideoAsync(options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { avpScore: true, options } });
    let message;
    worker.once('message', (m) => { message = m; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0 || !message) return reject(Object.assign(new Error('评分工作线程异常退出'), { code: 'SCORE_WORKER_FAILED' }));
      if (message.error) return reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      resolve(message.result);
    });
  });
}
if (!isMainThread && workerData && workerData.avpScore) {
  try { parentPort.postMessage({ result: scoreVideo(workerData.options) }); }
  catch (e) { parentPort.postMessage({ error: { code: e.code || 'SCORE_FAILED', message: e.message } }); }
}
module.exports = { scoreVideo, scoreVideoAsync, scoreMany, extract, probe, statsFrame, centerStability, blockShift, styleScore, FFMPEG, FFPROBE };
