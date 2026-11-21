#!/usr/bin/env node
/**
 * snap_quality.mjs —— 质检入口的快照生成器
 *
 * 为什么需要这个脚本：
 *   quality/index.html 是 file:// 双击打开的静态页，不能 fetch 本地 JSON（CORS 会拦死），
 *   页面上的每个数字都必须在构建期就固化进 window.__SNAP。
 *   于是「跑一次真实管线，把结论落成快照」必须有一个独立入口，而不是在页面里编数字。
 *
 * 数据链（一步都不跳）：
 *   quality/fixtures.js  generate()  用 ffmpeg 现场合成 good / bad 两条已知答案素材
 *   quality/probe.js     probe()     ffprobe 抽元数据（分辨率/fps/帧数来源/pix_fmt/音轨）
 *   quality/frames.js    analyze()   一次 ffmpeg 解码 → 逐帧四路指标 + 区间检测
 *   quality/report.js    build()     汇总成 status 计数 / problems / worst / segments
 *   本脚本                           再把上述真实结果整理成页面要读的形态
 *
 * 两条路径，绝不混：
 *   real       本机有 ffmpeg/ffprobe → 全部数字来自真实解码，页面标「real」
 *   synthetic  探测不到 ffmpeg      → 只写「管线口径 + 阈值 + 报告结构」，不写任何帧数据，页面标「synthetic」
 *   判定依据：先 probe.version() 探 ffprobe，再试 fixtures.generate()；任一环节失败直接降级，
 *   宁可让页面显示"本页为口径说明"，也不伪造帧号与分数。
 *
 * 写盘：quality/snapshot.json（唯一产物；测试素材按管线约定落在 %CACHE_ROOT%\avp\qc，属缓存区）
 *
 * 跑法：
 *   node tools/snap_quality.mjs            # 有快照则复用测试素材，只重算分析
 *   node tools/snap_quality.mjs --force    # 重造测试素材（改了 fixtures.js 后用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const load = (f) => require(path.join(ROOT, 'quality', f));

const fixtures = load('fixtures.js');
const probeMod = load('probe.js');
const framesMod = load('frames.js');
const reportMod = load('report.js');

const OUT = path.join(ROOT, 'quality', 'snapshot.json');
const DEFAULTS = framesMod.DEFAULTS;
const FORCE = process.argv.includes('--force');

/* ── 阈值注解表 ──────────────────────────────────────────────────────
   取值一律从 frames.js 的 DEFAULTS 里读（数字不在本文件手写），
   这里只提供「它在判定链里干什么」和「代码里没写清楚的地方」。
   group: 分析 / 判定 / 冻结 / 运行 —— 页面按这个分组排表。 */
