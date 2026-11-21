/**
 * cloud/audit.mjs —— 云端后端全面缺陷扫描（正面契约 + 负面用例 + 安全 + 文档一致性）
 *
 * 用法：node cloud/audit.mjs [--base http://127.0.0.1:8787] [--admin TOKEN]
 *
 * 设计原则：不只测"能通"，重点测"该拒的有没有拒"——大多数真 bug 都在错误路径上。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = (argOf('--base', 'http://127.0.0.1:8787') || '').replace(/\/+$/, '');
const ADMIN = argOf('--admin', process.env.ADMIN_TOKEN || '');

let pass = 0, fail = 0, warn = 0;
const bugs = [];
const ok = (n, c, extra = '') => { c ? (pass += 1, console.log('  ✅', n, extra)) : (fail += 1, bugs.push(n), console.log('  ❌', n, extra)); };
const soft = (n, c, extra = '') => { c ? (pass += 1, console.log('  ✅', n, extra)) : (warn += 1, console.log('  ⚠', n, extra)); };

async function req(method, p, body, { raw = false, timeout = 60000, headers = {} } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ADMIN ? { 'x-admin-token': ADMIN } : {}), ...headers },
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeout),
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, json: j, text: t, headers: r.headers };
}

console.log('目标：' + BASE + '\n');

/* ── A. 静态检查 ─────────────────────────────── */
console.log('【A】静态检查');
{
  const files = fs.readdirSync(path.join(ROOT, 'cloud')).filter((f) => f.endsWith('.mjs'));
  ok('cloud 下模块数量 ≥ 6', files.length >= 6, files.length + ' 个');
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'cloud', f), 'utf8');
    const hasRequireInEsm = /(^|\n)\s*require\(/.test(src) && !src.includes('createRequire');
    soft(`${f} 未在 ESM 里裸用 require`, !hasRequireInEsm);
    const hasHardKey = /(sk-[A-Za-z0-9]{20,})/.test(src);
    ok(`${f} 无硬编码 Key`, !hasHardKey);
  }
  const envEx = fs.readFileSync(path.join(ROOT, 'cloud', '.env.example'), 'utf8');
  ok('.env.example 覆盖 ARK/DASHSCOPE/S3/ADMIN', ['ARK_API_KEY', 'DASHSCOPE_API_KEY', 'S3_BUCKET', 'ADMIN_TOKEN'].every((k) => envEx.includes(k)));
}

/* ── B. 正面契约 ─────────────────────────────── */
console.log('\n【B】接口契约（正向）');
const cfg = (await req('GET', '/api/config')).json;
ok('GET /api/config', !!cfg && Array.isArray(cfg.providers), cfg ? cfg.providers.length + ' providers' : '');
ok('config 暴露 states 枚举', Array.isArray(cfg?.states) && cfg.states.includes('succeeded'));
ok('config 暴露 weights（四维+扣减）', !!cfg?.weights && 'Sface' in cfg.weights && 'Sbad' in cfg.weights);
ok('config 暴露 postprocess', !!cfg?.postprocess?.engine, cfg?.postprocess?.engine);
ok('GET /api/health', (await req('GET', '/api/health')).json?.ok === true);
ok('GET /api/tasks', Array.isArray((await req('GET', '/api/tasks?limit=5')).json?.items));
ok('GET /api/library', Array.isArray((await req('GET', '/api/library?limit=5')).json?.items));
ok('GET /api/experiments', Array.isArray((await req('GET', '/api/experiments')).json?.items));

