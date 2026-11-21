'use strict';
/**
 * prompt/compose.js —— 中文意图 → 模型可用提示词的编译层
 *
 * 设计取舍（为什么不是字符串拼接）：
 *   1) 唯一的真相源是 structured（分槽位的中间表示）。positive / positive_en / negative 全部由它渲染，
 *      不允许任何一处在渲染时"补一句"。这样 selftest 才能断言 render(structured) === positive，
 *      也才能保证 notes 的追溯链不断。
 *   2) 词落在 lexicon.zh.json（数据），装配逻辑落在这里（代码）。换个说法/加个词不需要动代码，
 *      改架构不需要动词库。
 *   3) 每个参数有一个"处置"：consumed（进某个槽位）或 nonprompt（明确声明与提示词无关，并写清理由）。
 *      不准许"没想清楚"的中间态——那才是提示词工程里最常见的隐性债。
 *   4) 冲突检测与负向集都从 structured/数值里推导，不额外读一遍 values，避免两份状态不同步。
 *
 * 零依赖：只用 node 内置 fs/path。
 */

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SPEC_DIR = path.resolve(HERE, '..', 'spec');

/* ───────────── 常量 ───────────── */

// 七个板块即七个 stage。export 不产提示词，但要能被 compile 接受并给出解释，而不是让 UI 传错就崩。
const STAGES = ['character', 'storyboard', 'keyframe', 'motion', 'voice', 'look', 'export'];

// 槽位顺序＝中文整句的语序。改这里等于改"读起来像不像人在描述画面"。
const SLOTS = ['subject', 'appearance', 'outfit', 'scene', 'light', 'camera', 'style', 'quality', 'motion', 'audio', 'beat'];

const SLOT_TITLES = {
  subject: '主体', appearance: '外观', outfit: '服饰', scene: '场景', light: '光线',
  camera: '镜头', style: '风格', quality: '质感', motion: '运动', audio: '音频', beat: '节拍',
};

// 会真正出"画面"的三个 stage。audio/beat/后期类的词不该出现在这里，否则就是白烧 token。
const VISUAL = ['character', 'keyframe', 'motion'];

/* ───────────── 数据加载（惰性 + 缓存） ───────────── */

let _lex = null, _sty = null, _reg = null;

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error('读取失败: ' + p + ' → ' + e.message);
  }
}

function lexicon() { return _lex || (_lex = readJson(path.join(HERE, 'lexicon.zh.json'))); }
function styles() { return _sty || (_sty = readJson(path.join(HERE, 'styles.json'))); }

function registry() {
  if (_reg !== null) return _reg;
  const p = path.join(SPEC_DIR, 'params.registry.json');
  _reg = fs.existsSync(p) ? readJson(p) : false;   // false = 没有注册表也能跑（用于脱离项目单独测）
  return _reg;
}

// 注册表默认值直读。不走 core/engine.js 是为了保持 prompt 层可被单独测试（不引入求解器依赖）。
function registryDefaults() {
  const reg = registry();
  if (!reg) return {};
  const out = {};
  for (const p of reg.params) out[p.key] = p.default;
  return out;
}

function paramIndex() {
  const reg = registry();
  if (!reg) return {};
  if (!paramIndex._map) {
    paramIndex._map = Object.create(null);
    for (const p of reg.params) paramIndex._map[p.key] = p;
  }
  return paramIndex._map;
}

/* ───────────── 词库读取原语 ───────────── */

function term(group, value) {
  const g = lexicon().groups[group];
  if (!g) return null;
  const e = g.entries[value];
  if (!e) return null;
  return {
    // zh 字段允许词条给中文写法（例如 tonemap 的键是 filmic/none/aces 这类英文 id）
    zh: e.zh || value, en: e.en, w: e.w == null ? 1 : e.w, why: e.why || '',
    pitfall: e.pitfall || '', provenance: e.provenance || 'inferred',
  };
}

function band(group, v) {
  const b = lexicon().bands[group];
  if (!b) return null;
  for (const c of b.cuts) if (v <= c.lte) return { zh: c.zh, en: c.en, w: c.w == null ? 1 : c.w, group, provenance: 'estimate' };
  const last = b.cuts[b.cuts.length - 1];
  return { zh: last.zh, en: last.en, w: last.w == null ? 1 : last.w, group, provenance: 'estimate' };
}

// 在中文自由文本里扫词表：这是把"米色针织衫"这类用户原话救回英文 tag 的唯一办法。
function scanTerms(text, groupIds) {
  const lex = lexicon();
  const out = [];
  for (const gid of groupIds) {
    const g = lex.groups[gid];
    if (!g) continue;
    for (const zh in g.entries) {
      if (text.indexOf(zh) >= 0) out.push({ group: gid, zh, ...g.entries[zh] });
    }
  }
  return out;
}

/* ───────────── 处置表：consumed ───────────── */
/**
 * 每一项都声明：进哪个槽位（slot）、怎么取词（mode）、在哪些 stage 里真的会出现（stages）。
 * stages 是关键：look 阶段的"锐化 30"如果混进 keyframe 的出图提示词，只会把画面推出白边，
 * 所以这类参数只在 look 阶段生效，而不是"全局有效"。
 *
 * mode 说明：
 *   text    —— 中文原话直接进槽（自由文本参数）
 *   scan    —— 中文原话进槽，同时扫词表补英文
 *   enum    —— 值 → 词库条目
 *   band    —— 数值 → 区间落词
 *   fmt     —— 数值 → 自定义短句（返回 null 表示"这个取值不该进提示词"）
 *   flag    —— 布尔 → 是否追加一句固定语义
 *   negative—— 并入负向集，不占正向槽位
 *   prefix  —— 提示词前缀，进 subject 槽最前，且必须过黑名单
 */
