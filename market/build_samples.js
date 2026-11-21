/**
 * market/build_samples.js —— 5 个示例模板的"配方 + 生成器"
 *
 * 为什么用脚本生成而不是手写 JSON：手写 258 参数里的一小撮差异，极易写出与默认值相同的键
 * （exportPreset 会把它们剔掉），也会手抄错 checksum。这里只写"差异"，checksum 与估算全部由
 * pack.js 现算，改配方重跑一次即可，产出的 .avptpl 是真实可用的包而不是演示占位。
 *
 * 运行：node market/build_samples.js [--no-install]
 * 产出：market/samples/*.avptpl（5 个）+ 打印真实估算（显存比 / 单格秒 / 质量分 / 定价）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AVP = require('../core/engine.js');
const pack = require('./pack.js');
const sign = require('./sign.js');

const ROOT = path.join(__dirname, '..');
const SAMPLES_DIR = path.join(__dirname, 'samples');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/params.registry.json'), 'utf8'));

// 演示用密钥：真实市场里密钥由平台签发、不进仓库。写死是为了让样例可重复签名/验签。
const DEMO_SECRET = 'avp-demo-signing-key-2026-11';

/**
 * 配方表。每条只写与"默认值不同"的参数——这既是导出语义，也是"卖点"的物理位置。
 * device 选档原则：模板要在该档上 state=ok（或 warn 但有余量），否则卖出去就是退货。
 */
