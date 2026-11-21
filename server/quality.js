'use strict';

const fs = require('node:fs');
const path = require('node:path');
const SPEC_PATH = path.join(__dirname, '..', 'spec', 'quality.json');
let cache;
function load() { return cache || (cache = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'))); }
function tiers() { return load().resolution_tiers.map((t) => ({ ...t })); }
function tierById(id) { return tiers().find((t) => t.id === id) || null; }
function tierBySize(width, height) { return tiers().find((t) => t.width === Number(width) && t.height === Number(height)) || null; }
function error(code, message, detail = {}) { return Object.assign(new Error(message), { code, status: 422, detail }); }

function vramNeedMib(width, height, frames) {
  const m = load().vram_model;
  const factor = Number(frames) > 0 ? Math.min(1.15, 1 + Math.max(0, Number(frames) - 124) / 1000) : 1;
  return Math.round((m.base_mib + Number(width) * Number(height) / 1e6 * m.mib_per_megapixel) * factor);
}

function sampling(o = {}) {
  const s = load().sampling;
  const adjusted = [];
  const clamp = (key, fallback) => {
    const [lo, hi] = s[key];
    const n = o[key] == null ? fallback : Number(o[key]);
    if (!Number.isFinite(n)) throw error('QUALITY_BAD_SAMPLING', `${key} 必须为有限数值`);
    const value = Math.max(lo, Math.min(hi, key === 'steps' ? Math.round(n) : n));
    if (n !== value) adjusted.push(`${key}=${n} → ${value}（质量区间 ${lo}–${hi}）`);
    return value;
  };
  // 引擎差异（2026-11-20 实测修正）：H3 是音视频联合模型，官方采样路径是 euler/simple、
  // CFG 5–7；硬套通用 DPM++ 2M Karras + CFG 7 会输出整片噪声（8G 真机已验证崩坏）。
  // 所以 sampler/scheduler/CFG 区间都要按 engine_overrides 覆盖；没有覆盖的引擎才用通用值。
  const eng = (load().engine_overrides || {})[o.engine] || null;
  // turbo 是独立参数域（4–8 步 / CFG 1.0–1.6），不能套无损路径的 16–25 步区间
  const turbo = o.turbo === true;
  const stepsRange = turbo ? ((eng && eng.turbo_steps) || [4, 8]) : s.steps;
  const cfgRange = turbo ? ((eng && eng.turbo_cfg) || [1.0, 1.6]) : ((eng && eng.cfg) ? eng.cfg : s.cfg);
  const cfg = Math.max(cfgRange[0], Math.min(cfgRange[1], o.cfg == null ? cfgRange[0] : Number(o.cfg)));
  if (o.cfg != null && Number(o.cfg) !== cfg) adjusted.push(`cfg=${o.cfg} → ${cfg}（${turbo ? 'turbo' : (o.engine || 'default')} 区间 ${cfgRange[0]}–${cfgRange[1]}）`);
  const rawSteps = o.steps == null ? (turbo ? stepsRange[0] : 20) : Number(o.steps);
  // 非法输入必须拒绝（我改成引擎/turbo 双区间后丢了这条校验，selftest 抓到了）
  if (!Number.isFinite(rawSteps)) throw error('QUALITY_BAD_SAMPLING', 'steps 必须为有限数值');
  if (o.cfg != null && !Number.isFinite(Number(o.cfg))) throw error('QUALITY_BAD_SAMPLING', 'cfg 必须为有限数值');
  const steps = Math.max(stepsRange[0], Math.min(stepsRange[1], Math.round(rawSteps)));
  if (Number(rawSteps) !== steps) adjusted.push(`steps=${rawSteps} → ${steps}（${turbo ? 'turbo' : '质量'}区间 ${stepsRange[0]}–${stepsRange[1]}）`);
  const denoise = clamp('denoise', 0.65);
  const sampler = (eng && eng.sampler) ? eng.sampler : s.sampler;
  const scheduler = (eng && eng.scheduler) ? eng.scheduler : s.scheduler;
  for (const key of ['sampler', 'scheduler']) {
    const want = key === 'sampler' ? sampler : scheduler;
    if (o[key] && o[key] !== want) adjusted.push(`${key}=${o[key]} → ${want}（${o.engine || 'default'} 采样路径）`);
  }
  const label = (eng && eng.sampler) ? `${sampler}/${scheduler}（${o.engine} 官方路径）` : s.sampler_label;
  return { steps, cfg, denoise, sampler, scheduler, label, engine: o.engine || null, turbo, adjusted };
}

function fpsPlan(o = {}) {
  const f = load().fps;
  const output = o.output_fps == null ? f.output_default : Number(o.output_fps);
  if (!f.output.includes(output)) throw error('QUALITY_BAD_OUTPUT_FPS', '输出帧率只允许 24、30、60');
  const requested = o.native_fps == null ? (output === 60 ? 30 : output) : Number(o.native_fps);
  if (!f.native.includes(requested)) throw error('QUALITY_BAD_NATIVE_FPS', '原生帧率只允许 24 或 30；60fps 必须由后处理插帧');
  // H3 音视频联合模型按 24fps 训练，不能靠修改容器帧率冒充原生 30fps。
  const native = o.engine === 'minimax_h3' ? 24 : requested;
  if (output < native) throw error('QUALITY_FPS_REDUCTION', '输出帧率不可低于原生帧率');
  return {
    native_fps: native, output_fps: output, needs_interp: output > native,
    interp_target: output > native ? output : null,
    adjusted: native !== requested ? ['H3 原生音画同步固定 24fps'] : [],
    note: output > native ? `原生 ${native}fps → RIFE 插帧 ${output}fps` : `原生 ${native}fps 直出`,
  };
}

function guard(o = {}) {
  const errors = [], warnings = [];
  let tier = null, width = Number(o.width), height = Number(o.height);
  if (o.tier || (o.width == null && o.height == null)) {
    tier = tierById(o.tier || '720p');
    if (!tier) errors.push({ code: 'QUALITY_UNKNOWN_TIER', message: `未知分辨率档位 ${o.tier}`, detail: { tiers: tiers().map((t) => t.id) } });
    else { width = tier.width; height = tier.height; }
  } else tier = tierBySize(width, height);
  const validSize = [width, height].every((v) => Number.isInteger(v) && v > 0 && v % 2 === 0);
  if (!validSize) errors.push({ code: 'QUALITY_BAD_RESOLUTION', message: '宽高必须为正偶数，且必须同时提供', detail: { width, height } });
  const alignment = o.engine === 'minimax_h3' ? 32 : 16;
  const renderWidth = Math.ceil(width / alignment) * alignment;
  const renderHeight = Math.ceil(height / alignment) * alignment;
  const frames = Number(o.frames ?? 124);
  if (!Number.isInteger(frames) || frames < 1) errors.push({ code: 'QUALITY_BAD_FRAMES', message: '帧数必须为正整数' });
  const usable = Number(o.usable_mib) || null;
  const required = validSize ? vramNeedMib(renderWidth, renderHeight, frames) : null;
  if (required && usable && required > usable) errors.push({
    code: 'QUALITY_VRAM_INSUFFICIENT',
    message: `${width}×${height} 预估需 ${required}MiB，设备 ${usable}MiB；不自动降分辨率或减步数`,
    detail: { width, height, frames, required_mib: required, usable_mib: usable, shortfall_mib: required - usable, provenance: 'estimate' },
  });
  if (!usable) warnings.push({ code: 'QUALITY_VRAM_UNKNOWN', message: '显存未探测，需求为估算，不保证可运行' });
  // turbo 不再一票否决（2026-11-20）：它是模型设计内的 4–8 步路径，不是偷工减料。
  // 但仍要锁区间，防止有人用 2 步冒充质量优先。
  if (o.turbo === true || o.lora === true) {
    const _ov = (load().engine_overrides || {}).minimax_h3 || {};
    const ts = _ov.turbo_steps || [4, 8];
    const st = Number(o.steps);
    if (Number.isFinite(st) && (st < ts[0] || st > ts[1])) {
      errors.push({ code: 'QUALITY_TURBO_STEPS_OUT_OF_RANGE', message: `turbo 路径步数必须在 ${ts[0]}–${ts[1]}（当前 ${st}）` });
    }
  }
  return {
    ok: errors.length === 0, mode: load().mode, tier: tier || (validSize ? { id: null, label: `${width}×${height}`, width, height } : null),
    resolution: validSize ? { width, height, megapixels: width * height / 1e6 } : null,
    render_resolution: validSize ? { width: renderWidth, height: renderHeight, crop: renderWidth !== width || renderHeight !== height } : null,
    sampling: sampling(o), fps: fpsPlan(o),
    vram: required ? { required_mib: required, usable_mib: usable, feasible: usable ? required <= usable : null, provenance: 'estimate' } : null,
    errors, warnings, forbid: load().forbid,
  };
}

function assertAllowed(result) {
  if (!result.ok) { const e = result.errors[0]; throw error(e.code, e.message, e.detail); }
  return result;
}

function workflowErrors(workflow) {
  const errors = [];
  for (const [id, node] of Object.entries(workflow || {})) {
    const inputs = node.inputs || {};
    for (const key of ['unet_name', 'clip_name', 'ckpt_name', 'lora_name', 'weight_dtype']) {
      const name = String(inputs[key] || '');
      // turbo/蒸馏权重在 2026-11-20 起按"受限允许"处理：allowed 但步数必须落在 4–8
      // （由下面的 KSampler 校验兜住），任务记录里要标 provenance=turbo。
      if (/(?:distill|lightning|lcm)/i.test(name) && !/turbo/i.test(name)) {
        errors.push({ code: 'QUALITY_SPEED_MODE_FORBIDDEN', message: '禁止 distill/lightning/LCM 极速权重（turbo 需显式声明并锁 4–8 步）', detail: { node: id, field: key, model: name } });
      }
    }
    if (/TeaCache|Nunchaku|SageAttention/i.test(node.class_type || '')) errors.push({ code: 'QUALITY_SPEED_MODE_FORBIDDEN', message: '质量优先禁止加速节点', detail: { node: id } });
    if (/KSampler/.test(node.class_type || '')) {
      // 按引擎 + turbo 判定：H3 无损 16–25 步 / CFG 4–7；H3 turbo 4–8 步 / CFG 1.0–1.6；
      // 其它引擎 DPM++ 2M Karras + 16–25 步 + CFG 7–10。引擎与 turbo 都从工作流自身推断。
      const unet = String(((workflow || {})[Object.keys(workflow || {}).find((k) => /UNETLoader/.test((workflow[k].class_type || ''))) || ''] || {}).inputs?.unet_name || '');
      const isH3 = /minimax_h3/i.test(unet);
      const hasTurboLora = Object.values(workflow || {}).some((n) => /turbo/i.test(String(((n || {}).inputs || {}).lora_name || '')));
      const h3Turbo = isH3 && hasTurboLora;
      const okSamp = isH3
        ? (inputs.sampler_name === 'euler' && inputs.scheduler === 'simple')
        : (inputs.sampler_name === 'dpmpp_2m' && inputs.scheduler === 'karras');
      const stepsLo = h3Turbo ? 4 : 16, stepsHi = h3Turbo ? 8 : 25;
      const cfgLo = h3Turbo ? 1.0 : (isH3 ? 4 : 7), cfgHi = h3Turbo ? 1.6 : (isH3 ? 7 : 10);
      if (!(inputs.steps >= stepsLo && inputs.steps <= stepsHi && inputs.cfg >= cfgLo && inputs.cfg <= cfgHi && inputs.denoise >= 0.55 && inputs.denoise <= 0.75) || !okSamp) {
        errors.push({ code: 'QUALITY_BAD_WORKFLOW_SAMPLING', message: '工作流采样参数不符合约束', detail: { node: id, engine: isH3 ? 'minimax_h3' : 'generic', turbo: h3Turbo, sampler: inputs.sampler_name, scheduler: inputs.scheduler, steps: inputs.steps, steps_range: [stepsLo, stepsHi], cfg: inputs.cfg, cfg_range: [cfgLo, cfgHi] } });
      }
    }
    if (node.class_type === 'CreateVideo' && ![24, 30].includes(inputs.fps)) errors.push({ code: 'QUALITY_BAD_NATIVE_FPS', message: '原生视频必须为 24/30fps', detail: { node: id } });
  }
  return errors;
}
function workflowWarnings(workflow) {
  const warnings = [];
  for (const [id, node] of Object.entries(workflow || {})) {
    for (const field of ['unet_name', 'clip_name', 'ckpt_name', 'vae_name', 'weight_dtype']) {
      const name = String((node.inputs || {})[field] || '');
      if (/(?:int[48]|fp[48]|awq|gguf)/i.test(name)) warnings.push({ code: 'QUALITY_EXISTING_QUANTIZED_WEIGHTS', message: '使用现有量化权重，不自动量化或切换模型；不代表全精度生成', detail: { node: id, field, model: name } });
    }
  }
  return warnings;
}
function assertWorkflow(workflow) { const errors = workflowErrors(workflow); return assertAllowed({ ok: errors.length === 0, errors, warnings: workflowWarnings(workflow) }); }
function scoringWeights() { return { ...load().scoring.weights }; }

module.exports = { load, tiers, tierById, tierBySize, vramNeedMib, sampling, fpsPlan, guard, assertAllowed, workflowErrors, workflowWarnings, assertWorkflow, scoringWeights, SPEC_PATH };
