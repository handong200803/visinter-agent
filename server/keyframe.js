/**
 * keyframe.js —— 关键帧选优（五维本地打分，无人脸自动降权）
 *
 * 五维（全部 0–1，本地计算，可用 Qwen-VL 增强但非必需）：
 *   Sface  人脸/主体五官稳定（无 OpenCV 人脸分类器时用"中心结构稳定"代理；有 Qwen 用其 face_stability）
 *   Ssharp 清晰度：Sobel 边缘密度 + 块方差，扣过曝/过暗
 *   Sstyle 风格契合：从提示词抽取颜色/时间/材质特征，与图像 HSL 分布比对
 *   Scomp  构图完整：主体能量是否落在安全区、是否贴边裁切
 *   Sbad   崩坏惩罚：退化（噪声/无结构）、极端对比、色偏、伪影
 *
 * 总分 = w1·Sface + w2·Ssharp + w3·Sstyle + w4·Scomp − w5·Sbad
 * 无人脸场景：Sface 权重按剩余维度原比例分配（不是简单丢掉）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const DETAIL = require('./detail.js');

const FFMPEG = process.env.AVP_FFMPEG || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';
const SPEC_PATH = path.join(__dirname, '..', 'spec', 'keyframe.json');
const W = 160;
const H = 90;

function loadSpec() {
  try { return JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')); } catch { return { weights: { Sface: 0.2, Ssharp: 0.3, Sstyle: 0.25, Scomp: 0.15, Sbad: 0.1 }, thresholds: {} }; }
}

/* ── 像素读取 ─────────────────────────────────────────────── */
function gm(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < W * H) return null;
  return r.stdout.subarray(0, W * H);
}
function rgb(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < W * H * 3) return null;
  return r.stdout.subarray(0, W * H * 3);
}

/* ── 各维计算 ─────────────────────────────────────────────── */
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/** 亮度均值/方差/过曝过暗比例 */
function lumaStats(px) {
  let sum = 0, sq = 0, over = 0, dark = 0;
  for (let i = 0; i < px.length; i += 1) {
    const v = px[i];
    sum += v; sq += v * v;
    if (v > 245) over += 1;
    if (v < 12) dark += 1;
  }
  const n = px.length;
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)), overRatio: over / n, darkRatio: dark / n };
}

/** Ssharp：边缘密度 + 块方差；过曝/过暗扣分 */
function scoreSharp(px, det) {
  const ls = lumaStats(px);
  const edge = clamp01((det.edge_density || 0) / 0.32);
  const tex = clamp01((det.block_std || 0) / 52);
  let s = edge * 0.55 + tex * 0.45;
  if (ls.overRatio > 0.06) s *= 1 - Math.min(0.6, (ls.overRatio - 0.06) * 4);
  if (ls.darkRatio > 0.25) s *= 1 - Math.min(0.6, (ls.darkRatio - 0.25) * 2);
  if (ls.mean < 28 || ls.mean > 232) s *= 0.7;
  return { score: clamp01(s), luma: ls };
}

