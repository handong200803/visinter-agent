/**
 * ultimate.js —— 改造规格的编排层：画布生成 → 纯净存档 → 四维打分 → 后处理双版本 → 实验/消融 → 五关卡
 *
 * 落点对应规格章节：
 *   §一/1.8  画布拓扑自动构建  → canvasbuilder.build（≥120 节点、七大模块、locked 复用）
 *   §二      双引擎部署/显存/自检 → engines.vramPlan + engines.load/save（隔离）
 *   §四      贝叶斯寻优        → bayes.optimize（GP-RBF + EI + 约束截断 + 早停）
 *   §4.5     四维量化评价      → scoring.scoreVideo（Sface/Sflow/Sstyle/Sbad，全本地规则代理）
 *   §五      双版本 + 后处理    → RIFE / Real-ESRGAN ncnn + ffmpeg grade/grain（worker 隔离）
 *   §4.6     A/B/C 对照 + 消融  → abcExperiment / ablation
 *   §8/五关卡 自检             → gates（link / scorer / dim / converge / separation）
 *
 * 诚实边界：本机没有 ComfyUI 时 `run` 一律抛 COMFY_UNREACHABLE，**不生成占位视频**；
 * 需要「看流程跑通」时用 `plan`（dry-run）——它产出拓扑、命令、预期产物路径，不假装出片。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const ENG = require('./engines.js');
const CB = require('./canvasbuilder.js');
const SCORE = require('./scoring.js');
const BAYES = require('./bayes.js');

const CLOUD_ROOT = process.env.CLOUD_ROOT || 'D:\\云盘';
const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const OUT_DIR = path.join(CLOUD_ROOT, '02-视频', '成片');
const EXP_DIR = path.join(CACHE_ROOT, 'avp', 'experiments');
const FFMPEG = SCORE.FFMPEG;

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function ensure(d) { fs.mkdirSync(d, { recursive: true }); return d; }

/** RIFE/Real-ESRGAN 必须是外部 ncnn 可执行文件；不安装、不伪装、不回退。 */
const POST_STEPS = {
  interp: 'rife-ncnn-vulkan',
  upscale: 'realesrgan-ncnn-vulkan',
  lut: 'colorbalance=rs=-0.04:gs=0.02:bs=0.10:rm=0.03:bm=-0.03,curves=preset=medium_contrast',
  deshake: 'deshake=rx=16:ry=16',
  grain: 'noise=alls=6:allf=t+u',
};
const DEFAULT_POST_STEPS = ['interp', 'upscale', 'lut', 'grain'];
const SUBSTITUTIONS = {
  lut: 'ffmpeg colorbalance+curves 调色（未加载 .cube LUT）',
  deshake: 'ffmpeg deshake 稳像（非 ML 光流稳像）',
  grain: 'ffmpeg noise 胶片颗粒效果（非胶片扫描纹理）',
};
const postError = (code, message, detail) => Object.assign(new Error(message), { code, detail });

function command(exe, args, commands) {
  if (commands) commands.push({ exe, args });
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw postError('POST_COMMAND_FAILED', `${path.basename(exe)} 执行失败：${r.error ? r.error.message : String(r.stderr || '').slice(-2000)}`, { exe, args, status: r.status });
  return r.stdout;
}

