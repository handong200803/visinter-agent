/**
 * models.js —— 模型库解析器（零依赖，浏览器 / Node 双端同一份）
 *
 * 职责边界：
 *   - 只吃 spec/model_configs.json，把「选了哪个模型」翻译成「哪些注册表键要改成什么」。
 *   - 不认识 UI，不认识后端；补丁键名全部来自配置里的 bindings，代码里不写死模型名或参数名。
 *
 * 为什么单独一层：
 *   参数面板要切模型、后端要按 model_id 复算、自检要断言基线，三处必须是同一套翻译逻辑。
 *   任何一处各写一份，就会出现「界面切了、导出没切、后端算的还是旧的」这类漂移。
 *
 * 浏览器侧挂到 window.AVPModels；Node 侧 module.exports（require 得到同一对象）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AVPModels = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 每个模型必须具备的字段（缺一条配置就不完整，自检会报出来） */
  const REQUIRED = ['id', 'name', 'type', 'sampler', 'cfg', 'steps', 'res', 'default_negative', 'placeholder', 'tips'];

  const FULLWIDTH = /\s+/g;

  function text(v) {
    return v == null ? '' : String(v).replace(FULLWIDTH, ' ').trim();
  }

  function normTips(list) {
    return (Array.isArray(list) ? list : []).map((t) => (typeof t === 'string'
      ? { level: 'info', text: t }
      : { level: t.level === 'warn' ? 'warn' : 'info', text: text(t.text) })).filter((t) => t.text);
  }

  function resText(m) {
    const r = m && m.res ? m.res : {};
    if (m && m.type === 'video') {
      const p = r.p || (r.h ? r.h + 'p' : '');
      return p || '—';
    }
    if (r.w && r.h) return r.w + '×' + r.h;
    return '—';
  }

  function baselineText(m) {
    if (!m) return '';
    const bits = [];
    if (m.sampler) bits.push(text(m.sampler));
    if (m.cfg != null) bits.push('CFG ' + m.cfg);
    if (m.steps != null) bits.push(m.steps + ' 步');
    bits.push(resText(m));
    if (m.type === 'video') {
      if (m.fps != null) bits.push(m.fps + 'fps');
      if (m.duration != null) bits.push(m.duration + 's');
      if (m.frames != null) bits.push(m.frames + ' 帧');
    }
    return bits.filter(Boolean).join(' · ');
  }

  function create(configs) {
    const cfg = configs || {};
    const raw = Array.isArray(cfg.models) ? cfg.models : [];
    const groups = Array.isArray(cfg.groups) ? cfg.groups : [
      { id: 'image', name: '图像模型' }, { id: 'video', name: '视频模型' },
    ];
    const bindings = cfg.bindings || {};
    const ui = cfg.ui || {};

    const models = raw.map((m) => ({
      ...m,
      tags: Array.isArray(m.tags) ? m.tags.slice() : [],
      tips: normTips(m.tips),
    }));
    const index = new Map();
    models.forEach((m) => { if (m && m.id) index.set(String(m.id), m); });

    const list = (type) => (type ? models.filter((m) => m.type === type) : models.slice());
    const byId = (id) => index.get(String(id)) || null;
    const defaultModel = () => models.find((m) => m.default) || models[0] || null;

    /** 把模型基线翻译成 { 注册表键: 值 }。键名全部来自 bindings，加模型不用改这份代码。 */
    function patchFor(model) {
      const m = typeof model === 'string' ? byId(model) : model;
      if (!m) return {};
      const b = bindings[m.type] || {};
      const out = {};
      const put = (key, val) => { if (key && val !== undefined && val !== null && val !== '') out[key] = val; };

      put(b.catalog_model, m.catalog_model);
      put(b.sampler_key, m.sampler_key);
      put(b.scheduler, m.scheduler);
      put(b.cfg, typeof m.cfg === 'number' ? m.cfg : null);
      put(b.steps, m.steps);
      if (b.resolution) {
        if (m.type === 'video') put(b.resolution, m.res && m.res.p);
        else put(b.resolution, m.res && m.res.w ? Math.max(m.res.w, m.res.h) : null);
      }
      put(b.ratio, m.ratio);
      put(b.fps, m.fps);
      put(b.duration, m.duration);
      put(b.frames, m.frames);
      put(b.negative, m.default_negative);
      return out;
    }

    /** 配置自检：返回问题数组，空数组 = 完整 */
    function validate() {
      const issues = [];
      if (!models.length) issues.push('models[] 为空');
      if (!groups.length) issues.push('groups[] 为空');
      if (!Array.isArray(cfg.models)) issues.push('缺少 models 数组');
      const ids = new Set();
      models.forEach((m, i) => {
        const where = 'models[' + i + ']' + (m && m.id ? '(' + m.id + ')' : '');
        for (const k of REQUIRED) {
          if (!(k in m)) issues.push(where + ' 缺字段 ' + k);
        }
        if (!m.id) issues.push(where + ' 缺 id');
        else if (ids.has(m.id)) issues.push(where + ' id 重复：' + m.id);
        else ids.add(m.id);
        if (m.type !== 'image' && m.type !== 'video') issues.push(where + ' type 非 image/video：' + m.type);
        const b = bindings[m.type];
        if (!b) issues.push(where + ' 没有对应的 bindings.' + m.type);
        if (m.type === 'image') {
          if (!m.sampler_key) issues.push(where + ' 图像模型缺 sampler_key');
          if (typeof m.cfg !== 'number') issues.push(where + ' 图像模型 cfg 必须是数字');
          if (typeof m.steps !== 'number') issues.push(where + ' 图像模型 steps 必须是数字');
          if (!m.res || !m.res.w || !m.res.h) issues.push(where + ' 图像模型 res 需要 {w,h}');
        } else {
          if (!m.res || !m.res.p) issues.push(where + ' 视频模型 res 需要 {p:"720p"}');
          if (!m.catalog_model) issues.push(where + ' 视频模型缺 catalog_model');
        }
        if (!text(m.default_negative)) issues.push(where + ' default_negative 为空');
        if (!text(m.placeholder)) issues.push(where + ' placeholder 为空');
        if (!m.tips || !m.tips.length) issues.push(where + ' tips 为空');
        if (!m.feature) issues.push(where + ' 缺 feature（卡片一句话说明）');
      });
      const def = cfg.default_model ? byId(cfg.default_model) : defaultModel();
      if (!def) issues.push('default_model 指向不存在的模型：' + cfg.default_model);
      return issues;
    }

    return {
      configs: cfg,
      ui,
      groups,
      bindings,
      models,
      list,
      byId,
      defaultModel,
      patchFor,
      baselineText,
      resText,
      validate,
      get version() { return cfg.version || ''; },
    };
  }

  return { create, REQUIRED, baselineText, resText, normTips };
});