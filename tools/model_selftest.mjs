#!/usr/bin/env node
/**
 * model_selftest.mjs —— 模型库基线自检（spec/model_configs.json × core/models.js × 注册表）
 *
 * 为什么单独一条：模型库最容易出的错不是「界面没渲染」，而是**配置与注册表脱钩**——
 *   下拉框里有 Kolors，注册表 kf.model 却没有这个选项（coerce 会静默夹回默认值）；
 *   或者模拟切换后 kf.cfg 被联动规则改写，用户看到的和基线不一致。
 *   这类问题在界面上表现为「选了没反应」，肉眼很难定位，只能靠断言。
 *
 * 跑法：node tools/model_selftest.mjs   （末行「全部通过」+ exit 0 才算通过）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVP = require(path.join(ROOT, 'core', 'engine.js'));
const AVPModels = require(path.join(ROOT, 'core', 'models.js'));

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const cfg = readJson('spec/model_configs.json');
const reg = readJson('spec/params.registry.json');
const catalog = readJson('spec/models.catalog.json');
const rules = readJson('spec/rules.linkage.json');

const M = AVPModels.create(cfg);
const map = AVP.byKey(reg);

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + msg + (extra ? '  ' + extra : '')); }
};

console.log('模型库基线自检 · spec/model_configs.json\n');

/* ── 1. 配置完整性 ─────────────────────────────────────────── */
console.log('== 1 · 配置完整性（字段 / id / 分组 / 默认模型）==');
const issues = M.validate();
ok(issues.length === 0, '9 条配置字段齐全且 id 唯一', issues.length ? issues.join(' | ') : '');
ok(M.groups.length === 2, '两组下拉分组：图像 / 视频', M.groups.map((g) => g.name).join(' / '));
ok(M.list('image').length === 6, '图像模型 6 个', M.list('image').map((m) => m.name).join(', '));
ok(M.list('video').length === 3, '视频模型 3 个', M.list('video').map((m) => m.name).join(', '));
ok(M.models.length === 9, '合计 9 个模型配置', String(M.models.length));
ok(M.defaultModel() && M.defaultModel().id === 'qwen-image-2', '默认选中 Qwen-Image2（平台主打）', M.defaultModel() && M.defaultModel().name);
ok(M.list('image').filter((m) => m.default).length === 1, '默认模型只有一个');
ok(M.models.every((m) => m.feature && m.feature.length >= 6), '每个模型都有一行特点说明（卡片用）');
ok(M.models.every((m) => m.tags.length > 0), '每个模型名后都带标签（推荐/二次元专用/写实…）');
ok(M.byId('qwen-image-2').tags.includes('推荐') && M.byId('pony-v6').tags.includes('二次元专用') && M.byId('flux-schnell').tags.includes('写实'),
  '三枚关键标签存在：推荐 / 二次元专用 / 写实');

/* ── 2. 补丁键必须真的存在于注册表 ─────────────────────────── */
console.log('\n== 2 · 补丁键 vs 注册表（键名脱钩就会出现「选了没反应」）==');
const patchKeys = new Set();
for (const m of M.models) Object.keys(M.patchFor(m)).forEach((k) => patchKeys.add(k));
ok(patchKeys.size > 0, '补丁键来自 bindings，共 ' + patchKeys.size + ' 个不同的注册表键', [...patchKeys].join(', '));
const missing = [...patchKeys].filter((k) => !map[k]);
ok(missing.length === 0, '全部补丁键都存在于 params.registry.json', missing.length ? '缺失：' + missing.join(',') : '');

/* ── 3. 逐模型：模拟切换后四个基线真的落地 ─────────────────── */
console.log('\n== 3 · 逐模型模拟切换（coerce + resolve 之后仍然是基线值）==');
const base = AVP.defaults(reg);
for (const m of M.models) {
  const patch = M.patchFor(m);
  const seeded = { ...base, ...patch };
  const r = AVP.resolve(reg, rules, seeded, { ctx: { usable_mib: 6900, device: 'T0' } });
  const v = r.values;
  if (m.type === 'image') {
    const checks = [
      ['kf.model', m.catalog_model],
      ['kf.sampler', m.sampler_key],
      ['kf.cfg', m.cfg],
      ['kf.steps', m.steps],
      ['kf.resolution', Math.max(m.res.w, m.res.h)],
      ['kf.ratio', m.ratio],
      ['kf.negative', m.default_negative],
    ];
    const bad = checks.filter(([k, want]) => String(v[k]) !== String(want));
    ok(bad.length === 0, m.name + '：模型/采样器/CFG/' + m.steps + ' 步/' + m.res.w + '×' + m.res.h + '/比例/负面词全部落地',
      bad.length ? bad.map(([k, want]) => k + ' 期望 ' + want + ' 实际 ' + v[k]).join('; ') : String(v['kf.cfg']) + ' CFG');
    ok(map['kf.ratio'].options.includes(m.ratio), m.name + '：纵横比 ' + m.ratio + ' 在注册表可选项内');
    ok(v['kf.resolution'] >= map['kf.resolution'].min && v['kf.resolution'] <= map['kf.resolution'].max,
      m.name + '：长边 ' + v['kf.resolution'] + ' 在 512~2048 内');
  } else {
    const checks = [
      ['mo.i2v_model', m.catalog_model],
      ['mo.i2v_res', m.res.p],
      ['mo.fps', m.fps],
      ['mo.duration', m.duration],
    ];
    const bad = checks.filter(([k, want]) => String(v[k]) !== String(want));
    ok(bad.length === 0, m.name + '：视频模型/分辨率/帧率/时长全部落地',
      bad.length ? bad.map(([k, want]) => k + ' 期望 ' + want + ' 实际 ' + v[k]).join('; ') : m.res.p + ' · ' + m.fps + 'fps · ' + m.duration + 's');
    ok(map['mo.i2v_res'].options.includes(m.res.p), m.name + '：' + m.res.p + ' 在 i2v 分辨率可选项内');
  }
}