const T_META = {
  width:        { group: '分析', meaning: '分析宽度：解码后降采样到 160px 宽灰度帧，据此算锐度与帧差' },
  scaleFlags:   { group: '分析', meaning: '降采样算法：area=盒式平均（抗锯齿，但会抹掉一部分高频）' },
  blackY:       { group: '判定', meaning: '黑帧判定：YAVG ≤ 24（limited range 黑=16，留 8 级编码噪声余量）' },
  whiteY:       { group: '判定', meaning: '白帧判定：YAVG ≥ 235（limited range 白=235）' },
  flickerHard:  { group: '判定', meaning: '亮度跳变硬阈值：相邻帧 YAVG 差 ≥ 20 级（≈8% 画幅亮度）即判可感知闪/切' },
  flowRaw:      { group: '判定', meaning: '帧差显示映射：平均绝对差 3 级即让 flowResidual 顶格 0.32' },
  flowHard:     { group: '判定', meaning: '帧差打分硬阈值：平均绝对差 ≥ 6 级（硬切/大运动）时运动项得分归零' },
  flowCap:      { group: '判定', meaning: 'flowResidual 的上限，与 inspector 折线除数保持一致' },
  sharpLo:      { group: '判定', meaning: '拉普拉斯方差 log 归一化的下界（实测模糊段方差≈2.5）' },
  sharpHi:      { group: '判定', meaning: '拉普拉斯方差 log 归一化的上界（实测 720p 网格素材正常帧≈130-190）' },
  sharpBlurAt:  { group: '判定', meaning: '锐度归一值低于此判模糊，分数封顶 45' },
  freezeMinSec: { group: '冻结', meaning: '连续静止 ≥ 0.1s 才算冻结（30fps 即 3 帧）；单帧重复属正常动画' },
  blackMinSec:  { group: '冻结', meaning: '交给 blackdetect 的最短黑场时长，0.02s 起抓，1 帧也不放过' },
  staticEps:    { group: '冻结', meaning: '相邻帧平均绝对差 < 0.05 视为像素级完全相同',
                  dormant: true,
                  note: '声明的默认值：当前判定链路用的是 anchorEps（frames.js:229），本值只出现在 thresholds 输出里（frames.js:333），未参与逐帧判定。' },
  anchorEps:    { group: '冻结', meaning: '与"静止候选段"锚点的平均绝对差 < 0.4 视为画面没动（实测静帧噪声 0~0.2，慢运动每帧 0.13 但会累计超限）' },
  timeoutMs:    { group: '运行', meaning: '单次 ffmpeg 解码超时，超时返回 E_FFMPEG_TIMEOUT 而不是挂死' },
  statsFile:    { group: '运行', meaning: 'signalstats 逐帧输出的临时文件名（相对 work 目录，绕开 Windows 盘符在 filtergraph 里的转义坑）' },
};

/** 阈值附录：DEFAULTS 之外但同样参与判定的常量（来自 frames.js 正文，逐个核对过行号） */
const T_EXTRA = [
  { key: 'scoreWeights', value: 'sharp 0.45 · flicker 0.35 · flow 0.20', ref: 'frames.js:243',
    meaning: '综合分权重：锐度是"能不能用"的第一判据，闪烁是"能不能播"的硬伤，帧差只做辅助' },
  { key: 'statusCut', value: 'ok ≥ 80 · warn ≥ 65 · bad < 65', ref: 'frames.js:253',
    meaning: '三档分数切点，与 inspector 前端判定逐字一致（避免后台说 ok、前端标红）' },
  { key: 'scoreClamp', value: '结构缺陷封顶：黑 10 / 白 15 / 模糊 45 / 冻结 30 / 跳变 60', ref: 'frames.js:247-252,297',
    meaning: '命中结构性缺陷时分数直接被压到上限以内，不靠权重算——权重算不出"整帧全黑"这种事' },
  { key: 'minStaticFrames', value: 'max(3, round(fps × freezeMinSec))', ref: 'frames.js:283',
    meaning: '冻结段的最短帧数，由 fps 与 freezeMinSec 推出，不另设常量' },
  { key: 'anchorEps', value: DEFAULTS.anchorEps, ref: 'frames.js:229',
    meaning: '冻结判定的实际门限（与锚点比对）。它没有写进 analyze() 的 thresholds 输出（frames.js:331-335），下游要读只能回读 DEFAULTS' },
  { key: 'warningBy', value: '阈值改动路径：改 DEFAULTS → 重跑 node tools/snap_quality.mjs → 重跑 selftest', ref: 'docs/06-quality.md §2',
    meaning: '阈值是硬编码默认值：页面上所有阈值只读，改判定的唯一入口是改代码' },
];

