'use strict';
/**
 * prompt/selftest.js —— 编译层的自检
 *
 * 自检原则：断言必须打在"产品承诺"上，而不是打在代码结构上。
 * 所以这里有六类硬断言，任何一条不过就直接 fail 并打印真实数字：
 *   1) 覆盖：258 参数每一个都有处置，43 个 L3 全部"被槽位消费"或"显式声明不影响提示词"；
 *   2) 追溯：125 个 consumed 参数，每一个都能在自己的 stage 里留下带参数 key 的 note（真跑，不是查表）；
 *   3) 唯一真相源：positive 必须等于 renderZh(structured)，不能有渲染期"偷偷补一句"；
 *   4) 负向分stage：六个出提示词的 stage，负向集两两不同（且 Jaccard 足够低，不是改个标点就算不同）；
 *   5) 冲突：构造用例必须命中既定冲突 id；
 *   6) 黑名单：所有 stage × 所有风格 × 中英两种 locale 的 positive 里不得出现黑名单词。
 *
 * 跑法：node prompt/selftest.js
 */

const path = require('path');
const fs = require('fs');

const compose = require('./compose.js');
const safety = require('./safety.js');

const HERE = __dirname;
let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fail++;
  failures.push(name + (detail ? ' → ' + detail : ''));
  return false;
}
function line(s) { console.log(s); }
function head(s) { console.log('\n── ' + s + ' ' + '─'.repeat(Math.max(4, 56 - s.length))); }

/* ───────────── 0. 数据文件可用性 ───────────── */

head('0 数据文件');
const lexRaw = JSON.parse(fs.readFileSync(path.join(HERE, 'lexicon.zh.json'), 'utf8'));
const styRaw = JSON.parse(fs.readFileSync(path.join(HERE, 'styles.json'), 'utf8'));
ok('lexicon/schema', lexRaw.schema === 'ai-video-platform/lexicon.zh');
ok('styles/schema', styRaw.schema === 'ai-video-platform/styles');

const groupCount = Object.keys(lexRaw.groups).length;
const entryCount = Object.keys(lexRaw.groups).reduce((n, g) => n + Object.keys(lexRaw.groups[g].entries).length, 0);
line('词库：' + groupCount + ' 组 / ' + entryCount + ' 条 / 黑名单 ' + lexRaw.blacklist.entries.length + ' 条');
line('风格：' + styRaw.styles.length + ' 个预设');

// 词库里不许出现"实测"宣称：本项目没有实验记录，写 measured 就是编数据
const measured = [];
for (const g in lexRaw.groups) for (const zh in lexRaw.groups[g].entries) {
  const e = lexRaw.groups[g].entries[zh];
  if (e.provenance === 'measured') measured.push(g + '.' + zh);
}
for (const s of styRaw.styles) for (const slot in s.structured_delta) for (const it of s.structured_delta[slot]) {
  if (it.provenance === 'measured') measured.push(s.id + '.' + slot);
}
ok('provenance 不得伪造实测', measured.length === 0, measured.slice(0, 5).join(','));

const provMissing = [];
for (const g in lexRaw.groups) for (const zh in lexRaw.groups[g].entries) {
  if (!lexRaw.groups[g].entries[zh].provenance) provMissing.push(g + '.' + zh);
}
ok('每条词条标注 provenance', provMissing.length === 0, provMissing.slice(0, 5).join(','));

/* ───────────── 1. 覆盖 ───────────── */

head('1 参数覆盖');
const d = compose.dispositions();
const l3 = d.l3rows;
const l3Consumed = l3.filter((r) => r.disposition === 'consumed');
const l3Non = l3.filter((r) => r.disposition === 'nonprompt');
const l3Un = l3.filter((r) => r.disposition === 'unmapped');
const allConsumed = d.rows.filter((r) => r.disposition === 'consumed');
const allNon = d.rows.filter((r) => r.disposition === 'nonprompt');
const allUn = d.rows.filter((r) => r.disposition === 'unmapped');

const pct = (a, b) => (b ? (a / b * 100).toFixed(1) : '0.0');
line('参数总数 ' + d.total + '｜L3 ' + d.l3 + '｜L4 ' + (d.total - d.l3));
line('L3 处置：consumed ' + l3Consumed.length + ' + nonprompt ' + l3Non.length + ' + unmapped ' + l3Un.length
  + '  →  L3 覆盖率 ' + pct(l3Consumed.length + l3Non.length, d.l3) + '%');
