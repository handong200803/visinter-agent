'use strict';
/**
 * prompt/safety.js —— AI 生成内容的"标识与留痕"层
 *
 * 边界声明（设计决策，不是免责声明）：
 *   本模块不做内容审查、不打分、不拦截。它只做两件事：
 *     1) 显式标识：观众能看见的那句话（角标/片尾/简介），必须可配置、可校验、不可被静默关掉；
 *     2) 隐式标识：写进文件元数据的字段（生成方/生成号/传播方/传播号/预留码 + 时间 + 工具指纹），
 *        用于事后追溯"这条片子是哪个模型、哪次编译、哪份提示词生成的"。
 *   为什么把审查排除在外：审查会随时间与平台变化，写死在编译层会让整条流水线跟着腐烂；
 *   而标识是结构性的、可被机器校验的，属于工程该负责的部分。
 *
 * 法规依据：中国境内《人工智能生成合成内容标识办法》要求"显式标识 + 隐式标识"双轨；
 * 具体字段名各平台（抖音/快手/B站/视频号）在落地时略有差异，所以 metadataStub() 里
 * 把字段分成"通用六字段"与"平台扩展"两块，前者稳定、后者由 platform 参数决定。
 * 所有数值型建议（字号比例、显示时长）均为工程估计，标 provenance: estimate，不做实测宣称。
 */

/* ───────────── 显式标识 ───────────── */

// 角标文案。为什么给多个候选而不是一句写死：不同平台的审核口径与观众耐受度不同，
// 短视频平台用最短的（"AI 生成"），长视频/纪录片用完整句（"本片画面由人工智能生成合成"）。
const LABEL_TEXTS = {
  short: 'AI 生成',
  standard: '本内容由 AI 生成',
  full: '本片画面与配音由人工智能生成合成，仅用于创作演示',
  endcard: '本片由 AI 生成合成，人物与场景均为虚构',
};

/**
 * 显式标识文本 + 落位建议。
 * @param {object} o {style:'short'|'standard'|'full'|'endcard', platform, duration_s, title, producer, year}
 * @returns {{text, placement, style, rules[], provenance}}
 */
function labelText(o) {
  o = o || {};
  const style = LABEL_TEXTS[o.style] ? o.style : 'standard';
  let text = LABEL_TEXTS[style];

  // 允许追加主体信息（"XX 出品"），但绝不把标识本身变成可选项
  if (o.producer && style !== 'short') text += '｜' + o.producer;
  if (o.year && style === 'endcard') text += '｜' + o.year;

  const platform = o.platform || 'generic';
  const placementMap = {
    douyin: { placement: '画面左下角常驻角标 + 简介首行', note: '信息流里角标要避开右侧交互按钮区' },
    bilibili: { placement: '片头 2 秒角标 + 简介首段', note: 'B 站的观众会点开简介，完整句放简介成本最低' },
    xhs: { placement: '封面角标 + 正文首行', note: '封面角标必须与标题错开，避免压字' },
    shipinhao: { placement: '画面右下角常驻 + 描述首行', note: '视频号转发到聊天窗时只显示描述，标识必须进描述' },
    generic: { placement: '画面角标 + 结尾 2 秒', note: '没有平台信息时按最保守的双落位' },
  };
  const pl = placementMap[platform] || placementMap.generic;

  const rules = [
    { id: 'visible', level: 'must', text: '标识必须在成片里可见，不依赖简介/描述等"画面外"位置单独承担' },
    { id: 'start', level: 'must', text: '起始画面与结尾都要有可辨识的标识位，避免掐头去尾后无法识别' },
    { id: 'size', level: 'estimate', text: '角标字高建议不低于画面短边的 4%（1080×1920 竖屏约 43px）；这是可读性下限的经验值，不是实测阈值' },
    { id: 'duration', level: 'estimate', text: '角标常驻 ≥3 秒；片尾标识停留 ≥2 秒' },
    { id: 'contrast', level: 'estimate', text: '标识与背景的亮度差建议 ≥40%，或加半透明描边/底板，避免糊在浅色背景里' },
  ];

  return {
    text, style, platform,
    placement: pl.placement, placement_note: pl.note,
    rules,
    provenance: 'text: project-defined; rules: estimate',
    // 交付时的机器可校验项：成片流水线应当断言这三项存在
    assert: ['label_text_present', 'label_visible_seconds>=2', 'label_in_description'],
  };
}

/* ───────────── 隐式标识（元数据） ───────────── */

// 通用六字段：这是国内 AIGC 元数据留痕的通行字段集合（Label / ContentProducer / ProduceID /
// ReservedCode1 / ContentPropagator / PropagateID / ReservedCode2）。
// 注意：各平台在验收时对大小写与嵌套层级可能有差异，落地前请以平台最新接口文档为准——
// 所以这里把字段集合单独暴露（AIGC_KEYS），方便对接层做映射而不是改本文件。
const AIGC_KEYS = {
  label: 'Label',
  producer: 'ContentProducer',
  produceId: 'ProduceID',
  reserved1: 'ReservedCode1',
  propagator: 'ContentPropagator',
  propagateId: 'PropagateID',
  reserved2: 'ReservedCode2',
};

