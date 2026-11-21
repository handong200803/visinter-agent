/**
 * audit.js —— 严苛质量审核机制（灰境方案 M6 完整版：五道闸 G0~G4 + 三态 PASS/REJECT/REVIEW）
 *
 * 能力边界（诚实口径，方案§二/§十二）：
 *   - 全自动·本机零 ML：规格/sharp/曝光/闪烁/运动残差/抖动/黑帧冻结/直方图漂移（复用 quality/frames.js 传统信号量）。
 *   - 结构/人脸/手/一致性/穿帮/水印：必须云端 VL 或人工；VL 不可用 → 这些项一律 REVIEW，不假装自动判过。
 *   - 一票否决：命中即 REJECT，不被总分抵扣；结构人体单项低于合格线 → 最高只能 REVIEW。
 *   - 全部留痕：QAReport（指标/阈值版本/VL 结论/否决项/扣分/复核/重试）入 report，可回溯。
 * 阈值带版本号、按模型/分辨率/风格分组；基线来自实测标定（qa-calibration），新指标占位标 provenance。
 */
'use strict';

/** §8.2 缺陷标签字典（统一枚举）。 */
const DEFECT_TAGS = ['blur', 'overexposed', 'underexposed', 'colorCast', 'noise', 'blockArtifact', 'flicker', 'flowResidual', 'jitter', 'blackFrame', 'freezeFrame', 'faceDefect', 'handDefect', 'bodyDefect', 'perspectiveBreak', 'inconsistency', 'costumeDrift', 'artifact', 'watermark', 'gibberishText', 'audioMute', 'audioDesync', 'specFail', 'phantomFace', 'extraPerson', 'spawnObject', 'vanishObject', 'backgroundPop', 'faceCountDrift'];

/** §五 一票否决项编号 → 缺陷标签。命中即 REJECT。 */
const VETO = {
  faceDefect: 'faceDefect', handDefect: 'handDefect', bodyDefect: 'bodyDefect', perspectiveBreak: 'perspectiveBreak',
  inconsistency: 'inconsistency', phantomFace: 'phantomFace', extraPerson: 'extraPerson', spawnObject: 'spawnObject',
  vanishObject: 'vanishObject', watermark: 'watermark', gibberishText: 'gibberishText',
  flickerHard: 'flicker', flowHard: 'flowResidual', blackRun: 'blackFrame', freezeRun: 'freezeFrame', specFail: 'specFail', audioDesync: 'audioDesync',
};

