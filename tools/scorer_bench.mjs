/**
 * tools/scorer_bench.mjs —— 评分器基准测试（把「发现」做成「结论」）
 *
 * 做的事：
 *   1) 组样本集：好片（现有成片）+ 坏片（对好片用 ffmpeg 滤镜人工制造 4 类退化 + 已有噪声样片）
 *   2) 同一评分器跑两遍：detail=off（旧口径）/ detail=on（加退化检测=新口径）
 *   3) 统计：坏片在旧口径下是否被排到好片前面（失误率）；新口径下的分离度与排序准确率
 *   4) 产出：CSV + SVG（两口径对比柱状）+ Markdown 结论
 *
 * 纪律：坏样本用 ffmpeg 滤镜确定性生成（同源同参数），换机器可复现；样本清单与哈希写进报告。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD = process.env.CLOUD_ROOT || 'D:\\云盘';
const CACHE = process.env.CACHE_ROOT || 'D:\\缓存';
const FFMPEG = process.env.AVP_FFMPEG || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';
const S = require(path.join(ROOT, 'server', 'scoring.js'));
const D = require(path.join(ROOT, 'server', 'detail.js'));

const GOOD_DIR = path.join(CLOUD, '02-视频', '成片');
const BAD_DIR = path.join(CLOUD, '04-数据', 'bad-samples');
const WORK = path.join(CACHE, 'avp', 'scorer_bench');
const OUT = path.join(CLOUD, '04-数据', 'audit');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(BAD_DIR, { recursive: true });

const DEGRADATIONS = [
  ['noise_heavy', 'noise=alls=90:allf=t+u', '重度噪声（模拟采样器错配产物）'],
  ['blur_heavy', 'gblur=sigma=8', '重度模糊（模拟糊脸/失焦）'],
  ['flat_color', 'hue=s=0,eq=contrast=0.15:brightness=0.02', '近乎纯色（模拟无结构）'],
  ['poster_lowq', 'scale=160:-2,scale=640:-2:flags=neighbor', '低分辨率块状（模拟低质伪影）'],
];

function pickGood(n) {
  try {
    return fs.readdirSync(GOOD_DIR)
      .filter((f) => /_pure\.mp4$/i.test(f) && !/repair_verify/i.test(f))   // 历史噪声片混在成片目录里，取样时排除
      .map((f) => ({ f, t: fs.statSync(path.join(GOOD_DIR, f)).mtimeMs, sz: fs.statSync(path.join(GOOD_DIR, f)).size }))
      .filter((x) => x.sz > 500000)
      .sort((a, b) => b.t - a.t)
      .slice(0, n)
      .map((x) => path.join(GOOD_DIR, x.f));
  } catch { return []; }
}

function makeDegraded(src, kind, vf) {
  const dst = path.join(WORK, `deg_${kind}_${crypto.createHash('md5').update(src).digest('hex').slice(0, 6)}.mp4`);
  if (fs.existsSync(dst)) return dst;
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-i', src, '-vf', vf, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-an', dst], { timeout: 180000, encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(dst) ? dst : null;
}

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch { return null; } };

/* ── 1. 样本集 ─────────────────────────────── */
const good = pickGood(15);
const bad = [];
// 每个退化类型覆盖 3 个不同源片，避免"只对一张图有效"的伪结论
for (const [kind, vf, desc] of DEGRADATIONS) {
  for (const src of good.slice(0, 3)) {
    const f = makeDegraded(src, kind, vf);
    if (f) bad.push({ file: f, kind, desc, from: path.basename(src) });
    if (bad.length >= 12) break;
  }
  if (bad.length >= 12) break;
}
// 已有的真实噪声样片（H3 采样器错配产物）
try {
  for (const f of fs.readdirSync(BAD_DIR).filter((x) => /\.mp4$/i.test(x))) bad.push({ file: path.join(BAD_DIR, f), kind: 'real_noise', desc: '真实噪声样片（H3 dpmpp 错配）', from: 'bad-samples' });
} catch { /* ignore */ }

/* ── 2. 两口径打分 ─────────────────────────── */
function score(file, withDetail) {
  try {
    const r = S.scoreVideo({ file, detail: withDetail });
    return { F: r.F, Sbad: r.scores.Sbad, degen: !!(r.detail.degeneration && r.detail.degeneration.degenerate), noise: r.detail.degeneration ? r.detail.degeneration.noise_ratio : null };
  } catch (e) { return { error: e.message }; }
}

const rows = [];
for (const f of good) rows.push({ file: f, label: '好片·' + path.basename(f).slice(0, 28), kind: 'good', sha: sha(f) });
for (const b of bad) rows.push({ file: b.file, label: '坏片·' + b.kind, kind: 'bad', degradeKind: b.kind, degrade: b.desc, from: b.from, sha: sha(b.file) });

