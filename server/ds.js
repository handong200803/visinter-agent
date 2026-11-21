/**
 * ds.js —— DashScope（通义万相）请求编译器：参数值 → 视频生成 API 请求体（任务卡②）
 *
 * 与 wf.js（ComfyUI 图编译）并列的第二条编译通路。口径一致：
 *   - 绑定来自注册表 bind_ds 字段（真源在 tools/gen_registry.mjs），不许在这里编字段；
 *   - 没绑定的参数全部进 unbound[] 如实上报，静默丢弃比报错更危险；
 *   - 值域夹紧（如 mo.duration 0.5–3s → API 2–15s）必须留 warning，不悄悄发生。
 *
 * 提示词不是拼字符串：走 prompt/compose.js 的槽位编译（主体/ appearance/光线/镜头…），
 * 与 Muse 九段式同构；bind_ds 标 input.prompt 的参数是"经编译器消费"的间接绑定，
 * applied 里 note:'prompt-compile' 标明路径，和直接写 API 字段区分开。
 *
 * 模型协议差异（实测文档口径，见 docs/02-backend.md）：
 *   wan2.2 系：parameters.size="宽*高" + duration；
 *   wan2.7 系：parameters.resolution="720P"/"1080P" + ratio。
 * 模型选择是 provider 层配置（AVP_DS_MODEL / job.model），不占注册表参数位。
 */
'use strict';

const path = require('node:path');
const { compile: composePrompt } = require('../prompt/compose.js');

class DsError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail || {}; }
}

/**
 * 模型能力表 —— 2026-11-18 清空。
 * 用户要求「把所有收钱的视频模型删除」：DashScope 的 wan2.2-t2v-plus / wan2.2-t2v-flash /
 * wan2.7-t2v（按量计费）全部下线，provider 也不再有 dashscope 这个选项。
 * 这里保留空表而不是删文件，是为了让所有引用方拿到确定的错误码 DS_PAID_MODEL_REMOVED，
 * 而不是 Cannot read properties of undefined。本地免费通道（ComfyUI / mock）不受影响。
 */
const MODEL_CAPS = {};
const DEFAULT_MODEL = '';

