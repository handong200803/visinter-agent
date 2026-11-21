/**
 * selftest.js —— 后端全链路自测（node server/selftest.js 一条命令跑通）
 *
 * 为什么自请求而不是直接调 createApp 返回的对象：走一遍真实 http（含 CORS 头、JSON 编解码、
 * SSE 分块、404 兜底），才能证明"服务真的能跑"，而不是"函数能返回"。临时端口用 listen(0)
 * 让系统分配，避免撞上正在跑的 8388。
 *
 * 任务落盘目录指到 %CACHE_ROOT%\avp\selftest-<时间戳>，跑完删掉：不污染真实任务历史。
 */
'use strict';

// 测试环境：cine 不走本地回退（否则会真的去调 ComfyUI，导致等待超时）
process.env.AVP_CINE_LOCAL = '0';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, readSpec } = require('./app.js');
const { validateAiPayload } = require('./recommend.js');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const TMP_DIR = path.join(CACHE_ROOT, 'avp', 'selftest-' + Date.now().toString(36));

let pass = 0, fail = 0;
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
function ok(cond, msg, extra) {
  if (cond) { pass += 1; log('  ✓ ' + msg + (extra ? '  ' + extra : '')); }
  else { fail += 1; log('  ✗ ' + msg + '  ' + (extra || '')); }
}

