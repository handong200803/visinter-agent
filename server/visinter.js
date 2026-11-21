/**
 * visinter.js —— VisInter-Agent 规则引擎（wan2.2 本地开源管线）
 *
 * 四件事，全部纯逻辑（自检除外，自检要连 ComfyUI）：
 *   1) 主体识别：人像 / 风景 / 未识别（未识别就什么都不动，宁可不猜）
 *   2) 双模式装配：小白一键填提示词与稳定预设；专家模式不填任何值
 *   3) 风险检测：六类只产出提示，不返回 blocked=true —— "不拦截"是接口层面的承诺
 *   4) 角色提取 + 脸型场景预设 + 自检状态机（inferred / measured / fail，分 global / face 两层）
 *
 * 硬约束（来自 spec/visinter.agent.json 的 rules，不是文档装饰）：
 *   · 用户手改优先：自动填充只写 manualKeys 之外的键；提示词一旦手改永不覆盖
 *   · 不拦截：risks() 永远返回数组，装配结果永远带 submit_allowed:true
 *   · 诚实：节点与模型用 ComfyUI /object_info 与模型列表真实检查；自检没跑就是 inferred
 *   · 风景不被人脸拖下水：face 层缺失只封人像，landscape_ok 仍为 true
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SPEC_FILE = path.join(__dirname, '..', 'spec', 'visinter.agent.json');
const RC_FILE = path.join(__dirname, '..', 'spec', 'reverse.capabilities.json');

let specCache = null;
function loadSpec() {
  if (!specCache) specCache = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
  return specCache;
}
let rcCache = null;
function loadReverseCaps() {
  if (!rcCache) rcCache = JSON.parse(fs.readFileSync(RC_FILE, 'utf8'));
  return rcCache;
}

/** 主体识别：关键词计分。两边都命中时取分高；打平或无命中 → unknown（不猜）。 */
function detectSubject(text) {
  const spec = loadSpec();
  const s = String(text || '').toLowerCase();
  const link = spec.linkage;
  const score = (words) => words.reduce((n, w) => (s.includes(String(w).toLowerCase()) ? n + 1 : n), 0);
  const portrait = score(link.portrait.keywords);
  const landscape = score(link.landscape.keywords);
  let subject = 'unknown';
  if (portrait > landscape) subject = 'portrait';
  else if (landscape > portrait) subject = 'landscape';
  const hits = (words) => words.filter((w) => s.includes(String(w).toLowerCase()));
  return {
    subject, scores: { portrait, landscape },
    matched: { portrait: hits(link.portrait.keywords), landscape: hits(link.landscape.keywords) },
    rule: '得分高者胜；打平/无命中 → unknown，不追加也不关闭人脸模块',
  };
}

/* ───────────── 脸型：关键词提取 + 场景预设 ───────────── */

/** 场景识别：Muse / 抖音网红 / 二次元。只影响脸型预设，不影响主体联动。 */
function sceneOf(text) {
  const spec = loadSpec();
  const s = String(text || '').toLowerCase();
  const scenes = (spec.face_presets && spec.face_presets.scenes) || [];
  for (const sc of scenes) {
    const hit = (sc.match || []).find((w) => s.includes(String(w).toLowerCase()));
    if (hit) return { scene: sc.id, face: sc.face, matched: hit, reason: sc.reason };
  }
  return { scene: null, face: null, matched: null, reason: '提示词未命中 Muse/网红/二次元场景，脸型走关键词或默认' };
}

/** 提示词里的脸型词。顺序即优先级（先到先得），与 character.js 的 FACE_RULES 保持同一套词表。 */
function detectFaceShape(text) {
  const spec = loadSpec();
  const s = String(text || '');
  const rules = (spec.face_presets && spec.face_presets.keyword_map) || [];
  for (const r of rules) {
    const m = new RegExp(r.re, 'i').exec(s);
    if (m) return { face: r.face, source: 'keyword', evidence: `提示词命中「${m[0]}」`, matched: m[0] };
  }
  return { face: null, source: 'none', evidence: '提示词没写脸型', matched: null };
}