for (const r of rows) {
  r.v1 = score(r.file, false);   // 旧口径：不启用退化检测
  r.v2 = score(r.file, true);    // 新口径：启用退化检测
}

/* ── 3. 统计 ───────────────────────────────── */
const goodRows = rows.filter((r) => r.kind === 'good' && r.v1.F != null);
const badRows = rows.filter((r) => r.kind === 'bad' && r.v1.F != null);
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

const stat = {
  n_good: goodRows.length,
  n_bad: badRows.length,
  v1: {
    good_mean: mean(goodRows.map((r) => r.v1.F)),
    bad_mean: mean(badRows.map((r) => r.v1.F)),
    bad_above_good: badRows.filter((b) => goodRows.some((g) => b.v1.F > g.v1.F)).length,
    worst: badRows.slice().sort((a, b) => b.v1.F - a.v1.F)[0] || null,
    best_good: goodRows.slice().sort((a, b) => b.v1.F - a.v1.F)[0] || null,
  },
  v2: {
    good_mean: mean(goodRows.map((r) => r.v2.F)),
    bad_mean: mean(badRows.map((r) => r.v2.F)),
    bad_above_good: badRows.filter((b) => goodRows.some((g) => b.v2.F > g.v2.F)).length,
    detected: badRows.filter((b) => b.v2.degen).length,
  },
};
stat.v1.accuracy = +((stat.n_good + stat.n_bad - stat.v1.bad_above_good) / (stat.n_good + stat.n_bad)).toFixed(3);
stat.v2.accuracy = +((stat.n_good + stat.n_bad - stat.v2.bad_above_good) / (stat.n_good + stat.n_bad)).toFixed(3);

/** AUC：随机取一对（好,坏），好片分更高的概率；0.5=随机，1=完全可分 */
function auc(goods, bads) {
  if (!goods.length || !bads.length) return null;
  let win = 0, tot = 0;
  for (const g of goods) for (const b of bads) { tot += 1; if (g > b) win += 1; else if (g === b) win += 0.5; }
  return +(win / tot).toFixed(3);
}
/** Cohen's d：均值差 / 合并标准差 */
function cohensD(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const m = (x) => x.reduce((p, c) => p + c, 0) / x.length;
  const v = (x, mm) => x.reduce((p, c) => p + (c - mm) ** 2, 0) / (x.length - 1);
  const ma = m(a), mb = m(b);
  const sp = Math.sqrt(((a.length - 1) * v(a, ma) + (b.length - 1) * v(b, mb)) / (a.length + b.length - 2));
  return sp ? +((ma - mb) / sp).toFixed(3) : null;
}
const gf1 = goodRows.map((r) => r.v1.F), bf1 = badRows.map((r) => r.v1.F);
const gf2 = goodRows.map((r) => r.v2.F), bf2 = badRows.map((r) => r.v2.F);
stat.v1.auc = auc(gf1, bf1);
stat.v2.auc = auc(gf2, bf2);
stat.v1.cohens_d = cohensD(gf1, bf1);
stat.v2.cohens_d = cohensD(gf2, bf2);
stat.v1.std_good = +Math.sqrt(gf1.reduce((p, c) => p + (c - stat.v1.good_mean) ** 2, 0) / Math.max(1, gf1.length - 1)).toFixed(4);
stat.v2.std_good = +Math.sqrt(gf2.reduce((p, c) => p + (c - stat.v2.good_mean) ** 2, 0) / Math.max(1, gf2.length - 1)).toFixed(4);

/* ── 3b. 按退化类型分组：检测器到底覆盖哪几类 ── */
const byKind = {};
for (const r of badRows) {
  const k = r.degradeKind || r.kind || 'unknown';
  byKind[k] = byKind[k] || { n: 0, detected: 0, v1_best: -1, v2_best: -1 };
  const b = byKind[k];
  b.n += 1;
  if (r.v2.degen) b.detected += 1;
  b.v1_best = Math.max(b.v1_best, r.v1.F ?? 0);
  b.v2_best = Math.max(b.v2_best, r.v2.F ?? 0);
}
stat.by_kind = Object.keys(byKind).map((k) => ({
  kind: k, n: byKind[k].n, detected: byKind[k].detected,
  rate: +(byKind[k].detected / byKind[k].n).toFixed(2),
  v1_max: +byKind[k].v1_best.toFixed(3), v2_max: +byKind[k].v2_best.toFixed(3),
}));