function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/**
 * 隐式标识：给 mp4 元数据（或 sidecar JSON）用的存根。
 * @param {object} o {producer, propagateId, tool, version, promptText, promptDigest, stage, style, created, platform, manualReview}
 */
function metadataStub(o) {
  o = o || {};
  const now = o.created || new Date().toISOString();
  const producer = o.producer || 'ai-video-platform';
  // ProduceID 用"工具名-时间-提示词指纹"：既能让同一提示词的重跑可被识别，又不需要中心化发号
  const digest = o.promptDigest || (o.promptText ? 'djb2:' + djb2(String(o.promptText)) : 'djb2:none');
  const produceId = producer + '-' + now.replace(/[-:.TZ]/g, '').slice(0, 14) + '-' + digest.split(':')[1];

  const aigc = {};
  aigc[AIGC_KEYS.label] = '1';                     // 1 = AI 生成合成内容（平台约定值）
  aigc[AIGC_KEYS.producer] = producer;             // 生成合成服务提供方
  aigc[AIGC_KEYS.produceId] = produceId;           // 本次生成的唯一编号
  aigc[AIGC_KEYS.reserved1] = 'ai-video-platform/' + (o.version || '0.1.0');
  aigc[AIGC_KEYS.propagator] = o.propagator || ''; // 传播平台（未发布时留空，发布时由分发层填）
  aigc[AIGC_KEYS.propagateId] = o.propagateId || '';
  aigc[AIGC_KEYS.reserved2] = '';

  return {
    AIGC: aigc,
    // XMP 侧：IPTC 的 DigitalSourceType 是国际通行的"算法生成"取值，与国内字段并行不冲突
    XMP: {
      'xmp:Label': 'AIGC',
      'Iptc4xmpExt:DigitalSourceType': 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
      'xmp:CreatorTool': producer + '/' + (o.version || '0.1.0'),
      'xmp:CreateDate': now,
    },
    // 留痕：把"哪次编译、哪个 stage、哪个风格"写进去，便于回溯"这条片子是哪版提示词出的"
    Trace: {
      tool: producer + '/' + (o.version || '0.1.0'),
      createdAt: now,
      stage: o.stage || '',
      style: o.style || '',
      promptDigest: digest,
      promptPreview: o.promptText ? String(o.promptText).slice(0, 120) : '',
    },
    // sidecar JSON 文件名约定：与成片同名 .aigc.json，放在同目录，打包时随母版一起走
    sidecar: (o.basename || 'output') + '.aigc.json',
    manual: {
      // 这几项机器判断不了，必须留人工确认位——写死成"已确认"就是造假
      human_review_required: o.manualReview !== false,
      checklist: ['人物/场景非真实可识别个人', '未使用未授权声音克隆', '标识在成片内可见'],
    },
    provenance: 'field-names: platform-common; values: project-defined',
  };
}

/* ───────────── 发布免责声明 ───────────── */

function disclaimerText(o) {
  o = o || {};
  const year = o.year || new Date().getFullYear();
  const tool = o.tool || '本地视频生成平台';
  const lines = [
    '本内容由「' + tool + '」使用生成式人工智能技术生成合成，画面、配音与文案均非真人实拍。',
    '人物形象、服饰、场景为虚构或合成，如有雷同纯属巧合；不构成对任何真实人物、机构、事件的指涉。',
    '内容仅用于创作与演示，不构成专业建议。' + (o.extra ? String(o.extra) : ''),
    '© ' + year + ' ' + (o.producer || '内容作者') + '｜AI 生成内容，已按平台要求添加显式标识与隐式元数据。',
  ];
  return { text: lines.join('\n'), lines, maxChars: o.maxChars || 0 };
}

/* ───────────── 与参数层的接线校验 ───────────── */

/**
 * ex.ai_label 在注册表里标注"不可关"，但设置文件是可以被手改的。
 * 这里做的是编译期断言：如果 values 里它被改成 false，就把 warning 交给上层 UI，而不是默默照做。
 */
function assertLabelsOn(values) {
  const out = [];
  const v = values || {};
  if (v['ex.ai_label'] === false) {
    out.push({ id: 'ai-label-disabled', level: 'red', keys: ['ex.ai_label'], msg: 'ex.ai_label 注册表标注为「不可关」，当前值却是 false：成片将缺少法规要求的显式标识', fix: '恢复为 true；如需隐藏角标，改用片尾完整声明（labelText({style:"endcard"})）' });
  }
  if (v['ex.metadata'] === false) {
    out.push({ id: 'metadata-disabled', level: 'yellow', keys: ['ex.metadata'], msg: 'ex.metadata 关闭后不写隐式标识，平台侧可能判定为"未标识 AI 内容"', fix: '保持开启，或由分发层在发布时补写平台字段' });
  }
  return out;
}

/** 一次性生成"标识包"：显式文本 + 隐式元数据 + 免责声明 + 校验结果 */
function labelBundle(values, o) {
  values = values || {};
  o = o || {};
  return {
    explicit: labelText({ style: o.style, platform: o.platform, producer: o.producer, year: o.year }),
    implicit: metadataStub(o),
    disclaimer: disclaimerText(o),
    warnings: assertLabelsOn(values),
  };
}

module.exports = { labelText, metadataStub, disclaimerText, assertLabelsOn, labelBundle, AIGC_KEYS, LABEL_TEXTS };