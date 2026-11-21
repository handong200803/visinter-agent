/**
 * cloud/selftest.mjs —— 云端后端全链路自测（不依赖任何 Key）
 *
 * 做法：用本地成片伪造「上游已产出的视频」，走通
 *   建任务 → 写对象存储 → 后处理插帧 → 入库 → 查库 → 打分 → 实验 → 寻优
 * 目的：证明除 Seedance 真生成（需 Key）之外，云端其余环节全部可用。
 *
 * 用法：node cloud/selftest.mjs [--base http://127.0.0.1:8787] [--src 本地mp4路径]
 */
import fs from 'node:fs';
import path from 'node:path';
import { store, objects, openDb } from './core.mjs';
import * as PP from './postprocess.mjs';

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };   // i>=0：第一个参数就是 --src 时也要命中
const BASE = argOf('--base', 'http://127.0.0.1:8787');
const SRC = argOf('--src', process.env.SELFTEST_SRC || '');
const ADMIN = String(process.env.ADMIN_TOKEN || '').trim();

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass += 1, console.log('  ✅', n, extra)) : (fail += 1, console.log('  ❌', n, extra)); };

async function j(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(ADMIN ? { 'x-admin-token': ADMIN } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300000) });
  const t = await r.text();
  let v = null; try { v = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, json: v, text: t };
}

console.log('后端：' + BASE);
console.log('数据目录：' + (process.env.DATA_DIR || path.join(process.cwd(), 'data')) + '\n');

openDb();

/* 0. 存活 */
{
  const r = await j('GET', '/api/health');
  ok('后端存活', r.status === 200 && r.json?.ok, r.json ? `storage=${r.json.storage}` : '');
}

/* 1. 造一条「上游已成功」的任务：把本地成片写进对象存储 */
let taskId = null;
{
  if (!SRC || !fs.existsSync(SRC)) {
    console.log('  ⚠ 跳过链路测试：未提供 --src 本地 mp4（用 --src 指定一条成片）');
  } else {
    const buf = fs.readFileSync(SRC);
    const t = store.createTask({ kind: 'video', provider: 'seedance', model: 'selftest', state: 'running', prompt: 'selftest 本地成片', params: { resolution: '640x384', duration: 5 } });
    taskId = t.id;
    const put = await objects.put(`videos/${taskId}-native.mp4`, buf, 'video/mp4');
    store.updateTask(taskId, { state: 'succeeded', output_url: put.url, output_key: put.key, ms: 1 });
    const after = store.getTask(taskId);
    ok('建任务 + 对象存储写入', after.state === 'succeeded' && !!after.output_url, `${(buf.length / 1048576).toFixed(1)}MB → ${after.output_url}`);
  }
}

/* 2. 状态机：非法转移必须被拒 */
{
  try {
    store.updateTask(taskId, { state: 'running' });
    ok('状态机拒绝非法转移（succeeded→running）', false, '居然通过了');
  } catch (e) {
    ok('状态机拒绝非法转移（succeeded→running）', e.code === 'STATE_INVALID', e.code || e.message);
  }
}

/* 3. 后处理：真跑 ffmpeg 插帧 */
let enhancedUrl = null;
{
  if (taskId) {
    const cap = PP.capability();
    if (!cap.available) { ok('后处理可用', false, cap.note); }
    else {
      const t0 = Date.now();
      try {
        const r = await PP.enhance(taskId, { targetFps: 60 });
        enhancedUrl = r.url;
        ok('后处理插帧 24→60fps', r.ok && r.output_fps >= 59, `${Math.round((Date.now() - t0) / 1000)}s · ${r.engine} · ${(r.bytes / 1048576).toFixed(1)}MB`);
        ok('双版本分存（native/enhanced 不同 key）', r.key.includes('enhanced'), r.key);
        ok('替代标注如实写入', r.engine === 'ffmpeg-minterpolate' ? !!r.substitution : true, r.substitution || 'rife-torch（无替代）');
      } catch (e) { ok('后处理插帧', false, (e.code || '') + ' ' + e.message); }
    }
  }
}

/* 4. 作品库：native + enhanced 两条都在 */
{
  if (taskId) {
    const r = await j('GET', '/api/library?limit=20');
    const items = r.json?.items || [];
    const mine = items.filter((x) => x.task_id === taskId);
    ok('作品库记录（cross-device）', r.status === 200 && mine.length >= 1, `本任务 ${mine.length} 条 / 共 ${items.length} 条`);
    ok('库内含 enhanced 变体', mine.some((x) => x.variant === 'enhanced'));
  }
}

/* 5. 对象可下载 */
{
  if (enhancedUrl) {
    const r = await fetch(BASE + enhancedUrl, { signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await r.arrayBuffer());
    ok('作品可下载（/files）', r.ok && buf.length > 10000, `${r.status} · ${(buf.length / 1048576).toFixed(1)}MB`);
  }
}

/* 6. 打分 */
{
  const w = 64, h = 64, gray = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) gray.push(50 + Math.round(170 * Math.abs(Math.sin(x / 6) * Math.cos(y / 8))));
  const r = await j('POST', '/api/scores', { gray, w, h, prompt: '晨雾中的江南水乡，湿石板路' });
  ok('四维打分', r.status === 200 && typeof r.json?.total === 'number', r.json ? `total=${r.json.total} Sbad=${r.json.Sbad}` : '');
}

/* 7. 实验 + 寻优 */
{
  const a = await j('POST', '/api/experiments', { kind: 'selftest', payload: { from: 'cloud/selftest.mjs' }, result: { total: 0.5 } });
  ok('实验写入', a.status === 201 && !!a.json?.id, a.json?.id || a.text.slice(0, 60));
  const b = await j('GET', '/api/experiments');
  ok('实验读取', b.status === 200 && (b.json?.items || []).length > 0, 'count=' + (b.json?.items?.length ?? '?'));
  const c = await j('POST', '/api/optimize', { space: [{ name: 'resolution', values: ['480p', '720p'] }] });
  ok('贝叶斯寻优一轮', c.status === 201 && !!c.json?.suggest, c.json ? 'round=' + c.json.round : c.text.slice(0, 80));
}

/* 8. 前端契约：config 里有 postprocess 与 providers */
{
  const r = await j('GET', '/api/config');
  ok('config 暴露 postprocess', !!r.json?.postprocess, r.json?.postprocess?.engine || '');
  ok('config 暴露 providers', Array.isArray(r.json?.providers) && r.json.providers.length > 0);
}

console.log(`\n结果：PASS ${pass} · FAIL ${fail}`);
if (fail) {
  console.log('\n提示：');
  console.log('  · 后处理失败 → 设 FFMPEG/FFPROBE 指向可执行文件，或容器装 ffmpeg');
  console.log('  · 对象下载 404 → 本地卷后端需 DATA_DIR 可写；S3 后端检查 S3_* 变量');
  console.log('  · 全部失败 → 后端没起（node cloud/server.mjs）');
  process.exit(1);
}
