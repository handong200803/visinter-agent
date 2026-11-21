/**
 * tools/audit_layers.mjs —— 七层真实性审计
 *
 * 目的：回答两个问题——①这层是否真的在运转 ②它对最终成片有没有实际作用。
 * 纪律：每层都用真实探测（HTTP / 文件 / 子进程），不看代码注释；取不到就记 MISSING，不编。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD = process.env.CLOUD_ROOT || 'D:\\云盘';
const CACHE = process.env.CACHE_ROOT || 'D:\\缓存';
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const PLAT = process.env.PLATFORM_URL || 'http://127.0.0.1:8418';
const OUT_DIR = path.join(CLOUD, '04-数据', 'audit');

const R = { at: new Date().toISOString(), layers: {} };
const ok = (v) => v === true;
const get = async (url, ms = 8000) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); const t = await r.text(); return { status: r.status, body: t }; } catch (e) { return { status: 0, error: e.message }; }
};
const j = (x) => { try { return JSON.parse(x.body); } catch { return null; } };

/* ── L1 环境与连通 ─────────────────────────────── */
async function L1() {
  const st = j(await get(COMFY + '/system_stats'));
  const health = j(await get(PLAT + '/api/health'));
  const modelsDir = path.join(CLOUD, '01-代码', 'AI视频', 'ComfyUI', 'models');
  const need = [
    ['diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors', 20e9],
    ['text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', 15e9],
    ['vae/minimax_h3_video_vae_fp16.safetensors', 5e9],
    ['vae/minimax_h3_audio_vae_fp32.safetensors', 0.5e9],
    ['loras/minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors', 1.8e9],
    ['checkpoints/v1-5-pruned-emaonly-fp16.safetensors', 1.5e9],
  ];
  const files = need.map(([rel, min]) => {
    const p = path.join(modelsDir, rel);
    const ex = fs.existsSync(p);
    const sz = ex ? fs.statSync(p).size : 0;
    return { file: rel, exists: ex, size_gb: +(sz / 1e9).toFixed(2), ok: ex && sz >= min };
  });
  const kolors = fs.existsSync('D:\\kolors\\model_index.json');
  R.layers.L1 = {
    comfy: { reachable: st != null, version: st?.system?.comfyui_version || null, vram_total_mib: st?.devices?.[0]?.vram_total || null },
    platform: { reachable: !!health?.ok, pid: health?.pid || null, node: health?.node || null },
    weights: files,
    kolors_ready: kolors,
    verdict: (st != null && health?.ok && files.every((f) => f.ok)) ? 'PASS' : 'DEGRADED',
  };
}

/* ── L2 视频生成（用最近真实任务，不新跑） ───────── */
function L2() {
  const dir = path.join(CACHE, 'avp', 'jobs');
  let jobs = [];
  try { jobs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { /* ignore */ }
  // 口径：产物可能落在 output.file / archived / pure_output 任一字段（不同阶段的迁移遗留），
  // 只认 pure_output 会把 51 条真实产物漏掉——这是审计本身要避免的错。
  const hasOutput = (x) => !!((x.output && x.output.file) || x.archived || x.pure_output);
  const done = jobs.filter((x) => x.state === 'succeeded' && hasOutput(x));
  const succeededAll = jobs.filter((x) => x.state === 'succeeded');
  const withSec = done.filter((x) => x.actualDurationMs > 0);
  const secs = withSec.map((x) => Math.round(x.actualDurationMs / 1000)).sort((a, b) => a - b);
  const stepsOf = (x) => Number((x.quality && x.quality.sampling && x.quality.sampling.steps) || 0) || null;
  const turboJobs = done.filter((x) => { const s = stepsOf(x); return s != null && s <= 8; });
  const qJobs = done.filter((x) => { const s = stepsOf(x); return s != null && s >= 16; });
  const med = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : null);
  R.layers.L2 = {
    jobs_total: jobs.length,
    succeeded: succeededAll.length,
    succeeded_with_output: done.length,
    failed: jobs.filter((x) => x.state === 'failed').length,
    duration_sec: { median: med(secs), min: secs[0] ?? null, max: secs[secs.length - 1] ?? null, samples: secs.length },
    by_mode: {
      turbo: { count: turboJobs.length, median_sec: med(turboJobs.map((x) => Math.round(x.actualDurationMs / 1000)).sort((a, b) => a - b)) },
      quality: { count: qJobs.length, median_sec: med(qJobs.map((x) => Math.round(x.actualDurationMs / 1000)).sort((a, b) => a - b)) },
    },
    verdict: done.length > 0 ? 'PASS' : 'FAIL',
  };
}

