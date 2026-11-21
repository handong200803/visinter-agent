/**
 * realrun.mjs —— 卡③ 真出片一键端到端（DashScope 通义万相云端路线）
 *
 *   node tools/realrun.mjs --prompt "云海之上的宫殿，雾气缭绕" [--style guofeng_immortal]
 *                          [--model wan2.2-t2v-plus] [--device T0] [--no-qa]
 *
 * 链路：风格预设 + ch.subject → POST 提交（进程内队列，不占 HTTP 端口）→ 轮询云端 →
 *       真 mp4 转存 %CLOUD_ROOT%\02-视频\成片（.part 写完 rename + 台账）→ qa.mjs 逐帧质检 →
 *       docs/state/realrun-<date>.json 实测记录（provenance: measured）。
 *
 * 纪律：
 *   - key 只走环境变量 DASHSCOPE_API_KEY；进程没有时读用户环境注册表（setx 后无需重启 Qoder），
 *     绝不落仓库/日志/任务记录。
 *   - 任务目录用 %CACHE_ROOT%\avp\jobs-realrun，与用户 8388 服务的 jobs 隔离，
 *     不碰别人的任务记录（restore 会把 running 标中断，绝不能扫共享目录）。
 *   - 失败如实报 code + 人话 hint + taskId（已提交云端的任务不自动重投，防重复计费）。
 *   - actualPeakMib 恒 null：云端拿不到 GPU 峰值，不编。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVP = require(path.join(ROOT, 'core/engine.js'));
const { createJobs } = require(path.join(ROOT, 'server/jobs.js'));

const C = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const has = (name) => process.argv.includes('--' + name);

/** key 解析：进程环境 → 用户环境注册表（setx 写入处）。只返回字符串，不打印。 */
function resolveKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', 'DASHSCOPE_API_KEY'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /DASHSCOPE_API_KEY\s+REG_SZ\s+(.+)/.exec(out);
    if (m && m[1].trim()) return m[1].trim();
  } catch { /* 注册表没有就是没有 */ }
  return '';
}

const prompt = arg('prompt', '');
const styleId = arg('style', 'muse_cinematic');
const model = arg('model', process.env.AVP_DS_MODEL || 'wan2.2-t2v-plus');
const device = arg('device', 'T0');
if (!prompt) {
  console.error(`${C.red}缺 --prompt${C.reset}  例：node tools/realrun.mjs --prompt "云海之上的宫殿，雾气缭绕" --style guofeng_immortal`);
  process.exit(1);
}
const key = resolveKey();
if (!key) {
  console.error(`${C.red}DS_NO_API_KEY${C.reset}  真出片需要 DashScope key（阿里云百炼控制台获取）。设置后重试：`);
  console.error(`  setx DASHSCOPE_API_KEY "sk-你的key"   （本工具会直接读用户环境注册表，无需重启 Qoder）`);
  console.error(`${C.dim}key 只走环境变量，不进仓库/前端/任务记录。${C.reset}`);
  process.exit(1);
}
process.env.DASHSCOPE_API_KEY = key;

const muse = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/muse.presets.json'), 'utf8'));
const preset = muse.presets.find((p) => p.id === styleId);
if (!preset) {
  console.error(`${C.red}未知风格 ${styleId}${C.reset}  可选：${muse.presets.map((p) => p.id).join(' / ')}`);
  process.exit(1);
}

const jobs = createJobs({ providerId: 'dashscope', dir: path.join(process.env.CACHE_ROOT || 'D:\\缓存', 'avp', 'jobs-realrun') });
const reg = jobs.spec.reg;
const map = AVP.byKey(reg);
const values = { ...AVP.defaults(reg) };
for (const [k, v] of Object.entries(preset.values)) if (map[k]) values[k] = AVP.coerce(map[k], v);
values['ch.subject'] = prompt;

const est = AVP.estimate(reg, jobs.spec.catalog, AVP.resolve(reg, jobs.spec.rules, values, { ctx: { device, usable_mib: (jobs.spec.catalog.devices.find((d) => d.id === device) || {}).usable_mib } }).values, { device });
console.log(`${C.bold}真出片 · DashScope 万相${C.reset}  ${C.dim}模型 ${model} · 风格 ${preset.name} · 档位 ${device}${C.reset}`);
console.log(`${C.dim}提示词：${prompt}${C.reset}`);
console.log(`${C.dim}本地估算（estimate，非云端实测）：质量 ${est.quality.score} 分 · 显存比 ${(est.vram.ratio * 100).toFixed(0)}%${C.reset}`);

