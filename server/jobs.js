/**
 * jobs.js —— 任务队列（内存状态 + 每任务落盘）
 *
 * 落盘位置：path.join(process.env.CACHE_ROOT || 'D:\\缓存', 'avp', 'jobs')。
 * 为什么不放项目目录：AGENTS.md 规定 %CLOUD_ROOT% 是要整体搬移动硬盘的产出区，
 * 任务日志属于可丢的中间物，必须待 %CACHE_ROOT%。盘符一律走环境变量，绝不硬编码
 * C 盘或某个固定盘符。
 *
 * 为什么"实际峰值"写 null：ComfyUI 没有进程级显存峰值接口，/system_stats 只给
 * 整机 used（含桌面占用），拿它冒充单任务峰值就是编数据。所以字段保留、值为 null，
 * 等以后用 nvidia-smi 采样才能真正填。
 *
 * provider 模式（任务卡①后）：出片后端由 AVP_PROVIDER=mock|comfy|dashscope 显式选择。
 * mock 用计时器推 0→100，让前端/自测在没有 GPU/没有 key 时也能跑通全链路，
 * job.mock=true 是硬标记，不伪装成真实执行；真实 provider 不可达时任务如实 failed，
 * 不再静默降级。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const AVP = require('../core/engine.js');
const { loadRegistry } = require('./wf.js');
const { createProvider } = require('./providers/index.js');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const JOBS_DIR = path.join(CACHE_ROOT, 'avp', 'jobs');
const STATES = ['queued', 'running', 'succeeded', 'failed', 'canceled'];

class JobError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail || {}; }
}

function loadSpec() {
  const p = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', n), 'utf8'));
  return { reg: loadRegistry(), catalog: p('models.catalog.json'), rules: p('rules.linkage.json') };
}

function createJobs(opts = {}) {
  const spec = opts.spec || loadSpec();
  const dir = opts.dir || JOBS_DIR;
  const concurrency = Math.max(1, Number(opts.concurrency || process.env.AVP_CONCURRENCY || 1));
  const mockMs = Math.max(200, Number(opts.mockMs || process.env.AVP_MOCK_MS || 3000));
  // provider 是唯一出片缝：mock|comfy|dashscope 显式选择（AVP_PROVIDER），新增后端不改本文件。
  const provider = opts.provider || createProvider({ id: opts.providerId, mockMs, registry: spec.reg });
  // 一句话电影管线是第二条缝：job.kind==='cine' 的任务走 cine provider，其余走主 provider。
  const cineProvider = opts.cineProvider || createProvider({ id: 'cine', mockMs, registry: spec.reg });
  // 出图是第三条缝：kind==='image' 固定走 Seedream 5.0 pro（同步出图协议），
  // 与视频主 provider 解耦——这样 AVP_PROVIDER=dashscope 时也能单张出关键帧，互不干扰。
  const imageProvider = opts.imageProvider || createProvider({ id: 'seedream', registry: spec.reg });
  // 第四条缝：kind==='local' 固定走本机 ComfyUI（VisInter 的 wan2.2 开源管线）。
  // 为什么单独一条：VisInter 的规格是「不依赖 ARK key、不调用 Seedream 云端」，
  // 让它跟着 AVP_PROVIDER=auto 落到 dashscope 就是偷偷花钱 —— 欠费报错正是这么暴露的。
  const localProvider = opts.localProvider || createProvider({ id: 'comfy', comfyUrl: opts.comfyUrl, registry: spec.reg });
  const providerFor = (job) => (job && job.kind === 'cine' ? cineProvider : job && job.kind === 'image' ? imageProvider : job && (job.kind === 'local' || (job.provider === 'comfy' && provider.id !== 'comfy')) ? localProvider : provider);
  const maxAttempts = 2;
  const reconnectMs = Math.max(50, Number(opts.reconnectMs || process.env.AVP_RECONNECT_MS || 5000));
  const archive = opts.archive || ((job) => require('./archive.js').archiveJob(job, opts.archiveOptions));

  const postprocessAsync = opts.postprocessAsync || ((o) => require('./ultimate.js').postprocessAsync(o));
  const archiveEnhanced = opts.archiveEnhanced || ((file, meta) => require('./archive.js').archivePath(file, meta));
  const enhancementSteps = ['interp', 'upscale', 'lut', 'grain'];

  function queueEnhancement(job) {
    job.enhancement = {
      state: 'queued', queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      attempts: job.enhancement && job.enhancement.attempts || 0,
      steps: job.quality && job.quality.fps && job.quality.fps.needs_interp === false ? enhancementSteps.filter((s) => s !== 'interp') : [...enhancementSteps],
      output_fps: (job.quality && job.quality.fps && job.quality.fps.output_fps) || 60,
    };
    job.enhancedError = null;
  }

  /** 独立持久队列；不重跑原生生成。HTTP 层可直接以 202 返回受理快照。 */
  function enhance(id) {
    acquire();
    const job = mustGet(id);
    if (job.state !== 'succeeded' || !job.pure_output || !fs.existsSync(job.pure_output) || !/\.(mp4|mov|mkv|webm)$/i.test(job.pure_output)) throw new JobError('JOB_NOT_ENHANCEABLE', '仅可增强已保存纯净视频的完成任务', { id });
    if (job.enhancement && ['queued', 'running', 'done'].includes(job.enhancement.state)) return publicView(job);
    queueEnhancement(job);
    save(job);
    emit(id, { type: 'enhancement', enhancement: job.enhancement });
    const accepted = publicView(job);
    pump();
    return accepted;
  }

  async function enhanceJob(job) {
    job.enhancement = { ...job.enhancement, state: 'running', startedAt: new Date().toISOString(), attempts: (job.enhancement.attempts || 0) + 1 };
    save(job);
    emit(job.id, { type: 'enhancement', enhancement: job.enhancement });
    try {
      const r = await postprocessAsync({
        file: job.pure_output,
        steps: job.enhancement.steps,
        outDir: path.join(CACHE_ROOT, 'avp', 'enhance', job.id),
        outputFps: job.enhancement.output_fps,
      });
      if (!r || r.ok !== true || !r.enhanced || !Array.isArray(r.steps) || r.steps.length !== job.enhancement.steps.length || r.steps.some((x, i) => !x.ok || x.step !== job.enhancement.steps[i])) {
        throw new JobError(r && r.error && r.error.code || 'ENHANCE_INCOMPLETE', r && r.error && r.error.message || '增强链不完整，拒绝归档局部产物', { steps: r && r.steps });
      }
      const moved = await archiveEnhanced(r.enhanced, {
        job_id: job.id, variant: 'enhanced', experiment_id: job.experiment_id,
        engine: (job.engine || job.model || 'comfy') + '_enhanced',
        name: `${job.experiment_id || 'exp'}_${job.id}_enhanced.mp4`,
        prompt: job.prompt || job.note || null,
        params: { steps: r.steps.map((x) => x.step), source_job: job.id, experiment_id: job.experiment_id },
      });
      if (!moved || !moved.file) throw new JobError('ENHANCE_ARCHIVE_FAILED', '增强版归档失败');
      job.enhanced = {
        file: moved.file, bytes: moved.record && moved.record.bytes,
        steps: r.steps.map((x) => x.step), native_fps: r.native_fps ?? null,
        output_fps: r.output_fps ?? null, at: new Date().toISOString(),
      };
      job.enhancedError = null;
      job.enhancement = { ...job.enhancement, state: 'done', finishedAt: new Date().toISOString() };
    } catch (e) {
      job.enhancedError = { code: e.code || 'ENHANCE_FAILED', message: e.message, detail: e.detail || null, at: new Date().toISOString() };
      job.enhancement = { ...job.enhancement, state: 'failed', finishedAt: new Date().toISOString() };
    }
    save(job); // close 持有锁并等待此 Promise，绝不在释放锁后回写。
    emit(job.id, { type: 'enhancement', enhancement: job.enhancement, enhanced: job.enhanced || null, enhancedError: job.enhancedError });
  }

  fs.mkdirSync(dir, { recursive: true });

  /** @type {Map<string, any>} */
  const jobs = new Map();
  const emitters = new Map();
  let running = 0, closed = false, wakeTimer = null, ownsLock = false;
  let enhancing = false, closingPromise = null;
  const active = new Map();
  const inflight = new Set();
  const lockFile = path.join(dir, '.worker.lock');
  const owner = { pid: process.pid, token: crypto.randomUUID() };

  function acquire() {
    if (closed) throw new JobError('JOB_WORKER_CLOSED', '任务调度器已关闭');
    if (ownsLock) return;
    try {
      fs.writeFileSync(lockFile, JSON.stringify(owner), { flag: 'wx', flush: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const other = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      let alive = true;
      try { process.kill(other.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new JobError('JOB_WORKER_ACTIVE', '已有后端进程管理此任务表，请连接现有服务', { pid: other.pid, dir });
      fs.unlinkSync(lockFile);
      fs.writeFileSync(lockFile, JSON.stringify(owner), { flag: 'wx', flush: true });
    }
    ownsLock = true;
  }

  const emit = (id, evt) => {
    if (!ownsLock) return; // 异步取消日志等回调不得在 close 释放锁后写盘。
    const event = { at: new Date().toISOString(), ...evt };
    const { job, ...log } = event;
    fs.appendFileSync(path.join(dir, id + '.events.jsonl'), JSON.stringify(log) + '\n', { flush: true });
    const em = emitters.get(id);
    if (em) em.emit('event', event);
  };

  function save(job) {
    if (!ownsLock) throw new JobError('JOB_WORKER_CLOSED', '未持有任务表锁，拒绝回写');
    job.task_id = job.id;
    job.status = { queued: 'pending', running: 'running', succeeded: 'done', failed: 'failed', canceled: 'failed' }[job.state];
    job.updatedAt = new Date().toISOString();
    job.output_path = typeof job.output === 'string' ? job.output : job.output && job.output.file || null;
    const file = path.join(dir, job.id + '.json');
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), { encoding: 'utf8', flush: true });
    fs.renameSync(tmp, file);
  }

  function restore() {
    acquire();
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/^job_[\w-]+\.json$/.test(f)) continue;
      let j;
      try {
        j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || j.id + '.json' !== f) throw new Error('任务 ID 与文件名不一致');
      } catch (e) {
        console.error('[jobs] 任务文件损坏，已保留原文件：' + f + ' · ' + e.message);
        continue;
      }
      if (jobs.has(j.id)) continue;
      j.experiment_id = j.experiment_id || 'exp_' + j.id.slice(4);
      j.prompt = j.prompt || j.cinePrompt || j.note || '';
      j.canvasSnapshot = j.canvasSnapshot || j.workflow || j.template || null;
      if (j.state === 'running' || j.state === 'queued') {
        j.state = j.canceled ? 'canceled' : 'queued';
        j.nextRunAt = null;
        j.finishedAt = null;
        j.progress = { ...j.progress, stage: j.canceled ? 'canceled' : 'recovering', text: '重新对接后端任务与 ComfyUI 队列' };
        if (j.canceled) j.finishedAt = new Date().toISOString();
      }
      // 只恢复明确持久化的增强意图；不扫描/重处理旧完成任务。
      if (j.enhancement && ['queued', 'running'].includes(j.enhancement.state)) {
        if (j.state === 'succeeded' && j.pure_output) {
          j.enhancement = { ...j.enhancement, state: 'queued', recoveredAt: new Date().toISOString(), startedAt: null, finishedAt: null, steps: j.enhancement.steps || [...enhancementSteps], output_fps: j.enhancement.output_fps || 60 };
        } else {
          j.enhancement = { ...j.enhancement, state: 'failed', finishedAt: new Date().toISOString() };
          j.enhancedError = { code: 'ENHANCE_NO_PURE', message: '恢复增强任务时未找到已完成的纯净产物' };
        }
      }
      jobs.set(j.id, j);
      save(j);
      n++;
    }
    pump();
    return n;
  }

  function publicView(j) {
    // 列表里不带整份 values（258 键 × N 任务太大）与整份 cineReport（8 组×重试提示词），详情接口才给全量。
    const { values, valueSnapshot, canvasSnapshot, workflow, template, cineReport, ...rest } = j;
    return {
      ...rest, canRetry: j.state === 'failed' || j.state === 'canceled',
      valuesCount: values ? Object.keys(values).length : 0,
      cine: cineReport ? { candidates: cineReport.candidates || null, pick: cineReport.pick || null, warnings: cineReport.warnings || [], analysis: cineReport.analysis || null } : null,
    };
  }

  function mustGet(id) {
    const j = jobs.get(id);
    if (!j) throw new JobError('JOB_NOT_FOUND', `任务 ${id} 不存在`, { id });
    return j;
  }

  async function create({ values = {}, device, template, note, model, promptExtend, kind, prompt, style, resume, multi, continuity, ratio, theme, ability, tier, size, dryRun, stage, rawPrompt, watermark, workflow, engine, experiment_id, canvasSnapshot, quality } = {}) {
    acquire();
    if (experiment_id != null && (typeof experiment_id !== 'string' || !/^[\p{L}\p{N}_-]{1,96}$/u.test(experiment_id))) {
      throw new JobError('BAD_EXPERIMENT_ID', '实验 ID 仅允许字母、数字、下划线或连字符（1–96 字）');
    }
    const dev = device || (spec.catalog.devices.find((d) => d.id === 'T0') || spec.catalog.devices[0]).id;
    if (!spec.catalog.devices.some((d) => d.id === dev)) {
      throw new JobError('BAD_DEVICE', `未知档位 ${dev}`, { allowed: spec.catalog.devices.map((d) => d.id) });
    }
    if (kind != null && !['cine', 'image', 'local'].includes(kind)) throw new JobError('BAD_KIND', `未知任务 kind ${kind}`, { allowed: ['cine', 'image', 'local'] });
    if (kind === 'cine' && !String(prompt || '').trim()) throw new JobError('CINE_EMPTY_PROMPT', '一句话电影需要 prompt（用户的那一句话）', {});
    const id = 'job_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
    const ctx = { device: dev, usable_mib: (spec.catalog.devices.find((d) => d.id === dev) || {}).usable_mib };
    // 关键：engine.resolve 只解析"传进来的键"，不会帮你补默认值（实测 values:{} → 全 null）。
    // 所以这里先铺 258 个默认值再叠用户传的，否则估算全是 null、任务也跑不出数字。
    const input = { ...AVP.defaults(spec.reg), ...values };
    const resolved = AVP.resolve(spec.reg, spec.rules, input, { ctx });
    const estimate = AVP.estimate(spec.reg, spec.catalog, resolved.values, { device: dev });
    const job = {
      id, state: 'queued', device: dev, template: template || null,
      experiment_id: experiment_id || 'exp_' + id.slice(4),
      prompt: String(prompt || values['ch.prompt_prefix'] || values['kf.prompt_prefix'] || values['ch.subject'] || note || ''),
      canvasSnapshot: canvasSnapshot || workflow || template || null,
      retryCount: 0, nextRunAt: null,
      kind: kind || null, cinePrompt: kind === 'cine' ? String(prompt).trim() : null,
      cineStyle: kind === 'cine' ? (style || null) : null, cineResume: kind === 'cine' ? !!resume : false,
      cineMulti: kind === 'cine' ? !!multi : false, cineContinuity: kind === 'cine' ? !!continuity : false,
      cineRatio: kind === 'cine' ? (ratio || null) : null,
      cineTheme: kind === 'cine' ? (theme || null) : null,
      ability: kind === 'image' ? (ability || style || null) : null,
      imageStage: kind === 'image' ? (stage || null) : null,
      imageTier: kind === 'image' ? (tier || null) : null,
      imageRatio: kind === 'image' ? (ratio || null) : null,
      imageSize: kind === 'image' ? (size || null) : null,
      dryRun: kind === 'image' ? !!dryRun : false,
      rawPrompt: !!rawPrompt,
      watermark: watermark === undefined ? null : !!watermark,
      // H3 本地图的直传工作流（kind=local 用）；存 job 以便重跑与复现，体积约 2KB
      workflow: workflow && typeof workflow === 'object' ? workflow : null,
      engine: engine || (model === 'minimax_h3' ? 'minimax_h3' : model === 'wan22' ? 'wan22' : null),
      quality: quality || null,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, durationMs: null,
      attempt: 0, attempts: [], mock: null, canceled: false,
      provider: providerFor({ kind }).id, providerTaskId: null, model: model || null, promptExtend: promptExtend == null ? null : !!promptExtend,
      values, valueSnapshot: resolved.values, warnings: resolved.warnings, trace: resolved.trace,
      estimate, actualPeakMib: null, actualDurationMs: null, comfyPromptId: null,
      images: [], output: null, error: null, progress: { percent: 0, stage: 'queued' }, note: note || null,
    };
    save(job);
    jobs.set(id, job);
    emit(id, { type: 'state', state: 'queued', job: publicView(job) });
    // 先拍 queued 快照再调度：接口返回受理时刻状态，不受 worker 进度影响。
    const created = publicView(job);
    pump();
    return created;
  }

  function list({ state, status, active: activeOnly, limit = 50 } = {}) {
    let all = [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (state) all = all.filter((j) => j.state === state);
    if (status) all = all.filter((j) => j.status === status);
    if (activeOnly) all = all.filter((j) => j.state === 'queued' || j.state === 'running');
    return all.slice(0, Math.max(1, Math.min(500, Number(limit) || 50))).map(publicView);
  }

  function get(id) { return mustGet(id); }

  function stats() {
    const out = { total: jobs.size, running, concurrency, dir, enhancing, enhancementQueued: [...jobs.values()].filter((j) => j.enhancement && j.enhancement.state === 'queued').length };
    for (const s of STATES) out[s] = [...jobs.values()].filter((j) => j.state === s).length;
    return out;
  }

  function cancel(id) {
    const job = mustGet(id);
    if (job.state === 'succeeded' || job.state === 'failed' || job.state === 'canceled') {
      throw new JobError('JOB_NOT_CANCELABLE', `任务已是 ${job.state}，不能取消`, { id, state: job.state });
    }
    job.canceled = true;
    save(job);
    const controller = active.get(id);
    if (controller) controller.abort(Object.assign(new Error('已取消'), { code: 'JOB_CANCELED' }));
    const prov = providerFor(job);
    if (job.providerTaskId && prov.cancel) {
      Promise.resolve(prov.cancel(job))
        .then((r) => { if (r && r.remote === false && r.reason) emit(id, { type: 'log', level: 'warn', text: '远端取消未生效（任务可能继续计费）：' + r.reason }); })
        .catch((e) => emit(id, { type: 'log', level: 'warn', text: '取消请求失败：' + (e.message || e.code) }));
    }
    if (job.state === 'queued') {
      job.state = 'canceled'; job.finishedAt = new Date().toISOString();
      job.error = { code: 'JOB_CANCELED', message: '排队中被取消', detail: {} };
      save(job); emit(id, { type: 'state', state: 'canceled', job: publicView(job) });
    } else {
      emit(id, { type: 'log', level: 'info', text: '已请求取消，等当前节点返回' });
    }
    return publicView(job);
  }

  function retry(id) {
    acquire();
    const job = mustGet(id);
    if (!['failed', 'canceled'].includes(job.state) || active.has(id)) {
      throw new JobError('JOB_NOT_RETRYABLE', '仅可重试已结束的失败或取消任务', { id, state: job.state });
    }
    const previousCode = job.error && job.error.code || '';
    job.attempts.push({ at: new Date().toISOString(), action: 'manual-retry', error: job.error, providerTaskId: job.providerTaskId, comfySubmission: job.comfySubmission || null });
    if (job.state === 'canceled' || ['COMFY_EXEC_ERROR', 'COMFY_OOM', 'COMFY_TASK_LOST', 'COMFY_SUBMISSION_UNCERTAIN'].includes(previousCode)) {
      job.providerTaskId = null;
      job.comfyPromptId = null;
      job.comfySubmission = null;
      job.result = null;
      job.images = [];
    }
    job.state = 'queued';
    job.canceled = false;
    job.error = null;
    job.finishedAt = null;
    job.nextRunAt = null;
    job.attempt = 0;
    job.retryCount = (job.retryCount || 0) + 1;
    job.progress = { percent: null, stage: 'retry', text: '按原任务快照重试' };
    save(job);
    emit(id, { type: 'state', state: job.state, job: publicView(job) });
    const accepted = publicView(job);
    pump();
    return accepted;
  }

  /** 电影管线选优窗口内的人工改选（规格第 4 步）。窗口外/已改选/非运行态一律拒绝。 */
  function pick(id, index) {
    const job = mustGet(id);
    if (job.kind !== 'cine' || job.state !== 'running' || !job.cinePick || job.cinePick.override != null) {
      throw new JobError('JOB_NOT_PICKABLE', '当前不在选优窗口内（8 组就绪后 15 秒内可改选）', { id, state: job.state });
    }
    const n = Number(index);
    if (!Number.isInteger(n) || n < 0 || n >= job.cinePick.options.length) {
      throw new JobError('BAD_PICK', `候选序号越界：${index}`, { allowed: job.cinePick.options.map((o) => o.id) });
    }
    job.cinePick.override = n;
    save(job);
    emit(job.id, { type: 'cine-pick', pick: job.cinePick });
    return publicView(job);
  }

  /** 审核复核队列：人工对 REVIEW（或任一条）QAReport 改判 PASS/REJECT，留痕复核人/原因。 */
  function review(id, auditId, decision, reason) {
    const job = mustGet(id);
    const list = (job.cineReport && job.cineReport.audit) || [];
    const item = list.find((a) => a.id === auditId);
    if (!item) throw new JobError('AUDIT_NOT_FOUND', '找不到该审核报告', { id, auditId });
    if (decision !== 'PASS' && decision !== 'REJECT') throw new JobError('BAD_REVIEW', '改判只能是 PASS 或 REJECT', { got: decision });
    item.reviewer = 'user';
    item.decision = decision;
    item.reason = String(reason || item.reason || '');
    item.retryHistory = item.retryHistory || [];
    item.retryHistory.push({ at: new Date().toISOString(), by: 'user', decision, reason: item.reason });
    save(job);
    emit(job.id, { type: 'cine-review', audit: item });
    return publicView(job);
  }

  function pump() {
    if (closed || enhancing) return;
    clearTimeout(wakeTimer);
    while (running < concurrency) {
      const next = [...jobs.values()].find((j) => j.state === 'queued' && !j.canceled && !active.has(j.id) && (!j.nextRunAt || Date.parse(j.nextRunAt) <= Date.now()));
      if (!next) break;
      const ac = new AbortController();
      active.set(next.id, ac);
      running++;
      // 先登记 inflight 再执行，防止同步事件订阅者调用 close 时漏等该任务。
      const execution = Promise.resolve().then(() => closed || next.canceled ? undefined : run(next, ac)).catch((e) => console.error('[jobs] ' + next.id + ' · ' + e.message)).finally(() => {
        active.delete(next.id);
        inflight.delete(execution);
        running--;
        pump();
      });
      inflight.add(execution);
    }
    const delayed = [...jobs.values()].filter((j) => j.state === 'queued' && !j.canceled && !active.has(j.id) && j.nextRunAt);
    if (delayed.length && running < concurrency) {
      const at = Math.min(...delayed.map((j) => Date.parse(j.nextRunAt)));
      wakeTimer = setTimeout(pump, Math.max(10, at - Date.now()));
      wakeTimer.unref();
    }
    // 生成优先排空；等待重连的原生任务也可能仍占远端 GPU，不能同时启动增强。
    // enhancing 在调用 worker 前同步置位，新 create/pump 不会抢跑下一次推理。
    if (running === 0 && ![...jobs.values()].some((j) => ['queued', 'running'].includes(j.state) && !j.canceled)) {
      const next = [...jobs.values()].find((j) => j.state === 'succeeded' && j.enhancement && j.enhancement.state === 'queued');
      if (next) {
        enhancing = true;
        const execution = Promise.resolve().then(() => closed ? undefined : enhanceJob(next)).catch((e) => console.error('[enhancement] ' + next.id + ' · ' + e.message)).finally(() => {
          inflight.delete(execution);
          enhancing = false;
          pump();
        });
        inflight.add(execution);
      }
    }
  }

  async function run(job, ac) {
    job.state = 'running';
    job.startedAt = job.startedAt || new Date().toISOString();
    job.finishedAt = null;
    job.nextRunAt = null;
    save(job);
    emit(job.id, { type: 'state', state: 'running', job: publicView(job) });

    const t0 = Date.parse(job.startedAt);
    const abortIfCanceled = () => { if (job.canceled) ac.abort(); };
    const prov = providerFor(job);

    try {
      job.mock = prov.mode === 'mock';
      const result = job.result || await prov.run(job, {
        signal: ac.signal,
        onCheckpoint: (patch) => {
          Object.assign(job, patch);
          save(job);
        },
        onProgress: (p) => {
          if (job.canceled) { ac.abort(); return; }
          if (closed) return;
          job.state = p.stage === 'queued' ? 'queued' : 'running';
          job.progress = { percent: p.percent == null ? null : p.percent, stage: p.stage, text: p.text || null };
          save(job);
          emit(job.id, { type: 'progress', ...p });
        },
        onGroup: (g) => {
          job.cineLive = job.cineLive || [];
          const i = job.cineLive.findIndex((x) => x.id === g.id);
          if (i >= 0) job.cineLive[i] = g; else job.cineLive.push(g);
          save(job);
          emit(job.id, { type: 'cine-group', group: g });
        },
        onPick: (defaultIndex, options) => new Promise((resolve) => {
          job.cinePick = { defaultIndex, options, at: Date.now(), override: null, windowMs: Math.max(0, Number(process.env.AVP_CINE_PICK_MS || 15000)) };
          save(job);
          emit(job.id, { type: 'cine-pick', pick: job.cinePick });
          const timer = setInterval(() => {
            if (job.cinePick.override != null) { clearInterval(timer); resolve(job.cinePick.override); }
            else if (job.canceled || Date.now() - job.cinePick.at > job.cinePick.windowMs) { clearInterval(timer); resolve(defaultIndex); }
          }, 300);
        }),
        onSubmitted: ({ taskId, meta }) => {
          job.providerTaskId = taskId || null;
          if (prov.id === 'comfy') {
            job.comfyPromptId = taskId || null;
            job.comfySubmission = { ...job.comfySubmission, promptId: taskId, phase: 'submitted' };
          }
          if (meta) {
            if (meta.comfySubmission) job.comfySubmission = meta.comfySubmission;
            if (meta.workflowStats) job.workflowStats = meta.workflowStats;
            if (meta.workflowWarnings) job.workflowWarnings = meta.workflowWarnings;
            if (meta.dsRequest) job.dsRequest = meta.dsRequest;
            if (meta.requestId) job.providerRequestId = meta.requestId;
            if (meta.cineReport) job.cineReport = meta.cineReport;
          }
          save(job);
          emit(job.id, { type: 'log', level: 'info', text: `已提交 ${prov.id}：${taskId}` });
          abortIfCanceled();
        },
      });
      if (job.canceled) throw Object.assign(new Error('已取消'), { code: 'JOB_CANCELED' });
      if (result.meta) {
        if (result.meta.workflowStats) job.workflowStats = result.meta.workflowStats;
        if (result.meta.workflowWarnings) job.workflowWarnings = result.meta.workflowWarnings;
        if (result.meta.dsRequest) job.dsRequest = result.meta.dsRequest;
        if (result.meta.cineReport) job.cineReport = result.meta.cineReport;
      }
      if (result.taskId && !job.providerTaskId) job.providerTaskId = result.taskId;
      job.result = result;
      job.images = result.images || [];
      job.output = result.output || null;
      job.actualDurationMs = Date.now() - t0;
      job.progress = { percent: null, stage: 'archiving', text: '生成已完成，正在保存纯净实验版' };
      save(job);
      // cine 的本地回退（providers/cine.js）也产出 mp4，同样要归档；
      // 判据放在 meta.localComfy 上，避免把仍是云端的 provider 混进来。
      const localArchive = prov.id === 'comfy' || !!(result.meta && result.meta.localComfy);
      if (localArchive) {
        const a = await archive(job);
        if (!a || !a.file) throw new JobError('ARCHIVE_NO_OUTPUT', '未取得归档文件，任务可重试');
        job.output = { file: a.file, bytes: a.bytes };
        job.pure_output = a.file;
        job.archived = a.record;
      }
      job.state = 'succeeded';
      job.error = null;
      job.progress = { percent: 100, stage: 'done' };
      if (localArchive && job.pure_output && /\.(mp4|mov|mkv|webm)$/i.test(job.pure_output) && process.env.AVP_AUTO_ENHANCE !== '0') {
        queueEnhancement(job); // 随原生 done 一起落盘，增强失败不改变此终态。
      }
    } catch (e) {
      if (closed && !job.canceled) {
        job.state = 'queued';
        job.progress = { ...job.progress, stage: 'recovering', text: '后端重启后将续接原任务' };
      } else if (job.canceled || e && e.code === 'JOB_CANCELED') {
        job.state = 'canceled';
        job.error = { code: 'JOB_CANCELED', message: '已取消', detail: {} };
      } else {
        const code = (e && e.code) || 'JOB_FAILED';
        const detail = (e && e.detail) || {};
        job.attempt += 1;
        job.attempts.push({ at: new Date().toISOString(), code, message: e && e.message, detail });
        if (prov.id === 'comfy' && ['COMFY_UNREACHABLE', 'COMFY_TIMEOUT', 'COMFY_HTTP_ERROR'].includes(code) && (!detail.status || detail.status >= 500)) {
          job.state = 'queued';
          job.error = { code, message: e.message, detail, hint: '任务已保存，ComfyUI 恢复后自动续接，无需再次提交' };
          job.nextRunAt = new Date(Date.now() + reconnectMs).toISOString();
          job.progress = { percent: job.progress.percent, stage: 'waiting_comfy', text: '等待 ComfyUI 恢复连接' };
          return;
        }
        // 校验类错误重试也不会好；已提交到云端的任务不自动重投（重投=重复计费），留 taskId 人工续查。
        // 电影管线组内已有≤3 次打磨重试，任务级一律不重投（重跑会把已计费的 8 组关键帧再买一遍）。
        const nonRetryable = ['COMFY_VALIDATION_FAILED', 'COMFY_INVALID_PROMPT', 'COMFY_NO_OUTPUTS', 'COMFY_MISSING_NODE', 'WF_BAD_TEMPLATE', 'WF_SYNTHETIC_TEMPLATE', 'BAD_DEVICE', 'DS_NO_API_KEY', 'DS_INVALID_API_KEY', 'DS_EMPTY_PROMPT', 'DS_SUBMIT_FAILED', 'DS_TASK_FAILED', 'DS_TASK_UNKNOWN', 'CINE_EMPTY_PROMPT', 'SR_NO_API_KEY', 'SR_INVALID_API_KEY', 'SR_EMPTY_PROMPT', 'SR_BAD_SIZE', 'SR_BAD_ABILITY', 'SR_HTTP_ERROR', 'SR_UNREACHABLE', 'SR_KIND_UNSUPPORTED'];
        const retryable = prov.id !== 'comfy' && job.kind !== 'cine' && !job.providerTaskId && !nonRetryable.includes(code);
        if (retryable && job.attempt < maxAttempts) {
          emit(job.id, { type: 'log', level: 'warn', text: `第 ${job.attempt} 次失败（${code}），重试一次` });
          job.state = 'queued';
          job.progress = { percent: 0, stage: 'retry' };
          job.nextRunAt = new Date(Date.now() + reconnectMs).toISOString();
          return;
        }
        afterFail(job, e);
      }
    } finally {
      const terminal = ['succeeded', 'failed', 'canceled'].includes(job.state);
      job.finishedAt = terminal ? new Date().toISOString() : null;
      job.actualDurationMs = Date.now() - t0;
      job.durationMs = job.actualDurationMs;
      save(job);
      emit(job.id, { type: 'state', state: job.state, job: publicView(job) });
      if (terminal) {
        emit(job.id, { type: 'done', state: job.state });
      }
    }
  }

  function afterFail(job, e) {
    job.state = 'failed';
    job.error = { code: (e && e.code) || 'JOB_FAILED', message: (e && e.message) || '执行失败', detail: (e && e.detail) || {} };
    if (e && e.hint) job.error.hint = e.hint;
    job.progress = { percent: job.progress && job.progress.percent ? job.progress.percent : 0, stage: 'failed' };
  }

  function subscribe(id, fn) {
    mustGet(id);
    let em = emitters.get(id);
    if (!em) { em = new EventEmitter(); em.setMaxListeners(50); emitters.set(id, em); }
    em.on('event', fn);
    return () => { em.off('event', fn); };
  }

  function close() {
    if (closingPromise) return closingPromise;
    closed = true;
    clearTimeout(wakeTimer);
    for (const controller of active.values()) controller.abort(Object.assign(new Error('后端退出，仅断开观察，不取消 ComfyUI 任务'), { code: 'JOB_DETACHED' }));
    closingPromise = (async () => {
      // 包括 worker/增强归档；队列项留在盘上，正在执行项结束后才释放写锁。
      await Promise.allSettled([...inflight]);
      if (ownsLock) {
        const current = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        if (current.token === owner.token) fs.unlinkSync(lockFile);
        ownsLock = false;
      }
    })();
    return closingPromise;
  }

  return { create, list, get, cancel, retry, enhance, pick, review, stats, subscribe, restore, save, publicView, close, dir, spec, provider, mockMs, concurrency };
}

module.exports = { createJobs, JobError, STATES, JOBS_DIR, loadSpec };