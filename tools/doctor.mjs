/**
 * doctor.mjs —— 平台环境体检（首启 / 换机 / 出故障时先跑这个）
 *
 * 为什么要单独一个体检器：
 *   这个平台的失败模式很分散——node 太旧、ffmpeg 不在 PATH、ComfyUI 没起、
 *   注册表被手改坏、C 盘被缓存撑爆。用户看到的只有「打不开 / 卡住 / 报红字」。
 *   与其在四个模块里各写一遍前置检查，不如统一在这里一次说清。
 *
 * 输出原则：每项给「状态 / 实测值 / 不通过时怎么修」，不通过不中断（体检要全量结论）。
 * 退出码：0 全绿或仅 WARN；1 存在 FAIL。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD_ROOT = process.env.CLOUD_ROOT || 'D:\\云盘';
const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const rows = [];
const add = (name, status, value, fix) => rows.push({ name, status, value: value ?? '', fix: fix ?? '' });

/* ── 1. Node 版本 ───────────────────────────────────────── */
const major = Number(process.versions.node.split('.')[0]);
add('Node 运行时', major >= 22 ? 'PASS' : 'FAIL',
  `v${process.versions.node}`,
  major >= 22 ? '' : '平台用了 fs/promises 与内置 test 相关 API，需 Node ≥ 22');

/* ── 2. ffmpeg / ffprobe ────────────────────────────────── */
function probeBin(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').split(/\r?\n/)[0];
}
const ffmpeg = probeBin('ffmpeg');
const ffprobe = probeBin('ffprobe');
add('ffmpeg', ffmpeg ? 'PASS' : 'FAIL', ffmpeg || '未找到', ffmpeg ? '' : '装 ffmpeg 并加进 PATH（质检与合成依赖它）');
add('ffprobe', ffprobe ? 'PASS' : 'FAIL', ffprobe || '未找到', ffprobe ? '' : '随 ffmpeg 一起安装（逐帧指标依赖它）');

