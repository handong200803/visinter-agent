/**
 * wizard/library.selftest.mjs —— 作品库自检（Node 下无 IndexedDB，所以测"可测且有意义"的部分）
 *
 * 为什么不去 mock 一整套 IndexedDB：
 *   自造 IDB 只能证明"我的 mock 和我的实现互相看得懂"，证明不了浏览器里能跑。
 *   真正会翻车的是另外几件事：模块在 Node 里加载就炸、summary 聚合算错、
 *   超过 500 条时把用户收藏的作品淘汰掉、源码里偷偷引了外部资源或第三方依赖。
 *   这四类都能在 Node 里用真调用验，比 mock 出的一屋子假对象可信。
 *
 * 协议：末行「全部通过 · N 项」+ exit 0；任何一条不过就 exit 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC_PATH = path.join(ROOT, 'wizard', 'library.js');
const require = createRequire(import.meta.url);

let pass = 0;
let fail = 0;
const fails = [];

function ok(label, detail) {
  pass++;
  console.log('  ✔ ' + label + (detail ? '  ·  ' + detail : ''));
}
function bad(label, detail) {
  fail++;
  fails.push(label + (detail ? ' — ' + detail : ''));
  console.log('  ✘ ' + label + (detail ? '  ·  ' + detail : ''));
}
function assert(label, cond, detail) {
  if (cond) ok(label, detail);
  else bad(label, detail);
}
function group(name) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(2, 58 - name.length)));
}

/* ═════════════ 一、加载与 API 契约 ═════════════ */
group('加载：Node 下 require 必须安全');

assert('源文件存在', fs.existsSync(SRC_PATH), SRC_PATH);

let L = null;
try {
  L = require('./library.js');
} catch (e) {
  L = null;
  bad('require 不崩', String(e && e.message));
}
assert('require 返回对象', !!L && typeof L === 'object', L ? '导出 ' + Object.keys(L).length + ' 项' : 'null');

const CORE = ['isSupported', 'open', 'save', 'list', 'get', 'update', 'remove', 'clear', 'download', 'summary'];
if (L) {
  const missing = CORE.filter((k) => typeof L[k] !== 'function');
  assert('十个契约方法齐全且都是函数', missing.length === 0, missing.length ? '缺 ' + missing.join(', ') : CORE.length + '/10');
  assert('MAX_BLOB_BYTES 导出且等于 40MB', L.MAX_BLOB_BYTES === 40 * 1024 * 1024, String(L.MAX_BLOB_BYTES));
  assert('上限常量导出', L.MAX_LIST === 500 && L.MAX_POSTER_CHARS === 60 * 1024, 'MAX_LIST=500 · MAX_POSTER=60KB');

  let sup = null;
  let threw = null;
  try { sup = L.isSupported(); } catch (e) { threw = e; }
  assert('isSupported() 不抛', threw === null, threw ? String(threw.message) : '');
  assert(
    'isSupported() 返回 {indexeddb, localstorage} 两个布尔',
    !!sup && typeof sup.indexeddb === 'boolean' && typeof sup.localstorage === 'boolean',
    sup ? JSON.stringify(sup) : 'null'
  );
  assert('Node 下 indexeddb 为 false（没有 IDB 就如实报）', sup && sup.indexeddb === false);
  assert('backend() 落在三档之一', ['indexeddb', 'localstorage', 'memory'].indexOf(L.backend()) >= 0, L.backend());

  // open() 在 Node 必须 resolve(null) 而不是 reject：界面调用 open 之后走降级，不该弹错误
  let openRes = '未调用';
  let openThrew = false;
  try { openRes = await L.open(); } catch (e) { openThrew = true; }
  assert('open() 在无 IDB 时 resolve(null) 且不 reject', !openThrew && openRes === null, String(openRes));
  assert('lastError() 记录过中文原因', !!L.lastError() && /[\u4e00-\u9fa5]/.test(L.lastError().message), L.lastError() ? L.lastError().code : 'null');
}

