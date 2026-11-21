/**
 * app.js —— HTTP API（node 原生 http，零依赖）
 *
 * 为什么手写路由表而不是一堆 if：路由少数固定，一张 [method, regex, handler] 表既
 * 能一眼看清全部端点，也方便 /api/jobs/:id 这类参数路由。
 *
 * 统一错误 JSON：所有失败都走同一个 {error:{code,message,detail}}，前端只写一次处理。
 * CORS 全开是刻意的：这是本地工具（127.0.0.1），web/ 页面和 inspector 都可能从别的
 * 端口/文件协议发起请求，收紧 origin 只会给自己添麻烦。
 *
 * SSE 用途：进度是天然流式的，轮询 /api/jobs/:id 会白造请求。SSE 在本地 http 上零成本，
 * 还能在失败/取消时收到终态事件后自动收尾。
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const AVP = require('../core/engine.js');
const { createComfy } = require('./comfy.js');
const { createJobs } = require('./jobs.js');
const { compileWorkflow, loadRegistry } = require('./wf.js');
const { createProvider } = require('./providers/index.js');
const { createSeedreamProvider } = require('./providers/seedream.js');
const VI = require('./visinter.js');
const H3 = require('./h3workflow.js');
const CB = require('./canvasbuilder.js');
const Q = require('./quality.js');
const { createRecommender } = require('./recommend.js');
const { createGpuProbe, tierFor } = require('./gpu.js');
const { serveStatic } = require('./static.js');

const ROOT = path.join(__dirname, '..');
const PKG_VERSION = '0.1.0';
const MAX_BODY = 4 * 1024 * 1024; // 258 参数 + 模板，4MB 足够又不会被意外打爆内存

class HttpError extends Error {
  constructor(status, code, message, detail) { super(message); this.status = status; this.code = code; this.detail = detail || {}; }
}

function readSpec() {
  const p = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', n), 'utf8'));
  return { reg: p('params.registry.json'), catalog: p('models.catalog.json'), rules: p('rules.linkage.json') };
}

function createApp(opts = {}) {
  const spec = opts.spec || readSpec();
  const provider = opts.provider || createProvider({ id: opts.providerId, comfyUrl: opts.comfyUrl, mockMs: opts.mockMs, registry: spec.reg });
  const seedream = opts.seedreamProvider || createSeedreamProvider({ registry: spec.reg });
  const comfy = provider.comfy || (opts.comfy || createComfy({ base: opts.comfyUrl }));
  const jobs = opts.jobs || createJobs({ spec, provider, cineProvider: opts.cineProvider,
    localProvider: opts.localProvider || createProvider({ id: 'comfy', comfy, registry: spec.reg }),
    dir: opts.jobsDir, mockMs: opts.mockMs, concurrency: opts.concurrency,
    reconnectMs: opts.reconnectMs, archiveOptions: opts.archiveOptions, archive: opts.archive });
  if (opts.restore !== false) jobs.restore();
  const recommender = opts.recommender || createRecommender({ registry: spec.reg, catalog: spec.catalog, rules: spec.rules });

  const defaults = AVP.defaults(spec.reg);
  // engine.resolve 只解析传进来的键（不会补默认），所以每个入口统一铺一层默认值再叠入参，
  // 这样 {values:{}} 也能拿到完整 258 键 + 有意义的估算。
  const withDefaults = (values) => ({ ...defaults, ...(values || {}) });
  const ctxFor = (device) => {
    const d = spec.catalog.devices.find((x) => x.id === device) || spec.catalog.devices[0];
    return { device: d.id, usable_mib: d.usable_mib };
  };

  function body(req) {
    return new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', (c) => { buf += c; if (buf.length > MAX_BODY) { reject(new HttpError(413, 'BODY_TOO_LARGE', 'body 超过 4MB', {})); req.destroy(); } });
      req.on('end', () => {
        if (!buf.trim()) return resolve({});
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new HttpError(400, 'BAD_JSON', 'body 不是合法 JSON：' + e.message, {})); }
      });
      req.on('error', reject);
    });
  }

  const send = (res, status, obj) => {
    const text = JSON.stringify(obj, null, 0);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
  };

  async function disk() {
    const root = path.parse(path.join(process.env.CACHE_ROOT || 'D:\\缓存')).root;
    try {
      const st = await fs.promises.statfs(root);
      return { mount: root, free_gib: +((st.bavail * st.bsize) / 1073741824).toFixed(1), total_gib: +((st.blocks * st.bsize) / 1073741824).toFixed(1) };
    } catch (e) {
      return { mount: root, error: e.code || e.message };
    }
  }

  // 估算缓存：默认参数 × 7 档的 estimate 是纯函数结果，不随请求变化。
  // 探测结果**不进**这里：显存是活的（桌面进程随时占走 1~2G），缓存久了就是在报旧值。
  // 探测自己的 TTL 在 gpu.js 里，默认 15s，可用 ?fresh=1 强制刷新。
  let devicesCache = null;
  const gpu = opts.gpuProbe || createGpuProbe({ ttlMs: opts.gpuTtlMs });
  async function localPlan(b) {
    const engine = b.engine;
    const vals = withDefaults(b.values);
    // 提示词组装（2026-11-20 修）：用户写的主体是核心，模板前缀只是质量修饰。
  // 旧逻辑让默认英文前缀压过主体，导致「小猫」类任务实际只收到 "masterpiece, best quality, ..."，
  // 模型没有任何主体信息 → 退化成重复贴片。
  const userText = String(b.prompt || vals['ch.subject'] || '').trim();
  const prefix = String(vals['kf.prompt_prefix'] || '').trim();
  const prompt = userText
    ? (prefix && !userText.startsWith(prefix) ? `${prefix}, ${userText}` : userText)
    : prefix;
    if (!prompt) throw new HttpError(400, 'ENGINE_EMPTY_PROMPT', '生成需要非空提示词');
    const frames = b.frames == null
      ? (engine === 'minimax_h3' ? H3.snapFrames(b.seconds ?? vals['mo.duration'] ?? 5).frames : 4 * Math.ceil((Number(b.seconds ?? vals['mo.duration'] ?? 5) * Q.fpsPlan({ engine, native_fps: b.native_fps, output_fps: b.output_fps }).native_fps - 1) / 4) + 1)
      : Number(b.frames);
    const probe = await gpu.probe({});
    const quality = Q.guard({ ...b, frames, usable_mib: probe.gpu && probe.gpu.total_mib || probe.usable_mib,
      tier: b.tier || vals['kf.tier'], width: b.width ?? vals['kf.width'], height: b.height ?? vals['kf.height'],
      steps: b.steps ?? vals['kf.steps'], cfg: b.cfg ?? vals['kf.cfg'], denoise: b.denoise ?? vals['kf.refine_denoise'],
      native_fps: b.native_fps, output_fps: b.output_fps ?? vals['mo.output_fps'],
    });
    if (!quality.resolution || quality.errors.some((e) => e.code !== 'QUALITY_VRAM_INSUFFICIENT')) Q.assertAllowed(quality);
    // 首帧：先走 ComfyUI 上传接口拿到文件名，再交给 build（避免直接写 input 目录被沙箱 EPERM）
    let firstFrameName = null;
    let lastFrameName = null;
    const ffPath = b.first_frame || vals['kf.first_frame'] || null;
    const lfPath = b.last_frame || null;
    if (engine === 'minimax_h3' && ffPath) firstFrameName = await H3.uploadImage(ffPath);
    if (engine === 'minimax_h3' && lfPath) lastFrameName = await H3.uploadImage(lfPath);
    const params = { ...b, ...quality.resolution, ...quality.sampling, frames, values: vals, firstFrameName, lastFrameName, firstFrame: null, lastFrame: null, prompt, negative: b.negative ?? vals['ch.negative'], seed: b.seed ?? vals['kf.seed'], native_fps: quality.fps.native_fps, output_fps: quality.fps.output_fps };
    const built = engine === 'minimax_h3' ? H3.build(params) : CB.executableFor(engine, params);
    const workflow = built.workflow || built.graph;
    const modelErrors = Q.workflowErrors(workflow);
    quality.errors.push(...modelErrors);
    quality.warnings.push(...Q.workflowWarnings(workflow));
    quality.ok = quality.errors.length === 0;
    return { ...built, workflow, quality, prompt, values: { ...vals, 'kf.steps': quality.sampling.steps, 'kf.cfg': quality.sampling.cfg, 'kf.refine_denoise': quality.sampling.denoise, 'kf.sampler': quality.sampling.sampler, 'kf.scheduler': quality.sampling.scheduler, 'mo.fps': quality.fps.native_fps, 'mo.max_frames': frames, 'kf.width': quality.resolution.width, 'kf.height': quality.resolution.height, 'kf.dtype': 'fp16', 'kf.teacache': false, 'kf.sage_attn': false, 'kf.nunchaku': false } };
  }

  async function runtimeStatus() {
    const categories = { unet_name: 'diffusion_models', clip_name: 'text_encoders', vae_name: 'vae' };
    const probe = await comfy.ping({ force: false });
    const inventory = {};
    if (probe.ok) await Promise.all(Object.values(categories).map(async (folder) => {
      try { inventory[folder] = await comfy.models(folder); } catch { inventory[folder] = null; }
    }));
    const models = ['wan22', 'minimax_h3'].map((engine) => {
      const graph = CB.executableFor(engine).graph;
      const requirements = [];
      for (const [id, node] of Object.entries(graph)) for (const [field, folder] of Object.entries(categories)) {
        const name = node.inputs && node.inputs[field];
        if (typeof name !== 'string') continue;
        const files = inventory[folder];
        requirements.push({ node: id, field, name, state: !Array.isArray(files) ? 'unknown' : files.includes(name) ? 'installed' : 'missing' });
      }
      const errors = requirements.filter((r) => r.state === 'missing').map((r) => ({ code: 'MODEL_FILE_MISSING', message: `ComfyUI 模型目录中找不到 ${r.name}`, detail: r }));
      return { engine, ready: probe.ok && requirements.every((r) => r.state === 'installed'), requirements, warnings: Q.workflowWarnings(graph), errors };
    });
    const exists = (file, directory) => { try { return directory ? fs.statSync(file).isDirectory() : fs.statSync(file).isFile(); } catch { return false; } };
    const postprocess = [['rife', 'AVP_RIFE'], ['realesrgan', 'AVP_REALESRGAN']].map(([id, key]) => {
      const ready = exists(process.env[key], false) && exists(process.env[key + '_MODEL'], true);
      return { id, ready, message: ready ? '程序与模型目录已配置，实际执行时验证模型文件' : `未配置 ${key} 程序及 ${key}_MODEL 模型；不影响原生视频生成` };
    });
    return { comfy_reachable: !!probe.ok, models, postprocess };
  }

  async function createLocalJob(b) {
    const built = await localPlan(b);
    Q.assertAllowed(built.quality);
    return jobs.create({ kind: 'local', workflow: built.workflow, canvasSnapshot: built.workflow,
      experiment_id: b.experiment_id, prompt: built.prompt, note: built.prompt,
      values: built.values, device: b.device, model: b.engine, engine: b.engine, quality: built.quality });
  }

  function deviceList() {
    if (devicesCache) return devicesCache;
    devicesCache = spec.catalog.devices.map((d) => {
      const e = AVP.estimate(spec.reg, spec.catalog, defaults, { device: d.id });
      return {
        id: d.id, name: d.name, vram_total_mib: d.vram_total_mib, usable_mib: d.usable_mib,
        watts: d.watts, price_yuan_per_kwh: d.price_yuan_per_kwh, provenance: d.provenance,
        estimate: { vram: e.vram, time: e.time, quality: e.quality, cost: e.cost },
        verdict: e.vram.state,
      };
    });
    return devicesCache;
  }

  /**
   * 档位接口 = 静态表（估算，仍然是纯函数结果） + 本机真值探测（活的）。
   * 两者永不混写：`devices[]` 永远是 catalog 的口径，本机读数只出现在 `probe` 里，
   * 免得"哪一档是本机"和"本机现在剩多少显存"被压成同一个字段、下次换机器看不出来。
   */
  async function devicesPayload(force) {
    const list = deviceList();
    const p = await gpu.probe({ force: !!force });
    const suggested = p.ok ? tierFor(p.gpu.total_mib, spec.catalog.devices) : null;
    return {
      base: 'defaults', devices: list, count: list.length, tiers: spec.reg.tiers,
      probe: {
        ok: p.ok,
        at: p.at,
        source: p.source,
        reason: p.reason,
        gpu: p.gpu,
        free_mib: p.free_mib,
        usable_mib: p.usable_mib,
        provenance: p.provenance, // measured（采到 used）/ estimate / unknown，禁止无标注的推断值
        tier_suggestion: suggested,
        tier_confirmed: false, // 探测只是建议；确认后由用户/config 固化，不自动改用户选的档
        enough_for: p.ok && p.usable_mib != null
          ? spec.catalog.devices.filter((d) => d.usable_mib <= p.usable_mib).map((d) => d.id)
          : [],
        detail: p.detail,
      },
    };
  }

  const routes = [];
  // 第四个参数是成功状态码（创建任务要回 202 Accepted 而不是 200）。
  const route = (method, pattern, handler, status) => routes.push({ method, pattern, handler, status });

  route('GET', /^\/api\/health$/, async () => {
    const pp = await provider.probe({ force: true });
    const probe = provider.id === 'comfy'
      ? { ok: pp.reachable, detail: pp.detail }
      : (process.env.COMFY_URL ? await comfy.ping({ force: true }) : { ok: false, detail: { skipped: 'provider 不是 comfy，且未设 COMFY_URL' } });
    const degraded = provider.mode === 'real' && !pp.reachable;
    return {
      ok: true, service: 'ai-video-platform/backend', version: PKG_VERSION,
      node: process.version, platform: process.platform, arch: process.arch,
      pid: process.pid, uptime_sec: Math.round(process.uptime()), project_root: ROOT,
      provider: {
        id: provider.id, mode: provider.mode, reachable: pp.reachable,
        requested: provider.requested || null,
        env: provider.envSource || null,
        degraded, reason: degraded ? ((pp.detail && (pp.detail.message || pp.detail.code)) || '不可达') : null,
        detail: pp.detail,
      },
      comfy: { base: comfy.base, reachable: probe.ok, mode: probe.ok ? 'live' : 'mock', detail: probe.detail },
      registry: { version: spec.reg.version, params: spec.reg.counts.total, stages: spec.reg.stages.length, updated: spec.reg.updated },
      rules: { version: spec.rules.version, count: spec.rules.rules.length },
      catalog: { version: spec.catalog.version, devices: spec.catalog.devices.length },
      gpu: await (async () => {
        const p = await gpu.probe({});
        return {
          ok: p.ok, name: p.gpu && p.gpu.name, total_mib: p.gpu && p.gpu.total_mib,
          usable_mib: p.usable_mib, provenance: p.provenance, reason: p.reason, at: p.at,
        };
      })(),
      disk: await disk(),
      jobs: jobs.stats(),
    };
  });

  // ?fresh=1 强制重采样（用户刚关掉占显存的程序时用），否则走 15s TTL。
  route('GET', /^\/api\/devices$/, async (m, req) => {
    const fresh = new URL(req.url, 'http://x').searchParams.get('fresh');
    return devicesPayload(fresh === '1' || fresh === 'true');
  });

  route('GET', /^\/api\/params$/, async (m, req) => {
    const only = new URL(req.url, 'http://x').searchParams.get('stage');
    const groups = spec.reg.stages.map((s) => {
      const params = spec.reg.params.filter((p) => p.stage === s.id);
      return { ...s, count: params.length, params };
    }).filter((g) => !only || g.id === only);
    return { version: spec.reg.version, total: spec.reg.params.length, counts: spec.reg.counts, tiers: spec.reg.tiers, stages: groups };
  });

  route('POST', /^\/api\/estimate$/, async (m, req) => {
    const b = await body(req);
    const device = b.device || ctxFor().device;
    if (!spec.catalog.devices.some((d) => d.id === device)) throw new HttpError(400, 'BAD_DEVICE', `未知档位 ${device}`, { allowed: spec.catalog.devices.map((d) => d.id) });
    const r = AVP.resolve(spec.reg, spec.rules, withDefaults(b.values), { ctx: ctxFor(device) });
    const estimate = AVP.estimate(spec.reg, spec.catalog, r.values, { device });
    return { device, estimate, warnings: r.warnings, trace: r.trace, values: r.values };
  });

  route('POST', /^\/api\/degrade$/, async (m, req) => {
    const b = await body(req);
    const device = b.device || ctxFor().device;
    if (!spec.catalog.devices.some((d) => d.id === device)) throw new HttpError(400, 'BAD_DEVICE', `未知档位 ${device}`, { allowed: spec.catalog.devices.map((d) => d.id) });
    const ctx = ctxFor(device);
    const r = AVP.resolve(spec.reg, spec.rules, withDefaults(b.values), { ctx });
    const estimate = AVP.estimate(spec.reg, spec.catalog, r.values, { device });
    return { needed: estimate.vram.ratio > 1, options: [], mode: 'quality_first', reason: '质量优先模式不提供自动降分辨率、减步数或量化方案，请保持参数并使用足够显存的设备' };
  });

  // 编译预览：不建任务，只看参数落到哪些节点/字段、哪些没落点。
  // provider=dashscope 已下线（付费视频模型删除）；传它得到 410，不静默改走本地。
  route('POST', /^\/api\/workflow\/compile$/, async (m, req) => {
    const b = await body(req);
    if (b.provider === 'dashscope') throw new HttpError(410, 'PROVIDER_RETIRED', '付费视频模型（DashScope wan2.2 / wan2.7）已全部移除；只剩 ComfyUI 图编译', { retired: ['wan2.2-t2v-plus', 'wan2.2-t2v-flash', 'wan2.7-t2v'] });
    const r = AVP.resolve(spec.reg, spec.rules, withDefaults(b.values), { ctx: ctxFor(b.device) });
    const c = compileWorkflow(r.values, { registry: spec.reg, template: b.template });
    return { provider: 'comfy', stats: c.stats, synthetic: c.synthetic, workflow: c.workflow, applied: c.applied, merged: c.merged, unbound: c.unbound, warnings: c.warnings };
  });

  route('POST', /^\/api\/jobs$/, async (m, req) => {
    const b = await body(req);
    // ── 双引擎直出：参数面板「一键生成」带 engine 时，直接编译成可执行工作流 ──
    // wan22 → canvasbuilder 的 12 节点 Wan 图；minimax_h3 → h3workflow 的 13 节点 H3 图（带音频）。
    if (b.engine && ['wan22', 'minimax_h3'].includes(b.engine)) return createLocalJob(b);
    if (b.engine) throw new HttpError(400, 'BAD_ENGINE', '未知本地视频引擎');
    if (b.kind === 'local' && !b.workflow) return createLocalJob({ ...b, engine: 'wan22' });
    if (b.kind === 'local' && b.workflow) Q.assertWorkflow(b.workflow);
    // 付费视频模型删除后，jobs 不再有 dashscope 预检分支：出图/出片只剩
    // comfy（本地）、mock（演示）、seedream（图像，ARK 可选）、cine（已下线）四条缝。
    // jobs.create 返回的是"受理时刻"的快照（queued），不是被调度器抢跑后的状态。
    return jobs.create({ values: b.values || {}, device: b.device, template: b.template, note: b.note, model: b.model, promptExtend: b.promptExtend, kind: b.kind, prompt: b.prompt, style: b.style, resume: b.resume, multi: b.multi, continuity: b.continuity, ratio: b.ratio, theme: b.theme, rawPrompt: b.rawPrompt, watermark: b.watermark, workflow: b.workflow, canvasSnapshot: b.canvasSnapshot, experiment_id: b.experiment_id });
  }, 202);

  // 电影管线选优窗口内的人工改选（规格第 4 步：AI 选最优，用户可点其他张）。
  route('POST', /^\/api\/jobs\/([^/]+)\/pick$/, async (m, req) => {
    const b = await body(req);
    return jobs.pick(m[1], b.index);
  });

  // 审核复核队列：人工对 QAReport 改判 PASS/REJECT（留痕复核人/原因）。
  route('POST', /^\/api\/jobs\/([^/]+)\/review$/, async (m, req) => {
    const b = await body(req);
    return jobs.review(m[1], b.auditId, b.decision, b.reason);
  });

  // 候选关键帧发射：只发任务自己记录的候选文件路径（provider 产物，非用户输入）。
  route('GET', /^\/api\/jobs\/([^/]+)\/candidates\/(\d+)$/, async (m, req, res) => {
    const j = jobs.get(m[1]);
    const list = (j.cineReport && j.cineReport.candidates) || j.cineLive || [];
    const c = list.find((x) => String(x.id) === m[2]);
    if (!c || !c.file) throw new HttpError(404, 'NO_CANDIDATE', '任务没有第 ' + m[2] + ' 组候选关键帧', { id: m[1], state: j.state });
    const abs = path.resolve(c.file);
    let st;
    try { st = await fs.promises.stat(abs); } catch (e) { throw new HttpError(404, 'CANDIDATE_MISSING', '候选文件不存在：' + abs, {}); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
    return 'stream';
  });

  route('GET', /^\/api\/jobs$/, async (m, req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    return { jobs: jobs.list({ state: q.get('state'), status: q.get('status'), active: q.get('active') === '1', limit: Number(q.get('limit') || 50) }), stats: jobs.stats() };
  });

  route('GET', /^\/api\/jobs\/([^/]+)$/, async (m) => {
    const j = jobs.get(m[1]);
    return { ...j, canRetry: j.state === 'failed' || j.state === 'canceled', events_url: `/api/jobs/${j.id}/events` };
  });

  route('POST', /^\/api\/jobs\/([^/]+)\/cancel$/, async (m) => jobs.cancel(m[1]));
  route('POST', /^\/api\/jobs\/([^/]+)\/retry$/, async (m) => jobs.retry(m[1]), 202);

  // 成片发射：只发任务自己记录的 output 路径（provider 产物，非用户输入），供预览/下载。
  // 支持 Range：<video> 拖动进度条要靠 206，否则部分浏览器只能从头播。
  route('GET', /^\/api\/jobs\/([^/]+)\/output$/, async (m, req, res) => {
    const j = jobs.get(m[1]);
    const file = typeof j.output === 'string' ? j.output : (j.output && j.output.file);
    if (!file) throw new HttpError(404, 'NO_OUTPUT', '任务没有成片产物（mock 演示或尚未完成）', { id: m[1], state: j.state, mock: j.mock });
    const abs = path.resolve(file);
    let st;
    try { st = await fs.promises.stat(abs); } catch (e) { throw new HttpError(404, 'OUTPUT_MISSING', '产物文件不存在：' + abs, {}); }
    const size = st.size;
    const range = req.headers.range;
    if (range) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!r) throw new HttpError(400, 'BAD_RANGE', 'Range 头不合法', { range });
      const start = r[1] ? Number(r[1]) : 0;
      const end = r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (start > end || start >= size) throw new HttpError(416, 'RANGE_NOT_SATISFIABLE', 'Range 越界', { size, range });
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(abs, { start, end }).on('error', () => res.destroy()).pipe(res);
      return 'stream';
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
    return 'stream';
  });

  // 预设模型清单：前端「用哪个模型出片」的下拉框数据源（真源是 ds.js 的能力表）。
  route('GET', /^\/api\/models$/, async () => {
    const pp = await provider.probe({ force: true });
    return {
      provider: { id: provider.id, mode: provider.mode, reachable: pp.reachable, requested: provider.requested || null },
      default: process.env.AVP_DS_MODEL || DEFAULT_MODEL,
      // 付费视频模型（DashScope wan2.2/2.7）已删除：这里只列本地 ComfyUI 可跑的模型，paid 恒为 false
      models: (JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'model.configs.json'), 'utf8')).models || []).map((m) => ({
        id: m.id, label: m.label || m.id, paid: false, provider: 'comfy',
        kind: /t2v|i2v|video/i.test(m.id + ' ' + (m.kind || '')) ? 'video' : 'image',
      })),
      paid_video_models: [],
      output_dir: process.env.AVP_OUT_DIR || null,
    };
  });

  route('GET', /^\/api\/jobs\/([^/]+)\/events$/, async (m, req, res) => {
    const id = m[1];
    const job = jobs.get(id); // 不存在时这里抛 404，别开 SSE 流
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    let n = 0;
    const write = (event, data) => {
      n += 1;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    write('snapshot', { job: jobs.publicView(job), seq: n });
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'canceled') {
      write('done', { state: job.state, job: jobs.publicView(job) });
      res.end();
      return 'sse-closed';
    }
    const off = jobs.subscribe(id, (e) => {
      if (e.type === 'done') { write('done', e); off(); res.end(); return; }
      write(e.type || 'message', e);
    });
    // 心跳：代理/浏览器会掐掉长时间静默的流；15s 一条注释行，代价可忽略。
    const hb = setInterval(() => { res.write(': ping\n\n'); }, 15000);
    req.on('close', () => { clearInterval(hb); off(); });
    return 'sse';
  });

  // AI 参数推荐（双轨）：有 key 调 Qwen，无 key/失败显式降级规则推荐（source:'rules'）。
  route('POST', /^\/api\/recommend$/, async (m, req) => {
    const b = await body(req);
    const device = b.device || ctxFor().device;
    if (!spec.catalog.devices.some((d) => d.id === device)) throw new HttpError(400, 'BAD_DEVICE', `未知档位 ${device}`, { allowed: spec.catalog.devices.map((d) => d.id) });
    if (b.model_id != null && !recommender.modelById(b.model_id)) throw new HttpError(400, 'BAD_MODEL', `未知模型 ${b.model_id}`, { allowed: recommender.modelConfigs.models.map((c) => c.id) });
    return recommender.recommend({ prompt: b.prompt, device, style: b.style, values: b.values, model_id: b.model_id });
  });

  // 两个逆向能力：能力包 + Seedream 5.0 pro 真机出图（同步，不排队；dryRun 只回 payload）
  route('GET', /^\/api\/capability$/, async () => {
    const caps = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'reverse.capabilities.json'), 'utf8'));
    const probe = await seedream.probe({ force: true });
    return {
      schema: caps.schema, version: caps.version, updated: caps.updated,
      target: { provider: caps.target.provider, base: caps.target.base, models: caps.target.models, unsupported_params: caps.target.unsupported_params },
      tiers: caps.tiers,
      abilities: caps.abilities.map((a) => ({
        id: a.id, name: a.name, reverse_mode: a.reverse_mode, recipe: a.seedream_recipe, yield_gate: a.yield_gate,
      })),
      provider: { id: 'seedream', mode: 'real', reachable: probe.reachable, detail: probe.detail },
    };
  });

  route('POST', /^\/api\/capability\/image$/, async (m, req) => {
    const b = await body(req);
    const caps = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'reverse.capabilities.json'), 'utf8'));
    const abilityId = b.ability || (caps.abilities[0] && caps.abilities[0].id);
    if (!caps.abilities.some((a) => a.id === abilityId)) {
      throw new HttpError(400, 'SR_BAD_ABILITY', `未知能力 ${abilityId}`, { allowed: caps.abilities.map((a) => a.id) });
    }
    const job = {
      id: 'cap_' + Date.now().toString(36), kind: 'image', ability: abilityId,
      stage: b.stage || 'keyframe', tier: b.tier || null, ratio: b.ratio || null, size: b.size || null,
      model: b.model || null, note: b.note || null, values: b.values || {},
      valueSnapshot: withDefaults(b.values), dryRun: b.dryRun === true,
    };
    try {
      const r = await seedream.run(job, { onProgress: () => {} });
      return {
        ability: abilityId, dry_run: !!(r.meta && r.meta.seedream && r.meta.seedream.dry_run),
        payload: r.meta && r.meta.seedream ? r.meta.seedream.payload : null,
        prompt: r.meta && r.meta.seedream ? r.meta.seedream.prompt : null,
        cost_cny_est: r.meta && r.meta.seedream ? r.meta.seedream.cost_cny_est : null,
        images: r.images || [], output: r.output || null,
        warnings: (r.meta && r.meta.seedream && r.meta.seedream.warnings) || [],
      };
    } catch (e) {
      const status = e.code === 'SR_NO_API_KEY' || e.code === 'SR_INVALID_API_KEY' ? 400 : e.code === 'SR_UNREACHABLE' || e.code === 'SR_TIMEOUT' ? 502 : 500;
      throw new HttpError(status, e.code || 'SR_FAILED', e.message, { hint: e.hint || '', detail: e.detail || {}, ability: abilityId });
    }
  });

  // VisInter-Agent：本地开源管线（wan2.2）的双模式装配 + 风险提示 + 自检。
  route('GET', /^\/api\/visinter$/, async () => {
    const spec = VI.loadSpec();
    return {
      schema: spec.schema, version: spec.version, updated: spec.updated,
      pipeline: spec.pipeline, modes: spec.modes, presets: spec.presets,
      resolutions: spec.resolutions, risk_rules: spec.risk_rules, risk_thresholds: spec.risk_thresholds,
      linkage: {
        portrait: { keywords: spec.linkage.portrait.keywords, enable: spec.linkage.portrait.enable, note: spec.linkage.portrait.note },
        landscape: { keywords: spec.linkage.landscape.keywords, disable: spec.linkage.landscape.disable, note: spec.linkage.landscape.note },
      },
      prompts: spec.prompts,
      selfcheck: { shots: spec.selfcheck.shots, model_requirements: spec.selfcheck.model_requirements, status_words: spec.selfcheck.status },
      banner: '💡 智能风险检测已开启：所有参数完全自由自定义，高风险配置仅提示，不限制提交',
      provenance: spec.provenance,
    };
  });

  route('POST', /^\/api\/visinter\/plan$/, async (m, req) => {
    const b = await body(req);
    if (b.mode != null && !['novice', 'expert'].includes(b.mode)) throw new HttpError(400, 'BAD_MODE', `未知模式 ${b.mode}`, { allowed: ['novice', 'expert'] });
    const plan = VI.assemble({
      text: b.text || '', mode: b.mode || 'novice',
      values: b.values || {}, manualKeys: Array.isArray(b.manualKeys) ? b.manualKeys : [],
      defaults,
    });
    // 角色设定提取：以 visinter 的场景脸型 + preconditions 为骨架，再用成熟提取器补主体/年龄/服装/画风。
    // 不能直接覆盖 character —— 那会把 face_shape 场景预设和「删鹅蛋脸」的 patch 全丢掉。
    let character = plan.character;
    try {
      const extractor = require('./character.js').createCharacterExtractor({ registry: spec.reg });
      const ex = extractor.extract({ prompt: b.text || '', values: plan.values });
      character = {
        ...plan.character,
        fields: ex.fields,                       // 主体 / 年龄 / 服装 / 画风（来源逐项标注）
        extractor_patch: ex.patch,
        contradictions: ex.contradictions,
        // visinter 的 patch 优先（它含脸型场景预设与主体句清理）
        patch: { ...(ex.patch || {}), ...(plan.character.patch || {}) },
        tag: '【AI提取】',
        note: '全部字段可手改；手改后写回 258 全量参数，AI 不再覆盖',
      };
    } catch (e) {
      character = { ...plan.character, error: e.message };
    }
    return { ...plan, character };
  });

  route('POST', /^\/api\/visinter\/selfcheck$/, async (m, req) => {
    const b = await body(req);
    return VI.selfCheck({ run: b.run === true });
  });

  // ── 本地 H3 通道（kind=local → comfy provider，工作流直传）────────────────────
  route('GET', /^\/api\/h3\/status$/, async () => {
    const probe = await comfy.ping({ force: true });
    const gp = await gpu.probe({});
    // 用「总显存」而不是当前可用：ComfyUI 正在跑任务时可用只剩 1GB，用它算预算会把安全线压到 0.19MP（误报）
    const usable = (gp.gpu && gp.gpu.total_mib) || gp.usable_mib || 8151;
    // 并发建议：H3 单条就吃满 8G，按显存给上限（只建议不强制，AVP_CONCURRENCY 仍是真开关）
    const recommend = usable >= 46000 ? 3 : usable >= 23000 ? 2 : 1;
    const current = Number(process.env.AVP_CONCURRENCY || 1);
    return {
      comfy: { base: comfy.base, reachable: probe.ok, detail: probe.detail || null },
      template: path.basename(H3.TEMPLATE),
      constraints: { fps: 24, frames_grid: '17k+5', frames_range: [124, 362], size_step: 32, sampling: Q.sampling(), turbo: false, usable_mib: usable },
      concurrency: {
        current, recommend, over: current > recommend,
        reason: `可用显存 ${usable}MiB → 建议并发 ${recommend}（H3 单条即吃满 8G；超配只会互相换页）`,
      },
      vram_budget: { safe_mp: +(0.25 * Math.max(0.75, usable / 8151)).toFixed(3), warn_mp: +(0.42 * Math.max(0.75, usable / 8151)).toFixed(3) },
    };
  });

  route('POST', /^\/api\/h3\/plan$/, async (m, req) => localPlan({ ...(await body(req)), engine: 'minimax_h3' }));
  route('POST', /^\/api\/jobs\/plan$/, async (m, req) => {
    const b = await body(req);
    if (!['wan22', 'minimax_h3'].includes(b.engine)) throw new HttpError(400, 'BAD_ENGINE', '请选择本地视频引擎');
    return localPlan(b);
  });
  route('POST', /^\/api\/h3\/(?:run|direct)$/, async (m, req) => createLocalJob({ ...(await body(req)), engine: 'minimax_h3' }), 202);
  route('POST', /^\/api\/jobs\/([^/]+)\/enhance$/, async (m) => jobs.enhance(m[1]), 202);

  route('GET', /^\/api\/h3\/job\/([^/]+)$/, async (m) => H3.status(m[1]));

  route('POST', /^\/api\/h3\/upscale$/, async (m, req) => {
    const b = await body(req);
    if (!b.job_id) throw new HttpError(422, 'ENHANCE_JOB_REQUIRED', '请提供已归档原生视频的job_id，通过独立RIFE/Real-ESRGAN流水线增强');
    return jobs.enhance(b.job_id);
  }, 202);

  // 质量优先策略 + 当前设备各档位可行性（feasible 为 null 表示未取到显存）
  // ── 关键帧两阶段管线（规格：文生候选 → 自动选优 → 图生视频）──
  // 阶段一二：生成 N 张候选 + 五维打分 + 自动选 Top1（可选 Qwen 语义增强）
  route('POST', /^\/api\/keyframes$/, async (m, req) => {
    const b = await body(req);
    const KFP = require('./kf_pipeline.js');
    // 异步：Kolors 出 3–6 张要 10–20 分钟，同步 HTTP 会被 headers 超时掐断（实测）。
    // 这里只建记录并排后台，客户端拿 id 去轮询 GET /api/keyframes/:id。
    const rec = KFP.createPlan({
      prompt: b.prompt, negative: b.negative, count: b.count, width: b.width, height: b.height,
      steps: b.steps, cfg: b.cfg, seed: b.seed, provider: b.provider, useQwen: b.useQwen === true,
    });
    setImmediate(() => { KFP.runPlan(rec.id, b).catch((e) => console.error('[kf] ' + rec.id + ' ' + e.message)); });
    return { id: rec.id, status: rec.status, stage: rec.stage, poll: `/api/keyframes/${rec.id}` };
  });

  // 关键帧服务能力探测（前端据此决定「关键帧生成」按钮是否可用）
  route('GET', /^\/api\/keyframes\/capability$/, async () => {
    const KFP = require('./kf_pipeline.js');
    const KF = require('./keyframe.js');
    const spec = KF.loadSpec();
    return {
      kolors: { ready: KFP.kolorsReady(), lang: 'zh' },
      sd15: { ready: KFP.sd15Ready(), lang: 'en' },
      default_provider: (() => { try { return KFP.pickProvider(); } catch (e) { return null; } })(),
      weights: spec.weights,
      thresholds: spec.thresholds,
      candidates: spec.candidates,
      note: '关键帧未选定前不允许进入视频生成；自动选优后可手动改选',
    };
  });

  // 读取一条关键帧记录（候选/打分/选中/视频状态）
  route('GET', /^\/api\/keyframes\/([^/]+)$/, async (m) => {
    const KFP = require('./kf_pipeline.js');
    return KFP.loadRec(decodeURIComponent(m[1]));
  });

  // 关键帧候选图预览（前端候选网格用）：只允许读该记录里登记过的图，防路径穿越
  route('GET', /^\/api\/keyframes\/([^/]+)\/frame\/(\d+)$/, async (m, req, res) => {
    const KFP = require('./kf_pipeline.js');
    const rec = KFP.loadRec(decodeURIComponent(m[1]));
    const idx = Number(m[2]);
    const cand = (rec.candidates || [])[idx];
    if (!cand || !cand.file) throw new HttpError(404, 'KF_FRAME_NOT_FOUND', '候选不存在', {});
    const fsx = require('node:fs');
    if (!fsx.existsSync(cand.file)) throw new HttpError(404, 'KF_FRAME_MISSING', '候选文件已不在磁盘上', { file: cand.file });
    const buf = fsx.readFileSync(cand.file);
    const ext = String(cand.file).toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': ext, 'Cache-Control': 'no-store', 'Content-Length': buf.length });
    res.end(buf);
    return undefined;
  });

  // 用户改选候选（以手动选择为准）
  route('POST', /^\/api\/keyframes\/([^/]+)\/pick$/, async (m, req) => {
    const b = await body(req);
    const KFP = require('./kf_pipeline.js');
    return KFP.pickCandidate(decodeURIComponent(m[1]), { index: b.index, file: b.file });
  });

  // 阶段三：把选中的关键帧作为 i2v 首帧提交（前置校验不通过 → 422，不发非法请求）
  route('POST', /^\/api\/keyframes\/([^/]+)\/video$/, async (m, req) => {
    const b = await body(req);
    const KFP = require('./kf_pipeline.js');
    return KFP.makeVideo(decodeURIComponent(m[1]), {
      prompt: b.prompt, width: b.width, height: b.height, seconds: b.seconds,
      output_fps: b.output_fps, usable_mib: b.usable_mib,
    });
  });

  route('GET', /^\/api\/quality$/, async () => {
    const probe = await gpu.probe({});
    const usable = (probe.gpu && probe.gpu.total_mib) || probe.usable_mib || null;
    const spec = Q.load();
    const tiers = Q.tiers().map((t) => {
      const need = Q.vramNeedMib(t.width, t.height, 124);
      return { ...t, required_mib: need, feasible: usable ? need <= usable : null };
    });
    return {
      mode: spec.mode, modes: spec.modes, tiers, sampling: spec.sampling, fps: spec.fps,
      scoring: spec.scoring, forbid: spec.forbid, usable_mib: usable, runtime: await runtimeStatus(),
      note: '质量优先：不自动降分辨率/不自动减步数；显存不足返回 422 而非降档',
    };
  });

  route('GET', /^\/api\/works\/preview$/, async (m, req, res) => {
    const u = new URL(req.url, 'http://x');
    const name = path.basename(String(u.searchParams.get('file') || ''));
    const dir = path.resolve(require('./archive.js').OUT_DIR);
    const abs = path.resolve(dir, name);
    if (!abs.startsWith(dir + path.sep)) throw new HttpError(400, 'WORKS_BAD_PATH', '只允许读成片目录', { file: name });
    let st;
    try { st = fs.statSync(abs); } catch { throw new HttpError(404, 'WORKS_NO_FILE', '文件不存在：' + name, {}); }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
    return 'stream';
  });

  route('POST', /^\/api\/ultimate\/score$/, async (m, req) => {
    const b = await body(req);
    const job = b.job_id ? jobs.get(b.job_id) : jobs.list({ limit: 500 }).find((j) => j.pure_output && path.resolve(j.pure_output) === path.resolve(String(b.file || '')));
    if (!job || !job.pure_output) throw new HttpError(422, 'SCORE_NATIVE_REQUIRED', '只能评分任务已归档的原生基础视频，请提供 job_id');
    const result = await require('./scoring.js').scoreVideoAsync({ file: job.pure_output, sample_kind: 'native', output_fps: job.enhanced && job.enhanced.output_fps || null });
    return { ...result, output_fps: job.enhanced && job.enhanced.output_fps || null, source_job: job.id, sample_kind: 'native' };
  });

  route('GET', /^\/api\/works$/, async (m, req) => {
    const u = new URL(req.url, 'http://x');
    const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit') || 20)));
    return { works: require('./archive.js').recent(limit), dir: require('./archive.js').OUT_DIR };
  });

  // 成片预览：只允许读 ComfyUI/output 下的文件（路径穿越一律拒）
  route('GET', /^\/api\/h3\/preview$/, async (m, req, res) => {
    const u = new URL(req.url, 'http://x');
    const rel = String(u.searchParams.get('file') || '');
    const dir = path.resolve(process.env.COMFY_OUTPUT_DIR || path.join(process.env.CLOUD_ROOT || 'D:\云盘', '01-代码', 'AI视频', 'ComfyUI', 'output'));
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) throw new HttpError(400, 'H3_BAD_PATH', '只允许读 ComfyUI/output 下的文件', { file: rel });
    let st;
    try { st = fs.statSync(abs); } catch { throw new HttpError(404, 'H3_NO_FILE', '文件不存在：' + rel, {}); }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' });
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
    return 'stream';
  });

  // Muse 预设叠加层（不改 258 参数结构）：前端 http 模式取这份，file:// 模式用构建期内联的 __MUSE。
  route('GET', /^\/api\/muse-presets$/, async () => recommender.muse);

  // 氛围审美层（8 题材配方 + 词库）：前端 http 模式取这份，file:// 模式用构建期内联的 __AESTH。
  route('GET', /^\/api\/aesthetics$/, async () => require('./aesthetics.js').DATA);

  route('POST', /^\/api\/presets\/export$/, async (m, req) => {
    const b = await body(req);
    const p = AVP.exportPreset(spec.reg, b.values || defaults, b.meta || {});
    return p;
  });

  route('POST', /^\/api\/presets\/import$/, async (m, req) => {
    const b = await body(req);
    const preset = b.preset || b;
    if (!preset || preset.schema !== 'ai-video-platform/preset') throw new HttpError(400, 'BAD_PRESET', '不是本平台预设（schema 不匹配）', { got: preset && preset.schema });
    const r = AVP.importPreset(spec.reg, preset);
    return { ...r, warnings: r.unknown.length ? [{ code: 'PRESET_UNKNOWN_KEYS', text: `${r.unknown.length} 个键不在当前注册表（版本差异），已忽略`, keys: r.unknown }] : [] };
  });

  route('GET', /^\/$/, async () => ({
    service: 'ai-video-platform backend', version: PKG_VERSION,
    endpoints: routes.map((r) => r.method + ' ' + r.pattern.source.replace(/\\\//g, '/').replace(/\^|\$/g, '')),
    entry: '/app/index.html',
    static_note: '非 /api 路径按静态文件发射（白名单后缀，仅本仓库目录）',
    docs: 'docs/02-backend.md',
  }));

  const server = http.createServer(async (req, res) => {
    // CORS 全开：本地工具，预检直接 204 掉，省一次往返。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      try {
        const out = await r.handler(m, req, res);
        if (out === 'sse' || out === 'sse-closed' || out === 'stream') return; // SSE/文件流自己管连接生命周期
        send(res, r.status || 200, out);
      } catch (e) {
        const status = e.status || (e.code === 'AUDIT_NOT_FOUND' || e.code === 'JOB_NOT_FOUND' ? 404 : e.code === 'JOB_NOT_ENHANCEABLE' || e.code === 'JOB_NOT_CANCELABLE' || e.code === 'JOB_NOT_PICKABLE' || e.code === 'JOB_NOT_RETRYABLE' || e.code === 'JOB_WORKER_ACTIVE' ? 409 : e.code === 'BAD_EXPERIMENT_ID' || e.code === 'BAD_DEVICE' || e.code === 'BAD_KIND' || e.code === 'BAD_PICK' || e.code === 'BAD_REVIEW' || e.code === 'CINE_EMPTY_PROMPT' || e.code === 'CINE_INPUT_GATE' ? 400 : 500);
        const payload = { error: { code: e.code || 'INTERNAL', message: e.message || '内部错误', detail: e.detail || {} } };
        if (e.hint) payload.error.hint = e.hint;
        if (status >= 500) payload.error.stack = String(e.stack || '').split('\n').slice(0, 4);
        send(res, status, payload);
      }
      return;
    }

    // 静态入口：平台页与七个模块页都从同一个端口发出去，外壳的「相对路径探测」才有意义。
    // 只接非 /api 的 GET/HEAD，保证 /api 的 404 语义（结构化 NOT_FOUND）不变。
    if (!pathname.startsWith('/api') && (req.method === 'GET' || req.method === 'HEAD')) {
      const hit = serveStatic(ROOT, pathname);
      if (hit.path) {
        // 不缓存：这是本地开发中的界面，改一个文件重开就要看到新的
        res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.size, 'Cache-Control': 'no-store' });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(hit.path).on('error', () => res.destroy()).pipe(res);
        return;
      }
      if (hit.error === 'PATH_OUTSIDE_ROOT' || hit.error === 'TYPE_BLOCKED' || hit.error === 'BAD_PATH') {
        send(res, 403, { error: { code: hit.error, message: hit.message, detail: { path: pathname } } });
        return;
      }
    }

    send(res, 404, { error: { code: 'NOT_FOUND', message: `没有路由 ${req.method} ${pathname}`, detail: {} } });
  });

  server.on('close', () => { jobs.close().catch((e) => console.error('[jobs] 关闭任务调度器失败：' + e.message)); });

  return { server, app: { spec, comfy, provider, jobs, routes }, listen: (port = 0, host = '127.0.0.1') => new Promise((resolve) => server.listen(port, host, () => resolve(server.address()))) };
}

module.exports = { createApp, readSpec, HttpError };