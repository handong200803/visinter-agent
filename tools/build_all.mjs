/**
 * build_all.mjs —— 一键重建全部产物
 *
 * 为什么要这个：
 *   平台有 4 类构建产物（注册表 / 参数面板 / 画布 / 外壳），改一处源文件往往要连带重建下游。
 *   手工记顺序容易漏，漏了的症状是「改了没生效」，非常难查。这里把顺序固化下来。
 *
 * 顺序不是随意的：
 *   gen_registry 必须先跑（产出 spec/params.registry.json 这个唯一真相源），
 *   其余三个构建器都读它；canvas / app 各自内联同一份数据。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const STEPS = [
  { id: 'registry', label: '参数注册表', file: 'tools/gen_registry.mjs', out: 'spec/params.registry.json', always: true },
  { id: 'params', label: '参数面板', file: 'core/build.mjs', out: 'web/params.html', always: true },
  { id: 'canvas', label: '三视图画布', file: 'tools/build_canvas.mjs', out: 'canvas/canvas.html' },
  { id: 'app', label: '平台外壳', file: 'tools/build_app.mjs', out: 'app/index.html' },
  // 模块入口：先跑各自的快照脚本（把模块真实数据落成 JSON），再交给通用构建器内联。
  // 快照脚本可能依赖 spec/，所以排在 registry 之后。
  { id: 'snap', label: '模块快照', file: 'tools/snap_all.mjs', out: 'market/snapshot.json' },
  { id: 'modules', label: '模块入口', file: 'tools/build_module.mjs', out: 'market/index.html' },
  // 验收台是单文件活样本，和七页吃同一份 tokens.css + glass-skin.css，所以也走构建。
  { id: 'inspector', label: '视觉验收台', file: 'tools/build_inspector.mjs', out: 'inspector/index.html' },
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const dry = process.argv.includes('--dry');

console.log(`${C.bold}AI 视频平台 · 全量构建${C.reset}\n`);

let fail = 0, built = 0, skipped = 0;
const t0 = Date.now();

for (const s of STEPS) {
  if (only.length && !only.includes(s.id)) continue;
  const src = path.join(ROOT, s.file);
  if (!fs.existsSync(src)) {
    console.log(`${C.yellow}—${C.reset} ${s.label.padEnd(10, ' ')} ${C.dim}跳过：${s.file} 不存在${C.reset}`);
    skipped++;
    continue;
  }
  if (dry) {
    console.log(`${C.cyan}·${C.reset} ${s.label.padEnd(10, ' ')} ${C.dim}将执行 node ${s.file}${C.reset}`);
    continue;
  }

  process.stdout.write(`${C.cyan}▸${C.reset} ${s.label.padEnd(10, ' ')} `);
  const started = Date.now();
  const r = spawnSync(process.execPath, [src], { cwd: ROOT, encoding: 'utf8' });
  const ms = Date.now() - started;

  if (r.status !== 0) {
    fail++;
    console.log(`${C.red}FAIL${C.reset} ${C.dim}${ms}ms${C.reset}`);
    const msg = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-8).join('\n');
    if (msg) console.log(msg.split('\n').map((l) => `    ${C.red}│${C.reset} ${l}`).join('\n'));
    continue;
  }

  built++;
  const outPath = path.join(ROOT, s.out);
  let size = '';
  try {
    const st = fs.statSync(outPath);
    size = `${(st.size / 1024).toFixed(0)}KB`;
  } catch { size = '（未产出目标文件）'; }
  // 构建器自己会打印关键数字（参数总数/规则数），只取末行，避免刷屏
  const note = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
  console.log(`${C.green}OK${C.reset} ${C.dim}${ms}ms → ${s.out} ${size}${C.reset}`);
  if (note && !/^写入/.test(note)) console.log(`    ${C.dim}${note}${C.reset}`);
}

const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n${C.bold}汇总${C.reset}  成功 ${built} · 失败 ${fail} · 跳过 ${skipped} · ${total}s`);
if (fail) { console.log(`${C.red}存在失败步骤${C.reset}`); process.exit(1); }
if (!dry) console.log(`${C.green}${C.bold}全部通过${C.reset}`);