#!/usr/bin/env node
// 纯 CPU 契约/代理模拟：不安装依赖，不联系 ComfyUI，不生成或评价真实视频。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const parent = process.env.CACHE_ROOT || 'D:/缓存/avp';
fs.mkdirSync(parent, { recursive: true });
process.env.CACHE_ROOT = fs.mkdtempSync(path.join(parent, 'quality-bayes-test-'));
const require = createRequire(import.meta.url);
const ENG = require('../server/engines.js');
const B = require('../server/bayes.js');
const Q = require('../server/quality.js');
let passed = 0;
const test = async (name, run) => { await run(); passed += 1; console.log(`PASS ${name}`); };
const clone = (v) => structuredClone(v);
const scores = { Sface: 0.8, Sflow: 0.7, Sstyle: 0.6, Sbad: 0.1 };
const rng = () => { let n = 31; return () => ((n = Math.imul(n, 1664525) + 1013904223 >>> 0) / 4294967296); };
console.log(`CACHE_ROOT=${process.env.CACHE_ROOT}（仅代理模拟，非实测生成）`);

await test('显存各档与未知值只调度卸载，不量化、不写环境', () => {
  for (const mib of [null, NaN, -1, 0, 1024, 8000, 12000, 32000]) {
    const p = ENG.vramPlan(mib);
    assert.equal(p.quant, 'preserve'); assert.equal(p.fp16, null); assert.equal(p.auto_quantization, false);
    if (!(mib > 16384)) assert.equal(p.offload, 'on_demand');
    for (const key of ['width', 'height', 'steps', 'frames']) assert.equal(key in p, false);
  }
  assert.equal(fs.existsSync(ENG.ENGINES_DIR), false);
});

await test('新默认值符合质量区间且读取不落盘', () => {
  const v = ENG.load('wan22').values;
  for (const k of ENG.optimizableKeys()) assert.ok(v[k.key] >= k.min && v[k.key] <= k.max);
  assert.equal(v['kf.sampler'], Q.load().sampling.sampler);
  assert.equal(v['kf.scheduler'], Q.load().sampling.scheduler);
  assert.equal(v['kf.dtype'], 'fp16');
  for (const k of ['kf.teacache', 'kf.sage_attn', 'kf.nunchaku']) assert.equal(v[k], false);
  assert.equal(fs.existsSync(ENG.ENGINES_DIR), false);
});

await test('读取旧/损坏用户快照不会偷偷迁移或重写', () => {
  ENG.save('minimax_h3', { values: { 'kf.cfg': 1, 'kf.teacache': true, 'kf.dtype': 'int8' } });
  const file = path.join(ENG.ENGINES_DIR, 'minimax_h3.json');
  const before = fs.readFileSync(file);
  assert.equal(ENG.load('minimax_h3').values['kf.cfg'], 1);
  assert.deepEqual(fs.readFileSync(file), before);
  fs.writeFileSync(file, '{legacy-broken');
  ENG.load('minimax_h3');
  assert.equal(fs.readFileSync(file, 'utf8'), '{legacy-broken');
  ENG.save('minimax_h3', { values: ENG.defaults() });
});

await test('显式白名单只含已绑定采样质量维度', () => {
  assert.deepEqual(ENG.optimizableKeys().map((k) => k.key), ['kf.steps', 'kf.cfg', 'kf.refine_denoise']);
  assert.deepEqual(ENG.loadSpec().bayes.quality_tunables, ENG.optimizableKeys().map((k) => k.key));
  assert.equal(ENG.optimizableKeys(1).length, 1);
  assert.equal(ENG.optimizableKeys(0).length, 0);
  for (const k of ENG.optimizableKeys()) assert.deepEqual([k.min, k.max], Q.load().sampling[k.key === 'kf.refine_denoise' ? 'denoise' : k.key.slice(3)]);
});

