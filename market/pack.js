/**
 * market/pack.js —— 模板包 `.avptpl` 的打包 / 校验 / 落地（零依赖 CJS）
 *
 * 为什么是单文件 JSON 而不是 zip：
 *   1) 双击就能用记事本/浏览器看，创作者不需要装解包工具，评审也不需要；
 *   2) git 能按行 diff，改一个参数就是一行 +/-,模板可以被 review、被 revert；
 *   3) 没有二进制头、没有解压炸弹、没有 zip-slip 路径穿越，安装器只需要 JSON.parse。
 *   代价是体积大一点（258 参数全量也就 ~40KB 级）,模板里存的是"与默认值的差异"，
 *   实测 5 个样例每个 3–6KB，这个代价可以接受。
 *
 * 三段职责：
 *   pack(registry, values, meta) -> 模板对象（内部一定走 engine.exportPreset，checksum 语义与预设文件完全一致）
 *   verify(tpl, registry)        -> {ok, errors[], warnings[]}  纯函数，不抛异常
 *   applyTo(tpl, registry, opts) -> 全量 values（走 engine.importPreset 的越界夹紧 + rules 联动求解）
 *
 * 设计上的一条硬规矩：**打包时算的估算必须能被 applyTo 复现**。
 * 所以两边走同一条 hydrate 管道（importPreset -> resolve -> estimate），
 * 而不是打包时用原始 values 算、应用时用夹紧后的 values 算——那样差一个夹紧就会对不上。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AVP = require('../core/engine.js');
const workflow = require('./workflow.js');

const TPL_SCHEMA = 'ai-video-platform/template';
const PRESET_SCHEMA = 'ai-video-platform/preset';
const IDX_SCHEMA = 'ai-video-platform/market-index';
const FORMAT = 1;
const PLATFORM = 'ai-video-platform';
const ROOT = path.join(__dirname, '..');

/* ───────────────────────── 定价规则表（唯一事实源） ─────────────────────────
 * 不许拍脑袋：价格 = 质量分档基价 + 板块数加价 + 4K 加价，再按授权模式折算。
 * 档位边界贴着 engine.estimate 的质量分刻度（38..99，默认参数约 78 分）。
 * 规则可执行性体现在 suggestPrice() 里是纯函数，selftest 有断言。
 */
const PRICE_BANDS = [
  { max: 59, band: 'draft', price: 0 },        // 低于 60 分只能免费：卖不动还会拉低平台口碑
  { max: 69, band: 'basic', price: 8 },
  { max: 79, band: 'pro', price: 18 },
  { max: 89, band: 'plus', price: 32 },
  { max: 99, band: 'flagship', price: 48 },
];
const PRICE_ADJ = {
  per_extra_stage: 2,   // 第 2 个及以后每个 stage_focus +2 元（覆盖越多板块，作者工作量越大）
  res_4k: 4,            // 4K 交付要多跑超分链，+4 元
  revenue_share_factor: 0.6, // 分成模式只收 60% 前置价，剩余从流水抽（口径见 license.md）
  cap: 199,             // 天花板：单人模板超过 200 元平台不背书
  share: { creator_pct: 60, platform_pct: 40 },
};

/* ───────────────────────── 平台上下文（catalog + 联动规则） ───────────────────────── */
let _ctxCache = null;
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function platformContext(over) {
  if (!_ctxCache) {
    // 为什么按需读：pack/verify 在 CLI 里可能只处理结构不需要估算，避免每次启动都读 catalog
    _ctxCache = {
      catalog: readJSON(path.join(ROOT, 'spec/models.catalog.json')),
      rules: readJSON(path.join(ROOT, 'spec/rules.linkage.json')),
    };
  }
  const o = over || {};
  return { catalog: o.catalog || _ctxCache.catalog, rules: o.rules || _ctxCache.rules };
}

/* ───────────────────────── 小工具 ───────────────────────── */

function sortKeys(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}

// 与 engine 同一实现：模板 checksum 与预设 checksum 必须能互相校验，不能各写一套
function checksumOf(values) {
  return 'djb2:' + AVP._internal.djb2(JSON.stringify(sortKeys(values)));
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

// 语义化版本比较，只认 x.y.z（预发布号按数字兜底），够用且零依赖
function semver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || '0.0.0'));
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}
function cmpVer(a, b) {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

// 中文名没法转 slug，就退化成稳定哈希；显式传 id 时优先用 id
function slug(s) {
  const ascii = String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii.length >= 3) return ascii.slice(0, 48);
  return 'tpl-' + AVP._internal.djb2(String(s || '')).slice(0, 8);
}

