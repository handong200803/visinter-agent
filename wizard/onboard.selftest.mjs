/**
 * wizard/onboard.selftest.mjs —— 新手引导的 Node 侧自检（无 DOM，只测纯逻辑 + 静态约束）
 *
 * 为什么不去开浏览器测：
 *   引导最容易错的是「气泡该放哪、会不会出屏」这类几何，它们全是纯函数就能算的；
 *   真跑一遍 puppeteer 既慢又引入依赖，而本项目铁律是零依赖。
 *   所以几何在这里被钉死，DOM 层（onboard.js 后半段）只是把算好的数字写进 style。
 *
 * 覆盖：
 *   1. computePlacement 目标在右上角 → 不越界、边距 ≥ 8px；
 *   2. 窄屏（width 600）→ 贴底全宽；
 *   3. shouldShow / reset 的 localStorage 语义（含隐私模式 store 抛错）；
 *   4. create() 空 steps 不抛、方法齐全可调用（Node 无 DOM 走桩）；
 *   5. 源码静态约束：无网络请求、无 http(s) 链接、无 innerHTML 拼接等。
 *
 * 协议（AGENTS.md）：末行「全部通过」，exit 0；有失败则列清单并 exit 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(HERE, 'onboard.js');
const require = createRequire(import.meta.url);

let pass = 0;
const fails = [];

function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  ✓ ' + label + (detail ? '  ·  ' + detail : ''));
  } else {
    fails.push(label + (detail ? '  ·  ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? '  ·  ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

const round = (n) => Math.round(n * 1000) / 1000;
const near = (a, b, eps) => Math.abs(a - b) <= (eps == null ? 1e-6 : eps);

/* ── 载入被测模块（Node 下 require 必须安全） ───────────────────────────── */

let ONB = null;
let loadError = null;
try {
  ONB = require(SRC_PATH);
} catch (e) {
  loadError = e;
}

section('0. 模块加载 / UMD 双导出');
ok('Node 下 require 不抛', !loadError, loadError ? String(loadError.message) : 'ok');
ok('导出 create / shouldShow / reset', !!ONB && typeof ONB.create === 'function' && typeof ONB.shouldShow === 'function' && typeof ONB.reset === 'function');
ok('导出纯几何函数 computePlacement / clampBox', !!ONB && typeof ONB.computePlacement === 'function' && typeof ONB.clampBox === 'function');
ok('本进程确实没有 DOM（后面 create 走桩）', typeof document === 'undefined', 'typeof document=' + typeof document);

if (!ONB) {
  console.log('\n模块加载失败，后续断言无法执行');
  process.exit(1);
}

/* ── 1. computePlacement：目标在右上角不越界 ──────────────────────────── */

section('1. computePlacement · 目标在右上角 → 不越界');

const VP = { width: 1280, height: 800 };
const BUBBLE = { width: 340, height: 180 };
const MARGIN = ONB.DEFAULTS.margin;

const topRight = ONB.computePlacement({
  spot: { left: 1100, top: 16, width: 160, height: 40 },
  viewport: VP,
  bubble: BUBBLE,
  place: 'auto'
});

ok('选了四边之一', ONB.PLACES.indexOf(topRight.placement) >= 0, 'placement=' + topRight.placement);
ok('右边放不下就不硬放', topRight.placement === 'left', '右只剩 20px，改放左');
ok('left ≥ 8', topRight.left >= MARGIN - 1e-9, 'left=' + round(topRight.left));
ok('top ≥ 8', topRight.top >= MARGIN - 1e-9, 'top=' + round(topRight.top));
ok('left + width ≤ 视口宽 - 8', topRight.left + topRight.width <= VP.width - MARGIN + 1e-9, round(topRight.left + topRight.width) + ' ≤ ' + (VP.width - MARGIN));
ok('top + height ≤ 视口高 - 8', topRight.top + topRight.height <= VP.height - MARGIN + 1e-9, round(topRight.top + topRight.height) + ' ≤ ' + (VP.height - MARGIN));
ok('返回的尺寸就是气泡尺寸（没有被压扁）', topRight.width === BUBBLE.width && topRight.height === BUBBLE.height);

