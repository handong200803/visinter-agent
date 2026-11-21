/**
 * engines.js —— 双引擎（Wan2.2 / MiniMax H3）注册表与参数空间隔离
 *
 * 三条硬规则直接来自改造规格（spec/engines.json 的 rules）：
 *   1) Wan2.2 原样保留，不做任何降级；
 *   2) 两套 258 参数空间**分开存**：engine:wan22 / engine:minimax_h3，切换只换命名空间；
 *   3) 无付费 API：paid 必须 false，否则引擎不出现在可选列表。
 *
 * 存储后端：
 *   · 浏览器（页面）：avp.shell.store.v1 → projects[active].engines[<id>].values（与旧 values 平级）
 *   · Node（CLI/后端）：%CACHE_ROOT%/avp/engines/<id>.json（同 schema，便于对拍）
 * 两种后端都只做「按引擎读写」，不存在一份共享 values 被两边改写的情况。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Q = require('./quality.js');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const ENGINES_DIR = path.join(CACHE_ROOT, 'avp', 'engines');
const SPEC_FILE = path.join(__dirname, '..', 'spec', 'engines.json');
const REG_FILE = path.join(__dirname, '..', 'spec', 'params.registry.json');

function loadSpec() { return JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8')); }
function registry() { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); }

/** 可选引擎：付费的一律剔除（不能只靠文档说"免费"）。 */
function list() {
  const spec = loadSpec();
  return spec.engines.filter((e) => e.paid === false && e.free === true);
}

function get(id) {
  const e = list().find((x) => x.id === id);
  if (!e) {
    const err = new Error(`未知或不可用引擎「${id}」（只允许免费本地引擎：${list().map((x) => x.id).join(' / ')}）`);
    err.code = 'BAD_ENGINE';
    throw err;
  }
  return e;
}

/** 只调度卸载/分片，不自动量化，也不修改分辨率、步数或环境。 */
function vramPlan(usableMib) {
  const spec = loadSpec();
  const mib = Number(usableMib);
  const precision = { quant: 'preserve', fp16: null, auto_quantization: false };
  if (!Number.isFinite(mib) || mib <= 0) return { tier: 'unknown', ...precision, split_load: true, offload: 'on_demand', reason: '显存未知 → 保持已安装权重精度 + 按需卸载；仍须质量准入检查' };
  const tiers = spec.vram_policy.tiers;
  const t = tiers.find((x) => x.max_mib == null || mib <= x.max_mib) || tiers[tiers.length - 1];
  return { ...t, ...precision, reason: `可用 ${mib}MiB → 保持已安装权重精度${t.split_load ? ' + 分片' : ''}${t.offload === 'none' ? '' : ' + 按需卸载'}；不保证显存足够` };
}

function defaults() {
  const reg = registry();
  const v = {};
  for (const p of reg.params) v[p.key] = p.default;
  const sampling = Q.sampling({ steps: v['kf.steps'], cfg: v['kf.cfg'], denoise: v['kf.refine_denoise'] });
  Object.assign(v, { 'kf.steps': sampling.steps, 'kf.cfg': sampling.cfg, 'kf.refine_denoise': sampling.denoise, 'kf.sampler': sampling.sampler, 'kf.scheduler': sampling.scheduler });
  v['kf.dtype'] = 'fp16';
  for (const key of ['kf.teacache', 'kf.sage_attn', 'kf.nunchaku']) v[key] = false;
  return v;
}

function fileOf(id) { return path.join(ENGINES_DIR, id + '.json'); }

/** 纯读取：缺失/不可读时返回新默认值，不覆盖已有文件，不复制另一引擎的值。 */
function load(id) {
  get(id);
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'));
    if (raw && raw.engine === id && raw.values) return raw;
  } catch { /* 只在内存里提供默认值；持久化必须显式 save/patch */ }
  return { schema: 'ai-video-platform/engine.params', engine: id, values: defaults(), selfcheck: { status: 'inferred', at: null }, bayes: { best: null, dataset: [] }, updatedAt: null };
}

function save(id, doc) {
  get(id);
  fs.mkdirSync(ENGINES_DIR, { recursive: true });
  const safe = {
    schema: 'ai-video-platform/engine.params',
    engine: id,
    values: { ...(doc.values || {}) },
    selfcheck: doc.selfcheck || { status: 'inferred', at: null },
    bayes: doc.bayes || { best: null, dataset: [] },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(fileOf(id), JSON.stringify(safe, null, 2) + '\n', 'utf8');
  return safe;
}

/** 写入若干键（只在指定引擎命名空间内）。 */
function patch(id, values) {
  const doc = load(id);
  doc.values = { ...doc.values, ...(values || {}) };
  return save(id, doc);
}

/**
 * 隔离自检：改 A 的若干键，断言 B 一个字节都没变。
 * 这是「切换不串参、不覆盖」的可执行证明，不靠口头承诺。
 */
function isolationCheck(a = 'wan22', b = 'minimax_h3') {
  const beforeB = JSON.stringify(load(b).values);
  const beforeA = JSON.parse(JSON.stringify(load(a).values));
  patch(a, { 'kf.cfg': 9.25, '__isolation_probe': true });
  const afterB = JSON.stringify(load(b).values);
  const afterA = load(a).values;
  const noLeak = beforeB === afterB;
  const aChanged = afterA['kf.cfg'] === 9.25;
  // 还原探针，避免污染真实参数
  const restore = JSON.parse(JSON.stringify(beforeA));
  save(a, { ...load(a), values: restore });
  return {
    ok: noLeak && aChanged,
    a_changed: aChanged,
    b_untouched: noLeak,
    probe: { a: afterA['kf.cfg'], b: load(b).values['kf.cfg'] },
    note: noLeak ? '写入 A 后 B 完全未变' : '隔离失效：B 被连带修改',
  };
}

// 只搜索已绑定的采样旋钮，不把纯规划参数冒充实际可优化维度。
function optimizableKeys(limit = 24) {
  const reg = registry();
  const sampling = Q.load().sampling;
  const allowlist = [
    { key: 'kf.steps', range: 'steps', type: 'int', step: 1, label: '采样步数' },
    { key: 'kf.cfg', range: 'cfg', type: 'float', step: 0.1, label: 'CFG' },
    { key: 'kf.refine_denoise', range: 'denoise', type: 'float', step: 0.01, label: '采样去噪' },
  ];
  return allowlist.map((item) => {
    const p = reg.params.find((x) => x.key === item.key);
    const [min, max] = sampling[item.range];
    return { key: item.key, type: item.type, min, max, step: item.step, enum: null, tier: p ? p.tier : 'L3', label: item.label };
  }).slice(0, Math.max(0, limit));
}

module.exports = { loadSpec, registry, list, get, vramPlan, defaults, load, save, patch, isolationCheck, optimizableKeys, ENGINES_DIR };
