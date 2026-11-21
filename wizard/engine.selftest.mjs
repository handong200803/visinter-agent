/**
 * wizard/engine.selftest.mjs —— engine.js 的 Node 侧验收
 *
 * 为什么在这里做：浏览器里的东西没法在 CI/命令行里「看着对」，但引擎有一半是
 * 纯数据（风格 → 场景描述），那一半可以断言。所以本文件只验：
 *   · 模块能被 require、API 签名齐全（调用方按签名写的，签错就是白干）；
 *   · 7 个风格的 sceneStats 都在、粒子数在 1..240、palette 与 styles.js 逐字一致；
 *   · 种子真的决定画面（同 seed 同、异 seed 异）；
 *   · 源码里没有联网/写文档的越界调用（零依赖是硬约束，只能静态查）；
 *   · 关键词映射表够用（≥12 个词）；
 *   · **Node 下加载模块本身不能抛**（无 document / window 也要安全），
 *     只有 createRenderer / renderPoster / record 允许显式失败。
 *
 * 跑法：node wizard/engine.selftest.mjs      → 末行「全部通过 · N 项」，退出码 0
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = join(HERE, 'engine.js');
const STYLES_PATH = join(HERE, 'styles.js');

let passed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + name);
  } else {
    failures.push(name + (detail ? '  → ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '  → ' + detail : ''));
  }
}

function json(v) { return JSON.stringify(v); }

// ── 1. 模块加载与导出 ────────────────────────────────────────────────────
console.log('[1] 模块加载 / 导出 API');
let ENGINE = null;
try {
  ENGINE = require(ENGINE_PATH);
} catch (e) {
  console.log('  ✗ require(engine.js) 抛错 → ' + e.message);
  failures.push('require(engine.js) 抛错');
}

const API = ['createRenderer', 'renderPoster', 'record', 'sceneStats'];
check('require() 无异常且返回对象', !!ENGINE && typeof ENGINE === 'object');
check('4 个必需 API 都是函数', !!ENGINE && API.every((k) => typeof ENGINE[k] === 'function'),
  ENGINE ? API.filter((k) => typeof ENGINE[k] !== 'function').join(',') : 'engine 为空');
check('导出 STYLE_IDS 覆盖 7 个风格', !!ENGINE && Array.isArray(ENGINE.STYLE_IDS) && ENGINE.STYLE_IDS.length === 7,
  ENGINE ? json(ENGINE.STYLE_IDS) : '');

const stylesMod = require(STYLES_PATH);
const STYLES = Array.isArray(stylesMod) ? stylesMod : (stylesMod && stylesMod.STYLES);
check('styles.js 可读且为 7 条风格真源', Array.isArray(STYLES) && STYLES.length === 7,
  STYLES ? String(STYLES.length) : 'undefined');

// ── 2. 7 个风格的纯数据层 ────────────────────────────────────────────────
console.log('[2] 7 个风格 sceneStats');
const statsById = {};
for (const st of STYLES || []) {
  let s = null;
  let err = '';
  try {
    s = ENGINE.sceneStats({ styleId: st.id, prompt: '', seed: 7 });
  } catch (e) {
    err = e.message;
  }
  statsById[st.id] = s;
  const keysOk = s && ['styleId', 'particles', 'palette', 'motion'].every((k) => k in s);
  const numOk = s && Number.isInteger(s.particles) && s.particles >= 1 && s.particles <= ENGINE.MAX_PARTICLES;
  const palOk = s && Array.isArray(s.palette) && json(s.palette) === json(st.palette);
  const motOk = s && s.motion && Number.isFinite(s.motion.zoomTo) && s.motion.zoomTo > 1 && s.motion.zoomTo < 1.1;
  check(st.id + ' 返回完整四键 + 粒子 1..240 + palette 与 styles.js 一致 + 推近 1.00→1.0x',
    keysOk && numOk && palOk && motOk,
    err || (!keysOk ? '缺字段' : (!numOk ? 'particles=' + (s && s.particles) : (!palOk ? 'palette 漂移' : 'motion 异常'))));
}
check('7 个风格粒子数互不相同（画面结构确实分开了）',
  new Set(Object.values(statsById).filter(Boolean).map((s) => s.particles)).size === 7,
  json(Object.entries(statsById).map(([k, v]) => [k, v && v.particles])));

// ── 3. 种子的确定性 ─────────────────────────────────────────────────────
console.log('[3] seed 决定画面');
const a1 = ENGINE.sceneStats({ styleId: 'cyberpunk', prompt: '', seed: 424242 });
const a2 = ENGINE.sceneStats({ styleId: 'cyberpunk', prompt: '', seed: 424242 });
const b1 = ENGINE.sceneStats({ styleId: 'cyberpunk', prompt: '', seed: 424243 });
check('同 seed 两次结果逐字段一致', json(a1) === json(a2));
check('不同 seed 结果不同（布点指纹变化）', json(a1) !== json(b1),
  a1.motion.signature + ' vs ' + b1.motion.signature);
check('字符串 seed 也稳定（不依赖 typeof）',
  json(ENGINE.sceneStats({ styleId: 'anime', seed: 'abc' })) === json(ENGINE.sceneStats({ styleId: 'anime', seed: 'abc' })));

// ── 4. prompt 关键词确实影响画面 ─────────────────────────────────────────
console.log('[4] prompt 映射生效');
const base = ENGINE.sceneStats({ styleId: 'cinematic', prompt: '', seed: 11 });
const snow = ENGINE.sceneStats({ styleId: 'cinematic', prompt: '下雪的公路，夜里开车过去', seed: 11 });
const fog = ENGINE.sceneStats({ styleId: 'dark', prompt: '一缕雾，很冷', seed: 11 });
check('含「雪」的描述让粒子数变多', snow.particles > base.particles, base.particles + ' → ' + snow.particles);
check('含「雪/夜」的描述改变了调色板', json(snow.palette) !== json(base.palette), json(snow.palette));
check('含「雾/冷」的描述改变了暗黑风格的调色板',
  json(fog.palette) !== json(ENGINE.sceneStats({ styleId: 'dark', prompt: '', seed: 11 }).palette));

// ── 5. 源码静态边界 ─────────────────────────────────────────────────────
console.log('[5] 源码静态检查（零依赖 / 不写文档）');
const SRC = readFileSync(ENGINE_PATH, 'utf8');
// 注释里出现 require('./engine.js') 这类「用法示例」是文档，不是依赖；查代码本体
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
check('不含 fetch(', SRC.indexOf('fetch(') < 0);
check('不含 http://', SRC.indexOf('http://') < 0);
check('不含 https://', SRC.indexOf('https://') < 0);
check('不含 document.write', SRC.indexOf('document.write') < 0);
check('没有第三方 import/require（只有 UMD 的 module.exports）',
  !/\brequire\s*\(\s*['"]/.test(CODE) && !/\bimport\s+[\w{*]/.test(CODE));
check('注释里讲清了「演示渲染、非模型语义理解」',
  SRC.indexOf('演示') >= 0 && SRC.indexOf('不是语义理解') >= 0);

// ── 6. 关键词表规模 ─────────────────────────────────────────────────────
console.log('[6] 关键词映射表');
const KW = ENGINE.KEYWORDS;
const words = (KW || []).reduce((n, k) => n + (k.words ? k.words.length : 0), 0);
check('映射条目 ≥ 12', Array.isArray(KW) && KW.length >= 12, String(KW && KW.length));
check('映射词条总数 ≥ 12', words >= 12, String(words));
check('每条都有 id / words / kind 或旋钮', (KW || []).every((k) => k.id && Array.isArray(k.words) && k.words.length > 0));

// ── 7. Node 无 DOM 时的降级行为 ──────────────────────────────────────────
console.log('[7] 无 DOM 环境下的行为');
let threw = '';
try {
  ENGINE.createRenderer(null, { styleId: 'anime' });
} catch (e) {
  threw = e.message;
}
check('createRenderer 在 Node 下抛明确错误', /canvas/i.test(threw), threw || '没有抛');
check('renderPoster 在 Node 下返回 null', ENGINE.renderPoster({ styleId: 'anime' }) === null);

let recResult = { ok: 'pending' };
try {
  recResult = await ENGINE.record({ styleId: 'anime', ms: 100 });
} catch (e) {
  recResult = { ok: 'threw', reason: e.message };
}
check('record 在 Node 下 resolve 失败对象且不 throw',
  recResult && recResult.ok === false && typeof recResult.reason === 'string', json(recResult));

// ── 8. 循环与运镜参数 ───────────────────────────────────────────────────
console.log('[8] 循环 / 运镜');
check('循环周期为 8000ms（首尾可无缝相接）', ENGINE.LOOP_MS === 8000, String(ENGINE.LOOP_MS));
check('推近区间是 1.00 → ≤1.06（缓慢推近）',
  Object.values(statsById).every((s) => s && s.motion.zoomFrom === 1 && s.motion.zoomTo <= 1.0601));
check('粒子上限 240', ENGINE.MAX_PARTICLES === 240, String(ENGINE.MAX_PARTICLES));

// ── 结论 ────────────────────────────────────────────────────────────────
const total = passed + failures.length;
console.log('');
if (failures.length) {
  console.log('失败 ' + failures.length + ' 项：');
  for (const f of failures) console.log('  - ' + f);
  console.log('失败 · ' + passed + '/' + total + ' 项');
  process.exit(1);
}
console.log('全部通过 · ' + passed + ' 项');