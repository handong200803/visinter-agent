#!/usr/bin/env node
/**
 * e2e.mjs —— 端到端集成验收（模块自检之外的那一层）
 *
 * 分工：
 *   各模块 selftest 证明「我自己是对的」；这里证明「装在一起能互相找到」。
 *   平台最常见的坏法不是某个函数算错，而是**契约漂移**：外壳写着探测
 *   `../canvas/index.html`，画布却产出 `canvas.html`——每个模块都自检通过，
 *   用户看到的是「未验证」。这类问题只能靠跨模块断言抓。
 *
 * 四组断言：
 *   1) 外壳 → 模块：`MODULES[].probe` 里写的相对路径，文件真的在那儿。
 *   2) 模块 → 外壳：起一次真实服务，七个入口全部 200；除工作台外每个页面都有
 *      `data-backlink` 且指向真实文件（file:// 下没有后退可用）。
 *   3) 入口页没有「即将支持 / 敬请期待」这类死按钮，且按钮数不为零（空白页也算失败）。
 *   4) 渲染桥：POST /api/jobs → 轮询到 succeeded（comfy 不可达时走 mock），
 *      证明外壳「开始渲染」这条链路在无 GPU、无 ComfyUI 的机器上也跑得通。
 *
 * 跑法：node tools/e2e.mjs        （端口用 listen(0) 交给系统，不撞正在跑的 8388）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createApp } = require(path.join(ROOT, 'server', 'app.js'));

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const TMP_DIR = path.join(CACHE_ROOT, 'avp', 'e2e-' + Date.now().toString(36));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra ? '  ' + extra : ''}`); }
};

const req = (port, method, p, payload) => new Promise((resolve, reject) => {
  const data = payload === undefined ? null : JSON.stringify(payload);
  const r = http.request({
    host: '127.0.0.1', port, method, path: p,
    headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
  }, (res) => {
    let buf = '';
    res.on('data', (c) => { buf += c; });
    res.on('end', () => {
      let json = null;
      try { json = buf ? JSON.parse(buf) : null; } catch { /* 非 JSON 留给调用方看 text */ }
      resolve({ status: res.statusCode, headers: res.headers, text: buf, json });
    });
  });
  r.on('error', reject);
  if (data) r.write(data);
  r.end();
});

/** 入口清单：与 docs/08-shell.md §7 的约定表一一对应 */
const ENTRIES = [
  { id: 'params', path: '/web/params.html', file: 'web/params.html', min: 100_000 },
  { id: 'canvas', path: '/canvas/canvas.html', file: 'canvas/canvas.html', min: 100_000 },
  { id: 'inspector', path: '/inspector/index.html', file: 'inspector/index.html', min: 20_000 },
  { id: 'market', path: '/market/index.html', file: 'market/index.html', min: 50_000 },
  { id: 'plugins', path: '/plugins/index.html', file: 'plugins/index.html', min: 50_000 },
  { id: 'quality', path: '/quality/index.html', file: 'quality/index.html', min: 50_000 },
  { id: 'server', path: '/server/index.html', file: 'server/index.html', min: 50_000 },
];

const DEAD = /即将支持|敬请期待|coming soon|待实现|尚未支持/i;

