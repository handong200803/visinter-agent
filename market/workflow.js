/**
 * market/workflow.js —— 模板 → 工作流（编译贯通）
 *
 * 背景：`.avptpl` 以前只是"参数快照"，装进仓库也跑不起来——因为 `POST /api/jobs {template}`
 * 需要的是 **ComfyUI API 格式的图**（`{"id":{class_type,inputs}}`），而模板里只有 values。
 * 这一层就是把两者接上：模板自带一份 `workflow`（最小兼容图）+ `workflow_ref`（指向/口径），
 * 于是客户端只要 `template: tpl.workflow` 就能直接编译，不需要额外下载别的东西。
 *
 * 与 server/wf.js 的关系（为什么这里要重复十几行绑定归一化）：
 *   - 依赖方向是单向向下的，market（L2）不能反向 require server（L2）；
 *   - 但规则必须一致：只收 `bind.target` 与 `bind.widget` 都非空的参数；class_type 用去空格写法，
 *     `_meta.title` 保留人读标题，这样 `compileWorkflow` 的 id/title/class 三种匹配都能命中。
 *   - 一致靠测试守：`market/selftest.js` 第 10 组用**真的** `server/wf.js#compileWorkflow` 对拍，
 *     任何一边改了规则都会当场红掉，不需要把两边的代码合并到一起。
 *
 * 诚实标注：本文件产出的图是"绑定快照图"（4 个节点、无采样链、无 SaveImage），
 * `synthetic: true` 一路带到 `workflow_ref` 与节点 `_meta` 上——它不是能直接跑真 ComfyUI 的成品图。
 */
'use strict';

const WF_FORMAT = 'comfyui-api';
const TEXTY = new Set(['text', 'prompt', 'positive', 'negative', 'string']);

/** 与 server/wf.js 同一套归一化：去非字母数字、小写 */
function norm(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function bindOf(p) {
  const b = (p && p.bind) || {};
  const target = typeof b.target === 'string' ? b.target.trim() : '';
  const widget = typeof b.widget === 'string' ? b.widget.trim() : '';
  return { target, widget, ok: !!(target && widget) };
}

/** 注册表里"真能落地"的参数（当前 258 个里只有 6 个有完整绑定，这是常态不是 bug） */
function boundParams(registry) {
  return ((registry && registry.params) || [])
    .map((p) => ({ p, b: bindOf(p) }))
    .filter((x) => x.b.ok)
    .map(({ p, b }) => ({ key: p.key, stage: p.stage, type: p.type, target: b.target, widget: b.widget, def: p.default }));
}

/**
 * buildWorkflow —— 从注册表绑定 + 模板 values 生成最小 ComfyUI API 图
 * @param {object} registry spec/params.registry.json
 * @param {object} values   模板 values（差异值；缺的用注册表默认值补齐，避免 inputs 里留 null 被判非法）
 * @returns {{workflow:object, targets:string[], bindings:object[], nodes:number, params:number}}
 */
function buildWorkflow(registry, values) {
  const vals = values || {};
  const bound = boundParams(registry);
  const byTarget = new Map();
  for (const p of bound) {
    if (!byTarget.has(p.target)) byTarget.set(p.target, []);
    byTarget.get(p.target).push(p);
  }

  const workflow = {};
  const bindings = [];
  let i = 1;
  for (const [target, ps] of byTarget) {
    const id = String(i++);
    const inputs = {};
    for (const p of ps) {
      const has = Object.prototype.hasOwnProperty.call(vals, p.key) && vals[p.key] !== undefined;
      const v = has ? vals[p.key] : p.def;
      const texty = TEXTY.has(String(p.widget).toLowerCase()) || p.type === 'text';
      if (Object.prototype.hasOwnProperty.call(inputs, p.widget) && texty) {
        // 同槽位多参数（ch.subject + ch.face_detail 都绑 CLIP Text Encode.text）：
        // 文本用「，」拼成整句，与 server/wf.js 的合并口径一致；数值槽位留先写的，由编译器告警覆盖
        inputs[p.widget] = [inputs[p.widget], v]
          .filter((x) => x !== null && x !== undefined && String(x).trim() !== '').join('，');
      } else if (!Object.prototype.hasOwnProperty.call(inputs, p.widget)) {
        inputs[p.widget] = v;
      }
      bindings.push({ key: p.key, stage: p.stage, node: id, target, widget: p.widget });
    }
    workflow[id] = {
      class_type: target.replace(/\s+/g, ''),
      inputs,
      _meta: { title: target, synthetic: true, source: 'market/workflow.js' },
    };
  }

  return { workflow, targets: [...byTarget.keys()], bindings, nodes: Object.keys(workflow).length, params: bound.length };
}

/** workflow_ref：模板里的"编译口径"字段（kind=inline 时正文在 path 指向的字段上） */
function workflowRefOf(registry, values) {
  const b = buildWorkflow(registry, values);
  return {
    kind: 'inline',
    format: WF_FORMAT,
    path: 'workflow',
    synthetic: true,              // 绑定快照图，不是可执行采样链
    registry_version: registry.version,
    nodes: b.nodes,
    params: b.params,
    targets: b.targets,
    bindings: b.bindings,
  };
}

/** 节点索引：id / title / class_type 三种键都能查到同一个节点（与 server/wf.js 一致） */
function indexTargets(workflow) {
  const ids = new Set();
  for (const [id, node] of Object.entries(workflow || {})) {
    if (!node || typeof node !== 'object') continue;
    ids.add(String(id));
    if (node._meta && node._meta.title) ids.add(norm(node._meta.title));
    if (node.class_type) ids.add(norm(node.class_type));
  }
  return ids;
}

/**
 * resolveWorkflow —— 把模板变回可直接塞进 `POST /api/jobs {template}` 的图
 * 支持两种 kind：
 *   inline        正文内嵌在 tpl[workflow_ref.path]（默认 'workflow'）——发布出去的包走这条；
 *   registry-binds 只存口径不存正文，读数时按当前注册表重建——体积最小，但依赖平台版本。
 */
function resolveWorkflow(tpl, registry) {
  const t = tpl || {};
  const ref = t.workflow_ref;
  if (!ref || typeof ref !== 'object') return { ok: false, reason: 'NO_WORKFLOW_REF', workflow: null };
  if (ref.kind === 'inline') {
    const body = t[ref.path || 'workflow'];
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: 'MISSING_WORKFLOW_BODY', workflow: null };
    }
    return { ok: true, kind: 'inline', workflow: body, targets: ref.targets || [], registry_version: ref.registry_version || '' };
  }
  if (ref.kind === 'registry-binds') {
    if (!registry) return { ok: false, reason: 'NO_REGISTRY', workflow: null };
    const b = buildWorkflow(registry, t.values || {});
    return { ok: true, kind: 'registry-binds', workflow: b.workflow, targets: b.targets, registry_version: registry.version };
  }
  return { ok: false, reason: 'BAD_WORKFLOW_KIND:' + String(ref.kind), workflow: null };
}

