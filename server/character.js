/**
 * character.js —— 角色设定自动提取（从一句提示词回填 ch.* 字段）
 *
 * 为什么要有这个文件：
 *   角色设定板块有 42 个 ch.* 参数，用户写提示词时其实已经把「谁、多大、脸什么样、穿什么、
 *   什么画风」讲清了；让用户再逐项手填一遍，是把模型的活推给人。
 *   这里只做一件事：**把提示词里已经说过的提取出来**，说过的才填，没说的留空/留默认。
 *
 * 三条纪律：
 *   1. 不脑补：提示词没写的字段不写值，只标 source:'default'（值取注册表默认）或 'empty'。
 *   2. 不擅自选：提示词里出现两个主体（"男生和女生"）→ source:'conflict'，候选原样列出，等用户点。
 *   3. 每项留痕：value/source/evidence/confidence 四件套，前端才能标「AI提取」还是「已自定义」。
 *
 * 字段与注册表的真实口径（不是方案稿里的理想 schema）：
 *   ch.subject     text    主体描述
 *   ch.age         int     年龄感 → 关键词映射到数字（teen 16 / young 24 / middle 42 / old 68），
 *                          写了"23岁"就取 23，不写不填
 *   ch.face_shape  enum    鹅蛋|圆|方|瓜子|长|心形
 *   ch.outfit_1    text    主服装
 *   ch.style       enum    赛璐璐|厚涂|工笔|水墨|韩漫|日漫|国潮（插画画风）；
 *                          「电影感/古风/赛博」这类**画面风格**另出 style7（cine 七风格 id），
 *                          两者不是同一个字段，别互相覆盖
 *   ch.consistency float   多镜头/同人物系列 → 1.0；单镜氛围片 → 0.85；上限 1.1
 */
'use strict';

/** 年龄关键词 → 数字。顺序有意义：先匹配具体的，再匹配泛的。 */
const AGE_RULES = [
  { re: /(?:^|[^\d])(\d{1,2})\s*(?:岁|周岁)/, kind: 'explicit' },
  { re: /(婴儿|宝宝|幼童|幼儿)/, age: 5, band: 'infant' },
  { re: /(小孩|儿童|男孩|女孩|正太|萝莉|少年|少女)(?!感)/, age: 16, band: 'teen' },
  { re: /(青年|年轻|小伙|小伙儿|学生|大学|二十出头|20出头|20岁左右)/, age: 24, band: 'young' },
  { re: /(中年|大叔|阿姨|四十|40岁左右|不惑)/, age: 42, band: 'middle' },
  { re: /(老年|老人|大爷|大妈|奶奶|爷爷|白发|花甲|古稀)/, age: 68, band: 'old' },
];

/** 脸型词 → 注册表 enum。V脸/瓜子脸都归「瓜子」；网红脸=平台默认精致脸（鹅蛋）。 */
const FACE_RULES = [
  { re: /(鹅蛋脸|鹅蛋)/, value: '鹅蛋' },
  { re: /(瓜子脸|瓜子|V脸|v脸|V型脸|小V脸|尖脸|网红脸)/, value: '瓜子' },
  { re: /(圆脸|娃娃脸|婴儿肥)/, value: '圆' },
  { re: /(方脸|国字脸|棱角脸)/, value: '方' },
  { re: /(长脸|马脸)/, value: '长' },
  { re: /(心形脸|桃心脸|倒三角)/, value: '心形' },
];

/** 插画画风词 → ch.style（与 cine 七风格分开） */
const ILLUST_RULES = [
  { re: /(赛璐璐|cel\s*shading)/i, value: '赛璐璐' },
  { re: /(厚涂|painterly)/i, value: '厚涂' },
  { re: /(工笔|工笔画)/, value: '工笔' },
  { re: /(水墨|泼墨|写意)/, value: '水墨' },
  { re: /(韩漫|韩国漫画)/, value: '韩漫' },
  { re: /(日漫|日本漫画|漫画风)/, value: '日漫' },
  { re: /(国潮|国风插画)/, value: '国潮' },
];

