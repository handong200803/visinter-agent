/**
 * h3real.js —— 质量优先真机闭环：GP + EI / 单参数消融 → 原片归档 → 四维打分。
 * 仅优化 steps / cfg / denoise；shift_video 固定 12，原生 24fps，不降分辨率。
 * 默认 1280×720，20 / 7 / 0.65；耗时不进入目标函数，不以失败样本伪造分数。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const H3 = require('./h3workflow.js');
const Q = require('./quality.js');
const SCORE = require('./scoring.js');
const BAYES = require('./bayes.js');
const ARCHIVE = require('./archive.js');
const ENG = require('./engines.js');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const COMFY_OUTPUT = path.resolve(process.env.COMFY_OUTPUT_DIR || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '01-代码', 'AI视频', 'ComfyUI', 'output'));
const DEFAULTS = Object.freeze({ steps: 20, cfg: 7, denoise: 0.65, shift: 12 });
const SPACE = Object.freeze(Object.fromEntries(['steps', 'cfg', 'denoise'].map((key) => {
  const [min, max] = Q.load().sampling[key];
  return [key, Object.freeze({ min, max, type: key === 'steps' ? 'int' : 'float', step: key === 'steps' ? 1 : key === 'cfg' ? 0.1 : 0.01 })];
})));
const fail = (code, message) => Object.assign(new Error(message), { code, status: 422 });
function number(value, key) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value))) throw fail('H3REAL_BAD_PARAM', `${key} 必须为有限数值`);
  return Number(value);
}

/** 实验入口拒绝越界，不能把 H3.build 的夹紧结果冒充所请求的参数。 */
function validateParams(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('H3REAL_BAD_PARAM', '参数必须是对象');
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULTS, key)) throw fail('H3REAL_BAD_PARAM', `不支持的实验参数：${key}`);
  const p = { ...DEFAULTS, ...input };
  for (const [key, d] of Object.entries(SPACE)) {
    p[key] = number(p[key], key);
    if (p[key] < d.min || p[key] > d.max || (d.type === 'int' && !Number.isInteger(p[key]))) throw fail('H3REAL_BAD_PARAM', `${key} 必须在 ${d.min}..${d.max}${d.type === 'int' ? ' 且为整数' : ''}`);
  }
  p.shift = number(p.shift, 'shift');
  if (p.shift !== 12) throw fail('H3REAL_BAD_PARAM', '质量实验 shift_video 固定为 12；不使用 i2v_strength 代替');
  return p;
}
function requestedParams(o) {
  return validateParams(Object.fromEntries(Object.keys(DEFAULTS).filter((key) => o[key] !== undefined).map((key) => [key, o[key]])));
}
function baseline(o) {
  if (o.base != null) validateParams(o.base);
  return validateParams({ ...requestedParams(o), ...(o.base ?? {}) });
}

