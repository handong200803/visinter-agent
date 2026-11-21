/**
 * byok.src.js —— BYOK 云端视频生成（火山方舟 Seedance），纯前端
 *
 * 契约（2026-11-20 按用户给定规格重写）：
 *   · 鉴权：访客自己的 ARK_API_KEY，存本机 localStorage，请求头 Authorization: Bearer <key>
 *   · 创建：POST /api/v3/contents/generations/tasks
 *       content: [ {type:'image_url', image_url:{url:'data:image/xxx;base64,…'}, role:'first_frame'},
 *                  {type:'text', text: prompt} ]
 *       字段：model / resolution(480p|720p|1080p|4k) / ratio / duration / seed /
 *             camera_fixed / watermark / generate_audio
 *   · 轮询：GET /api/v3/contents/generations/tasks/{id}，5–10s 间隔，最长 30 分钟
 *       queued|running 继续；succeeded 取 content.video_url.url；
 *       failed|expired|cancelled 读 error.code/message
 *   · 落盘：拿到 video_url 立即下载成 Blob 存 IndexedDB（URL 仅 24h 有效）
 *   · 安全：Key 不下发平台、不写进静态包、日志不回显（统一 mask）
 *
 * 暴露 window.AVPByok = { getConfig, setConfig, clearConfig, classify, validate, generate, mount, providers, VENDORS }
 */