/**
 * 场景脸型预设：先看提示词是否明写了脸型；没写再按场景给默认；都没有就 None（交给面板默认）。
 * 为什么场景优先于「什么都不做」：Muse/网红人像的骨相锚点就是瓜子/V 脸，
 * 不给预设就会一路沿用注册表默认的「鹅蛋」，出图必漂。
 */
function faceShapeFor(text) {
  const kw = detectFaceShape(text);
  if (kw.face) return { ...kw, scene: null, scene_reason: null };
  const sc = sceneOf(text);
  if (sc.face) return { face: sc.face, source: 'scene', evidence: `${sc.reason}（命中「${sc.matched}」）`, matched: sc.matched, scene: sc.scene, scene_reason: sc.reason };
  return { face: null, source: 'none', evidence: kw.evidence, matched: null, scene: null, scene_reason: sc.reason };
}

/**
 * 把 reverse.capabilities 的 preconditions 前置到 UI 层：
 * 抖音网红脸场景下，默认主体整句里的「，鹅蛋脸」必须整段删掉，否则提示词里两套脸型并存。
 * 返回清理后的 subject（只删命中项，不动用户其它字）。
 */
function applySubjectPreconditions(subject, scene) {
  const rc = loadReverseCaps();
  const want = scene === 'douyin' ? 'douyin-face' : null;
  if (!want || !subject) return { subject, applied: [] };
  const ability = rc.abilities.find((a) => a.id === want);
  const subs = (ability && ability.preconditions && ability.preconditions.substitutions) || [];
  let out = String(subject);
  const applied = [];
  for (const s of subs) {
    if (!s || !s.find) continue;
    if (out.includes(s.find)) {
      out = out.split(s.find).join(s.replace || '');
      applied.push({ ability: want, find: s.find, replace: s.replace || '' });
    }
  }
  return { subject: out, applied };
}

/** 角色提取汇总（前端标【AI提取】，可随时改）。 */
function characterOf(text, opts = {}) {
  const subj = detectSubject(text);
  const face = faceShapeFor(text);
  const scene = sceneOf(text);
  const pre = applySubjectPreconditions(opts.subject || '', scene.scene);
  const patch = {};
  if (face.face) patch['ch.face_shape'] = face.face;
  if (pre.subject) patch['ch.subject'] = pre.subject;
  return {
    tag: '【AI提取】',
    subject: subj.subject,
    face_shape: { value: face.face, source: face.source, evidence: face.evidence, scene: face.scene, manual_overridable: true },
    scene: { id: scene.scene, reason: scene.reason },
    patch,
    preconditions_applied: pre.applied,
    note: '全部字段可手改；手改后不会被再次自动覆盖（manualKeys 优先）',
  };
}

/**
 * 分辨率风险判定：把 kf.resolution（长边像素）+ kf.ratio 换算成 "W*H" 再比白名单。
 * 只在「用户显式动过分辨率」时才判 —— 默认的 1536 是平台自己的合法档，
 * 一上来就弹窗等于把常驻提示变成噪音（那六条是异常提示，不是开机广告）。
 */
function resolutionWH(values, defaults) {
  const longEdge = Number(values['kf.resolution'] != null ? values['kf.resolution'] : (defaults['kf.resolution'] || 1536));
  const ratio = String(values['kf.ratio'] || defaults['kf.ratio'] || '16:9');
  const m = /^(\d+)\s*[:*x/]\s*(\d+)$/.exec(ratio.replace(/[×xX]/g, '*'));
  if (!m) return null;
  const rw = Number(m[1]);
  const rh = Number(m[2]);
  if (!rw || !rh) return null;
  const portrait = rh > rw;
  const shortEdge = Math.round(longEdge * Math.min(rw, rh) / Math.max(rw, rh));
  return portrait ? { w: shortEdge, h: longEdge } : { w: longEdge, h: shortEdge };
}