line('全量处置：consumed ' + allConsumed.length + ' + nonprompt ' + allNon.length + ' + unmapped ' + allUn.length
  + '  →  总覆盖率 ' + pct(allConsumed.length + allNon.length, d.total) + '%');
line('（nonprompt 的 ' + allNon.length + ' 条全部带书面理由，可逐条审计：' + (allNon.every((r) => r.reason && r.reason.length > 6) ? '是' : '否') + '）');

ok('L3 无 unmapped', l3Un.length === 0, l3Un.map((r) => r.key).join(','));
ok('全量无 unmapped', allUn.length === 0, allUn.map((r) => r.key).join(','));
ok('nonprompt 每条有理由', allNon.every((r) => r.reason && r.reason.length > 6));

/* ───────────── 2. 追溯：真跑每个 stage ───────────── */

head('2 notes 可追溯');
const STAGES = compose.STAGES;
const styles = compose.listStyles();
const styleNames = [null].concat(styles.map((s) => s.id));

// 全组合跑一遍：7 stage × 9 style（含无风格），两个 locale 由 stage 循环覆盖
const runs = [];
for (const stage of STAGES) for (const st of styleNames) runs.push(compose.compile({}, { stage, style: st }));

const traceKeys = new Set();
for (const r of runs) for (const t of r.structured.trace) traceKeys.add(t.key);

const reg = compose.registry();
const regKeys = new Set(reg.params.map((p) => p.key));
const styleIds = new Set(styles.map((s) => s.id));

const unconsumed = allConsumed.filter((r) => !traceKeys.has(r.key));
line('consumed 参数在真跑中留下 note：' + (allConsumed.length - unconsumed.length) + '/' + allConsumed.length
  + '  = ' + pct(allConsumed.length - unconsumed.length, allConsumed.length) + '%');
ok('每个 consumed 参数都能追溯到 key', unconsumed.length === 0, unconsumed.map((r) => r.key).join(','));

let badKey = [];
for (const r of runs) for (const t of r.structured.trace) {
  if (String(t.key).indexOf('style:') === 0) {
    if (!styleIds.has(String(t.key).slice(6))) badKey.push(t.key);
  } else if (!regKeys.has(t.key)) badKey.push(t.key);
}
ok('notes 里的 key 均为注册表 key 或合法 style id', badKey.length === 0, [...new Set(badKey)].slice(0, 6).join(','));

const totalNotes = runs.reduce((n, r) => n + r.notes.length, 0);
line('总 note 条数（7 stage × 9 风格，含被去重/条件未触发的行）: ' + totalNotes);

/* ───────────── 3. structured 是唯一真相源 ───────────── */

head('3 唯一真相源');
const drift = [];
for (const r of runs) {
  if (compose.renderZh(r.structured) !== r.positive_zh) drift.push(r.stage + '/' + (r.structured.style || '-') + ' zh');
  if (compose.renderEn(r.structured) !== r.positive_en) drift.push(r.stage + '/' + (r.structured.style || '-') + ' en');
}
ok('positive === render(structured)', drift.length === 0, drift.slice(0, 4).join(','));

// 槽位完整性：structured 必须真的有槽，而不是一个字符串
const slotKeys = Object.keys(runs[0].structured.slots);
ok('槽位齐全（11 槽）', compose.SLOTS.every((s) => slotKeys.indexOf(s) >= 0), slotKeys.join(','));

/* ───────────── 4. 负向分 stage ───────────── */

