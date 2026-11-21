/**
 * cloud/scoring.mjs —— 云端打分：四维（复用本地权重与退化检测思路）+ 可选 Qwen 语义维
 *
 * 与本地 server/scoring.js 的差别：
 *   本地是 ffmpeg 抽帧 + Sobel；云端没有 ffmpeg 二进制，改为「浏览器已抽好帧 → 传 JPEG 上来打分」，
 *   或者对图片（关键帧）直接打分。视频打分走 /api/scores 上传 3 帧。
 *
 * 权重沿用 spec/keyframe.json 的口径：Sface .20 / Ssharp .30 / Sstyle .25 / Scomp .15，Sbad .10 扣减。
 */
import { evalQwen } from './providers.mjs';

export const WEIGHTS = { Sface: 0.2, Ssharp: 0.3, Sstyle: 0.25, Scomp: 0.15, Sbad: 0.1 };

/** 无解码器时的轻量图像统计：用 PNG/JPEG 字节无法算像素，所以要求前端传「已缩放的原始 RGBA 或灰度」 */
export function scoreFromGray({ gray, w, h, prompt }) {
  const n = w * h;
  if (!gray || gray.length < n) return null;
  // 锐度：Sobel 梯度均值
  let g = 0, cnt = 0;
  for (let y = 1; y + 1 < h; y += 2) {
    for (let x = 1; x + 1 < w; x += 2) {
      const px = (yy, xx) => gray[yy * w + xx];
      const gx = -px(y - 1, x - 1) - 2 * px(y, x - 1) - px(y + 1, x - 1) + px(y - 1, x + 1) + 2 * px(y, x + 1) + px(y + 1, x + 1);
      const gy = -px(y - 1, x - 1) - 2 * px(y - 1, x) - px(y - 1, x + 1) + px(y + 1, x - 1) + 2 * px(y + 1, x) + px(y + 1, x + 1);
      g += Math.abs(gx) + Math.abs(gy); cnt += 1;
    }
  }
  const sharp = Math.min(1, (g / Math.max(1, cnt)) / 220);
  // 块方差（结构丰富度）
  const bs = 8, blocks = [];
  for (let by = 0; by + bs <= h; by += bs) for (let bx = 0; bx + bs <= w; bx += bs) {
    let s = 0;
    for (let y = 0; y < bs; y += 1) for (let x = 0; x < bs; x += 1) s += gray[(by + y) * w + (bx + x)];
    blocks.push(s / (bs * bs));
  }
  const mean = blocks.reduce((a, b) => a + b, 0) / Math.max(1, blocks.length);
  const std = Math.sqrt(blocks.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, blocks.length));
  const comp = Math.min(1, std / 60);
  // 退化：近乎纯色 / 高频噪声
  const flat = std < 6;
  let diff = 0, dc = 0;
  for (let y = 0; y < h; y += 1) for (let x = 0; x + 1 < w; x += 1) { diff += Math.abs(gray[y * w + x] - gray[y * w + x + 1]); dc += 1; }
  const noise = (diff / Math.max(1, dc)) / Math.max(1e-6, std);
  const noisy = noise > 1.15;
  const sbad = flat || noisy ? 0.95 : 0;
  // Sface：无检测器时的代理——中心区域结构稳定性（与本地口径一致）
  let center = 0, cc = 0;
  for (let y = Math.floor(h * 0.3); y < Math.floor(h * 0.7); y += 1) for (let x = Math.floor(w * 0.3); x < Math.floor(w * 0.7); x += 1) { center += gray[y * w + x]; cc += 1; }
  const face = Math.min(1, Math.abs(center / Math.max(1, cc) - mean) / 40 + 0.3);
  // Sstyle：有 prompt 时用颜色词匹配（简化：只判冷暖/明暗关键词）
  const style = prompt ? styleMatch(prompt, mean) : 0.5;
  return { Sface: +face.toFixed(3), Ssharp: +sharp.toFixed(3), Sstyle: +style.toFixed(3), Scomp: +comp.toFixed(3), Sbad: +sbad.toFixed(3), degenerate: sbad > 0.5, noise: +noise.toFixed(3) };
}

function styleMatch(prompt, mean) {
  const p = String(prompt || '');
  let want = 0.5;
  if (/夜|暗|黑|dark|night/.test(p)) want = 0.25;
  if (/亮|阳光|白|bright|sunny/.test(p)) want = 0.75;
  const got = Math.max(0, Math.min(1, mean / 255));
  return Math.max(0, 1 - Math.abs(got - want) * 2);
}

/** 加权总分（与本地一致：Sbad 为扣减项） */
export function total(s) {
  return +(WEIGHTS.Sface * s.Sface + WEIGHTS.Ssharp * s.Ssharp + WEIGHTS.Sstyle * s.Sstyle + WEIGHTS.Scomp * s.Scomp - WEIGHTS.Sbad * s.Sbad).toFixed(4);
}

/**
 * 一张候选（前端上传灰度像素）的完整打分：本地四维 + （可选）Qwen 语义融合。
 * 语义可用时把 Sstyle 替换成 0.6*语义 + 0.4*规则，保证权重口径不变。
 */
export async function scoreCandidate({ gray, w, h, prompt, imageUrl }) {
  const base = scoreFromGray({ gray, w, h, prompt });
  if (!base) return null;
  let semantic = null;
  if (imageUrl && evalQwen.ready()) {
    const r = await evalQwen.scoreImage({ imageUrl, prompt }).catch(() => ({ ok: false }));
    if (r.ok) semantic = r.score;
  }
  if (semantic != null) {
    base.Sstyle = +(0.6 * semantic + 0.4 * base.Sstyle).toFixed(3);
  }
  return { ...base, semantic, total: total(base) };
}