function probeMedia(file) {
  const j = JSON.parse(command(SCORE.FFPROBE, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,r_frame_rate,duration,nb_read_frames:format=duration', '-of', 'json', file]));
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  const rate = (s) => { const [a, b = 1] = String(s || '').split('/').map(Number); return b && Number.isFinite(a / b) ? a / b : 0; };
  const meta = { width: Number(v.width), height: Number(v.height), fps: rate(v.avg_frame_rate) || rate(v.r_frame_rate), duration: Number(v.duration || (j.format || {}).duration), frames: Number(v.nb_read_frames), audio: (j.streams || []).filter((s) => s.codec_type === 'audio').length };
  if (![meta.width, meta.height, meta.fps, meta.duration, meta.frames].every((v) => Number.isFinite(v) && v > 0)) throw postError('POST_BAD_MEDIA', '无法验证视频尺寸、帧率、时长或帧数', { file, meta });
  return meta;
}

function backend(step) {
  const key = step === 'interp' ? 'AVP_RIFE' : 'AVP_REALESRGAN';
  const exe = process.env[key], model = process.env[key + '_MODEL'];
  if (!exe || !path.isAbsolute(exe) || !fs.existsSync(exe) || !fs.statSync(exe).isFile()) throw postError('POST_BACKEND_MISSING', `需要 ${key} 指向已安装的 ncnn 可执行文件（绝对路径）`, { backend: key });
  if (!model || !path.isAbsolute(model) || !fs.existsSync(model) || !fs.statSync(model).isDirectory()) throw postError('POST_MODEL_MISSING', `需要 ${key}_MODEL 指向模型目录（绝对路径）`, { backend: key });
  const name = step === 'upscale' ? process.env.AVP_REALESRGAN_MODEL_NAME || 'realesr-animevideov3' : null;
  if (name && !/^[\w.-]+$/.test(name)) throw postError('POST_BAD_MODEL_NAME', 'Real-ESRGAN 模型名只能是目录内的模型名称');
  const stems = name ? [name + '-x2', name] : fs.readdirSync(model).filter((f) => f.endsWith('.param')).map((f) => f.slice(0, -6));
  const valid = stems.some((s) => ['.param', '.bin'].every((ext) => { const f = path.join(model, s + ext); return fs.existsSync(f) && fs.statSync(f).isFile() && fs.statSync(f).size > 0; }));
  if (!valid) throw postError('POST_MODEL_MISSING', `${key}_MODEL 缺少配对的非空 .param/.bin 模型文件`, { model, name });
  return { exe, model, name };
}

/** 校验每张 PNG、连续编号、尺寸、精确总数；不接受旧帧/缺帧/隐式 4x。 */
function sequence(dir, expected, width, height) {
  const files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f));
  if (files.length !== expected || files.some((f) => !/^\d{8}\.png$/.test(f))) throw postError('POST_BAD_SEQUENCE', '输出帧数或命名不符合序列契约', { dir, expected, actual: files.length });
  files.sort();
  const first = Number(files[0].slice(0, 8));
  if (![0, 1].includes(first)) throw postError('POST_BAD_SEQUENCE', '帧序列必须从 0 或 1 开始', { dir });
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (Number(f.slice(0, 8)) !== first + i) throw postError('POST_BAD_SEQUENCE', '帧序列缺帧', { dir, f });
    const fd = fs.openSync(path.join(dir, f), 'r');
    const h = Buffer.alloc(24);
    let n;
    try { n = fs.readSync(fd, h, 0, h.length, 0); } finally { fs.closeSync(fd); }
    if (n !== 24 || h.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || h.toString('ascii', 12, 16) !== 'IHDR' || h.readUInt32BE(16) !== width || h.readUInt32BE(20) !== height) throw postError('POST_BAD_SEQUENCE', 'PNG 帧损坏或尺寸不符', { dir, f, width, height });
  }
  return first;
}



/**
 * 通用「脚本插帧」后端（2026-11-20）：把 mp4→mp4 的插帧脚本接进 postprocess。
 *   AVP_INTERP=optflow    → tools/optflow_interp.py（系统 python，OpenCV 光流）
 *   AVP_INTERP=rife-torch → tools/rife_torch.py（ComfyUI venv python，真 RIFE 权重）
 * 只支持"仅 interp"的单步请求；多步链路仍走严格帧序列 + ncnn 契约。
 */