/* ═════════════ 二、summary 纯函数 ═════════════ */
group('纯函数：summary 聚合');

if (L && typeof L.summary === 'function') {
  const recs = [
    { id: 'a', createdAt: 1, sizeBytes: 1000, styleId: 'cinematic' },
    { id: 'b', createdAt: 3, sizeBytes: 2000, styleId: 'cinematic' },
    { id: 'c', createdAt: 2, sizeBytes: 3000, styleId: 'photo' },
  ];
  const before = JSON.stringify(recs);
  const s = L.summary(recs);
  assert('count = 3', s.count === 3, String(s.count));
  assert('totalBytes = 6000', s.totalBytes === 6000, String(s.totalBytes));
  assert('lastAt 取最大 createdAt（=3）', s.lastAt === 3, String(s.lastAt));
  assert('styles 聚合 cinematic=2 / photo=1', s.styles.cinematic === 2 && s.styles.photo === 1, JSON.stringify(s.styles));
  assert('summary 不改入参', JSON.stringify(recs) === before);

  const e = L.summary([]);
  assert('空数组 → count 0 / totalBytes 0 / lastAt null', e.count === 0 && e.totalBytes === 0 && e.lastAt === null, JSON.stringify(e));
  assert('非数组输入不炸', L.summary(null).count === 0 && L.summary('x').count === 0);
  assert('脏条目（null / 字符串）被跳过', L.summary([null, 'x', { id: 'z', sizeBytes: 5 }]).count === 1);
  assert('sizeBytes 缺失不计入体积、不产生 NaN', L.summary([{ id: 'q', createdAt: 9 }]).totalBytes === 0);
  assert('poster / blob 字段不影响统计', L.summary([{ id: 'p', sizeBytes: 7, poster: null, videoBlob: null }]).totalBytes === 7);
}

/* ═════════════ 三、淘汰策略（纯函数 + 真 list 接线） ═════════════ */
group('上限策略：520 条 → 500 条，收藏/带片优先保住');

