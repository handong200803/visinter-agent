/**
 * market/store.js —— 本地模板仓库（纯文件系统，绝不联网）
 *
 * 为什么自己写一个"仓库"而不是直接扫目录：
 *   市场列表要按"安装量 + 评分"排序、要按 标签/板块/价格 过滤，这些都需要一份索引；
 *   每次 list 都全量 JSON.parse 所有 .avptpl 在模板过百时会明显卡（每个 3–6KB），
 *   所以索引单独落 market/store/index.json，模板正文按版本落盘。
 *
 * 目录布局（版本目录，卡⑦）：
 *   market/store/tpl/<id>/<version>.avptpl     每个版本一份正文，永不互相覆盖
 *   market/store/tpl/<id>.avptpl               旧版扁平布局：读到就自动搬进版本目录（迁移，不丢文件）
 *   索引里的 item.file 指向"当前激活版本"的正文，item.versions[] 列出全部版本。
 *
 * 一致性策略（本地单机场景够用）：
 *   - 索引原子写：先写 index.json.tmp 再 rename，崩溃时不会留下半截 JSON；
 *   - 正文也原子写：先写 <file>.tmp 再 rename，避免"写一半被 list 读到"；
 *   - 读取自愈（heal）：任何读操作都会剔除"正文已不在"的版本记录，条目连一个版本都不剩就整条剔除
 *     ——所以手删文件不会在列表里留幽灵条目，不需要用户记得跑 rebuild()；
 *   - rebuild()：索引丢了/坏了从 tpl/ 目录重扫，且**保留**旧索引里的安装量与评分（卡⑦要求）；
 *   - 所有写操作串行：Node 单线程 + 同步 fs，没有并发写窗口。
 *
 * 排序口径（写死在 rankScore，doc 与 license.md 同步）：
 *   rank = 安装量 + 2 × 平均分 + 0.5 × 评分数
 *   为什么平均分乘 2：一个 5 分作品和一个 0 分作品差 10 分,约等于 10 次安装；
 *   为什么评分数乘 0.5：1 个 5 分不如 50 个 4.8 分可信，给样本量一点权重但不至于碾压安装量。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pack = require('./pack.js');

const STORE_DIR = path.join(__dirname, 'store');
const INDEX_FILE = 'index.json';
const TPL_DIR = 'tpl';
const RANK_W = { installs: 1, avg: 2, count: 0.5 };

function nowISO() {
  return new Date().toISOString();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function defaultIndex() {
  return { schema: pack.IDX_SCHEMA, version: 1, updated: nowISO(), items: [] };
}

/* ───────── 路径与版本号 ───────── */

/** 版本目录：store/tpl/<id>/ */
function tplDir(dir, id) {
  return path.join(dir, TPL_DIR, id);
}

/** 版本正文：store/tpl/<id>/<version>.avptpl */
function tplPath(dir, id, version) {
  return path.join(tplDir(dir, id), version + '.avptpl');
}

/** 旧扁平布局：store/tpl/<id>.avptpl（只读兼容 + 迁移源） */
function legacyPath(dir, id) {
  return path.join(dir, TPL_DIR, id + '.avptpl');
}

/** 索引里存的是相对仓库根的 POSIX 路径（Windows 上 path.join 也认正斜杠，别混着写） */
function relTpl(id, version) {
  return TPL_DIR + '/' + id + '/' + version + '.avptpl';
}

function cmpVerDesc(a, b) {
  return -pack.cmpVer(a, b);
}

/* ───────── 原子写 ───────── */

function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readIndex(dir) {
  const f = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(f)) return defaultIndex();
  try {
    const idx = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(idx.items)) idx.items = [];
    return idx;
  } catch (e) {
    // 索引损坏不阻塞市场：重扫目录，退化成"没有安装量历史"的可用状态
    return defaultIndex();
  }
}

function writeIndex(dir, idx) {
  ensureDir(dir);
  idx.updated = nowISO();
  writeFileAtomic(path.join(dir, INDEX_FILE), JSON.stringify(idx, null, 2) + '\n');
}

function rankScore(it) {
  const r = it.rating || { avg: 0, count: 0 };
  return +(it.installs || 0) * RANK_W.installs + (r.avg || 0) * RANK_W.avg + (r.count || 0) * RANK_W.count;
}

