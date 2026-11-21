'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await pause(40);
  }
  const diag = typeof globalThis.__diag === 'function' ? globalThis.__diag() : '';
  throw new Error('等待超时：' + label + (diag ? ' · 状态快照 ' + diag : ''));
}

async function createFixture(root) {
  const output = path.join(root, 'comfy-output');
  fs.mkdirSync(output, { recursive: true });
  const fixture = { online: true, entries: new Map(), submits: 0, interrupts: 0, output };
  const server = http.createServer(async (req, res) => {
    const send = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (!fixture.online) return send(503, { error: { message: '测试：ComfyUI 离线' } });
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    if (req.url === '/system_stats') return send(200, { system: { comfyui_version: 'recovery-fixture' }, devices: [] });
    if (req.url === '/prompt' && req.method === 'POST') {
      fixture.submits++;
      const id = data.prompt_id;
      fixture.entries.set(id, { id, state: 'running', request: data, filename: id + '.mp4' });
      return send(200, { prompt_id: id, number: fixture.submits });
    }
    if (req.url.startsWith('/history/')) {
      const id = decodeURIComponent(req.url.slice('/history/'.length));
      const entry = fixture.entries.get(id);
      if (!entry || !['done', 'failed'].includes(entry.state)) return send(200, {});
      return send(200, { [id]: { status: { completed: true, status_str: entry.state === 'done' ? 'success' : 'error' }, outputs: { '1': { videos: [{ filename: entry.filename, subfolder: '', type: 'output' }] } } } });
    }
    if (req.url === '/queue' && req.method === 'GET') {
      const entries = [...fixture.entries.values()];
      return send(200, { queue_running: entries.filter((x) => x.state === 'running').map((x) => [0, x.id]), queue_pending: entries.filter((x) => x.state === 'pending').map((x) => [0, x.id]) });
    }
    if (req.url === '/queue' && req.method === 'POST') {
      for (const id of data.delete || []) fixture.entries.delete(id);
      return send(200, {});
    }
    if (req.url === '/interrupt') { fixture.interrupts++; return send(200, {}); }
    return send(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixture.base = 'http://127.0.0.1:' + server.address().port;
  fixture.complete = (id, write = true) => {
    const entry = fixture.entries.get(id);
    entry.state = 'done';
    if (write) fs.writeFileSync(path.join(output, entry.filename), Buffer.from('isolated-video-fixture-' + id));
  };
  fixture.close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return fixture;
}

async function startWorker(root, fixture) {
  const options = { jobsDir: path.join(root, 'jobs'), comfyUrl: fixture.base, archiveOptions: { outDir: path.join(root, 'works'), comfyOutput: fixture.output }, reconnectMs: 150 };
  const child = fork(__filename, ['--worker', JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, COMFY_WS: '0', COMFY_RETRIES: '0', AVP_ENV_FILE: path.join(root, 'no-keys.env'), CACHE_ROOT: root } });
  let output = '';
  child.stdout.on('data', (buf) => { output += buf; });
  child.stderr.on('data', (buf) => { output += buf; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('启动超时 ' + output)); }, 10000);
    child.once('message', (message) => { clearTimeout(timer); if (message.error) reject(new Error(message.error)); else resolve(message); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('后端提前退出 ' + code + ' ' + output)); });
  });
  return { child, base: 'http://127.0.0.1:' + ready.port, async stop(crash = false) {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    if (crash) child.kill('SIGKILL'); else child.send('stop');
    await exited;
  } };
}

