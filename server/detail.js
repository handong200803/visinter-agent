/**
 * detail.js —— 画面退化检测（解决「评分器奖励噪声」的根因）
 *
 * 背景（2026-11-20 实测）：现有四维评分把「帧间变化小」当成稳定性，
 * 于是**纯噪声片得分（F=0.6808）反而是真实好片（F=0.3544）的 1.9 倍**。
 * 这是指标口径的缺陷，不是数据问题。
 *
 * 本模块提供两个与「有没有真实内容」直接相关的量，用 ffmpeg 抽灰度原始帧在 Node 里算（零依赖）：
 *   noiseRatio  = 相邻像素平均绝对差 / 4×4 块均值标准差
 *                 噪声：相邻差异大、块均值几乎相同 → 比值高（>1）
 *                 真实画面：相邻差异小、块间起伏大 → 比值低（<0.5）
 *   edgeDensity = Sobel 梯度超过阈值的像素占比（真实画面集中在轮廓，噪声铺满全图）
 *   blockEntropy= 块均值直方图熵（真实画面有结构 → 熵低而有序；噪声块均值趋同 → 熵极低）
 *
 * 判定：degenerate = noiseRatio > 0.9 || (edgeDensity > 0.35 && blockEntropy < 1.2)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FFMPEG = process.env.AVP_FFMPEG || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';
const CACHE = new Map();      // file|mtime -> { at, result }
const CACHE_MS = 60_000;
const W = 160;
const H = 90;
// 高频判据用更高分辨率采样：160×90 会把噪声/块状平滑掉（2026-11-20 基准测试暴露）
const HD_W = 320;
const HD_H = 180;

/** 抽一帧灰度原始像素（W×H, 1 byte/px）。 */
function grayFrame(file, atSec = 1) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < W * H) return null;
  return r.stdout.subarray(0, W * H);
}

function grayFrameHD(file, atSec = 1) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-vf', `scale=${HD_W}:${HD_H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length < HD_W * HD_H) return null;
  return r.stdout.subarray(0, HD_W * HD_H);
}

/** 高分辨率统计：边缘密度 + 块方差（判模糊/纯色/块状用）。 */
function analyzeHD(px) {
  if (!px) return null;
  const n = HD_W * HD_H;
  let edge = 0, tot = 0;
  for (let y = 1; y + 1 < HD_H; y += 2) {
    for (let x = 1; x + 1 < HD_W; x += 2) {
      const gx = -px[(y - 1) * HD_W + x - 1] - 2 * px[y * HD_W + x - 1] - px[(y + 1) * HD_W + x - 1]
        + px[(y - 1) * HD_W + x + 1] + 2 * px[y * HD_W + x + 1] + px[(y + 1) * HD_W + x + 1];
      const gy = -px[(y - 1) * HD_W + x - 1] - 2 * px[(y - 1) * HD_W + x] - px[(y - 1) * HD_W + x + 1]
        + px[(y + 1) * HD_W + x - 1] + 2 * px[(y + 1) * HD_W + x] + px[(y + 1) * HD_W + x + 1];
      if (Math.abs(gx) + Math.abs(gy) > 120) edge += 1;
      tot += 1;
    }
  }
  const bs = 8, blocks = [];
  for (let by = 0; by + bs <= HD_H; by += bs) for (let bx = 0; bx + bs <= HD_W; bx += bs) {
    let sum = 0;
    for (let y = 0; y < bs; y += 1) for (let x = 0; x < bs; x += 1) sum += px[(by + y) * HD_W + (bx + x)];
    blocks.push(sum / (bs * bs));
  }
  const bm = blocks.reduce((a, b) => a + b, 0) / Math.max(1, blocks.length);
  const bsd = Math.sqrt(blocks.reduce((a, b) => a + (b - bm) * (b - bm), 0) / Math.max(1, blocks.length));
  let diffSum = 0, diffCnt = 0;
  for (let y = 0; y < HD_H; y += 1) {
    for (let x = 0; x + 1 < HD_W; x += 1) { diffSum += Math.abs(px[y * HD_W + x] - px[y * HD_W + x + 1]); diffCnt += 1; }
  }
  const noiseHd = (diffSum / Math.max(1, diffCnt)) / Math.max(1e-6, bsd);
  return { edge_density_hd: +(edge / Math.max(1, tot)).toFixed(4), block_std_hd: +bsd.toFixed(2), mean_hd: +bm.toFixed(1), noise_ratio_hd: +noiseHd.toFixed(3), pixels: n };
}