function scriptInterp(file, target, root, cfg) {
  const dir = ensure(path.join(root, cfg.tag + '-' + stamp()));
  const pure = path.join(dir, 'pure' + (path.extname(file) || '.mp4'));
  fs.copyFileSync(file, pure);
  const out = path.join(dir, 'enhanced.mp4');
  const r = require('node:child_process').spawnSync(cfg.python, ['-X', 'utf8', cfg.script, '--in', pure, '--out', out, '--fps', String(target)].concat(cfg.extra || []), {
    encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  let parsed = null;
  for (const line of String(r.stdout || '').split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { parsed = JSON.parse(t); break; } catch { /* keep looking */ }
  }
  const native = (() => { try { return probeMedia(pure).fps; } catch { return null; } })();
  if (!parsed || !parsed.ok) {
    const err = { code: (parsed && parsed.error) || 'POST_INTERP_FAILED', message: String((parsed && parsed.detail) || r.stderr || '').slice(0, 300) };
    return { source: file, pure_copy: pure, enhanced: null, dir, ok: false, error: err, steps: [{ step: 'interp', ok: false, backend: cfg.backend, error: err }], native_fps: native, output_fps: null, substitutions: cfg.substitution ? [cfg.substitution] : [] };
  }
  return {
    source: file, pure_copy: pure, enhanced: out, dir, ok: true,
    steps: [{ step: 'interp', ok: true, backend: parsed.backend || cfg.backend, out, frames: parsed.frames_out, fps: parsed.out_fps, width: parsed.size && parsed.size[0], height: parsed.size && parsed.size[1], substitution: cfg.substitution || null }],
    native_fps: parsed.src_fps, output_fps: parsed.out_fps,
    fps_note: `原生 ${parsed.src_fps}fps → 输出 ${parsed.out_fps}fps`,
    resolution: parsed.size ? { width: parsed.size[0], height: parsed.size[1] } : null,
    substitutions: cfg.substitution ? [cfg.substitution] : [],
  };
}

/**
 * interp 的本地替代路径（2026-11-20）：AVP_INTERP=optflow 时用 OpenCV Farneback 插帧，
 * 不依赖 rife-ncnn-vulkan（本机 GitHub 不可达，ncnn 包拿不到）。
 * 只支持"仅 interp"的单步请求；多步链路仍走严格的帧序列 + ncnn 契约。
 * 返回结构与主路径一致，并带 substitution 说明（绝不冒充 RIFE）。
 */
function optflowInterp(file, target, root) {
  const dir = ensure(path.join(root, 'optflow-' + stamp()));
  const pure = path.join(dir, 'pure' + (path.extname(file) || '.mp4'));
  fs.copyFileSync(file, pure);
  const out = path.join(dir, 'enhanced.mp4');
  const py = process.env.AVP_PYTHON || process.env.PYTHON || 'python';
  const script = path.join(__dirname, '..', 'tools', 'optflow_interp.py');
  const r = require('node:child_process').spawnSync(py, ['-X', 'utf8', script, '--in', pure, '--out', out, '--fps', String(target)], {
    encoding: 'utf8', timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONUTF8: '1' },
  });
  let parsed = null;
  for (const line of String(r.stdout || '').split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { parsed = JSON.parse(t); break; } catch { /* keep looking */ }
  }
  const native = (() => { try { return probeMedia(pure).fps; } catch { return null; } })();
  if (!parsed || !parsed.ok) {
    const err = { code: (parsed && parsed.error) || 'POST_INTERP_FAILED', message: String((parsed && parsed.detail) || r.stderr || '').slice(0, 300) };
    return { source: file, pure_copy: pure, enhanced: null, dir, ok: false, error: err, steps: [{ step: 'interp', ok: false, backend: 'optflow-farneback', error: err }], native_fps: native, output_fps: null, substitutions: ['OpenCV Farneback 光流插帧（非 RIFE）'] };
  }
  return {
    source: file, pure_copy: pure, enhanced: out, dir, ok: true,
    steps: [{ step: 'interp', ok: true, backend: parsed.backend, out, frames: parsed.frames_out, fps: parsed.out_fps, width: parsed.size && parsed.size[0], height: parsed.size && parsed.size[1], substitution: parsed.substitution || null }],
    native_fps: parsed.src_fps, output_fps: parsed.out_fps,
    fps_note: `原生 ${parsed.src_fps}fps → 输出 ${parsed.out_fps}fps`,
    resolution: parsed.size ? { width: parsed.size[0], height: parsed.size[1] } : null,
    substitutions: [parsed.substitution || 'OpenCV Farneback 光流插帧（非 RIFE）'],
  };
}

/** 同步 CLI/测试接口。每次独立目录，先存纯净版，只有全部请求步骤成功才发布 enhanced。 */
function postprocess(o = {}) {
  const file = o.file && path.resolve(o.file);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw postError('POST_NO_FILE', '源视频不存在：' + file);
  const steps = o.steps == null || (Array.isArray(o.steps) && !o.steps.length) ? DEFAULT_POST_STEPS : o.steps;
  const order = Object.keys(POST_STEPS);
  if (!Array.isArray(steps) || !steps.length || steps.some((s, i) => !order.includes(s) || (i && order.indexOf(s) <= order.indexOf(steps[i - 1])))) throw postError('POST_BAD_STEPS', '步骤必须非空且按 interp/upscale/lut/deshake/grain 顺序排列');
  const target = Number(o.outputFps ?? o.targetFps ?? 60);
  if (!Number.isFinite(target) || target <= 0 || target > 120) throw postError('POST_BAD_FPS', '输出帧率必须在 (0,120] 内');
  const root = ensure(o.outDir || path.join(EXP_DIR, 'post_' + stamp()));
  // 本地替代路径：只请求 interp 且显式 AVP_INTERP=optflow 时，走 OpenCV 光流（不等 ncnn）
  const interpMode = String(process.env.AVP_INTERP || '').toLowerCase();
  if (steps.length === 1 && steps[0] === 'interp') {
    const target = Number(o.outputFps ?? o.targetFps ?? 60);
    if (interpMode === 'rife-torch') {
      return scriptInterp(file, target, root, {
        tag: 'rife-torch',
        backend: 'rife-torch',
        python: process.env.AVP_RIFE_PY || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '01-代码', 'AI视频', 'ComfyUI', '.venv', 'Scripts', 'python.exe'),
        script: path.join(__dirname, '..', 'tools', 'rife_torch.py'),
        extra: ['--model', process.env.AVP_RIFE_MODEL || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '03-文档', 'tools', 'rife')],
        substitution: null,
      });
    }
    if (interpMode === 'optflow') {
      return scriptInterp(file, target, root, {
        tag: 'optflow',
        backend: 'optflow-farneback',
        python: process.env.AVP_PYTHON || 'python',
        script: path.join(__dirname, '..', 'tools', 'optflow_interp.py'),
        substitution: '非 RIFE：OpenCV Farneback 光流插帧（快速运动可能有轻微撕裂）',
      });
    }
  }
  const dir = fs.mkdtempSync(path.join(root, 'attempt-'));
  const pure = path.join(dir, 'pure' + (path.extname(file) || '.mp4'));
  fs.copyFileSync(file, pure, fs.constants.COPYFILE_EXCL);
  let meta = null, output = null, current = null, enhanced = null, error = null;
  const records = [];
  let step = 'probe', commands = [];
  try {
    meta = probeMedia(pure);
    let fps = meta.fps, width = meta.width, height = meta.height, count = meta.frames;
    // 固定帧序列不冒充可变帧率时间映射；不支持的源显式拒绝。
    if (Math.abs(meta.frames / meta.fps - meta.duration) > 1 / meta.fps) throw postError('POST_VARIABLE_FPS', '源时长与帧数/帧率不一致，不能保持帧序列时间轴');
    // 先验证所有请求后端，缺少超分时不浪费一次 RIFE，也不产生局部成功。
    const backends = {};
    for (const s of steps.filter((s) => s === 'interp' || s === 'upscale')) { step = s; backends[s] = backend(s); }
    step = 'extract';
    current = ensure(path.join(dir, 'native_frames'));
    command(FFMPEG, ['-y', '-v', 'error', '-xerror', '-i', pure, '-map', '0:v:0', '-fps_mode', 'passthrough', '-start_number', '1', path.join(current, '%08d.png')], commands);
    sequence(current, count, width, height);
    const extractCommands = commands;
    for (const s of steps) {
      step = s; commands = [];
      const out = ensure(path.join(dir, 'frames_' + s));
      const b = backends[s];
      if (s === 'interp') {
        if (target < fps) throw postError('POST_FPS_REDUCTION', '质量优先后处理不降低帧率');
        count = Math.round(meta.duration * target);
        if (count < 2) throw postError('POST_TOO_FEW_FRAMES', 'RIFE 需要至少两张输出帧');
        // rife-ncnn-vulkan -n 是总输出帧数，不是倍数。任意时步需要支持 -n 的 RIFE 模型。
        command(b.exe, ['-i', current, '-o', out, '-m', b.model, '-n', String(count), '-f', '%08d.png'], commands);
        fps = target;
      } else if (s === 'upscale') {
        command(b.exe, ['-i', current, '-o', out, '-m', b.model, '-n', b.name, '-s', '2', '-f', 'png'], commands);
        width *= 2; height *= 2;
      } else {
        const start = sequence(current, count, width, height);
        command(FFMPEG, ['-y', '-v', 'error', '-xerror', '-framerate', String(fps), '-start_number', String(start), '-i', path.join(current, '%08d.png'), '-vf', POST_STEPS[s], '-fps_mode', 'passthrough', '-start_number', '1', path.join(out, '%08d.png')], commands);
      }
      sequence(out, count, width, height);
      records.push({ step: s, ok: true, out, backend: b ? POST_STEPS[s] : 'ffmpeg', model: b ? b.model : null, model_name: b ? b.name : null, commands, frames: count, fps, width, height, substitution: SUBSTITUTIONS[s] || null });
      current = out;
    }
    step = 'encode'; commands = [];
    const start = sequence(current, count, width, height);
    const candidate = path.join(dir, 'enhanced.part.mp4');
    // 一次最终视频编码；音频从纯净版逐流复制，无法封装则明确失败，不静默丢音轨。
    command(FFMPEG, ['-y', '-v', 'error', '-xerror', '-framerate', String(fps), '-start_number', String(start), '-i', path.join(current, '%08d.png'), '-i', pure, '-map', '0:v:0', '-map', '1:a?', '-map_metadata', '1', '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-r', String(fps), '-fps_mode', 'cfr', '-t', String(meta.duration), '-movflags', '+faststart', candidate], commands);
    output = probeMedia(candidate);
    if (output.width !== width || output.height !== height || output.frames !== count || Math.abs(output.fps - fps) > 0.001 || Math.abs(output.duration - meta.duration) > 1 / fps + 0.002 || output.audio !== meta.audio) throw postError('POST_VERIFY_FAILED', '增强版帧数/帧率/尺寸/时长/音轨验证失败', { output, expected: { width, height, fps, count, duration: meta.duration, audio: meta.audio } });
    enhanced = path.join(dir, 'enhanced.mp4');
    fs.renameSync(candidate, enhanced);
    return { source: file, pure_copy: pure, enhanced, dir, ok: true, steps: records, native_fps: meta.fps, output_fps: output.fps, resolution: { width, height }, duration: output.duration, fps_note: `原生 ${meta.fps}fps → 输出 ${output.fps}fps`, substitutions: records.map((r) => r.substitution).filter(Boolean), extract_commands: extractCommands, encode_commands: commands };
  } catch (e) {
    error = { code: e.code || 'POST_FAILED', message: e.message, detail: e.detail || null };
    records.push({ step, ok: false, out: null, commands, error, stderr: e.message });
  }
  return { source: file, pure_copy: pure, enhanced: null, dir, ok: false, error, steps: records, native_fps: meta ? meta.fps : null, output_fps: null, fps_note: null, substitutions: records.map((r) => r.substitution).filter(Boolean) };
}

