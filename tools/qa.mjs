#!/usr/bin/env node
/**
 * tools/qa.mjs —— 逐帧质检 CLI（零依赖，只用内置模块 + 子进程调 ffmpeg/ffprobe）
 *
 *   node tools/qa.mjs run <video>          单条：探针 → 逐帧指标 → 汇总 → quality.json
 *   node tools/qa.mjs batch <dir>          整目录批量，出对照表 + batch.json
 *   node tools/qa.mjs selftest             跑 quality/selftest.js 全量自检
 *   node tools/qa.mjs fixtures [--force]   生成测试素材（good/bad 各一条）
 *
 * 退出码：0 正常 / 2 用法错误 / 3 分析失败 / 4 自检失败
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { probe } = require(path.join(ROOT, 'quality', 'probe.js'));
const { runExport, OUT_DIR } = require(path.join(ROOT, 'quality', 'export.js'));
const { analyze } = require(path.join(ROOT, 'quality', 'frames.js'));
const { build } = require(path.join(ROOT, 'quality', 'report.js'));
const { generate, FIX_DIR } = require(path.join(ROOT, 'quality', 'fixtures.js'));

const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.flv', '.ts', '.mts']);
const C = process.stdout.isTTY
  ? { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', off: '\x1b[0m' }
  : { dim: '', red: '', green: '', yellow: '', cyan: '', off: '' };

const fmtSize = (n) => (n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB');
const flag = (argv, n) => argv.includes('--' + n);
const opt = (argv, n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

function usage() {
  console.log(`逐帧质检 CLI

  node tools/qa.mjs run <video> [--patch-inspector] [--out DIR] [--worst N] [--json]
  node tools/qa.mjs batch <dir> [--out DIR] [--json]
  node tools/qa.mjs selftest
  node tools/qa.mjs fixtures [--force]

出参：quality.json（%CACHE_ROOT%\\avp\\qc\\out），--patch-inspector 另出 quality/inspector.live.html`);
}

/** 打印一条视频的结论（人读） */
function printReport(q, jsonPath) {
  const s = q.summary;
  console.log(`\n${C.cyan}${q.video}${C.off}  ${q.probe_summary.width}x${q.probe_summary.height} @ ${q.probe_summary.fps}fps ` +
    `${q.probe_summary.duration}s · ${q.probe_summary.nbFrames} 帧(${q.probe_summary.framesSource}) · ${fmtSize(q.probe.sizeBytes)}`);
  console.log(`  解码 ${q.analysis.width}x${q.analysis.height} 灰阶 · ${q.analysis.frames} 帧 · 分析耗时 ${q.timing.totalMs}ms`);
  console.log(`  综合分 均值 ${s.mean} · p5 ${s.p5} · p95 ${s.p95} · 问题帧 ${s.problem_frames}/${s.frames}` +
    ` (ok ${s.status.ok} / warn ${s.status.warn} / bad ${s.status.bad})`);
  if (s.frame_count_mismatch) console.log(`  ${C.red}! 帧数不一致${C.off} 容器 ${s.frame_count_mismatch.probe} vs 解码 ${s.frame_count_mismatch.decoded}`);
  const det = q.detect;
  console.log(`  检出 黑帧[${det.blackFrames.join(',') || '无'}] 白帧[${det.white.join(',') || '无'}] ` +
    `冻结段[${det.staticRuns.map((r) => r.start + '-' + r.end).join(',') || '无'}]`);
  console.log(`  ffmpeg blackdetect: ${det.black.map((b) => `${b.startFrame}-${b.endFrame}`).join(',') || '无'}` +
    ` | freezedetect: ${det.freeze.map((f) => `${f.startFrame}-${f.endFrame}${f.open ? '~' : ''}`).join(',') || '无'}`);
  if (s.segments.length) {
    console.log('  问题段：');
    for (const seg of s.segments.slice(0, 12)) {
      console.log(`    ${String(seg.start).padStart(3)}-${String(seg.end).padStart(3)}  ${seg.defect_cn} ×${seg.frames}  均分 ${seg.score_avg}`);
    }
    if (s.segments.length > 12) console.log(`    …还有 ${s.segments.length - 12} 段（见 quality.json）`);
  }
  console.log(`  最该重绘的 ${s.worst.length} 帧：`);
  for (const w of s.worst.slice(0, 8)) {
    console.log(`    帧 ${String(w.frame).padStart(3)}  分 ${String(w.score).padStart(2)}  ${(w.defect_cn || '低分').padEnd(4)}  ${w.reasons.join('；')}`);
  }
  console.log(`  ${C.dim}→ ${jsonPath}${C.off}`);
}

