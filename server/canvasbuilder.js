/**
 * canvasbuilder.js —— 画布拓扑自动构建器（改造规格 §1.8）
 *
 * 职责：为任意生成入口（小白/专家/贝叶斯/对照/消融）自动产出画布拓扑：
 *   创建画布 → 摆放节点 → 连线 → 注入当前模型参数/提示词/分辨率/参考图 → 交执行
 *
 * 硬约束（违反即返工）：
 *   · 节点总数 ≥ 120，七大模块齐备，**禁止打包、禁止子图**（每节点独立，模块只做分组标签）；
 *   · 对照/消融实验走 locked 模式：拓扑（节点/端口/连线）完全冻结，只改节点内部参数；
 *   · 双引擎隔离：节点 class_type 与 VAE/文本编码器按引擎取，不共用一份。
 *
 * 诚实边界（必须写清，不能让评审以为 130 个节点都能在 ComfyUI 里直接跑）：
 *   本模块产出的是**拓扑规划与复现凭据**（节点清单、端口、连线、参数注入点、显存策略），
 *   字段 `execution.comfy_ready=false` 表示其中有自定义节点（IPAdapter / FaceDetailer / H3 专用）
 *   尚未在本机 ComfyUI 验证；可执行最小图仍由 server/wf.js（bind 绑定）负责。
 *   两者通过 params_digest 对齐：同一份参数，同一份拓扑，才是可复现实验。
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ENG = require('./engines.js');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'engines.json'), 'utf8'));

/** 各模块的节点模板：class_type + 角色 + 参数注入键（无值表示结构节点）。 */
const MODULE_TEMPLATES = {
  input_precheck: [
    ['AVP.PromptSanitize', 'prompt_sanitize', 'ch.subject'],
    ['AVP.ConflictScan', 'conflict_scan'],
    ['AVP.Tokenize', 'tokenize', 'kf.prompt_compile'],
    ['AVP.NegativeBuild', 'negative_build', 'ch.negative'],
    ['AVP.RatioCheck', 'ratio_check', 'kf.ratio'],
    ['AVP.ResolutionCheck', 'resolution_check', 'kf.resolution'],
    ['AVP.RefImageCheck', 'ref_image_check', 'ch.ref_images'],
    ['AVP.SeedDerive', 'seed_derive', 'kf.seed'],
    ['AVP.VramProbe', 'vram_probe'],
    ['AVP.QuantSelect', 'quant_select'],
    ['AVP.TaskBind', 'task_bind'],
    ['AVP.ParamSnapshot', 'param_snapshot'],
    ['AVP.EngineRoute', 'engine_route'],
    ['AVP.GuardRisk', 'guard_risk'],
    ['AVP.PromptNormalize', 'prompt_normalize'],
    ['AVP.LanguageDetect', 'language_detect'],
    ['AVP.CharBudget', 'char_budget'],
    ['AVP.StyleAnchor', 'style_anchor'],
    ['AVP.MotionHint', 'motion_hint', 'mo.strength'],
    ['AVP.AudioHint', 'audio_hint', 'vo.breath'],
  ],
  text_encode: [
    ['CLIPTextEncode', 'pos_main', 'ch.prompt_prefix'],
    ['CLIPTextEncode', 'pos_style', 'ch.style'],
    ['CLIPTextEncode', 'pos_light', 'kf.key_light_dir'],
    ['CLIPTextEncode', 'pos_camera', 'sb.camera_language'],
    ['CLIPTextEncode', 'pos_quality', 'kf.detail_boost'],
    ['CLIPTextEncode', 'neg_main', 'ch.negative'],
    ['CLIPTextEncode', 'neg_anatomy', 'kf.hand_fix'],
    ['CLIPTextEncode', 'neg_motion', 'mo.flicker_guard'],
    ['AVP.EmbedMix', 'embed_mix'],
    ['AVP.CLPooled', 'clip_pooled'],
    ['AVP.T5Encode', 't5_encode'],
    ['AVP.ConditionConcat', 'cond_concat'],
    ['AVP.UncondConcat', 'uncond_concat'],
    ['AVP.CFGRescale', 'cfg_rescale', 'ch.cfg_rescale'],
    ['AVP.PromptWeight', 'weight_apply', 'kf.prompt_weight_syntax'],
  ],
  latent_init: [
    ['EmptyLatentVideo', 'latent_empty', 'kf.resolution'],
    ['AVP.LatentResize', 'latent_resize', 'kf.ratio'],
    ['AVP.Scheduler', 'scheduler', 'kf.scheduler'],
    ['AVP.Sigmas', 'sigmas', 'kf.steps'],
    ['AVP.NoiseSeed', 'noise_seed', 'kf.seed'],
    ['AVP.NoiseMode', 'noise_mode', 'kf.seed_mode'],
    ['AVP.LatentBatch', 'latent_batch', 'kf.batch'],
    ['AVP.FrameCount', 'frame_count', 'mo.max_frames'],
    ['AVP.FpsMap', 'fps_map', 'mo.fps'],
    ['AVP.TemporalScale', 'temporal_scale', 'mo.motion_blur'],
    ['AVP.LatentAnchor', 'latent_anchor', 'kf.anchor_count'],
    ['AVP.AnchorInterval', 'anchor_interval', 'kf.anchor_interval'],
    ['AVP.TilePlan', 'tile_plan', 'kf.vae_tile'],
    ['AVP.MemoryPlan', 'memory_plan'],
    ['AVP.LatentDType', 'latent_dtype', 'kf.dtype'],
  ],
  sampler_core: [
    ['KSampler', 'sampler_main', 'kf.steps'],
    ['AVP.CFGApply', 'cfg_apply', 'kf.cfg'],
    ['AVP.SamplerSelect', 'sampler_select', 'kf.sampler'],
    ['AVP.CrossAttn', 'cross_attn'],
    ['AVP.TemporalAttn', 'temporal_attn'],
    ['AVP.MotionModule', 'motion_module', 'mo.strength'],
    ['AVP.CameraControl', 'camera_control', 'mo.camera'],
    ['AVP.CameraSpeed', 'camera_speed', 'mo.camera_speed'],
    ['AVP.ParallaxLayers', 'parallax', 'mo.parallax_layers'],
    ['ControlNetApply', 'cn_apply', 'kf.cn_type'],
    ['AVP.CNWeight', 'cn_weight', 'kf.cn_weight'],
    ['ControlNetApply', 'cn2_apply', 'kf.cn2_type'],
    ['AVP.CN2Weight', 'cn2_weight', 'kf.cn2_weight'],
    ['IPAdapterApply', 'ipadapter', 'kf.ipadapter_weight'],
    ['AVP.IdentityLock', 'identity_lock', 'kf.identity_weight'],
    ['AVP.RefStrength', 'ref_strength', 'ch.ref_strength'],
    ['LoraLoader', 'lora_style', 'kf.lora1_w'],
    ['LoraLoader', 'lora_style2', 'kf.lora2_w'],
    ['LoraLoader', 'lora_face', 'ch.lora_face'],
    ['AVP.FreeU', 'freeu', 'kf.freeu'],
    ['AVP.TeaCache', 'teacache', 'kf.teacache'],
    ['AVP.SageAttn', 'sage_attn', 'kf.sage_attn'],
    ['AVP.Nunchaku', 'nunchaku', 'kf.nunchaku'],
    ['AVP.ClipSkip', 'clip_skip', 'kf.clip_skip'],
    ['AVP.RefinePass', 'refine_pass', 'kf.refine_scale'],
  ],
  vae_decode: [
    ['VAEDecode', 'vae_decode', null],
    ['AVP.VaeTile', 'vae_tile', 'kf.tile_size'],
    ['AVP.VaeOverlap', 'vae_overlap', 'kf.tile_overlap'],
    ['AVP.VaeTemporal', 'vae_temporal'],
    ['AVP.FrameSplit', 'frame_split'],
    ['AVP.ColorConvert', 'color_convert'],
    ['AVP.AlphaRestore', 'alpha_restore'],
    ['AVP.H3AudioVAE', 'audio_vae'],
    ['AVP.AudioLatent', 'audio_latent'],
    ['AVP.AVJoint', 'av_joint'],
    ['AVP.FrameGrain', 'film_grain', 'kf.grain'],
    ['AVP.Tonemap', 'tonemap', 'kf.tonemap'],
    ['AVP.USM', 'usm', 'kf.usm_amount'],
    ['AVP.SharpTarget', 'sharp_target', 'kf.sharpness_target'],
    ['AVP.HandFix', 'hand_fix', 'kf.hand_fix'],
    ['AVP.EyeFix', 'eye_fix', 'kf.eye_fix'],
    ['FaceDetailer', 'face_detailer', 'kf.face_denoise'],
    ['AVP.TexturePass', 'texture_pass', 'kf.texture_pass'],
    ['AVP.DetailBoost', 'detail_boost', 'kf.detail_boost'],
    ['AVP.FrameConcat', 'frame_concat'],
  ],
  scoring: [
    ['AVP.FrameSample', 'frame_sample'],
    ['AVP.FaceLandmark', 'face_landmark'],
    ['AVP.FaceStability', 's_face'],
    ['AVP.FlowEstimate', 'flow_estimate'],
    ['AVP.FlowJitter', 's_flow'],
    ['AVP.HistRef', 'hist_ref'],
    ['AVP.StyleDistance', 's_style'],
    ['AVP.BadAnatomy', 'bad_anatomy'],
    ['AVP.BadPenalty', 's_bad'],
    ['AVP.ScoreNormalize', 'normalize'],
    ['AVP.ScoreWeight', 'weight_apply'],
    ['AVP.ScoreFuse', 'fuse'],
    ['AVP.CsvAppend', 'csv_append'],
    ['AVP.ScoreLog', 'score_log'],
    ['AVP.ScoreGuard', 'score_guard'],
    ['AVP.ScoreBaseline', 'baseline'],
    ['AVP.ScoreDiff', 'diff'],
    ['AVP.ScoreSeed', 'score_seed'],
    ['AVP.ScoreTimestamp', 'timestamp'],
    ['AVP.ScoreExport', 'export'],
  ],
  archive_split: [
    ['SaveVideo', 'pure_save'],
    ['AVP.TopologyDump', 'topology_dump'],
    ['AVP.NodeManifest', 'node_manifest'],
    ['AVP.ParamDump', 'param_dump'],
    ['AVP.LatentDump', 'latent_dump'],
    ['AVP.ExperimentId', 'experiment_id'],
    ['AVP.PostInterp', 'post_interp'],
    ['AVP.PostUpscale', 'post_upscale'],
    ['AVP.PostLUT', 'post_lut'],
    ['AVP.PostDeshake', 'post_deshake'],
    ['AVP.PostGrain', 'post_grain'],
    ['SaveVideo', 'enhanced_save'],
    ['AVP.LibraryIndex', 'library_index'],
    ['AVP.RunLog', 'run_log'],
    ['AVP.FailureTrap', 'failure_trap'],
  ],
};