/** 画面风格词 → cine 七风格 id（cinema/doc/anime/guofeng/cyber/dark/dream） */
const STYLE7_RULES = [
  { re: /(赛博|cyber|霓虹|neon|未来|科幻|机械|机甲|蒸汽朋克|柴油朋克)/i, id: 'cyber' },
  { re: /(暗黑|哥特|gothic|恐怖|废墟|阴森|死亡|noir|黑色电影)/i, id: 'dark' },
  { re: /(梦幻|dream|柔光|奶油|童话|空灵|仙气|朦胧)/i, id: 'dream' },
  { re: /(古风|国风|汉服|仙侠|东方|水墨|工笔|宫廷|武侠)/, id: 'guofeng' },
  { re: /(动漫|二次元|动画|番剧|anime)/i, id: 'anime' },
  { re: /(纪实|纪录片|胶片|日常|生活流|采访|vlog)/i, id: 'doc' },
  { re: /(电影感|电影|cinematic|写实|大片|影视|剧照)/i, id: 'cinema' },
];

/** 服装词库：类别（用于组合成一句人话）+ 颜色 + 材质 */
const GARMENT_WORDS = [
  '围巾', '大衣', '风衣', '羽绒服', '毛衣', '针织衫', '开衫', '卫衣', '衬衫', 'T恤', 't恤', '西装', '礼服', '连衣裙',
  '半身裙', '长裙', '短裙', '牛仔裤', '阔腿裤', '工装裤', '半裙', '背心', '吊带', '夹克', '皮衣', '皮草', '马甲',
  '汉服', '长袍', '道袍', '旗袍', '襦裙', '马面裙', '披风', '斗篷', '铠甲', '战袍', '僧袍', '和服', '浴衣',
  '校服', '制服', '泳装', '睡衣', '运动服', '西服', '外套', '羽绒', '帽衫', '背带裤', '连体裤', '短裤', '丝袜',
];
const COLOR_WORDS = [
  '米色', '奶白', '白色', '黑色', '深色', '浅色', '灰色', '藏青', '驼色', '卡其', '棕色', '酒红', '红色', '粉色',
  '蓝色', '宝蓝', '军绿', '墨绿', '绿色', '紫色', '黄色', '橙色', '金色', '银色', '条纹', '格子', '碎花', '纯色',
];

/** 多镜头/系列 → 一致性提到 1.0 */
const MULTI_RULES = /(多镜|分镜|三个镜头|3镜|系列|同一个人|同一人物|连续|连拍|组图|多次|一致|保持形象|同一角色|短剧|剧情)/;
/** 单镜氛围片 → 一致性 0.85（放开画面） */
const SINGLE_RULES = /(氛围|空镜|剪影|背影|侧脸|光斑|单独一人|一个人的|情绪片|风景)/;

const PERSON_WORDS = ['女生', '女孩', '女子', '女人', '男生', '男孩', '男子', '男人', '少女', '少年', '姑娘', '小姐', '男生', '学生', '老人', '大爷', '阿姨', '奶奶', '爷爷', '孩子', '小孩', '模特', '女孩儿', '女人', '人物'];
/** 主体冲突：并列连词 + 两个人物词，或明确的"两个/两位/一群人" */
const JOIN_RE = /(和|与|跟|以及|、|,|，)/;
const MULTI_PERSON_RE = /(两个|两位|俩人|二人|三人|三个|一群|众人|几个人|多人|双人)/;

/** 从提示词里剥掉技术/风格噪音，得到一句可当主体描述的话 */
const NOISE_RE = /(电影感|写实|高清|4k|8k|超清|横屏|竖屏|16:9|9:16|运镜|慢推|慢拉|环绕|跟拍|景深|虚化|光斑|氛围感|胶片感|丁达尔|逆光|柔光|打光|构图|三分法|留白|特写|中景|远景|全景|推镜|拉镜|摇镜)/gi;

function tidy(s) {
  return String(s || '')
    .replace(NOISE_RE, '')
    .replace(/[，,、；;]+/g, '，')
    .replace(/[。！!？?]+/g, '，')
    .replace(/，{2,}/g, '，')
    .replace(/^[，\s]+|[，\s]+$/g, '')
    .trim();
}

function findFirst(rules, text) {
  for (const r of rules) if (r.re.test(text)) return r;
  return null;
}