/* ── 2. 窄屏：贴底全宽 ───────────────────────────────────────────────── */

section('2. 窄屏（width 600）→ 气泡贴底全宽');

const NARROW_VP = { width: 600, height: 900 };
const narrow = ONB.computePlacement({
  spot: { left: 300, top: 300, width: 120, height: 40 },
  viewport: NARROW_VP,
  bubble: BUBBLE,
  place: 'auto'
});

ok('placement = bottom', narrow.placement === 'bottom', 'placement=' + narrow.placement);
ok('narrow 标记为 true', narrow.narrow === true);
ok('宽度 = 视口宽 - 16（左右各 8）', narrow.width === NARROW_VP.width - 16, 'width=' + round(narrow.width));
ok('左边距 = 8', narrow.left === 8, 'left=' + round(narrow.left));
ok('右边距 = 8', near(narrow.left + narrow.width, NARROW_VP.width - 8), round(narrow.left + narrow.width) + ' = 592');
ok('底边距 = 8', near(narrow.top + narrow.height, NARROW_VP.height - 8), round(narrow.top + narrow.height) + ' = 892');

const edge = ONB.computePlacement({
  spot: { left: 40, top: 40, width: 100, height: 40 },
  viewport: { width: 720, height: 800 },
  bubble: BUBBLE,
  place: 'auto'
});
ok('720px 不算窄屏（阈值取 <720）', edge.narrow === false, 'placement=' + edge.placement);

/* ── 3. clampBox：夹紧语义 ───────────────────────────────────────────── */

section('3. clampBox · 越界一律夹回 8px 边距');

const clamped = ONB.clampBox({ left: -50, top: 5000, width: 340, height: 180 }, { width: 800, height: 600 });
ok('左边溢出 → 8', clamped.left === 8, 'left=' + clamped.left);
ok('下边溢出 → 视口高 - 8 - 高', clamped.top === 412, 'top=' + clamped.top);
ok('夹紧后仍在视口内', clamped.left + clamped.width <= 792 && clamped.top + clamped.height <= 592);

const oversized = ONB.clampBox({ left: 0, top: 0, width: 4000, height: 4000 }, { width: 800, height: 600 });
ok('盒子比视口还大 → 先压尺寸再定位', oversized.width === 784 && oversized.height === 584, round(oversized.width) + '×' + round(oversized.height));
ok('超大盒子也不会算出负可用区间', oversized.left === 8 && oversized.top === 8);

/* ── 4. 显式 place 与降级 ────────────────────────────────────────────── */

section('4. 显式 place：放得下就听，放不下才降级');

const rightable = ONB.computePlacement({
  spot: { left: 100, top: 100, width: 100, height: 40 },
  viewport: VP, bubble: BUBBLE, place: 'right'
});
ok("place:'right' 有空间 → 照办", rightable.placement === 'right' && rightable.fallback === false, 'left=' + round(rightable.left));
ok('右边距 = 目标右缘 + 12', rightable.left === 100 + 100 + 12, 'left=' + rightable.left);

const degrade = ONB.computePlacement({
  spot: { left: 20, top: 100, width: 100, height: 40 },
  viewport: VP, bubble: BUBBLE, place: 'left'
});
ok("place:'left' 左边只有 20px → 换到右边", degrade.placement === 'right', 'placement=' + degrade.placement);
ok('降级被标记出来（fallback=true）', degrade.fallback === true);

