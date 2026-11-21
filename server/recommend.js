/**
 * recommend.js —— AI 参数推荐（双轨：Qwen 在线推荐 / 本地规则推荐）
 *
 * 为什么有两条轨：
 *   有 DASHSCOPE_API_KEY 时调 Qwen 输出完整配置 JSON（core/common/advanced_overrides）；
 *   没有 key 或调用失败时退回「Muse 预设关键词匹配 + engine 求解」的规则推荐，
 *   并显式标 source:'rules' + ai.error——绝不把规则结果伪装成 AI 输出（诚实降级铁律）。
 *
 * 防编造三道闸：
 *   1. AI 只允许输出注册表里真实存在的键，未知键丢弃并上报 invalid_keys；
 *   2. 所有值经 engine.coerce 夹取到 min/max/枚举合法域；
 *   3. muse_level 一律 provenance:'estimate'——质量分来自 engine.estimate 估算模型，
 *      不是实测画质评分，AI 给的分数也只当估算参考。
 *
 * key 只走环境变量（DASHSCOPE_API_KEY），不落仓库/前端/响应体。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AVP = require('../core/engine.js');
const AESTH = require('./aesthetics.js');
const { createCharacterExtractor } = require('./character.js');

const ROOT = path.join(__dirname, '..');

function loadMuse() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'muse.presets.json'), 'utf8'));
}

function loadModelConfigs() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'model.configs.json'), 'utf8'));
}

/** model_configs 配置 → 注册表补丁（与前端 modelPatches 同口径：coerce 夹取 + 比例最近近似，notes 如实）。 */
function modelPatchesOf(c, map) {
  const RATIO_VAL = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '2.35:1': 2.35 };
  const patch = {}, notes = [];
  const put = (k, v) => {
    if (v == null || !map[k]) return;
    const cv = AVP.coerce(map[k], v);
    if (cv !== v && (map[k].type === 'int' || map[k].type === 'float')) notes.push(`${k} ${v} 超注册表范围，夹取到 ${cv}`);
    patch[k] = cv;
  };
  put('kf.sampler', c.sampler); put('kf.scheduler', c.scheduler); put('kf.cfg', c.cfg); put('kf.steps', c.steps);
  if (Array.isArray(c.res)) {
    const [w, h] = c.res;
    put('kf.resolution', Math.max(w, h));
    let best = null, bd = Infinity;
    for (const [r, v] of Object.entries(RATIO_VAL)) { const d = Math.abs(Math.log((w / h) / v)); if (d < bd) { bd = d; best = r; } }
    patch['kf.ratio'] = best;
    if (bd > 0.01) notes.push(`${w}×${h} 无精确比例枚举，按最近 ${best} 近似`);
  }
  put('mo.fps', c.fps); put('mo.duration', c.duration);
  if (c.default_negative != null) patch['ch.negative'] = c.default_negative;
  if (c.prompt_suffix != null) patch['ch.prompt_prefix'] = c.prompt_suffix;
  for (const [k, v] of Object.entries(c.registry_map || {})) put(k, v);
  return { patch, notes };
}

/** 关键词命中最多的预设；style 显式指定时优先；都不中 → 第一个（Muse电影感）。 */
function pickPreset(muse, prompt, style) {
  if (style) {
    const hit = muse.presets.find((p) => p.id === style);
    if (hit) return hit;
  }
  const text = String(prompt || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const p of muse.presets) {
    const s = (p.keywords || []).filter((k) => text.includes(String(k).toLowerCase())).length;
    if (s > bestScore) { best = p; bestScore = s; }
  }
  return best || muse.presets[0];
}