const RECIPES = [
  {
    meta: {
      id: 'oriental-ink-portrait',
      name: '东方古风人物特写',
      version: '1.2.0',
      author: '云盘工坊',
      license: 'paid',
      tags: ['古风', '人物', '特写', '工笔', '国风'],
      stage_focus: ['character', 'keyframe', 'look'],
      cover_params: ['ch.style', 'kf.composition', 'kf.dof', 'lk.paper_texture'],
      device: 'T0',
      created: '2026-11-16T09:00:00.000Z',
      origin: 'manual',
      derived_from: [],
    },
    values: {
      'ch.subject': '一位28岁古典女子，鹅蛋脸细眉凤目，发髻斜插一支白玉簪，月白立领对襟长衫，站于回廊窗下',
      'ch.age': 28,
      'ch.face_shape': '瓜子',
      'ch.hair_style': '古风发髻',
      'ch.outfit_1': '月白立领对襟长衫，暗纹云锦，宽袖',
      'ch.outfit_2': '藕荷色马面裙',
      'ch.style': '工笔',
      'ch.line_weight': 22,
      'ch.screen_tone': 8,
      'ch.expression_count': 6,
      'ch.pose_count': 2,
      'ch.consistency': 0.95,
      'ch.ref_images': 4,
      'ch.lora_style_1': 0.82,
      'ch.hair_detail': 78,
      'ch.eye_highlight': 68,
      'ch.fabric_texture': 74,
      'ch.prompt_prefix': 'masterpiece, best quality, consistent character, fine brushwork, ',
      'sb.shot_scale': '特写',
      'sb.rhythm': '慢',
      'sb.duration': 30,
      'sb.grid_count': 18,
      'sb.closeup_ratio': 72,
      'sb.medium_ratio': 21,
      'sb.wide_ratio': 7,
      'sb.emotion_curve': 58,
      'sb.narration_ratio': 18,
      'kf.steps': 28,
      'kf.cfg': 5.2,
      'kf.refine_scale': 1.6,
      'kf.refine_denoise': 0.42,
      'kf.refine_steps': 14,
      'kf.composition': '大留白',
      'kf.negative_space': 34,
      'kf.color_temp': 4600,
      'kf.light_ratio': 3.4,
      'kf.dof': 58,
      'kf.ipadapter_weight': 0.88,
      'kf.cn_type': 'lineart',
      'kf.cn_weight': 0.62,
      'kf.usm_amount': 0.3,
      'mo.mode': '局部i2v',
      'mo.i2v_res': '480p',
      'mo.i2v_strength': 0.42,
      'mo.mask_area': 22,
      'mo.hair_sway': 66,
      'mo.cloth_sway': 52,
      'mo.breath_amp': 34,
      'mo.fx_bloom_light': 36,
      'mo.fx_fog': 26,
      'mo.fx_dust': 18,
      'mo.flow_stabilize': 62,
      'vo.voice_id': '白桦',
      'vo.emotion': '平静',
      'vo.speed': 0.92,
      'vo.pause_insert': 240,
      'vo.bgm_genre': '古风',
      'vo.bgm_strength': 30,
      'lk.grain': 18,
      'lk.paper_texture': 14,
      'lk.ink_bleed': 6,
      'lk.vignette': 32,
      'lk.lut_strength': 62,
      'lk.saturation': 96,
      'lk.contrast': 108,
      'lk.film_halation': 14,
      'lk.subtitle_style': '书法',
      'lk.subtitle_font': '毛笔楷',
      'ex.resolution': '1440p',
      'ex.bitrate': 18,
      'ex.codec': 'H.265',
      'ex.transition': '淡入淡出',
    },
  },
  {
    meta: {
      id: 'product-turntable-pro',
      name: '商业产品转台',
      version: '1.0.3',
      author: '云盘工坊',
      license: 'paid',
      tags: ['电商', '产品', '转台', '4K', '广告'],
      stage_focus: ['keyframe', 'motion', 'export'],
      cover_params: ['kf.dof', 'mo.camera', 'lk.lut', 'ex.resolution'],
      device: 'T1',
      created: '2026-11-16T09:10:00.000Z',
      origin: 'manual',
      derived_from: [],
    },
    values: {
      'ch.subject': '哑光黑陶瓷保温杯，磨砂喷塑表面，金属环扣，置于浅灰无缝背景中央',
      'ch.skin': '哑光',
      'ch.palette': '莫兰迪',
      'sb.genre': '都市',
      'sb.shot_scale': '中景',
      'sb.rhythm': '快',
      'sb.duration': 15,
      'sb.grid_count': 12,
      'sb.beat_per_grid': 1,
      'sb.closeup_ratio': 24,
      'sb.medium_ratio': 56,
      'sb.wide_ratio': 20,
      'sb.narration_ratio': 0,
      'sb.emotion_curve': 40,
      'sb.conflict_intensity': 30,
      'sb.hook_seconds': false,
      'kf.ratio': '1:1',
      'kf.steps': 22,
      'kf.cfg': 3.8,
      'kf.refine_scale': 1.6,
      'kf.composition': '居中',
      'kf.negative_space': 12,
      'kf.dof': 76,
      'kf.light_ratio': 3.2,
      'kf.key_light_dir': '侧光',
      'kf.color_temp': 5400,
      'kf.ipadapter_weight': 0.95,
      'kf.ipadapter_mode': '风格',
      'kf.cn_type': 'canny',
      'kf.cn_weight': 0.55,
      'kf.usm_amount': 0.55,
      'mo.mode': '视差',
      'mo.parallax_layers': 4,
      'mo.strength': 0.3,
      'mo.camera': '环绕',
      'mo.camera_speed': 0.35,
      'mo.easing': 'bezier',
      'mo.layer1_shift': 120,
      'mo.layer2_shift': 70,
      'mo.motion_blur': 14,
      'mo.fx_dust': 8,
      'mo.flow_stabilize': 70,
      'vo.lipsync': false,
      'vo.bgm_genre': '氛围',
      'vo.bgm_strength': 24,
      'vo.sfx_tracks': 3,
      'vo.emphasis': 40,
      'lk.lut': '青橙',
      'lk.lut_strength': 55,
      'lk.bloom': 10,
      'lk.sharpen': 44,
      'lk.contrast': 112,
      'lk.saturation': 94,
      'lk.temperature': -3,
      'lk.highlight_rolloff': 34,
      'lk.grain': 6,
      'lk.denoise': 8,
      'lk.subtitle_style': '圆体阴影',
      'ex.resolution': '4K',
      'ex.bitrate': 26,
      'ex.codec': 'H.265',
      'ex.color_space': 'Rec.2020',
      'ex.transition': '无',
      'ex.intro': false,
      'ex.outro': false,
    },
  },
  {
    meta: {
      id: 'manju-3panel-strip',
      name: '漫剧 3 格分镜',
      version: '1.1.0',
      author: '云盘工坊',
      license: 'revenue_share',
      tags: ['漫剧', '分镜', '韩漫', '校园', '格子'],
      stage_focus: ['storyboard', 'keyframe', 'look'],
      cover_params: ['ch.style', 'kf.cn_weight', 'lk.cel_levels', 'sb.conflict_intensity'],
      device: 'T0',
      created: '2026-11-16T09:20:00.000Z',
      origin: 'manual',
      derived_from: [],
    },
    values: {
      'ch.subject': '三名高中生在天台对峙：短发女生、戴眼镜男生、扎马尾的转学生，校服外套被风吹起',
      'ch.style': '韩漫',
      'ch.palette': '高饱和',
      'ch.line_weight': 52,
      'ch.screen_tone': 42,
      'ch.expression_count': 8,
      'ch.pose_count': 5,
      'ch.consistency': 0.9,
      'ch.ref_images': 3,
      'ch.lora_style_1': 0.9,
      'sb.genre': '校园',
      'sb.scene_count': 3,
      'sb.grid_count': 12,
      'sb.beat_per_grid': 1,
      'sb.rhythm': '变速',
      'sb.camera_language': '今敏式',
      'sb.emotion_curve': 82,
      'sb.conflict_intensity': 78,
      'sb.transition_count': 4,
      'sb.character_count': 3,
      'sb.closeup_ratio': 45,
      'sb.medium_ratio': 40,
      'sb.wide_ratio': 15,
      'sb.duration': 15,
      'sb.line_density': 5.6,
      'sb.narration_ratio': 22,
      'sb.retry': 2,
      'kf.composition': '九宫格',
      'kf.steps': 26,
      'kf.cfg': 5.5,
      'kf.refine_scale': 1.4,
      'kf.negative_space': 14,
      'kf.color_temp': 5800,
      'kf.cn_type': 'lineart',
      'kf.cn_weight': 0.95,
      'kf.cn_end': 0.62,
      'kf.cn2_type': 'pose',
      'kf.cn2_weight': 0.35,
      'mo.mode': '粒子',
      'mo.particle_type': '纸屑',
      'mo.particle_count': 90,
      'mo.camera': '推',
      'mo.camera_speed': 0.55,
      'mo.strength': 0.35,
      'mo.fx_dust': 22,
      'mo.fx_bloom_light': 14,
      'vo.voice_id': '冰糖',
      'vo.emotion': '俏皮',
      'vo.speed': 1.08,
      'vo.bgm_genre': '电子',
      'vo.bgm_strength': 38,
      'vo.sfx_tracks': 3,
      'lk.lut': '胶片',
      'lk.cel_levels': 4,
      'lk.outline': 38,
      'lk.saturation': 118,
      'lk.contrast': 116,
      'lk.grain': 8,
      'lk.chroma': 12,
      'lk.screen_tone': 30,
      'ex.transition': '划像',
      'ex.transition_duration': 0.2,
      'ex.bitrate': 14,
      'ex.codec': 'H.265',
      'ex.episode_duration': 15,
    },
  },
  {
    meta: {
      id: 'doc-interview-real',
      name: '写实纪录访谈',
      version: '2.0.0',
      author: '云盘工坊',
      license: 'paid',
      tags: ['纪录片', '访谈', '写实', '口型', '中景'],
      stage_focus: ['voice', 'motion', 'look'],
      cover_params: ['vo.closeup_only', 'mo.mask_area', 'lk.grain', 'kf.key_light_dir'],
      device: 'T2',
      created: '2026-11-16T09:30:00.000Z',
      origin: 'manual',
      derived_from: [],
    },
    values: {
      'ch.subject': '45岁男性老木匠，短发夹白，深蓝工装外套，手上有锯末，坐在工作台前',
      'ch.age': 45,
      'ch.face_shape': '方',
      'ch.palette': '莫兰迪',
      'sb.genre': '都市',
      'sb.shot_scale': '中景',
      'sb.rhythm': '慢',
      'sb.emotion_curve': 55,
      'sb.narration_ratio': 58,
      'sb.duration': 90,
      'sb.grid_count': 30,
      'sb.character_count': 2,
      'sb.closeup_ratio': 30,
      'sb.medium_ratio': 50,
      'sb.wide_ratio': 20,
      'sb.conflict_intensity': 35,
      'sb.line_density': 5.4,
      'sb.subtitle_lines': 3,
      'sb.llm_temperature': 0.5,
      'kf.key_light_dir': '侧光',
      'kf.light_ratio': 2.2,
      'kf.color_temp': 5600,
      'kf.dof': 48,
      'kf.steps': 26,
      'kf.cfg': 4.2,
      'kf.composition': '黄金分割',
      'kf.grain': 8,
      'kf.usm_amount': 0.28,
      'kf.tonemap': 'reinhard',
      'mo.mode': '局部i2v',
      'mo.i2v_strength': 0.32,
      'mo.i2v_res': '576p',
      'mo.mask_area': 18,
      'mo.breath_amp': 26,
      'mo.hair_sway': 18,
      'mo.cloth_sway': 14,
      'mo.flow_stabilize': 68,
      'vo.voice_id': '旁白男',
      'vo.emotion': '平静',
      'vo.speed': 0.95,
      'vo.closeup_only': false, // 中景也要口型：关掉"仅近景"这条联动才不会被自动掐掉
      'vo.loudness': '-23 LUFS',
      'vo.bgm_genre': '钢琴',
      'vo.bgm_strength': 18,
      'vo.ducking_db': -18,
      'vo.pause_insert': 260,
      'vo.compression': 4,
      'lk.lut': '胶片',
      'lk.lut_strength': 48,
      'lk.grain': 24,
      'lk.highlight_rolloff': 30,
      'lk.vignette': 18,
      'lk.saturation': 96,
      'lk.contrast': 104,
      'lk.temperature': 4,
      'ex.codec': 'H.265',
      'ex.bitrate': 10,
      'ex.intro': false,
      'ex.outro': false,
      'ex.episode_duration': 90,
    },
  },
  {
    meta: {
      id: 'cyber-night-dolly',
      name: '赛博夜景运镜',
      version: '1.3.1',
      author: '云盘工坊',
      license: 'revenue_share',
      tags: ['赛博', '夜景', '运镜', '霓虹', '视差'],
      stage_focus: ['motion', 'look', 'keyframe'],
      cover_params: ['mo.parallax_layers', 'mo.lens_distortion', 'lk.bloom', 'kf.ratio'],
      device: 'T3',
      created: '2026-11-16T09:40:00.000Z',
      origin: 'manual',
      derived_from: ['oriental-ink-portrait'], // 演示血缘：构图语言继承自古风特写
    },
    values: {
      'ch.subject': '赛博夜雨中的霓虹街区：湿滑柏油路、全息招牌、飞驰的悬浮车',
      'ch.style': '国潮',
      'ch.palette': '冷青电影',
      'ch.line_weight': 30,
      'sb.genre': '科幻',
      'sb.rhythm': '快',
      'sb.shot_scale': '全景',
      'sb.duration': 20,
      'sb.grid_count': 14,
      'sb.closeup_ratio': 15,
      'sb.medium_ratio': 35,
      'sb.wide_ratio': 50,
      'sb.camera_language': '快剪',
      'sb.emotion_curve': 74,
      'sb.conflict_intensity': 66,
      'kf.ratio': '2.35:1',
      'kf.resolution': 2048, // 宽银幕吃像素，联动会同步压低 mo.max_frames，这是设计好的取舍
      'kf.steps': 30,
      'kf.cfg': 4.8,
      'kf.refine_scale': 1.4,
      'kf.refine_denoise': 0.4,
      'kf.composition': '黄金分割',
      'kf.color_temp': 6800,
      'kf.light_ratio': 4.2,
      'kf.key_light_dir': '底光',
      'kf.dof': 62,
      'kf.usm_amount': 0.42,
      'kf.grain': 5,
      'kf.tonemap': 'aces',
      'mo.mode': '视差',
      'mo.parallax_layers': 5,
      'mo.strength': 0.72, // 强运动 → 联动把 kf.identity_weight 抬到 1.03+"，主体不漂
      'mo.camera': '移',
      'mo.camera_speed': 0.42,
      'mo.layer1_shift': 90,
      'mo.layer2_shift': 52,
      'mo.layer3_shift': 26,
      'mo.fx_rain': 62,
      'mo.fx_fog': 38,
      'mo.fx_bloom_light': 55,
      'mo.lens_distortion': 14,
      'mo.motion_blur': 34,
      'mo.interp_factor': '4x',
      'mo.fps': 30,
      'mo.flow_stabilize': 44,
      'vo.voice_id': '苏打',
      'vo.emotion': '激动',
      'vo.lipsync': false,
      'vo.bgm_genre': '电子',
      'vo.bgm_strength': 46,
      'vo.sfx_tracks': 3,
      'lk.lut': '赛博',
      'lk.lut_strength': 82,
      'lk.chroma': 24,
      'lk.bloom': 48,
      'lk.lens_flare': 22,
      'lk.film_halation': 26,
      'lk.contrast': 118,
      'lk.saturation': 112,
      'lk.vignette': 36,
      'lk.sharpen': 36,
      'ex.resolution': '1440p',
      'ex.bitrate': 26,
      'ex.codec': 'H.265',
      'ex.color_space': 'Rec.2020',
      'ex.transition': '闪白',
      'ex.transition_duration': 0.12,
      'ex.fps': '30',
    },
  },
];

