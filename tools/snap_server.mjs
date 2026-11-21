#!/usr/bin/env node
/**
 * snap_server.mjs —— 静态导出「本地服务」入口的 API 契约快照 server/snapshot.json
 *
 * 为什么「静态」：
 *   入口 HTML 要在 file:// 下双击可开，页面里的数据只能来自构建期注入。
 *   本脚本只读项目源码与 spec/*.json，不要求后端在跑，也不连任何端口；
 *   同样输入必须得到同样产物（只有 generatedAt 是时间戳）。
 *
 * 为什么从代码里解析路由，而不是维护一份手写路由表：
 *   手写表会漂。app.js 新增一条 route(...) 而快照没跟上时，页面会安静地少一个端点。
 *   这里用 app.js 的 route('METHOD', /^...$/, ...) 调用当唯一真源，再要求每条路由都有
 *   契约注解（用途/示例体/响应键）；缺注解直接构建失败，逼着改动同步。
 *
 * 解析出来的东西：
 *   - 路由：method / path / 成功状态码（route 第四参数）
 *   - 任务状态：server/jobs.js 的 STATES、run/cancel/afterFail 里的赋值、maxAttempts
 *   - job 对象字段：create() 字面量与持久字段赋值；publicView 隐藏字段与详情字段分别解析
 *   - stats 字段：jobs.js stats()
 *   - ComfyUI：comfy.js 的 DEFAULT_BASE / COMFY_URL / 超时 / 探测缓存
 *   - 服务端口与 HOST：tools/serve.mjs
 *   - PKG_VERSION / MAX_BODY / CORS / 错误结构：server/app.js
 *   - 设备档位与参数规模：spec/*.json
 *
 * 跑法：node tools/snap_server.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m' };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const die = (msg) => {
  console.error(`${C.red}[snap_server] ${msg}${C.reset}`);
  process.exit(1);
};
const need = (cond, msg) => { if (!cond) die(msg); };
const uniq = (xs) => [...new Set(xs)];

/* ── 源码 ─────────────────────────────────────────────── */
const F = {
  app: 'server/app.js',
  jobs: 'server/jobs.js',
  comfy: 'server/comfy.js',
  wf: 'server/wf.js',
  recommend: 'server/recommend.js',
  quality: 'server/quality.js',
  h3: 'server/h3workflow.js',
  canvasbuilder: 'server/canvasbuilder.js',
  visinter: 'server/visinter.js',
  scoring: 'server/scoring.js',
  providers: 'server/providers/index.js',
  qualitySpec: 'spec/quality.json',
  engine: 'core/engine.js',
  serve: 'tools/serve.mjs',
  launch: 'tools/launch.mjs',
  registry: 'spec/params.registry.json',
  catalog: 'spec/models.catalog.json',
  rules: 'spec/rules.linkage.json',
  muse: 'spec/muse.presets.json',
  aesthetics: 'spec/aesthetics.json',
};
const SRC = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, read(p)]));
// 响应源包含实际被 handler 委托的 helper 和原样返回的策略 JSON；只读，不加载/执行服务模块。
const POOL = [SRC.app, SRC.jobs, SRC.comfy, SRC.wf, SRC.recommend, SRC.engine, SRC.serve,
  SRC.quality, SRC.h3, SRC.canvasbuilder, SRC.visinter, SRC.scoring, SRC.providers,
  SRC.qualitySpec, SRC.muse, SRC.aesthetics].join('\n');

const grab = (src, re, what) => {
  const m = re.exec(src);
  need(m, `解析失败：${what}`);
  return m;
};

/* ── 1. 路由表（唯一真源：app.js 的 route(...) 调用）──────── */
const ROUTE_START = /route\('(GET|POST)',\s*\/\^(.+?)\$\/,/g;
const marks = [];
for (let m = ROUTE_START.exec(SRC.app); m; m = ROUTE_START.exec(SRC.app)) {
  marks.push({ method: m[1], pattern: m[2], at: m.index });
}
need(marks.length >= 10, `app.js 里只解析到 ${marks.length} 条 route(...)，路由表可能改写法了`);

const parsedRoutes = marks.map((r, i) => {
  const end = i + 1 < marks.length ? marks[i + 1].at : SRC.app.indexOf('const server = http.createServer');
  need(end > r.at, `路由 ${r.method} 的源码片段切不出来`);
  const block = SRC.app.slice(r.at, end);
  const code = /,\s*(\d{3})\s*\)\s*;/.exec(block);
  const pathname = r.pattern.replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, ':id').replace(/\(\\d\+\)/g, ':n');
  return { method: r.method, path: pathname, pattern: r.pattern, status: code ? Number(code[1]) : 200, block };
});

/* ── 2. jobs.js：状态、字段、stats、SSE 事件 ──────────── */
const STATES = JSON.parse(grab(SRC.jobs, /const STATES = (\[[^\]]+\]);/, 'jobs.js STATES')[1].replace(/'/g, '"'));
need(STATES.length === 5 && STATES[0] === 'queued', `STATES 解析结果异常：${STATES.join(',')}`);

const jobBlockStart = SRC.jobs.indexOf('const job = {');
const jobBlockEnd = SRC.jobs.indexOf('};', jobBlockStart);
need(jobBlockStart > 0 && jobBlockEnd > jobBlockStart, 'jobs.js 里找不到 create() 的 job 字面量');

/** 取顶层对象键：字符串/嵌套花括号都不误判，兼容 `id,` 这种简写字段 */
function topLevelKeys(block) {
  const start = block.indexOf('{');
  if (start < 0) return [];
  let depth = 0;
  let quote = null;
  let seg = '';
  const segs = [];
  for (let i = start + 1; i < block.length; i += 1) {
    const ch = block[i];
    if (quote) {
      seg += ch;
      if (ch === '\\') { i += 1; seg += block[i] || ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && block[i + 1] === '/') {
      const end = block.indexOf('\n', i + 2);
      need(end >= 0, '对象字段解析遇到未结束的行注释');
      i = end; seg += '\n'; continue;
    }
    if (ch === '/' && block[i + 1] === '*') {
      const end = block.indexOf('*/', i + 2);
      need(end >= 0, '对象字段解析遇到未结束的块注释');
      i = end + 1; seg += ' '; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; seg += ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; seg += ch; continue; }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0 && ch === '}') break;
      depth -= 1; seg += ch; continue;
    }
    if (ch === ',' && depth === 0) { segs.push(seg); seg = ''; continue; }
    seg += ch;
  }
  if (seg.trim()) segs.push(seg);
  return segs.map((s) => {
    const m = /^\s*([a-zA-Z_$][\w$]*)/.exec(s);
    return m ? m[1] : null;
  }).filter(Boolean);
}

