/** 隔离回归：只连接本文件创建的 127.0.0.1 随机端口 HTTP/WS 假服务，绝不生成 GPU 任务。 */
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const { getEventListeners } = require('node:events');
const { createComfy } = require('./comfy.js');
const { createComfyProvider } = require('./providers/comfy.js');

const clone = (value) => JSON.parse(JSON.stringify(value));
const workflow = () => ({ '1': { class_type: 'TestOutput', inputs: { seed: 42 } } });
const image = { filename: 'test.png', subfolder: '', type: 'output' };
const success = (outputs = { '1': { images: [image] } }) => ({ status: { status_str: 'success', completed: true }, outputs });
const submission = (phase) => ({ promptId: randomUUID(), clientId: 'avp-recovered', phase });
const hasId = (items, id) => items.some((item) => item[1] === id);
function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  if (payload.length < 126) header[1] = payload.length;
  else { header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  return Buffer.concat([header, payload]);
}

// 就算环境设置了真实 COMFY_URL，测试也不能误连。所有 fetch 必须命中当前自建服务。
const allowed = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  assert(allowed.has(new URL(url).origin), `禁止自测连接非模拟服务：${url}`);
  return realFetch(url, opts);
};
const originalWs = process.env.COMFY_WS;
process.env.COMFY_WS = '0';

async function fakeComfy(test, opts = {}) {
  const state = { history: new Map(), pending: [], running: [], requests: [], errors: [], sockets: new Set(), route: null, onPrompt: null, onUpgrade: null };
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : null;
      const request = { method: req.method, path: req.url, body };
      state.requests.push(request);
      if (state.route && await state.route(request, req, res)) return;
      if (req.url === '/system_stats') return json(res, { system: {}, devices: [] });
      if (req.method === 'POST' && req.url === '/prompt') {
        if (state.onPrompt && await state.onPrompt(body, req, res)) return;
        const id = body.prompt_id || randomUUID();
        state.history.set(id, success());
        return json(res, { prompt_id: id, number: 1 });
      }
      if (req.url.startsWith('/history/')) {
        const id = decodeURIComponent(req.url.slice('/history/'.length));
        return json(res, state.history.has(id) ? { [id]: state.history.get(id) } : {});
      }
      if (req.method === 'GET' && req.url === '/queue') return json(res, { queue_pending: state.pending, queue_running: state.running });
      if (req.method === 'POST' && req.url === '/queue') {
        assert.deepEqual(Object.keys(body), ['delete']);
        state.pending = state.pending.filter((item) => !body.delete.includes(item[1]));
        res.writeHead(200); return res.end();
      }
      if (req.method === 'POST' && req.url === '/interrupt') { res.writeHead(200); return res.end(); }
      json(res, { error: 'unexpected route' }, 404);
    } catch (e) { state.errors.push(e); if (!res.headersSent) json(res, { error: e.message }, 500); else res.destroy(); }
  });
  server.on('upgrade', (req, socket) => {
    state.sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => state.sockets.delete(socket));
    if (!state.onUpgrade) { socket.destroy(); return; }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('data', (data) => { if ((data[0] & 15) === 8) socket.end(Buffer.from([0x88, 0])); });
    state.onUpgrade((message) => socket.write(frame(message)), req);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.notEqual(server.address().port, 8188);
  allowed.add(base);
  const comfy = createComfy({ base, retries: 0, timeoutMs: 500, ...opts });
  const waitFor = comfy.waitFor;
  comfy.waitFor = (id, options) => waitFor(id, { pollMs: 5, ...options });
  state.comfy = comfy;
  state.provider = createComfyProvider({ comfy });
  state.posts = (path = '/prompt') => state.requests.filter((r) => r.method === 'POST' && r.path === path);
  state.reads = (path) => state.requests.filter((r) => r.method === 'GET' && r.path === path);
  try { await test(state); assert.deepEqual(state.errors, []); }
  finally {
    for (const socket of state.sockets) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    allowed.delete(base);
  }
}