/** 生成 5 个 .avptpl（签名 + 落盘），返回 [{tpl, file, estimate}] */
function build(opts) {
  const o = opts || {};
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const out = [];
  for (const r of RECIPES) {
    const tpl = pack.pack(reg, r.values, r.meta);
    // 签名摘要固定时间戳，保证重跑生成的字节完全一致（便于 diff 与 selftest 断言）
    const signed = sign.sign(tpl, o.secret || DEMO_SECRET, { signed_at: r.meta.created, issuer: 'market/build_samples.js' });
    const v = pack.verify(signed, reg);
    if (!v.ok) {
      throw new Error('样例 ' + tpl.id + ' 校验失败：' + v.errors.map((e) => e.code + '@' + e.path).join(','));
    }
    const file = path.join(SAMPLES_DIR, tpl.id + '.avptpl');
    fs.writeFileSync(file, JSON.stringify(signed, null, 2) + '\n', 'utf8');
    out.push({ tpl: signed, file, verify: v });
  }
  return out;
}

/**
 * 历史版本配方（卡⑦ 版本目录要有多版本可回滚的真实数据）
 *
 * 为什么单独一组而不是塞进 RECIPES：`market/samples/` 的语义是"当前 5 个可上架模板"，
 * selftest 与 snapshot 都按这个口径数文件（5 个）。历史版本落到 `market/samples/prev/`，
 * 仓库里两个版本的正文并存：`store/tpl/<id>/<version>.avptpl`。
 */
