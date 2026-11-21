/**
 * wizard/library.js —— 「小白模式」作品库（第五步：生成完的视频存哪儿、怎么再拿出来）
 *
 * 为什么要有这一层，而不是让界面直接开 IndexedDB：
 *   作品库有四种完全不同的"存法"——网页版走 IndexedDB（能直接存 Blob 成片）、
 *   `file://` 双击打开时 IndexedDB 可能整个不可用（退到 localStorage 只存元数据）、
 *   配额写满时再退到内存、Node 里跑自检时压根没有浏览器环境。
 *   把这四条路收在一个模块里，界面只认 save/list/get/update/remove/download 六个动词，
 *   不需要在每个按钮里各写一遍 `if (!indexedDB) ...`。能力差异由 isSupported() 如实上报。
 *
 * 三条设计约束（和 wizard/styles.js 一致）：
 *   1. **零依赖、零外部资源**：只用浏览器内置 API；Node 下 require 不崩（靠惰性探测 + 内存 Map）。
 *   2. **不静默吞错**：底层不可用时 list()/get() 老实返回空/null 不抛；save() 写不进去就 reject，
 *      中文原因带 code —— 调用方要能 toast 出"视频没存下"，而不是以为存成功了。
 *   3. **模块加载期不碰 window/document**：所有浏览器对象都在函数里现取，require 时一律安全。
 *
 * 用法：
 *   Node:   以 CommonJS 方式载入本文件（module.exports）  → 对象（save 落到内存 Map，便于自检）
 *   浏览器: window.AVPW_LIBRARY                     → 同一个对象
 *   构建器把本文件原样内联进 wizard/index.html（file:// 下不需要 fetch）。
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AVPW_LIBRARY = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  /* ═════════════ 一、常量：这几项是外部契约，改名会让老数据读不出来 ═════════════ */

  var DB_NAME = 'avp-wizard';
  var DB_VERSION = 1;
  var STORE_NAME = 'works';
  var KEY_PATH = 'id';
  var INDEX_NAME = 'createdAt';
  var LS_PREFIX = 'avp.wizard.works.v1'; // localStorage 降级时只存元数据数组，键前缀即键名
  var LS_KEY = LS_PREFIX;
  var LS_PROBE_KEY = LS_PREFIX + '.probe';

  // 40MB：一条 5 秒 720p 的 webm 一般 2~8MB，40MB 已经是"超长/超清"的量级。
  // 再大就不该往库里塞：浏览器给站的配额通常只有几百 MB，一条大文件能把整个库顶死。
  var MAX_BLOB_BYTES = 40 * 1024 * 1024;

  // 60KB 是缩略图 data URL 的经验红线：一条 320×200 的 PNG 大约 20~40KB，
  // 500 条全带 poster 就是十几 MB，localStorage 那 5MB 配额撑不住。
  var MAX_POSTER_CHARS = 60 * 1024;

  // 列表上限：DOM 挂 500 张卡已经卡了，再多的记录也看不见；超出的按下面 prune() 的规则淘汰。
  var MAX_LIST = 500;

  /* 没有 poster 时的兜底图：64×36 的内联渐变 + 播放三角（手搓 PNG，356 字节）。
   * 为什么不用 SVG data URL：SVG 的 xmlns 里带一段 URI 文本，静态检查（禁外链字面量）会误报；
   * 为什么不用空字符串：列表里 500 个灰块看着像坏了，宁可给一张"这里本该有缩略图"的暗色图。 */
  var PLACEHOLDER_POSTER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAYAAAA5DDySAAABK0lEQVR42uXQSU7CABgF4HcIEQotLZ1pmQrOsx7Ty7nzAF7gGUyqhkDTQt7qX3zrN+Bs4NMy9JyAlqHnTGgZzochLUN/FNEy9N2YlmHgJrQMjpfSMjjjjJZh6Oe0DCN/SsswCgoqfXx+vaszTgF3UlJpe8CWOudY8MIZleoDauq8ruCFcyrtHvB3hDa3LYyjBZUOHbClzm4DfrykUtMBNXWHJvCTFZXaHPB7hLjLPgiSikpdDqipO/2HIF1TqdNwcZd9MMk2VGozXN2hCcL8gkpNw9XZbSDML6l0eLw2ty1E0ysq7Q5X53WFuLimUj1cnXMsxOUNlX7GizNOgaS8pWVIZ3e0DOn8npYhWzzQMuSLR1qGfPlEyzBdPdMyFNULLUNRvdIylOs3WvYNFVjBoLkCG8kAAAAASUVORK5CYII=';

  /* ═════════════ 二、小工具 ═════════════ */

  function now() { return Date.now(); }

  function assign(target, src) {
    if (src && typeof src === 'object') {
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function msgOf(e) {
    if (!e) return '未知原因';
    if (e.message) return String(e.message);
    return String(e);
  }

  function err(message, code) {
    var e = new Error(message);
    e.code = code || 'LIBRARY_ERROR';
    return e;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  /** 作品 id：w_ + base36 时间戳 + 随机后缀（不用 crypto.randomUUID：file:// 属不安全上下文，部分浏览器不给） */
  function newId() {
    return 'w_' + now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** 只在环境不支持时记录，不进 console：Node 下每次调用都少一行噪音 */
  var last = null;
  function note(code, message) {
    last = { code: code, message: message, at: now() };
  }
  /** 真错误：记录 + 打一行中文警告，绝不静默吞掉 */
  function fail(code, message) {
    note(code, message);
    try { if (typeof console !== 'undefined' && console.warn) console.warn('[作品库] ' + message); } catch (e) { /* 控制台被禁也不影响主流程 */ }
  }

  function lastError() {
    return last ? { code: last.code, message: last.message, at: last.at } : null;
  }

  /** Blob 判定不写 instanceof Blob：自检要能用 {size, slice} 的假对象验证体积上限，不占 40MB 内存 */
  function isBlobLike(v) {
    return !!v && typeof v === 'object' && typeof v.size === 'number' && v.size >= 0 && typeof v.slice === 'function';
  }

  /* ═════════════ 三、能力探测（惰性，加载期不碰 window） ═════════════ */

  var probeCache = null;

  function idbFactory() {
    try {
      return (root && root.indexedDB) ? root.indexedDB : null;
    } catch (e) {
      return null; // 沙箱 iframe 里读 indexedDB 本身就可能抛
    }
  }

  function lsRaw() {
    try {
      return (root && root.localStorage) ? root.localStorage : null;
    } catch (e) {
      return null; // 隐私模式/被禁用时，访问 localStorage 这个属性就会抛 SecurityError
    }
  }

  /** 真写一次才算可用：某些环境 getItem 能读、setItem 直接抛（只读配额 / 被策略禁写） */
  function lsUsable() {
    var s = lsRaw();
    if (!s) return false;
    try {
      s.setItem(LS_PROBE_KEY, '1');
      s.removeItem(LS_PROBE_KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  function detect() {
    if (probeCache) return probeCache;
    var idb = false;
    var ls = false;
    try { idb = !!idbFactory(); } catch (e) { idb = false; }
    try { ls = lsUsable(); } catch (e) { ls = false; }
    probeCache = { indexeddb: idb, localstorage: ls };
    return probeCache;
  }

  /** 配额写爆后把这个能力位翻成 false：isSupported() 必须如实说"现在存不进 localStorage 了" */
  function disableLs() {
    var c = detect();
    c.localstorage = false;
  }

  function isSupported() {
    try {
      var c = detect();
      return { indexeddb: !!c.indexeddb, localstorage: !!c.localstorage };
    } catch (e) {
      return { indexeddb: false, localstorage: false };
    }
  }

  /** 当前实际会落到哪一层：界面据此提示"刷新会丢"或"视频本体没存" */
  function backend() {
    var c = detect();
    if (c.indexeddb) return 'indexeddb';
    if (c.localstorage) return 'localstorage';
    return 'memory';
  }

  /* ═════════════ 四、IndexedDB 层 ═════════════ */

  var dbPromise = null;

  /**
   * 打开库并建 store / 索引。
   * 约定：**永不 reject**，打不开就 resolve(null) 让上层降级 —— 界面不能因为浏览器不给库就白屏。
   * 打不开的原因（被别的标签页 blocked、被隐私策略拒、版本冲突）写进 lastError() 并打警告。
   */
  function openDb() {
    if (dbPromise) return dbPromise;
    var p = new Promise(function (resolve) {
      var f = idbFactory();
      if (!f) {
        note('NO_INDEXEDDB', '当前环境没有 IndexedDB（Node 或 file:// 沙箱），作品库退到 localStorage / 内存');
        return resolve(null);
      }
      var settled = false;
      function finish(db) {
        if (settled) {
          // 已经在 onblocked 里认输了，结果连接又成功了：立刻关掉，别留一个没人用的连接挡住别人升级
          if (db) { try { db.close(); } catch (e) { /* 忽略 */ } }
          return;
        }
        settled = true;
        resolve(db);
      }
      var req;
      try {
        req = f.open(DB_NAME, DB_VERSION);
      } catch (e) {
        fail('IDB_OPEN_THROW', '打开作品库失败：' + msgOf(e));
        return resolve(null);
      }
      // 只在 version 1 首次建库时进来；之后升级版本要在这里写迁移分支
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames || !db.objectStoreNames.contains(STORE_NAME)) {
          var os = db.createObjectStore(STORE_NAME, { keyPath: KEY_PATH });
          os.createIndex(INDEX_NAME, 'createdAt', { unique: false });
        }
      };
      req.onblocked = function () {
        // 另一个标签页还占着旧版本：宁可退回 localStorage，也不要让列表在这里转圈等死
        fail('IDB_BLOCKED', '作品库升级被另一个标签页占用，暂时退回 localStorage；关掉其它页面再刷新即可恢复');
        finish(null);
      };
      req.onerror = function () {
        fail('IDB_OPEN_FAILED', '打开作品库失败：' + (req.error && req.error.message ? req.error.message : '未知原因'));
        finish(null);
      };
      req.onsuccess = function () {
        var db = req.result;
        // 别的标签页要升级版本时主动让位，否则它那边会一直 blocked
        db.onversionchange = function () {
          try { db.close(); } catch (e) { /* 忽略 */ }
          dbPromise = null;
        };
        finish(db);
      };
    });
    dbPromise = p;
    // 开失败不缓存：用户可能刚关掉占用数据库的标签页，下次调用应该再试一次
    p.then(function (db) { if (!db && dbPromise === p) dbPromise = null; });
    return p;
  }

  function idbAll(db) {
    return new Promise(function (resolve) {
      var rows = [];
      var tx;
      try { tx = db.transaction(STORE_NAME, 'readonly'); }
      catch (e) { fail('IDB_TX_READ', '读作品库失败：' + msgOf(e)); return resolve(null); }
      var req;
      try { req = tx.objectStore(STORE_NAME).openCursor(); }
      catch (e) { fail('IDB_CURSOR', '读作品库失败：' + msgOf(e)); return resolve(null); }
      req.onsuccess = function () {
        var cur = req.result;
        if (!cur) return; // 游标走完，等 tx.oncomplete 收尾
        rows.push(cur.value);
        cur.continue();
      };
      req.onerror = function () { /* 交给 tx.onerror 统一报：这里再报一次就是重复噪音 */ };
      tx.oncomplete = function () { resolve(rows); };
      tx.onerror = function () {
        fail('IDB_READ_FAILED', '读作品库失败：' + (tx.error && tx.error.message ? tx.error.message : '未知原因'));
        resolve(null);
      };
      tx.onabort = function () { fail('IDB_READ_ABORT', '读作品库被浏览器中止'); resolve(null); };
    });
  }

  function idbGet(db, key) {
    return new Promise(function (resolve) {
      var tx;
      try { tx = db.transaction(STORE_NAME, 'readonly'); }
      catch (e) { fail('IDB_TX_GET', '读单条作品失败：' + msgOf(e)); return resolve(null); }
      var req;
      try { req = tx.objectStore(STORE_NAME).get(key); }
      catch (e) { fail('IDB_GET', '读单条作品失败：' + msgOf(e)); return resolve(null); }
      req.onsuccess = function () { resolve(req.result || null); };
      req.onerror = function () {
        fail('IDB_GET_FAILED', '读单条作品失败：' + (req.error && req.error.message ? req.error.message : '未知原因'));
        resolve(null);
      };
    });
  }

  /** 写单条：成功 resolve(record)，失败 reject（调用方要 toast） */
  function idbPut(db, record) {
    return new Promise(function (resolve, reject) {
      var tx;
      try { tx = db.transaction(STORE_NAME, 'readwrite'); }
      catch (e) { return reject(err('作品库写入失败：' + msgOf(e), 'IDB_TX_WRITE')); }
      tx.oncomplete = function () { resolve(record); };
      tx.onerror = function () {
        var e2 = tx.error;
        var detail = e2 ? ((e2.name || '') + ' ' + (e2.message || '')).trim() : '未知原因';
        if (e2 && e2.name === 'QuotaExceededError') {
          return reject(err('浏览器存储配额已满，这条作品没存下；删掉几条旧作品或换个更短的视频再试（' + detail + '）', 'IDB_QUOTA'));
        }
        reject(err('作品库写入失败：' + detail, 'IDB_WRITE_FAILED'));
      };
      tx.onabort = function () { reject(err('作品库写入被浏览器中止，这条作品没存下', 'IDB_WRITE_ABORT')); };
      try {
        tx.objectStore(STORE_NAME).put(record);
      } catch (e3) {
        return reject(err('作品库写入失败：' + msgOf(e3), 'IDB_PUT_THROW'));
      }
    });
  }

  /** 删单条：resolve(这条原本是否存在)。同一事务里先 get 再 delete，顺序由 IDB 保证 */
  function idbDelete(db, key) {
    return new Promise(function (resolve) {
      var existed = false;
      var tx;
      try { tx = db.transaction(STORE_NAME, 'readwrite'); }
      catch (e) { fail('IDB_TX_DEL', '删除作品失败：' + msgOf(e)); return resolve(false); }
      var store = tx.objectStore(STORE_NAME);
      var g;
      try { g = store.get(key); }
      catch (e2) { fail('IDB_DEL_GET', '删除作品失败：' + msgOf(e2)); return resolve(false); }
      g.onsuccess = function () {
        existed = !!g.result;
        try { store.delete(key); } catch (e3) { fail('IDB_DEL', '删除作品失败：' + msgOf(e3)); }
      };
      g.onerror = function () { fail('IDB_DEL_FAILED', '删除作品失败：读不到这条记录'); };
      tx.oncomplete = function () { resolve(existed); };
      tx.onerror = function () { fail('IDB_DEL_TX', '删除作品失败：' + (tx.error && tx.error.message ? tx.error.message : '未知原因')); resolve(false); };
      tx.onabort = function () { resolve(false); };
    });
  }

  function idbClearAll(db) {
    return new Promise(function (resolve) {
      var tx;
      try { tx = db.transaction(STORE_NAME, 'readwrite'); }
      catch (e) { fail('IDB_TX_CLEAR', '清空作品库失败：' + msgOf(e)); return resolve(false); }
      tx.oncomplete = function () { resolve(true); };
      tx.onerror = function () { fail('IDB_CLEAR_FAILED', '清空作品库失败：' + (tx.error && tx.error.message ? tx.error.message : '未知原因')); resolve(false); };
      tx.onabort = function () { resolve(false); };
      try { tx.objectStore(STORE_NAME).clear(); }
      catch (e2) { fail('IDB_CLEAR_THROW', '清空作品库失败：' + msgOf(e2)); resolve(false); }
    });
  }

  /* ═════════════ 五、localStorage 降级层（只存元数据） ═════════════ */

  /** 把记录压成"能在 5MB 里活下去"的形状：去掉 Blob、超宽缩略图砍成 null */
  function stripForLs(rec) {
    var meta = assign({}, rec);
    meta.videoBlob = null;
    // 主动标一下"本体没跟着来"，免得界面把它当成"这条视频损坏了"
    if (rec.videoBlob) meta.blobStripped = true;
    if (typeof meta.poster === 'string' && meta.poster.length > MAX_POSTER_CHARS) meta.poster = null;
    return meta;
  }

  function lsReadAll() {
    var s = lsRaw();
    if (!s) return [];
    try {
      var raw = s.getItem(LS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      var out = [];
      for (var i = 0; i < arr.length; i++) if (arr[i] && typeof arr[i] === 'object') out.push(arr[i]);
      return out;
    } catch (e) {
      // 存储被外部写坏（半截 JSON / 别的版本改了格式）：当空库处理，不阻断启动
      fail('LS_READ_FAILED', 'localStorage 里的作品索引读不出来，按空库处理：' + msgOf(e));
      return [];
    }
  }

  function lsWriteAll(arr) {
    var s = lsRaw();
    if (!s) throw err('localStorage 不可用，作品索引没写进去', 'LS_UNAVAILABLE');
    s.setItem(LS_KEY, JSON.stringify(arr)); // 配额爆了由调用方决定退到哪
  }

  function lsRemove(key) {
    var arr = lsReadAll();
    var next = [];
    var existed = false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === key) existed = true;
      else next.push(arr[i]);
    }
    if (!existed) return false;
    try {
      lsWriteAll(next);
    } catch (e) {
      disableLs(); // 写不动了：能力位翻 false，让 isSupported() 说实话
    }
    return true;
  }

  function lsClear() {
    var s = lsRaw();
    if (!s) return true; // 没有 localStorage 时"清空"本来就是空的
    try {
      s.removeItem(LS_KEY);
      return true;
    } catch (e) {
      fail('LS_CLEAR_FAILED', '清空 localStorage 作品索引失败：' + msgOf(e));
      return false;
    }
  }

  /* ═════════════ 六、内存层（最后一档，刷新即丢） ═════════════ */

  var mem = new Map();

  function memAll() {
    var out = [];
    mem.forEach(function (v) { out.push(v); });
    return out;
  }

  /** 内存档也按同一个上限裁剪：一直往内存里塞是另一种泄漏 */
  function trimMemory() {
    if (mem.size <= MAX_LIST) return;
    var kept = prune(memAll(), MAX_LIST).keep;
    mem.clear();
    for (var i = 0; i < kept.length; i++) mem.set(kept[i].id, kept[i]);
  }

  /* ═════════════ 七、纯函数：淘汰 + 摘要（独立出来就是为了自检能直接打） ═════════════ */

  function hasVideoBody(r) {
    if (!r) return false;
    if (r.videoBlob) return true;
    if (r.videoUrl) return true; // 后端任务只有地址，那条片子同样不该被轻易淘汰
    return false;
  }

  /**
   * "这条有多舍不得删"：分数越高越优先保留。
   *   收藏 +4       —— 用户亲手标的，是最高优先级（比"有片"还硬）
   *   有视频 +2     —— 参数还在、片子还能看，删了最心疼
   *   videoOmitted -2 —— 本来就只剩参数，属于最便宜的一档
   * 同分时按 createdAt 老的先走。
   */
  function keepScore(r) {
    var s = 0;
    if (r && r.favorite) s += 4;
    if (hasVideoBody(r)) s += 2;
    if (r && r.videoOmitted) s -= 2;
    return s;
  }

  /**
   * 上限保护（纯函数，不改入参）：
   *   输入任意记录数组 → 输出 { keep, dropped, limit, over }。
   *   keep 已按 createdAt 倒序，可直接渲染；dropped 按"最该先删"排好，便于界面提示"淘汰了 20 条"。
   * 说明：收藏多过 limit 时收藏也会被删——没有别的办法，上限就是上限。
   */
  function prune(records, limit) {
    var max = Number(limit) > 0 ? Math.floor(Number(limit)) : MAX_LIST;
    var arr = Array.isArray(records) ? records.slice() : [];
    var sorted = arr.sort(function (a, b) {
      return (Number(b && b.createdAt) || 0) - (Number(a && a.createdAt) || 0);
    });
    if (sorted.length <= max) return { keep: sorted, dropped: [], limit: max, over: 0 };

    var rank = sorted.slice().sort(function (a, b) {
      var d = keepScore(a) - keepScore(b);
      if (d) return d; // 分数低的先删
      return (Number(a && a.createdAt) || 0) - (Number(b && b.createdAt) || 0); // 同龄里面老的先删
    });
    var over = sorted.length - max;
    var dropSet = new Set();
    for (var i = 0; i < over; i++) dropSet.add(rank[i]);
    var keep = [];
    for (var j = 0; j < sorted.length; j++) if (!dropSet.has(sorted[j])) keep.push(sorted[j]);
    return { keep: keep, dropped: rank.slice(0, over), limit: max, over: over };
  }

  /**
   * 列表头部统计（纯函数，不读时钟也不碰存储）：
   *   totalBytes 用记录里的 sizeBytes（videoOmitted 时那是"原体积"），别拿 blob.size 现算，
   *   否则降级后的记录会显示 0MB，用户会以为东西丢了。
   */
  function summary(records) {
    var arr = Array.isArray(records) ? records : [];
    var count = 0;
    var totalBytes = 0;
    var lastAt = null;
    var styles = {};
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!r || typeof r !== 'object') continue;
      count++;
      var b = Number(r.sizeBytes);
      if (isFinite(b) && b > 0) totalBytes += b;
      var t = Number(r.createdAt);
      if (isFinite(t) && t > 0 && (lastAt === null || t > lastAt)) lastAt = t;
      var sid = r.styleId ? String(r.styleId) : 'unknown';
      styles[sid] = (styles[sid] || 0) + 1;
    }
    return { count: count, totalBytes: totalBytes, lastAt: lastAt, styles: styles };
  }

  /* ═════════════ 八、记录整形 ═════════════ */

  /**
   * 补齐 id/createdAt/sizeBytes，并在这里就把"超体积不存 blob"的规矩执行掉。
   * 为什么整形集中在保存入口：调用方（第五步向导）刚生成完，字段是拼出来的，
   * 少一个 sizeBytes 列表就显示"0 B"，少一个 poster 列表就是一格灰块。
   */
  function normalizeRecord(input) {
    if (!input || typeof input !== 'object') {
      throw err('作品记录为空，保存需要一个对象', 'NO_RECORD');
    }
    var r = input;
    var out = assign({}, r); // 浅拷贝：调用方的字段一个不丢（favorite 之类可选字段也照原样留着）

    out.id = r.id ? String(r.id) : newId();
    var t = Number(r.createdAt);
    out.createdAt = (isFinite(t) && t > 0) ? Math.floor(t) : now();
    out.styleId = r.styleId == null ? '' : String(r.styleId);
    out.styleLabel = r.styleLabel == null ? (out.styleId || '作品') : String(r.styleLabel);
    out.prompt = r.prompt == null ? '' : String(r.prompt);

    // seed 允许 0，所以不能写 Number(r.seed) || null
    var sd = r.seed;
    out.seed = (sd === undefined || sd === null || sd === '') ? null : (isFinite(Number(sd)) ? Number(sd) : null);

    out.params = (r.params && typeof r.params === 'object') ? r.params : {};
    out.source = r.source === 'backend' ? 'backend' : 'local';
    out.jobId = r.jobId == null ? null : r.jobId;
    out.videoUrl = (typeof r.videoUrl === 'string' && r.videoUrl) ? r.videoUrl : null;
    out.poster = (typeof r.poster === 'string' && r.poster) ? r.poster : PLACEHOLDER_POSTER;
    out.durationMs = isFinite(Number(r.durationMs)) ? Number(r.durationMs) : 0;
    out.videoOmitted = !!r.videoOmitted;
    out.note = r.note == null ? '' : String(r.note);

    var blob = isBlobLike(r.videoBlob) ? r.videoBlob : null;
    var blobSize = blob ? (Number(blob.size) || 0) : 0;
    var givenSize = isFinite(Number(r.sizeBytes)) ? Number(r.sizeBytes) : 0;

    if (blob && blobSize > MAX_BLOB_BYTES) {
      // 超过 40MB：只留参数 + 缩略图，把原体积记在 sizeBytes 里，
      // 用户至少知道"这条本来有多大"，而不是看到 0 B 以为是空文件
      out.videoBlob = null;
      out.videoOmitted = true;
      out.sizeBytes = blobSize;
    } else {
      out.videoBlob = blob;
      out.sizeBytes = blob ? blobSize : givenSize;
    }
    return out;
  }

  /* ═════════════ 九、读路径 ═════════════ */

  /** LS 与内存合并：同一 id 以内存为准（内存里那份更新、且可能还带着 blob） */
  function mergeRows(base, extra) {
    if (!extra.length) return base;
    if (!base.length) return extra;
    var byId = new Map();
    for (var i = 0; i < base.length; i++) if (base[i] && base[i].id) byId.set(base[i].id, base[i]);
    for (var j = 0; j < extra.length; j++) if (extra[j] && extra[j].id) byId.set(extra[j].id, extra[j]);
    var out = [];
    byId.forEach(function (v) { out.push(v); });
    return out;
  }

  function fallbackReadAll() {
    return mergeRows(lsReadAll(), memAll());
  }

  function fallbackGet(key) {
    if (mem.has(key)) return mem.get(key); // 内存里那份最新
    var ls = lsReadAll();
    for (var i = 0; i < ls.length; i++) if (ls[i] && ls[i].id === key) return ls[i];
    return null;
  }

  /** 底层怎么坏都返回数组，绝不 throw：界面拿到空列表只需要显示"还没有作品" */
  function readAll() {
    return openDb().then(function (db) {
      if (!db) return fallbackReadAll();
      return idbAll(db).then(function (rows) {
        if (rows) return mergeRows(rows, memAll());
        return fallbackReadAll(); // IDB 读坏：退一层，别让整个列表变白
      });
    }).catch(function (e) {
      fail('READ_FAILED', '读作品库失败：' + msgOf(e));
      return fallbackReadAll();
    });
  }

  /** 列表：createdAt 倒序，默认最多 500 条（opts.limit 可临时放宽，给"导出全部"之类用） */
  function list(opts) {
    var limit = (opts && Number(opts.limit) > 0) ? Math.floor(Number(opts.limit)) : MAX_LIST;
    return readAll().then(function (rows) {
      return prune(rows, limit).keep;
    }).catch(function () { return []; });
  }

  function get(id) {
    var key = (id === undefined || id === null) ? '' : String(id);
    if (!key) return Promise.resolve(null);
    return openDb().then(function (db) {
      if (!db) return fallbackGet(key);
      return idbGet(db, key).then(function (rec) {
        return rec || fallbackGet(key); // IDB 里没有：可能是降级期存进 localStorage / 内存的
      });
    }).catch(function (e) {
      note('GET_FAILED', '读作品失败：' + msgOf(e));
      return null;
    });
  }

  /* ═════════════ 十、写路径 ═════════════ */

  /** localStorage 档：只写元数据；配额爆了先砍 poster 再试，还不行就退内存 */
  function saveLocal(rec) {
    var c = detect();
    var s = c.localstorage ? lsRaw() : null;
    if (!s) {
      note('NO_LOCALSTORAGE', 'localStorage 不可用（file:// 或隐私模式），作品只存在内存里，刷新即丢');
      return saveMemory(rec);
    }
    var arr = lsReadAll();
    var meta = stripForLs(rec);
    var replaced = false;
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id === meta.id) { arr[i] = meta; replaced = true; break; }
    }
    if (!replaced) arr.push(meta);
    var keep = prune(arr, MAX_LIST).keep; // 写的时候就裁，别让索引无限长

    try {
      lsWriteAll(keep);
      return Promise.resolve(rec);
    } catch (e) {
      // 降级一：海报全砍掉再写一次。缩略图是装饰，参数和记录才是本体。
      var slim = [];
      for (var j = 0; j < keep.length; j++) {
        var c2 = assign({}, keep[j]);
        c2.poster = null;
        slim.push(c2);
      }
      try {
        lsWriteAll(slim);
        return Promise.resolve(rec);
      } catch (e2) {
        // 降级二：配额真的不够了 → 内存 Map，并把 localstorage 能力位翻 false（isSupported 说实话）
        disableLs();
        fail('LS_QUOTA', 'localStorage 写入失败（配额已满），这条作品只存在内存里，刷新即丢：' + msgOf(e2));
        return saveMemory(rec);
      }
    }
  }

  function saveMemory(rec) {
    mem.set(rec.id, assign({}, rec));
    trimMemory();
    return Promise.resolve(rec);
  }

  /**
   * 保存一条作品：自动补 id/createdAt/sizeBytes，同 id 覆盖。
   * 注意是**整条覆盖**（IDB 的 put 语义）：只传了半条记录就把视频本体冲掉了。
   * 想改一两个字段（改备注、标记收藏）请用 update()，它会合并。
   * 成功 resolve(整形后的记录)；真写不进去 reject（带中文 message + code），调用方 toast。
   */
  function save(record) {
    var rec;
    try {
      rec = normalizeRecord(record);
    } catch (e) {
      return Promise.reject(e);
    }

    var layer = backend();
    if (layer === 'indexeddb') {
      return openDb().then(function (db) {
        // 库开着但这次打不开（blocked/被拒）：退到 localStorage，别让用户点了保存却没反应
        if (!db) return saveLocal(rec);
        return idbPut(db, rec).catch(function (e) {
          fail(e.code || 'SAVE_FAILED', e.message);
          throw e; // 按约定上抛：调用方要能提示"没存下"
        });
      }).catch(function (e) {
        // 只有 IDB 写失败会走到这（openDb 自己不 reject）
        if (e && e.code) throw e;
        throw err('作品保存失败：' + msgOf(e), 'SAVE_FAILED');
      });
    }
    if (layer === 'localstorage') return saveLocal(rec);
    note('MEMORY_ONLY', '没有可用的持久化层，作品只存在内存里，刷新即丢');
    return saveMemory(rec);
  }

  function update(id, patch) {
    var key = (id === undefined || id === null) ? '' : String(id);
    if (!key) return Promise.resolve(null);
    return get(key).then(function (cur) {
      if (!cur) return null;
      var next = assign({}, cur);
      if (patch && typeof patch === 'object') {
        for (var k in patch) {
          if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
          if (k === 'params' && patch.params && typeof patch.params === 'object') {
            // 参数走一层合并：界面只改一个时长，不该把宽高比/档位一起抹掉
            next.params = assign(assign({}, cur.params || {}), patch.params);
          } else {
            next[k] = patch[k];
          }
        }
      }
      next.id = cur.id;               // id 是主键，不许改
      next.createdAt = cur.createdAt; // 时间线不动，否则列表顺序会莫名跳一下
      return save(next);
    }).catch(function (e) {
      if (e && e.code) throw e; // 写失败照旧上抛
      note('UPDATE_FAILED', '更新作品失败：' + msgOf(e));
      return null;
    });
  }

  function remove(id) {
    var key = (id === undefined || id === null) ? '' : String(id);
    if (!key) return Promise.resolve(false);
    var memHad = mem.has(key);
    var pIdb = openDb().then(function (db) {
      return db ? idbDelete(db, key) : false;
    }).catch(function () { return false; });
    var pLs = Promise.resolve(lsRemove(key));
    var pMem = Promise.resolve(memHad);
    if (memHad) mem.delete(key);
    return Promise.all([pIdb, pLs, pMem]).then(function (r) {
      return !!(r[0] || r[1] || r[2]);
    });
  }

  function clear() {
    var pIdb = openDb().then(function (db) {
      return db ? idbClearAll(db) : true; // 本来就没有库 = 已经清干净了
    }).catch(function () { return false; });
    var pLs = Promise.resolve(lsClear());
    mem.clear();
    return Promise.all([pIdb, pLs]).then(function (r) {
      // 清空后空间可能回来了：重探一次能力位，别让用户一直停在"存不进 localStorage"的降级态
      if (probeCache) {
        try { probeCache.localstorage = lsUsable(); } catch (e) { /* 探不到就保持原样 */ }
      }
      return r[0] !== false && r[1] !== false;
    });
  }

  /* ═════════════ 十一、下载（唯一依赖 document 的部分） ═════════════ */

  function safeName(name) {
    var s = String(name === undefined || name === null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\u0000-\u001f]/g, '')
      .trim();
    if (!s) s = '作品';
    return s.length > 120 ? s.slice(0, 120) : s;
  }

  function extOf(rec, blob) {
    var type = (blob && blob.type) ? String(blob.type) : '';
    if (/mp4/.test(type)) return 'mp4';
    if (/webm/.test(type)) return 'webm';
    if (rec && typeof rec.videoUrl === 'string') {
      var m = /\.([A-Za-z0-9]{2,5})(?:[?#].*)?$/.exec(rec.videoUrl);
      if (m) return m[1].toLowerCase();
    }
    return 'webm'; // 本地引擎出来的就是 webm，没线索时按最常见的猜
  }

  function defaultName(rec) {
    var t = Number(rec && rec.createdAt);
    var d = new Date(isFinite(t) && t > 0 ? t : now());
    var stamp = '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate())
      + '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
    var label = (rec && (rec.styleLabel || rec.styleId)) || '';
    // label 本身就是"作品"时不再重复一遍（否则会得到 作品-作品-20231115.webm）
    var mid = (label && label !== '作品') ? '-' + label : '';
    return safeName('作品' + mid + '-' + stamp + '.' + extOf(rec, rec && rec.videoBlob));
  }

  function triggerDownload(doc, href, name) {
    var a = doc.createElement('a');
    a.href = href;
    a.download = name;
    a.rel = 'noopener';
    a.style.display = 'none';
    var host = doc.body || doc.documentElement;
    if (host && host.appendChild) host.appendChild(a);
    a.click();
    if (a.parentNode && a.parentNode.removeChild) a.parentNode.removeChild(a);
    return true;
  }

  function isSameOrigin(url) {
    var loc = root && root.location;
    if (!loc || !loc.protocol) return false;
    if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return false; // file:// 一律按跨域处理
    var abs;
    try {
      abs = new root.URL(url, loc.href);
    } catch (e) {
      return false;
    }
    var base = loc.origin || (loc.protocol + '//' + loc.host);
    return abs.origin === base;
  }

  /**
   * 下载一条作品：有 blob 直接造对象 URL；只有地址就同源 fetch 成 blob 再下，
   * fetch 失败（CORS / 401 / file:// ）退回 a[download] 直接指过去——
   * 能不能下由浏览器决定，但至少用户点得动，而不是我们在这里假装失败。
   */
  function download(record, filename) {
    return new Promise(function (resolve) {
      var rec = record || null;
      var doc = (root && root.document) ? root.document : null;
      var name = safeName(filename || (rec ? defaultName(rec) : '作品.webm'));
      if (!rec) {
        note('DOWNLOAD_NO_RECORD', '没有传入作品记录，无法下载');
        return resolve({ ok: false, method: 'none', filename: name });
      }
      if (!doc || typeof doc.createElement !== 'function') {
        note('DOWNLOAD_NO_DOCUMENT', '当前环境没有 document（Node），下载只能在浏览器里做');
        return resolve({ ok: false, method: 'none', filename: name, reason: '当前环境没有 document，下载只能在浏览器里做' });
      }

      if (isBlobLike(rec.videoBlob)) {
        var objUrl = null;
        try {
          objUrl = root.URL.createObjectURL(rec.videoBlob);
          triggerDownload(doc, objUrl, name);
        } catch (e) {
          if (objUrl) { try { root.URL.revokeObjectURL(objUrl); } catch (e2) { /* 忽略 */ } }
          return resolve({ ok: false, method: 'none', filename: name, reason: '浏览器拒绝生成本地下载链接：' + msgOf(e) });
        }
        // 4 秒后再 revoke：Chrome 已经开始接管下载流，立刻 revoke 偶发下到 0 字节
        setTimeout(function () {
          try { root.URL.revokeObjectURL(objUrl); } catch (e3) { /* 忽略 */ }
        }, 4000);
        return resolve({ ok: true, method: 'blob', filename: name });
      }

      if (rec.videoUrl) {
        var same = false;
        try { same = isSameOrigin(rec.videoUrl); } catch (e4) { same = false; }
        if (same && typeof root.fetch === 'function') {
          root.fetch(rec.videoUrl, { credentials: 'same-origin' }).then(function (res) {
            if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
            return res.blob();
          }).then(function (blob) {
            var u2 = root.URL.createObjectURL(blob);
            triggerDownload(doc, u2, name);
            setTimeout(function () {
              try { root.URL.revokeObjectURL(u2); } catch (e5) { /* 忽略 */ }
            }, 4000);
            resolve({ ok: true, method: 'blob', filename: name });
          }).catch(function () {
            // 兜底：让浏览器直接打开/另存这个地址（跨域时通常变成新标签预览）
            var ok2 = true;
            try { triggerDownload(doc, rec.videoUrl, name); } catch (e6) { ok2 = false; }
            resolve({ ok: ok2, method: 'url', filename: name, reason: ok2 ? '' : '浏览器拦截了这次下载' });
          });
          return;
        }
        var ok3 = true;
        try { triggerDownload(doc, rec.videoUrl, name); } catch (e7) { ok3 = false; }
        return resolve({ ok: ok3, method: 'url', filename: name, reason: ok3 ? '' : '浏览器拦截了这次下载' });
      }

      note('DOWNLOAD_NO_VIDEO', '这条作品没有视频本体（可能是超过 40MB 或降级存储），只能复用参数');
      resolve({ ok: false, method: 'none', filename: name, reason: '这条作品没有视频本体（可能超过 40MB 或降级存储），只能复用参数' });
    });
  }

  /* ═════════════ 十二、对外 API（调用方按这份契约写的，别改名） ═════════════ */

  return {
    /* 契约常量 */
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_NAME: STORE_NAME,
    KEY_PATH: KEY_PATH,
    INDEX_NAME: INDEX_NAME,
    LS_PREFIX: LS_PREFIX,
    MAX_BLOB_BYTES: MAX_BLOB_BYTES,
    MAX_POSTER_CHARS: MAX_POSTER_CHARS,
    MAX_LIST: MAX_LIST,
    PLACEHOLDER_POSTER: PLACEHOLDER_POSTER,

    /* 十个动词 */
    isSupported: isSupported,
    open: openDb,
    save: save,
    list: list,
    get: get,
    update: update,
    remove: remove,
    clear: clear,
    download: download,
    summary: summary,

    /* 便于自检/界面判断的纯函数与调试口 */
    prune: prune,
    normalize: normalizeRecord,
    newId: newId,
    backend: backend,
    lastError: lastError,
  };
});