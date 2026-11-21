/**
 * kf_pipeline.js —— 关键帧两阶段管线（覆盖规格：候选生成 → 自动选优 → 图生视频）
 *
 * 设计要点（对应验收）：
 *   · 阶段一：一次出 N 张候选（默认 4，3–6 可配），种子按 seed_stride 拉开，避免四张雷同
 *   · 阶段二：五维本地打分（keyframe.js），自动选 Top1；用户可改选（pick 覆盖）
 *   · 阶段三：前置校验（非空/可解码/尺寸对齐）通过才上传 ComfyUI 当 first_frame 出片
 *   · 全候选低于阈值 → 自动重生成一轮（max_retry_rounds），仍不行则拒绝进入视频
 *   · 全过程落盘：候选图、每张分项分、选中项、参数、prompt_id —— 可追溯"哪张关键帧进了视频"
 *
 * 生图与视频工作流完全分离：生图走 providers（kolors / sd15），视频走 H3 I2V。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const KF = require('./keyframe.js');
const T2I = require('./t2i.js');
const H3 = require('./h3workflow.js');
const QUALITY = require('./quality.js');

const CLOUD = process.env.CLOUD_ROOT || 'D:\\云盘';
const CACHE = process.env.CACHE_ROOT || 'D:\\缓存';
const KF_DIR = path.join(CLOUD, '04-数据', 'keyframes');
const REC_DIR = path.join(CACHE, 'avp', 'keyframes');
const KOLORS_DIR = process.env.KOLORS_DIR || path.join(CLOUD, '03-文档', 'tools', 'models', 'Kolors');
const KOLORS_PY = process.env.KOLORS_PY || path.join(CLOUD, '01-代码', 'AI视频', 'ComfyUI', '.venv', 'Scripts', 'python.exe');
const KOLORS_SCRIPT = path.join(__dirname, '..', 'tools', 'kolors_t2i.py');

function ensureDirs() {
  fs.mkdirSync(KF_DIR, { recursive: true });
  fs.mkdirSync(REC_DIR, { recursive: true });
}

/* ── 生图后端探测 ─────────────────────────────────────────── */
function kolorsReady() {
  try {
    const cfg = path.join(KOLORS_DIR, 'model_index.json');
    const unet = path.join(KOLORS_DIR, 'unet');
    if (!fs.existsSync(cfg) || !fs.existsSync(unet)) return false;
    // unet 目录里至少要有一个 >1GB 的权重文件，避免半截下载被当成可用
    const big = fs.readdirSync(unet).some((f) => {
      const st = fs.statSync(path.join(unet, f));
      return st.isFile() && st.size > 1e9;
    });
    return big;
  } catch { return false; }
}

function sd15Ready() {
  try {
    const ckpt = path.join(CLOUD, '01-代码', 'AI视频', 'ComfyUI', 'models', 'checkpoints', T2I.DEFAULT_CKPT);
    return fs.existsSync(ckpt) && fs.statSync(ckpt).size > 1.5e9;
  } catch { return false; }
}

function pickProvider(want) {
  const k = kolorsReady();
  const s = sd15Ready();
  if (want === 'kolors') {
    if (!k) throw Object.assign(new Error('Kolors 权重未就绪（' + KOLORS_DIR + '）'), { code: 'KF_T2I_BACKEND_MISSING', status: 503, detail: { provider: 'kolors', hint: 'bash tools/setup_kolors.sh' } });
    return 'kolors';
  }
  if (want === 'sd15') {
    if (!s) throw Object.assign(new Error('SD1.5 权重未就绪'), { code: 'KF_T2I_BACKEND_MISSING', status: 503, detail: { provider: 'sd15', hint: 'bash tools/setup_t2i_model.sh' } });
    return 'sd15';
  }
  if (k) return 'kolors';     // 默认优先中文原生的 Kolors
  if (s) return 'sd15';
  throw Object.assign(new Error('没有可用的生图后端（Kolors / SD1.5 都未安装）'), { code: 'KF_NO_T2I_BACKEND', status: 503, detail: { hint: 'Kolors: bash tools/setup_kolors.sh；SD1.5: bash tools/setup_t2i_model.sh' } });
}