/** 一次解析固定实验条件；传给每轮的 seed 必须已经是正整数。 */
function experimentOptions(o = {}) {
  const prompt = String(o.prompt || '').trim();
  if (!prompt) throw fail('H3REAL_NO_PROMPT', '需要 prompt');
  const params = requestedParams(o);
  for (const key of ['ranges', 'space', 'keys']) if (o[key] != null) throw fail('H3REAL_BAD_PARAM', `${key} 不支持覆盖；实验只使用 Q 质量区间`);
  for (const key of ['fps', 'native_fps', 'output_fps']) if (o[key] != null && number(o[key], key) !== 24) throw fail('H3REAL_BAD_FPS', '原片实验固定 24fps，不进行增强或插帧');
  if (o.shiftVideo != null && number(o.shiftVideo, 'shiftVideo') !== 12) throw fail('H3REAL_BAD_PARAM', 'shiftVideo 固定为 12');
  const disabled = [false, 0, 'false', 'off', 'none', '0', ''];
  for (const key of ['turbo', 'lora', 'distill', 'distilled', 'teacache', 'sage_attn', 'nunchaku', 'speed_mode', 'lowres_preview', 'auto_downscale', 'auto_step_reduce']) {
    if (o[key] != null && !disabled.includes(o[key])) throw fail('H3REAL_BAD_QUALITY', `质量实验禁止 ${key}`);
  }
  if (o.loraStrength != null && number(o.loraStrength, 'loraStrength') !== 0) throw fail('H3REAL_BAD_QUALITY', '质量实验禁止蒸馏 LoRA');
  for (const key of ['dtype', 'quant', 'weight_dtype']) if (o[key] != null && !['fp16', 'bf16', 'fp32', 'default', 'none', false].includes(o[key])) throw fail('H3REAL_BAD_QUALITY', '质量实验禁止量化权重');
  for (const key of ['sampler', 'scheduler']) if (o[key] != null && o[key] !== Q.load().sampling[key]) throw fail('H3REAL_BAD_QUALITY', `${key} 必须为 ${Q.load().sampling[key]}`);
  const tier = o.tier == null ? null : Q.tierById(o.tier);
  if (o.tier != null && !tier) throw fail('H3REAL_BAD_RESOLUTION', `未知分辨率档位：${o.tier}`);
  const width = number(o.width ?? (tier ? tier.width : 1280), 'width');
  const height = number(o.height ?? (tier ? tier.height : 720), 'height');
  if (tier && (width !== tier.width || height !== tier.height)) throw fail('H3REAL_BAD_RESOLUTION', '显式宽高与 tier 冲突；不自动覆盖分辨率');
  const seconds = number(o.seconds ?? 5, 'seconds');
  if (seconds <= 0) throw fail('H3REAL_BAD_PARAM', 'seconds 必须为正数');
  const frames = H3.snapFrames(seconds).frames;
  if (o.frames != null && number(o.frames, 'frames') !== frames) throw fail('H3REAL_BAD_PARAM', 'frames 与 seconds 对应的 H3 帧数不一致');
  let seed = number(o.seed ?? 20261119, 'seed');
  if (seed === -1) seed = 1 + Math.floor(Math.random() * 2147483646);
  if (!Number.isSafeInteger(seed) || seed <= 0) throw fail('H3REAL_BAD_PARAM', 'seed 必须为正安全整数，或 -1（实验开始时随机一次）');
  const timeoutMs = o.timeoutMs == null || o.timeoutMs === Infinity ? Infinity : number(o.timeoutMs, 'timeoutMs');
  if (timeoutMs < 0) throw fail('H3REAL_BAD_PARAM', 'timeoutMs 不能为负数');
  const fixed = { prompt, width, height, seconds, frames, seed, tier: tier ? tier.id : undefined, fps: 24, native_fps: 24, output_fps: 24, shiftVideo: 12, turbo: false, lora: false, usableMib: o.usableMib, timeoutMs };
  Q.assertAllowed(Q.guard({ ...fixed, ...params, engine: 'minimax_h3', usable_mib: o.usableMib }));
  return fixed;
}
function experimentContext(fixed) {
  return { mode: Q.load().mode, prompt: fixed.prompt, width: fixed.width, height: fixed.height, tier: fixed.tier || null, frames: fixed.frames, seconds: +(fixed.frames / 24).toFixed(3), requested_seconds: fixed.seconds, seed: fixed.seed, fps: 24, native_fps: 24, output_fps: 24, shift: 12, variant: 'pure', turbo: false, lora: false, weights_policy: Q.load().weights_policy, timeout_ms: Number.isFinite(fixed.timeoutMs) ? fixed.timeoutMs : null };
}
function dirFor(tag) {
  const d = path.join(CACHE_ROOT, 'avp', 'h3real', `${tag}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
async function waitDone(id, limitMs = Infinity, onTick = () => {}) {
  const t0 = Date.now();
  for (;;) {
    const st = await H3.status(id);
    if (st.done) return st;
    if (Date.now() - t0 >= limitMs) return { done: false, timeout: true };
    onTick(Math.round((Date.now() - t0) / 1000));
    await new Promise((r) => setTimeout(r, 8000));
  }
}
function buildRecord(built, fixed, requested) {
  const m = built.meta;
  const expected = { width: fixed.width, height: fixed.height, frames: fixed.frames, seed: fixed.seed, native_fps: 24, output_fps: 24, steps: requested.steps, cfg: requested.cfg, denoise: requested.denoise, sampler: Q.load().sampling.sampler, scheduler: Q.load().sampling.scheduler };
  for (const [key, value] of Object.entries(expected)) if (!m || m[key] !== value) throw fail('H3REAL_BUILD_MISMATCH', `实际构建的 ${key} 与固定实验条件不一致`);
  const shift = built.workflow['2'].inputs.shift_video;
  if (shift !== 12) throw fail('H3REAL_BUILD_MISMATCH', '实际 shift_video 不是 12');
  return { params: { ...m, shift }, built: { meta: m, quality: built.quality, risk: built.risk, applied: built.applied }, risk: built.risk, variant: 'pure' };
}

/** 直调 H3.run 保留未量化权重断言；不安装、不增强，归档成功后才对原片打分。 */
async function generateScore(o = {}) {
  const fixed = experimentOptions(o);
  const requested = requestedParams(o);
  const say = o.say || (() => {});
  const args = { ...fixed, ...requested, prefix: o.prefix };
  const t0 = Date.now();
  let evidence = buildRecord(H3.build(args), fixed, requested);
  let r;
  try { r = await H3.run(args); } catch (e) { return { ...evidence, error: 'SUBMIT_FAILED', code: e.code, detail: e.message }; }
  if (r.built) evidence = buildRecord(r.built, fixed, requested);
  evidence.prompt_id = r.prompt_id;
  if (!r.ok) return { ...evidence, error: 'SUBMIT_FAILED', detail: r.error };
  let st;
  try { st = await waitDone(r.prompt_id, fixed.timeoutMs, (s) => say(`  生成中 ${s}s`)); } catch (e) { return { ...evidence, error: 'STATUS_FAILED', detail: e.message }; }
  if (!st.done || st.state !== 'success') return { ...evidence, error: st.timeout ? 'TIMEOUT' : 'EXEC_ERROR', status: st.status || null };
  const im = (st.images || []).find((x) => /\.(mp4|webm|mov|mkv)$/i.test(String(x.filename || '')));
  if (!im) return { ...evidence, error: 'NO_OUTPUT' };
  const rawFile = path.resolve(COMFY_OUTPUT, im.subfolder || '', im.filename);
  if (!rawFile.startsWith(COMFY_OUTPUT + path.sep)) return { ...evidence, error: 'BAD_OUTPUT_PATH' };
  evidence.raw_file = rawFile;
  let archived;
  try {
    const id = String(r.prompt_id).replace(/[^\w-]/g, '_');
    archived = ARCHIVE.archivePath(rawFile, { job_id: r.prompt_id, experiment_id: o.experimentId || null, engine: 'minimax_h3', prompt: fixed.prompt, variant: 'pure', name: `${id}_pure${path.extname(rawFile)}`, params: { ...evidence.params, quality: evidence.built.quality }, duration_ms: Date.now() - t0 });
    if (!archived || archived.error || !archived.file) return { ...evidence, error: 'ARCHIVE_FAILED', detail: archived };
  } catch (e) { return { ...evidence, error: 'ARCHIVE_FAILED', detail: e.message }; }
  evidence = { ...evidence, file: archived.file, archive: archived.record };
  let score;
  try {
    score = await SCORE.scoreVideo({ file: archived.file, pure_output: archived.file, sample_kind: 'pure' });
    const validScore = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
    if (!score || !validScore(score.F) || !['Sface', 'Sflow', 'Sstyle', 'Sbad'].every((key) => score.scores && validScore(score.scores[key]))) throw new Error('评分器未返回完整的 0..1 有限分数');
  } catch (e) { return { ...evidence, error: 'SCORE_FAILED', detail: e.message }; }
  const ms = Date.now() - t0;
  say(`  生成 ${im.filename} · ${Math.round(ms / 1000)}s · F=${score.F.toFixed(4)}`);
  return { ...evidence, ms, F: score.F, scores: score.scores, detail: score.detail };
}

const toU = (p) => Object.entries(SPACE).map(([key, d]) => (p[key] - d.min) / (d.max - d.min));
const fromU = (u) => {
  if (!Array.isArray(u) || u.length !== 3 || u.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) throw fail('H3REAL_BAD_PARAM', 'EI 点必须在 [0,1]^3');
  return validateParams(Object.fromEntries(Object.entries(SPACE).map(([key, d], i) => [key, +((Math.round((d.min + u[i] * (d.max - d.min)) / d.step) * d.step).toFixed(2))])));
};
const samePoint = (a, b) => Object.keys(SPACE).every((key) => a[key] === b[key]);
function csvRow(values) { return values.map((value) => JSON.stringify(value == null ? '' : value)).join(','); }
function sampleCells(s) {
  const p = s.params || s.requested_params;
  return [p.steps, p.cfg, p.denoise, p.shift, p.width, p.height, p.frames, p.seed, p.native_fps, s.F, ...['Sface', 'Sflow', 'Sstyle', 'Sbad'].map((key) => s.scores && s.scores[key]), s.file, s.raw_file, s.error];
}
const CSV_FIELDS = 'steps,cfg,denoise,shift,width,height,frames,seed,fps,F,Sface,Sflow,Sstyle,Sbad,file,raw_file,error';

async function bayesReal(o = {}) {
  const fixed = experimentOptions(o);
  const base = baseline(o);
  const rounds = number(o.rounds ?? 3, 'rounds');
  if (!Number.isInteger(rounds) || rounds < 2 || rounds > 6) throw fail('H3REAL_BAD_PARAM', 'rounds 必须为 2..6 的整数');
  const dir = dirFor('bayes');
  const say = o.onProgress || ((m) => console.log('[bayesReal] ' + m));
  const samples = [], X = [], y = [];
  for (let i = 1; i <= rounds; i += 1) {
    const pick = X.length ? BAYES.maxEI(X, y, Math.max(...y), 0.4, 3, 600) : null;
    let p = pick ? fromU(pick.u) : base;
    if (samples.some((s) => samePoint(s.requested_params, p))) {
      // 少量轮次内总能找到未测步数；所有候选仍在 Q 区间，绝不退回 turbo。
      for (let steps = SPACE.steps.min; steps <= SPACE.steps.max; steps += 1) {
        const candidate = { ...p, steps };
        if (!samples.some((s) => samePoint(s.requested_params, candidate))) { p = candidate; break; }
      }
    }
    say(`第 ${i}/${rounds} 轮：${pick ? 'EI 选点' : '质量基线'} steps=${p.steps} cfg=${p.cfg} denoise=${p.denoise} shift=12`);
    const r = await generateScore({ ...fixed, ...p, prefix: i === 1 ? 'h3/rb_base' : `h3/rb_${i}`, experimentId: path.basename(dir), say });
    samples.push({ round: i, source: pick ? 'ei' : 'baseline', requested_params: p, ei: pick ? pick.ei : null, ...r });
    if (!r.error) { X.push(toU(r.params)); y.push(r.F); }
    else if (!X.length) break; // 基线失败仍落盘证据，不反复提交无法评分的起点。
  }
  const bestSample = samples.filter((s) => Number.isFinite(s.F)).sort((a, b) => b.F - a.F)[0] || null;
  let applied = null;
  if (bestSample && o.apply !== false) {
    try {
      ENG.patch('minimax_h3', { 'kf.steps': bestSample.params.steps, 'kf.cfg': bestSample.params.cfg, 'kf.refine_denoise': bestSample.params.denoise });
      applied = ['kf.steps', 'kf.cfg', 'kf.refine_denoise'];
    } catch (e) { applied = 'FAILED: ' + e.message; }
  }
  const csv = path.join(dir, 'bayes_real.csv');
  fs.writeFileSync(csv, `round,source,${CSV_FIELDS}\n` + samples.map((s) => csvRow([s.round, s.source, ...sampleCells(s)])).join('\n') + '\n', 'utf8');
  const report = { ...experimentContext(fixed), base, space: SPACE, rounds, samples, best: bestSample, applied, evaluator: 'measured', dir, csv, at: new Date().toISOString() };
  if (!bestSample) report.error = 'NO_SCORED_SAMPLES';
  fs.writeFileSync(path.join(dir, 'bayes_real.json'), JSON.stringify(report, null, 2));
  return report;
}

function svgBars(title, rows, { width = 520, height = 260 } = {}) {
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const pad = { l: 44, r: 16, t: 34, b: 34 };
  const max = Math.max(1e-6, ...rows.filter((r) => Number.isFinite(r.F)).map((r) => r.F));
  const bw = (width - pad.l - pad.r) / Math.max(1, rows.length);
  const bars = rows.map((r, i) => {
    const valid = Number.isFinite(r.F);
    const h = valid ? (r.F / max) * (height - pad.t - pad.b) : 0;
    const x = pad.l + i * bw + bw * 0.18;
    const y = height - pad.b - h;
    return (valid ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.64).toFixed(1)}" height="${h.toFixed(1)}" fill="#8aa0b8"/>` : '')
      + `<text x="${(x + bw * 0.32).toFixed(1)}" y="${(y - 6).toFixed(1)}" fill="#d4d8de" font-size="11" text-anchor="middle">${valid ? r.F.toFixed(3) : 'N/A'}</text>`
      + `<text x="${(x + bw * 0.32).toFixed(1)}" y="${height - pad.b + 16}" fill="#7a8089" font-size="11" text-anchor="middle">${escape(r.label)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + '<rect width="100%" height="100%" fill="#0b0b0d"/>'
    + `<text x="${pad.l}" y="22" fill="#d4d8de" font-size="13">${escape(title)}</text>`
    + `<line x1="${pad.l}" y1="${height - pad.b}" x2="${width - pad.r}" y2="${height - pad.b}" stroke="#2a2f36"/>` + bars + '</svg>';
}

async function ablationReal(o = {}) {
  const fixed = experimentOptions(o);
  const param = o.param ?? 'steps';
  if (!Object.hasOwn(SPACE, param)) throw fail('H3REAL_BAD_PARAM', '消融只允许 steps / cfg / denoise');
  const defaults = { steps: [16, 20, 25], cfg: [7, 8.5, 10], denoise: [0.55, 0.65, 0.75] };
  const input = o.values ?? defaults[param];
  if (!Array.isArray(input) || !input.length) throw fail('H3REAL_BAD_PARAM', 'values 必须为非空数组');
  const base = baseline(o);
  // 先校验整组，禁止生成一半才发现调用方的后续值越界。
  const points = input.map((value) => validateParams({ ...base, [param]: value }));
  const values = points.map((p) => p[param]);
  const dir = dirFor(`abl_${param}`);
  const say = o.onProgress || ((m) => console.log('[ablationReal] ' + m));
  const rows = [];
  for (const p of points) {
    const v = p[param];
    say(`${param}=${v}`);
    const r = await generateScore({ ...fixed, ...p, prefix: `h3/abl_${param}_${String(v).replace('.', 'p')}`, experimentId: path.basename(dir), say });
    rows.push({ label: String(v), value: v, requested_params: p, ...r });
  }
  const csv = path.join(dir, `ablation_${param}.csv`);
  fs.writeFileSync(csv, `value,${CSV_FIELDS}\n` + rows.map((r) => csvRow([r.value, ...sampleCells(r)])).join('\n') + '\n', 'utf8');
  const svgFile = path.join(dir, `ablation_${param}.svg`);
  fs.writeFileSync(svgFile, svgBars(`H3 单参数消融 · ${param}（原片四维 F）`, rows), 'utf8');
  const report = { ...experimentContext(fixed), param, values, base, rows, dir, csv, svg: svgFile, at: new Date().toISOString(), evaluator: 'measured' };
  if (!rows.some((r) => Number.isFinite(r.F))) report.error = 'NO_SCORED_SAMPLES';
  fs.writeFileSync(path.join(dir, `ablation_${param}.json`), JSON.stringify(report, null, 2));
  return report;
}

module.exports = { bayesReal, ablationReal, generateScore, svgBars, SPACE, validateParams, experimentOptions, experimentContext };