/** 720P 档各宽高比的输出像素（万相2.7文档表格；wan2.2 的 16:9/9:16 与实测 ledger 一致）。 */
/** wan2.2 视频合法 size 白名单（云端实测报错口径，逐字）。提交前强制校验/就近映射。 */
const VIDEO_SIZE_WHITELIST = ['1080*1920', '1920*1080', '1440*1440', '1632*1248', '1248*1632', '480*832', '832*480', '624*624'];
/** 本地 ComfyUI 图像分辨率表（仅本地，禁止直接传云端）。 */
const LOCAL_IMAGE_SIZES = ['1024*1536', '1536*1024', '1024*1280', '768*1024', '1024*1024', '1280*720', '720*1280'];
const SIZE_HIGH = { '16:9': '1920*1080', '9:16': '1080*1920', '1:1': '1440*1440', '4:3': '1632*1248', '3:4': '1248*1632' };
const SIZE_LOW = { '16:9': '832*480', '9:16': '480*832', '1:1': '624*624', '4:3': '1632*1248', '3:4': '1248*1632' };
const aspectOf = (s) => { const [w, h] = String(s).split('*').map(Number); return w / h; };
const ratioAspect = (r) => { const m = String(r).match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/); if (m) return Number(m[1]) / Number(m[2]); const a = aspectOf(r); return Number.isFinite(a) ? a : 16 / 9; };
/** 分辨率白名单校验 + 按画幅就近映射到合法档位（显存不足降低清档）。返回 {size, original, tier, mapped, note}。 */
function mapVideoSize({ ratio = '16:9', res = '1080p', device } = {}) {
  const lowTier = res === '720p' || device === 'T0-low';
  const table = lowTier ? SIZE_LOW : SIZE_HIGH;
  const target = ratioAspect(ratio);
  let size = table[ratio];
  let note = null;
  if (!size) {
    // 比例不在表内（2:3/3:2/2.35:1 等）→ 全白名单按_aspect 就近
    let best = null, bestD = Infinity;
    for (const s of VIDEO_SIZE_WHITELIST) {
      const d = Math.abs(Math.log(aspectOf(s) / target));
      const tierPenalty = lowTier && aspectOf(s) > 1000 / 1920 * 1.5 ? 0.5 : 0; // 低清档优先小尺寸
      if (d + tierPenalty < bestD) { bestD = d + tierPenalty; best = s; }
    }
    size = best; note = `比例 ${ratio} 无直配档位，按画幅就近映射`;
  }
  if (!VIDEO_SIZE_WHITELIST.includes(size)) { size = '1920*1080'; note = (note || '') + '；兜底 1920*1080'; }
  return { size, original: `${ratio}@${res}`, tier: lowTier ? 'low' : 'high', mapped: !!note, note };
}
/** 提交前 dry-run 预检（不打云端）：size 白名单 / 模型 / 必填 / 区间。返回 errors[]。 */
function validateDsRequest(request, model) {
  if (!Object.keys(MODEL_CAPS).length) return [{ key: 'model', got: model, legal: '付费视频模型已全部移除（只剩本地 ComfyUI / mock）' }];
  const caps = capsFor(model);
  const errors = [];
  const p = request.parameters || {};
  if (!request.input || !String(request.input.prompt || '').trim()) errors.push({ key: 'input.prompt', got: request.input && request.input.prompt, legal: '非空提示词' });
  if (!MODEL_CAPS[model]) errors.push({ key: 'model', got: model, legal: Object.keys(MODEL_CAPS).join('/') });
  if (caps.protocol === 'size') {
    if (!VIDEO_SIZE_WHITELIST.includes(p.size)) errors.push({ key: 'parameters.size', got: p.size, legal: VIDEO_SIZE_WHITELIST.join(',') });
  } else if (!['720P', '1080P'].includes(p.resolution)) {
    errors.push({ key: 'parameters.resolution', got: p.resolution, legal: '720P/1080P' });
  }
  const dur = Number(p.duration);
  // durations 有两种口径：枚举（wan2.2 只有 5s）与区间（wan2.7 是 2–15s）。
  // 之前一律 includes()，把 2–15 当枚举，3s/10s 全被判非法——这是真 bug，不是用户参数错。
  const durOk = Number.isFinite(dur) && (caps.durations.length === 2 && caps.durations[1] > caps.durations[0]
    ? dur >= caps.durations[0] && dur <= caps.durations[1]
    : caps.durations.includes(dur));
  if (!durOk) errors.push({ key: 'parameters.duration', got: p.duration, legal: (caps.durations.length === 2 && caps.durations[1] > caps.durations[0] ? caps.durations[0] + '–' + caps.durations[1] : caps.durations.join('/')) + '（秒）' });
  return errors;
}

function capsFor(model) {
  return MODEL_CAPS[model] || null;
}

function normBindDs(p) {
  const b = p.bind_ds;
  if (!b || typeof b.path !== 'string' || !b.path.trim()) return { ok: false, path: '' };
  return { ok: true, path: b.path.trim() };
}

/** 按点路径写值：'parameters.seed' → obj.parameters.seed。 */
function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * compileDsRequest(values, {registry, model, note})
 * 返回 { model, request, applied, unbound, warnings, stats, prompt }。
 * request 即 POST video-synthesis 的 body（不含鉴权头）。
 */