function stagesOf(registry) {
  return (registry.stages || []).map((s) => s.id);
}

/* 没有显式声明 stage_focus 时，从"实际改了哪些板块的参数"反推主张：
 * 模板最有说服力的信息就是"它动了哪几个板块"，比手写标签可靠。 */
function inferStageFocus(registry, values) {
  const map = AVP.byKey(registry);
  const hit = {};
  for (const k of Object.keys(values || {})) {
    const p = map[k];
    if (!p) continue;
    hit[p.stage] = (hit[p.stage] || 0) + 1;
  }
  return Object.keys(hit).sort((a, b) => hit[b] - hit[a] || a.localeCompare(b)).slice(0, 3);
}

/* ───────────────────────── 定价 ───────────────────────── */

function bandOf(quality) {
  const q = Number(quality) || 0;
  for (const b of PRICE_BANDS) if (q <= b.max) return b;
  return PRICE_BANDS[PRICE_BANDS.length - 1];
}

/**
 * suggestPrice —— 可执行的定价规则（纯函数，输入固定则输出固定）
 * @param {object} p {license, quality, stage_count, ex_resolution}
 */
function suggestPrice(p) {
  const o = p || {};
  const license = o.license || 'free';
  const band = bandOf(o.quality);
  // 低于 60 分强制免费：低价区商品会拉低整个市场对"付费模板"的预期
  if (license === 'free' || band.band === 'draft') return { mode: 'free', price_cny: 0 };

  let price = band.price;
  price += PRICE_ADJ.per_extra_stage * Math.max(0, (o.stage_count || 1) - 1);
  if (o.ex_resolution === '4K') price += PRICE_ADJ.res_4k;

  if (license === 'revenue_share') {
    // 分成模式：前置价打折，剩下的从流水分成里拿，避免创作者双重收费
    const pre = Math.round(price * PRICE_ADJ.revenue_share_factor);
    return {
      mode: 'revenue_share',
      price_cny: clamp(pre, 0, PRICE_ADJ.cap),
      share: { ...PRICE_ADJ.share },
      basis: '净流水（扣除支付通道费与税费后的实收）',
    };
  }
  return { mode: 'paid', price_cny: clamp(Math.round(price), 0, PRICE_ADJ.cap) };
}

/* ───────────────────────── 估算管道（pack 与 applyTo 共用） ───────────────────────── */

function presetOf(registry, values, checksum) {
  return {
    schema: PRESET_SCHEMA,
    format: 1,
    registry_version: registry.version,
    name: '',
    author: '',
    device: '',
    created: '',
    checksum: checksum || checksumOf(values),
    values: values || {},
  };
}

/**
 * hydrate —— 把"差异 values"变成"全量 + 联动求解后 values + 估算"
 * 顺序不能换：importPreset 先夹紧（保证越界值不会进估算），resolve 再跑联动
 * （例如分辨率 2048 会压低 mo.max_frames），最后 estimate 才是平台真实会跑出来的数字。
 */
function hydrate(registry, tplLike, opts) {
  const o = opts || {};
  const { catalog, rules } = platformContext(o);
  const imp = AVP.importPreset(registry, presetOf(registry, tplLike.values, tplLike.checksum));
  const devices = catalog.devices || [];
  const device = o.device ? devices.find((d) => d.id === o.device) || devices[0] : devices[0];
  const ctx = { ...(o.ctx || {}), usable_mib: o.usable_mib || device.usable_mib, device: (o.ctx && o.ctx.device) || device.id };
  const res = rules ? AVP.resolve(registry, rules, imp.values, { ctx }) : { values: imp.values, trace: [], warnings: [] };
  const est = AVP.estimate(registry, catalog, res.values, { device: device.id, usable_mib: ctx.usable_mib });
  return {
    full: imp.values,
    resolved: res.values,
    unknown: imp.unknown,
    checksum_ok: imp.checksum_ok,
    trace: res.trace || [],
    linkWarnings: res.warnings || [],
    estimate: est,
    device: device.id,
  };
}

/* 估算摘要：塞进模板里让市场列表不用重算就能排序/展示，
 * 也是 selftest 里"applyTo 估算 == 打包估算"的比对基准。 */
