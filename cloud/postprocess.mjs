/**
 * cloud/postprocess.mjs —— 云端后处理（复用本地后处理语义，换执行器）
 *
 * 本地版用 RIFE（flownet.pkl + torch）插帧；云端容器不带 torch/权重，改用 ffmpeg minterpolate：
 *   · 效果：24fps → 60fps，运动补偿插帧（mci + aobmc + vsbmc）
 *   · 诚实标注：substitution = "ffmpeg minterpolate（非 RIFE）"，写进任务记录与作品 meta
 *   · 若部署环境自带 RIFE（AVP_RIFE_PY 指向 python + AVP_RIFE_MODEL 指向权重），自动优先用 RIFE
 *
 * 双版本分存（对应验收）：
 *   native   = 上游原始成片（只用于实验打分）
 *   enhanced = 后处理产物（只用于展示）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fail, objects, store, paths } from './core.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const HAS_FFMPEG = (() => {
  try { return spawnSync(FFMPEG, ['-version'], { timeout: 8000 }).status === 0; } catch { return false; }
})();

export function capability() {
  return {
    available: HAS_FFMPEG,
    engine: process.env.AVP_RIFE_PY ? 'rife-torch' : (HAS_FFMPEG ? 'ffmpeg-minterpolate' : 'none'),
    note: HAS_FFMPEG ? null : '容器内未找到 ffmpeg（Dockerfile 已 apk add ffmpeg）',
  };
}

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) fail('UPSTREAM_FAILED', 'ffprobe 读不出媒体信息');
  const j = JSON.parse(r.stdout || '{}');
  const st = (j.streams || [])[0] || {};
  const [a, b = 1] = String(st.avg_frame_rate || '0/1').split('/').map(Number);
  return { width: Number(st.width), height: Number(st.height), fps: b ? a / b : 0, duration: Number((j.format || {}).duration) };
}

/**
 * 取源视频到临时文件。
 * 关键：本地卷后端的 output_url 是相对路径 /files/…，fetch 不能直接吃；
 * 且同进程没必要绕 HTTP —— 有 output_key 时优先直接读对象存储，S3 才走 HTTP。
 */
async function loadSource(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avp-post-'));
  const f = path.join(dir, 'src.mp4');
  let buf = null;
  if (task.output_key && objects.backend === 'local') {
    try { buf = await objects.get(task.output_key); } catch { buf = null; }
  }
  if (!buf) {
    const raw = task.output_url || '';
    if (!raw) fail('BAD_REQUEST', '该任务没有成片地址');
    const url = /^https?:/i.test(raw)
      ? raw
      : (process.env.PUBLIC_BASE || ('http://127.0.0.1:' + (process.env.PORT || 8787))) + raw;
    const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!r.ok) fail('UPSTREAM_FAILED', '下载源视频失败 HTTP ' + r.status + '（' + url + '）');
    buf = Buffer.from(await r.arrayBuffer());
  }
  fs.writeFileSync(f, buf);
  return { file: f, dir };
}

/**
 * 插帧：源 → 目标帧率。
 * @returns { file, native_fps, output_fps, engine, substitution }
 */
