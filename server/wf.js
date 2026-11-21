/**
 * wf.js —— Workflow 编译器：参数值 → ComfyUI API 格式工作流
 *
 * 关键事实（写代码前先按注册表算过，别当成假设）：258 个参数里只有 6 个带非空
 * bind.target，其余 252 个 target/widget 都是空字符串。所以"绑定覆盖率 2.3%"是常态，
 * 编译器的主职责不是拼图，而是**如实报告哪 252 个参数没有落点**——静默丢弃会让
 * 前端以为参数生效了，比报错更危险。
 *
 * 节点匹配为什么做归一化：注册表写的 target 是 "CLIP Text Encode"（给人看的标题），
 * ComfyUI 的 class_type 实际是 "CLIPTextEncode"。把两边都去掉非字母数字再小写，
 * 标题匹配与类名匹配就能同时命中，不用在 JSON 里维护两套名字。
 *
 * 同一槽位多个参数：ch.subject 与 ch.face_detail 都绑 CLIP Text Encode.text。
 * 文本类用「，」拼成整句（语义上就是主体描述 + 细节），数值类无法合并则后写覆盖并
 * 记 warning —— 覆盖必须留痕，不能悄悄发生。
 */
'use strict';

const AVP = require('../core/engine.js');

const TEXTY = new Set(['text', 'prompt', 'positive', 'negative', 'string']);
const norm = (s) => String(s == null ? '' : s).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

class WfError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail || {}; }
}

/** 参数 → 槽位索引；只收 target+widget 都齐全的。 */
function normBind(p) {
  const b = p.bind || {};
  const target = typeof b.target === 'string' ? b.target.trim() : '';
  const widget = typeof b.widget === 'string' ? b.widget.trim() : '';
  return { target, widget, ok: !!(target && widget) };
}

/**
 * 从注册表生成一份"合成模板"：每个 bind.target 一个节点。
 * 它不是能直接跑在真 ComfyUI 上的图（没有采样链、没有 SaveImage），
 * 但足以把 6 个参数摆到正确节点/正确 widget 上，供前端预览与对拍。
 */
function defaultTemplate(reg) {
  const byTarget = new Map();
  for (const p of reg.params) {
    const b = normBind(p);
    if (!b.ok) continue;
    if (!byTarget.has(b.target)) byTarget.set(b.target, []);
    byTarget.get(b.target).push(b.widget);
  }
  const wf = {};
  let i = 1;
  for (const [target, widgets] of byTarget) {
    const inputs = {};
    for (const w of widgets) inputs[w] = null;
    // class_type 用去空格的写法（"CLIP Text Encode" → "CLIPTextEncode"），贴近真 ComfyUI 的命名；
    // _meta.title 保留人读的原始标题，两种匹配路径都能命中。
    wf[String(i++)] = { class_type: target.replace(/\s+/g, ''), inputs, _meta: { title: target, synthetic: true } };
  }
  return { workflow: wf, synthetic: true, targets: [...byTarget.keys()] };
}

/** 建节点索引：id / title / class_type 三种键都能查到同一个节点 id。 */
function indexTemplate(wf) {
  const byId = new Map(), byTitle = new Map(), byClass = new Map();
  for (const [id, node] of Object.entries(wf || {})) {
    if (!node || typeof node !== 'object' || !node.class_type) {
      throw new WfError('WF_BAD_TEMPLATE', '模板不是 ComfyUI API 格式：节点缺少 class_type', { node: id });
    }
    byId.set(String(id), node);
    if (node._meta && node._meta.title) byTitle.set(norm(node._meta.title), String(id));
    byClass.set(norm(node.class_type), String(id));
  }
  return { byId, byTitle, byClass };
}

function findNode(idx, target) {
  const k = norm(target);
  if (idx.byId.has(target)) return idx.byId.get(target);
  if (idx.byTitle.has(k)) return idx.byTitle.get(k);
  if (idx.byClass.has(k)) return idx.byClass.get(k);
  return null;
}

/**
 * compileWorkflow(values, {template, registry, rules})
 * - template 省略 → 合成模板，返回值里 synthetic:true 明示"这不是可执行图"。
 * - 返回 unbound[] 覆盖三类：注册表没绑、绑了但模板没这个节点、绑定缺 widget。
 */
