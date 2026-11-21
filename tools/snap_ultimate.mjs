#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENG = require('../server/engines.js');
const Q = require('../server/quality.js');
const ULT = require('../server/ultimate.js');
const plan = ULT.plan({ engine: 'wan22', params: ENG.defaults() });
const stored = ENG.load('wan22').bayes;
const data = stored && stored.fixed_constraints && Array.isArray(stored.dataset) ? stored.dataset : [];
const valid = data.length > 0 && data.every((s) => s.params && Number.isFinite(s.F) &&
  ENG.optimizableKeys().every((k) => s.params[k.key] >= k.min && s.params[k.key] <= k.max));
const evaluator = valid ? stored.evaluator : 'pending';
const weights = Object.fromEntries(Object.values(Q.scoringWeights()).map((v, i) => ['w' + (i + 1), v]));
const gates = ULT.gates({ topology: plan, scorer: null, bayes: null, separation: null });
const snap = {
  generatedAt: new Date().toISOString(),
  engines: ENG.list().map((e) => ({ id: e.id, name: e.name, label: e.label, vae: e.vae, features: e.features, quant: e.quant, selfcheck: ENG.load(e.id).selfcheck })),
  isolation: { ok: null, note: '构建不修改引擎数据；隔离验证请运行自检', probe: {} },
  vram: { plan: ENG.vramPlan(null), fp16: ENG.vramPlan(24000) },
  plan: { engine: plan.engine, task_id: plan.task_id, stats: plan.stats, vram: plan.vram, execution: { comfy_ready: plan.execution.comfy_ready, mapped_nodes: plan.execution.mapped_nodes, planned_nodes: plan.execution.planned_nodes, save_latent: plan.execution.save_latent, quality_errors: plan.execution.quality_errors }, params_digest: plan.params_digest, dir: plan.dir },
  bayes: {
    engine: 'wan22', iters: valid ? data.length : 0, converged: false,
    best: valid ? stored.best : { F: null, params: {} }, weights: valid ? stored.weights : weights, evaluator,
    curve: valid ? data.map((s) => ({ round: s.round, source: s.source, F: s.F })) : [],
  },
  abc: { csv: '', only_variable: '质量采样参数组', variables_locked: ['分辨率', '原生帧率', '帧数', '种子', '拓扑'], rows: ['A', 'B', 'C'].map((id) => ({ id, label: '等待质量模式原生对照样片', F: null, digest: '' })) },
  ablation: { param: 'kf.steps', rows: [16, 20, 25].map((value) => ({ value, F: null })), bars: '未执行；不读取旧极速实验作为当前质量证据' },
  score: null, post: null, gates,
  note: '构建仅展示已有质量策略数据，不运行代理寻优、不生成或评分视频；旧极速实验文件原样保留，但不作为本次质量验收证据。原生评分与增强状态从任务API读取。',
};
const out = path.join(ROOT, 'ultimate', 'snapshot.json');
fs.writeFileSync(out, JSON.stringify(snap, null, 2) + '\n', 'utf8');
console.log('OK ultimate/snapshot.json · 质量策略 · evaluator=' + evaluator + ' · 不修改实验档案');
