/**
 * params.registry.json 生成器（v0.1）
 *
 * 为什么用生成器而不是手写 JSON：
 *   七板块 258 个参数的字段高度重复（type/min/max/hint/impact/bind），手写既费时又容易漏字段。
 *   这里用 DSL 描述，跑 `node tools/gen_registry.mjs` 产出 spec/params.registry.json。
 *   生成物是唯一真相源：UI、求解器、模板导出、workflow 编译全部只读 JSON，不读本文件。
 *
 * 字段口径（与设计文档 §28 一致）：
 *   impact = [vram, time, quality]
 *     vram   —— 归一化到 0..1 的参数位置对峰值显存的乘性增量（0.05 = 满量程 +5%）
 *     time   —— 同上，对耗时的乘性增量
 *     quality—— 对质量分的边际贡献权重（0..1，1.0 = 单参数吃满 100 分）
 *   物理参数（分辨率/帧数/量化/模型）的 vram 记为 0：显存由求解器的物理方程算，不在这里重复计。
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = '0.1.0';
const UPDATED = '2026-11-16';

const STAGES = [
  { id: 'character', code: 'A', name: '角色设定', en: 'Character', l3: 6, total: 42, desc: '一张脸贯穿全剧：骨相/服装/画风/一致性' },
  { id: 'storyboard', code: 'B', name: '剧本分镜', en: 'Storyboard', l3: 5, total: 34, desc: '格数/节奏/景别/情绪曲线，LLM 出分镜表' },
  { id: 'keyframe', code: 'C', name: '关键帧', en: 'Keyframe', l3: 8, total: 56, desc: '画质主战场：七阶精修、四把锁、ControlNet/IPAdapter' },
  { id: 'motion', code: 'D', name: '动效', en: 'Motion', l3: 7, total: 38, desc: '视差/局部 i2v/粒子，帧率与光流稳定' },
  { id: 'voice', code: 'E', name: '配音口型', en: 'Voice', l3: 5, total: 30, desc: 'TTS、多音字、口型对齐、响度' },
  { id: 'look', code: 'F', name: '质感后期', en: 'Look', l3: 6, total: 32, desc: 'LUT/颗粒/赛璐璐/字幕，统一观感' },
  { id: 'export', code: 'G', name: '输出', en: 'Export', l3: 6, total: 26, desc: '编码/码率/多平台派生/打包' },
];

const params = [];

/** 参数 DSL。key 形如 'kf.steps'，stage 自动取前缀展开。 */
function p(key, type, def, o = {}) {
  const prefix = key.split('.')[0];
  const stageMap = { ch: 'character', sb: 'storyboard', kf: 'keyframe', mo: 'motion', vo: 'voice', lk: 'look', ex: 'export' };
  const stage = stageMap[prefix];
  if (!stage) throw new Error('unknown prefix: ' + key);
  const entry = {
    key,
    stage,
    type,
    default: def,
  };
  if (['int', 'float', 'seed'].includes(type)) {
    entry.min = o.min ?? 0;
    entry.max = o.max ?? 100;
    entry.step = o.step ?? (type === 'int' ? 1 : 0.01);
  }
  if (type === 'enum') entry.options = o.options || [];
  if (type === 'bool') { /* 无范围 */ }
  if (o.unit) entry.unit = o.unit;
  entry.label = o.label || key;
  entry.hint = o.hint || '';
  entry.tier = o.tier || 'L4';
  entry.impact = { vram: o.i?.[0] ?? 0, time: o.i?.[1] ?? 0, quality: o.i?.[2] ?? 0 };
  if (o.presets) entry.presets = o.presets;
  if (o.guards) entry.guards = o.guards.map((g) => ({ when: g[0], warn: g[1] }));
  if (o.options) entry.options = o.options;
  entry.bind = { target: o.bind?.[0] || '', widget: o.bind?.[1] || '' };
  // bind_ds：DashScope（通义万相）通路的绑定，与 ComfyUI 的 bind 并列（任务卡②）。
  // path 是 API 请求体点路径；'input.prompt' 表示经 prompt/compose.js 槽位编译间接消费。
  if (o.ds) entry.bind_ds = { path: o.ds };
  if (o.auto) entry.auto = true;          // 由联动求解器写入，UI 只读
  if (o.derived) entry.derived = true;    // 派生显示字段，不入 preset
  params.push(entry);
}