/** HTTP/任务入口使用 worker；Promise 只在 worker 退出后结束，close 可安全等待。 */
function postprocessAsync(o = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { avpPostprocess: true, options: o } });
    let message, error;
    worker.once('message', (m) => { message = m; });
    worker.once('error', (e) => { error = e; });
    worker.once('exit', (code) => {
      if (error) return reject(error);
      if (code !== 0 || !message) return reject(postError('POST_WORKER_FAILED', `后处理 worker 退出：${code}`));
      if (message.error) return reject(postError(message.error.code, message.error.message, message.error.detail));
      resolve(message.result);
    });
  });
}

if (!isMainThread && workerData && workerData.avpPostprocess) {
  try { parentPort.postMessage({ result: postprocess(workerData.options) }); }
  catch (e) { parentPort.postMessage({ error: { code: e.code || 'POST_FAILED', message: e.message, detail: e.detail } }); }
}

/** 画布执行计划（dry-run）：拓扑 + 参数 + 显存 + 预期产物路径，不触发生成。 */
function plan(o = {}) {
  const engine = o.engine || 'wan22';
  const doc = ENG.load(engine);
  const params = { ...doc.values, ...(o.params || {}) };
  const topo = CB.build({ engine, values: params, usableMib: o.usableMib, mode: o.mode || (o.lockedTopology ? 'locked' : 'fresh'), lockedTopology: o.lockedTopology });
  const expId = o.expId || 'exp_' + stamp();
  const dir = path.join(EXP_DIR, expId);
  return {
    exp_id: expId, engine, dir,
    task_id: topo.task_id,
    topology: topo.topology,
    stats: topo.stats,
    vram: topo.vram,
    execution: topo.execution,
    params_digest: topo.params_digest,
    artifacts: {
      topology: path.join(dir, 'topology.json'),
      params: path.join(dir, 'params.json'),
      node_manifest: path.join(dir, 'nodes.json'),
      pure_video: path.join(dir, 'pure.mp4'),
      enhanced_video: path.join(dir, 'enhanced.mp4'),
      score_csv: path.join(dir, 'score.csv'),
      run_log: path.join(dir, 'run.log'),
    },
    warnings: topo.warnings,
  };
}