const CONSUME = {
  /* ── character 角色设定 ── */
  'ch.subject': { slot: 'subject', mode: 'text', stages: VISUAL, scan: ['eye_shape', 'object', 'skin'], label: '主体' },
  'ch.age': { slot: 'appearance', mode: 'fmt', stages: VISUAL, label: '年龄', fmt: (v) => ({ zh: '约' + v + '岁', en: v + ' years old', w: 1.0, dedupe_key: v + '岁' }) },
  'ch.face_shape': { slot: 'appearance', mode: 'enum', group: 'face_shape', tag: '脸', stages: VISUAL, label: '脸型' },
  'ch.face_detail': { slot: 'appearance', mode: 'text', stages: VISUAL, scan: ['eye_shape', 'skin', 'hair'], label: '五官细节' },
  'ch.body': { slot: 'appearance', mode: 'enum', group: 'body', tag: '体态', stages: VISUAL, label: '体态' },
  'ch.skin': { slot: 'appearance', mode: 'enum', group: 'skin', tag: '肤质', stages: VISUAL, label: '肤质' },
  'ch.hair_style': { slot: 'appearance', mode: 'enum', group: 'hair', stages: VISUAL, label: '发型' },
  'ch.hair_color': { slot: 'appearance', mode: 'enum', group: 'hair_color', stages: VISUAL, label: '发色' },
  'ch.outfit_1': { slot: 'outfit', mode: 'scan', stages: VISUAL, scan: ['outfit', 'object'], label: '主服装' },
  'ch.outfit_2': { slot: 'outfit', mode: 'scan', stages: VISUAL, scan: ['outfit', 'object'], label: '副服装1' },
  'ch.outfit_3': { slot: 'outfit', mode: 'scan', stages: VISUAL, scan: ['outfit', 'object'], label: '副服装2' },
  'ch.palette': { slot: 'style', mode: 'enum', group: 'palette', stages: VISUAL, label: '配色' },
  'ch.style': { slot: 'style', mode: 'enum', group: 'style_words', stages: VISUAL, label: '画风' },
  'ch.line_weight': { slot: 'quality', mode: 'fmt', stages: VISUAL, label: '线稿强度', fmt: (v, vals) => {
    // 只有线稿类画风才有"线条"这个概念；厚涂/写实里写线条强度＝自相矛盾
    const s = String(vals['ch.style'] || '');
    if (!/赛璐璐|日漫|韩漫|工笔|国潮/.test(s)) return null;
    return { zh: '线条强度 ' + v, en: 'line weight ' + v, w: 1.0 };
  } },
  'ch.screen_tone': { slot: 'quality', mode: 'fmt', stages: VISUAL, label: '网点密度', fmt: (v, vals) => {
    const s = String(vals['ch.style'] || '');
    if (!/赛璐璐|日漫|韩漫/.test(s) || !v) return null;
    return { zh: '网点密度 ' + v, en: 'screentone density ' + v, w: 1.0 };
  } },
  'ch.shadow_levels': { slot: 'quality', mode: 'fmt', stages: VISUAL, label: '阴影阶数', fmt: (v, vals) => {
    const s = String(vals['ch.style'] || '');
    if (!/赛璐璐|日漫|韩漫|国潮/.test(s)) return null;
    return { zh: '阴影 ' + v + ' 阶', en: v + '-tone shading', w: 1.0 };
  } },
  'ch.expression_count': { slot: 'beat', mode: 'fmt', stages: ['character'], label: '表情数', fmt: (v) => v > 1 ? { zh: v + ' 种表情', en: v + ' expressions sheet', w: 1.0 } : null },
  'ch.pose_count': { slot: 'beat', mode: 'fmt', stages: ['character'], label: '姿态数', fmt: (v) => v > 1 ? { zh: v + ' 组姿态', en: v + ' pose variations', w: 1.0 } : null },
  'ch.turnaround': { slot: 'camera', mode: 'flag', stages: ['character'], label: '三视图', zh: '三视图（正面/侧面/背面）', en: 'character turnaround sheet, front side back view', w: 1.1 },
  'ch.consistency': { slot: 'appearance', mode: 'fmt', stages: VISUAL, label: '一致性', fmt: (v) => v >= 0.7 ? { zh: '面部特征前后一致', en: 'consistent facial identity', w: 1.1 } : null },
  'ch.identity_lock': { slot: 'appearance', mode: 'flag', stages: VISUAL, label: '身份锁', zh: '同一人物，不换脸', en: 'same person, locked identity', w: 1.05 },
  'ch.hair_detail': { slot: 'quality', mode: 'fmt', stages: VISUAL, label: '发丝细节', fmt: (v) => v >= 40 ? { zh: '发丝分层清晰', en: 'strand-level hair detail', w: 1.05 } : null },
  'ch.eye_highlight': { slot: 'quality', mode: 'fmt', stages: VISUAL, label: '瞳孔高光', fmt: (v) => v >= 30 ? { zh: '瞳孔有清晰高光', en: 'clear catchlight in pupils', w: 1.05 } : null },
  'ch.fabric_texture': { slot: 'quality', mode: 'fmt', stages: VISUAL, label: '织物纹理', fmt: (v) => v >= 40 ? { zh: '织物纹理可辨', en: 'readable fabric weave texture', w: 1.05 } : null },
  'ch.prompt_prefix': { slot: 'subject', mode: 'prefix', stages: VISUAL, label: '前缀' },
  'ch.negative': { slot: null, mode: 'negative', label: '排除词' },

  /* ── storyboard 剧本分镜：产物是"给 LLM 的分镜指令"，不是画面提示词 ── */
  'sb.duration': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '时长', fmt: (v) => ({ zh: '目标 ' + v + ' 秒', en: v + 's target duration', w: 1.0 }) },
  'sb.grid_count': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '格数', fmt: (v) => ({ zh: v + ' 格', en: v + ' panels', w: 1.0 }) },
  'sb.rhythm': { slot: 'beat', mode: 'enum', group: 'rhythm', tag: '节奏', stages: ['storyboard'], label: '节奏' },
  'sb.shot_scale': { slot: 'camera', mode: 'enum', group: 'camera_scale', stages: ['storyboard', 'keyframe', 'motion', 'character'], label: '主导景别' },
  'sb.shot_diversity': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '机位多样性', fmt: (v) => ({ zh: '机位多样 ' + v + ' 分', en: 'camera variety ' + v, w: 1.0 }) },
  'sb.closeup_ratio': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '特写占比', fmt: (v) => v > 0 ? { zh: '特写占 ' + v + '%', en: 'close-up ratio ' + v + '%', w: 1.0 } : null },
  'sb.medium_ratio': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '中景占比', fmt: (v) => v > 0 ? { zh: '中景占 ' + v + '%', en: 'medium shot ratio ' + v + '%', w: 1.0 } : null },
  'sb.wide_ratio': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '全景占比', fmt: (v) => v > 0 ? { zh: '全景占 ' + v + '%', en: 'wide shot ratio ' + v + '%', w: 1.0 } : null },
  'sb.emotion_curve': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '情绪曲线', fmt: (v) => ({ zh: '情绪曲线强度 ' + v, en: 'emotion curve ' + v, w: 1.0 }) },
  'sb.act_structure': { slot: 'beat', mode: 'enum_generic', stages: ['storyboard'], label: '叙事结构' },
  'sb.line_density': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '台词密度', fmt: (v) => ({ zh: '台词密度 ' + v, en: 'dialogue density ' + v, w: 1.0 }) },
  'sb.narration_ratio': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '旁白占比', fmt: (v) => v > 0 ? { zh: '旁白占 ' + v + '%', en: 'narration ratio ' + v + '%', w: 1.0 } : null },
  'sb.genre': { slot: 'style', mode: 'enum', group: 'genre', tag: '题材', stages: ['storyboard', 'keyframe', 'motion', 'character'], label: '题材' },
  'sb.camera_language': { slot: 'camera', mode: 'enum', group: 'camera_language', stages: ['storyboard', 'keyframe', 'motion'], label: '镜头语言' },
  'sb.scene_count': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '场景数', fmt: (v) => v > 1 ? { zh: v + ' 个场景', en: v + ' scenes', w: 1.0 } : null },
  'sb.transition_count': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '转场数', fmt: (v) => v > 0 ? { zh: v + ' 次转场', en: v + ' transitions', w: 1.0 } : null },
  'sb.conflict_intensity': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '冲突强度', fmt: (v) => ({ zh: '冲突强度 ' + v, en: 'conflict intensity ' + v, w: 1.0 }) },
  'sb.hook_seconds': { slot: 'beat', mode: 'flag', stages: ['storyboard'], label: '3 秒钩子', zh: '前 3 秒必须有钩子', en: 'hook within first 3 seconds', w: 1.0 },
  'sb.subtitle_lines': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '字幕行数', fmt: (v) => ({ zh: '字幕最多 ' + v + ' 行', en: 'max ' + v + ' subtitle lines', w: 1.0 }) },
  'sb.character_count': { slot: 'beat', mode: 'fmt', stages: ['storyboard', 'character', 'keyframe'], label: '角色数', fmt: (v) => v > 1 ? { zh: v + ' 个角色', en: v + ' characters', w: 1.0 } : null },
  'sb.beat_per_grid': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '每格节拍', fmt: (v) => ({ zh: '每格 ' + v + ' 个节拍', en: v + ' beats per panel', w: 1.0 }) },
  'sb.silence_ratio': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: '静场占比', fmt: (v) => v > 0 ? { zh: '静场占 ' + v + '%', en: 'silence ratio ' + v + '%', w: 1.0 } : null },
  'sb.bgm_cue_count': { slot: 'beat', mode: 'fmt', stages: ['storyboard'], label: 'BGM 提示点', fmt: (v) => v > 0 ? { zh: v + ' 个 BGM 提示点', en: v + ' BGM cues', w: 1.0 } : null },
  'sb.title_style': { slot: 'beat', mode: 'enum_generic', stages: ['storyboard'], label: '标题风格' },
  'sb.style_ref': { slot: 'style', mode: 'text', stages: ['storyboard', 'keyframe'], label: '参考风格' },

  /* ── keyframe 关键帧：数值靠区间落词，而不是让用户背 prompt 咒语 ── */
  'kf.composition': { slot: 'camera', mode: 'enum', group: 'composition', stages: ['keyframe', 'character'], label: '构图' },
  'kf.negative_space': { slot: 'camera', mode: 'band', group: 'negative_space', stages: ['keyframe', 'character'], label: '留白' },
  'kf.color_temp': { slot: 'light', mode: 'band', group: 'color_temp', stages: VISUAL, label: '色温' },
  'kf.light_ratio': { slot: 'light', mode: 'band', group: 'light_ratio', stages: VISUAL, label: '光比' },
  'kf.key_light_dir': { slot: 'light', mode: 'enum', group: 'light', stages: VISUAL, label: '主光方向' },
  'kf.dof': { slot: 'camera', mode: 'band', group: 'dof', stages: VISUAL, label: '景深' },
  'kf.grain': { slot: 'quality', mode: 'band', group: 'grain', stages: VISUAL, label: '颗粒' },
  'kf.tonemap': { slot: 'quality', mode: 'enum', group: 'tonemap', stages: ['keyframe', 'character'], label: '色调映射' },
  'kf.detail_boost': { slot: 'quality', mode: 'fmt', stages: ['keyframe'], label: '细节增强', fmt: (v, vals) => {
    // 步数不够时"加细节"只会变噪点，所以直接不落词——这比落一个假词诚实
    const steps = Number(vals['kf.steps'] || 24);
    if (steps < 20) return null;
    return v >= 50 ? { zh: '织物与发丝层次清晰', en: 'crisp micro-detail on fabric and hair', w: 1.05 } : null;
  } },
  'kf.prompt_weight_syntax': { slot: 'quality', mode: 'fmt', stages: STAGES, emits: 'controls', label: '权重语法', fmt: () => null },
  'kf.prompt_compile': { slot: 'quality', mode: 'fmt', stages: STAGES, emits: 'controls', label: '编译开关', fmt: () => null },
  'kf.negative': { slot: null, mode: 'negative', label: '排除词' },

  /* ── motion 动效 ── */
  'mo.mode': { slot: 'motion', mode: 'enum', group: 'motion_mode', stages: ['motion'], label: '动效模式' },
  'mo.strength': { slot: 'motion', mode: 'band', group: 'motion_strength', stages: ['motion', 'storyboard'], label: '运动强度' },
  'mo.camera': { slot: 'motion', mode: 'enum', group: 'move', stages: ['motion', 'storyboard'], label: '运镜' },
  'mo.camera_speed': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '运镜速度', fmt: (v) => {
    const s = v <= 0.3 ? ['缓慢', 'slow'] : v <= 0.7 ? ['中速', 'steady'] : ['快速', 'fast'];
    return { zh: s[0] + '运镜', en: s[1] + ' camera move', w: 1.0 };
  } },
  'mo.duration': { slot: 'motion', mode: 'fmt', stages: ['motion', 'storyboard'], label: '单格时长', fmt: (v) => ({ zh: '单格 ' + v + ' 秒', en: v + 's per shot', w: 1.0 }) },
  'mo.parallax_layers': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '视差层数', fmt: (v, vals) => String(vals['mo.mode']) === '视差' ? { zh: v + ' 层视差', en: v + '-layer parallax', w: 1.0 } : null },
  'mo.hair_sway': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '发丝飘动', fmt: (v) => v >= 20 ? { zh: '发丝随风微动', en: 'hair swaying gently', w: 1.05 } : null },
  'mo.cloth_sway': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '衣摆飘动', fmt: (v) => v >= 20 ? { zh: '衣摆轻晃', en: 'fabric hem drifting', w: 1.05 } : null },
  'mo.fx_rain': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '雨效', fmt: (v) => v > 0 ? { zh: '细雨落下', en: 'light rain falling', w: 1.0 } : null },
  'mo.fx_snow': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '雪效', fmt: (v) => v > 0 ? { zh: '雪粒飘落', en: 'snow drifting down', w: 1.0 } : null },
  'mo.fx_fog': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '雾效', fmt: (v) => v > 0 ? { zh: '薄雾缓慢流动', en: 'thin fog drifting', w: 1.0 } : null },
  'mo.fx_bloom_light': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '光斑', fmt: (v) => v > 0 ? { zh: '光斑浮动', en: 'floating light bokeh', w: 1.0 } : null },
  'mo.fx_dust': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '尘埃', fmt: (v) => v > 0 ? { zh: '空气尘埃可见', en: 'dust motes in the air', w: 1.0 } : null },
  'mo.particle_type': { slot: 'motion', mode: 'enum_generic', stages: ['motion'], label: '粒子类型' },
  'mo.particle_count': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '粒子数量', fmt: (v) => v > 0 ? { zh: '粒子 ' + v + ' 个', en: v + ' particles', w: 1.0 } : null },
  'mo.motion_blur': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '运动模糊', fmt: (v) => v >= 10 ? { zh: '运动模糊自然', en: 'natural motion blur', w: 1.0 } : null },
  'mo.lens_distortion': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '镜头畸变', fmt: (v) => v >= 20 ? { zh: '广角畸变明显', en: 'visible wide-angle distortion', w: 1.0 } : null },
  'mo.loop': { slot: 'motion', mode: 'flag', stages: ['motion'], label: '循环', zh: '首尾可无缝循环', en: 'seamless loop', w: 1.0 },
  'mo.breath_amp': { slot: 'motion', mode: 'fmt', stages: ['motion'], label: '呼吸幅度', fmt: (v) => v >= 20 ? { zh: '胸腔随呼吸起伏', en: 'subtle breathing motion in chest', w: 1.0 } : null },

  /* ── voice 配音：产物是音频指令，不是画面词 ── */
  'vo.voice_id': { slot: 'audio', mode: 'enum', group: 'voice_id', tag: '音色', stages: ['voice'], label: '音色' },
  'vo.speed': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '语速', fmt: (v) => ({ zh: '语速 ' + Number(v).toFixed(2) + 'x', en: 'speech rate ' + Number(v).toFixed(2), w: 1.0 }) },
  'vo.pitch': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '音高', fmt: (v) => ({ zh: '音高 ' + (v > 0 ? '+' : '') + v, en: 'pitch ' + (v > 0 ? '+' : '') + v, w: 1.0 }) },
  'vo.emotion': { slot: 'audio', mode: 'enum', group: 'emotion', tag: '情绪', stages: ['voice'], label: '情绪' },
  'vo.lipsync': { slot: 'audio', mode: 'flag', stages: ['voice'], label: '口型', zh: '口型与音素对齐', en: 'lip sync to phonemes', w: 1.0 },
  'vo.pause_insert': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '停顿', fmt: (v) => v > 0 ? { zh: '句间停顿 ' + v, en: 'inserted pauses ' + v, w: 1.0 } : null },
  'vo.dialect': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '方言', fmt: (v) => String(v) !== '普通话' ? { zh: '方言 ' + v, en: v + ' dialect', w: 1.0 } : null },
  'vo.lipsync_strength': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '口型强度', fmt: (v) => ({ zh: '口型强度 ' + v, en: 'lip sync strength ' + v, w: 1.0 }) },
  'vo.closeup_only': { slot: 'audio', mode: 'flag', stages: ['voice'], label: '仅近景口型', zh: '仅近景做口型', en: 'lip sync only in close-ups', w: 0.9 },
  'vo.sfx_tracks': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '音效轨', fmt: (v) => v > 0 ? { zh: '音效 ' + v + ' 轨', en: v + ' SFX tracks', w: 1.0 } : null },
  'vo.bgm_genre': { slot: 'audio', mode: 'fmt', stages: ['voice', 'storyboard'], label: 'BGM', fmt: (v) => String(v) !== '无' ? { zh: 'BGM ' + v, en: v + ' BGM', w: 1.0 } : null },
  'vo.bgm_strength': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: 'BGM 强度', fmt: (v) => v > 0 ? { zh: 'BGM 强度 ' + v + '%', en: 'BGM level ' + v + '%', w: 1.0 } : null },
  'vo.ducking_db': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: 'ducking', fmt: (v) => ({ zh: 'ducking ' + v + 'dB', en: 'ducking ' + v + 'dB', w: 1.0 }) },
  'vo.breath': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '气口', fmt: (v) => ({ zh: '气口 ' + v, en: 'breath intensity ' + v, w: 1.0 }) },
  'vo.emphasis': { slot: 'audio', mode: 'fmt', stages: ['voice'], label: '重音', fmt: (v) => ({ zh: '重音 ' + v, en: 'emphasis ' + v, w: 1.0 }) },
  'vo.rate_curve': { slot: 'audio', mode: 'text', stages: ['voice'], label: '语速曲线' },
  'vo.subtitle_sync': { slot: 'audio', mode: 'flag', stages: ['voice', 'storyboard'], label: '字幕同步', zh: '字幕与语音强制同步', en: 'subtitles locked to speech', w: 1.0 },
  'vo.max_chars_per_line': { slot: 'audio', mode: 'fmt', stages: ['voice', 'storyboard'], label: '每行字数', fmt: (v) => ({ zh: '每行不超过 ' + v + ' 字', en: 'max ' + v + ' chars per line', w: 1.0 }) },

  /* ── look 质感后期：产物是后期指令（target=post），绝不混进出图提示词 ── */
  'lk.lut': { slot: 'quality', mode: 'enum', group: 'lut', tag: 'LUT', stages: ['look'], label: 'LUT' },
  'lk.lut_strength': { slot: 'quality', mode: 'fmt', stages: ['look'], label: 'LUT 强度', fmt: (v, vals) => String(vals['lk.lut']) === '无' ? null : { zh: 'LUT 强度 ' + v + '%', en: 'LUT at ' + v + '%', w: 1.0 } },
  'lk.grain': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '颗粒', fmt: (v) => v > 0 ? { zh: '胶片颗粒 ' + v, en: 'film grain ' + v, w: 1.0 } : null },
  'lk.vignette': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '暗角', fmt: (v) => v > 0 ? { zh: '暗角 ' + v, en: 'vignette ' + v, w: 1.0 } : null },
  'lk.chroma': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '色散', fmt: (v) => v > 0 ? { zh: '镜头色散 ' + v, en: 'chromatic aberration ' + v, w: 1.0 } : null },
  'lk.bloom': { slot: 'quality', mode: 'fmt', stages: ['look'], label: 'bloom', fmt: (v) => v > 0 ? { zh: 'bloom ' + v, en: 'bloom ' + v, w: 1.0 } : null },
  'lk.screen_tone': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '网点', fmt: (v) => v > 0 ? { zh: '网点 ' + v, en: 'screentone ' + v, w: 1.0 } : null },
  'lk.outline': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '描边', fmt: (v) => v > 0 ? { zh: '描边 ' + v, en: 'outline ' + v, w: 1.0 } : null },
  'lk.cel_levels': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '赛璐璐阶数', fmt: (v) => ({ zh: '赛璐璐 ' + v + ' 阶', en: 'cel shading ' + v + ' levels', w: 1.0 }) },
  'lk.sharpen': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '锐化', fmt: (v) => v > 0 ? { zh: '锐化 ' + v, en: 'sharpen ' + v, w: 1.0 } : null },
  'lk.denoise': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '降噪', fmt: (v) => v > 0 ? { zh: '降噪 ' + v, en: 'denoise ' + v, w: 1.0 } : null },
  'lk.deflicker': { slot: 'quality', mode: 'fmt', stages: ['look'], label: 'deflicker', fmt: (v) => v > 0 ? { zh: 'deflicker ' + v, en: 'deflicker ' + v, w: 1.0 } : null },
  'lk.contrast': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '对比度', fmt: (v) => ({ zh: '对比度 ' + v, en: 'contrast ' + v, w: 1.0 }) },
  'lk.saturation': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '饱和度', fmt: (v) => ({ zh: '饱和度 ' + v, en: 'saturation ' + v, w: 1.0 }) },
  'lk.temperature': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '色温微调', fmt: (v) => v !== 0 ? { zh: '色温微调 ' + (v > 0 ? '+' : '') + v, en: 'temp shift ' + (v > 0 ? '+' : '') + v, w: 1.0 } : null },
  'lk.tint': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '色调微调', fmt: (v) => v !== 0 ? { zh: '色调微调 ' + (v > 0 ? '+' : '') + v, en: 'tint shift ' + (v > 0 ? '+' : '') + v, w: 1.0 } : null },
  'lk.highlight_rolloff': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '高光滚降', fmt: (v) => v > 0 ? { zh: '高光滚降 ' + v, en: 'highlight rolloff ' + v, w: 1.0 } : null },
  'lk.shadow_lift': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '暗部提亮', fmt: (v) => v > 0 ? { zh: '暗部提亮 ' + v, en: 'shadow lift ' + v, w: 1.0 } : null },
  'lk.lens_flare': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '光晕', fmt: (v) => v > 0 ? { zh: '镜头光晕 ' + v, en: 'lens flare ' + v, w: 1.0 } : null },
  'lk.paper_texture': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '纸纹', fmt: (v) => v > 0 ? { zh: '纸纹 ' + v, en: 'paper texture ' + v, w: 1.0 } : null },
  'lk.watercolor_edge': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '水彩边', fmt: (v) => v > 0 ? { zh: '水彩边 ' + v, en: 'watercolor edge ' + v, w: 1.0 } : null },
  'lk.ink_bleed': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '墨韵', fmt: (v) => v > 0 ? { zh: '墨韵扩散 ' + v, en: 'ink bleed ' + v, w: 1.0 } : null },
  'lk.frame_border': { slot: 'quality', mode: 'flag', stages: ['look'], label: '画框', zh: '加画框', en: 'framed border', w: 1.0 },
  'lk.film_halation': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '胶片光晕', fmt: (v) => v > 0 ? { zh: '胶片光晕 ' + v, en: 'film halation ' + v, w: 1.0 } : null },
  'lk.vignette_softness': { slot: 'quality', mode: 'fmt', stages: ['look'], label: '暗角柔度', fmt: (v) => v > 0 ? { zh: '暗角柔度 ' + v, en: 'vignette softness ' + v, w: 1.0 } : null },
};

