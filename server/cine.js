/**
 * cine.js —— 一句话电影管线（分析 → 8 组关键帧打磨 → 选优 → i2v → 电影级后处理）
 *
 * 用户只写一句话。本模块把规格里的七步串成一条 provider 通路（providers/cine.js），
 * 进度文案与规格【二】逐字对齐，由 jobs.js 的 SSE 原样转发。
 *
 * 真实能力边界（2026-11-18 实测，见 docs/02-backend.md §cine）：
 *   - 分析/评审：DashScope compatible-mode，qwen-plus / qwen3-vl-plus（真调用）。
 *     规格写的「Qwen3.8」是称呼，账号可用型号以 /models 实测列表为准，映射如实记录。
 *   - 关键帧：qwen-image-2.0 同步文生图（真出图，1024*1536，negative_prompt 真生效）。
 *     规格基线 DPM++ 3M SDE Karras / CFG 6.0 / 30 步是 ComfyUI 采样器口径；本机无 ComfyUI、
 *     云端 t2i 不暴露这些旋钮 → 记 requested + applicable:false，不假装设置过。
 *   - 图生视频：wan2.2 i2v（异步 video-synthesis，真出片）。
 *   - 后处理：本机 ffmpeg。RIFE / Real-ESRGAN 是第三方 ML 运行时，铁律禁止引入 →
 *     用 minterpolate(mci) / lanczos 真实替代，并在 substitutions[] 里逐条标明「非 RIFE / 非 ESRGAN」。
 *   - 评审分是模型意见（provenance:'model-opinion'），不是逐像素实测画质分；两者不许混称。
 *
 * 诚实降级：无 key / 调用失败 → 抛带 code 的错误，任务如实 failed；分析退规则轨时标 source:'rules'。
 * 重试纪律：关键帧组内重试≤3 次（规格）；i2v 提交成功后的失败不自动重投（重投=重复计费）。
 * key 只走环境变量 DASHSCOPE_API_KEY，不进仓库、不进前端、不落任务记录。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const QA = require('../quality/frames.js');
const AUDIT = require('./audit.js');
const AESTH = require('./aesthetics.js');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const CLOUD_ROOT = process.env.CLOUD_ROOT || 'D:\\云盘';
const CINE_DIR = path.join(CACHE_ROOT, 'avp', 'cine');
const OUTPUT_DIR = path.join(CLOUD_ROOT, '02-视频', '成片');
const FFMPEG = process.env.AVP_FFMPEG || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffmpeg.exe';
const FFPROBE = process.env.AVP_FFPROBE || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffprobe.exe';

/** 规格【一】第 2 步逐字修饰词 / 统一负面词；第 5 步逐字运动提示词 / 视频负面词。 */
const MODIFIERS = 'masterpiece, best quality, ultra-detailed, 8k uhd, shot on ARRI Alexa Mini, Kodak Vision3 film stock, professional cinematography, award-winning, sharp focus, detailed skin texture, pores visible, volumetric lighting, film grain natural, dark vignette';
const NEGATIVE = 'deformed, blurry, low quality, plastic skin, overexposed, CGI, cartoon, 3d render, text, watermark, extra limbs, distorted face, oversaturated, jpeg artifacts';
const MOTION_PROMPT = 'almost static locked-off shot, barely perceptible motion, hair strands slowly drifting, dust particles floating in light beam, subtle breathing, handheld micro shake, no pan no zoom no dolly';
const MOTION_NEG = 'fast motion, shaky swing, flickering exposure, morphing face, scene cut, zoom, pan, head turn, walking, distorted limbs, jitter, warping';
/** 规格【五】仅用户明确写运镜才生成对应运镜并标注；默认固定机位。 */
const CAMERA_MOVES = [
  { re: /推近|推进|push in|zoom in/, en: 'slow push in', zh: '推近' },
  { re: /拉远|拉开|pull out|zoom out/, en: 'slow pull out', zh: '拉远' },
  { re: /环绕|orbit|arc shot/, en: 'slow orbit around subject', zh: '环绕' },
  { re: /跟拍|跟随|tracking|follow shot/, en: 'smooth tracking follow', zh: '跟拍' },
];
function detectCamera(prompt) {
  const hit = CAMERA_MOVES.find((c) => c.re.test(String(prompt || '')));
  return hit ? { move: hit.en, zh: hit.zh, fixed: false } : { move: null, zh: '固定机位', fixed: true };
}

/** 规格【三】基线：请求口径如实记录；云端不暴露的旋钮标 applicable:false。 */
const BASELINES = {
  keyframe: { sampler: 'DPM++ 3M SDE Karras', cfg: 6.0, steps: 30, size: '1024*1536' },
  video: { model_family: 'wan2.2 i2v', duration: 5, resolution: '720p', fps: 16 },
  post: { interpolate_fps: 48, upscale: '1080p', lut: 'teal and orange', grain: '35mm', vignette_pct: 1.5, handheld: true },
};

/** 规格【一】七风格词库（POS/NEG 逐字）。key 为规格风格 id。 */
const STYLE_WORDS = {
  cinema: {
    pos: 'cinematic film still, ARRI Alexa Mini, Kodak Vision3 500T, 35mm anamorphic lens, f/1.8 shallow depth of field, volumetric rim light, teal shadows warm highlights, subtle anamorphic flare, natural skin pores, 35mm film grain, dark vignette, rule of thirds, award-winning cinematography',
    neg: 'flat overcast light, plastic waxy skin, CGI 3d render, cartoon, overexposed highlights, HDR washout, harsh flash, cluttered background',
  },
  doc: {
    pos: 'documentary still, natural ambient daylight, candid unposed moment, raw unfiltered texture, real skin with pores wrinkles imperfections, 50mm f/2.0, neutral true color, no beauty retouching',
    neg: 'studio softbox, heavy makeup, airbrushed smooth skin, posed portrait, glamour lighting',
  },
  anime: {
    pos: 'high quality anime key visual, clean confident line art, cel shading, flat cel colors, anime proportional face, soft cel shadow, studio anime production, sharp line weight',
    neg: '3d render, realistic skin pores, photo texture, uncanny valley, plastic shading, watercolor blur',
  },
  guofeng: {
    pos: 'Chinese classical aesthetic, hanfu robe embroidery, timber courtyard or misty mountain, ink wash atmosphere, elegant composition, muted mineral palette celadon ink-gray ochre, silk texture, distant mountain layers',
    neg: 'modern streetwear, western castle, neon sign, concrete building, sunglasses, plastic armor',
  },
  cyber: {
    pos: 'cyberpunk night street, neon blue magenta glow, wet asphalt reflections, holographic signage, rain mist haze, high contrast, leather techwear, volumetric neon haze, depth layers',
    neg: 'pastoral field, old wooden village, soft pastel daylight, warm cozy cabin, green nature',
  },
  dark: {
    pos: 'dark low-key lighting, deep crushed shadows, desaturated cold slate, single weak light source, heavy negative space, quiet mysterious mood, grainy 16mm film, muted contrast',
    neg: 'bright sunny, cheerful pastel, high-key white, colorful celebration, warm candy tones',
  },
  dream: {
    pos: 'ethereal dreamy atmosphere, soft circular bokeh, pastel cream pink, floating dust in light beam, gentle fog, glowing rim halo, soft focus edges, light airy composition',
    neg: 'harsh hard shadow, gritty rough texture, dark horror, harsh contrast, cracked dirty ground',
  },
};
/** 前端 MUSE 预设 id / 分析 style_id → 规格风格 id。 */
const STYLE_MAP = {
  muse_cinematic: 'cinema', real_photo: 'doc', anime: 'anime', guofeng_immortal: 'guofeng', cyberpunk: 'cyber', dark_sculpture: 'dark', dreamy: 'dream',
  'cinematic-real': 'cinema', 'film-doc': 'doc', 'oriental-ancient': 'guofeng', ink: 'guofeng', cyber: 'cyber', commercial: 'doc',
};
const styleFor = (id) => (STYLE_WORDS[id] ? id : (STYLE_MAP[id] || 'cinema'));

/** 规格【一/二】统一抖音网红脸：正向词库按权重分级（写实类自动拼装）+ 逐字负面。
 *  2026-11-18 与 reverse.capabilities.json#douyin-face 对齐：皮相组必须「保留毛孔 + 水光高光点」并存，
 *  删掉旧版的 `no visible pores / flawless complexion / beauty filter look` —— 那三条正是塑料脸的配方，
 *  与逆向后得出的『只写水光=油脸、只写磨皮=塑料』结论直接冲突。改这里必须同步 server/selftest.js 断言。 */
const FACE_POS = '(pure Chinese beauty face:1.15), (douyin influencer aesthetic:1.1), (big clear bright eyes:1.15), (double eyelids:1.1), long curled lashes, (straight high nose bridge:1.1), slim nose tip, (small V-shaped face:1.1), pointed soft chin, (symmetrical refined features:1.1), small lips with glossy pink lip tint, (visible skin pores retained:1.1), (dewy highlight on cheekbones and nose tip:1.2), natural skin texture, even skin tone, brightened under-eye, soft natural makeup, light blush on cheeks, defined eyebrows, glossy lips, black silky straight hair, soft face-framing strands, neat hairstyle, youthful age 18-25, gentle expression, pretty on camera';
const FACE_STYLE_ADD = {
  cinema: '保留轻微皮肤纹理，美颜强度中等，光影立体',
  guofeng: '柳叶细眉，鹅蛋脸，古典丹凤眼，淡唇色，汉服精致妆',
  cyber: '冷白皮，烟熏眼妆，高光修容，酷感精致',
  dream: '柔光奶油肌，粉腮红，空气刘海，朦胧美颜',
  doc: '精致淡妆，皮肤干净，不浓妆',
};
const FACE_NEG = 'wrinkles, rough dry skin, age spots, acne, facial hair, under-eye dark circles, asymmetric face, crooked nose, wide flat nose, deep-set eyes, small eyes, single eyelid, thick lips, square jaw, wide face, caucasian western face, blonde, blue eyes, deformed asymmetrical face, blurry face, extra eye, extra finger, plastic doll face, waxy over-smoothed skin, oversized cartoon eyes, heavy filter distortion';
/**  legacy 年龄追加词（保留导出供参考；统一网红脸默认 youthful，不再按年龄挂载自然瑕疵词）。 */
const FACE_AGE = {
  teen: 'youthful soft face, smooth real skin, no facial hair',
  young: 'young adult natural proportions',
  middle: 'subtle laugh lines, mature features',
  old: 'real wrinkles, age spots, natural sagging skin',
};
const FACE_STYLE_EXCLUDE = new Set(['anime']); // 二次元不挂写实网红脸块
function detectAge(prompt) {
  const s = String(prompt || '');
  if (/老年|老人|老者|白发|皱纹|老妇|老翁/.test(s)) return 'old';
  if (/中年|大叔|大妈|母亲|父亲/.test(s)) return 'middle';
  if (/少年|少女|孩子|儿童|小孩|学生|童年/.test(s)) return 'teen';
  return 'young';
}
/** 人脸技术链请求口径：influencerBeauty LoRA / FaceDetailer / 美颜数值在本机不可执行 → applicable:false 如实记。 */
const FACE_TECH = {
  lora: { id: 'influencerBeauty_v1', default_weight: 0.75, min: 0.60, max: 0.90, retry_weight: 0.85 },
  face_detailer: { box_scale: 2, denoise: 0.40, asym_denoise: 0.45, eye_scale: 1.05, face_narrow: true, skin_brighten: true, multi_face_target: 'subject' },
  beauty: { smooth_pct: 60, brighten_pct: 8, slim_pct: 8, eye_pct: 5, under_eye: true, lip: 'natural-pink', per_style: { cinema: 40, dream: 40, cyber: 70, guofeng: 70 }, expert_range: [0, 100] },
  face_quality_gate: { dims: ['五官精致度', '皮肤质感', '妆容完成度', '脸型轮廓', '上镜效果'], each: 2.0, regen_below: 7, max_retry: 3 },
  applicable: false,
  reason: '本机无 ComfyUI（FaceDetailer/LoRA 为 ComfyUI 节点），云端 qwen-image 不暴露 LoRA/重绘/人脸 landmarks 旋钮；磨皮用 ffmpeg bilateral 传统滤镜近似、提亮用 eq/grade；瘦脸/大眼/眼下/face-mask 需 landmarks/ML 不可执行',
  provenance: 'measured',
};