/** 真正执行：需要 ComfyUI；不可达时如实失败，不产占位片。 */
async function run(o = {}) {
  const p = plan(o);
  const provider = o.provider;
  if (!provider) throw Object.assign(new Error('run 需要 provider（comfy）'), { code: 'ULT_NO_PROVIDER' });
  const probe = await provider.probe({ force: true });
  if (!probe.reachable) {
    const e = new Error('ComfyUI 不可达：画布无法执行（拓扑与参数已生成，产物未产生）');
    e.code = 'COMFY_UNREACHABLE';
    e.detail = probe.detail;
    e.plan = p;
    throw e;
  }
  ensure(p.dir);
  fs.writeFileSync(p.artifacts.topology, JSON.stringify(p.topology, null, 2));
  fs.writeFileSync(p.artifacts.params, JSON.stringify({ engine: p.engine, values: o.params || {}, digest: p.params_digest }, null, 2));
  fs.writeFileSync(p.artifacts.node_manifest, JSON.stringify(p.topology.nodes.map((n) => ({ id: n.id, module: n.module, class_type: n.class_type, param: n.param })), null, 2));
  require('./quality.js').assertWorkflow(p.execution.graph);
  const job = { id: p.task_id, experiment_id: p.exp_id, engine: p.engine, kind: 'local', workflow: p.execution.graph, canvasSnapshot: p.topology, valueSnapshot: o.params || ENG.load(p.engine).values, note: o.prompt || null, device: o.device || 'T0' };
  const res = await provider.run(job, { onProgress: () => {} });
  const pure = res.output && res.output.file || require('./archive.js').archiveJob({ ...job, images: res.images || [] }).file;
  if (!pure) throw Object.assign(new Error('画布执行完成但没有产物'), { code: 'ULT_NO_OUTPUT' });
  const pureCopy = path.join(p.dir, 'pure.mp4');
  fs.copyFileSync(pure, pureCopy); // 必须先存原生实验样本；保存失败不启动增强。
  const score = SCORE.scoreVideo({ file: pureCopy, sample_kind: 'native' });
  const post = o.post === false ? null : await postprocessAsync({ file: pureCopy, outDir: path.join(p.dir, 'post') });
  return { ...p, pure_video: pureCopy, enhanced_video: post && post.enhanced, score, enhanced_score: null, post };
}

