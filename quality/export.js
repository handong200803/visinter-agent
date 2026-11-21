'use strict';
/**
 * quality/export.js —— 产出 quality.json，并可选把真数据注入 inspector 的**副本**
 *
 * 铁律：只读 inspector/index.html，永远只写 quality/inspector.live.html。
 *   写入前后各算一次 sha256，若原文件被动过直接抛 E_INSPECTOR_MUTATED —— 这是不可协商的护栏。
 *
 * 注入点（对齐 inspector/README.md 里点名的三处之一：frames[]）：
 *   ① const N / FPS        —— 帧数、帧率改成真值，否则 120 帧的 UI 会去索引不存在的帧
 *   ② 帧质量模型整块      —— 用真实 frames[] 字面量替换 Array.from 生成的假数据
 *   ③ 「120 帧已就位」文案 —— 顺手改成真实帧数（纯观感，改不到也不影响功能）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const probeMod = require('./probe.js');
const framesMod = require('./frames.js');
const reportMod = require('./report.js');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const QC_DIR = path.join(CACHE_ROOT, 'avp', 'qc');
const OUT_DIR = path.join(QC_DIR, 'out');
const ROOT = path.join(__dirname, '..');
const INSPECTOR = path.join(ROOT, 'inspector', 'index.html');
const LIVE = path.join(__dirname, 'inspector.live.html');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

const START_MARK = '/* ================= 帧质量模型（演示数据） ================= */';
const END_MARK = 'const anchors = new Set(';

/** 把 frames[] 压成 inspector 契约字段（多余字段全塞 extra，避免污染契约） */
function contractFrames(frames) {
  return frames.map((f) => ({
    frame: f.frame,
    score: f.score,
    sharp: f.sharp,
    flicker: f.flicker,
    flowResidual: f.flowResidual,
    defect: f.defect,
    status: f.status,
    repaired: false,
    extra: f.extra,
  }));
}

/**
 * 生成副本。返回 { outPath, frames, bytes }；失败抛错（调用方决定如何提示）
 */
function patchInspector(quality, opts = {}) {
  const srcPath = opts.source || INSPECTOR;
  const outPath = opts.target || LIVE;
  const before = fs.readFileSync(srcPath);
  const beforeHash = sha256(before);
  const html = before.toString('utf8');

  if (!html.includes(START_MARK) || !html.includes(END_MARK)) {
    const e = new Error('inspector 里找不到注入锚点（帧质量模型块/anchor 定义），可能被改过');
    e.code = 'E_PATCH_ANCHOR';
    throw e;
  }
  const frames = contractFrames(quality.frames);
  const fps = quality.analysis.fps || 30;
  const literal = JSON.stringify(frames);

  // ① N / FPS
  let out = html.replace(/const N = \d+, FPS = \d+/, `const N = ${frames.length}, FPS = ${Math.round(fps)}`);
  if (!new RegExp(`const N = ${frames.length}, FPS = ${Math.round(fps)}`).test(out)) {
    const e = new Error('替换 N/FPS 失败');
    e.code = 'E_PATCH_N';
    throw e;
  }

  // ② 整块替换（用函数式 replace，避免 $& 之类被当成替换模式）
  const block =
    '/* ================= 帧质量模型（真数据 · quality/export.js --patch-inspector 注入） ================= */\n' +
    'const DEFECT = ' + JSON.stringify(
      Object.fromEntries(frames.filter((f) => f.defect).map((f) => [f.frame, f.defect])),
    ) + ';\n' +
    'const frames = ' + literal + ';\n';
  const i0 = out.indexOf(START_MARK);
  const i1 = out.indexOf(END_MARK, i0);
  out = out.slice(0, i0) + block + out.slice(i1);

  // ③ 观感：帧数文案
  out = out.replace(/'生成完成 · 120 帧已就位'/, '`生成完成 · ${N} 帧已就位`');

  // 注入后自检：能被 JSON.parse 重新读出来，且长度等于 N
  const back = JSON.parse(literal);
  if (back.length !== frames.length) throw Object.assign(new Error('frames 字面量自校验失败'), { code: 'E_PATCH_SELFCHECK' });
  // 简单括号/引号平衡检查：至少确认 IIFE 没被我们截断
  if (!out.includes('const anchors = new Set(') || !out.trimEnd().endsWith('</html>')) {
    throw Object.assign(new Error('注入后 HTML 结构异常'), { code: 'E_PATCH_STRUCTURE' });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out, 'utf8');

  // 护栏：原文件必须字节级不变
  const afterHash = sha256(fs.readFileSync(srcPath));
  if (afterHash !== beforeHash) {
    throw Object.assign(new Error('inspector/index.html 的哈希变了——立即停止，恢复原文件'), { code: 'E_INSPECTOR_MUTATED' });
  }
  return { outPath, frames: frames.length, bytes: Buffer.byteLength(out), source: srcPath, sourceSha256: beforeHash, sourceUnchanged: true };
}