/** 把 AI 返回的三层补丁验证 + 夹取成合法 values 增量。未知键/坏值如实上报。 */
function validateAiPayload(payload, reg) {
  const map = AVP.byKey(reg);
  const values = {};
  const invalid = [];
  const sections = ['core', 'common', 'advanced_overrides'];
  for (const sec of sections) {
    const obj = payload && payload[sec];
    if (!obj || typeof obj !== 'object') continue;
    for (const [k, v] of Object.entries(obj)) {
      const p = map[k];
      if (!p) { invalid.push({ key: k, reason: 'UNKNOWN_KEY', section: sec }); continue; }
      if (v === '保持默认' || v === null || v === undefined) continue;
      const coerced = AVP.coerce(p, v);
      if ((p.type === 'int' || p.type === 'float') && !Number.isFinite(Number(v))) {
        invalid.push({ key: k, reason: 'NOT_A_NUMBER', got: v, section: sec });
        continue;
      }
      if (p.type === 'enum' && !p.options.includes(v)) {
        invalid.push({ key: k, reason: 'BAD_ENUM', got: v, allowed: p.options, section: sec });
        continue;
      }
      if (coerced !== v && (p.type === 'int' || p.type === 'float')) {
        invalid.push({ key: k, reason: 'CLAMPED', got: v, to: coerced, section: sec });
      }
      values[k] = coerced;
    }
  }
  return { values, invalid };
}

/** 从完整 values 切出三层视图：core 5 项 / common=L3 其余 / advanced_overrides=L4 非默认。 */
function splitLayers(values, reg, muse) {
  const coreKeys = muse.core_keys;
  const core = {}, common = {}, advanced_overrides = {};
  for (const p of reg.params) {
    const v = values[p.key];
    if (coreKeys.includes(p.key)) core[p.key] = v;
    else if (p.tier === 'L3') common[p.key] = v;
    else if (v !== p.default) advanced_overrides[p.key] = v;
  }
  return { core, common, advanced_overrides };
}