function estimateMeta(est, device) {
  return {
    device,
    peak_mib: est.vram.peak_mib,
    usable_mib: est.vram.usable_mib,
    ratio: est.vram.ratio,
    state: est.vram.state,
    dominant: est.vram.dominant,
    shot_sec: est.time.shot_sec,
    episode_sec: est.time.episode_sec,
    quality: est.quality.score,
    cost_episode_yuan: est.cost.episode_yuan,
  };
}

/* ───────────────────────── 打包 ───────────────────────── */

/**
 * pack —— 生成模板对象
 * @param {object} registry  spec/params.registry.json
 * @param {object} values    用户调好的 values（可全量可差异化，越界值交给 importPreset 夹）
 * @param {object} meta      {id,name,author,license,version,created,tags,stage_focus,device,derived_from,pricing,min_platform}
 */
function pack(registry, values, meta) {
  const m = meta || {};
  const name = m.name || '未命名模板';
  // 关键：先夹紧一次再导出，否则包里的 values 可能带着越界值，verify 会判它不合法
  const cleaned = AVP.importPreset(registry, presetOf(registry, values || {})).values;
  const preset = AVP.exportPreset(registry, cleaned, { name, author: m.author || '', device: m.device || '' });

  const stageIds = stagesOf(registry);
  const focus = (m.stage_focus && m.stage_focus.length ? m.stage_focus : inferStageFocus(registry, preset.values))
    .filter((s) => stageIds.includes(s));

  const device = m.device || 'T0';
  const deviceIds = (platformContext(m).catalog.devices || []).map((d) => d.id);
  if (!deviceIds.includes(device)) {
    throw new Error('未知 device：' + device + '（可选 ' + deviceIds.join('/') + '）');
  }

  // 先 hydrate 一次拿真实质量分，再据质量分定价——价格必须由"跑出来的东西"决定
  const probe = hydrate(registry, { values: preset.values, checksum: preset.checksum }, { device, catalog: m.catalog, rules: m.rules });
  const quality = probe.estimate.quality.score;
  const pricing = m.pricing || suggestPrice({
    license: m.license || 'free',
    quality,
    stage_count: focus.length,
    ex_resolution: probe.full['ex.resolution'],
  });

  /* 编译贯通：模板自带一份最小 ComfyUI API 图（当前注册表 4 个节点 / 6 个绑定参数），
   * 让 `POST /api/jobs {template: tpl.workflow}` 直接能编译，而不是"装了只会显示参数"。 */
  const wf = workflow.buildWorkflow(registry, preset.values);

  const tpl = {
    schema: TPL_SCHEMA,
    format: FORMAT,
    id: m.id ? String(m.id) : slug(name),
    name,
    version: m.version || '1.0.0',
    author: m.author || '',
    license: (m.license || 'free'),
    registry_version: registry.version,
    created: m.created || new Date().toISOString(),
    tags: Array.isArray(m.tags) ? m.tags.slice(0, 12) : [],
    stage_focus: focus,
    cover_params: Array.isArray(m.cover_params) ? m.cover_params : Object.keys(preset.values).slice(0, 4),
    values: preset.values,
    checksum: preset.checksum,
    lineage: {
      derived_from: Array.isArray(m.derived_from) ? m.derived_from : [],
      parent_checksum: m.parent_checksum || null,
      origin: m.origin || 'manual',
    },
    compat: {
      min_platform: m.min_platform || registry.version,
      max_tested: registry.version,
      platform: PLATFORM,
    },
    pricing,
    signature: null, // 交给 market/sign.js 签；未签名的包在市场上标"未验签"
    estimate_meta: estimateMeta(probe.estimate, device),
    // 编译贯通：workflow_ref 是口径，workflow 是正文（两者一起进签名载荷，改一个字节就验签失败）
    workflow_ref: {
      kind: 'inline',
      format: workflow.WF_FORMAT,
      path: 'workflow',
      synthetic: true,
      registry_version: registry.version,
      nodes: wf.nodes,
      params: (wf.bindings || []).length,
      targets: wf.targets || [],
      bindings: wf.bindings || [],
    },
    workflow: wf.workflow,
    // 便于审计：记录是谁导出的、导出规则版本
    build: { engine: 'core/engine.js', preset_schema: PRESET_SCHEMA, preset_format: preset.format, packer: 'market/pack.js@' + FORMAT },
  };
  return tpl;
}