/** Scomp：主体能量（亮度显著高于周围的块）是否落在中央安全区、是否贴边 */
function scoreComp(px) {
  const cw = Math.floor(W / 3), ch = Math.floor(H / 3);
  const cells = [];
  for (let cy = 0; cy < 3; cy += 1) for (let cx = 0; cx < 3; cx += 1) {
    let s = 0, n = 0;
    for (let y = cy * ch; y < (cy + 1) * ch; y += 1) for (let x = cx * cw; x < (cx + 1) * cw; x += 1) { s += px[y * W + x]; n += 1; }
    cells.push({ cx, cy, v: s / Math.max(1, n) });
  }
  const mean = cells.reduce((a, b) => a + b.v, 0) / 9;
  // 主体 = 与均值差最大的块（亮或暗都算）
  const subject = cells.slice().sort((a, b) => Math.abs(b.v - mean) - Math.abs(a.v - mean))[0];
  const centerDist = Math.max(Math.abs(subject.cx - 1), Math.abs(subject.cy - 1)); // 0=中心,1=边中
  const centerScore = 1 - centerDist * 0.5;   // 中心 1.0，边 0.5
  // 贴边裁切：最外圈块若明显偏亮/偏暗（主体被切）扣分
  const edgeCells = cells.filter((c) => c.cx === 0 || c.cx === 2 || c.cy === 0 || c.cy === 2);
  const edgeSpread = Math.max(...edgeCells.map((c) => Math.abs(c.v - mean)));
  const cropPenalty = Math.min(0.35, edgeSpread / 255);
  // 主体突出度：主体与均值差越大越"有主体"
  const salience = clamp01(Math.abs(subject.v - mean) / 60);
  const score = clamp01(centerScore * 0.5 + salience * 0.5) * (1 - cropPenalty);
  return { score, subject_cell: [subject.cx, subject.cy], salience: +salience.toFixed(3), crop_penalty: +cropPenalty.toFixed(3) };
}

/** 颜色特征：主色调（暖/冷/中性）、亮度、饱和度 */
function colorFeature(rgbBuf) {
  let r = 0, g = 0, b = 0, satSum = 0;
  const n = W * H;
  for (let i = 0; i < n; i += 1) {
    const R = rgbBuf[i * 3], G = rgbBuf[i * 3 + 1], B = rgbBuf[i * 3 + 2];
    r += R; g += G; b += B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    satSum += mx === 0 ? 0 : (mx - mn) / mx;
  }
  r /= n; g /= n; b /= n;
  const warmth = (r - b) / 255;          // >0 偏暖，<0 偏冷
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return { warmth: +warmth.toFixed(3), luma: +luma.toFixed(3), saturation: +(satSum / n).toFixed(3) };
}

/** 从提示词里抽特征（中英双语关键词表，可解释、不靠模型） */
const KEYWORDS = {
  warm: ['暖', '金色', '夕阳', '黄昏', '烛光', '温暖', '橘', '橙', '暖阳', 'sunset', 'golden', 'warm', 'candle', 'orange'],
  cool: ['冷', '蓝', '青', '夜', '月光', '阴雨', '寒', '冷调', 'blue', 'cool', 'night', 'moon', 'rain', 'cyan'],
  bright: ['明亮', '高调', '雪', '白', '阳光', 'bright', 'snow', 'sunny', 'high key'],
  dark: ['暗', '低调', '黑', '阴影', '昏暗', 'dark', 'low key', 'shadow', 'black'],
  vivid: ['饱和', '鲜艳', '浓郁', 'vivid', 'saturated', 'colorful'],
  muted: ['低饱和', '灰', '淡', '复古', 'muted', 'desaturated', 'faded', 'film'],
};
function promptFeature(prompt) {
  const p = String(prompt || '').toLowerCase();
  const hit = (arr) => arr.some((k) => p.includes(k.toLowerCase()));
  return {
    warm: hit(KEYWORDS.warm), cool: hit(KEYWORDS.cool),
    bright: hit(KEYWORDS.bright), dark: hit(KEYWORDS.dark),
    vivid: hit(KEYWORDS.vivid), muted: hit(KEYWORDS.muted),
  };
}

/** Sstyle：提示词颜色倾向 vs 图像颜色特征 */
function scoreStyle(feat, pf) {
  if (!feat) return { score: 0.5, note: 'no_color_data' };
  let score = 0.6, hits = 0;
  if (pf.warm && !pf.cool) { score += feat.warmth > 0.02 ? 0.2 : -0.2; hits += 1; }
  if (pf.cool && !pf.warm) { score += feat.warmth < -0.02 ? 0.2 : -0.2; hits += 1; }
  if (pf.bright) { score += feat.luma > 0.55 ? 0.15 : -0.15; hits += 1; }
  if (pf.dark) { score += feat.luma < 0.45 ? 0.15 : -0.15; hits += 1; }
  if (pf.vivid) { score += feat.saturation > 0.35 ? 0.15 : -0.1; hits += 1; }
  if (pf.muted) { score += feat.saturation < 0.3 ? 0.15 : -0.1; hits += 1; }
  return { score: clamp01(score), matched_terms: hits, color: feat };
}