/* ── 4. 输出 ───────────────────────────────── */
const csv = ['label,kind,v1_F,v1_Sbad,v2_F,v2_Sbad,degen,noise_ratio,file']
  .concat(rows.map((r) => [r.label, r.kind, r.v1.F, r.v1.Sbad, r.v2.F, r.v2.Sbad, r.v2.degen, r.v2.noise, path.basename(r.file)].join(',')))
  .join('\n');
fs.writeFileSync(path.join(OUT, 'scorer-bench.csv'), csv, 'utf8');

const bars = (rows2) => {
  const W = 640, H = 260, pad = { l: 60, r: 16, t: 34, b: 62 };
  const max = 0.8;
  const bw = (W - pad.l - pad.r) / rows2.length;
  const items = rows2.map((r, i) => {
    const x = pad.l + i * bw + bw * 0.2;
    const h1 = (r.v1 / max) * (H - pad.t - pad.b);
    const h2 = (r.v2 / max) * (H - pad.t - pad.b);
    const y1 = H - pad.b - h1, y2 = H - pad.b - h2;
    return `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${(bw * 0.28).toFixed(1)}" height="${h1.toFixed(1)}" fill="#c58a6a"/>`
      + `<rect x="${(x + bw * 0.3).toFixed(1)}" y="${y2.toFixed(1)}" width="${(bw * 0.28).toFixed(1)}" height="${h2.toFixed(1)}" fill="#7fa88a"/>`
      + `<text x="${(x + bw * 0.3).toFixed(1)}" y="${H - pad.b + 14}" fill="#8b9199" font-size="9" text-anchor="middle" transform="rotate(-35 ${(x + bw * 0.3).toFixed(1)} ${H - pad.b + 14})">${r.label.slice(0, 12)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#0b0b0d"/>`
    + `<text x="${pad.l}" y="20" fill="#e6e8ec" font-size="12">评分器基准：橙=旧口径(detail off) 绿=新口径(detail on)</text>`
    + `<line x1="${pad.l}" y1="${H - pad.b}" x2="${W - pad.r}" y2="${H - pad.b}" stroke="#2a2f36"/>${items}</svg>`;
};
fs.writeFileSync(path.join(OUT, 'scorer-bench.svg'), bars(rows.map((r) => ({ label: r.label, v1: r.v1.F || 0, v2: r.v2.F || 0 }))), 'utf8');

const md = [];
md.push('# 评分器基准（n=' + rows.length + '：好片 ' + stat.n_good + ' / 坏片 ' + stat.n_bad + '）');
md.push('');
md.push('| 口径 | 好片均分 | 坏片均分 | 坏片压过好片 | 排序准确率 | AUC | Cohen\'s d |');
md.push('|---|---|---|---|---|---|---|');
md.push(`| 旧（detail off） | ${stat.v1.good_mean.toFixed(4)} | **${stat.v1.bad_mean.toFixed(4)}** | **${stat.v1.bad_above_good}/${stat.n_bad}** | ${(stat.v1.accuracy * 100).toFixed(1)}% | ${stat.v1.auc ?? '—'} | ${stat.v1.cohens_d ?? '—'} |`);
md.push(`| 新（detail on） | ${stat.v2.good_mean.toFixed(4)} | **${stat.v2.bad_mean.toFixed(4)}** | **${stat.v2.bad_above_good}/${stat.n_bad}** | **${(stat.v2.accuracy * 100).toFixed(1)}%** | **${stat.v2.auc ?? '—'}** | **${stat.v2.cohens_d ?? '—'}** |`);
md.push('');
md.push('## 按退化类型（检测器覆盖度）');
md.push('');
md.push('| 退化类型 | 样本数 | 新口径检出 | 检出率 | 旧口径最高分 | 新口径最高分 |');
md.push('|---|---|---|---|---|---|');
for (const k of (stat.by_kind || [])) md.push(`| ${k.kind} | ${k.n} | ${k.detected} | ${(k.rate * 100).toFixed(0)}% | ${k.v1_max} | ${k.v2_max} |`);
md.push('');
md.push('## 明细');
md.push('');
md.push('| 样本 | 类型 | 旧 F | 新 F | 退化判定 | noise_ratio |');
md.push('|---|---|---|---|---|---|');
for (const r of rows) md.push(`| ${r.label} | ${r.kind} | ${r.v1.F?.toFixed(4) ?? '—'} | ${r.v2.F?.toFixed(4) ?? '—'} | ${r.v2.degen} | ${r.v2.noise ?? '—'} |`);
fs.writeFileSync(path.join(OUT, 'scorer-bench.md'), md.join('\n'), 'utf8');
fs.writeFileSync(path.join(OUT, 'scorer-bench.json'), JSON.stringify({ stat, rows }, null, 2), 'utf8');

console.log(md.slice(0, 8).join('\n'));
console.log('\n产物：' + OUT);