/* ───────────────────────── 校验 ───────────────────────── */

function err(list, code, p, msg) {
  list.push({ code, path: p, msg });
}
function warn(list, code, p, msg) {
  list.push({ code, path: p, msg });
}

/**
 * verify —— 结构 + 版本 + checksum + 值域 + 定价一致性
 * 原则：能判死的判死（error），只能提示的别拦（warning）。
 * 不抛异常——CLI 要对着一批文件连续报错，抛异常会打断批次。
 */
function verify(tpl, registry) {
  const errors = [];
  const warnings = [];

  if (!tpl || typeof tpl !== 'object') {
    err(errors, 'not_object', '', '模板必须是 JSON 对象');
    return { ok: false, errors, warnings };
  }
  if (tpl.schema !== TPL_SCHEMA) err(errors, 'bad_schema', 'schema', '期望 ' + TPL_SCHEMA + '，实际 ' + JSON.stringify(tpl.schema));
  if (tpl.format !== FORMAT) err(errors, 'bad_format', 'format', 'format 必须为 ' + FORMAT);

  /* 必填字段：类型先管住，业务校验才有意义 */
  const req = {
    id: 'string', name: 'string', version: 'string', author: 'string', license: 'string',
    registry_version: 'string', created: 'string', tags: 'array', stage_focus: 'array',
    cover_params: 'array', values: 'object', checksum: 'string', lineage: 'object',
    compat: 'object', pricing: 'object',
  };
  for (const k of Object.keys(req)) {
    const t = req[k];
    if (tpl[k] === undefined) err(errors, 'missing_field', k, '缺少必填字段 ' + k);
    else if (t === 'array' ? !Array.isArray(tpl[k]) : typeof tpl[k] !== t) err(errors, 'bad_type', k, k + ' 类型应为 ' + t);
  }
  if (!('signature' in tpl)) err(errors, 'missing_field', 'signature', '缺少必填字段 signature（未签名写 null）');

  /* id / version 形状 */
  if (typeof tpl.id === 'string' && !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(tpl.id)) {
    err(errors, 'bad_id', 'id', 'id 只允许小写字母数字 . _ -，长度 3–64：' + tpl.id);
  }
  if (typeof tpl.version === 'string' && !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tpl.version)) {
    err(errors, 'bad_version', 'version', 'version 必须是 x.y.z：' + tpl.version);
  }

  /* 版本兼容：registry_version 就是平台耦合版本 */
  if (typeof tpl.registry_version === 'string' && tpl.registry_version !== registry.version) {
    err(errors, 'registry_version_mismatch', 'registry_version',
      '注册表版本不匹配：模板 ' + tpl.registry_version + ' / 当前平台 ' + registry.version + '（参数语义可能已变，禁止安装）');
  }
  if (tpl.compat && typeof tpl.compat.min_platform === 'string') {
    if (cmpVer(registry.version, tpl.compat.min_platform) < 0) {
      err(errors, 'platform_too_old', 'compat.min_platform', '平台 ' + registry.version + ' 低于模板要求的最低版本 ' + tpl.compat.min_platform);
    }
    if (tpl.compat.max_tested && cmpVer(registry.version, tpl.compat.max_tested) > 0) {
      warn(warnings, 'untested_platform', 'compat.max_tested',
        '模板最高只在 ' + tpl.compat.max_tested + ' 上测过，当前 ' + registry.version + ' 未验证（可用但请复核估算）');
    }
  }

  /* checksum：模板自洽性。注意它只防"手改/传输损坏"，不防伪造——防伪在 sign.js */
  if (tpl.values && typeof tpl.values === 'object') {
    const got = checksumOf(tpl.values);
    if (typeof tpl.checksum === 'string' && tpl.checksum !== got) {
      err(errors, 'checksum_mismatch', 'checksum', 'checksum 不匹配：文件 ' + tpl.checksum + ' / 实算 ' + got + '（values 被改过或文件损坏）');
    }
  }

  /* 值域：未知键判死（否则会被 importPreset 静默丢弃，作者以为生效了其实没有） */
  if (tpl.values && typeof tpl.values === 'object') {
    const map = AVP.byKey(registry);
    for (const k of Object.keys(tpl.values)) {
      const p = map[k];
      if (!p) { err(errors, 'unknown_param', 'values.' + k, '注册表里没有参数 ' + k + '（可能是旧版模板或拼错）'); continue; }
      const co = AVP.coerce(p, tpl.values[k]);
      const same = typeof co === 'object' ? JSON.stringify(co) === JSON.stringify(tpl.values[k]) : co === tpl.values[k];
      if (!same) {
        err(errors, 'value_out_of_range', 'values.' + k, '值越界或类型不符：' + JSON.stringify(tpl.values[k]) + ' → 夹紧后 ' + JSON.stringify(co));
      }
    }
    if (Object.keys(tpl.values).length === 0) warn(warnings, 'no_diff', 'values', 'values 为空：模板等同默认参数，没有差异化卖点');
  }

  /* 板块与封面参数 */
  const stageIds = stagesOf(registry);
  if (Array.isArray(tpl.stage_focus)) {
    if (!tpl.stage_focus.length) err(errors, 'empty_stage_focus', 'stage_focus', 'stage_focus 不能为空');
    for (const s of tpl.stage_focus) {
      if (!stageIds.includes(s)) err(errors, 'unknown_stage', 'stage_focus', '未知板块 ' + JSON.stringify(s) + '（可选 ' + stageIds.join('/') + '）');
    }
  }
  if (Array.isArray(tpl.cover_params)) {
    const map = AVP.byKey(registry);
    for (const k of tpl.cover_params) {
      if (!map[k]) err(errors, 'unknown_param', 'cover_params', '封面参数不存在 ' + k);
      else if (tpl.values && !(k in tpl.values)) warn(warnings, 'cover_param_is_default', 'cover_params', k + ' 与默认值相同，卡片上看不出差异');
    }
  }
  if (Array.isArray(tpl.tags)) {
    if (tpl.tags.length > 12) err(errors, 'too_many_tags', 'tags', '标签上限 12');
    for (const t of tpl.tags) if (typeof t !== 'string' || !t.trim()) err(errors, 'bad_tag', 'tags', '标签必须是非空字符串');
  }

  /* 授权与定价必须自洽（三条可执行规则） */
  const LIC = ['free', 'paid', 'revenue_share'];
  if (typeof tpl.license === 'string' && !LIC.includes(tpl.license)) err(errors, 'bad_license', 'license', 'license 只能是 ' + LIC.join('/'));
  if (tpl.pricing && typeof tpl.pricing === 'object') {
    const pr = tpl.pricing;
    if (pr.mode !== tpl.license) err(errors, 'pricing_mode_mismatch', 'pricing.mode', 'pricing.mode(' + pr.mode + ') 必须等于 license(' + tpl.license + ')');
    if (typeof pr.price_cny !== 'number' || !(pr.price_cny >= 0)) err(errors, 'bad_price', 'pricing.price_cny', 'price_cny 必须是非负数');
    if (tpl.license === 'free' && pr.price_cny !== 0) err(errors, 'free_must_be_zero', 'pricing.price_cny', 'free 模板价格必须为 0');
    if (tpl.license === 'paid' && !(pr.price_cny > 0)) err(errors, 'paid_must_cost', 'pricing.price_cny', 'paid 模板价格必须 > 0');
    if (tpl.license === 'revenue_share') {
      const sh = pr.share || {};
      const sum = (sh.creator_pct || 0) + (sh.platform_pct || 0);
      if (sum !== 100) err(errors, 'bad_share', 'pricing.share', '分成比例之和必须为 100，实际 ' + sum);
      if (!pr.basis) warn(warnings, 'no_share_basis', 'pricing.basis', '缺 basis：分成基数口径未写明，结算时容易扯皮');
    }
  }

  /* 血缘与签名 */
  if (tpl.lineage && !Array.isArray(tpl.lineage.derived_from)) err(errors, 'bad_lineage', 'lineage.derived_from', 'derived_from 必须是数组');
  if (Array.isArray(tpl.lineage && tpl.lineage.derived_from)) {
    for (const d of tpl.lineage.derived_from) {
      if (typeof d !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(d)) err(errors, 'bad_derived_from', 'lineage.derived_from', '血缘 id 不合法：' + JSON.stringify(d));
    }
  }
  if (tpl.signature === null || tpl.signature === undefined) warn(warnings, 'unsigned', 'signature', '未签名：完整性/来源未验（安装前建议先跑 tpl sign）');
  else if (tpl.signature && tpl.signature.algo !== 'HMAC-SHA256') warn(warnings, 'unknown_algo', 'signature.algo', '未知签名算法 ' + JSON.stringify(tpl.signature.algo));

  /* 编译贯通：workflow_ref / 内嵌图 的形状与版本一致性（错码见 market/workflow.js#checkWorkflowRef） */
  workflow.checkWorkflowRef(tpl, registry, errors, warnings);

  /* 估算元数据（可选，但缺了就失去市场排序依据） */
  if (!tpl.estimate_meta) warn(warnings, 'no_estimate', 'estimate_meta', '缺 estimate_meta：市场列表无法直接显示显存/耗时，需要在客户端重算');

  return { ok: errors.length === 0, errors, warnings };
}