function req(port, method, p, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { /* 非 JSON（SSE）留给 sse() */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/** 收 SSE 事件直到 done（或超时）；返回事件数组。 */
function sse(port, p, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const r = http.get({ host: '127.0.0.1', port, path: p, headers: { Accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('SSE status ' + res.statusCode)); return; }
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, i); buf = buf.slice(i + 2);
          if (raw.startsWith(':')) continue;
          const ev = {}; const dataLines = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) ev.event = line.slice(7).trim();
            else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
          }
          try { ev.data = JSON.parse(dataLines.join('\n')); } catch { ev.data = null; }
          events.push(ev);
          if (ev.event === 'done') { clearTimeout(timer); res.destroy(); resolve(events); return; }
        }
      });
      res.on('end', () => { clearTimeout(timer); resolve(events); });
    });
    const timer = setTimeout(() => { r.destroy(); resolve(events); }, timeoutMs);
    r.on('error', () => { clearTimeout(timer); resolve(events); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitState(port, id, want, { timeoutMs = 20000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await req(port, 'GET', '/api/jobs/' + id);
    const st = r.json && r.json.state;
    if (want.includes(st)) return { job: r.json, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeoutMs) throw new Error(`等 ${want} 超时，当前 ${st}`);
    await sleep(60);
  }
}

(async () => {
  log('== 启动 ==');
  const svc = createApp({ jobsDir: TMP_DIR, mockMs: 600, concurrency: 1, providerId: 'mock' });
  const addr = await svc.listen(0);
  const port = addr.port;
  log(`  临时端口 ${port} · 任务目录 ${TMP_DIR.replace(CACHE_ROOT, '%CACHE_ROOT%')}`);

  try {
    log('\n== health ==');
    const h = await req(port, 'GET', '/api/health');
    ok(h.status === 200, 'GET /api/health 200', `node ${h.json && h.json.node}`);
    ok(h.json.node.startsWith('v'), '返回 node 版本', h.json.node);
    ok(typeof h.json.comfy.reachable === 'boolean', 'comfy 可达性字段存在', `reachable=${h.json.comfy.reachable} mode=${h.json.comfy.mode}`);
    ok(h.json.provider && h.json.provider.id === 'mock' && h.json.provider.mode === 'mock', 'health 报 provider（默认 mock 显式标记）', `id=${h.json.provider.id} mode=${h.json.provider.mode} degraded=${h.json.provider.degraded}`);
    ok(h.json.registry.version === '0.1.0' && h.json.registry.params === 258, '注册表版本/参数数', `${h.json.registry.version} / ${h.json.registry.params}`);
    ok(h.json.disk && (h.json.disk.free_gib > 0 || h.json.disk.error), '磁盘可用', `${h.json.disk.mount} 空闲 ${h.json.disk.free_gib}GiB`);
    ok(h.headers['access-control-allow-origin'] === '*', 'CORS 头存在');

    log('\n== devices ==');
    const d = await req(port, 'GET', '/api/devices');
    ok(d.status === 200 && d.json.devices.length === 7, 'GET /api/devices 7 档', `count=${d.json.count}`);
    const t0 = d.json.devices.find((x) => x.id === 'T0');
    const t0low = d.json.devices.find((x) => x.id === 'T0-low');
    ok(t0 && t0.estimate.vram.peak_mib > 0, 'T0 显存估算有数', `peak ${t0.estimate.vram.peak_mib}MiB / ${t0.usable_mib}MiB = ${(t0.estimate.vram.ratio * 100).toFixed(1)}% [${t0.estimate.vram.state}]`);
    ok(t0low && t0low.verdict === 'block', 'T0-low 判为 block', `ratio ${t0low.estimate.vram.ratio}`);
    ok(d.json.devices.every((x) => x.estimate && x.estimate.time.shot_sec > 0), '每档都有耗时估算', `T0 单格 ${t0.estimate.time.shot_sec}s`);

    log('\n== gpu probe（卡 ④ 显存真值） ==');
    const spec4 = readSpec();
    const pr = d.json.probe;
    ok(pr && typeof pr.ok === 'boolean', 'probe 字段存在且是布尔口径', `ok=${pr && pr.ok} source=${pr && pr.source}`);
    ok(pr && ['measured', 'estimate', 'unknown'].includes(pr.provenance), 'provenance 三态之一（不许无标注推断）', `provenance=${pr && pr.provenance}`);
    if (pr && pr.ok) {
      ok(typeof pr.gpu.name === 'string' && pr.gpu.total_mib > 0, '探测到型号与总显存', `${pr.gpu.name} / ${pr.gpu.total_mib}MiB / cc ${pr.gpu.compute_cap} / 驱动 ${pr.gpu.driver}`);
      ok(pr.usable_mib === null || pr.usable_mib <= pr.gpu.total_mib, '可用显存不超过总量（不做越界推断）', `usable=${pr.usable_mib} free=${pr.free_mib}`);
      ok(pr.provenance === 'measured' ? pr.gpu.used_mib != null : true, 'measured 必须真的采到 used', `used=${pr.gpu.used_mib}`);
      ok(pr.tier_suggestion == null || spec4.catalog.devices.some((x) => x.id === pr.tier_suggestion), '建议档位落在目录内', `suggest=${pr.tier_suggestion} enough_for=${(pr.enough_for || []).join('/')}`);
    } else {
      ok(typeof pr.reason === 'string' && pr.reason.length > 0, '探测失败给 reason（不装成功）', `reason=${pr.reason}`);
      ok(pr.gpu === null && pr.tier_suggestion === null, '失败时不编 gpu/档位', `gpu=${pr.gpu}`);
    }
    // 单元级：CSV 解析 + 档位选择不依赖 nvidia-smi 是否在场
    const gpuMod = require('./gpu.js');
    const parsed = gpuMod.parseCsv('NVIDIA GeForce RTX 5060 Laptop GPU, 8151, 4595, 12.0, 576.80\n');
    ok(parsed && parsed.total_mib === 8151 && parsed.used_mib === 4595, 'parseCsv 读 total/used', `${parsed && parsed.total_mib}/${parsed && parsed.used_mib}`);
    ok(gpuMod.tierFor(8151, spec4.catalog.devices) === 'T0' && gpuMod.tierFor(24576, spec4.catalog.devices) === 'T3', 'tierFor 按总量选档（不越档）', `${gpuMod.tierFor(8151, spec4.catalog.devices)} / ${gpuMod.tierFor(24576, spec4.catalog.devices)}`);
    ok(gpuMod.tierFor(null, spec4.catalog.devices) === null && gpuMod.tierFor(8151, null) === null, '缺输入时返回 null 而不是猜', 'null/null');
    // 假探针：模拟"没有 GPU"的机器，接口必须如实报 ok:false
    const fakeSvc = createApp({ spec: spec4, jobsDir: TMP_DIR, restore: false, gpuProbe: { probe: async () => ({ ok: false, at: new Date().toISOString(), source: 'nvidia-smi', gpu: null, usable_mib: null, provenance: 'unknown', free_mib: null, reason: 'NVIDIA_SMI_MISSING', detail: {} }) } });
    const fakeAddr = await fakeSvc.listen(0);
    const fd = await req(fakeAddr.port, 'GET', '/api/devices');
    ok(fd.status === 200 && fd.json.probe.ok === false && fd.json.probe.reason === 'NVIDIA_SMI_MISSING', '无 GPU 机器→probe.ok=false + reason', `ok=${fd.json.probe.ok} reason=${fd.json.probe.reason}`);
    ok(fd.json.devices.length === 7 && fd.json.probe.tier_suggestion === null, '探测失败仍返回目录档位（标未探测，不假装匹配）', `devices=${fd.json.devices.length}`);
    if (typeof fakeSvc.server.closeAllConnections === 'function') fakeSvc.server.closeAllConnections();
    await new Promise((r) => fakeSvc.server.close(r));

    log('\n== character 自动提取 ==');
    {
      const { createCharacterExtractor } = require('./character.js');
      const ex = createCharacterExtractor({ registry: spec4.reg });
      const c1 = ex.extract({ prompt: '轮渡上20岁左右女生，格子围巾，深色大衣，侧脸看海，电影感', values: {} });
      ok(c1.fields['ch.age'].value === 20 && c1.fields['ch.age'].source === 'ai', '年龄：写了几岁就取几岁（不按档位脑补）', `age=${c1.fields['ch.age'].value} band=${c1.fields['ch.age'].band}`);
      ok(String(c1.patch['ch.outfit_1'] || '').includes('围巾') && String(c1.patch['ch.outfit_1']).includes('大衣'), '服装：抽到两件且带颜色/款式', `outfit=${c1.patch['ch.outfit_1']}`);
      ok(c1.style7 && c1.style7.id === 'cinema', '画风：电影感 → cine cinema（与插画 ch.style 分开）', `style7=${c1.style7 && c1.style7.id} ch.style.source=${c1.fields['ch.style'].source}`);
      ok(c1.fields['ch.face_shape'].source === 'default', '没写脸型 → 用默认值且标 default（不脑补）', `face=${c1.fields['ch.face_shape'].value}`);
      const c2 = ex.extract({ prompt: '男孩和女孩在雪地木屋前，圆脸，红色羽绒服', values: {} });
      ok(c2.fields['ch.subject'].source === 'conflict' && c2.conflicts.length === 1, '两个主体 → 冲突不擅自选', `candidates=${(c2.conflicts[0] && c2.conflicts[0].candidates || []).join(' / ')}`);
      ok(String(c2.patch['ch.outfit_1']) === '红色羽绒服', '服装去重：羽绒服不吃成「羽绒」', `outfit=${c2.patch['ch.outfit_1']}`);
      const c3 = ex.extract({ prompt: '穿汉服的男子站在长廊', values: { 'ch.outfit_1': '黑色皮衣' } });
      ok(c3.contradictions.length === 1 && c3.contradictions[0].note === '已按提示词更新', '与面板值矛盾 → 按提示词更新并留痕', JSON.stringify(c3.contradictions[0] || {}));
      const c4 = ex.extract({ prompt: '一只猫趴在窗台，柔光', values: {} });
      ok(c4.fields['ch.outfit_1'].source === 'empty' && !('ch.outfit_1' in c4.patch), '没写服装 → 留空不写默认值', `source=${c4.fields['ch.outfit_1'].source}`);
      const c5 = ex.extract({ prompt: '三个镜头，同一个女生穿白裙走在街上，保持形象一致', values: {} });
      ok(c5.patch['ch.consistency'] === 1.0, '多镜头/同人物系列 → 一致性 1.0', `consistency=${c5.patch['ch.consistency']}`);
      const q = ex.mergeQwen(c1, { 'ch.face_shape': '不存在的脸', 'ch.age': 999, 'ch.outfit_1': '白色旗袍' });
      ok(q.qwen.rejected.length === 2 && q.patch['ch.outfit_1'] === '白色旗袍', 'Qwen 值过域校验：坏值进 rejected 不静默丢', `rejected=${q.qwen.rejected.map((x) => x.key + ':' + x.reason).join(',')}`);
      const recResp = await req(port, 'POST', '/api/recommend', { prompt: '轮渡上20岁左右女生，格子围巾，深色大衣，电影感', device: 'T0' });
      ok(recResp.status === 200 && recResp.json.character && recResp.json.character.applied >= 3, '/api/recommend 返回 character 并真实回填', `applied=${recResp.json.character && recResp.json.character.applied} source=${recResp.json.source}`);
      ok(recResp.json.values['ch.outfit_1'] && String(recResp.json.values['ch.outfit_1']).includes('大衣'), '回填值进了 258 键真实 values', `ch.outfit_1=${recResp.json.values['ch.outfit_1']}`);
    }

    log('\n== params ==');
    const p = await req(port, 'GET', '/api/params');
    const sum = p.json.stages.reduce((a, s) => a + s.params.length, 0);
    ok(p.status === 200 && p.json.total === 258, 'GET /api/params 总数 258', `total=${p.json.total}`);
    ok(p.json.stages.length === 7 && sum === 258, '按 stage 分组且不丢参数', `${p.json.stages.length} 组 / 合计 ${sum}`);
    const ps = await req(port, 'GET', '/api/params?stage=keyframe');
    ok(ps.json.stages.length === 1 && ps.json.stages[0].params.length === 56, 'stage 过滤生效', `keyframe ${ps.json.stages[0].params.length} 个`);

    log('\n== estimate ==');
    const e = await req(port, 'POST', '/api/estimate', { device: 'T0', values: {} });
    ok(e.status === 200 && e.json.estimate.vram.peak_mib > 0, 'POST /api/estimate 200', `peak ${e.json.estimate.vram.peak_mib}MiB, 质量 ${e.json.estimate.quality.score}, 单集 ¥${e.json.estimate.cost.episode_yuan}`);
    const ebad = await req(port, 'POST', '/api/estimate', { device: 'TX' });
    ok(ebad.status === 400 && ebad.json.error.code === 'BAD_DEVICE', '坏档位→统一 error JSON', `${ebad.status} ${ebad.json.error.code}`);
    const dg = await req(port, 'POST', '/api/degrade', { device: 'T0-low', values: {} });
    ok(dg.status === 200 && dg.json.needed === true && dg.json.options.length === 0 && dg.json.mode === 'quality_first', 'POST /api/degrade 不再提供降质方案', `needed=${dg.json.needed} options=${dg.json.options.length}`);
    const wfc = await req(port, 'POST', '/api/workflow/compile', { values: {} });
    ok(wfc.json.stats.bound === 6 && wfc.json.stats.unbound === 252, '编译器绑定/未绑定如实计数', `bound=${wfc.json.stats.bound} unbound=${wfc.json.stats.unbound} merged=${wfc.json.stats.merged}`);
    ok(wfc.json.synthetic === true, '无模板时标记 synthetic:true');
    // 2026-11-18：付费视频模型（DashScope wan2.2/2.7）已全部删除，编译入口返回 410 而不是静默改走本地
    const dsc = await req(port, 'POST', '/api/workflow/compile', { provider: 'dashscope', values: {} });
    ok(dsc.status === 410 && dsc.json.error.code === 'PROVIDER_RETIRED', 'dashscope 编译 → 410 PROVIDER_RETIRED', `${dsc.status} ${dsc.json.error && dsc.json.error.code}`);
    ok(Array.isArray(dsc.json.error.detail.retired) && dsc.json.error.detail.retired.length === 3, '410 里列出被删的三个付费视频模型', JSON.stringify(dsc.json.error.detail.retired));

    log('\n== presets ==');
    const ex = await req(port, 'POST', '/api/presets/export', { meta: { name: 'selftest' } });
    ok(ex.status === 200 && ex.json.schema === 'ai-video-platform/preset', 'POST /api/presets/export', `checksum ${ex.json.checksum}`);
    const im = await req(port, 'POST', '/api/presets/import', { preset: ex.json });
    ok(im.status === 200 && im.json.checksum_ok === true && Object.keys(im.json.values).length === 258, 'POST /api/presets/import 校验通过', `${Object.keys(im.json.values).length} 键`);

    log('\n== jobs · mock 全链路 ==');
    const cr = await req(port, 'POST', '/api/jobs', { device: 'T0', values: {} });
    ok(cr.status === 202 && cr.json.state === 'queued', 'POST /api/jobs 202 入队', `id ${cr.json.id}`);
    const jobId = cr.json.id;
    const events = await sse(port, `/api/jobs/${jobId}/events`, { timeoutMs: 20000 });
    const kinds = events.map((x) => x.event);
    ok(events.length >= 2, 'SSE 收到 ≥2 个事件', `${events.length} 个：${kinds.join(',')}`);
    const progress = events.filter((x) => x.event === 'progress');
    ok(progress.length >= 3, 'SSE 有进度帧', `progress ×${progress.length}，末帧 ${progress.length ? progress[progress.length - 1].data.percent + '%' : '-'}`);
    const done = events.find((x) => x.event === 'done');
    ok(done && done.data.state === 'succeeded', 'SSE done 事件= succeeded', done ? done.data.state : '无');
    const jd = await req(port, 'GET', '/api/jobs/' + jobId);
    ok(jd.json.state === 'succeeded' && jd.json.mock === true, '真实任务详情：succeeded 且 mock:true', `耗时 ${jd.json.actualDurationMs}ms`);
    ok(jd.json.actualPeakMib === null, '实际峰值不编造，明确 null', String(jd.json.actualPeakMib));
    ok(jd.json.estimate && jd.json.estimate.vram.peak_mib > 0, '任务记录 estimate', `peak ${jd.json.estimate.vram.peak_mib}MiB`);
    ok(Array.isArray(jd.json.images) && jd.json.images.length === 1 && jd.json.images[0].mock === true, 'mock 出图占位', jd.json.images[0] && jd.json.images[0].filename);
    ok(fs.existsSync(path.join(TMP_DIR, jobId + '.json')), '任务已落盘 %CACHE_ROOT%\\avp\\jobs', jobId + '.json');

    log('\n== jobs · 取消 ==');
    const c1 = await req(port, 'POST', '/api/jobs', { device: 'T0', values: {} });
    const c2 = await req(port, 'POST', '/api/jobs', { device: 'T0', values: {} });
    // 并发 1：c1 先跑、c2 排队；先取消排队中的 c2，再取消运行中的 c1。
    const cc2 = await req(port, 'POST', `/api/jobs/${c2.json.id}/cancel`);
    ok(cc2.status === 200 && cc2.json.state === 'canceled', '取消排队任务 → canceled', c2.json.id);
    await waitState(port, c1.json.id, ['running']);
    const cc1 = await req(port, 'POST', `/api/jobs/${c1.json.id}/cancel`);
    ok(cc1.status === 200, '取消运行中任务：受理');
    const c1end = await waitState(port, c1.json.id, ['canceled', 'succeeded']);
    ok(c1end.job.state === 'canceled', '运行中任务最终 canceled', `用时 ${c1end.ms}ms`);
    const again = await req(port, 'POST', `/api/jobs/${c1.json.id}/cancel`);
    ok(again.status === 409 && again.json.error.code === 'JOB_NOT_CANCELABLE', '重复取消→409 结构化错误', again.json.error.code);

    log('\n== jobs · 列表与 404 ==');
    const ls = await req(port, 'GET', '/api/jobs?limit=10');
    ok(ls.status === 200 && ls.json.jobs.length === 3, 'GET /api/jobs 列出 3 个任务', JSON.stringify(ls.json.stats).slice(0, 90));
    const nf = await req(port, 'GET', '/api/jobs/job_nope');
    ok(nf.status === 404 && nf.json.error.code === 'JOB_NOT_FOUND', '未知任务→404', nf.json.error.message);
    const r404 = await req(port, 'GET', '/api/nope');
    ok(r404.status === 404 && r404.json.error.code === 'NOT_FOUND', '未知路由→404 统一 JSON');
    const bad = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/estimate', headers: { 'Content-Type': 'application/json' } }, (res) => {
        let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      r.end('{oops');
    });
    ok(bad.status === 400 && JSON.parse(bad.body).error.code === 'BAD_JSON', '坏 JSON→400 BAD_JSON');

    log('\n== 静态入口 · 平台页与模块页同端口发射 ==');
    const rootIdx = await req(port, 'GET', '/');
    ok(rootIdx.status === 200 && rootIdx.json.entry === '/app/index.html', 'GET / 指明平台入口', rootIdx.json && rootIdx.json.entry);
    const appPage = await req(port, 'GET', '/app/index.html');
    ok(appPage.status === 200 && /text\/html/.test(appPage.headers['content-type'] || ''), '平台外壳 200 text/html', `${appPage.text.length}B`);
    ok(!/\/\*__(ENGINE|STATE|DATA)__\*\//.test(appPage.text), '外壳是构建产物（无未填占位符）');
    for (const p of ['/canvas/canvas.html', '/web/params.html', '/market/index.html', '/plugins/index.html', '/quality/index.html', '/server/index.html']) {
      const r = await req(port, 'GET', p);
      ok(r.status === 200 && r.text.length > 20000, `${p} 可发射`, `${r.status} ${r.text.length}B`);
    }
    const dirReq = await req(port, 'GET', '/app');
    ok(dirReq.status === 200 && dirReq.text.length > 20000, '目录请求落到 index.html（/app）', String(dirReq.status));
    const specReq = await req(port, 'GET', '/spec/params.registry.json');
    ok(specReq.status === 200 && specReq.json !== null, '/spec/*.json 可读且是合法 JSON');
    const mdReq = await req(port, 'GET', '/README.md');
    ok(mdReq.status === 403 && mdReq.json.error.code === 'TYPE_BLOCKED', '白名单外后缀（.md）→403 TYPE_BLOCKED');
    const travReq = await req(port, 'GET', '/%2e%2e/%2e%2e/Windows/win.ini');
    ok([403, 404].includes(travReq.status) && typeof travReq.text === 'string', '越界路径被拦', String(travReq.status));
    const apiMiss = await req(port, 'GET', '/api/not-a-route');
    ok(apiMiss.status === 404 && apiMiss.json.error.code === 'NOT_FOUND', '/api 下不落到静态（语义不变）');

    log('\n== recommend · 双轨推荐与防编造闸 ==');
    // 摘掉 key 强制规则轨（若环境里有 key，避免真调 Qwen 拖慢自测）。
    const recSavedKey = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      const mp = await req(port, 'GET', '/api/muse-presets');
      // 预设数量随 spec/muse.presets.json 演进（v0.2 起 7 套），断言口径改为「与 spec 一致」而非硬编码
      const museSpec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'muse.presets.json'), 'utf8'));
      ok(mp.status === 200 && mp.json.presets.length === museSpec.presets.length && mp.json.core_keys.join() === museSpec.core_keys.join(), 'GET /api/muse-presets 与 spec 一致（预设数 + core 键）', `presets=${mp.json.presets.length}`);
      ok(mp.json.presets.every((p) => p.emoji && p.example), '每个风格带 emoji + 示例占位（小白向导口径）', `count=${mp.json.presets.length}`);

      const rc = await req(port, 'POST', '/api/recommend', { prompt: '国风仙境，云海缭绕，仙侠工笔', device: 'T2' });
      ok(rc.status === 200 && rc.json.source === 'rules' && rc.json.preset.id === 'guofeng_immortal', '无 key → 规则轨且关键词命中国风预设', `source=${rc.json.source} preset=${rc.json.preset && rc.json.preset.id}`);
      ok(rc.json.ai && rc.json.ai.ok === false && rc.json.ai.error && rc.json.ai.error.code === 'DS_NO_API_KEY', '降级原因显式 DS_NO_API_KEY（不伪装 AI）', rc.json.ai && rc.json.ai.error && rc.json.ai.error.code);
      const coreKeys = mp.json.core_keys;
      ok(Object.keys(rc.json.core).length === 5 && coreKeys.every((k) => k in rc.json.core), 'core 层恰好 5 个核心键', Object.keys(rc.json.core).join(','));
      ok(Object.keys(rc.json.common).length === 39, 'common 层 39 项（L3 去 core）', String(Object.keys(rc.json.common).length));
      ok(Object.keys(rc.json.values).length === 258, 'values 全量 258 键', String(Object.keys(rc.json.values).length));
      const reg = readSpec().reg;
      const defMap = {};
      for (const p of reg.params) defMap[p.key] = p.default;
      const advKeys = Object.keys(rc.json.advanced_overrides);
      ok(advKeys.length > 0 && advKeys.every((k) => rc.json.advanced_overrides[k] !== defMap[k] && !coreKeys.includes(k)), 'advanced_overrides 只放非默认键', `${advKeys.length} 项`);
      ok(rc.json.values['mo.fx_fog'] === 65 && rc.json.values['kf.lora1_w'] === 0.6, '国风补丁落值（fog 65 / LoRA 0.6）', `fog=${rc.json.values['mo.fx_fog']} lora=${rc.json.values['kf.lora1_w']}`);
      ok(rc.json.muse_level && rc.json.muse_level.provenance === 'estimate', 'muse_level 恒标 estimate（非实测）', `score=${rc.json.muse_level && rc.json.muse_level.score}`);

      const badDev = await req(port, 'POST', '/api/recommend', { prompt: 'x', device: '不存在的档' });
      ok(badDev.status === 400 && badDev.json.error.code === 'BAD_DEVICE', '未知档位 → 400 BAD_DEVICE', badDev.json.error.code);

      const oj = await req(port, 'POST', '/api/jobs', { device: 'T0', values: {} });
      await waitState(port, oj.json.id, ['succeeded', 'failed'], { timeoutMs: 15000 });
      const oo = await req(port, 'GET', `/api/jobs/${oj.json.id}/output`);
      ok(oo.status === 404 && oo.json.error.code === 'NO_OUTPUT', 'mock 任务无成片 → output 路由 404 NO_OUTPUT（不发射占位假视频）', oo.json.error.code);

      const stepsMax = reg.params.find((p) => p.key === 'kf.steps').max;
      const gate = validateAiPayload({
        core: { 'kf.cfg': 'abc', 'kf.steps': stepsMax + 100, 'kf.sampler': '不存在的采样器' },
        common: { 'ch.不存在': 1, 'kf.seed': '保持默认' },
      }, reg);
      const reasons = gate.invalid.map((x) => x.reason);
      ok(['UNKNOWN_KEY', 'BAD_ENUM', 'NOT_A_NUMBER', 'CLAMPED'].every((r) => reasons.includes(r)), '防编造闸四类全触发', reasons.join(','));
      ok(gate.values['kf.steps'] === stepsMax && !('kf.seed' in gate.values) && !('ch.不存在' in gate.values), '越界夹取 / 保持默认跳过 / 未知键不入值', `steps→${gate.values['kf.steps']}`);

      // 模型库叠加层（spec/model.configs.json）：配置合法性 + 切换落值 + 诚实夹取/近似注记
      const mcSpec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'model.configs.json'), 'utf8'));
      const mcMap = {};
      for (const p of reg.params) mcMap[p.key] = p;
      const mcBad = [];
      for (const c of mcSpec.models) {
        for (const [k, v] of [['kf.sampler', c.sampler], ['kf.scheduler', c.scheduler]]) {
          if (v != null && !mcMap[k].options.includes(v)) mcBad.push(`${c.id}:${k}=${v}`);
        }
        for (const [k, v] of Object.entries(c.registry_map || {})) {
          if (!mcMap[k] || !mcMap[k].options.includes(v)) mcBad.push(`${c.id}:map ${k}=${v}`);
        }
        if (!c.id || !c.name || !c.type || !c.placeholder || !c.tips) mcBad.push(`${c.id}:缺字段`);
      }
      ok(mcSpec.models.length === 9 && mcSpec.models.filter((c) => c.type === 'image').length === 6 && mcSpec.models.filter((c) => c.type === 'video').length === 3 && mcBad.length === 0, 'model_configs 9 模型（6 图像 + 3 视频）枚举/映射全合法', mcBad.join(',') || 'invalid=0');

      const rFlux = await req(port, 'POST', '/api/recommend', { prompt: '窗台产品静物', device: 'T0', model_id: 'flux_schnell' });
      ok(rFlux.status === 200 && rFlux.json.model_id === 'flux_schnell' && rFlux.json.values['kf.cfg'] === 7 && rFlux.json.values['kf.sampler'] === 'euler', '图像模型建议经质量区间夹取CFG，model_id仍回显', `cfg=${rFlux.json.values['kf.cfg']} sampler=${rFlux.json.values['kf.sampler']}`);
      ok(/low saturation/.test(rFlux.json.values['ch.negative']), 'Flux 负面词切轻模板', rFlux.json.values['ch.negative']);

      const rPony = await req(port, 'POST', '/api/recommend', { prompt: '1girl, silver hair', device: 'T0', model_id: 'pony' });
      ok(rPony.json.values['ch.negative'].includes('lowres') && rPony.json.values['kf.sampler'] === 'dpmpp_2m' && rPony.json.values['kf.cfg'] === 7, '选 Pony → Danbooru 负面词 + DPM++ 2M Karras 基线', `cfg=${rPony.json.values['kf.cfg']}`);
      ok(rPony.json.values['kf.scheduler'] === 'karras', 'Karras 调度器落 kf.scheduler', rPony.json.values['kf.scheduler']);

      const rQwen = await req(port, 'POST', '/api/recommend', { prompt: '江南雨巷人像', device: 'T0', model_id: 'qwen_image2' });
      ok(rQwen.json.values['kf.model'] === 'Qwen-Image-GGUF-Q4' && /plastic skin/.test(rQwen.json.values['ch.negative']) && /cinematic lighting/.test(rQwen.json.values['ch.prompt_prefix']), '选 Qwen-Image2 → 底模映射 + 负面词 + 正向后缀', rQwen.json.values['kf.model']);
      ok(rQwen.json.values['kf.resolution'] === 1280 && rQwen.json.values['kf.ratio'] === '1:1' && rQwen.json.model_notes.some((n) => /近似/.test(n)), '1024×1280 无 4:5 枚举 → 1:1 近似且如实注记', `res=${rQwen.json.values['kf.resolution']} ratio=${rQwen.json.values['kf.ratio']}`);

      const rWan = await req(port, 'POST', '/api/recommend', { prompt: '金鱼珊瑚礁', device: 'T0', model_id: 'wan21_t2v' });
      // mo.duration 上限 2026-11-18 起从 3s 放到 15s（wan2.7 单次最长 15s）：Wan 推荐的 5s 不再被夹取
      ok(rWan.json.values['mo.i2v_model'] === 'Wan2.1-1.3B' && rWan.json.values['mo.fps'] === 24 && rWan.json.values['mo.duration'] === 5, 'Wan推荐保留5s，低帧率夹到原生24fps下限', `duration=${rWan.json.values['mo.duration']} fps=${rWan.json.values['mo.fps']}`);
      ok(rWan.json.values['kf.resolution'] === 1280 && rWan.json.values['kf.ratio'] === '16:9', '720p = 1280 × 16:9 精确落值', `${rWan.json.values['kf.resolution']} ${rWan.json.values['kf.ratio']}`);

      const badModel = await req(port, 'POST', '/api/recommend', { prompt: 'x', model_id: '不存在的模型' });
      ok(badModel.status === 400 && badModel.json.error.code === 'BAD_MODEL', '未知 model_id → 400 BAD_MODEL', badModel.json.error.code);
      ok(rc.json.model_id === null, '不带 model_id → 回显 null（风格驱动不受影响）', String(rc.json.model_id));
    } finally {
      if (recSavedKey !== undefined) process.env.DASHSCOPE_API_KEY = recSavedKey;
    }

    log('\n== provider · 真实后端不可达不静默降级 ==');
    // 付费视频模型删除后：dashscope 不再是可构造的 provider，必须显式报 PROVIDER_RETIRED（不留半可用入口）
    const { createProvider: createProv } = require('./providers/index.js');
    let retiredThrown = null;
    try { createProv({ id: 'dashscope' }); } catch (e) { retiredThrown = e; }
    ok(retiredThrown && retiredThrown.code === 'PROVIDER_RETIRED', 'createProvider(dashscope) → PROVIDER_RETIRED', retiredThrown && retiredThrown.code);
    ok(/已下线/.test(String(retiredThrown && retiredThrown.message)), '下线错误给人话原因', retiredThrown && retiredThrown.message);
    const { PROVIDER_IDS } = require('./providers/index.js');
    ok(!PROVIDER_IDS.includes('dashscope') && PROVIDER_IDS.includes('comfy') && PROVIDER_IDS.includes('seedream'), 'provider 清单只剩本地/图像通道', PROVIDER_IDS.join(','));
    log('\n== cine · 一句话电影管线（纯函数 + 假传输全链路 + HTTP 契约，零计费） ==');
    const CINE = require('./cine.js');
    ok(CINE.GROUPS.length === 8, '8 组关键帧方向齐备', CINE.GROUPS.map((g) => g.id).join(','));
    ok(CINE.MODIFIERS.includes('shot on ARRI Alexa Mini') && CINE.NEGATIVE.includes('plastic skin'), '规格修饰词/负面词逐字在位');
    ok(CINE.MOTION_PROMPT.startsWith('almost static') && CINE.MOTION_NEG.includes('head turn'), '规格运动提示词/视频负面词逐字在位');
    const pj = CINE.parseJsonReply('废话```json\n{"a":1}\n```尾巴');
    ok(pj.a === 1, 'parseJsonReply 容忍围栏与前后废话');
    let threw = false;
    try { CINE.parseJsonReply('没有 json'); } catch (e) { threw = e.code === 'CINE_BAD_JSON'; }
    ok(threw, '抠不出 JSON 抛 CINE_BAD_JSON（不猜分数）');
    const ns = CINE.normalizeScores({ dims: { fit: 2, composition: 1.6, light: 2, face: 1.8, style: 1.6 }, diagnosis: 'd', fix: 'f' });
    ok(ns.total === 9, '五维各2分满分10：0-2 之和=总分（内部×5均值同值）', String(ns.total));
    const fx = CINE.diagnoseFix({ dims: { fit: 9, composition: 9, light: 9, face: 4, style: 9 } }, 'extra tokens');
    ok(fx.dim === 'face' && fx.tokens.includes('natural facial anatomy') && fx.cfg === 5.5 && fx.cfgApplicable === false, '脸崩→face 修复词 + CFG5.5 记录但标不可执行', fx.tokens);
    const fxW = CINE.diagnoseFix({ dims: { fit: 9, composition: 9, light: 9, face: 9, style: 9 }, western_face: true }, '');
    ok(fxW.rule === 'western' && fxW.loraWeight === 0.85 && fxW.tokens.includes('pure Chinese beauty face'), '西方面孔→网红脸POS+LoRA0.85（记录口径）', fxW.rule);
    ok(Object.keys(CINE.STYLE_WORDS).length === 7 && CINE.STYLE_WORDS.cinema.pos.includes('Kodak Vision3 500T') && CINE.STYLE_WORDS.guofeng.neg.includes('western castle'), '七风格词库 POS/NEG 逐字在位');
    ok(CINE.FACE_POS.includes('(pure Chinese beauty face:1.15)') && CINE.FACE_POS.includes('(visible skin pores retained:1.1)') && CINE.FACE_POS.includes('(dewy highlight on cheekbones and nose tip:1.2)') && !CINE.FACE_POS.includes('no visible pores') && CINE.FACE_NEG.includes('plastic doll face') && CINE.FACE_NEG.includes('waxy over-smoothed skin') && !CINE.FACE_NEG.includes('natural visible pores') && CINE.FACE_NEG.includes('caucasian western face'), '统一网红脸 POS/NEG 与 reverse.capabilities 对齐（保毛孔+水光，去塑料条款）');
    ok(CINE.FACE_STYLE_ADD.guofeng.includes('柳叶细眉') && CINE.FACE_STYLE_ADD.cyber.includes('烟熏眼妆') && CINE.FACE_TECH.lora.id === 'influencerBeauty_v1' && CINE.FACE_TECH.lora.default_weight === 0.75, '分风格人脸追加 + influencerBeauty LoRA 0.75');
    ok(CINE.clampLora(0.5) === 0.6 && CINE.clampLora(0.95) === 0.9 && CINE.clampLora(undefined) === 0.75 && CINE.beautyDefault('cinema') === 40 && CINE.beautyDefault('cyber') === 70 && CINE.beautyDefault('doc') === 60, 'LoRA 夹取0.60~0.90 + 美颜分风格默认');
    const ffx = CINE.diagnoseFaceFix({ faceFlags: { eyesSmall: true, wideFace: true, skinBlemish: true }, western_face: false });
    ok(ffx.tokens.includes('double eyelids:1.20') && ffx.beautyAdd === 20 && ffx.hit.length === 3, '脸诊断→眼/脸/皮肤修正+美颜+10%×2');
    ok(CINE.detectAge('白发老人') === 'old' && CINE.detectAge('年轻女生') === 'young' && CINE.detectAge('少年') === 'teen', '年龄追加词检测');
    const seeds = CINE.groupSeeds(8);
    ok(seeds.length === 8 && new Set(seeds).size === 8, '8 组种子互不相同', seeds.join(','));
    ok(CINE.DEFAULT_RATIO === '16:9' && CINE.keyframeSize('随便一句') === '1280*720', '平台默认 16:9 横屏', CINE.keyframeSize('随便一句'));
    ok(CINE.keyframeSize('竖幅人像') === '720*1280' && CINE.keyframeSize('x', '2:3') === '1024*1536' && CINE.keyframeSize('x', '1:1') === '1024*1024', '比例可选：9:16/2:3/1:1 映射尺寸');
    ok(CINE.ratioFor('x', '9:16') === '9:16' && CINE.ratioFor('竖屏vlog') === '9:16' && CINE.ratioFallback('x', '16:9') === '1536*1024', '比例显式优先/竖屏关键词/回退尺寸');
    ok(CINE.detectCamera('镜头推近').fixed === false && CINE.detectCamera('安静侧脸').fixed === true, '仅明确运镜才运镜，默认固定机位');
    const gp = CINE.buildGroupPrompt({ subject: '轮渡上的女生侧脸', scene: '黄昏江面', style_id: 'cinematic-real' }, CINE.GROUPS[2], '');
    ok(gp.includes('轮渡上的女生侧脸') && gp.includes('backlit silhouette') && gp.includes(CINE.MODIFIERS) && gp.includes('(pure Chinese beauty face:1.15)') && gp.includes('(cinematic film still:1.15)'), '组提示词=槽位+组方向+风格词库+网红脸+加权+修饰词');
    const gpA = CINE.buildGroupPrompt({ subject: '魔法少女', style_id: 'anime' }, CINE.GROUPS[0], '', { styleId: 'anime' });
    ok(!gpA.includes('pure Chinese beauty face') && gpA.includes('cel shading'), 'anime 不挂写实网红脸块、挂二次元词库');
    ok(CINE.buildGroupNegative('extra neg').startsWith(CINE.NEGATIVE), '统一负面词在前、追加词在后');
    ok(CINE.buildGroupNegative('', { styleId: 'cinema' }).includes('caucasian western face'), '写实类负面词挂人脸 NEG');
    const cubeC = CINE.buildStyleCube('cinema', 9), cubeD = CINE.buildStyleCube('dream', 9);
    ok(cubeC !== cubeD && cubeC.includes('LUT_3D_SIZE 9'), '分风格 LUT 各不相同');
    const goodFrames = Array.from({ length: 48 }, () => ({ sharp: 1, flicker: 0.1, flowResidual: 0.1, status: 'ok' }));
    ok(CINE.qaPixelGate(goodFrames).pass === true, 'M6 像素闸：标定基线内好片过闸');
    const badFrames = Array.from({ length: 48 }, (_, i) => ({ sharp: i < 10 ? 0.3 : 1, flicker: 0.1, flowResidual: 0.1, status: i < 10 ? 'bad' : 'ok' }));
    const badGate = CINE.qaPixelGate(badFrames);
    ok(badGate.pass === false && badGate.reasons.length >= 1, 'M6 像素闸：虚焦/坏帧超基线→淘汰并给原因', badGate.reasons.join(';'));
    ok(CINE.QA_BASELINE.provenance === 'calibrated' && CINE.QA_BASELINE.frames === 948, 'M6 阈值来自实测标定（948 帧）非拍脑袋');
    ok(CINE.buildFilmicCube('cinema', 0.3, 9) !== CINE.buildFilmicCube('cinema', 0.7, 9), 'M8 filmic LUT 随关键帧曝光匹配变化');
    const st = CINE.buildShotTable({ subject: 's', shot: '近景', mood: 'm', light: 'l' }, 'p', { zh: '固定机位' }, 5);
    ok(st.length === 1 && st[0].no === 1 && st[0].camera === '固定机位' && st[0].duration === 5 && st[0].firstFrameDesc, 'M1 分镜表字段齐备（单镜闭环）');
    const chain2 = CINE.postFilterChain('D:/x/l.cube', 1080, 1608);
    ok(chain2.includes('gblur') && chain2.includes('blend=all_mode=screen') && chain2.includes('deflicker') && chain2.includes('[vout]'), 'M8 链含 halation(gblur+screen)/deflicker/gate weave');
    const cube = CINE.buildTealOrangeCube(17);
    ok(cube.split('\n').filter(Boolean).length === 4 + 17 * 17 * 17 && cube.includes('LUT_3D_SIZE 17'), '.cube 点数=尺寸³+4 行头', String(cube.split('\n').filter(Boolean).length));
    const pt = CINE.postTargetSize(784, 1168);
    ok(pt.w === 1080 && pt.h === 1608, '竖幅源→宽 1080 保持宽高比（实测 784x1168）', `${pt.w}x${pt.h}`);
    const pl = CINE.postTargetSize(1280, 720);
    ok(pl.w === 1920 && pl.h === 1080, '横幅源→1920x1080', `${pl.w}x${pl.h}`);
    const chain = CINE.postFilterChain('D:/x/lut.cube', 1080, 1608);
    ok(chain.includes('minterpolate=fps=48') && chain.includes('lut3d=') && chain.includes('vignette=') && chain.includes('noise=') && chain.includes('crop='), '后处理链含插帧/LUT/暗角/颗粒/手持五件');
    ok(CINE.POST_SUBSTITUTIONS.some((s) => s.is_rife === false) && CINE.POST_SUBSTITUTIONS.some((s) => s.is_esrgan === false), 'RIFE/ESRGAN 替代如实标 false（不冒充）');

    // 假传输跑完整七步：第 3 组首评 8 分触发一次重试，其余 9.3 分；验证重试/选优/进度文案/提交透明。
    let judgeCalls = 0, imgCalls = 0;
    const progTexts = [];
    let submitted = null;
    const groupsSeen = [];
    let pickArg = null;
    const fakeTransport = {
      chat: async (messages) => ({ text: JSON.stringify({ subject: '轮渡上的女生侧脸', scene: '黄昏江面', light: '逆光', mood: '克制', camera: '固定机位', shot: '近景', style_id: 'cinematic-real', reason: '测试' }), model: 'qwen-plus(fake)', usage: null }),
      genImage: async (p, neg) => { imgCalls += 1; return { url: 'fake://img' + imgCalls, usage: { image_count: 1 }, request: { model: 'qwen-image-2.0(fake)' }, requestId: 'r' + imgCalls }; },
      judge: async (url) => {
        const i = judgeCalls++;
        const low = i === 2; // 第 3 组首评
        const dims = low ? { fit: 9, composition: 9, light: 3, face: 9, style: 9 } : { fit: 9.3, composition: 9.3, light: 9.3, face: 9.3, style: 9.3 };
        const total = low ? 7.8 : 9.3;
        return { dims, total, diagnosis: low ? '光影平' : '达标', fix: low ? 'rim light' : '', western_face: false, limb_deformity: false, model: 'qwen3-vl-plus(fake)', provenance: 'model-opinion' };
      },
      downloadTo: async (url, file) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fake'); return 4; },
      ffprobeJson: async () => ({ streams: [{ codec_type: 'video', width: 784, height: 1168, r_frame_rate: '30/1', nb_frames: '150' }] }),
      i2vSubmit: async () => ({ output: { task_id: 'fake-task-1' }, request_id: 'req-1' }),
      i2vStatus: async () => ({ output: { task_status: 'SUCCEEDED', video_url: 'fake://video', submit_time: 's', end_time: 'e' }, usage: { duration: 5 } }),
      postProcess: async (src, dst) => { fs.writeFileSync(dst, 'fake'); return { file: dst, bytes: 4, probe: { streams: [{ codec_type: 'video', width: 1080, height: 1608, r_frame_rate: '48/1', nb_frames: '240' }] }, filter: 'fake', substitutions: CINE.POST_SUBSTITUTIONS, target: { w: 1080, h: 1608 } }; },
      qa: async () => ({ ok: true, frames: Array.from({ length: 48 }, () => ({ sharp: 1, flicker: 0.1, flowResidual: 0.1, status: 'ok' })) }),
      muxAudio: async (v, out) => { fs.writeFileSync(out, 'fake'); return { file: out, bytes: 4, source: 'synthetic-ambient', native: false }; },
      vlAudit: async () => ({ faceOk: true, handsOk: true, bodyOk: true, perspectiveOk: true, consistencyOk: true, artifactOk: true, phantomFace: false, extraPersonOk: true, watermark: false, gibberishText: false, composition: true, emotion: true, vlScore: 9, tags: [], vlModel: 'fake-vl' }),
      publishToCloud: async (file) => ({ file, bytes: 4 }),
    };
    const fakeJob = { id: 'cine_selftest', cinePrompt: '轮渡上的女生侧脸', note: null };
    const cres = await CINE.runCine(fakeJob, {
      onProgress: (p) => progTexts.push(p.text),
      onSubmitted: (x) => { submitted = x; },
      onGroup: (g) => groupsSeen.push(g),
      onPick: async (def, opts) => { pickArg = { def, opts }; return def; },
    }, fakeTransport);
    ok(cres.meta.cineReport.groups.length === 8 && groupsSeen.length === 8, '七步跑完 8 组且逐组上报', String(groupsSeen.length));
    const g3 = cres.meta.cineReport.groups[2];
    ok(g3.attempts.length === 2 && g3.attempts[0].fix && g3.attempts[0].fix.dim === 'light', '第 3 组 8 分→诊断→重试一次达标', `attempts=${g3.attempts.length}`);
    ok(progTexts.some((t) => t === '正在分析你的描述...') && progTexts.some((t) => t === '正在打磨8组关键帧（第3/8组）...') && progTexts.some((t) => t.startsWith('第3组') && t.includes('重新生成')) && progTexts.some((t) => t === '8组精品已就绪，正在选最优...') && progTexts.some((t) => t === '正在图生视频...') && progTexts.some((t) => t === '正在电影级后处理...'), '进度文案与规格【二】逐字对齐');
    ok(submitted && submitted.meta.dsRequest.input.prompt === CINE.MOTION_PROMPT && submitted.meta.dsRequest.input.negative_prompt === CINE.MOTION_NEG && submitted.meta.dsRequest.parameters.duration === 5 && submitted.meta.dsRequest.parameters.resolution === '720P', 'i2v 请求透明：运动词/负面词/5s/720P 逐字', submitted.taskId);
    ok(cres.meta.cineReport.pick.source === 'model' && pickArg.opts.length === 8, '选优走模型总分最高 + 8 候选改选窗口');
    ok(cres.images.length === 8 && cres.images.filter((c) => c.picked).length === 1, '8 候选保留且唯一 picked 标');
    ok(cres.output.fps === 48 && cres.output.width === 1080, '成片 48fps / 宽 1080（measured-from-fake-probe）', `${cres.output.width}x${cres.output.height}@${cres.output.fps}`);
    ok(cres.meta.cineReport.warnings.some((w) => w.code === 'CINE_FPS_DEVIATION'), '源 30fps ≠ 规格 16fps 如实告警');
    ok(cres.meta.cineReport.keyframeBaselineNote.applicable === false, 'ComfyUI 采样器基线标不可执行（不假装设置过）');
    ok(cres.meta.cineReport.qa && cres.meta.cineReport.qa.pass === true && cres.meta.cineReport.qa.pixel.pass === true, 'M6 QA 双闸：像素+审美都过（假传输好片）');
    ok(cres.meta.cineReport.audio && cres.meta.cineReport.audio.source === 'synthetic-ambient' && cres.meta.cineReport.audio.native === false, 'M9 声音：合成环境声如实标 synthetic/非原生');
    ok(cres.meta.cineReport.shots.length === 1 && cres.meta.cineReport.gradePreset && cres.meta.cineReport.gradePreset.filmic === true, 'M1 分镜表 + M8 filmic 调色预设落报告');
    // 改选窗口：用户选第 1 组 → pick.source=user
    judgeCalls = 0; imgCalls = 0;
    const cres2 = await CINE.runCine({ id: 'cine_selftest2', cinePrompt: '轮渡上的女生侧脸' }, { onPick: async () => 1 }, fakeTransport);
    ok(cres2.meta.cineReport.pick.source === 'user' && cres2.meta.cineReport.pick.index === 1 && cres2.images[1].picked === true, '人工改选生效且 picked 跟随');
    // 重试 3 次仍不达标 → 保留最高分 + 如实告警，不谎报 9 分
    judgeCalls = 0; imgCalls = 0;
    const alwaysLow = { ...fakeTransport, judge: async () => ({ dims: { fit: 7, composition: 7, light: 7, face: 7, style: 7 }, total: 7, diagnosis: 'd', fix: '', western_face: false, limb_deformity: false, provenance: 'model-opinion' }) };
    const cres3 = await CINE.runCine({ id: 'cine_selftest3', cinePrompt: '测试低分重试用例' }, {}, alwaysLow);
    ok(cres3.meta.cineReport.groups.every((g) => g.attempts.length === 4 && g.belowTarget === true) && cres3.meta.cineReport.warnings.filter((w) => w.code === 'CINE_GROUP_BELOW_TARGET').length === 8, '重试上限 3 次后保留最高分并逐组告警（不谎报达标）');
    for (const id of ['cine_selftest', 'cine_selftest2', 'cine_selftest3']) {
      try { fs.rmSync(path.join(CINE.CINE_DIR, id), { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
    }
    // 多镜头短片（M1/M4/M7）零计费假传输：3 镜×4 候选=12 图、3 次 i2v、xfade 组接、整片声、终审 QA
    judgeCalls = 0; imgCalls = 0;
    const multiTransport = {
      ...fakeTransport,
      concat: async (files, durs, cf, out) => { fs.writeFileSync(out, 'fake'); return { file: out, bytes: 4, transition: 'crossfade', crossfade: cf, totalDuration: 14 }; },
      lastFrame: async (v, p) => { fs.writeFileSync(p, 'fake'); return p; },
      exposure: async () => 0.5,
    };
    const mres = await CINE.runCineMultiShot({ id: 'cine_multi_selftest', cinePrompt: '轮渡上的女生侧脸', cineStyle: 'muse_cinematic', cineMulti: true }, {}, multiTransport);
    const mrep = mres.meta.cineReport;
    ok(mrep.mode === 'multi' && mrep.shots.length === 3 && mrep.groups.length === 3, 'M1 多镜分镜 3 镜逐镜生产', `shots=${mrep.shots.length}`);
    ok(imgCalls === 12, 'M3/M5 每镜 4 候选共 12 图', `imgCalls=${imgCalls}`);
    ok(mrep.timeline && mrep.timeline.transition === 'crossfade' && mrep.timeline.totalDuration === 14 && mrep.timeline.shots.length === 3, 'M7 xfade 组接时间线落报告', JSON.stringify(mrep.timeline));
    ok(mrep.shots.every((s) => s.lock && s.lock.includes('same character')) && mrep.shots[1].firstFrameUsed, 'M4 锁定描述随镜传递');
    ok(mrep.qa && mrep.qa.pass === true && mrep.audio && mrep.audio.source === 'synthetic-ambient', '多镜终审 QA + 整片声');
    ok(mrep.status === 'success' && mres.output.file, '多镜入库 status/output');
    try { fs.rmSync(path.join(CINE.CINE_DIR, 'cine_multi_selftest'), { recursive: true, force: true }); } catch { /* 忽略 */ }
    // 严苛审核机制（五道闸/三态/一票否决/加权评分/留痕）
    const AUD = require('./audit.js');
    ok(AUD.inputGate({ prompt: 'ab' }).pass === false && AUD.inputGate({ prompt: '轮渡上的女生侧脸' }).pass === true, 'G0 输入闸：过短退回、合格放行');
    const goodM = { sharpMin: 1, flickerMean: 0.1, flickerMax: 0.3, flowMean: 0.1, flowMax: 0.2, blackFrameRatio: 0, freezeFrameRatio: 0, jitter: 0, histDrift: 0, deadWhiteRatio: 0, deadBlackRatio: 0 };
    const goodVl = AUD.vlGate({ faceOk: true, handsOk: true, bodyOk: true, perspectiveOk: true, consistencyOk: true, artifactOk: true, composition: true, emotion: true, phantomFace: false, extraPersonOk: true, watermark: false, gibberishText: false }, 'image');
    const dPass = AUD.decide({ metrics: goodM, auto: AUD.autoGate(goodM, AUD.thresholdFor()), vl: goodVl, type: 'image', th: AUD.thresholdFor() });
    ok(dPass.decision === 'PASS' && dPass.total >= 9, '三态：全优→PASS 精选', String(dPass.total));
    const badVl = AUD.vlGate({ faceOk: false, handsOk: true, bodyOk: true, perspectiveOk: true, consistencyOk: true, artifactOk: true, composition: true, emotion: true, phantomFace: false, extraPersonOk: true, watermark: false, gibberishText: false }, 'image');
    const dVeto = AUD.decide({ metrics: goodM, auto: AUD.autoGate(goodM, AUD.thresholdFor()), vl: badVl, type: 'image', th: AUD.thresholdFor() });
    ok(dVeto.decision === 'REJECT' && dVeto.vetoHits.includes('faceDefect'), '一票否决：脸崩即 REJECT 不被总分抵扣', dVeto.vetoHits.join(','));
    const lowStruct = AUD.vlGate({ faceOk: false, handsOk: false, bodyOk: false, perspectiveOk: false, consistencyOk: true, artifactOk: true, composition: true, emotion: true, phantomFace: false, extraPersonOk: true, watermark: false, gibberishText: false }, 'image');
    // 结构低但无否决项不可能（faceOk false 即否决）；改用结构中等偏低+氛围高验证 cap：用 vlGate 结构=6（null 项）
    const nullStruct = AUD.vlGate({ faceOk: null, handsOk: null, bodyOk: null, perspectiveOk: null, consistencyOk: true, artifactOk: true, composition: true, emotion: true, phantomFace: null, extraPersonOk: true, watermark: false, gibberishText: false }, 'image');
    const dReview = AUD.decide({ metrics: goodM, auto: AUD.autoGate(goodM, AUD.thresholdFor()), vl: nullStruct, type: 'image', th: AUD.thresholdFor() });
    ok(dReview.decision === 'REVIEW', 'VL 结构缺结论→REVIEW 人工（不假装自动判过）', dReview.decision);
    const dNoVl = AUD.decide({ metrics: goodM, auto: AUD.autoGate(goodM, AUD.thresholdFor()), vl: AUD.vlGate(null, 'video'), type: 'video', th: AUD.thresholdFor() });
    ok(dNoVl.decision === 'REVIEW', '视频 VL 不可用→REVIEW', dNoVl.decision);
    ok(AUD.DEFECT_TAGS.includes('phantomFace') && AUD.DEFECT_TAGS.includes('faceCountDrift') && AUD.THRESHOLD_PRESETS.version, '缺陷字典+阈值版本化在位');
    const crepA = cres.meta.cineReport;
    ok(crepA.audit && crepA.audit.length === 10 && crepA.audit[0].decision === 'PASS' && crepA.audit[9].decision === 'REVIEW', 'G1×8 + G2 + G3 留痕（视频结构→REVIEW）', `audit=${crepA.audit.length}`);
    ok(crepA.compliance && crepA.compliance.pass === true && crepA.qa.thresholdVersion, 'G4 合规闸 + 阈值版本入报告');
    // 氛围审美层（8 题材配方 + 词库 + 分题材参数/调色/声音）
    const AES = require('./aesthetics.js');
    ok(AES.themes().length === 8 && AES.words().negative.includes('塑料皮肤'), '8 氛围题材 + 通用负面词库在位');
    ok(AES.matchTheme('日落黄昏公路背影').theme.id === 'sunset_gold' && AES.matchTheme('雪林晨雾').theme.id === 'forest_snow' && AES.matchTheme('完全无关句子') === null, '题材关键词匹配（无命中不硬套）');
    ok(AES.promptSuffix(AES.recipeById('night_neon')).includes('霓虹') && AES.paramRules(AES.recipeById('sunset_gold')).applicable === false, '配方拼接 + 参数请求口径 applicable:false');
    judgeCalls = 0; imgCalls = 0;
    const themed = await CINE.runCine({ id: 'cine_theme_selftest', cinePrompt: '日落黄昏公路背影', cineTheme: 'sunset_gold', cineRatio: '9:16' }, {}, fakeTransport);
    const trep = themed.meta.cineReport;
    ok(trep.aesthetics && trep.aesthetics.themeId === 'sunset_gold' && trep.gradePreset.theme === 'sunset_gold' && trep.ratio === '9:16', '题材入报告 + 调色预设按题材 + 竖屏画幅', trep.aesthetics && trep.aesthetics.grade);
    ok(trep.groups[0].best.prompt.includes('golden hour') || trep.groups[0].attempts[0].prompt.includes('golden hour'), '氛围光影词拼进关键帧提示词');
    try { fs.rmSync(path.join(CINE.CINE_DIR, 'cine_theme_selftest'), { recursive: true, force: true }); } catch { /* 忽略 */ }
    // 分辨率白名单 + 自动映射 + dry-run 预检（P0：杜绝非法分辨率提交云端）
    const DS = require('./ds.js');
    ok(DS.VIDEO_SIZE_WHITELIST.length === 8 && DS.VIDEO_SIZE_WHITELIST.includes('1632*1248') && !DS.VIDEO_SIZE_WHITELIST.includes('1280*720'), 'wan2.2 视频白名单 8 档（1280*720 非法）');
    ok(DS.mapVideoSize({ ratio: '9:16', res: '1080p' }).size === '1080*1920' && DS.mapVideoSize({ ratio: '16:9', res: '720p' }).size === '832*480' && DS.mapVideoSize({ ratio: '1:1', res: '720p' }).size === '624*624', '画幅×档位→合法档位（含低清降档）');
    ok(DS.mapVideoSize({ ratio: '9:16', res: '1080p', device: 'T0-low' }).size === '480*832', 'T0-low 显存降档→低清');
    const m23 = DS.mapVideoSize({ ratio: '2:3', res: '1080p' });
    ok(DS.VIDEO_SIZE_WHITELIST.includes(m23.size) && m23.mapped === true, '非直配比例 2:3 就近映射到白名单', m23.size);
    for (const ratio of ['16:9', '9:16', '1:1', '4:3', '3:4', '2:3', '3:2', '2.35:1']) for (const res of ['720p', '1080p']) {
      const s = DS.mapVideoSize({ ratio, res }).size;
      if (!DS.VIDEO_SIZE_WHITELIST.includes(s)) { ok(false, '映射越界 ' + ratio + '@' + res, s); }
    }
    ok(true, '全比例×全档位映射均落在白名单');
    const badReq = { input: { prompt: 'x' }, parameters: { size: '1280*720', duration: 5 } };
    // 付费视频模型删除后：DS 编译器只剩「明确拒绝」这一种行为，模型表为空
    ok(Object.keys(DS.MODEL_CAPS).length === 0, 'MODEL_CAPS 已清空（付费视频模型全删）', Object.keys(DS.MODEL_CAPS).join(','));
    const errs = DS.validateDsRequest(badReq, 'wan2.2-t2v-plus');
    ok(errs.some((e) => /已全部移除/.test(e.legal)), 'validate 返回「付费模型已移除」', JSON.stringify(errs));
    let compThrew = null;
    try { DS.compileDsRequest({}, { registry: readSpec().reg, model: 'wan2.2-t2v-plus' }); } catch (e) { compThrew = e; }
    ok(compThrew && compThrew.code === 'DS_PAID_MODEL_REMOVED', 'compile 抛 DS_PAID_MODEL_REMOVED', compThrew && compThrew.code);
    ok(CINE.styleFor('doc') === 'doc' && CINE.styleFor('guofeng') === 'guofeng' && CINE.styleFor('dark') === 'dark' && CINE.styleFor('dream') === 'dream' && CINE.styleFor('real_photo') === 'doc', 'styleFor 接受已映射 id（doc/guofeng/dark/dream 不再误落 cinema）');
    const gpDoc = CINE.buildGroupPrompt({ subject: '人像', style_id: 'doc' }, CINE.GROUPS[0], '', { styleId: 'doc' });
    ok(gpDoc.includes('documentary still') && CINE.buildGroupNegative('', { styleId: 'doc' }, {}).includes('studio softbox'), 'doc 风格 POS/NEG 真挂载');
    // 入队前预检：付费通道已删，预检只在云端存在时生效 → 这里验证本地 provider 不再有 DS 预检分支
    const preSvc = createApp({ providerId: 'comfy', restore: false, jobsDir: TMP_DIR + '-pre' });
    const preAddr = await preSvc.listen(0);
    const preBlank = await req(preAddr.port, 'POST', '/api/jobs', { device: 'T0', values: { 'ch.subject': '   ' } });
    ok(preBlank.status === 202, '本地 provider 不再有云端预检分支（受理后由 ComfyUI 连通性决定失败）', String(preBlank.status));
    const preOver = await req(preAddr.port, 'POST', '/api/jobs', { device: 'T0', values: { 'ch.subject': 'x', 'kf.cfg': 99, 'kf.steps': 999 } });
    ok(preOver.status === 202, '超区间 cfg/steps 由注册表夹取，不再 400', String(preOver.status));
    await preSvc.app.jobs.close();
    preSvc.server.close();
    try { fs.rmSync(TMP_DIR + '-pre', { recursive: true, force: true }); } catch { /* 忽略 */ }

    // HTTP 契约：kind 校验 / 无 key 如实 failed / 选优与候选路由的错误形状
    const savedKey2 = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    const cineSvc = createApp({ jobsDir: TMP_DIR + '-cinehttp', providerId: 'cine', restore: false });
    const cineAddr = await cineSvc.listen(0);
    try {
      const empty = await req(cineAddr.port, 'POST', '/api/jobs', { kind: 'cine', prompt: '  ' });
      ok(empty.status === 400 && empty.json.error.code === 'CINE_EMPTY_PROMPT', '空一句话 → 400 CINE_EMPTY_PROMPT', empty.json.error.code);
      const badKind = await req(cineAddr.port, 'POST', '/api/jobs', { kind: 'nope', prompt: 'x' });
      ok(badKind.status === 400 && badKind.json.error.code === 'BAD_KIND', '未知 kind → 400 BAD_KIND');
      const cj = await req(cineAddr.port, 'POST', '/api/jobs', { kind: 'cine', prompt: '轮渡上的女生侧脸' });
      ok(cj.status === 202 && cj.json.provider === 'cine' && cj.json.kind === 'cine', 'cine 任务受理且 provider 显式 cine', cj.json.provider);
      const cEnd = await waitState(cineAddr.port, cj.json.id, ['failed', 'succeeded'], { timeoutMs: 15000 });
      ok(cEnd.job.state === 'failed' && cEnd.job.error.code === 'CINE_CLOUD_RETIRED' && cEnd.job.mock === false, 'cine 云端已下线 → failed 且不打 mock', cEnd.job.error.code);
      const noPick = await req(cineAddr.port, 'POST', `/api/jobs/${cj.json.id}/pick`, { index: 0 });
      ok(noPick.status === 409 && noPick.json.error.code === 'JOB_NOT_PICKABLE', '非运行态改选 → 409 JOB_NOT_PICKABLE');
      const noCand = await req(cineAddr.port, 'GET', `/api/jobs/${cj.json.id}/candidates/1`);
      ok(noCand.status === 404 && noCand.json.error.code === 'NO_CANDIDATE', '无候选 → 404 NO_CANDIDATE');
    } finally {
      await cineSvc.app.jobs.close();
      cineSvc.server.close();
      try { fs.rmSync(TMP_DIR + '-cinehttp', { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
      if (savedKey2 !== undefined) process.env.DASHSCOPE_API_KEY = savedKey2;
    }
  } catch (e) {
    fail += 1;
    log('  ✗ 未捕获异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  } finally {
    await svc.app.jobs.close();
    svc.server.close();
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }

  log('\n== 结果 ==');
  log(`  通过 ${pass} · 失败 ${fail}`);
  if (fail === 0) { log('全部通过'); process.exit(0); }
  else { log('存在失败项'); process.exit(1); }
})();