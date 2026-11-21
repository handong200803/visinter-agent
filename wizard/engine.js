/**
 * wizard/engine.js —— 小白模式的「演示引擎」：没有后端、没有真模型，也要有一个会动的画面
 *
 * 它是演示渲染，不是模型出片，这一点在 UI 上必须讲清楚。但它要满足四件事：
 *   1. 离线可用（`file://` 双击就能跑）、零依赖（不引库、不联网、不加载字体图片）；
 *   2. 点开就动（rAF 自驱，t 从 0 起取模循环，所以能无限播）；
 *   3. 7 个风格的画面**明显不同**（调色 + 图层 + 粒子 + 运镜各一套，不是换个滤镜）；
 *   4. 录出来是**真的 webm 文件**（canvas.captureStream + MediaRecorder），不是假装。
 *
 * 三层结构（这个分法是为了让 Node 下也能做验收）：
 *   ┌ 纯数据层  buildScene / sceneStats  —— 不碰 canvas，只用种子和风格算「画什么」
 *   ├ 静态层    buildCache / paintBG     —— 每帧都不变的东西烘到离屏 canvas，一帧一次 drawImage
 *   └ 动态层    drawFrame / PAINT        —— 只画会动的那几样：粒子、光晕、雨丝、火焰、飘带
 *
 * 为什么非要分静态 / 动态：960×540@30fps 要在集显上跑得住。每帧重建渐变、每帧画一遍远山，
 * 是这类演示页面掉帧的头号原因。这里把渐变在 buildCache 里做一次（单位空间渐变 + 变换缩放），
 * 把背景烘成一张图，每帧成本就剩「一次 drawImage + 几十到两百个粒子」。
 *
 * 用法：
 *   Node:   const E = require('./engine.js')        → { createRenderer, renderPoster, record, sceneStats, … }
 *   浏览器: window.AVPW_ENGINE                        → 同上（styles.js 先加载则自动共用其真源调色板）
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AVPW_ENGINE = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var VERSION = '1.0.0';

  /* 循环周期：所有运动函数都以它为一个整数周期 → start() 无限播不跳帧，
     drawAt(t) 与 drawAt(t + LOOP_MS) 必然是同一画面，录制取模也不会出现接缝。 */
  var LOOP_MS = 8000;

  /* 粒子上限：240。再多在集显上就开始掉帧，而且这个尺寸下也看不出更多细节。 */
  var MAX_PARTICLES = 240;

  var TAU = Math.PI * 2;

  /* ── 0. 数学 / 颜色小工具 ────────────────────────────────────────────────── */

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function mix(a, b, t) { return a + (b - a) * t; }

  /** 有符号安全的取模：JS 的 % 对负数返回负值，粒子用到会跳到画面外。 */
  function modPos(v, m) { var r = v % m; return r < 0 ? r + m : r; }

  function nowMs() {
    if (root && root.performance && typeof root.performance.now === 'function') return root.performance.now();
    return Date.now();
  }

  function hex2rgb(h) {
    var s = String(h == null ? '#000000' : h).replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (!isFinite(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgb2hex(r, g, b) {
    function h(v) { var s = clamp(Math.round(v), 0, 255).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + h(r) + h(g) + h(b);
  }

  function rgba(h, a) {
    var c = hex2rgb(h);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a == null ? 1 : a) + ')';
  }

  /**
   * 柔边椭圆团（云、雾）。只在**烘焙背景**时用，所以每次新建渐变无所谓；
   * 为什么不用 ctx.ellipse 硬边：单个硬边椭圆无论怎么压扁都读作「飞碟」，
   * 云和雾得靠软边 + 多层错位叠出来才像。
   */
  function softBlob(ctx, x, y, rx, ry, color, alpha) {
    if (!(rx > 0) || !(ry > 0)) return;
    var g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(0.55, rgba(color, alpha * 0.50));
    g.addColorStop(1, rgba(color, 0));
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(rx, ry);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function mixHex(a, b, t) {
    var A = hex2rgb(a), B = hex2rgb(b);
    return rgb2hex(mix(A[0], B[0], t), mix(A[1], B[1], t), mix(A[2], B[2], t));
  }

  function rgb2hsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    var h = 0;
    if (d > 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    var l = (max + min) / 2;
    var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return [h, s, l];
  }

  function hsl2rgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = modPos(h, 360) / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = l - c / 2;
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }

  /**
   * 句子里的「暖 / 冷 / 昼夜」只调这三样：色相微转、饱和度、明度。
   * 为什么不用滤镜叠一层了事：叠色会把暗部一起抬灰，7 个风格会越来越像；
   * 转调色板则是「同一个套路换个时辰」，风格骨架还在。
   * 注意：色相/饱和度/明度全为恒等时**原样返回**，保证空 prompt 下的 palette
   * 与 styles.js 逐字节一致（自检要断言这件事）。
   */
  function shiftPalette(pal, hueDeg, satMul, ligMul) {
    if (Math.abs(hueDeg) < 0.01 && Math.abs(satMul - 1) < 1e-6 && Math.abs(ligMul - 1) < 1e-6) return pal.slice();
    var out = [];
    for (var i = 0; i < pal.length; i += 1) {
      var hsl = rgb2hsl(hex2rgb(pal[i]));
      var rgb = hsl2rgb(hsl[0] + hueDeg, clamp(hsl[1] * satMul, 0, 1), clamp(hsl[2] * ligMul, 0, 1));
      out.push(rgb2hex(rgb[0], rgb[1], rgb[2]));
    }
    return out;
  }

  /* ── 1. 种子：mulberry32 + FNV-1a ────────────────────────────────────────
     为什么要自带 PRNG：Math.random 每帧每次调用结果都不同，同一个 seed 就复原不出
     同一张画，录制出来的片子和海报也会对不上。mulberry32 只要 4 个整数状态，
     够随机、够快、可复现，是这类图形演示里性价比最高的小 PRNG。 */

  function mulberry32(a) {
    var s = a >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function seedInt(seed) {
    if (typeof seed === 'number' && isFinite(seed)) return (Math.abs(Math.floor(seed)) >>> 0) || 1;
    return hashStr(String(seed == null ? '1' : seed)) || 1;
  }

  /* ── 2. 风格表：styles.js 才是真相源，这里是一份逐字兜底 ───────────────────
     为什么还要兜底：engine.js 要能被单独 require（Node 自检、别的页面直接引），
     而 styles.js 只在浏览器里挂 window.AVPW_STYLES。加载顺序也不该由引擎决定。
     所以 styleList() 在**调用时**才去读全局，读不到就用这份；两份必须保持一致，
     自检里有断言。 */

  var BUILTIN_STYLES = [
    { id: 'cinematic', label: '电影感', palette: ['#0b0c10', '#3a2a1c', '#c9862f', '#ffe6b0'] },
    { id: 'photo', label: '写实摄影', palette: ['#7f8b98', '#4d5f70', '#c3cdd6', '#fff6dd'] },
    { id: 'anime', label: '二次元', palette: ['#7fb9ef', '#bcd9f7', '#ffd4c9', '#3f4a63'] },
    { id: 'guofeng', label: '国风古风', palette: ['#f3ead6', '#8d9a92', '#b8402c', '#39463f'] },
    { id: 'cyberpunk', label: '赛博朋克', palette: ['#160b2a', '#ff2d95', '#22d3ee', '#a855f7'] },
    { id: 'dark', label: '暗黑电影', palette: ['#070910', '#3c4d68', '#c98a3c', '#ffd79a'] },
    { id: 'fantasy', label: '梦幻仙气', palette: ['#2a2140', '#5b3f74', '#c98fb6', '#fff0fb'] },
  ];

  function styleList() {
    var g = root && root.AVPW_STYLES;
    if (g) {
      if (g.STYLES && g.STYLES.length) return g.STYLES;
      if (Object.prototype.toString.call(g) === '[object Array]' && g.length) return g;
    }
    return BUILTIN_STYLES;
  }

  function styleById(id) {
    var list = styleList();
    for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
    return null;
  }

  /* ── 3. 每风格的场景底座（调色之外，真正决定「看起来像不像」的参数） ─────
     horizon  —— 地平线在画面高度的百分比（构图）。国风高一点像手卷，暗黑低一点像室内。
     density  —— 粒子密度系数（乘在 240 上）。
     kind     —— 这风格自带的粒子种类。
     zoomTo   —— 推近上限。人像/静物片推得猛，风景片推得轻。
     panX/panY—— 横移 / 竖移幅度（画宽的百分比），再乘推近量避免露边。 */

  var STYLE_SCENE = {
    cinematic: {
      horizon: 0.70, density: 0.50, kind: 'dust', zoomTo: 1.06, panX: 0.030, panY: 0.006,
      vignette: 0.55, glowColor: '#ffe6b0',
      tint: { dust: '#ffe6b0', rain: '#cfe4ff', snow: '#fffaf0', ember: '#ff9d4d' }
    },
    photo: {
      horizon: 0.72, density: 0.42, kind: 'bokeh', zoomTo: 1.05, panX: -0.020, panY: 0.004,
      vignette: 0.34, glowColor: '#fff6dd',
      tint: { bokeh: '#fff6dd', rain: '#e8f4ff', snow: '#ffffff', leaf: '#ffe0b8' }
    },
    anime: {
      horizon: 0.66, density: 0.46, kind: 'petal', zoomTo: 1.05, panX: 0.022, panY: 0.0,
      vignette: 0.22, glowColor: '#fffdf2',
      tint: { petal: '#ffc7d9', bokeh: '#ffffff', spark: '#fffdf2', snow: '#ffffff', rain: '#d9f0ff' }
    },
    guofeng: {
      horizon: 0.68, density: 0.34, kind: 'mote', zoomTo: 1.04, panX: -0.014, panY: 0.003,
      vignette: 0.30, glowColor: '#c8442e',
      tint: { mote: '#7d8378', leaf: '#7d8378', petal: '#d8a99a', snow: '#fbf7ee', rain: '#8a9188', spark: '#b8402c' }
    },
    cyberpunk: {
      horizon: 0.74, density: 0.60, kind: 'rain', zoomTo: 1.06, panX: 0.018, panY: 0.005,
      vignette: 0.46, glowColor: '#22d3ee',
      tint: { rain: '#bff6ff', petal: '#ff9ad5', snow: '#e9d7ff', ember: '#ff7ac8', spark: '#eafcff' }
    },
    dark: {
      horizon: 0.78, density: 0.26, kind: 'mote', zoomTo: 1.05, panX: 0.012, panY: 0.004,
      vignette: 0.78, glowColor: '#ffd79a',
      tint: { mote: '#9fb4d8', ember: '#ffb066', snow: '#cfd8e6', rain: '#9fb4d8', spark: '#dfe8ff' }
    },
    fantasy: {
      horizon: 0.72, density: 0.48, kind: 'light', zoomTo: 1.06, panX: -0.018, panY: 0.008,
      vignette: 0.40, glowColor: '#fff0fb',
      tint: { light: '#fff2ff', spark: '#ffe8ff', snow: '#fcefff', petal: '#ffd7ee', rain: '#e6d6ff' }
    }
  };

  /* ── 4. 关键词映射表（演示级近似，不是语义理解）─────────────────────────
     规则：把描述当**字符串**扫一遍，命中哪个词就叠哪一组微调。不做分词、不做语义、
     不做否定（「不要下雨」也会命中「雨」）。这是刻意的：小白模式下用户要的是
     「我写了雪，画面里真的飘雪」，能对上就够了，多出来的那点聪明全是误会来源。
     映射只影响 5 个旋钮：粒子种类/密度、色温、明度、地平线、以及少量附加图层。 */

  var KEYWORDS = [
    { id: 'snow', words: ['雪', '下雪', '雪地', '雪花', '暴雪'], kind: 'snow', density: 0.55, bright: 0.05, cool: 0.10 },
    { id: 'rain', words: ['雨', '下雨', '雨夜', '细雨', '暴雨', '雷雨'], kind: 'rain', density: 0.52, bright: -0.09, cool: 0.14 },
    { id: 'sakura', words: ['樱花', '花瓣', '落花', '花雨'], kind: 'petal', density: 0.40, warm: 0.06 },
    { id: 'sea', words: ['海', '海边', '大海', '湖', '浪', '河'], horizon: 0.12, bright: 0.05, reflect: 0.5 },
    { id: 'mountain', words: ['山', '远山', '雪山', '悬崖', '峰'], horizon: -0.05, density: 0.04 },
    { id: 'city', words: ['城市', '街', '街道', '楼', '巷子', '广场'], density: 0.18, horizon: -0.02 },
    { id: 'light', words: ['灯', '灯光', '路灯', '霓虹', '招牌', '车灯', '灯笼'], glow: 0.30, density: 0.12 },
    { id: 'fog', words: ['雾', '雾气', '朦胧', '烟'], fog: 0.55, bright: 0.03, density: 0.10 },
    { id: 'fire', words: ['火', '篝火', '烛', '蜡烛', '燃烧', '火焰'], kind: 'ember', glow: 0.25, warm: 0.20, density: 0.18 },
    { id: 'star', words: ['星', '星空', '星星', '银河', '夜空'], kind: 'spark', density: 0.30, bright: -0.04 },
    { id: 'cloud', words: ['云', '云海', '白云', '云端'], cloud: 0.70, bright: 0.04 },
    { id: 'car', words: ['车', '汽车', '跑车', '老车', '列车', '开过去'], traffic: 1, density: 0.08 },
    { id: 'tree', words: ['树', '森林', '竹林', '树叶', '林'], kind: 'leaf', density: 0.12 },
    { id: 'road', words: ['路', '公路', '马路', '街道上', '道'], road: 1, horizon: 0.04 },
    { id: 'night', words: ['夜', '夜晚', '深夜', '半夜', '午夜'], bright: -0.17, cool: 0.20, density: 0.08 },
    { id: 'sunset', words: ['日落', '黄昏', '夕阳', '傍晚', '落日'], warm: 0.22, horizon: 0.02, glow: 0.18 },
    { id: 'dawn', words: ['清晨', '早晨', '黎明', '日出', '晨光'], warm: 0.10, bright: 0.13, cool: -0.08 },
    { id: 'wind', words: ['风', '刮风', '微风', '吹起来', '飘'], wind: 0.55, density: 0.08 },
    { id: 'steam', words: ['蒸汽', '热气', '白气', '蒸气'], fog: 0.35, density: 0.10 },
    { id: 'person', words: ['人', '女孩', '男孩', '她', '他', '影子', '背影'], figure: 1 },
    { id: 'flower', words: ['花', '野花', '花开', '花海'], density: 0.14, warm: 0.05 },
    { id: 'water', words: ['水', '水面', '湿', '雨后', '倒影'], reflect: 0.45 },
    { id: 'gold', words: ['金', '金色', '暖金', '阳光', '日照'], warm: 0.16, glow: 0.12 },
    { id: 'cold', words: ['冷', '冰冷', '灰', '阴天', '灰蓝'], cool: 0.16, bright: -0.05 },
  ];

  /** 把描述扫成一组微调量。返回的对象是纯数据，sceneStats 直接读它做自检。 */
  function matchPrompt(prompt) {
    var text = String(prompt == null ? '' : prompt);
    var v = {
      density: 1, bright: 0, warm: 0, cool: 0, horizon: 0, fog: 0, glow: 0, wind: 1,
      cloud: 0, traffic: 0, road: 0, figure: 0, reflect: 0, kinds: [], hits: []
    };
    if (!text) return v;
    for (var i = 0; i < KEYWORDS.length; i += 1) {
      var k = KEYWORDS[i], hit = false;
      for (var j = 0; j < k.words.length; j += 1) {
        if (text.indexOf(k.words[j]) >= 0) { hit = true; break; }
      }
      if (!hit) continue;
      v.hits.push(k.id);
      v.density += k.density || 0;
      v.bright += k.bright || 0;
      v.warm += k.warm || 0;
      v.cool += k.cool || 0;
      v.horizon += k.horizon || 0;
      v.fog += k.fog || 0;
      v.glow += k.glow || 0;
      v.wind += k.wind || 0;
      v.cloud += k.cloud || 0;
      v.traffic += k.traffic || 0;
      v.road += k.road || 0;
      v.figure += k.figure || 0;
      v.reflect += k.reflect || 0;
      if (k.kind && v.kinds.indexOf(k.kind) < 0) v.kinds.push(k.kind);
    }
    return v;
  }

  /* ── 5. 粒子画像：半径 / 透明度 / 每圈循环次数 / 摆动 ────────────────────
     运动必须「每个 loop 整数圈」，否则 t 回到 0 的那一刻所有粒子会瞬移一下
     （录出来的片子首尾接不上，就是这一下）。fall/rise 给的是**整数圈数上限**，
     xCycles 同理；sway 是像素摆幅，相位来自种子。 */

  var PARTICLE_PROFILE = {
    dust: { r: [0.9, 2.6], a: [0.10, 0.34], xCycles: 2, sway: 8, tw: 0 },
    mote: { r: [0.6, 1.7], a: [0.06, 0.24], xCycles: 1, sway: 4, tw: 0 },
    bokeh: { r: [7, 19], a: [0.10, 0.30], rise: 2, sway: 6, tw: 0 },
    petal: { r: [2.2, 4.6], a: [0.45, 0.90], fall: 3, sway: 16, tw: 0, spin: 2 },
    leaf: { r: [1.8, 3.8], a: [0.35, 0.70], fall: 4, sway: 22, tw: 0, spin: 2 },
    rain: { r: [0.6, 1.3], a: [0.18, 0.46], fall: 14, sway: 2, tw: 0, slant: 0.16, streak: [9, 26] },
    snow: { r: [1.2, 3.2], a: [0.32, 0.78], fall: 3, sway: 20, tw: 0 },
    spark: { r: [0.8, 1.9], a: [0.35, 0.90], fall: 2, sway: 3, tw: 3 },
    ember: { r: [1.0, 2.4], a: [0.36, 0.88], rise: 4, sway: 14, tw: 2 },
    light: { r: [0.8, 2.4], a: [0.30, 0.85], rise: 3, sway: 12, tw: 2 },
  };

  /** 粒子本色的兜底（风格 tint 优先）。雨雪这类「物理色」不跟调色板走，否则紫风里下雨是紫的。 */
  var KIND_COLOR = {
    dust: '#ffe6b0', mote: '#cfe0ff', bokeh: '#fff6dd', petal: '#ffd4e6',
    leaf: '#e8c9a0', rain: '#d8f4ff', snow: '#ffffff', spark: '#fffdf2',
    ember: '#ffb066', light: '#fff0fb'
  };

  /* ── 6. 纯数据层：把「风格 + 描述 + 种子」算成一份场景 ───────────────────
     这一层绝不碰 canvas —— Node 自检（sceneStats）靠的就是这条边界。 */

  function normalize(opts) {
    var o = opts || {};
    var w = Math.round(Number(o.width) || 960);
    var h = Math.round(Number(o.height) || 540);
    return {
      styleId: o.styleId || 'cinematic',
      prompt: o.prompt == null ? '' : String(o.prompt),
      seed: o.seed == null ? 1 : o.seed,
      width: clamp(w, 64, 4096),
      height: clamp(h, 64, 4096),
      aspect: o.aspect || '16:9',
      fps: clamp(Math.round(Number(o.fps) || 30), 1, 60),
      ms: clamp(Math.round(Number(o.ms) || 6000), 250, 60000),
      doc: o.doc || null,
    };
  }

  function aspectNum(aspect) {
    var m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)/.exec(String(aspect || '16:9'));
    if (m) {
      var a = parseFloat(m[1]) / parseFloat(m[2]);
      if (isFinite(a) && a > 0) return a;
    }
    return 16 / 9;
  }

  function normalizeTime(tMs) {
    var ms = Number(tMs);
    if (!isFinite(ms)) ms = 0;
    return modPos(ms, LOOP_MS);
  }

  function makeParticle(sc, kind, rnd) {
    var prof = PARTICLE_PROFILE[kind] || PARTICLE_PROFILE.dust;
    var k = clamp(Math.min(sc.width, sc.height) / 540, 0.62, 1.7);
    var q = {
      kind: kind,
      x0: rnd(),
      y0: rnd(),
      nx: 0,
      ny: 0,
      sw: prof.sway ? prof.sway * k * (0.35 + rnd()) : 0,
      swN: 1 + Math.floor(rnd() * 2),
      ph: rnd(),
      r: (prof.r[0] + rnd() * (prof.r[1] - prof.r[0])) * k,
      a: prof.a[0] + rnd() * (prof.a[1] - prof.a[0]),
      tw: prof.tw ? (1 + Math.floor(rnd() * prof.tw)) : 0,
      spin: prof.spin ? (1 + Math.floor(rnd() * prof.spin)) : 0,
      sl: 0,
      len: 0,
      color: ''
    };
    if (prof.xCycles) q.nx = (1 + Math.floor(rnd() * prof.xCycles)) * (rnd() < 0.5 ? -1 : 1);
    if (prof.fall) q.ny = 1 + Math.floor(rnd() * prof.fall);
    else if (prof.rise) q.ny = -(1 + Math.floor(rnd() * prof.rise));
    if (prof.streak) {
      q.len = prof.streak[0] + rnd() * (prof.streak[1] - prof.streak[0]);
      q.sl = q.len * (prof.slant || 0);
    }
    var tint = sc.cfg.tint && sc.cfg.tint[kind];
    q.color = tint || KIND_COLOR[kind] || sc.palette[3];
    return q;
  }

  /** 每个风格自带一点「画面外的道具」：霓虹灯管、飞鸟、飘带、烛台。位置也要过种子。 */
  function buildExtras(sc, rnd) {
    var w = sc.width, h = sc.height, i;
    var ex = { signs: [], birds: [], ribbons: [], lanterns: [], groundY: h * 0.9 };

    if (sc.styleId === 'cyberpunk') {
      // 竖招牌：位置/长度/颜色都随种子，闪烁相位分开，避免整齐划一地闪
      for (i = 0; i < 7; i += 1) {
        ex.signs.push({
          x: (0.03 + i * 0.142) * w,
          y: (0.16 + rnd() * 0.30) * h,
          wd: (0.006 + rnd() * 0.016) * w,
          ht: (0.16 + rnd() * 0.38) * h,
          col: sc.palette[1 + (i % 3)],
          ph: rnd(),
          tw: 2 + Math.floor(rnd() * 4)
        });
      }
      ex.groundY = Math.round(h * 0.86);
    }

    if (sc.styleId === 'guofeng') {
      for (i = 0; i < 3; i += 1) ex.birds.push({ x: 0.15 + rnd() * 0.6, y: 0.14 + rnd() * 0.18, s: 0.8 + rnd() * 0.7, ph: rnd() });
      ex.groundY = Math.round(h * 0.80);
    }

    if (sc.styleId === 'fantasy') {
      for (i = 0; i < 2; i += 1) ex.ribbons.push({ y: 0.30 + i * 0.26, amp: 0.035 + i * 0.015, ph: rnd() * TAU });
      for (i = 0; i < 6; i += 1) ex.lanterns.push({ x: 0.08 + rnd() * 0.84, y: 0.55 + rnd() * 0.32, r: 1.4 + rnd() * 2.4, ph: rnd() });
    }

    if (sc.styleId === 'dark') {
      ex.candle = { x: w * 0.33, y: h * 0.845 };
      ex.window = { x: w * 0.60, y: h * 0.12, w: w * 0.28, h: h * 0.52 };
    }

    if (sc.styleId === 'anime') {
      ex.clouds = [
        { y: 0.10, s: 1.00, sp: 1, a: 0.85 },
        { y: 0.17, s: 0.72, sp: 1, a: 0.60 },
        { y: 0.26, s: 0.52, sp: 2, a: 0.42 }
      ];
    }

    return ex;
  }

  function buildStars(sc, rnd) {
    var want = sc.styleId === 'fantasy' ? 16 : (sc.styleId === 'anime' ? 9 : (sc.styleId === 'dark' ? 6 : 0));
    var out = [];
    for (var i = 0; i < want; i += 1) {
      out.push({
        x: rnd(), y: rnd() * 0.62,
        r: 1.6 + rnd() * (sc.styleId === 'anime' ? 3.4 : 2.2),
        ph: rnd(), tw: 1 + Math.floor(rnd() * 3)
      });
    }
    return out;
  }

  function buildScene(o) {
    var cfg = STYLE_SCENE[o.styleId] || STYLE_SCENE.cinematic;
    var style = styleById(o.styleId) || styleById('cinematic') || BUILTIN_STYLES[0];
    var v = matchPrompt(o.prompt);
    var ar = aspectNum(o.aspect);
    var seed = (seedInt(o.seed) ^ hashStr(style.id)) >>> 0;
    var rnd = mulberry32(seed);
    var areaF = Math.sqrt((o.width * o.height) / (960 * 540));

    var total = clamp(Math.round(MAX_PARTICLES * cfg.density * v.density * areaF), 14, MAX_PARTICLES);

    var sc = {
      styleId: style.id,
      label: style.label || style.id,
      prompt: o.prompt,
      width: o.width,
      height: o.height,
      aspectNum: ar,
      seed: seed,
      doc: o.doc || null,
      cfg: cfg,
      variant: v,
      palette: shiftPalette(style.palette, (v.warm - v.cool) * 9, 1 + v.warm * 0.10 - v.cool * 0.04, clamp(1 + v.bright * 0.22, 0.78, 1.22)),
      horizon: clamp(cfg.horizon + v.horizon, 0.42, 0.88) * o.height,
      letterbox: style.id === 'cinematic' ? Math.round(o.height * (ar >= 2.1 ? 0.145 : 0.095)) : 0,
      particles: [],
      stars: [],
      extras: {},
      loopMs: LOOP_MS,
      signature: 0
    };

    // 粒子配比：主粒子占大头，描述里点名的天气/星火最多再叠两种（再多就变成一锅糊）
    var kinds = [cfg.kind];
    for (var ek = 0; ek < v.kinds.length && kinds.length < 3; ek += 1) {
      if (kinds.indexOf(v.kinds[ek]) < 0) kinds.push(v.kinds[ek]);
    }
    var weights = kinds.map(function (_, i) { return i === 0 ? 0.66 : 0.17; });
    var sumW = 0;
    for (var wi = 0; wi < weights.length; wi += 1) sumW += weights[wi];
    var used = 0;
    for (var ki = 0; ki < kinds.length; ki += 1) {
      var n = ki === kinds.length - 1 ? total - used : Math.round(total * weights[ki] / sumW);
      n = Math.max(0, n);
      used += n;
      for (var c = 0; c < n; c += 1) sc.particles.push(makeParticle(sc, kinds[ki], rnd));
    }
    // 按 kind 分组、组内按 alpha 降序：绘制时 fillStyle 只在换 kind 时切换一次
    sc.particles.sort(function (A, B) {
      if (A.kind === B.kind) return B.a - A.a;
      return A.kind < B.kind ? -1 : 1;
    });
    if (!sc.particles.length) sc.particles.push(makeParticle(sc, cfg.kind, rnd));

    sc.stars = buildStars(sc, rnd);
    sc.extras = buildExtras(sc, rnd);

    // 布点指纹：同 seed 必同、异 seed 必异。sceneStats 靠它证明种子真的生效了
    var hh = 2166136261;
    for (var pi = 0; pi < sc.particles.length; pi += 1) {
      var q = sc.particles[pi];
      hh ^= ((q.x0 * 4096) | 0) ^ (((q.y0 * 4096) | 0) << 7) ^ ((q.ph * 4096) | 0);
      hh = Math.imul(hh, 16777619) >>> 0;
    }
    sc.signature = hh >>> 0;
    return sc;
  }

  /** 自检 / 调试入口：只跑纯数据层，因此 Node 下可用。 */
  function sceneStats(opts) {
    var sc = buildScene(normalize(opts));
    return {
      styleId: sc.styleId,
      particles: sc.particles.length,
      palette: sc.palette.slice(),
      motion: {
        zoomFrom: 1,
        zoomTo: sc.cfg.zoomTo,
        panX: sc.cfg.panX,
        horizon: sc.horizon,
        periodMs: LOOP_MS,
        signature: sc.signature
      }
    };
  }

  /* ── 7. 绘制工具 ──────────────────────────────────────────────────────── */

  function grad(ctx, x0, y0, x1, y1, stops) {
    var g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (var i = 0; i < stops.length; i += 1) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  }

  function rgrad(ctx, x, y, r, stops) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.001, r));
    for (var i = 0; i < stops.length; i += 1) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  }

  function getDoc() {
    if (root && root.document && typeof root.document.createElement === 'function') return root.document;
    return null;
  }

  function makeCanvas(doc, w, h) {
    if (!doc || typeof doc.createElement !== 'function') return null;
    var c = doc.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /**
   * 单位空间渐变：在 (0,0,0)→(0,0,1) 这种 1×1 坐标里建一次，用 translate+scale 贴到任意位置。
   * 这是本文件「每帧不新建渐变」的关键：光晕、雾带、反光、窗光全部复用同一批对象。
   */
  function drawUnitGlow(ctx, g, x, y, r, alpha) {
    if (!g || !(r > 0)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(r, r);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  /** 单位带宽渐变：rw/rh 是**半宽/半高**（渐变定义在 -1..1）。 */
  function drawUnitBand(ctx, g, x, y, rw, rh, alpha) {
    if (!g || !(rw > 0) || !(rh > 0)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(rw, rh);
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  /* ── 8. 静态层：每个风格一张「背景烘图」 ─────────────────────────────────
     远山、楼体、窗棂、水岸这些每帧都不变，画一次存成 canvas，之后每帧一次
     drawImage 就够。这样推近运镜也不用重画，只是把这张图放大。 */

  function bgCinematic(ctx, sc) {
    var w = sc.width, h = sc.height, P = sc.palette, hz = sc.horizon;
    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [
      [0, mixHex(P[0], '#000000', 0.45)],
      [0.42, mixHex(P[0], P[1], 0.85)],
      [0.70, P[1]],
      [1, mixHex(P[2], P[1], 0.30)]
    ]);
    ctx.fillRect(0, 0, w, h);

    var sx = w * 0.62, sy = hz * 0.95;
    ctx.fillStyle = rgrad(ctx, sx, sy, h * 0.66, [[0, rgba(P[3], 0.50)], [0.30, rgba(P[2], 0.30)], [1, rgba(P[2], 0)]]);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = rgrad(ctx, sx, sy, h * 0.13, [[0, rgba(P[3], 0.92)], [0.55, rgba(P[3], 0.35)], [1, rgba(P[3], 0)]]);
    ctx.fillRect(0, 0, w, h);

    // 远山折线：地平线以下全部压暗，给公路留出「一条通达远方的路」
    ctx.beginPath();
    ctx.moveTo(0, hz + h * 0.02);
    ctx.lineTo(w * 0.18, hz - h * 0.055);
    ctx.lineTo(w * 0.33, hz - h * 0.012);
    ctx.lineTo(w * 0.52, hz - h * 0.048);
    ctx.lineTo(w * 0.72, hz - h * 0.008);
    ctx.lineTo(w * 0.88, hz - h * 0.038);
    ctx.lineTo(w, hz);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = rgba(mixHex(P[0], P[1], 0.22), 0.96);
    ctx.fill();

    // 公路：梯形 + 中线虚线（近处更宽，透视感全靠它）
    var vx = w * 0.50;
    ctx.beginPath();
    ctx.moveTo(vx - w * 0.032, hz);
    ctx.lineTo(vx + w * 0.032, hz);
    ctx.lineTo(w * 1.04, h);
    ctx.lineTo(-w * 0.04, h);
    ctx.closePath();
    // 路面比远山亮一档：逆光片的公路永远「接住」天光，全压黑就看不见这条路了
    ctx.fillStyle = rgba(mixHex(P[1], '#000000', 0.22), 0.98);
    ctx.fill();

    // 路肩反光：两条边缘光，是把「路」从背景里拉出来的关键，比加虚线的性价比高
    ctx.strokeStyle = rgba(mixHex(P[2], P[3], 0.45), 0.28);
    ctx.lineWidth = Math.max(1, h * 0.0035);
    ctx.beginPath();
    ctx.moveTo(vx - w * 0.032, hz);
    ctx.lineTo(-w * 0.04, h);
    ctx.moveTo(vx + w * 0.032, hz);
    ctx.lineTo(w * 1.04, h);
    ctx.stroke();

    ctx.strokeStyle = rgba(mixHex(P[2], P[3], 0.45), 0.42);
    ctx.lineWidth = Math.max(1, h * 0.004);
    for (var d = 1; d <= 5; d += 1) {
      var t = d / 5;
      var y = hz + (h - hz) * t * t;
      var halfW = w * (0.012 + 0.20 * t * t);
      ctx.beginPath();
      ctx.moveTo(vx - halfW * 0.10, y);
      ctx.lineTo(vx + halfW * 0.10, y);
      ctx.stroke();
    }

    // 车：地平线上一辆剪影，加一道逆光轮廓 + 尾灯，否则在暗调里等于没画
    var cx = vx + w * 0.11, cy = hz + (h - hz) * 0.34, cs = h * 0.070;
    ctx.fillStyle = rgba('#06060a', 1);
    ctx.fillRect(cx - cs * 1.5, cy - cs * 0.42, cs * 3.0, cs * 0.62);
    ctx.beginPath();
    ctx.moveTo(cx - cs * 1.05, cy - cs * 0.42);
    ctx.lineTo(cx - cs * 0.62, cy - cs * 1.02);
    ctx.lineTo(cx + cs * 0.55, cy - cs * 1.02);
    ctx.lineTo(cx + cs * 0.95, cy - cs * 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = rgba(mixHex(P[3], P[2], 0.35), 0.55);
    ctx.lineWidth = Math.max(1, h * 0.0022);
    ctx.beginPath();
    ctx.moveTo(cx - cs * 0.62, cy - cs * 1.02);
    ctx.lineTo(cx + cs * 0.55, cy - cs * 1.02);
    ctx.stroke();
    ctx.fillStyle = rgba(mixHex(P[3], P[2], 0.30), 0.9);
    ctx.fillRect(cx + cs * 1.18, cy - cs * 0.30, cs * 0.26, cs * 0.18);
    ctx.fillStyle = rgba(P[2], 0.85);
    ctx.fillRect(cx - cs * 1.52, cy - cs * 0.26, cs * 0.22, cs * 0.14);
    ctx.fillStyle = rgba('#06060a', 1);
    ctx.beginPath();
    ctx.arc(cx - cs * 0.95, cy + cs * 0.24, cs * 0.26, 0, TAU);
    ctx.arc(cx + cs * 0.95, cy + cs * 0.24, cs * 0.26, 0, TAU);
    ctx.fill();
  }

  function bgPhoto(ctx, sc) {
    var w = sc.width, h = sc.height, P = sc.palette, hz = sc.horizon;
    var rnd = mulberry32(sc.seed ^ 0x2a17);

    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [
      [0, mixHex(P[0], P[2], 0.55)],
      [0.55, P[2]],
      [1, mixHex(P[0], P[1], 0.55)]
    ]);
    ctx.fillRect(0, 0, w, h);

    // 远景楼群：只给剪影和窗格，写实的「像」来自灰蓝层次，不是细节
    for (var i = 0; i < 5; i += 1) {
      var bw = w * (0.07 + rnd() * 0.08);
      var bh = h * (0.20 + rnd() * 0.32);
      var bx = w * (0.40 + i * 0.125);
      ctx.fillStyle = rgba(mixHex(P[1], P[2], 0.30 + rnd() * 0.32), 0.86);
      ctx.fillRect(bx, hz - bh, bw, bh + h * 0.05);
      ctx.fillStyle = rgba(mixHex(P[3], P[2], 0.4), 0.22);
      for (var wy = 0; wy < 6; wy += 1) {
        for (var wx = 0; wx < 3; wx += 1) {
          if (rnd() < 0.45) continue;
          ctx.fillRect(bx + bw * (0.16 + wx * 0.28), hz - bh + bh * (0.08 + wy * 0.15), bw * 0.16, bh * 0.06);
        }
      }
    }

    // 左侧玻璃幕墙：这风格的主角，竖向分格 + 斜面高光
    var gx = w * 0.02, gy = h * 0.08, gw = w * 0.30, gh = h * 0.80;
    ctx.fillStyle = grad(ctx, gx, gy, gx + gw, gy + gh, [
      [0, mixHex(P[1], '#ffffff', 0.10)],
      [0.48, mixHex(P[1], P[2], 0.55)],
      [1, mixHex(P[1], '#000000', 0.20)]
    ]);
    ctx.fillRect(gx, gy, gw, gh);
    ctx.strokeStyle = rgba(mixHex(P[2], '#ffffff', 0.55), 0.50);
    ctx.lineWidth = Math.max(1, w * 0.0012);
    for (var c = 1; c < 6; c += 1) {
      ctx.beginPath();
      ctx.moveTo(gx + gw * c / 6, gy);
      ctx.lineTo(gx + gw * c / 6, gy + gh);
      ctx.stroke();
    }
    for (var r2 = 1; r2 < 8; r2 += 1) {
      ctx.beginPath();
      ctx.moveTo(gx, gy + gh * r2 / 8);
      ctx.lineTo(gx + gw, gy + gh * r2 / 8);
      ctx.stroke();
    }
    ctx.strokeStyle = rgba('#eef4f9', 0.35);
    ctx.lineWidth = Math.max(1, w * 0.0015);
    ctx.strokeRect(gx, gy, gw, gh);

    // 浅景深光点：靠软边径向而不是模糊滤镜（滤镜在这类循环里是性能黑洞）
    for (var b = 0; b < 7; b += 1) {
      var bx2 = w * (0.42 + rnd() * 0.56);
      var by2 = h * (0.30 + rnd() * 0.52);
      var br = h * (0.02 + rnd() * 0.045);
      ctx.fillStyle = rgrad(ctx, bx2, by2, br * 1.9, [[0, rgba(P[3], 0.85)], [0.45, rgba(P[3], 0.28)], [1, rgba(P[3], 0)]]);
      ctx.fillRect(bx2 - br * 2, by2 - br * 2, br * 4, br * 4);
    }

    // 地面：一格亮边 + 湿反光
    ctx.fillStyle = rgba(mixHex(P[0], P[1], 0.55), 0.95);
    ctx.fillRect(0, h * 0.88, w, h * 0.12);
    ctx.fillStyle = rgba(mixHex(P[2], '#ffffff', 0.5), 0.28);
    ctx.fillRect(0, h * 0.88, w, Math.max(1, h * 0.003));
  }

  function bgAnime(ctx, sc) {
    var w = sc.width, h = sc.height, P = sc.palette, hz = sc.horizon;
    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [
      [0, P[0]],
      [0.55, P[1]],
      [1, mixHex(P[2], P[1], 0.25)]
    ]);
    ctx.fillRect(0, 0, w, h);

    // 太阳：二次元的太阳是「白芯 + 粉边」，不给写实的橙
    ctx.fillStyle = rgrad(ctx, w * 0.78, h * 0.33, h * 0.42, [[0, rgba('#fffdf2', 0.95)], [0.30, rgba(P[2], 0.55)], [1, rgba(P[2], 0)]]);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = rgrad(ctx, w * 0.78, h * 0.33, h * 0.10, [[0, rgba('#ffffff', 0.95)], [1, rgba('#fffdf2', 0)]]);
    ctx.fillRect(0, 0, w, h);

    // 云：每团由 3 个软椭圆错位叠出来（单椭圆一定读作飞碟，动画里的云边也是渐隐的）
    var cloudSet = [[0.16, 0.13, 0.22, 0.070, 0.92], [0.34, 0.085, 0.15, 0.045, 0.80], [0.64, 0.21, 0.18, 0.050, 0.58]];
    for (var i = 0; i < cloudSet.length; i += 1) {
      var c = cloudSet[i];
      softBlob(ctx, w * c[0], h * c[1], w * c[2], h * c[3], '#ffffff', c[4] * 0.85);
      softBlob(ctx, w * (c[0] + c[2] * 0.46), h * (c[1] - c[3] * 0.55), w * c[2] * 0.62, h * c[3] * 0.85, '#ffffff', c[4] * 0.72);
      softBlob(ctx, w * (c[0] - c[2] * 0.42), h * (c[1] + c[3] * 0.28), w * c[2] * 0.54, h * c[3] * 0.70, '#ffffff', c[4] * 0.58);
    }

    // 地面 + 天台栏杆 + 两个人剪影（和缩略图同一套构图）
    ctx.fillStyle = rgba(P[3], 0.95);
    ctx.fillRect(0, hz + h * 0.12, w, h);
    ctx.strokeStyle = rgba(mixHex(P[1], '#ffffff', 0.6), 0.95);
    ctx.lineWidth = Math.max(2, h * 0.006);
    ctx.beginPath();
    ctx.moveTo(0, hz + h * 0.08);
    ctx.lineTo(w, hz + h * 0.08);
    ctx.stroke();
    ctx.lineWidth = Math.max(2, h * 0.005);
    for (var r = 0; r <= 8; r += 1) {
      ctx.beginPath();
      ctx.moveTo(w * r / 8, hz + h * 0.08);
      ctx.lineTo(w * r / 8, hz + h * 0.20);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(mixHex(P[3], '#000000', 0.45), 1);
    ctx.beginPath();
    ctx.arc(w * 0.42, hz + h * 0.02, h * 0.019, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w * 0.395, hz + h * 0.08);
    ctx.quadraticCurveTo(w * 0.42, hz + h * 0.02, w * 0.445, hz + h * 0.08);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w * 0.53, hz + h * 0.035, h * 0.017, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w * 0.508, hz + h * 0.085);
    ctx.quadraticCurveTo(w * 0.53, hz + h * 0.028, w * 0.552, hz + h * 0.085);
    ctx.fill();
  }

  function bgGuofeng(ctx, sc) {
    var w = sc.width, h = sc.height, P = sc.palette, hz = sc.horizon;
    var rnd = mulberry32(sc.seed ^ 0x77ab);

    // 宣纸：底色偏暖，加一层极淡的噪点当纤维（噪点只在烘焙时算一次）
    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [[0, mixHex(P[0], '#ffffff', 0.18)], [1, mixHex(P[0], P[3], 0.10)]]);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = rgba('#ffffff', 0.05);
    for (var f = 0; f < 260; f += 1) {
      ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 14, 1);
    }

    // 红日：低饱和圆心 + 大晕，国风里这轮日头几乎等于构图锚点
    var sx = w * 0.74, sy = h * 0.22;
    ctx.fillStyle = rgrad(ctx, sx, sy, h * 0.30, [[0, rgba(P[2], 0.55)], [0.35, rgba(P[2], 0.20)], [1, rgba(P[2], 0)]]);
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = rgba(P[2], 0.82);
    ctx.beginPath();
    ctx.arc(sx, sy, h * 0.052, 0, TAU);
    ctx.fill();

    // 三层远山：越远越淡越平，这是水墨唯一的「纵深」语言
    var layers = [
      { base: hz - h * 0.02, amp: h * 0.15, col: mixHex(P[1], P[0], 0.55), a: 0.42, sd: 11 },
      { base: hz + h * 0.06, amp: h * 0.11, col: P[1], a: 0.48, sd: 27 },
      { base: hz + h * 0.16, amp: h * 0.07, col: P[3], a: 0.55, sd: 43 }
    ];
    for (var L = 0; L < layers.length; L += 1) {
      var ly = layers[L], lr = mulberry32(sc.seed ^ ly.sd);
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, ly.base);
      var px = 0, py = ly.base;
      var steps = 8;
      for (var s = 1; s <= steps; s += 1) {
        var nx = (s / steps) * w;
        var ny = ly.base - ly.amp * (0.15 + lr() * 0.95);
        ctx.quadraticCurveTo((px + nx) * 0.5, py, nx, ny);
        px = nx;
        py = ny;
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.globalAlpha = ly.a;
      ctx.fillStyle = ly.col;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 水岸线 + 孤舟 + 远处两只飞鸟
    ctx.strokeStyle = rgba(mixHex(P[3], P[1], 0.5), 0.35);
    ctx.lineWidth = Math.max(1, h * 0.0025);
    for (var wl = 0; wl < 4; wl += 1) {
      var yy = h * (0.80 + wl * 0.045);
      ctx.beginPath();
      ctx.moveTo(w * 0.06 + wl * w * 0.02, yy);
      ctx.lineTo(w * (0.55 + wl * 0.05), yy);
      ctx.stroke();
    }
    var bx = w * 0.30, by = h * 0.795;
    ctx.fillStyle = rgba('#2f2a22', 0.9);
    ctx.beginPath();
    ctx.moveTo(bx - w * 0.035, by);
    ctx.quadraticCurveTo(bx, by + h * 0.028, bx + w * 0.038, by);
    ctx.quadraticCurveTo(bx, by + h * 0.012, bx - w * 0.035, by);
    ctx.fill();
    ctx.fillRect(bx - w * 0.002, by - h * 0.038, Math.max(1, w * 0.002), h * 0.038);
    ctx.beginPath();
    ctx.moveTo(bx, by - h * 0.036);
    ctx.lineTo(bx + w * 0.030, by - h * 0.020);
    ctx.lineTo(bx, by - h * 0.014);
    ctx.fill();

    ctx.strokeStyle = rgba('#4a4436', 0.72);
    ctx.lineWidth = Math.max(1, h * 0.0022);
    var birds = sc.extras.birds || [];
    for (var bi = 0; bi < birds.length; bi += 1) {
      var bd = birds[bi];
      var bbx = bd.x * w, bby = bd.y * h, bss = h * 0.012 * bd.s;
      ctx.beginPath();
      ctx.moveTo(bbx - bss, bby);
      ctx.quadraticCurveTo(bbx - bss * 0.4, bby - bss * 0.7, bbx, bby);
      ctx.quadraticCurveTo(bbx + bss * 0.4, bby - bss * 0.7, bbx + bss, bby);
      ctx.stroke();
    }
  }

  function bgCyberpunk(ctx, sc) {
    var w = sc.width, h = sc.height, P = sc.palette, hz = sc.horizon;
    var rnd = mulberry32(sc.seed ^ 0x3e9d);
    var gy = sc.extras.groundY || h * 0.86;

    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [
      [0, mixHex(P[0], '#000000', 0.35)],
      [0.55, mixHex(P[0], P[3], 0.10)],
      [1, mixHex(P[0], '#000000', 0.55)]
    ]);
    ctx.fillRect(0, 0, w, h);

    // 两侧楼体：刻意不对称，中间留一条巷子。楼体要比天更黑，否则霓虹就浮在紫色空气里
    ctx.fillStyle = rgba(mixHex(P[0], '#000000', 0.55), 1);
    ctx.beginPath();
    ctx.moveTo(0, h); ctx.lineTo(0, hz * 0.42);
    ctx.lineTo(w * 0.26, hz * 0.55); ctx.lineTo(w * 0.26, h);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(w, h); ctx.lineTo(w, hz * 0.34);
    ctx.lineTo(w * 0.70, hz * 0.50); ctx.lineTo(w * 0.70, h);
    ctx.closePath(); ctx.fill();
    // 楼体临街的一侧压一道极淡的边光，读得出「这是两栋楼」而不是两团黑
    ctx.strokeStyle = rgba(P[3], 0.22);
    ctx.lineWidth = Math.max(1, w * 0.0016);
    ctx.beginPath();
    ctx.moveTo(w * 0.26, hz * 0.55); ctx.lineTo(w * 0.26, h);
    ctx.moveTo(w * 0.70, hz * 0.50); ctx.lineTo(w * 0.70, h);
    ctx.stroke();

    // 窗：只画亮的，暗的不画（省一半绘制量，视觉上没区别）
    for (var i = 0; i < 110; i += 1) {
      var cxp = rnd() < 0.5 ? rnd() * w * 0.25 : w * (0.72 + rnd() * 0.27);
      var cyp = hz * 0.45 + rnd() * (gy - hz * 0.45);
      var col = [P[1], P[2], P[3]][Math.floor(rnd() * 3)];
      ctx.fillStyle = rgba(col, 0.16 + rnd() * 0.46);
      ctx.fillRect(cxp, cyp, w * 0.008, h * 0.012);
    }

    // 霓虹招牌（静态部分）：光晕压得比灯管宽一圈，湿雨夜的味道全靠这个外溢
    var signs = sc.extras.signs || [];
    for (var s = 0; s < signs.length; s += 1) {
      var sg = signs[s];
      ctx.fillStyle = rgrad(ctx, sg.x + sg.wd * 0.5, sg.y + sg.ht * 0.5, Math.max(sg.wd * 3.4, sg.ht * 0.30),
        [[0, rgba(sg.col, 0.42)], [1, rgba(sg.col, 0)]]);
      ctx.fillRect(sg.x - sg.ht * 0.3, sg.y - sg.ht * 0.3, sg.wd + sg.ht * 0.6, sg.ht * 1.6);
      ctx.fillStyle = rgba(mixHex(sg.col, '#ffffff', 0.25), 0.92);
      ctx.fillRect(sg.x, sg.y, sg.wd, sg.ht);
    }

    // 横向霓虹牌：巷子中间一道，是画面的主视线
    ctx.fillStyle = rgba(P[1], 0.9);
    ctx.fillRect(w * 0.30, hz * 0.72, w * 0.40, Math.max(2, h * 0.010));
    ctx.fillStyle = rgba(P[2], 0.75);
    ctx.fillRect(w * 0.26, hz * 0.86, w * 0.46, Math.max(1, h * 0.005));

    // 湿地面：先压实，再铺一层霓虹的总反光（细节留给缓存的倒影图）
    ctx.fillStyle = rgba(mixHex(P[0], '#000000', 0.72), 1);
    ctx.fillRect(0, gy, w, h - gy);
    ctx.fillStyle = rgrad(ctx, w * 0.5, gy, w * 0.55, [[0, rgba(P[1], 0.16)], [0.5, rgba(P[2], 0.08)], [1, rgba(P[2], 0)]]);
    ctx.fillRect(0, gy, w, h - gy);
    ctx.fillStyle = rgba(P[2], 0.16);
    ctx.fillRect(0, gy, w, Math.max(1, h * 0.0025));
  }

  function bgDark(ctx, sc) {
    var w = sc.width, h = sc.height, P = sc.palette;
    var win = sc.extras.window || { x: w * 0.6, y: h * 0.12, w: w * 0.28, h: h * 0.52 };
    var candle = sc.extras.candle || { x: w * 0.33, y: h * 0.845 };

    ctx.fillStyle = grad(ctx, 0, 0, 0, h, [
      [0, mixHex(P[0], '#000000', 0.30)],
      [0.62, P[0]],
      [1, mixHex(P[0], '#000000', 0.60)]
    ]);
    ctx.fillRect(0, 0, w, h);

    // 冷窗：全片唯一冷光源，位置固定在右上（经典低调光三角）
    ctx.fillStyle = grad(ctx, win.x, win.y, win.x, win.y + win.h, [
      [0, mixHex(P[1], '#ffffff', 0.22)],
      [1, mixHex(P[1], P[0], 0.45)]
    ]);
    ctx.fillRect(win.x, win.y, win.w, win.h);
    ctx.strokeStyle = rgba(mixHex(P[0], '#000000', 0.15), 0.95);
    ctx.lineWidth = Math.max(2, w * 0.005);
    ctx.beginPath();
    ctx.moveTo(win.x + win.w * 0.5, win.y);
    ctx.lineTo(win.x + win.w * 0.5, win.y + win.h);
    ctx.moveTo(win.x, win.y + win.h * 0.46);
    ctx.lineTo(win.x + win.w, win.y + win.h * 0.46);
    ctx.stroke();
    ctx.fillStyle = rgrad(ctx, win.x + win.w * 0.5, win.y + win.h * 0.5, w * 0.52, [[0, rgba(P[1], 0.24)], [1, rgba(P[1], 0)]]);
    ctx.fillRect(0, 0, w, h);

    // 地面 + 桌面
    ctx.fillStyle = rgba(mixHex(P[0], '#000000', 0.45), 1);
    ctx.fillRect(0, h * 0.80, w, h * 0.20);
    ctx.fillStyle = rgba(mixHex(P[0], P[1], 0.22), 0.85);
    ctx.fillRect(candle.x - w * 0.14, candle.y, w * 0.28, Math.max(2, h * 0.008));

    // 蜡烛本体：蜡身用暖白，不是纯白，纯白在这个环境里会跳出来
    ctx.fillStyle = rgba(mixHex(P[3], '#ffffff', 0.55), 0.95);
    ctx.fillRect(candle.x - w * 0.013, candle.y - h * 0.14, w * 0.026, h * 0.14);
    ctx.fillStyle = rgba(mixHex(P[0], '#000000', 0.2), 0.9);
    ctx.fillRect(candle.x - w * 0.018, candle.y - h * 0.006, w * 0.036, h * 0.010);
  }

  function bgFantasy(ctx, sc) {
    var w = sc.width, h = sc.height, P = sc.palette;
    var rnd = mulberry32(sc.seed ^ 0x6b21);

    ctx.fillStyle = grad(ctx, 0, 0, w, h, [
      [0, mixHex(P[0], '#000000', 0.20)],
      [0.45, P[1]],
      [1, P[2]]
    ]);
    ctx.fillRect(0, 0, w, h);

    // 主光团：梦幻感 90% 来自这一个柔光，而不是加粒子
    ctx.fillStyle = rgrad(ctx, w * 0.66, h * 0.35, h * 0.55, [[0, rgba(P[3], 0.70)], [0.35, rgba(P[2], 0.28)], [1, rgba(P[2], 0)]]);
    ctx.fillRect(0, 0, w, h);

    // 云海：每团也是软边叠出来的，压得很扁（俯视云海的透视就是扁的）
    for (var i = 0; i < 6; i += 1) {
      var cx = rnd() * w, cy = h * (0.62 + rnd() * 0.32), rw = w * (0.10 + rnd() * 0.18), rh = h * (0.022 + rnd() * 0.032);
      var ccol = mixHex(P[3], P[2], rnd() * 0.5);
      softBlob(ctx, cx, cy, rw, rh, ccol, 0.22 + rnd() * 0.16);
      softBlob(ctx, cx + rw * 0.35, cy - rh * 0.45, rw * 0.6, rh * 0.8, ccol, 0.14 + rnd() * 0.10);
    }

    // 尖塔剪影
    var tx = w * 0.62;
    ctx.fillStyle = rgba(mixHex(P[3], P[0], 0.35), 0.55);
    ctx.beginPath();
    ctx.moveTo(tx, h * 0.30);
    ctx.lineTo(tx + w * 0.030, h * 0.86);
    ctx.lineTo(tx - w * 0.030, h * 0.86);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = rgba(P[3], 0.55);
    ctx.beginPath();
    ctx.moveTo(tx, h * 0.22);
    ctx.lineTo(tx + w * 0.012, h * 0.34);
    ctx.lineTo(tx - w * 0.012, h * 0.34);
    ctx.closePath();
    ctx.fill();

    // 远处灯笼：小暖点，用来把「云海」和「有人间」连起来
    var lanterns = sc.extras.lanterns || [];
    for (var L = 0; L < lanterns.length; L += 1) {
      var ln = lanterns[L];
      ctx.fillStyle = rgrad(ctx, ln.x * w, ln.y * h, ln.r * h * 0.012, [[0, rgba('#ffd9f2', 0.75)], [1, rgba('#ffd9f2', 0)]]);
      ctx.fillRect(ln.x * w - ln.r * h * 0.02, ln.y * h - ln.r * h * 0.02, ln.r * h * 0.04, ln.r * h * 0.04);
    }
  }

  var BG = {
    cinematic: bgCinematic,
    photo: bgPhoto,
    anime: bgAnime,
    guofeng: bgGuofeng,
    cyberpunk: bgCyberpunk,
    dark: bgDark,
    fantasy: bgFantasy
  };

  /* ── 9. 缓存：每帧都要用、但每帧都一样的东西 ────────────────────────────
     渐变、噪点贴图、扫描线、暗角、倒影、云贴图全在这里做一次。
     resize / 换风格 / 换种子时整块丢掉重建 —— 这是「不每帧重建渐变」的落点。 */

  function buildCache(ctx, sc) {
    var doc = sc.doc || getDoc();
    var c = {
      w: sc.width, h: sc.height,
      bg: null, reflect: null, cloud: null,
      grainPattern: null, scanPattern: null,
      vignette: null, unitGlow: null, unitSoft: null, unitSweep: null, unitMist: null
    };
    var i;

    if (doc) {
      c.bg = makeCanvas(doc, sc.width, sc.height);
      if (c.bg) {
        var bctx = c.bg.getContext('2d');
        if (bctx) (BG[sc.styleId] || BG.cinematic)(bctx, sc);
      }

      // 赛博朋克的湿地面倒影：把已烘好的背景翻一倍压暗存下来，每帧只需一次 drawImage
      if (c.bg && sc.styleId === 'cyberpunk') {
        var ry = sc.extras.groundY || Math.round(sc.height * 0.86);
        var dh = Math.max(1, sc.height - ry);
        c.reflect = makeCanvas(doc, sc.width, dh);
        if (c.reflect) {
          var rctx = c.reflect.getContext('2d');
          if (rctx) {
            rctx.save();
            rctx.translate(0, dh);
            rctx.scale(1, -1);
            rctx.globalAlpha = 0.55;
            rctx.drawImage(c.bg, 0, ry - dh, sc.width, dh, 0, 0, sc.width, dh);
            rctx.restore();
          }
        }
      }

      // 云贴图：动画/梦幻两风格共用一张软圆，靠 drawImage 缩放，比每帧建径向渐变便宜
      if (sc.styleId === 'anime' || sc.styleId === 'fantasy') {
        c.cloud = makeCanvas(doc, 128, 128);
        var cctx = c.cloud && c.cloud.getContext('2d');
        if (cctx) {
          var cg = cctx.createRadialGradient(64, 64, 0, 64, 64, 64);
          cg.addColorStop(0, 'rgba(255,255,255,0.95)');
          cg.addColorStop(0.55, 'rgba(255,255,255,0.45)');
          cg.addColorStop(1, 'rgba(255,255,255,0)');
          cctx.fillStyle = cg;
          cctx.fillRect(0, 0, 128, 128);
        }
      }

      // 胶片颗粒：64×64 噪点贴图平铺，比逐像素噪点快两个数量级
      var tile = makeCanvas(doc, 64, 64);
      var tctx = tile && tile.getContext('2d');
      if (tctx) {
        var img = tctx.createImageData(64, 64);
        var nr = mulberry32(sc.seed ^ 0x9e3779b9);
        for (i = 0; i < img.data.length; i += 4) {
          var v = 110 + nr() * 145;
          img.data[i] = v;
          img.data[i + 1] = v;
          img.data[i + 2] = v;
          img.data[i + 3] = nr() < 0.34 ? 24 + nr() * 62 : 0;
        }
        tctx.putImageData(img, 0, 0);
        c.grainPattern = ctx.createPattern(tile, 'repeat');
      }

      if (sc.styleId === 'cyberpunk') {
        var scan = makeCanvas(doc, 4, 4);
        var sctx = scan && scan.getContext('2d');
        if (sctx) {
          sctx.fillStyle = 'rgba(0,0,0,0.55)';
          sctx.fillRect(0, 0, 4, 2);
          c.scanPattern = ctx.createPattern(scan, 'repeat');
        }
      }
    }

    // 以下渐变都建在主 ctx 上，尺寸变了就得重建（drawFrame 不重建它们）
    var cx = sc.width * 0.5, cy = sc.height * 0.5;
    var rr = Math.sqrt(cx * cx + cy * cy);
    var vig = sc.cfg.vignette == null ? 0.40 : sc.cfg.vignette;
    c.vignette = rgrad(ctx, cx, cy, rr, [[0, 'rgba(0,0,0,0)'], [0.55, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,' + vig + ')']]);

    var gcol = sc.cfg.glowColor || sc.palette[3];
    c.unitGlow = rgrad(ctx, 0, 0, 1, [[0, rgba(gcol, 0.92)], [0.35, rgba(gcol, 0.30)], [1, rgba(gcol, 0)]]);
    c.unitSoft = rgrad(ctx, 0, 0, 1, [[0, 'rgba(255,255,255,0.88)'], [0.45, 'rgba(255,255,255,0.30)'], [1, 'rgba(255,255,255,0)']]);
    c.unitSweep = grad(ctx, -1, 0, 1, 0, [[0, 'rgba(255,255,255,0)'], [0.5, 'rgba(255,255,255,0.92)'], [1, 'rgba(255,255,255,0)']]);
    c.unitMist = grad(ctx, 0, -1, 0, 1, [[0, 'rgba(255,255,255,0)'], [0.5, 'rgba(255,255,255,0.55)'], [1, 'rgba(255,255,255,0)']]);
    return c;
  }

  /* ── 10. 动态层：粒子 ───────────────────────────────────────────────────
     位置全部由「t 的整数周期函数」给出：
       x = (x0·W + nx·W·p + sway·sin(2π(swN·p + ph))) mod W
       y = (y0·H + ny·H·p) mod H
     nx/ny/swN 都是整数 → p 从 0 走到 1 时每个粒子正好回到起点，循环天然无缝。 */

  function setKindStyle(ctx, q) {
    ctx.fillStyle = q.color;
    ctx.strokeStyle = q.color;
    ctx.lineWidth = q.kind === 'rain' ? Math.max(0.7, q.r) : Math.max(0.8, q.r * 0.55);
    ctx.lineCap = 'round';
  }

  function paintParticles(ctx, sc, p, w, h, cache) {
    var list = sc.particles, n = list.length, cur = '', i, q, px, py, a;
    var unitSoft = cache && cache.unitSoft;
    ctx.save();
    for (i = 0; i < n; i += 1) {
      q = list[i];
      px = modPos(q.x0 * w + q.nx * w * p + Math.sin(TAU * (q.swN * p + q.ph)) * q.sw, w);
      py = modPos(q.y0 * h + q.ny * h * p, h);
      a = q.a;
      if (q.tw) a = q.a * (0.5 + 0.5 * Math.sin(TAU * (q.tw * p + q.ph)));
      if (q.kind !== cur) { cur = q.kind; setKindStyle(ctx, q); }

      if (cur === 'rain') {
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + q.sl, py + q.len);
        ctx.stroke();
      } else if (cur === 'bokeh' && unitSoft) {
        // 浅景深光点必须软边，直接用缓存的白色径向贴上去
        drawUnitGlow(ctx, unitSoft, px, py, q.r, a);
      } else if (cur === 'petal' || cur === 'leaf') {
        ctx.globalAlpha = a;
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(TAU * (q.spin * p + q.ph));
        ctx.beginPath();
        ctx.ellipse(0, 0, q.r, q.r * 0.52, 0, 0, TAU);
        ctx.fill();
        ctx.restore();
      } else if (cur === 'spark') {
        ctx.globalAlpha = a;
        var s2 = q.r * 2.2;
        ctx.beginPath();
        ctx.moveTo(px - s2, py);
        ctx.lineTo(px + s2, py);
        ctx.moveTo(px, py - s2);
        ctx.lineTo(px, py + s2);
        ctx.stroke();
      } else if (cur === 'ember') {
        ctx.globalAlpha = a * 0.32;
        ctx.beginPath();
        ctx.arc(px, py, q.r * 2.8, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(px, py, q.r, 0, TAU);
        ctx.fill();
      } else {
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(px, py, q.r, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /** 星芒：用两个 fillRect 拼十字，比画路径便宜，动画里也够用。 */
  function paintStars(ctx, sc, p, w, h, mul) {
    var list = sc.stars, i, q, a;
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,1)';
    for (i = 0; i < list.length; i += 1) {
      q = list[i];
      a = (0.30 + 0.70 * (0.5 + 0.5 * Math.sin(TAU * (q.tw * p + q.ph)))) * (mul || 1);
      ctx.globalAlpha = a;
      ctx.fillRect(q.x * w - q.r, q.y * h - q.r * 0.13, q.r * 2, q.r * 0.26);
      ctx.fillRect(q.x * w - q.r * 0.13, q.y * h - q.r, q.r * 0.26, q.r * 2);
    }
    ctx.restore();
  }

  /** 车灯光带：只在地平线附近两条走廊里横移，整数周期 → 无缝。 */
  function paintTraffic(ctx, sc, p, w, h) {
    var P = sc.palette;
    var y1 = sc.horizon + (h - sc.horizon) * 0.30;
    var y2 = sc.horizon + (h - sc.horizon) * 0.72;
    ctx.save();
    ctx.lineCap = 'round';
    for (var i = 0; i < 3; i += 1) {
      var len = w * (0.10 + i * 0.035);
      var span = w + len;
      var x = modPos(p * (2 + i) * span + w * (0.15 + i * 0.28), span) - len;
      ctx.globalAlpha = 0.52 - i * 0.11;
      ctx.strokeStyle = rgba(P[3], 0.9);
      ctx.lineWidth = Math.max(1.4, h * 0.005);
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x + len, y1);
      ctx.stroke();
      ctx.globalAlpha = 0.34 - i * 0.08;
      ctx.strokeStyle = rgba(P[2], 0.9);
      ctx.beginPath();
      ctx.moveTo(x + len * 0.15, y2);
      ctx.lineTo(x + len * 1.35, y2);
      ctx.stroke();
    }
    ctx.restore();
  }

  var PAINT = {};

  PAINT.cinematic = function (ctx, sc, p, ph, cache, w, h) {
    var sx = w * 0.62, sy = sc.horizon * 0.95;
    var pulse = 0.5 + 0.5 * Math.sin(ph * 2);            // 整数倍频，首尾同相
    drawUnitGlow(ctx, cache.unitGlow, sx, sy, h * (0.44 + 0.05 * pulse), 0.13 + 0.09 * pulse);
    drawUnitGlow(ctx, cache.unitGlow, sx, sy, h * (0.12 + 0.015 * pulse), 0.34 + 0.16 * pulse);
    drawUnitBand(ctx, cache.unitMist, sx, sc.horizon + h * 0.012, w * 0.72, h * 0.045, 0.10 + 0.05 * pulse);
    paintParticles(ctx, sc, p, w, h, cache);
    if (sc.variant.traffic > 0 || sc.variant.road > 0) paintTraffic(ctx, sc, p, w, h);
  };

  PAINT.photo = function (ctx, sc, p, ph, cache, w, h) {
    // 玻璃反光：一道白光每 loop 扫两趟（2 是整数，所以到点刚好回到起点）
    var sx = (modPos(p * 2, 1) * 1.6 - 0.30) * w;
    drawUnitBand(ctx, cache.unitSweep, sx, h * 0.46, w * 0.075, h * 0.56, 0.26);
    paintParticles(ctx, sc, p, w, h, cache);
    // 湿地面反光：几条随呼吸明暗的亮线，雨后城市的关键细节
    var breathe = 0.5 + 0.5 * Math.sin(ph * 3);
    ctx.save();
    ctx.strokeStyle = rgba(sc.palette[3], 0.30);
    ctx.lineWidth = Math.max(1, h * 0.0025);
    for (var i = 0; i < 5; i += 1) {
      var y = h * (0.895 + i * 0.018);
      var x0 = w * (0.06 + i * 0.07);
      var len = w * (0.22 + i * 0.05);
      ctx.globalAlpha = (0.10 + 0.16 * breathe) * (1 - i * 0.16);
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + len, y);
      ctx.stroke();
    }
    ctx.restore();
  };

  PAINT.anime = function (ctx, sc, p, ph, cache, w, h) {
    // 云横向漂移：模数是 (w + 2·cloudW)，乘整数圈才无缝
    var clouds = sc.extras.clouds || [];
    if (cache && cache.cloud) {
      for (var i = 0; i < clouds.length; i += 1) {
        var cl = clouds[i];
        var cw = w * 0.34 * cl.s, chh = h * 0.16 * cl.s;
        var span = w + cw * 2;
        var x = modPos(p * cl.sp * span + w * (0.05 + i * 0.30), span) - cw;
        ctx.globalAlpha = cl.a * 0.55;
        ctx.drawImage(cache.cloud, x, h * cl.y, cw, chh);
      }
      ctx.globalAlpha = 1;
    }
    paintStars(ctx, sc, p, w, h, 0.5);
    paintParticles(ctx, sc, p, w, h, cache);
    // 夕阳一圈呼吸光
    var pulse = 0.5 + 0.5 * Math.sin(ph * 2);
    drawUnitGlow(ctx, cache.unitGlow, w * 0.78, h * 0.33, h * (0.26 + 0.03 * pulse), 0.20 + 0.10 * pulse);
  };

  PAINT.guofeng = function (ctx, sc, p, ph, cache, w, h) {
    // 雾带：三条不同速度的横向滚动，靠「速度不同」做出层次；速度都取整数圈
    for (var i = 0; i < 3; i += 1) {
      var bw2 = w * (0.55 + i * 0.15), bh2 = h * (0.035 + i * 0.012);
      var span = w + bw2 * 2;
      var x = modPos(p * (1 + i) * span + w * (0.05 + i * 0.3), span) - bw2;
      var y = sc.horizon + h * (0.03 + i * 0.075);
      drawUnitBand(ctx, cache.unitMist, x + bw2 * 0.5, y, bw2, bh2, 0.14 + 0.05 * (1 - i * 0.3));
    }
    // 水波：短横向笔画，明暗随时间跑（整数周期）
    ctx.save();
    ctx.strokeStyle = rgba(mixHex(sc.palette[3], sc.palette[0], 0.35), 0.55);
    ctx.lineWidth = Math.max(1, h * 0.0018);
    for (var wv = 0; wv < 7; wv += 1) {
      var yy = sc.horizon + h * (0.06 + wv * 0.032);
      var ph2 = TAU * (p * (1 + (wv % 2)) + wv * 0.17);
      var xx = w * (0.10 + wv * 0.10) + Math.sin(ph2) * w * 0.025;
      ctx.globalAlpha = 0.22 + 0.20 * (0.5 + 0.5 * Math.sin(ph2 + 1.1));
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      ctx.lineTo(xx + w * (0.10 - wv * 0.006), yy);
      ctx.stroke();
    }
    ctx.restore();
    paintParticles(ctx, sc, p, w, h, cache);
  };

  PAINT.cyberpunk = function (ctx, sc, p, ph, cache, w, h) {
    var gy = sc.extras.groundY || Math.round(h * 0.86);
    // 湿地面倒影（缓存图）
    if (cache && cache.reflect) {
      ctx.save();
      ctx.globalAlpha = 0.52 + 0.06 * Math.sin(ph * 2);
      ctx.drawImage(cache.reflect, 0, gy, w, h - gy);
      ctx.restore();
    }
    // 霓虹灯管逐根闪烁：相位来自种子，所以 7 根不会同步呼吸
    var signs = sc.extras.signs || [];
    for (var i = 0; i < signs.length; i += 1) {
      var s = signs[i];
      var f = 0.55 + 0.45 * Math.sin(TAU * (s.tw * p + s.ph)) * (0.6 + 0.4 * Math.sin(TAU * (p * 2 + s.ph * 3)));
      ctx.globalAlpha = clamp(0.25 + f * 0.75, 0.1, 0.98);
      ctx.fillStyle = rgba(mixHex(s.col, '#ffffff', 0.25), 1);
      ctx.fillRect(s.x, s.y, s.wd, s.ht);
      ctx.globalAlpha = 1;
      drawUnitGlow(ctx, cache.unitGlow, s.x + s.wd * 0.5, s.y + s.ht * 0.5, s.ht * 0.55, 0.16 + 0.10 * f);
    }
    // 主霓虹牌呼吸
    var pulse = 0.5 + 0.5 * Math.sin(ph * 2);
    drawUnitGlow(ctx, cache.unitGlow, w * 0.5, h * 0.55, w * 0.30, 0.10 + 0.06 * pulse);
    paintParticles(ctx, sc, p, w, h, cache);
  };

  PAINT.dark = function (ctx, sc, p, ph, cache, w, h) {
    var win = sc.extras.window || { x: w * 0.6, y: h * 0.12, w: w * 0.28, h: h * 0.52 };
    var candle = sc.extras.candle || { x: w * 0.33, y: h * 0.845 };
    // 冷窗投在地上的光斑：极慢的呼吸，快到反而假
    var breathe = 0.5 + 0.5 * Math.sin(ph);
    drawUnitBand(ctx, cache.unitMist, win.x + win.w * 0.3, h * 0.80, w * 0.22, h * 0.07, 0.06 + 0.04 * breathe);

    // 烛光：暖光晕 + 摇摆火焰（两层形状，用 sin 错相做火苗抖动）
    var flick = 0.82 + 0.18 * Math.sin(TAU * (p * 3 + 0.2)) + 0.06 * Math.sin(TAU * (p * 7 + 0.6));
    var cx = candle.x, cy = candle.y - h * 0.14;
    drawUnitGlow(ctx, cache.unitGlow, cx, cy, h * (0.30 * flick), 0.42 * flick);
    ctx.save();
    ctx.globalAlpha = clamp(0.85 * flick, 0.4, 1);
    ctx.fillStyle = rgba(mixHex(sc.palette[3], '#ffffff', 0.45), 1);
    ctx.beginPath();
    ctx.moveTo(cx, cy - h * 0.048 * flick);
    ctx.quadraticCurveTo(cx + w * 0.007, cy - h * 0.016, cx + w * 0.0035, cy);
    ctx.quadraticCurveTo(cx, cy + h * 0.006, cx - w * 0.0035, cy);
    ctx.quadraticCurveTo(cx - w * 0.007, cy - h * 0.016, cx, cy - h * 0.048 * flick);
    ctx.fill();
    ctx.fillStyle = rgba('#fff3c4', 0.95);
    ctx.beginPath();
    ctx.moveTo(cx, cy - h * 0.026 * flick);
    ctx.quadraticCurveTo(cx + w * 0.003, cy - h * 0.008, cx, cy);
    ctx.quadraticCurveTo(cx - w * 0.003, cy - h * 0.008, cx, cy - h * 0.026 * flick);
    ctx.fill();
    ctx.restore();

    paintParticles(ctx, sc, p, w, h, cache);
    // 底部一层贴地薄雾
    drawUnitBand(ctx, cache.unitMist, w * 0.5, h * 0.90, w * 0.62, h * 0.05, 0.10 + 0.04 * breathe);
  };

  PAINT.fantasy = function (ctx, sc, p, ph, cache, w, h) {
    // 云（梦幻版：更慢、更淡）
    if (cache && cache.cloud) {
      for (var i = 0; i < 3; i += 1) {
        var cw = w * (0.38 - i * 0.06), chh = h * (0.14 - i * 0.02);
        var span = w + cw * 2;
        var x = modPos(p * (1 + i) * span + w * (0.1 + i * 0.27), span) - cw;
        ctx.globalAlpha = 0.30 - i * 0.07;
        ctx.drawImage(cache.cloud, x, h * (0.52 + i * 0.10), cw, chh);
      }
      ctx.globalAlpha = 1;
    }
    // 飘带：一条带宽 + 一条中线高光。只描一根线会读成「铁丝」，加带宽才有布的感觉
    var ribs = sc.extras.ribbons || [];
    for (var r = 0; r < ribs.length; r += 1) {
      var rb = ribs[r];
      var y0 = rb.y * h;
      var amp = rb.amp * h;
      var p1y = y0 - amp * 2.2 + Math.sin(ph * 2 + rb.ph) * amp;
      var p2y = y0 + amp * 2.4 + Math.sin(ph * 2 + rb.ph + 1.2) * amp;
      var yEnd = y0 + Math.sin(ph + rb.ph + 1.6) * amp;
      var yStart = y0 + Math.sin(ph + rb.ph) * amp;
      ctx.save();
      ctx.lineCap = 'round';
      var ribCol = mixHex(sc.palette[3], sc.palette[2], 0.35);
      for (var pass = 0; pass < 2; pass += 1) {
        ctx.globalAlpha = pass === 0 ? 0.16 : 0.52;
        ctx.strokeStyle = rgba(ribCol, 1);
        ctx.lineWidth = Math.max(1.2, h * (pass === 0 ? 0.020 : 0.0055));
        ctx.beginPath();
        ctx.moveTo(-w * 0.05, yStart);
        ctx.bezierCurveTo(w * 0.30, p1y, w * 0.70, p2y, w * 1.05, yEnd);
        ctx.stroke();
      }
      ctx.restore();
    }
    paintStars(ctx, sc, p, w, h, 0.8);
    paintParticles(ctx, sc, p, w, h, cache);
    var pulse = 0.5 + 0.5 * Math.sin(ph * 2);
    drawUnitGlow(ctx, cache.unitGlow, w * 0.66, h * 0.35, h * (0.40 + 0.04 * pulse), 0.14 + 0.08 * pulse);
  };

  /* ── 11. 一帧 ─────────────────────────────────────────────────────────
     相机：zoom = 1 + (zoomTo-1)·(0.5-0.5cos) —— 起点和终点都落在 1.00，
     横移再乘 (zoom-1)/(zoomTo-1)，保证 zoom=1 那两帧横移为 0（否则会露出画布边）。 */

  function drawFrame(ctx, sc, cache, tMs) {
    var w = sc.width, h = sc.height;
    var p = normalizeTime(tMs) / LOOP_MS;
    var ph = p * TAU;
    var cfg = sc.cfg;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);

    var zoom = 1 + (cfg.zoomTo - 1) * (0.5 - 0.5 * Math.cos(ph));
    var zf = (cfg.zoomTo - 1) > 1e-6 ? (zoom - 1) / (cfg.zoomTo - 1) : 0;
    var panX = cfg.panX * w * Math.sin(ph) * zf;
    var panY = cfg.panY * h * Math.cos(ph) * zf;

    ctx.save();
    ctx.translate(w * 0.5 + panX, h * 0.5 + panY);
    ctx.scale(zoom, zoom);
    ctx.translate(-w * 0.5, -h * 0.5);

    if (cache && cache.bg) ctx.drawImage(cache.bg, 0, 0, w, h);
    else { ctx.fillStyle = sc.palette[0]; ctx.fillRect(0, 0, w, h); }

    (PAINT[sc.styleId] || PAINT.cinematic)(ctx, sc, p, ph, cache, w, h);
    ctx.restore();

    // 屏幕空间叠加：不跟相机动（色温和暗角属于镜头，不属于场景）
    var v = sc.variant;
    if (v.warm > 0.001) {
      ctx.globalAlpha = clamp(v.warm * 0.09, 0, 0.14);
      ctx.fillStyle = '#ff9d3d';
      ctx.fillRect(0, 0, w, h);
    }
    if (v.cool > 0.001) {
      ctx.globalAlpha = clamp(v.cool * 0.09, 0, 0.14);
      ctx.fillStyle = '#3f6fd8';
      ctx.fillRect(0, 0, w, h);
    }
    if (v.bright > 0.001) {
      ctx.globalAlpha = clamp(v.bright * 0.22, 0, 0.14);
      ctx.fillStyle = '#fff4e6';
      ctx.fillRect(0, 0, w, h);
    } else if (v.bright < -0.001) {
      ctx.globalAlpha = clamp(-v.bright * 0.30, 0, 0.18);
      ctx.fillStyle = '#02050c';
      ctx.fillRect(0, 0, w, h);
    }

    // 胶片颗粒（有 seed 的贴图，偏移随循环走，滚得慢所以看不出平铺）
    if (cache && cache.grainPattern) {
      var gx = (p * 64 * 3) % 64, gy2 = (p * 64 * 2) % 64;
      ctx.globalAlpha = sc.styleId === 'anime' ? 0.10 : 0.16;
      ctx.save();
      ctx.translate(-gx, -gy2);
      ctx.fillStyle = cache.grainPattern;
      ctx.fillRect(0, 0, w + 64, h + 64);
      ctx.restore();
    }

    // 扫描线：只给赛博朋克，别的风格加了就变成加特技
    if (cache && cache.scanPattern) {
      ctx.globalAlpha = 0.20;
      ctx.fillStyle = cache.scanPattern;
      ctx.fillRect(0, 0, w, h);
    }

    if (cache && cache.vignette) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = cache.vignette;
      ctx.fillRect(0, 0, w, h);
    }

    // 宽银幕黑边（电影感专属）
    var bar = sc.letterbox;
    if (bar > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#040406';
      ctx.fillRect(0, 0, w, bar);
      ctx.fillRect(0, h - bar, w, bar);
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, bar, w, 1);
      ctx.fillRect(0, h - bar - 1, w, 1);
    }
    ctx.globalAlpha = 1;
  }

  /* ── 12. 公共 API ─────────────────────────────────────────────────────── */

  function getRaf() {
    if (root && typeof root.requestAnimationFrame === 'function') {
      return function (cb) { return root.requestAnimationFrame(cb); };
    }
    return null;
  }

  function getCaf() {
    if (root && typeof root.cancelAnimationFrame === 'function') {
      return function (id) { return root.cancelAnimationFrame(id); };
    }
    return null;
  }

  function createRenderer(canvas, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('AVPW_ENGINE.createRenderer: 需要一个 canvas 元素；当前环境没有 DOM（Node 下请用 sceneStats）');
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('AVPW_ENGINE.createRenderer: canvas.getContext("2d") 返回空，画布不可用');

    var doc = canvas.ownerDocument || getDoc();
    var o = normalize(opts);
    // 调用方没给尺寸时，尊重画布上已有的非默认尺寸（300×150 是 canvas 的出厂默认，忽略它）
    if (!(opts && opts.width) && canvas.width >= 64 && canvas.width !== 300) o.width = canvas.width;
    if (!(opts && opts.height) && canvas.height >= 64 && canvas.height !== 150) o.height = canvas.height;
    o.doc = doc;
    canvas.width = o.width;
    canvas.height = o.height;

    var state = { scene: null, cache: null, running: false, raf: 0, timer: 0, t0: 0, dead: false };

    function rebuild() {
      o.width = canvas.width;
      o.height = canvas.height;
      state.scene = buildScene(o);
      state.cache = null;   // 背景/渐变全部作废，下一帧重建一次
    }

    function frame(tMs) {
      if (state.dead || !state.scene) return;
      if (!state.cache) state.cache = buildCache(ctx, state.scene);
      drawFrame(ctx, state.scene, state.cache, tMs);
    }

    rebuild();

    var api = {
      setInputs: function (next) {
        var n = next || {};
        if (n.styleId) o.styleId = n.styleId;
        if (n.prompt != null) o.prompt = String(n.prompt);
        if (n.seed != null) o.seed = n.seed;
        rebuild();
        return api;
      },
      resize: function (width, height) {
        canvas.width = Math.max(64, Math.round(width || canvas.width));
        canvas.height = Math.max(64, Math.round(height || canvas.height));
        rebuild();
        return api;
      },
      drawAt: function (tMs) {
        frame(tMs);
        return api;
      },
      start: function () {
        if (state.dead || state.running) return api;
        state.running = true;
        state.t0 = nowMs();
        var raf = getRaf();
        (function tick() {
          if (!state.running || state.dead) return;
          frame(modPos(nowMs() - state.t0, LOOP_MS));
          if (raf) state.raf = raf(tick);
          else state.timer = setTimeout(tick, 33);
        })();
        return api;
      },
      stop: function () {
        state.running = false;
        var caf = getCaf();
        if (state.raf && caf) caf(state.raf);
        state.raf = 0;
        if (state.timer) { clearTimeout(state.timer); state.timer = 0; }
        return api;
      },
      isRunning: function () { return state.running; },
      destroy: function () {
        api.stop();
        state.dead = true;
        state.scene = null;
        state.cache = null;
      }
    };
    return api;
  }

  function renderPoster(opts) {
    var src = opts || {};
    var o = normalize({
      styleId: src.styleId || 'cinematic',
      prompt: src.prompt,
      seed: src.seed,
      aspect: src.aspect,
      width: src.width || 320,
      height: src.height || 200
    });
    var doc = getDoc();
    if (!doc) return null;
    var cv = null;
    try {
      cv = makeCanvas(doc, o.width, o.height);
      if (!cv) return null;
      o.doc = doc;
      var r = createRenderer(cv, o);
      r.drawAt(1500);            // 固定 1500ms：卡在推近中段，构图最舒展
      var url = cv.toDataURL('image/png');
      r.destroy();
      return typeof url === 'string' && url.indexOf('data:image') === 0 ? url : null;
    } catch (e) {
      return null;
    }
  }

  function pickMime(MR) {
    var list = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    if (typeof MR.isTypeSupported !== 'function') return 'video/webm';
    for (var i = 0; i < list.length; i += 1) {
      if (MR.isTypeSupported(list[i])) return list[i];
    }
    return null;
  }

  /**
   * 录制：canvas.captureStream(fps) + MediaRecorder。
   * 帧不用 renderer.start() 推，而是自己按真实经过时间 drawAt(t) —— 这样时长精确可控，
   * 且最后的 t 恰好落在 ms，不会出现「说 6 秒实际 7.2 秒」。
   * 任何一步不可用都 resolve 一个带 reason 的对象，绝不 reject：调用方在 UI 上要能降级提示。
   */
  function record(opts) {
    return new Promise(function (resolve) {
      var o = normalize(opts);
      var doc = getDoc();
      if (!doc) { resolve({ ok: false, reason: 'NO_DOCUMENT' }); return; }

      var cv;
      try {
        cv = makeCanvas(doc, o.width, o.height);
      } catch (e) {
        resolve({ ok: false, reason: 'NO_DOCUMENT' });
        return;
      }
      if (!cv || typeof cv.captureStream !== 'function') { resolve({ ok: false, reason: 'CAPTURE_STREAM_UNSUPPORTED' }); return; }

      var MR = root && root.MediaRecorder;
      if (!MR) { resolve({ ok: false, reason: 'MEDIA_RECORDER_UNSUPPORTED' }); return; }
      var mime = pickMime(MR);
      if (!mime) { resolve({ ok: false, reason: 'MEDIA_RECORDER_UNSUPPORTED' }); return; }

      var renderer = null, rec = null, stream = null;
      var chunks = [], done = false, t0 = 0, timer = 0;

      function cleanup() {
        if (timer) { clearTimeout(timer); timer = 0; }
        if (renderer) { try { renderer.stop(); renderer.destroy(); } catch (e) { /* 已销毁，忽略 */ } }
        if (stream) {
          try {
            var tracks = stream.getTracks();
            for (var i = 0; i < tracks.length; i += 1) tracks[i].stop();
          } catch (e) { /* 轨道已停，忽略 */ }
        }
      }

      try {
        o.doc = doc;
        renderer = createRenderer(cv, o);
        stream = cv.captureStream(o.fps);
        rec = new MR(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
      } catch (e) {
        cleanup();
        resolve({ ok: false, reason: 'MEDIA_RECORDER_UNSUPPORTED' });
        return;
      }

      rec.ondataavailable = function (ev) {
        if (ev && ev.data && ev.data.size) chunks.push(ev.data);
      };
      rec.onerror = function () {
        if (done) return;
        done = true;
        cleanup();
        resolve({ ok: false, reason: 'MEDIA_RECORDER_ERROR' });
      };
      rec.onstop = function () {
        if (done) return;
        done = true;
        var dur = Math.round(nowMs() - t0);
        cleanup();
        var blob = null;
        try { blob = new Blob(chunks, { type: mime.split(';')[0] }); } catch (e) { blob = null; }
        if (!blob || !blob.size) {
          resolve({ ok: false, reason: 'EMPTY_BLOB' });
          return;
        }
        resolve({ ok: true, blob: blob, mime: mime, durationMs: dur, poster: renderPoster(o) });
      };

      t0 = nowMs();
      try {
        rec.start();
      } catch (e) {
        done = true;
        cleanup();
        resolve({ ok: false, reason: 'MEDIA_RECORDER_UNSUPPORTED' });
        return;
      }

      var raf = getRaf();
      function tick() {
        if (done) return;
        var el = nowMs() - t0;
        try { renderer.drawAt(Math.min(el, o.ms)); } catch (e) { /* 单帧失败不该毁掉整段录制 */ }
        if (el >= o.ms) {
          try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* 已停 */ }
          return;
        }
        if (raf) raf(tick);
        else timer = setTimeout(tick, Math.max(8, 1000 / o.fps));
      }
      if (raf) raf(tick);
      else timer = setTimeout(tick, Math.max(8, 1000 / o.fps));

      // 兜底：个别浏览器 stop 后不触发 onstop，这里强推一次并给失败结论
      timer = setTimeout(function () {
        if (done) return;
        try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* 已停 */ }
        setTimeout(function () {
          if (done) return;
          done = true;
          cleanup();
          resolve({ ok: false, reason: 'MEDIA_RECORDER_TIMEOUT' });
        }, 1500);
      }, o.ms + 4000);
    });
  }

  return {
    version: VERSION,
    LOOP_MS: LOOP_MS,
    MAX_PARTICLES: MAX_PARTICLES,
    STYLE_IDS: ['cinematic', 'photo', 'anime', 'guofeng', 'cyberpunk', 'dark', 'fantasy'],
    KEYWORDS: KEYWORDS,
    createRenderer: createRenderer,
    renderPoster: renderPoster,
    record: record,
    sceneStats: sceneStats
  };
});