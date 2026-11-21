'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Q = require('./quality.js');
const TEMPLATE = path.join(__dirname, '..', 'templates', 'h3_t2v_min.json');
const BASE = process.env.COMFY_URL || 'http://127.0.0.1:8188';

function estimateRisk({ width, height, frames, usableMib }) {
  const required = Q.vramNeedMib(width, height, frames);
  const usable = Number(usableMib) || null;
  const level = !usable ? 'unknown' : required > usable ? 'high' : 'low';
  return { level, mp: width * height / 1e6, frames, usable_mib: usable, required_mib: required, provenance: 'estimate', reason: `${width}×${height} / ${frames}帧预估需要 ${required}MiB；不自动降质` };
}

function snapFrames(seconds) {
  const raw = Math.round(Number(seconds) * 24);
  if (!Number.isFinite(raw)) throw Object.assign(new Error('时长必须为有限数值'), { code: 'QUALITY_BAD_FRAMES', status: 422 });
  const k = Math.max(7, Math.min(21, Math.round((raw - 5) / 17)));
  return { frames: 17 * k + 5, seconds: +((17 * k + 5) / 24).toFixed(3), k };
}
function baseTemplate() { return JSON.parse(fs.readFileSync(TEMPLATE, 'utf8')); }


/** 把本地图片放到 ComfyUI 的 input 目录，返回 LoadImage 可用的文件名（同机零拷贝成本）。 */

/**
 * 通过 ComfyUI 的 /upload/image 上传图片（走上传接口而不是写 input 目录）。
 * 原因：进程可能没有 D:\云盘\...\ComfyUI\input 的写权限（沙箱/ACL 会 EPERM），
 * HTTP 上传由 ComfyUI 自己落盘，绕开文件权限问题。
 */
async function uploadImage(localPath) {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  if (!localPath || !fs2.existsSync(localPath)) throw Object.assign(new Error('首帧图片不存在：' + localPath), { code: 'H3_NO_FIRST_FRAME', status: 422 });
  const buf = fs2.readFileSync(localPath);
  const form = new FormData();
  form.append('image', new Blob([buf]), path2.basename(localPath) || 'frame.png');
  form.append('overwrite', 'true');
  const r = await fetch(BASE + '/upload/image', { method: 'POST', body: form });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error('首帧上传失败：' + String(text).slice(0, 200)), { code: 'H3_UPLOAD_FAILED', status: 502, detail: { status: r.status } });
  let j = {};
  try { j = JSON.parse(text); } catch { /* 有些版本返回空体 */ }
  const name = j.name || (j.subfolder ? `${j.subfolder}/${j.name}` : null) || path2.basename(localPath);
  return name;
}

function stageImage(localPath) {
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  const inputDir = process.env.COMFY_INPUT_DIR || path2.join(process.env.COMFY_HOME || 'D:\\云盘\\01-代码\\AI视频\\ComfyUI', 'input');
  if (!localPath || !fs2.existsSync(localPath)) throw Object.assign(new Error('首帧图片不存在：' + localPath), { code: 'H3_NO_FIRST_FRAME', status: 422 });
  fs2.mkdirSync(inputDir, { recursive: true });
  const name = 'avp_frame_' + Date.now() + (path2.extname(localPath) || '.png').toLowerCase();
  fs2.copyFileSync(localPath, path2.join(inputDir, name));
  return name;
}

