/**
 * cloud/seed_experiments.mjs —— 把本地真机跑出来的实验数据导入云端后端
 *
 * 为什么需要：站点「实验/寻优」区读的是后端 /api/experiments；
 * 评委看到的应该是**真机数据**（ABC 对照 / 步数消融 / 贝叶斯），不是编的。
 *
 * 用法：
 *   node cloud/seed_experiments.mjs --base https://your-backend --admin <ADMIN_TOKEN>
 *   node cloud/seed_experiments.mjs --base http://127.0.0.1:8787 --admin dev
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = (argOf('--base', 'http://127.0.0.1:8787') || '').replace(/\/+$/, '');
const ADMIN = argOf('--admin', process.env.ADMIN_TOKEN || '');
const CLOUD = process.env.CLOUD_ROOT || 'D:\\云盘';

const SOURCES = [
  { file: path.join(CLOUD, '04-数据', 'h3abc', '2026-11-19_h3_abc.json'), kind: 'abc', desc: 'A/B/C 控变量对照（同 prompt/seed，只变参数组）' },
  { file: path.join(CLOUD, '04-数据', 'h3real', '2026-11-19_ablation_steps.json'), kind: 'ablation', desc: '步数消融' },
  { file: path.join(CLOUD, '04-数据', 'h3real', '2026-11-19_bayes_real.json'), kind: 'bayes', desc: '贝叶斯寻优（真机）' },
  { file: path.join(CLOUD, '04-数据', 'audit', 'scorer-bench.json'), kind: 'scorer_bench', desc: '评分器基准 n=21（旧口径 47.6% → 新口径 61.9%，AUC 0.625→0.755）' },
];

async function post(body) {
  const r = await fetch(BASE + '/api/experiments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ADMIN ? { 'x-admin-token': ADMIN } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  let v = null; try { v = JSON.parse(t); } catch { /* */ }
  return { status: r.status, json: v, text: t };
}

let okc = 0, skip = 0, bad = 0;
for (const src of SOURCES) {
  if (!fs.existsSync(src.file)) { console.log('  ⚠ 跳过（文件不存在）', path.basename(src.file)); skip += 1; continue; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(src.file, 'utf8')); } catch (e) { console.log('  ✗ 解析失败', path.basename(src.file), e.message); bad += 1; continue; }

  // 统一成 {payload, result}：原始数据整体放 payload，result 取可聚合的标量
  let result = {};
  if (src.kind === 'scorer_bench') {
    result = {
      total: raw.stat?.v2?.good_mean ?? null,
      accuracy_v1: raw.stat?.v1?.accuracy,
      accuracy_v2: raw.stat?.v2?.accuracy,
      auc_v1: raw.stat?.v1?.auc,
      auc_v2: raw.stat?.v2?.auc,
      cohens_d_v1: raw.stat?.v1?.cohens_d,
      cohens_d_v2: raw.stat?.v2?.cohens_d,
      n_good: raw.stat?.n_good, n_bad: raw.stat?.n_bad,
      by_kind: raw.stat?.by_kind,
    };
  } else if (src.kind === 'ablation') {
    const rows = raw.rows || [];
    result = { total: rows.length ? Math.max(...rows.map((r) => Number(r.F) || 0)) : null, rows };
  } else if (src.kind === 'abc') {
    const rows = raw.rows || [];
    result = { total: rows.length ? Math.max(...rows.map((r) => Number(r.F) || 0)) : null, rows };
  } else if (src.kind === 'bayes') {
    result = { total: raw.best?.score ?? null, rounds: raw.rounds, best: raw.best?.params || null, evaluator: raw.evaluator || null };
  }

  const r = await post({ kind: src.kind, payload: { desc: src.desc, source: path.basename(src.file), at: raw.at || null }, result });
  if (r.status === 201) { console.log('  ✅', src.kind, '→', r.json.id, '|', src.desc); okc += 1; }
  else { console.log('  ✗', src.kind, 'HTTP', r.status, (r.json?.error?.code || r.text.slice(0, 80))); bad += 1; }
}

console.log(`\n导入完成：成功 ${okc} · 跳过 ${skip} · 失败 ${bad}`);
if (bad) {
  console.log('提示：写接口需要 ADMIN_TOKEN；未设 ADMIM_TOKEN 时后端不校验，设了就必须带 --admin');
  process.exit(1);
}