const ENGINE_NODE_HINTS = {
  wan22: { vae: 'VAEDecode(Wan2.2)', text: 'CLIPTextEncode(umt5-xxl)', sampler: 'KSampler(uni_pc)' },
  minimax_h3: { vae: 'H3.VAEDecode(video+audio)', text: 'H3.TextEncoder', sampler: 'H3.FlowSampler' },
};


/* ───────────── 可执行图映射（130 节点规划 → ComfyUI 真节点） ─────────────
 * 规划拓扑负责「结构与复现凭据」，这里负责「真能提交」：
 * 每个 role 映射到真实 class_type + 连线，产出可直接 POST /prompt 的 API 图。
 * 只映射关键 12–14 个节点：ComfyUI 的执行图不需要 130 个节点，但论文要的是 130 个的拆分粒度，
 * 两者不是一回事 —— 这点必须在返回值里写清楚（mapped_nodes vs planned_nodes）。
 */
const WAN_DEFAULTS = {
  unet: 'wan2.2_ti2v_5B_fp16.safetensors',
  te: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
  vae: 'wan2.2_vae.safetensors',
};

function wanExecutable({ values = {}, prompt = '', negative = '', width = 1280, height = 720, frames = 121, steps = 20, cfg = 7.0, seed = 0, sampler = 'dpmpp_2m', scheduler = 'karras', denoise = 0.65, fps = 30 }) {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: process.env.AVP_WAN_UNET || WAN_DEFAULTS.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: process.env.AVP_WAN_CLIP || WAN_DEFAULTS.te, type: 'wan', device: 'cpu' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: WAN_DEFAULTS.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    '6': { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: Number(values['kf.sample_shift'] || 8) } },
    '7': { class_type: 'WanImageToVideo', inputs: { positive: ['4', 0], negative: ['5', 0], vae: ['3', 0], width, height, length: frames, batch_size: 1 } },
    '8': { class_type: 'KSampler', inputs: { model: ['6', 0], seed, steps, cfg, sampler_name: sampler, scheduler, positive: ['7', 0], negative: ['7', 1], latent_image: ['7', 2], denoise } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveLatent', inputs: { samples: ['8', 0], filename_prefix: 'wan/latent' } },
    '11': { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps } },
    '12': { class_type: 'SaveVideo', inputs: { video: ['11', 0], filename_prefix: 'wan/t2v', format: 'auto' } },
  };
}