/** Sface：无人脸检测器时的"主体五官稳定"代理（中心区边缘密度 + 局部对比） */
function scoreFace(px, det) {
  const cx0 = Math.floor(W * 0.3), cx1 = Math.floor(W * 0.7), cy0 = Math.floor(H * 0.2), cy1 = Math.floor(H * 0.8);
  let sum = 0, n = 0;
  for (let y = cy0; y < cy1; y += 1) for (let x = cx0; x < cx1; x += 1) { sum += px[y * W + x]; n += 1; }
  const centerMean = sum / Math.max(1, n);
  const ls = lumaStats(px);
  // 中心对比度：中心亮度与全图均值的偏离（主体通常在画面里是"有对比"的那块）
  const contrast = clamp01(Math.abs(centerMean - ls.mean) / 55);
  const edge = clamp01((det.edge_density || 0) / 0.4);
  return { score: clamp01(contrast * 0.6 + edge * 0.4), available: false, note: 'no_face_detector' };
}

/** Sbad：崩坏惩罚 */
function scoreBad(det, sharpInfo, comp) {
  let bad = 0;
  const reasons = [];
  if (det.degenerate) { bad += 0.85; reasons.push('退化（噪声/无结构）'); }
  if (sharpInfo.luma.overRatio > 0.15) { bad += 0.2; reasons.push('过曝'); }
  if (sharpInfo.luma.darkRatio > 0.5) { bad += 0.2; reasons.push('过暗'); }
  if (comp.crop_penalty > 0.25) { bad += 0.15; reasons.push('主体贴边/疑似裁切'); }
  if (det.noise_ratio > 0.8 && !det.degenerate) { bad += 0.1; reasons.push('高频噪声偏高'); }
  return { score: clamp01(bad), reasons };
}

/* ── 单图打分 ─────────────────────────────────────────────── */
function scoreImage(file, opts = {}) {
  const px = gm(file);
  if (!px) return { file, ok: false, error: 'DECODE_FAILED' };
  const a = DETAIL.analyze(px) || {};
  const rgbBuf = rgb(file);
  const feat = rgbBuf ? colorFeature(rgbBuf) : null;
  const pf = promptFeature(opts.prompt);

  const sharp = scoreSharp(px, a);
  const comp = scoreComp(px);
  const style = scoreStyle(feat, pf);
  const face = scoreFace(px, a);
  const bad = scoreBad(a, sharp, comp);

  const spec = loadSpec();
  const w = { ...(spec.weights || {}) };
  let scores = {
    Sface: +face.score.toFixed(4),
    Ssharp: +sharp.score.toFixed(4),
    Sstyle: +style.score.toFixed(4),
    Scomp: +comp.score.toFixed(4),
    Sbad: +bad.score.toFixed(4),
  };

  // 无人脸：把 Sface 的权重按比例分给其余三维（不是丢掉，也不是当 0 分）
  let weights = { ...w };
  if (!face.available) {
    const rest = ['Ssharp', 'Sstyle', 'Scomp'];
    const restSum = rest.reduce((s, k) => s + (weights[k] || 0), 0) || 1;
    const give = weights.Sface || 0;
    for (const k of rest) weights[k] = +((weights[k] || 0) + give * ((weights[k] || 0) / restSum)).toFixed(4);
    weights.Sface = 0;
  }
  const total = clamp01(
    (weights.Sface || 0) * scores.Sface
    + (weights.Ssharp || 0) * scores.Ssharp
    + (weights.Sstyle || 0) * scores.Sstyle
    + (weights.Scomp || 0) * scores.Scomp
    - (weights.Sbad || 0) * scores.Sbad,
  );
  const threshold = (spec.thresholds || {}).accept_total || 0.45;
  if (bad.score >= 0.85) scores = { ...scores, Sbad: Math.max(scores.Sbad, 0.95) };

  return {
    file,
    ok: true,
    total: +total.toFixed(4),
    scores,
    weights,
    degenerate: !!a.degenerate,
    accept: total >= threshold && !a.degenerate,
    verdict: a.degenerate ? '退化淘汰' : (total >= threshold ? '可用关键帧' : '低于阈值'),
    detail: {
      edge_density: a.edge_density, block_std: a.block_std, block_entropy: a.block_entropy, noise_ratio: a.noise_ratio,
      luma: sharp.luma, subject_cell: comp.subject_cell, crop_penalty: comp.crop_penalty,
      bad_reasons: bad.reasons, prompt_feature: pf, face_note: face.note,
    },
  };
}