const noRoom = ONB.computePlacement({
  spot: { left: 40, top: 40, width: 720, height: 520 },
  viewport: { width: 800, height: 600 }, bubble: BUBBLE, place: 'auto'
});
ok('四边都放不下也不越界', noRoom.left >= 8 && noRoom.top >= 8 && noRoom.left + noRoom.width <= 792 && noRoom.top + noRoom.height <= 592,
  'left=' + round(noRoom.left) + ' top=' + round(noRoom.top) + ' placement=' + noRoom.placement);
ok('四边都放不下时标记 fallback', noRoom.fallback === true);

/* ── 5. 属性测试：任意目标位置 × 任意 place 都不越界 ──────────────────── */

section('5. 属性测试 · 16 个目标位置 × 5 种 place 全部不越界');

const spots = [];
for (const left of [-60, 0, 120, 460, 900, 1180]) {
  for (const top of [-40, 0, 300, 760]) spots.push({ left, top, width: 160, height: 40 });
}
let combos = 0;
let bad = 0;
let badDetail = '';
for (const spot of spots) {
  for (const place of ['auto', 'right', 'bottom', 'top', 'left']) {
    combos += 1;
    const p = ONB.computePlacement({ spot, viewport: VP, bubble: BUBBLE, place });
    const out = p.left < MARGIN - 1e-9
      || p.top < MARGIN - 1e-9
      || p.left + p.width > VP.width - MARGIN + 1e-9
      || p.top + p.height > VP.height - MARGIN + 1e-9;
    if (out) { bad += 1; if (!badDetail) badDetail = 'spot(' + spot.left + ',' + spot.top + ') place=' + place + ' → ' + round(p.left) + ',' + round(p.top); }
  }
}
ok('全部组合都在视口内且边距 ≥ 8', bad === 0, combos + ' 组，越界 ' + bad + (badDetail ? ' · 首个 ' + badDetail : ''));

/* ── 6. shouldShow / reset ──────────────────────────────────────────── */

section('6. shouldShow / reset · 标记语义');

function fakeStore(init) {
  const map = new Map(Object.entries(init || {}));
  return {
    map,
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); }
  };
}

ok('无 localStorage 时 shouldShow → true', ONB.shouldShow('avp.test.key') === true);
const st = fakeStore();
ok('有 store 但没标记 → true', ONB.shouldShow('avp.test.key', st) === true);
ok('writeFlag 写入成功', ONB.writeFlag('avp.test.key', st) === true && st.getItem('avp.test.key') === '1');
ok('有标记 → false', ONB.shouldShow('avp.test.key', st) === false);
ONB.reset('avp.test.key', st);
ok('reset 后 → true', ONB.shouldShow('avp.test.key', st) === true);
ok('reset 真的删了键', st.getItem('avp.test.key') === null);

const other = fakeStore();
ONB.writeFlag('avp.test.other', other);
ok('不同 storageKey 不串档', ONB.shouldShow('avp.test.key', other) === true && ONB.shouldShow('avp.test.other', other) === false);
ONB.writeFlag(undefined, st);
ok('不传 storageKey 用默认值', st.getItem(ONB.DEFAULTS.storageKey) === '1' && ONB.shouldShow(undefined, st) === false);

const hostile = {
  getItem() { throw new Error('storage disabled'); },
  setItem() { throw new Error('storage disabled'); },
  removeItem() { throw new Error('storage disabled'); }
};
let hostileThrew = false;
let hostileShow = null;
let hostileWrite = null;
try {
  hostileShow = ONB.shouldShow('avp.test.key', hostile);
  hostileWrite = ONB.writeFlag('avp.test.key', hostile);
  ONB.reset('avp.test.key', hostile);
} catch (e) { hostileThrew = true; }
ok('隐私模式（store 全抛错）不崩', !hostileThrew);
ok('读不到标记时按「没看过」处理 → true', hostileShow === true);
ok('写标记失败返回 false 而不是抛', hostileWrite === false);
ok('Node 下 reset() 无 store 也不抛', (() => { try { ONB.reset(); return true; } catch (e) { return false; } })());