function build(o = {}) {
  const frames = o.frames == null ? snapFrames(o.seconds ?? 5).frames : Number(o.frames);
  if (!Number.isInteger(frames) || frames < 124 || frames > 362 || (frames - 5) % 17 !== 0) throw Object.assign(new Error('H3 帧数必须在124–362且符合17k+5，不自动减少帧数'), { code: 'H3_FRAME_GRID', status: 422 });
  const quality = Q.guard({ ...o, engine: 'minimax_h3', frames, usable_mib: o.usableMib, native_fps: o.native_fps ?? o.fps });
  Q.assertAllowed(quality);
  const wf = baseTemplate();
  const { width, height } = quality.resolution;
  const render = quality.render_resolution;
  const samp = quality.sampling;
  const rawSeed = Number(o.seed);
  const seed = Number.isFinite(rawSeed) && rawSeed >= 0 ? Math.floor(rawSeed) : Math.floor(Math.random() * 2147483646);
  if (process.env.AVP_H3_UNET) wf['1'].inputs.unet_name = process.env.AVP_H3_UNET;
  if (process.env.AVP_H3_CLIP) wf['4'].inputs.clip_name = process.env.AVP_H3_CLIP;
  // turbo 路径（2026-11-20 恢复）：turbo LoRA 是为 4–8 步设计的蒸馏权重，
  // 4 步是"正确用法"而不是"偷工减料"；无损路径（16–25 步）在本机 8G 上要 20–25 分钟，
  // 无法满足"5 秒视频 10 分钟内"的硬指标。两种路径都保留，由调用方选并记录 provenance。
  const useTurbo = o.turbo === true;
  if (!useTurbo) {
    delete wf['3'];
  }
  // 首帧 / 尾帧驱动（2026-11-20）：H3 的 MiniMaxH3ImageToVideo 支持可选 first_frame/last_frame。
  // 给它一张好图，模型只负责"让画面动起来"，质量远高于纯文生视频从零想象主体。
  if (o.firstFrame || o.firstFrameName) {
    const name = o.firstFrameName || stageImage(o.firstFrame);
    wf['20'] = { class_type: 'LoadImage', inputs: { image: name } };
    wf['7'].inputs.first_frame = ['20', 0];
  }
  if (o.lastFrame || o.lastFrameName) {
    const name2 = o.lastFrameName || stageImage(o.lastFrame);
    wf['21'] = { class_type: 'LoadImage', inputs: { image: name2 } };
    wf['7'].inputs.last_frame = ['21', 0];
  }
  Object.assign(wf['7'].inputs, { width: render.width, height: render.height, length: frames, prompt: String(o.prompt || '') });
  if (o.negative != null) wf['8'].inputs.text = String(o.negative);
  Object.assign(wf['9'].inputs, { model: useTurbo ? ['3', 0] : ['2', 0], steps: samp.steps, cfg: samp.cfg, seed, sampler_name: samp.sampler, scheduler: samp.scheduler, denoise: samp.denoise });
  if (o.shiftVideo != null) wf['2'].inputs.shift_video = Number(o.shiftVideo);
  if (o.shiftAudio != null) wf['2'].inputs.shift_audio = Number(o.shiftAudio);
  if (o.audio === false) { delete wf['11']; delete wf['12'].inputs.audio; }
  wf['12'].inputs.fps = quality.fps.native_fps;
  if (render.crop) {
    wf['14'] = { class_type: 'ImageCrop', inputs: { image: ['10', 0], width, height, x: 0, y: 0 } };
    wf['12'].inputs.images = ['14', 0];
  }
  wf['13'].inputs.filename_prefix = String(o.prefix || 'h3/t2v');
  const applied = [
    { key: 'width/height', node: '7', value: `${width}×${height}`, render_resolution: render },
    { key: 'length', node: '7', value: frames },
    { key: 'sampling', node: '9', value: samp },
    { key: 'seed', node: '9', value: seed },
    { key: 'native_fps', node: '12', value: quality.fps.native_fps },
  ];
  const modelErrors = Q.workflowErrors(wf);
  return {
    workflow: wf, quality,
    meta: { width, height, frames, seconds: +(frames / 24).toFixed(3), ...samp, seed, quantized_weights: Q.workflowWarnings(wf).length > 0, weight_names: { unet: wf['1'].inputs.unet_name, clip: wf['4'].inputs.clip_name }, lora: false, lora_strength: 0, vae: wf['5'].inputs.vae_name, audio: o.audio !== false, template: path.basename(TEMPLATE), ...quality.fps },
    applied, unapplied: [], risk: estimateRisk({ width: render.width, height: render.height, frames, usableMib: o.usableMib }),
    warnings: [...quality.warnings, ...Q.workflowWarnings(wf), ...modelErrors], ready: modelErrors.length === 0,
    note: '原生24fps；使用已安装权重并标注实际精度，不自动量化；原始视频与后处理独立存档',
  };
}

async function run(o = {}) {
  const built = build(o);
  Q.assertWorkflow(built.workflow);
  const r = await fetch(BASE + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: built.workflow, client_id: 'avp-h3-' + Date.now() }) });
  const j = await r.json();
  if (!j.prompt_id) return { ok: false, status: r.status, error: j, built };
  return { ok: true, prompt_id: j.prompt_id, built, queue_url: `${BASE}/queue`, history_url: `${BASE}/history/${j.prompt_id}` };
}

async function status(promptId) {
  const h = await (await fetch(`${BASE}/history/${promptId}`)).json();
  const item = h[promptId];
  if (!item) return { done: false, state: 'running_or_queued' };
  const st = item.status || {};
  const images = [];
  for (const o of Object.values(item.outputs || {})) for (const im of o.images || []) images.push(im);
  return { done: true, state: st.status_str || 'unknown', images, status: st };
}
module.exports = { uploadImage, build, run, status, snapFrames, estimateRisk, baseTemplate, TEMPLATE, BASE };