/** docs/06-quality.md §7 的已知缺口：页面单列一栏，不与"检查项"混排 */
const GAPS = [
  { id: 'blur-calib', title: '模糊门限未做真机标定',
    detail: 'sharpBlurAt 0.22 对「轻微虚焦」是否够灵敏未标定；测试素材的模糊段锐度归零是 gblur sigma=14 的阈值效应，不代表真实失焦的水平。',
    ref: 'docs/06-quality.md §7-1' },
  { id: 'no-flow', title: 'flowResidual 不是真光流',
    detail: '它是相邻帧平均绝对差，会把握拍/快速平移当成高残差，靠 flowHard 归零兜住，不精确。',
    ref: 'docs/06-quality.md §7-2' },
  { id: 'no-audio', title: '无音频质检',
    detail: 'probe 只取音频参数（codec / 采样率 / 声道），astats 未接，不做响度、削波、静音检测。',
    ref: 'docs/06-quality.md §7-3' },
  { id: 'no-color', title: '无色彩质检',
    detail: '不做色偏、色带（banding）、gamma 异常检测；inspector 里的「色带断层」负向词目前没有指标支撑。',
    ref: 'docs/06-quality.md §7-4' },
  { id: 'no-bbox', title: '缺陷定位到帧，不定位到区域',
    detail: 'defect 只说 blur / flicker / dark / white / freeze，不给 bbox；框选重绘靠人工在 inspector 里拖框。',
    ref: 'docs/06-quality.md §7-5' },
  { id: 'no-parallel', title: '批量不做并行',
    detail: 'batch 逐条串行跑 ffmpeg，多片时 CPU 有空闲，未做 worker 池。',
    ref: 'docs/06-quality.md §7-6' },
];

/** report.js build() 产出的字段清单（页面"报告结构"栏用；synthetic 模式下这是主要内容） */
const REPORT_FIELDS = [
  { key: 'summary.status', type: '{ok,warn,bad}', note: '逐帧状态计数，页面顶部三枚徽标' },
  { key: 'summary.mean / p5 / p95 / min / max', type: 'number', note: '分数分布。p5 用线性插值，比单帧最小值稳（转场/编码抖动会拉低极值）' },
  { key: 'summary.worst[]', type: 'array', note: '分数最低的 N 帧，带 reasons（人话理由）与 suggestion（修复建议）' },
  { key: 'summary.segments[]', type: 'array', note: '连续问题帧按同一缺陷合并成段：start/end/frames/defect/defect_cn/score_avg' },
  { key: 'summary.problem_frames', type: 'number', note: 'status ≠ ok 的帧数' },
  { key: 'summary.redraw_plan[]', type: 'array', note: 'worst 的前 N 条压成「帧号 + 理由 + 建议」，直接当重绘工单' },
  { key: 'detect', type: 'object', note: 'blackdetect / freezedetect 区间（交叉验证）+ 逐帧命中的帧号集合' },
  { key: 'thresholds', type: 'object', note: '本次实际生效的阈值（可被 opts 覆盖，与 DEFAULTS 对照）' },
  { key: 'frames[]', type: 'array', note: '逐帧契约：frame/score/sharp/flicker/flowResidual/defect/status/extra，inspector/index.html 直接吃这份' },
];

/* ── 小工具 ─────────────────────────────────────────────────────── */
const round = (v, n = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** n) / 10 ** n : v);
const card = (s) => (s / 1024).toFixed(0) + 'KB';