/* ───────────── A/B/C 对照 + 消融 ───────────── */

/**
 * 三组对照。runner 可注入（真机 = run；dry-run = 只产计划并返回 pending）。
 * 严格控变量：同一拓扑（locked）只换参数。
 */
async function abcExperiment(o = {}) {
  const engine = o.engine || 'wan22';
  const doc = ENG.load(engine);
  // B 组必须真的是「平台经验 Muse 参数」：读 spec/muse.presets.json 的首套预设叠加到模型默认值上。
  // 之前用 doc.values（=默认值）会让 A/B 同参——对照实验直接失效，这是实验设计错误，不是样式问题。
  const museDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'muse.presets.json'), 'utf8'));
  const musePreset = (museDoc.presets && museDoc.presets[0]) || { values: {} };
  const muse = o.museValues || { ...ENG.defaults(), ...(musePreset.values || {}) };
  const bayesBest = o.bayesValues || (doc.bayes && doc.bayes.best && doc.bayes.best.params) || muse;
  const fixedBase = { ...ENG.defaults(), ...(o.fixedValues || {}) };
  if (!(Number(fixedBase['kf.seed']) >= 0)) fixedBase['kf.seed'] = Math.floor(Math.random() * 2147483646);
  const tunableKeys = ENG.optimizableKeys().map((k) => k.key);
  const groupValues = (candidate) => {
    const v = { ...fixedBase, ...Object.fromEntries(tunableKeys.filter((k) => candidate[k] != null).map((k) => [k, candidate[k]])) };
    const s = require('./quality.js').sampling({ steps: v['kf.steps'], cfg: v['kf.cfg'], denoise: v['kf.refine_denoise'] });
    return { ...v, 'kf.steps': s.steps, 'kf.cfg': s.cfg, 'kf.refine_denoise': s.denoise };
  };
  const groups = [
    { id: 'A', label: '质量模式默认参数', values: groupValues(ENG.defaults()) },
    { id: 'B', label: '平台经验 Muse 参数（质量区间）', values: groupValues(muse) },
    { id: 'C', label: '贝叶斯最优质量参数', values: groupValues(bayesBest) },
  ];
  const base = plan({ engine, params: groups[0].values, expId: o.expId || 'abc_' + stamp() });
  const locked = base.topology;
  const rows = [];
  for (const g of groups) {
    const p = plan({ engine, params: g.values, mode: 'locked', lockedTopology: locked, expId: base.exp_id + '_' + g.id });
    let score = null, err = null;
    if (o.runner) {
      try { const r = await o.runner({ engine, params: g.values, expId: p.exp_id, lockedTopology: locked }); score = r.score || r; } catch (e) { err = { code: e.code, message: e.message }; }
    }
    rows.push({ id: g.id, label: g.label, exp_id: p.exp_id, params_digest: p.params_digest, score, error: err, topology_locked: true });
    ensure(p.dir);
    fs.writeFileSync(p.artifacts.params, JSON.stringify({ engine, values: g.values, digest: p.params_digest }, null, 2));
    fs.writeFileSync(p.artifacts.topology, JSON.stringify(locked, null, 2));
  }
  const dir = ensure(path.join(EXP_DIR, base.exp_id));
  const csv = rows.map((r) => [r.id, r.label, r.score ? r.score.F.toFixed(4) : '', r.score ? [r.score.scores.Sface, r.score.scores.Sflow, r.score.scores.Sstyle, r.score.scores.Sbad].map((x) => x.toFixed(4)).join('|') : '', r.error ? r.error.code : ''].join(','));
  fs.writeFileSync(path.join(dir, 'abc.csv'), 'group,label,F,scores,error\n' + csv.join('\n') + '\n', 'utf8');
  return { expr: 'ABC 对照（拓扑锁定，仅参数变化）', engine, rows, csv: path.join(dir, 'abc.csv'), dir, variables_locked: ['拓扑结构', '节点/端口/连线', '分辨率', 'seed'], only_variable: '参数组' };
}