/* ───────────── 处置表：nonprompt（显式声明"不影响提示词"） ───────────── */
/**
 * 这张表是本次交付最重要的诚实性资产：132 个参数明确声明不产提示词词条，并给出理由。
 * 不写理由的"不影响"等于没想清楚，下一个改代码的人会再猜一遍。
 */
const NONPROMPT = Object.create(null);
const N = (reason, keys) => { for (const k of keys) NONPROMPT[k] = reason; };

N('采样尺寸：写进文本就是黑名单里的「8K/超清」话术，模型读不到分辨率意图，画幅只能走 latent 尺寸',
  ['kf.resolution', 'kf.ratio', 'ch.image_size', 'mo.i2v_res']);
N('采样参数：改的是噪声轨迹与步数预算，不进入文本', ['kf.steps', 'kf.cfg', 'ch.steps', 'ch.cfg']);
N('采样器/调度器：纯采样器选择，无文本表征', ['kf.sampler', 'kf.scheduler', 'ch.sampler', 'ch.scheduler']);
N('精修链参数：放大与去噪强度属采样层，落词只会让模型提前"精修"，反而糊', ['kf.refine_scale', 'kf.refine_denoise', 'kf.refine_steps', 'kf.texture_pass', 'kf.usm_amount', 'kf.usm_radius', 'kf.sharpness_target']);
N('条件控制强度：CN/IPAdapter/LoRA 权重是条件强度，不是语义描述', ['kf.cn_type', 'kf.cn_weight', 'kf.cn_start', 'kf.cn_end', 'kf.cn2_type', 'kf.cn2_weight', 'kf.ipadapter_weight', 'kf.ipadapter_mode', 'kf.identity_weight', 'ch.ref_strength', 'ch.ref_images', 'ch.lora_face', 'ch.lora_outfit', 'ch.lora_style_1', 'ch.lora_style_2', 'kf.lora1_w', 'kf.lora2_w', 'kf.lora3_w', 'ch.cfg_rescale']);
N('随机性：seed 保证可复现，不参与语义', ['kf.seed', 'kf.seed_mode', 'ch.seed', 'sb.story_seed', 'mo.shake_seed']);
N('批处理：一次出几张，与单张画面无关', ['kf.batch', 'ch.batch']);
N('修复/后处理开关：改的是像素后处理，写进提示词会变成"畸形手"之类的自指污染', ['kf.face_denoise', 'kf.hand_fix', 'kf.eye_fix', 'ch.face_denoise', 'ch.lineart_model']);
N('分块与加速：VAE 分块、FreeU、TeaCache、SageAttention、Nunchaku 都是推理实现细节', ['kf.tile_size', 'kf.tile_overlap', 'kf.clip_skip', 'kf.freeu', 'kf.teacache', 'kf.sage_attn', 'kf.nunchaku', 'kf.vae_tile', 'kf.dtype']);
N('模型选择：模型 id 决定"谁来画"，不是"画什么"；不同模型的提示词风格差异由 styles 层承担', ['kf.model', 'kf.prompt_llm']);
N('锚点帧：控制关键帧采样节奏，属时序调度', ['kf.anchor_count', 'kf.anchor_interval']);
N('动效执行层：i2v 模型/强度/分辨率、层位移、帧率、补帧、光流稳定、闪烁闸门都是执行参数；它们只影响"动得稳不稳"，不影响"动什么"',
  ['mo.i2v_model', 'mo.i2v_strength', 'mo.mask_area', 'mo.easing', 'mo.fps', 'mo.interp', 'mo.interp_factor', 'mo.flow_stabilize', 'mo.max_frames', 'mo.flicker_guard', 'mo.deflicker_strength', 'mo.temporal_denoise',
    'mo.layer1_shift', 'mo.layer2_shift', 'mo.layer3_shift', 'mo.layer4_shift', 'mo.layer5_shift']);