async function cmdRun(argv) {
  const video = argv[0];
  if (!video) { usage(); return 2; }
  const outDir = opt(argv, 'out', OUT_DIR);
  const r = await runExport({
    video, outDir, patchInspector: flag(argv, 'patch-inspector'), worstN: Number(opt(argv, 'worst', 10)),
  });
  if (!r.ok) {
    console.error(`${C.red}[run] ${r.code}: ${r.message}${C.off}` + (r.hint ? `\n      ${r.hint}` : ''));
    return 3;
  }
  if (flag(argv, 'json')) console.log(JSON.stringify(r.quality, null, 2));
  else printReport(r.quality, r.jsonPath);
  if (r.live) console.log(`  ${C.green}inspector 副本已生成${C.off} ${r.live.outPath}（注入 ${r.live.frames} 帧，原文件哈希未变）`);
  return 0;
}

function listVideos(dir) {
  return fs.readdirSync(dir)
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f))
    .sort();
}

async function cmdBatch(argv) {
  const dir = argv[0];
  if (!dir) { usage(); return 2; }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`${C.red}[batch] 目录不存在：${dir}${C.off}`);
    return 2;
  }
  const files = listVideos(dir);
  if (!files.length) { console.error(`[batch] 目录里没有视频：${dir}`); return 2; }
  const outDir = opt(argv, 'out', OUT_DIR);
  const rows = [];
  console.log(`批量质检 ${files.length} 条（${dir}）`);
  for (const f of files) {
    const t0 = Date.now();
    const p = probe(f);
    if (!p.ok) { rows.push({ file: path.basename(f), ok: false, code: p.code }); console.log(`  ${C.red}✗${C.off} ${path.basename(f)} ${p.code}`); continue; }
    const a = await analyze(f, { fps: p.video.fps });
    if (!a.ok) { rows.push({ file: path.basename(f), ok: false, code: a.code }); console.log(`  ${C.red}✗${C.off} ${path.basename(f)} ${a.code}`); continue; }
    const q = build(p, a, { worstN: 5 });
    q.timing = { ...a.timing, totalMs: Date.now() - t0 };
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, path.basename(f).replace(/\.[^.]+$/, '') + '.quality.json');
    fs.writeFileSync(jsonPath, JSON.stringify(q, null, 2), 'utf8');
    rows.push({
      file: path.basename(f), ok: true, frames: q.summary.frames, mean: q.summary.mean, p5: q.summary.p5,
      problem: q.summary.problem_frames, bad: q.summary.status.bad, worst: q.summary.worst[0] ? q.summary.worst[0].frame : null,
      ms: q.timing.totalMs, json: jsonPath,
    });
    const mark = q.summary.mean >= 80 ? `${C.green}✓${C.off}` : `${C.yellow}!${C.off}`;
    console.log(`  ${mark} ${path.basename(f).padEnd(28)} 均值 ${String(q.summary.mean).padStart(5)}  p5 ${String(q.summary.p5).padStart(5)}  ` +
      `问题 ${String(q.summary.problem_frames).padStart(4)}/${q.summary.frames}  ${q.timing.totalMs}ms`);
  }
  const batchPath = path.join(outDir, 'batch.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(batchPath, JSON.stringify({ generated_at: new Date().toISOString(), dir, count: rows.length, rows }, null, 2), 'utf8');
  const done = rows.filter((r) => r.ok);
  if (done.length) {
    const avg = Math.round((done.reduce((s, r) => s + r.mean, 0) / done.length) * 10) / 10;
    console.log(`\n合计 ${rows.length} 条 · 均值 ${avg} · 有序输出 ${batchPath}`);
  }
  return rows.every((r) => r.ok) ? 0 : 3;
}

function cmdSelftest() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'quality', 'selftest.js')], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code === 0 ? 0 : 4));
  });
}

function cmdFixtures(argv) {
  const r = generate({ force: flag(argv, 'force') });
  for (const f of [r.good, r.bad]) console.log(`${f}  ${fmtSize(fs.statSync(f).size)}`);
  console.log(`注入帧号（30fps）：黑 ${r.expected.black.join('-')} · 白 ${r.expected.white.join('-')} · 模糊 ${r.expected.blur.join('-')} · 冻结 ${r.expected.freeze.join('-')}`);
  console.log(`目录：${FIX_DIR}`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
let code = 2;
if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') { usage(); code = cmd ? 0 : 2; }
else if (cmd === 'run') code = await cmdRun(rest);
else if (cmd === 'batch') code = await cmdBatch(rest);
else if (cmd === 'selftest') code = await cmdSelftest();
else if (cmd === 'fixtures') code = cmdFixtures(rest);
else { console.error(`未知子命令：${cmd}`); usage(); }
process.exit(code);