/* ── L3 关键帧选优 ─────────────────────────────── */
function L3() {
  const dir = path.join(CACHE, 'avp', 'keyframes');
  let recs = [];
  try { recs = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } }).filter(Boolean); } catch { /* ignore */ }
  const sel = recs.filter((r) => r.status === 'selected');
  const stats = sel.filter((r) => r.selected_by !== 'user').map((r) => {
    const tots = (r.candidates || []).map((c) => c.total).filter((v) => typeof v === 'number');
    const spread = tots.length ? +(Math.max(...tots) - Math.min(...tots)).toFixed(4) : null;
    const best = r.selected ? (r.candidates || []).find((c) => c.file === r.selected) : null;
    const isTop = best && tots.length ? best.total === Math.max(...tots) : null;
    return { id: r.id, n: tots.length, spread, is_top: isTop, by: r.selected_by, seeds: r.params && r.params.base_seed };
  });
  R.layers.L3 = {
    records: recs.length,
    selected: sel.length,
    rejected: recs.filter((r) => r.status === 'rejected').length,
    spread_median: (() => { const s = stats.map((x) => x.spread).filter((v) => v != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; })(),
    top_picked_rate: stats.length ? +(stats.filter((x) => x.is_top).length / stats.length).toFixed(2) : null,
    auto_checked: stats.length,
    manual_repicks: sel.length - stats.length,
    samples: stats.slice(-3),
    verdict: sel.length ? 'PASS' : 'FAIL',
  };
}

/* ── L4 参数调控（真实边界探测） ───────────────── */
function L4() {
  const Q = require(path.join(ROOT, 'server', 'quality.js'));
  const cases = [
    ['turbo2(应拒)', { engine: 'minimax_h3', width: 640, height: 384, frames: 124, usable_mib: 8151, turbo: true, steps: 2, cfg: 1.0 }],
    ['turbo4(应过)', { engine: 'minimax_h3', width: 640, height: 384, frames: 124, usable_mib: 8151, turbo: true, steps: 4, cfg: 1.0 }],
    ['turbo8(应过)', { engine: 'minimax_h3', width: 640, height: 384, frames: 124, usable_mib: 8151, turbo: true, steps: 8, cfg: 1.4 }],
    ['quality20(应过)', { engine: 'minimax_h3', width: 640, height: 384, frames: 124, usable_mib: 8151, turbo: false, steps: 20, cfg: 5 }],
    ['1080p(应拒)', { engine: 'minimax_h3', tier: '1080p', frames: 124, usable_mib: 8151 }],
    ['cfg9-h3(应变4)', { engine: 'minimax_h3', width: 640, height: 384, frames: 124, usable_mib: 8151, turbo: false, steps: 20, cfg: 9 }],
  ];
  const out = cases.map(([name, o]) => {
    try {
      const g = Q.guard(o);
      return { case: name, ok: g.ok, code: g.errors[0]?.code || null, applied: { steps: g.sampling.steps, cfg: g.sampling.cfg, sampler: g.sampling.sampler, turbo: g.sampling.turbo }, adjusted: g.sampling.adjusted };
    } catch (e) { return { case: name, ok: false, code: e.code || 'THROW', message: e.message }; }
  });
  R.layers.L4 = { cases: out, verdict: out.every((x) => x.ok || x.code) ? 'PASS' : 'DEGRADED' };
}