if (L && typeof L.prune === 'function') {
  // 构造：0-9 收藏（且只剩参数，最容易被误删）、10-19 有视频、20-519 光秃秃
  const bulk = [];
  for (let i = 0; i < 520; i++) {
    const r = {
      id: 'w_bulk_' + i,
      createdAt: 1000000 + i,
      styleId: 'cinematic',
      styleLabel: '电影感',
      prompt: '雪夜里小木屋亮着灯 #' + i,
      poster: 'data:image/png;base64,xx',
      sizeBytes: 100 + i,
      note: '',
    };
    if (i < 10) { r.favorite = true; r.videoOmitted = true; }
    else if (i < 20) { r.videoBlob = { size: 1024, type: 'video/webm', slice() { return this; } }; r.videoOmitted = false; }
    else { r.videoOmitted = false; }
    bulk.push(r);
  }
  const bulkBefore = bulk.length;

  const plan = L.prune(bulk, 500);
  assert('keep 恰好 500 条', plan.keep.length === 500, String(plan.keep.length));
  assert('dropped 恰好 20 条', plan.dropped.length === 20 && plan.over === 20, 'dropped=' + plan.dropped.length);
  assert('prune 不改入参（仍是 520 条）', bulk.length === bulkBefore, String(bulk.length));
  assert('keep 按 createdAt 倒序', plan.keep[0].createdAt === 1000519, String(plan.keep[0].createdAt));

  const droppedIds = new Set(plan.dropped.map((r) => r.id));
  const favLost = bulk.filter((r) => r.favorite && droppedIds.has(r.id));
  const blobLost = bulk.filter((r) => r.videoBlob && droppedIds.has(r.id));
  assert('10 条收藏一条没淘汰', favLost.length === 0, favLost.map((r) => r.id).join(',') || '全部保住');
  assert('10 条带视频的一条没淘汰', blobLost.length === 0, blobLost.map((r) => r.id).join(',') || '全部保住');
  assert('被淘汰的全是最老的光杆记录（20-39）', plan.dropped.every((r) => Number(r.id.split('_').pop()) >= 20 && Number(r.id.split('_').pop()) <= 39));
  // 注意：0-9 是收藏，虽然最老但要保住，所以整体最小值仍是最老那条；这里看的是"普通记录被砍掉最老的 20 条后，从第 40 条起才留下"
  const keptPlain = plan.keep.filter((r) => !r.favorite && !r.videoBlob);
  assert('普通记录里最老留下来的是第 40 条（20-39 被淘汰）', Math.min(...keptPlain.map((r) => r.createdAt)) === 1000040, String(Math.min(...keptPlain.map((r) => r.createdAt))));
  assert('最老那条收藏（第 0 条）仍在列表里', plan.keep.some((r) => r.id === 'w_bulk_0'), '收藏优先于时间');

  // 真接线：走一遍 save→list，确认 list() 用的就是这套策略，而不是各写一份
  const mode = L.backend();
  for (const r of bulk) await L.save(r);
  const listed = await L.list();
  assert('list() 返回 500 条（真跑写入路径）', listed.length === 500, 'backend=' + mode + ' · ' + listed.length + ' 条');
  const listedIds = new Set(listed.map((r) => r.id));
  const favMissing = bulk.filter((r) => r.favorite && !listedIds.has(r.id));
  const blobMissing = bulk.filter((r) => r.videoBlob && !listedIds.has(r.id));
  assert('真跑后收藏仍在列表里', favMissing.length === 0, favMissing.length + ' 条丢');
  assert('真跑后带视频的仍在列表里', blobMissing.length === 0, blobMissing.length + ' 条丢');
  let desc = true;
  for (let i = 1; i < listed.length; i++) if ((listed[i - 1].createdAt || 0) < (listed[i].createdAt || 0)) desc = false;
  assert('list() 结果 createdAt 倒序', desc);
}

/* ═════════════ 四、save / update / remove / clear 的真实行为 ═════════════ */
group('写入路径：无底层时的行为按约定');