const PREV_RECIPES = [
  {
    baseId: 'oriental-ink-portrait',       // 以当前版为底，只改几个参数 → 得到上一个版本的真实差异
    meta: { version: '1.1.0', created: '2026-11-15T09:00:00.000Z', origin: 'market/build_samples.js#prev' },
    patch: { 'kf.steps': 24, 'kf.dof': 52, 'lk.grain': 22, 'sb.closeup_ratio': 70 },
  },
];

/** 生成历史版本 .avptpl（签名 + 落盘到 samples/prev/），返回 [{tpl, file, estimate}] */
function buildPrev(opts) {
  const o = opts || {};
  const dir = path.join(SAMPLES_DIR, 'prev');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const p of PREV_RECIPES) {
    const base = RECIPES.find((r) => r.meta.id === p.baseId);
    if (!base) throw new Error('PREV_RECIPES 引用了不存在的模板：' + p.baseId);
    const meta = { ...base.meta, ...p.meta };
    const values = { ...base.values, ...p.patch };
    const tpl = pack.pack(reg, values, meta);
    const signed = sign.sign(tpl, o.secret || DEMO_SECRET, { signed_at: meta.created, issuer: 'market/build_samples.js#prev' });
    const v = pack.verify(signed, reg);
    if (!v.ok) {
      throw new Error('历史版本 ' + tpl.id + '@' + tpl.version + ' 校验失败：' + v.errors.map((e) => e.code + '@' + e.path).join(','));
    }
    const file = path.join(dir, tpl.id + '-' + tpl.version + '.avptpl');
    fs.writeFileSync(file, JSON.stringify(signed, null, 2) + '\n', 'utf8');
    out.push({ tpl: signed, file, verify: v });
  }
  return out;
}

