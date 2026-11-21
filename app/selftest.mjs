/**
 * selftest.mjs —— 外壳的自检：静态读产物 + 真跑状态机。
 *
 * 为什么静态断言也要做：
 *   内联构建最典型的翻车方式是"占位符替换成功但内容丢了"——页面照样能打开，
 *   只是所有数字变成 NaN。这类问题只有把"产物里必须出现的字符串"钉死才拦得住。
 *
 * 为什么状态机要 here 真跑而不是只读源码：
 *   状态机的价值全在"非法路径被拒绝"，这件事必须用真实调用证明，
 *   打印出来的 from→to 是真的算出来的，不是从注释里抄的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const kb = (n) => (n / 1024).toFixed(1) + 'KB';

let pass = 0, fail = 0;
const fails = [];

function ok(label, detail) {
  pass++;
  console.log('  ✔ ' + label + (detail ? '  ·  ' + detail : ''));
}
function bad(label, detail) {
  fail++;
  fails.push(label + (detail ? ' — ' + detail : ''));
  console.log('  ✘ ' + label + (detail ? '  ·  ' + detail : ''));
}
function assert(label, cond, detail) {
  if (cond) ok(label, detail); else bad(label, detail);
}
function group(name) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(2, 58 - name.length)));
}

/* ═════════════ 一、产物静态断言 ═════════════ */
const sourceOnly = process.argv.includes('--source');
const html = read(sourceOnly ? 'app/index.src.html' : 'app/index.html');
if (!sourceOnly) {
group('静态：app/index.html');

const HTML = path.join(ROOT, 'app', 'index.html');
if (!fs.existsSync(HTML)) {
  bad('产物存在', 'app/index.html 不存在，先跑 node tools/build_app.mjs');
  console.log('\n未通过：产物缺失');
  process.exit(1);
}
const size = Buffer.byteLength(html);
console.log('  产物 ' + kb(size) + ' · 行数 ' + html.split('\n').length);

assert('内联 window.__REG（参数注册表）', /window\.__REG\s*=\s*\{/.test(html));
assert('内联 window.__CATALOG（设备/模型目录）', /window\.__CATALOG\s*=\s*\{/.test(html));
assert('内联 window.__RULES（联动规则）', /window\.__RULES\s*=\s*\{/.test(html));

// engine / state 都是 UMD：Node 走 module.exports，浏览器走 root(=window) 挂载。
// 断言源码里的真实特征，而不是我们期望它长什么样。
const engineMarks = ['root.AVP = api', 'function estimate(', 'function applyPreset(', 'function degrade(', 'function resolve('];
const engineMiss = engineMarks.filter((m) => html.indexOf(m) < 0);
assert('内联 engine（AVP 挂载 + 四个核心函数）', engineMiss.length === 0, engineMiss.length ? '缺 ' + engineMiss.join(' / ') : engineMarks.length + ' 个特征全中');
assert('内联状态机（root.AVP_STATE 挂载）', html.indexOf('root.AVP_STATE = api') >= 0);

assert('静态文案「参数 258」出现', html.indexOf('参数 258') >= 0, '用于首屏统计对齐注册表');

const NAVS = ['nav-workbench', 'nav-params', 'nav-canvas', 'nav-inspector', 'nav-market', 'nav-plugins', 'nav-quality', 'nav-server'];
const navMiss = NAVS.filter((id) => html.indexOf('id="' + id + '"') < 0);
assert('8 个导航项 id 齐全', navMiss.length === 0 && NAVS.length === 8, navMiss.length ? '缺 ' + navMiss.join(', ') : NAVS.length + '/8');

const WIZ = [
  ['id="wiz-step-1"', 'data-step="1"'],
  ['id="wiz-step-2"', 'data-step="2"'],
  ['id="wiz-step-3"', 'data-step="3"'],
];
const wizMiss = [];
WIZ.forEach((pair, i) => pair.forEach((m) => { if (html.indexOf(m) < 0) wizMiss.push('第' + (i + 1) + '屏 ' + m); }));
assert('3 屏向导锚点存在', wizMiss.length === 0, wizMiss.length ? '缺 ' + wizMiss.join(' / ') : '3/3 屏 + 步骤条');

const ext = html.match(/(?:src|href)\s*=\s*["']https?:|url\(\s*["']?https?:/gi) || [];
assert('无外链 http(s) 资源', ext.length === 0, ext.length ? ext.slice(0, 3).join(' ') : '0 处（零外部字体/图标/脚本）');
assert('零外部样式表', (html.match(/<link[^>]+stylesheet/gi) || []).length === 0);
assert('单脚本内联（script 标签数）', (html.match(/<script/gi) || []).length === 1, (html.match(/<script/gi) || []).length + ' 个');

assert('体积 < 480KB', size < 480 * 1024, kb(size) + ' / 480.0KB');

/* ── 服务桥：把「渲染中」接到本地队列的那一段，必须可静态验证 ──
   为什么要在自检里锁死：这段代码最容易在"体验优化"里被改成乐观更新
   （点一下就自动跳审片）。锁住接口存在与状态由任务结果推进；基址在源件模式也验证。 */
group('静态：服务桥');
const svcApi = ['/api/health', "'/api/jobs'", "'/api/jobs/'", "'/cancel'"];
const svcMiss = svcApi.filter((s) => html.indexOf(s) < 0);
assert('健康/提交/查询/取消四个特征都在', svcMiss.length === 0, svcMiss.length ? '缺 ' + svcMiss.join(' / ') : svcApi.length + ' 个全中');
assert('任务成功后才推进状态（onJobFinished 内 apply review）',
  /function onJobFinished\(j\)[\s\S]{0,400}?S\.apply\(project, 'review'/.test(html), '不允许在提交时就跳审片');
assert('失败不自动跳状态（failed 分支只 svcPaint/toast）',
  /if \(j\.state === 'failed'\)[\s\S]{0,300}?return;/.test(html), '失败必须由用户显式「渲染失败退回」');

} else {
  console.log('源件模式：不构建、不校验旧产物；运行源件 DOM/VM 与状态机回归。');
}

group('服务基址：file 回退与 HTTP 同源');
const svcBaseDeclaration = html.match(/var SVC_BASE\s*=[^;]+;/);
assert('SVC_BASE 声明存在', !!svcBaseDeclaration);
if (svcBaseDeclaration) {
  for (const [protocol, origin, expected] of [
    ['file:', 'null', 'http://127.0.0.1:8388'],
    ['http:', 'http://127.0.0.1:9133', 'http://127.0.0.1:9133'],
    ['https:', 'https://localhost:9443', 'https://localhost:9443'],
  ]) {
    const context = { location: { protocol, origin } };
    vm.runInNewContext(svcBaseDeclaration[0], context);
    assert('SVC_BASE ' + protocol + ' 使用正确服务地址', context.SVC_BASE === expected);
  }
}

/* ═════════════ 二、状态机真跑 ═════════════ */
group('状态机：合法迁移（真实调用 AVP_STATE.apply）');

const require_ = createRequire(import.meta.url);
let S;
try {
  S = require_(path.join(ROOT, 'app', 'state.js'));
} catch (e) {
  bad('加载 app/state.js', e.message);
  console.log('\n未通过：状态机加载失败');
  process.exit(1);
}

const VALS = { 'kf.resolution': 1536, 'kf.steps': 24, 'mo.duration': 1.5 };

function fresh(extra) {
  return S.create(Object.assign({ name: '自检项目', values: VALS, summary: { vramState: 'ok' } }, extra || {}));
}

let p = fresh();
console.log('  起点：' + S.stateName(p.state) + '（values ' + Object.keys(p.values).length + ' 项）');
for (const act of ['configure', 'render', 'review', 'export']) {
  const before = p.state;
  try {
    p = S.apply(p, act, { note: 'selftest' });
    ok(act, before + ' → ' + p.state + '（' + p.history[p.history.length - 1].label + '）');
  } catch (e) {
    bad(act, before + ' 抛错：' + e.message);
  }
}
assert('终态 = exported', p.state === 'exported', '历史 ' + p.history.length + ' 条');
assert('history 记录了完整链路', p.history.map((h) => h.action).join('>') === 'configure>render>review>export',
  p.history.map((h) => S.stateName(h.from) + '→' + S.stateName(h.to)).join(' , '));

group('状态机：非法迁移（必须被拒）');

const ILLEGAL = [
  ['draft', 'export', '草稿没有产物却想导出'],
  ['draft', 'review', '草稿直接进审片'],
  ['configured', 'review', '跳过渲染直接审片'],
  ['configured', 'export', '已配置但没有产物就想导出'],
  ['exported', 'render', '已导出还想再渲（应先返工/新起一轮）'],
  ['exported', 'review', '已导出去审片'],
  ['draft', 'render', '草稿没确认配置就开渲'],
];
for (const [state, act, why] of ILLEGAL) {
  const proj = fresh({ state });
  try {
    S.apply(proj, act);
    bad(state + ' --' + act + '-->', '居然通过了（' + why + '）');
  } catch (e) {
    const goodCode = e.code === 'ILLEGAL_TRANSITION';
    assert(state + ' --' + act + '--> 被拒', goodCode, 'code=' + e.code + ' · ' + S.stateName(proj.state) + ' 不允许「' + act + '」');
  }
}

group('状态机：守卫（合法来源但条件不满足）');

{
  const empty = S.create({ name: '空参数项目', values: {}, summary: { vramState: 'ok' } });
  const r = S.can(empty, 'configure');
  assert('空参数集拒绝「确认配置」', !r.ok && r.code === 'NO_VALUES', r.reason);
}
{
  const block = fresh({ state: 'configured', summary: { vramState: 'block' } });
  const r = S.can(block, 'render');
  assert('显存红线拒绝「开渲」', !r.ok && r.code === 'VRAM_BLOCK', r.reason);
}
{
  const half = S.create({ name: '缺关键键', values: { 'sb.grid_count': 24 }, summary: { vramState: 'ok' } });
  const r = S.can(half, 'configure');
  assert('缺 kf.resolution 拒绝「确认配置」', !r.ok && r.code === 'INCOMPLETE_VALUES', r.reason);
}
{
  const okOne = fresh({ state: 'configured', summary: { vramState: 'ok' } });
  const r = S.can(okOne, 'render');
  assert('显存 ok 允许「开渲」', r.ok && r.to === 'rendering', r.reason);
}

group('状态机：序列化往返');

{
  const text = S.serialize(p);
  const back = S.deserialize(text);
  assert('serialize → deserialize 一致', back.state === p.state && back.id === p.id && Object.keys(back.values).length === Object.keys(p.values).length,
    kb(Buffer.byteLength(text)) + ' · ' + S.stateName(back.state) + ' · values ' + Object.keys(back.values).length + ' 项');
}
{
  let caught = null;
  try { S.deserialize('{"schema":"别的项目","state":"draft"}'); } catch (e) { caught = e; }
  assert('拒绝非本平台项目文件', !!caught && /schema/.test(caught.message), caught && caught.message);
}
{
  let caught = null;
  try { S.deserialize(JSON.stringify({ schema: S.PROJECT_SCHEMA, state: '飞升' })); } catch (e) { caught = e; }
  assert('拒绝非法状态值', !!caught && /状态非法/.test(caught.message), caught && caught.message);
}

/* ═════════════ 三、存储降级三档 ═════════════ */
group('存储：full / slim / memory 三档降级（模拟配额）');

/** 假 storage：探测键放行，真实 key 按策略抛 QuotaExceededError */
function fakeStorage(policy) {
  const m = new Map();
  return {
    kind: 'fake',
    failCount: 0,
    setItem(k, v) {
      if (k === '__avp_probe__') { m.set(k, v); return; }
      const shouldFail = policy === 'always' || (policy === 'once' && this.failCount === 0);
      if (shouldFail) {
        this.failCount++;
        const err = new Error('QuotaExceededError: 模拟 localStorage 写满');
        err.name = 'QuotaExceededError';
        throw err;
      }
      m.set(k, String(v));
    },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    removeItem(k) { m.delete(k); },
    raw() { return m; },
  };
}

{
  const st = fakeStorage('never');
  const store = S.createStore({ storage: st });
  const r = store.save(fresh());
  assert('正常配额 → mode=full', r.ok && r.mode === 'full', 'ok=' + r.ok + ' mode=' + r.mode + ' kind=' + store.kind);
  assert('落盘后可 list 出来', store.list().length === 1, '项目数 ' + store.list().length);
}
{
  const st = fakeStorage('once');
  const store = S.createStore({ storage: st });
  const r = store.save(fresh());
  assert('首次写满 → 裁剪后重试成功 mode=slim', r.ok && r.mode === 'slim', 'mode=' + r.mode + ' hint=' + (r.hint || '—').slice(0, 40));
  assert('slim 仍标记 degraded', r.degraded === true);
}
{
  const st = fakeStorage('always');
  const store = S.createStore({ storage: st });
  const r = store.save(fresh());
  assert('始终写不进 → mode=memory（不抛、不假装成功）', !r.ok && r.mode === 'memory', 'mode=' + r.mode + ' error=' + (r.error || '—').slice(0, 40));
  assert('降级给出可操作提示', !!r.hint && r.hint.length > 10, r.hint.slice(0, 52) + '…');
  assert('内存中仍可继续操作', store.load(r.id) !== null && store.load(r.id).state === 'draft');
}
{
  const store = S.createStore({ storage: null }); // 显式无 storage → 走内存后端
  const r = store.save(fresh());
  assert('无 localStorage 环境 → memory 后端不崩', store.kind === 'memory' && r.mode === 'memory', 'kind=' + store.kind);
}

group('三入口：后端任务恢复、互斥与离开行为（VM，无真实提交）');

try {
  const source = { app: html, web: read(sourceOnly ? 'web/params.src.html' : 'web/params.html'), ultimate: read(sourceOnly ? 'ultimate/ultimate.src.html' : 'ultimate/index.html') };
  for (const [name, markup] of Object.entries(source)) {
    for (const [, js] of markup.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(js, { filename: name + '.html' });
    ok(name + (sourceOnly ? ' 源件' : ' 构建产物') + '脚本语法有效');
  }
  const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/i)[1];
  const start = script.search(/\(function \(\) \{\s+var STORE_KEY = 'avp\.shell\.store\.v1';/);
  const end = script.indexOf('\n})();', start);
  if (start < 0 || end < 0) throw new Error('找不到出片模态闭包');
  const clients = {
    app: script.slice(start, end + '\n})();'.length),
    ultimate: source.ultimate.slice(source.ultimate.indexOf('  var scoreJobs ='), source.ultimate.indexOf('  function renderGates()')) + source.ultimate.slice(source.ultimate.indexOf('  var H3 = {'), source.ultimate.indexOf('\n  renderEngines();')),
    web: source.web.slice(source.web.indexOf('  const apiBase ='), source.web.indexOf('  /* ───── 我的预设')) + '\nwindow.testSelect = id => { rememberGen(id); renderGen(serverJobs.find(j => j.id === id)); refreshGenJobs(); }; refreshGenJobs();',
  };
  const ids = {
    app: { go: 'rmGo', prompt: 'rmPrompt', status: 'rmStatus', video: 'rmVideo', retry: 'rmRetry', refresh: 'rmRefresh', history: 'rmWorks', background: 'rmBackground', create: '/api/jobs' },
    ultimate: { go: 'h3-go', prompt: 'h3-prompt', status: 'h3-msg', video: 'h3-video', retry: 'h3-retry', refresh: 'h3-refresh', history: 'h3-history', background: 'h3-background', create: '/api/h3/run' },
    web: { go: 'genBtn', prompt: 'aiPrompt', status: 'genStatus', video: 'genVideo', retry: 'genRetry', refresh: 'genRefresh', history: 'genHistory', background: 'genBackground', create: '/api/jobs' },
  };
  Object.assign(ids.app, { engine: 'rmEngine', tier: 'rmTier', native: 'rmNativeFps', output: 'rmOutputFps', versions: 'rmVersions', enhance: 'rmEnhance', enhanceMsg: 'rmEnhanceMsg', submitError: 'rmSubmitError' });
  Object.assign(ids.web, { engine: 'genEngine', tier: 'genTier', native: 'genNativeFps', output: 'genOutputFps', versions: 'genVersions', enhance: 'genEnhance', enhanceMsg: 'genEnhanceMsg', submitError: 'genSubmitError' });
  Object.assign(ids.ultimate, { tier: 'h3-tier', native: 'h3-native-fps', output: 'h3-output-fps', versions: 'h3-versions', enhance: 'h3-enhance', enhanceMsg: 'h3-enhance-msg', submitError: 'h3-submit-error' });
  Object.assign(ids.app, { custom: 'rmCustomSize', width: 'rmWidth', height: 'rmHeight', runtime: 'rmRuntime' });
  Object.assign(ids.web, { custom: 'genCustomSize', width: 'genWidth', height: 'genHeight', runtime: 'genRuntime' });
  Object.assign(ids.ultimate, { custom: 'h3-custom-size', width: 'h3-width', height: 'h3-height', runtime: 'h3-runtime' });
  const samplingValues = { 'ch.prompt_prefix': '原始参数', 'kf.steps': 24, 'mo.steps': 22, 'kf.cfg': 9, 'mo.cfg': 8, 'mo.denoise': 0.65, 'kf.seed': 12345, 'mo.seed': 67890 };
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const job = (state, id = 'test-job') => ({ id, task_id: id, state, engine: 'minimax_h3', createdAt: '2026-11-19T10:00:00Z', prompt: '原始提示词', progress: { percent: state === 'succeeded' ? 100 : 42, stage: 'sampling', text: '后端进度' }, output: state === 'succeeded' ? { file: 'D:/归档/不同名称.mp4' } : null, error: state === 'failed' ? { code: 'FAIL', message: '<故障>', hint: '检查服务后重试' } : null, canRetry: state === 'failed' });

  function harness(name, saved = {}, noStorage = false) {
    saved = { 'avp.shell.store.v1': JSON.stringify({ schema: 'ai-video-platform/shell.store', active: 'sample', projects: { sample: { values: samplingValues } } }), ...saved };
    const nodes = new Map(), requests = [], calls = [], timers = new Map(), events = new Map(), streams = [], messages = [];
    let sequence = 0;
    const on = (type, handler) => { if (!events.has(type)) events.set(type, []); events.get(type).push(handler); };
    function node(id) {
      if (!nodes.has(id)) nodes.set(id, { id, style: {}, value: '', textContent: '', innerHTML: '', disabled: false, hidden: true, handlers: {},
        classList: { add() {}, toggle() {} }, querySelectorAll() { return []; }, setAttribute() {}, getAttribute() { return null; }, closest() { return null; }, focus() {},
        addEventListener(type, fn) { const previous = this.handlers[type]; this.handlers[type] = event => { if (previous) previous(event); fn(event); }; } });
      return nodes.get(id);
    }
    function initMarkup(markup) {
      for (const [, id] of markup.matchAll(/id="([^"]+)"/g)) node(id);
      for (const [tag, id] of markup.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        node(id).value = (tag.match(/\bvalue="([^"]*)"/) || [])[1] || '';
        node(id).disabled = /\sdisabled\b/.test(tag);
      }
      for (const [tag, id, options] of markup.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
        const opts = [...options.matchAll(/<option\b[^>]*\bvalue="([^"]*)"[^>]*>/g)];
        const selected = opts.find(o => /\sselected\b/.test(o[0])) || opts[0];
        node(id).value = selected ? selected[1] : '';
        node(id).disabled = /<select[^>]*\sdisabled\b/.test(tag);
      }
    }
    const document = {
      hidden: false, getElementById: id => nodes.get(id) || null,
      body: { insertAdjacentHTML(position, markup) { initMarkup(markup); } },
      addEventListener: on,
    };
    if (name !== 'app') initMarkup(source[name]);
    const window = { addEventListener: on };
    class EventSource {
      constructor(url) { this.url = url; this.handlers = {}; this.closed = false; streams.push(this); }
      addEventListener(type, fn) { this.handlers[type] = fn; }
      close() { this.closed = true; }
    }
    const context = {
      document, window, location: { protocol: 'http:', origin: 'http://127.0.0.1:8388' }, EventSource,
      el: node, $: selector => node(selector.slice(1)), esc: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
      toast: value => messages.push(value), updateLibCounts() {}, updateRisk() {}, VRAM: {}, libTab: 'cine', setMode() {},
      values: { ...samplingValues }, device: 'T0', recMeta: null, baseline: null, BRIDGE: null,
      localStorage: { getItem(key) { if (noStorage) throw new Error('禁用存储'); return saved[key] || null; }, setItem(key, value) { if (noStorage) throw new Error('禁用存储'); saved[key] = value; } },
      fetch(url, options = {}) {
        url = url.replace('http://127.0.0.1:8388', ''); calls.push({ url, options });
        if (url === '/api/h3/status') return Promise.resolve({ ok: true, json: async () => ({ comfy: { reachable: true } }) });
        return new Promise((resolve, reject) => requests.push({ url, options, resolve, reject }));
      },
      setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    };
    vm.runInNewContext(clients[name], context, { filename: name + '-tasks.js' });
    const key = ids[name];
    node(key.prompt).value = '江南水乡清晨';
    function fire(type, target = {}) { for (const fn of events.get(type) || []) fn({ target, preventDefault() {} }); }
    return {
      key, calls, requests, messages, streams, document, window,
      node: id => node(key[id] || id),
      get posts() { return calls.filter(c => c.options.method === 'POST'); },
      get timers() { return [...timers.values()]; },
      get status() { return node(key.status).innerHTML + node(key.status).textContent; },
      fire,
      click(id) { const n = node(key[id] || id); if (n.onclick) n.onclick(); if (n.handlers.click) n.handlers.click({ target: n }); fire('click', n); },
      change(id, value) { const n = node(key[id] || id); n.value = String(value); if (n.handlers.change) n.handlers.change({ target: n }); },
      select(id) {
        const target = { getAttribute: attr => ['data-job', 'data-rm-job'].includes(attr) ? id : null, closest() { return null; } };
        if (name === 'app') fire('click', target);
        else if (name === 'ultimate') node('h3-history').handlers.click({ target });
        else window.testSelect(id);
      },
      async reply(url, data, status = 200) {
        const index = requests.findIndex(r => r.url === url);
        if (index < 0) throw new Error(name + ' 没有待响应请求：' + url);
        const [request] = requests.splice(index, 1);
        if (data instanceof Error) request.reject(data);
        else request.resolve({ ok: status >= 200 && status < 300, status, json: async () => data });
        await flush();
      },
      async sync(jobs, detail) {
        await this.reply('/api/jobs?limit=500', { jobs });
        const pending = requests.find(r => /^\/api\/jobs\/[^/]+$/.test(r.url) && !r.options.method);
        if (pending) await this.reply(pending.url, detail || jobs.find(j => '/api/jobs/' + encodeURIComponent(j.id) === pending.url));
      },
      async tick() {
        const next = timers.entries().next().value;
        if (!next) throw new Error(name + ' 没有待运行的轮询');
        timers.delete(next[0]); next[1].callback(); await flush();
      },
    };
  }

  for (const name of Object.keys(clients)) {
    group(name + ' 质量优先 DOM 契约');
    const markup = source[name], key = ids[name];
    const selectMarkup = id => (markup.match(new RegExp('<select\\b[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)<\\/select>')) || [])[0] || '';
    const optionValues = id => [...selectMarkup(id).matchAll(/<option[^>]*value="([^"]*)"/g)].map(m => m[1]).join(',');
    assert(name + ' 四个分辨率档位及手动自定义全部开放', optionValues(key.tier) === '720p,864p,1080p,cinema_2176,custom' && !/disabled/.test(selectMarkup(key.tier)));
    assert(name + ' 明确手动尺寸、非快速模式与量化权重说明', /自定义原生尺寸（手动选择）/.test(selectMarkup(key.tier)) && /不是自动降分辨率，也不是预览快速模式/.test(markup) && /现有模型权重可能已量化/.test(markup) && /8GB 显存不保证所有高分辨率档位可运行/.test(markup));
    for (const dimension of ['width', 'height']) {
      const input = (markup.match(new RegExp('<input\\b[^>]*id="' + key[dimension] + '"[^>]*>')) || [])[0] || '';
      assert(name + ' ' + dimension + ' 正偶数输入约束', /type="number"/.test(input) && /min="2"/.test(input) && /step="2"/.test(input));
    }
    assert(name + ' 唯一质量模式单选', /type="radio"[^>]*value="quality_first"[^>]*checked>质量优先（当前默认）/.test(markup));
    assert(name + ' 原生与输出帧率显式分离', optionValues(key.native) === (name === 'ultimate' ? '24' : '24,30') && optionValues(key.output) === '24,30,60');
    {
      const t = harness(name); await t.sync([]);
      assert(name + ' 默认 720p 与输出 60fps', t.node('tier').value === '720p' && t.node('output').value === '60');
      assert(name + ' 默认原生帧率遵守模型约束', t.node('native').value === (name === 'ultimate' ? '24' : '30') && (name !== 'ultimate' || t.node('native').disabled));
      t.click('go');
      const body = JSON.parse(t.posts[0].options.body);
      assert(name + ' 默认提交质量字段', body.tier === '720p' && body.native_fps === (name === 'ultimate' ? 24 : 30) && body.output_fps === 60 && body.mode === 'quality_first');
      if (name === 'ultimate') assert('H3 提交质量采样且无旧宽高', body.steps === 20 && body.cfg === 8 && body.denoise === 0.65 && !('width' in body) && !('height' in body));
    }
    {
      const baseline = harness(name); await baseline.sync([]); baseline.click('go');
      const tierBody = JSON.parse(baseline.posts[0].options.body);
      for (const [width, height] of [[640, 384], [512, 288]]) {
        const t = harness(name); await t.sync([]);
        assert(name + ' 自定义默认隐藏且保留640×384', t.node('custom').hidden && t.node('width').value === '640' && t.node('height').value === '384');
        t.change('tier', 'custom'); t.change('width', width); t.change('height', height);
        assert(name + ' 手动选择才显示宽高', !t.node('custom').hidden && t.node('tier').value === 'custom');
        t.click('go');
        const body = JSON.parse(t.posts[0].options.body), expected = { ...tierBody, width, height };
        delete expected.tier;
        assert(name + ' 自定义' + width + '×' + height + '精确请求且无tier', isDeepStrictEqual(body, expected) && !('tier' in body));
        assert(name + ' 自定义保留质量模式与原生fps', body.mode === 'quality_first' && body.native_fps === (name === 'ultimate' ? 24 : 30));
        if (name !== 'ultimate') assert(name + ' 自定义不修改步数CFG去噪种子', Object.entries(samplingValues).filter(([key]) => key !== 'ch.prompt_prefix').every(([key, value]) => body.values[key] === value));
        else assert('H3 自定义不修改采样参数', body.steps === 20 && body.cfg === 8 && body.denoise === 0.65);
        await t.reply(t.key.create, { error: { code: 'QUALITY_VRAM', message: '显存不足' } }, 422); await t.sync([]);
        assert(name + ' 自定义失败不自动改尺寸、不重复POST', t.posts.length === 1 && t.node('tier').value === 'custom' && +t.node('width').value === width && +t.node('height').value === height && /QUALITY_VRAM/.test(t.node('submitError').textContent));
      }
      for (const tier of ['720p', '864p', '1080p', 'cinema_2176']) {
        const t = harness(name); await t.sync([]);
        t.change('tier', 'custom'); t.change('width', '639'); t.change('height', ''); t.change('tier', tier); t.click('go');
        const body = JSON.parse(t.posts[0].options.body);
        assert(name + ' 切回' + tier + '不携带自定义宽高且请求不变', t.node('custom').hidden && isDeepStrictEqual(body, { ...tierBody, tier }));
        t.change('tier', 'custom');
        assert(name + ' 切回自定义保留用户输入不重置', !t.node('custom').hidden && t.node('width').value === '639' && t.node('height').value === '');
      }
    }
    for (const [dimension, invalid] of [['width', 0], ['height', -2], ['width', 639], ['height', 383], ['width', 640.5], ['height', ''], ['width', 'Infinity'], ['height', 'bad'], ['width', 9007199254740992]]) {
      const t = harness(name); await t.sync([]); t.change('tier', 'custom'); t.change(dimension, invalid); t.click('go');
      assert(name + ' 拒绝非法自定义' + dimension + '=' + invalid, t.posts.length === 0 && !t.node('go').disabled && /正偶数/.test(t.status) && t.node(dimension).value === String(invalid));
      t.change(dimension, dimension === 'width' ? 640 : 384); t.click('go');
      assert(name + ' 手动修正后可提交一次', t.posts.length === 1);
    }
    if (name === 'ultimate') {
      const t = harness(name); await t.sync([]);
      t.change('h3-steps', 25); t.change('h3-cfg', 9.5); t.change('h3-denoise', 0.7);
      t.change('tier', 'custom'); t.change('tier', '1080p'); t.change('tier', 'custom'); t.click('go');
      const body = JSON.parse(t.posts[0].options.body);
      assert('H3 切换尺寸仍保留手动高质量步数CFG去噪与24fps', body.steps === 25 && body.cfg === 9.5 && body.denoise === 0.7 && body.native_fps === 24 && !('tier' in body));
      assert('H3 自定义尺寸风险按实际640×384估算', /0.25MP/.test(t.node('h3-risk').textContent));
    } else {
      const t = harness(name); await t.sync([]); t.change('tier', 'custom'); t.change('engine', 'minimax_h3'); t.click('go');
      const body = JSON.parse(t.posts[0].options.body);
      assert(name + ' H3自定义仍为原生24且无tier', body.native_fps === 24 && body.width === 640 && body.height === 384 && !('tier' in body));
    }
    for (const tier of ['864p', '1080p', 'cinema_2176']) {
      const t = harness(name); await t.sync([]); t.change('tier', tier); t.click('go');
      assert(name + ' 提交 ' + tier + ' 不降档', JSON.parse(t.posts[0].options.body).tier === tier);
      await t.reply(t.key.create, { error: { code: 'QUALITY_VRAM', message: '<质量不足>' } }, 422);
      assert(name + ' 422 保留档位且不自动重交', t.node('tier').value === tier && t.posts.length === 1 && /QUALITY_VRAM/.test(t.status));
      await t.sync([]);
      assert(name + ' 422 核对完成后解锁', !t.node('go').disabled && t.posts.length === 1);
      assert(name + ' 质量错误持续可见且使用安全文本', /<质量不足>/.test(t.node('submitError').textContent) && !t.node('submitError').innerHTML);
    }
    if (name !== 'ultimate') {
      const t = harness(name); await t.sync([]);
      t.change('output', 24); t.change('output', 60);
      assert(name + ' 选择输出60默认仍原生30', t.node('native').value === '30');
      t.change('native', 24); t.change('output', 30); t.change('output', 60);
      assert(name + ' 主动选择原生24不被输出60覆盖', t.node('native').value === '24');
      t.change('engine', 'minimax_h3');
      assert(name + ' H3 锁定真实原生24', t.node('native').disabled && t.node('native').value === '24');
      t.click('go');
      assert(name + ' H3 不伪装原生30', JSON.parse(t.posts[0].options.body).native_fps === 24);
      const freshWan = harness(name); await freshWan.sync([]); freshWan.change('engine', 'minimax_h3'); freshWan.change('engine', 'wan22');
      assert(name + ' H3切回Wan恢复默认原生30', freshWan.node('native').value === '30' && !freshWan.node('native').disabled);
    }
    for (const output of [24, 30]) {
      const t = harness(name); await t.sync([]); t.change('output', output); t.click('go');
      assert(name + ' 输出' + output + '不被硬编码60覆盖', JSON.parse(t.posts[0].options.body).output_fps === output);
    }
    {
      const t = harness(name);
      const raw = { ...job('succeeded'), quality: { fps: { native_fps: 24, output_fps: 60 } }, enhancement: { state: 'failed' }, enhancedError: { code: 'ENHANCE_FAIL', message: '<增强错误>' } };
      await t.sync([raw]);
      assert(name + ' 增强错误转义并保留原生链接', /&lt;增强错误&gt;/.test(t.node('versions').innerHTML) && /原生版/.test(t.node('versions').innerHTML) && t.node('video').src.endsWith('/api/jobs/test-job/output'));
      assert(name + ' 历史也显示增强状态与错误', /ENHANCE_FAIL/.test(t.node('history').innerHTML) && /原生版/.test(t.node('history').innerHTML));
      t.click('enhance'); t.click('enhance');
      assert(name + ' 增强重试只POST一次且不重生成', t.posts.length === 1 && t.posts[0].url === '/api/jobs/test-job/enhance' && t.posts[0].options.body === '{}');
      await t.reply('/api/jobs/test-job/enhance', { accepted: true }, 202);
      t.click('enhance');
      assert(name + ' 增强受理后同步期不重复POST', t.posts.length === 1);
      await t.sync([{ ...raw, enhancedError: null, enhancement: { state: 'running' } }]);
      assert(name + ' 原生成功后增强中继续轮询', t.timers.length === 1 && /running/.test(t.node('versions').innerHTML));
      await t.tick();
      const enhanced = { ...raw, enhancedError: null, enhancement: { state: 'succeeded' }, enhanced: { file: 'D:/成片/test-job_enhanced.mp4', native_fps: 24, output_fps: 60 } };
      await t.sync([enhanced]);
      assert(name + ' 双版本独立链接且原生视频不被替换', /test-job\/output/.test(t.node('versions').innerHTML) && /file=test-job_enhanced.mp4/.test(t.node('versions').innerHTML) && /增强版/.test(t.node('history').innerHTML) && t.node('video').src.endsWith('/api/jobs/test-job/output'));
      assert(name + ' 展示实际原生24和增强输出60', /原生 24fps/.test(t.node('versions').innerHTML) && /输出 60fps/.test(t.node('versions').innerHTML) && t.timers.length === 0);
      t.click('refresh'); await t.sync([{ ...enhanced, enhanced: { ...enhanced.enhanced, output_fps: null } }]);
      assert(name + ' 增强输出未知不伪造请求60', /输出 未生成/.test(t.node('versions').innerHTML));
      t.click('refresh'); await t.sync([raw]); t.click('enhance');
      await t.reply('/api/jobs/test-job/enhance', { error: { code: 'ENHANCE_DENIED', message: '<服务错误>' } }, 503);
      assert(name + ' 增强API错误使用安全文本', /<服务错误>/.test(t.node('enhanceMsg').textContent) && !t.node('enhanceMsg').innerHTML);
      await t.sync([raw]);
    }
    group(name + ' 运行环境只读核验');
    {
      const t = harness(name);
      await t.reply('/api/quality', { runtime: {
        comfy_reachable: true,
        models: [
          { engine: 'wan22', ready: true, requirements: [{ node: 'loader', field: 'unet_name', name: '<installed>.safetensors', state: 'installed' }], warnings: ['现有权重为量化精度 <warning>'], errors: [] },
          { engine: 'minimax_h3', ready: false, requirements: [{ node: 'loader', field: 'vae_name', name: 'missing.safetensors', state: 'missing' }, { node: 'encoder', field: 'name', name: 'unknown.safetensors', state: 'unknown' }], warnings: [], errors: [{ code: 'NOT_READY', message: '<error>' }] },
        ],
        postprocess: [{ id: 'rife', ready: false, message: '<未安装>' }],
      } });
      assert(name + ' 运行环境成功不能提前释放初始任务同步锁', t.node('go').disabled && t.posts.length === 0);
      const runtimeText = t.node('runtime').textContent;
      assert(name + ' 展示模型已安装缺失未知与量化警告', /wan22：依赖就绪/.test(runtimeText) && /<installed>.safetensors：已安装/.test(runtimeText) && /missing.safetensors：缺失（后端核验）/.test(runtimeText) && /unknown.safetensors：未核验/.test(runtimeText) && /量化精度 <warning>/.test(runtimeText));
      assert(name + ' 运行环境错误与后处理使用安全文本', /NOT_READY <error>/.test(runtimeText) && /rife：未就绪/.test(runtimeText) && /<未安装>/.test(runtimeText) && !t.node('runtime').innerHTML);
      await t.sync([job('failed')]);
      const history = t.node('history').innerHTML, status = t.status;
      t.click('refresh'); await t.reply('/api/quality', {});
      assert(name + ' 旧服务无runtime只标未核验不报文件缺失', /runtime 未核验/.test(t.node('runtime').textContent) && !/缺失（后端核验）|未就绪/.test(t.node('runtime').textContent));
      assert(name + ' readiness不覆盖历史和持久任务错误', t.node('history').innerHTML === history && t.status === status);
      await t.sync([job('failed')]); t.click('refresh');
      await t.reply('/api/quality', new Error('离线'));
      assert(name + ' readiness离线安全降级未核验', /runtime 未核验/.test(t.node('runtime').textContent));
      await t.sync([job('failed')]);
      assert(name + ' readiness离线不阻止历史恢复、不额外POST', !t.node('go').disabled && /FAIL/.test(t.status) && t.posts.length === 0);
      t.click('refresh'); await t.reply('/api/quality', { runtime: { comfy_reachable: false, models: [], postprocess: [] } }); await t.sync([job('failed')]);
      assert(name + ' Comfy不可达与模型未知分开呈现', /ComfyUI：不可达/.test(t.node('runtime').textContent) && /模型：runtime 未核验/.test(t.node('runtime').textContent));
    }
    group(name + ' 任务生命周期');
    {
      const t = harness(name, {}, true);
      assert(name + ' 初始同步禁用生成', t.node('go').disabled);
      t.click('go'); assert(name + ' 同步前不提交', t.posts.length === 0);
      await t.reply('/api/jobs?limit=500', new Error('离线'));
      assert(name + ' 初始失败保持锁并安排重试', t.node('go').disabled && t.timers.length === 1 && t.timers[0].delay === 6000);
      assert(name + ' 查询错误明确提示重试', /查询失败.*重试/.test(t.status));
      await t.tick(); await t.sync([job('running')]);
      assert(name + ' 无 localStorage 仍恢复运行进度', /sampling/.test(t.status) && /42/.test(t.status) && t.node('go').disabled);
      assert(name + ' 常驻后台提示', /任务在后台继续生成，可稍后回来看/.test(t.node('background').textContent));
      t.fire('pagehide'); t.document.hidden = true; t.fire('visibilitychange');
      if (name === 'app') { t.click('rmClose'); t.click('btnRender'); }
      assert(name + ' 关闭/离开零 POST、零 cancel', t.posts.length === 0);
      assert(name + ' 离开没有 beforeunload 阻断器', !/beforeunload|returnValue|confirm\(/.test(clients[name]));
    }
    {
      const t = harness(name);
      await t.sync([]);
      t.click('go'); t.click('go');
      assert(name + ' 提交期事件互斥', t.posts.length === 1 && t.node('go').disabled);
      if (name === 'app') { t.click('rmClose'); t.click('btnRender'); t.click('go'); assert('模态关闭重开保留提交锁和提示词', t.posts.length === 1 && t.node('prompt').value === '江南水乡清晨'); }
      await t.reply(t.key.create, job('queued'), 202);
      await t.sync([job('queued')]);
      t.click('go'); assert(name + ' 受理后运行互斥', t.posts.length === 1 && t.node('go').disabled);
      await t.tick(); await t.reply('/api/jobs?limit=500', { error: { code: 'UNAVAILABLE' } }, 503);
      assert(name + ' HTTP 查询失败保持锁与单一重试', t.node('go').disabled && t.timers.length === 1 && t.timers[0].delay === 6000);
      await t.tick(); await t.sync([job('succeeded')]);
      assert(name + ' 成功解锁且停止轮询', !t.node('go').disabled && t.timers.length === 0);
      assert(name + ' 成片使用任务 output 地址而非猜路径', t.node('video').src.endsWith('/api/jobs/test-job/output'));
      const src = t.node('video').src;
      t.fire('pageshow'); await t.sync([job('succeeded')]);
      assert(name + ' 重入恢复完成历史和播放', t.node('video').src === src && t.posts.length === 1);
    }
    {
      const t = harness(name);
      const active = job('running', 'live'), old = job('succeeded', 'old');
      await t.sync([old, active]);
      assert(name + ' 初始优先恢复 active 而非最新历史', /live/.test(t.status));
      t.select('old'); await t.sync([old, active]);
      assert(name + ' 查看旧任务不覆盖运行锁', t.node('video').src.endsWith('/api/jobs/old/output') && t.node('go').disabled);
      t.click('go'); assert(name + ' 历史播放不能绕过互斥', t.posts.length === 0);
      await t.tick(); await t.sync([old, job('failed', 'live')]);
      assert(name + ' 非选中任务结束也释放运行锁', !t.node('go').disabled);
    }
    {
      const t = harness(name, { 'avp.h3.lastJob': 'gone', 'avp.shell.selectedJob': 'gone', 'avp.expert.selectedJob': 'gone' });
      await t.sync([job('failed')]);
      assert(name + ' 失败详情不会被 error 字段吞掉', /失败/.test(t.status) && /FAIL/.test(t.status) && /检查服务后重试/.test(t.status));
      assert(name + ' 后端 canRetry 控制重试入口', t.node('retry').style.display !== 'none' && !t.node('retry').disabled);
      if (name !== 'ultimate') assert(name + ' 失败信息已 HTML 转义', /&lt;故障&gt;/.test(t.status));
      t.node('prompt').value = '不能用于重试的新参数';
      t.click('retry'); t.click('retry');
      assert(name + ' 重试同一 ID 且不发送当前参数', t.posts.length === 1 && t.posts[0].url === '/api/jobs/test-job/retry' && t.posts[0].options.body === '{}');
      await t.reply('/api/jobs/test-job/retry', job('queued'), 202); await t.sync([job('queued')]);
      assert(name + ' 重试后同任务恢复进度并锁定', /test-job/.test(t.status) && t.node('go').disabled);
      await t.tick(); await t.sync([{ ...job('failed'), canRetry: false }]);
      assert(name + ' 不可重试的失败不显示重试按钮', t.node('retry').style.display === 'none');
    }
    {
      const t = harness(name);
      await t.sync([]); t.click('go'); await t.reply(t.key.create, new Error('响应丢失'));
      t.click('go');
      assert(name + ' 提交网络异常先核对历史、不自动 POST', t.node('go').disabled && t.posts.length === 1);
      await t.sync([job('running')]);
      assert(name + ' 响应丢失但后端已受理可恢复', /test-job/.test(t.status) && t.node('go').disabled && t.posts.length === 1);
    }
    {
      const t = harness(name);
      const history = Array.from({ length: 45 }, (_, i) => job('succeeded', 'history-' + i));
      await t.sync(history);
      assert(name + ' 历史不再被本地 30 条截断', /history-44/.test(t.node('history').innerHTML));
      t.document.hidden = false; t.fire('visibilitychange'); await t.sync([job('running'), ...history]);
      assert(name + ' 回到可见刷新后端并发现新 active', t.node('go').disabled && t.posts.length === 0);
    }
    {
      const t = harness(name);
      const active = job('running', 'live'), old = job('failed', 'old');
      await t.sync([active, old]);
      await t.tick(); await t.reply('/api/jobs?limit=500', { jobs: [active, old] });
      t.select('old');
      await t.reply('/api/jobs/live', active);
      await t.sync([active, old]);
      assert(name + ' 切换历史时忽略旧详情响应并补查新选择', /old/.test(t.status) && t.node('go').disabled && t.node('retry').disabled);
      t.fire('pagehide');
      await t.tick(); await t.sync([job('succeeded', 'live'), old]);
      assert(name + ' 页面离开不停止后台状态观察', !t.node('go').disabled && t.posts.length === 0);
    }
    {
      const t = harness(name); await t.sync([job('failed')]);
      t.click('retry'); await t.reply('/api/jobs/test-job/retry', { error: { code: 'RETRY_DENIED', message: '尚不可重试' } }, 409);
      assert(name + ' 重试接口失败有错误提示且暂不解锁', /RETRY_DENIED/.test(t.status) && t.node('go').disabled);
      await t.sync([{ ...job('failed'), canRetry: false }]);
      t.click('retry'); assert(name + ' 重试失败后按后端 canRetry 放行而非自动再试', t.posts.length === 1 && t.node('retry').style.display === 'none');
    }
    for (const state of ['failed', 'canceled']) {
      const t = harness(name); await t.sync([job('queued')]); await t.tick(); await t.sync([job(state)]);
      assert(name + ' ' + state + ' 终态解锁并停止轮询', !t.node('go').disabled && t.timers.length === 0);
      if (state === 'canceled') assert(name + ' 取消与失败区分', /已取消/.test(t.status));
    }
  }
  group('Ultimate 原生评分与采样边界');
  {
    const t = harness('ultimate');
    const raw = job('succeeded', 'raw-job');
    const enhanced = { ...job('succeeded', 'enhanced-job'), engine: 'wan22_enhanced', output: { file: 'D:/成片/enhanced.mp4' } };
    await t.sync([raw, enhanced, { ...job('succeeded', 'mock-job'), mock: true }]);
    const options = t.node('score-source').innerHTML;
    assert('评分只列真实原生任务', /raw-job/.test(options) && !/enhanced-job|mock-job/.test(options));
    t.click('score-run'); t.click('score-run');
    assert('评分端点与任务ID契约且互斥', t.posts.length === 1 && t.posts[0].url === '/api/ultimate/score' && JSON.parse(t.posts[0].options.body).job_id === 'raw-job');
    await t.reply('/api/ultimate/score', { file: 'raw.mp4', resolution: { width: 1920, height: 1080 }, native_fps: 30, output_fps: null, detail_score: 0.72, temporal_stability_score: 0.81, detail: { note: '<代理>' } });
    const score = t.node('score-grid').innerHTML;
    assert('评分展示分辨率/原生fps/已生成输出fps', /1920×1080/.test(score) && /native_fps[\s\S]*30/.test(score) && /output_fps[\s\S]*未生成/.test(score));
    assert('细节分与时序稳定分明确且代理非保真度', /detail_score（rule-proxy，非模型保真度）/.test(score) && /0.72/.test(score) && /temporal_stability_score/.test(score) && /0.81/.test(score));
    t.click('score-run');
    await t.reply('/api/ultimate/score', { error: { code: 'SCORE_FAILED', message: '<评分错误>' } }, 422);
    assert('评分失败使用textContent而非注入HTML', /<评分错误>/.test(t.node('score-msg').textContent) && !t.node('score-msg').innerHTML);
    await t.reply('/api/works?limit=14', { works: [{ file: 'D:/成片/archive_pure.mp4', name: 'archive_pure.mp4' }, { file: 'D:/成片/archive_enhanced.mp4', name: 'archive_enhanced.mp4' }] });
    assert('归档增强版可预览但不能选评分', /增强版/.test(t.node('works').innerHTML) && !/archive_enhanced/.test(t.node('score-source').innerHTML));
    t.change('score-source', 1); t.click('score-run');
    assert('原生归档以raw file提交评分', JSON.parse(t.posts[t.posts.length - 1].options.body).file === 'D:/成片/archive_pure.mp4');
  }
  for (const [id, invalid] of [['h3-steps', 4], ['h3-steps', 26], ['h3-cfg', 6], ['h3-cfg', 11], ['h3-denoise', 0.2]]) {
    const t = harness('ultimate'); await t.sync([]); t.change(id, invalid); t.click('go');
    assert('H3 拒绝非法采样 ' + id + '=' + invalid + '而非自动减步', t.posts.length === 0 && /质量区间/.test(t.status) && !t.node('go').disabled);
  }
  const webSource = read('web/params.src.html'), appSource = read('app/index.src.html'), ultimateSource = read('ultimate/ultimate.src.html');
  assert('移除活跃降档动作与turbo UI', !/AVP\.degrade|data-apply|value="draft"/.test(webSource) && !/turbo|h3-w"|h3-h"/i.test(ultimateSource) && !/tryTiers = \['draft'/.test(appSource));
  for (const name of ['app', 'ultimate']) {
    const t = harness(name); await t.sync([]); t.node('prompt').value = '   '; t.click('go');
    assert(name + ' 空提示词不提交、不占运行锁', t.posts.length === 0 && !t.node('go').disabled && /先写提示词/.test(t.status));
  }
  {
    const t = harness('web'); await t.sync([job('running')]);
    const es = t.streams[0]; es.onerror();
    assert('专家 SSE 断线关闭流并只留一个轮询', es.closed && t.timers.length === 1);
    await t.tick(); await t.sync([job('succeeded')]);
    assert('专家轮询终态复用完成逻辑与播放', !t.node('go').disabled && t.node('video').src.endsWith('/api/jobs/test-job/output') && t.messages.some(m => /已完成.*后端历史/.test(m)));
  }
} catch (e) {
  bad('任务恢复异步回归', e.stack || e.message);
}

/* ═════════════ 汇总 ═════════════ */
console.log('\n' + '═'.repeat(64));
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败清单：');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('全部通过');