/* ───────────────────────── 落地 ───────────────────────── */

/**
 * applyTo —— 把模板变成本机可跑的 258 参数
 * 走 engine.importPreset：schema/版本校验 + 越界夹紧 + 未知键丢弃（不静默——unknown 一并返回给调用方提示用户）
 */
function applyTo(tpl, registry, opts) {
  const o = opts || {};
  const v = verify(tpl, registry);
  // checksum 错就拒绝落地：宁可报错，也不要把"和作者声称的不一样"的参数跑进渲染队列
  if (!v.ok && v.errors.some((e) => e.code === 'checksum_mismatch')) {
    throw new Error('模板 checksum 校验失败，拒绝应用：' + v.errors.map((e) => e.code).join(','));
  }
  const h = hydrate(registry, tpl, { ...o, device: o.device || (tpl.estimate_meta && tpl.estimate_meta.device) });
  return {
    template: { id: tpl.id, version: tpl.version, name: tpl.name },
    values: h.full,          // 全量 258 参数（已夹紧）
    resolved: h.resolved,    // 再跑一遍联动规则后的最终参数（真正送进管线的）
    unknown: h.unknown,
    checksum_ok: h.checksum_ok,
    linkWarnings: h.linkWarnings,
    estimate: h.estimate,
    device: h.device,
    verify: v,
  };
}