function analyze(px) {
  if (!px) return null;
  const n = W * H;
  // 1) 相邻像素差（水平+垂直）
  let diffSum = 0, diffCnt = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x + 1 < W; x += 1) {
      diffSum += Math.abs(px[y * W + x] - px[y * W + x + 1]);
      diffCnt += 1;
    }
  }
  for (let y = 0; y + 1 < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      diffSum += Math.abs(px[y * W + x] - px[(y + 1) * W + x]);
      diffCnt += 1;
    }
  }
  const meanAbsDiff = diffSum / Math.max(1, diffCnt);

  // 2) 4×4 块均值 → 块间标准差 + 直方图熵
  const bw = 4, bh = 4;
  const blocks = [];
  for (let by = 0; by + bh <= H; by += bh) {
    for (let bx = 0; bx + bw <= W; bx += bw) {
      let s = 0;
      for (let y = 0; y < bh; y += 1) for (let x = 0; x < bw; x += 1) s += px[(by + y) * W + (bx + x)];
      blocks.push(s / (bw * bh));
    }
  }
  const bm = blocks.reduce((a, b) => a + b, 0) / Math.max(1, blocks.length);
  const bsd = Math.sqrt(blocks.reduce((a, b) => a + (b - bm) * (b - bm), 0) / Math.max(1, blocks.length));
  const hist = new Array(32).fill(0);
  for (const b of blocks) hist[Math.max(0, Math.min(31, Math.floor(b / 8)))] += 1;
  let entropy = 0;
  for (const c of hist) { if (!c) continue; const p = c / blocks.length; entropy -= p * Math.log2(p); }

  // 3) Sobel 边缘密度
  let edge = 0, tot = 0;
  for (let y = 1; y + 1 < H; y += 2) {
    for (let x = 1; x + 1 < W; x += 2) {
      const gx = -px[(y - 1) * W + x - 1] - 2 * px[y * W + x - 1] - px[(y + 1) * W + x - 1]
        + px[(y - 1) * W + x + 1] + 2 * px[y * W + x + 1] + px[(y + 1) * W + x + 1];
      const gy = -px[(y - 1) * W + x - 1] - 2 * px[(y - 1) * W + x] - px[(y - 1) * W + x + 1]
        + px[(y + 1) * W + x - 1] + 2 * px[(y + 1) * W + x] + px[(y + 1) * W + x + 1];
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag > 120) edge += 1;
      tot += 1;
    }
  }
  const edgeDensity = edge / Math.max(1, tot);
  const noiseRatio = meanAbsDiff / Math.max(1e-6, bsd);
  const degenerate = noiseRatio > 0.9 || (edgeDensity > 0.35 && entropy < 1.2);
  return {
    mean_abs_diff: +meanAbsDiff.toFixed(3),
    block_std: +bsd.toFixed(3),
    block_entropy: +entropy.toFixed(3),
    edge_density: +edgeDensity.toFixed(3),
    noise_ratio: +noiseRatio.toFixed(3),
    degenerate,
    verdict: degenerate ? '噪声/退化画面（无真实结构）' : '有真实结构',
  };
}

/** 对一条视频抽 3 帧取中位数（避免单帧偶然）。 */
function inspectVideo(file) {
  // 同一文件 60s 内复用结果：selftest / 批量打分时会重复调用同一条片，避免重复抽帧拖慢流程
  try {
    const st = fs.statSync(file);
    const key = file + '|' + st.size + '|' + Math.round(st.mtimeMs);
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  } catch { /* 文件不存在走下面的错误分支 */ }
  if (!file || !fs.existsSync(file)) return { error: 'NO_FILE', file };
  const snaps = [];
  for (const t of [0.5, 2.0, 4.0]) {
    const px = grayFrame(file, t);
    const a = analyze(px);
    if (a) snaps.push(a);
  }
  if (!snaps.length) return { error: 'NO_FRAME', file };
  const med = (k) => {
    const v = snaps.map((s) => s[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  const degenerate = snaps.filter((s) => s.degenerate).length >= Math.ceil(snaps.length / 2);
  // 高分辨率复核（判模糊/纯色/块状）
  let hd = null;
  try {
    const hdPx = grayFrameHD(file, 2.0);
    hd = analyzeHD(hdPx);
  } catch { /* 忽略 */ }
  // 阈值来自 2026-11-20 基准（good hdEdge≈0.34 / blur≈0.046 / flat≈0.002）
  const hdBlur = hd ? (hd.edge_density_hd < 0.10 && hd.block_std_hd < 40) : false;
  const hdFlat = hd ? (hd.block_std_hd < 6) : false;
  const hdNoise = hd ? (hd.noise_ratio_hd > 1.15) : false;
  const degenFinal = degenerate || hdBlur || hdFlat || hdNoise;

  const result = {
    file: path.basename(file),
    frames: snaps.length,
    mean_abs_diff: med('mean_abs_diff'),
    block_std: med('block_std'),
    block_entropy: med('block_entropy'),
    edge_density: med('edge_density'),
    noise_ratio: med('noise_ratio'),
    degenerate: degenFinal,
    degenerate_reasons: [degenerate ? '噪声/无结构' : null, hdNoise ? '高频噪声（HD 判据）' : null, hdBlur ? '模糊（高频缺失）' : null, hdFlat ? '近乎纯色' : null].filter(Boolean),
    noise_degenerate: degenerate,
    hd,
    verdict: degenFinal ? ('退化画面：' + [degenerate ? '噪声' : null, hdNoise ? '高频噪声' : null, hdBlur ? '模糊' : null, hdFlat ? '纯色' : null].filter(Boolean).join('/')) : '有真实结构',
    provenance: 'measured(ffmpeg-gray+sobel,hd320)',
  };
  try {
    const st = fs.statSync(file);
    CACHE.set(file + '|' + st.size + '|' + Math.round(st.mtimeMs), { at: Date.now(), result });
  } catch { /* 忽略缓存写失败 */ }
  return result;
}

module.exports = { inspectVideo, analyze, grayFrame, W, H };