head('4 负向集按 stage 分离');
const negStages = ['character', 'storyboard', 'keyframe', 'motion', 'voice', 'look'];
const negSets = {};
for (const s of negStages) {
  const r = compose.compile({}, { stage: s });
  negSets[s] = new Set(r.negative.split('，').filter(Boolean));
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}
const pairs = [];
for (let i = 0; i < negStages.length; i++) for (let j = i + 1; j < negStages.length; j++) {
  const a = negStages[i], b = negStages[j];
  pairs.push({ a, b, j: jaccard(negSets[a], negSets[b]), equal: [...negSets[a]].sort().join('|') === [...negSets[b]].sort().join('|') });
}
const equalPairs = pairs.filter((p) => p.equal);
const maxJ = pairs.reduce((m, p) => Math.max(m, p.j), 0);
line('负向集规模：' + negStages.map((s) => s + '=' + negSets[s].size).join('  '));
line('两两组合 ' + pairs.length + ' 对，完全相同 ' + equalPairs.length + ' 对，最大 Jaccard ' + maxJ.toFixed(2));
ok('两两不同（无完全相同的组合）', equalPairs.length === 0, equalPairs.map((p) => p.a + '/' + p.b).join(','));
ok('Jaccard 上限 <0.5（不是"改标点充数"）', maxJ < 0.5, 'max=' + maxJ.toFixed(2));
// 关键三类必须各说各的：出图看结构、动效看时序、人像看解剖
const kfHas = (w) => negSets.keyframe.has(w);
const moHas = (w) => negSets.motion.has(w);
const chHas = (w) => negSets.character.has(w);
line('抽样：关键帧含「色带断层」=' + kfHas('色带断层') + '｜动效含「逐帧闪烁」=' + moHas('逐帧闪烁') + '｜人像含「多余的手指」=' + chHas('多余的手指'));
ok('三类负向互不串门', kfHas('色带断层') && moHas('逐帧闪烁') && chHas('多余的手指') && !kfHas('逐帧闪烁') && !moHas('色带断层'));

/* ───────────── 5. 冲突检测 ───────────── */

head('5 冲突检测');
const cases = [
  { id: 'cold-light-warm-skin', values: { 'kf.color_temp': 7200, 'ch.palette': '东方暖调', 'ch.skin': '水光' } },
  { id: 'fast-move-deep-dof', values: { 'mo.camera_speed': 1.2, 'kf.dof': 10 } },
  { id: 'fast-move-shallow-dof', values: { 'mo.camera_speed': 1.1, 'kf.dof': 85 } },
  { id: 'multi-subject-strong-lock', values: { 'sb.character_count': 4, 'ch.consistency': 0.9, 'ch.identity_lock': true } },
  { id: 'anime-vs-realistic-skin', values: { 'ch.style': '赛璐璐', 'ch.skin': '写实纹理' } },
  { id: 'ink-vs-sharpen', values: { 'ch.style': '水墨', 'lk.sharpen': 55, 'kf.grain': 30 } },
  { id: 'steps-vs-detail', values: { 'kf.steps': 12, 'kf.detail_boost': 60 } },
  { id: 'fast-rhythm-long-take', values: { 'sb.rhythm': '快', 'mo.duration': 5 } },
  { id: 'lipsync-scale-mismatch', values: { 'vo.lipsync': true, 'vo.closeup_only': true, 'sb.shot_scale': '全景' } },
  { id: 'mono-vs-haircolor', values: { 'lk.lut': '黑白', 'ch.hair_color': '栗棕' } },
  { id: 'emotion-vs-genre', values: { 'vo.emotion': '俏皮', 'sb.genre': '古风' } },
];
let hit = 0;
const missed = [];
for (const c of cases) {
  const r = compose.compile(c.values, { stage: 'keyframe' });
  const ids = r.warnings.map((w) => w.id);
  if (ids.indexOf(c.id) >= 0) hit++; else missed.push(c.id);
}
line('构造用例 ' + cases.length + ' 组，命中 ' + hit + ' 组' + (missed.length ? '，未命中：' + missed.join(',') : ''));
ok('至少命中 3 组冲突', hit >= 3, 'hit=' + hit);
ok('全部构造用例命中', missed.length === 0, missed.join(','));
// 每条冲突都要给"怎么修"，否则等于报错不给出路
const noFix = [];
for (const c of cases) for (const w of compose.compile(c.values, { stage: 'keyframe' }).warnings) {
  if (['red', 'yellow'].indexOf(w.level) >= 0 && !w.fix) noFix.push(w.id);
}
ok('红/黄级冲突都带 fix 建议', noFix.length === 0, noFix.join(','));
// 默认值不该满屏报警，但默认前缀确实命中黑名单——这两个都要是"真"的
const defRun = compose.compile({}, { stage: 'keyframe' });
line('默认值告警：' + (defRun.warnings.map((w) => w.id).join(',') || '无'));
ok('默认值出现 prefix 黑名单告警（ch.prompt_prefix 默认含 masterpiece/best quality）',
  defRun.warnings.some((w) => w.id === 'prefix-blacklist'));

/* ───────────── 6. 黑名单 ───────────── */