const jobLiteral = SRC.jobs.slice(jobBlockStart, jobBlockEnd + 2);
// create 字面量以外，save()/run()/enhance() 还会追加持久字段；它们在相应阶段才出现。
const JOB_FIELDS = uniq([...topLevelKeys(jobLiteral),
  ...[...SRC.jobs.matchAll(/\b(?:job|j)\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1])]);
need(JOB_FIELDS.includes('id') && JOB_FIELDS.includes('progress') && JOB_FIELDS.includes('createdAt'), 'job 字段解析不全');
const viewBlock = grab(SRC.jobs, /function publicView\(j\)\s*\{([\s\S]*?)\n  \}/, 'jobs.js publicView')[1];
const hiddenFields = grab(viewBlock, /const \{\s*([^}]+),\s*\.\.\.rest\s*\} = j;/, 'publicView 隐藏字段')[1].split(',').map((k) => k.trim());
const VIEW_FIELDS = JOB_FIELDS.filter((k) => !hiddenFields.includes(k));
const PUBLIC_FIELDS = uniq([...VIEW_FIELDS, ...topLevelKeys(viewBlock.slice(viewBlock.indexOf('return {')))]);
need(PUBLIC_FIELDS.includes('valuesCount') && PUBLIC_FIELDS.includes('canRetry'), 'publicView 字段解析不全');
const DETAIL_FIELDS = uniq([...JOB_FIELDS, 'canRetry', 'events_url']);
need(/return \{ \.\.\.j, canRetry:[^\n]+events_url:/.test(SRC.app), '任务详情响应字段与代码不符');

const statsBlock = SRC.jobs.slice(SRC.jobs.indexOf('function stats()'), SRC.jobs.indexOf('function cancel('));
const STATS_FIELDS = uniq([...topLevelKeys(statsBlock.slice(statsBlock.indexOf('const out = {'))), ...STATES]);
for (const k of ['total', 'running', 'concurrency', 'dir']) {
  need(new RegExp(`\\b${k}\\b`).test(statsBlock), `stats() 里没有字段 ${k}`);
}

const SSE_EVENTS = uniq([
  ...[...SRC.app.matchAll(/write\('(snapshot|done)'/g)].map((m) => m[1]),
  ...[...SRC.jobs.matchAll(/\bemit\([^\n]*?\{ type: '([^']+)'/g)].map((m) => m[1]),
]).sort((a, b) => {
  const order = ['snapshot', 'state', 'log', 'progress', 'enhancement', 'cine-group', 'cine-pick', 'cine-review', 'done'];
  need(order.includes(a) && order.includes(b), '新增 SSE 事件需要同步排序与说明');
  return order.indexOf(a) - order.indexOf(b);
});
need(SSE_EVENTS.includes('snapshot') && SSE_EVENTS.includes('done'), 'SSE 事件解析不全');
const SSE_HEARTBEAT_MS = Number(grab(SRC.app, /res\.write\(': ping\\n\\n'\);?\s*\}, (\d+)\)/, 'SSE 心跳间隔')[1]);
const SSE_CONTENT_TYPE = grab(SRC.app, /'Content-Type': '(text\/event-stream[^']*)'/, 'SSE Content-Type')[1];

const MAX_ATTEMPTS = Number(grab(SRC.jobs, /const maxAttempts = (\d+)/, 'jobs.js maxAttempts')[1]);
const CONCURRENCY = Number(grab(SRC.jobs, /process\.env\.AVP_CONCURRENCY \|\| (\d+)/, 'jobs.js 并发默认值')[1]);
const MOCK_MS = Number(grab(SRC.jobs, /process\.env\.AVP_MOCK_MS \|\| (\d+)/, 'jobs.js mockMs 默认值')[1]);
const CACHE_ROOT = grab(SRC.jobs, /const CACHE_ROOT = process\.env\.CACHE_ROOT \|\| '([^']+)'/, 'jobs.js CACHE_ROOT')[1];
const JOBS_DIR = '%CACHE_ROOT%/avp/jobs';

