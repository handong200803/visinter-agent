/**
 * state.js —— 项目状态机 + 多项目本地存储（零依赖，浏览器 / Node 双端同一份）
 *
 * 为什么把状态写成「显式表」而不是一堆布尔标记：
 *   外壳对用户最重要的信息不是"按钮能不能点"，而是"这个项目走到哪一步、下一步允许做什么"。
 *   把 (当前状态, 动作) 做成白名单，(draft, export) 这种语义事故在数据层就被拒绝，
 *   UI 只负责读表渲染禁用态，不用在每个按钮里各写一遍 if。
 *
 * 为什么值的持久化和状态绑在一起：
 *   项目和参数是同一个东西的两面——只存参数不存状态，重开页面就退化成"草稿"；
 *   只存状态不存参数，状态就成了一句空话。两者同落一个 JSON，导入导出也只需一份文件。
 *
 * 为什么存储要分 full / slim / memory 三档：
 *   localStorage 在 file:// 下可能被禁用、配额只有 5MB、写满时 setItem 直接抛。
 *   外壳不能因为"存不进去"就白屏：先按全量写，失败就去历史精简重试，再失败就退到内存，
 *   每一档都如实告诉用户"刷新会丢什么"，而不是假装保存成功。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AVP_STATE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PROJECT_SCHEMA = 'ai-video-platform/project';
  const PROJECT_FORMAT = 1;
  const STORE_SCHEMA = 'ai-video-platform/shell.store';
  const STORE_KEY = 'avp.shell.store.v1';
  const PRESET_NAMES = { draft: '草稿', standard: '标准', cinematic: '电影级' };

  /* ───────────── 状态定义 ─────────────
   * tone 只喂 CSS 类名；id 才是落盘的那份契约，改名会让旧项目读不出来。 */
  const STATES = [
    { id: 'draft', name: '草稿', tone: 'dim', desc: '只有默认值或向导推荐值，参数还没被确认' },
    { id: 'configured', name: '已配置', tone: 'acc', desc: '参数确认并求解通过，可以排队渲染' },
    { id: 'rendering', name: '渲染中', tone: 'violet', desc: '任务已下发，等待产物回填' },
    { id: 'reviewing', name: '审片中', tone: 'warn', desc: '产物已生成，等人工验收' },
    { id: 'exported', name: '已导出', tone: 'ok', desc: '成片与清单已落地，本轮闭环' },
  ];

  /* ───────────── 动作表 ─────────────
   * from 是"合法来源"白名单。注意 export 的 from 只有 reviewing：
   * 草稿、已配置两个状态都没有产物，任何直达导出的路径都必须被拒。 */
  const ACTIONS = [
    {
      id: 'configure', label: '确认配置', from: ['draft', 'configured'], to: 'configured', guard: 'hasValues',
      why: '确认后参数才被视为定版；此前改动一律回草稿',
    },
    {
      id: 'render', label: '铸造画面', from: ['configured'], to: 'rendering', guard: 'vramOk',
      why: '显存红线状态不允许开渲，否则一开就 OOM',
    },
    {
      id: 'review', label: '进审片', from: ['rendering'], to: 'reviewing',
      why: '有产物才能验收',
    },
    {
      id: 'rework', label: '返工', from: ['reviewing'], to: 'configured',
      why: '审片不通过退回配置，历史里留一次返工记录',
    },
    {
      id: 'export', label: '导出成片', from: ['reviewing'], to: 'exported',
      why: '只有审片通过才能导出；草稿/已配置没有产物可导',
    },
    {
      id: 'fail', label: '渲染失败退回', from: ['rendering'], to: 'configured',
      why: '失败要能回到可改参数的状态，不能卡在渲染中',
    },
    {
      id: 'restart', label: '新起一轮', from: ['configured', 'rendering', 'reviewing', 'exported'], to: 'draft',
      why: '改参数或换版本后，配置需要重新确认',
    },
  ];

  const ACTION_MAP = Object.create(null);
  for (const a of ACTIONS) ACTION_MAP[a.id] = a;

  const STATE_MAP = Object.create(null);
  for (const s of STATES) STATE_MAP[s.id] = s;

  /* ───────────── 小工具 ───────────── */

  function nowISO() {
    return new Date().toISOString();
  }

  function newId() {
    // 不用 crypto.randomUUID：file:// 属于不安全上下文，部分浏览器不给。
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function stateName(id) {
    // 兼容旧数据：早期 history.from 存的是合法来源数组而不是单一状态
    if (Array.isArray(id)) id = id[0];
    return (STATE_MAP[id] && STATE_MAP[id].name) || String(id);
  }

  function stateDesc(id) {
    return (STATE_MAP[id] && STATE_MAP[id].desc) || '';
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  /* ───────────── 守卫 ─────────────
   * 守卫只回答"现在能不能做"，不负责改数据；返回结构统一 {ok, code, reason}。 */

  const GUARDS = {
    // 没有参数就谈不上"确认配置"：至少要有一把 key，且关键分辨率存在
    hasValues(project) {
      const v = project && project.values;
      if (!v || typeof v !== 'object' || !Object.keys(v).length) {
        return { ok: false, code: 'NO_VALUES', reason: '项目里没有参数值，先跑一次向导或载入默认值' };
      }
      if (v['kf.resolution'] === undefined) {
        return { ok: false, code: 'INCOMPLETE_VALUES', reason: '缺少关键帧分辨率（kf.resolution），参数集不完整' };
      }
      return { ok: true, code: 'OK', reason: '参数集完整' };
    },
    // 显存红线拦在开渲这一步：这是估算给得最硬的一条约束
    vramOk(project) {
      const s = project && project.summary;
      const st = s && s.vramState;
      if (st === 'block') {
        return { ok: false, code: 'VRAM_BLOCK', reason: '显存比超过 100%，先按降档建议改参数再开渲' };
      }
      return { ok: true, code: 'OK', reason: st ? '显存比在预算内（' + st + '）' : '未估算，按可渲染处理' };
    },
  };

  /* ───────────── 项目对象 ───────────── */

  function create(opts) {
    const o = opts || {};
    const now = nowISO();
    return {
      schema: PROJECT_SCHEMA,
      format: PROJECT_FORMAT,
      id: o.id || newId(),
      name: o.name || '未命名项目',
      state: STATE_MAP[o.state] ? o.state : 'draft',
      tier: PRESET_NAMES[o.tier] ? o.tier : 'standard',
      device: o.device || 'T0',
      usable_mib: Number(o.usable_mib) || 0,
      values: o.values && typeof o.values === 'object' ? clone(o.values) : {},
      // summary 只存状态栏要用的几个数，重算成本高，不必每次开机都跑一遍 engine
      summary: o.summary && typeof o.summary === 'object' ? clone(o.summary) : null,
      createdAt: o.createdAt || now,
      updatedAt: now,
      history: Array.isArray(o.history) ? clone(o.history) : [],
    };
  }

  /** 判断一个 (状态, 动作) 是否合法；不抛错，供 UI 批量渲染按钮禁用态 */
  function can(project, actionId) {
    const act = ACTION_MAP[actionId];
    if (!act) return { ok: false, code: 'UNKNOWN_ACTION', reason: '未知动作：' + actionId };
    if (!project || !project.state) return { ok: false, code: 'NO_PROJECT', reason: '没有当前项目' };
    if (!STATE_MAP[project.state]) return { ok: false, code: 'BAD_STATE', reason: '项目状态非法：' + project.state };
    if (act.from.indexOf(project.state) < 0) {
      return {
        ok: false,
        code: 'ILLEGAL_TRANSITION',
        action: act.id,
        from: project.state,
        reason: stateName(project.state) + ' 不允许「' + act.label + '」；合法来源：' + act.from.map(stateName).join(' / '),
      };
    }
    const guard = act.guard && GUARDS[act.guard];
    if (guard) {
      const g = guard(project);
      if (!g.ok) return { ok: false, code: g.code, action: act.id, from: project.state, reason: g.reason };
    }
    return {
      ok: true, code: 'OK', action: act.id, from: project.state, to: act.to,
      reason: stateName(project.state) + ' → ' + stateName(act.to),
    };
  }

  /** 执行动作：返回新对象（不改入参），非法时抛带 code 的错误 */
  function apply(project, actionId, meta) {
    const r = can(project, actionId);
    if (!r.ok) {
      const err = new Error(r.reason);
      err.code = r.code;
      err.action = actionId;
      err.state = project && project.state;
      throw err;
    }
    const act = ACTION_MAP[actionId];
    const next = clone(project);
    const at = nowISO();
    next.state = act.to;
    next.updatedAt = at;
    next.history = (next.history || []).concat([{
      at, action: act.id, label: act.label, from: project.state, to: act.to,
      note: (meta && meta.note) || '',
    }]);
    // 历史只留最近 40 条：项目文件要能塞进 localStorage，也方便人读
    if (next.history.length > 40) next.history = next.history.slice(-40);
    return next;
  }

  /** 把一次估算报告压成状态栏摘要（存盘用，避免项目文件里塞整份报告） */
  function summarize(report) {
    if (!report || !report.vram) return null;
    return {
      vramRatio: report.vram.ratio,
      vramState: report.vram.state,
      peak_mib: report.vram.peak_mib,
      shot_sec: report.time.shot_sec,
      episode_min: report.time.episode_min,
      quality: report.quality.score,
      device: report.device && report.device.id,
      usable_mib: report.device && report.device.usable_mib,
    };
  }

  /** 给 UI 用：列出当前状态下每个动作的可执行性 */
  function actions(project) {
    return ACTIONS.map(function (a) {
      const r = can(project, a.id);
      return { id: a.id, label: a.label, why: a.why, ok: r.ok, reason: r.reason, code: r.code };
    });
  }

  function serialize(project) {
    return JSON.stringify(project, null, 2);
  }

  /** 反序列化做硬校验：字段缺失/状态非法就抛，别把半个项目写进存储 */
  function deserialize(input) {
    let obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (e) { throw new Error('不是合法 JSON：' + e.message); }
    }
    if (!obj || typeof obj !== 'object') throw new Error('项目内容为空');
    if (obj.schema !== PROJECT_SCHEMA) throw new Error('不是本平台的项目文件（schema=' + obj.schema + '）');
    if (!STATE_MAP[obj.state]) throw new Error('项目状态非法：' + obj.state);
    const p = create({
      id: obj.id, name: obj.name, state: obj.state, tier: obj.tier, device: obj.device,
      usable_mib: obj.usable_mib, values: obj.values, summary: obj.summary,
      createdAt: obj.createdAt, history: obj.history,
    });
    p.updatedAt = obj.updatedAt || p.updatedAt;
    return p;
  }

  /* ───────────── 存储层 ───────────── */

  /** localStorage 在 file://、隐私模式、配额打满时都可能抛，统一包成哑接口 */
  function probeStorage(storage) {
    const s = storage || (function () {
      try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
    })();
    if (!s) return null;
    try {
      const k = '__avp_probe__';
      s.setItem(k, '1');
      s.removeItem(k);
      return s;
    } catch (e) {
      return null; // 只读/被禁用：当作不可用，落到内存
    }
  }

  function memoryBackend() {
    const m = new Map();
    return {
      kind: 'memory',
      getItem: function (k) { return m.has(k) ? m.get(k) : null; },
      setItem: function (k, v) { m.set(k, String(v)); },
      removeItem: function (k) { m.delete(k); },
    };
  }

  function createStore(opts) {
    const o = opts || {};
    const key = o.key || STORE_KEY;
    const real = probeStorage(o.storage);
    const backend = real || memoryBackend();
    const kind = real ? 'localStorage' : 'memory';
    // 内存镜像：即使落盘失败，本次会话也能继续操作
    const mirror = new Map();

    function emptyStore() {
      return { schema: STORE_SCHEMA, format: 1, active: null, projects: {} };
    }

    function read() {
      let raw = mirror.has(key) ? mirror.get(key) : null;
      if (raw == null && kind === 'localStorage') {
        try { raw = backend.getItem(key); } catch (e) { raw = null; }
      }
      if (!raw) return emptyStore();
      try {
        const s = JSON.parse(raw);
        if (!s || s.schema !== STORE_SCHEMA || !s.projects) return emptyStore();
        return s;
      } catch (e) {
        return emptyStore(); // 存储被外部写坏：当空库处理，不阻断启动
      }
    }

    function write(store) {
      const text = JSON.stringify(store);
      mirror.set(key, text);
      if (kind !== 'localStorage') return { ok: false, mode: 'memory', degraded: true };
      try {
        backend.setItem(key, text);
        return { ok: true, mode: 'full', degraded: false };
      } catch (e) {
        return { ok: false, mode: 'memory', degraded: true, error: String(e && e.name || e) };
      }
    }

    function save(project, opts2) {
      const store = read();
      const p = project;
      store.projects[p.id] = p;
      if (!store.active || (opts2 && opts2.activate)) store.active = p.id;

      let w = write(store);
      if (w.ok) return { ok: true, mode: 'full', degraded: false, id: p.id };

      // 降级一：去掉历史再试。历史是审计信息，丢了不影响干活。
      const slim = clone(store);
      const sp = slim.projects[p.id];
      sp.history = (sp.history || []).slice(-3);
      for (const id in slim.projects) {
        if (id !== p.id) {
          // 其它项目只留骨架，优先保住当前项目
          const q = slim.projects[id];
          slim.projects[id] = { id: q.id, name: q.name, state: q.state, tier: q.tier, updatedAt: q.updatedAt, schema: q.schema, format: q.format, values: {}, history: [] };
        }
      }
      const w2 = write(slim);
      if (w2.ok) {
        return { ok: true, mode: 'slim', degraded: true, id: p.id, hint: '存储紧张：已裁剪历史和其它项目的参数以保住当前项目' };
      }

      // 降级二：只进内存。明确告诉调用方"刷新会丢"。
      mirror.set(key, JSON.stringify(store));
      return {
        ok: false, mode: 'memory', degraded: true, id: p.id,
        error: w2.error || w.error || '写入失败',
        hint: kind === 'memory'
          ? 'localStorage 不可用（file:// 或隐私模式），项目只存在于内存，刷新即丢失；请用「导出项目」备份'
          : 'localStorage 已满，项目只存在于内存，刷新即丢失；请删掉旧项目或导出后清理',
      };
    }

    function list() {
      const store = read();
      return Object.keys(store.projects).map(function (id) {
        const p = store.projects[id];
        return { id: id, name: p.name, state: p.state, tier: p.tier, updatedAt: p.updatedAt, active: store.active === id };
      }).sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    }

    function load(id) {
      const store = read();
      const raw = store.projects[id || store.active];
      if (!raw) return null;
      try { return deserialize(raw); } catch (e) { return null; }
    }

    function remove(id) {
      const store = read();
      delete store.projects[id];
      if (store.active === id) store.active = Object.keys(store.projects)[0] || null;
      write(store);
      return list();
    }

    function active() {
      return read().active;
    }

    function setActive(id) {
      const store = read();
      if (!store.projects[id]) return { ok: false, reason: '项目不存在：' + id };
      store.active = id;
      const w = write(store);
      return { ok: true, mode: w.mode, degraded: w.degraded };
    }

    function clear() {
      mirror.delete(key);
      try { backend.removeItem(key); } catch (e) { /* 忽略：清不掉也不影响内存态 */ }
    }

    return {
      kind: kind, key: key,
      save: save, list: list, load: load, remove: remove,
      active: active, setActive: setActive, clear: clear,
      inspect: function () { return read(); },
    };
  }

  return {
    PROJECT_SCHEMA, PROJECT_FORMAT, STORE_SCHEMA, STORE_KEY, PRESET_NAMES,
    STATES, ACTIONS, GUARDS,
    create, can, apply, actions, summarize,
    serialize, deserialize,
    stateName, stateDesc,
    createStore,
  };
});