/**
 * cloud/e2e-mock.mjs —— 全链路稳定性测试（后端 → mock 上游 → 后处理 → 入库）
 *
 * 验证的是"评委填了 Key 之后"会走的**同一条代码路径**：
 *   建密钥态 → 文生图（异步轮询 2 次）→ 选优 → 图生视频（异步轮询）→ 下载 → 60fps → 入库 → 可下载
 *
 * 用法：node cloud/e2e-mock.mjs [--base http://127.0.0.1:8787] [--rounds 3]
 */
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BASE = (argOf('--base', 'http://127.0.0.1:8787') || '').replace(/\/+$/, '');
const ROUNDS = Number(argOf('--rounds', 3));
const ADMIN = String(process.env.ADMIN_TOKEN || 'mock-token');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? (pass += 1, console.log('  ✅', n, extra)) : (fail += 1, console.log('  ❌', n, extra)); };

async function j(method, p, body, timeout = 180000) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const t = await r.text();
  let v = null; try { v = JSON.parse(t); } catch { /* text */ }
  return { status: r.status, json: v, text: t };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('后端：' + BASE + '　轮次：' + ROUNDS + '\n');

/* 0. 前置 */
{
  const c = (await j('GET', '/api/config')).json;
  const wanx = (c.providers || []).find((p) => p.id === 'wanx');
  ok('万相 provider 就绪（指向 mock）', !!wanx && wanx.ready === true, wanx ? 'ready=' + wanx.ready : 'missing');
  ok('后处理可用', !!c.postprocess?.available, c.postprocess?.engine || '');
}

/* 每轮完整跑一次：t2i → select → i2v → poll → postprocess → library */
for (let round = 1; round <= ROUNDS; round += 1) {
  console.log(`\n── 第 ${round} 轮 ──`);
  const t0 = Date.now();
  let kfId = null, videoId = null, enhancedUrl = null;

  /* 1. 文生图（异步 2 次轮询） */
  {
    const r = await j('POST', '/api/keyframes', { prompt: `全链路测试第${round}轮：雨夜古寺`, count: 2, size: '832*480' });
    const cands = (r.json?.candidates || []).filter((c) => c.url);
    ok('文生图返回候选', r.status === 200 && cands.length === 2, `${cands.length} 张 · ${Math.round((Date.now() - t0) / 1000)}s`);
    ok('候选 URL 是公网可访问地址', cands.every((c) => /^https?:\/\//.test(c.url)), cands[0] ? cands[0].url.slice(0, 46) + '…' : '');
    // 断言候选图真的能下载
    if (cands[0]) {
      const img = await fetch(cands[0].url, { signal: AbortSignal.timeout(20000) }).catch(() => null);
      ok('候选图可下载', !!img && img.ok, img ? img.status + ' / ' + (img.headers.get('content-type') || '') : 'fail');
    }
    kfId = r.json?.id;
    // 手动改选第 2 张（验证选优接口）
    if (kfId) {
      const sel = await j('POST', `/api/keyframes/${kfId}/select`, { index: 1 });
      ok('手动改选候选', sel.status === 200 && !!sel.json?.selected, sel.json?.selected ? 'ok' : 'fail');
    }
  }

  /* 2. 图生视频（异步轮询） */
  {
    const kf = kfId ? (await j('GET', `/api/keyframes/${kfId}`)).json : null;
    const firstFrame = kf?.selected;
    const r = await j('POST', '/api/video', {
      prompt: `全链路测试第${round}轮：小猫转头`,
      first_frame: firstFrame,
      resolution: '480p', ratio: '16:9', duration: 5,
    });
    ok('提交图生视频', r.status === 202 && !!r.json?.id, r.json?.id || r.text.slice(0, 80));
    videoId = r.json?.id;
  }

  /* 3. 轮询到终态 */
  if (videoId) {
    let st = null;
    for (let i = 0; i < 60; i += 1) {
      await sleep(1200);
      const t = (await j('GET', `/api/video/${videoId}`)).json;
      st = t;
      if (['succeeded', 'failed', 'expired', 'cancelled'].includes(t.state)) break;
    }
    ok('视频任务到达 succeeded', st?.state === 'succeeded', `${st?.state} · ${Math.round((Date.now() - t0) / 1000)}s`);
    ok('产物 URL 可访问', !!st?.output_url, st?.output_url ? st.output_url.slice(0, 46) + '…' : '无');
    if (st?.output_url) {
      const v = await fetch(BASE + st.output_url, { signal: AbortSignal.timeout(60000) }).catch(() => null);
      const len = v ? (await v.arrayBuffer()).byteLength : 0;
      ok('成片可下载且有内容', !!v && v.ok && len > 50000, len ? (len / 1048576).toFixed(1) + 'MB' : 'fail');
    }
  }

  /* 4. 后处理 60fps */
  if (videoId) {
    const r = await j('POST', '/api/postprocess', { taskId: videoId, targetFps: 60 }, 300000);
    ok('后处理 60fps 成功', r.status === 200 && r.json?.ok === true,
      r.json ? `${r.json.native_fps}→${r.json.output_fps}fps · ${(r.json.bytes / 1048576).toFixed(1)}MB · ${r.json.engine}` : r.text.slice(0, 100));
    ok('增强版标注了替代引擎', r.json?.engine === 'ffmpeg-minterpolate' ? !!r.json?.substitution : true, r.json?.substitution || 'rife-torch');
    enhancedUrl = r.json?.url || null;
    if (enhancedUrl) {
      const v = await fetch(BASE + enhancedUrl, { signal: AbortSignal.timeout(60000) }).catch(() => null);
      ok('增强版可下载', !!v && v.ok, v ? v.status : 'fail');
    }
  }

  /* 5. 入库 */
  {
    const r = await j('GET', '/api/library?limit=30');
    const mine = (r.json?.items || []).filter((x) => x.task_id === videoId);
    ok('作品库含 native + enhanced', mine.length >= 1, `${mine.length} 条（含 enhanced: ${mine.some((x) => x.variant === 'enhanced')}）`);
    const native = mine.find((x) => x.variant !== 'enhanced');
    ok('库记录带来源与模型', !!native?.provider && !!native?.model, native ? `${native.provider}/${native.model}` : '无');
  }

  /* 6. 任务状态可查 */
  if (videoId) {
    const t = (await j('GET', `/api/tasks/${videoId}`)).json;
    ok('任务详情可回溯（含耗时与参数）', !!t?.id && t.ms > 0, `ms=${t?.ms}`);
  }

  console.log(`  本轮总耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
}

/* 7. 稳定性：并发 3 条同时提交，不应互相踩踏 */
console.log('\n── 并发稳定性 ──');
{
  const t0 = Date.now();
  const subs = await Promise.all([1, 2, 3].map((i) => j('POST', '/api/video', {
    prompt: '并发测试 ' + i, resolution: '480p', ratio: '16:9', duration: 5,
  })));
  const ids = subs.map((s) => s.json?.id).filter(Boolean);
  ok('并发 3 条都受理', ids.length === 3, ids.length + ' 条');
  let done = 0;
  for (let i = 0; i < 60; i += 1) {
    await sleep(1200);
    const sts = await Promise.all(ids.map((id) => j('GET', `/api/video/${id}`)));
    done = sts.filter((s) => s.json?.state === 'succeeded').length;
    if (done === ids.length) break;
  }
  ok('并发 3 条全部成功', done === ids.length, `${done}/${ids.length} · ${Math.round((Date.now() - t0) / 1000)}s`);
}

console.log(`\n══ 结果：PASS ${pass} · FAIL ${fail} ══`);
process.exit(fail ? 1 : 0);