function ffmpegVersion() {
  const r = spawnSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  const m = /ffmpeg version (\S+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

function thresholdsTable() {
  return Object.keys(DEFAULTS).map((key) => {
    const meta = T_META[key] || {};
    const v = DEFAULTS[key];
    return {
      key,
      value: typeof v === 'string' ? v : v,
      type: typeof v,
      group: meta.group || '其它',
      meaning: meta.meaning || '（代码里未加注解）',
      note: meta.note || null,
      dormant: !!meta.dormant,
      source: 'quality/frames.js DEFAULTS',
    };
  });
}

/* ── 检查项：每一条都必须能在代码里指出判定位置 ─────────────────────
   状态口径（与本项目 status 三档一致）：
     ok   未命中该缺陷
     bad  命中该缺陷（结构性缺陷不设 warn 档：黑帧 1 帧就是事故）
     na   管线尚未实现（如实标注，不冒充"通过"）
   warn 只出现在"参数合规"这种连续量上（帧数来源回退、fps 抖动）。 */
function buildChecks(pr, an, rep) {
  const f = an.frames;
  const th = an.thresholds;
  const det = an.detect;
  const blackFrames = det.blackFrames;
  const whiteFrames = det.white;
  const frozen = det.frozenFrames;
  const blurFrames = f.filter((x) => x.defect === 'blur').map((x) => x.frame);
  const flickerFrames = f.filter((x) => x.flicker >= th.flickerHard).map((x) => x.frame);
  const p = pr.video;
  const a = pr.audio;

  const minSharp = f.reduce((m, x) => (x.sharp < m ? x.sharp : m), 1);
  const maxFlicker = f.reduce((m, x) => (x.flicker > m ? x.flicker : m), 0);
  /* 帧号集合要按"连续段"写：freeze 的命中帧是 21-24 + 100-119，
     直接写 21–119 会让人以为是 99 帧，比不写更糟。 */
  const fmtRuns = (arr) => {
    if (!arr.length) return '—';
    const out = [];
    let s = arr[0];
    let p = arr[0];
    for (let i = 1; i < arr.length; i++) {
      if (arr[i] === p + 1) { p = arr[i]; continue; }
      out.push(s === p ? `${s}` : `${s}–${p}`);
      s = arr[i];
      p = arr[i];
    }
    out.push(s === p ? `${s}` : `${s}–${p}`);
    return out.join('、');
  };
  const fmtHit = (arr) => (arr.length ? `${arr.length} 帧（${fmtRuns(arr)}）` : '0 帧');
  const fmtIv = (ivs) => (ivs.length ? ivs.map((i) => `${i.start}s–${i.end}s`).join('，') : '0 段');
  // an.thresholds 不含 anchorEps（frames.js:331-335 没把它写进输出），冻结门限必须回读 DEFAULTS
  const anchorEps = DEFAULTS.anchorEps;

  /* 参数合规：只对"能判的"下判，不能判的如实写成记录 */
  const paramSubs = [
    { k: '画面', v: `${p.displayWidth}×${p.displayHeight} · ${p.codec}${p.profile ? ' ' + p.profile : ''} · ${p.pixFmt}` },
    { k: '帧率', v: `${p.fps} fps（avg ${p.avgFps}）` },
    { k: '帧数', v: `${p.nbFrames} 帧 · 来源 ${p.framesSource}` },
    { k: '色彩', v: `range=${p.colorRange || '未标注'} · space=${p.colorSpace || '未标注'}${p.hdr ? ' · HDR' : ''}${p.rotation ? ` · rotation=${p.rotation}` : ''}` },
    { k: '音轨', v: a ? `${a.codec} ${a.sampleRate}Hz ${a.channels}ch ${a.channelLayout || ''}`.trim() : '无音频流' },
    { k: '容器', v: `${pr.format.name} · ${card(pr.sizeBytes)}` },
  ];
  const paramWarn = [];
  if (p.framesSource === 'duration*fps') paramWarn.push('帧数回退到 duration×fps，属估算');
  if (Math.abs(p.fps - p.avgFps) > 0.01) paramWarn.push(`r_frame_rate 与 avg_frame_rate 不一致（${p.fps} vs ${p.avgFps}），疑似变帧率`);

  const status = rep.summary.status;
  const cut = th.statusCut;

  return [
    {
      id: 'black', name: '黑场 / 黑帧', status: blackFrames.length ? 'bad' : 'ok',
      threshold: `YAVG ≤ ${th.blackY}`, thresholdKey: 'blackY',
      actual: `${fmtHit(blackFrames)} · blackdetect ${fmtIv(det.black)}`,
      basis: 'frames.js:247 —— 每帧平均亮度 yavg ≤ blackY 判黑帧，分数封顶 10；blackdetect 区间只做交叉验证，不覆盖逐帧结论。',
      hits: blackFrames.length,
    },
    {
      id: 'white', name: '白屏 / 白帧', status: whiteFrames.length ? 'bad' : 'ok',
      threshold: `YAVG ≥ ${th.whiteY}`, thresholdKey: 'whiteY',
      actual: fmtHit(whiteFrames),
      basis: 'frames.js:248 —— yavg ≥ whiteY 判白帧（过曝/空镜），分数封顶 15。',
      hits: whiteFrames.length,
    },
    {
      id: 'freeze', name: '冻结（freeze）', status: frozen.length ? 'bad' : 'ok',
      threshold: `与锚点差 ≥ ${anchorEps} 视为画面变化；连续静止 ≥ ${th.freezeMinSec}s 判冻结`, thresholdKey: 'anchorEps',
      actual: `${fmtHit(frozen)} · 静止段 ${det.staticRuns.length} 段 · freezedetect 交叉验证 ${fmtIv(det.freeze)}`,
      basis: 'frames.js:283-300 —— 以"静止候选段锚点"累计帧差（只看相邻差区分不了编码噪声与慢速运镜），命中后分数封顶 30 并改写 defect=freeze。门限 anchorEps 未写进 thresholds 输出，本行从 DEFAULTS 回读。',
      hits: frozen.length,
    },
    {
      id: 'blur', name: '模糊（锐度）', status: blurFrames.length ? 'bad' : 'ok',
      threshold: `sharp < ${th.sharpBlurAt} 判模糊（log 归一，上下界 ${th.sharpLo}/${th.sharpHi}）`, thresholdKey: 'sharpBlurAt',
      actual: `${fmtHit(blurFrames)}判模糊 · 全片最低 sharp ${round(minSharp, 3)}`,
      basis: 'frames.js:249 —— 拉普拉斯方差 log 归一后的 sharpNorm 低于 sharpBlurAt 判模糊，分数封顶 45。',
      hits: blurFrames.length,
    },
    {
      id: 'flicker', name: '亮度跳变（闪烁）', status: flickerFrames.length ? 'bad' : 'ok',
      threshold: `相邻帧 |ΔYAVG| ≥ ${th.flickerHard}`, thresholdKey: 'flickerHard',
      actual: `${flickerFrames.length} 帧越线 · 全片最大跳变 ${round(maxFlicker, 2)} 级`,
      basis: 'frames.js:251 —— flicker ≥ flickerHard 判可感知闪/切，分数封顶 60；闪烁在权重里占 0.35，因为它直接决定能不能播。',
      hits: flickerFrames.length,
    },
    {
      id: 'params', name: '参数合规（元数据自洽）', status: paramWarn.length ? 'warn' : 'ok',
      threshold: '帧数必须可溯源；fps 与 avg_fps 必须一致', thresholdKey: null,
      actual: paramWarn.length ? paramWarn.join('；') : '帧数来源 nb_frames / nb_read_frames（实测），fps 与 avg_fps 一致',
      basis: 'probe.js:140-178 —— 只把 ffprobe 结果翻译成稳定字段，并把帧数标注为容器声明还是数出来的；回退到 duration×fps 时属估算，页面按 warn 处理。',
      subs: paramSubs,
      hits: paramWarn.length,
    },
    {
      id: 'audio', name: '音频静音', status: 'na', implemented: false,
      threshold: '未接入（astats 未接）', thresholdKey: null,
      actual: a ? `仅记录音轨参数：${a.codec} ${a.sampleRate}Hz ${a.channels}ch` : '该片无音频流，静音检查无从进行',
      basis: 'docs/06-quality.md §7 缺口 3 —— probe.js 只取音频参数，frames.js 不含任何音频指标；本行如实标「未实现」，不冒充通过。',
      hits: null,
    },
    {
      id: 'bands', name: '综合分三档（status）', status: status.bad ? 'bad' : status.warn ? 'warn' : 'ok',
      threshold: `ok ≥ ${cut.ok} · warn ≥ ${cut.warn} · bad < ${cut.warn}`, thresholdKey: 'statusCut',
      actual: `ok ${status.ok} / warn ${status.warn} / bad ${status.bad} · 问题帧 ${rep.summary.problem_frames}/${f.length}`,
      basis: 'frames.js:253 —— 综合分 = sharp×0.45 + flicker×0.35 + flow×0.20，再按三档切；切点与 inspector 前端逐字一致。',
      hits: status.bad,
    },
  ];
}

/* ── 覆盖率：把"检测到的帧号"和 fixtures.js 声明的注入帧号对一遍 ─────
   这是快照里唯一带 ground truth 的验证，页面用它说明"坏片的问题帧不是随便标的"。 */
function coverage(expected, detect, blurFrames) {
  if (!expected) return null;
  const within = (frames, range) => frames.filter((x) => x >= range[0] && x <= range[1]).length;
  const span = (range) => range[1] - range[0] + 1;
  return [
    { defect: 'dark', defect_cn: '黑帧', expect: `${expected.black[0]}–${expected.black[1]}`, total: span(expected.black), hit: within(detect.blackFrames, expected.black) },
    { defect: 'white', defect_cn: '白帧', expect: `${expected.white[0]}–${expected.white[1]}`, total: span(expected.white), hit: within(detect.white, expected.white) },
    { defect: 'blur', defect_cn: '模糊', expect: `${expected.blur[0]}–${expected.blur[1]}`, total: span(expected.blur), hit: within(blurFrames, expected.blur) },
    { defect: 'freeze', defect_cn: '冻结', expect: `${expected.freeze[0]}–${expected.freeze[1]}`, total: span(expected.freeze), hit: within(detect.frozenFrames, expected.freeze) },
  ];
}

/* ── 单个样片的完整结论 ─────────────────────────────────────────── */
async function sample(id, label, role, file, expected) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) return { id, label, role, file: name, ok: false, error: 'E_INPUT_MISSING', message: '测试素材不存在：' + file };

  const pr = probeMod.probe(file);
  if (!pr.ok) return { id, label, role, file: name, ok: false, error: pr.code, message: pr.message };

  const an = await framesMod.analyze(file, {});
  if (!an.ok) return { id, label, role, file: name, ok: false, error: an.code, message: an.message };

  const rep = reportMod.build(pr, an, { worstN: 12 });
  const fps = an.analysis.fps || 0;
  const cut = an.thresholds.statusCut;

  const segments = rep.summary.segments.map((s) => ({
    ...s,
    t0: fps ? round(s.start / fps, 3) : null,
    t1: fps ? round(s.end / fps, 3) : null,
    grade: s.score_avg < cut.warn ? 'bad' : 'warn',
  }));

  const worst = rep.summary.worst.map((w) => ({
    ...w,
    t: fps ? round(w.frame / fps, 3) : null,
    t_note: 'frame ÷ fps',
  }));

  // 总判：页面口径，规则写进快照，避免"页面判定"和"报告判定"两套说法
  const s = rep.summary.status;
  const verdict = s.bad > 0
    ? { key: 'fail', label: '不通过', tone: 'bad', rule: 'bad > 0 → 不通过' }
    : s.warn > 0
      ? { key: 'warn', label: '有警告', tone: 'warn', rule: 'bad = 0 且 warn > 0 → 有警告' }
      : { key: 'pass', label: '通过', tone: 'ok', rule: 'bad = 0 且 warn = 0 → 通过' };

  const top = worst[0] || null;
  // 通过片也会"有最差帧"（全片最弱的那一帧），但它不是待修项：problem_frames=0 时不许给工单
  const hasProblem = rep.summary.problem_frames > 0;

  return {
    id, label, role, file: name, ok: true,
    bytes: pr.sizeBytes,
    fps,
    frames: an.analysis.frames,
    analysisSize: `${an.analysis.width}×${an.analysis.height}`,
    verdict,
    headline: (hasProblem && top)
      ? `先修第 ${top.frame} 帧（t=${top.t}s）：${top.reasons[0] || top.defect_cn || '综合分偏低'}`
      : `无问题帧（${rep.summary.frames} 帧全部 ok）`,
    top_fix: (hasProblem && top) ? { frame: top.frame, t: top.t, defect: top.defect, defect_cn: top.defect_cn, reason: top.reasons.join('；'), suggestion: top.suggestion } : null,
    probe: {
      codec: pr.video.codec, profile: pr.video.profile, pixFmt: pr.video.pixFmt,
      displayWidth: pr.video.displayWidth, displayHeight: pr.video.displayHeight,
      fps: pr.video.fps, avgFps: pr.video.avgFps, duration: pr.video.duration,
      nbFrames: pr.video.nbFrames, framesSource: pr.video.framesSource,
      colorRange: pr.video.colorRange, colorSpace: pr.video.colorSpace, hdr: pr.video.hdr,
      rotation: pr.video.rotation,
      audio: pr.audio ? { codec: pr.audio.codec, sampleRate: pr.audio.sampleRate, channels: pr.audio.channels, channelLayout: pr.audio.channelLayout, bitrate: pr.audio.bitrate } : null,
      format: pr.format.name, sizeBytes: pr.sizeBytes,
      ffprobe: pr.meta.ffprobe, tookMs: pr.meta.tookMs,
    },
    summary: {
      mean: rep.summary.mean, p5: rep.summary.p5, p95: rep.summary.p95,
      min: rep.summary.min, max: rep.summary.max,
      frames: rep.summary.frames, problems: rep.summary.problem_frames,
      status: rep.summary.status,
      segments, worst,
      worst_shown: worst.length,
    },
    detect: {
      black: an.detect.black,
      freeze: an.detect.freeze,
      staticRuns: an.detect.staticRuns,
      black_frames: an.detect.blackFrames.length,
      white_frames: an.detect.white.length,
      frozen_frames: an.detect.frozenFrames.length,
    },
    checks: buildChecks(pr, an, rep),
    coverage: coverage(expected, an.detect, an.frames.filter((x) => x.defect === 'blur').map((x) => x.frame)),
    timing: { ffmpegMs: an.timing.ffmpegMs },
    generated_from: 'probe → frames → report（单次 ffmpeg 解码）',
  };
}