/** §8.3 阈值配置（版本化、分组）。default 组信号量基线=实测标定；新指标占位标 estimate/placeholder。 */
const THRESHOLD_PRESETS = {
  version: '2026-11-18.1',
  calibratedAt: '2026-11-18',
  groups: {
    default: {
      sharpMin: 0.9, flickerMeanMax: 0.30, flickerHardMax: 2.0, flowMeanMax: 0.20, flowHardMax: 0.32,
      badFrameRatioMax: 0.02, blackFrameRatioMax: 0.02, freezeFrameRatioMax: 0.10,
      jitterSpikeRatioMax: 0.15, histDriftMax: 0.12, deadWhiteRatioMax: 0.06, deadBlackRatioMax: 0.10,
      structurePassLine: 7.0, provenance: { sharpMin: 'calibrated', flickerMeanMax: 'calibrated', flickerHardMax: 'calibrated', flowMeanMax: 'calibrated', flowHardMax: 'calibrated', jitterSpikeRatioMax: 'placeholder', histDriftMax: 'placeholder', deadWhiteRatioMax: 'placeholder', deadBlackRatioMax: 'placeholder', structurePassLine: 'placeholder' },
    },
  },
};
function thresholdFor(model, resolution, style) {
  const g = THRESHOLD_PRESETS.groups;
  const key = [model, resolution, style].filter(Boolean).join('|');
  return { id: g[key] ? key : 'default', version: THRESHOLD_PRESETS.version, ... (g[key] || g.default) };
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const max = (a) => (a.length ? Math.max(...a) : 0);
const min = (a) => (a.length ? Math.min(...a) : 0);
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/** 从 quality/frames.analyze 结果提炼 §8.1 metrics（全自动信号量）。 */
function metricsFromAnalysis(r, spec) {
  const fr = (r && r.frames) || [];
  const n = fr.length || 1;
  const sharp = fr.map((f) => f.sharp);
  const flicker = fr.map((f) => f.flicker);
  const flow = fr.map((f) => f.flowResidual);
  const yavg = fr.map((f) => (f.extra && f.extra.yavg) || 0);
  const diffs = fr.map((f) => (f.extra && f.extra.meanAbsDiff) || 0);
  const dMed = median(diffs);
  const jitterSpikes = diffs.filter((d) => dMed > 0 && d > 3 * dMed).length / n;
  const first = fr[0] && fr[0].extra, last = fr[fr.length - 1] && fr[fr.length - 1].extra;
  const histDrift = first && last ? Math.abs((first.yavg || 0) - (last.yavg || 0)) / 255 : 0;
  const det = (r && r.detect) || {};
  const whiteY = (r && r.thresholds && r.thresholds.whiteY) || 235;
  const blackY = (r && r.thresholds && r.thresholds.blackY) || 16;
  const deadWhite = yavg.filter((y) => y >= whiteY).length / n;
  const deadBlack = yavg.filter((y) => y <= blackY).length / n;
  const exposureScore = Math.max(0, 10 - deadWhite * 40 - deadBlack * 25 - Math.abs(mean(yavg) / 255 - 0.5) * 8);
  const staticDiffs = fr.filter((f) => f.extra && f.extra.freeze).map((f) => f.extra.meanAbsDiff || 0);
  return {
    sharpMean: +mean(sharp).toFixed(3), sharpMin: +min(sharp).toFixed(3),
    flickerMean: +mean(flicker).toFixed(3), flickerMax: +max(flicker).toFixed(3),
    flowMean: +mean(flow).toFixed(3), flowMax: +max(flow).toFixed(3),
    jitter: +jitterSpikes.toFixed(3),
    blackFrames: (det.blackFrames || []).length, freezeFrames: (det.frozenFrames || []).length,
    blackFrameRatio: +((det.blackFrames || []).length / n).toFixed(3), freezeFrameRatio: +((det.frozenFrames || []).length / n).toFixed(3),
    histDrift: +histDrift.toFixed(3),
    exposureScore: +exposureScore.toFixed(2), deadWhiteRatio: +deadWhite.toFixed(3), deadBlackRatio: +deadBlack.toFixed(3),
    noiseLevel: staticDiffs.length ? +median(staticDiffs).toFixed(3) : null,
    frames: n, spec: spec || null,
    provenance: { jitter: 'estimate', histDrift: 'measured', exposureScore: 'estimate', noiseLevel: staticDiffs.length ? 'estimate' : 'not-measured' },
  };
}

/** 自动信号量闸：返回 {vetoHits[], deductions[], tags[], borderline[]}。 */
function autoGate(m, th) {
  const vetoHits = [], deductions = [], tags = [], borderline = [];
  if (m.specFail) { vetoHits.push('specFail'); tags.push('specFail'); }
  if (m.flickerMax > th.flickerHardMax) { vetoHits.push('flickerHard'); tags.push('flicker'); }
  else if (m.flickerMean > th.flickerMeanMax) { borderline.push('flickerMean 超基线'); deductions.push(['flicker', 2]); tags.push('flicker'); }
  if (m.flowMax > th.flowHardMax) { vetoHits.push('flowHard'); tags.push('flowResidual'); }
  else if (m.flowMean > th.flowMeanMax) { borderline.push('flowMean 超基线'); deductions.push(['flowResidual', 2]); tags.push('flowResidual'); }
  if (m.blackFrameRatio > th.blackFrameRatioMax) { vetoHits.push('blackRun'); tags.push('blackFrame'); }
  if (m.freezeFrameRatio > th.freezeFrameRatioMax) { vetoHits.push('freezeRun'); tags.push('freezeFrame'); }
  if (m.sharpMin < th.sharpMin) { deductions.push(['blur', 3]); tags.push('blur'); borderline.push('sharp 低于基线'); }
  if (m.deadWhiteRatio > th.deadWhiteRatioMax) { deductions.push(['overexposed', 3]); tags.push('overexposed'); }
  if (m.deadBlackRatio > th.deadBlackRatioMax) { deductions.push(['underexposed', 3]); tags.push('underexposed'); }
  if (m.jitter > th.jitterSpikeRatioMax) { deductions.push(['jitter', 2]); tags.push('jitter'); borderline.push('jitter 突增'); }
  if (m.histDrift > th.histDriftMax) { deductions.push(['colorCast', 2]); tags.push('colorCast'); borderline.push('直方图漂移'); }
  return { vetoHits, deductions, tags, borderline };
}

/** VL 结构/一致性/审美闸 → {vetoHits[], deductions[], tags[], structureScore, consistencyScore, aestheticScore, review[]}。 */
function vlGate(vl, type) {
  const out = { vetoHits: [], deductions: [], tags: [], review: [], structureScore: null, consistencyScore: null, aestheticScore: null };
  if (!vl) { out.review.push('VL 不可用：结构/一致性/审美进人工复核'); return out; }
  const vetoMap = { faceOk: 'faceDefect', handsOk: 'handDefect', bodyOk: 'bodyDefect', perspectiveOk: 'perspectiveBreak', phantomFace: 'phantomFace', extraPersonOk: 'extraPerson', watermark: 'watermark', gibberishText: 'gibberishText' };
  for (const [k, tag] of Object.entries(vetoMap)) {
    const v = vl[k];
    const bad = (k === 'phantomFace' || k === 'watermark' || k === 'gibberishText') ? v === true : v === false;
    if (bad) { out.vetoHits.push(tag); out.tags.push(tag); }
  }
  if (type === 'video' && vl.consistencyOk === false) { out.vetoHits.push('inconsistency'); out.tags.push('inconsistency'); }
  const s = (ok) => (ok === true ? 9 : ok === false ? 3 : 6);
  out.structureScore = mean([s(vl.faceOk), s(vl.handsOk), s(vl.bodyOk), s(vl.perspectiveOk)]);
  out.consistencyScore = s(vl.consistencyOk);
  out.aestheticScore = mean([s(vl.composition), s(vl.emotion), s(vl.artifactOk), ...[vl.lightUnified, vl.colorUnified, vl.textureOk, vl.whitespaceOk, vl.motionRestraint].filter((x) => x != null).map(s)]);
  if (vl.faceOk == null || vl.handsOk == null || vl.bodyOk == null) out.review.push('VL 结构项缺结论');
  if (vl.phantomFace == null) out.review.push('VL 未判凭空人脸');
  return out;
}

/** §六 加权评分 + 分档 + 三态。结构单项低于合格线 → 最高 REVIEW。 */
function decide({ metrics, auto, vl, type, th }) {
  const tech = Math.max(0, 10 - auto.deductions.reduce((a, [, d]) => a + d, 0));
  const structure = vl.structureScore, consistency = vl.consistencyScore, aesthetic = vl.aestheticScore;
  const known = [structure, consistency, aesthetic].filter((x) => x != null);
  let total = null;
  if (known.length === 3) total = +(tech * 0.30 + structure * 0.30 + consistency * 0.20 + aesthetic * 0.20).toFixed(2);
  const vetoHits = [...auto.vetoHits, ...vl.vetoHits];
  let decision, tier;
  if (vetoHits.length) { decision = 'REJECT'; tier = '淘汰'; }
  else if (total == null) { decision = 'REVIEW'; tier = '存疑(VL缺结论)'; }
  else if (structure != null && structure < th.structurePassLine) { decision = 'REVIEW'; tier = '存疑(结构低于合格线)'; }
  else if (total >= 9.0) { decision = 'PASS'; tier = '精选'; }
  else if (total >= 7.5) { decision = 'PASS'; tier = '可用'; }
  else if (total >= 6.0) { decision = 'REVIEW'; tier = '存疑'; }
  else { decision = 'REJECT'; tier = '淘汰'; }
  if (decision !== 'REJECT' && auto.borderline.length && decision === 'PASS' && total < 9) { /* 可用档允许 borderline */ }
  if (decision === 'PASS' && auto.borderline.length && total < 7.5) decision = 'REVIEW';
  return { decision, tier, total, tech: +tech.toFixed(2), structure, consistency, aesthetic, vetoHits, deductions: auto.deductions, tags: [...new Set([...auto.tags, ...vl.tags])], review: [...auto.borderline, ...vl.review], weights: { tech: 0.30, structure: 0.30, consistency: 0.20, aesthetic: 0.20 } };
}

/**
 * 审核一条素材 → QAReport（§8.1）。type=image|video。
 * deps: { analyze(file)->quality结果, vl(imageUrls,ask)->VL结论, spec }。VL/analyze 可注入（自测零计费）。
 */
async function auditMedia({ file, type, spec, threshold, analyze, vl, imageUrls }) {
  const th = threshold || thresholdFor();
  let r = null;
  try { r = analyze ? await analyze(file) : null; } catch (e) { r = { ok: false, code: e.code || 'E_ANALYZE', message: e.message }; }
  const metrics = r && r.ok ? metricsFromAnalysis(r, spec) : { frames: 0, spec: spec || null, unavailable: true, reason: (r && (r.code || r.message)) || 'analyze 未注入' };
  if (metrics.unavailable) metrics.specFail = false; // 分析不可用≠规格失败，进 REVIEW
  const auto = metrics.unavailable ? { vetoHits: [], deductions: [], tags: [], borderline: ['信号量不可用'] } : autoGate(metrics, th);
  let vlRaw = null;
  if (vl) { try { vlRaw = await vl(imageUrls || [file], type); } catch (e) { vlRaw = null; } }
  const vlG = vlGate(vlRaw, type);
  const d = decide({ metrics, auto, vl: vlG, type, th });
  if (metrics.unavailable && d.decision === 'PASS') d.decision = 'REVIEW';
  return {
    id: 'qa_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 1e4),
    mediaType: type, file, spec: spec || null, thresholdVersion: th.version, thresholdId: th.id,
    metrics, vlCheck: vlRaw || null, vlModel: (vlRaw && vlRaw.vlModel) || null,
    decision: d.decision, tier: d.tier, total: d.total, scores: { tech: d.tech, structure: d.structure, consistency: d.consistency, aesthetic: d.aesthetic }, weights: d.weights,
    vetoHits: d.vetoHits, deductions: d.deductions, tags: d.tags, review: d.review,
    reviewer: null, reason: d.vetoHits.length ? '一票否决：' + d.vetoHits.join(',') : (d.review.length ? d.review.join('；') : ''), retryHistory: [],
    at: new Date().toISOString(),
  };
}

/** G0 输入闸：提示词/参考齐全性（生成前，不计费）。 */
function inputGate({ prompt, style }) {
  const problems = [];
  if (!String(prompt || '').trim()) problems.push('提示词为空');
  if (String(prompt || '').trim().length < 4) problems.push('提示词过短（<4字），建议补主体/场景/光线');
  return { pass: problems.length === 0, problems };
}

/** G4 入库合规闸：元数据完整性 + VL 水印/乱码（复用终审 vlCheck）。 */
function complianceGate(report) {
  const problems = [];
  if (!report.output || !report.output.file) problems.push('缺成片路径');
  if (!report.params) problems.push('缺参数JSON');
  if (!report.modelChain) problems.push('缺模型链');
  const vl = report.qa && report.qa.vlCheck;
  if (vl && (vl.watermark === true || vl.gibberishText === true)) problems.push('水印/乱码文字');
  return { pass: problems.length === 0, problems };
}

module.exports = { DEFECT_TAGS, VETO, THRESHOLD_PRESETS, thresholdFor, metricsFromAnalysis, autoGate, vlGate, decide, auditMedia, inputGate, complianceGate };