(function (global) {
  'use strict';

  var STORE_KEY = 'avp.byok.v1';
  var IDB_DB = 'avp_byok';
  var IDB_STORE = 'works';
  var MAX_WAIT_MS = 30 * 60 * 1000;   // 30 分钟
  var POLL_MS = 6000;                 // 6s（规格 5–10s）

  var DEFAULT_CFG = {
    vendor: 'seedance',
    model: 'doubao-seedance-2-0-mini-260615',
    endpoint: 'https://ark.cn-beijing.volces.com',
    proxy: '',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    cameraFixed: false,
    generateAudio: false,
    watermark: false,
  };

  /** 厂商白名单（据实声明；未实现的一律明确报错，不静默改路） */
  var VENDORS = {
    seedance: {
      id: 'seedance',
      label: '火山方舟 Seedance',
      keyLabel: 'ARK_API_KEY',
      models: ['doubao-seedance-2-0-mini-260615', 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0', 'doubao-seedance-2.5'],
      resolutions: ['480p', '720p', '1080p', '4k'],
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      duration: [2, 30],
      // 合规：2.x / 2.5 不支持真人人脸参考图（首帧只能是非真人或已授权素材）
      faceFirstFrameBlocked: ['doubao-seedance-2.0', 'doubao-seedance-2.5', 'doubao-seedance-2.0-fast'],
      implemented: true,
    },
    wanx: {
      id: 'wanx',
      label: '万相 Wanx（预留位）',
      keyLabel: 'DASHSCOPE_API_KEY',
      models: [],
      resolutions: [],
      ratios: [],
      duration: [2, 10],
      faceFirstFrameBlocked: [],
      implemented: false,
    },
  };

  /* ── 配置存取（只在本机） ─────────────────────────── */
  function getConfig() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return { ...DEFAULT_CFG, key: '' };
      var j = JSON.parse(raw);
      return { ...DEFAULT_CFG, ...j, key: j.key || '' };
    } catch { return { ...DEFAULT_CFG, key: '' }; }
  }
  function setConfig(patch) {
    var next = { ...getConfig(), ...patch };
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch { /* 隐私模式：仅内存 */ }
    return next;
  }
  function clearConfig() {
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    return { ...DEFAULT_CFG, key: '' };
  }
  function hasKey() { return !!String(getConfig().key || '').trim(); }
  function maskKey(k) {
    var s = String(k || '');
    if (!s) return '(未填)';
    return s.length <= 8 ? '****' : s.slice(0, 3) + '****' + s.slice(-4);
  }

  /* ── 错误分类 ─────────────────────────────────────── */
  function classify(status, body, extra) {
    var msg = '';
    try { msg = typeof body === 'string' ? body : JSON.stringify(body || {}); } catch { msg = ''; }
    var table = {
      401: { code: 'BYOK_KEY_INVALID', text: 'Key 无效或过期（401）。确认是标准方舟 ARK_API_KEY；Plan key 打 /api/v3 也会 401。' },
      403: { code: 'BYOK_FORBIDDEN', text: '额度不足 / 权限不足 / 模型未开通（403）。' },
      400: { code: 'BYOK_BAD_PARAM', text: '参数非法（400）。检查 model id、resolution、ratio、duration、seed 是否在白名单内。' },
      404: { code: 'BYOK_NOT_FOUND', text: '接口或任务不存在（404）。检查 endpoint。' },
      429: { code: 'BYOK_RATE_LIMIT', text: '请求过于频繁（429），稍后重试。' },
    };
    if (status && table[status]) return { code: table[status].code, status: status, message: table[status].text, detail: msg.slice(0, 300) };
    if (/Failed to fetch|NetworkError|Load failed|CORS/i.test(String(extra || ''))) {
      return { code: 'BYOK_CORS', status: 0, message: '浏览器跨域被拦（方舟不开放 CORS）。填「透传代理地址」后重试，或改用本地 ComfyUI。', detail: String(extra || '').slice(0, 200) };
    }
    return { code: 'BYOK_UNKNOWN', status: status || 0, message: '云端请求失败', detail: msg.slice(0, 300) };
  }

  /* ── 参数白名单（越界前端拦截） ───────────────────── */
  function validate(cfg, params) {
    var v = VENDORS[cfg.vendor];
    if (!v) return { ok: false, code: 'BYOK_UNKNOWN_VENDOR', message: '未知厂商：' + cfg.vendor };
    if (!v.implemented) return { ok: false, code: 'BYOK_NOT_IMPLEMENTED', message: v.label + ' 尚未接入（预留位）' };
    if (v.models.length && v.models.indexOf(cfg.model) < 0) return { ok: false, code: 'BYOK_BAD_MODEL', message: '模型不在白名单：' + cfg.model };
    if (v.resolutions.length && v.resolutions.indexOf(params.resolution) < 0) return { ok: false, code: 'BYOK_BAD_RESOLUTION', message: '分辨率只允许 ' + v.resolutions.join(' / ') };
    if (v.ratios.length && v.ratios.indexOf(params.ratio) < 0) return { ok: false, code: 'BYOK_BAD_RATIO', message: '比例只允许 ' + v.ratios.join(' / ') };
    var d = Number(params.duration);
    if (!(d >= v.duration[0] && d <= v.duration[1])) return { ok: false, code: 'BYOK_BAD_DURATION', message: '时长必须在 ' + v.duration[0] + '–' + v.duration[1] + ' 秒' };
    if (params.seed != null && params.seed !== '' && !Number.isFinite(Number(params.seed))) return { ok: false, code: 'BYOK_BAD_SEED', message: '种子必须是数字' };
    return { ok: true };
  }

  /** 合规检查：某些模型不支持真人人脸首帧 */
  function compliance(cfg, params) {
    var v = VENDORS[cfg.vendor] || {};
    var blocked = (v.faceFirstFrameBlocked || []).indexOf(cfg.model) >= 0;
    if (params.firstFrameDataUrl && blocked) {
      return {
        blocked: true,
        code: 'BYOK_FACE_REF_BLOCKED',
        message: cfg.model + ' 不支持直接上传真人人脸参考图。请改用非真人首帧、或换用支持人脸参考的模型。',
      };
    }
    return { blocked: false };
  }

  /* ── HTTP（支持透传代理） ─────────────────────────── */
  function buildUrl(cfg, pathname) {
    var base = String(cfg.endpoint || '').replace(/\/+$/, '');
    var url = base + pathname;
    var proxy = String(cfg.proxy || '').trim();
    if (!proxy) return url;
    var sep = proxy.indexOf('?') >= 0 ? '&' : '?';
    return proxy + sep + 'url=' + encodeURIComponent(url);
  }

  async function httpJson(cfg, method, pathname, body, timeoutMs) {
    var key = String(cfg.key || '').trim();
    if (!key) throw Object.assign(new Error('未填写 ARK_API_KEY'), { code: 'BYOK_NO_KEY' });
    var opts = {
      method: method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(timeoutMs || 60000),
    };
    if (body) opts.body = JSON.stringify(body);
    var r;
    try { r = await fetch(buildUrl(cfg, pathname), opts); }
    catch (e) {
      var c = classify(0, null, e && e.message);
      throw Object.assign(new Error(c.message), { code: c.code, detail: c.detail });
    }
    var text = await r.text();
    var json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    if (!r.ok) {
      var err = classify(r.status, json || text);
      throw Object.assign(new Error(err.message), { code: err.code, status: r.status, detail: err.detail });
    }
    return json || {};
  }

  /* ── Provider: Seedance ───────────────────────────── */
  var seedance = {
    id: 'seedance',

    async submitTask(cfg, task) {
      var content = [];
      // 首帧：image_url + role=first_frame（先图后文，按方舟契约）
      if (task.firstFrameDataUrl) content.push({ type: 'image_url', image_url: { url: task.firstFrameDataUrl }, role: 'first_frame' });
      content.push({ type: 'text', text: String(task.prompt || '') });

      var body = {
        model: cfg.model,
        content: content,
        resolution: task.resolution,
        ratio: task.ratio,
        duration: Number(task.duration),
        camera_fixed: !!task.cameraFixed,
        watermark: !!task.watermark,
        generate_audio: !!task.generateAudio,
      };
      if (task.seed != null && task.seed !== '' && Number.isFinite(Number(task.seed))) body.seed = Number(task.seed);
      var j = await httpJson(cfg, 'POST', '/api/v3/contents/generations/tasks', body, 60000);
      if (!j.id) throw Object.assign(new Error('创建任务未返回 id'), { code: 'BYOK_NO_TASK_ID', detail: JSON.stringify(j).slice(0, 200) });
      return { taskId: j.id, raw: j };
    },

    async pollTask(cfg, taskId) {
      var j = await httpJson(cfg, 'GET', '/api/v3/contents/generations/tasks/' + encodeURIComponent(taskId), null, 30000);
      return { status: j.status || 'unknown', raw: j };
    },

    async fetchResult(cfg, taskId, last) {
      var j = (last && last.raw) || (await httpJson(cfg, 'GET', '/api/v3/contents/generations/tasks/' + encodeURIComponent(taskId), null, 30000));
      var c = j.content || {};
      // 契约：content.video_url.url；兼容字符串与顶层字段
      var url = (c.video_url && (c.video_url.url || c.video_url)) || j.video_url || (c.url && (c.url.url || c.url)) || null;
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
        var m = JSON.stringify(j).match(/https:\/\/[^\s"]+?\.(?:mp4|mov)[^\s"]*/);
        url = m ? m[0] : null;
      }
      if (!url) throw Object.assign(new Error('任务成功但没有可用视频地址'), { code: 'BYOK_NO_VIDEO_URL', detail: JSON.stringify(j).slice(0, 300) });
      var usage = j.usage || {};
      return { url: url, tokens: usage.completion_tokens || usage.total_tokens || null, raw: j };
    },
  };

  var PROVIDERS = { seedance: seedance, wanx: { id: 'wanx' } };

  /* ── IndexedDB（存 Blob，URL 过期也能回看） ────────── */
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!global.indexedDB) return reject(new Error('浏览器不支持 IndexedDB'));
      var req = indexedDB.open(IDB_DB, 2);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  async function idbPut(rec) {
    var db = await idbOpen();
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(rec);
      tx.oncomplete = function () { resolve(rec); };
      tx.onerror = function () { reject(tx.error); };
    });
  }
  async function idbList(limit) {
    try {
      var db = await idbOpen();
      return await new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readonly');
        var req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = function () {
          var arr = (req.result || []).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
          resolve(arr.slice(0, limit || 20));
        };
        req.onerror = function () { reject(req.error); };
      });
    } catch { return []; }
  }
  async function idbClear() {
    try {
      var db = await idbOpen();
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
      });
      return true;
    } catch { return false; }
  }

  /** 立即下载视频转 Blob（URL 24h 有效，不能只存链接） */
  async function grabVideo(url, onStage) {
    try {
      if (onStage) onStage({ stage: 'downloading', text: '下载成片到本机…' });
      var r = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var blob = await r.blob();
      return { blob: blob, bytes: blob.size, type: blob.type || 'video/mp4' };
    } catch (e) {
      // 下载失败不阻断：URL 先存着（24h 内仍可用），并标注未转存
      return { blob: null, bytes: null, error: (e && e.message || 'download failed') };
    }
  }

  /* ── 主流程 ───────────────────────────────────────── */
  async function generate(opts) {
    var cfg = { ...getConfig(), ...(opts.cfg || {}) };
    var key = String(cfg.key || '').trim();
    if (!key) throw Object.assign(new Error('云端生成需要先填 ' + ((VENDORS[cfg.vendor] || {}).keyLabel || 'API Key')), { code: 'BYOK_NO_KEY' });

    var params = {
      prompt: String(opts.prompt || ''),
      resolution: opts.resolution || cfg.resolution,
      ratio: opts.ratio || cfg.ratio,
      duration: Number(opts.duration || cfg.duration),
      seed: opts.seed == null ? null : opts.seed,
      cameraFixed: opts.cameraFixed != null ? !!opts.cameraFixed : !!cfg.cameraFixed,
      generateAudio: opts.generateAudio != null ? !!opts.generateAudio : !!cfg.generateAudio,
      watermark: opts.watermark != null ? !!opts.watermark : !!cfg.watermark,
      firstFrameDataUrl: opts.firstFrameDataUrl || null,
    };

    var v = validate(cfg, params);
    if (!v.ok) throw Object.assign(new Error(v.message), { code: v.code });
    var comp = compliance(cfg, params);
    if (comp.blocked) throw Object.assign(new Error(comp.message), { code: comp.code });
    if (!params.prompt.trim()) throw Object.assign(new Error('提示词不能为空'), { code: 'BYOK_NO_PROMPT' });

    var prov = PROVIDERS[cfg.vendor];
    if (!prov || !prov.submitTask) throw Object.assign(new Error('厂商适配未实现'), { code: 'BYOK_NOT_IMPLEMENTED' });

    var onStage = opts.onStage || function () {};
    var t0 = Date.now();
    onStage({ stage: 'submitting', text: '创建任务…' });
    var sub = await prov.submitTask(cfg, params);
    onStage({ stage: 'queued', text: '已创建 task=' + sub.taskId, taskId: sub.taskId });

    var maxMs = Number(opts.maxWaitMs || MAX_WAIT_MS);
    var interval = Number(opts.pollMs || POLL_MS);
    var last = null;
    for (;;) {
      if (Date.now() - t0 > maxMs) {
        throw Object.assign(new Error('等待超时（' + Math.round(maxMs / 60000) + ' 分钟）。任务可能仍在云端运行，可用 task ID 稍后重查。'), { code: 'BYOK_TIMEOUT', taskId: sub.taskId });
      }
      await new Promise(function (r) { setTimeout(r, interval); });
      last = await prov.pollTask(cfg, sub.taskId);
      onStage({ stage: last.status, text: '状态 ' + last.status + ' · ' + Math.round((Date.now() - t0) / 1000) + 's', taskId: sub.taskId });
      if (last.status === 'succeeded') break;
      if (['failed', 'expired', 'cancelled'].indexOf(last.status) >= 0) {
        var e2 = (last.raw && last.raw.error) || {};
        var codeMap = { failed: 'BYOK_TASK_FAILED', expired: 'BYOK_TASK_EXPIRED', cancelled: 'BYOK_TASK_CANCELLED' };
        throw Object.assign(new Error('云端任务' + (last.status === 'failed' ? '失败' : last.status === 'expired' ? '已过期' : '已取消') + '：' + (e2.message || e2.code || last.status)), {
          code: codeMap[last.status] || 'BYOK_TASK_FAILED',
          detail: JSON.stringify(e2).slice(0, 300),
          taskId: sub.taskId,
        });
      }
    }

    var res = await prov.fetchResult(cfg, sub.taskId, last);
    var grabbed = await grabVideo(res.url, onStage);

    var rec = {
      id: 'byok_' + Date.now().toString(36),
      source: 'byok',
      vendor: cfg.vendor,
      model: cfg.model,
      taskId: sub.taskId,
      url: res.url,
      blob: grabbed.blob,
      bytes: grabbed.bytes,
      downloadError: grabbed.error || null,
      tokens: res.tokens,
      prompt: params.prompt,
      resolution: params.resolution,
      ratio: params.ratio,
      duration: params.duration,
      seed: params.seed,
      cameraFixed: params.cameraFixed,
      generateAudio: params.generateAudio,
      watermark: params.watermark,
      i2v: !!params.firstFrameDataUrl,
      aiGenerated: true,                      // AI 生成标识：随记录持久化
      aiLabel: 'AI 生成内容（BYOK · ' + cfg.vendor + '）',
      createdAt: new Date().toISOString(),
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    };
    try { await idbPut(rec); } catch { /* 隐私模式忽略 */ }
    return rec;
  }

  /* ── 面板 ─────────────────────────────────────────── */
  function mount(el, ctx) {
    if (!el) return null;
    var cfg = getConfig();
    var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); };
    var v = VENDORS[cfg.vendor] || VENDORS.seedance;
    var inputStyle = 'height:28px;padding:0 8px;font-family:var(--mono);font-size:var(--fz-xs);background:var(--panel);border:1px solid var(--line);border-radius:var(--r3);color:var(--text)';

    el.innerHTML =
      '<div style="border:1px solid var(--line);border-radius:var(--r3);padding:10px 12px;background:var(--panel2)">'
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">'
      + '<b style="font-size:var(--fz-s)">云端生成（BYOK）</b>'
      + '<span id="byokState" style="font:var(--fz-xs)/1 var(--mono);color:var(--text-dim)">未配置 Key</span>'
      + '<div style="flex:1"></div>'
      + '<span style="font:var(--fz-xs)/1 var(--mono);color:var(--text-dim2)">Key 只存本机 · 不下发平台 · 日志脱敏</span>'
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">'
      + '<select id="byokVendor" style="height:28px;min-width:150px">' + Object.values(VENDORS).map(function (x) { return '<option value="' + x.id + '"' + (x.id === cfg.vendor ? ' selected' : '') + '>' + esc(x.label) + '</option>'; }).join('') + '</select>'
      + '<input id="byokKey" type="password" placeholder="' + esc(v.keyLabel) + '（只存本机）" value="' + esc(cfg.key || '') + '" style="' + inputStyle + ';min-width:280px">'
      + '<button id="byokEye" class="btn mini" type="button">显示</button>'
      + '<input id="byokEndpoint" placeholder="endpoint" value="' + esc(cfg.endpoint) + '" style="' + inputStyle + ';min-width:230px;color:var(--text-dim)">'
      + '<button id="byokSave" class="btn mini" type="button">保存</button>'
      + '<button id="byokClear" class="btn mini" type="button">清除 Key</button>'
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">'
      + '<input id="byokProxy" placeholder="透传代理地址（可选，CORS 被拦时用）" value="' + esc(cfg.proxy) + '" style="' + inputStyle + ';min-width:300px;color:var(--text-dim)">'
      + '<select id="byokRes" style="height:28px">' + (v.resolutions.length ? v.resolutions : ['720p']).map(function (r) { return '<option' + (r === cfg.resolution ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>'
      + '<select id="byokRatio" style="height:28px">' + (v.ratios.length ? v.ratios : ['16:9']).map(function (r) { return '<option' + (r === cfg.ratio ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select>'
      + '<select id="byokDur" style="height:28px">' + [5, 8, 10, 15].map(function (d) { return '<option value="' + d + '"' + (Number(cfg.duration) === d ? ' selected' : '') + '>' + d + 's</option>'; }).join('') + '</select>'
      + '<input id="byokSeed" placeholder="seed（可空）" style="' + inputStyle + ';width:110px">'
      + '<label style="font-size:var(--fz-xs);color:var(--text-dim)"><input id="byokCam" type="checkbox"' + (cfg.cameraFixed ? ' checked' : '') + '> 固定镜头</label>'
      + '<label style="font-size:var(--fz-xs);color:var(--text-dim)"><input id="byokAudio" type="checkbox"' + (cfg.generateAudio ? ' checked' : '') + '> 生成音频</label>'
      + '<label style="font-size:var(--fz-xs);color:var(--text-dim)"><input id="byokMark" type="checkbox"' + (cfg.watermark ? ' checked' : '') + '> 水印</label>'
      + '</div>'
      + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
      + '<button id="byokGen" class="btn acc" type="button">云端出片</button>'
      + '<span id="byokHint" style="font-size:var(--fz-xs);color:var(--text-dim2)"></span>'
      + '</div>'
      + '<div style="margin-top:6px;font:var(--fz-xs)/1.6 var(--mono);color:var(--text-dim2)">合规提示：2.x / 2.5 模型不支持直接上传真人人脸参考图；产物标注为 AI 生成内容。</div>'
      + '<div id="byokLog" style="margin-top:6px;font:var(--fz-xs)/1.6 var(--mono);color:var(--text-dim);white-space:pre-wrap"></div>'
      + '<video id="byokVideo" controls style="width:100%;display:none;margin-top:8px;border:1px solid var(--line);border-radius:var(--r2)"></video>'
      + '<div id="byokWorks" style="margin-top:8px;font:var(--fz-xs)/1.6 var(--mono);color:var(--text-dim2)"></div>'
      + '<div id="byokAI" style="margin-top:4px;font:var(--fz-xs)/1.4 var(--mono);color:var(--text-dim2)"></div>'
      + '</div>';

    var $ = function (id) { return el.querySelector('#' + id); };
    var log = function (t) { var n = $('byokLog'); if (n) n.textContent = t; };
    var state = function (t, tone) { var n = $('byokState'); if (!n) return; n.textContent = t; n.style.color = tone === 'bad' ? 'var(--bad-ink)' : tone === 'ok' ? 'var(--ok)' : 'var(--text-dim)'; };

    function syncGate() {
      var gen = $('byokGen');
      var ok = hasKey();
      gen.disabled = !ok;
      gen.title = ok ? '' : '先填 ' + ((VENDORS[getConfig().vendor] || {}).keyLabel || 'API Key');
      var c = getConfig();
      state(ok ? 'Key 已配置 · ' + maskKey(c.key) : '未配置 Key', ok ? 'ok' : 'warn');
      $('byokHint').textContent = ok ? '' : '未填 Key 时云端不可用；本地 ComfyUI / 演示模式不受影响';
    }
    syncGate();

    $('byokEye').onclick = function () { var k = $('byokKey'); k.type = k.type === 'password' ? 'text' : 'password'; this.textContent = k.type === 'password' ? '显示' : '隐藏'; };
    $('byokSave').onclick = function () {
      setConfig({
        key: $('byokKey').value.trim(), endpoint: $('byokEndpoint').value.trim(), proxy: $('byokProxy').value.trim(),
        vendor: $('byokVendor').value, resolution: $('byokRes').value, ratio: $('byokRatio').value,
        duration: Number($('byokDur').value), cameraFixed: $('byokCam').checked,
        generateAudio: $('byokAudio').checked, watermark: $('byokMark').checked,
      });
      syncGate();
      log('已保存到本机（' + maskKey(getConfig().key) + '）');
    };
    $('byokClear').onclick = function () { clearConfig(); $('byokKey').value = ''; syncGate(); log('已清除本机 Key'); };

    $('byokGen').onclick = async function () {
      var btn = this; btn.disabled = true;
      log('准备中…');
      try {
        var prompt = String((ctx && ctx.getPrompt && ctx.getPrompt()) || '').trim();
        var ff = (ctx && ctx.getFirstFrameDataUrl) ? await ctx.getFirstFrameDataUrl() : null;
        if (ff) log('已带首帧（i2v，role=first_frame）');
        var rec = await generate({
          prompt: prompt,
          firstFrameDataUrl: ff,
          resolution: $('byokRes').value,
          ratio: $('byokRatio').value,
          duration: Number($('byokDur').value),
          seed: $('byokSeed').value.trim() === '' ? null : Number($('byokSeed').value.trim()),
          cameraFixed: $('byokCam').checked,
          generateAudio: $('byokAudio').checked,
          watermark: $('byokMark').checked,
          onStage: function (s) { log(s.text); },
        });
        log('完成 · task=' + rec.taskId + ' · ' + rec.elapsedSec + 's · ' + rec.resolution + '/' + rec.duration + 's'
          + (rec.seed != null ? ' · seed=' + rec.seed : '')
          + (rec.bytes ? ' · 已转存 ' + (rec.bytes / 1048576).toFixed(1) + 'MB' : ' · 未转存(URL 24h 有效)'));
        var vid = $('byokVideo');
        vid.src = rec.blob ? URL.createObjectURL(rec.blob) : rec.url;
        vid.style.display = 'block';
        $('byokAI').textContent = rec.aiLabel;
        state('已出片 · BYOK', 'ok');
        renderWorks();
      } catch (e) {
        log('失败 · ' + (e.code || 'BYOK_FAILED') + ' · ' + e.message + (e.detail ? '\n' + String(e.detail).slice(0, 300) : ''));
        state('失败 · ' + (e.code || 'BYOK_FAILED'), 'bad');
      } finally { btn.disabled = false; syncGate(); }
    };

    async function renderWorks() {
      var list = await idbList(6);
      var box = $('byokWorks');
      if (!box) return;
      box.innerHTML = list.length ? ('<b>本机 BYOK 作品</b><br>' + list.map(function (w) {
        return esc(String(w.createdAt).slice(0, 19).replace('T', ' ')) + ' · ' + esc(w.vendor) + ' · ' + esc(w.model)
          + ' · ' + esc(w.resolution || '?') + '/' + esc(String(w.duration || '?')) + 's'
          + (w.seed != null ? ' · seed ' + esc(String(w.seed)) : '')
          + ' · ' + (w.bytes ? (w.bytes / 1048576).toFixed(1) + 'MB' : 'URL')
          + ' · ' + (w.blob ? '<a href="' + esc(w.url) + '" target="_blank" style="color:var(--acc)">打开</a>' : '仅 URL');
      }).join('<br>')) : '本机还没有 BYOK 产物（视频 Blob 存 IndexedDB，不上传）';
    }
    renderWorks();

    return { refresh: syncGate, renderWorks: renderWorks, getConfig: getConfig };
  }

  global.AVPByok = {
    VENDORS, DEFAULT_CFG, IDB_DB, MAX_WAIT_MS, POLL_MS,
    getConfig, setConfig, clearConfig, hasKey, maskKey,
    classify, validate, compliance, generate, buildUrl, grabVideo,
    idbList, idbClear,
    mount,
    providers: PROVIDERS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