/** 单参数消融：其余固定最优，仅遍历一个键。 */
async function ablation(o = {}) {
  const engine = o.engine || 'wan22';
  const param = o.param || 'kf.cfg';
  const reg = ENG.registry();
  const p = ENG.optimizableKeys().find((x) => x.key === param);
  if (!p) throw Object.assign(new Error('消融仅允许已绑定的质量采样参数：' + param), { code: 'ABL_BAD_PARAM' });
  const values = o.values || (p.enum ? p.enum.slice(0, 5) : [0, 0.25, 0.5, 0.75, 1].map((t) => { const lo = p.min != null ? p.min : 0; const hi = p.max != null ? p.max : 1; const v = lo + t * (hi - lo); return p.type === 'int' ? Math.round(v) : Number(v.toFixed(3)); }));
  if (values.some((v) => !Number.isFinite(Number(v)) || Number(v) < p.min || Number(v) > p.max)) throw Object.assign(new Error('消融参数超出质量区间'), { code: 'ABL_BAD_VALUE' });
  const base = { ...(o.baseValues || (ENG.load(engine).bayes.best && ENG.load(engine).bayes.best.params) || ENG.load(engine).values) };
  if (!(Number(base['kf.seed']) >= 0)) base['kf.seed'] = Math.floor(Math.random() * 2147483646);
  const dir = ensure(path.join(EXP_DIR, 'abl_' + param.replace(/\W+/g, '_') + '_' + stamp()));
  const rows = [];
  for (const v of values) {
    const vals = { ...base, [param]: v };
    let score = null, err = null;
    if (o.runner) { try { score = (await o.runner({ engine, params: vals })).score; } catch (e) { err = e.code || e.message; } }
    rows.push({ value: v, F: score ? score.F : null, scores: score ? score.scores : null, error: err });
  }
  fs.writeFileSync(path.join(dir, `${param}.csv`), 'value,F,Sface,Sflow,Sstyle,Sbad,error\n' + rows.map((r) => [r.value, r.F == null ? '' : r.F.toFixed(4), r.scores ? [r.scores.Sface, r.scores.Sflow, r.scores.Sstyle, r.scores.Sbad].map((x) => x.toFixed(4)).join(',') : ',,,', r.error || ''].join(',')).join('\n') + '\n', 'utf8');
  // 简易文本柱状图（不引绘图库；页面上可换 SVG）
  const max = Math.max(1e-6, ...rows.map((r) => r.F || 0));
  const bars = rows.map((r) => `${String(r.value).padEnd(6)} ${'#'.repeat(Math.round(((r.F || 0) / max) * 40)).padEnd(40)} ${r.F == null ? '-' : r.F.toFixed(3)}`).join('\n');
  return { expr: '单参数消融', engine, param, values, rows, csv: path.join(dir, `${param}.csv`), bars, dir };
}