N('文本预处理：多音字表改的是 TTS 的输入文本，本身不进入提示词', ['vo.polyphone_table']);
N('配音引擎与对齐：引擎/模型/容差属执行层，负向以 QC 清单形式给出', ['vo.lipsync_model', 'vo.align_tolerance', 'vo.loudness', 'vo.tts_engine']);
N('声学处理：压缩/EQ/降噪/清晰度是后期信号链，属"加工"不属"指令"', ['vo.compression', 'vo.eq_low', 'vo.eq_high', 'vo.denoise', 'vo.clarity']);
N('声音复制：克隆与参考音频是素材输入，不是文本指令', ['vo.voice_clone', 'vo.ref_audio']);
N('字幕层：字体/字号/位置/动效由字幕渲染器执行，写进视频提示词无效（也是黑名单里"文字"负向要压掉的东西）',
  ['lk.subtitle_style', 'lk.subtitle_font', 'lk.subtitle_size', 'lk.subtitle_pos', 'lk.subtitle_anim']);
N('调色实现：调色方式与参考图属工具链选择', ['lk.color_grade_model', 'lk.reference_image']);
N('剧本工程参数：LLM 型号/温度/token 上限/重写次数/种子/是否锁稿属生成过程控制', ['sb.llm_temperature', 'sb.llm_model', 'sb.max_tokens', 'sb.retry', 'sb.lock_script']);
N('交付与语言：输出语言、分镜表导出格式、本批集数是导出层设置', ['sb.lang', 'sb.shotlist_export', 'sb.episode_count']);
N('编码交付：分辨率/码率/编码/帧率/时长/打包/水印位置属导出与分发，与提示词无关（转场同理：写进提示词会让模型在一个镜头里画叠化，只会糊）',
  ['ex.resolution', 'ex.bitrate', 'ex.codec', 'ex.fps', 'ex.color_space', 'ex.episode_duration', 'ex.transition', 'ex.transition_duration',
    'ex.intro', 'ex.outro', 'ex.watermark_pos', 'ex.watermark_opacity', 'ex.pack_master', 'ex.pack_srt', 'ex.pack_cover', 'ex.pack_manifest',
    'ex.audio_bitrate', 'ex.loudness_norm', 'ex.faststart', 'ex.naming_rule',
    'ex.platform_douyin', 'ex.platform_bilibili', 'ex.platform_xhs', 'ex.platform_shipinhao']);
