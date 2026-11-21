/**
 * tools/t2i_i2v.mjs —— 一条命令跑完「文生图 → 抓最优关键帧 → 图生视频」
 *
 * 用法：
 *   node tools/t2i_i2v.mjs --prompt "一只英国短毛幼猫，银渐层，坐在木质窗台上，午后侧光" --count 4
 *   node tools/t2i_i2v.mjs --prompt "..." --count 4 --motion "小猫抬头，尾巴轻摆，毛发被风吹动" --qwen
 *
 * 流程：
 *   1) ComfyUI 出 N 张候选关键帧（不同 seed，SD1.5）
 *   2) keyframe.pickBest 打分排序（退化淘汰 + 清晰度/构图/熵；可选 Qwen-VL 语义加权）
 *   3) 用最优帧作 first_frame，走 H3 I2V 出片（20 步 euler，640×384）
 *   4) 落盘：候选图、评分表、成片
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T2I = require(path.join(ROOT, 'server', 't2i.js'));
const KF = require(path.join(ROOT, 'server', 'keyframe.js'));
const H3 = require(path.join(ROOT, 'server', 'h3workflow.js'));
const QUALITY = require(path.join(ROOT, 'server', 'quality.js'));

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) { args[k] = next; i += 1; } else { args[k] = true; }
  }
}
const prompt = args.prompt || '一只英国短毛幼猫，银渐层毛色，绿色眼睛，坐在木质窗台上，午后侧光';
const motion = args.motion || prompt;
const count = Number(args.count || 4);
const W = Number(args.width || 640);
const H = Number(args.height || 384);

const OUT = path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '04-数据', 't2i_i2v', 'run_' + Date.now());
fs.mkdirSync(OUT, { recursive: true });

console.log('[1/3] 文生图 · 候选', count, '张 ·', W + 'x' + H);
const gen = await T2I.generateCandidates({ prompt: prompt, negative: args.negative, width: W, height: H, count, steps: Number(args.steps || 24), cfg: Number(args.cfg || 7) });
const files = gen.candidates.filter((c) => c.ok).map((c) => c.file);
console.log('  生成', files.length, '张 →', gen.outDir);

console.log('[2/3] 抓取最优关键帧');
const pick = await KF.pickBest({ files, prompt: motion, useQwen: !!args.qwen });
fs.writeFileSync(path.join(OUT, 'keyframes.json'), JSON.stringify({ gen, pick }, null, 2) + String.fromCharCode(10), 'utf8');
for (const r of pick.ranked) console.log('  ', r.score.toFixed(4), r.verdict, r.file);
if (!pick.best) { console.error('没有可用关键帧（全部退化）'); process.exit(1); }
console.log('  选中：', pick.best.file, 'score', pick.best.score, pick.best.verdict, '| 语义:', pick.provenance.semantic);

console.log('[3/3] 图生视频（首帧驱动）');
const q = QUALITY.guard({ engine: 'minimax_h3', width: W, height: H, frames: H3.snapFrames(Number(args.seconds || 5)).frames, usable_mib: Number(args.usable_mib || 8151), output_fps: Number(args.output_fps || 60) });
if (!q.ok) { console.error('质量准入拒绝：', q.errors[0].code, q.errors[0].message); process.exit(2); }
const up = await H3.uploadImage(pick.best.file);
const built = H3.build({
  prompt: String(args.motion || motion),
  width: W, height: H,
  seconds: Number(args.seconds || 5),
  seed: Number(args.seed || 0),
  firstFrameName: up,
  usableMib: Number(args.usable_mib || 8151),
});
const sub = await H3.run({ prompt: String(args.motion || motion), width: W, height: H, seconds: Number(args.seconds || 5), seed: Number(args.seed || 0), firstFrameName: up, usableMib: Number(args.usable_mib || 8151) });
if (!sub.ok) { console.error('提交失败', JSON.stringify(sub.error).slice(0, 300)); process.exit(3); }
console.log('  已提交 prompt_id =', sub.prompt_id, '（约 20–30 分钟）');
fs.writeFileSync(path.join(OUT, 'submit.json'), JSON.stringify({ prompt_id: sub.prompt_id, first_frame: up, workflow: built.workflow }, null, 2), 'utf8');

// 轮询到完成
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 15000));
  const st = await H3.status(sub.prompt_id);
  if (st.done) {
    const sec = Math.round((Date.now() - t0) / 1000);
    console.log('完成', st.state, sec + 's', JSON.stringify(st.images).slice(0, 200));
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ...st, elapsed_sec: sec, keyframe: pick.best.file }, null, 2), 'utf8');
    break;
  }
  if (Date.now() - t0 > 60 * 60 * 1000) { console.log('超时'); break; }
}
console.log('产物目录：', OUT);