function risks(values = {}, opts = {}) {
  const spec = loadSpec();
  const th = spec.risk_thresholds;
  const defaults = opts.defaults || {};
  const manual = new Set(opts.manualKeys || []);
  const subject = opts.subject || 'unknown';
  const v = (k) => (values[k] != null ? values[k] : defaults[k]);
  const out = [];

  // 1) 分辨率
  const wh = resolutionWH(values, defaults);
  const resStr = wh ? `${wh.w}*${wh.h}` : null;
  const resTouched = manual.has('kf.resolution') || manual.has('kf.ratio')
    || (values['kf.resolution'] != null && values['kf.resolution'] !== defaults['kf.resolution'])
    || (values['kf.ratio'] != null && values['kf.ratio'] !== defaults['kf.ratio']);
  if (resStr && resTouched && !spec.resolutions.includes(resStr)) {
    const r = spec.risk_rules.find((x) => x.id === 'resolution');
    out.push({ ...r, detail: { got: resStr, allowed: spec.resolutions } });
  }

  // 2) 运动幅度
  const motion = Number(v('mo.strength'));
  if (Number.isFinite(motion) && motion > th.motion_max) {
    const r = spec.risk_rules.find((x) => x.id === 'motion');
    out.push({ ...r, detail: { got: motion, stable_max: th.motion_max, recommended: spec.presets.stable['mo.strength'] } });
  }

  // 3) CFG
  const cfg = Number(v('kf.cfg'));
  if (Number.isFinite(cfg) && (cfg < th.cfg_min || cfg > th.cfg_max)) {
    const r = spec.risk_rules.find((x) => x.id === 'cfg');
    out.push({ ...r, detail: { got: cfg, stable: [th.cfg_min, th.cfg_max], recommended: spec.presets.stable['kf.cfg'] } });
  }

  // 4) 采样步数
  const steps = Number(v('kf.steps'));
  if (Number.isFinite(steps) && steps < th.steps_min) {
    const r = spec.risk_rules.find((x) => x.id === 'steps');
    out.push({ ...r, detail: { got: steps, stable_min: th.steps_min, recommended: spec.presets.stable['kf.steps'] } });
  }

  // 5) 多重调色叠加：只数「用户改离默认值」的调色参数，默认配置不算叠加
  const gradeTouched = th.grade_params.filter((k) => values[k] != null && values[k] !== defaults[k]);
  if (gradeTouched.length >= th.grade_stack_count) {
    const r = spec.risk_rules.find((x) => x.id === 'grade_stack');
    out.push({ ...r, detail: { touched: gradeTouched, threshold: th.grade_stack_count } });
  }

  // 6) 关闭人脸模块（仅人像场景提示）
  const faceOff = th.face_params.filter((k) => Number(v(k)) <= 0);
  if (subject === 'portrait' && faceOff.length) {
    const r = spec.risk_rules.find((x) => x.id === 'face_off');
    out.push({ ...r, detail: { zeroed: faceOff, recommended: spec.presets.stable['kf.ipadapter_weight'] } });
  }

  return out;
}

/** 把 muse 与（人像时）portrait 正向词拼成一段；用户已写过的前缀不覆盖。 */
function composePositive(spec, subject, current, manual, mode) {
  const base = String(current == null ? '' : current).trim();
  if (manual || mode === 'expert' || (base && base.includes(spec.prompts.muse_positive.split(',')[0].trim()))) {
    return { text: base, applied: false, reason: manual ? 'user-edited' : mode === 'expert' ? 'expert-mode' : 'already-has-muse' };
  }
  const parts = [spec.prompts.muse_positive];
  if (subject === 'portrait') parts.push(spec.prompts.portrait_positive);
  if (base) parts.push(base);
  return { text: parts.join(', '), applied: true, reason: subject === 'portrait' ? 'muse+portrait' : 'muse-only' };
}