function compileDsRequest(values = {}, opts = {}) {
  if (!Object.keys(MODEL_CAPS).length) {
    throw new DsError('DS_PAID_MODEL_REMOVED', '付费视频模型已全部移除：DashScope（wan2.2 / wan2.7）通道不可用，请改用本地 ComfyUI 或 mock', { models: [] });
  }
  const reg = opts.registry || loadRegistry();
  const model = String(opts.model || process.env.AVP_DS_MODEL || DEFAULT_MODEL);
  const caps = capsFor(model);
  const warnings = [];
  if (!MODEL_CAPS[model]) warnings.push({ code: 'DS_MODEL_UNKNOWN', text: `模型 ${model} 不在能力表，按 wan2.2 协议推断（provenance: estimate）` });

  const request = { model, input: {}, parameters: {} };
  const applied = [], unbound = [];
  const vals = { ...values };

  // 1) 提示词：槽位编译器消费全部入参（motion 阶段含镜头语言），间接绑定在这里兑现。
  let composed = null;
  let positive = '';
  if (opts.rawPrompt && opts.note && String(opts.note).trim()) {
    // raw 模式：长镜头脚本不适合槽位编译（时间轴叙述会被拆散，主体槽还会凭空造人）。
    // 显式开关，不静默：调用方必须知道"这条请求没走编译器"。
    positive = String(opts.note).trim();
    warnings.push({ code: 'DS_RAW_PROMPT', text: 'raw 模式：未走槽位编译，prompt 逐字来自 note' });
  } else {
    composed = composePrompt(vals, { stage: 'motion' });
    positive = composed.positive_zh || composed.positive || '';
    if (opts.note && String(opts.note).trim()) positive += '。' + String(opts.note).trim();
  }
  if (!positive.trim()) throw new DsError('DS_EMPTY_PROMPT', '提示词为空：至少填 ch.subject（主体描述）', {});
  if (positive.length > 5000) {
    warnings.push({ code: 'DS_PROMPT_TRUNCATED', text: `提示词 ${positive.length} 字符超过 5000 上限，截断保留前 5000` });
    positive = positive.slice(0, 5000);
  }
  request.input.prompt = positive;
  // 水印：云端默认会打「AI 生成」角标；成片需要干净画面时关掉（模型不支持会 400，由调用方如实上报）
  if (opts.watermark !== undefined) request.parameters.watermark = !!opts.watermark;
  // raw 模式没有 compiler 产物：negative 只能来自调用方显式传的 opts.negative
  const negative = String((composed && composed.negative) || opts.negative || '').slice(0, 500);
  if (negative) request.input.negative_prompt = negative;
  for (const w of (composed && composed.warnings) || []) {
    if (w.level === 'red') warnings.push({ code: 'DS_PROMPT_RED', text: w.msg, keys: w.keys });
  }

  // 2) 逐参数落位：直接绑定写 API 字段；input.prompt 间接绑定记 note。
  for (const p of reg.params) {
    const b = normBindDs(p);
    const has = Object.prototype.hasOwnProperty.call(vals, p.key);
    if (!b.ok) {
      unbound.push({ key: p.key, stage: p.stage, reason: 'NO_BIND_DS', hadValue: has });
      continue;
    }
    const v = has ? vals[p.key] : p.default;
    if (b.path === 'input.prompt' || b.path === 'input.negative_prompt') {
      applied.push({ key: p.key, path: b.path, value: v, note: 'prompt-compile' });
      continue;
    }
    let out = v;
    if (b.path === 'parameters.duration') {
      const [lo, hi] = caps.durations.length === 2 ? caps.durations : [caps.durations[0], caps.durations[0]];
      const n = Math.round(Number(v));
      out = Math.min(hi, Math.max(lo, n));
      if (out !== n) warnings.push({ code: 'DS_DURATION_CLAMPED', text: `${p.key}=${v}s 超出 ${model} 支持范围 [${lo},${hi}]s，夹到 ${out}s`, key: p.key });
    } else if (b.path === 'parameters.seed') {
      const n = Number(v);
      if (n < 0) { applied.push({ key: p.key, path: b.path, value: v, note: 'random(-1 不传 seed)' }); continue; }
      out = Math.min(2147483647, Math.max(0, Math.round(n)));
    } else if (b.path === 'parameters.size' || b.path === 'parameters.resolution' || b.path === 'parameters.ratio') {
      continue; // 分辨率/宽高比在下面按模型协议合成，不逐字段写
    } else if (p.type === 'bool') {
      out = !!v;
    }
    setPath(request, b.path, out);
    applied.push({ key: p.key, path: b.path, value: out });
  }

  // 3) 分辨率 × 宽高比 → 按模型协议合成（ex.resolution / kf.ratio 两个参数共同决定）。
  const resRaw = String(vals['ex.resolution'] || '1080p');
  const ratioRaw = String(vals['kf.ratio'] || '16:9');
  let res = resRaw.toLowerCase();
  if (!caps.resolutions.includes(res)) {
    const fallback = '1080p';
    warnings.push({ code: 'DS_RESOLUTION_CLAMPED', text: `ex.resolution=${resRaw} 超出 ${model} 支持档位（${caps.resolutions.join('/')}），夹到 ${fallback}；更高分辨率走后期超分`, key: 'ex.resolution' });
    res = fallback;
  }
  let ratio = ratioRaw;
  const known = ['16:9', '9:16', '1:1', '4:3', '3:4'];
  if (!known.includes(ratio)) {
    warnings.push({ code: 'DS_RATIO_FALLBACK', text: `kf.ratio=${ratioRaw} 不在直配列表，按画幅就近映射到合法档位（2.35:1 等电影幅面走后期裁切）`, key: 'kf.ratio' });
  }
  if (caps.protocol === 'resolution') {
    request.parameters.resolution = res === '720p' ? '720P' : '1080P';
    request.parameters.ratio = known.includes(ratio) ? ratio : '16:9';
  } else {
    const m = mapVideoSize({ ratio, res, device: opts.device });
    request.parameters.size = m.size;
    if (m.mapped || m.original !== `${ratio}@${res}`) warnings.push({ code: 'DS_SIZE_MAPPED', text: `分辨率映射：${m.original} → ${m.size}（${m.tier} 档）${m.note ? '· ' + m.note : ''}`, key: 'parameters.size', original: m.original, mapped: m.size, tier: m.tier });
  }
  applied.push({ key: 'ex.resolution', path: caps.protocol === 'resolution' ? 'parameters.resolution' : 'parameters.size', value: res, note: 'composed-with-ratio' });
  applied.push({ key: 'kf.ratio', path: caps.protocol === 'resolution' ? 'parameters.ratio' : 'parameters.size', value: ratio, note: 'composed-with-resolution' });

  // 4) 智能改写：千问多模态对短提示词扩写（默认开；provider/job 可关）。
  const extend = opts.promptExtend == null ? true : !!opts.promptExtend;
  request.parameters.prompt_extend = extend;

  const boundCount = reg.params.filter((p) => normBindDs(p).ok).length;
  const stats = { params: reg.params.length, bound_ds: boundCount, applied: applied.length, unbound: unbound.length, model, protocol: caps.protocol, provenance: caps.provenance };
  if (unbound.length) warnings.push({ code: 'DS_UNBOUND', text: `${stats.unbound} 个参数没有落到 DashScope 请求（注册表缺 bind_ds），见 unbound[]` });
  return { model, request, applied, unbound, warnings, stats, prompt: { positive, negative, warnings: (composed && composed.warnings) || [] } };
}

let _reg = null;
function loadRegistry() {
  if (_reg) return _reg;
  const fs = require('node:fs');
  _reg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'params.registry.json'), 'utf8'));
  return _reg;
}

module.exports = { compileDsRequest, capsFor, MODEL_CAPS, DEFAULT_MODEL, DsError, normBindDs, VIDEO_SIZE_WHITELIST, LOCAL_IMAGE_SIZES, mapVideoSize, validateDsRequest };