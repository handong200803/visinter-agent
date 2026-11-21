'use strict';

// Focused CPU-only checks. ncnn/CV/provider fixtures below are SIMULATED, not GPU evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createRequire } = require('node:module');
const { once } = require('node:events');

const parent = 'D:/缓存/avp';
const root = fs.mkdtempSync(path.join(parent, 'postprocess-test-'));
const envKeys = ['AVP_RIFE', 'AVP_RIFE_MODEL', 'AVP_REALESRGAN', 'AVP_REALESRGAN_MODEL', 'AVP_REALESRGAN_MODEL_NAME', 'AVP_AUTO_ENHANCE'];
const oldEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
for (const k of envKeys) delete process.env[k];
const ULT = require('./ultimate.js');
const SCORE = require('./scoring.js');
const { createJobs } = require('./jobs.js');
const steps = ['interp', 'upscale', 'lut', 'grain'];
let passed = 0;
const check = (value, label) => { assert.ok(value, label); passed++; console.log('PASS ' + label); };
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const immediate = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function until(test, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timeout: ' + label);
}
function run(exe, args) {
  const r = cp.spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, String(r.error || r.stderr));
  return r.stdout;
}
function loadWithSpawn(name, spawnSync) {
  const filename = path.join(__dirname, name);
  const module = { exports: {} };
  const req = createRequire(filename);
  const wrapped = vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(filename, 'utf8') + '\n})', { filename });
  wrapped((key) => key === 'node:child_process' ? { ...cp, spawnSync } : req(key), module, module.exports, filename, __dirname);
  return module.exports;
}
function complete(file) {
  return { ok: true, enhanced: file, steps: steps.map((step) => ({ step, ok: true })), native_fps: 24, output_fps: 60 };
}
function seed(dir, id, file, state) {
  fs.mkdirSync(dir, { recursive: true });
  const job = { id, state: 'succeeded', provider: 'comfy', pure_output: file, output: { file }, createdAt: new Date().toISOString(), finishedAt: 'native-finished', progress: { percent: 100, stage: 'done' } };
  if (state) job.enhancement = { state, steps, output_fps: 60, attempts: 1 };
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(job));
}