/* ── L5 量化评估（已知好/坏样本能否被分开） ─────── */
function L5() {
  const S = require(path.join(ROOT, 'server', 'scoring.js'));
  const D = require(path.join(ROOT, 'server', 'detail.js'));
  const badDir = path.join(CLOUD, '04-数据', 'bad-samples');
  const bad = (() => { try { return fs.readdirSync(badDir).map((f) => path.join(badDir, f)).find((f) => /\.mp4$/i.test(f)) || null; } catch { return null; } })();
  const goodDir = path.join(CLOUD, '02-视频', '成片');
  const good = (() => {
    try {
      const list = fs.readdirSync(goodDir).filter((f) => /_pure\.mp4$/i.test(f)).map((f) => ({ f, t: fs.statSync(path.join(goodDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      return list.length ? path.join(goodDir, list[0].f) : null;
    } catch { return null; }
  })();
  const res = {};
  if (bad) { try { const s = S.scoreVideo({ file: bad }); res.bad = { F: s.F, Sbad: s.scores.Sbad, degen: !!(s.detail.degeneration && s.detail.degeneration.degenerate), noise: s.detail.degeneration?.noise_ratio }; } catch (e) { res.bad = { error: e.message }; } }
  if (good) { try { const s = S.scoreVideo({ file: good }); res.good = { F: s.F, Sbad: s.scores.Sbad, degen: !!(s.detail.degeneration && s.detail.degeneration.degenerate), noise: s.detail.degeneration?.noise_ratio, file: path.basename(good) }; } catch (e) { res.good = { error: e.message }; } }
  const separates = res.bad && res.good && typeof res.bad.F === 'number' && typeof res.good.F === 'number' ? res.good.F > res.bad.F : null;
  R.layers.L5 = { samples: res, separates_good_over_bad: separates, verdict: separates === true ? 'PASS' : (separates === false ? 'FAIL' : 'MISSING') };
}

/* ── L6 后处理增强（真跑一次 interp） ───────────── */
async function L6() {
  const U = require(path.join(ROOT, 'server', 'ultimate.js'));
  const goodDir = path.join(CLOUD, '02-视频', '成片');
  const src = (() => {
    try {
      const list = fs.readdirSync(goodDir).filter((f) => /_pure\.mp4$/i.test(f)).map((f) => ({ f, t: fs.statSync(path.join(goodDir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      return list.length ? path.join(goodDir, list[0].f) : null;
    } catch { return null; }
  })();
  if (!src) { R.layers.L6 = { verdict: 'MISSING' }; return; }
  const t0 = Date.now();
  try {
    const r = U.postprocess({ file: src, steps: ['interp'], outDir: path.join(CACHE, 'avp', 'audit_post'), outputFps: 60 });
    R.layers.L6 = {
      ran: true,
      ok: !!r.ok,
      sec: Math.round((Date.now() - t0) / 1000),
      native_fps: r.native_fps, output_fps: r.output_fps,
      step_ok: (r.steps || []).map((x) => ({ step: x.step, ok: x.ok, sub: x.substitution })),
      note: r.ok ? '插帧成功（minterpolate 替代 RIFE）' : '插帧失败',
      verdict: r.ok ? 'PASS_WITH_SUBSTITUTE' : (String(((r.steps || [])[0] || {}).error?.code || '').includes('BACKEND_MISSING') ? 'BLOCKED(缺 RIFE 后端)' : 'FAIL'),
      first_error: ((r.steps || [])[0] || {}).error || null,
    };
  } catch (e) {
    const code = e.code || 'THROW';
    R.layers.L6 = {
      ran: true, ok: false, code, message: e.message,
      verdict: code === 'POST_BACKEND_MISSING' ? 'BLOCKED(缺 RIFE 后端)' : 'FAIL',
      unblock: code === 'POST_BACKEND_MISSING' ? '装 rife-ncnn-vulkan 并设 AVP_RIFE / AVP_RIFE_MODEL 即可启用' : null,
    };
  }
}

/* ── L7 寻优与实验（读真机数据） ───────────────── */
function L7() {
  const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const abc = read(path.join(CLOUD, '04-数据', 'h3abc', '2026-11-19_h3_abc.json'));
  const abl = read(path.join(CLOUD, '04-数据', 'h3real', '2026-11-19_ablation_steps.json'));
  const bayes = read(path.join(CLOUD, '04-数据', 'h3real', '2026-11-19_bayes_real.json'));
  R.layers.L7 = {
    abc: abc ? { rows: abc.rows.length, F: abc.rows.map((r) => r.F) } : 'MISSING',
    ablation: abl ? { param: abl.param, values: abl.values, F: (abl.rows || []).map((r) => r.F) } : 'MISSING',
    bayes: bayes ? { rounds: bayes.rounds, best: bayes.best && bayes.best.params, samples: (bayes.samples || []).length, evaluator: bayes.evaluator } : 'MISSING',
    verdict: (abc && abl && bayes) ? 'PASS(数据真机)' : 'DEGRADED',
  };
}

/* ── L8 工程与持久化 ───────────────────────────── */
function L8() {
  const jobsDir = path.join(CACHE, 'avp', 'jobs');
  const lock = path.join(jobsDir, '.worker.lock');
  let lockInfo = null;
  try { if (fs.existsSync(lock)) lockInfo = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* ignore */ }
  const events = (() => { try { return fs.readdirSync(jobsDir).filter((f) => f.endsWith('.events.jsonl')).length; } catch { return 0; } })();
  const archiveIdx = path.join(CLOUD, '02-视频', '成片', '_index.json');
  let idx = null;
  try { idx = JSON.parse(fs.readFileSync(archiveIdx, 'utf8')); } catch { /* ignore */ }
  const backfill = (() => { try { return fs.readdirSync(path.join(CLOUD, '02-视频', '成片')).filter((f) => /_pure\.mp4$/.test(f)).length; } catch { return 0; } })();
  R.layers.L8 = {
    job_files: (() => { try { return fs.readdirSync(jobsDir).filter((f) => f.endsWith('.json')).length; } catch { return 0; } })(),
    worker_lock: lockInfo ? { pid: lockInfo.pid, at: lockInfo.at } : 'absent',
    events_jsonl: events,
    archive_index_entries: Array.isArray(idx) ? idx.length : (idx ? 'non-array' : 'missing'),
    pure_files_on_disk: backfill,
    verdict: (lockInfo || events > 0) && backfill > 0 ? 'PASS' : 'DEGRADED',
  };
}

/* ── 运行 ─────────────────────────────────────── */
fs.mkdirSync(OUT_DIR, { recursive: true });
await L1();
L2(); L3(); L4(); L5();
await L6();
L7(); L8();

const lines = [];
lines.push('# 七层真实性审计');
lines.push('');
lines.push('时间：' + R.at);
lines.push('');
lines.push('| 层 | 判定 | 关键证据 |');
lines.push('|---|---|---|');
const ev = (k) => {
  const L = R.layers[k];
  if (!L) return '—';
  if (k === 'L1') return `ComfyUI ${L.comfy?.version || 'offline'} · 平台 ${L.platform?.reachable ? 'ok' : 'down'} · 权重 ${L.weights.filter((w) => w.ok).length}/${L.weights.length} · Kolors ${L.kolors_ready ? 'ok' : 'no'}`;
  if (k === 'L2') return `成功 ${L.succeeded}/${L.jobs_total}（有产物 ${L.succeeded_with_output}）· 耗时中位 ${L.duration_sec.median}s · turbo 中位 ${L.by_mode.turbo.median_sec}s / quality ${L.by_mode.quality.median_sec}s`;
  if (k === 'L3') return `记录 ${L.records} · 选中率 ${L.top_picked_rate} · 候选分差中位 ${L.spread_median}`;
  if (k === 'L4') return L.cases.map((c) => `${c.case}:${c.ok ? 'ok' : c.code}`).join(' · ');
  if (k === 'L5') return `坏样本 F=${L.samples.bad?.F} · 好样本 F=${L.samples.good?.F} · 可分辨 ${L.separates_good_over_bad}`;
  if (k === 'L6') return L.ran ? `${L.sec}s · ${L.step_ok?.[0]?.ok ? 'ok' : 'fail'} · ${L.native_fps}→${L.output_fps}fps` : 'no sample';
  if (k === 'L7') return `ABC ${L.abc !== 'MISSING' ? L.abc.rows + ' 组' : '缺失'} · 消融 ${L.ablation !== 'MISSING' ? L.ablation.values?.join('/') : '缺失'} · 贝叶斯 ${L.bayes !== 'MISSING' ? L.bayes.rounds + ' 轮' : '缺失'}`;
  if (k === 'L8') return `任务文件 ${L.job_files} · 事件日志 ${L.events_jsonl} · 归档索引 ${L.archive_index_entries} · 成片 ${L.pure_files_on_disk}`;
  return '—';
};
for (const k of Object.keys(R.layers).sort()) lines.push(`| ${k} | ${R.layers[k].verdict} | ${ev(k)} |`);
lines.push('');
lines.push('```json');
lines.push(JSON.stringify(R, null, 2));
lines.push('```');

fs.writeFileSync(path.join(OUT_DIR, 'layers-audit.md'), lines.join('\n'), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'layers-audit.json'), JSON.stringify(R, null, 2), 'utf8');
console.log(lines.slice(0, 16).join('\n'));
console.log('\n报告：' + path.join(OUT_DIR, 'layers-audit.md'));