/** 规格【三】分风格采样参数。sampler/CFG/步数云端不暴露 → applicable:false；尺寸真生效。 */
const SAMPLING = {
  cinema: { sampler: 'DPM++ 3M SDE Karras', cfg: 6.0, steps: 30 },
  doc: { sampler: 'DPM++ 3M SDE Karras', cfg: 6.0, steps: 30 },
  dark: { sampler: 'DPM++ 3M SDE Karras', cfg: 6.0, steps: 30 },
  anime: { sampler: 'DPM++ 2M Karras', cfg: 7.0, steps: 28 },
  guofeng: { sampler: 'DPM++ 3M SDE Karras', cfg: 6.5, steps: 30 },
  cyber: { sampler: 'DPM++ 2M SDE Karras', cfg: 7.0, steps: 30 },
  dream: { sampler: 'DPM++ 2M Karras', cfg: 5.5, steps: 26 },
};
const isLandscape = (prompt) => /横版|横屏|横幅|landscape|wide screen|16:9/.test(String(prompt || ''));
const isPortrait = (prompt) => /竖版|竖屏|竖幅|portrait|9:16/.test(String(prompt || ''));
/** 画幅比例 → t2i 尺寸（+ 不支持时的回退尺寸）。默认 16:9 横屏（电影画幅）。 */
const RATIOS = {
  '16:9': { size: '1280*720', fallback: '1536*1024', label: '16:9 横屏' },
  '9:16': { size: '720*1280', fallback: '1024*1536', label: '9:16 竖屏' },
  '1:1': { size: '1024*1024', fallback: '1024*1024', label: '1:1 方形' },
  '3:2': { size: '1536*1024', fallback: '1536*1024', label: '3:2 横' },
  '2:3': { size: '1024*1536', fallback: '1024*1536', label: '2:3 竖' },
};
const DEFAULT_RATIO = '16:9';
function ratioFor(prompt, ratio) {
  if (ratio && RATIOS[ratio]) return ratio;
  if (isPortrait(prompt)) return '9:16';
  return DEFAULT_RATIO; // 平台默认 16:9
}
const keyframeSize = (prompt, ratio) => RATIOS[ratioFor(prompt, ratio)].size;
const ratioFallback = (prompt, ratio) => RATIOS[ratioFor(prompt, ratio)].fallback;
/** 8 组互异随机种子（写入请求日志）。 */
function groupSeeds(n = 8) {
  const set = new Set();
  while (set.size < n) set.add(Math.floor(Math.random() * 2147483647));
  return [...set];
}
/** 规格【三】提示词权重 (词:1.15)，单句加权不超 1.25。只对风格/人脸领词加权。 */
const weight = (term, w = 1.15) => `(${term}:${Math.min(1.25, w).toFixed(2)})`;
/** 专家 LoRA 权重夹取 0.60~0.90（默认 0.75）。 */
const clampLora = (w) => { const n = Number(w); if (!Number.isFinite(n)) return FACE_TECH.lora.default_weight; return Math.min(FACE_TECH.lora.max, Math.max(FACE_TECH.lora.min, n)); };
/** 美颜强度：专家 0~100 优先，否则分风格默认（cinema/dream40 cyber/guofeng70 其余60）。 */
const beautyDefault = (styleId) => (FACE_TECH.beauty.per_style[styleId] != null ? FACE_TECH.beauty.per_style[styleId] : FACE_TECH.beauty.smooth_pct);

const GROUPS = [
  { id: 1, name: '标准电影感', zh: '标准电影感构图，自然光效，曝光均衡', en: 'cinematic composition, natural lighting, balanced exposure' },
  { id: 2, name: '伦勃朗侧光', zh: '伦勃朗侧光，脸颊三角光斑，明暗对照强烈', en: 'Rembrandt lighting, triangle light on cheek, strong side key light, chiaroscuro' },
  { id: 3, name: '逆光剪影', zh: '逆光剪影，轮廓光勾边，主体压暗成剪影', en: 'backlit silhouette, glowing rim light, dark foreground subject against bright background' },
  { id: 4, name: '浅景深特写', zh: '浅景深特写，焦外奶油化开，皮肤纹理可见', en: 'extreme close-up, shallow depth of field, f/1.4, creamy bokeh, detailed skin texture' },
  { id: 5, name: '广角环境人像', zh: '广角环境人像，人物置于大场景之中，纵深清晰', en: 'wide angle environmental portrait, 24mm lens, subject within vast scene, deep focus' },
  { id: 6, name: '冷暖对比最强', zh: '冷暖对比拉到最强，暖主光冷辅光，电影调色', en: 'strongest teal and orange contrast, warm key light cool fill, heavily color graded' },
  { id: 7, name: '雾气空气透视', zh: '雾气弥漫，体积光光束，空气透视分层', en: 'atmospheric fog, volumetric light shafts, aerial perspective, layered haze' },
  { id: 8, name: '胶片复古质感', zh: '胶片复古质感，卤化银光晕，黑位微微发灰', en: 'vintage film look, Kodak Vision3 500T, halation, soft contrast, faded blacks' },
];

/** 规格【四】诊断→修复映射（8 条）。cfg/步数/LoRA/FaceDetailer 云端无旋钮 → applicable:false 如实记。 */
const FIX_MAP = {
  plastic: { tokens: 'natural skin pores fine texture film grain', negativeAdd: 'waxy smooth airbrushed' },
  face: { tokens: 'natural facial anatomy, symmetric eyes, detailed iris', negativeAdd: 'deformed asymmetrical face', cfg: 5.5, stepsAdd: 2, faceDetailer: true },
  light: { tokens: 'rim light volumetric light high contrast deep shadow', negativeAdd: 'flat lighting, even lighting' },
  composition: { tokens: 'rule of thirds centered subject cinematic framing', negativeAdd: 'centered snapshot, cluttered frame' },
  color: { tokens: 'color graded', negativeAdd: 'clashing colors', styleGrade: true },
  western: { tokens: FACE_POS, negativeAdd: 'caucasian western', loraWeight: 0.85 },
  style: { tokens: '', negativeAdd: '', rewriteStyle: true },
  limbs: { tokens: '', negativeAdd: 'extra fingers deformed hands', regen: true },
};
const DIM_ZH = { fit: '提示词符合度', composition: '构图美学', light: '光影层次', face: '人脸/主体细节', style: '风格还原度' };

class CineError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail || {}; }
}

const key = () => String(process.env.DASHSCOPE_API_KEY || '').trim();
const chatModel = () => process.env.AVP_QWEN_MODEL || 'qwen-plus';
const vlModel = () => process.env.AVP_QWEN_VL_MODEL || 'qwen3-vl-plus';
const imageModel = () => process.env.AVP_CINE_IMAGE_MODEL || 'qwen-image-2.0';
const i2vModel = () => process.env.AVP_CINE_I2V_MODEL || 'wan2.2-i2v-flash';
const base = () => String(process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '');
const compatBase = () => base().replace(/\/api\/v1\/?$/, '') + '/compatible-mode/v1';

/** 从模型回复里抠 JSON：容忍围栏/前后废话；抠不出抛 CINE_BAD_JSON（不猜分数）。 */
function parseJsonReply(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = fence ? fence[1] : s;
  const a = cand.indexOf('{'), b = cand.lastIndexOf('}');
  if (a < 0 || b <= a) throw new CineError('CINE_BAD_JSON', '模型回复里没有 JSON', { snippet: s.slice(0, 200) });
  try { return JSON.parse(cand.slice(a, b + 1)); } catch (e) {
    throw new CineError('CINE_BAD_JSON', '模型 JSON 解析失败：' + e.message, { snippet: s.slice(0, 200) });
  }
}

/** 规格【四】五维各 2 分满分 10：模型回 0-2，内部换算 0-10（×5），total=均值=五维(0-2)之和。缺维/越界如实抛错。 */
function normalizeScores(raw) {
  const dims = {};
  for (const k of Object.keys(DIM_ZH)) {
    const v = Number(raw && raw.dims ? raw.dims[k] : NaN);
    if (!Number.isFinite(v)) throw new CineError('CINE_BAD_SCORE', `评审缺维度 ${k}`, { raw });
    dims[k] = Math.min(10, Math.max(0, v * 5));
  }
  const total = Math.round((Object.values(dims).reduce((a, b) => a + b, 0) / 5) * 10) / 10;
  const fd = raw && raw.faceDims;
  const faceTotal = fd ? Math.round(Object.values(fd).reduce((a, b) => a + (Number(b) || 0), 0) * 10) / 10 : null;
  return {
    dims, total, faceDims: fd || null, faceTotal, faceFlags: (raw && raw.faceFlags) || null,
    diagnosis: String((raw && raw.diagnosis) || ''), fix: String((raw && raw.fix) || ''),
    western_face: !!(raw && raw.western_face), limb_deformity: !!(raw && raw.limb_deformity),
  };
}

/** 规格【五】网红脸诊断→修正（眼睛小/脸宽/皮肤瑕疵/妆容淡/西方/不对称）。 */
function diagnoseFaceFix(scores) {
  const f = (scores && scores.faceFlags) || {};
  const tokens = [], neg = [];
  let beautyAdd = 0, loraWeight = null, denoise = null;
  if (f.eyesSmall) { tokens.push('(big clear bright eyes:1.20), (double eyelids:1.20), long curled lashes'); }
  if (f.wideFace) { tokens.push('(small V-shaped face:1.20), pointed soft chin, slim nose tip'); beautyAdd += 10; }
  if (f.skinBlemish) { tokens.push('(fair smooth porcelain skin:1.20), flawless complexion, even skin tone'); beautyAdd += 10; }
  if (f.makeupLight) { tokens.push('defined eyebrows, glossy lips, light blush on cheeks, long curled lashes'); }
  if (f.western || scores.western_face) { tokens.push('(pure Chinese beauty face:1.20)'); loraWeight = FACE_TECH.lora.retry_weight; }
  if (f.asym) { denoise = FACE_TECH.face_detailer.asym_denoise; tokens.push('(symmetrical refined features:1.20)'); }
  const seen = new Set();
  const uniq = tokens.join(', ').split(',').map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  return { tokens: uniq.join(', '), negativeAdd: neg.join(', '), beautyAdd, loraWeight, denoise, hit: Object.keys(f).filter((k) => f[k]) };
}

/** 诊断→修复：先看人种/肢体/塑料等硬伤旗标与诊断词，再按最弱维兜底。 */
function diagnoseFix(scores, modelFix, diagnosisText) {
  const d = String(diagnosisText || scores.diagnosis || '');
  let rule = null;
  if (scores.western_face || /西方面孔|西方|caucasian|western|混血/.test(d)) rule = 'western';
  else if (scores.limb_deformity || /肢体|手指|多指|limb|finger/.test(d)) rule = 'limbs';
  else if (/塑料|蜡感|plastic|waxy|airbrush/.test(d)) rule = 'plastic';
  else if (/风格跑偏|风格不符|style/.test(d)) rule = 'style';
  else if (/色调|色彩|color/.test(d)) rule = 'color';
  if (!rule) {
    const weak = Object.entries(scores.dims).filter(([, v]) => v < 9).sort((a, b) => a[1] - b[1]);
    rule = { face: 'face', style: 'style', light: 'light', composition: 'composition', fit: 'composition' }[weak[0] && weak[0][0]] || 'light';
  }
  const f = FIX_MAP[rule];
  const extra = [f.tokens, modelFix].filter(Boolean).join(', ');
  const seen = new Set();
  const tokens = extra.split(',').map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  const weak = Object.entries(scores.dims).sort((a, b) => a[1] - b[1])[0];
  return {
    rule,
    dim: weak ? weak[0] : null,
    dimZh: weak ? DIM_ZH[weak[0]] : null,
    tokens: tokens.join(', '),
    negativeAdd: f.negativeAdd || '',
    cfg: f.cfg == null ? null : f.cfg,
    stepsAdd: f.stepsAdd || 0,
    loraWeight: f.loraWeight == null ? null : f.loraWeight,
    faceDetailer: !!f.faceDetailer,
    rewriteStyle: !!f.rewriteStyle,
    cfgApplicable: false, // 云端 t2i 无 CFG/步数/LoRA/FaceDetailer 旋钮；规格要求只能记录不能执行
  };
}

/** 组提示词 = 分析槽位 + 组方向 + 风格词库(逐字) + 中国人脸(写实类) + 规格修饰词 + 重试追加词。 */
function buildGroupPrompt(analysis, group, extraTokens, opts = {}) {
  const styleId = styleFor(opts.styleId || analysis.style_id);
  const sw = STYLE_WORDS[styleId];
  const slots = [analysis.subject, analysis.scene, analysis.light, analysis.mood, analysis.camera, analysis.shot]
    .map((s) => String(s || '').trim()).filter(Boolean);
  const parts = [slots.join('，') + '。' + group.zh + '。' + group.en];
  // 风格领词加权 (词:1.15)，其余逐字
  const lead = sw.pos.split(',')[0].trim();
  parts.push(weight(lead) + ', ' + sw.pos.slice(lead.length).replace(/^,\s*/, ''));
  if (!FACE_STYLE_EXCLUDE.has(styleId)) {
    parts.push(FACE_POS + (FACE_STYLE_ADD[styleId] ? ', ' + FACE_STYLE_ADD[styleId] : ''));
  }
  parts.push(MODIFIERS);
  let p = parts.join(', ');
  if (extraTokens) p += ', ' + extraTokens;
  return p.slice(0, 5000);
}