async function request(worker, method, url, body) {
  const res = await fetch(worker.base + url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  return { status: res.status, data: await res.json() };
}

async function main() {
  const parent = path.join(process.env.CACHE_ROOT || 'D:/缓存', 'avp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'task-recovery-test-'));
  const fixture = await createFixture(root);
  let worker;
  let passed = 0;
  const check = (condition, label) => { assert.ok(condition, label); passed++; console.log('PASS ' + label); };
  const payload = { kind: 'local', model: 'minimax_h3', prompt: '隔离断点恢复测试', values: { 'kf.seed': 42 }, workflow: { '1': { class_type: 'SaveVideo', inputs: { filename_prefix: 'test' } } }, canvasSnapshot: { nodes: [{ id: 'canvas-1' }] }, experiment_id: 'recovery_exp' };
  const record = (id) => JSON.parse(fs.readFileSync(path.join(root, 'jobs', id + '.json'), 'utf8'));
  globalThis.__diag = () => {
    try {
      return fs.readdirSync(path.join(root, 'jobs')).filter((f) => /^job_.*\.json$/.test(f)).map((f) => {
        const j = JSON.parse(fs.readFileSync(path.join(root, 'jobs', f), 'utf8'));
        return (j.experiment_id || j.id) + '=' + j.status + '/' + ((j.progress || {}).stage || '-');
      }).join(',');
    } catch { return ''; }
  };
  try {
    fixture.online = false;
    worker = await startWorker(root, fixture);
    const accepted = await request(worker, 'POST', '/api/jobs', payload);
    const id = accepted.data.id;
    check(accepted.status === 202 && fs.existsSync(path.join(root, 'jobs', id + '.json')), '受理前任务已落盘');
    const initial = record(id);
    check(initial.task_id === id && initial.prompt === payload.prompt && initial.experiment_id === payload.experiment_id, '任务ID、提示词和实验ID持久化');
    check(initial.valueSnapshot['kf.seed'] === 42 && initial.canvasSnapshot.nodes[0].id === 'canvas-1', '参数与画布快照持久化');
    await until(() => record(id).progress.stage === 'waiting_comfy', '离线pending');
    check(record(id).status === 'pending' && !record(id).finishedAt && fixture.submits === 0, 'ComfyUI离线挂pending且未投递');
    await worker.stop(true);
    worker = await startWorker(root, fixture);
    check((await request(worker, 'GET', '/api/jobs')).data.jobs.some((j) => j.id === id), '重启恢复待处理任务历史');
    fixture.online = true;
    await until(() => record(id).comfyPromptId && record(id).progress.stage === 'running', '自动提交');
    const promptId = record(id).comfyPromptId;
    check(fixture.submits === 1 && record(id).comfySubmission.phase === 'submitted', '离线恢复后仅投递一次并保存队列ID');
    check(fixture.entries.get(promptId).request.extra_data.avp_task_id === id, '远端请求带持久任务ID');
    await new Promise((resolve, reject) => {
      const req = http.get(worker.base + '/api/jobs/' + id + '/events', (res) => {
        res.once('data', () => { res.destroy(); resolve(); });
      });
      req.on('error', reject);
    });
    check(fixture.entries.get(promptId).state === 'running' && fixture.interrupts === 0, '关闭前端进度连接不取消生成');
    await worker.stop(true);
    worker = await startWorker(root, fixture);
    await until(() => record(id).progress.stage === 'running', '恢复远端运行任务');
    check(record(id).comfyPromptId === promptId && fixture.submits === 1, '后端崩溃重启续接原队列、不重复提交');
    await assert.rejects(() => startWorker(root, fixture), /已有后端进程/);
    passed++; console.log('PASS 同任务表拒绝第二个调度进程');
    fixture.complete(promptId);
    await until(() => record(id).status === 'done', '归档完成');
    const done = record(id);
    check(done.output.file.includes('recovery_exp_') && done.output.file.endsWith('_pure.mp4') && fs.existsSync(done.output.file), 'done之前纯净版按实验ID落盘');
    check(fs.existsSync(done.output.file + '.task.json') && fs.existsSync(path.join(root, 'jobs', id + '.events.jsonl')), '任务产物元数据与日志永久按ID定位');
    const index = () => JSON.parse(fs.readFileSync(path.join(root, 'works', '_index.json'), 'utf8'));
    check(index().filter((x) => x.job_id === id).length === 1, '原始成片自动进入作品库且不重复登记');
    const output = await fetch(worker.base + '/api/jobs/' + id + '/output');
    check(output.status === 200 && (await output.arrayBuffer()).byteLength === done.output.bytes, '历史任务可取回完整视频');
    await worker.stop(); worker = await startWorker(root, fixture);
    check((await request(worker, 'GET', '/api/jobs/' + id)).data.status === 'done' && fixture.submits === 1, '完成任务重启后仍可查看且不重跑');

    const next = (await request(worker, 'POST', '/api/jobs', { ...payload, experiment_id: 'offline_complete' })).data.id;
    await until(() => record(next).comfyPromptId, '第二条提交');
    const nextPrompt = record(next).comfyPromptId;
    await worker.stop(true);
    fixture.complete(nextPrompt);
    worker = await startWorker(root, fixture);
    await until(() => record(next).status === 'done', '离线期间完成任务归档');
    check(fixture.submits === 2 && fs.existsSync(record(next).output.file), '后端退出期间Comfy完成，重启后自动取回入库');

    const missing = (await request(worker, 'POST', '/api/jobs', { ...payload, experiment_id: 'missing_file' })).data.id;
    // 冷启动 + 恢复期调度：首次运行实测需要 >12s，给足 30s（不是放宽断言，是放宽等待）
    await until(() => record(missing).comfyPromptId, '缺文件任务提交（恢复期冷启动）', 30000);
    const missingPrompt = record(missing).comfyPromptId;
    fixture.complete(missingPrompt, false);
    await until(() => record(missing).state === 'failed', '缺文件失败');
    const failed = (await request(worker, 'GET', '/api/jobs/' + missing)).data;
    check(failed.error.code === 'ARCHIVE_SOURCE_MISSING' && failed.canRetry && !failed.output, '文件缺失明确失败并提供重试入口');
    fixture.complete(missingPrompt, true);
    const retried = await request(worker, 'POST', '/api/jobs/' + missing + '/retry', {});
    check(retried.status === 202 && retried.data.id === missing, '失败重试保留原任务ID');
    await until(() => record(missing).status === 'done', '重试归档');
    check(fixture.submits === 3 && fs.existsSync(record(missing).output.file), '归档重试复用结果，不再次生成');
    check(index().filter((x) => x.job_id === missing).length === 1, '重试后作品库无重复条目');
    const conflict = await request(worker, 'POST', '/api/jobs/' + missing + '/retry', {});
    check(conflict.status === 409, '已完成任务不能误触重试');

    const detached = (await request(worker, 'POST', '/api/jobs', payload)).data.id;
    await until(() => record(detached).comfyPromptId, '优雅退出任务提交');
    const detachedPrompt = record(detached).comfyPromptId;
    await worker.stop();
    check(record(detached).status === 'pending' && fixture.interrupts === 0 && fixture.entries.get(detachedPrompt).state === 'running', '退出后台仅保存续接状态，不中断Comfy');
    fixture.complete(detachedPrompt);
    worker = await startWorker(root, fixture);
    await until(() => record(detached).status === 'done', '优雅退出后恢复');
    check(fixture.submits === 4, '多次重启仍使用原生成请求');
    console.log('全部通过（任务持久化/进程恢复 ' + passed + ' 项）');
  } finally {
    if (worker) await worker.stop();
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  const { createApp } = require('./app.js');
  (async () => {
    try {
      const svc = createApp(JSON.parse(process.argv[3]));
      const addr = await svc.listen(0);
      process.send({ port: addr.port });
      process.on('message', async (message) => {
        if (message !== 'stop') return;
        await svc.app.jobs.close();
        svc.server.closeAllConnections();
        svc.server.close(() => process.exit(0));
      });
    } catch (e) { process.send({ error: e.message }); process.exitCode = 1; process.disconnect(); }
  })();
} else if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { createFixture, startWorker, request, until };