/* ───────────────────────── A · 角色设定 (42) ───────────────────────── */
p('ch.subject', 'text', '一个24岁的中国女孩，鹅蛋脸，黑色长直发，米色针织衫，站在窗边', { ds: 'input.prompt',
  tier: 'L3', label: '主体描述', hint: '一句话交代年龄/脸型/发型/服装/场景。中文整句，求解器会拼进最终提示词。',
  i: [0, 0.03, 0.30], bind: ['CLIP Text Encode', 'text'],
});
p('ch.age', 'int', 24, { min: 16, max: 60, unit: '岁', tier: 'L3', label: '年龄感', hint: '影响骨相与皮肤质感；误差 ±4 岁内不易被察觉', i: [0, 0, 0.06], bind: ['Character Builder', 'age'] });
p('ch.face_shape', 'enum', '鹅蛋', { options: ['鹅蛋', '圆', '方', '瓜子', '长', '心形'], tier: 'L3', label: '骨相脸型', hint: '一致性最强的锚点之一，换脸型等于换人', i: [0, 0, 0.10], bind: ['Character Builder', 'face_shape'] });
p('ch.face_detail', 'text', '', { ds: 'input.prompt', label: '五官细节补充', hint: '如「内双、鼻梁细直、唇珠明显」，与骨相互补', i: [0, 0, 0.08], bind: ['CLIP Text Encode', 'text'] });
p('ch.body', 'enum', '标准', { options: ['纤细', '标准', '丰润', '高挑'], label: '体态', hint: '颈肩线与腰胯比决定「像不像真人」，比脸更容易被忽略', i: [0, 0, 0.05] });
p('ch.skin', 'enum', '写实纹理', { options: ['哑光', '水光', '磨皮', '写实纹理'], label: '肤质', hint: '「写实纹理」保留毛孔与微瑕，商用观感更像摄影', i: [0, 0, 0.08] });
p('ch.hair_style', 'enum', '黑色长直发', { options: ['黑色长直发', '短发齐耳', '高马尾', '古风发髻', '微卷中长', '空气刘海'], tier: 'L4', label: '发型', hint: '发丝走向决定 i2v 的形变难度', i: [0, 0.01, 0.08] });
p('ch.hair_color', 'enum', '自然黑', { options: ['自然黑', '栗棕', '亚麻', '冷灰', '挑染'], label: '发色', i: [0, 0, 0.03] });
p('ch.outfit_1', 'text', '米色针织衫，宽松', { ds: 'input.prompt', tier: 'L3', label: '主服装', hint: '面料写清楚（针织/雪纺/棉麻），纹理阶依赖它', i: [0, 0.02, 0.10] });
p('ch.outfit_2', 'text', '', { label: '副服装 1', hint: '同一角色的第二套，用于换装镜头', i: [0, 0.02, 0.04] });
p('ch.outfit_3', 'text', '', { label: '副服装 2', i: [0, 0.02, 0.04] });
p('ch.palette', 'enum', '东方暖调', { ds: 'input.prompt', options: ['东方暖调', '莫兰迪', '高饱和', '冷青电影', '黑白灰'], label: '配色方案', hint: '决定整片色彩基调，与 F 板块 LUT 需一致', i: [0, 0, 0.06] });
p('ch.style', 'enum', '厚涂', { ds: 'input.prompt', options: ['赛璐璐', '厚涂', '工笔', '水墨', '韩漫', '日漫', '国潮'], tier: 'L3', label: '画风', hint: '画风是最大的质量杠杆：赛璐璐容错高，厚涂上限高', i: [0, 0, 0.18] });
p('ch.line_weight', 'int', 35, { min: 0, max: 100, label: '线稿强度', hint: '0 = 无线稿纯色块；赛璐璐建议 40–60', i: [0, 0.05, 0.10] });
p('ch.screen_tone', 'int', 20, { min: 0, max: 100, label: '网点密度', hint: '漫画网点，过量会脏', i: [0, 0.02, 0.05] });
p('ch.shadow_levels', 'int', 2, { min: 1, max: 3, label: '阴影阶数', hint: '1=平涂 2=两阶 3=三阶+高光，阶数越多越像厚涂', i: [0, 0.02, 0.05] });
p('ch.expression_count', 'int', 5, { min: 1, max: 8, label: '表情数', hint: '每个表情一次出图，直接乘耗时', i: [0, 0.10, 0.03] });
p('ch.pose_count', 'int', 3, { min: 1, max: 6, label: '姿态数', hint: '三视图开启后姿态数会被自动抬高', i: [0, 0.10, 0.02] });
p('ch.turnaround', 'bool', true, { label: '三视图', hint: '正/侧/背三视图卡，角色一致性的硬保障', i: [0, 0.25, 0.05] });
p('ch.consistency', 'float', 0.85, { min: 0, max: 1.5, step: 0.05, tier: 'L3', label: '一致性权重', hint: '>1.0 会略微牺牲构图自由度换取同脸率；漫剧建议 0.85–1.1', i: [0.03, 0.04, 0.12], guards: [['>1.2', '过强：构图会僵，建议降到 1.1 以下']] });
p('ch.ref_images', 'int', 2, { min: 1, max: 6, label: '参考图数', hint: '每张参考都要过 IPAdapter，显存与耗时同步上升', i: [0.08, 0.20, 0.06] });
p('ch.image_size', 'enum', '1536', { options: ['1024', '1536', '2048'], label: '角色图尺寸', hint: '八字档：1536 足以支撑 1080p 成片', i: [0.12, 0.25, 0.10] });
p('ch.steps', 'int', 24, { min: 8, max: 50, label: '角色图步数', i: [0, 0.35, 0.25], presets: { draft: 12, standard: 24, cinematic: 34 } });
p('ch.cfg', 'float', 4.5, { min: 1, max: 10, step: 0.1, label: '角色图 CFG', i: [0, 0.05, 0.10] });
p('ch.sampler', 'enum', 'dpmpp_2m', { options: ['euler', 'euler_a', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc'], label: '采样器', i: [0, 0.03, 0.06] });
p('ch.scheduler', 'enum', 'karras', { options: ['normal', 'karras', 'exponential', 'sgm_uniform', 'beta'], label: '调度器', i: [0, 0.03, 0.05] });
p('ch.lora_style_1', 'float', 0.7, { min: -1, max: 2, step: 0.05, label: '画风 LoRA 1 权重', hint: '同一 LoRA 0.6–0.8 是甜区，>1.2 会吃掉提示词', i: [0.04, 0.06, 0.12] });
p('ch.lora_style_2', 'float', 0, { min: -1, max: 2, step: 0.05, label: '画风 LoRA 2 权重', i: [0.04, 0.06, 0.08] });
p('ch.lora_face', 'float', 0.8, { min: 0, max: 1.5, step: 0.05, label: '角色 LoRA 权重', hint: '自训角色 LoRA 是跨集同脸的根本手段', i: [0.04, 0.06, 0.12] });
p('ch.lora_outfit', 'float', 0.5, { min: 0, max: 1.5, step: 0.05, label: '服装 LoRA 权重', i: [0.03, 0.05, 0.06] });
p('ch.cfg_rescale', 'float', 0.5, { min: 0, max: 1, step: 0.05, label: 'CFG 重缩放', hint: '高 CFG 下防过曝，厚涂建议 0.4–0.6', i: [0, 0, 0.04] });
p('ch.seed', 'seed', -1, { label: '角色种子', hint: '-1 = 随机；锁定种子可复现同一张脸', i: [0, 0, 0.02] });
p('ch.batch', 'int', 1, { min: 1, max: 8, label: '出图张数', hint: '张数线性乘耗时，选图用候选更省总时间', i: [0.10, 0.35, 0.02] });
p('ch.face_denoise', 'float', 0.35, { min: 0, max: 0.8, step: 0.05, label: '面部重绘强度', hint: '画质七阶第 2 阶：不跑这一步，脸一定软', i: [0.02, 0.12, 0.16] });
p('ch.identity_lock', 'bool', true, { label: '身份锁', hint: '开启后所有镜头强制带角色锚点，禁止漂移', i: [0.03, 0.02, 0.10] });
p('ch.prompt_prefix', 'text', 'masterpiece, best quality, consistent character,', { label: '提示词前缀', i: [0, 0, 0.06] });
p('ch.negative', 'text', '模糊, 低质量, 水印, 文字, 畸形手指, 多余肢体', { ds: 'input.negative_prompt', label: '排除词', i: [0, 0, 0.05] });
p('ch.ref_strength', 'float', 0.65, { min: 0, max: 1, step: 0.05, label: '参考强度', hint: '参考图与提示词打架时，先降这个再降权重', i: [0, 0, 0.08] });
p('ch.hair_detail', 'int', 60, { min: 0, max: 100, label: '发丝细节', hint: '发丝是「塑料感」的第一破绽', i: [0, 0.02, 0.05] });
p('ch.eye_highlight', 'int', 55, { min: 0, max: 100, label: '瞳孔高光', hint: '有高光才有活人感，过低会「死眼」', i: [0, 0, 0.05] });
p('ch.fabric_texture', 'int', 60, { min: 0, max: 100, label: '织物纹理', i: [0, 0.02, 0.05] });
p('ch.lineart_model', 'enum', 'lineart', { options: ['lineart', 'canny', 'te', 'none'], label: '线稿提取模型', i: [0.02, 0.02, 0.04] });

/* ───────────────────────── B · 剧本分镜 (34) ───────────────────────── */
p('sb.duration', 'int', 36, { min: 15, max: 120, unit: 's', tier: 'L3', label: '目标时长', hint: '单集总时长；成片时长由它反推格数与台词量', i: [0, 0.45, 0.03] });
p('sb.grid_count', 'int', 24, { min: 12, max: 40, tier: 'L3', label: '每集格数', hint: '漫剧 24 格 ≈ 30–40s；每格一次关键帧 + 一次动效', i: [0, 0.60, 0.04] });
p('sb.rhythm', 'enum', '中', { options: ['快', '中', '慢', '变速'], tier: 'L3', label: '节奏模板', hint: '快=每格 0.8s，慢=1.8s；变速适合情绪转折', i: [0, 0.10, 0.05] });
p('sb.shot_scale', 'enum', '中景', { options: ['特写', '中景', '全景'], tier: 'L3', label: '主导景别', hint: '特写提升口型价值，全景提升信息量', i: [0, 0.05, 0.05] });
p('sb.shot_diversity', 'int', 60, { min: 0, max: 100, tier: 'L3', label: '机位多样性', hint: '>70 更电影，但一致性压力上升', i: [0, 0.08, 0.06] });
p('sb.closeup_ratio', 'int', 35, { min: 0, max: 100, unit: '%', label: '特写占比', hint: '三项合计建议 100%', i: [0, 0.03, 0.03] });
p('sb.medium_ratio', 'int', 45, { min: 0, max: 100, unit: '%', label: '中景占比', i: [0, 0.02, 0.02] });
p('sb.wide_ratio', 'int', 20, { min: 0, max: 100, unit: '%', label: '全景占比', i: [0, 0.02, 0.02] });
p('sb.emotion_curve', 'int', 65, { min: 0, max: 100, label: '情绪曲线强度', hint: '起承转合的起伏幅度', i: [0, 0.02, 0.07] });
p('sb.act_structure', 'enum', '起承转合', { options: ['起承转合', '三幕', '单线'], label: '叙事结构', i: [0, 0, 0.05] });
p('sb.line_density', 'float', 4.2, { min: 0, max: 8, step: 0.1, unit: '字/秒', label: '台词密度', hint: '中文 4–5 字/秒最舒适，>6 会听不清', i: [0, 0.05, 0.05] });
p('sb.narration_ratio', 'int', 30, { min: 0, max: 100, unit: '%', label: '旁白占比', i: [0, 0.02, 0.04] });
p('sb.genre', 'enum', '古风', { options: ['古风', '都市', '科幻', '悬疑', '校园', '玄幻'], label: '题材', hint: '决定提示词词典与 LUT 默认值', i: [0, 0, 0.05] });
p('sb.camera_language', 'enum', '写实剧', { options: ['今敏式', '宫崎式', '写实剧', '快剪'], label: '镜头语言', i: [0, 0, 0.08] });
p('sb.llm_temperature', 'float', 0.7, { min: 0, max: 1, step: 0.05, label: 'LLM 温度', hint: '>0.9 会出戏，<0.4 会套路化', i: [0, 0.02, 0.04] });
p('sb.lang', 'enum', '中文', { options: ['中文', '英文', '日文'], label: '输出语言', i: [0, 0, 0] });
p('sb.llm_model', 'enum', 'Qwen3-8B', { options: ['Qwen3-8B', 'GLM-4-9B', 'DeepSeek-V3(API)'], label: '分镜 LLM', hint: '本地 8B 够用；API 更快但按量计费', i: [0, 0.10, 0.06] });
p('sb.max_tokens', 'int', 2048, { min: 512, max: 4096, step: 256, label: '最大 token', i: [0, 0.10, 0.02] });
p('sb.scene_count', 'int', 3, { min: 1, max: 8, label: '场景数', hint: '每场景一次场景图出图，切场景需重锁光影', i: [0, 0.20, 0.03] });
p('sb.transition_count', 'int', 2, { min: 0, max: 8, label: '转场数', i: [0, 0.05, 0.02] });
p('sb.conflict_intensity', 'int', 60, { min: 0, max: 100, label: '冲突强度', i: [0, 0, 0.06] });
p('sb.hook_seconds', 'bool', true, { label: '前 3 秒钩子', hint: '短视频完播率的第一杠杆', i: [0, 0, 0.05] });
p('sb.subtitle_lines', 'int', 2, { min: 1, max: 3, label: '字幕行数上限', i: [0, 0, 0] });
p('sb.character_count', 'int', 1, { min: 1, max: 4, label: '角色数', hint: '每多一个角色多一套锚点与 LoRA 显存', i: [0.04, 0.02, 0.04] });
p('sb.story_seed', 'seed', -1, { label: '剧本种子', i: [0, 0, 0] });
p('sb.retry', 'int', 1, { min: 0, max: 3, label: '重写次数', hint: '分镜不满意时自动重写，线性加时间', i: [0, 0.30, 0.03] });
p('sb.beat_per_grid', 'int', 2, { min: 1, max: 4, label: '每格节拍数', i: [0, 0, 0.03] });
p('sb.silence_ratio', 'int', 10, { min: 0, max: 60, unit: '%', label: '静场占比', i: [0, 0, 0.02] });
p('sb.bgm_cue_count', 'int', 3, { min: 0, max: 12, label: 'BGM 提示点数', i: [0, 0.02, 0.02] });
p('sb.shotlist_export', 'enum', 'JSON', { options: ['JSON', 'CSV', '表格'], label: '分镜表导出格式', i: [0, 0, 0] });
p('sb.lock_script', 'bool', true, { label: '锁定剧本', hint: '锁定后改参数不会重写分镜，只改画面', i: [0, 0, 0] });
p('sb.style_ref', 'text', '', { label: '参考剧集/风格描述', i: [0, 0, 0.05] });
p('sb.episode_count', 'int', 1, { min: 1, max: 12, label: '本批集数', hint: '整批任务量，影响总耗时与排队', i: [0, 0.30, 0] });
p('sb.title_style', 'enum', '留白书法', { options: ['留白书法', '居中黑体', '无标题'], label: '标题风格', i: [0, 0, 0.02] });

/* ───────────────────────── C · 关键帧 (56) ───────────────────────── */
p('kf.resolution', 'int', 1536, { min: 512, max: 2048, step: 64, tier: 'L3', label: '关键帧分辨率', hint: '长边像素。1536 是 8G 卡的商用下限，2048 会挤爆显存', i: [0, 0.55, 0.30], bind: ['EmptyLatentImage', 'width'], guards: [['>1792', '8G 卡上 1792+ 需要分块或换档'], ['<1024', '低于 1024 细节无法支撑 1080p 成片']] });
p('kf.ratio', 'enum', '16:9', { ds: 'parameters.ratio', options: ['16:9', '9:16', '1:1', '4:3', '2.35:1'], tier: 'L3', label: '纵横比', i: [0, 0.02, 0.05] });
p('kf.steps', 'int', 20, { min: 16, max: 25, tier: 'L3', label: '采样步数', hint: '质量优先固定16–25步，不自动减步数', i: [0, 0.42, 0.31], presets: { draft: 20, standard: 20, cinematic: 25 }, bind: ['KSampler', 'steps'] });
p('kf.cfg', 'float', 7, { min: 7, max: 10, step: 0.1, tier: 'L3', label: 'CFG', hint: '质量优先固定7–10，不使用蒸馏极速路径', i: [0, 0.04, 0.10], presets: { draft: 7, standard: 7, cinematic: 8 } });
p('kf.sampler', 'enum', 'dpmpp_2m', { options: ['euler', 'euler_a', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'uni_pc'], label: '采样器', i: [0, 0.03, 0.06] });
p('kf.scheduler', 'enum', 'karras', { options: ['normal', 'karras', 'exponential', 'sgm_uniform', 'beta'], label: '调度器', i: [0, 0.03, 0.05] });
p('kf.refine_scale', 'float', 1.5, { min: 1, max: 2, step: 0.1, tier: 'L3', label: '精修放大倍率', hint: '画质七阶第 1 阶：hires-fix 1.5× 补结构细节', i: [0.12, 0.30, 0.22], presets: { draft: 1.0, standard: 1.5, cinematic: 1.8 } });
p('kf.refine_denoise', 'float', 0.65, { min: 0.55, max: 0.75, step: 0.01, tier: 'L3', label: '采样去噪', hint: '质量区间0.55–0.75，所有生成入口一致', i: [0, 0.10, 0.14], presets: { draft: 0.65, standard: 0.65, cinematic: 0.65 } });
p('kf.refine_steps', 'int', 12, { min: 4, max: 24, label: '精修步数', i: [0, 0.22, 0.12] });
p('kf.cn_type', 'enum', 'lineart', { options: ['none', 'lineart', 'canny', 'depth', 'pose'], tier: 'L4', label: 'ControlNet 类型', hint: '构图锁：lineart 最稳，depth 适合大景深', i: [0.05, 0.06, 0.08] });
p('kf.cn_weight', 'float', 0.7, { min: 0, max: 2, step: 0.05, tier: 'L3', label: 'CN 权重', hint: '0.6–1.0 锁构图；>1.3 会僵硬', i: [0.03, 0.12, 0.12] });
p('kf.cn_start', 'float', 0, { min: 0, max: 1, step: 0.01, label: 'CN 起效步', i: [0, 0.02, 0.04] });
p('kf.cn_end', 'float', 0.8, { min: 0, max: 1, step: 0.01, label: 'CN 失效步', i: [0, 0.02, 0.04] });
p('kf.cn2_type', 'enum', 'none', { options: ['none', 'lineart', 'canny', 'depth', 'pose'], label: '第二 ControlNet', hint: '第二张控制图，显存几乎翻倍', i: [0.06, 0.05, 0.05] });
p('kf.cn2_weight', 'float', 0.4, { min: 0, max: 2, step: 0.05, label: 'CN2 权重', i: [0.02, 0.10, 0.08] });
p('kf.ipadapter_weight', 'float', 0.75, { min: 0, max: 1.5, step: 0.05, tier: 'L3', label: 'IPAdapter 权重', hint: '角色锁的抓手；0.6–0.9 同脸且不死板', i: [0.06, 0.08, 0.12] });
p('kf.ipadapter_mode', 'enum', '构图', { options: ['构图', '风格', '两者'], label: 'IPAdapter 模式', i: [0, 0.02, 0.03] });
p('kf.identity_weight', 'float', 1.0, { min: 0.6, max: 1.5, step: 0.05, label: '一致性权重（联动）', hint: '运动强度 >0.6 时由联动引擎自动抬高', i: [0, 0, 0.10], auto: true });
p('kf.lora1_w', 'float', 0.7, { min: -1, max: 2, step: 0.05, label: 'LoRA 1 权重', i: [0.04, 0.06, 0.10] });
p('kf.lora2_w', 'float', 0.4, { min: -1, max: 2, step: 0.05, label: 'LoRA 2 权重', i: [0.04, 0.06, 0.08] });
p('kf.lora3_w', 'float', 0, { min: -1, max: 2, step: 0.05, label: 'LoRA 3 权重', i: [0.04, 0.06, 0.06] });
p('kf.composition', 'enum', '九宫格', { ds: 'input.prompt', options: ['九宫格', '黄金分割', '居中', '大留白'], label: '构图锁定', i: [0, 0, 0.06] });
p('kf.negative_space', 'int', 20, { min: 0, max: 60, unit: '%', label: '留白比例', hint: '留白给字幕与呼吸感，>40% 主体会弱', i: [0, 0, 0.05] });
p('kf.color_temp', 'int', 5200, { ds: 'input.prompt', min: 2700, max: 8000, step: 50, unit: 'K', tier: 'L4', label: '色温', hint: '黄昏 3800–4500K，正午 5500–6000K', i: [0, 0, 0.07] });
p('kf.light_ratio', 'float', 2.5, { min: 1, max: 8, step: 0.1, label: '光比', hint: '>4 是硬光戏剧感，1.5 是柔和棚拍', i: [0, 0.02, 0.07] });
p('kf.key_light_dir', 'enum', '侧逆光', { ds: 'input.prompt', options: ['顺光', '侧光', '侧逆光', '顶光', '底光'], label: '主光方向', i: [0, 0, 0.06] });
p('kf.dof', 'int', 40, { ds: 'input.prompt', min: 0, max: 100, label: '景深强度', hint: '浅景深显贵，但会吃掉背景细节', i: [0.02, 0.05, 0.06] });
p('kf.batch', 'int', 1, { min: 1, max: 4, label: '批量', hint: '每批张数，生成候选用', i: [0, 0.35, 0.02] });
p('kf.seed', 'seed', -1, { ds: 'parameters.seed', label: '关键帧种子', i: [0, 0, 0.02] });
p('kf.seed_mode', 'enum', '锁定', { options: ['锁定', '随机', '递增'], label: 'seed 策略', hint: '锁定=同一镜头可复现；递增=每格微变化', i: [0, 0.02, 0.02] });
p('kf.face_denoise', 'float', 0.35, { min: 0, max: 0.8, step: 0.05, label: '面部重绘（七阶第 2 阶）', hint: '脸/手/眼专项重绘，不做必软', i: [0.02, 0.12, 0.16], presets: { draft: 0, standard: 0.35, cinematic: 0.45 } });
p('kf.hand_fix', 'bool', true, { label: '手部修复', hint: '指节与握姿专项重绘', i: [0.02, 0.10, 0.10] });
p('kf.eye_fix', 'bool', true, { label: '眼部高光修复', i: [0.02, 0.08, 0.08] });
p('kf.tile_size', 'int', 1024, { min: 512, max: 1536, step: 64, label: '分块尺寸', hint: '分块超分越小越省显存，接缝风险越高', i: [0.10, 0.10, 0.02] });
p('kf.tile_overlap', 'int', 64, { min: 32, max: 192, step: 16, label: '分块重叠', hint: '64–96 基本无接缝', i: [0.05, 0.05, 0.01] });
p('kf.texture_pass', 'float', 0.2, { min: 0, max: 0.4, step: 0.01, label: '纹理 pass 去噪', hint: '七阶第 4 阶：0.15–0.25 注入材质颗粒', i: [0.02, 0.10, 0.14], presets: { draft: 0, standard: 0.2, cinematic: 0.25 } });
p('kf.usm_amount', 'float', 0.35, { min: 0, max: 2, step: 0.05, label: 'USM 锐化量', hint: '1.2/0.35 是印刷常用组合', i: [0, 0.02, 0.10], presets: { draft: 0.2, standard: 0.35, cinematic: 0.5 } });
p('kf.usm_radius', 'float', 1.2, { min: 0.2, max: 3, step: 0.1, label: 'USM 半径', i: [0, 0.02, 0.05] });
p('kf.grain', 'int', 4, { ds: 'input.prompt', min: 0, max: 20, label: '底片颗粒', hint: '3–6% 去塑料感，多了像噪点', i: [0, 0.02, 0.04] });
p('kf.tonemap', 'enum', 'filmic', { options: ['none', 'filmic', 'aces', 'reinhard'], label: '色调映射', i: [0, 0, 0.04] });
p('kf.clip_skip', 'int', 2, { min: 1, max: 3, label: 'CLIP 跳过层', i: [0, 0.02, 0.03] });
p('kf.freeu', 'bool', false, { label: 'FreeU', i: [0, 0.03, 0.03] });
p('kf.teacache', 'bool', false, { label: 'TeaCache（质量模式禁用）', hint: '不跳过采样步骤', i: [0, 0, 0] });
p('kf.sage_attn', 'bool', false, { label: 'SageAttention（质量模式禁用）', i: [0, 0, 0] });
p('kf.nunchaku', 'bool', false, { label: 'Nunchaku（质量模式禁用）', hint: '不使用int4量化加速', i: [0, 0, 0] });
p('kf.vae_tile', 'bool', true, { label: 'VAE 分块解码', hint: '8G 必开，否则解码阶段 OOM', i: [0.08, 0.10, 0] });
p('kf.dtype', 'enum', 'fp16', { options: ['fp16'], label: '推理精度', hint: '质量优先不自动量化；需要对应未量化模型权重', i: [0, 0.05, 0.05] });
p('kf.model', 'enum', 'Qwen-Image-GGUF-Q4', { options: ['Qwen-Image-GGUF-Q4', 'Qwen-Image-fp8', 'SDXL', 'Flux-GGUF-Q4'], label: '关键帧模型', hint: '8G：Qwen-Image Q4 出图质量最好；SDXL 最快', i: [0, 0.25, 0.10] });
p('kf.negative', 'text', '低质量, 模糊, 水印, 文字, 变形, 塑料感', { ds: 'input.negative_prompt', label: '关键帧排除词', i: [0, 0, 0.05] });
p('kf.prompt_weight_syntax', 'enum', 'A1111', { options: ['A1111', 'ComfyUI', '自然语言'], label: '提示词权重语法', i: [0, 0, 0.04] });
p('kf.prompt_compile', 'bool', true, { label: '中文提示词编译', hint: '本地 LLM 把中文整句翻成 danbooru 风格标签', i: [0, 0.08, 0.10] });
p('kf.prompt_llm', 'enum', 'Qwen3-4B', { options: ['Qwen3-4B', 'Qwen3-8B', '规则模板'], label: '编译用 LLM', i: [0, 0.10, 0.05] });
p('kf.detail_boost', 'int', 30, { min: 0, max: 100, label: '细节增强', hint: '提示词加权 + 精修去噪的合成旋钮', i: [0, 0.05, 0.08], presets: { draft: 5, standard: 30, cinematic: 60 } });
p('kf.sharpness_target', 'int', 420, { min: 0, max: 1000, label: '锐度目标（拉普拉斯方差）', hint: '质检闸门：低于它判「糊」', i: [0, 0, 0.03] });
p('kf.anchor_count', 'int', 1, { min: 0, max: 8, label: '锚点帧数', hint: '每 8 帧一个锚点，近景加密；8G 预算下建议 1–2 个', i: [0, 0.30, 0.06], presets: { draft: 0, standard: 1, cinematic: 3 } });
p('kf.anchor_interval', 'int', 8, { min: 4, max: 16, label: '锚点间隔（帧）', i: [0, 0.10, 0.04] });

/* ───────────────────────── D · 动效 (38) ───────────────────────── */
p('mo.mode', 'enum', '视差', { options: ['静帧', '视差', '局部i2v', '粒子'], tier: 'L3', label: '动效模式', hint: '静帧 0 成本；视差最稳；局部 i2v 最强也最贵', i: [0.05, 0.10, 0.05] });
p('mo.parallax_layers', 'int', 3, { min: 1, max: 5, tier: 'L4', label: '视差层数', hint: '3 层（前景/主体/背景）已够 95% 场景', i: [0.02, 0.06, 0.06] });
p('mo.strength', 'float', 0.55, { min: 0, max: 1, step: 0.01, tier: 'L3', label: '运动强度', hint: '>0.6 时联动引擎会抬关键帧一致性权重', i: [0.02, 0.15, 0.04], guards: [['>0.85', '已知崩坏区：肢体与背景易撕裂（专家可试）']] });
p('mo.layer1_shift', 'int', 40, { min: 0, max: 300, unit: 'px', label: '前景层位移', i: [0, 0.01, 0.02] });
p('mo.layer2_shift', 'int', 22, { min: 0, max: 300, unit: 'px', label: '主体层位移', i: [0, 0.01, 0.02] });
p('mo.layer3_shift', 'int', 10, { min: 0, max: 300, unit: 'px', label: '背景层位移', i: [0, 0.01, 0.02] });
p('mo.layer4_shift', 'int', 6, { min: 0, max: 300, unit: 'px', label: '远景层位移', i: [0, 0.01, 0.01] });
p('mo.layer5_shift', 'int', 3, { min: 0, max: 300, unit: 'px', label: '天空层位移', i: [0, 0.01, 0.01] });
p('mo.easing', 'enum', 'easeInOut', { options: ['linear', 'easeInOut', 'bezier', 'custom'], label: '缓动曲线', i: [0, 0, 0.02] });
p('mo.camera', 'enum', '推', { ds: 'input.prompt', options: ['推', '拉', '摇', '移', '环绕', '手持', '固定'], tier: 'L3', label: '镜头运动', hint: '推/拉最稳；环绕需要 3D 感知，8G 卡慎用', i: [0, 0.03, 0.05] });
p('mo.camera_speed', 'float', 0.5, { ds: 'input.prompt', min: 0, max: 1, step: 0.01, label: '运镜速度', i: [0, 0.05, 0.03] });
p('mo.i2v_model', 'enum', 'Wan2.1-1.3B', { options: ['Wan2.1-1.3B', 'Wan2.2-5B', 'LTX-2B', 'H3(远程)'], label: 'i2v 模型', i: [0.10, 0.30, 0.10] });
p('mo.i2v_strength', 'float', 0.5, { min: 0.1, max: 0.9, step: 0.01, tier: 'L3', label: 'i2v 强度', hint: '0.4–0.6 只动局部，>0.75 会重画主体', i: [0.03, 0.20, 0.06] });
p('mo.i2v_res', 'enum', '480p', { options: ['384p', '480p', '576p', '720p'], tier: 'L3', label: 'i2v 生成分辨率', hint: '细节靠锚点传播，不靠原生像素', i: [0.20, 0.35, 0.10] });
p('mo.duration', 'float', 5, { ds: 'parameters.duration', min: 0.5, max: 15, step: 0.5, unit: 's', tier: 'L3', label: '单格时长', hint: '云端 wan2.7 支持 2–15s；wan2.2 固定 5s，超范围会夹紧并留 warning', i: [0, 0.20, 0.02] });
p('mo.mask_area', 'int', 35, { min: 0, max: 100, unit: '%', label: '局部重绘面积', hint: '面积越大越贵，>60% 不如整帧重画', i: [0.05, 0.15, 0.03] });
p('mo.breath_amp', 'int', 30, { min: 0, max: 100, label: '呼吸幅度', i: [0, 0.04, 0.04] });
p('mo.hair_sway', 'int', 40, { min: 0, max: 100, label: '发丝飘动', i: [0, 0.04, 0.04] });
p('mo.cloth_sway', 'int', 35, { min: 0, max: 100, label: '衣摆飘动', i: [0, 0.04, 0.04] });
p('mo.fx_rain', 'int', 0, { min: 0, max: 100, label: '雨效', i: [0, 0.03, 0.02] });
p('mo.fx_snow', 'int', 0, { ds: 'input.prompt', min: 0, max: 100, label: '雪效', i: [0, 0.03, 0.02] });
p('mo.fx_fog', 'int', 10, { ds: 'input.prompt', min: 0, max: 100, label: '雾效', i: [0, 0.03, 0.02] });
p('mo.fx_bloom_light', 'int', 20, { min: 0, max: 100, label: '光斑', i: [0, 0.03, 0.02] });
p('mo.fx_dust', 'int', 10, { min: 0, max: 100, label: '尘埃', i: [0, 0.03, 0.02] });
p('mo.fps', 'int', 30, { min: 24, max: 30, step: 6, tier: 'L4', label: '原生生成帧率', hint: '仅24/30fps；H3固定24fps，输出60fps由独立RIFE插帧', i: [0, 0.05, 0.02] });
p('mo.interp', 'bool', true, { tier: 'L3', label: '补帧', hint: 'RIFE 2× 让 12fps 生成变 24fps 播放', i: [0.03, 0.25, 0.06] });
p('mo.interp_factor', 'enum', '2x', { options: ['2x', '4x'], label: '补帧倍率', i: [0.03, 0.20, 0.02] });
p('mo.flow_stabilize', 'int', 50, { min: 0, max: 100, tier: 'L4', label: '光流稳定强度', hint: '0.3–0.5 是「留细节又不抖」的保险', i: [0.05, 0.30, 0.10] });
p('mo.max_frames', 'int', 121, { min: 1, max: 4097, label: '原生帧数', hint: '按模型帧数网格校验；高分辨率不自动压低帧数', i: [0, 0.25, 0.02] });
p('mo.flicker_guard', 'bool', true, { label: '闪烁闸门', hint: '帧间亮度 std >2% 判异常并回修', i: [0, 0.08, 0.10] });
p('mo.deflicker_strength', 'int', 40, { min: 0, max: 100, label: 'deflicker 强度', i: [0, 0.06, 0.08] });
p('mo.temporal_denoise', 'float', 0.4, { min: 0, max: 1, step: 0.05, label: '时序降噪权重', hint: '中间帧去噪必须 ≤0.25，否则呼吸感崩坏', i: [0.02, 0.06, 0.08] });
p('mo.particle_count', 'int', 120, { min: 0, max: 600, label: '粒子数量', i: [0.02, 0.10, 0.03] });
p('mo.particle_type', 'enum', '光点', { options: ['光点', '花瓣', '雪片', '火星', '纸屑'], label: '粒子类型', i: [0, 0.02, 0.02] });
p('mo.shake_seed', 'seed', -1, { label: '抖动种子', i: [0, 0, 0] });
p('mo.lens_distortion', 'int', 0, { min: 0, max: 100, label: '镜头畸变', i: [0, 0.02, 0.02] });
p('mo.motion_blur', 'int', 20, { min: 0, max: 100, label: '运动模糊', i: [0, 0.04, 0.04] });
p('mo.loop', 'bool', false, { label: '循环首尾', hint: '做循环 GIF/封面动效时开', i: [0, 0.02, 0.02] });

/* ───────────────────────── E · 配音口型 (30) ───────────────────────── */
p('vo.voice_id', 'enum', '茉莉', { options: ['茉莉', '冰糖', '白桦', '苏打', '旁白男', '旁白女'], tier: 'L3', label: '音色', hint: '女声茉莉/narrator 冰糖是中文短剧主力', i: [0, 0, 0.02] });
p('vo.speed', 'float', 1.0, { min: 0.7, max: 1.3, step: 0.01, tier: 'L3', label: '语速', i: [0, 0.03, 0.02] });
p('vo.pitch', 'int', 0, { min: -12, max: 12, unit: '半音', tier: 'L3', label: '音高', i: [0, 0, 0.02] });
p('vo.emotion', 'enum', '温柔', { options: ['平静', '温柔', '激动', '悲怆', '俏皮'], tier: 'L3', label: '情绪', i: [0, 0, 0.03] });
p('vo.lipsync', 'bool', true, { tier: 'L3', label: '口型驱动', hint: '仅近景有价值；联动引擎会在中景/全景自动关掉', i: [0.06, 0.35, 0.10] });
p('vo.pause_insert', 'int', 180, { min: 0, max: 1000, step: 10, unit: 'ms', label: '停顿插入', i: [0, 0.05, 0.02] });
p('vo.polyphone_table', 'text', '朝=zhāo; 还=huán; 重=chóng; 骑=jì; 教=jiào', { label: '多音字校正表', hint: 'TTS 读错的字在这里逐字钉死', i: [0, 0, 0.03] });
p('vo.dialect', 'enum', '普通话', { options: ['普通话', '东北', '粤语', '川渝'], label: '方言', i: [0, 0.02, 0.02] });
p('vo.lipsync_model', 'enum', 'LatentSync', { options: ['Wav2Lip', 'MuseTalk', 'LatentSync'], label: '口型模型', hint: 'LatentSync 质量最好，8G 需 384 输入', i: [0.10, 0.15, 0.05] });
p('vo.lipsync_strength', 'float', 0.8, { min: 0, max: 1, step: 0.05, label: '口型强度', i: [0.02, 0.05, 0.06] });
p('vo.closeup_only', 'bool', true, { label: '仅近景做口型', i: [0, 0, 0.02] });
p('vo.align_tolerance', 'int', 80, { min: 0, max: 200, step: 10, unit: 'ms', label: '对齐容差', i: [0, 0.03, 0.03] });
p('vo.sfx_tracks', 'int', 2, { min: 0, max: 3, label: '音效轨数', i: [0, 0.05, 0.02] });
p('vo.bgm_genre', 'enum', '古风', { options: ['古风', '氛围', '电子', '钢琴', '无'], label: 'BGM 曲风', i: [0, 0, 0.02] });
p('vo.bgm_strength', 'int', 35, { min: 0, max: 100, label: 'BGM 强度', i: [0, 0, 0.02] });
p('vo.ducking_db', 'int', -12, { min: -24, max: 0, unit: 'dB', label: 'ducking 阈值', hint: '人声出现时 BGM 自动压低', i: [0, 0, 0.02] });
p('vo.loudness', 'enum', '-14 LUFS', { options: ['-14 LUFS', '-23 LUFS'], label: '响度目标', hint: '短视频 -14，广电 -23', i: [0, 0, 0.02] });
p('vo.tts_engine', 'enum', 'edge-tts', { options: ['edge-tts', 'Azure', '火山TTS', 'GPT-SoVITS(本地)'], label: 'TTS 引擎', i: [0, 0.05, 0.02] });
p('vo.breath', 'int', 40, { min: 0, max: 100, label: '气口强度', hint: '气口是人味来源，纯 TTS 会像播报', i: [0, 0.02, 0.02] });
p('vo.emphasis', 'int', 50, { min: 0, max: 100, label: '重音强度', i: [0, 0, 0.02] });
p('vo.compression', 'float', 3.0, { min: 1, max: 8, step: 0.1, label: '压缩比', i: [0, 0, 0.01] });
p('vo.eq_low', 'int', 0, { min: -12, max: 12, unit: 'dB', label: '低频 EQ', i: [0, 0, 0.01] });
p('vo.eq_high', 'int', 2, { min: -12, max: 12, unit: 'dB', label: '高频 EQ', i: [0, 0, 0.01] });
p('vo.denoise', 'bool', true, { label: '人声降噪', i: [0, 0.03, 0.02] });
p('vo.clarity', 'int', 60, { min: 0, max: 100, label: '清晰度', i: [0, 0.02, 0.03] });
p('vo.rate_curve', 'text', '', { label: '语速曲线（逐句）', hint: '如 1:1.0,2:0.9，逐句覆盖全局语速', i: [0, 0, 0.02] });
p('vo.subtitle_sync', 'bool', true, { label: '字幕强制同步', i: [0, 0.01, 0.02] });
p('vo.voice_clone', 'bool', false, { label: '音色克隆', hint: '需参考音频；克隆质量决定观众信任度', i: [0, 0.10, 0.05] });
p('vo.ref_audio', 'bool', false, { label: '提供参考音频', i: [0, 0.05, 0.04] });
p('vo.max_chars_per_line', 'int', 14, { min: 8, max: 24, label: '每行字数', i: [0, 0, 0] });

/* ───────────────────────── F · 质感后期 (32) ───────────────────────── */
p('lk.lut', 'enum', '东方暖调', { options: ['东方暖调', '青橙', '胶片', '黑白', '赛博', '无'], tier: 'L3', label: 'LUT', hint: '全片统一色感的第一杠杆', i: [0, 0.02, 0.08] });
p('lk.lut_strength', 'int', 70, { min: 0, max: 100, tier: 'L3', label: 'LUT 强度', i: [0, 0.02, 0.06] });
p('lk.grain', 'int', 12, { min: 0, max: 100, tier: 'L3', label: '胶片颗粒', hint: '3–6% 去塑料感，>15 变噪点', i: [0, 0.02, 0.05] });
p('lk.vignette', 'int', 25, { min: 0, max: 100, tier: 'L3', label: '暗角', i: [0, 0.02, 0.04] });
p('lk.chroma', 'int', 8, { min: 0, max: 100, label: '色散', i: [0, 0.02, 0.03] });
p('lk.bloom', 'int', 20, { min: 0, max: 100, tier: 'L3', label: 'bloom', i: [0, 0.02, 0.04] });
p('lk.screen_tone', 'int', 15, { min: 0, max: 100, label: '网点', i: [0, 0.02, 0.03] });
p('lk.outline', 'int', 20, { min: 0, max: 100, label: '描边', i: [0, 0.02, 0.03] });
p('lk.cel_levels', 'int', 3, { min: 2, max: 8, label: '赛璐璐阶数', i: [0, 0.02, 0.04] });
p('lk.sharpen', 'int', 30, { tier: 'L3', min: 0, max: 100, label: '锐化', i: [0, 0.02, 0.06] });
p('lk.denoise', 'int', 15, { min: 0, max: 100, label: '降噪', hint: '降噪过猛会吃掉颗粒与纹理', i: [0, 0.02, 0.02] });
p('lk.deflicker', 'int', 40, { min: 0, max: 100, label: 'deflicker', i: [0, 0.05, 0.08] });
p('lk.subtitle_style', 'enum', '黑体描边', { options: ['无', '黑体描边', '圆体阴影', '书法'], label: '字幕样式', i: [0, 0.02, 0.02] });
p('lk.subtitle_font', 'enum', '思源黑体', { options: ['思源黑体', '思源宋体', '站酷高端黑', '毛笔楷'], label: '字幕字体', i: [0, 0, 0.01] });
p('lk.subtitle_size', 'int', 44, { min: 24, max: 96, unit: 'px', label: '字幕字号', i: [0, 0, 0.01] });
p('lk.subtitle_pos', 'enum', '底部', { options: ['底部', '中部', '顶部'], label: '字幕位置', i: [0, 0, 0] });
p('lk.subtitle_anim', 'enum', '淡入', { options: ['淡入', '逐字', '打字机', '弹入'], label: '字幕动效', i: [0, 0.02, 0.01] });
p('lk.contrast', 'int', 105, { min: 0, max: 200, label: '对比度', i: [0, 0, 0.03] });
p('lk.saturation', 'int', 105, { min: 0, max: 200, label: '饱和度', i: [0, 0, 0.03] });
p('lk.temperature', 'int', 5, { min: -100, max: 100, label: '色温微调', i: [0, 0, 0.03] });
p('lk.tint', 'int', 0, { min: -100, max: 100, label: '色调微调', i: [0, 0, 0.02] });
p('lk.highlight_rolloff', 'int', 20, { min: 0, max: 100, label: '高光滚降', i: [0, 0, 0.03] });
p('lk.shadow_lift', 'int', 10, { min: 0, max: 100, label: '暗部提亮', i: [0, 0, 0.03] });
p('lk.lens_flare', 'int', 5, { min: 0, max: 100, label: '镜头光晕', i: [0, 0.02, 0.02] });
p('lk.paper_texture', 'int', 0, { min: 0, max: 100, label: '纸纹', i: [0, 0.02, 0.02] });
p('lk.watercolor_edge', 'int', 0, { min: 0, max: 100, label: '水彩边', i: [0, 0.02, 0.02] });
p('lk.ink_bleed', 'int', 0, { min: 0, max: 100, label: '墨韵扩散', i: [0, 0.02, 0.02] });
p('lk.frame_border', 'bool', false, { label: '画框', i: [0, 0, 0.01] });
p('lk.film_halation', 'int', 10, { min: 0, max: 100, label: '胶片光晕', i: [0, 0.02, 0.02] });
p('lk.vignette_softness', 'int', 50, { min: 0, max: 100, label: '暗角柔度', i: [0, 0, 0.01] });
p('lk.color_grade_model', 'enum', 'LUT', { options: ['无', 'IC-Light', '参考图匹配', 'LUT'], label: '调色方式', i: [0.03, 0.05, 0.04] });
p('lk.reference_image', 'bool', false, { label: '参考图调色', i: [0.02, 0.05, 0.04] });

/* ───────────────────────── G · 输出 (26) ───────────────────────── */
p('ex.resolution', 'enum', '1080p', { ds: 'parameters.resolution', options: ['720p', '1080p', '1440p', '4K'], tier: 'L3', label: '成片分辨率', i: [0, 0.10, 0.06] });
p('ex.bitrate', 'int', 12, { min: 2, max: 40, unit: 'Mbps', tier: 'L3', label: '码率', hint: '1080p24 建议 10–16 Mbps', i: [0, 0.05, 0.03] });
p('ex.codec', 'enum', 'H.264', { options: ['H.264', 'H.265', 'AV1'], tier: 'L3', label: '编码', hint: 'H.265 同码率更清晰，但部分平台转码更慢', i: [0, 0.08, 0.02] });
p('ex.fps', 'enum', '24', { options: ['24', '25', '30', '60'], tier: 'L3', label: '成片帧率', i: [0, 0.08, 0.02] });
p('ex.color_space', 'enum', 'Rec.709', { options: ['Rec.709', 'Rec.2020', 'sRGB'], label: '色彩空间', i: [0, 0.02, 0.01] });
p('ex.episode_duration', 'int', 36, { min: 5, max: 300, unit: 's', tier: 'L3', label: '单集成片时长', i: [0, 0.02, 0.01] });
p('ex.transition', 'enum', '叠化', { tier: 'L3', options: ['无', '淡入淡出', '叠化', '划像', '闪白'], label: '转场类型', i: [0, 0.02, 0.02] });
p('ex.transition_duration', 'float', 0.3, { min: 0.1, max: 1.5, step: 0.1, unit: 's', label: '转场时长', i: [0, 0.01, 0.01] });
p('ex.intro', 'bool', true, { label: '片头', i: [0, 0.02, 0] });
p('ex.outro', 'bool', true, { label: '片尾', i: [0, 0.02, 0] });
p('ex.watermark_pos', 'enum', '右下', { options: ['右下', '左下', '居中', '无'], label: '水印位置', i: [0, 0, 0] });
p('ex.watermark_opacity', 'int', 40, { min: 0, max: 100, label: '水印透明度', i: [0, 0, 0] });
p('ex.ai_label', 'bool', true, { ds: 'parameters.watermark', label: 'AI 生成标识（不可关）', hint: '合规红线：国内平台要求显著标识', i: [0, 0, 0], guards: [] });
p('ex.metadata', 'bool', true, { label: '写入元数据', i: [0, 0, 0] });
p('ex.platform_douyin', 'bool', true, { label: '派生抖音版', hint: '9:16 + 安全边距', i: [0, 0.03, 0] });
p('ex.platform_bilibili', 'bool', true, { label: '派生 B 站版', i: [0, 0.03, 0] });
p('ex.platform_xhs', 'bool', true, { label: '派生小红书版', i: [0, 0.03, 0] });
p('ex.platform_shipinhao', 'bool', true, { label: '派生视频号版', i: [0, 0.03, 0] });
p('ex.pack_master', 'bool', true, { label: '打包母版', i: [0, 0.02, 0] });
p('ex.pack_srt', 'bool', true, { label: '打包 SRT', i: [0, 0.01, 0] });
p('ex.pack_cover', 'bool', true, { label: '打包封面', i: [0, 0.02, 0] });
p('ex.pack_manifest', 'bool', true, { label: '打包 manifest', i: [0, 0, 0] });
p('ex.audio_bitrate', 'int', 192, { min: 96, max: 320, step: 16, unit: 'kbps', label: '音频码率', i: [0, 0.01, 0.01] });
p('ex.loudness_norm', 'bool', true, { label: '响度归一', i: [0, 0.01, 0] });
p('ex.faststart', 'bool', true, { label: 'faststart', hint: '网页秒开必需', i: [0, 0, 0] });
p('ex.naming_rule', 'text', '{episode}_{shot}_{seed}', { label: '文件命名规则', i: [0, 0, 0] });

/* ───────────────────────── 校验 + 产出 ───────────────────────── */
const byStage = {};
for (const s of STAGES) byStage[s.id] = [];
for (const e of params) byStage[e.stage].push(e);

let bad = 0;
for (const s of STAGES) {
  const got = byStage[s.id].length;
  const l3 = byStage[s.id].filter((e) => e.tier === 'L3').length;
  const mark = got === s.total && l3 === s.l3 ? 'OK ' : '!! ';
  if (mark === '!! ') bad++;
  console.log(`${mark}${s.code} ${s.name}: total ${got}/${s.total}, L3 ${l3}/${s.l3}`);
}
// 主键唯一性
const keys = params.map((e) => e.key);
const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
if (dup.length) { console.log('!! 重复 key:', dup); bad++; }

const out = {
  schema: 'ai-video-platform/params.registry',
  version: VERSION,
  updated: UPDATED,
  generated_by: 'tools/gen_registry.mjs',
  note: '唯一真相源。UI 控件、预设导出、workflow 编译全部从这里生成，不要手改界面代码。impact=[vram,time,quality] 见 tools/gen_registry.mjs 头部口径。',
  tiers: {
    L0: '系统硬约束：显存方程与模型能力上限，用户不可见',
    L1: '机型预设：探测+标定自动生成，可覆盖但提示风险',
    L2: '模板默认：作者打包时设定，改动后卡片标记已自定义',
    L3: '用户常用：每板块 5–8 个核心参数，界面直接露出',
    L4: '高级裸参：折叠区/专家模式/导入导出，覆盖后强制重算',
  },
  stages: STAGES.map((s) => ({ ...s, count: byStage[s.id].length, l3_count: byStage[s.id].filter((e) => e.tier === 'L3').length })),
  counts: { total: params.length, l3: params.filter((e) => e.tier === 'L3').length, l4: params.filter((e) => e.tier === 'L4').length },
  params,
};

const target = path.join(process.cwd(), 'spec', 'params.registry.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`\n写入 ${target}`);
console.log(`合计 ${out.counts.total} 参数（L3 ${out.counts.l3} / L4 ${out.counts.l4}）${bad ? ' 有 ' + bad + ' 项不符' : ' 全部符合设计文档口径'}`);