/** 抽服装：把命中词按出现顺序拼成"颜色+服装"，不重复、不超过两件 */
function extractOutfits(text) {
  const hits = [];
  for (const w of [...GARMENT_WORDS, ...COLOR_WORDS]) {
    let idx = text.indexOf(w);
    while (idx >= 0) {
      hits.push({ w, idx });
      idx = text.indexOf(w, idx + w.length);
    }
  }
  hits.sort((a, b) => a.idx - b.idx);
  // 「羽绒服」与「羽绒」会同时命中：同一区间只留最长词，否则会拼出「红色羽绒服，红色羽绒」
  const garmentHits = hits.filter((h) => GARMENT_WORDS.includes(h.w));
  const garments = [];
  for (const g of garmentHits) {
    const overlap = garments.find((x) => Math.abs(x.idx - g.idx) < Math.max(x.w.length, g.w.length) && (x.w.includes(g.w) || g.w.includes(x.w)));
    if (overlap) { if (g.w.length > overlap.w.length) garments[garments.indexOf(overlap)] = g; continue; }
    garments.push(g);
  }
  garments.sort((a, b) => a.idx - b.idx);
  if (!garments.length) return [];
  // 每件服装往前找最近的颜色修饰，组成「深色大衣」这种短语
  const out = [];
  for (const g of garments) {
    const color = hits.filter((h) => COLOR_WORDS.includes(h.w) && h.idx <= g.idx).pop();
    const phrase = (color ? color.w : '') + g.w;
    if (!out.includes(phrase)) out.push(phrase);
    if (out.length >= 2) break;
  }
  return out;
}

/** 找主体候选：并列人物词 / 多人量词 */
function detectSubjects(text) {
  const persons = [];
  for (const w of PERSON_WORDS) {
    const i = text.indexOf(w);
    if (i >= 0) persons.push({ word: w, idx: i });
  }
  persons.sort((a, b) => a.idx - b.idx);
  const uniq = [];
  for (const p of persons) if (!uniq.some((u) => u.idx === p.idx || p.word.includes(u.word) || u.word.includes(p.word))) uniq.push(p);
  const multi = MULTI_PERSON_RE.test(text);
  const joined = uniq.length >= 2 && JOIN_RE.test(text.slice(Math.max(0, uniq[0].idx - 2), uniq[uniq.length - 1].idx + 3));
  if (multi || joined) {
    // 冲突：把每个人物词连同它前面的修饰语做成候选，原样给用户看
    const segs = text.split(/[和与跟、,，]/).map((x) => tidy(x)).filter(Boolean);
    const cands = uniq.slice(0, 4).map((p) => {
      const seg = segs.find((x) => x.includes(p.word));
      return (seg || p.word).slice(0, 40);
    });
    return { conflict: true, candidates: cands.length ? cands : uniq.map((u) => u.word), reason: multi ? '提示词含多人/复数主体' : '提示词并列出现两个人物' };
  }
  return { conflict: false, candidates: [], reason: null };
}

/**
 * 提取主体描述：优先"人物词所在的第一个短句"，没有人物就取整句（物体/场景也能当主体）。
 */
function extractSubject(text) {
  const clauses = text.split(/[，,。；;]/).map((s) => s.trim()).filter(Boolean);
  if (!clauses.length) return '';
  const person = PERSON_WORDS.find((w) => text.includes(w));
  if (person) {
    const idx = clauses.findIndex((c) => c.includes(person));
    if (idx >= 0) return tidy(clauses[idx]).slice(0, 80);
  }
  return tidy(clauses[0]).slice(0, 80);
}

/**
 * 主提取器。
 * @param {{registry:object}} opts
 */