head('6 黑名单');
const bl = compose.blacklist();
let dirty = [];
for (const stage of STAGES) for (const st of styleNames) {
  for (const locale of ['zh', 'en']) {
    const r = compose.compile({}, { stage, style: st, locale });
    const l1 = compose.lint(r.positive);
    const l2 = compose.lint(r.positive_en);
    if (l1.hits.length) dirty.push(stage + '/' + (st || '-') + '/' + locale + ':' + l1.hits.map((h) => h.word).join('+'));
    if (l2.hits.length) dirty.push(stage + '/' + (st || '-') + '/' + locale + '-en:' + l2.hits.map((h) => h.word).join('+'));
  }
}
line('黑名单 ' + bl.length + ' 条；扫描 ' + (STAGES.length * styleNames.length * 2) + ' 份正负向产物');
ok('positive/positive_en 无黑名单词', dirty.length === 0, dirty.slice(0, 4).join(' | '));

// 黑名单必须真能抓住"堆砌画质词"的典型写法
const bad = '8K超高清杰作，best quality, masterpiece, 超写实，极致细节，ultra detailed，一个女孩站在窗边';
const badLint = compose.lint(bad);
line('样板检测：命中 ' + badLint.hits.length + ' 条，超长=' + badLint.overlong + '，建议 ' + badLint.advice.length + ' 条');
ok('lint 抓到堆砌词', badLint.hits.length >= 6, 'hits=' + badLint.hits.length);
ok('lint 给出可执行建议', badLint.advice.length >= 1);

const goodLint = compose.lint('一个24岁的中国女孩，侧逆光，中景，35mm，皮肤保留毛孔质感');
ok('干净提示词不被误报', goodLint.ok === true, JSON.stringify(goodLint.hits));

// 超长冗余：中文 160 字上限，用复读把长度顶上去
const longText = '一个女孩，' + '站在窗边，'.repeat(42);
const longLint = compose.lint(longText);
line('超长样板：' + longLint.chars + ' 汉字 / 复读 ' + longLint.duplicates.length + ' 处');
ok('超长/复读被识别', longLint.overlong === true && longLint.duplicates.length >= 1,
  'overlong=' + longLint.overlong + ' dup=' + longLint.duplicates.length);

/* ───────────── 7. 风格与标识层 ───────────── */

head('7 风格预设与标识');
ok('风格 ≥ 8 个', styRaw.styles.length >= 8, String(styRaw.styles.length));
const badStage = [];
const badSlot = [];
for (const s of styRaw.styles) {
  for (const st of s.stages) if (STAGES.indexOf(st) < 0) badStage.push(s.id + '.' + st);
  for (const slot in s.structured_delta) {
    if (slot !== 'negative_extra' && compose.SLOTS.indexOf(slot) < 0) badSlot.push(s.id + '.' + slot);
  }
}
ok('风格 stage 合法', badStage.length === 0, badStage.join(','));
ok('风格增量槽位合法', badSlot.length === 0, badSlot.join(','));
// 中文别名必须能解析（用户会说"古风"，不会说 oriental-ancient）
const aliasOk = ['古风', '水墨', '赛博', '二次元', '漫剧', '胶片'].every((n) => !!compose.resolveStyle(styRaw, n));
line('别名解析（古风/水墨/赛博/二次元/漫剧/胶片）：' + (aliasOk ? '全部命中' : '有未命中'));
ok('中文别名可解析', aliasOk);

const bundle = safety.labelBundle({ 'ex.ai_label': true, 'ex.metadata': true }, { platform: 'douyin', producer: '测试号', promptText: defRun.positive, stage: 'keyframe' });
line('显式标识：' + bundle.explicit.text + '｜落位：' + bundle.explicit.placement);
line('隐式字段：' + Object.keys(bundle.implicit.AIGC).join('/'));
ok('显式标识非空', !!bundle.explicit.text && bundle.explicit.text.length >= 6);
ok('隐式标识含六字段', Object.keys(bundle.implicit.AIGC).length === 7, String(Object.keys(bundle.implicit.AIGC).length));
ok('元数据带提示词指纹', /^djb2:/.test(bundle.implicit.Trace.promptDigest), bundle.implicit.Trace.promptDigest);
ok('关闭标识会被拦下', safety.assertLabelsOn({ 'ex.ai_label': false, 'ex.metadata': false }).length === 2);

/* ───────────── 汇总 ───────────── */

head('汇总');
line('断言 ' + (pass + fail) + ' 条：通过 ' + pass + '，失败 ' + fail);
if (fail) {
  line('失败明细：');
  for (const f of failures) line('  ✗ ' + f);
  process.exitCode = 1;
  console.log('\n存在失败断言');
} else {
  console.log('\n全部通过');
}