/* 状态机：在对应函数内核对赋值与恢复/重试条件，不依赖已删除的中断错误码。 */
const restoreBlock = grab(SRC.jobs, /function restore\(\)\s*\{([\s\S]*?)\n  \}/, 'jobs.js restore')[1];
const recovery = grab(restoreBlock, /if \(j\.state === '([^']+)' \|\| j\.state === '([^']+)'\)\s*\{\s*j\.state = j\.canceled \? '([^']+)' : '([^']+)';/, '重启恢复状态转移');
need(recovery[1] === 'running' && recovery[2] === 'queued' && recovery[3] === 'canceled' && recovery[4] === 'queued', '重启恢复必须重新排队并保留取消意图');
need(/j\.nextRunAt = null/.test(restoreBlock) && /pump\(\)/.test(restoreBlock), '恢复任务没有重新进入调度');
const TERMINAL = JSON.parse(grab(SRC.jobs, /const terminal = (\[[^\]]+\])\.includes\(job\.state\)/, '任务终态 includes 判定')[1].replace(/'/g, '"'));
need(TERMINAL.join(',') === 'succeeded,failed,canceled', '终态判定与代码不符');
const RECONNECT_MS = Number(grab(SRC.jobs, /process\.env\.AVP_RECONNECT_MS \|\| (\d+)/, 'jobs.js 重连间隔')[1]);
const RECONNECT_CODES = JSON.parse(grab(SRC.jobs, /prov\.id === 'comfy' && (\[[^\]]+\])\.includes\(code\)/, 'ComfyUI 重连错误码')[1].replace(/'/g, '"'));
const NON_RETRYABLE = JSON.parse(grab(SRC.jobs, /const nonRetryable = (\[[^\]]+\]);/, '不自动重试的错误码')[1].replace(/'/g, '"'));
const retryBlock = grab(SRC.jobs, /function retry\(id\)\s*\{([\s\S]*?)\n  \}/, 'jobs.js retry')[1];
need(/!\['failed', 'canceled'\]\.includes\(job\.state\) \|\| active\.has\(id\)/.test(retryBlock), '人工重试条件漂移');
need(/const retryable = prov\.id !== 'comfy' && job\.kind !== 'cine' && !job\.providerTaskId && !nonRetryable\.includes\(code\)/.test(SRC.jobs)
  && /retryable && job\.attempt < maxAttempts/.test(SRC.jobs), '自动重试条件漂移');
const TRANSITIONS = [
  { from: 'queued', to: 'running', trigger: '调度器 pump 取队（并发上限 ' + CONCURRENCY + '）', source: 'jobs.js run()' },
  { from: 'queued', to: 'canceled', trigger: '排队中被取消，立即落终态', source: 'jobs.js cancel()' },
  { from: 'running', to: 'succeeded', trigger: 'provider 完成；ComfyUI 原生产物成功归档后落终态，增强独立排队', source: 'jobs.js run()' },
  { from: 'running', to: 'failed', trigger: '不可自动重试的错误或重试耗尽；非 ComfyUI 自动重试最多 ' + MAX_ATTEMPTS + ' 次尝试', source: 'jobs.js afterFail()' },
  { from: 'running', to: 'canceled', trigger: '收到取消意图或 JOB_CANCELED', source: 'jobs.js run()' },
  { from: 'running', to: 'queued', trigger: '后端退出保留任务、ComfyUI 等待重连或允许的自动重试', source: 'jobs.js run()' },
  { from: recovery[1], to: recovery[4], trigger: '重启恢复未取消任务，保留远端提交信息以续接', source: 'jobs.js restore()' },
  { from: 'failed', to: 'queued', trigger: '人工 retry，沿用原任务快照', source: 'jobs.js retry()' },
  { from: 'canceled', to: 'queued', trigger: '人工 retry，清除取消意图及旧提交信息', source: 'jobs.js retry()' },
];
for (const t of TRANSITIONS) {
  const fn = grab(t.source, /jobs\.js (\w+)\(\)/, '状态转移函数')[1];
  const block = grab(SRC.jobs, new RegExp(`function ${fn}\\([^\\n]*?\\)\\s*\\{([\\s\\S]*?)\\n  \\}`), `jobs.js ${fn}`)[1];
  need(fn === 'restore' ? recovery[4] === t.to : new RegExp(`job\\.state = '${t.to}'`).test(block), `找不到 ${t.source} → ${t.to} 的赋值，状态机与代码不符`);
}

/* ── 3. comfy.js / serve.mjs / app.js 常量 ───────────── */
const PKG_VERSION = grab(SRC.app, /const PKG_VERSION = '([^']+)'/, 'app.js PKG_VERSION')[1];
const MAX_BODY = Number(grab(SRC.app, /const MAX_BODY = (\d+) \* (\d+) \* (\d+)/, 'app.js MAX_BODY')[1]) * 1024 * 1024;
need(MAX_BODY > 0, 'MAX_BODY 解析为 0');

const COMFY_BASE = grab(SRC.comfy, /const DEFAULT_BASE = '([^']+)'/, 'comfy.js DEFAULT_BASE')[1];
need(/process\.env\.COMFY_URL/.test(SRC.comfy), 'comfy.js 没有 COMFY_URL 入口');
const COMFY_TIMEOUT_MS = Number(grab(SRC.comfy, /process\.env\.COMFY_TIMEOUT_MS \|\| (\d+)/, 'comfy.js 超时默认值')[1]);
const PROBE_TTL_MS = Number(grab(SRC.comfy, /const PROBE_TTL = (\d+)/, 'comfy.js PROBE_TTL')[1]);
need(/COMFY_WS/.test(SRC.comfy), 'comfy.js 没有 COMFY_WS 开关');
const PING_PATH = grab(SRC.comfy, /call\('(\/system_stats)'/, 'comfy.js ping 路径')[1];

const PORT = Number(grab(SRC.launch, /parsePort\(value = '(\d+)'\)/, 'launch.mjs default PORT')[1]);
const HOST = grab(SRC.serve, /process\.env\.HOST \|\| '([^']+)'/, 'serve.mjs HOST')[1];

const CORS = {};
for (const m of SRC.app.matchAll(/res\.setHeader\('(Access-Control-[^']+)', '([^']*)'\)/g)) CORS[m[1]] = m[2];
need(CORS['Access-Control-Allow-Origin'] === '*', 'CORS 允许来源不是 *');

const STATUS_MAP = {};
// 同一三元分支的所有 e.code 比较都映射到该状态，而不只抓最后一项。
for (const m of SRC.app.matchAll(/((?:e\.code === '[A-Z0-9_]+'(?:\s*\|\|\s*)?)+)\s*\?\s*(\d{3})/g)) {
  for (const code of m[1].matchAll(/'([A-Z0-9_]+)'/g)) STATUS_MAP[code[1]] = Number(m[2]);
}
for (const m of SRC.app.matchAll(/new HttpError\(\s*(\d{3}),\s*'([A-Z0-9_]+)'/g)) STATUS_MAP[m[2]] = Number(m[1]);
for (const src of [SRC.h3, SRC.canvasbuilder]) {
  for (const m of src.matchAll(/code: '([A-Z0-9_]+)', status: (\d{3})/g)) STATUS_MAP[m[1]] = Number(m[2]);
}
const QUALITY_STATUS = Number(grab(SRC.quality, /function error\([^\n]+\{ code, status: (\d{3}), detail \}/, '质量准入错误状态')[1]);
const QUALITY_CODES = uniq([...SRC.quality.matchAll(/(?:error\(|code:\s*)'(QUALITY_[A-Z0-9_]+)'/g)].map((m) => m[1]));
for (const code of QUALITY_CODES.filter((c) => c !== 'QUALITY_VRAM_UNKNOWN')) STATUS_MAP[code] = QUALITY_STATUS;
need(QUALITY_STATUS === 422 && STATUS_MAP.JOB_NOT_FOUND === 404 && STATUS_MAP.JOB_NOT_ENHANCEABLE === 409, '错误状态映射与代码不符');
STATUS_MAP.DEFAULT = Number(grab(SRC.app, /const status = e\.status \|\| \([^\n]+:\s*(5\d{2})\);/, '错误默认状态码')[1]);
const ERROR_CODES = uniq([
  ...Object.keys(STATUS_MAP).filter((c) => c !== 'DEFAULT'),
  ...[...POOL.matchAll(/(?:new (?:JobError|ComfyError)\(|\bcode:\s*|\bcode\s*=\s*)'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]),
  ...RECONNECT_CODES, ...NON_RETRYABLE,
]).filter((c) => c !== 'QUALITY_VRAM_UNKNOWN').sort();

/* ── 4. spec 数据 ─────────────────────────────────────── */
const REG = json(F.registry);
const CAT = json(F.catalog);
const RULES = json(F.rules);

const stageCounts = REG.stages.map((s) => ({ id: s.id, name: s.name, count: REG.params.filter((p) => p.stage === s.id).length }));
need(stageCounts.reduce((a, s) => a + s.count, 0) === REG.params.length, '板块参数数之和与注册表总数不符');

const devices = CAT.devices.map((d) => ({
  id: d.id,
  name: d.name,
  vram_mib: d.vram_total_mib,
  usable_mib: d.usable_mib,
  usable_ratio: +(d.usable_mib / d.vram_total_mib).toFixed(3),
  watts: d.watts,
  price_yuan_per_kwh: d.price_yuan_per_kwh,
  provenance: d.provenance,
}));

/* ── 5. 路由契约注解（缺一条就失败）───────────────────── */
const qualityPolicy = json(F.qualitySpec);
const H3_NATIVE_FPS = Number(grab(SRC.quality, /const native = o\.engine === 'minimax_h3' \? (\d+) : requested;/, 'H3 原生帧率')[1]);
const WAN_DEFAULT_FPS = Number(grab(SRC.quality, /o\.native_fps == null \? \(output === 60 \? (\d+) : output\)/, 'Wan 默认原生帧率')[1]);
need(qualityPolicy.fps.native.includes(WAN_DEFAULT_FPS) && qualityPolicy.engine_overrides.minimax_h3.native_fps === H3_NATIVE_FPS, '帧率策略与实现漂移');
need(/return \{ needed: estimate\.vram\.ratio > 1, options: \[\], mode: 'quality_first', reason:/.test(SRC.app), 'degrade 不再是质量优先空方案响应');
need(/Q\.assertAllowed\(built\.quality\)/.test(SRC.app) && /Q\.assertWorkflow\(b\.workflow\)/.test(SRC.app), '提交前缺少质量准入校验');
const FPS_NOTE = `默认输出 ${qualityPolicy.fps.output_default}fps：Wan 原生 ${WAN_DEFAULT_FPS}fps，H3 原生固定 ${H3_NATIVE_FPS}fps；目标高于原生时由独立 RIFE 后处理插帧`;
const PLAN_KEYS = ['workflow', 'quality', 'prompt', 'values'];
const H3_PLAN_KEYS = [...PLAN_KEYS, 'meta', 'applied', 'unapplied', 'risk', 'warnings', 'ready', 'note'];
const ROUTE_META = {
  'GET /api/health': {
    purpose: '服务健康：版本、node/平台、pid、运行时长、ComfyUI 可达性与模式、注册表/规则/目录统计、磁盘、队列',
    responseKeys: ['ok', 'service', 'version', 'node', 'platform', 'arch', 'pid', 'uptime_sec', 'provider', 'comfy', 'registry', 'rules', 'catalog', 'gpu', 'disk', 'jobs'],
    notes: '每次请求 force 探测 provider；comfy provider 或配置 COMFY_URL 时才探测 ComfyUI。provider.degraded 表示真实后端不可达，不会据此把任务切成 mock',
  },
  'GET /api/devices': {
    purpose: '设备档位表：显存/可用/功耗/来源 + 每档默认参数估算与 verdict（首次请求后缓存）',
    responseKeys: ['base', 'devices', 'count', 'tiers', 'probe'],
    notes: '档位估算基于默认参数并缓存；probe 为独立本机读数，?fresh=1/true 强制刷新，tier_suggestion 只是建议、不自动确认设备档位',
  },
  'GET /api/params': {
    purpose: '参数注册表：按 stage 分组，支持 ?stage=<id> 过滤',
    responseKeys: ['version', 'total', 'counts', 'tiers', 'stages'],
    notes: '总 258 个参数；板块顺序与分层定义（L0–L4）来自 spec/params.registry.json',
  },
  'POST /api/estimate': {
    purpose: '解析参数并估算显存/耗时/质量/成本，返回 warnings 与 trace',
    responseKeys: ['device', 'estimate', 'warnings', 'trace', 'values'],
    sampleBody: { device: 'T0', values: {} },
    notes: 'estimate 内含 vram/time/quality/cost/dims；未知档位 → 400 BAD_DEVICE',
  },
  'POST /api/degrade': {
    purpose: '质量优先预算提示：needed 表示当前估算超出显存预算，不提供降质方案',
    responseKeys: ['needed', 'options', 'mode', 'reason'],
    sampleBody: { device: 'T0-low', values: {} },
    notes: 'mode=quality_first，options 恒为空数组；不自动降低分辨率、步数或量化。生成准入失败返回 422，而不是自动降档',
  },
  'POST /api/workflow/compile': {
    purpose: '编译预览：参数落到哪些节点、哪些未绑定；不建任务、不投递 ComfyUI',
    responseKeys: ['provider', 'stats', 'synthetic', 'workflow', 'applied', 'merged', 'unbound', 'warnings'],
    sampleBody: { values: {} },
    notes: '未传 template 时 synthetic=true（只有合成工作流），真实执行会以 WF_SYNTHETIC_TEMPLATE 失败',
  },
  'POST /api/jobs': {
    purpose: '创建任务：返回 202 与受理时刻的 queued 快照（调度器随后会把它推进 running）',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: { engine: 'wan22', prompt: '远山云海，固定镜头', tier: '720p', output_fps: 60 },
    expectedStatus: 202,
    notes: `engine=wan22/minimax_h3 编译本地图并经质量准入；不足显存/禁用权重等返回 422，不降尺寸。${FPS_NOTE}。ComfyUI 不可达则持久排队重连；仅显式 mock 模式模拟进度`,
  },
  'GET /api/jobs': {
    purpose: '任务列表：按创建时间倒序，支持 ?state=、?status=、?active=1 与 ?limit=（1–500，默认 50）',
    responseKeys: ['jobs', 'stats'],
    notes: '列表项走 publicView；隐藏 values/valueSnapshot/canvasSnapshot/workflow/template/cineReport，附 valuesCount/canRetry/cine；status 为 pending/running/done/failed',
  },
  'GET /api/jobs/:id': {
    purpose: '任务详情：完整持久任务、canRetry 与 events_url，含原生产物和独立增强状态',
    responseKeys: DETAIL_FIELDS,
    notes: '未知 id → 404 JOB_NOT_FOUND；直接返回 jobs.get 的全量字段，不经过 publicView，故不附 valuesCount/cine；运行期追加字段按任务阶段出现',
  },
  'POST /api/jobs/:id/cancel': {
    purpose: '取消任务：queued 立即 canceled；running 只发中断请求，等当前节点返回',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: {},
    notes: '已是终态再取消 → 409 JOB_NOT_CANCELABLE；真实执行时调 ComfyUI /interrupt（全局中断）',
  },
  'POST /api/jobs/:id/retry': {
    purpose: '按原任务快照重新排队失败或取消任务，返回受理快照',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: {},
    expectedStatus: 202,
    notes: '仅 failed/canceled 且无活跃 worker 可重试，否则 409 JOB_NOT_RETRYABLE；保留可复用远端结果，取消或指定执行错误会清除旧提交信息',
  },
  'GET /api/jobs/:id/events': {
    purpose: 'SSE：snapshot → state/log/progress/cine/enhancement 事件 → done；15s 心跳注释行',
    responseKeys: SSE_EVENTS,
    notes: `Content-Type ${SSE_CONTENT_TYPE}；终态任务发完 snapshot+done 立即关闭；未知 id → 404`,
    sse: true,
  },
  'GET /api/jobs/:id/output': {
    purpose: '成片发射：流式发射任务记录的 output 产物（video/mp4），供小白向导预览与作品库下载',
    responseKeys: [],
    notes: '二进制流非 JSON；只发 provider 产物路径（非用户输入）；无产物（mock 演示/未完成）→ 404 NO_OUTPUT；文件已清理 → 404 OUTPUT_MISSING；未知 id → 404 JOB_NOT_FOUND',
    stream: true,
  },
  'POST /api/jobs/:id/pick': {
    purpose: '电影管线选优窗口内的人工改选：8 组就绪后 windowMs 内可改选某一组作为 i2v 源',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: { index: 1 },
    notes: '非 cine / 非 running / 窗口已关 / 已改选 → 409 JOB_NOT_PICKABLE；序号越界 → 400 BAD_PICK；index 为 0 基候选序号',
  },
  'POST /api/jobs/:id/review': {
    purpose: '审核复核队列：人工对某条 QAReport（cineReport.audit[]）改判 PASS/REJECT，留痕 reviewer/reason/retryHistory',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: { auditId: 'qa_xxx', decision: 'PASS', reason: '人工目视确认无穿帮' },
    notes: '找不到审核报告 → 404 AUDIT_NOT_FOUND；decision 非 PASS/REJECT → 400 BAD_REVIEW；改判写回 job.cineReport.audit 并发 cine-review 事件',
  },
  'GET /api/jobs/:id/candidates/:n': {
    purpose: '候选关键帧发射：流式发射第 n 组候选 PNG（image/png），供向导直播网格与作品库回放点选',
    responseKeys: [],
    notes: '二进制流非 JSON；只发任务自己记录的候选文件路径（provider 产物，非用户输入）；无该组 → 404 NO_CANDIDATE；文件已清理 → 404 CANDIDATE_MISSING；未知 id → 404 JOB_NOT_FOUND',
    stream: true,
  },
  'POST /api/recommend': {
    purpose: 'AI 参数推荐（双轨）：有 DASHSCOPE_API_KEY 走 Qwen，无 key/失败显式降级规则推荐（source=rules），返回三层补丁 + 258 键求解值 + 四向估算',
    responseKeys: ['source', 'model', 'preset', 'reason', 'core', 'common', 'advanced_overrides', 'values', 'device', 'estimate', 'warnings', 'muse_level', 'ai', 'invalid_keys'],
    sampleBody: { prompt: '黑白高反差，雕塑感人物，强烈侧光', device: 'T0', values: {} },
    notes: '未知档位 → 400 BAD_DEVICE；muse_level.provenance=estimate（质量分/10，非实测）；ai.attempted/ai.error 说明降级原因，不伪装 AI 输出',
  },
  'GET /api/capability': {
    purpose: '逆向能力包与 Seedream provider 探测结果',
    responseKeys: ['schema', 'version', 'updated', 'target', 'tiers', 'abilities', 'provider'],
    notes: '能力来自 spec/reverse.capabilities.json；provider 探测每次强制刷新',
  },
  'POST /api/capability/image': {
    purpose: 'Seedream 图像能力同步执行；dryRun 只返回编译载荷，不进入视频任务队列',
    responseKeys: ['ability', 'dry_run', 'payload', 'prompt', 'cost_cny_est', 'images', 'output', 'warnings'],
    sampleBody: { dryRun: true, values: {} },
    notes: 'ability 缺省取能力表第一项；未知能力 400 SR_BAD_ABILITY，密钥错误 400，连接/超时错误 502，其余执行错误 500',
  },
  'GET /api/visinter': {
    purpose: 'VisInter 双模式管线、预设、提示词与自检规格',
    responseKeys: ['schema', 'version', 'updated', 'pipeline', 'modes', 'presets', 'resolutions', 'risk_rules', 'risk_thresholds', 'linkage', 'prompts', 'selfcheck', 'banner', 'provenance'],
    notes: '只返回规格，不生成；风险提示不代表通过本地视频提交的质量准入',
  },
  'POST /api/visinter/plan': {
    purpose: '组装 novice/expert 参数计划、角色提取与风险提示',
    responseKeys: ['mode', 'mode_label', 'subject', 'subject_detail', 'values', 'applied', 'skipped', 'linkage', 'character', 'risks', 'submit_allowed', 'risk_count', 'provenance', 'banner'],
    sampleBody: { text: '远山云海，固定镜头', mode: 'novice', values: {}, manualKeys: [] },
    notes: '未知模式 400 BAD_MODE；角色提取结果可手改，提取失败记入 character.error；submit_allowed 是提示层标记，不绕过生成质量校验',
  },
  'POST /api/visinter/selfcheck': {
    purpose: '检查 ComfyUI 基础节点、人脸节点与模型是否齐备',
    responseKeys: ['at', 'models_dir', 'shots', 'status', 'provenance', 'reason', 'comfy', 'layers', 'models', 'missing', 'node_missing', 'landscape_ok', 'ran', 'report'],
    sampleBody: { run: false },
    notes: 'status/provenance 为 fail/inferred/measured；不可达分支不含 node_missing；当前 HTTP handler 未注入 buildWorkflow，run=true 不会伪报跑图成功',
  },
  'GET /api/h3/status': {
    purpose: '本地 H3 通道探测、模板、质量采样约束、显存预算与并发建议',
    responseKeys: ['comfy', 'template', 'constraints', 'concurrency', 'vram_budget'],
    notes: `H3 原生 ${H3_NATIVE_FPS}fps；帧数 17k+5（124–362）、尺寸步长32、turbo=false；并发预算仅建议，实际提交仍走质量准入`,
  },
  'POST /api/h3/plan': {
    purpose: 'H3 本地工作流与质量准入预览，不创建任务',
    responseKeys: H3_PLAN_KEYS,
    sampleBody: { prompt: '远山云海，固定镜头', tier: '720p', seconds: 5, output_fps: 60 },
    notes: `返回 quality.ok/errors；显存不足可返回计划供检查，生成时必须通过准入。非法帧数/参数返回 422，不自动减少尺寸或帧数。${FPS_NOTE}`,
  },
  'POST /api/jobs/plan': {
    purpose: '按 wan22/minimax_h3 编译本地执行图与质量准入预览，不创建任务',
    responseKeys: uniq([...H3_PLAN_KEYS, 'graph', 'mapped_nodes', 'save_latent']),
    sampleBody: { engine: 'wan22', prompt: '远山云海，固定镜头', tier: '720p', seconds: 5, output_fps: 60 },
    notes: `未知/缺少 engine → 400 BAD_ENGINE；空提示词 → 400 ENGINE_EMPTY_PROMPT。共同字段 workflow/quality/prompt/values；Wan 另含 graph/mapped_nodes/save_latent/note，H3 另含 meta/applied/unapplied/risk/warnings/ready/note。quality.errors 报显存不足，非法参数返回 422，不降尺寸。${FPS_NOTE}`,
  },
  'POST /api/h3/(?:run|direct)': {
    purpose: 'H3 run/direct 两个别名统一通过持久化任务队列提交',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: { prompt: '远山云海，固定镜头', tier: '720p', seconds: 5, output_fps: 60 },
    expectedStatus: 202,
    notes: `返回 queued 任务快照，不再直接返回 prompt_id；质量准入失败 → 422。${FPS_NOTE}`,
  },
  'POST /api/jobs/:id/enhance': {
    purpose: '为已归档原生视频排队独立增强，失败时仅重试后处理',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: {},
    expectedStatus: 202,
    notes: '需 succeeded 且 pure_output 文件存在，否则 409 JOB_NOT_ENHANCEABLE；enhancement 为 queued/running/done 时幂等返回；增强失败不改原生任务终态或丢失纯净产物',
  },
  'GET /api/h3/job/:id': {
    purpose: '按 ComfyUI prompt ID 查询旧 H3 直连任务历史',
    responseKeys: ['done', 'state', 'images', 'status'],
    notes: '不是平台 job ID；历史不存在时仅返回 done=false/state=running_or_queued，完成后附 images/status',
  },
  'POST /api/h3/upscale': {
    purpose: 'H3 兼容入口：通过 job_id 排队同一独立增强流水线',
    responseKeys: PUBLIC_FIELDS,
    sampleBody: { job_id: 'job_example' },
    expectedStatus: 202,
    notes: '缺少 job_id → 422 ENHANCE_JOB_REQUIRED；不是按任意文件路径同步缩放；任务前置条件同 /api/jobs/:id/enhance',
  },
  'GET /api/quality': {
    purpose: '质量策略、分辨率档位、采样/帧率约束与当前显存可行性估算',
    responseKeys: ['mode', 'modes', 'tiers', 'sampling', 'fps', 'scoring', 'forbid', 'usable_mib', 'note'],
    notes: `策略来自 spec/quality.json；tiers.required_mib 是估算，无显存读数时 feasible=null；不足显存返回 422，不自动降低分辨率/步数。${FPS_NOTE}`,
  },
  'GET /api/works/preview': {
    purpose: '按 ?file= 文件名读取归档成片目录的视频流',
    responseKeys: [],
    notes: '二进制 video/mp4，输入先取 basename；路径越界 400 WORKS_BAD_PATH，文件缺失 404 WORKS_NO_FILE',
    stream: true,
  },
  'POST /api/ultimate/score': {
    purpose: '仅评分任务已归档的原生纯净视频，返回四维目标与细节/时序指标',
    responseKeys: ['file', 'meta', 'sample_kind', 'frames', 'size', 'resolution', 'native_fps', 'output_fps', 'detail_score', 'temporal_stability_score', 'scores', 'F', 'weights', 'detail', 'cv', 'provenance', 'not_measured', 'note', 'source_job'],
    sampleBody: { job_id: 'job_example' },
    notes: '接受 job_id 或匹配列表中 pure_output 的 file；无原生产物 → 422 SCORE_NATIVE_REQUIRED，未知 job_id → 404。output_fps 仅来自已生成 enhanced，否则 null；目标只有 Sface/Sflow/Sstyle/Sbad，细节为规则代理，不宣称参考图保真度',
  },
  'GET /api/works': {
    purpose: '归档作品列表与成片目录',
    responseKeys: ['works', 'dir'],
    notes: '?limit=1–100，默认20；内容来自 archive.recent()',
  },
  'GET /api/h3/preview': {
    purpose: '按 ?file= 相对路径读取 ComfyUI/output 中的视频流',
    responseKeys: [],
    notes: '二进制 video/mp4；路径越界 400 H3_BAD_PATH，文件缺失 404 H3_NO_FILE',
    stream: true,
  },
  'GET /api/models': {
    purpose: '本地模型下拉列表：真源 spec/model.configs.json，附 provider 探测结果与默认模型/产物目录',
    responseKeys: ['provider', 'default', 'models', 'paid_video_models', 'output_dir'],
    notes: '每次请求 force 探测 provider；models 各项 id/label/paid=false/provider=comfy/kind，paid_video_models=[]；output_dir 未配置时为 null',
  },
  'GET /api/muse-presets': {
    purpose: 'Muse 预设叠加层：不改 258 参数结构，前端 http 模式取这份，file:// 模式用构建期内联的 __MUSE',
    responseKeys: ['schema', 'version', 'core_keys', 'layers', 'presets'],
    notes: '内容即 spec/muse.presets.json（4 个预设）；pickPreset 按关键词命中挑选，style 显式指定时优先',
  },
  'GET /api/aesthetics': {
    purpose: '氛围审美层：8 题材配方(场景/光影/色调/镜头/质感/参数/负面/声音情绪/画幅) + 可拼接词库；前端 http 取这份，file:// 用内联 __AESTH',
    responseKeys: ['version', 'note', 'words', 'themes'],
    notes: '内容即 spec/aesthetics.json；matchTheme 按关键词命中挑题材；params 为请求口径(sampler/CFG/步数/HD applicable:false)，分辨率/画幅真生效',
  },
  'POST /api/presets/export': {
    purpose: '导出预设：只保留与默认不同的值，附 djb2 checksum 与注册表版本',
    responseKeys: ['schema', 'format', 'registry_version', 'name', 'author', 'device', 'created', 'checksum', 'values'],
    sampleBody: { meta: { name: 'server-console', author: 'local' } },
    notes: '不传 values 时用全量默认值（导出结果通常接近空 values）',
  },
  'POST /api/presets/import': {
    purpose: '导入预设：校验 schema 与 registry_version，返回 values/unknown/checksum_ok 与告警',
    responseKeys: ['values', 'unknown', 'checksum_ok', 'warnings'],
    sampleBody: { preset: { schema: 'ai-video-platform/preset', format: 1, registry_version: '0.1.0', name: 'server-console 示例', values: {} } },
    notes: 'schema 不符 → 400 BAD_PRESET；registry_version 不符由 engine 抛普通 Error → 500 INTERNAL（现状）；checksum 不符只返回 checksum_ok=false',
  },
  'GET /': {
    purpose: '服务自述：版本、路由清单（method + path）与文档路径',
    responseKeys: ['service', 'version', 'endpoints', 'entry', 'static_note', 'docs'],
    notes: '路径末尾斜杠会被剥掉（/api/health/ 等价 /api/health）',
  },
};

const seen = new Set();
const routes = parsedRoutes.map((r) => {
  const key = `${r.method} ${r.path}`;
  need(!seen.has(key), `重复路由 ${key}`);
  seen.add(key);
  const meta = ROUTE_META[key];
  need(meta, `路由 ${key} 没有契约注解：请在 tools/snap_server.mjs 的 ROUTE_META 里补上`);
  if (meta.expectedStatus !== undefined) need(r.status === meta.expectedStatus, `${key} 成功状态码应为 ${meta.expectedStatus}，实际 ${r.status}`);
  for (const k of meta.responseKeys || []) {
    if (meta.sse) continue;
    const leaf = k.split('.').pop();
    // 允许 `key: value`、`key,`（对象简写）与 JSON 的 `"key":`（响应本体是 spec JSON 时）
    const inBlock = new RegExp(`(^|[^A-Za-z0-9_])${leaf}["']?\\s*[:,}]`).test(r.block);
    const inPool = new RegExp(`(^|[^A-Za-z0-9_])${leaf}["']?\\s*[:,}]`).test(POOL);
    // 持久任务的部分字段以 job.key = value 追加，而非对象字面量；只接受已从源码提取的任务字段。
    const inJob = (meta.responseKeys === PUBLIC_FIELDS || meta.responseKeys === DETAIL_FIELDS) && JOB_FIELDS.includes(k);
    need(inBlock || inPool || inJob, `${key} 的响应键 ${k} 在源码里找不到`);
  }
  return {
    method: r.method,
    path: r.path,
    status: r.status,
    purpose: meta.purpose,
    pathParams: [...r.path.matchAll(/\/:([a-zA-Z_]+)/g)].map((m) => m[1]),
    sampleBody: meta.sampleBody === undefined ? null : meta.sampleBody,
    responseKeys: meta.responseKeys,
    notes: meta.notes || '',
    sse: !!meta.sse,
  };
});
for (const key of Object.keys(ROUTE_META)) need(seen.has(key), `ROUTE_META 里的 ${key} 在 app.js 里已不存在`);

/* ── 6. 环境变量表（名字必须在源码里出现过）────────────── */
const envVars = [
  { name: 'PORT', default: String(PORT), where: 'tools/serve.mjs', effect: 'HTTP监听端口；HTTP页面使用当前origin，启动器发现并复用现有后端' },
  { name: 'HOST', default: HOST, where: 'tools/serve.mjs', effect: '监听地址（默认仅本机）' },
  { name: 'COMFY_URL', default: COMFY_BASE, where: 'server/comfy.js', effect: 'ComfyUI 基址' },
  { name: 'COMFY_TIMEOUT_MS', default: String(COMFY_TIMEOUT_MS), where: 'server/comfy.js', effect: 'ComfyUI 请求超时' },
  { name: 'COMFY_WS', default: '未设=启用', where: 'server/comfy.js', effect: '设为 0 强制轮询进度（无真实百分比）' },
  { name: 'AVP_MOCK_MS', default: String(MOCK_MS), where: 'server/jobs.js', effect: 'mock 任务十步走完的总时长' },
  { name: 'AVP_CONCURRENCY', default: String(CONCURRENCY), where: 'server/jobs.js', effect: '并发执行任务数' },
  { name: 'AVP_RECONNECT_MS', default: String(RECONNECT_MS), where: 'server/jobs.js', effect: 'ComfyUI 连接恢复与允许的自动重试等待间隔' },
  { name: 'CACHE_ROOT', default: CACHE_ROOT, where: 'server/jobs.js', effect: '任务落盘根目录（avp/jobs）' },
];
for (const e of envVars) need(new RegExp(`\\b${e.name}\\b`).test(POOL), `环境变量 ${e.name} 在源码里找不到`);

/* ── 7. 组装 ─────────────────────────────────────────── */
const snapshot = {
  schema: 'ai-video-platform/server-snapshot@1',
  generatedAt: new Date().toISOString(),
  generator: 'tools/snap_server.mjs',
  source: '静态解析 server/*.js、tools/serve.mjs、spec/*.json（不连接后端）',
  version: PKG_VERSION,
  service: {
    name: 'ai-video-platform backend',
    version: PKG_VERSION,
    healthPath: '/api/health',
    cors: CORS,
    maxBodyBytes: MAX_BODY,
    maxBodyLabel: '4MB（app.js MAX_BODY）',
  },
  server: {
    port: PORT,
    host: HOST,
    baseUrl: `http://${HOST}:${PORT}`,
    start: 'node tools/serve.mjs',
    envVars,
  },
  comfy: {
    base: COMFY_BASE,
    env: 'COMFY_URL',
    defaultBase: COMFY_BASE,
    pingPath: PING_PATH,
    pingTimeoutMs: 2500,
    probeTtlMs: PROBE_TTL_MS,
    timeoutMs: COMFY_TIMEOUT_MS,
    modes: ['live', 'mock'],
    mockNote: '仅显式 mock provider/AVP_ALLOW_MOCK=1 模拟进度（mock:true）；ComfyUI 不可达不会自动切换 mock，任务保存后等待重连',
  },
  routes,
  stateMachine: {
    states: STATES,
    terminal: TERMINAL,
    transitions: TRANSITIONS,
    retry: {
      maxAttempts: MAX_ATTEMPTS, nonRetryableCodes: NON_RETRYABLE,
      reconnectCodes: RECONNECT_CODES, reconnectMs: RECONNECT_MS,
      note: 'ComfyUI 连接错误（无 HTTP 状态或 >=500）持久排队重连，不受 maxAttempts 限制；普通自动重试仅非 comfy/cine、未提交任务且错误可重试；人工 retry 仅 failed/canceled',
    },
    bootRecovery: {
      from: [recovery[2], recovery[1]], to: recovery[4], canceledTo: recovery[3],
      note: '服务重启恢复落盘任务并重新调度；保留远端提交信息用于续接，已有取消意图的任务恢复为 canceled；增强队列独立恢复',
    },
  },
  jobs: {
    statsFields: STATS_FIELDS,
    fields: PUBLIC_FIELDS,
    detailFields: DETAIL_FIELDS,
    dir: JOBS_DIR,
    cacheRoot: CACHE_ROOT,
    concurrency: CONCURRENCY,
    mockMs: MOCK_MS,
    maxAttempts: MAX_ATTEMPTS,
    defaultDevice: 'T0',
    listDefaultLimit: 50,
    listMaxLimit: 500,
    sse: {
      urlTemplate: '/api/jobs/:id/events',
      events: SSE_EVENTS,
      heartbeatMs: SSE_HEARTBEAT_MS,
      contentType: SSE_CONTENT_TYPE,
    },
  },
  catalog: {
    version: CAT.version,
    count: devices.length,
    devices,
    note: '设备档位来自 spec/models.catalog.json；可用率 = usable_mib / vram_total_mib',
  },
  registry: {
    version: REG.version,
    params: REG.counts.total,
    l3: REG.counts.l3,
    l4: REG.counts.l4,
    updated: REG.updated,
    stages: stageCounts,
    tiers: REG.tiers,
  },
  rules: { version: RULES.version, count: RULES.rules.length },
  errors: {
    shape: '{ error: { code, message, detail, hint?, stack? } }',
    statusMap: STATUS_MAP,
    codes: ERROR_CODES,
    notes: '5xx 额外带 error.stack 前 4 行；404 兜底 NOT_FOUND',
  },
  limits: {
    maxBodyBytes: MAX_BODY,
    note: 'body 超过上限 → 413 BODY_TOO_LARGE；非 JSON → 400 BAD_JSON',
  },
  provenance: Object.values(F).map((p) => rel(path.join(ROOT, p))),
};

const target = path.join(ROOT, 'server', 'snapshot.json');
const text = JSON.stringify(snapshot, null, 2) + '\n';
fs.writeFileSync(target, text, 'utf8');

const kb = (Buffer.byteLength(text) / 1024).toFixed(1);
console.log(
  `${C.bold}[snap_server]${C.reset} ${routes.length} 路由 · ${STATES.length} 状态 · ${devices.length} 设备档 · ` +
  `${REG.counts.total} 参数 · ${RULES.rules.length} 规则 → ${C.green}${rel(target)}${C.reset} ${C.dim}${kb}KB${C.reset}`
);