function createCharacterExtractor(opts = {}) {
  const reg = opts.registry;
  const byKey = new Map((reg.params || []).map((p) => [p.key, p]));
  const def = (k) => (byKey.has(k) ? byKey.get(k).default : undefined);
  const dom = (k) => {
    const p = byKey.get(k);
    if (!p) return null;
    if (p.type === 'enum') return p.options || null;
    if (p.type === 'int' || p.type === 'float') return { min: p.min, max: p.max };
    return null;
  };

  const field = (value, source, evidence, confidence) => ({ value, source, evidence: evidence || '', confidence: confidence == null ? (source === 'ai' ? 0.8 : 0) : confidence });

  /**
   * @param {{prompt:string, values?:object, style?:string, shotCount?:number, mode?:string}} input
   *   values = 当前面板上的值（用于矛盾检测：提示词说汉服、面板却是皮衣 → 按提示词更新并留痕）
   */
  function extract(input = {}) {
    const raw = String(input.prompt || '').trim();
    const cur = input.values || {};
    const fields = {};
    const contradictions = [];
    const patch = {};

    if (!raw) {
      // 没提示词 = 没有任何可提取的信息，一律不写值
      for (const k of ['ch.subject', 'ch.age', 'ch.face_shape', 'ch.outfit_1', 'ch.style', 'ch.consistency']) {
        fields[k] = field(undefined, byKey.get(k) && byKey.get(k).type === 'text' ? 'empty' : 'default', '提示词为空', 0);
      }
      return { ok: false, reason: 'EMPTY_PROMPT', fields, patch, contradictions, subject: null, style7: null, confidence: 0 };
    }

    const text = raw;

    // ---- 主体 ----
    const subj = detectSubjects(text);
    const subjectText = extractSubject(text);
    if (subj.conflict) {
      fields['ch.subject'] = { value: null, source: 'conflict', evidence: subj.reason, confidence: 0, candidates: subj.candidates };
    } else if (subjectText) {
      fields['ch.subject'] = field(subjectText, 'ai', `提示词主体句：「${subjectText}」`, 0.75);
      patch['ch.subject'] = subjectText;
    } else {
      fields['ch.subject'] = field(null, 'empty', '未识别出主体', 0);
    }

    // ---- 年龄感 ----
    let ageHit = null;
    let ageValue = null;
    let ageBand = null;
    for (const r of AGE_RULES) {
      const m = text.match(r.re);
      if (!m) continue;
      ageHit = m[0].trim();
      if (r.kind === 'explicit') {
        ageValue = Math.max(3, Math.min(90, Number(m[1])));
        ageBand = ageValue <= 12 ? 'child' : ageValue <= 19 ? 'teen' : ageValue <= 30 ? 'young' : ageValue <= 55 ? 'middle' : 'old';
      } else {
        ageValue = r.age;
        ageBand = r.band;
      }
      break;
    }
    if (ageValue != null) {
      const d = dom('ch.age');
      const v = d && d.min != null ? Math.max(d.min, Math.min(d.max, ageValue)) : ageValue;
      fields['ch.age'] = { ...field(v, 'ai', `关键词「${ageHit}」→ ${ageBand}`, 0.7), band: ageBand };
      patch['ch.age'] = v;
    } else {
      fields['ch.age'] = { ...field(def('ch.age'), 'default', '提示词没写年龄，用默认值，不脑补具体岁数', 0), band: 'young' };
    }

    // ---- 骨相脸型 ----
    const face = findFirst(FACE_RULES, text);
    if (face) {
      const allow = dom('ch.face_shape');
      const v = allow && !allow.includes(face.value) ? allow[0] : face.value;
      fields['ch.face_shape'] = field(v, 'ai', `命中「${face.value}」`, 0.75);
      patch['ch.face_shape'] = v;
    } else {
      fields['ch.face_shape'] = field(def('ch.face_shape'), 'default', '提示词没写脸型，用当前风格默认脸（不报错、不脑补）', 0);
    }

    // ---- 主服装 ----
    const outfits = extractOutfits(text);
    if (outfits.length) {
      const v = outfits.join('，');
      fields['ch.outfit_1'] = field(v, 'ai', `抽到服装词：${outfits.join(' / ')}`, 0.7);
      patch['ch.outfit_1'] = v;
    } else {
      fields['ch.outfit_1'] = field(null, 'empty', '提示词没写服装，留空由模型按风格发挥', 0);
    }

    // ---- 画风（两条线：插画 ch.style / 画面 style7） ----
    const ill = findFirst(ILLUST_RULES, text);
    if (ill) {
      const allow = dom('ch.style');
      const v = allow && !allow.includes(ill.value) ? allow[0] : ill.value;
      fields['ch.style'] = field(v, 'ai', `命中插画词「${ill.value}」`, 0.75);
      patch['ch.style'] = v;
    } else {
      fields['ch.style'] = field(def('ch.style'), 'default', '提示词没写插画画风，保持默认', 0);
    }
    const s7 = findFirst(STYLE7_RULES, text);
    const style7 = s7 ? { id: s7.id, evidence: s7.re.source, explicit: true } : { id: input.style || 'cinema', evidence: '按顶部风格卡片', explicit: false };

    // ---- 一致性权重 ----
    const multi = MULTI_RULES.test(text) || Number(input.shotCount) > 1 || input.mode === 'multi';
    const single = SINGLE_RULES.test(text);
    let cons = Number(def('ch.consistency'));
    if (!Number.isFinite(cons)) cons = 0.85;
    let consNote = '默认 0.85（单镜氛围片口径）';
    if (multi) { cons = 1.0; consNote = '多镜头/同人物系列 → 提到 1.0'; }
    else if (single) { cons = 0.85; consNote = '单镜氛围/空镜 → 0.85，不锁死画面'; }
    cons = Math.min(1.1, Math.max(0.5, cons));
    const consExplicit = /(一致性|一致|锁定形象|形象锁|保持同一|同一张脸)/.test(text);
    fields['ch.consistency'] = field(cons, consExplicit || multi ? 'ai' : 'default', consNote, multi || consExplicit ? 0.7 : 0.3);
    if (multi || consExplicit) patch['ch.consistency'] = cons;

    // ---- 矛盾检测：面板现值与提示词明显冲突 → 按提示词更新，并留痕 ----
    for (const [k, v] of Object.entries(patch)) {
      const before = cur[k];
      if (k === 'ch.subject' || k === 'ch.age' || k === 'ch.consistency') continue;
      if (before == null || before === '' || before === v) continue;
      if (k === 'ch.outfit_1' && String(before).trim() && String(before).trim() !== String(v).trim()) {
        contradictions.push({ key: k, from: before, to: v, note: '已按提示词更新' });
      }
      if (k === 'ch.face_shape' && before !== v) contradictions.push({ key: k, from: before, to: v, note: '已按提示词更新' });
    }

    const aiCount = Object.values(fields).filter((f) => f.source === 'ai').length;
    return {
      ok: true,
      subject: fields['ch.subject'] && fields['ch.subject'].value,
      fields,
      patch,
      contradictions,
      style7,
      ageBand: fields['ch.age'] && fields['ch.age'].band,
      confidence: +(aiCount / 6).toFixed(2),
      conflicts: Object.entries(fields).filter(([, f]) => f.source === 'conflict').map(([k, f]) => ({ key: k, candidates: f.candidates || [], reason: f.evidence })),
    };
  }

  /**
   * 把 Qwen 返回的 character 块并进来：只认六个键，值必须过注册表域校验；
   * 过不了的进 rejected（前端可见），不静默丢弃。
   */
  function mergeQwen(base, qwenChar) {
    if (!qwenChar || typeof qwenChar !== 'object') return { ...base, qwen: { used: false, rejected: [] } };
    const KEYS = ['ch.subject', 'ch.age', 'ch.face_shape', 'ch.outfit_1', 'ch.style', 'ch.consistency'];
    const rejected = [];
    const fields = { ...base.fields };
    const patch = { ...base.patch };
    for (const k of KEYS) {
      const v = qwenChar[k];
      if (v == null || v === '') continue;
      const p = byKey.get(k);
      if (!p) { rejected.push({ key: k, reason: 'UNKNOWN_KEY' }); continue; }
      if (p.type === 'enum' && !(p.options || []).includes(v)) { rejected.push({ key: k, reason: 'BAD_ENUM', got: v, allowed: p.options }); continue; }
      if (p.type === 'int' || p.type === 'float') {
        const n = Number(v);
        if (!Number.isFinite(n) || (p.min != null && n < p.min) || (p.max != null && n > p.max)) { rejected.push({ key: k, reason: 'OUT_OF_RANGE', got: v, min: p.min, max: p.max }); continue; }
        fields[k] = field(n, 'ai', 'Qwen 提取', 0.85);
        patch[k] = n;
        continue;
      }
      const s = String(v).trim().slice(0, 120);
      fields[k] = field(s, 'ai', 'Qwen 提取', 0.85);
      patch[k] = s;
    }
    return { ...base, fields, patch, qwen: { used: true, rejected } };
  }

  return { extract, mergeQwen };
}

module.exports = { createCharacterExtractor, AGE_RULES, FACE_RULES, ILLUST_RULES, STYLE7_RULES, GARMENT_WORDS, COLOR_WORDS, extractOutfits, detectSubjects, extractSubject };