N('AI 标识与元数据：走 safety.js 的标识层（显式文本 + 隐式元数据），不属于提示词编译', ['ex.ai_label', 'ex.metadata']);

/* ───────────── 风格解析 ───────────── */

function resolveStyle(stylesDoc, name) {
  if (!name) return null;
  const list = stylesDoc.styles;
  const s = String(name).trim().toLowerCase();
  return list.find((x) => x.id.toLowerCase() === s)
    || list.find((x) => x.name === name || x.name.toLowerCase() === s)
    || list.find((x) => (x.aliases || []).some((a) => a.toLowerCase() === s))
    || list.find((x) => (x.aliases || []).some((a) => s.indexOf(a.toLowerCase()) >= 0) || x.name.indexOf(String(name)) >= 0)
    || null;
}

/* ───────────── 编译主体 ───────────── */

function emptySlots() {
  const s = {};
  for (const k of SLOTS) s[k] = [];
  return s;
}

function pushItem(st, slot, item) {
  if (!slot) return;
  if (!item) return;
  if (!item.zh) return;
  const arr = st.slots[slot];
  if (!arr) return;
  // 同槽同词只留一个：风格增量与参数常常给出等价词，重复会稀释权重
  if (arr.some((x) => x.zh === item.zh)) {
    st.trace.push({ key: item.key, slot, word: item.zh, disposition: 'consumed', dropped: '同槽重复', provenance: item.provenance || 'inferred' });
    return;
  }
  // 包含关系去重：更具体的表达胜出。风格增量常给出比参数更具体的说法
  // （"侧逆光勾出轮廓" vs "侧逆光"），两条都留会让整句复读、还摊薄后面真正重要的词。
  // 同源（都是参数或都是风格）不做包含比较，避免把并列枚举误杀。
  if (slot !== 'subject') {
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (!!a.from_style === !!item.from_style) continue;
      if (a.zh.length >= 2 && item.zh.indexOf(a.zh) >= 0) {
        arr.splice(i, 1);
        st.trace.push({ key: a.key, slot, word: a.zh, disposition: 'consumed', dropped: '被更具体表达替代(' + item.key + ')' });
        break;
      }
      if (item.zh.length >= 2 && a.zh.indexOf(item.zh) >= 0) {
        st.trace.push({ key: item.key, slot, word: item.zh, disposition: 'consumed', dropped: '已被更具体表达覆盖(' + a.key + ')' });
        return;
      }
    }
  }
  arr.push(item);
  st.trace.push({ key: item.key, slot, word: item.zh, en: item.en || '', w: item.w, provenance: item.provenance || 'inferred', emits: item.emits || 'text' });
}

function costOf(key) {
  const p = paramIndex()[key];
  if (!p || !p.impact) return null;
  return { vram: p.impact.vram || 0, time: p.impact.time || 0, quality: p.impact.quality || 0 };
}

/**
 * 参数消费：一个参数可以产出 0..n 个词条。返回值决定它是否真的"消费"了某个槽位。
 * 注意 fmt 返回 null 时仍算 consumed —— 因为"这个取值不该落词"本身是编译决策，不是没接线。
 */
function consumeParam(st, key, spec, values) {
  const raw = values[key];
  const stages = spec.stages || VISUAL;
  const mkItem = (zh, en, w, extra) => Object.assign({
    zh, en: en || '', w: w == null ? 1 : w, key, slot: spec.slot, stages,
    provenance: 'inferred', cost: costOf(key),
  }, extra || {});

  switch (spec.mode) {
    case 'text':
    case 'scan': {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) { st.trace.push({ key, disposition: 'consumed', slot: spec.slot, skipped: '空值' }); return true; }
      const hits = spec.scan ? scanTerms(s, spec.scan) : [];
      const en = hits.map((h) => h.en).filter(Boolean).join(', ');
      const w = hits.length ? Math.max(1.05, ...hits.map((h) => h.w || 1)) : 1.0;
      // 中文原话必须整句保留：用户写"米色针织衫，宽松"要的是米色与宽松，不是词条"针织衫"三个字。
      // 词表只负责补英文 tag（en），不负责改写中文。
      pushItem(st, spec.slot, mkItem(s, en, w, {
        provenance: hits.length ? 'lexicon+user-text' : 'user-text',
        matched: hits.map((h) => h.zh), dedupe_key: s,
      }));
      return true;
    }
    case 'enum': {
      const t = term(spec.group, String(raw));
      if (!t) {
        // 词库没收录的枚举值：不硬编造英文，退化为中文原值并留痕
        pushItem(st, spec.slot, mkItem(String(raw) + (spec.tag || ''), '', 1.0, { provenance: 'unmapped-enum' }));
        st.warnings.push({ id: 'lexicon-miss', level: 'gray', keys: [key], msg: '词库未收录枚举值「' + raw + '」，已按中文原值落槽，英文 tag 缺失' });
        return true;
      }
      const zhTpl = (lexicon().zh_tpl || {})[spec.group];
      const zh = zhTpl ? String(zhTpl).replace('{v}', t.zh) : (spec.tag ? t.zh + (spec.tag === '脸' ? '脸' : spec.tag) : t.zh);
      pushItem(st, spec.slot, mkItem(zh, t.en, t.w, { provenance: t.provenance, pitfall: t.pitfall, dedupe_key: zh }));
      return true;
    }
    case 'enum_generic': {
      // 中文枚举值本身就是可用词（分镜指令给 LLM 看，中文更准），只补空英文
      const s = String(raw == null ? '' : raw).trim();
      if (!s) { st.trace.push({ key, disposition: 'consumed', skipped: '空值', slot: spec.slot }); return true; }
      pushItem(st, spec.slot, mkItem(s, '', 1.0, { provenance: 'registry-enum' }));
      return true;
    }
    case 'band': {
      const b = band(spec.group, Number(raw));
      if (!b) { st.trace.push({ key, disposition: 'consumed', skipped: '无区间', slot: spec.slot }); return true; }
      pushItem(st, spec.slot, mkItem(b.zh, b.en, b.w, { provenance: b.provenance }));
      return true;
    }
    case 'fmt': {
      let out = null;
      try { out = spec.fmt(raw, values); } catch (e) { out = null; }
      if (!out) { st.trace.push({ key, disposition: 'consumed', slot: spec.slot, emits: spec.emits || 'text', skipped: '取值不落词' }); return true; }
      pushItem(st, spec.slot, mkItem(out.zh, out.en, out.w, { provenance: 'derived', dedupe_key: out.dedupe_key || out.zh, emits: spec.emits || 'text' }));
      return true;
    }
    case 'flag': {
      if (!raw) { st.trace.push({ key, disposition: 'consumed', skipped: '关闭', slot: spec.slot }); return true; }
      pushItem(st, spec.slot, mkItem(spec.zh, spec.en, spec.w, { provenance: 'inferred' }));
      return true;
    }
    case 'prefix': {
      const s = String(raw == null ? '' : raw).trim();
      if (!s) { st.trace.push({ key, disposition: 'consumed', skipped: '空值', slot: spec.slot }); return true; }
      const clean = stripBlacklist(s);
      if (clean.hits.length) {
        st.warnings.push({
          id: 'prefix-blacklist', level: 'yellow', keys: [key],
          msg: 'ch.prompt_prefix 命中黑名单 ' + clean.hits.map((h) => h.word).join('、') + '，已从 positive 剔除（这些词对扩散模型无实义，还会拉偏画风）',
          fix: '把 ch.prompt_prefix 改成具体约束（例如「同一人物，室内侧逆光」），画质诉求交给采样参数而不是文字',
        });
      }
      // 纯英文前缀不该塞进中文整句（中英混排会打乱中文底模的语序理解），
      // 它属于 tag 模型（SDXL/FLUX）的输入，所以落到 structured.meta.prefix_en，只进 positive_en。
      const hasCJK = /[\u4e00-\u9fa5]/.test(clean.text);
      if (hasCJK) pushItem(st, 'subject', mkItem(clean.text, '', 1.0, { provenance: 'user-text', prepend: true, dedupe_key: clean.text }));
      else {
        st.meta.prefix_en = clean.text;
        st.trace.push({ key, disposition: 'consumed', slot: 'subject', emits: 'en-only', word: clean.text, provenance: 'user-text' });
      }
      return true;
    }
    case 'negative': {
      st.userNegative.push({ key, text: String(raw == null ? '' : raw) });
      st.trace.push({ key, disposition: 'consumed', slot: 'negative', emits: 'negative', word: String(raw == null ? '' : raw).slice(0, 40) });
      return true;
    }
    default:
      return false;
  }
}