// 模拟同步 JSON 存储，恢复时只用序列化后的对象，不能靠旧实例的内存隐藏状态。
function durableJob(job) {
  let saved = clone(job);
  const phases = [], submitted = [];
  return {
    phases, submitted,
    load: () => clone(saved),
    hooks: {
      onCheckpoint(patch) { saved = { ...saved, ...clone(patch) }; phases.push(saved.comfySubmission.phase); },
      onSubmitted({ taskId, meta }) {
        saved = { ...saved, comfyPromptId: taskId, providerTaskId: taskId, ...clone(meta) };
        submitted.push(taskId);
      },
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('正常编译：prepared → submitting → submitted 在 POST 两侧同步保存', () => fakeComfy(async (s) => {
  const job = { id: 'normal', experimentId: 'exp-42', template: workflow(), valueSnapshot: { seed: 99 }, canvasSnapshot: { nodes: ['saved'] } };
  const durable = durableJob(job);
  const provider = createComfyProvider({ comfy: s.comfy, registry: { params: [{ key: 'seed', type: 'int', min: 0, max: 1000, default: 7, bind: { target: 'TestOutput', widget: 'seed' } }] } });
  s.onPrompt = (body) => {
    const saved = durable.load();
    assert.deepEqual(durable.phases, ['prepared', 'submitting']);
    assert.equal(saved.comfySubmission.promptId, body.prompt_id);
    assert.match(body.prompt_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(body.client_id, 'avp-normal');
    assert.deepEqual(body.extra_data, { avp_task_id: 'normal', experiment_id: 'exp-42' });
    assert.deepEqual(body.prompt, saved.workflow);
    assert.equal(body.prompt['1'].inputs.seed, 99);
    assert.equal(saved.comfyPromptId, undefined);
  };
  const result = await provider.run(job, durable.hooks);
  assert.equal(s.posts().length, 1);
  assert.equal(result.images[0].filename, 'test.png');
  assert.equal(durable.load().comfySubmission.phase, 'submitted');
  assert.equal(durable.load().providerTaskId, result.taskId);
  assert.deepEqual(durable.load().canvasSnapshot, { nodes: ['saved'] });
  assert.equal(job.template['1'].inputs.seed, 42);
}));

for (const field of ['comfyPromptId', 'providerTaskId']) {
  test(`已有 ${field}：不编译、不探测、不 POST`, () => fakeComfy(async (s) => {
    const id = randomUUID();
    s.history.set(id, success());
    const job = { id: 'confirmed', [field]: id };
    Object.defineProperty(job, 'workflow', { get() { throw new Error('恢复不可读取/编译 workflow'); } });
    const result = await s.provider.run(job);
    assert.equal(result.taskId, id);
    assert.equal(s.posts().length, 0);
    assert.equal(s.reads('/system_stats').length, 0);
  }));
}

test('confirmed 队列续等：未知百分比为 null', () => fakeComfy(async (s) => {
  const id = randomUUID(), progress = [];
  s.pending = [[1, id]];
  let reads = 0;
  s.route = (r) => {
    if (r.path === '/history/' + id && ++reads === 3) s.history.set(id, success());
    if (r.path === '/queue' && reads === 2) { s.pending = []; s.running = [[1, id]]; }
  };
  await s.provider.run({ id: 'waiting', comfyPromptId: id }, { onProgress: (p) => progress.push(p) });
  assert.deepEqual(progress.map((p) => p.stage), ['queued', 'running']);
  assert(progress.every((p) => p.percent === null));
  assert.equal(s.posts().length, 0);
}));

test('prepared 恢复只提交已固定 workflow / UUID / clientId', () => fakeComfy(async (s) => {
  const job = { id: 'prepared', comfySubmission: submission('prepared'), workflow: workflow(), template: { broken: true }, valueSnapshot: { seed: 987 } };
  const durable = durableJob(job);
  const result = await s.provider.run(durable.load(), durable.hooks);
  const body = s.posts()[0].body;
  assert.equal(result.taskId, job.comfySubmission.promptId);
  assert.equal(body.client_id, job.comfySubmission.clientId);
  assert.deepEqual(body.prompt, job.workflow);
  assert.deepEqual(durable.phases, ['submitting']);
}));

test('检查点写失败阻止 POST', () => fakeComfy(async (s) => {
  for (const phase of ['prepared', 'submitting']) {
    const err = new Error('storage unavailable');
    await assert.rejects(s.provider.run({ id: phase, workflow: workflow() }, {
      onCheckpoint(patch) { if (patch.comfySubmission.phase === phase) throw err; },
    }), (e) => e === err);
  }
  assert.equal(s.posts().length, 0);
}));

test('prepared 缺 workflow 不重新编译/不提交', () => fakeComfy(async (s) => {
  await assert.rejects(s.provider.run({ id: 'broken', comfySubmission: submission('prepared'), template: workflow() }), { code: 'WF_BAD_TEMPLATE' });
  assert.equal(s.posts().length, 0);
}));

for (const location of ['history', 'queue_pending', 'queue_running', 'history-race']) {
  test(`submitting 对账 ${location} 后 onSubmitted 续接`, () => fakeComfy(async (s) => {
    const job = { id: 'reconcile', comfySubmission: submission('submitting') };
    const id = job.comfySubmission.promptId, durable = durableJob(job);
    if (location === 'history') s.history.set(id, success());
    if (location === 'queue_pending') s.pending = [[1, id]];
    if (location === 'queue_running') s.running = [[1, id]];
    let reads = 0;
    s.route = (r) => {
      if (r.path === '/history/' + id && ++reads === 3) s.history.set(id, success());
      if (location === 'history-race' && r.path === '/queue') s.history.set(id, success());
    };
    const result = await s.provider.run(durable.load(), durable.hooks);
    assert.equal(result.taskId, id);
    assert.deepEqual(durable.submitted, [id]);
    assert.equal(durable.load().comfySubmission.phase, 'submitted');
    assert.equal(s.posts().length, 0);
    assert.equal(s.reads('/system_stats').length, 0);
  }));
}

test('submitting 查无记录：反复恢复也不盲重投', () => fakeComfy(async (s) => {
  const job = { id: 'uncertain', comfySubmission: submission('submitting'), workflow: workflow() };
  const durable = durableJob(job);
  for (let i = 0; i < 2; i++) await assert.rejects(s.provider.run(durable.load(), durable.hooks), { code: 'COMFY_SUBMISSION_UNCERTAIN' });
  assert.equal(s.reads('/history/' + job.comfySubmission.promptId).length, 4);
  assert.equal(s.posts().length, 0);
  assert.equal(durable.load().comfySubmission.phase, 'submitting');
  assert.equal(durable.submitted.length, 0);
}));

for (const accepted of [true, false]) {
  test(`初次 POST 断网（accepted=${accepted}）：不重试 POST，重启只对账`, () => fakeComfy(async (s) => {
    const job = { id: 'dropped', workflow: workflow() }, durable = durableJob(job);
    s.onPrompt = (body, req) => {
      if (accepted) s.history.set(body.prompt_id, success());
      req.socket.destroy(); return true;
    };
    await assert.rejects(s.provider.run(job, durable.hooks), { code: 'COMFY_UNREACHABLE' });
    assert.equal(s.posts().length, 1);
    assert.equal(durable.load().comfySubmission.phase, 'submitting');
    assert.equal(durable.load().providerTaskId, undefined);
    const provider = createComfyProvider({ comfy: s.comfy });
    if (accepted) await provider.run(durable.load(), durable.hooks);
    else await assert.rejects(provider.run(durable.load(), durable.hooks), { code: 'COMFY_SUBMISSION_UNCERTAIN' });
    assert.equal(s.posts().length, 1);
  }, { retries: 3 }));
}

test('POST 超时保留 submitting；远端已接受可恢复', () => fakeComfy(async (s) => {
  const job = { id: 'timeout', workflow: workflow() }, durable = durableJob(job);
  s.onPrompt = (body) => { s.history.set(body.prompt_id, success()); return true; };
  await assert.rejects(s.provider.run(job, durable.hooks), { code: 'COMFY_TIMEOUT' });
  assert.equal(durable.load().comfySubmission.phase, 'submitting');
  await s.provider.run(durable.load(), durable.hooks);
  assert.equal(s.posts().length, 1);
}, { timeoutMs: 80, retries: 2 }));

test('POST 5xx/坏 JSON 不自动重试；旧 prompt(workflow) 仍可用', () => fakeComfy(async (s) => {
  for (const response of ['500', 'invalid-json']) {
    s.onPrompt = (body, req, res) => {
      if (response === '500') json(res, { error: 'unavailable' }, 500);
      else { res.writeHead(200); res.end('invalid'); }
      return true;
    };
    await assert.rejects(s.comfy.prompt(workflow()), { code: response === '500' ? 'COMFY_HTTP_ERROR' : 'COMFY_BAD_RESPONSE' });
  }
  assert.equal(s.posts().length, 2);
  s.onPrompt = null;
  const result = await s.comfy.prompt(workflow());
  assert.equal(typeof result.prompt_id, 'string');
  assert.equal(s.posts()[2].body.client_id, 'avp');
  assert.equal(s.posts()[2].body.prompt_id, undefined);
}, { retries: 2 }));

test('返回 ID 即确认提交（其它输出节点警告不能丢 ID）', () => fakeComfy(async (s) => {
  const job = { id: 'warning', workflow: workflow() }, durable = durableJob(job);
  s.onPrompt = (body, req, res) => {
    s.history.set(body.prompt_id, success());
    json(res, { prompt_id: body.prompt_id, node_errors: { unused: { errors: [] } } }); return true;
  };
  await s.provider.run(job, durable.hooks);
  assert.equal(durable.submitted.length, 1);
}));

test('确认回调失败后保留 submitting，恢复不重复生成', () => fakeComfy(async (s) => {
  const job = { id: 'submit-storage-failure', workflow: workflow() }, durable = durableJob(job);
  const failure = new Error('cannot persist confirmation');
  await assert.rejects(s.provider.run(job, { ...durable.hooks, onSubmitted() { throw failure; } }), (e) => e === failure);
  assert.equal(durable.load().comfySubmission.phase, 'submitting');
  await s.provider.run(durable.load(), durable.hooks);
  assert.equal(s.posts().length, 1);
}));

for (const state of ['new', 'confirmed', 'submitting']) {
  test(`离线 ${state}：原 COMFY_UNREACHABLE，不模拟成功`, () => fakeComfy(async (s) => {
    const job = { id: 'offline', workflow: workflow() };
    if (state === 'confirmed') job.comfyPromptId = randomUUID();
    if (state === 'submitting') job.comfySubmission = submission('submitting');
    const durable = durableJob(job);
    s.route = (r, req) => { req.socket.destroy(); return true; };
    await assert.rejects(s.provider.run(job, durable.hooks), { code: 'COMFY_UNREACHABLE' });
    assert.equal(s.posts().length, 0);
    if (state === 'new') assert.equal(durable.load().comfySubmission.phase, 'prepared');
  }));
}

test('history/queue 超时及 queue 网络错误向上传递', () => fakeComfy(async (s) => {
  for (const failPath of ['/history/', '/queue']) {
    for (const code of ['COMFY_TIMEOUT', 'COMFY_UNREACHABLE']) {
      s.route = (r, req) => {
        if (r.path.startsWith(failPath)) { if (code === 'COMFY_UNREACHABLE') req.socket.destroy(); return true; }
      };
      await assert.rejects(s.comfy.waitFor(randomUUID()), { code });
    }
  }
}, { timeoutMs: 80 }));

for (const race of [false, true]) {
  test(`队列无 ID 二次 history（完成竞态=${race}）`, () => fakeComfy(async (s) => {
    const id = randomUUID();
    s.running = [[1, 'someone-else']];
    s.route = (r) => { if (race && r.path === '/queue') s.history.set(id, success()); };
    if (race) assert.equal((await s.comfy.waitFor(id)).ok, true);
    else await assert.rejects(s.comfy.waitFor(id), { code: 'COMFY_TASK_LOST' });
    assert.equal(s.reads('/history/' + id).length, 2);
    assert.equal(s.posts().length, 0);
  }));
}

for (const [status, code] of [
  [{ status_str: 'error', completed: true }, 'COMFY_EXEC_ERROR'],
  [{ status_str: 'interrupted', completed: true }, 'COMFY_INTERRUPTED'],
  [{ status_str: 'error', completed: false, messages: [['execution_interrupted', { node_id: '1' }]] }, 'COMFY_INTERRUPTED'],
  [{ status_str: 'success', completed: true, messages: [['execution_error', { exception_message: 'GPU failed' }]] }, 'COMFY_EXEC_ERROR'],
]) {
  test(`错误 history ${JSON.stringify(status)} 不当成功`, () => fakeComfy(async (s) => {
    const id = randomUUID();
    s.history.set(id, { status, outputs: { '1': { images: [image] } } });
    const history = await s.comfy.history(id);
    assert.equal(history.done, false);
    const result = await s.comfy.waitFor(id);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, code);
    await assert.rejects(s.provider.run({ id: 'failed', comfyPromptId: id }), { code });
    const resumed = { id: 'failed-reconcile', comfySubmission: { promptId: id, clientId: 'avp-failed', phase: 'submitting' } };
    const durable = durableJob(resumed);
    await assert.rejects(s.provider.run(resumed, durable.hooks), { code });
    assert.deepEqual(durable.submitted, [id]);
  }));
}

test('completed/outputs 非空但无 success 不算成功', () => fakeComfy(async (s) => {
  const id = randomUUID();
  s.running = [[1, id]];
  s.history.set(id, { status: { completed: true }, outputs: { '1': { images: [image] } } });
  assert.equal((await s.comfy.history(id)).done, false);
  let reads = 0;
  s.route = (r) => { if (r.path === '/history/' + id && ++reads === 2) s.history.set(id, success()); };
  assert.equal((await s.comfy.waitFor(id)).ok, true);
  assert.equal(reads, 2);
}));

test('images/videos/gifs 文件描述归一去重，保留节点/子目录', () => fakeComfy(async (s) => {
  const id = randomUUID(), video = { filename: 'clip.mp4', subfolder: 'exp', type: 'output', format: 'video/h264' };
  s.history.set(id, success({
    '1': { images: [image], videos: [video] },
    '2': { gifs: [video, { filename: 'preview.gif', type: 'output' }] },
    '3': { videos: [{ ...video, subfolder: 'other' }], images: [null, {}, image] },
  }));
  const result = await s.provider.run({ id: 'videos', comfyPromptId: id });
  assert.equal(result.images.length, 4);
  assert.equal(result.images.filter((f) => f.filename === 'clip.mp4' && f.subfolder === 'exp').length, 1);
  assert.equal(result.images.find((f) => f.filename === 'clip.mp4').node, '1');
  assert(result.images.some((f) => f.filename === 'preview.gif'));
}));

test('signal 已取消/脱离：不请求远端；JOB_DETACHED 原对象抛出', () => fakeComfy(async (s) => {
  for (const detach of [false, true]) {
    const ac = new AbortController();
    const reason = Object.assign(new Error('backend closing'), { code: 'JOB_DETACHED' });
    ac.abort(detach ? reason : undefined);
    if (detach) await assert.rejects(s.comfy.waitFor(randomUUID(), { signal: ac.signal }), (e) => e === reason);
    else assert.equal((await s.comfy.waitFor(randomUUID(), { signal: ac.signal })).canceled, true);
    await assert.rejects(s.provider.run({ id: 'aborted', workflow: workflow() }, { signal: ac.signal }), { code: detach ? 'JOB_DETACHED' : 'JOB_CANCELED' });
  }
  assert.equal(s.requests.length, 0);
}));

for (const during of ['request', 'poll-delay']) {
  test(`等待 ${during} 时 detach 及时停止，不隐式 interrupt`, () => fakeComfy(async (s) => {
    const id = randomUUID(), ac = new AbortController();
    const reason = Object.assign(new Error('shutdown'), { code: 'JOB_DETACHED' });
    s.running = [[1, id]];
    if (during === 'request') s.route = (r) => { if (r.path.startsWith('/history/')) { ac.abort(reason); return true; } };
    await assert.rejects(s.comfy.waitFor(id, {
      signal: ac.signal, pollMs: 60000,
      onProgress() { if (during === 'poll-delay') queueMicrotask(() => ac.abort(reason)); },
    }), (e) => e === reason);
    assert.equal(s.posts('/interrupt').length, 0);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  }));
}

test('POST 返回前 detach 仍先保存 confirmed ID', () => fakeComfy(async (s) => {
  const ac = new AbortController(), job = { id: 'detached-submit', workflow: workflow() }, durable = durableJob(job);
  const reason = Object.assign(new Error('shutdown'), { code: 'JOB_DETACHED' });
  s.onPrompt = () => { ac.abort(reason); };
  await assert.rejects(s.provider.run(job, { ...durable.hooks, signal: ac.signal }), (e) => e === reason);
  assert.equal(durable.load().comfySubmission.phase, 'submitted');
  assert.equal(durable.submitted.length, 1);
  assert.equal(s.posts('/interrupt').length, 0);
}));

test('定点取消 queued/running/缺 ID/其它任务，不发送全局 interrupt', () => fakeComfy(async (s) => {
  const id = randomUUID(), other = randomUUID();
  s.pending = [[1, id], [2, other]]; s.running = [[0, other]];
  await s.provider.cancel({ comfyPromptId: id });
  assert.deepEqual(s.posts('/queue')[0].body, { delete: [id] });
  assert(hasId(s.pending, other));
  assert.equal(s.posts('/interrupt').length, 0);
  s.running = [[1, id]];
  await s.provider.cancel({ providerTaskId: id });
  assert.deepEqual(s.posts('/interrupt')[0].body, { prompt_id: id });
  s.running = [[1, other]];
  assert.equal((await s.provider.cancel({ comfyPromptId: id })).remote, false);
  assert.equal((await s.provider.cancel({ id: 'not-remote' })).remote, false);
  assert.equal((await s.provider.cancel({ comfySubmission: { promptId: other, phase: 'prepared' } })).remote, false);
  assert.equal(s.posts('/interrupt').length, 1);
}));

test('取消期间 pending → running 切换：复核同 ID 后定点 interrupt', () => fakeComfy(async (s) => {
  const id = randomUUID(); s.pending = [[1, id]];
  s.route = (r) => { if (r.method === 'POST' && r.path === '/queue') { s.pending = []; s.running = [[1, id]]; } };
  await s.provider.cancel({ comfySubmission: { promptId: id, phase: 'submitting' } });
  assert.deepEqual(s.posts('/queue')[0].body, { delete: [id] });
  assert.deepEqual(s.posts('/interrupt')[0].body, { prompt_id: id });
}));

for (const mode of ['silent', 'success-event', 'history-error', 'history-offline', 'lost', 'disconnect']) {
  test(`WS ${mode}：仍以后台 history/queue 为准`, async () => {
    process.env.COMFY_WS = '1';
    try {
      await fakeComfy(async (s) => {
        const id = randomUUID(), progress = [];
        let upgraded;
        const ready = new Promise((resolve) => { upgraded = resolve; });
        s.running = mode === 'lost' ? [] : [[1, id]];
        s.onUpgrade = (send, req) => {
          assert.equal(new URL(req.url, s.comfy.base).searchParams.get('clientId'), 'avp-ws');
          if (mode !== 'silent') {
            send({ type: 'execution_start', data: { prompt_id: id } });
            send({ type: 'progress', data: { prompt_id: 'other', value: 99, max: 100 } });
            send({ type: 'progress', data: { prompt_id: id, value: 1, max: 4 } });
            send({ type: 'execution_success', data: { prompt_id: id } });
          }
          if (mode === 'disconnect') for (const socket of s.sockets) socket.end();
          upgraded();
        };
        let reads = 0;
        s.route = async (r, req) => {
          if (r.path !== '/history/' + id) return;
          await ready;
          reads += 1;
          if (reads === 1 || mode === 'lost') return;
          if (mode === 'history-offline') { req.socket.destroy(); return true; }
          s.history.set(id, mode === 'history-error' ? { status: { status_str: 'error', completed: true }, outputs: { '1': { images: [image] } } } : success());
        };
        const waiting = s.comfy.waitFor(id, { clientId: 'avp-ws', onProgress: (p) => progress.push(p) });
        if (mode === 'history-offline') await assert.rejects(waiting, { code: 'COMFY_UNREACHABLE' });
        else if (mode === 'lost') await assert.rejects(waiting, { code: 'COMFY_TASK_LOST' });
        else {
          const result = await waiting;
          assert.equal(result.ok, mode !== 'history-error');
          if (mode === 'history-error') assert.equal(result.errorCode, 'COMFY_EXEC_ERROR');
          else assert.equal(result.images.length, 1);
        }
        assert(reads >= 2);
        assert(s.reads('/queue').length >= 1);
        if (mode === 'success-event') assert(progress.some((p) => p.percent === 25));
        assert(progress.every((p) => p.percent === null || p.percent === 25));
      });
    } finally { process.env.COMFY_WS = '0'; }
  });
}

(async () => {
  let passed = 0;
  try {
    for (const [name, run] of tests) {
      // 回归到“永远 running”时也必须有限时间失败，不能让自测自身无限等待。
      const deadline = setTimeout(() => { console.error('FAIL 超过 10 秒：' + name); process.exit(1); }, 10000);
      deadline.unref();
      try { await run(); } finally { clearTimeout(deadline); }
      passed += 1; console.log('PASS ' + name);
    }
    console.log(`通过 ${passed} / ${tests.length}（仅本地模拟 HTTP/WS，无真实 ComfyUI/GPU）`);
    console.log('全部通过');
  } catch (e) { console.error(`FAIL ${tests[passed][0]}\n`, e); process.exitCode = 1; }
  finally {
    globalThis.fetch = realFetch;
    if (originalWs === undefined) delete process.env.COMFY_WS;
    else process.env.COMFY_WS = originalWs;
  }
})();
