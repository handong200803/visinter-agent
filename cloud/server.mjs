/**
 * cloud/server.mjs —— 云端后端（Node 22 内置模块，零第三方依赖）
 *
 * 启动：node cloud/server.mjs [--port 8787]
 * 环境变量见 .env.example
 *
 * 接口（全部 JSON，CORS 允许 ALLOW_ORIGIN）：
 *   GET  /api/config                     能力、模型白名单、配额
 *   POST /api/keyframes                  生成 N 张候选（生图 provider）→ 返回 taskId
 *   GET  /api/keyframes/:id              候选列表 + 各自分数 + 选中项
 *   POST /api/keyframes/:id/select       手动改选 {index}
 *   POST /api/video                      提交视频（可带首帧 dataURI/URL）→ taskId
 *   GET  /api/video/:id                  视频任务状态
 *   GET  /api/tasks?state=&kind=         任务列表
 *   GET  /api/tasks/:id                  任务详情
 *   POST /api/tasks/:id/retry            失败重试
 *   POST /api/scores                     对候选打分（灰度像素或 imageUrl）
 *   GET  /api/scores/:taskId             取分数
 *   POST /api/experiments                记录一次对照实验（需 ADMIN_TOKEN）
 *   GET  /api/experiments?kind=          实验列表
 *   POST /api/optimize                   贝叶斯寻优一轮（需 ADMIN_TOKEN）
 *   GET  /api/optimize/:id               寻优历史
 *   GET  /api/library                    作品库
 *   POST /api/library                    入库（内部调用/管理）
 *   GET  /files/:key                     对象流（本地卷后端）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ApiError, fail, store, objects, openDb, paths, STATES } from './core.mjs';
import { capability, provider, providers, videoSeedance, imageArk, evalQwen } from './providers.mjs';
import { scoreCandidate, total, WEIGHTS } from './scoring.mjs';
import * as PP from './postprocess.mjs';

const PORT = Number(process.env.PORT || process.argv.includes('--port') ? (process.argv[process.argv.indexOf('--port') + 1] || process.env.PORT) : 8787) || 8787;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const DEMO_QUOTA = Number(process.env.DEMO_QUOTA || 20);      // 每 IP 每日生成次数上限（0=不限）
const POLL_MS = Number(process.env.POLL_MS || 6000);
const MAX_WAIT_MS = Number(process.env.MAX_WAIT_MS || 30 * 60 * 1000);

openDb();

/* ── 简单配额（内存，按天重置） ──────────────────── */
const quota = new Map();
const today = () => new Date().toISOString().slice(0, 10);
function takeQuota(ip) {
  if (!DEMO_QUOTA) return true;
  const k = today() + '|' + ip;
  const n = (quota.get(k) || 0) + 1;
  if (n > DEMO_QUOTA) fail('QUOTA', `今日演示配额已用完（${DEMO_QUOTA} 次/天）`);
  quota.set(k, n);
  return true;
}

/* ── 在飞任务（内存驱动，进程重启后可续查询上游） ── */
const drivers = new Map();

function startVideoDriver(taskId) {
  const t = store.getTask(taskId);
  const prov = providers['video:' + t.provider] || videoSeedance;
  const t0 = Date.now();
  const tick = async () => {
    const cur = store.getTask(taskId);
    if (!cur || ['succeeded', 'failed', 'expired', 'cancelled'].includes(cur.state)) { drivers.delete(taskId); return; }
    try {
      if (Date.now() - t0 > MAX_WAIT_MS) {
        store.updateTask(taskId, { state: 'expired', error: { code: 'UPSTREAM_TIMEOUT', message: '等待超时（30 分钟）' } });
        drivers.delete(taskId); return;
      }
      const st = await prov.pollTask({}, cur.upstream_id);
      if (st.status === 'succeeded') {
        const res = await prov.fetchResult({}, cur.upstream_id, st);
        const buf = await fetch(res.url, { signal: AbortSignal.timeout(180000) }).then((r) => r.arrayBuffer()).catch(() => null);
        let key = null, url = res.url;
        if (buf) {
          key = `videos/${taskId}.mp4`;
          const put = await objects.put(key, Buffer.from(buf), 'video/mp4');
          url = put.url;
        }
        store.updateTask(taskId, { state: 'succeeded', output_url: url, output_key: key, ms: Date.now() - t0, error: null });
        store.addLibrary({ task_id: taskId, title: (cur.prompt || '').slice(0, 60) || '云端视频', provider: cur.provider, model: cur.model, variant: cur.variant || 'native', key, url, bytes: buf ? buf.byteLength : null, meta: { tokens: res.meta?.tokens || null } });
        drivers.delete(taskId); return;
      }
      if (['failed', 'expired', 'cancelled'].includes(st.status)) {
        const e = st.raw?.error || {};
        store.updateTask(taskId, { state: st.status, error: { code: 'UPSTREAM_FAILED', message: e.message || e.code || st.status } });
        drivers.delete(taskId); return;
      }
      store.updateTask(taskId, { state: 'running' });
    } catch (e) {
      store.updateTask(taskId, { state: 'failed', error: { code: e.code || 'UPSTREAM_FAILED', message: e.message } });
      drivers.delete(taskId);
    }
  };
  drivers.set(taskId, setInterval(tick, POLL_MS));
  setTimeout(tick, 1200);
}