/* ── 主流程 ─────────────────────────────────────────────────────── */
function ok(reason) { return { real: true, reason }; }

async function main() {
  const ffmpeg = ffmpegVersion();
  const ffprobe = probeMod.version();
  const env = {
    ffmpeg, ffprobe,
    ffmpeg_bin: process.env.FFMPEG_BIN || 'ffmpeg',
    ffprobe_bin: process.env.FFPROBE_BIN || 'ffprobe',
    cache_root: fixtures.CACHE_ROOT,
    fixture_dir: fixtures.FIX_DIR,
    node: process.version,
    platform: process.platform,
  };

  const base = {
    tool: 'avp-qc-snap',
    schema: 'quality.snapshot/1',
    generated_at: new Date().toISOString(),
    env,
    sources: {
      snapshot: 'quality/snapshot.json',
      report: 'quality/report.js build()',
      frames: 'quality/frames.js analyze()',
      probe: 'quality/probe.js probe()',
      fixtures: 'quality/fixtures.js generate()',
    },
    thresholds: { items: thresholdsTable(), extra: T_EXTRA, note: '阈值是硬编码默认值，改阈值要改 quality/frames.js 的 DEFAULTS 后重跑本脚本。' },
    gaps: GAPS,
    report_fields: REPORT_FIELDS,
    capabilities: {
      implemented: ['黑场 / 黑帧', '白屏 / 白帧', '冻结（freeze）', '模糊（锐度）', '亮度跳变（闪烁）', '参数合规（元数据自洽）', '综合分三档'],
      not_implemented: ['音频静音 / 响度 / 削波', '色彩（色偏 / 色带 / gamma）', '缺陷区域定位（bbox）', '批量并行'],
    },
  };

  /* 路径一：synthetic —— 探测不到 ffmpeg，只写口径，不写帧数据 */
  const degrade = (reason) => {
    const snap = {
      ...base,
      mode: 'synthetic',
      mode_note: reason,
      mode_caveat: '本快照不含任何逐帧数据：帧号、分数、status 计数、worst 列表均为空。页面在此模式下只做口径说明。',
      samples: [],
      fixture_spec: null,
      real_requires: [
        '安装 ffmpeg / ffprobe 全量包并把 bin 目录加入 PATH',
        '或设置环境变量：set FFMPEG_BIN=D:\\path\\ffmpeg.exe 与 set FFPROBE_BIN=D:\\path\\ffprobe.exe',
        '然后重跑 node tools/snap_quality.mjs',
      ],
    };
    fs.writeFileSync(OUT, JSON.stringify(snap, null, 2) + '\n', 'utf8');
    console.log(`[snap] 降级为 synthetic：${reason}`);
    console.log(`[snap] 已写 ${path.relative(ROOT, OUT)}（${card(fs.statSync(OUT).size)}）· 无帧数据`);
  };

  if (!ffmpeg) return degrade('探测不到可执行的 ffmpeg（PATH 里没有，或 FFMPEG_BIN 指向错误），不能生成已知答案素材');
  if (!ffprobe) return degrade('探测不到可执行的 ffprobe（PATH 里没有，或 FFPROBE_BIN 指向错误），无法抽取真实元数据');

  let fx;
  try {
    fx = fixtures.generate({ force: FORCE });
  } catch (e) {
    return degrade('ffmpeg 存在但合成测试素材失败：' + String(e.message || e).slice(0, 300));
  }
  console.log(`[snap] 测试素材 ${fx.dir}（新建 ${fx.made.length} 条，复用 ${2 - fx.made.length} 条）`);

  const samples = [];
  samples.push(await sample('bad', '坏片 · 定点注入缺陷', 'bad', fx.bad, fx.expected));
  samples.push(await sample('good', '正常片 · 无注入', 'good', fx.good, null));

  const failed = samples.filter((s) => !s.ok);
  if (!samples.some((s) => s.ok)) {
    return degrade('分析阶段全部失败：' + failed.map((s) => `${s.id}=${s.error}`).join('，'));
  }

  const snap = {
    ...base,
    mode: 'real',
    mode_note: `本机 ffmpeg ${ffmpeg} 可用，全部数字来自真实解码：fixtures 合成 → ffprobe → 单次 ffmpeg 逐帧分析 → report 汇总。`,
    mode_caveat: '样片是 ffmpeg 现场合成的测试素材（缺陷定点注入、帧号已知），不是真实拍摄/生成影片；阈值在真机素材上的灵敏度见"已知缺口"。',
    fixture_spec: {
      dir: fx.dir,
      fps: fixtures.FPS,
      expected: fx.expected,
      expected_cn: `注入帧号（${fixtures.FPS}fps）：黑 ${fx.expected.black.join('–')} · 白 ${fx.expected.white.join('–')} · 模糊 ${fx.expected.blur.join('–')} · 冻结 ${fx.expected.freeze.join('–')}`,
      made_now: fx.made.map((p) => path.basename(p)),
      note: 'good 为 3.0s / 90 帧带 AAC 静音轨；bad 为 4.0s / 120 帧且无音轨（fixtures.js 生成时未加音频输入）。',
    },
    samples,
    cross_check: samples.find((s) => s.coverage) ? samples.find((s) => s.coverage).coverage : null,
  };

  fs.writeFileSync(OUT, JSON.stringify(snap, null, 2) + '\n', 'utf8');
  const size = fs.statSync(OUT).size;

  for (const s of samples) {
    if (!s.ok) { console.log(`[snap] ${s.id} 失败 ${s.error}: ${s.message}`); continue; }
    const st = s.summary.status;
    console.log(`[snap] ${s.id.padEnd(4)} ${s.verdict.label.padEnd(4)} mean=${s.summary.mean} p5=${s.summary.p5} · ok/warn/bad=${st.ok}/${st.warn}/${st.bad} · problems=${s.summary.problems}/${s.summary.frames} · segments=${s.summary.segments.length} · worst#${s.summary.worst[0] ? s.summary.worst[0].frame : '-'}`);
  }
  console.log(`[snap] 快照 quality/snapshot.json ${card(size)} · 模式 real · 样例 ${samples.length} · 阈值 ${Object.keys(DEFAULTS).length} 项 · 缺口 ${GAPS.length} 项`);
}

main().catch((e) => {
  console.error('[snap] 未捕获异常：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});