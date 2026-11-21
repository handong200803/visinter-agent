/**
 * comfy.js —— ComfyUI 适配层（零依赖，只用 node 内置 http / fetch / WebSocket）
 *
 * 为什么单独一层：ComfyUI 的失败信息是三层嵌套的红字（HTTP status → error.type →
 * node_errors[x].errors[y].type），直接甩给前端等于让前端写正则。这里一次性收敛成
 * 稳定 error code + 中文 hint，上层（jobs/app）只认 code。
 *
 * history + queue 始终负责终态与丢失检测；WebSocket 只补充 value/max 真进度，
 * 绝不以 WS 完成事件或 outputs 非空代替 history success。COMFY_WS=0 可关闭 WS；
 * 没有真百分比时 percent=null。signal 只停止本地等待，远端取消必须显式指定任务 ID。
 */
'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const DEFAULT_BASE = 'http://127.0.0.1:8188';

/** ComfyUI 的 type 字符串 → 本层稳定 code。没收录的落 COMFY_ERROR 并保留原 type。 */
const TYPE_CODE = {
  prompt_outputs_failed_validation: 'COMFY_VALIDATION_FAILED',
  prompt_no_outputs: 'COMFY_NO_OUTPUTS',
  invalid_prompt: 'COMFY_INVALID_PROMPT',
  missing_node_type: 'COMFY_MISSING_NODE',
  value_not_valid: 'COMFY_VALUE_NOT_VALID',
  value_bigger_than_max: 'COMFY_VALUE_OUT_OF_RANGE',
  value_smaller_than_min: 'COMFY_VALUE_OUT_OF_RANGE',
  required_input_missing: 'COMFY_INPUT_MISSING',
  bad_linked_input: 'COMFY_LINK_BAD',
  return_type_mismatch: 'COMFY_TYPE_MISMATCH',
  exception_during_execution: 'COMFY_EXEC_ERROR',
  execution_error: 'COMFY_EXEC_ERROR',
  out_of_memory: 'COMFY_OOM',
};

/** 给每个 code 一句人话：这套 hint 就是为了让"红字"变成可操作的结论。 */
const HINTS = {
  COMFY_VALIDATION_FAILED: '工作流校验没过：某个节点的入参类型/取值不合法，看 detail.nodes。',
  COMFY_NO_OUTPUTS: '工作流没有可执行的输出节点（缺 SaveImage 之类），ComfyUI 拒绝入队。',
  COMFY_INVALID_PROMPT: 'prompt 结构不是 API 格式（应形如 {"3":{"class_type":...,"inputs":{}}}）。',
  COMFY_MISSING_NODE: '模板里的 class_type 在当前 ComfyUI 没装（缺自定义节点或没重启）。',
  COMFY_VALUE_NOT_VALID: '某个 widget 的取值不在 ComfyUI 的枚举/范围里。',
  COMFY_VALUE_OUT_OF_RANGE: '数值超出节点定义的 min/max。',
  COMFY_INPUT_MISSING: '必填入参没给。',
  COMFY_LINK_BAD: '连线引用了不存在的节点或槽位。',
  COMFY_TYPE_MISMATCH: '连线两端类型不匹配。',
  COMFY_EXEC_ERROR: '节点执行期抛异常（常见：模型文件缺失、CUDA OOM、采样器名写错）。',
  COMFY_OOM: '显存不足；已保留原参数，不自动降分辨率、减步数或量化，请使用足够显存的设备后重试。',
  COMFY_UNREACHABLE: '连不上 ComfyUI：确认 http://127.0.0.1:8188 已启动，或用 COMFY_URL 改基址。',
  COMFY_TIMEOUT: '请求超时：ComfyUI 在忙或进程卡死。',
  COMFY_HTTP_ERROR: 'ComfyUI 返回了非 2xx。',
  COMFY_BAD_RESPONSE: '返回体不是合法 JSON。',
  COMFY_NOT_FOUND: 'prompt_id 在 /history 里查不到（可能已被清理或从未入队）。',
  COMFY_INTERRUPTED: 'ComfyUI 已中断该任务，未成功完成。',
  COMFY_TASK_LOST: '任务既不在 history 也不在队列中，可能已被清理或 ComfyUI 已重启。',
  COMFY_SUBMISSION_UNCERTAIN: '提交结果不确定，且未查到原 prompt_id；为避免重复生成，请核对后显式重试。',
};

class ComfyError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'ComfyError';
    this.code = code;
    this.detail = detail || {};
    this.hint = HINTS[code] || '';
  }
  toJSON() {
    return { code: this.code, message: this.message, hint: this.hint, detail: this.detail };
  }
}