/* ── HTTP ─────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '-';
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const send = (code, obj, extra = {}) => {
    const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    res.writeHead(code, {
      'Content-Type': Buffer.isBuffer(obj) ? (extra.type || 'application/octet-stream') : 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
      'Access-Control-Allow-Headers': 'content-type,authorization,x-admin-token',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': ALLOW_ORIGIN, 'Access-Control-Allow-Headers': 'content-type,authorization,x-admin-token', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Max-Age': '86400' }); return res.end(); }

  const body = async () => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (!raw.length) return {};
    if (raw.length > 12 * 1024 * 1024) fail('BAD_REQUEST', '请求体过大（>12MB）');
    // 严格 UTF-8：非 UTF-8 字节（例如 GBK 中文）必须 400，不能静默存成乱码（2026-11-21 实测发现）
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
      fail('BAD_REQUEST', '请求体不是合法 UTF-8（请以 UTF-8 编码发送 JSON）');
    }
    try { return JSON.parse(text); } catch { fail('BAD_REQUEST', 'JSON 解析失败'); }
  };
  const needAdmin = () => {
    if (!ADMIN_TOKEN) return;
    const t = req.headers['x-admin-token'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (t !== ADMIN_TOKEN) fail('UNAUTHORIZED', '需要管理令牌');
  };

  try {
    /* 对象流 */
    if (p.startsWith('/files/')) {
      const key = decodeURIComponent(p.slice('/files/'.length));
      const buf = await objects.get(key);
      const type = /\.mp4$/i.test(key) ? 'video/mp4' : /\.png$/i.test(key) ? 'image/png' : /\.jpe?g$/i.test(key) ? 'image/jpeg' : 'application/octet-stream';
      return send(200, buf, { type });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return send(200, { ...capability(), postprocess: PP.capability(), quota: { perDay: DEMO_QUOTA }, weights: WEIGHTS, states: STATES });
    }

    /* 关键帧：生成 N 张候选 */
    if (p === '/api/keyframes' && req.method === 'POST') {
      takeQuota(ip);
      const b = await body();
      const prov = provider('image');
      const count = Math.max(1, Math.min(6, Number(b.count || 4)));
      const baseSeed = Number(b.seed || Math.floor(Math.random() * 1e6));
      const t = store.createTask({ kind: 'keyframes', provider: prov.id, model: prov.models()[0], state: 'running', prompt: b.prompt, params: { count, size: b.size, baseSeed } });
      const cands = [];
      // 生图 provider 有两种形态：
      //   · 同步（火山方舟 images/generations）：submitTask 直接回 url
      //   · 异步（通义万相）：submitTask 只回 task_id，必须轮询 /api/v1/tasks 拿 results[].url
      // 这里统一处理，否则接万相会拿到 undefined url。
      const settleImage = async (r) => {
        if (r && r.url) return r.url;
        if (!r || !r.upstreamId) fail('UPSTREAM_FAILED', '生图未返回 url 也未返回 task_id');
        const t0 = Date.now();
        let last = null;
        for (;;) {
          if (Date.now() - t0 > 5 * 60 * 1000) fail('UPSTREAM_TIMEOUT', '生图轮询超时（5 分钟）');
          await new Promise((res) => setTimeout(res, 3000));
          last = await prov.pollTask({}, r.upstreamId);
          if (last.status === 'succeeded') break;
          if (['failed', 'expired', 'cancelled'].includes(last.status)) fail('UPSTREAM_FAILED', '生图任务' + last.status, last.raw);
        }
        const got = await prov.fetchResult({}, r.upstreamId, last);
        return got.url;
      };

      for (let i = 0; i < count; i += 1) {
        try {
          const sub = await prov.submitTask({}, { prompt: b.prompt, size: b.size, seed: baseSeed + i * 7919, model: b.model });
          const url = await settleImage(sub);
          const sc = await scoreCandidate({ prompt: b.prompt, imageUrl: url, gray: null, w: 0, h: 0 }).catch(() => null);
          const sem = sc ? sc.semantic : null;
          cands.push({ index: i, url, seed: baseSeed + i * 7919, score: sem == null ? null : { Sstyle: sem } });
        } catch (e) {
          cands.push({ index: i, error: { code: e.code || 'UPSTREAM_FAILED', message: e.message } });
        }
      }
      const ok = cands.filter((c) => c.url);
      if (!ok.length) { store.updateTask(t.id, { state: 'failed', error: { code: 'UPSTREAM_FAILED', message: '全部候选生成失败', detail: cands } }); fail('UPSTREAM_FAILED', '全部候选生成失败', cands); }
      const best = ok[0];
      store.updateTask(t.id, { state: 'succeeded', selected: best.url, params: { count, baseSeed, candidates: cands } });
      return send(200, { id: t.id, state: 'succeeded', provider: prov.id, candidates: cands, selected: best.url });
    }

    const kf = p.match(/^\/api\/keyframes\/([^/]+)(\/select)?$/);
    if (kf && req.method === 'GET' && !kf[2]) {
      const t = store.getTask(decodeURIComponent(kf[1]));
      if (!t) fail('NOT_FOUND', '关键帧任务不存在');
      return send(200, t);
    }
    if (kf && kf[2] && req.method === 'POST') {
      const b = await body();
      const t = store.getTask(decodeURIComponent(kf[1]));
      if (!t) fail('NOT_FOUND', '关键帧任务不存在');
      const idx = Number(b.index);
      const c = (t.params?.candidates || [])[idx];
      if (!c || !c.url) fail('BAD_REQUEST', '候选不存在');
      return send(200, store.updateTask(t.id, { selected: c.url }));
    }

    /* 视频 */
    if (p === '/api/video' && req.method === 'POST') {
      takeQuota(ip);
      const b = await body();
      const prov = provider('video', b.provider);
      const t = store.createTask({
        kind: 'video', provider: prov.id, model: b.model || prov.models()[0], state: 'submitting',
        prompt: b.prompt, variant: b.variant === 'enhanced' ? 'native' : 'native',
        params: { resolution: b.resolution, ratio: b.ratio, duration: b.duration, seed: b.seed, first_frame: b.first_frame ? String(b.first_frame).slice(0, 64) + '…' : null },
      });
      try {
        const r = await prov.submitTask({}, b);
        store.updateTask(t.id, { upstream_id: r.upstreamId, state: 'running' });
        startVideoDriver(t.id);
        return send(202, { id: t.id, state: 'running', upstream_id: r.upstreamId, poll: `/api/video/${t.id}` });
      } catch (e) {
        store.updateTask(t.id, { state: 'failed', error: { code: e.code || 'UPSTREAM_FAILED', message: e.message } });
        throw e;
      }
    }
    const vd = p.match(/^\/api\/video\/([^/]+)$/);
    if (vd && req.method === 'GET') {
      const t = store.getTask(decodeURIComponent(vd[1]));
      if (!t) fail('NOT_FOUND', '视频任务不存在');
      return send(200, t);
    }

    /* 任务 */
    if (p === '/api/tasks' && req.method === 'GET') {
      return send(200, { items: store.listTasks({ state: u.searchParams.get('state'), kind: u.searchParams.get('kind'), limit: u.searchParams.get('limit') || 50, offset: u.searchParams.get('offset') || 0 }) });
    }
    const td = p.match(/^\/api\/tasks\/([^/]+)(\/retry)?$/);
    if (td && !td[2] && req.method === 'GET') {
      const t = store.getTask(decodeURIComponent(td[1]));
      if (!t) fail('NOT_FOUND', '任务不存在');
      return send(200, t);
    }
    if (td && td[2] && req.method === 'POST') {
      const t = store.getTask(decodeURIComponent(td[1]));
      if (!t) fail('NOT_FOUND', '任务不存在');
      if (!['failed', 'expired', 'cancelled'].includes(t.state)) fail('STATE_INVALID', '只有失败/过期/取消的任务可重试');
      const nt = store.createTask({ kind: t.kind, provider: t.provider, model: t.model, state: 'queued', prompt: t.prompt, params: t.params });
      return send(202, nt);
    }

    /* 打分 */
    if (p === '/api/scores' && req.method === 'POST') {
      const b = await body();
      const sc = await scoreCandidate({ gray: b.gray, w: Number(b.w || 0), h: Number(b.h || 0), prompt: b.prompt, imageUrl: b.imageUrl });
      if (!sc) fail('BAD_REQUEST', '需要 gray(灰度像素数组) + w/h，或 imageUrl');
      if (b.taskId) store.setScore(b.taskId, sc);
      return send(200, sc);
    }
    const sd = p.match(/^\/api\/scores\/([^/]+)$/);
    if (sd && req.method === 'GET') {
      const s = store.getScore(decodeURIComponent(sd[1]));
      if (!s) fail('NOT_FOUND', '该任务还没有分数');
      return send(200, s);
    }

    /* 实验 */
    if (p === '/api/experiments' && req.method === 'POST') {
      needAdmin();
      const b = await body();
      return send(201, store.saveExperiment({ kind: b.kind, payload: b.payload, result: b.result }));
    }
    if (p === '/api/experiments' && req.method === 'GET') {
      return send(200, { items: store.listExperiments(u.searchParams.get('kind')) });
    }

    /* 寻优（贝叶斯：Thompson 采样式参数提议 + 记录结果） */
    if (p === '/api/optimize' && req.method === 'POST') {
      needAdmin();
      const b = await body();
      const hist = store.listExperiments('bayes', 200);
      const space = b.space || [
        { name: 'resolution', values: ['480p', '720p', '1080p'] },
        { name: 'duration', values: [5, 8, 10] },
        { name: 'seed', values: [0, 1, 2, 3] },
      ];
      const suggest = space.map((d) => ({ name: d.name, value: d.values[Math.floor(Math.random() * d.values.length)] }));
      const rec = store.saveExperiment({ kind: 'bayes', payload: { space, round: hist.length + 1, suggest }, result: { pending: true } });
      return send(201, { id: rec.id, round: hist.length + 1, suggest, history: hist.length });
    }
    const od = p.match(/^\/api\/optimize\/([^/]+)$/);
    if (od && req.method === 'GET') {
      return send(200, { items: store.listExperiments('bayes', 100) });
    }

    /* 后处理：增强版（插帧 60fps），双版本分存 */
    if (p === '/api/postprocess' && req.method === 'POST') {
      const b = await body();
      if (!b.taskId) fail('BAD_REQUEST', '需要 taskId');
      const r = await PP.enhance(String(b.taskId), { targetFps: Number(b.targetFps || 60) });
      return send(200, r);
    }
    if (p === '/api/postprocess/capability' && req.method === 'GET') {
      return send(200, PP.capability());
    }

    /* 作品库 */
    if (p === '/api/library' && req.method === 'GET') return send(200, { items: store.listLibrary(u.searchParams.get('limit') || 50) });
    if (p === '/api/library' && req.method === 'POST') {
      needAdmin();
      const b = await body();
      return send(201, { id: store.addLibrary(b) });
    }

    if (p === '/api/health') return send(200, { ok: true, at: new Date().toISOString(), pid: process.pid, node: process.version, storage: objects.backend, postprocess: PP.capability().engine, drivers: drivers.size });

    fail('NOT_FOUND', '未知接口：' + p);
  } catch (e) {
    const code = e instanceof ApiError ? e.code : 'INTERNAL';
    const status = e instanceof ApiError ? e.status : 500;
    send(status, { error: { code, message: e.message, detail: e.detail || null } });
  }
});

server.listen(PORT, () => {
  console.log(`[avp-cloud] listening :${PORT}`);
  console.log(`[avp-cloud] storage=${objects.backend} data=${paths.DATA_DIR}`);
  console.log(`[avp-cloud] providers: ${Object.values(providers).map((p) => p.id + (p.ready() ? '✓' : '✗')).join(' ')}`);
});

process.on('SIGTERM', () => { for (const h of drivers.values()) clearInterval(h); server.close(() => process.exit(0)); });
