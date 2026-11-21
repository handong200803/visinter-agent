/**
 * cloud-client.src.js —— 前端到云端后端的唯一通道
 *
 * 纪律（对应验收项）：
 *   1. 前端不硬编码任何本机地址（localhost/端口）；baseUrl 来自构建注入 __AVP_API_BASE__ 或运行时设置；
 *   2. 前端不含任何内置 Key：所有凭据只活在后端 Secrets；
 *   3. 统一错误码直接透传后端 {error:{code,message,detail}}，由 UI 分档提示。
 *
 * 暴露：window.AVPCloud = { base, setBase, config, keyframes, select, video, task, tasks, score, experiments, optimize, library, health }
 */
(function (g) {
  'use strict';
  var STORE = 'avp.api.base';
  var BUILD_BASE = (typeof __AVP_API_BASE__ === 'string' ? __AVP_API_BASE__ : '');

  function base() {
    try { return (localStorage.getItem(STORE) || BUILD_BASE || '').replace(/\/+$/, ''); } catch { return BUILD_BASE; }
  }
  function setBase(u) {
    try { localStorage.setItem(STORE, String(u || '').replace(/\/+$/, '')); } catch { /* 隐私模式 */ }
    return base();
  }

  async function call(method, pathname, body, opts) {
    var b = base();
    if (!b) throw Object.assign(new Error('未配置后端地址（设置里填 https://…）'), { code: 'NO_BASE' });
    var o = { method: method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout((opts && opts.timeoutMs) || 120000) };
    if (opts && opts.admin) o.headers['x-admin-token'] = opts.admin;
    if (body !== undefined && body !== null) o.body = JSON.stringify(body);
    var r;
    try { r = await fetch(b + pathname, o); }
    catch (e) {
      throw Object.assign(new Error('连不上后端（' + b + '）：' + (e.message || e)), { code: 'NETWORK' });
    }
    var text = await r.text();
    var json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!r.ok) {
      var err = (json && json.error) || {};
      throw Object.assign(new Error(err.message || ('HTTP ' + r.status)), { code: err.code || 'HTTP_' + r.status, detail: err.detail, status: r.status });
    }
    return json || {};
  }

  var api = {
    get base() { return base(); },
    setBase: setBase,
    buildBase: BUILD_BASE,
    raw: call,
    health: () => call('GET', '/api/health'),
    config: () => call('GET', '/api/config'),

    /* 关键帧：生成候选 → 选优 */
    keyframes: (payload) => call('POST', '/api/keyframes', payload, { timeoutMs: 180000 }),
    keyframeTask: (id) => call('GET', '/api/keyframes/' + encodeURIComponent(id)),
    select: (id, index) => call('POST', '/api/keyframes/' + encodeURIComponent(id) + '/select', { index }),

    /* 视频：提交 → 轮询 */
    video: (payload) => call('POST', '/api/video', payload, { timeoutMs: 90000 }),
    videoTask: (id) => call('GET', '/api/video/' + encodeURIComponent(id)),

    /* 任务 */
    task: (id) => call('GET', '/api/tasks/' + encodeURIComponent(id)),
    tasks: (q) => call('GET', '/api/tasks?' + new URLSearchParams(q || {}).toString()),
    retry: (id) => call('POST', '/api/tasks/' + encodeURIComponent(id) + '/retry', {}),

    /* 打分 */
    score: (payload) => call('POST', '/api/scores', payload),
    getScore: (taskId) => call('GET', '/api/scores/' + encodeURIComponent(taskId)),

    /* 实验与寻优（需管理令牌） */
    experiments: (kind) => call('GET', '/api/experiments' + (kind ? '?kind=' + encodeURIComponent(kind) : '')),
    saveExperiment: (payload, admin) => call('POST', '/api/experiments', payload, { admin }),
    optimize: (payload, admin) => call('POST', '/api/optimize', payload, { admin }),

    /* 作品库 */
    library: (limit) => call('GET', '/api/library?limit=' + (limit || 50)),

    /** 轮询到终态：3–5s 间隔，默认 30 分钟 */
    async wait(taskId, { onStage, intervalMs = 5000, maxWaitMs = 30 * 60 * 1000, kind = 'video' } = {}) {
      var t0 = Date.now();
      for (;;) {
        if (Date.now() - t0 > maxWaitMs) throw Object.assign(new Error('等待超时'), { code: 'TIMEOUT', taskId });
        await new Promise((r) => setTimeout(r, intervalMs));
        var t = kind === 'video' ? await api.videoTask(taskId) : await api.keyframeTask(taskId);
        if (onStage) onStage({ state: t.state, task: t, sec: Math.round((Date.now() - t0) / 1000) });
        if (['succeeded', 'failed', 'expired', 'cancelled'].includes(t.state)) return t;
      }
    },
  };

  g.AVPCloud = api;
})(typeof window !== 'undefined' ? window : globalThis);