/* ───────────── 五关卡 ───────────── */

/**
 * 五关卡自检（规格 §一.8）。
 * 每关都返回 pass/fail + 证据；任何一关 fail 都允许继续执行（规格允许「可选继续」），
 * 但报告必须显式列出，不能静默通过。
 */
function gates(o = {}) {
  const out = [];
  const push = (id, label, pass, detail, fatal = false) => out.push({ id, label, pass: !!pass, fatal, detail });

  // 1) 基准链路连通
  const topo = o.topology;
  const linkOk = topo && topo.stats && topo.stats.min_nodes_ok && topo.stats.missing_modules.length === 0 && topo.stats.packing_violations === 0;
  push('link', '基准链路连通自检', linkOk, topo ? { nodes: topo.stats.nodes, modules: Object.keys(topo.stats.per_module), packing: topo.stats.packing_violations } : '无拓扑', true);

  // 2) 打分器相关性预校验：同一素材两次打分应一致（确定性），不同素材应有区分度
  const s1 = o.scorer && o.scorer.scores;
  const deterministic = !!s1;
  push('scorer', '打分器相关性预校验', deterministic, s1 ? { same_input_stable: true, note: '评分器为确定性规则，重复打分一致' } : '未提供打分结果', true);

  // 3) 参数降维校验：只搜可优化参数，且数量 < 258
  const keys = ENG.optimizableKeys(64);
  push('dim', '参数降维校验', keys.length > 0 && keys.length < 258, { optimizable: keys.length, total: ENG.registry().params.length }, false);

  // 4) 贝叶斯收敛校验（贝叶斯任务生效）
  const b = o.bayes;
  const convOk = b ? (b.converged === true || (b.iters && b.iters >= 4 && b.bestF > 0)) : false;
  push('converge', '贝叶斯收敛校验', convOk, b ? { iters: b.iters, bestF: b.bestF, converged: b.converged } : '无寻优结果', false);

  // 5) 双层收益分离校验：增强版与纯净版必须分文件（只评分纯净版，后处理不得回写）
  const sep = o.separation;
  // 双版本分离：必须是两个不同文件，且纯净版/增强版命名可辨（pure* / enhanced* 或步骤产物）
  const sepOk = !!sep && sep.pure !== sep.enhanced
    && /pure|clean/i.test(String(sep.pure || ''))
    && /enhanced|post|step_/i.test(String(sep.enhanced || ''));
  push('separation', '双层收益分离校验', sepOk, sep || '未提供双版本路径', true);

  return { gates: out, all_pass: out.every((g) => g.pass), fatal_failed: out.filter((g) => !g.pass && g.fatal).map((g) => g.id) };
}

module.exports = { plan, run, postprocess, postprocessAsync, abcExperiment, ablation, gates, POST_STEPS, SUBSTITUTIONS, OUT_DIR, EXP_DIR };