/**
 * jobPayload —— 把"装了能不能跑"这件事变成一行可发送的请求体
 *
 * 返回的就是 `POST /api/jobs` 的 body：values 用 rules 求解后的全量参数，
 * template 用模板自带的最小图（`POST /api/jobs {template}` 直接进 server/wf.js#compileWorkflow）。
 * 为什么不用 tpl.workflow 原样当 values：模板只存差异，管线要 258 个键；这里统一走 applyTo，
 * 保证"模板落地参数"和"编译进图的参数"是同一份。
 */
function jobPayload(tpl, registry, opts) {
  const o = opts || {};
  const a = applyTo(tpl, registry, o);
  const w = workflow.resolveWorkflow(tpl, registry);
  if (!w.ok) {
    const e = new Error('E_NO_WORKFLOW: ' + w.reason + '（模板缺 workflow_ref/内嵌图，无法直接编译）');
    e.reason = w.reason;
    throw e;
  }
  return {
    values: a.resolved,
    device: o.device || a.estimate.device.id,
    template: w.workflow,
    note: o.note || (tpl.id + '@' + tpl.version),
    meta: {
      template: { id: tpl.id, version: tpl.version, checksum: tpl.checksum },
      workflow_kind: w.kind,
      synthetic: !!(tpl.workflow_ref && tpl.workflow_ref.synthetic),
      nodes: Object.keys(w.workflow).length,
      bound_params: ((tpl.workflow_ref && tpl.workflow_ref.bindings) || []).length,
      checksum_ok: a.checksum_ok,
      estimate: {
        device: a.estimate.device.id,
        peak_mib: a.estimate.vram.peak_mib,
        ratio: a.estimate.vram.ratio,
        shot_sec: a.estimate.time.shot_sec,
        quality: a.estimate.quality.score,
      },
    },
  };
}

module.exports = {
  TPL_SCHEMA, PRESET_SCHEMA, IDX_SCHEMA, FORMAT, PLATFORM,
  PRICE_BANDS, PRICE_ADJ,
  pack, verify, applyTo, jobPayload,
  suggestPrice, bandOf,
  checksumOf, slug, semver, cmpVer, sortKeys,
  hydrate, estimateMeta, stagesOf, inferStageFocus,
  platformContext, workflow,
};