await test('正态 CDF 使用 sqrt(2)，尾部与对称性正确', () => {
  for (const [z, expected] of [[0, 0.5], [1, 0.841344746], [2, 0.977249868], [-1, 0.158655254], [-2, 0.022750132]]) assert.ok(Math.abs(B.cdf(z) - expected) < 1e-7);
  assert.equal(B.cdf(Infinity), 1); assert.equal(B.cdf(-Infinity), 0);
  assert.ok(Math.abs(B.cdf(0.37) + B.cdf(-0.37) - 1) < 1e-12);
});

await test('Q 权重单一真源；detail 和速度都不是第五目标', () => {
  const original = Q.scoringWeights;
  Q.scoringWeights = () => ({ Sface: 0.5, Sflow: 0.2, Sstyle: 0.2, Sbad: 0.1 });
  try {
    const expected = 0.5 * scores.Sface + 0.2 * scores.Sflow + 0.2 * scores.Sstyle - 0.1 * scores.Sbad;
    assert.ok(Math.abs(B.objective(scores) - expected) < 1e-12);
    assert.equal(B.objective({ ...scores, detail: 1, Sdetail: 1, speed: 100000, elapsed_ms: 1 }), B.objective(scores));
    assert.equal(B.objective(scores, { speed: 1e9, w5: 1e9 }), B.objective(scores));
    assert.equal(B.objective(scores, original()), B.objective(scores, { w1: original().Sface, w2: original().Sflow, w3: original().Sstyle, w4: original().Sbad }));
  } finally { Q.scoringWeights = original; }
});

let calls = 0;
const options = { engine: 'wan22', evaluateKind: 'proxy', maxIter: 2, rng: rng(), evaluate: async () => { calls += 1; return { scores }; } };
await test('未知引擎/空白名单/纯固定键拒绝，不伪造优化', async () => {
  await assert.rejects(B.optimize({ ...options, engine: 'unknown' }), { code: 'BAD_ENGINE' });
  for (const keys of [[], ['not-a-parameter'], ['kf.resolution', 'ch.age', 'mo.fps'], [{ key: 'post.upscale', min: 1, max: 3 }]]) await assert.rejects(B.optimize({ ...options, keys }), { code: 'BAYES_NO_ELIGIBLE_KEYS' });
  await assert.rejects(B.optimize({ ...options, keys: 'kf.cfg' }), { code: 'BAYES_BAD_KEYS' });
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(ENG.ENGINES_DIR, 'wan22.json')), false);
});

const fixed = {
  width: 1920, height: 1080, tier: '1080p', resolution: '1920x1080', 'kf.resolution': '1080p',
  fps: 30, native_fps: 30, output_fps: 60, frames: 151, duration: 5, seconds: 5,
  seed: 0, 'kf.seed': 123, 'ch.age': 35, batch: 1, quant: 'fp16', dtype: 'fp16',
  'mo.fps': 30, 'mo.max_frames': 151, 'kf.batch': 1, 'kf.refine_scale': 1.5,
  'kf.grain': 0.1, postprocess: { interp: true, upscale: false },
};
let result;
await test('调用方不能扩大范围；每轮收到完整固定快照并落盘', async () => {
  const otherBefore = fs.readFileSync(path.join(ENG.ENGINES_DIR, 'minimax_h3.json'));
  const seedValues = { ...fixed, 'kf.steps': 2, 'kf.cfg': 100, 'kf.refine_denoise': 1 };
  const original = clone(seedValues);
  const seen = [];
  const banned = Object.keys(fixed).map((key) => ({ key, type: 'float', min: 0, max: 1 }));
  result = await B.optimize({
    ...options, seedValues, apply: false,
    weights: { w1: 999, w5: 999, speed: 999 },
    keys: [...banned, ...['kf.steps', 'kf.cfg', 'kf.refine_denoise'].map((key) => ({ key, type: 'enum', enum: [-100, 1000], min: -100, max: 1000 }))],
    evaluate: async (params) => {
      seen.push(clone(params));
      for (const [key, value] of Object.entries(fixed)) assert.deepEqual(params[key], value, key);
      for (const k of ENG.optimizableKeys()) assert.ok(params[k.key] >= k.min && params[k.key] <= k.max, k.key);
      params.width = 1; params.postprocess.interp = false; // 模拟 evaluator 内部突变
      return { scores, detail: { synthetic: true, elapsed_ms: seen.length, detail: 1 } };
    },
  });
  assert.deepEqual(seedValues, original);
  assert.deepEqual(result.dataset.map((s) => s.params), seen);
  assert.deepEqual(result.space.dims, ['kf.steps', 'kf.cfg', 'kf.refine_denoise']);
  for (const [key, value] of Object.entries(fixed)) {
    assert.deepEqual(result.fixed_constraints[key], value, key);
    assert.deepEqual(result.best.params[key], value, key);
  }
  const persisted = ENG.load('wan22').bayes;
  assert.deepEqual(persisted.dataset, result.dataset);
  assert.deepEqual(persisted.fixed_constraints, result.fixed_constraints);
  assert.deepEqual(persisted.best.params, result.best.params);
  assert.deepEqual(persisted.seed_values, { ...ENG.defaults(), ...original });
  assert.equal(result.weights.w1, Q.scoringWeights().Sface);
  assert.deepEqual(Object.keys(result.weights), ['w1', 'w2', 'w3', 'w4']);
  assert.deepEqual(fs.readFileSync(path.join(ENG.ENGINES_DIR, 'minimax_h3.json')), otherBefore);
  assert.equal(result.applied_keys, null);
  assert.ok(result.dataset.every((s) => s.evaluator === 'proxy'));
  assert.equal(result.iters, 2);
});