/**
 * 双模式装配。
 * @param {{text?:string, mode?:'novice'|'expert', values?:object, manualKeys?:string[], defaults?:object}} input
 */
function assemble(input = {}) {
  const spec = loadSpec();
  const mode = input.mode === 'expert' ? 'expert' : 'novice';
  const values = { ...(input.values || {}) };
  const defaults = input.defaults || {};
  const manualKeys = new Set(input.manualKeys || []);
  const text = input.text || values['kf.prompt_prefix'] || values['ch.subject'] || '';
  const subj = detectSubject(text);
  const applied = [];
  const skipped = [];

  const setIfFree = (key, val, why) => {
    if (manualKeys.has(key)) { skipped.push({ key, value: values[key], reason: '用户手改，保留', why }); return; }
    // 跨页手改兼容：值已偏离注册表默认（用户在全量面板调过）→ 视为已配置，不再自动覆盖。
    // 手改清单存在页面内存里，换个标签页就丢了；用「偏离默认」当持久信号，比假装清单全局共享可靠。
    const cur = values[key];
    if (cur != null && defaults[key] != null && String(cur) !== String(defaults[key])) {
      skipped.push({ key, value: cur, reason: '已偏离默认值（跨页手改），保留', why });
      return;
    }
    values[key] = val;
    applied.push({ key, value: val, why });
  };

  if (mode === 'novice' && spec.modes.novice.auto_fill) {
    for (const [k, v] of Object.entries(spec.presets.stable)) setIfFree(k, v, 'stable preset');
    if (!manualKeys.has('kf.negative')) {
      if (!values['kf.negative'] || values['kf.negative'] === defaults['kf.negative']) {
        values['kf.negative'] = spec.prompts.negative;
        applied.push({ key: 'kf.negative', value: spec.prompts.negative, why: 'muse negative' });
      } else {
        skipped.push({ key: 'kf.negative', reason: '用户已自定义负面词，保留', why: 'negative' });
      }
    }
    const pos = composePositive(spec, subj.subject, values['kf.prompt_prefix'], manualKeys.has('kf.prompt_prefix'), mode);
    if (pos.applied) { values['kf.prompt_prefix'] = pos.text; applied.push({ key: 'kf.prompt_prefix', value: pos.text, why: pos.reason }); }
    else skipped.push({ key: 'kf.prompt_prefix', reason: pos.reason, why: 'prompt' });
  }

  // 联动：人像开模块 / 风景关模块。开关永远可被用户反向覆盖（手改优先）。
  // 专家模式不执行联动 —— 「取消自动填充，完全交由用户自主调配」是规格原话，
  // 连模块开关都替用户拨好就不叫自主了；风险检测照跑（face_off 就是这么被发现的）。
  const linkage = { subject: subj.subject, enabled: {}, disabled: [], note: '' };
  if (mode === 'expert') {
    linkage.note = `专家模式：不做联动（识别为 ${subj.subject}），人脸模块开关与提示词由你决定。`;
  } else if (subj.subject === 'portrait') {
    for (const [k, v] of Object.entries(spec.linkage.portrait.enable)) {
      if (manualKeys.has(k)) { skipped.push({ key: k, reason: '用户手改，保留', why: 'linkage-portrait' }); continue; }
      values[k] = v;
      linkage.enabled[k] = v;
    }
    linkage.note = spec.linkage.portrait.note;
    const refImgs = Number(values['ch.ref_images'] != null ? values['ch.ref_images'] : (defaults['ch.ref_images'] != null ? defaults['ch.ref_images'] : 0));
    if (refImgs <= 0) {
      linkage.note += '｜注意：ch.ref_images=0，IP-Adapter 没有参考图可锁，定妆一致性不成立。';
    }
  } else if (subj.subject === 'landscape') {
    for (const [k, v] of Object.entries(spec.linkage.landscape.disable)) {
      if (manualKeys.has(k)) { skipped.push({ key: k, reason: '用户手改，保留', why: 'linkage-landscape' }); continue; }
      values[k] = v;
      linkage.disabled.push(k);
    }
    const cur = String(values['kf.prompt_prefix'] || '');
    if (cur.includes(spec.prompts.portrait_positive)) {
      values['kf.prompt_prefix'] = cur.split(spec.prompts.portrait_positive).join('').replace(/,(\s*,)+/g, ',').replace(/,\s*$/, '').trim();
      applied.push({ key: 'kf.prompt_prefix', value: values['kf.prompt_prefix'], why: 'drop portrait words (landscape)' });
    }
    linkage.note = spec.linkage.landscape.note;
  } else {
    linkage.note = '未识别到人物或风景：不追加词、不关模块，交给用户决定。';
  }

  // 角色提取（含脸型场景预设 + preconditions 前置）。只作为 patch 交给前端，不写 values：
  // 写了会破坏「专家模式不填任何值」，而且这些字段必须能显示【AI提取】并可手改。
  // 主体句缺省时用注册表默认整句（它写着「鹅蛋脸」）—— 网红场景必须能把它清掉，
  // 否则 preconditions 只在用户手填 ch.subject 时才生效，等于默认路径永远踩坑。
  const character = characterOf(text, { subject: values['ch.subject'] || defaults['ch.subject'] });
  if (manualKeys.has('ch.face_shape')) character.face_shape.manual_overridable = false;

  const riskList = risks(values, { defaults, manualKeys: [...manualKeys], subject: subj.subject });

  return {
    mode, mode_label: spec.modes[mode].label,
    subject: subj.subject, subject_detail: subj,
    values, applied, skipped, linkage, character, risks: riskList,
    submit_allowed: true,           // 接口层面的「不拦截」承诺：永远允许提交
    risk_count: riskList.length,
    provenance: spec.provenance,
    banner: '💡 智能风险检测已开启：所有参数完全自由自定义，高风险配置仅提示，不限制提交',
  };
}