/* ── 候选生成 ─────────────────────────────────────────────── */
function runKolors({ prompt, negative, count, width, height, steps, cfg, seed }) {
  ensureDirs();
  const outDir = path.join(KF_DIR, 'kolors_' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const args = [KOLORS_SCRIPT, '--prompt', prompt, '--count', String(count), '--width', String(width), '--height', String(height),
    '--steps', String(steps), '--cfg', String(cfg), '--out', outDir, '--prefix', 'kf'];
  if (negative) args.push('--negative', negative);
  if (Number.isFinite(Number(seed))) args.push('--seed', String(seed));
  const r = spawnSync(KOLORS_PY, ['-X', 'utf8', ...args], { encoding: 'utf8', timeout: 30 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1', KOLORS_DIR } });
  const stdout = r.stdout || '';
  let parsed = null;
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { parsed = JSON.parse(t); break; } catch { /* 继续找 */ }
  }
  if (!parsed || !parsed.ok) {
    const code = parsed && parsed.error === 'KOLORS_DIR_MISSING' ? 'KF_T2I_BACKEND_MISSING' : 'KF_T2I_FAILED';
    throw Object.assign(new Error('Kolors 生图失败：' + String(r.stderr || stdout || '').slice(-300)), { code, status: 502, detail: { returncode: r.status } });
  }
  return { provider: 'kolors', files: (parsed.images || []).map((x) => x.file), meta: parsed };
}

async function runSd15({ prompt, negative, count, width, height, steps, cfg, seed }) {
  const gen = await T2I.generateCandidates({ prompt, negative, width, height, count, steps, cfg, seed });
  const files = (gen.candidates || []).filter((c) => c.ok).map((c) => c.file);
  if (!files.length) throw Object.assign(new Error('SD1.5 未产出任何候选图'), { code: 'KF_T2I_FAILED', status: 502 });
  return { provider: 'sd15', files, meta: gen };
}

async function generateCandidates(o = {}) {
  const spec = KF.loadSpec();
  const cs = spec.candidates || {};
  const count = Math.max(cs.min || 3, Math.min(cs.max || 6, Number(o.count || cs.default || 4)));
  const stride = cs.seed_stride || 7919;
  const provider = pickProvider(o.provider);
  const pcfg = (spec.providers || {})[provider] || {};
  const width = Number(o.width || pcfg.width || 640);
  const height = Number(o.height || pcfg.height || 384);
  const steps = Number(o.steps || pcfg.steps || 24);
  const cfg = Number(o.cfg || pcfg.cfg || 7);
  const baseSeed = Number.isFinite(Number(o.seed)) && Number(o.seed) >= 0 ? Math.floor(Number(o.seed)) : Math.floor(Math.random() * 1000000);
  const p = String(o.prompt || '').trim();
  if (!p) throw Object.assign(new Error('缺少提示词'), { code: 'KF_NO_PROMPT', status: 422 });
  if (provider === 'sd15' && /[\u4e00-\u9fa5]/.test(p)) {
    throw Object.assign(new Error('SD1.5 的 CLIP 只认英文：请给英文提示词，或安装 Kolors（bash tools/setup_kolors.sh）走中文'), { code: 'KF_NEEDS_ENGLISH', status: 422, detail: { provider } });
  }

  const out = provider === 'kolors'
    ? runKolors({ prompt: p, negative: o.negative, count, width, height, steps, cfg, seed: baseSeed })
    : await runSd15({ prompt: p, negative: o.negative, count, width, height, steps, cfg, seed: baseSeed });

  // 补 seed 信息（SD1.5 的候选带 seed；Kolors 由脚本返回）
  return { provider, count, width, height, steps, cfg, base_seed: baseSeed, files: out.files, meta: out.meta };
}

/* ── 前置校验（不满足就不发 ComfyUI） ──────────────────────── */
function validateFirstFrame(file, { width, height }) {
  const errs = [];
  if (!file) errs.push({ code: 'KF_NO_FIRST_FRAME', message: '首帧路径为空' });
  else if (!fs.existsSync(file)) errs.push({ code: 'KF_FRAME_MISSING', message: '首帧文件不存在：' + file });
  else {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size < 1024) errs.push({ code: 'KF_FRAME_EMPTY', message: '首帧文件为空或过小' });
    // 可解码 + 尺寸
    const ffprobe = String(process.env.AVP_FFPROBE || 'C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/ffprobe.exe');
    const r = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', file], { encoding: 'utf8', timeout: 20000 });
    try {
      const j = JSON.parse(r.stdout || '{}');
      const s = (j.streams || [])[0];
      if (!s) errs.push({ code: 'KF_FRAME_UNDECODABLE', message: '首帧无法解码（不是有效图片）' });
      else {
        const ratio = s.width / s.height;
        const target = width / height;
        if (Math.abs(ratio - target) > 0.02) {
          errs.push({ code: 'KF_ASPECT_MISMATCH', message: `首帧比例 ${s.width}×${s.height} 与视频档位 ${width}×${height} 不一致（差 ${(Math.abs(ratio - target) * 100).toFixed(1)}%）` });
        }
      }
    } catch {
      errs.push({ code: 'KF_FRAME_UNDECODABLE', message: '首帧解码失败' });
    }
  }
  return { ok: errs.length === 0, errors: errs };
}

/* ── 记录读写 ─────────────────────────────────────────────── */
function recPath(id) { return path.join(REC_DIR, id + '.json'); }
function saveRec(rec) {
  ensureDirs();
  rec.updated_at = new Date().toISOString();
  fs.writeFileSync(recPath(rec.id), JSON.stringify(rec, null, 2) + String.fromCharCode(10), 'utf8');
  return rec;
}
function loadRec(id) {
  const p = recPath(id);
  if (!fs.existsSync(p)) throw Object.assign(new Error('关键帧记录不存在：' + id), { code: 'KF_NOT_FOUND', status: 404 });
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/* ── 阶段一二：生成 + 选优（异步：先建记录，再后台跑） ─────────────
 * 为什么必须异步：Kolors 单张 640×832 20 步在 8G 卡上约 3–4 分钟，
 * 3–6 张要 10–20 分钟，同步 HTTP 会被 undici 的 headers 超时掐断（实测 UND_ERR_HEADERS_TIMEOUT）。
 * 所以：createPlan 立即返回 id（status=generating），后台 runPlan 推进状态，前端轮询 GET。
 */
function createPlan(o = {}) {
  const id = 'kf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    created_at: new Date().toISOString(),
    prompt: o.prompt || null,
    negative: o.negative || null,
    provider: null,
    params: { count: o.count || null, width: o.width || null, height: o.height || null },
    status: 'generating',
    stage: 'candidates',
    candidates: [],
    ranked: [],
    selected: null,
    selected_by: null,
    scores: null,
    rounds: [],
    video: null,
  };
  return saveRec(rec);
}

async function runPlan(id, o = {}) {
  const rec0 = loadRec(id);
  const spec = KF.loadSpec();
  const maxRetry = Math.max(0, Number((spec.thresholds || {}).max_retry_rounds ?? 1));
  try {
    let pick = null;
    let gen = null;
    const rounds = [];
    for (let round = 0; round <= maxRetry; round += 1) {
      rec0.stage = round === 0 ? 'candidates' : 'regenerating';
      rec0.round = round;
      saveRec(rec0);
      gen = await generateCandidates({ ...o, seed: o.seed == null ? undefined : Number(o.seed) + round * 1013 });
      rec0.provider = gen.provider;
      rec0.params = { count: gen.count, width: gen.width, height: gen.height, steps: gen.steps, cfg: gen.cfg, base_seed: gen.base_seed };
      rec0.stage = 'scoring';
      saveRec(rec0);
      pick = await KF.pickBest({ files: gen.files, prompt: o.prompt, useQwen: !!o.useQwen });
      rounds.push({ round, provider: gen.provider, files: gen.files.length, best_total: pick.best ? pick.best.total : null, all_rejected: pick.all_rejected });
      if (!pick.all_rejected) break;
    }
    rec0.rounds = rounds;
    rec0.candidates = pick.candidates;
    rec0.ranked = pick.ranked;
    rec0.provenance = pick.provenance;
    rec0.qwen = pick.qwen;
    rec0.all_rejected = pick.all_rejected;
    if (pick.best) {
      rec0.selected = pick.best.file;
      rec0.selected_by = 'auto';
      rec0.scores = pick.best.scores;
      rec0.status = 'selected';
      rec0.stage = 'selected';
    } else {
      rec0.selected = null;
      rec0.status = 'rejected';
      rec0.stage = 'rejected';
      rec0.error = { code: 'KF_ALL_REJECTED', message: '全部候选低于阈值或退化，未进入视频阶段', detail: { rounds } };
    }
    return saveRec(rec0);
  } catch (e) {
    rec0.status = 'failed';
    rec0.stage = 'failed';
    rec0.error = { code: e.code || 'KF_FAILED', message: e.message, detail: e.detail || {} };
    return saveRec(rec0);
  }
}

/** 用户改选 */
function pickCandidate(id, { file, index }) {
  const rec = loadRec(id);
  let target = null;
  if (index != null) target = (rec.candidates || [])[Number(index)] || null;
  if (file) target = (rec.candidates || []).find((c) => c.file === file || c.basename === file) || null;
  if (!target || !target.file) throw Object.assign(new Error('候选不存在'), { code: 'KF_CANDIDATE_NOT_FOUND', status: 404 });
  if (target.degenerate) throw Object.assign(new Error('该候选被判定退化，不能作为首帧'), { code: 'KF_CANDIDATE_REJECTED', status: 422 });
  rec.selected = target.file;
  rec.selected_by = 'user';
  rec.scores = target.scores;
  rec.status = 'selected';
  return saveRec(rec);
}

/* ── 阶段三：图生视频 ─────────────────────────────────────── */
async function makeVideo(id, o = {}) {
  const rec = loadRec(id);
  if (!rec.selected) throw Object.assign(new Error('还没有选定关键帧（候选全部被拒或未生成）'), { code: 'KF_NOT_SELECTED', status: 409 });
  const width = Number(o.width || rec.params.width || 640);
  const height = Number(o.height || rec.params.height || 384);
  const chk = validateFirstFrame(rec.selected, { width, height });
  if (!chk.ok) throw Object.assign(new Error(chk.errors[0].message), { code: chk.errors[0].code, status: 422, detail: { errors: chk.errors } });

  const q = QUALITY.guard({ engine: 'minimax_h3', width, height, frames: H3.snapFrames(Number(o.seconds || 5)).frames, usable_mib: Number(o.usable_mib || 8151), output_fps: Number(o.output_fps || 60) });
  if (!q.ok) throw Object.assign(new Error(q.errors[0].message), { code: q.errors[0].code, status: 422, detail: q.errors[0].detail });

  const up = await H3.uploadImage(rec.selected);
  const built = H3.build({ prompt: String(o.prompt || rec.prompt || ''), width, height, seconds: Number(o.seconds || 5), firstFrameName: up, usable_mib: Number(o.usable_mib || 8151) });
  const sub = await H3.run({ prompt: String(o.prompt || rec.prompt || ''), width, height, seconds: Number(o.seconds || 5), firstFrameName: up, usable_mib: Number(o.usable_mib || 8151) });
  if (!sub.ok) throw Object.assign(new Error('提交 ComfyUI 失败：' + JSON.stringify(sub.error).slice(0, 200)), { code: 'KF_SUBMIT_FAILED', status: 502 });
  rec.video = { prompt_id: sub.prompt_id, first_frame: up, width, height, seconds: Number(o.seconds || 5), submitted_at: new Date().toISOString(), workflow_nodes: Object.keys(built.workflow).length };
  rec.status = 'video_submitted';
  saveRec(rec);
  return { id, prompt_id: sub.prompt_id, first_frame: rec.selected, uploaded_as: up, rec };
}

module.exports = { createPlan, runPlan, pickCandidate, makeVideo, validateFirstFrame, loadRec, saveRec, kolorsReady, sd15Ready, pickProvider, KF_DIR, REC_DIR };