export function interp(srcFile, targetFps) {
  if (!HAS_FFGEG_SAFE()) fail('PROVIDER_MISSING', '容器内没有 ffmpeg，无法后处理');
  const info = probe(srcFile);
  if (!info.fps) fail('UPSTREAM_FAILED', '源视频帧率不可读');
  if (targetFps <= info.fps + 0.01) fail('BAD_REQUEST', `目标帧率 ${targetFps} 不高于源 ${info.fps}，后处理不降帧`);

  const useRife = !!process.env.AVP_RIFE_PY;
  // 输出必须写可写目录：实测源目录（云盘成片）与 os.tmpdir() 都可能 EACCES，
  // 统一落到 DATA_DIR/tmp（本地=D盘缓存派生，云端=/data/tmp 持久盘）
  const tmpDir = process.env.POST_TMP || path.join(paths.DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const out = path.join(tmpDir, 'avp-enh-' + Date.now() + '.mp4');

  if (useRife) {
    const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools', 'rife_torch.py');
    const r = spawnSync(process.env.AVP_RIFE_PY, ['-X', 'utf8', script, '--in', srcFile, '--out', out, '--fps', String(targetFps), '--model', process.env.AVP_RIFE_MODEL || ''], { encoding: 'utf8', timeout: 30 * 60 * 1000 });
    const tail = String(r.stdout || '').trim().split('\n').pop() || '';
    if (r.status !== 0 || !fs.existsSync(out)) fail('UPSTREAM_FAILED', 'RIFE 插帧失败: ' + (tail || r.stderr || '').slice(0, 200));
    return { file: out, native_fps: info.fps, output_fps: targetFps, engine: 'rife-torch', substitution: null };
  }

  // ffmpeg minterpolate：运动补偿插帧（质量低于 RIFE，但零权重依赖）
  const args = ['-y', '-v', 'error', '-i', srcFile,
    '-vf', `minterpolate=fps=${targetFps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1,format=yuv420p`,
    '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', out];
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 30 * 60 * 1000 });
  if (r.status !== 0 || !fs.existsSync(out)) fail('UPSTREAM_FAILED', 'ffmpeg 插帧失败: ' + String(r.stderr || '').slice(0, 300));
  const after = probe(out);
  if (Math.abs(after.fps - targetFps) > 0.5) fail('UPSTREAM_FAILED', `插帧后帧率不符（${after.fps}）`);
  return { file: out, native_fps: info.fps, output_fps: after.fps, engine: 'ffmpeg-minterpolate', substitution: 'ffmpeg minterpolate（非 RIFE，快速运动可能有轻微拖影）' };
}

function HAS_FFGEG_SAFE() { return HAS_FFMPEG; }

/**
 * 对一条已完成任务做增强：下载 → 插帧 → 上传 → 记 enhanced 版本 → 入库展示。
 */
export async function enhance(taskId, { targetFps = 60 } = {}) {
  const t = store.getTask(taskId);
  if (!t) fail('NOT_FOUND', '任务不存在: ' + taskId);
  if (t.state !== 'succeeded') fail('STATE_INVALID', `只有 succeeded 的任务能增强（当前 ${t.state}）`);
  if (!t.output_url) fail('BAD_REQUEST', '该任务没有成片地址');
  const target = Number(targetFps);
  if (!(target > 0 && target <= 120)) fail('BAD_REQUEST', '目标帧率需在 (0,120]');

  const { file, dir } = await loadSource(t);
  try {
    // 原生版先入对象存储（若还没存），保证"原生仅供打分、增强仅供展示"两条链都有实体
    let nativeKey = t.output_key;
    if (!nativeKey) {
      const buf = fs.readFileSync(file);
      const put = await objects.put(`videos/${taskId}-native.mp4`, buf, 'video/mp4');
      nativeKey = put.key;
      store.updateTask(taskId, { output_key: nativeKey });
    }
    const r = interp(file, target);
    const buf = fs.readFileSync(r.file);
    const key = `videos/${taskId}-enhanced.mp4`;
    const put = await objects.put(key, buf, 'video/mp4');
    store.addLibrary({
      task_id: taskId,
      title: (t.prompt || '').slice(0, 60) + ' · enhanced',
      provider: t.provider, model: t.model,
      variant: 'enhanced', key, url: put.url, bytes: buf.length,
      meta: { native_fps: r.native_fps, output_fps: r.output_fps, engine: r.engine, substitution: r.substitution, from: taskId },
    });
    return {
      ok: true, taskId, variant: 'enhanced',
      key, url: put.url, bytes: buf.length,
      native_fps: r.native_fps, output_fps: r.output_fps,
      engine: r.engine, substitution: r.substitution,
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