/* ───────────── 自检 ───────────── */

/**
 * 自检分两层：
 *   global —— ComfyUI 可达 + 基础节点（CheckpointLoaderSimple / KSampler / SaveImage）
 *   face   —— LoRA / IP-Adapter / FaceDetailer 三件套（节点 + 模型文件）
 * face 层缺失 → status='fail'，但 landscape_ok=true：Muse 氛围风景管线不依赖人脸节点。
 *
 * 检查用真接口，不靠猜路径：
 *   · 节点：GET /object_info 的键名（可选注入 opts.objectInfo 便于测试）
 *   · 模型：GET /models/{folder}（ComfyUI 新版接口），拿不到才回退文件系统 exists + path_hint
 */
async function selfCheck(opts = {}) {
  const spec = loadSpec();
  const exists = opts.exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const modelsDir = opts.modelsDir || process.env.COMFY_MODELS_DIR || 'D:\\ComfyUI\\models';
  const shots = spec.selfcheck.shots.map((s) => ({ ...s, status: 'pending', images: [], error: null }));

  let comfy = opts.comfy || null;
  if (!comfy) {
    try {
      const { createComfy } = require('./comfy.js');
      comfy = createComfy({ base: process.env.COMFY_URL || 'http://127.0.0.1:8188' });
    } catch (e) {
      comfy = null;
    }
  }

  let probe = { ok: false, detail: { code: 'COMFY_UNREACHABLE', message: '无法创建 ComfyUI 客户端' } };
  try {
    if (comfy && typeof comfy.ping === 'function') probe = await comfy.ping({ force: true });
  } catch (e) {
    probe = { ok: false, detail: { code: e.code || 'COMFY_UNREACHABLE', message: e.message } };
  }

  const base = { at: new Date().toISOString(), models_dir: modelsDir, shots };
  if (!probe || !probe.ok) {
    return {
      ...base,
      status: 'fail', provenance: 'fail',
      reason: `ComfyUI 不可达（${(probe && probe.detail && (probe.detail.code || probe.detail.message)) || 'COMFY_UNREACHABLE'}）：开源管线没起来，不能标 measured。启动 ComfyUI 后重跑自检。`,
      comfy: probe,
      layers: { global: { ok: false, nodes: [] }, face: { ok: false, nodes: [], models: [] } },
      models: [], missing: [], landscape_ok: false, ran: [],
      report: reportOf(null, shots),
    };
  }

  // 节点表：/object_info 很大，只取键名。注入对象可直接给 { NodeName: {...} } 或数组。
  let nodeKeys = null;
  try {
    const info = opts.objectInfo !== undefined
      ? opts.objectInfo
      : (typeof comfy.objectInfo === 'function' ? await comfy.objectInfo() : null);
    if (info) nodeKeys = Array.isArray(info) ? info : Object.keys(info);
  } catch (e) {
    nodeKeys = null;
  }

  // 模型列表：优先 /models/{folder}，失败回退文件系统。
  async function listModels(folder) {
    if (opts.listModels) return opts.listModels(folder);
    if (typeof comfy.models !== 'function') return null;
    try { return await comfy.models(folder); } catch { return null; }
  }

  const layersSpec = spec.selfcheck.layers || {};
  const nodeCheck = (want) => {
    if (!nodeKeys) return { present: null, reason: '未拿到 /object_info，节点状态未知' };
    const hit = nodeKeys.find((k) => want.some((w) => String(k).toLowerCase() === String(w).toLowerCase()));
    return hit ? { present: true, node: hit } : { present: false, node: null };
  };

  const globalNodes = (layersSpec.global_nodes || []).map((n) => ({ want: n, ...nodeCheck([n]) }));
  const globalOk = globalNodes.every((n) => n.present !== false);

  const models = [];
  for (const m of spec.selfcheck.model_requirements) {
    const nc = nodeCheck(m.node_types || [m.node]);
    let present = false, via = 'unknown';
    const folder = m.folder || (m.slot === 'lora' ? 'loras' : m.slot === 'ipadapter' ? 'ipadapter' : 'custom_nodes');
    const listed = await listModels(folder);
    if (Array.isArray(listed)) {
      via = 'api';
      // 文件名匹配要先归一化：注册表写 ip-adapter-faceid-sdxl，磁盘上是 ip-adapter-faceid_sdxl.bin，
      // 直接 includes 永远 false —— 那不是「模型缺失」，是字符串没对齐。
      const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const cands = [m.name, ...(m.files || []), path.basename(m.path_hint || '')].map(norm).filter(Boolean);
      present = listed.some((f) => {
        const nf = norm(f);
        return nf && cands.some((c) => nf.includes(c) || c.includes(nf));
      });
    } else {
      via = 'fs';
      present = exists(m.path_hint) || exists(path.join(modelsDir, folder, path.basename(m.path_hint)));
    }
    models.push({ ...m, node_present: nc.present, node_hit: nc.node, present, via });
  }
  const missing = models.filter((m) => !m.present);
  const nodeMissing = models.filter((m) => m.node_present === false);
  const faceOk = missing.length === 0 && nodeMissing.length === 0 && globalOk;

  const layers = {
    global: { ok: globalOk, nodes: globalNodes },
    face: { ok: faceOk, nodes: models.map((m) => ({ slot: m.slot, node_present: m.node_present, node_hit: m.node_hit })), models },
  };

  const failReason = !globalOk
    ? `基础节点缺失：${globalNodes.filter((n) => n.present === false).map((n) => n.want).join('、')}（ComfyUI 版本过旧或安装不完整）`
    : (missing.length || nodeMissing.length)
      ? `人脸链路组件缺失：${[...missing.map((m) => `${m.name} → ${m.path_hint}`), ...nodeMissing.map((m) => `节点 ${(m.node_types || []).join('/')}`)].join('；')}｜风景/静物仍可跑（landscape_ok=true）`
      : null;

  let status = 'inferred';
  let reason = '组件齐备但未跑自检：点「跑 4 张测试图」或传 run=true 才会标 measured';
  let ran = [];

  if (failReason) {
    status = 'fail';
    reason = failReason;
  } else if (opts.run === true) {
    if (typeof opts.buildWorkflow !== 'function') {
      status = 'fail';
      reason = '缺少 buildWorkflow(shot)：自检跑图需要工作流编译器（传 opts.buildWorkflow）';
    } else {
      try {
        for (const shot of shots) {
          const wf = opts.buildWorkflow(shot);
          const r = await comfy.prompt(wf);
          const done = typeof comfy.waitFor === 'function' ? await comfy.waitFor(r.prompt_id) : { images: [] };
          const imgs = (done && done.images) || [];
          shot.images = imgs;
          shot.status = imgs.length ? 'done' : 'no_output';
          ran.push({ id: shot.id, prompt_id: r.prompt_id, images: imgs.length });
          if (!imgs.length) throw Object.assign(new Error(`第 ${shot.id} 张没产出图`), { code: 'SELFCHECK_NO_OUTPUT' });
        }
        status = 'measured';
        reason = '4 张测试图全部出图（1K 骨相 ×2 + 1.5K 定妆 ×2）→ 状态 measured';
      } catch (e) {
        status = 'fail';
        reason = `自检跑图失败：${e.code || ''} ${e.message}`;
        shots.forEach((s) => { if (s.status === 'pending') { s.status = 'failed'; s.error = e.code || e.message; } });
      }
    }
  }

  return {
    ...base,
    status, provenance: status, reason, comfy: probe,
    layers, models, missing, node_missing: nodeMissing,
    landscape_ok: globalOk && failReason == null ? true : globalOk,
    ran,
    report: reportOf({ status, models, missing, nodeMissing, shots, opts }, shots),
  };
}