/** 哪些错误值得重试：网络层与 5xx 短暂故障。校验类错误重试没意义（它不会自己变好）。 */
const RETRYABLE = new Set(['COMFY_UNREACHABLE', 'COMFY_TIMEOUT', 'COMFY_HTTP_ERROR']);

/** 把 ComfyUI 4xx 的 body 折成结构化 error。 */
function fromComfyBody(status, body) {
  const err = (body && body.error) || {};
  const type = typeof err === 'string' ? err : err.type || '';
  const nodes = [];
  if (body && body.node_errors && typeof body.node_errors === 'object') {
    for (const [nid, ne] of Object.entries(body.node_errors)) {
      for (const e of (ne && ne.errors) || []) {
        const extra = e.extra_info || {};
        nodes.push({
          node: nid,
          class_type: (ne && ne.class_type) || extra.class_type || '',
          code: TYPE_CODE[e.type] || 'COMFY_ERROR',
          comfy_type: e.type || '',
          message: e.message || '',
          widget: extra.input_name || extra.widget_name || null,
        });
      }
    }
  }
  const code = TYPE_CODE[type] || (status >= 500 ? 'COMFY_HTTP_ERROR' : 'COMFY_VALIDATION_FAILED');
  const first = nodes[0];
  const msg = (err.message || err.details || '') || (first && first.message) || `HTTP ${status}`;
  return new ComfyError(code, String(msg), { status, comfy_type: type || null, nodes });
}

function checkSignal(signal) {
  if (!signal || !signal.aborted) return;
  if (signal.reason && signal.reason.code === 'JOB_DETACHED') throw signal.reason;
  throw new ComfyError('JOB_CANCELED', '已停止本地等待');
}

async function pause(ms, signal) {
  try { await delay(ms, undefined, { signal }); }
  catch (e) { checkSignal(signal); throw e; }
}

function inQueue(items, id) {
  return Array.isArray(items) && items.some((item) => Array.isArray(item) && item[1] === id);
}

/** 老调用者仍读 images；其中兼容放入视频/GIF 文件描述，按实际文件而非输出节点去重。 */
function outputFiles(outputs) {
  const files = new Map();
  for (const [node, out] of Object.entries(outputs || {})) {
    for (const kind of ['images', 'videos', 'gifs']) {
      if (!out || !Array.isArray(out[kind])) continue;
      for (const file of out[kind]) {
        if (!file || typeof file.filename !== 'string' || !file.filename) continue;
        const key = JSON.stringify([file.type || 'output', file.subfolder || '', file.filename]);
        if (!files.has(key)) files.set(key, { node, ...file });
      }
    }
  }
  return [...files.values()];
}

