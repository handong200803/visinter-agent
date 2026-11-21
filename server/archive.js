/**
 * archive.js —— 成片归档：ComfyUI 产物 → 云盘成片目录 + 作品库索引
 *
 * 为什么必须做：ComfyUI 的 output 目录是它的临时区，清缓存/重装就没了；平台的成片必须落在
 * %CLOUD_ROOT%\02-视频\成片（可搬盘、可被作品库检索），并带一份可复现元数据（job_id / 引擎 /
 * 提示词 / 参数摘要 / 耗时 / 源路径）。
 *
 * 索引：%CLOUD_ROOT%\02-视频\成片\_index.json（数组，最新在前，最多 500 条）。
 * 不覆盖同名文件：同一天同名自动加 -2/-3 后缀。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CLOUD_ROOT = process.env.CLOUD_ROOT || 'D:\\云盘';
const OUT_DIR = path.join(CLOUD_ROOT, '02-视频', '成片');
const INDEX = path.join(OUT_DIR, '_index.json');
const COMFY_OUTPUT = path.resolve(process.env.COMFY_OUTPUT_DIR || path.join(CLOUD_ROOT, '01-代码', 'AI视频', 'ComfyUI', 'output'));

function uniqueName(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 2;
  while (fs.existsSync(path.join(dir, candidate))) candidate = `${base}-${i++}${ext}`;
  return candidate;
}

/**
 * 归档一个 job（读 job.images 里的 ComfyUI output 文件）。
 * @returns {{file:string, index:number, bytes:number}|null} 无可归档文件时返回 null
 */
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flush: true });
  fs.renameSync(tmp, file);
}

function archiveJob(job, { outDir = OUT_DIR, comfyOutput = COMFY_OUTPUT } = {}) {
  const images = job.images || [];
  const video = images.find((x) => /\.(mp4|webm|mov|mkv)$/i.test(String(x.filename || '')));
  const im = video || (!job.engine && images[0]);
  if (!im || !im.filename) throw Object.assign(new Error('ComfyUI 未返回可归档的成片'), { code: 'ARCHIVE_NO_OUTPUT' });
  const root = path.resolve(comfyOutput);
  const src = path.resolve(root, im.subfolder || '', im.filename);
  if (!src.startsWith(root + path.sep)) throw Object.assign(new Error('产物路径超出 ComfyUI 输出目录'), { code: 'ARCHIVE_BAD_PATH' });
  const ext = path.extname(im.filename).toLowerCase();
  const experiment = job.experiment_id || job.id;
  if (!/^[\p{L}\p{N}_-]{1,96}$/u.test(experiment) || !/^[\w-]+$/.test(job.id)) {
    throw Object.assign(new Error('实验或任务 ID 不能用作归档文件名'), { code: 'ARCHIVE_BAD_ID' });
  }
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, `${experiment}_${job.id}_pure${ext}`);
  const manifest = target + '.task.json';
  let previous = null;
  if (fs.existsSync(manifest)) previous = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (!(previous && previous.job_id === job.id && fs.existsSync(target) && fs.statSync(target).size === previous.bytes)) {
    if (!fs.existsSync(src) || !fs.statSync(src).isFile() || fs.statSync(src).size === 0) {
      throw Object.assign(new Error('生成结果文件缺失，保留任务以便重试取回'), { code: 'ARCHIVE_SOURCE_MISSING', detail: { src } });
    }
    const tmp = target + '.part';
    let copied = false, lastErr;
    for (let i = 0; i < 3 && !copied; i++) {
      try { fs.copyFileSync(src, tmp); copied = true; } catch (e) {
        lastErr = e;
        try { fs.writeFileSync(tmp, fs.readFileSync(src)); copied = true; } catch (fallback) { lastErr = fallback; }
      }
    }
    if (!copied) throw Object.assign(new Error('成片复制失败：' + lastErr.message), { code: 'ARCHIVE_COPY_FAILED', detail: { src, target } });
    if (fs.statSync(tmp).size !== fs.statSync(src).size) throw Object.assign(new Error('成片复制不完整'), { code: 'ARCHIVE_COPY_FAILED' });
    const fd = fs.openSync(tmp, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  }
  const rec = {
    job_id: job.id, task_id: job.id, provider_task_id: job.providerTaskId || null,
    experiment_id: experiment, variant: 'pure', name: path.basename(target), file: target,
    bytes: fs.statSync(target).size, engine: job.engine || 'comfy', model: job.model || job.engine || null,
    prompt: job.prompt || job.note || null, params: job.valueSnapshot || {},
    canvasSnapshot: job.canvasSnapshot || job.workflow || null, quality: job.quality || null,
    duration_ms: job.actualDurationMs || null, source: src, at: previous ? previous.at : new Date().toISOString(),
  };
  writeJson(manifest, rec);
  const index = path.join(outDir, '_index.json');
  let list = fs.existsSync(index) ? JSON.parse(fs.readFileSync(index, 'utf8')) : [];
  if (!Array.isArray(list)) throw Object.assign(new Error('作品库索引格式损坏，原文件已保留'), { code: 'ARCHIVE_INDEX_INVALID' });
  list = list.filter((x) => !(x.job_id === job.id && (x.variant || 'pure') === 'pure'));
  list.unshift(rec);
  writeJson(index, list);
  return { file: target, index: list.length, bytes: rec.bytes, record: rec };
}

/**
 * 直接归档一个文件路径（不经 jobs；用于 A/B/C 这类脚本产物）。
 * @param {string} src 绝对路径
 * @param {object} meta {job_id, engine, prompt, params, duration_ms}
 */
function archivePath(src, meta = {}) {
  if (!src || !fs.existsSync(src)) return { error: 'SOURCE_MISSING', src };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // meta.name 允许调用方指定成品文件名（增强版要用 <experiment>_<job>_enhanced.mp4）；
  // 否则按 <日期>_<引擎>_<原名> 命名。两种都走 uniqueName 去重。
  const wanted = meta.name || `${day}_${meta.engine || 'h3'}_${path.basename(src)}`;
  const target = path.join(OUT_DIR, uniqueName(OUT_DIR, wanted));
  let copied = false, lastErr = null;
  for (let i = 0; i < 3 && !copied; i += 1) {
    try { fs.copyFileSync(src, target); copied = true; } catch (e) {
      lastErr = e;
      try { fs.writeFileSync(target, fs.readFileSync(src)); copied = true; } catch (e2) { lastErr = e2; }
    }
  }
  if (!copied) return { error: 'COPY_FAILED', detail: lastErr && lastErr.code };
  const st = fs.statSync(target);
  const rec = { job_id: meta.job_id || null, variant: meta.variant || 'pure', experiment_id: meta.experiment_id || null, name: path.basename(target), file: target, bytes: st.size, engine: meta.engine || 'h3', model: meta.model || null, prompt: meta.prompt || null, params: meta.params || null, source: src, at: new Date().toISOString() };
  const list = fs.existsSync(INDEX) ? JSON.parse(fs.readFileSync(INDEX, 'utf8')) : [];
  if (!Array.isArray(list)) throw Object.assign(new Error('作品库索引格式损坏，原文件已保留'), { code: 'ARCHIVE_INDEX_INVALID' });
  list.unshift(rec);
  writeJson(INDEX, list);
  return { file: target, record: rec };
}

/** 列出最近归档（页面作品库用）。 */
function recent(limit = 20) {
  try {
    const list = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    return Array.isArray(list) ? list.slice(0, limit) : [];
  } catch { return []; }
}

module.exports = { archiveJob, archivePath, recent, OUT_DIR, INDEX, COMFY_OUTPUT };