async function main() {
  const source = path.join(root, 'source.mp4');
  run(SCORE.FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
  const originalHash = hash(source);
  const sourceAudio = path.join(root, 'source.aac');
  run(SCORE.FFMPEG, ['-v', 'error', '-i', source, '-vn', '-c:a', 'copy', sourceAudio]);

  const missing = ULT.postprocess({ file: source, outDir: path.join(root, 'missing') });
  check(!missing.ok && missing.error.code === 'POST_BACKEND_MISSING' && !missing.enhanced, 'missing ncnn fails explicitly, no ffmpeg substitute');
  check(hash(missing.pure_copy) === originalHash && hash(source) === originalHash, 'pure is saved before backend failure and remains byte-identical');
  await assert.rejects(ULT.postprocessAsync({ file: path.join(root, 'absent.mp4') }), { code: 'POST_NO_FILE' });
  check(true, 'worker preserves error codes');
  process.env.AVP_RIFE = process.execPath;
  const missingModel = ULT.postprocess({ file: source, steps: ['interp'], outDir: path.join(root, 'missing-model') });
  check(!missingModel.ok && missingModel.error.code === 'POST_MODEL_MISSING', 'missing model directory is explicit');

  const rifeModel = path.join(root, 'simulated-rife-model');
  const upModel = path.join(root, 'simulated-esrgan-model');
  fs.mkdirSync(rifeModel); fs.mkdirSync(upModel);
  process.env.AVP_RIFE_MODEL = rifeModel;
  const emptyModel = ULT.postprocess({ file: source, steps: ['interp'], outDir: path.join(root, 'empty-model') });
  check(!emptyModel.ok && emptyModel.error.code === 'POST_MODEL_MISSING', 'empty model directory rejected');
  for (const ext of ['.param', '.bin']) {
    fs.writeFileSync(path.join(rifeModel, 'flownet' + ext), 'SIMULATED MODEL - NOT FOR INFERENCE');
    fs.writeFileSync(path.join(upModel, 'fixture-x2' + ext), 'SIMULATED MODEL - NOT FOR INFERENCE');
  }
  process.env.AVP_REALESRGAN = process.execPath;
  process.env.AVP_REALESRGAN_MODEL = upModel;
  process.env.AVP_REALESRGAN_MODEL_NAME = 'fixture';
  let fault = null;
  const calls = [];
  const simulated = loadWithSpawn('ultimate.js', (exe, args, opts) => {
    if (exe === SCORE.FFPROBE && args.at(-1).endsWith('enhanced.part.mp4') && fault && fault.startsWith('verify-')) {
      const r = cp.spawnSync(exe, args, opts);
      const j = JSON.parse(r.stdout);
      const video = j.streams.find((s) => s.codec_type === 'video');
      if (fault === 'verify-fps') video.avg_frame_rate = '30/1';
      if (fault === 'verify-duration') video.duration = '2';
      if (fault === 'verify-audio') j.streams = j.streams.filter((s) => s.codec_type !== 'audio');
      return { ...r, stdout: JSON.stringify(j) };
    }
    if (exe !== process.execPath || !args.includes('-m')) return cp.spawnSync(exe, args, opts);
    calls.push({ exe, args });
    const at = (key) => args[args.indexOf(key) + 1];
    const input = at('-i'), output = at('-o');
    const files = fs.readdirSync(input).filter((f) => f.endsWith('.png')).sort();
    if (!args.includes('-s')) {
      // SIMULATED RIFE: repeated frames test command/frame-count plumbing only.
      const total = Number(at('-n'));
      for (let i = 0; i < total; i++) fs.copyFileSync(path.join(input, files[Math.min(files.length - 1, Math.floor(i * files.length / total))]), path.join(output, String(i + 1).padStart(8, '0') + '.png'));
      if (fault === 'missing-frame') fs.unlinkSync(path.join(output, '00000002.png'));
      if (fault === 'corrupt-frame') fs.writeFileSync(path.join(output, '00000002.png'), 'not a png');
    } else {
      if (fault === 'upscale-error') return { status: 9, stderr: 'SIMULATED ncnn failure' };
      // SIMULATED ESRGAN: CPU scale is test fixture generation ONLY, never production fallback.
      run(SCORE.FFMPEG, ['-y', '-v', 'error', '-start_number', '1', '-i', path.join(input, '%08d.png'), '-vf', fault === 'wrong-size' ? 'null' : 'scale=iw*2:ih*2', '-start_number', '1', path.join(output, '%08d.png')]);
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  delete process.env.AVP_REALESRGAN;
  const missingUpscaler = simulated.postprocess({ file: source, outDir: path.join(root, 'missing-upscaler') });
  check(!missingUpscaler.ok && missingUpscaler.error.code === 'POST_BACKEND_MISSING' && calls.length === 0, 'missing ESRGAN is caught before any RIFE execution');
  process.env.AVP_REALESRGAN = process.execPath;
  const result = simulated.postprocess({ file: source, steps: [], outDir: path.join(root, 'simulated-complete') });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  check(result.native_fps === 24 && result.output_fps === 60 && result.resolution.width === 192 && result.resolution.height === 128, 'SIMULATED ncnn pipeline verifies 24→60fps and exact 2x dimensions');
  check(calls[0].args.includes(rifeModel) && calls[0].args[calls[0].args.indexOf('-n') + 1] === '60', 'SIMULATED RIFE -n is total frames (60), not multiplier');
  check(calls[1].args.includes(upModel) && calls[1].args[calls[1].args.indexOf('-n') + 1] === 'fixture' && calls[1].args[calls[1].args.indexOf('-s') + 1] === '2', 'SIMULATED ESRGAN receives model directory, name and scale 2');
  const enhancedAudio = path.join(root, 'enhanced.aac');
  run(SCORE.FFMPEG, ['-v', 'error', '-i', result.enhanced, '-vn', '-c:a', 'copy', enhancedAudio]);
  check(hash(sourceAudio) === hash(enhancedAudio) && Math.abs(result.duration - 1) < 1 / 60, 'actual CPU encode preserves audio packets and duration');
  for (const mode of ['missing-frame', 'corrupt-frame', 'wrong-size', 'upscale-error']) {
    fault = mode;
    const bad = simulated.postprocess({ file: source, steps: ['interp', 'upscale'], outDir: path.join(root, mode) });
    check(!bad.ok && !bad.enhanced && hash(bad.pure_copy) === originalHash && hash(source) === originalHash, 'SIMULATED ' + mode + ' rejects partial enhancement, preserves pure');
  }
  for (const mode of ['verify-fps', 'verify-duration', 'verify-audio']) {
    fault = mode;
    const bad = simulated.postprocess({ file: source, steps: ['interp', 'upscale'], outDir: path.join(root, mode) });
    check(!bad.ok && bad.error.code === 'POST_VERIFY_FAILED' && !bad.enhanced, 'SIMULATED ' + mode + ' cannot publish invalid final media');
  }
  fault = null;
  const source30 = path.join(root, 'native-30fps.mp4');
  run(SCORE.FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=30', '-frames:v', '31', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source30]);
  const res30 = simulated.postprocess({ file: source30, steps: ['interp', 'upscale'], outDir: path.join(root, 'simulated-30fps') });
  check(res30.ok && res30.native_fps === 30 && res30.output_fps === 60 && res30.steps[0].frames === 62, 'SIMULATED 31 native frames at 30fps become 62 total frames at 60fps');
  assert.throws(() => ULT.postprocess({ file: source, steps: ['not-a-step'] }), { code: 'POST_BAD_STEPS' });
  check(true, 'unknown steps cannot silently succeed');
  // Never run the simulated model/binary configuration in a real worker.
  delete process.env.AVP_RIFE; delete process.env.AVP_REALESRGAN;
  const workerMissing = await ULT.postprocessAsync({ file: source, outDir: path.join(root, 'worker-missing') });
  check(!workerMissing.ok && workerMissing.error.code === 'POST_BACKEND_MISSING', 'async worker reports missing backend without GPU work');

  const server = http.createServer((_req, res) => res.end('responsive'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let ticks = 0, settled = false;
  const timer = setInterval(() => ticks++, 5);
  try {
    const work = ULT.postprocessAsync({ file: source, steps: ['lut', 'grain'], outDir: path.join(root, 'async-cpu') }).finally(() => { settled = true; });
    const response = await fetch('http://127.0.0.1:' + server.address().port);
    check(await response.text() === 'responsive' && !settled, 'HTTP remains responsive while real ffmpeg work runs in worker');
    const done = await work;
    check(done.ok && ticks > 0 && hash(source) === originalHash, 'CPU-only worker completes, event loop ticks and pure unchanged');
  } finally { clearInterval(timer); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }

  assert.throws(() => SCORE.scoreVideo({ file: source, sample_kind: 'enhanced' }), { code: 'SCORE_ENHANCED_FORBIDDEN' });
  const score = SCORE.scoreVideo({ file: result.enhanced, pure_output: source, useCV: false });
  check(score.file === source && score.native_fps === 24 && score.output_fps === null && score.resolution.width === 96, 'scorer prefers native and does not invent output fps');
  check(score.temporal_stability_score === score.scores.Sflow && score.detail_score >= 0 && score.detail_score <= 1 && score.provenance.detail_score === 'rule-proxy', 'detail is honest rule proxy; temporal stability aliases Sflow');
  const quality = require('./quality.js');
  const oldWeights = quality.scoringWeights;
  try {
    quality.scoringWeights = () => ({ Sface: 1, Sflow: 0, Sstyle: 0, Sbad: 0 });
    const weighted = SCORE.scoreVideo({ file: source, output_fps: 60, useCV: false });
    check(weighted.F === weighted.scores.Sface && weighted.output_fps === 60 && Object.keys(weighted.scores).length === 4, 'objective uses quality.scoringWeights and only four native terms');
  } finally { quality.scoringWeights = oldWeights; }
  const simulatedCV = loadWithSpawn('scoring.js', (exe, args, opts) => args.includes('-X') ? { status: 0, stdout: JSON.stringify({ flow: { jitter: 0.2, big_ratio: 0.1 }, faces: { available: true }, backend: 'SIMULATED-CV' }) } : cp.spawnSync(exe, args, opts));
  const cvScore = simulatedCV.scoreVideo({ file: source });
  check(cvScore.provenance.Sface === 'rule-proxy' && cvScore.provenance.Sflow === 'measured(opencv-farneback)' && !cvScore.not_measured.some((s) => s.startsWith('稠密光流')), 'SIMULATED CV: faces do not falsely promote Sface; available flow provenance stays consistent');

  // SIMULATED providers use promises; no ComfyUI endpoint, GPU submission, archive library or production jobs directory.
  process.env.AVP_AUTO_ENHANCE = '1';
  const rawCalls = [], enhancementCalls = [];
  let cancelCalls = 0;
  const provider = { id: 'comfy', mode: 'mock', cancel() { cancelCalls++; }, run(job, hooks) {
    const d = deferred(); rawCalls.push({ id: job.id, d });
    hooks.signal.addEventListener('abort', () => d.reject(hooks.signal.reason), { once: true });
    return d.promise;
  } };
  const dir = path.join(root, 'jobs-scheduling');
  let archiveCalls = 0;
  const opts = { dir, provider, localProvider: provider, cineProvider: provider, imageProvider: provider,
    archive: () => ({ file: source, bytes: fs.statSync(source).size, record: { simulated: true } }),
    postprocessAsync(o) { const d = deferred(); enhancementCalls.push({ o, d }); return d.promise; },
    archiveEnhanced: (file) => { archiveCalls++; return { file, record: { simulated: true } }; },
  };
  const jobs = createJobs(opts);
  try {
    const a = await jobs.create({}); const b = await jobs.create({});
    rawCalls[0].d.resolve({ output: { file: source } });
    await until(() => rawCalls.length === 2, 'second raw');
    check(jobs.get(a.id).state === 'succeeded' && jobs.get(a.id).enhancement.state === 'queued' && enhancementCalls.length === 0, 'raw completion persists independently; queued generation never overlaps enhancement');
    rawCalls[1].d.resolve({ output: { file: source } });
    await until(() => enhancementCalls.length === 1, 'first enhancement');
    const c = await jobs.create({});
    check(jobs.get(b.id).state === 'succeeded' && jobs.get(c.id).state === 'queued' && rawCalls.length === 2, 'new inference waits while enhancement occupies GPU slot');
    check(jobs.enhance(a.id).enhancement.state === 'running' && enhancementCalls.length === 1, 'duplicate enhance is idempotent');
    const closing = jobs.close();
    check(fs.existsSync(path.join(dir, '.worker.lock')), 'close retains lock while enhancement worker is active');
    const other = createJobs(opts);
    assert.throws(() => other.restore(), { code: 'JOB_WORKER_ACTIVE' });
    await other.close();
    enhancementCalls[0].d.resolve({ ...complete(result.enhanced), ok: false });
    await closing;
    check(jobs.get(a.id).state === 'succeeded' && jobs.get(a.id).pure_output === source && jobs.get(a.id).enhancement.state === 'failed' && archiveCalls === 0, 'partial enhanced path with ok=false is not archived and cannot fail native job');
    check(!fs.existsSync(path.join(dir, '.worker.lock')) && cancelCalls === 0, 'close releases lock after worker, never cancels raw Comfy jobs');
    const before = fs.readFileSync(path.join(dir, a.id + '.json'), 'utf8');
    assert.throws(() => jobs.save(jobs.get(a.id)), { code: 'JOB_WORKER_CLOSED' });
    await immediate();
    check(before === fs.readFileSync(path.join(dir, a.id + '.json'), 'utf8'), 'no state writes after close releases lock');
  } finally { for (const c of enhancementCalls) c.d.resolve(complete(result.enhanced)); await jobs.close(); }

  const recoveryDir = path.join(root, 'jobs-recovery');
  for (const [id, state] of [['job_legacy', null], ['job_failed', 'failed'], ['job_done', 'done'], ['job_queued', 'queued'], ['job_running', 'running']]) seed(recoveryDir, id, source, state);
  const recovered = [], archived = [];
  const recoveryOpts = { ...opts, dir: recoveryDir, postprocessAsync: async (o) => { recovered.push(o); return complete(result.enhanced); }, archiveEnhanced: async (file) => { archived.push(file); return { file, record: {} }; } };
  const recoveredJobs = createJobs(recoveryOpts);
  try {
    recoveredJobs.restore();
    await until(() => recoveredJobs.get('job_running').enhancement.state === 'done', 'enhancement recovery');
    check(recovered.length === 2 && !recoveredJobs.get('job_legacy').enhancement && recoveredJobs.get('job_failed').enhancement.state === 'failed', 'restart recovers only persisted queued/running enhancement intents');
    const accepted = recoveredJobs.enhance('job_failed');
    check(accepted.enhancement.state === 'queued', 'public enhance retry returns queued acceptance snapshot');
    await until(() => recoveredJobs.get('job_failed').enhancement.state === 'done', 'enhance retry');
    check(recovered.length === 3 && archived.length === 3 && recoveredJobs.get('job_failed').enhanced.output_fps === 60 && recoveredJobs.get('job_failed').finishedAt === 'native-finished', 'enhance retry archives complete enhancement and retains raw timestamps/metadata');
  } finally { await recoveredJobs.close(); }
  const doneJobs = createJobs(recoveryOpts);
  doneJobs.restore(); await immediate(); await doneJobs.close();
  check(recovered.length === 3, 'completed enhancements are not repeated after restart');

  const eventDir = path.join(root, 'jobs-close-event');
  seed(eventDir, 'job_event', source, null);
  const eventWork = deferred();
  let eventClosing = null, eventStarted = false;
  const eventJobs = createJobs({ ...recoveryOpts, dir: eventDir, postprocessAsync: () => { eventStarted = true; return eventWork.promise; } });
  eventJobs.restore();
  eventJobs.subscribe('job_event', (event) => {
    if (event.type === 'enhancement' && event.enhancement.state === 'running') eventClosing = eventJobs.close();
  });
  eventJobs.enhance('job_event');
  await until(() => eventStarted, 'close from synchronous event subscriber');
  check(eventClosing && fs.existsSync(path.join(eventDir, '.worker.lock')), 'synchronous event-triggered close also waits for registered worker');
  eventWork.resolve(complete(result.enhanced));
  await eventClosing;
  check(eventJobs.get('job_event').enhancement.state === 'done' && !fs.existsSync(path.join(eventDir, '.worker.lock')), 'event-triggered close writes final enhancement before releasing lock');

  const detachDir = path.join(root, 'jobs-detach');
  const detachJobs = createJobs({ ...opts, dir: detachDir });
  const detached = await detachJobs.create({});
  await detachJobs.close();
  check(detachJobs.get(detached.id).state === 'queued' && cancelCalls === 0, 'closing active raw job detaches observation without remote cancellation');
  check(hash(source) === originalHash, 'native source unchanged across all focused tests');
  console.log('Focused checks: ' + passed + ' (CPU fixtures + explicitly SIMULATED backends; no real GPU validation)');
  console.log('全部通过');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  for (const k of envKeys) { if (oldEnv[k] === undefined) delete process.env[k]; else process.env[k] = oldEnv[k]; }
  fs.rmSync(root, { recursive: true, force: true });
});