/* ── 4. 用户点名的四条验收 ─────────────────────────────────── */
console.log('\n== 4 · 四条验收：采样器/CFG 跟着变、Pony 标签写、Flux CFG 3.5、负面词切换 ==');
const samplers = new Set(M.list('image').map((m) => m.sampler_key));
ok(samplers.size >= 3, '图像模型覆盖 ≥3 种采样器（切模型时控件会真的动）', [...samplers].join(', '));
const cfgs = M.list('image').map((m) => m.cfg);
ok(new Set(cfgs).size >= 4, 'CFG 取值 ≥4 种', cfgs.join(' / '));

const pony = M.byId('pony-v6');
ok(/1girl/.test(pony.placeholder), 'Pony：提示词模板是 Danbooru 标签写法', pony.placeholder.slice(0, 46) + '…');
ok(pony.tips.some((t) => /1girl/.test(t.text) && t.level === 'warn'), 'Pony：提示「二次元风格请用标签式提示词」为 warn 级');

const flux = M.byId('flux-schnell');
ok(flux.cfg === 3.5, 'Flux：基线 CFG = 3.5', String(flux.cfg));
ok(flux.tips.some((t) => /3~4/.test(t.text) && t.level === 'warn'), 'Flux：提示「CFG 建议 3~4，过高会过饱和」为 warn 级');
ok(flux.default_negative.split(',').length <= 6, 'Flux：负面词保持轻量', flux.default_negative);

const negatives = M.list('image').map((m) => m.default_negative);
ok(new Set(negatives).size === negatives.length, '6 个图像模型的负面词互不相同（切换时真的会换）');
ok(negatives.some((n) => /cartoon/.test(n)) && negatives.some((n) => /lowres/.test(n)) && negatives.some((n) => /\(deformed/.test(n)),
  '三套典型负面词都在：Qwen(anti-cartoon) / Pony(lowres) / SDXL(带权重串)');

const defaultPatch = M.patchFor(M.defaultModel());
ok(defaultPatch['kf.cfg'] === 6.5 && defaultPatch['kf.steps'] === 24 && defaultPatch['kf.resolution'] === 1280,
  'Qwen-Image2：CFG 6.5 / 24 步 / 长边 1280（1024×1280）', JSON.stringify({ cfg: defaultPatch['kf.cfg'], steps: defaultPatch['kf.steps'], res: defaultPatch['kf.resolution'] }));

/* ── 5. 目录映射：切了模型，显存估算也要跟着换口径 ─────────── */
console.log('\n== 5 · catalog 映射（模型库的 id 必须能在 models.catalog 里估显存）==');
for (const m of M.models) {
  const group = m.type === 'image' ? 'keyframe' : 'i2v';
  const hit = (catalog.models[group] || []).find((x) => x.id === m.catalog_model);
  ok(!!hit, m.name + ' → catalog.' + group + ' 命中 ' + m.catalog_model, hit ? (hit.resident_mib.fp8 + ' MiB@fp8 · ' + hit.provenance.slice(0, 12)) : '未收录');
}
const fluxEst = AVP.estimate(reg, catalog, AVP.resolve(reg, rules, { ...base, ...M.patchFor(flux) }).values, { device: 'T0' });
const hidreamEst = AVP.estimate(reg, catalog, AVP.resolve(reg, rules, { ...base, ...M.patchFor(M.byId('hidream-i1')) }).values, { device: 'T0' });
ok(hidreamEst.vram.peak_mib > fluxEst.vram.peak_mib, '切到 HiDream-I1 后峰值显存高于 Flux（目录不是死数）', fluxEst.vram.peak_mib + ' → ' + hidreamEst.vram.peak_mib + ' MiB');

/* ── 6. 构建产物内联了同一份配置 ───────────────────────────── */
console.log('\n== 6 · 产物一致性（web/params.html 内联的必须是同一份）==');
const htmlPath = path.join(ROOT, 'web', 'params.html');
ok(fs.existsSync(htmlPath), 'web/params.html 存在（先跑 node tools/build_all.mjs）');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  ok(html.includes('window.__MODELS ='), '产物内联了 window.__MODELS');
  ok(html.includes('window.AVPModels'), '产物内联了 core/models.js');
  ok(html.includes('id="modelSelect"') && html.includes('<optgroup'), '产物有下拉框且按分组渲染');
  const missNames = M.models.filter((m) => !html.includes(m.placeholder.slice(0, 24)));
  ok(missNames.length === 0, '9 个模型的提示词模板都已进产物', missNames.length ? '缺：' + missNames.map((m) => m.name).join(',') : '');
  ok(html.includes('已切换到') && html.includes('{baseline}'), '产物含切换提示模板（已切换到 {name}…）');
}

console.log('\n' + (fail ? `FAIL ${fail} · PASS ${pass}` : `全部通过 · ${pass} 项`));
if (fail) process.exit(1);