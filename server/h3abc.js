/**
 * h3abc.js —— H3 质量优先 A/B/C 对照：每组真生成，原片归档后四维打分。
 * A：20 steps / CFG 7 / denoise 0.65；B：25 / 8.5 / 0.65。
 * C：只在 Q 允许的 steps / cfg / denoise 上用 proxy 挑选，再真跑取分。
 * 所有组固定 shift_video=12、正 seed、分辨率/帧数、原生 24fps；不使用 turbo/量化。
 * proxy 的参数合理性分数不是画面质量，绝不替代真机评分。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const BAYES = require('./bayes.js');
const ENG = require('./engines.js');
const Q = require('./quality.js');
const REAL = require('./h3real.js');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';

function groups() {
  return [
    { id: 'A', label: '质量基线（20 步 / CFG 7 / denoise 0.65）', steps: 20, cfg: 7, denoise: 0.65, shift: 12 },
    { id: 'B', label: '质量对照（25 步 / CFG 8.5 / denoise 0.65）', steps: 25, cfg: 8.5, denoise: 0.65, shift: 12 },
    { id: 'C', label: '贝叶斯候选（proxy 挑参 → 原片真机评分）', steps: null, cfg: null, denoise: null, shift: 12 },
  ];
}

/** proxy 只用于选参，目标中心是显式启发式，不声称已知最佳画面质量。 */
async function bayesPick(o = {}) {
  const fixed = REAL.experimentOptions({ ...o, prompt: o.prompt ?? 'H3 quality proxy (no generation)' });
  const quality = Q.assertAllowed(Q.guard({ ...fixed, engine: 'minimax_h3', steps: 20, cfg: 7, denoise: 0.65, usable_mib: fixed.usableMib }));
  const snapshot = { ...REAL.experimentContext(fixed), source: 'ENG.defaults()', quality, evaluator: 'proxy' };
  // 覆盖旧引擎缓存的采样/精度/加速值；不把旧 turbo 快照作为实验起点。
  const seedValues = {
    ...ENG.defaults(),
    'kf.steps': 20, 'kf.cfg': 7, 'kf.refine_denoise': 0.65,
    'kf.width': fixed.width, 'kf.height': fixed.height, 'kf.seed': fixed.seed,
    'kf.sampler': quality.sampling.sampler, 'kf.scheduler': quality.sampling.scheduler,
    'kf.dtype': 'fp16', 'kf.teacache': false, 'kf.sage_attn': false, 'kf.nunchaku': false, 'kf.turbo': false,
    'mo.fps': 24, 'mo.max_frames': fixed.frames, 'ex.fps': '24',
    prompt: fixed.prompt, width: fixed.width, height: fixed.height, frames: fixed.frames, seconds: fixed.seconds,
    seed: fixed.seed, native_fps: 24, output_fps: 24, shiftVideo: 12, turbo: false, lora: false,
    quality_snapshot: snapshot,
  };
  const target = { steps: 22, cfg: 8.5, denoise: 0.65 };
  const opt = await BAYES.optimize({
    engine: 'minimax_h3',
    // optimize 的白名单只有这三项；范围统一来自 Q，不能注入 i2v_strength 等伪维度。
    keys: ['kf.steps', 'kf.cfg', 'kf.refine_denoise'],
    seedValues,
    evaluate: async (p) => {
      const params = REAL.validateParams({ steps: p['kf.steps'], cfg: p['kf.cfg'], denoise: p['kf.refine_denoise'] });
      const distance = Object.entries(REAL.SPACE).reduce((sum, [key, d]) => sum + Math.abs(params[key] - target[key]) / (d.max - d.min), 0);
      const fit = Math.max(0, 1 - distance / 3);
      return { scores: { Sface: fit, Sflow: fit, Sstyle: fit, Sbad: 0 }, detail: { evaluator: 'proxy', rule: 'distance_to_heuristic_quality_target', target } };
    },
    maxIter: 6, patience: 2, evaluateKind: 'proxy', apply: false,
  });
  const params = REAL.validateParams({ steps: opt.best.params['kf.steps'], cfg: opt.best.params['kf.cfg'], denoise: opt.best.params['kf.refine_denoise'] });
  return { ...params, snapshot, opt };
}

async function run(o = {}) {
  if (!String(o.prompt || '').trim()) throw Object.assign(new Error('需要 prompt'), { code: 'H3ABC_NO_PROMPT' });
  const fixed = REAL.experimentOptions(o);
  const say = o.onProgress || (() => {});
  const gs = groups();
  const pick = await bayesPick(fixed);
  Object.assign(gs[2], { steps: pick.steps, cfg: pick.cfg, denoise: pick.denoise });
  const dir = path.join(CACHE_ROOT, 'avp', 'h3abc', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  say(`贝叶斯挑参数：steps=${pick.steps} cfg=${pick.cfg} denoise=${pick.denoise} shift=12（proxy 评估）`);
  const rows = [];
  for (const g of gs) {
    say(`[${g.id}] 提交 steps=${g.steps} cfg=${g.cfg} denoise=${g.denoise} shift=12`);
    const requested = { steps: g.steps, cfg: g.cfg, denoise: g.denoise, shift: 12 };
    const r = await REAL.generateScore({ ...fixed, ...requested, prefix: `h3/abc_${g.id}`, experimentId: path.basename(dir), say: (message) => say(`[${g.id}] ${message}`) });
    rows.push({ ...g, requested_params: requested, ...r });
    if (r.error) say(`[${g.id}] ${r.error}：未记录质量分数`);
  }
  const csv = path.join(dir, 'h3_abc.csv');
  const cell = (value) => JSON.stringify(value == null ? '' : value);
  fs.writeFileSync(csv, 'group,label,steps,cfg,denoise,shift,width,height,frames,seed,fps,F,Sface,Sflow,Sstyle,Sbad,file,raw_file,error\n' + rows.map((r) => {
    const p = r.params || r.requested_params;
    return [r.id, r.label, p.steps, p.cfg, p.denoise, p.shift, p.width, p.height, p.frames, p.seed, p.native_fps, r.F,
      ...['Sface', 'Sflow', 'Sstyle', 'Sbad'].map((key) => r.scores && r.scores[key]), r.file, r.raw_file, r.error].map(cell).join(',');
  }).join('\n') + '\n', 'utf8');
  const max = Math.max(1e-6, ...rows.filter((r) => Number.isFinite(r.F)).map((r) => r.F));
  const bars = rows.map((r) => `${r.id}  ${(Number.isFinite(r.F) ? '#'.repeat(Math.round(r.F / max * 40)) : '').padEnd(40)} ${Number.isFinite(r.F) ? r.F.toFixed(3) : 'N/A'}`).join('\n');
  const bayes = { steps: pick.steps, cfg: pick.cfg, denoise: pick.denoise, shift: 12, provenance: 'proxy', iters: pick.opt.iters, converged: pick.opt.converged };
  const report = { ...REAL.experimentContext(fixed), dir, csv, rows, bars, evaluator: 'measured', bayes, quality_snapshot: pick.snapshot };
  if (!rows.some((r) => Number.isFinite(r.F))) report.error = 'NO_SCORED_SAMPLES';
  fs.writeFileSync(path.join(dir, 'h3_abc.json'), JSON.stringify(report, null, 2));
  return report;
}

module.exports = { run, groups, bayesPick };