/** 打印真实估算行（这是需求 7 要求贴出来的数字） */
function report(built) {
  console.log('\n=== 示例模板真实估算（engine.estimate，未做任何美化） ===');
  for (const b of built) {
    const e = b.tpl.estimate_meta;
    const p = b.tpl.pricing;
    console.log(
      `${b.tpl.name.padEnd(10, '　')} | ${b.tpl.version} | ${e.device.padEnd(4)} | 显存 ${String(e.peak_mib).padStart(5)}/${e.usable_mib} MiB = ${(e.ratio * 100).toFixed(1)}% [${e.state}]`
      + ` | 单格 ${String(e.shot_sec).padStart(3)}s | 单集 ${(e.episode_sec / 60).toFixed(1)}min | 质量 ${e.quality}`
      + ` | ${p.mode} ¥${p.price_cny}`,
    );
  }
  console.log('');
}

function main() {
  const built = build();
  const prev = buildPrev();
  report(built.concat(prev));

  if (process.argv.includes('--no-install')) return;
  const store = require('./store.js').openStore({ dir: path.join(__dirname, 'store'), registry: reg });
  // 演示评分：让市场列表的"安装量+评分"排序有真实差异，而不是全 0
  const RATINGS = { 'oriental-ink-portrait': 5, 'cyber-night-dolly': 4, 'doc-interview-real': 5, 'manju-3panel-strip': 4, 'product-turntable-pro': 3 };
  // 先装历史版本（临时占据激活位），再装当前版本把激活指针推回最新——两个版本的正文都留在版本目录里。
  for (const b of prev) store.install(b.file, { upgrade: true });
  for (const b of built) {
    store.install(b.file, { upgrade: true }); // 重跑覆盖：内容变了就是升级，安装量继续累加
    const s = RATINGS[b.tpl.id];
    if (s) store.rate(b.tpl.id, s, { rater: 'seed-' + b.tpl.id });
  }
  const st = store.stats();
  console.log(`已写入 store：${st.count} 条（付费 ${st.paid} / 免费 ${st.free}），${st.versions} 个版本，累计安装 ${st.installs}，评分 ${st.ratings} 次`);
}

if (require.main === module) main();

module.exports = { RECIPES, PREV_RECIPES, build, buildPrev, report, DEMO_SECRET, SAMPLES_DIR };