function compileWorkflow(values = {}, opts = {}) {
  const reg = opts.registry || loadRegistry();
  let tpl, synthetic = false, source = 'synthetic';
  if (opts.template) {
    tpl = opts.template;
    if (tpl && tpl.nodes && Array.isArray(tpl.nodes)) {
      throw new WfError('WF_BAD_TEMPLATE', '传入的是 ComfyUI 前端 UI 格式（含 nodes[]），需要 API 格式（{"id":{"class_type","inputs"}}）', {});
    }
    source = 'custom';
  } else {
    const d = defaultTemplate(reg);
    tpl = d.workflow; synthetic = true;
  }
  const idx = indexTemplate(tpl);
  // 深拷贝：调用方传进来的模板对象不应被我们改掉（jobs 会复用同一份模板）。
  const workflow = JSON.parse(JSON.stringify(tpl));

  const applied = [], merged = [], unbound = [], warnings = [];
  const slotOwner = new Map(); // "nodeId|widget" → 逗号拼接的已写值（文本）或最后一次的 key
  const byKey = AVP.byKey(reg);

  for (const p of reg.params) {
    const key = p.key;
    const has = Object.prototype.hasOwnProperty.call(values, key);
    const raw = has ? values[key] : undefined;
    const b = normBind(p);

    if (!b.ok) {
      // 缺绑定：不是错误，但必须进报告（252 条）。
      unbound.push({ key, stage: p.stage, type: p.type, reason: b.target || b.widget ? 'BIND_INCOMPLETE' : 'NO_BIND', target: b.target || null, widget: b.widget || null, hadValue: has });
      continue;
    }
    if (!has || raw === undefined) {
      // 有绑定但本次没传值：用注册表默认值补齐，否则节点入参是 null 会被 ComfyUI 判非法。
      values[key] = p.default;
    }
    const v0 = values[key];
    const v = (() => { try { return AVP.coerce(p, v0); } catch { return v0; } })();

    const nodeId = findNode(idx, b.target);
    if (!nodeId) {
      unbound.push({ key, stage: p.stage, type: p.type, reason: 'NODE_NOT_IN_TEMPLATE', target: b.target, widget: b.widget, hadValue: true, value: v });
      continue;
    }
    const node = workflow[nodeId];
    node.inputs = node.inputs || {};
    const slot = nodeId + '|' + b.widget;
    const texty = TEXTY.has(String(b.widget).toLowerCase()) || p.type === 'text';

    if (slotOwner.has(slot)) {
      if (texty) {
        const prev = node.inputs[b.widget];
        const next = [prev, v].filter((x) => x !== null && x !== undefined && String(x).trim() !== '').join('，');
        node.inputs[b.widget] = next;
        const rec = merged.find((m) => m.slot === slot);
        if (rec) { rec.keys.push(key); rec.value = next; } else merged.push({ slot, node: nodeId, target: b.target, widget: b.widget, keys: [slotOwner.get(slot), key], value: next });
        applied.push({ key, node: nodeId, target: b.target, widget: b.widget, value: v, note: 'merged' });
        continue;
      }
      warnings.push({ code: 'WF_SLOT_OVERWRITTEN', text: `${b.target}.${b.widget} 已被 ${slotOwner.get(slot)} 占用，${key} 覆盖它（数值槽位无法合并）`, slot });
    }
    node.inputs[b.widget] = v;
    slotOwner.set(slot, key);
    applied.push({ key, node: nodeId, target: b.target, widget: b.widget, value: v });
  }

  const stats = { params: reg.params.length, bound: reg.params.filter((p) => normBind(p).ok).length, applied: applied.length, merged: merged.length, unbound: unbound.length, nodes: Object.keys(workflow).length };
  if (unbound.length) {
    warnings.push({ code: 'WF_UNBOUND', text: `${stats.unbound} 个参数没有落到工作流（注册表缺绑定或模板缺节点），见 unbound[]` });
  }
  return { source, synthetic, workflow, applied, merged, unbound, warnings, stats, template_targets: Object.keys(tpl).length };
}

let _reg = null;
function loadRegistry() {
  if (_reg) return _reg;
  const fs = require('node:fs');
  const path = require('node:path');
  _reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'params.registry.json'), 'utf8'));
  return _reg;
}

module.exports = { compileWorkflow, defaultTemplate, loadRegistry, WfError, normBind, norm };