/* ── 7. create()：空 steps / 无 DOM 走桩 ─────────────────────────────── */

section('7. create() · Node 无 DOM 返回同接口桩');

let made = null;
let createThrew = null;
try {
  made = ONB.create({ steps: [] });
} catch (e) { createThrew = e; }
ok('create({ steps: [] }) 不抛', !createThrew, createThrew ? String(createThrew.message) : 'ok');

const METHODS = ['start', 'next', 'prev', 'end', 'index', 'isActive', 'refresh', 'destroy'];
ok('控制器方法齐全', !!made && METHODS.every((m) => typeof made[m] === 'function'), METHODS.join('/'));
ok('桩被显式标记（stub:true）', !!made && made.stub === true);
ok('桩：isActive() === false', made.isActive() === false);
ok('桩：index() === 0', made.index() === 0);
ok('桩：空 steps 长度为 0', made.steps.length === 0);

let chainOk = null;
try {
  chainOk = made.start() === made && made.next() === made && made.prev() === made && made.refresh() === made && made.end(true) === made && made.destroy() === made;
} catch (e) { chainOk = false; }
ok('桩：全部方法可安全调用且可链式', chainOk === true);

let noArgThrew = false;
try { ONB.create(); } catch (e) { noArgThrew = true; }
ok('create() 无参不抛', !noArgThrew);

let withSteps = null;
let withStepsThrew = false;
try {
  withSteps = ONB.create({
    steps: [
      { selector: '#styles', title: '选风格', text: '先挑一个' },
      { selector: () => null, title: '缺失目标', text: '会被跳过' }
    ],
    once: true
  });
  withSteps.start(); withSteps.next(); withSteps.end(false); withSteps.destroy();
} catch (e) { withStepsThrew = true; }
ok('带真实 steps 在 Node 下也不抛', !withStepsThrew && !!withSteps && withSteps.stub === true);

/* ── 8. 源码静态约束（安全 / 零依赖 / 复用类名） ─────────────────────── */

section('8. onboard.js 源码静态检查');

const src = fs.readFileSync(SRC_PATH, 'utf8');
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

ok('不含网络请求 fetch(', !src.includes('fetch(') && !codeOnly.includes('fetch('));
ok('不含 http:// 字面量', !src.includes('http://'));
ok('不含 https:// 字面量', !src.includes('https://'));
ok('完全不用 innerHTML（只用 textContent）', !src.includes('innerHTML'));
ok('不用 outerHTML 赋值', !/outerHTML\s*=/.test(src));
ok('不用 document.write', !/document\.write/.test(src));
ok('不用 eval / Function 构造器', !/(^|[^.\w])eval\s*\(/.test(src) && !/new\s+Function\s*\(/.test(src));
ok('不注入 <style>（只复用 theme.css）', !/<style/i.test(src));
ok('UMD：同时挂 module.exports 与 window.AVPW_ONBOARD', /module\.exports/.test(src) && /AVPW_ONBOARD/.test(src) && /typeof window/.test(src));
const reuse = ['onboard', 'veil', 'spot', 'bubble', 'ob-step', 'ob-actions', 'grow', 'dots', 'btn ghost', 'btn primary'];
ok('复用 theme.css 既有类名', reuse.every((c) => src.includes(c)), reuse.join(','));
ok('有中文注释（设计取舍写清楚）', /[\u4e00-\u9fa5]{4,}/.test(src));
ok('-- 有 rAF 节流（不每像素重排）', /requestAnimationFrame/.test(src) && /rafId/.test(src));
ok('-- 锁滚动先存原值再恢复', /prevOverflow/.test(src) && /overflow = 'hidden'/.test(src));

/* ── 汇总 ──────────────────────────────────────────────────────────── */

console.log('\n' + '═'.repeat(64));
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  console.log('\n失败清单：');
  fails.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  process.exit(1);
}
console.log('全部通过 · ' + pass + ' 项');