function buildGroupNegative(extraNeg, opts = {}, analysis = {}) {
  const styleId = styleFor(opts.styleId || (analysis && analysis.style_id));
  const parts = [NEGATIVE, STYLE_WORDS[styleId].neg];
  if (!FACE_STYLE_EXCLUDE.has(styleId)) parts.push(FACE_NEG);
  if (extraNeg) parts.push(extraNeg);
  return parts.join(', ').slice(0, 2000);
}

/** 规格【六】分风格 LUT 调色参数（阴影/高光偏移 + 饱和 + 对比 + 提亮）。人脸肤色不偏色靠低饱和偏移近似，mask 保护不可执行如实记。 */
const STYLE_GRADE = {
  cinema: { sh: [-0.045, 0.015, 0.060], hi: [0.055, -0.005, -0.065], sat: 1.06, curve: 0.06, lift: 0 },
  doc: { sh: [0, 0, 0], hi: [0.01, 0.005, 0], sat: 0.92, curve: 0.03, lift: 0 },
  guofeng: { sh: [-0.02, 0.03, 0.03], hi: [0.05, 0.03, -0.04], sat: 0.85, curve: 0.04, lift: 0 },
  cyber: { sh: [0.02, -0.02, 0.07], hi: [0.06, -0.03, 0.05], sat: 1.15, curve: 0.09, lift: 0 },
  dark: { sh: [-0.02, 0, 0.03], hi: [0.01, 0.01, 0.02], sat: 0.70, curve: 0.08, lift: -0.03 },
  dream: { sh: [0.03, 0.01, 0.02], hi: [0.05, 0.04, 0.02], sat: 0.90, curve: 0.02, lift: 0.03 },
  anime: { sh: [0, 0, 0.01], hi: [0.01, 0.01, 0], sat: 1.05, curve: 0.04, lift: 0 },
  // 氛围题材光学预设（灰境审美方案 §3/§8：M8 按题材落 filmic/halation/颗粒/暗角）
  sunset: { sh: [-0.04, 0.01, 0.05], hi: [0.08, 0.03, -0.05], sat: 1.02, curve: 0.05, lift: 0.01 },
  nightneon: { sh: [0.01, -0.02, 0.06], hi: [0.05, -0.02, 0.06], sat: 1.10, curve: 0.08, lift: -0.01 },
  snow: { sh: [-0.02, 0.0, 0.04], hi: [0.02, 0.03, 0.04], sat: 0.78, curve: 0.06, lift: 0.02 },
  window: { sh: [0.01, 0.01, 0.0], hi: [0.04, 0.03, 0.01], sat: 0.92, curve: 0.03, lift: 0.02 },
  retro: { sh: [0.03, 0.01, -0.02], hi: [0.06, 0.03, -0.03], sat: 0.85, curve: 0.04, lift: 0.01 },
  sea: { sh: [-0.02, 0.0, 0.03], hi: [0.02, 0.03, 0.04], sat: 0.72, curve: 0.04, lift: 0.02 },
  noir: { sh: [-0.02, 0.0, 0.02], hi: [0.02, 0.02, 0.03], sat: 0.35, curve: 0.12, lift: -0.04 },
};
/** 33 点 .cube：按风格_grade 生成真 LUT 文件，ffmpeg lut3d 消费。 */
function buildStyleCube(styleId = 'cinema', size = 33) {
  const g = STYLE_GRADE[styleId] || STYLE_GRADE.cinema;
  const lines = [`TITLE "AVP ${styleId} grade (node-generated)"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  const curve = (x) => Math.min(1, Math.max(0, x + g.curve * Math.sin(Math.PI * x) * (x - 0.5) * 2 + g.lift));
  for (let b = 0; b < size; b += 1) for (let g2 = 0; g2 < size; g2 += 1) for (let r = 0; r < size; r += 1) {
    const R = r / (size - 1), G = g2 / (size - 1), B = b / (size - 1);
    const luma = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const sh = Math.pow(1 - luma, 2), hi = Math.pow(luma, 2);
    let oR = curve(R) + g.sh[0] * sh + g.hi[0] * hi;
    let oG = curve(G) + g.sh[1] * sh + g.hi[1] * hi;
    let oB = curve(B) + g.sh[2] * sh + g.hi[2] * hi;
    const l2 = 0.2126 * oR + 0.7152 * oG + 0.0722 * oB;
    oR = l2 + (oR - l2) * g.sat; oG = l2 + (oG - l2) * g.sat; oB = l2 + (oB - l2) * g.sat;
    const c = (x) => Math.min(1, Math.max(0, x)).toFixed(6);
    lines.push(`${c(oR)} ${c(oG)} ${c(oB)}`);
  }
  return lines.join('\n') + '\n';
}
const buildTealOrangeCube = (size = 33) => buildStyleCube('cinema', size);

/**
 * 规格【六】固定顺序后处理滤镜链（ffmpeg 真实替代）：
 * 1 插帧48 → 2 lanczos超分(保aspect) → 3 分风格LUT → 4 颗粒8% → 5 暗角1.5%+中心提亮 → 6 ±0.5%呼吸微抖 → 7 编码。
 * 目标尺寸由源探针决定：横幅→高1080，竖幅→宽1080（硬拉 1920x1080 会变形）。
 */
function postTargetSize(srcW, srcH, ratio) {
  const RT = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080], '3:2': [1620, 1080], '2:3': [1080, 1620] };
  if (ratio && RT[ratio]) return { w: RT[ratio][0], h: RT[ratio][1] };
  if (srcW >= srcH) {
    const h = 1080;
    return { w: Math.round((srcW * h) / srcH / 2) * 2, h };
  }
  const w = 1080;
  return { w, h: Math.round((srcH * w) / srcW / 2) * 2 };
}

function postFilterChain(lutFile, w, h, opts = {}) {
  const lut = String(lutFile).replace(/\\/g, '/').replace(/:/g, '\\:');
  const A = Math.max(1, Math.round(0.005 * w)); // ±0.5% 呼吸微抖
  const W = Math.max(1, Math.round(0.002 * w)); // 轻 gate weave（更慢更小）
  const crop = `crop=w=iw-${2 * (A + W)}:h=ih-${2 * (A + W)}:x='${A + W}+${A}*sin(t*2.1)+${W}*sin(t*0.7)':y='${A + W}+${A}*sin(t*1.7+0.9)+${W}*sin(t*0.53+1.3)'`;
  const ar = (w / h).toFixed(4);
  // 中心裁到目标画幅比例（保证输出比例=用户所选，即使 t2i 尺寸回退），再缩放到目标分辨率
  const aspectCrop = `crop=w='min(iw,ih*${ar})':h='min(ih,iw/${ar})':x='(iw-ow)/2':y='(ih-oh)/2'`;
  // 美颜（规格【四】 executable 部分）：bilateral 边缘保持磨皮（保留五官轮廓）+ 肤色提亮；全局近似非 face-mask，如实标
  const bp = Math.max(0, Math.min(100, Number(opts.beautyPct) || 0));
  const smooth = bp > 0 ? `bilateral=sigmaS=${(bp * 0.05).toFixed(2)}:sigmaR=0.1,` : '';
  const bright = (0.02 + 0.08 * bp / 100).toFixed(3);
  // M8 固定顺序：插帧48 → lanczos超分 → 磨皮 → filmic LUT → halation → deflicker → 颗粒8% → 提亮+暗角1.5% → 呼吸+weave → 裁画幅 → 回缩
  return [
    `[0:v]minterpolate=fps=48:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1`,
    `scale=${w}:${h}:flags=lanczos`,
    smooth + `lut3d=file='${lut}'`,
    `split=2[b][g];[g]gblur=sigma=10[bl];[b][bl]blend=all_mode=screen:all_opacity=0.10`,
    `deflicker=size=5:mode=am`,
    `noise=alls=8:allf=t+u`,
    `eq=brightness=${bright}`,
    `vignette=angle=0.113`,
    crop,
    aspectCrop,
    `scale=${w}:${h}:flags=lanczos`,
    `format=yuv420p[vout]`,
  ].join(',');
}

const POST_SUBSTITUTIONS = [
  { spec: 'RIFE v4.6 插帧 16→48fps', actual: 'ffmpeg minterpolate(mi_mode=mci) 48fps', reason: 'RIFE 是第三方 ML 运行时，铁律禁止引入', is_rife: false },
  { spec: 'Real-ESRGAN x4plus 超分 720p→1080p', actual: 'ffmpeg scale lanczos 保aspect 1080p', reason: 'Real-ESRGAN 是第三方 ML 运行时，铁律禁止引入', is_esrgan: false },
  { spec: '分风格 LUT 调色（人脸 mask 不偏色）', actual: 'node 生成 33 点 filmic(ACES近似+曝光匹配)分风格 .cube + ffmpeg lut3d', reason: '真 LUT 文件非 ML；人脸 mask 单独保护不可执行，靠低饱和偏移近似', is_lut: true, face_mask_applicable: false },
  { spec: 'halation 光学光晕', actual: 'ffmpeg split+gblur(sigma10)+blend screen opacity0.10', reason: '传统滤镜近似高光卤化，非扫描胶片 halation', is_halation: true },
  { spec: 'deflicker 去闪', actual: 'ffmpeg deflicker=size=5:mode=am', reason: '真去闪滤镜', is_deflicker: true },
  { spec: 'gate weave 片门微抖', actual: 'ffmpeg crop 慢正弦 ±0.2%宽 叠加呼吸 ±0.5%', reason: '真逐帧位移', is_weave: true },
  { spec: '35mm 胶片颗粒 强度8%', actual: 'ffmpeg noise=alls=8:allf=t+u', reason: '时序颗粒近似，非扫描胶片颗粒', is_scan_grain: false },
  { spec: '四周1.5%渐变暗角+中心提亮', actual: 'ffmpeg vignette angle=0.113 + eq brightness=0.02', reason: '角度/提亮近似，未逐像素标定 1.5%', provenance: 'estimate' },
  { spec: '±0.5% 呼吸微抖', actual: 'ffmpeg crop x/y 正弦振荡 ±0.5%宽', reason: '真逐帧位移', is_handheld: true },
  { spec: 'H.264 mp4 8Mbps', actual: 'ffmpeg libx264 -b:v 8M', reason: '真编码码率', is_8mbps: true },
];

/* ── M6 QA 双闸 · 像素闸阈值（方案§6：实测标定后固化） ──
 * 标定源：2026-11-18 四条真实验收成片 948 帧（quality/frames.analyze），见 D:/缓存/avp/qa-calibration-2026-11-18.json。
 * sharp 对这批 1080p+颗粒 输出饱和=1（p20=p80=1），故 sharpMin 取 0.9 留余量只抓严重虚焦；
 * flicker 是帧差口径，会把水面/雨/雪等合法运动算进去，故不用 P80 当过闸线（会误杀 case1 水面），
 * 改用「高于观测好片最大值 1.53 留余量」的上限 2.0 + 均值上限 0.30；flow 用 P80≈0.18 取 0.20 + 硬顶 0.32。 */
const QA_BASELINE = {
  sharpMin: 0.9, flickerMeanMax: 0.30, flickerHardMax: 2.0, flowMeanMax: 0.20, flowHardMax: 0.32, badFrameRatioMax: 0.02,
  provenance: 'calibrated', calibratedAt: '2026-11-18', samples: 4, frames: 948,
  note: 'sharp 饱和=1 取 0.9 余量；flicker 含合法运动故用上限而非 P80；flow 取 P80≈0.18→0.20',
};
function qaPixelGate(frames) {
  const n = frames.length || 1;
  const mean = (k) => frames.reduce((a, f) => a + (Number(f[k]) || 0), 0) / n;
  const max = (k) => frames.reduce((a, f) => Math.max(a, Number(f[k]) || 0), 0);
  const m = { sharpMean: +mean('sharp').toFixed(3), sharpMin: +frames.reduce((a, f) => Math.min(a, Number(f.sharp) || 0), Infinity).toFixed(3), flickerMean: +mean('flicker').toFixed(3), flickerMax: +max('flicker').toFixed(3), flowMean: +mean('flowResidual').toFixed(3), flowMax: +max('flowResidual').toFixed(3), badFrames: frames.filter((f) => f.status !== 'ok').length, frames: n };
  const reasons = [];
  if (m.sharpMin < QA_BASELINE.sharpMin) reasons.push('sharp 低于基线（虚焦）');
  if (m.flickerMean > QA_BASELINE.flickerMeanMax || m.flickerMax > QA_BASELINE.flickerHardMax) reasons.push('flicker 超基线（闪烁）');
  if (m.flowMean > QA_BASELINE.flowMeanMax || m.flowMax > QA_BASELINE.flowHardMax) reasons.push('flowResidual 超基线（运动崩坏/撕裂）');
  if (m.badFrames / n > QA_BASELINE.badFrameRatioMax) reasons.push('坏帧比例超基线');
  return { ...m, pass: reasons.length === 0, reasons, baseline: QA_BASELINE };
}

/* ── M1 分镜表（单镜闭环先落 1 行，多镜后续扩展） ── */
function buildShotTable(analysis, prompt, camera, duration) {
  return [{
    no: 1, subject: analysis.subject || prompt, action: analysis.mood || '静态呼吸', shotSize: analysis.shot || '中近景',
    camera: camera.zh, duration, mood: analysis.mood || '', light: analysis.light || '',
    firstFrameDesc: (analysis.subject || '') + '，' + (analysis.scene || ''), lastFrameDesc: '同首帧（固定机位微呼吸）',
  }];
}

/* ── M8 filmic 调色：读关键帧曝光 → ACES 近似 tonemap + 曝光匹配 + 风格轻 tint ── */
function readExposure(pngFile) {
  // 相对文件名 + cwd，绕开 Windows 盘符 ":" 在 filtergraph 里被当选项分隔符的坑（同 quality/frames.js）
  const rel = 'exposure-' + path.basename(pngFile) + '.txt';
  const statsFile = path.join(CINE_DIR, rel);
  try { fs.unlinkSync(statsFile); } catch { /* 首次无 */ }
  spawnSync(FFMPEG, ['-hide_banner', '-nostdin', '-i', pngFile, '-vf', 'signalstats,metadata=print:file=' + rel, '-f', 'null', '-'], { encoding: 'utf8', timeout: 60000, cwd: CINE_DIR });
  let yavg = 0.5;
  try {
    const txt = fs.readFileSync(statsFile, 'utf8');
    const m = txt.match(/YAVG=([\d.]+)/);
    if (m) yavg = Number(m[1]) / 255;
  } catch { /* 读不到用中性 0.5 */ }
  return yavg;
}
/** ACES 近似 filmic tonemap（shoulder/toe）+ 曝光匹配 + 风格 tint；真 .cube。 */
function buildFilmicCube(styleId, yavg = 0.5, size = 33) {
  const g = STYLE_GRADE[styleId] || STYLE_GRADE.cinema;
  const gain = Math.min(1.25, Math.max(0.8, 0.5 / Math.max(0.08, yavg))); // 曝光匹配：偏暗提、偏亮压
  const aces = (x) => { const v = x * gain; return Math.min(1, Math.max(0, (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14))); };
  const lines = [`TITLE "AVP filmic ${styleId} (ACES-approx, exposure-matched)"`, `LUT_3D_SIZE ${size}`, 'DOMAIN_MIN 0.0 0.0 0.0', 'DOMAIN_MAX 1.0 1.0 1.0'];
  for (let b = 0; b < size; b += 1) for (let g2 = 0; g2 < size; g2 += 1) for (let r = 0; r < size; r += 1) {
    const R = r / (size - 1), G = g2 / (size - 1), B = b / (size - 1);
    let oR = aces(R), oG = aces(G), oB = aces(B);
    const luma = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    const sh = Math.pow(1 - luma, 2), hi = Math.pow(luma, 2);
    oR += g.sh[0] * sh * 0.5 + g.hi[0] * hi * 0.5;
    oG += g.sh[1] * sh * 0.5 + g.hi[1] * hi * 0.5;
    oB += g.sh[2] * sh * 0.5 + g.hi[2] * hi * 0.5;
    const l2 = 0.2126 * oR + 0.7152 * oG + 0.0722 * oB;
    const sat = 1 + (g.sat - 1) * 0.6;
    oR = l2 + (oR - l2) * sat; oG = l2 + (oG - l2) * sat; oB = l2 + (oB - l2) * sat;
    const c = (x) => Math.min(1, Math.max(0, x)).toFixed(6);
    lines.push(`${c(oR)} ${c(oG)} ${c(oB)}`);
  }
  return lines.join('\n') + '\n';
}

/* ── M9 声音：ffmpeg 零依赖合成环境声床（非原生音画同步，如实标 synthetic） ── */
function ambientBedFor(styleId) {
  // 风格 → 环境声床配方（pink noise 低通 = 风/房间tone；正弦 pad + tremolo = 氛围垫）
  const beds = {
    cinema: { noise: 'anoisesrc=color=pink:amplitude=0.06', lp: 500, pad: 110 },
    doc: { noise: 'anoisesrc=color=pink:amplitude=0.04', lp: 350, pad: 90 },
    guofeng: { noise: 'anoisesrc=color=pink:amplitude=0.05', lp: 420, pad: 146 },
    cyber: { noise: 'anoisesrc=color=brown:amplitude=0.07', lp: 700, pad: 82 },
    dark: { noise: 'anoisesrc=color=brown:amplitude=0.05', lp: 260, pad: 65 },
    dream: { noise: 'anoisesrc=color=pink:amplitude=0.04', lp: 600, pad: 196 },
    anime: { noise: 'anoisesrc=color=pink:amplitude=0.04', lp: 500, pad: 164 },
    sunset: { noise: 'anoisesrc=color=pink:amplitude=0.05', lp: 450, pad: 130 },
    nightneon: { noise: 'anoisesrc=color=brown:amplitude=0.06', lp: 650, pad: 98 },
    snow: { noise: 'anoisesrc=color=pink:amplitude=0.04', lp: 380, pad: 110 },
    window: { noise: 'anoisesrc=color=pink:amplitude=0.03', lp: 320, pad: 146 },
    retro: { noise: 'anoisesrc=color=brown:amplitude=0.05', lp: 420, pad: 123 },
    sea: { noise: 'anoisesrc=color=pink:amplitude=0.06', lp: 550, pad: 87 },
    noir: { noise: 'anoisesrc=color=brown:amplitude=0.05', lp: 240, pad: 62 },
  };
  return beds[styleId] || beds.cinema;
}
function muxAmbientAudio(videoFile, outFile, styleId, durationSec) {
  const bed = ambientBedFor(styleId);
  const fc = `${bed.noise}:duration=${durationSec}[n];[n]lowpass=f=${bed.lp}[nl];sine=frequency=${bed.pad}:duration=${durationSec}[s];[s]tremolo=f=0.3:d=0.6,volume=0.10[sp];[nl][sp]amix=inputs=2:duration=longest,afade=t=in:d=1,afade=t=out:st=${Math.max(0, durationSec - 1.5)}:d=1.5[a]`;
  const args = ['-y', '-i', videoFile, '-filter_complex', fc, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', outFile];
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 5 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(outFile)) throw new CineError('CINE_AUDIO_FAILED', (r.stderr || '').slice(-300), { fc });
  return { file: outFile, bytes: fs.statSync(outFile).size, source: 'synthetic-ambient', native: false, bed: { noise: bed.noise, lowpass: bed.lp, pad: bed.pad }, provenance: 'measured' };
}

/* ── 传输层（可注入，自测用假传输零计费） ── */

async function raw(pathname, { method = 'GET', body, timeout = 60000, async: isAsync = false, headers: extraHeaders } = {}) {
  const k = key();
  if (!k) throw new CineError('DS_NO_API_KEY', '未设置 DASHSCOPE_API_KEY', {});
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const headers = { Authorization: 'Bearer ' + k, ...(extraHeaders || {}) };
    if (body) headers['Content-Type'] = 'application/json';
    if (isAsync) headers['X-DashScope-Async'] = 'enable';
    const res = await fetch(base() + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { throw new CineError('DS_HTTP_ERROR', 'DashScope 返回非 JSON', { status: res.status, snippet: text.slice(0, 200) }); }
    if (res.status === 401 || (data && data.code === 'InvalidApiKey')) throw new CineError('DS_INVALID_API_KEY', (data && data.message) || 'API key 无效', { status: res.status });
    if (!res.ok) throw new CineError('DS_HTTP_ERROR', (data && data.message) || `HTTP ${res.status}`, { status: res.status, code: (data && data.code) || null, path: pathname });
    return data;
  } catch (e) {
    if (e instanceof CineError) throw e;
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new CineError('DS_TIMEOUT', `请求 ${pathname} 超时`, { path: pathname });
    throw new CineError('DS_UNREACHABLE', `连不上 DashScope：${(e.cause && e.cause.code) || e.message}`, {});
  } finally { clearTimeout(timer); }
}

async function chat(messages, { model, timeout = 120000 } = {}) {
  const k = key();
  if (!k) throw new CineError('DS_NO_API_KEY', '未设置 DASHSCOPE_API_KEY', {});
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(compatBase() + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + k, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || chatModel(), messages }), signal: ac.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new CineError('DS_HTTP_ERROR', (data && data.message) || `HTTP ${res.status}`, { status: res.status, code: data && data.code });
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new CineError('CINE_EMPTY_REPLY', '模型没回内容', { model });
    return { text: content, usage: data.usage || null, model: data.model || model };
  } catch (e) {
    if (e instanceof CineError) throw e;
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new CineError('DS_TIMEOUT', 'chat 超时', {});
    throw new CineError('DS_UNREACHABLE', `连不上 compatible-mode：${(e.cause && e.cause.code) || e.message}`, {});
  } finally { clearTimeout(timer); }
}

/** 第 1 步：一句话 → 槽位分析。失败退规则轨并标 source:'rules'（不伪装 AI）。 */
async function analyze(prompt, transport) {
  const t = transport || { chat };
  const system = '你是电影摄影指导。把用户的一句话拆成槽位，只输出 JSON：{"subject":"主体","scene":"场景","light":"光线","mood":"情绪","camera":"镜头语言","shot":"画面类型","style_id":"cinematic-real|oriental-ancient|anime|cyber|ink|film-doc|commercial 之一","reason":"30字内中文理由"}。不要围栏不要解释。';
  try {
    const r = await t.chat([{ role: 'system', content: system }, { role: 'user', content: prompt }], { model: chatModel() });
    const j = parseJsonReply(r.text);
    if (!j.subject) throw new CineError('CINE_BAD_JSON', '分析缺 subject', { j });
    return { source: 'qwen', model: r.model, usage: r.usage, subject: j.subject, scene: j.scene || '', light: j.light || '', mood: j.mood || '', camera: j.camera || '', shot: j.shot || '', style_id: j.style_id || 'cinematic-real', reason: j.reason || '' };
  } catch (e) {
    if (e.code === 'DS_NO_API_KEY' || e.code === 'DS_INVALID_API_KEY') throw e;
    return { source: 'rules', model: null, error: { code: e.code, message: e.message }, subject: prompt, scene: '', light: '自然光', mood: '克制', camera: '固定机位', shot: '中近景', style_id: 'cinematic-real', reason: '规则轨兜底（非 AI）' };
  }
}

/** 第 3 步：五维评审。返回归一分 + 诊断 + 修复词。 */
async function judge(imageUrl, promptText, transport) {
  const t = transport || { chat };
  const ask = `你是苛刻的电影摄影评审。提示词：${promptText.slice(0, 600)}。按5维度各打0-2分（可一位小数，五维合计满分10）：fit提示词符合度/composition构图美学/light光影层次/face人脸或主体细节(有无崩坏/塑料/西化)/style风格还原度。另判断 western_face(是否明显西方面孔/混血感,true/false) 与 limb_deformity(是否肢体/手指畸形,true/false)。若画面有人脸，再按网红脸细则各打0-2分：faceDims{"refine五官精致度(大眼双眼皮睫毛高鼻梁唇形)","skin皮肤质感(白皙光滑无瑕疵均匀)","makeup妆容完成度(眉形腮红唇妆睫毛)","shape脸型轮廓(V脸鹅蛋脸对称流畅下巴精致)","photogenic上镜效果(镜头前好看网红氛围)"}，并给 faceFlags{"eyesSmall眼小/单睑","wideFace脸宽/方颌","skinBlemish皮肤瑕疵/毛孔","makeupLight妆容淡","western西方面孔","asym五官不对称"}(bool,无人脸则faceDims=null)。只输出JSON：{"dims":{"fit":n,"composition":n,"light":n,"face":n,"style":n},"western_face":bool,"limb_deformity":bool,"faceDims":{"refine":n,"skin":n,"makeup":n,"shape":n,"photogenic":n}|null,"faceFlags":{...}|null,"diagnosis":"一句中文诊断","fix":"建议追加的英文修饰词,逗号分隔"}`;
  const r = await t.chat([{ role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl } }, { type: 'text', text: ask }] }], { model: vlModel() });
  const s = normalizeScores(parseJsonReply(r.text));
  return { ...s, model: r.model, usage: r.usage, provenance: 'model-opinion' };
}

/** 审核 VL 闸（G1/G2/G3 结构/一致性/穿帮/水印）：不在画面内的项返回 null（不误否决）。 */
async function vlAudit(imageUrls, type, transport) {
  const t = transport || { chat };
  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).slice(0, 4);
  const ask = `你是严苛的影视质检员。检查这${urls.length}张${type === 'video' ? '视频抽帧' : '关键帧'}。只输出JSON：{"faceOk":bool|null,"handsOk":bool|null,"bodyOk":bool|null,"perspectiveOk":bool|null,"consistencyOk":bool|null,"artifactOk":bool|null,"phantomFace":bool|null,"extraPersonOk":bool|null,"watermark":bool|null,"gibberishText":bool|null,"composition":bool|null,"emotion":bool|null,"lightUnified":bool|null,"colorUnified":bool|null,"textureOk":bool|null,"whitespaceOk":bool|null,"motionRestraint":bool|null,"vlScore":0-10,"tags":[缺陷标签],"vlModel":"${vlModel()}"}。规则：五官/手指/肢体/透视/头颈肩连接崩坏=false；主体之外浮现清单外清晰人脸/多余人物 phantomFace=true 或 extraPersonOk=false；背景物体凭空出现/消失 consistencyOk=false；未授权logo watermark=true；乱码文字 gibberishText=true；画面内不存在的项（如无手）=null，不要猜。氛围审美项：lightUnified主光方向统一/轮廓光自然、colorUnified色调统一无突兀色偏肤色自然、textureOk无过度平滑塑料感颗粒光晕适度、whitespaceOk竖屏主体位置合理留白不拥挤、motionRestraint运动克制无快切崩坏。tags 从 blur,faceDefect,handDefect,bodyDefect,perspectiveBreak,inconsistency,phantomFace,extraPerson,watermark,gibberishText,artifact 中选。`;
  const content = [{ type: 'text', text: ask }, ...urls.map((u) => ({ type: 'image_url', image_url: { url: u } }))];
  const r = await t.chat([{ role: 'user', content }], { model: vlModel() });
  const j = parseJsonReply(r.text);
  return { ...j, vlModel: r.model };
}

/** 跑一道审核闸 → QAReport（注入 analyze/vl，自测可零计费）。
 *  视频结构/一致性需抽帧公网 URL 或人工（本机无帧托管）→ 视频 VL 置 null → 这些项 REVIEW，不假装自动判过。 */
function runAudit(T, file, type, spec, urls, styleId) {
  return AUDIT.auditMedia({ file, type, spec, imageUrls: urls, analyze: T.qa, vl: type === 'image' ? T.vlAudit : null, threshold: AUDIT.thresholdFor(imageModel(), spec && spec.size, styleId) });
}

/** 第 2/3 步出图：qwen-image 同步文生图。返回 {url, usage, request}。seed/size 真写入请求。 */
async function genImage(prompt, negative, transport, opts = {}) {
  const t = transport || { raw };
  const mk = (size) => {
    const parameters = { size, n: 1, negative_prompt: negative, prompt_extend: false, watermark: false };
    if (opts.seed != null) parameters.seed = opts.seed;
    return { model: imageModel(), input: { messages: [{ role: 'user', content: [{ text: prompt }] }] }, parameters };
  };
  let request = mk(opts.size || BASELINES.keyframe.size);
  let data;
  try {
    data = await t.raw('/services/aigc/multimodal-generation/generation', { method: 'POST', body: request, timeout: 240000 });
  } catch (e) {
    // 尺寸不被该模型支持 → 回退到已验证尺寸（如实记录，不假装原尺寸生效）
    if (opts.fallbackSize && opts.fallbackSize !== request.parameters.size && /size|resolution|parameter|range/i.test(e.message || '')) {
      request = mk(opts.fallbackSize);
      request.fellBackFrom = opts.size;
      data = await t.raw('/services/aigc/multimodal-generation/generation', { method: 'POST', body: request, timeout: 240000 });
    } else throw e;
  }
  const content = data && data.output && data.output.choices && data.output.choices[0] && data.output.choices[0].message && data.output.choices[0].message.content;
  const url = content && content[0] && content[0].image;
  if (!url) throw new CineError('CINE_NO_IMAGE', '文生图没返回图像 URL', { body: data });
  return { url, usage: data.usage || null, request, requestId: data.request_id || null };
}

async function downloadTo(url, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.part';
  const res = await fetch(url);
  if (!res.ok) throw new CineError('CINE_DOWNLOAD_FAILED', '下载失败 HTTP ' + res.status, { url });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  fs.renameSync(tmp, file);
  return fs.statSync(file).size;
}

function ffprobeJson(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new CineError('CINE_FFPROBE_FAILED', (r.stderr || '').slice(0, 300), { file });
  return JSON.parse(r.stdout);
}

/** 第 6 步：ffmpeg 电影级后处理。返回 {file, bytes, probe, filter, substitutions, target}。 */
function postProcess(srcFile, dstFile, lutFile, opts = {}) {
  const srcProbe = ffprobeJson(srcFile);
  const sv = (srcProbe.streams || []).find((s) => s.codec_type === 'video') || {};
  const target = postTargetSize(Number(sv.width) || 1080, Number(sv.height) || 1920, opts.ratio);
  const filter = postFilterChain(lutFile, target.w, target.h, { beautyPct: opts.beautyPct });
  const args = ['-y', '-i', srcFile, '-filter_complex', filter, '-map', '[vout]', '-c:v', 'libx264', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '16M', '-preset', 'slow', '-r', '48', '-an', '-movflags', '+faststart', dstFile];
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(dstFile)) throw new CineError('CINE_POST_FAILED', (r.stderr || '').slice(-400), { filter });
  return { file: dstFile, bytes: fs.statSync(dstFile).size, probe: ffprobeJson(dstFile), filter, substitutions: POST_SUBSTITUTIONS, target, srcProbe };
}

/** 成片进云盘：sync 客户端禁止 CREATE .mp4（EPERM），先编码在缓存再 renameSync（实测可行）。 */
function publishToCloud(cacheFile, note) {
  const safe = String(note || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = 'cine-' + (safe ? safe + '-' : '') + stamp;
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, name + '.mp4');
  fs.renameSync(cacheFile, file);
  return { file, bytes: fs.statSync(file).size };
}

/**
 * 七步 orchestrator。hooks: {signal, onProgress, onSubmitted}。
 * transport 可注入 {chat, raw, genImage, judge, downloadTo, postProcess, publishToCloud, i2vSubmit, i2vStatus}。
 */
async function runCine(job, hooks = {}, transport = {}) {
  const prompt = String(job.cinePrompt || job.note || '').trim();
  if (!prompt) throw new CineError('CINE_EMPTY_PROMPT', '一句话为空：先写描述', {});
  const g0 = AUDIT.inputGate({ prompt, style: job.cineStyle });
  if (!g0.pass) throw new CineError('CINE_INPUT_GATE', 'G0 输入闸不通过：' + g0.problems.join('；') + '（退回补全，不计生成）', { problems: g0.problems });
  const T = {
    chat, raw, genImage, judge, downloadTo, postProcess, publishToCloud, ffprobeJson,
    i2vSubmit: (request) => raw('/services/aigc/video-generation/video-synthesis', { method: 'POST', body: request, async: true, timeout: 60000 }),
    i2vStatus: (taskId) => raw('/tasks/' + encodeURIComponent(taskId), { timeout: 30000 }),
    qa: (file) => QA.analyze(file, {}),
    muxAudio: muxAmbientAudio,
    vlAudit: (u, t) => vlAudit(u, t, { chat }),
    ...transport,
  };
  const prog = (stage, text, extra) => hooks.onProgress && hooks.onProgress({ percent: null, stage, text, ...(extra || {}) });
  const alive = () => { if (hooks.signal && hooks.signal.aborted) throw new CineError('JOB_CANCELED', '已取消', {}); };
  const dir = path.join(CINE_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const ckptFile = path.join(dir, 'checkpoint.json');
  const readCkpt = () => { try { return JSON.parse(fs.readFileSync(ckptFile, 'utf8')); } catch { return null; } };
  const writeCkpt = (c) => { try { fs.writeFileSync(ckptFile, JSON.stringify(c), 'utf8'); } catch { /* 检查点失败不阻断 */ } };
  const prior = job.cineResume ? readCkpt() : null;

  const styleId = styleFor(job.cineStyle || (prior && prior.styleId) || '');
  const age = detectAge(prompt);
  const ratio = ratioFor(prompt, job.cineRatio || (prior && prior.ratio));
  const size = keyframeSize(prompt, ratio);
  const sizeFallback = ratioFallback(prompt, ratio);
  const seeds = (prior && prior.seeds) || groupSeeds(8);
  const sampling = SAMPLING[styleId] || SAMPLING.cinema;
  const camera = detectCamera(prompt);
  const recipe = AESTH.recipeById(job.cineTheme) || (AESTH.matchTheme(prompt) || {}).theme || null;
  const gradeKey = recipe ? recipe.grade : styleId;
  const aesthSuffix = AESTH.promptSuffix(recipe);
  const aesthNeg = AESTH.negativeAdd(recipe);
  const beautyBase = job.cineBeauty != null ? Math.max(0, Math.min(100, Number(job.cineBeauty) || 0)) : beautyDefault(styleId);
  const report = {
    at: new Date().toISOString(), prompt, styleId, age, ratio, baselines: BASELINES, substitutions: POST_SUBSTITUTIONS, groups: [], warnings: [], audit: [],
    aesthetics: recipe ? { themeId: recipe.id, name: recipe.name, light: recipe.light, color: recipe.color, lens: recipe.lens, texture: recipe.texture, motion: recipe.motion, soundMood: recipe.soundMood, grade: gradeKey, params: AESTH.paramRules(recipe), ratioSuggested: recipe.ratio, durationRequested: recipe.duration } : null,
    styleWords: { id: styleId, pos: STYLE_WORDS[styleId].pos, neg: STYLE_WORDS[styleId].neg, mounted: true },
    face: { mounted: !FACE_STYLE_EXCLUDE.has(styleId), age, tech: FACE_TECH },
    sampling: { ...sampling, size, applicable: false, reason: '云端 qwen-image 不暴露采样器/CFG/步数旋钮；尺寸真生效', provenance: 'measured' },
    seeds, camera,
    keyframeBaselineNote: { requested: { ...sampling, size }, applicable: false, reason: '本机无 ComfyUI（实测 ECONNREFUSED），云端 qwen-image 不暴露采样器/CFG/步数/LoRA 旋钮；尺寸真生效', provenance: 'measured' },
    resumed: !!prior,
  };

  prog('analyze', '正在分析你的描述...');
  const analysis = await analyze(prompt, T);
  if (!job.cineStyle && !prior) report.styleId = styleFor(analysis.style_id);
  report.analysis = analysis;
  report.shots = buildShotTable(analysis, prompt, camera, BASELINES.video.duration);
  alive();

  // 第 2+3 步：8 组独立打磨。规格【四】：≥9 通过 / 8~8.9 候选 / <8 重试≤3；3 次仍<8 保留最高分标"质量一般"。
  const doneGroups = (prior && prior.groups) || [];
  for (const group of GROUPS) {
    alive();
    const reused = doneGroups.find((g) => g.id === group.id && g.best);
    if (reused) { report.groups.push(reused); if (hooks.onGroup) hooks.onGroup({ id: reused.id, name: reused.name, file: reused.best.file, total: reused.best.scores.total, dims: reused.best.scores.dims, passed: reused.passed, attempts: reused.attempts.length }); continue; }
    prog('keyframes', `正在打磨8组关键帧（第${group.id}/8组）...`, { group: group.id });
    const g = { id: group.id, name: group.name, attempts: [], belowTarget: false, seed: seeds[group.id - 1] };
    let extraTokens = '', extraNeg = '', best = null, loraWeight = clampLora(job.cineLoraWeight), beautyBoost = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      alive();
      const p = buildGroupPrompt(analysis, group, [aesthSuffix, extraTokens].filter(Boolean).join(', '), { styleId: report.styleId, prompt, age });
      const neg = buildGroupNegative([aesthNeg, extraNeg].filter(Boolean).join(', '), { styleId: report.styleId }, analysis);
      const img = await T.genImage(p, neg, T, { seed: g.seed, size, fallbackSize: sizeFallback });
      const scores = await T.judge(img.url, p, T);
      const rec = { attempt, prompt: p, negative: neg, imageUrl: img.url, usage: img.usage, scores, requestId: img.requestId, seed: g.seed, loraWeight };
      g.attempts.push(rec);
      if (!best || scores.total > best.scores.total) best = rec;
      const faceOk = scores.faceTotal == null || scores.faceTotal >= FACE_TECH.face_quality_gate.regen_below; // 无人脸不卡脸闸
      if (scores.total >= 8 && faceOk) break; // ≥8 且脸≥7 才作候选
      if (attempt === 4) { g.belowTarget = true; report.warnings.push({ code: 'CINE_GROUP_BELOW_TARGET', text: `第${group.id}组重试3次仍 总${best.scores.total}/脸${best.scores.faceTotal == null ? '—' : best.scores.faceTotal}（总<8 或 脸<7），保留最高分 attempt ${best.attempt}，标注质量一般，不谎报达标`, group: group.id }); break; }
      const fix = diagnoseFix(scores, scores.fix, scores.diagnosis);
      const faceFix = diagnoseFaceFix(scores);
      rec.fix = fix; rec.faceFix = faceFix;
      extraTokens = [fix.tokens, faceFix.tokens].filter(Boolean).join(', ');
      extraNeg = [fix.negativeAdd, faceFix.negativeAdd].filter(Boolean).join(', ');
      beautyBoost = Math.max(beautyBoost, faceFix.beautyAdd);
      if (faceFix.loraWeight != null) loraWeight = faceFix.loraWeight; // 西方面孔→LoRA 提 0.85（记录口径）
      else if (fix.loraWeight != null) loraWeight = fix.loraWeight;
      prog('keyframes', `第${group.id}组${faceFix.hit.length ? '人脸(' + faceFix.hit.join('/') + ')' : (fix.dimZh || '质感')}不够，重新生成...`, { group: group.id, attempt: attempt + 1, dim: fix.dim, rule: fix.rule, face: faceFix.hit });
    }
    const file = path.join(dir, `g${group.id}.png`);
    const bytes = await T.downloadTo(best.imageUrl, file);
    g.best = { attempt: best.attempt, file, bytes, imageUrl: best.imageUrl, scores: best.scores, prompt: best.prompt, negative: best.negative, seed: g.seed, loraWeight };
    g.beautyBoost = beautyBoost;
    // G1 生图静态闸：信号量 + VL 结构/穿帮 → 三态；REJECT 淘汰不入候选池
    const g1 = await runAudit(T, file, 'image', { size, ratio: report.ratio }, [best.imageUrl], report.styleId);
    g.audit = g1; report.audit.push(g1);
    g.rejected = g1.decision === 'REJECT';
    if (g.rejected) report.warnings.push({ code: 'CINE_G1_REJECT', text: `第${group.id}组关键帧 G1 否决：${g1.vetoHits.join(',') || g1.reason}（淘汰，不入候选）`, group: group.id });
    g.passed = !g.belowTarget && !g.rejected;
    g.qualityLabel = best.scores.total >= 9 ? 'pass' : best.scores.total >= 8 ? 'candidate' : '质量一般';
    report.groups.push(g);
    writeCkpt({ styleId: report.styleId, ratio: report.ratio, seeds, groups: report.groups });
    if (hooks.onGroup) hooks.onGroup({ id: g.id, name: g.name, file: g.best.file, total: g.best.scores.total, dims: g.best.scores.dims, passed: g.passed, attempts: g.attempts.length });
    prog('keyframes', `正在打磨8组关键帧（第${group.id}/8组）...`, { group: group.id, done: true, total: best.scores.total });
  }
  alive();

  // 第 4 步：8 组全部≥8 后选总分最高；给用户改选窗口，以用户选择为准
  prog('pick', '8组精品已就绪，正在选最优...');
  const eligible = report.groups.map((g, i) => ({ g, i })).filter((x) => !x.g.rejected);
  if (!eligible.length) throw new CineError('CINE_ALL_REJECTED', 'G1 全部关键帧被否决，无可用候选（不流入剪辑）', { audit: report.audit.map((a) => ({ decision: a.decision, veto: a.vetoHits })) });
  const pickIndex = eligible.reduce((bi, x, k, arr) => (x.g.best.scores.total > arr[bi].g.best.scores.total ? k : bi), 0);
  const pickAbs = eligible[pickIndex].i;
  report.pick = { index: pickAbs, source: 'model', total: report.groups[pickAbs].best.scores.total };
  if (hooks.onPick) {
    const decided = await hooks.onPick(pickAbs, eligible.map((x) => ({ id: x.g.id, name: x.g.name, total: x.g.best.scores.total })));
    if (Number.isInteger(decided) && decided >= 0 && decided < report.groups.length && !report.groups[decided].rejected && decided !== pickAbs) {
      report.pick = { index: decided, source: 'user', total: report.groups[decided].best.scores.total };
    }
  }
  const chosen = report.groups[report.pick.index];
  alive();

  // 第 5 步：i2v（首帧=最优关键帧，5s 720p，画幅跟随；运动/负面词逐字；默认固定机位，仅明确运镜才加）
  prog('i2v', '正在图生视频...');
  const motionPrompt = camera.fixed ? MOTION_PROMPT : MOTION_PROMPT + ', ' + camera.move;
  const i2vRequest = {
    model: i2vModel(),
    input: { img_url: chosen.best.imageUrl, prompt: motionPrompt, negative_prompt: MOTION_NEG },
    parameters: { resolution: '720P', duration: 5, prompt_extend: false },
  };
  report.i2v = { request: i2vRequest, motionPrompt, motionNegative: MOTION_NEG, camera, fpsRequested: BASELINES.video.fps };
  let sub = null, taskId = (prior && prior.i2vTaskId) || null;
  if (taskId) {
    report.i2v.resumedTaskId = taskId; // 续跑复用已提交云端任务，不重投（防重复计费）
  } else {
    try {
      sub = await T.i2vSubmit(i2vRequest);
      taskId = sub && sub.output && sub.output.task_id;
      if (!taskId) throw new CineError('DS_SUBMIT_FAILED', 'i2v 创建任务没返回 task_id', { body: sub });
    } catch (e) {
      // 提交期失败（尚未计费）→ 切备用云端模型；两通道都不可用明确报错，不出占位假视频
      report.warnings.push({ code: 'CINE_I2V_PRIMARY_FAILED', text: '主 i2v 通道提交失败：' + e.message + '，切备用云端', primary: i2vModel() });
      const backupReq = { ...i2vRequest, model: process.env.AVP_CINE_I2V_BACKUP || 'wan2.2-i2v-plus' };
      try {
        sub = await T.i2vSubmit(backupReq);
        taskId = sub && sub.output && sub.output.task_id;
        if (!taskId) throw new CineError('DS_SUBMIT_FAILED', '备用 i2v 也没返回 task_id', { body: sub });
        report.i2v.request = backupReq; report.i2v.backup = true;
      } catch (e2) {
        throw new CineError('CINE_I2V_BOTH_CHANNELS_FAILED', '主/备 i2v 云端通道均不可用：' + e2.message, { primary: e.message, backup: e2.message });
      }
    }
    report.i2v.taskId = taskId;
    writeCkpt({ styleId: report.styleId, ratio: report.ratio, seeds, groups: report.groups, i2vTaskId: taskId });
    if (hooks.onSubmitted) hooks.onSubmitted({ taskId, meta: { dsRequest: report.i2v.request, requestId: (sub && sub.request_id) || null } });
  }
  const t0 = Date.now();
  let st = null;
  for (;;) {
    alive();
    if (Date.now() - t0 > 20 * 60 * 1000) throw new CineError('DS_TIMEOUT', 'i2v 等待超过 20 分钟', { taskId });
    st = await T.i2vStatus(taskId);
    const state = st && st.output && st.output.task_status;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED') throw new CineError('DS_TASK_FAILED', (st.output && st.output.message) || 'i2v 云端失败', { taskId, code: st.output && st.output.code });
    if (state === 'CANCELED') throw new CineError('JOB_CANCELED', '云端任务已取消', { taskId });
    if (state === 'UNKNOWN') throw new CineError('DS_TASK_UNKNOWN', 'task_id 查不到', { taskId });
    prog('i2v', '正在图生视频...', { taskId, cloudState: state });
    await new Promise((r) => setTimeout(r, 5000));
  }
  const videoUrl = st.output.video_url;
  if (!videoUrl) throw new CineError('DS_TASK_FAILED', 'SUCCEEDED 但没返回 video_url', { taskId });
  report.i2v.cloudTimes = { submit: st.output.submit_time, end: st.output.end_time };
  report.i2v.usage = st.usage || null;
  report.i2v.ms = Date.now() - t0;
  const rawFile = path.join(dir, 'i2v-raw.mp4');
  await T.downloadTo(videoUrl, rawFile);
  report.i2v.rawProbe = await T.ffprobeJson(rawFile);
  const rv = (report.i2v.rawProbe.streams || []).find((s) => s.codec_type === 'video') || {};
  const srcFps = rv.r_frame_rate ? Number(rv.r_frame_rate.split('/')[0]) / Number(rv.r_frame_rate.split('/')[1]) : null;
  report.i2v.measured = { width: rv.width, height: rv.height, fps: srcFps, frames: rv.nb_frames };
  if (srcFps != null && srcFps !== BASELINES.video.fps) {
    report.warnings.push({ code: 'CINE_FPS_DEVIATION', text: `规格基线 ${BASELINES.video.fps}fps，实测 i2v 输出 ${srcFps}fps（measured），后处理按实测源插帧到 48fps`, requested: BASELINES.video.fps, measured: srcFps });
  }
  alive();

  // G2 视频动态闸：时序信号量（结构项视频需抽帧URL/人工 → REVIEW）；REJECT 不流入后处理/剪辑
  const g2 = await runAudit(T, rawFile, 'video', { duration: BASELINES.video.duration, fps: srcFps, ratio: report.ratio }, null, report.styleId);
  report.i2v.audit = g2; report.audit.push(g2);
  if (g2.decision === 'REJECT') throw new CineError('CINE_G2_REJECT', 'G2 视频动态闸否决：' + (g2.vetoHits.join(',') || g2.reason) + '（不流入剪辑，可人工重试）', { veto: g2.vetoHits, tags: g2.tags });
  alive();

  // 第 6 步：固定顺序电影级后处理（M8 filmic LUT + halation/deflicker/weave，ffmpeg 真实替代）
  prog('post', '正在电影级后处理...');
  const exposure = readExposure(chosen.best.file);
  const lutFile = path.join(dir, `${gradeKey}-filmic.cube`);
  fs.writeFileSync(lutFile, buildFilmicCube(gradeKey, exposure, 33), 'utf8');
  const cacheOut = path.join(dir, 'cine-final.mp4');
  const beautyPct = Math.max(0, Math.min(100, beautyBase + (chosen.beautyBoost || 0)));
  const post = await T.postProcess(rawFile, cacheOut, lutFile, { ratio: report.ratio, beautyPct });
  report.beauty = {
    smoothPct: beautyPct, brightenPct: 8, base: beautyBase, boost: chosen.beautyBoost || 0, expert: job.cineBeauty != null ? Number(job.cineBeauty) : null,
    loraWeight: chosen.best.loraWeight, perStyleDefault: beautyDefault(report.styleId),
    executed: { smooth: 'ffmpeg bilateral(边缘保持磨皮,全局近似非face-mask)', brighten: 'eq brightness(全局近似)' },
    notExecuted: ['slim瘦脸8%', 'eye大眼5%', 'underEye眼下', 'face-mask单独保护', 'FaceDetailer', 'LoRA'],
    applicable: false, reason: FACE_TECH.reason, provenance: 'measured',
  };
  report.post = { engine: 'ffmpeg', filter: post.filter, substitutions: post.substitutions, probe: post.probe, target: post.target, lut: `${gradeKey}-filmic.cube 33pt`, order: ['interpolate48', 'upscale-lanczos', 'filmic-lut', 'halation', 'deflicker', 'grain8', 'vignette1.5+lift', 'shake0.5+weave0.2', 'encode-h264-8M'] };
  report.gradePreset = { id: `filmic-${gradeKey}`, type: '调色', filmic: true, acesApprox: true, exposureMatched: +exposure.toFixed(3), halation: { gblur: 10, screen: 0.10 }, deflicker: { size: 5, mode: 'am' }, weave: 0.002, shake: 0.005, styleTint: gradeKey, theme: recipe ? recipe.id : null, reusable: true };
  try { fs.writeFileSync(path.join(dir, 'grade-preset.json'), JSON.stringify(report.gradePreset, null, 2), 'utf8'); } catch { /* 不阻断 */ }
  alive();

  // M6 QA 双闸：像素闸（本机标定基线）+ 审美闸（VL 选优分）。不达标标记淘汰原因，不自动重投计费。
  prog('post', '正在成片 QA 双闸...');
  const qaRes = await T.qa(cacheOut);
  const pixel = qaRes && qaRes.ok ? qaPixelGate(qaRes.frames || []) : { pass: false, unavailable: true, reasons: ['QA 不可用：' + ((qaRes && qaRes.code) || 'unknown')] };
  const aesthetic = { total: chosen.best.scores.total, pass: chosen.best.scores.total >= 8, source: 'model-opinion' };
  // G3 成片终审闸：全片信号量复扫 + 三态（结构项视频→REVIEW 人工）
  const g3 = await runAudit(T, cacheOut, 'video', { duration: BASELINES.video.duration, fpsOut: 48, ratio: report.ratio }, null, report.styleId);
  report.audit.push(g3);
  report.qa = { pixel, aesthetic, pass: !!(pixel.pass && aesthetic.pass && g3.decision !== 'REJECT'), rejectReasons: [...(pixel.reasons || []), ...g3.vetoHits], decision: g3.decision, tier: g3.tier, total: g3.total, vetoHits: g3.vetoHits, tags: g3.tags, review: g3.review, scores: g3.scores, thresholdVersion: g3.thresholdVersion };
  if (!report.qa.pass) report.warnings.push({ code: 'CINE_QA_GATE_FAIL', text: '成片 QA 双闸未过：' + (pixel.reasons || []).join('；') + '（不自动重投计费，可人工重试/换候选）', reasons: pixel.reasons });
  if (g3.decision === 'REVIEW') report.warnings.push({ code: 'CINE_G3_REVIEW', text: 'G3 终审存疑进人工复核：' + g3.review.join('；'), review: g3.review });
  alive();

  // M9 声音：ffmpeg 零依赖合成环境声床混流（非原生音画同步，如实标 synthetic）；失败标记无声
  const muxed = path.join(dir, 'cine-final-audio.mp4');
  let audio = null;
  try { audio = await T.muxAudio(cacheOut, muxed, gradeKey, BASELINES.video.duration); }
  catch (e) { report.warnings.push({ code: 'CINE_AUDIO_SKIPPED', text: '环境声混流失败，成片标记无声：' + e.message }); }
  report.audio = audio || { source: 'none', native: false, silent: true };
  const finalFile = audio ? muxed : cacheOut;
  alive();

  // 第 7 步：成片进作品库目录 + 8 帧保留 + 完整参数 JSON
  const pub = await T.publishToCloud(finalFile, prompt);
  report.output = pub;
  report.candidates = report.groups.map((g, i) => ({ id: g.id, name: g.name, file: g.best.file, total: g.best.scores.total, dims: g.best.scores.dims, passed: g.passed, qualityLabel: g.qualityLabel, attempts: g.attempts.length, seed: g.seed, picked: i === report.pick.index }));
  report.params = {
    sampler: sampling.sampler, cfg: sampling.cfg, steps: sampling.steps, size,
    lora: { id: FACE_TECH.lora.id, weight: chosen.best.loraWeight, applicable: false },
    seeds, duration: BASELINES.video.duration, fpsRequested: BASELINES.video.fps, fpsOut: 48,
    styleId: report.styleId, age, camera: camera.zh, bitrate: '8M', ratio: report.ratio,
  };
  report.paramsFile = path.join(dir, 'cine-params.json');
  try { fs.writeFileSync(report.paramsFile, JSON.stringify(report.params, null, 2), 'utf8'); } catch { /* 不阻断 */ }
  report.modelChain = { analyze: chatModel(), judge: vlModel(), image: imageModel(), i2v: report.i2v.request.model, post: 'ffmpeg', qa: 'quality/frames(像素)+VL(审美)', audio: report.audio.source };
  report.retries = report.groups.reduce((a, g) => a + Math.max(0, g.attempts.length - 1), 0);
  report.status = report.groups.some((g) => g.belowTarget) || !report.qa.pass ? 'partial' : 'success';
  // G4 入库合规闸（作品库入库前）：元数据完整性 + 水印/乱码
  const g4 = AUDIT.complianceGate(report);
  report.compliance = g4;
  if (!g4.pass) report.warnings.push({ code: 'CINE_G4_COMPLIANCE', text: 'G4 入库合规存疑：' + g4.problems.join('；'), problems: g4.problems });
  const v = (post.probe.streams || []).find((s) => s.codec_type === 'video') || {};
  return {
    taskId,
    images: report.candidates,
    output: { file: pub.file, bytes: pub.bytes, videoUrl, usage: st.usage || null, cloudTimes: report.i2v.cloudTimes, fps: Number(v.r_frame_rate ? v.r_frame_rate.split('/')[0] / v.r_frame_rate.split('/')[1] : 48), width: v.width, height: v.height },
    meta: { dsRequest: report.i2v.request, cineReport: report },
  };
}

/* ── M1 多镜分镜 / M4 一致性 / M7 组接（方案§7 第二步） ── */
const SHOT_SIZES = [
  { zh: '广角环境', en: 'wide angle environmental shot, subject within vast scene, deep focus' },
  { zh: '中景', en: 'medium shot, waist up, subject centered with environment' },
  { zh: '特写', en: 'extreme close-up, face detail, shallow depth of field' },
];
function buildMultiShots(analysis, prompt, camera, duration) {
  const lock = [analysis.subject, analysis.scene, analysis.light, 'same character, same outfit, same location, consistent color grade'].filter(Boolean).join('，');
  return SHOT_SIZES.map((s, i) => ({
    no: i + 1, subject: analysis.subject || prompt, action: analysis.mood || '静态呼吸', shotSize: s.zh, shotSizeEn: s.en,
    camera: camera.zh, duration, mood: analysis.mood || '', light: analysis.light || '',
    firstFrameDesc: (analysis.subject || '') + '，' + (analysis.scene || '') + '，' + s.zh, lastFrameDesc: '同首帧（固定机位微呼吸）',
    lock,
  }));
}
function extractLastFrame(videoFile, pngFile) {
  const r = spawnSync(FFMPEG, ['-y', '-v', 'error', '-sseof', '-0.1', '-i', videoFile, '-vframes', '1', pngFile], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0 || !fs.existsSync(pngFile)) throw new CineError('CINE_LASTFRAME_FAILED', (r.stderr || '').slice(-200), { videoFile });
  return pngFile;
}
const probeDuration = (probe) => {
  const v = (probe.streams || []).find((s) => s.codec_type === 'video') || {};
  const fps = v.r_frame_rate ? Number(v.r_frame_rate.split('/')[0]) / Number(v.r_frame_rate.split('/')[1]) : 48;
  return (Number(v.nb_frames) || 0) / (fps || 48);
};
/** M7 组接：xfade 交叉溶解优先，失败退硬切 concat（如实告警）。输入需同分辨率/帧率。 */
function concatShots(files, durations, crossfade, outFile) {
  const cf = Math.max(0.2, Math.min(crossfade, ...durations.map((d) => d / 2)));
  let graph = '';
  let acc = durations[0];
  let prev = '[0:v]';
  for (let i = 1; i < files.length; i += 1) {
    const out = i === files.length - 1 ? '[vx]' : `[v${i}]`;
    graph += `${prev}[${i}:v]xfade=transition=fade:duration=${cf}:offset=${(acc - cf).toFixed(3)}${out};`;
    acc = acc + durations[i] - cf;
    prev = out;
  }
  graph += `${prev}format=yuv420p[vout]`;
  const args = ['-y', ...files.flatMap((f) => ['-i', f]), '-filter_complex', graph, '-map', '[vout]', '-c:v', 'libx264', '-b:v', '8M', '-preset', 'slow', '-r', '48', '-an', '-movflags', '+faststart', outFile];
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (r.status === 0 && fs.existsSync(outFile)) return { file: outFile, bytes: fs.statSync(outFile).size, transition: 'crossfade', crossfade: cf, totalDuration: +acc.toFixed(3) };
  // 硬切兜底
  const listFile = outFile + '.concat.txt';
  fs.writeFileSync(listFile, files.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'), 'utf8');
  const r2 = spawnSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'libx264', '-b:v', '8M', '-preset', 'slow', '-r', '48', '-an', '-movflags', '+faststart', outFile], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
  if (r2.status !== 0 || !fs.existsSync(outFile)) throw new CineError('CINE_CONCAT_FAILED', (r2.stderr || r.stderr || '').slice(-300), { graph });
  return { file: outFile, bytes: fs.statSync(outFile).size, transition: 'hardcut', crossfade: 0, totalDuration: +durations.reduce((a, b) => a + b, 0).toFixed(3), fallbackReason: (r.stderr || '').slice(-200) };
}

/** i2v 提交+轮询+下载+探针（单镜/多镜共用）。提交成功后不重投。 */
async function i2vRun(T, request, hooks, prog, alive, dir, tag) {
  const sub = await T.i2vSubmit(request);
  const taskId = sub && sub.output && sub.output.task_id;
  if (!taskId) throw new CineError('DS_SUBMIT_FAILED', 'i2v 没返回 task_id', { body: sub });
  if (hooks.onSubmitted) hooks.onSubmitted({ taskId, meta: { dsRequest: request, requestId: sub.request_id || null } });
  const t0 = Date.now();
  let st = null;
  for (;;) {
    alive();
    if (Date.now() - t0 > 20 * 60 * 1000) throw new CineError('DS_TIMEOUT', 'i2v 超 20 分钟', { taskId });
    st = await T.i2vStatus(taskId);
    const state = st && st.output && st.output.task_status;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED') throw new CineError('DS_TASK_FAILED', (st.output && st.output.message) || 'i2v 云端失败', { taskId });
    if (state === 'CANCELED') throw new CineError('JOB_CANCELED', '云端已取消', { taskId });
    if (state === 'UNKNOWN') throw new CineError('DS_TASK_UNKNOWN', 'task_id 查不到', { taskId });
    prog('i2v', '正在图生视频...', { taskId, cloudState: state });
    await new Promise((r) => setTimeout(r, 5000));
  }
  const videoUrl = st.output.video_url;
  if (!videoUrl) throw new CineError('DS_TASK_FAILED', 'SUCCEEDED 无 video_url', { taskId });
  const rawFile = path.join(dir, tag + '-raw.mp4');
  await T.downloadTo(videoUrl, rawFile);
  const probe = await T.ffprobeJson(rawFile);
  const v = (probe.streams || []).find((s) => s.codec_type === 'video') || {};
  const fps = v.r_frame_rate ? Number(v.r_frame_rate.split('/')[0]) / Number(v.r_frame_rate.split('/')[1]) : null;
  return { taskId, rawFile, probe, videoUrl, usage: st.usage || null, ms: Date.now() - t0, measured: { width: v.width, height: v.height, fps, frames: v.nb_frames } };
}

/** 多镜头短片 orchestrator：M1 分镜 → 每镜 M3 选帧/M5 候选 → M4 锁定 → i2v → M8 逐镜 filmic → M7 组接 → M9 声 → M6 终审 → M10 入库。 */
async function runCineMultiShot(job, hooks = {}, transport = {}) {
  const prompt = String(job.cinePrompt || job.note || '').trim();
  if (!prompt) throw new CineError('CINE_EMPTY_PROMPT', '一句话为空', {});
  const g0m = AUDIT.inputGate({ prompt, style: job.cineStyle });
  if (!g0m.pass) throw new CineError('CINE_INPUT_GATE', 'G0 输入闸不通过：' + g0m.problems.join('；'), { problems: g0m.problems });
  const T = { chat, raw, genImage, judge, downloadTo, postProcess, publishToCloud, ffprobeJson, qa: (f) => QA.analyze(f, {}), muxAudio: muxAmbientAudio, vlAudit: (u, t) => vlAudit(u, t, { chat }), concat: concatShots, lastFrame: extractLastFrame, exposure: readExposure, i2vSubmit: (r) => raw('/services/aigc/video-generation/video-synthesis', { method: 'POST', body: r, async: true, timeout: 60000 }), i2vStatus: (t) => raw('/tasks/' + encodeURIComponent(t), { timeout: 30000 }), ...transport };
  const prog = (stage, text, extra) => hooks.onProgress && hooks.onProgress({ percent: null, stage, text, ...(extra || {}) });
  const alive = () => { if (hooks.signal && hooks.signal.aborted) throw new CineError('JOB_CANCELED', '已取消', {}); };
  const dir = path.join(CINE_DIR, job.id);
  fs.mkdirSync(dir, { recursive: true });
  const styleId = styleFor(job.cineStyle || '');
  const age = detectAge(prompt);
  const ratio = ratioFor(prompt, job.cineRatio);
  const size = keyframeSize(prompt, ratio);
  const sizeFallback = ratioFallback(prompt, ratio);
  const camera = detectCamera(prompt);
  const seeds = groupSeeds(12);
  const recipeM = AESTH.recipeById(job.cineTheme) || (AESTH.matchTheme(prompt) || {}).theme || null;
  const gradeKeyM = recipeM ? recipeM.grade : styleId;
  const aesthSuffixM = AESTH.promptSuffix(recipeM);
  const aesthNegM = AESTH.negativeAdd(recipeM);
  const report = { at: new Date().toISOString(), prompt, mode: 'multi', styleId, age, ratio, seeds, camera, baselines: BASELINES, substitutions: POST_SUBSTITUTIONS, warnings: [], shots: [], groups: [], audit: [],
    aesthetics: recipeM ? { themeId: recipeM.id, name: recipeM.name, light: recipeM.light, color: recipeM.color, lens: recipeM.lens, texture: recipeM.texture, motion: recipeM.motion, soundMood: recipeM.soundMood, grade: gradeKeyM, params: AESTH.paramRules(recipeM), ratioSuggested: recipeM.ratio, durationRequested: recipeM.duration } : null };
  prog('analyze', '正在分析你的描述...');
  const analysis = await analyze(prompt, T);
  if (!job.cineStyle) report.styleId = styleFor(analysis.style_id);
  report.analysis = analysis;
  const shots = buildMultiShots(analysis, prompt, camera, BASELINES.video.duration);
  report.shots = shots;
  alive();
  const shotVideos = []; const shotDurations = [];
  let prevLastFrame = null;
  for (let si = 0; si < shots.length; si += 1) {
    const shot = shots[si];
    alive();
    prog('keyframes', `正在打磨第${shot.no}/3镜关键帧（${shot.shotSize}）...`, { group: shot.no });
    // M3/M5：每镜 4 候选，VL 选最优
    let best = null; const cands = [];
    for (let c = 0; c < 4; c += 1) {
      alive();
      const seed = seeds[si * 4 + c];
      const p = buildGroupPrompt(analysis, { id: c + 1, name: shot.shotSize, zh: shot.shotSize + '，' + shot.lock, en: shot.shotSizeEn }, aesthSuffixM, { styleId: report.styleId, prompt, age });
      const neg = buildGroupNegative(aesthNegM, { styleId: report.styleId }, analysis);
      const img = await T.genImage(p, neg, T, { seed, size, fallbackSize: sizeFallback });
      const scores = await T.judge(img.url, p, T);
      const rec = { attempt: c + 1, seed, prompt: p, imageUrl: img.url, scores };
      cands.push(rec);
      if (!best || scores.total > best.scores.total) best = rec;
    }
    const kf = path.join(dir, `s${shot.no}-kf.png`);
    await T.downloadTo(best.imageUrl, kf);
    shot.keyframe = kf; shot.candidates = cands.map((c) => ({ seed: c.seed, total: c.scores.total, imageUrl: c.imageUrl })); shot.pickTotal = best.scores.total;
    // G1 生图静态闸（本镜关键帧）：REJECT 不浪费 i2v 计费，直接失败留帧人工重试
    const g1m = await runAudit(T, kf, 'image', { size, ratio: report.ratio }, [best.imageUrl], report.styleId);
    shot.audit = g1m; report.audit.push(g1m);
    if (g1m.decision === 'REJECT') throw new CineError('CINE_G1_REJECT', `第${shot.no}镜关键帧 G1 否决：${g1m.vetoHits.join(',') || g1m.reason}（不投 i2v，留帧人工重试）`, { shot: shot.no, veto: g1m.vetoHits });
    // M4：锁定描述随镜保一致。云端 i2v 只收公网 URL，本地尾帧无法作首帧传入 →
    // continuity 请求如实告警不可执行，仍用本镜关键帧的远程 URL（不假装尾帧继承已生效）。
    const firstFrameUrl = best.imageUrl;
    if (job.cineContinuity && prevLastFrame) {
      shot.inheritFrom = shot.no - 1;
      report.warnings.push({ code: 'CINE_CONTINUITY_UNAVAILABLE', text: `第${shot.no}镜尾帧继承不可执行：云端 i2v 只收公网 URL，本地尾帧无 URL；以锁定描述保一致`, shot: shot.no });
    }
    shot.firstFrameUsed = firstFrameUrl;
    alive();
    prog('i2v', `正在图生视频（第${shot.no}/3镜）...`, { group: shot.no });
    const motionPrompt = camera.fixed ? MOTION_PROMPT : MOTION_PROMPT + ', ' + camera.move;
    const req = { model: i2vModel(), input: { img_url: firstFrameUrl, prompt: motionPrompt, negative_prompt: MOTION_NEG }, parameters: { resolution: '720P', duration: 5, prompt_extend: false } };
    const iv = await i2vRun(T, req, hooks, prog, alive, dir, `s${shot.no}`);
    shot.i2v = { taskId: iv.taskId, model: req.model, measured: iv.measured, ms: iv.ms };
    // G2 视频动态闸（本镜）：REJECT 不流入组接
    const g2m = await runAudit(T, iv.rawFile, 'video', { duration: 5, fps: iv.measured.fps, ratio: report.ratio }, null, report.styleId);
    shot.i2v.audit = g2m; report.audit.push(g2m);
    if (g2m.decision === 'REJECT') throw new CineError('CINE_G2_REJECT', `第${shot.no}镜 G2 否决：${g2m.vetoHits.join(',') || g2m.reason}（不流入组接）`, { shot: shot.no, veto: g2m.vetoHits });
    if (iv.measured.fps != null && iv.measured.fps !== BASELINES.video.fps) report.warnings.push({ code: 'CINE_FPS_DEVIATION', text: `第${shot.no}镜规格16fps 实测${iv.measured.fps}fps`, shot: shot.no });
    prevLastFrame = await T.lastFrame(iv.rawFile, path.join(dir, `s${shot.no}-last.png`));
    shot.lastFrame = prevLastFrame;
    // M8 逐镜 filmic
    prog('post', `正在电影级后处理（第${shot.no}/3镜）...`, { group: shot.no });
    const exp = await T.exposure(kf);
    const lut = path.join(dir, `s${shot.no}-filmic.cube`);
    fs.writeFileSync(lut, buildFilmicCube(gradeKeyM, exp, 33), 'utf8');
    const shotOut = path.join(dir, `s${shot.no}-final.mp4`);
    const post = await T.postProcess(iv.rawFile, shotOut, lut, { ratio: report.ratio, beautyPct: Math.max(0, Math.min(100, (job.cineBeauty != null ? Number(job.cineBeauty) : beautyDefault(styleId)))) });
    shot.post = { lut: `s${shot.no}-filmic.cube`, target: post.target, exposure: +exp.toFixed(3) };
    shotVideos.push(shotOut); shotDurations.push(probeDuration(post.probe));
    if (hooks.onGroup) hooks.onGroup({ id: shot.no, name: shot.shotSize, file: kf, total: best.scores.total, dims: best.scores.dims, passed: best.scores.total >= 8, attempts: 4 });
    report.groups.push({ id: shot.no, name: shot.shotSize, best: { file: kf, scores: best.scores, imageUrl: best.imageUrl }, attempts: cands, belowTarget: best.scores.total < 8, passed: best.scores.total >= 8, qualityLabel: best.scores.total >= 9 ? 'pass' : best.scores.total >= 8 ? 'candidate' : '质量一般' });
  }
  alive();
  // M7 组接
  prog('post', '正在组接多镜头...');
  const concatOut = path.join(dir, 'multi-concat.mp4');
  const concat = await T.concat(shotVideos, shotDurations, 0.5, concatOut);
  if (concat.transition === 'hardcut') report.warnings.push({ code: 'CINE_CONCAT_FALLBACK', text: 'xfade 失败退硬切：' + (concat.fallbackReason || '') });
  report.timeline = { shots: shots.map((s, i) => ({ no: s.no, shotSize: s.shotSize, duration: +shotDurations[i].toFixed(3) })), transition: concat.transition, crossfade: concat.crossfade, totalDuration: concat.totalDuration };
  alive();
  // M9 整片声
  const muxed = path.join(dir, 'multi-final-audio.mp4');
  let audio = null;
  try { audio = await T.muxAudio(concatOut, muxed, gradeKeyM, concat.totalDuration); } catch (e) { report.warnings.push({ code: 'CINE_AUDIO_SKIPPED', text: '混流失败标无声：' + e.message }); }
  report.audio = audio || { source: 'none', native: false, silent: true };
  const finalFile = audio ? muxed : concatOut;
  // M6 终审 QA
  prog('post', '正在成片 QA 双闸...');
  const qaRes = await T.qa(finalFile);
  const pixel = qaRes && qaRes.ok ? qaPixelGate(qaRes.frames || []) : { pass: false, unavailable: true, reasons: ['QA 不可用'] };
  const aestheticTotal = report.groups.reduce((a, g) => a + g.best.scores.total, 0) / report.groups.length;
  const g3m = await runAudit(T, finalFile, 'video', { duration: concat.totalDuration, fpsOut: 48, ratio: report.ratio }, null, report.styleId);
  report.audit.push(g3m);
  report.qa = { pixel, aesthetic: { total: +aestheticTotal.toFixed(2), pass: aestheticTotal >= 8, source: 'model-opinion' }, pass: !!(pixel.pass && aestheticTotal >= 8 && g3m.decision !== 'REJECT'), rejectReasons: [...(pixel.reasons || []), ...g3m.vetoHits], decision: g3m.decision, tier: g3m.tier, total: g3m.total, vetoHits: g3m.vetoHits, tags: g3m.tags, review: g3m.review, scores: g3m.scores, thresholdVersion: g3m.thresholdVersion };
  if (!report.qa.pass) report.warnings.push({ code: 'CINE_QA_GATE_FAIL', text: '终审 QA 未过：' + (pixel.reasons || []).join('；'), reasons: pixel.reasons });
  if (g3m.decision === 'REVIEW') report.warnings.push({ code: 'CINE_G3_REVIEW', text: 'G3 终审存疑进人工复核：' + g3m.review.join('；'), review: g3m.review });
  alive();
  // 先探针再 publish：publishToCloud 会 renameSync 把文件移走，移走后再探针必失败
  const finalProbe = await T.ffprobeJson(finalFile);
  const pub = await T.publishToCloud(finalFile, prompt);
  report.output = pub;
  report.candidates = report.groups.map((g, i) => ({ id: g.id, name: g.name, file: g.best.file, total: g.best.scores.total, dims: g.best.scores.dims, passed: g.passed, qualityLabel: g.qualityLabel, attempts: g.attempts.length, picked: false }));
  report.params = { size, ratio: report.ratio, seeds, duration: concat.totalDuration, fpsOut: 48, styleId: report.styleId, age, camera: camera.zh, bitrate: '8M', shots: shots.length };
  report.beauty = { smoothPct: Math.max(0, Math.min(100, job.cineBeauty != null ? Number(job.cineBeauty) : beautyDefault(styleId))), brightenPct: 8, loraWeight: clampLora(job.cineLoraWeight), executed: { smooth: 'ffmpeg bilateral', brighten: 'eq' }, notExecuted: ['slim', 'eye', 'underEye', 'face-mask', 'FaceDetailer', 'LoRA'], applicable: false, reason: FACE_TECH.reason, provenance: 'measured' };
  report.modelChain = { analyze: chatModel(), judge: vlModel(), image: imageModel(), i2v: i2vModel(), post: 'ffmpeg', edit: concat.transition, audio: report.audio.source };
  report.retries = 0;
  report.status = report.groups.some((g) => g.belowTarget) || !report.qa.pass ? 'partial' : 'success';
  const g4m = AUDIT.complianceGate(report);
  report.compliance = g4m;
  if (!g4m.pass) report.warnings.push({ code: 'CINE_G4_COMPLIANCE', text: 'G4 入库合规存疑：' + g4m.problems.join('；'), problems: g4m.problems });
  const v = (finalProbe.streams || []).find((s) => s.codec_type === 'video') || {};
  return { taskId: shots.map((s) => s.i2v.taskId).join(','), images: report.candidates, output: { file: pub.file, bytes: pub.bytes, fps: 48, width: v.width, height: v.height }, meta: { cineReport: report } };
}

module.exports = {
  MODIFIERS, NEGATIVE, MOTION_PROMPT, MOTION_NEG, BASELINES, GROUPS, FIX_MAP, DIM_ZH, POST_SUBSTITUTIONS,
  STYLE_WORDS, STYLE_MAP, styleFor, FACE_POS, FACE_AGE, FACE_NEG, FACE_TECH, FACE_STYLE_ADD, detectAge, SAMPLING, keyframeSize, groupSeeds, weight, detectCamera, STYLE_GRADE,
  RATIOS, DEFAULT_RATIO, ratioFor, ratioFallback, clampLora, beautyDefault, diagnoseFaceFix,
  QA_BASELINE, qaPixelGate, buildShotTable, readExposure, buildFilmicCube, ambientBedFor, muxAmbientAudio,
  SHOT_SIZES, buildMultiShots, extractLastFrame, probeDuration, concatShots, i2vRun, runCineMultiShot,
  vlAudit, runAudit, AUDIT,
  CineError, parseJsonReply, normalizeScores, diagnoseFix, buildGroupPrompt, buildGroupNegative,
  buildTealOrangeCube, buildStyleCube, postFilterChain, postTargetSize, analyze, judge, genImage, runCine, postProcess, publishToCloud,
  downloadTo, ffprobeJson, CINE_DIR, OUTPUT_DIR, models: { chat: chatModel, vl: vlModel, image: imageModel, i2v: i2vModel },
};