function createRecommender(opts = {}) {
  const reg = opts.registry;
  const catalog = opts.catalog;
  const rules = opts.rules;
  const muse = opts.muse || loadMuse();
  const modelConfigs = opts.models || loadModelConfigs();
  const map = AVP.byKey(reg);
  const defaults = AVP.defaults(reg);
  const modelById = (id) => modelConfigs.models.find((c) => c.id === id) || null;
  // 角色设定提取器：只认 ch.* 六个字段，值过注册表域校验
  const character = createCharacterExtractor({ registry: reg });

  const qwenKey = () => process.env.DASHSCOPE_API_KEY || '';
  const qwenModel = () => process.env.AVP_QWEN_MODEL || 'qwen-plus';
  const qwenUrl = () => {
    const base = process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1';
    return base.replace(/\/api\/v1\/?$/, '') + '/compatible-mode/v1/chat/completions';
  };

  /** 规则轨：预设补丁 → 模型库基线（model_id 指定时）→ coerce → resolve → estimate。永远可用。 */
  function ruleRecommend({ prompt, device, style, values: extra, model_id }) {
    const preset = pickPreset(muse, prompt, style);
    const values = { ...defaults };
    for (const [k, v] of Object.entries(preset.values)) if (map[k]) values[k] = AVP.coerce(map[k], v);
    const mc = model_id ? modelById(model_id) : null;
    let modelNotes = [];
    if (mc) {
      const { patch, notes } = modelPatchesOf(mc, map);
      Object.assign(values, patch);
      modelNotes = notes;
    }
    return { preset, values, modelConfig: mc, modelNotes };
  }

  /** 给 Qwen 的参数目录：只喂真实键与合法域，一行一参数。 */
  function paramCatalogText() {
    return reg.params.map((p) => {
      const range = p.type === 'enum' ? `enum[${p.options.join('|')}]`
        : p.type === 'bool' ? 'bool'
        : p.type === 'text' ? 'text'
        : `${p.type} ${p.min}..${p.max}${p.step ? ' step ' + p.step : ''}`;
      return `${p.key} | ${p.tier} | ${range} | 默认 ${JSON.stringify(p.default)} | ${typeof p.label === 'string' ? p.label : (p.label && p.label.zh) || ''}`;
    }).join('\n');
  }

  function systemPrompt() {
    return [
      '你是「本地一体化 AI 视频平台」的参数调校引擎。平台有 258 个参数（7 板块），目标是通过参数组合与提示词工程释放开源模型潜力，逼近 Muse 级电影质感。',
      '用户给你创作提示词与显存档位，你输出一个完整参数配置 JSON，且只输出 JSON（不要 markdown 围栏、不要解释文字）。',
      '输出结构：{"core":{...},"common":{...},"advanced_overrides":{...},"reason":"中文推荐理由（80字内）","muse_level":0到10的数字}',
      `core 必须给满这 5 个键：${muse.core_keys.join(', ')}。`,
      'common 给 L3 常用层的推荐值（多数保持默认即可，只写你确有把握的键）。advanced_overrides 只放需要偏离默认值的高级参数，其余一律不写（等价于保持默认）。',
      '硬约束：只能使用下方目录中真实存在的键；数值必须在 min..max 内；enum 只能取列出的值；显存估算 ratio 不得超过 1（超了必须降分辨率/步数/批量）。',
      'muse_level 是你对这套配置画面质感的预估（0-10），不是实测分。',
      '额外可选字段 character：{ "ch.subject": "主体描述", "ch.age": 24, "ch.face_shape": "鹅蛋|圆|方|瓜子|长|心形", "ch.outfit_1": "服装（含颜色款式）", "ch.style": "赛璐璐|厚涂|工笔|水墨|韩漫|日漫|国潮", "ch.consistency": 0.85~1.1 }。',
      'character 的规则：只写提示词里真的说了的字段；没说的不要写（留空由平台按默认处理）；ch.age 必须是数字（"二十出头"这类写 24）；多镜头/同人物系列 ch.consistency=1.0，单镜氛围片=0.85，不得超过 1.1。',
      '参数目录（key | 层级 | 类型与合法域 | 默认值 | 中文名）：',
      paramCatalogText(),
    ].join('\n');
  }

  async function callQwen({ prompt, device, usableMib, modelConfig }) {
    const key = qwenKey();
    if (!key) { const e = new Error('未设置 DASHSCOPE_API_KEY'); e.code = 'DS_NO_API_KEY'; throw e; }
    const user = [
      `创作提示词：${prompt || '（未提供，按通用电影感场景推荐）'}`,
      `显存档位：${device}（可用 ${usableMib} MiB，WDDM 口径）`,
      modelConfig ? `用户选定模型：${modelConfig.name}（${modelConfig.features}）。特性与口径：${modelConfig.tips} 推荐基线：sampler=${modelConfig.sampler || '保持'} cfg=${modelConfig.cfg != null ? modelConfig.cfg : '保持'} steps=${modelConfig.steps != null ? modelConfig.steps : '保持'}。负面词口径：${modelConfig.default_negative || '平台默认'}。映射说明：${modelConfig.mapping_note} 请按该模型特性推荐参数（基线可微调，但不要违背模型特性，如 Flux 低 CFG）。` : '',
      '请输出完整配置 JSON。',
    ].filter(Boolean).join('\n');
    const res = await fetch(qwenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: qwenModel(),
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: user }],
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(Number(process.env.AVP_QWEN_TIMEOUT_MS || 60000)),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch (e) { /* 忽略 */ }
      const e = new Error(`Qwen HTTP ${res.status}${detail ? '：' + detail : ''}`);
      e.code = res.status === 401 ? 'DS_INVALID_API_KEY' : 'QWEN_HTTP_ERROR';
      throw e;
    }
    const data = await res.json();
    const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text) { const e = new Error('Qwen 返回空内容'); e.code = 'QWEN_EMPTY'; throw e; }
    const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let payload;
    try { payload = JSON.parse(cleaned); } catch (e) { const err = new Error('Qwen 输出不是合法 JSON：' + e.message); err.code = 'QWEN_BAD_JSON'; throw err; }
    return payload;
  }

  /**
   * 主入口。返回三层补丁 + 完整 258 键求解值 + 四向估算。
   * source:'qwen' = 真 AI 推荐；source:'rules' = 规则推荐（ai.attempted/ai.error 说明原因）。
   */
  async function recommend({ prompt, device, style, values: extraValues, model_id } = {}) {
    const dev = catalog.devices.find((d) => d.id === device) || catalog.devices[0];
    const ctx = { device: dev.id, usable_mib: dev.usable_mib };
    const base = ruleRecommend({ prompt, device: dev.id, style, model_id });
    const mc = base.modelConfig;

    let ai = { attempted: false, ok: false };
    let overlay = {};
    let invalid = [];
    let reason = `按提示词关键词匹配「${base.preset.name}」预设（${Object.keys(base.preset.values).length} 项补丁）${mc ? `，叠加模型库「${mc.name}」基线` : ''}，其余保持注册表默认。`;
    let qwenMuseLevel = null;
    let qwenPayload = null;

    if (qwenKey()) {
      ai.attempted = true;
      try {
        const payload = await callQwen({ prompt, device: dev.id, usableMib: dev.usable_mib, modelConfig: mc });
        qwenPayload = payload;
        const v = validateAiPayload(payload, reg);
        overlay = v.values;
        invalid = v.invalid;
        ai.ok = true;
        ai.model = qwenModel();
        if (typeof payload.reason === 'string' && payload.reason.trim()) reason = payload.reason.trim().slice(0, 300);
        const ml = Number(payload.muse_level);
        if (Number.isFinite(ml)) qwenMuseLevel = Math.max(0, Math.min(10, ml));
      } catch (e) {
        ai.error = { code: e.code || 'QWEN_ERROR', message: e.message };
        reason += ` AI 通路失败（${ai.error.code}），已显式降级为规则推荐，不伪装 AI 输出。`;
      }
    } else {
      ai.error = { code: 'DS_NO_API_KEY', message: '未设置 DASHSCOPE_API_KEY，使用本地规则推荐（Muse 预设匹配 + 求解器），非 AI 生成。' };
    }

    const merged = { ...base.values, ...overlay };
    if (extraValues && typeof extraValues === 'object') {
      for (const [k, v] of Object.entries(extraValues)) if (map[k]) merged[k] = AVP.coerce(map[k], v);
    }
    // 角色设定自动提取：Qwen 给了 character 块就用它（过域校验），否则纯规则提取。
    // 写回 merged 前先 coerce，保证 258 键里 ch.* 的值永远合法；冲突/矛盾如实留在 character 里给前端展示。
    let charRep = character.extract({
      prompt,
      values: extraValues || {},
      style,
      shotCount: extraValues && (extraValues['ex.shot_count'] || extraValues['ch.pose_count']),
      mode: extraValues && extraValues['ex.mode'],
    });
    if (qwenPayload && qwenPayload.character) charRep = character.mergeQwen(charRep, qwenPayload.character);
    let charApplied = 0;
    for (const [k, v] of Object.entries(charRep.patch || {})) {
      if (!map[k]) continue;
      merged[k] = AVP.coerce(map[k], v);
      charApplied += 1;
    }
    charRep.applied = charApplied;

    const r = AVP.resolve(reg, rules, merged, { ctx });
    const estimate = AVP.estimate(reg, catalog, r.values, { device: dev.id });
    const layers = splitLayers(r.values, reg, muse);
    const engineLevel = +(estimate.quality.score / 10).toFixed(1);

    return {
      source: ai.ok ? 'qwen' : 'rules',
      model: ai.ok ? ai.model : null,
      model_id: mc ? mc.id : null,
      model_config: mc ? { id: mc.id, name: mc.name, tag: mc.tag } : null,
      model_notes: base.modelNotes,
      preset: { id: base.preset.id, name: base.preset.name },
      reason,
      ...layers,
      values: r.values,
      device: dev.id,
      estimate: { vram: estimate.vram, time: estimate.time, quality: estimate.quality, cost: estimate.cost },
      warnings: r.warnings,
      muse_level: {
        score: qwenMuseLevel !== null ? qwenMuseLevel : engineLevel,
        engine_score: engineLevel,
        provenance: 'estimate',
        basis: qwenMuseLevel !== null ? 'Qwen 预估（参考）+ engine.estimate 质量分/10' : 'engine.estimate 质量分/10（估算模型，非实测）',
      },
      ai,
      invalid_keys: invalid,
      character: charRep,
      aesthetics: (() => { const m = AESTH.matchTheme(prompt); return m ? { themeId: m.theme.id, name: m.theme.name, score: m.score, params: AESTH.paramRules(m.theme), ratioSuggested: m.theme.ratio, soundMood: m.theme.soundMood, light: m.theme.light, color: m.theme.color, lens: m.theme.lens, texture: m.theme.texture } : null; })(),
    };
  }

  return { recommend, ruleRecommend, pickPreset: (prompt, style) => pickPreset(muse, prompt, style), muse, modelConfigs, modelById };
}

module.exports = { createRecommender, loadMuse, loadModelConfigs, modelPatchesOf, pickPreset, validateAiPayload, splitLayers };