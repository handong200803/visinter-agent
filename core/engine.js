/**
 * engine.js —— 参数求解器（零依赖，浏览器 / Node 双端同一份）
 *
 * 职责边界：
 *   - 不认识 UI，不认识 ComfyUI，只吃 spec/*.json，吐结构化报告。
 *   - 浏览器侧挂到 window.AVP；Node 侧 module.exports（require 得到同一对象）。
 *
 * 四向预估的口径（重要，别当成实测）：
 *   显存：peak = W_resident + c1·(Mpix·frames) + decode + overhead，再乘参数 vram 影响；
 *         系数在 models.catalog.json 的 vram 段，来源等级见 provenance。
 *   耗时：设计文档 §25/§37 的区间中值做基准秒数，其余为乘性系数（每个系数下面注释了依据）。
 *   质量：参数注册表里的 impact.quality 走进饱和收益曲线（1-e^-2x），过拐点后边际收益递减。
 *   成本：秒数 × 整机功率 × 电价。
 *
 * 为什么不用 eval 直接跑规则：规则文本来自 JSON，属于数据；这里只允许白名单函数与
 * 参数名，遇到可疑 token 直接判失败并回报，不静默执行。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AVP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PREFIX = { ch: 'character', sb: 'storyboard', kf: 'keyframe', mo: 'motion', vo: 'voice', lk: 'look', ex: 'export' };
  const STAGE_PREFIX = { character: 'ch', storyboard: 'sb', keyframe: 'kf', motion: 'mo', voice: 'vo', look: 'lk', export: 'ex' };

  /* ───────────── 基础工具 ───────────── */

  function labelOf(p) {
    return typeof p.label === 'string' ? p.label : (p.label && (p.label.zh || p.label.en)) || p.key;
  }

  function byKey(reg) {
    const m = {};
    for (const p of reg.params) m[p.key] = p;
    return m;
  }

  function defaults(reg) {
    const v = {};
    for (const p of reg.params) v[p.key] = p.default;
    return v;
  }

  function norm(p, value) {
    if (['int', 'float', 'seed'].includes(p.type)) {
      const n = (value - p.min) / (p.max - p.min || 1);
      return Math.max(0, Math.min(1, n));
    }
    if (p.type === 'bool') return value ? 1 : 0;
    if (p.type === 'enum') {
      const i = p.options.indexOf(value);
      return p.options.length > 1 ? Math.max(0, i) / (p.options.length - 1) : 0;
    }
    return 0;
  }

  function coerce(p, value) {
    if (p.type === 'int' || p.type === 'seed') {
      const n = Math.round(Number(value));
      if (!Number.isFinite(n)) return p.default;
      return Math.max(p.min, Math.min(p.max, n));
    }
    if (p.type === 'float') {
      const n = Number(value);
      if (!Number.isFinite(n)) return p.default;
      return Math.max(p.min, Math.min(p.max, n));
    }
    if (p.type === 'bool') return !!value;
    if (p.type === 'enum') return p.options.includes(value) ? value : p.default;
    return value == null ? '' : String(value);
  }

  /* ───────────── 表达式（规则用） ───────────── */

  const BAD = /(;|`|\$\{|\b(window|document|fetch|eval|Function|import|require|process|globalThis|self|top|parent)\b|\bthis\b|=>)/;

  function scopeFor(values, ctx) {
    const s = { ch: {}, sb: {}, kf: {}, mo: {}, vo: {}, lk: {}, ex: {}, ctx: ctx || {} };
    for (const k in values) {
      const [p, a] = k.split('.');
      if (s[p]) s[p][a] = values[k];
    }
    s.character = s.ch; s.storyboard = s.sb; s.keyframe = s.kf;
    s.motion = s.mo; s.voice = s.vo; s.look = s.lk; s.export = s.ex;
    s.shot = { scale: values['sb.shot_scale'], duration: values['mo.duration'] };
    s.max = Math.max; s.min = Math.min; s.round = Math.round; s.abs = Math.abs;
    s.clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    return s;
  }

  const fnCache = new Map();
  function compile(expr) {
    if (fnCache.has(expr)) return fnCache.get(expr);
    if (typeof expr !== 'string' || !expr.trim()) throw new Error('空表达式');
    if (BAD.test(expr)) throw new Error('表达式含非白名单 token：' + expr);
    // eslint-disable-next-line no-new-func
    const fn = new Function('__s', 'with (__s) { return (' + expr + '); }');
    fnCache.set(expr, fn);
    return fn;
  }

  function evalExpr(expr, scope) {
    return compile(expr)(scope);
  }

  /* ───────────── 预设 ───────────── */

  function applyPreset(reg, presetName) {
    const v = defaults(reg);
    const applied = [];
    for (const p of reg.params) {
      if (p.presets && p.presets[presetName] !== undefined) {
        v[p.key] = coerce(p, p.presets[presetName]);
        applied.push(p.key);
      }
    }
    return { values: v, applied };
  }

  /* ───────────── 联动求解 ───────────── */

  function resolve(reg, rulesSpec, inputValues, opts) {
    const map = byKey(reg);
    const values = { ...inputValues };
    const rules = (rulesSpec && rulesSpec.rules) || [];
    const ctx = (opts && opts.ctx) || {};
    const trace = [];
    const warnings = [];
    const autoWritten = {};

    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      const scope = scopeFor(values, ctx);
      for (const r of rules) {
        let hit = false;
        try { hit = !!evalExpr(r.if, scope); } catch (e) {
          trace.push({ id: r.id, error: String(e.message || e) });
          continue;
        }
        if (!hit) continue;

        if (r.then) {
          const m = /^\s*([a-z]+\.[A-Za-z0-9_]+)\s*=(?!=)\s*([\s\S]+)$/.exec(r.then);
          if (!m) { trace.push({ id: r.id, error: 'then 不是赋值形式' }); continue; }
          const target = m[1];
          const p = map[target];
          if (!p) { trace.push({ id: r.id, error: '未知目标 ' + target }); continue; }
          let next;
          try { next = evalExpr(m[2], scope); } catch (e) { trace.push({ id: r.id, error: String(e.message || e) }); continue; }
          next = coerce(p, next);
          if (values[target] !== next) {
            trace.push({ id: r.id, target, from: values[target], to: next, why: r.why || '' });
            values[target] = next;
            autoWritten[target] = r.id;
            changed = true;
          }
        }
        if (r.warn && !warnings.some((w) => w.id === r.id)) {
          warnings.push({ id: r.id, level: r.level || 'gray', text: r.warn, why: r.why || '' });
        }
      }
      if (!changed) break;
    }

    // 注册表自带的参数级护栏
    for (const p of reg.params) {
      if (!p.guards) continue;
      const v = values[p.key];
      for (const g of p.guards) {
        const m = /^\s*(>=|<=|==|!=|>|<)\s*(-?[\d.]+)\s*$/.exec(g.when);
        if (!m) continue;
        const op = m[1], x = parseFloat(m[2]), cur = Number(v);
        const hit = op === '>' ? cur > x : op === '<' ? cur < x : op === '>=' ? cur >= x : op === '<=' ? cur <= x : op === '==' ? cur === x : cur !== x;
        if (hit) warnings.push({ id: 'guard:' + p.key, level: 'gray', text: labelOf(p) + '：' + g.warn, why: g.when });
      }
    }

    return { values, warnings, trace, autoWritten };
  }

  /* ───────────── 显存 / 耗时 / 质量 / 成本 ───────────── */

  function ratioDims(ratio, longEdge) {
    const [a, b] = String(ratio).split(':').map(Number);
    const r = a / b;
    if (r >= 1) return { w: longEdge, h: Math.round((longEdge / r) / 16) * 16 };
    return { w: Math.round((longEdge * r) / 16) * 16, h: longEdge };
  }

  function shortResToHeight(res) {
    const m = /^(\d+)p$/.exec(String(res));
    return m ? Number(m[1]) : 480;
  }

  function residentOf(model, dtype) {
    if (!model || !model.resident_mib) return 0;
    const key = model.resident_mib[dtype] !== undefined ? dtype : Object.keys(model.resident_mib)[0];
    return model.resident_mib[key] || 0;
  }

  function pickModel(catalog, stage, id) {
    const list = (catalog.models && catalog.models[stage]) || [];
    return list.find((m) => m.id === id) || list[0] || null;
  }

  function dtypeOf(catalog, values, stage) {
    if (stage === 'keyframe' && /GGUF/i.test(String(values['kf.model']))) return 'gguf_q4';
    if (stage === 'i2v' && /GGUF/i.test(String(values['mo.i2v_model']))) return 'gguf_q4';
    return values['kf.dtype'] || 'fp8';
  }

  function vramBoost(reg, values, stage) {
    let b = 0;
    for (const p of reg.params) {
      if (p.stage !== stage) continue;
      b += (p.impact.vram || 0) * norm(p, values[p.key]);
    }
    return b;
  }

  function gain(x) {
    // 1 - e^{-2x} 归一化到 0..1：过拐点后边际收益递减，天然表达「32 步以后没意义」
    return (1 - Math.exp(-2 * Math.max(0, x))) / (1 - Math.exp(-2));
  }

  function estimate(reg, catalog, values, opts) {
    const o = opts || {};
    const devices = catalog.devices || [];
    const device = o.device ? devices.find((d) => d.id === o.device) || devices[0] : devices[0];
    const usable = o.usable_mib || device.usable_mib;
    const V = catalog.vram;
    const T = catalog.time;

    const kf = ratioDims(values['kf.ratio'], values['kf.resolution']);
    const kfMpix = (kf.w * kf.h) / 1e6;
    const kfModel = pickModel(catalog, 'keyframe', values['kf.model']);
    const kfDtype = dtypeOf(catalog, values, 'keyframe');
    const wKf = residentOf(kfModel, kfDtype);
    const actKf = V.act_c1_mib_per_mpix_frame * kfMpix;
    const decKf = values['kf.vae_tile'] ? V.dec_tile_mib_per_mpix * (V.tile_pixels / 1e6) : V.dec_full_mib_per_mpix_frame * kfMpix;
    // vram 影响只作用在激活/解码项（权重与开销是常量），并设 35% 上限，避免参数叠加把估算吹上天
    const boostKf = Math.min(0.35, vramBoost(reg, values, 'keyframe'));
    const kfPeak = wKf + (actKf + decKf) * (1 + boostKf) + V.overhead.keyframe;

    // 动效：只有局部 i2v / 粒子需要扩散；视差是纯 2.5D 合成
    const mode = values['mo.mode'];
    const frames = Math.max(1, Math.round(Math.min(values['mo.max_frames'], values['mo.fps'] * values['mo.duration'])));
    let i2vPeak = 0, i2vMpix = 0, i2vModel = null;
    if (mode === '局部i2v' || mode === '粒子') {
      // "480p" 指的是短边（高度），不是长边：先取高度再按比例反推宽度
      const h = shortResToHeight(values['mo.i2v_res']);
      const [rw, rh] = String(values['kf.ratio']).split(':').map(Number);
      const dims = { w: Math.round((h * rw / rh) / 16) * 16, h };
      i2vMpix = (dims.w * dims.h) / 1e6;
      i2vModel = pickModel(catalog, 'i2v', values['mo.i2v_model']);
      const wI2v = residentOf(i2vModel, dtypeOf(catalog, values, 'i2v'));
      const act = V.act_c1_mib_per_mpix_frame * i2vMpix * frames;
      const dec = values['kf.vae_tile'] ? V.dec_tile_mib_per_mpix * (V.tile_pixels / 1e6) : V.dec_full_mib_per_mpix_frame * i2vMpix * frames;
      const boostMo = Math.min(0.35, vramBoost(reg, values, 'motion'));
      i2vPeak = wI2v + (act + dec) * (1 + boostMo) + V.overhead.i2v;
    }

    let voicePeak = 0, voiceModel = null;
    if (values['vo.lipsync']) {
      voiceModel = pickModel(catalog, 'voice', values['vo.lipsync_model']);
      voicePeak = residentOf(voiceModel, values['kf.dtype'] === 'fp16' ? 'fp16' : 'fp8') + V.overhead.voice;
    }

    const stages = [
      { stage: 'keyframe', label: '关键帧', peak_mib: Math.round(kfPeak), weights: Math.round(wKf), act: Math.round(actKf), decode: Math.round(decKf), overhead: V.overhead.keyframe, model: kfModel ? kfModel.id : '-', dtype: kfDtype },
      { stage: 'motion', label: '动效 i2v', peak_mib: Math.round(i2vPeak), weights: i2vModel ? Math.round(residentOf(i2vModel, dtypeOf(catalog, values, 'i2v'))) : 0, act: Math.round(V.act_c1_mib_per_mpix_frame * i2vMpix * frames), decode: Math.round(V.dec_tile_mib_per_mpix * (V.tile_pixels / 1e6)), overhead: V.overhead.i2v, model: i2vModel ? i2vModel.id : '-', dtype: dtypeOf(catalog, values, 'i2v') },
      { stage: 'voice', label: '口型', peak_mib: Math.round(voicePeak), weights: voiceModel ? Math.round(residentOf(voiceModel, values['kf.dtype'] === 'fp16' ? 'fp16' : 'fp8')) : 0, act: 0, decode: 0, overhead: V.overhead.voice, model: voiceModel ? voiceModel.id : '-', dtype: 'fp8' },
    ];
    const peak = Math.max(kfPeak, i2vPeak, voicePeak);
    const ratio = usable ? peak / usable : 0;
    const state = ratio > 1 ? 'block' : ratio > V.safety_ratio ? 'warn' : 'ok';
    const dominant = stages.slice().sort((a, b) => b.peak_mib - a.peak_mib)[0];

    /* 耗时 */
    const stepF = values['kf.steps'] / T.kf_ref_steps;             // 步数线性
    const pixF = Math.pow(kfMpix / (T.kf_ref_pixels / 1e6), 1.15);  // 像素超线性（注意力是平方项，但 VAE 解码是线性，取 1.15 折中）
    const refineF = 1 + (values['kf.refine_scale'] - 1) * 0.6;      // 精修放大：1.5× → +30%
    const modelF = kfModel ? kfModel.t_factor : 1;
    const batchF = values['kf.batch'];
    const anchorF = 1 + values['kf.anchor_count'] * T.kf_anchor_gain; // 每个锚点重跑一次缩水精修
    const kfSec = T.kf_base_sec * stepF * pixF * refineF * modelF * anchorF * batchF;

    let motionSec = 0;
    if (mode === '视差') motionSec = T.parallax_base_sec * (1 + values['mo.parallax_layers'] * 0.15);
    else if (mode === '局部i2v' && i2vModel) {
      const frameF = Math.pow(frames / T.i2v_ref_frames, 1.1);
      motionSec = T.i2v_base_sec * (i2vMpix / (T.i2v_ref_pixels / 1e6)) * frameF * i2vModel.t_factor * (0.6 + values['mo.i2v_strength']);
    } else if (mode === '粒子') motionSec = 4 * (1 + values['mo.particle_count'] / 600);

    const outPixels = values['ex.resolution'] === '4K' ? 8.29e6 : values['ex.resolution'] === '1440p' ? 3.69e6 : values['ex.resolution'] === '720p' ? 0.92e6 : 2.07e6;
    const postSec = T.post_base_sec * (outPixels / 2.07e6) * (values['mo.interp'] ? 1.25 : 1) * (1 + values['lk.deflicker'] / 400);
    const voiceSec = values['vo.lipsync'] ? T.voice_base_sec * (values['vo.voice_clone'] ? 1.25 : 1) : 8;

    const shotSec = kfSec + motionSec + postSec + voiceSec;
    const shots = values['sb.grid_count'];
    const episodeSec = shotSec * shots + T.llm_base_sec * (1 + values['sb.retry'] * 0.5) + T.encode_base_sec;
    const batchSec = episodeSec * values['sb.episode_count'];

    const time = {
      shot_sec: Math.round(shotSec),
      episode_sec: Math.round(episodeSec),
      batch_sec: Math.round(batchSec),
      episode_min: +(episodeSec / 60).toFixed(1),
      batch_min: +(batchSec / 60).toFixed(1),
      breakdown: [
        { key: 'kf', label: '关键帧+锚点', sec: Math.round(kfSec), pct: Math.round((kfSec / shotSec) * 100) },
        { key: 'motion', label: mode === '局部i2v' ? '局部 i2v' : mode, sec: Math.round(motionSec), pct: Math.round((motionSec / shotSec) * 100) },
        { key: 'post', label: '超分/补帧/调色', sec: Math.round(postSec), pct: Math.round((postSec / shotSec) * 100) },
        { key: 'voice', label: '配音/口型', sec: Math.round(voiceSec), pct: Math.round((voiceSec / shotSec) * 100) },
      ],
    };

    /* 质量 */
    let qSum = 0;
    const qTop = [];
    for (const p of reg.params) {
      const q = p.impact.quality || 0;
      if (!q) continue;
      const g = gain(norm(p, values[p.key]));
      const contrib = q * g;
      qSum += contrib;
      qTop.push({ key: p.key, label: labelOf(p), contrib: +contrib.toFixed(3) });
    }
    qTop.sort((a, b) => b.contrib - a.contrib);
    // 归一分母 8.0 由默认参数 qSum≈6.1 → 78 分反解；cinematic 预设约 82–86，draft 约 58–62
    const quality = Math.max(20, Math.min(99, Math.round(38 + 52 * Math.min(1, qSum / 8))));

    /* 成本 */
    const kwhPerSec = (device.watts / 1000) / 3600;
    const cost = {
      shot_yuan: +(shotSec * kwhPerSec * device.price_yuan_per_kwh).toFixed(4),
      episode_yuan: +(episodeSec * kwhPerSec * device.price_yuan_per_kwh).toFixed(4),
      batch_yuan: +(batchSec * kwhPerSec * device.price_yuan_per_kwh).toFixed(3),
      watts: device.watts,
      price: device.price_yuan_per_kwh,
    };

    return {
      device: { id: device.id, name: device.name, usable_mib: usable, vram_total_mib: device.vram_total_mib, provenance: device.provenance },
      vram: { peak_mib: Math.round(peak), usable_mib: usable, ratio: +ratio.toFixed(3), state, safety: V.safety_ratio, headroom_mib: Math.round(usable - peak), dominant: dominant.stage, stages },
      time,
      quality: { score: quality, qSum: +qSum.toFixed(3), top: qTop.slice(0, 6) },
      cost,
      dims: { kf, i2v: i2vMpix ? ratioDims(values['kf.ratio'], shortResToHeight(values['mo.i2v_res'])) : null, frames },
    };
  }

  /* ───────────── 降档建议（红线自动给三套等价方案） ───────────── */

  function degrade(reg, catalog, rulesSpec, values, opts) {
    // 候选方案必须走一遍联动求解再估算，否则规则会把降下来的参数又顶回去（例如分辨率>1024 压低帧数）
    const settle = (v) => (rulesSpec ? resolve(reg, rulesSpec, v, { ctx: (opts && opts.ctx) || {} }).values : v);
    values = settle(values);
    const base = estimate(reg, catalog, values, opts);
    if (base.vram.state === 'ok') return { needed: false, base, options: [] };

    // 三套策略各自逐级加码：每次再降一档，直到进预算或触底（这样红线时给的是真能跑的方案）
    const strategies = [
      {
        label: '降分辨率',
        why: '分辨率是平方项：关键帧与 i2v 一起降一档，省下的是激活与解码两块，后续靠七阶超分回补 1080p',
        step: (v) => {
          const order = ['720p', '576p', '480p', '384p'];
          const i = order.indexOf(v['mo.i2v_res']);
          const nextRes = i >= 0 && i < order.length - 1 ? order[i + 1] : v['mo.i2v_res'];
          return { ...v, 'kf.resolution': Math.max(512, v['kf.resolution'] - 256), 'mo.i2v_res': nextRes };
        },
        floor: (v) => v['kf.resolution'] <= 512 && v['mo.i2v_res'] === '384p',
      },
      {
        label: '降动效开销',
        why: '先把单格时长与帧数砍 20%，仍不够就把动效退到视差（不跑扩散），画面语义不变但少一层运动',
        step: (v) => {
          if (v['mo.duration'] > 0.5) {
            return { ...v, 'mo.duration': Math.max(0.5, +(v['mo.duration'] * 0.8).toFixed(2)), 'mo.max_frames': Math.max(16, Math.round(v['mo.max_frames'] * 0.8)) };
          }
          return { ...v, 'mo.mode': '视差' };
        },
        floor: (v) => v['mo.mode'] === '视差' && v['mo.duration'] <= 0.5,
      },
      {
        label: '换轻模型/精度',
        why: '常驻权重从 Qwen-Image Q4 的 4400MiB 换成 SDXL int4 的 1400MiB，画风与细节上限下降',
        step: (v) => (v['kf.model'] === 'SDXL' && v['kf.dtype'] === 'int4' ? { ...v, 'kf.resolution': Math.max(512, v['kf.resolution'] - 256) } : { ...v, 'kf.model': 'SDXL', 'kf.dtype': 'int4' }),
        floor: (v) => v['kf.model'] === 'SDXL' && v['kf.dtype'] === 'int4' && v['kf.resolution'] <= 512,
      },
    ];

    const options = strategies.map((st) => {
      let v = { ...values };
      let r = estimate(reg, catalog, v, opts);
      let steps = 0;
      while (r.vram.state !== 'ok' && !st.floor(v) && steps < 8) {
        v = settle(st.step(v));
        r = estimate(reg, catalog, v, opts);
        steps++;
      }
      const patch = {};
      for (const k of Object.keys(v)) if (v[k] !== values[k]) patch[k] = v[k];
      return {
        label: st.label,
        why: st.why,
        patch,
        steps,
        report: r,
        deltaQuality: r.quality.score - base.quality.score,
        deltaTimePct: Math.round(((r.time.shot_sec - base.time.shot_sec) / base.time.shot_sec) * 100),
      };
    });

    options.sort((a, b) => (a.report.vram.state === 'ok' ? 0 : 1) - (b.report.vram.state === 'ok' ? 0 : 1) || b.deltaQuality - a.deltaQuality);
    return { needed: true, base, options };
  }

  /* ───────────── 预设导出 / 导入 ───────────── */

  function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    return h.toString(16).padStart(8, '0');
  }

  function exportPreset(reg, values, meta) {
    const map = byKey(reg);
    const out = {};
    for (const k of Object.keys(values).sort()) {
      const p = map[k];
      if (!p || p.derived) continue;
      if (values[k] === p.default) continue;  // 与默认一致的项不入档，预设文件保持最小
      out[k] = values[k];
    }
    const body = JSON.stringify(out);
    return {
      schema: 'ai-video-platform/preset',
      format: 1,
      registry_version: reg.version,
      name: (meta && meta.name) || '未命名预设',
      author: (meta && meta.author) || '',
      device: (meta && meta.device) || '',
      created: new Date().toISOString(),
      checksum: 'djb2:' + djb2(body),
      values: out,
    };
  }

  function importPreset(reg, preset) {
    if (!preset || preset.schema !== 'ai-video-platform/preset') throw new Error('不是本平台的预设文件');
    if (preset.registry_version !== reg.version) throw new Error('注册表版本不匹配：文件 ' + preset.registry_version + ' / 当前 ' + reg.version);
    const map = byKey(reg);
    const values = defaults(reg);
    const unknown = [];
    for (const k in preset.values) {
      if (!map[k]) { unknown.push(k); continue; }
      values[k] = coerce(map[k], preset.values[k]);
    }
    const body = JSON.stringify(Object.keys(preset.values).sort().reduce((acc, k) => (acc[k] = preset.values[k], acc), {}));
    const ok = preset.checksum === 'djb2:' + djb2(body);
    return { values, unknown, checksum_ok: ok };
  }

  /* ───────────── 导出 ───────────── */

  return {
    PREFIX, STAGE_PREFIX,
    defaults, byKey, coerce, norm,
    applyPreset, resolve, estimate, degrade,
    exportPreset, importPreset,
    _internal: { evalExpr, scopeFor, ratioDims, gain, djb2 },
  };
});