if (L) {
  const mode = L.backend();
  console.log('  当前后端：' + mode + (mode === 'memory' ? '（Node 无 IndexedDB/localStorage，落内存 Map）' : ''));

  // 1) 非法入参必须 reject，且原因是中文
  const badRes = await L.save(null).then(() => ({ rejected: false }), (e) => ({ rejected: true, e }));
  assert('save(null) 被 reject', badRes.rejected, badRes.rejected ? '' : '竟然 resolve 了');
  assert('reject 原因是中文且带 code', badRes.rejected && /[\u4e00-\u9fa5]/.test(badRes.e.message) && !!badRes.e.code, badRes.rejected ? badRes.e.code + ' · ' + badRes.e.message : '');

  // 2) 正常保存：补 id / createdAt / sizeBytes
  const t0 = Date.now();
  const saved = await L.save({
    styleId: 'cinematic',
    styleLabel: '电影感',
    prompt: '雪夜里小木屋亮着灯',
    seed: 123456789,
    params: { aspect: '16:9', duration: 5 },
    source: 'local',
    poster: 'data:image/png;base64,AAA',
    durationMs: 6000,
  });
  assert('save() resolve 出记录', !!saved && typeof saved === 'object');
  assert('自动补 id（w_ + base36）', /^w_[0-9a-z]+$/.test(saved.id), saved.id);
  assert('自动补 createdAt（毫秒时间戳，接近现在）', typeof saved.createdAt === 'number' && Math.abs(saved.createdAt - t0) < 60000, String(saved.createdAt));
  assert('sizeBytes 补齐为数字（无 blob 时为 0）', saved.sizeBytes === 0, String(saved.sizeBytes));
  assert('seed 原样保留', saved.seed === 123456789, String(saved.seed));
  assert('params 原样保留', saved.params.aspect === '16:9' && saved.params.duration === 5);
  assert('source 规范为 local', saved.source === 'local');

  const got = await L.get(saved.id);
  assert('get() 能读回刚存的记录', !!got && got.id === saved.id, got ? got.prompt : 'null');

  // 3) 超 40MB：不落 blob，标 videoOmitted，但保留原体积
  const big = { size: 41 * 1024 * 1024, type: 'video/webm', slice() { return this; } };
  const savedBig = await L.save({
    id: 'w_big_case', createdAt: 2000000000001, styleId: 'photo', prompt: '超大文件',
    videoBlob: big, poster: 'data:image/png;base64,AAA', durationMs: 30000,
  });
  assert('>40MB 时 videoBlob 被丢弃', savedBig.videoBlob === null, String(savedBig.videoBlob));
  assert('>40MB 时 videoOmitted = true', savedBig.videoOmitted === true);
  assert('>40MB 时 sizeBytes 仍记原体积', savedBig.sizeBytes === 41 * 1024 * 1024, String(savedBig.sizeBytes));

  // 4) 不超限：blob 留着
  const small = { size: 1024 * 1024, type: 'video/webm', slice() { return this; } };
  const savedSmall = await L.save({
    id: 'w_small_case', createdAt: 2000000000002, styleId: 'photo', prompt: '正常大小',
    videoBlob: small, poster: 'data:image/png;base64,AAA', durationMs: 5000,
  });
  assert('<=40MB 时 blob 保留', !!savedSmall.videoBlob && savedSmall.videoBlob.size === 1048576);
  assert('<=40MB 时 sizeBytes = blob.size', savedSmall.sizeBytes === 1048576, String(savedSmall.sizeBytes));
  assert('没有 poster 时兜底给占位图', /^data:image\/png;base64,/.test(savedSmall.poster));

  const head = await L.list();
  assert('list() 第一条是最新 createdAt', head.length > 0 && head[0].id === 'w_small_case', head.length ? head[0].id : '空');

  // 5) 同 id 覆盖，不产生两条
  const dup = await L.save({ id: 'w_small_case', createdAt: 2000000000002, styleId: 'photo', prompt: '改名了', poster: 'data:image/png;base64,AAA' });
  const afterDup = await L.list();
  assert('同 id 覆盖（不起第二条）', afterDup.filter((r) => r.id === dup.id).length === 1, String(afterDup.filter((r) => r.id === dup.id).length));
  assert('覆盖后内容是新的', (await L.get('w_small_case')).prompt === '改名了');

  // 6) update：patch 合并、params 一层合并、id/createdAt 不动
  const upd = await L.update('w_small_case', { note: '复用参数测试', params: { duration: 8 }, favorite: true });
  assert('update() 返回更新后的记录', !!upd && upd.note === '复用参数测试');
  assert('update 不改 id / createdAt', !!upd && upd.id === 'w_small_case' && upd.createdAt === 2000000000002, upd ? String(upd.createdAt) : 'null');
  assert('update 支持可选 favorite 字段', !!upd && upd.favorite === true);
  assert('update 不存在的 id → null', (await L.update('w_nope', { note: 'x' })) === null);

  // 7) 参数合并的正面用例
  await L.save({ id: 'w_merge', createdAt: 2000000000003, styleId: 'cinematic', params: { aspect: '9:16', duration: 5 }, poster: 'data:image/png;base64,AAA' });
  const merged = await L.update('w_merge', { params: { duration: 8 } });
  assert('params 合并后 aspect 还在、duration 被改', merged.params.aspect === '9:16' && merged.params.duration === 8, JSON.stringify(merged.params));

  // 8) remove
  assert('remove() 存在的记录 → true', (await L.remove('w_merge')) === true);
  assert('remove() 之后 get → null', (await L.get('w_merge')) === null);
  assert('remove() 不存在的记录 → false', (await L.remove('w_merge')) === false);

  // 9) 底层坏了也不 throw
  let listThrew = false;
  let listRes = null;
  try { listRes = await L.list(); } catch (e) { listThrew = true; }
  assert('list() 永不 throw', !listThrew && Array.isArray(listRes), Array.isArray(listRes) ? listRes.length + ' 条' : '非数组');
  assert('get(垃圾入参) → null', (await L.get('')) === null && (await L.get({})) === null);

  // 10) download 在 Node 无 document → {ok:false, method:'none'}，不炸
  let dl = null;
  let dlThrew = false;
  try { dl = await L.download({ id: 'x', createdAt: 1 }); } catch (e) { dlThrew = true; }
  assert('download() 在 Node 不 throw', !dlThrew);
  assert('download() 无 document 时 ok=false / method=none', !!dl && dl.ok === false && dl.method === 'none', dl ? JSON.stringify({ ok: dl.ok, method: dl.method }) : 'null');
  const dlNull = await L.download(null);
  assert('download(null) 也返回同一种结构', dlNull.ok === false && dlNull.method === 'none', JSON.stringify(dlNull));

  // 11) clear 收尾
  const cleared = await L.clear();
  const afterClear = await L.list();
  assert('clear() → true 且列表清空', cleared === true && afterClear.length === 0, 'cleared=' + cleared + ' · 剩 ' + afterClear.length + ' 条');
}