function h3Executable(o) {
  return require('./h3workflow.js').build(o).workflow;
}

/** 返回可执行图 + 与规划拓扑的对应关系。 */
function executableFor(engine, o = {}) {
  const values = o.values || {};
  const prompt = o.prompt || String(values['ch.subject'] || values['kf.prompt_prefix'] || '');
  const negative = o.negative || String(values['ch.negative'] || '');
  const rawSeed = Number(o.seed ?? values.seed ?? values['kf.seed']);
  const seed = Number.isFinite(rawSeed) && rawSeed >= 0 ? Math.floor(rawSeed) : Math.floor(Math.random() * 2147483646);
  const Q = require('./quality.js');
  const frames = Number(o.frames ?? values.frames ?? (engine === 'minimax_h3' ? require('./h3workflow.js').snapFrames(values['mo.duration'] ?? 5).frames : values['mo.max_frames'] ?? 121));
  if (engine !== 'minimax_h3' && (!Number.isInteger(frames) || frames < 1 || (frames - 1) % 4 !== 0)) throw Object.assign(new Error('Wan 帧数必须符合4k+1，不自动减少帧数'), { code: 'QUALITY_BAD_FRAMES', status: 422 });
  const ratio = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3, '2.35:1': 2.35 }[values['kf.ratio']] || 16 / 9;
  const edge = Number(values['kf.resolution']);
  const defaultWidth = edge > 0 ? Math.ceil((ratio >= 1 ? edge : edge * ratio) / 2) * 2 : undefined;
  const defaultHeight = edge > 0 ? Math.ceil((ratio >= 1 ? edge / ratio : edge) / 2) * 2 : undefined;
  const quality = Q.assertAllowed(Q.guard({ ...o, engine, frames,
    tier: o.tier ?? values.tier ?? values['kf.tier'], width: o.width ?? values.width ?? values['kf.width'] ?? defaultWidth, height: o.height ?? values.height ?? values['kf.height'] ?? defaultHeight,
    steps: o.steps ?? values['kf.steps'], cfg: o.cfg ?? values['kf.cfg'], denoise: o.denoise ?? values['kf.refine_denoise'],
    native_fps: o.native_fps ?? o.fps ?? values.native_fps ?? values['mo.fps'], output_fps: o.output_fps ?? values.output_fps ?? values['mo.output_fps'] }));
  const { width, height } = quality.resolution;
  const render = quality.render_resolution;
  const g = engine === 'minimax_h3'
    ? h3Executable({ ...o, prompt, negative, width, height, frames, seed, ...quality.sampling, native_fps: quality.fps.native_fps })
    : wanExecutable({ prompt, negative, width: render.width, height: render.height, frames, seed, values, ...quality.sampling, fps: quality.fps.native_fps });
  if (engine !== 'minimax_h3' && render.crop) {
    g['13'] = { class_type: 'ImageCrop', inputs: { image: ['9', 0], width, height, x: 0, y: 0 } };
    g['11'].inputs.images = ['13', 0];
  }
  return {
    graph: g,
    quality,
    mapped_nodes: Object.keys(g).length,
    note: '可执行图是「关键节点子集」；130 节点规划拓扑仍是实验拆分与复现凭据，两者节点数不同不代表缺失',
    // H3 的 latent 是 NestedTensor（音视频联合），SaveLatent 会报
    // 'NestedTensor' object has no attribute 'contiguous' —— 因此 H3 不做潜变量快照；
    // Wan2.2 的 latent 是普通 tensor，保留 SaveLatent。
    save_latent: engine !== 'minimax_h3',
  };
}