/* 索引条目：只存列表页要用的字段，正文不进索引（索引要小到能整份缓存） */
function entryOf(tpl, dir, versions) {
  const active = versions.find((v) => v.version === tpl.version) || versions[0] || null;
  const file = active ? path.join(dir, active.file) : null;
  return {
    id: tpl.id,
    name: tpl.name,
    version: tpl.version,
    author: tpl.author,
    license: tpl.license,
    registry_version: tpl.registry_version,
    tags: tpl.tags || [],
    stage_focus: tpl.stage_focus || [],
    price_cny: tpl.pricing ? tpl.pricing.price_cny : 0,
    checksum: tpl.checksum,
    estimate_meta: tpl.estimate_meta || null,
    signed: !!(tpl.signature && tpl.signature.value),
    has_workflow: !!(tpl.workflow_ref && (tpl.workflow_ref.kind === 'registry-binds' || tpl.workflow)),
    workflow_kind: tpl.workflow_ref ? tpl.workflow_ref.kind || '' : '',
    workflow_nodes: (tpl.workflow_ref && tpl.workflow_ref.nodes) || 0,
    file: active ? active.file : null,
    size_bytes: file && fs.existsSync(file) ? fs.statSync(file).size : 0,
    versions: (versions || []).map((v) => ({ ...v, active: !!(active && v.version === active.version) })),
  };
}

function versionRecord(tpl, dir) {
  const file = path.join(dir, relTpl(tpl.id, tpl.version));
  return {
    version: tpl.version,
    checksum: tpl.checksum,
    file: relTpl(tpl.id, tpl.version),
    size_bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    signed: !!(tpl.signature && tpl.signature.value),
  };
}

/** 读一条正文（不存在返回 null，坏 JSON 返回 null——批量操作不能被一个坏包打断） */
function readTplFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * migrateLegacy —— 把旧扁平布局 store/tpl/<id>.avptpl 搬进版本目录
 * 为什么必须搬而不是删：老用户的仓库里文件就是唯一历史，直接删等于删他的安装。
 * @returns {object|null} 迁移后的模板对象
 */
function migrateLegacy(dir, id) {
  const legacy = legacyPath(dir, id);
  if (!fs.existsSync(legacy)) return null;
  const tpl = readTplFile(legacy);
  if (!tpl || !tpl.version) return null;
  const dest = tplPath(dir, id, tpl.version);
  if (!fs.existsSync(dest)) writeFileAtomic(dest, JSON.stringify(tpl, null, 2) + '\n');
  fs.unlinkSync(legacy);
  return tpl;
}

/**
 * healsItems —— 读取自愈：剔除正文已不存在的版本记录、条目
 * @returns {{items: object[], changed: boolean}}
 */
function healItems(dir, idx) {
  let changed = false;
  const items = [];
  for (const it of idx.items) {
    if (!it || !it.id) { changed = true; continue; }
    let versions = Array.isArray(it.versions) && it.versions.length
      ? it.versions.slice()
      : (it.file ? [{ version: it.version, checksum: it.checksum, file: String(it.file).replace(/\\/g, '/'), size_bytes: it.size_bytes || 0, signed: !!it.signed }] : []);
    const alive = versions.filter((v) => v && v.file && fs.existsSync(path.join(dir, v.file)));
    if (alive.length !== versions.length) changed = true;
    if (!alive.length) { changed = true; continue; }  // 一个版本都不剩 → 不留幽灵条目
    let item = it;
    const activeVersion = alive.some((v) => v.version === it.version) ? it.version : alive.slice().sort((a, b) => cmpVerDesc(a.version, b.version))[0].version;
    if (activeVersion !== it.version) {
      // 激活版本被删了：退到剩下的最高版本，并把条目字段按该版本正文重建
      const rec = alive.find((v) => v.version === activeVersion);
      const tpl = readTplFile(path.join(dir, rec.file));
      if (!tpl) { changed = true; continue; }
      const fresh = entryOf(tpl, dir, alive);
      item = { ...it, ...fresh, version: activeVersion };
      changed = true;
    } else if (!Array.isArray(it.versions) || it.versions.length !== alive.length) {
      item = { ...it, checksum: alive.find((v) => v.version === activeVersion).checksum, versions: alive };
    }
    item.versions = alive.map((v) => ({ ...v, active: v.version === activeVersion }));
    item.rank = +rankScore(item).toFixed(3);
    items.push(item);
  }
  return { items, changed };
}