/* ═════════════ 五、源码静态检查 ═════════════ */
group('静态：零依赖 / 无外链 / UMD');

if (fs.existsSync(SRC_PATH)) {
  const SRC = fs.readFileSync(SRC_PATH, 'utf8');
  const bytes = Buffer.byteLength(SRC);
  console.log('  源码 ' + (bytes / 1024).toFixed(1) + 'KB · ' + SRC.split('\n').length + ' 行');

  assert("无 fetch('http 这类硬编码请求", !/fetch\s*\(\s*['"]http/.test(SRC));
  assert('无 http:// 字面量', SRC.indexOf('http://') < 0, SRC.indexOf('http://') < 0 ? '' : '第 ' + (SRC.slice(0, SRC.indexOf('http://')).split('\n').length) + ' 行');
  assert('无 https:// 字面量', SRC.indexOf('https://') < 0);
  assert('无 ESM import', !/(^|\n)\s*import\s/.test(SRC));
  assert('无 require() 调用', !/\brequire\s*\(/.test(SRC));
  assert('无 node:/npm: 内置或外部模块引用', !/\b(node|npm):/.test(SRC));
  assert('无 node_modules / package.json 依赖痕迹', !/node_modules|package\.json/.test(SRC));
  assert('UMD 双出口齐全', SRC.indexOf('root.AVPW_LIBRARY = api') >= 0 && SRC.indexOf('module.exports = api') >= 0);
  assert('模块加载期不碰 window/document', !/(^|\n)\s*(window|document)\s*\./.test(SRC));
  assert('UTF-8 完好（无替换字符）', SRC.indexOf('\uFFFD') < 0);
  assert('契约常量写死在源码里', ['avp-wizard', 'avp.wizard.works.v1'].every((k) => SRC.indexOf(k) >= 0));
  assert('store / 索引 / keyPath 名对得上', SRC.indexOf("'works'") >= 0 && SRC.indexOf("'createdAt'") >= 0 && SRC.indexOf("'id'") >= 0);
  assert('中文注释解释"为什么"（不是只写"做了什么"）', (SRC.match(/为什么/g) || []).length >= 3, (SRC.match(/为什么/g) || []).length + ' 处');
}

/* ═════════════ 收尾 ═════════════ */

if (fail) {
  console.log('\n未通过 · ' + fail + ' 项（共 ' + (pass + fail) + ' 项）');
  fails.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('\n全部通过 · ' + pass + ' 项');
process.exit(0);