/* ── 3. ComfyUI 可达性（非必需，缺失走 mock） ────────────── */
function tcpCheck(url, timeout = 800) {
  return new Promise((resolve) => {
    let host = '127.0.0.1', port = 80;
    try { const u = new URL(url); host = u.hostname; port = Number(u.port || 80); } catch { return resolve(false); }
    const sock = new net.Socket();
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

/* ── 4. 注册表完整性 ───────────────────────────────────── */
let reg = null, regErr = null;
try {
  reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/params.registry.json'), 'utf8'));
  regErr = null;
} catch (e) { regErr = e.message; }
const regOk = !!reg && reg.counts && reg.counts.total > 0 && Array.isArray(reg.stages);
add('参数注册表', regOk ? 'PASS' : 'FAIL',
  regOk ? `${reg.counts.total} 参数 / ${reg.stages.length} 板块 / v${reg.version}` : (regErr || '结构异常'),
  regOk ? '' : '跑 node tools/gen_registry.mjs 重新生成');

/* ── 5. 模块入口落地情况 ───────────────────────────────── */
const MODULES = [
  ['core', 'core/selftest.js'], ['prompt', 'prompt/selftest.js'], ['quality', 'quality/selftest.js'],
  ['market', 'market/selftest.js'], ['plugins', 'plugins/selftest.js'], ['server', 'server/selftest.js'],
  ['canvas', 'canvas/selftest.mjs'], ['app', 'app/selftest.mjs'],
];
const present = MODULES.filter(([, p]) => fs.existsSync(path.join(ROOT, p))).map(([id]) => id);
const missing = MODULES.filter(([, p]) => !fs.existsSync(path.join(ROOT, p))).map(([id]) => id);
add('模块落地', missing.length === 0 ? 'PASS' : (present.length ? 'WARN' : 'FAIL'),
  `已接入 ${present.length}/8${missing.length ? ' · 缺 ' + missing.join(',') : ''}`,
  missing.length ? '每个模块需提供 selftest 入口，见 docs/01-architecture.md §4' : '');

/* ── 6. 构建产物是否落后于源文件 ────────────────────────── */
function newer(src, out) {
  try { return fs.statSync(path.join(ROOT, src)).mtimeMs > fs.statSync(path.join(ROOT, out)).mtimeMs; }
  catch { return fs.existsSync(path.join(ROOT, src)); }
}
const stale = [];
if (newer('core/engine.js', 'web/params.html') || newer('spec/params.registry.json', 'web/params.html')) stale.push('web/params.html');
if (fs.existsSync(path.join(ROOT, 'canvas/canvas.src.html')) &&
    newer('canvas/canvas.src.html', 'canvas/canvas.html')) stale.push('canvas/canvas.html');
if (fs.existsSync(path.join(ROOT, 'app/index.src.html')) &&
    newer('app/index.src.html', 'app/index.html')) stale.push('app/index.html');
add('构建产物新鲜度', stale.length ? 'WARN' : 'PASS',
  stale.length ? stale.join(', ') + ' 落后于源文件' : '全部最新',
  stale.length ? '重跑对应构建器（node tools/build_*.mjs）' : '');

/* ── 7. 磁盘与写权限（C 盘零占用纪律） ──────────────────── */
function freeGB(drive) {
  try {
    const s = fs.statfsSync(drive + '\\');
    return (s.bavail * s.bsize) / 1024 ** 3;
  } catch { return null; }
}
const freeCloud = freeGB(path.parse(CLOUD_ROOT).root.replace(/\\$/, ''));
const freeCache = freeGB(path.parse(CACHE_ROOT).root.replace(/\\$/, ''));
const freeC = freeGB('C:');
add('云盘可用空间', freeCloud === null ? 'WARN' : freeCloud > 20 ? 'PASS' : 'WARN',
  freeCloud === null ? `${CLOUD_ROOT} 不可达` : `${freeCloud.toFixed(1)} GB @ ${path.parse(CLOUD_ROOT).root}`,
  freeCloud === null ? '检查移动硬盘/网盘盘符是否挂载（别硬编码盘符）' : '成片与模型吃空间，建议 >20GB');
add('C 盘可用空间', freeC === null ? 'WARN' : freeC > 10 ? 'PASS' : 'WARN',
  freeC === null ? '读取失败' : `${freeC.toFixed(1)} GB`,
  '缓存应全部落 %CACHE_ROOT%，C 盘只放程序本体');

function writable(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    const f = path.join(p, '.avp_write_probe');
    fs.writeFileSync(f, 'ok'); fs.unlinkSync(f);
    return true;
  } catch { return false; }
}
const cacheDir = path.join(CACHE_ROOT, 'avp');
add('缓存写入', writable(cacheDir) ? 'PASS' : 'FAIL', cacheDir,
  writable(cacheDir) ? '' : '检查 %CACHE_ROOT% 是否存在、是否有写权限');
add('产出写入', writable(CLOUD_ROOT) ? 'PASS' : 'FAIL', CLOUD_ROOT,
  writable(CLOUD_ROOT) ? '' : '%CLOUD_ROOT% 不可写，产出会失败');

/* ── 输出 ──────────────────────────────────────────────── */
const comfy = await tcpCheck(COMFY_URL);
add('ComfyUI 服务', comfy ? 'PASS' : 'WARN',
  comfy ? `可达 ${COMFY_URL}` : `不可达 ${COMFY_URL}`,
  comfy ? '' : '未起服务不影响界面与估算；提交生成任务会走 mock 模式（显式标记 mock:true）');

const ICON = { PASS: `${C.green}✓${C.reset}`, WARN: `${C.yellow}!${C.reset}`, FAIL: `${C.red}✗${C.reset}` };
const ORDER = rows.slice(0, 5).concat([rows[rows.length - 1]], rows.slice(5, rows.length - 1));

console.log(`${C.bold}AI 视频平台 · 环境体检${C.reset}  ${C.dim}${os.type()} ${os.release()} · ${os.cpus().length} 核${C.reset}`);
console.log(`${C.dim}根目录 ${ROOT}${C.reset}\n`);
for (const r of ORDER) {
  console.log(`${ICON[r.status]} ${r.name.padEnd(14, ' ')} ${C.dim}${r.value}${C.reset}`);
  if (r.status !== 'PASS' && r.fix) console.log(`   ${C.dim}└ ${r.fix}${C.reset}`);
}

const fails = rows.filter((r) => r.status === 'FAIL').length;
const warns = rows.filter((r) => r.status === 'WARN').length;
console.log(`\n${C.bold}结论${C.reset}  FAIL ${fails} · WARN ${warns} · PASS ${rows.length - fails - warns}`);
if (fails) {
  console.log(`${C.red}先修 FAIL 项，其余模块才能正常工作${C.reset}`);
  process.exit(1);
}
console.log(`${C.green}环境可用${warns ? '（WARN 项不阻塞本地开发）' : ''}${C.reset}`);