/**
 * 一条视频的完整导出：probe → frames → report → quality.json（+ 可选补丁）
 */
async function runExport(opts = {}) {
  const video = opts.video;
  const t0 = Date.now();
  const p = probeMod.probe(video, {});
  if (!p.ok) return { ok: false, code: p.code, message: p.message, hint: p.hint };
  const a = await framesMod.analyze(video, { fps: p.video.fps, frameCount: p.video.nbFrames });
  if (!a.ok) return { ok: false, code: a.code, message: a.message, hint: a.hint };

  const quality = reportMod.build(p, a, { worstN: opts.worstN || 10 });
  quality.timing = { ...a.timing, totalMs: Date.now() - t0 };
  quality.probe_summary = {
    width: p.video.width, height: p.video.height, fps: p.video.fps, duration: p.video.duration,
    nbFrames: p.video.nbFrames, framesSource: p.video.framesSource, bitrate: p.video.bitrate,
    pixFmt: p.video.pixFmt, colorSpace: p.video.colorSpace,
  };
  // 帧数一致性：容器声明 vs 实际解码，不一致要显式喊出来（VFR/坏容器）
  quality.summary.frame_count_mismatch = p.video.nbFrames !== a.analysis.frames
    ? { probe: p.video.nbFrames, decoded: a.analysis.frames } : null;

  const outDir = opts.outDir || OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(video).replace(/\.[^.]+$/, '');
  const jsonPath = opts.jsonPath || path.join(outDir, base + '.quality.json');
  fs.writeFileSync(jsonPath, JSON.stringify(quality, null, 2), 'utf8');

  let live = null;
  if (opts.patchInspector) live = patchInspector(quality, {});

  return { ok: true, jsonPath, quality, live, probe: p, analysis: a, totalMs: Date.now() - t0 };
}

module.exports = { runExport, patchInspector, contractFrames, INSPECTOR, LIVE, OUT_DIR, sha256 };

if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const video = argv.find((a) => !a.startsWith('--'));
    const flag = (name) => argv.includes('--' + name);
    const val = (name, dflt) => {
      const i = argv.indexOf('--' + name);
      return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
    };
    if (!video) {
      console.error('用法: node quality/export.js <video> [--patch-inspector] [--out DIR] [--worst N]');
      process.exit(2);
    }
    const r = await runExport({ video, patchInspector: flag('patch-inspector'), outDir: val('out', OUT_DIR), worstN: Number(val('worst', 10)) });
    if (!r.ok) {
      console.error(`[export] ${r.code}: ${r.message}` + (r.hint ? `\n         ${r.hint}` : ''));
      process.exit(3);
    }
    const s = r.quality.summary;
    console.log(`quality.json → ${r.jsonPath}  (${(fs.statSync(r.jsonPath).size / 1024).toFixed(0)} KB)`);
    console.log(`帧 ${s.frames} · 均值 ${s.mean} · p5 ${s.p5} · p95 ${s.p95} · 问题帧 ${s.problem_frames} (ok ${s.status.ok}/warn ${s.status.warn}/bad ${s.status.bad})`);
    if (r.live) console.log(`inspector 副本 → ${r.live.outPath}  (${(r.live.bytes / 1024).toFixed(0)} KB，注入 ${r.live.frames} 帧，原文件哈希未变)`);
  })();
}