(async () => {
  console.log('AI 视频平台 · 端到端集成验收');
  console.log(`根目录 ${ROOT}\n`);

  // ── 1. 外壳 → 模块：探测路径的契约 ─────────────────────────────
  console.log('== 1 · 外壳探测路径 vs 实际产物 ==');
  const shellSrc = fs.readFileSync(path.join(ROOT, 'app', 'index.src.html'), 'utf8');
  const probes = [...shellSrc.matchAll(/id:\s*'([\w-]+)'[^\n]*?probe:\s*'([^']+)'/g)]
    .map((m) => ({ id: m[1], probe: m[2] }));
  ok(probes.length >= 7, `外壳声明了 ${probes.length} 个可探测模块（含工作台自身）`, probes.map((p) => p.id).join(','));
  for (const p of probes) {
    if (p.probe === null || p.probe === undefined) continue;
    const abs = path.resolve(ROOT, 'app', p.probe);
    const exists = fs.existsSync(abs);
    ok(exists, `${p.id} → ${p.probe}`, exists ? '' : '文件不存在：外壳会永远显示「未验证」');
  }

  // ── 2/3. 起服务，逐个入口 → 200 + 回程链接 + 无死按钮 ─────────────
  console.log('\n== 2 · 服务发射七个入口，且都能回到工作台 ==');
  // cine provider 用零计费桩：契约测试只验受理/改选/候选路由，不触发云端 8 组打磨（重投=重复计费）。
  const cineStub = { id: 'cine', mode: 'mock', probe: async () => ({ reachable: true, mode: 'mock' }), run: async () => ({ output: null, images: [] }) };
  const svc = createApp({ jobsDir: TMP_DIR, mockMs: 120, providerId: 'mock', cineProvider: cineStub });
  const addr = await svc.listen(0, '127.0.0.1');
  const port = addr.port;
  console.log(`  （临时端口 ${port}，任务目录 ${TMP_DIR}）`);

  try {
    const shellExists = fs.existsSync(path.join(ROOT, 'app', 'index.html'));
    const appPage = await req(port, 'GET', '/app/index.html');
    ok(appPage.status === 200 && /text\/html/.test(appPage.headers['content-type'] || ''), '工作台 200 text/html', `${appPage.text.length}B`);
    ok(!/即将支持|敬请期待/.test(appPage.text), '工作台无「即将支持」类死文案');

    for (const e of ENTRIES) {
      const r = await req(port, 'GET', e.path);
      ok(r.status === 200 && r.text.length >= e.min, `${e.id} 入口可达 ≥${(e.min / 1024).toFixed(0)}KB`, `${r.status} ${(r.text.length / 1024).toFixed(0)}KB`);
      if (e.id === 'inspector') continue; // 帧检查器是早期独立产物，未纳入回程契约
      ok(r.text.includes('data-backlink') && r.text.includes('href="../app/index.html"'), `${e.id} 有「← 工作台」回程链接`);
      ok(shellExists, `${e.id} 回程目标 app/index.html 存在`);
      const dead = (r.text.match(DEAD) || []).length;
      const btns = (r.text.match(/<button/g) || []).length;
      ok(dead === 0, `${e.id} 无死按钮文案`, dead ? `命中 ${dead} 处` : '');
      ok(btns > 0, `${e.id} 有可交互控件`, `${btns} 个按钮`);
    }

    // ── 4. 渲染桥：外壳「开始渲染」的真实链路 ─────────────────────
    console.log('\n== 3 · 渲染桥（POST /api/jobs → 终态）==');
    const health = await req(port, 'GET', '/api/health');
    ok(health.status === 200 && health.json && health.json.ok !== false, 'GET /api/health 200', `comfy ${health.json && health.json.comfy && health.json.comfy.mode}`);
    const created = await req(port, 'POST', '/api/jobs', { device: 'T0', values: {}, note: 'e2e' });
    ok(created.status === 200 || created.status === 201 || created.status === 202, 'POST /api/jobs 受理', String(created.status));
    const jobId = created.json && (created.json.id || (created.json.job && created.json.job.id));
    ok(!!jobId, '返回任务 id', String(jobId));
    let final = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const r = await req(port, 'GET', `/api/jobs/${jobId}`);
      const st = r.json && (r.json.state || (r.json.job && r.json.job.state));
      if (st === 'succeeded' || st === 'failed' || st === 'canceled') { final = st; break; }
      await new Promise((res) => setTimeout(res, 200));
    }
    ok(final === 'succeeded', '任务走到 succeeded（mock 后端）', `${final} · ${Date.now() - t0}ms`);

    console.log('\n== 3b · 一句话电影管线契约（cine）==');
    const emptyCine = await req(port, 'POST', '/api/jobs', { kind: 'cine', prompt: '   ' });
    ok(emptyCine.status === 400 && emptyCine.json.error.code === 'CINE_EMPTY_PROMPT', 'cine 空提示词 400', emptyCine.json.error && emptyCine.json.error.code);
    const badKind = await req(port, 'POST', '/api/jobs', { kind: 'bogus', prompt: 'x' });
    ok(badKind.status === 400 && badKind.json.error.code === 'BAD_KIND', '未知 kind 400', badKind.json.error && badKind.json.error.code);
    const cineJob = await req(port, 'POST', '/api/jobs', { kind: 'cine', prompt: '轮渡上的女生侧脸' });
    ok(cineJob.status === 202 && cineJob.json.provider === 'cine', 'cine 任务受理走 cine provider', `${cineJob.status} · ${cineJob.json.provider}`);
    const pickNonCine = await req(port, 'POST', `/api/jobs/${jobId}/pick`, { index: 0 });
    ok(pickNonCine.status === 409 && pickNonCine.json.error.code === 'JOB_NOT_PICKABLE', '非 cine 任务改选 409', pickNonCine.json.error && pickNonCine.json.error.code);
    const noCand = await req(port, 'GET', `/api/jobs/${jobId}/candidates/1`);
    ok(noCand.status === 404 && noCand.json.error.code === 'NO_CANDIDATE', '无候选关键帧 404', noCand.json.error && noCand.json.error.code);

    console.log('\n== 4 · 静态层的边界 ==');
    const md = await req(port, 'GET', '/README.md');
    ok(md.status === 403 && md.json.error.code === 'TYPE_BLOCKED', '白名单外后缀 403');
    const trav = await req(port, 'GET', '/%2e%2e/%2e%2e/Windows/win.ini');
    ok([403, 404].includes(trav.status), '越界路径被拦', String(trav.status));
  } finally {
    // 顺序有讲究：先关任务调度器（它要写 .worker.lock 的释放记录），再关 HTTP server，最后删目录。
    // 反过来会 ENOENT：server close 事件里再次 jobs.close() 时目录已被 rmSync 删掉。
    try { await svc.app.jobs.close(); } catch { /* 已关闭则忽略 */ }
    svc.server.close();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }

  console.log(`\n结果  通过 ${pass} · 失败 ${fail}`);
  if (fail) process.exit(1);
  console.log('全部通过');
})().catch((e) => {
  console.log('✗ 未捕获异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e));
  process.exit(1);
});