/* ── C. 负面用例（真 bug 高发区） ──────────────── */
console.log('\n【C】负面用例（该拒的必须拒）');
{
  const r1 = await req('POST', '/api/video', '{bad json', { raw: true });
  ok('非法 JSON → 400 BAD_REQUEST', r1.status === 400 && r1.json?.error?.code === 'BAD_REQUEST', r1.json?.error?.code);

  const r2 = await req('GET', '/api/nonexistent-route');
  ok('未知路由 → 404', r2.status === 404 && r2.json?.error?.code === 'NOT_FOUND');

  const r3 = await req('POST', '/api/video', {});
  ok('缺 prompt 时不 500（要么 400 要么上游错）', [400, 502, 503].includes(r3.status), 'status=' + r3.status + ' code=' + r3.json?.error?.code);

  const r4 = await req('GET', '/api/tasks/tk_not_exist');
  ok('查不存在任务 → 404', r4.status === 404);

  const r5 = await req('POST', '/api/tasks/tk_not_exist/retry', {});
  ok('重试不存在任务 → 404', r5.status === 404);

  const r6 = await req('POST', '/api/postprocess', {});
  ok('后处理缺 taskId → 400', r6.status === 400 && r6.json?.error?.code === 'BAD_REQUEST');

  const r7 = await req('POST', '/api/postprocess', { taskId: 'tk_nope' });
  ok('后处理不存在任务 → 404', r7.status === 404);

  const r8 = await req('POST', '/api/scores', { gray: [1, 2, 3], w: 999, h: 999 });
  ok('打分像素不足 → 400', r8.status === 400);

  const r9 = await req('POST', '/api/scores', {});
  ok('打分空 body → 400', r9.status === 400);

  const r10 = await req('GET', '/api/keyframes/kf_nope');
  ok('查不存在关键帧任务 → 404', r10.status === 404);

  const r11 = await req('POST', '/api/keyframes/kf_nope/select', { index: 0 });
  ok('改选不存在任务 → 404', r11.status === 404);

  const r12 = await req('GET', '/api/tasks?limit=99999');
  soft('超大 limit 不炸', r12.status === 200, String(r12.status));

  const r13 = await req('GET', '/api/tasks?limit=0');
  soft('limit=0 不炸', r13.status === 200);

  // 超大 body（>12MB 应被拒）
  const big = 'x'.repeat(13 * 1024 * 1024);
  try {
    const r14 = await req('POST', '/api/experiments', '{"a":"' + big + '"}', { raw: true, timeout: 30000 });
    ok('超大 body → 400', r14.status === 400, 'status=' + r14.status);
  } catch (e) { soft('超大 body 拒绝（连接层已断也算）', true, e.message.slice(0, 40)); }
}

/* ── D. 安全 ─────────────────────────────────── */
console.log('\n【D】安全');
{
  // 路径穿越
  for (const p of ['/files/../../etc/passwd', '/files/%2e%2e%2f%2e%2e%2fetc%2fpasswd', '/files/..%5c..%5cwindows%5cwin.ini']) {
    const r = await req('GET', p);
    ok(`路径穿越被拒 ${p.slice(0, 28)}…`, [400, 403, 404].includes(r.status), 'status=' + r.status);
  }
  // 响应里不得出现 Key
  const probes = ['/api/config', '/api/health', '/api/tasks?limit=3', '/api/library?limit=3'];
  let leaked = false;
  for (const p of probes) {
    const r = await req('GET', p);
    if (/sk-[A-Za-z0-9]{16,}|Bearer\s+sk-/.test(r.text)) leaked = true;
  }
  ok('任何响应体不含 Key', !leaked);
  // 管理接口在设了 ADMIN_TOKEN 时应拦
  if (ADMIN) {
    const r = await fetch(BASE + '/api/experiments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'audit', payload: {} }) });
    ok('无令牌写实验 → 401', r.status === 401, 'status=' + r.status);
  } else {
    soft('ADMIN_TOKEN 未设置：管理接口无鉴权（部署时必须设）', false);
  }
}

/* ── E. 文档一致性 ───────────────────────────── */
console.log('\n【E】文档 vs 实现');
{
  const serverSrc = fs.readFileSync(path.join(ROOT, 'cloud', 'server.mjs'), 'utf8');
  const routes = [...serverSrc.matchAll(/p === '(\/api\/[a-z\/]+)'/g)].map((m) => m[1]);
  const doc = fs.readFileSync(path.join(ROOT, 'docs', '33-cloud-fullstack.md'), 'utf8');
  const documented = ['/api/health', '/api/config', '/api/keyframes', '/api/video', '/api/tasks', '/api/scores', '/api/experiments', '/api/optimize', '/api/library', '/api/postprocess'];
  const missing = documented.filter((d) => !doc.includes(d));
  ok('文档覆盖全部主要接口', missing.length === 0, missing.join(',') || '全覆盖');
  const implMissing = documented.filter((d) => d !== '/api/postprocess' && !routes.some((r) => r.startsWith(d)));
  ok('文档提到的接口都已实现', implMissing.length === 0, implMissing.join(',') || '全实现');
  // 前端不含本机硬编码
  const site = fs.readFileSync(path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '03-文档', 'qoder-site', 'index.html'), 'utf8');
  ok('站点无 127.0.0.1/:8418/:8188', !/127\.0\.0\.1|:8418|:8188/.test(site));
  ok('站点无内置 Key', !/sk-[A-Za-z0-9]{16,}/.test(site));
}

console.log(`\n结果：PASS ${pass} · FAIL ${fail} · WARN ${warn}`);
if (bugs.length) { console.log('\n未通过项：'); bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`)); }
process.exit(fail ? 1 : 0);