const job = jobs.create({ values, device, model, note: prompt.slice(0, 40), promptExtend: true });
console.log(`${C.cyan}已受理 ${job.id}${C.reset}  任务目录 ${jobs.dir}`);

const t0 = Date.now();
let lastStage = '';
let final = null;
for (;;) {
  await new Promise((r) => setTimeout(r, 3000));
  const j = jobs.get(job.id);
  const stage = (j.progress && j.progress.stage) || j.state;
  if (stage !== lastStage) {
    lastStage = stage;
    console.log(`  ${C.dim}[${((Date.now() - t0) / 1000).toFixed(0)}s]${C.reset} ${stage}${j.providerTaskId ? '  taskId=' + j.providerTaskId : ''}`);
  }
  if (['succeeded', 'failed', 'canceled'].includes(j.state)) { final = j; break; }
  if (Date.now() - t0 > 25 * 60 * 1000) { console.error(`${C.red}本地等待超 25 分钟${C.reset}（云端可能仍在跑，taskId=${j.providerTaskId} 可人工续查）`); process.exit(1); }
}

if (final.state !== 'succeeded') {
  const e = final.error || {};
  console.error(`${C.red}任务 ${final.state}${C.reset}  ${e.code || ''} ${e.message || ''}`);
  if (e.hint) console.error(`${C.yellow}人话：${e.hint}${C.reset}`);
  if (final.providerTaskId) console.error(`${C.dim}云端 taskId=${final.providerTaskId}（已提交的任务不自动重投，防重复计费；可人工续查）${C.reset}`);
  process.exit(1);
}

const out = final.output || {};
if (!out.file || !fs.existsSync(out.file) || !(out.bytes > 0)) {
  console.error(`${C.red}succeeded 但产物文件缺失${C.reset}  ${JSON.stringify(out)}`);
  process.exit(1);
}
console.log(`${C.green}真 mp4 落盘${C.reset}  ${out.file}  ${(out.bytes / 1024 / 1024).toFixed(2)} MB · 实际耗时 ${(final.actualDurationMs / 1000).toFixed(1)}s`);
console.log(`${C.dim}台账 ${out.file.replace(/\.mp4$/, '.ledger.json')} · actualPeakMib=null（云端无 GPU 峰值接口，不编）${C.reset}`);

let quality = null;
if (!has('no-qa')) {
  console.log(`${C.cyan}逐帧质检…${C.reset}  node tools/qa.mjs run`);
  const qa = spawnSync(process.execPath, [path.join(ROOT, 'tools/qa.mjs'), 'run', out.file, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  const tail = (qa.stdout || '').trim().split('\n').slice(-6).join('\n');
  console.log(tail);
  if (qa.status !== 0) {
    console.error(`${C.yellow}质检未通过（exit ${qa.status}），成片已落盘，报告见 %%CACHE_ROOT%%\\avp\\qc\\out${C.reset}`);
  } else {
    try {
      // qa --json 把 quality 摘要对象美化打印在 stdout 末尾；从最后一个顶格 { 截到结尾解析
      const s = qa.stdout || '';
      const idx = s.lastIndexOf('\n{\n');
      quality = JSON.parse(idx >= 0 ? s.slice(idx + 1) : s.trim());
    } catch { /* 质检摘要解析不了不影响成片记录 */ }
  }
}

const record = {
  at: new Date().toISOString(),
  provenance: 'measured',
  provider: 'dashscope',
  model: final.model,
  prompt, style: styleId, device,
  jobId: final.id, providerTaskId: final.providerTaskId,
  ms: final.actualDurationMs,
  bytes: out.bytes,
  file: out.file,
  ledger: out.file.replace(/\.mp4$/, '.ledger.json'),
  actualPeakMib: null,
  actualPeakMib_note: '云端推理无进程级显存峰值接口，恒 null（诚实降级）',
  usage: out.usage || null,
  cloudTimes: out.cloudTimes || null,
  quality: quality ? { summary: quality.summary, probe: quality.probe_summary || null, timing: quality.timing || null } : 'skipped-or-unparsed',
};
const stateDir = path.join(ROOT, 'docs/state');
fs.mkdirSync(stateDir, { recursive: true });
const stateFile = path.join(stateDir, `realrun-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(stateFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
console.log(`${C.green}${C.bold}真出片成功${C.reset}  实测记录 ${stateFile}`);