function createComfy(opts = {}) {
  const base = String(opts.base || process.env.COMFY_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const timeoutMs = Number(opts.timeoutMs || process.env.COMFY_TIMEOUT_MS || 15000);
  const retries = Number(opts.retries == null ? process.env.COMFY_RETRIES || 1 : opts.retries);
  // 探测结果缓存 2s：/api/health 会被前端高频打，不必每次都真连。
  let probe = { at: 0, ok: false, detail: null };
  const PROBE_TTL = 2000;

  async function raw(pathname, { method = 'GET', body, timeout = timeoutMs, signal } = {}) {
    checkSignal(signal);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(base + pathname, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { throw new ComfyError('COMFY_BAD_RESPONSE', 'ComfyUI 返回非 JSON', { status: res.status, snippet: text.slice(0, 300) }); }
      if (!res.ok) throw fromComfyBody(res.status, data);
      return data;
    } catch (e) {
      checkSignal(signal);
      if (e instanceof ComfyError) throw e;
      if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) throw new ComfyError('COMFY_TIMEOUT', `请求 ${pathname} 超时 ${timeout}ms`, { path: pathname, timeout });
      // undici 的 fetch 把 ECONNREFUSED 包在 cause 里，取出来才能区分"没启动"与"域名错"。
      const cause = (e && e.cause) || {};
      throw new ComfyError('COMFY_UNREACHABLE', `连不上 ${base}：${cause.code || e.code || e.message}`, { base, cause: cause.code || e.code || null });
    } finally { clearTimeout(timer); }
  }

  async function call(pathname, o = {}) {
    // 写请求可能已经被远端接受，重试会重复入队；只允许重试只读请求。
    const attempts = ['GET', 'HEAD'].includes((o.method || 'GET').toUpperCase()) ? retries : 0;
    for (let attempt = 0; ; attempt += 1) {
      try { return await raw(pathname, o); } catch (e) {
        if (!RETRYABLE.has(e.code) || attempt >= attempts) throw e;
        await pause(300 * (attempt + 1), o.signal);
      }
    }
  }

  /** 可达性探测：/system_stats 是最轻的只读端点。 */
  async function ping({ force = false } = {}) {
    if (!force && Date.now() - probe.at < PROBE_TTL) return probe;
    try {
      const s = await call('/system_stats', { timeout: 2500 });
      probe = {
        at: Date.now(), ok: true, detail: {
          comfyui: (s && s.system && s.system.comfyui_version) || null, os: (s && s.system && s.system.os) || null,
          python: (s && s.system && s.system.python_version) || null, devices: (s && s.devices) || [],
        },
      };
    } catch (e) {
      probe = { at: Date.now(), ok: false, detail: e.toJSON ? e.toJSON() : { code: e.code, message: e.message } };
    }
    return probe;
  }

  const api = {
    base, timeoutMs, retries,
    ComfyError,
    ping,
    /** POST /prompt → prompt_id */
    async prompt(workflow, { clientId = 'avp', promptId, extraData } = {}) {
      const body = { prompt: workflow, client_id: clientId };
      if (promptId != null) body.prompt_id = promptId;
      if (extraData != null) body.extra_data = extraData;
      const r = await call('/prompt', { method: 'POST', body });
      // 某些输出校验失败时，其余输出仍可入队；收到 ID 就必须先记住已接受的任务。
      if (!r || typeof r.prompt_id !== 'string' || !r.prompt_id) {
        if (r && (r.error || (r.node_errors && Object.keys(r.node_errors).length))) throw fromComfyBody(200, r);
        throw new ComfyError('COMFY_BAD_RESPONSE', '/prompt 没返回 prompt_id', { body: r });
      }
      return { prompt_id: r.prompt_id, number: r.number, node_errors: r.node_errors || null };
    },
    /** GET /history/{id}；查不到返回 null（调用方决定是"还在跑"还是"丢了"） */
    async history(id, { signal } = {}) {
      const r = await call(`/history/${encodeURIComponent(id)}`, { signal });
      const h = r && r[id];
      if (!h) return null;
      const st = h.status || {};
      const messages = Array.isArray(st.messages) ? st.messages : [];
      const failure = messages.find((m) => Array.isArray(m) && ['execution_error', 'execution_interrupted'].includes(m[0]));
      const interrupted = st.status_str === 'interrupted' || (failure && failure[0] === 'execution_interrupted');
      const failed = !!(interrupted || failure || st.status_str === 'error');
      const errorCode = failed ? (interrupted ? 'COMFY_INTERRUPTED' : 'COMFY_EXEC_ERROR') : null;
      const error = failed ? new ComfyError(errorCode,
        (failure && failure[1] && failure[1].exception_message) || (interrupted ? 'ComfyUI 执行已中断' : 'ComfyUI 执行失败'),
        { prompt_id: id, status: st, execution: failure ? failure[1] : null }) : null;
      return {
        prompt_id: id, done: st.status_str === 'success' && !failed, completed: !!st.completed,
        status_str: st.status_str || null, images: outputFiles(h.outputs), raw_status: st,
        failed, errorCode, error,
      };
    },
    async queue({ signal } = {}) { return call('/queue', { signal }); },
    async interrupt(id) { return call('/interrupt', { method: 'POST', body: id ? { prompt_id: id } : {} }); },
    async cancel(id) {
      if (!id) return { remote: false, reason: '没有远端 prompt_id' };
      const q = await api.queue();
      if (inQueue(q && q.queue_pending, id)) {
        await call('/queue', { method: 'POST', body: { delete: [id] } });
        // 删除期间可能已从 pending 切到 running，重新核对，不能全局 interrupt。
        const after = await api.queue();
        if (inQueue(after && after.queue_running, id)) await api.interrupt(id);
        return { remote: true, taskId: id };
      }
      if (inQueue(q && q.queue_running, id)) {
        // 本机 ComfyUI 也会在 /interrupt 内再次检查 ID，避免队列切换误伤下一条。
        await api.interrupt(id);
        return { remote: true, taskId: id };
      }
      return { remote: false, taskId: id, reason: '该 prompt_id 不在队列中，未中断其它任务' };
    },
    async objectInfo() { return call('/object_info', { timeout: 60000 }); },
    /**
     * GET /models/{folder} —— 新版 ComfyUI 的模型清单（loras / ipadapter / checkpoints…）。
     * 老版本没有这个端点（404）：返回 null 让调用方回退文件系统检查，不要当成「没有模型」。
     */
    async models(folder) {
      try {
        const r = await call('/models/' + encodeURIComponent(String(folder || '')), { timeout: 10000 });
        if (Array.isArray(r)) return r;
        if (r && Array.isArray(r.models)) return r.models;
        return null;
      } catch (e) {
        return null;
      }
    },

    /**
     * 等待一个 prompt 结束，并回调进度。
     * onProgress({type,value,max,percent,stage}) —— 只有 WS 才有真实 percent。
     * 返回 {ok, images, errorCode}；中断/取消由 signal 控制。
     */
    async waitFor(id, { onProgress = () => {}, signal, pollMs = 400, clientId = 'avp' } = {}) {
      let stopWs = () => {};
      try {
        checkSignal(signal);
        if (process.env.COMFY_WS !== '0' && typeof globalThis.WebSocket === 'function') {
          stopWs = watchProgress(id, onProgress, clientId);
        }
        return await waitPoll(id, onProgress, signal, pollMs);
      } catch (e) {
        if (e && e.code === 'JOB_CANCELED') return { ok: false, canceled: true, images: [] };
        throw e;
      } finally { stopWs(); }
    },
  };

  function watchProgress(id, onProgress, clientId) {
    const wsUrl = base.replace(/^http/, 'ws') + '/ws?clientId=' + encodeURIComponent(clientId || 'avp');
    let ws, stopped = false, fallbackSent = false, activePrompt = null;
    const fallback = () => {
      if (stopped || fallbackSent) return;
      fallbackSent = true;
      onProgress({ type: 'ws_fallback', stage: 'poll', percent: null, reason: 'WS 不可用，继续 history/queue 轮询' });
    };
    try { ws = new WebSocket(wsUrl); }
    catch { fallback(); return () => {}; }
    const onOpen = () => { if (!stopped) onProgress({ type: 'ws_open', stage: 'ws', percent: null }); };
    const onMessage = (ev) => {
      if (stopped) return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const d = m.data || {};
      if (['execution_start', 'executing'].includes(m.type) && d.prompt_id) activePrompt = d.prompt_id;
      if (d.prompt_id ? d.prompt_id !== id : activePrompt !== id) return;
      if (m.type === 'progress') {
        const percent = Number.isFinite(d.value) && Number.isFinite(d.max) && d.max > 0
          ? Math.round((d.value / d.max) * 100) : null;
        onProgress({ type: 'progress', stage: 'sampling', value: d.value, max: d.max, percent, node: d.node || null });
      } else if (m.type === 'executing') {
        onProgress({ type: 'executing', stage: 'sampling', node: d.node || null, percent: null });
      }
      // success/error/interrupted 都由持续轮询的 history 判定，不在事件里吞掉请求错误。
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', fallback);
    ws.addEventListener('close', fallback);
    return () => {
      stopped = true;
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', fallback);
      ws.removeEventListener('close', fallback);
      try { ws.close(); } catch {}
    };
  }

  function historyResult(h) {
    if (!h) return null;
    if (h.failed) return { ok: false, images: h.images, errorCode: h.errorCode, error: h.error };
    if (h.done) return { ok: true, images: h.images };
    return null;
  }

  async function waitPoll(id, onProgress, signal, pollMs) {
    const started = Date.now();
    let stageSent = '';
    for (;;) {
      checkSignal(signal);
      let h = await api.history(id, { signal });
      checkSignal(signal);
      let result = historyResult(h);
      if (result) return result;
      const q = await api.queue({ signal });
      checkSignal(signal);
      const running = inQueue(q && q.queue_running, id);
      if (!running && !inQueue(q && q.queue_pending, id)) {
        // history → queue 之间任务可能刚完成。二次读取才能安全判丢失。
        h = await api.history(id, { signal });
        checkSignal(signal);
        result = historyResult(h);
        if (result) return result;
        throw new ComfyError('COMFY_TASK_LOST', `ComfyUI 找不到任务 ${id}`, { prompt_id: id, status: h && h.raw_status });
      }
      const stage = running ? 'running' : 'queued';
      if (stage !== stageSent) {
        stageSent = stage;
        onProgress({ type: 'stage', stage, percent: null, elapsedMs: Date.now() - started });
      }
      await pause(pollMs, signal);
    }
  }

  return api;
}

module.exports = { createComfy, ComfyError, TYPE_CODE, HINTS, DEFAULT_BASE };