/**
 * openStore —— 返回一个仓库句柄
 * @param {object} opts {dir, registry, verify:boolean}
 * 为什么允许换 dir：selftest 要在临时目录跑完整的 install/list/search 链路，
 * 不能污染用户真实的市场索引。
 */
function openStore(opts) {
  const o = opts || {};
  const dir = o.dir || STORE_DIR;
  const registry = o.registry || require('../spec/params.registry.json');

  /** load：读索引 + 自愈（ghost 条目在任何读路径上都看不见） */
  function load() {
    const idx = readIndex(dir);
    const h = healItems(dir, idx);
    if (h.changed) {
      idx.items = h.items;
      writeIndex(dir, idx); // 自愈即落盘：下次启动也不用再看幽灵
    }
    return { ...idx, items: h.items };
  }
  function save(idx) {
    writeIndex(dir, idx);
  }

  /**
   * install：路径或模板对象都能装；同版本同 checksum 重装视为再次安装（安装量 +1）
   * @param {object} opt {upgrade, force}
   * 版本规则（卡⑦）：
   *   - 新版本 / 同版本不同内容 → 必须显式 upgrade，否则 E_VERSION_CONFLICT
   *   - 老版本正文永不覆盖（版本目录布局保证），所以"装 v2 后还能回滚 v1"
   *   - 旧扁平布局遇到同 id 先迁移再写，安装量/评分不丢
   */
  function install(src, opt) {
    const x = opt || {};
    const tpl = typeof src === 'string' ? JSON.parse(fs.readFileSync(src, 'utf8')) : src;
    if (!tpl || !tpl.id) throw new Error('模板缺少 id，拒绝安装');

    const v = pack.verify(tpl, registry);
    if (!v.ok) {
      const code = 'E_INVALID_TEMPLATE:' + v.errors.map((e) => e.code).join(',');
      if (!x.force) {
        const e = new Error(code);
        e.errors = v.errors;
        throw e;
      }
    }

    const idx = load();
    // 旧扁平布局（tpl/<id>.avptpl）先搬进版本目录，再读一次索引：老用户的安装量与历史不能丢
    const migrated = migrateLegacy(dir, tpl.id);
    const idx2 = migrated ? load() : idx;
    const existing = idx2.items.find((it) => it.id === tpl.id);
    const versions = existing ? existing.versions.slice() : [];
    const rec = versions.find((r) => r.version === tpl.version);

    if (existing && !x.upgrade) {
      if (!rec) {
        const e = new Error('E_VERSION_CONFLICT: 已安装 ' + tpl.id + '@' + existing.version + '，新版本 ' + tpl.version + ' 需 --upgrade');
        e.conflict = { installed: existing.version, incoming: tpl.version };
        throw e;
      }
      if (rec.checksum !== tpl.checksum) {
        const e = new Error('E_VERSION_CONFLICT: ' + tpl.id + '@' + tpl.version + ' 内容变了（checksum 不同），需 --upgrade');
        e.conflict = { installed: tpl.version, incoming: tpl.version };
        throw e;
      }
    }

    const file = tplPath(dir, tpl.id, tpl.version);
    writeFileAtomic(file, JSON.stringify(tpl, null, 2) + '\n');

    const isReinstall = !!(rec && rec.checksum === tpl.checksum);
    const fresh = versionRecord(tpl, dir);
    const nextVersions = versions.filter((r) => r.version !== tpl.version).concat(fresh)
      .sort((a, b) => cmpVerDesc(a.version, b.version));

    const entry = entryOf(tpl, dir, nextVersions);
    const merged = {
      ...(existing || {}),
      ...entry,
      installs: (existing ? existing.installs || 0 : 0) + 1,
      rating: (existing && existing.rating) || { count: 0, sum: 0, avg: 0 },
      raters: (existing && existing.raters) || {},
      installed_at: (existing && existing.installed_at) || nowISO(),
      updated_at: nowISO(),
    };
    merged.rank = +rankScore(merged).toFixed(3);

    const items = idx2.items.filter((it) => it.id !== tpl.id).concat(merged);
    save({ ...idx2, items });
    return {
      ok: true, id: tpl.id, version: tpl.version, reinstall: isReinstall,
      installs: merged.installs, file, versions: merged.versions.length, verify: v,
    };
  }

  function list(opt) {
    const x = opt || {};
    const items = load().items.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0) || String(a.id).localeCompare(String(b.id)));
    return x.limit ? items.slice(0, x.limit) : items;
  }

  /**
   * search —— 过滤 + 排序都是纯内存操作（索引只有几十 KB，够快且不依赖任何索引库）
   * filter: {q, tag, tags[], stage, license, max_price, min_price, signed, sort, limit}
   */
  function search(filter) {
    const f = filter || {};
    const kw = (f.q || '').trim().toLowerCase();
    let out = list();

    if (kw) {
      out = out.filter((it) =>
        [it.id, it.name, it.author, (it.tags || []).join(' '), (it.stage_focus || []).join(' ')]
          .join(' ').toLowerCase().includes(kw));
    }
    if (f.tag) out = out.filter((it) => (it.tags || []).includes(f.tag));
    if (f.tags && f.tags.length) {
      // any：命中任一标签即可（模板标签本来就是多挂的，要求全中会搜不到东西）
      out = out.filter((it) => f.tags.some((t) => (it.tags || []).includes(t)));
    }
    if (f.stage) out = out.filter((it) => (it.stage_focus || []).includes(f.stage));
    if (f.license) out = out.filter((it) => it.license === f.license);
    if (typeof f.min_price === 'number') out = out.filter((it) => (it.price_cny || 0) >= f.min_price);
    if (typeof f.max_price === 'number') out = out.filter((it) => (it.price_cny || 0) <= f.max_price);
    if (f.signed === true) out = out.filter((it) => it.signed);

    const sort = f.sort || 'rank';
    if (sort === 'price') out.sort((a, b) => (a.price_cny || 0) - (b.price_cny || 0) || (b.rank || 0) - (a.rank || 0));
    else if (sort === 'new') out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    else if (sort === 'rating') out.sort((a, b) => ((b.rating || {}).avg || 0) - ((a.rating || {}).avg || 0) || (b.rank || 0) - (a.rank || 0));
    else out.sort((a, b) => (b.rank || 0) - (a.rank || 0) || String(a.id).localeCompare(String(b.id)));

    return f.limit ? out.slice(0, f.limit) : out;
  }

  /** get(id, {version})：不给 version 取当前激活版本，给了就取那个版本 */
  function get(id, opt) {
    const x = opt || {};
    const idx = load();
    const item = idx.items.find((it) => it.id === id);
    if (!item) {
      if (x.throwNotFound) throw new Error('E_NOT_INSTALLED: ' + id);
      return null;
    }
    const version = x.version || item.version;
    const rec = item.versions.find((v) => v.version === version);
    const rel = rec ? rec.file : item.file;
    const file = rel ? path.join(dir, rel) : null;
    const tpl = readTplFile(file);
    return { item, template: tpl, file, version, versions: item.versions, requested_version: version };
  }

  /** versionsOf：按版本号倒序列出，标出当前激活 */
  function versionsOf(id) {
    const g = get(id);
    if (!g) return null;
    return g.item.versions.slice().sort((a, b) => cmpVerDesc(a.version, b.version))
      .map((v) => ({ ...v, active: v.version === g.item.version }));
  }

  /**
   * rollback —— 切到指定版本（"回滚"只是把激活指针移回去，正文早就都在，不重下载不重打包）
   * 幂等：切到已经激活的版本返回 changed:false，不写盘。
   */
  function rollback(id, version) {
    if (!version) throw new Error('回滚需要目标版本号（用法：rollback <id> <version>）');
    const idx = load();
    const item = idx.items.find((it) => it.id === id);
    if (!item) throw new Error('E_NOT_INSTALLED: ' + id);
    const rec = item.versions.find((v) => v.version === version);
    if (!rec) throw new Error('E_VERSION_NOT_FOUND: ' + id + ' 没有版本 ' + version + '（已有 ' + item.versions.map((v) => v.version).join('/') + '）');
    if (item.version === version) {
      return { ok: true, id, from: version, to: version, changed: false, item };
    }
    const tpl = readTplFile(path.join(dir, rec.file));
    if (!tpl) throw new Error('E_TEMPLATE_FILE_MISSING: ' + rec.file);
    const fresh = entryOf(tpl, dir, item.versions);
    const next = {
      ...item, ...fresh,
      installs: item.installs || 0,
      rating: item.rating || { count: 0, sum: 0, avg: 0 },
      raters: item.raters || {},
      installed_at: item.installed_at || nowISO(),
      updated_at: nowISO(),
    };
    next.rank = +rankScore(next).toFixed(3);
    const items = idx.items.filter((it) => it.id !== id).concat(next);
    save({ ...idx, items });
    return { ok: true, id, from: item.version, to: version, changed: true, item: next, template: tpl };
  }

  /**
   * remove(id, {version?})
   * 不给 version：整条卸装（目录一起删）；给 version：只删那个版本，
   * 如果删的正是激活版本 → 激活指针退到剩下的最高版本；一个都不剩 → 整条移除。
   */
  function remove(id, opt) {
    const x = opt || {};
    const idx = load();
    const item = idx.items.find((it) => it.id === id);
    if (!item) return { removed: false, id };
    const target = x.version ? item.versions.find((v) => v.version === x.version) : null;
    if (x.version && !target) return { removed: false, id, reason: 'E_VERSION_NOT_FOUND' };

    const kill = target ? [target] : item.versions.slice();
    let fileDeleted = false;
    for (const rec of kill) {
      const f = path.join(dir, rec.file);
      if (fs.existsSync(f)) { fs.unlinkSync(f); fileDeleted = true; }
    }
    const left = item.versions.filter((v) => !kill.some((k) => k.version === v.version));
    const dirPath = tplDir(dir, id);
    if (!left.length) {
      if (fs.existsSync(dirPath)) { try { fs.rmdirSync(dirPath); } catch (_) { /* 目录非空就留着，不影响索引 */ } }
      const items = idx.items.filter((it) => it.id !== id);
      save({ ...idx, items });
      return { removed: true, id, fileDeleted, versions: 0, active: null };
    }
    // 还有版本剩下：激活指针若被删就走退版逻辑（读剩下最高的正文重建条目字段）
    const activeVersion = left.some((v) => v.version === item.version)
      ? item.version : left.slice().sort((a, b) => cmpVerDesc(a.version, b.version))[0].version;
    const tpl = readTplFile(path.join(dir, left.find((v) => v.version === activeVersion).file));
    let next = item;
    if (tpl) {
      next = { ...item, ...entryOf(tpl, dir, left) };
    }
    next.versions = left.map((v) => ({ ...v, active: v.version === activeVersion }));
    next.version = activeVersion;
    next.updated_at = nowISO();
    next.rank = +rankScore(next).toFixed(3);
    const items = idx.items.filter((it) => it.id !== id).concat(next);
    save({ ...idx, items });
    return { removed: true, id, fileDeleted, versions: left.length, active: activeVersion };
  }

  /**
   * rate —— 1–5 星。同一个 rater 只计最后一次（防自刷分，这是"可交易"的底线）
   * 评分不写回模板正文：模板是作者签名过的不可变对象，评分属于市场侧元数据。
   */
  function rate(id, score, opt) {
    const x = opt || {};
    const s = Math.max(1, Math.min(5, Math.round(Number(score) || 0)));
    const rater = x.rater || 'anonymous';
    const idx = load();
    const it = idx.items.find((v) => v.id === id);
    if (!it) throw new Error('E_NOT_INSTALLED: ' + id);
    it.rating = it.rating || { count: 0, sum: 0, avg: 0 };
    it.raters = it.raters || {};
    const prev = it.raters[rater];
    if (prev !== undefined) {
      it.rating.sum += s - prev; // 覆盖旧分，不按次累加
    } else {
      it.rating.count += 1;
      it.rating.sum += s;
    }
    it.raters[rater] = s;
    it.rating.avg = +(it.rating.sum / Math.max(1, it.rating.count)).toFixed(2);
    it.rank = +rankScore(it).toFixed(3);
    it.updated_at = nowISO();
    save(idx);
    return { ok: true, id, score: s, rating: it.rating, rank: it.rank };
  }

  /**
   * rebuild —— 索引丢了/坏了时从 tpl/ 目录重扫
   * 卡⑦的两条承诺：
   *   1) 保留安装量与评分（按 id 从旧索引继承，旧索引读不出来才归零）；
   *   2) 只有在盘上真有正文的 id 才进索引（删了文件不会有幽灵条目），并顺手把旧扁平布局迁进版本目录。
   */
  function rebuild(opt) {
    const x = opt || {};
    const previous = x.fromIndex === false ? defaultIndex() : (() => { try { return readIndex(dir); } catch (_) { return defaultIndex(); } })();
    const prevById = new Map((previous.items || []).filter((i) => i && i.id).map((i) => [i.id, i]));

    const d = path.join(dir, TPL_DIR);
    const discovered = new Map(); // id -> Map(version -> tpl)
    if (fs.existsSync(d)) {
      for (const name of fs.readdirSync(d)) {
        const abs = path.join(d, name);
        if (name.endsWith('.avptpl')) {
          // 旧扁平布局：读出来搬进版本目录（搬不动就仍在原地，但索引仍能引用它）
          const tpl = readTplFile(abs);
          if (!tpl || !tpl.version) continue;
          if (!discovered.has(tpl.id)) discovered.set(tpl.id, new Map());
          discovered.get(tpl.id).set(tpl.version, tpl);
          try {
            const dest = tplPath(dir, tpl.id, tpl.version);
            if (!fs.existsSync(dest)) writeFileAtomic(dest, JSON.stringify(tpl, null, 2) + '\n');
            fs.unlinkSync(abs);
          } catch (_) { /* 迁移失败不影响索引（下一轮再搬） */ }
          continue;
        }
        let stat = null;
        try { stat = fs.statSync(abs); } catch (_) { continue; }
        if (!stat.isDirectory()) continue;
        for (const f of fs.readdirSync(abs).filter((n) => n.endsWith('.avptpl'))) {
          const tpl = readTplFile(path.join(abs, f));
          if (!tpl) continue; // 坏文件跳过，不让一个坏包毁掉整个索引
          if (tpl.id !== name) continue; // 目录与 id 不一致：不猜，跳过（可在 doc 里手工修）
          if (!discovered.has(tpl.id)) discovered.set(tpl.id, new Map());
          discovered.get(tpl.id).set(tpl.version, tpl);
        }
      }
    }

    const idx = defaultIndex();
    for (const [id, byVersion] of discovered) {
      const prev = prevById.get(id) || {};
      const wanted = prev.version && byVersion.has(prev.version) ? prev.version : null;
      const versionsSorted = [...byVersion.keys()].sort(cmpVerDesc);
      const active = wanted || versionsSorted[0];
      const tpl = byVersion.get(active);
      const versions = versionsSorted.map((v) => ({ ...versionRecord(byVersion.get(v), dir), installed_at: prev.installed_at || nowISO() }));
      const entry = entryOf(tpl, dir, versions);
      const merged = {
        ...entry,
        installs: typeof prev.installs === 'number' ? prev.installs : 1,
        rating: prev.rating || { count: 0, sum: 0, avg: 0 },
        raters: prev.raters || {},
        installed_at: prev.installed_at || nowISO(),
        updated_at: nowISO(),
      };
      merged.versions = versions.map((v) => ({ ...v, active: v.version === active }));
      merged.rank = +rankScore(merged).toFixed(3);
      idx.items.push(merged);
    }
    idx.items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    save(idx);
    return x.detail ? { count: idx.items.length, items: idx.items, dropped: [...prevById.keys()].filter((id) => !discovered.has(id)) } : idx.items.length;
  }

  function stats() {
    const items = load().items;
    const paid = items.filter((i) => (i.price_cny || 0) > 0).length;
    return {
      dir,
      count: items.length,
      paid,
      free: items.length - paid,
      installs: items.reduce((s, i) => s + (i.installs || 0), 0),
      ratings: items.reduce((s, i) => s + ((i.rating && i.rating.count) || 0), 0),
      versions: items.reduce((s, i) => s + ((i.versions || []).length || 0), 0),
      updated: load().updated,
    };
  }

  return { dir, indexFile: path.join(dir, INDEX_FILE), install, list, search, get, versionsOf, rollback, remove, rate, rebuild, stats, rankScore };
}

module.exports = {
  openStore, STORE_DIR, RANK_W, rankScore, defaultIndex,
  tplDir, tplPath, legacyPath, relTpl, healItems, migrateLegacy,
};