/**
 * checkWorkflowRef —— verify 用的纯校验（把错误/警告推进调用方给的数组，不抛异常）
 * 判死口径：ref 形状错、内嵌正文缺失、节点数不符、声明 target 在正文里找不到、注册表版本不一致。
 */
function checkWorkflowRef(tpl, registry, errors, warnings) {
  const err = (code, p, msg) => errors.push({ code, path: p, msg });
  const warn = (code, p, msg) => warnings.push({ code, path: p, msg });

  const ref = tpl.workflow_ref;
  if (ref === undefined || ref === null) {
    warn('no_workflow', 'workflow_ref', '缺 workflow_ref：装了只能当参数快照，POST /api/jobs 无法直接编译');
    return;
  }
  if (typeof ref !== 'object' || Array.isArray(ref)) {
    err('bad_workflow_ref', 'workflow_ref', 'workflow_ref 必须是对象（{kind, format, registry_version, path, nodes, targets}）');
    return;
  }
  if (ref.kind !== 'inline' && ref.kind !== 'registry-binds') {
    err('bad_workflow_ref', 'workflow_ref.kind', 'kind 只能是 inline / registry-binds，实际 ' + JSON.stringify(ref.kind));
    return;
  }
  if (ref.format && ref.format !== WF_FORMAT) {
    err('bad_workflow_ref', 'workflow_ref.format', 'format 只能是 ' + WF_FORMAT + '（前端 UI 格式 compileWorkflow 会拒）');
  }
  if (typeof ref.registry_version === 'string' && ref.registry_version !== tpl.registry_version) {
    err('workflow_registry_mismatch', 'workflow_ref.registry_version',
      'workflow_ref.registry_version(' + ref.registry_version + ') 必须与模板 registry_version(' + tpl.registry_version + ') 一致');
  }

  if (ref.kind === 'registry-binds') {
    // 正文不落盘：只校验口径可用（是否能按当前注册表建图由运行时决定）
    if (ref.synthetic !== true) warn('workflow_synthetic_unknown', 'workflow_ref.synthetic', 'registry-binds 未标 synthetic，客户端可能误以为可执行');
    return;
  }

  const bodyPath = ref.path || 'workflow';
  const body = tpl[bodyPath];
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    err('missing_workflow_body', bodyPath, 'kind=inline 但 ' + bodyPath + ' 不是对象：包不完整');
    return;
  }
  const nodes = Object.entries(body).filter(([, n]) => n && typeof n === 'object' && typeof n.class_type === 'string');
  if (nodes.length !== Object.keys(body).length) {
    err('bad_workflow_node', bodyPath, '每个节点都必须有 class_type（ComfyUI API 格式）');
  }
  if (typeof ref.nodes === 'number' && ref.nodes !== nodes.length) {
    err('workflow_node_count_mismatch', 'workflow_ref.nodes', '声明 ' + ref.nodes + ' 个节点，正文实际 ' + nodes.length + ' 个');
  }
  const known = indexTargets(body);
  for (const target of Array.isArray(ref.targets) ? ref.targets : []) {
    if (!known.has(norm(target))) err('workflow_target_missing', 'workflow_ref.targets', '声明了节点 ' + target + '，正文里找不到（id/title/class_type 都不匹配）');
  }
  const regMap = new Map(((registry && registry.params) || []).map((p) => [p.key, p]));
  for (const b of Array.isArray(ref.bindings) ? ref.bindings : []) {
    const p = regMap.get(b && b.key);
    if (!p) { err('workflow_bind_unknown', 'workflow_ref.bindings', '绑定表里的参数 ' + JSON.stringify(b && b.key) + ' 不在注册表'); continue; }
    const bb = bindOf(p);
    if (bb.target !== b.target || bb.widget !== b.widget) {
      err('workflow_bind_unknown', 'workflow_ref.bindings', b.key + ' 的绑定与注册表不一致（注册表 ' + bb.target + '.' + bb.widget + ' / 模板 ' + b.target + '.' + b.widget + '）');
    }
  }
}

module.exports = {
  WF_FORMAT,
  norm,
  bindOf,
  boundParams,
  buildWorkflow,
  workflowRefOf,
  indexTargets,
  resolveWorkflow,
  checkWorkflowRef,
};