/* ───────────── 黑名单 ───────────── */

function blacklist() { return lexicon().blacklist.entries; }

function stripBlacklist(text) {
  let out = String(text);
  const hits = [];
  for (const e of blacklist()) {
    const word = e.word;
    const re = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(out)) {
      hits.push(e);
      out = out.replace(re, '');
    }
  }
  // 清掉残留的空逗号
  out = out.replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').replace(/\s{2,}/g, ' ');
  return { text: out, hits };
}

/* ───────────── 冲突检测 ───────────── */
/**
 * 每条冲突都要能回答三件事：哪两个参数冲突、为什么会烂、怎么改。
 * 只报"有冲突"而不给修的提示词工具，产品上等于没做。
 */
function detectConflicts(values, stage) {
  const w = [];
  const v = (k) => values[k];
  const num = (k) => Number(values[k]);
  const is2D = /赛璐璐|日漫|韩漫|国潮/.test(String(v('ch.style')));
  const add = (id, level, keys, msg, fix) => w.push({ id, level, keys, msg, fix });

  // 1) 冷光 + 暖肤色：最常见的"脸发绿"来源
  if (num('kf.color_temp') >= 6500 && (String(v('ch.palette')) === '东方暖调' || String(v('ch.skin')) === '水光' || String(v('lk.temperature')) === '0')) {
    add('cold-light-warm-skin', 'yellow', ['kf.color_temp', 'ch.palette'],
      '冷光（' + num('kf.color_temp') + 'K）打东方暖调皮肤：肤色会被压成灰绿，红润感全丢',
      '把 kf.color_temp 降到 5200 以下，或在光线里加一句「暖烛光做辅光」对冲');
  }

  // 2) 快速运镜 + 深景深：远景全清晰时，逐帧形变最容易被看见
  if (num('mo.camera_speed') >= 1.0 && num('kf.dof') <= 20) {
    add('fast-move-deep-dof', 'yellow', ['mo.camera_speed', 'kf.dof'],
      '快速运镜 + 深景深：背景全清晰，i2v 每帧的位移都会被放大成"贴图滑动"',
      '把 kf.dof 提到 40 以上（虚化吃掉背景位移），或把 mo.camera_speed 降到 0.7 以下');
  }

  // 3) 快速运镜 + 极浅景深：焦点漂移，人脸会持续跑焦
  if (num('mo.camera_speed') >= 1.0 && num('kf.dof') >= 75) {
    add('fast-move-shallow-dof', 'yellow', ['mo.camera_speed', 'kf.dof'],
      '快速运镜 + 极浅景深：模型无法维持焦点，脸会在焦内焦外反复跳',
      '降到 kf.dof ≤ 60，或改「固定」机位让虚化静态化');
  }

  // 4) 多主体 + 高一致性锁：IPAdapter 会把所有主体拉成同一张脸
  if (num('sb.character_count') >= 3 && num('ch.consistency') >= 0.8 && v('ch.identity_lock')) {
    add('multi-subject-strong-lock', 'red', ['sb.character_count', 'ch.consistency', 'ch.identity_lock'],
      '多主体（' + num('sb.character_count') + ' 人）+ 高一致性锁：身份锁会跨人物生效，多人会同脸',
      '拆成单主体分别生成，或把 ch.consistency 降到 0.6 以下并关掉 identity_lock');
  }

  // 5) 二次元画风 + 写实质感：两种底子互斥
  if (is2D && String(v('ch.skin')) === '写实纹理') {
    add('anime-vs-realistic-skin', 'red', ['ch.style', 'ch.skin'],
      '赛璐璐/日漫画风 + 写实皮肤纹理：一个要平涂，一个要毛孔，出来的是"塑料感写实脸"',
      '画风保持二次元时把 ch.skin 换成「磨皮」，或把 ch.style 换成「厚涂」');
  }

  // 6) 水墨 + 锐化/颗粒：纸感会被碾成噪点
  if (String(v('ch.style')) === '水墨' && (num('lk.sharpen') >= 40 || num('kf.grain') >= 25)) {
    add('ink-vs-sharpen', 'yellow', ['ch.style', 'lk.sharpen', 'kf.grain'],
      '水墨 + 高锐化/颗粒：墨韵扩散会被锐化成锯齿边，纸纹变噪点',
      'lk.sharpen 归零、kf.grain ≤ 4，靠 lk.ink_bleed / lk.paper_texture 出质感');
  }

  // 7) 只给近景做口型，但主导景别不是近景：口型白烧时间
  if (v('vo.lipsync') && v('vo.closeup_only') && String(v('sb.shot_scale')) === '全景') {
    add('lipsync-scale-mismatch', 'gray', ['vo.lipsync', 'vo.closeup_only', 'sb.shot_scale'],
      '要求口型但主导景别是全景：全景里口型不可辨，白烧 30% 时间（注册表 linkage 会自动关掉它）',
      '要么把 sb.shot_scale 改成近景/特写，要么关掉 vo.lipsync');
  }

  // 8) 快节奏 + 长单格：结构上自相矛盾
  if (String(v('sb.rhythm')) === '快' && num('mo.duration') >= 4) {
    add('fast-rhythm-long-take', 'yellow', ['sb.rhythm', 'mo.duration'],
      '节奏「快」但单格 ' + num('mo.duration') + ' 秒：36 秒里塞不进 24 格的快切',
      '把 mo.duration 压到 2 秒以内，或节奏改成「中」');
  }

  // 9) 步数不够却要细节：细节来自采样预算
  if (num('kf.steps') <= 18 && num('kf.detail_boost') >= 40) {
    add('steps-vs-detail', 'yellow', ['kf.steps', 'kf.detail_boost'],
      '步数 ' + num('kf.steps') + ' 却开高细节增强：未收敛的高频会变成噪点而不是细节',
      '步数提到 24 以上，或关掉 detail_boost');
  }

  // 10) 黑白调 + 发色/肤色参数：无效参数白烧 token
  if ((String(v('lk.lut')) === '黑白' || String(v('ch.palette')) === '黑白灰') && String(v('ch.hair_color')) !== '自然黑') {
    add('mono-vs-haircolor', 'gray', ['lk.lut', 'ch.hair_color'],
      '黑白交付却指定发色：发色/肤色参数在灰度画面里不可见，属无效 token',
      '确认是否真的要黑白；要灰度就走 look 阶段，keyframe 不用写发色');
  }

  // 11) 配音情绪与古风题材错配（最常见的是"俏皮"进正剧）
  if (String(v('vo.emotion')) === '俏皮' && String(v('sb.genre')) === '古风') {
    add('emotion-vs-genre', 'gray', ['vo.emotion', 'sb.genre'],
      '古风题材配「俏皮」情绪：TTS 的升调与文言句式打架，听起来像念广告',
      '改「温柔」或「平静」；真要俏皮就把题材改成都市');
  }

  // 12) 黑名单词出现在自由文本里（除 prefix 外的其他中文原话）
  return w;
}

/* ───────────── 负向集 ───────────── */

function conditions(values, stage) {
  const v = (k) => values[k];
  const visual = VISUAL.indexOf(stage) >= 0;
  const style2d = /赛璐璐|日漫|韩漫|国潮/.test(String(v('ch.style')));
  return {
    closeup: String(v('sb.shot_scale')) === '特写',
    wide: String(v('sb.shot_scale')) === '全景',
    multi_subject: Number(v('sb.character_count')) >= 3,
    hands: visual && String(v('sb.shot_scale')) !== '全景',
    text: stage === 'keyframe',
    style_2d: style2d,
    style_ink: String(v('ch.style')) === '水墨',
    motion_heavy: Number(v('mo.strength')) >= 0.7,
    particles: String(v('mo.mode')) === '粒子' || Number(v('mo.particle_count')) > 0,
    lipsync: !!v('vo.lipsync') && !!v('vo.closeup_only'),
    long_line: Number(v('vo.max_chars_per_line')) > 20,
    ink: stage === 'look' && String(v('ch.style')) === '水墨',
    film: String(v('lk.lut')) === '胶片' || Number(v('kf.grain')) >= 25,
    mono: String(v('lk.lut')) === '黑白' || String(v('ch.palette')) === '黑白灰',
    fast: String(v('sb.rhythm')) === '快',
    hook: !!v('sb.hook_seconds'),
  };
}

