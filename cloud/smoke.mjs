/**
 * cloud/smoke.mjs —— 部署后一键自检（照着跑，失败项会明确告诉你缺什么）
 *
 * 用法：
 *   node cloud/smoke.mjs https://your-backend.onrender.com
 *   node cloud/smoke.mjs https://your-backend.onrender.com --admin <ADMIN_TOKEN>
 *   node cloud/smoke.mjs http://127.0.0.1:8787            # 本地自检
 *
 * 检查项：存活 / 配置 / provider 就绪 / 后处理能力 / 打分通路 / 错误码 / 任务列表 / 作品库
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ADMIN = (() => { const i = process.argv.indexOf('--admin'); return i > 0 ? process.argv[i + 1] : ''; })();
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass += 1, console.log('  ✅', n, extra)) : (fail += 1, console.log('  ❌', n, extra)); };

async function j(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ADMIN ? { 'x-admin-token': ADMIN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const t = await r.text();
  let v = null; try { v = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, json: v, text: t };
}

console.log('目标后端：' + BASE + '\n');

/* 1. 存活 */
{
  const r = await j('GET', '/api/health');
  ok('存活 /api/health', r.status === 200 && r.json?.ok === true, r.json ? `storage=${r.json.storage} postprocess=${r.json.postprocess}` : r.text.slice(0, 80));
}

/* 2. 配置与 provider */
let cfg = null;
{
  const r = await j('GET', '/api/config');
  cfg = r.json;
  ok('配置 /api/config', r.status === 200 && Array.isArray(cfg?.providers));
  const pv = (cfg?.providers || []).find((p) => p.kind === 'video');
  const pi = (cfg?.providers || []).find((p) => p.kind === 'image');
  ok('视频 provider 就绪（需 ARK_API_KEY）', !!pv?.ready, pv ? pv.id + (pv.ready ? '' : ' ✗') : 'missing');
  ok('生图 provider 就绪', !!pi?.ready, pi ? pi.id + (pi.ready ? '' : ' ✗') : 'missing');
  ok('配额已配置', cfg?.quota != null, 'perDay=' + (cfg?.quota?.perDay ?? '?'));
  console.log('     providers: ' + (cfg?.providers || []).map((p) => p.id + (p.ready ? '✓' : '✗')).join(' '));
}

/* 3. 后处理 */
{
  const r = await j('GET', '/api/postprocess/capability');
  ok('后处理可用', r.status === 200 && r.json?.available === true, r.json ? 'engine=' + r.json.engine : r.text.slice(0, 80));
}

/* 4. 打分通路（不需要 Key） */
{
  const w = 48, h = 48, gray = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) gray.push(60 + Math.round(150 * Math.abs(Math.sin(x / 5) * Math.cos(y / 7))));
  const r = await j('POST', '/api/scores', { gray, w, h, prompt: '雨夜古寺，冷色调' });
  ok('打分通路', r.status === 200 && typeof r.json?.total === 'number', r.json ? 'total=' + r.json.total : r.text.slice(0, 80));
}

/* 5. 错误码（无 Key 时应返回 PROVIDER_MISSING 而不是 500） */
{
  const r = await j('POST', '/api/video', { prompt: 'smoke', resolution: '480p', duration: 5 });
  const code = r.json?.error?.code;
  ok('错误码规范', [202, 400, 503, 502].includes(r.status) && (!r.json?.error || /^[A-Z_]+$/.test(code)), 'status=' + r.status + ' code=' + (code || '-'));
}

/* 6. 列表接口 */
{
  const a = await j('GET', '/api/tasks?limit=3');
  ok('任务列表', a.status === 200 && Array.isArray(a.json?.items), 'count=' + (a.json?.items?.length ?? '?'));
  const b = await j('GET', '/api/library?limit=3');
  ok('作品库', b.status === 200 && Array.isArray(b.json?.items), 'count=' + (b.json?.items?.length ?? '?'));
  const c = await j('GET', '/api/experiments');
  ok('实验列表', c.status === 200 && Array.isArray(c.json?.items), 'count=' + (c.json?.items?.length ?? '?'));
}

/* 7. CORS 预检（浏览器能不能调） */
{
  try {
    const r = await fetch(BASE + '/api/config', { method: 'OPTIONS', headers: { Origin: 'https://example.qodersite.com', 'Access-Control-Request-Method': 'POST' }, signal: AbortSignal.timeout(15000) });
    const acao = r.headers.get('access-control-allow-origin');
    ok('CORS 预检', r.status < 400 && !!acao, 'allow-origin=' + acao);
  } catch (e) { ok('CORS 预检', false, e.message); }
}

console.log(`\n结果：PASS ${pass} · FAIL ${fail}`);
if (fail) {
  console.log('\n排查提示：');
  console.log('  · provider ✗ → 部署平台 Secrets 里没填 ARK_API_KEY，或值前后有空格');
  console.log('  · postprocess ✗ → 镜像没装 ffmpeg（用 cloud/Dockerfile，已 apk add）');
  console.log('  · CORS ✗ → ALLOW_ORIGIN 要写成站点完整域名（含 https://，不带末尾斜杠）');
  console.log('  · 全部 ✗ → 后端没起来或地址错，先 curl ' + BASE + '/api/health');
  process.exit(1);
}