/** 自检报告：模型加载状态（实测）+ 人脸一致性/质感评分（规则代理，不是 VL 评分）。 */
function reportOf(ctx, shots) {
  if (!ctx) return { models_loaded: { ok: false, provenance: 'fail', detail: '未连上 ComfyUI' }, face_consistency: null, texture_score: null };
  const modelsOk = ctx.missing.length === 0 && ctx.nodeMissing.length === 0;
  const doneShots = shots.filter((s) => s.status === 'done');
  // 同组（骨相/定妆）内 seed 一致才算流程一致性；跨组本来就该换 seed，混在一起算会永远 false
  const groups = {};
  shots.forEach((s) => { (groups[s.kind] = groups[s.kind] || []).push(s.seed); });
  const seedSame = Object.values(groups).every((g) => new Set(g).size === 1);
  return {
    models_loaded: {
      ok: modelsOk,
      provenance: 'measured',
      detail: modelsOk ? 'LoRA / IP-Adapter / FaceDetailer 节点与模型均在位' : ctx.missing.map((m) => `${m.name} 缺失`).join('；'),
    },
    face_consistency: {
      value: doneShots.length ? (seedSame ? 1 : 0.5) : null,
      provenance: 'rule-proxy',
      not_visual: true,
      reason: '按「4 张是否同 seed + 参考图路径是否一致」计数，不是视觉比对；要真一致性得用 VL 或人工',
    },
    texture_score: {
      value: doneShots.length ? (modelsOk ? 6.5 : 5.0) : null,
      provenance: 'rule-proxy',
      not_visual: true,
      reason: '按组件齐备度给出的代理分（0–10），不是画质模型评分',
    },
  };
}

module.exports = { loadSpec, detectSubject, sceneOf, detectFaceShape, faceShapeFor, applySubjectPreconditions, characterOf, risks, assemble, selfCheck, resolutionWH };