function buildNegative(st, values, stage) {
  const lex = lexicon();
  const set = lex.negative_sets[stage];
  const cond = conditions(values, stage);
  const st_norm = st.normal;
  const out = [];
  const src = [];

  const push = (arr, tag) => { for (const w of arr) { if (out.indexOf(w) < 0) { out.push(w); src.push(tag); } } };

  if (set) {
    push(set.base, 'base');
    for (const c in (set.by_condition || {})) {
      if (cond[c]) push(set.by_condition[c], 'cond:' + c);
    }
    st_norm.negative_kind = set.kind;
    st_norm.negative_note = set.target_note;
  }
  // 风格自带的负向（"西式礼裙/现代配饰"这类）必须并入：风格预设不只要加正向词，
  // 还要告诉模型"本风格绝不出现什么"，否则古风里冒出塑料花也只是运气问题。
  if (st.meta && st.meta.negative_extra) push(st.meta.negative_extra, 'style');
  // 用户自定义负向：过黑名单（负向里写"杰作"也毫无意义），去重并入
  for (const u of st.userNegative) {
    const parts = String(u.text).split(/[,，;；\n]/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      if (!p) continue;
      if (blacklist().some((b) => p.toLowerCase() === b.word.toLowerCase())) continue;
      if (out.indexOf(p) < 0) { out.push(p); src.push('param:' + u.key); }
    }
  }
  return { list: out, src };
}

/* ───────────── 渲染（纯函数：只能读 structured） ───────────── */

function applicable(structured, slot) {
  const arr = structured.slots[slot] || [];
  const stage = structured.stage;
  return arr.filter((it) => !it.skip && (!it.stages || it.stages.indexOf(stage) >= 0));
}

function renderZh(structured) {
  const lex = lexicon();
  const R = lex.render;
  const lead = (R.stage_lead && R.stage_lead[structured.stage]) || '';

  const head = applicable(structured, 'subject').map((i) => i.zh).join(R.inner);

  const parts = [];
  for (const slot of R.slot_order) {
    if (slot === 'subject') continue;
    const items = applicable(structured, slot);
    if (!items.length) continue;
    parts.push({ lead: R.lead[slot] || '，', body: items.map((i) => i.zh).join(R.inner) });
  }

  let s = head;
  for (let i = 0; i < parts.length; i++) {
    // 没有主体时第一段直接用 stage 前缀，别让句子以"；"开头——读起来像断句的半成品
    if (!s) s = (i === 0 ? lead : '') + parts[i].body;
    else s += parts[i].lead + parts[i].body;
  }
  if (!s) return '';
  if (!/[。.]$/.test(s)) s += R.end;
  return s;
}

function renderEn(structured) {
  const syntax = String((structured.controls || {}).weight_syntax || 'none');
  const parts = [];
  const seenFirst = new Set();
  const pre = (structured.meta || {}).prefix_en;
  if (pre) parts.push(pre);
  for (const slot of lexicon().render.slot_order) {
    for (const it of applicable(structured, slot)) {
      if (!it.en) continue;
      // 首 token 相同视为同一标签的不同写法（"medium shot, waist-up" 与 "medium shot, negative space"），
      // 只留先到的那条——SDXL 的 77 token 窗口很贵，重复标签是纯浪费。
      const firstTok = it.en.split(',')[0].trim().toLowerCase();
      if (seenFirst.has(firstTok)) continue;
      seenFirst.add(firstTok);
      let tag = it.en;
      if (syntax !== 'none' && it.w && Math.abs(it.w - 1) >= 0.05) {
        // A1111/ComfyUI 的权重语法；SDXL/FLUX 原生不吃数字权重，所以由 kf.prompt_weight_syntax 决定写不写
        tag = '(' + tag + ':' + (Math.round(it.w * 100) / 100) + ')';
      }
      parts.push(tag);
    }
  }
  // 英文 tag 去重：中文去重按槽做，英文可能跨槽重复（比如主体扫描与发型条目给同一串）
  const seen = new Set();
  return parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true))).join(', ');
}

/* ───────────── 主入口 ───────────── */

function compile(values0, opts) {
  opts = opts || {};
  const stage = opts.stage || 'keyframe';
  if (STAGES.indexOf(stage) < 0) throw new Error('未知 stage: ' + stage + '（可选：' + STAGES.join('/') + '）');

  const lex = lexicon();
  const styDoc = styles();
  const values = Object.assign({}, registryDefaults(), values0 || {});
  const style = opts.style ? resolveStyle(styDoc, opts.style) : null;
  const locale = opts.locale || 'zh';

  const st = {
    schema: 'ai-video-platform/prompt-structured',
    version: '0.1.0',
    stage,
    style: style ? style.id : null,
    style_name: style ? style.name : null,
    locale,
    target: 'llm',
    slots: emptySlots(),
    controls: {
      weight_syntax: values['kf.prompt_weight_syntax'] || 'none',
      compile_enabled: values['kf.prompt_compile'] !== false,
      ratio: values['kf.ratio'],
      resolution: values['kf.resolution'],
    },
    meta: {},
    conditions: {},
    trace: [],
    userNegative: [],
    warnings: [],
    // 代价用注册表的归一化乘性增量口径（见 tools/gen_registry.mjs 头部）：
    // 提示词层本身几乎不花钱，花钱的是它"点亮"的那些参数——所以这里只做加法汇总，不做绝对量换算。
    cost: { vram_delta: 0, time_delta: 0, quality_sum: 0, unit: 'normalized-multiplicative(0..1)' },
    normal: {},
  };

  /* 1) 先铺参数（参数优先于风格：用户手填的值必须压过预设立场） */
  for (const key in CONSUME) {
    const spec = CONSUME[key];
    if (!(key in values)) continue;
    consumeParam(st, key, spec, values);
    const c = costOf(key);
    if (c) { st.cost.vram_delta += c.vram; st.cost.time_delta += c.time; st.cost.quality_sum += c.quality; }
  }

  /* 2) 再叠风格增量（来源标成 style:<id>，这样 notes 能区分"用户设的"与"风格给的"） */
  if (style && style.structured_delta) {
    const d = style.structured_delta;
    for (const slot in d) {
      if (slot === 'negative_extra') continue;
      for (const it of d[slot]) {
        // overrides：风格声明"我接管这几个参数"。这是合并语义里最关键的一条——
        // 用户的 ch.skin=写实纹理 撞上古风的"哑光肤色"时，必须有一条明确的胜负规则，
        // 否则两个词都进句子，模型自己抽签（结果就是塑料脸）。
        if (it.overrides) {
          for (const ok of it.overrides) {
            for (const s2 of SLOTS) {
              for (const cand of st.slots[s2]) {
                if (cand.key === ok && !cand.from_style && !cand.skip) {
                  cand.skip = true;
                  cand.skip_reason = '被风格 ' + style.id + ' 覆盖';
                  const tr = st.trace.filter((t) => t.key === ok && !t.skipped).pop();
                  if (tr) tr.skipped = '风格覆盖(' + style.id + ')';
                }
              }
            }
          }
        }
        pushItem(st, slot, {
          zh: it.zh, en: it.en || '', w: it.w == null ? 1 : it.w,
          key: 'style:' + style.id, slot,
          stages: it.stages || (slot === 'audio' ? ['voice'] : slot === 'beat' ? ['storyboard'] : VISUAL),
          provenance: it.provenance || 'inferred', from_style: true,
        });
      }
    }
    st.meta.negative_extra = (style.negative_extra || []).slice();
  }
  // note：参数项先入槽，所以同词时风格项会被"同槽重复"丢掉——这正是想要的优先级；
  //       反过来，风格项更具体时会通过"包含关系"顶掉参数的裸词。

  // 服饰槽把风格给的整件衣服排前面："身穿交领广袖汉服，宽松"比"身穿宽松，交领广袖汉服"更像人话
  st.slots.outfit.sort((a, b) => (b.from_style ? 1 : 0) - (a.from_style ? 1 : 0));

  /* 3) 去重：默认值整句里已经含脸型/发型/服装，避免复读 */
  const subjText = st.slots.subject.map((i) => i.zh).join('，');
  if (subjText) {
    for (const slot of ['appearance', 'outfit', 'scene', 'light', 'camera']) {
      for (const it of st.slots[slot]) {
        if (it.from_style) continue;
        const tr = st.trace.filter((t) => t.key === it.key && t.word === it.zh).pop();
        // 先看编译期给的去重键（如"24岁"），再看逐段包含——主体句常常只说了半个词
        if (it.dedupe_key && subjText.indexOf(it.dedupe_key) >= 0) {
          it.skip = true; it.skip_reason = '主体整句已包含';
          if (tr) tr.skipped = '与主体重复';
          continue;
        }
        const segs = String(it.zh).split(/[，,、]/).map((x) => x.trim()).filter(Boolean);
        const left = segs.filter((seg) => subjText.indexOf(seg) < 0);
        if (!segs.length) continue;
        if (!left.length) {
          it.skip = true; it.skip_reason = '主体整句已包含';
          if (tr) tr.skipped = '与主体重复';
        } else if (left.length < segs.length) {
          // 只保留主体没说的部分："米色针织衫，宽松" 在主体已说米色针织衫时退化为"宽松"
          it.zh = left.join('，');
          if (tr) { tr.word = it.zh; tr.partial = true; }
        }
      }
    }
  }
  if (!st.slots.subject.length) {
    st.warnings.push({ id: 'no-subject', level: 'yellow', keys: ['ch.subject'], msg: '主体槽为空：没有主体的提示词会退化成"风格样片"，人物一致性无从谈起', fix: '填 ch.subject' });
  }

  /* 4) 条件 + 负向 */
  st.conditions = conditions(values, stage);
  const neg = buildNegative(st, values, stage);
  st.negative_src = neg.src;
  st.normal = st.normal || {};

  /* 5) 冲突 */
  st.warnings = st.warnings.concat(detectConflicts(values, stage));

  /* 6) 渲染 */
  const positive_zh = renderZh(st);
  const positive_en = renderEn(st);

  /* 7) 正文过一遍黑名单（词库/风格/自由文本都可能带进来） */
  const chk = [['positive', positive_zh], ['positive_en', positive_en]];
  for (const [field, text] of chk) {
    const c = stripBlacklist(text);
    if (c.hits.length) {
      st.warnings.push({
        id: 'positive-blacklist', level: 'red', keys: ['lexicon.blacklist'],
        msg: field + ' 命中黑名单：' + c.hits.map((h) => h.word + '（' + h.reason.slice(0, 18) + '…）').join('；'),
        fix: '从词库/风格增量里删掉该词；positive 不允许出现无实义画质词',
      });
    }
  }

  /* 8) stage 层面的交付说明 */
  let target = 'diffusion';
  if (stage === 'voice') target = 'tts';
  else if (stage === 'look') target = 'post';
  else if (stage === 'storyboard') target = 'llm';
  else if (stage === 'export') target = 'none';
  st.target = target;

  let positive = locale === 'en' ? positive_en : positive_zh;
  let negative = neg.list.join('，');

  const warnings = st.warnings.slice();
  if (stage === 'export') {
    warnings.push({ id: 'no-prompt-stage', level: 'gray', keys: [], msg: 'export 阶段不产提示词：它的产物是交付行程单（编码/打包/平台派生），提示词在 keyframe/motion 阶段已经定稿', fix: '改用 --stage keyframe 或 motion' });
  }
  if (style && style.stages && style.stages.indexOf(stage) < 0) {
    warnings.push({ id: 'style-stage-mismatch', level: 'gray', keys: ['style:' + style.id, 'stage'], msg: '风格「' + style.name + '」的适用 stage 里没有 ' + stage + '，画面语言可能与阶段目标不一致', fix: '换一个在该 stage 适用的风格，或接受它作为刻意混搭' });
  }
  if (lex.negative_sets[stage] && lex.negative_sets[stage].kind !== 'diffusion') {
    warnings.push({ id: 'negative-kind', level: 'gray', keys: [], msg: '本阶段负向集类型是 ' + lex.negative_sets[stage].kind + '：它是核对清单，不是喂给模型的负向文本（' + lex.negative_sets[stage].target_note + '）', fix: '无' });
  }

  const notes = st.trace.filter((t) => !t.skipped || t.skipped !== '空值');

  return {
    stage, style: st.style, style_name: st.style_name, target,
    positive, positive_zh, positive_en, negative,
    structured: st,
    notes,
    warnings,
  };
}

