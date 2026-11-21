#!/usr/bin/env node
/**
 * snap_plugins.mjs —— 插件管理入口的快照生成器（EMS 外壳 + CJS loader 内核）
 *
 * 为什么需要它：
 *   入口 HTML 是构建期内联的（见 tools/build_module.mjs），浏览器里既不能 require
 *   plugins/loader.js，也不能在 file:// 下读 plugins/packs/*。所以「哪些包通过校验、
 *   哪些被拒、拒在哪一行」这件事必须在 Node 侧算完，落成 plugins/snapshot.json，
 *   再由构建器整块注入 window.__SNAP。
 *
 * 一条自我约束（这是本脚本存在的全部意义）：
 *   快照里的 state / errors[] / warnings[] / permissions 一律来自 loader 的真实返回值，
 *   这里**不做第二次判断**。本文件只负责：遍历目录 → 调 loader → 裁剪字段 → 落盘。
 *   任何在页面上显示的「为什么被拒」都必须能在 errors[].code 里找到同名代码。
 *
 * 版本口径：
 *   本项目没有根 package.json（零依赖、无包管理器）。宿主平台版本 = 基础注册表版本
 *   spec/params.registry.json#version —— 与 plugins/selftest.js 传入的 platformVersion
 *   是同一个值（selftest 用 { platformVersion: base.version }）。engines 的版本比较
 *   完全交给 loader.satisfies（支持 >= <= > < = ^ ~ 与空格「与」、||「或」，不支持 x/* 通配）。
 *
 * 跑法：node tools/snap_plugins.mjs
 * 产物：plugins/snapshot.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m]', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const loader = require(path.join(ROOT, 'plugins', 'loader.js'));

const PACKS_DIR = path.join(ROOT, 'plugins', 'packs');
const FIXTURES_DIR = path.join(ROOT, 'plugins', 'fixtures');
const OUT = path.join(ROOT, 'plugins', 'snapshot.json');

const relOf = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

/** 本地时间戳（口径条要人读的「生成时间」，ISO 那份留给机器） */
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = p(Math.floor(Math.abs(off) / 60));
  const mm = p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${hh}:${mm}`;
}

/** 列出一级子目录里带 plugin.json 的包目录；排序保证同一磁盘状态 ⇒ 同一快照（幂等） */
function listDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs
    .readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(baseDir, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'plugin.json')))
    .sort((a, b) => a.localeCompare(b));
}

/** contributions 摘要：页面的「清单」页要能一眼看出这个包往运行时加了什么 */
function contribSummary(manifest) {
  const c = (manifest && manifest.contributes) || {};
  const out = {
    keys: Object.keys(c),
    params: Array.isArray(c.params) ? c.params.length : 0,
    models: Array.isArray(c.models) ? c.models.length : 0,
    node: null,
    preset: null,
    ui: null,
  };
  if (c.node && typeof c.node === 'object') {
    out.node = {
      id: c.node.id || '',
      title: c.node.title || '',
      stage: c.node.stage || '',
      inputs: Array.isArray(c.node.inputs) ? c.node.inputs.length : 0,
      outputs: Array.isArray(c.node.outputs) ? c.node.outputs.length : 0,
    };
  }
  if (c.preset && typeof c.preset === 'object') {
    out.preset = {
      schema: c.preset.schema || '',
      format: c.preset.format,
      registry_version: c.preset.registry_version || '',
      name: c.preset.name || '',
      checksum: c.preset.checksum || '',
      values: c.preset.values && typeof c.preset.values === 'object' ? Object.keys(c.preset.values).length : 0,
    };
  }
  if (c.ui && typeof c.ui === 'object') {
    out.ui = {
      themes: Array.isArray(c.ui.themes) ? c.ui.themes.length : 0,
      panels: Array.isArray(c.ui.panels) ? c.ui.panels.length : 0,
    };
  }
  return out;
}

/**
 * engines 是否满足。比较本身用 loader.satisfies（和校验器同一份实现），
 * 页面不再自己算一遍版本 —— 否则「页面说满足、loader 说拒绝」会变成两个真相。
 */
function enginesCheck(manifest, platformVersion, registryVersion) {
  const e = (manifest && manifest.engines) || {};
  const out = {};
  for (const key of ['platform', 'registry']) {
    const range = e[key];
    if (typeof range !== 'string' || !range.trim()) {
      out[key] = null;
      continue;
    }
    const against = key === 'platform' ? platformVersion : registryVersion;
    out[key] = { range, against, satisfied: loader.satisfies(against, range) };
  }
  return out;
}

/** 权限三分：声明值 / 命中白名单 / 未识别（未识别的 loader 会直接忽略） */
function permissionsOf(manifest) {
  const declared = Array.isArray(manifest && manifest.permissions) ? manifest.permissions.slice() : [];
  const whitelist = loader.PERMISSION_WHITELIST;
  return {
    declared,
    recognized: declared.filter((p) => whitelist.includes(p)),
    unknown: declared.filter((p) => !whitelist.includes(p)),
  };
}

/** 把 schema 里真正被 loader 用到的约束抽出来，页面上的「本地校验」照它执行，不另写一份规则 */
function schemaContract() {
  const schema = loader.loadSchema();
  const p = schema.properties || {};
  const contrib = (p.contributes && p.contributes.properties) || {};
  const typeRequirements = [];
  for (const clause of schema.allOf || []) {
    const t = clause && clause.if && clause.if.properties && clause.if.properties.type && clause.if.properties.type.const;
    const need =
      clause && clause.then && clause.then.properties && clause.then.properties.contributes
        ? clause.then.properties.contributes.required || []
        : [];
    if (t && need.length) typeRequirements.push({ type: t, contributes_required: need });
  }
  return {
    schema_file: relOf(loader.SCHEMA_PATH),
    required: schema.required || [],
    additional_properties: schema.additionalProperties,
    schema_const: (p.schema && p.schema.const) || '',
    id_pattern: (p.id && p.id.pattern) || '',
    name_min_length: (p.name && p.name.minLength) || 0,
    name_max_length: (p.name && p.name.maxLength) || 0,
    version_pattern: (p.version && p.version.pattern) || '',
    type_enum: (p.type && p.type.enum) || [],
    description_max_length: (p.description && p.description.maxLength) || 0,
    author_max_length: (p.author && p.author.maxLength) || 0,
    homepage_pattern: (p.homepage && p.homepage.pattern) || '',
    engines_required: (p.engines && p.engines.required) || [],
    engines_keys: Object.keys((p.engines && p.engines.properties) || {}),
    engines_pattern: (p.engines && p.engines.properties && p.engines.properties.platform && p.engines.properties.platform.pattern) || '',
    permissions_items_enum: (p.permissions && p.permissions.items && p.permissions.items.enum) || loader.PERMISSION_WHITELIST,
    permissions_max_items: (p.permissions && p.permissions.maxItems) || 0,
    permissions_unique: !!(p.permissions && p.permissions.uniqueItems),
    contributes_keys: Object.keys(contrib),
    type_requirements: typeRequirements,
  };
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

const base = loader.loadBaseRegistry(ROOT);
const platformVersion = base.version; // 同 selftest：platformVersion = base.version
const registryVersion = base.version;
const run = loader.loadAll({ root: ROOT, base, platformVersion });

const entries = [];
const stateTally = { active: 0, 'needs-review': 0, rejected: 0 };
let errorsTotal = 0;
let warningsTotal = 0;

const jobList = [
  ...listDirs(PACKS_DIR).map((dir) => ({ dir, origin: 'pack' })),
  ...listDirs(FIXTURES_DIR).map((dir) => ({ dir, origin: 'fixture' })),
];

for (const job of jobList) {
  const rel = relOf(job.dir);
  const { manifest, verdict } = loader.validatePluginDir(job.dir, { root: ROOT, base, platformVersion });
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const perms = permissionsOf(m);

  let state;
  let stateFrom;
  let reason;
  let applies = false;
  let applied = null;
  let errors;
  let warnings;

  if (job.origin === 'pack') {
    // packs/ 走的是真实加载管线：state、reason、applied 全部取 loadAll 的登记信息
    const info = run.plugins.find((x) => x.dir === rel) || run.plugins.find((x) => x.id === (m.id || path.basename(job.dir)));
    state = info ? info.state : verdict.ok ? verdict.state : 'rejected';
    stateFrom = 'loadAll';
    reason = info ? info.reason : '';
    applies = info ? !!info.applies : false;
    applied = info ? info.applied : null;
    // loadAll 的 dir 指向 manifest 文件（…/plugin.json），本脚本的 rel 指向包目录，两种都认
    const mine = (x) => x.dir === rel || x.dir === `${rel}/plugin.json`;
    errors = run.errors.filter(mine).map(({ path: p2, code, message }) => ({ path: p2, code, message }));
    warnings = run.warnings.filter(mine).map(({ path: p2, code, message }) => ({ path: p2, code, message }));
  } else {
    // fixtures/ 不在 packs/ 里，loadAll 扫不到；用 validatePluginDir 的结果，
    // 状态推导与 loadAll 同构：ok ? verdict.state : 'rejected'
    state = verdict.ok ? verdict.state : 'rejected';
    stateFrom = 'validatePluginDir';
    errors = verdict.errors.map(({ path: p2, code, message }) => ({ path: p2, code, message }));
    warnings = verdict.warnings.map(({ path: p2, code, message }) => ({ path: p2, code, message }));
    reason = errors.length
      ? `${errors[0].path}: ${errors[0].message}`
      : verdict.state === 'needs-review'
        ? '声明 exec 权限，等待人工审核（不注入运行时）'
        : '校验通过；不在 packs/ 内，不进入运行时注册表';
  }

  stateTally[state] = (stateTally[state] || 0) + 1;
  errorsTotal += errors.length;
  warningsTotal += warnings.length;

  entries.push({
    id: m.id || path.basename(job.dir),
    dir: rel,
    origin: job.origin,
    listed_in_runtime: job.origin === 'pack',
    name: m.name || '',
    version: m.version || '',
    type: m.type || '',
    description: m.description || '',
    author: m.author || '',
    homepage: m.homepage || '',
    engines: m.engines || {},
    engines_check: enginesCheck(m, platformVersion, registryVersion),
    permissions_declared: perms.declared,
    permissions_recognized: perms.recognized,
    permissions_unknown: perms.unknown,
    quarantine_exec: perms.declared.includes('exec'),
    contributes: contribSummary(m),
    state,
    state_from: stateFrom,
    reason,
    applies,
    applied,
    errors,
    warnings,
    manifest: manifest || null,
  });
}

const packs = entries.filter((e) => e.origin === 'pack');
const fixtures = entries.filter((e) => e.origin === 'fixture');
const now = new Date();

const snapshot = {
  module: 'plugins',
  module_title: '插件管理',
  built_by: 'tools/snap_plugins.mjs',
  validator: 'plugins/loader.js',
  schema_file: relOf(loader.SCHEMA_PATH),
  generated_at: localStamp(now),
  generated_at_utc: now.toISOString(),
  host: {
    platform_version: platformVersion,
    registry_version: registryVersion,
    platform_version_source: 'spec/params.registry.json#version',
    version_rule: 'plugins/loader.js satisfies()：>= <= > < = ^ ~ 空格为「与」、|| 为「或」，不支持 x/* 通配',
    base_params: base.params.length,
    engine_prefixes: loader.ENGINE_PREFIX,
  },
  permission_whitelist: loader.PERMISSION_WHITELIST,
  plugin_types: loader.PLUGIN_TYPES,
  schema_contract: schemaContract(),
  counts: {
    entries: entries.length,
    packs: packs.length,
    fixtures: fixtures.length,
    active: stateTally.active,
    needs_review: stateTally['needs-review'],
    rejected: stateTally.rejected,
    errors: errorsTotal,
    warnings: warningsTotal,
    errors_packs: packs.reduce((a, e) => a + e.errors.length, 0),
    errors_fixtures: fixtures.reduce((a, e) => a + e.errors.length, 0),
    warnings_packs: packs.reduce((a, e) => a + e.warnings.length, 0),
    warnings_fixtures: fixtures.reduce((a, e) => a + e.warnings.length, 0),
  },
  runtime: {
    loader: 'loader.loadAll()',
    plugins: run.plugins.length,
    errors: run.errors.length,
    warnings: run.warnings.length,
    injected: run.plugins.filter((p) => p.applies).length,
    registry_params: run.registry.params.length,
    registry_params_delta: run.registry.params.length - base.params.length,
    registry_presets: (run.registry.presets || []).length,
    registry_themes: ((run.registry.ui || {}).themes || []).length,
  },
  entries,
};

fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
const kb = (fs.statSync(OUT).size / 1024).toFixed(1);

const c = snapshot.counts;
console.log(`${C.bold}插件快照${C.reset} ${C.dim}宿主 avp ${platformVersion} · 校验器 plugins/loader.js${C.reset}`);
for (const e of entries) {
  const tone = e.state === 'active' ? C.green : e.state === 'needs-review' ? C.yellow : C.red;
  const mark = e.origin === 'fixture' ? ' (fixture)' : '';
  console.log(
    `  ${tone}${e.state.padEnd(12)}${C.reset} ${String(e.id).padEnd(26)} v${e.version.padEnd(7)} ${String(e.type).padEnd(7)}` +
      ` 错${e.errors.length} 警${e.warnings.length}${C.dim}${mark}${C.reset}`
  );
}
console.log(
  `${C.dim}合计${C.reset} ${c.entries} 条（packs ${c.packs} · fixtures ${c.fixtures}）· ` +
    `active ${c.active} · needs-review ${c.needs_review} · rejected ${c.rejected} · 错 ${c.errors} · 警 ${c.warnings}`
);
console.log(
  `${C.dim}运行时${C.reset} 注入 ${snapshot.runtime.injected} 个 · 注册表参数 ${snapshot.runtime.registry_params}` +
    `（基础 ${base.params.length} +${snapshot.runtime.registry_params_delta}）→ ${relOf(OUT)} ${kb}KB`
);