await test('最佳完整快照可替换 values，apply 仅写搜索键不覆盖当前固定参数', async () => {
  ENG.patch('wan22', { ...fixed, width: 1280, height: 720, tier: '720p' });
  const before = clone(ENG.load('wan22').values);
  const r = await B.optimize({ ...options, seedValues: { ...fixed, 'kf.cfg': 8 }, keys: ['kf.cfg'], apply: true });
  assert.deepEqual(r.applied_keys, ['kf.cfg']);
  assert.equal(r.best.params.width, 1920);
  assert.equal(r.best.params['kf.steps'], before['kf.steps']);
  assert.equal(r.fixed_constraints['kf.steps'], before['kf.steps']);
  const after = ENG.load('wan22').values;
  for (const key of Object.keys(before).filter((k) => k !== 'kf.cfg')) assert.deepEqual(after[key], before[key], key);
});

await test('未搜索的非法采样值明确报错，不在评估器中默默改变', async () => {
  await assert.rejects(B.optimize({ ...options, keys: ['kf.cfg'], seedValues: { 'kf.steps': 4 } }), { code: 'BAYES_INVALID_FIXED_SAMPLING' });
});

await test('固定快照中的 turbo/TeaCache/量化与非质量采样拒绝且不改档案', async () => {
  const file = path.join(ENG.ENGINES_DIR, 'wan22.json');
  const before = fs.readFileSync(file);
  for (const seedValues of [{ turbo: true }, { 'kf.teacache': true }, { distill: true }, { 'kf.dtype': 'int8' }, { 'kf.sampler': 'lcm' }, { 'kf.scheduler': 'simple' }]) {
    await assert.rejects(B.optimize({ ...options, seedValues }), { code: 'BAYES_INVALID_FIXED_QUALITY' });
  }
  assert.deepEqual(fs.readFileSync(file), before);
});

await test('后处理元数据要求外部 RIFE/Real-ESRGAN，禁止替代声明', () => {
  const post = ENG.loadSpec().postprocess;
  for (const [id, impl] of [['interp', 'RIFE'], ['upscale', 'Real-ESRGAN']]) {
    const p = post.steps.find((s) => s.id === id);
    assert.equal(p.impl, impl); assert.equal(p.on_missing, 'explicit_error'); assert.equal(p.fallback, null);
    assert.deepEqual(p.required, ['executable', 'model_weights']);
  }
  assert.doesNotMatch(JSON.stringify(post), /minterpolate|lanczos|substitution/i);
});
console.log(`${passed} 项代理/契约测试；未运行 GPU、真实生成或外部后处理。`);
console.log('全部通过');