/* ── 批量选优 ─────────────────────────────────────────────── */
async function pickBest(o = {}) {
  const files = (o.files || []).filter((f) => f && fs.existsSync(f));
  if (!files.length) throw Object.assign(new Error('没有候选关键帧'), { code: 'KF_NO_CANDIDATES', status: 422 });
  const scored = files.map((f) => scoreImage(f, { prompt: o.prompt }));
  const okOnes = scored.filter((s) => s.ok);
  const accepted = okOnes.filter((s) => s.accept).sort((a, b) => b.total - a.total);
  const ranked = (accepted.length ? accepted : okOnes.slice().sort((a, b) => b.total - a.total));

  // 可选 Qwen 语义增强（只调整 Sstyle，权重仍按 spec）
  let qwen = { used: false };
  if (o.useQwen) {
    try {
      const QW = require('./providers/qwen_eval.js');
      const av = QW.available();
      if (!av.ok) throw Object.assign(new Error(av.reason), { code: av.code });
      for (const s of ranked.slice(0, 3)) {
        try {
          const r = await QW.scoreVideo({ file: s.file, frames: [s.file], prompt: o.prompt });
          s.qwen = { backend: r.backend, scores: r.scores, reason: r.reason };
          s.scores.Sstyle = +((s.scores.Sstyle * 0.5) + (r.scores.Sstyle * 0.5)).toFixed(4);
          s.total = +clamp01(s.total * 0.7 + r.F * 0.3).toFixed(4);
        } catch (e) { s.qwen = { error: e.code || 'QWEN_FAILED' }; }
      }
      ranked.sort((a, b) => b.total - a.total);
      qwen = { used: true };
    } catch (e) { qwen = { used: false, error: e.code || e.message }; }
  }

  const best = ranked[0] || null;
  return {
    prompt: o.prompt || null,
    candidates: scored.map((s) => ({
      file: s.file, basename: s.ok ? path.basename(s.file) : null,
      total: s.ok ? s.total : null, scores: s.ok ? s.scores : null, verdict: s.ok ? s.verdict : s.error,
      accept: !!s.ok && s.accept, degenerate: !!s.ok && s.degenerate,
      weights: s.ok ? s.weights : null,
    })),
    ranked: ranked.map((s) => ({ file: path.basename(s.file), total: s.total, verdict: s.verdict })),
    best: best ? { file: best.file, basename: path.basename(best.file), total: best.total, scores: best.scores, verdict: best.verdict } : null,
    all_rejected: ranked.length === 0 || !ranked.some((s) => s.accept),
    qwen,
    provenance: {
      geometry: 'measured(ffmpeg-gray+sobel)',
      style: 'measured(color-hist vs prompt-keywords)',
      face: 'proxy(no_face_detector)',
      semantic: qwen.used ? 'measured(qwen-vl)' : 'skipped',
    },
  };
}

module.exports = { scoreImage, pickBest, promptFeature, colorFeature, loadSpec, SPEC_PATH };