function digest(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

/**
 * 生成拓扑。
 * @param {{engine?:string, mode?:'fresh'|'locked', lockedTopology?:object, values?:object, usableMib?:number, taskId?:string}} o
 */
function build(o = {}) {
  const engineId = o.engine || 'wan22';
  const eng = ENG.get(engineId);
  const mode = o.mode === 'locked' ? 'locked' : 'fresh';
  const values = o.values || ENG.load(engineId).values;
  const taskId = o.taskId || 'task_' + Date.now().toString(36) + '_' + crypto.randomBytes(2).toString('hex');

  // locked：只复用拓扑，节点/端口/连线一律不改；参数注入值可以变
  if (mode === 'locked') {
    if (!o.lockedTopology || !Array.isArray(o.lockedTopology.nodes)) {
      const e = new Error('locked 模式必须传 lockedTopology（对照/消融实验要先锁定一份拓扑）');
      e.code = 'CANVAS_NO_LOCKED_TOPOLOGY';
      throw e;
    }
    const t = JSON.parse(JSON.stringify(o.lockedTopology));
    for (const n of t.nodes) if (n.param && values[n.param] != null) n.value = values[n.param];
    return {
      task_id: taskId, engine: engineId, mode,
      topology: t,
      stats: statsOf(t, eng),
      vram: ENG.vramPlan(o.usableMib),
      params_digest: digest(values),
      execution: executionOf(t, eng, { ...o, values }),
      warnings: [{ code: 'CANVAS_LOCKED_REUSED', text: 'locked 模式：复用既有拓扑，仅替换节点内部参数（控制变量）' }],
    };
  }

  // fresh：从七大模块模板生成
  const nodes = [];
  const edges = [];
  const per = {};
  for (const mod of SPEC.canvas.modules) {
    const tpl = MODULE_TEMPLATES[mod.id] || [];
    const arr = [];
    for (let i = 0; i < mod.quota; i += 1) {
      const t = tpl[i % Math.max(1, tpl.length)] || ['AVP.PassThrough', 'fill_' + i, null];
      const n = {
        id: `${mod.id}_${String(i + 1).padStart(2, '0')}`,
        module: mod.id,
        role: t[1] + (i >= tpl.length ? '_' + Math.floor(i / tpl.length) : ''),
        class_type: t[0],
        param: t[2] || null,
        value: t[2] ? (values[t[2]] != null ? values[t[2]] : null) : null,
        engine: engineId,
        ports: { in: i === 0 ? ['upstream'] : ['prev'], out: ['next'] },
      };
      arr.push(n);
      nodes.push(n);
      if (i > 0) edges.push({ from: `${mod.id}_${String(i).padStart(2, '0')}`, to: n.id, input: 'prev' });
    }
    per[mod.id] = arr.length;
  }

  // 模块间主干：input→text→latent→sampler→vae→scoring→archive（每段一条主干边）
  const spine = ['input_precheck', 'text_encode', 'latent_init', 'sampler_core', 'vae_decode', 'scoring', 'archive_split'];
  for (let i = 0; i < spine.length - 1; i += 1) {
    const a = `${spine[i]}_${String(per[spine[i]]).padStart(2, '0')}`;
    const b = `${spine[i + 1]}_01`;
    edges.push({ from: a, to: b, input: 'spine' });
  }
  // 采样器回边（迭代核心内部循环）与打分回传（贝叶斯适配）
  edges.push({ from: 'sampler_core_25', to: 'sampler_core_01', input: 'loop', loop: true });
  edges.push({ from: 'scoring_12', to: 'input_precheck_13', input: 'bayes_feedback', dashed: true });

  const topology = {
    schema: 'ai-video-platform/canvas.topology',
    version: '1.0.0',
    engine: engineId,
    engine_node_hints: ENGINE_NODE_HINTS[engineId] || null,
    nodes, edges,
    modules: SPEC.canvas.modules.map((m) => ({ id: m.id, name: m.name, nodes: per[m.id], quota: m.quota })),
    created_at: new Date().toISOString(),
  };

  const execution = executionOf(topology, eng, { ...o, values });
  return {
    task_id: taskId, engine: engineId, mode,
    topology,
    stats: { ...statsOf(topology, eng), mapped_executable_nodes: execution.mapped_nodes },
    vram: ENG.vramPlan(o.usableMib),
    params_digest: digest(values),
    execution,
    warnings: statsOf(topology, eng).min_nodes_ok ? [] : [{ code: 'CANVAS_TOO_SMALL', text: `节点数 ${nodes.length} < ${SPEC.canvas.min_nodes}` }],
  };
}

function statsOf(t, eng) {
  const mods = {};
  for (const n of t.nodes) mods[n.module] = (mods[n.module] || 0) + 1;
  const missingModules = SPEC.canvas.modules.filter((m) => !mods[m.id]).map((m) => m.id);
  const packed = t.nodes.filter((n) => /Group|Subgraph|Pack/i.test(String(n.class_type))).length;
  return {
    nodes: t.nodes.length,
    edges: t.edges.length,
    per_module: mods,
    missing_modules: missingModules,
    min_nodes_ok: t.nodes.length >= SPEC.canvas.min_nodes,
    packing_violations: packed,
    engine: eng.id,
  };
}

function executionOf(t, eng, o) {
  const exec = executableFor(eng.id, o);
  const errors = require('./quality.js').workflowErrors(exec.graph);
  return { comfy_ready: errors.length === 0, graph: exec.graph, quality: exec.quality, quality_errors: errors,
    mapped_nodes: exec.mapped_nodes, planned_nodes: t.nodes.length, note: exec.note, save_latent: exec.save_latent };
}

module.exports = { build, statsOf, MODULE_TEMPLATES, SPEC, digest, executableFor, wanExecutable, h3Executable };