/* ───────────── lint ───────────── */

const ZH_LIMIT = 160;   // 中文整句的经验上限：超过它，后半段对模型基本无贡献，还会稀释前 20 个 token 的权重
const EN_LIMIT = 75;    // SDXL 的 77 token 窗口对齐（多出来的部分会被 CLIP 截断）

function lint(text, opts) {
  opts = opts || {};
  const src = String(text == null ? '' : text);
  const hits = [];
  for (const e of blacklist()) {
    if (new RegExp(e.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(src)) hits.push({ word: e.word, reason: e.reason, severity: e.severity, replace: e.replace });
  }
  const zhChars = (src.match(/[\u4e00-\u9fa5]/g) || []).length;
  const tokens = src.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const isEn = zhChars < src.replace(/\s/g, '').length / 2;

  // 重复段：同一个短语出现 ≥2 次 = 复读；同一 token 出现 ≥3 次 = 无效堆砌
  const segs = src.split(/[,，;；。\n]/).map((s) => s.trim()).filter((s) => s.length >= 2);
  const segCount = {};
  for (const s of segs) segCount[s] = (segCount[s] || 0) + 1;
  const duplicates = Object.keys(segCount).filter((k) => segCount[k] > 1).map((k) => ({ text: k, times: segCount[k] }));

  const advice = [];
  const overlong = isEn ? tokens.length > EN_LIMIT : zhChars > ZH_LIMIT;
  if (overlong) advice.push(isEn
    ? '超长：' + tokens.length + ' 个 tag 超过 SDXL 的 77 token 窗口，后面的会被截断。删掉画质词与重复形容词，只留主体+光线+镜头'
    : '超长：' + zhChars + ' 个汉字（建议 ≤' + ZH_LIMIT + '）。中文底模对长句后半段的注意力急剧衰减，把"氛围词"删掉，留骨架');
  if (hits.length) advice.push('黑名单命中 ' + hits.length + ' 项：' + hits.map((h) => h.word).join('、') + '。这些词不产生可辨识的视觉变化，删掉不亏');
  if (duplicates.length) advice.push('复读 ' + duplicates.length + ' 处：' + duplicates.map((d) => d.text + '×' + d.times).join('；'));

  return {
    ok: hits.length === 0 && !overlong && duplicates.length === 0,
    chars: zhChars, tags: tokens.length, overlong,
    hits, duplicates, advice,
  };
}

/* ───────────── 覆盖统计（给 selftest 与文档用） ───────────── */

function dispositions() {
  const reg = registry();
  if (!reg) return { total: 0, l3: 0, rows: [] };
  const rows = reg.params.map((p) => {
    if (CONSUME[p.key]) {
      const spec = CONSUME[p.key];
      return { key: p.key, stage: p.stage, tier: p.tier, disposition: 'consumed', slot: spec.slot || null, emits: spec.emits || 'text', reason: spec.label || '' };
    }
    if (NONPROMPT[p.key]) {
      return { key: p.key, stage: p.stage, tier: p.tier, disposition: 'nonprompt', slot: null, emits: 'none', reason: NONPROMPT[p.key] };
    }
    return { key: p.key, stage: p.stage, tier: p.tier, disposition: 'unmapped', slot: null, emits: 'none', reason: '' };
  });
  const l3 = rows.filter((r) => r.tier === 'L3');
  return { total: rows.length, l3: l3.length, rows, l3rows: l3 };
}

/* ───────────── 预设 ───────────── */
/**
 * 预设只是 values 的覆盖层，不是风格。风格改"看起来怎样"，预设改"花多少时间"。
 */
const PRESETS = {
  standard: { label: '默认（= 注册表默认值）', values: {} },
  draft: { label: '草稿：低步数、不精修、不补帧', values: { 'kf.steps': 16, 'kf.refine_scale': 1.0, 'mo.interp': false, 'kf.anchor_count': 0 } },
  hero: { label: '定稿：高步数、2× 精修、强一致性', values: { 'kf.steps': 36, 'kf.refine_scale': 2.0, 'kf.refine_denoise': 0.5, 'ch.consistency': 0.92 } },
  vertical: { label: '竖屏信息流', values: { 'kf.ratio': '9:16', 'ex.resolution': '1080p', 'sb.grid_count': 24 } },
};

function listStyles() {
  return styles().styles.map((s) => ({ id: s.id, name: s.name, aliases: s.aliases, stages: s.stages, why: s.why }));
}

module.exports = {
  STAGES, SLOTS, SLOT_TITLES, VISUAL, PRESETS,
  lexicon, styles, registry,
  compile, renderZh, renderEn, lint, listStyles, resolveStyle,
  dispositions, conditions, detectConflicts, stripBlacklist, blacklist,
  CONSUME, NONPROMPT,
};