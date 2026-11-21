/**
 * wizard/onboard.js —— 第一次打开网站的新手引导（半透明遮罩 + 高亮圈 + 气泡）
 *
 * 为什么单独一个文件、且自带纯函数区：
 *   一个「引导」看着简单，翻车点全在几何：气泡越界、高亮圈压住目标、窄屏气泡盖满整屏。
 *   这些都不是 DOM 问题而是算术问题，所以把 placement 抽成不碰 DOM 的纯函数
 *   （computePlacement / clampBox / padRect），再用 wizard/onboard.selftest.mjs 钉死。
 *   于是「有没有浏览器」都能验证同一套几何，DOM 层只是把算好的数字写进 style。
 *
 * 三条设计取舍：
 *   1. **不新增任何 CSS**：类名全部复用 theme.css 的「新手引导」段
 *      （.onboard / .veil / .spot / .bubble / .ob-step / .ob-actions / .grow / .dots），
 *      本文件只写 left/top/width/height 这些几何内联样式。
 *   2. **click 不关闭，键盘才关闭**：遮罩点击退出是最常见的误触（用户点页面、结果引导没了），
 *      所以 veil 点击什么都不做；Esc = 跳过，←/→、Enter = 前后步。
 *   3. **锁滚动但不放弃滚动目标**：实测 Chromium 里 html 设为 overflow:hidden 后，
 *      scrollIntoView() 仍然能程序化滚动（scrollY 照常变化），所以可以「先锁再滚」，
 *      两个需求不冲突；解锁时写回进来前的原值，不硬写空串。
 *
 * 用法：
 *   Node:   const ONB = require('./onboard.js');            → { create, shouldShow, reset, … }
 *   浏览器: const ONB = window.AVPW_ONBOARD;                 → 同上（UMD 两条路都挂）
 *           const g = ONB.create({ steps: [...] }); g.start();
 *
 * 节点下没有 document：create() 返回一个同接口的空控制器（桩），不抛错，
 * 方便 Node 侧自检与「先 require 再在浏览器里用」的构建器。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.AVPW_ONBOARD = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ═════════════ 常量：所有魔数只在这里出现 ═════════════ */

  var DEFAULTS = {
    storageKey: 'avp.wizard.onboarded',
    pad: 8,        // 高亮圈外扩（像素）
    place: 'auto',
    margin: 8,     // 气泡与视口边缘的最小距离
    gap: 12,       // 高亮圈与气泡之间的缝
    narrow: 720,   // 小于这个宽度：气泡贴底全宽
    once: true
  };

  // auto 选边的偏好顺序：右 → 左 → 下 → 上（与产品需求逐字一致）
  var PLACES = ['right', 'left', 'bottom', 'top'];
  var FLAG_ON = '1';

  /* ═════════════ 纯函数区：不碰 DOM，Node 下可直接测 ═════════════ */

  function isNum(n) { return typeof n === 'number' && isFinite(n); }
  function num(v, d) { return isNum(v) ? v : d; }

  // 夹紧；hi < lo（视口比气泡还小）时退化为 lo，保证不出现负数宽度
  function clamp(v, lo, hi) {
    if (hi < lo) return lo;
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 把目标矩形按 pad 外扩成高亮圈的框（pad 默认 8） */
  function padRect(rect, pad) {
    var r = rect || {};
    var p = num(pad, DEFAULTS.pad);
    return {
      left: num(r.left, 0) - p,
      top: num(r.top, 0) - p,
      width: num(r.width, 0) + p * 2,
      height: num(r.height, 0) + p * 2
    };
  }

  /**
   * 把任意盒子夹进视口，四周至少留 margin（默认 8）。
   * 尺寸先夹（视口装不下就压到视口内），再夹位置 —— 顺序反了会出现负的可用区间。
   */
  function clampBox(box, viewport, margin) {
    var m = num(margin, DEFAULTS.margin);
    var vw = Math.max(0, num(viewport && viewport.width, 0));
    var vh = Math.max(0, num(viewport && viewport.height, 0));
    var w = Math.min(Math.max(0, num(box && box.width, 0)), Math.max(0, vw - m * 2));
    var h = Math.min(Math.max(0, num(box && box.height, 0)), Math.max(0, vh - m * 2));
    var left = clamp(num(box && box.left, 0), m, Math.max(m, vw - m - w));
    var top = clamp(num(box && box.top, 0), m, Math.max(m, vh - m - h));
    return { left: left, top: top, width: w, height: h };
  }

  /** 目标四边还剩多少空间（含被裁掉的那部分，可能是负数） */
  function spaceOf(spot, viewport) {
    return {
      right: viewport.width - (spot.left + spot.width),
      left: spot.left,
      bottom: viewport.height - (spot.top + spot.height),
      top: spot.top
    };
  }

  /** 某一边要「放得下」气泡，需要多少空间：气泡尺寸 + 缝 + 边距 */
  function needOf(place, bubble) {
    if (place === 'right' || place === 'left') return bubble.width + DEFAULTS.gap + DEFAULTS.margin;
    return bubble.height + DEFAULTS.gap + DEFAULTS.margin;
  }

  function fitsAt(place, spot, viewport, bubble) {
    return spaceOf(spot, viewport)[place] >= needOf(place, bubble);
  }

  /** 某一边的锚点：垂直方向对齐目标中线（上下则横向对齐中线） */
  function anchorAt(place, spot, bubble) {
    if (place === 'right') {
      return { left: spot.left + spot.width + DEFAULTS.gap, top: spot.top + spot.height / 2 - bubble.height / 2 };
    }
    if (place === 'left') {
      return { left: spot.left - DEFAULTS.gap - bubble.width, top: spot.top + spot.height / 2 - bubble.height / 2 };
    }
    if (place === 'bottom') {
      return { left: spot.left + spot.width / 2 - bubble.width / 2, top: spot.top + spot.height + DEFAULTS.gap };
    }
    return { left: spot.left + spot.width / 2 - bubble.width / 2, top: spot.top - DEFAULTS.gap - bubble.height };
  }

  /**
   * 自动选边 + 越界夹紧（本组件的几何核心）。
   *
   *   computePlacement({ spot, viewport, bubble, place }) → { left, top, placement, width, height }
   *     spot     : 视口坐标系下的目标矩形（已含 pad）
   *     viewport : { width, height }（= innerWidth / innerHeight）
   *     bubble   : { width, height }（气泡实测尺寸）
   *     place    : 'auto' | 'right' | 'bottom' | 'top' | 'left'
   *
   * 规则：
   *   1. 窄屏（viewport.width < 720）→ 一律贴底全宽（左右各留 8），竖屏手机最稳，
   *      也避免「气泡一半在屏幕外」这种在手机上最刺眼的问题。
   *   2. 否则按 右→左→下→上 挑第一条「放得下」的边；显式 place 能放下就听它的。
   *   3. 四条边都放不下（目标几乎占满视口）→ 取剩余空间最大的一边，再靠夹紧兜底。
   *   4. 最后统一 clampBox：left/top 至少 8，left+width / top+height 不超视口。
   *
   * 返回里的 placement 是「实际用的边」，request 是「调用方要的边」，fallback 标出降级，
   * 便于调用方打点知道自己的 place 有没有被尊重。
   */
  function computePlacement(opts) {
    var o = opts || {};
    var viewport = {
      width: Math.max(0, num(o.viewport && o.viewport.width, 0)),
      height: Math.max(0, num(o.viewport && o.viewport.height, 0))
    };
    var spot = {
      left: num(o.spot && o.spot.left, 0),
      top: num(o.spot && o.spot.top, 0),
      width: Math.max(0, num(o.spot && o.spot.width, 0)),
      height: Math.max(0, num(o.spot && o.spot.height, 0))
    };
    var bubble = {
      width: Math.max(0, num(o.bubble && o.bubble.width, 0)),
      height: Math.max(0, num(o.bubble && o.bubble.height, 0))
    };
    var request = o.place && (o.place === 'auto' || PLACES.indexOf(o.place) >= 0) ? o.place : 'auto';

    // 1) 窄屏：贴底全宽
    if (viewport.width > 0 && viewport.width < DEFAULTS.narrow) {
      var m = DEFAULTS.margin;
      var fullW = Math.max(0, viewport.width - m * 2);
      var bh = Math.min(bubble.height, Math.max(0, viewport.height - m * 2));
      var dock = clampBox(
        { left: m, top: viewport.height - m - bh, width: fullW, height: bh },
        viewport, m
      );
      return {
        placement: 'bottom', left: dock.left, top: dock.top,
        width: dock.width, height: dock.height,
        narrow: true, request: request, fallback: request !== 'auto' && request !== 'bottom'
      };
    }

    // 2) 选边：显式指定且放得下 → 用它的；否则按 右→左→下→上 找第一条放得下的
    var chosen = null;
    var fallback = false;
    if (request !== 'auto') {
      if (fitsAt(request, spot, viewport, bubble)) chosen = request;
      else fallback = true;
    }
    if (!chosen) {
      for (var i = 0; i < PLACES.length; i += 1) {
        if (fitsAt(PLACES[i], spot, viewport, bubble)) { chosen = PLACES[i]; break; }
      }
    }

    // 3) 四边都不够：取剩余空间最大的一边（再夹紧）
    if (!chosen) {
      var space = spaceOf(spot, viewport);
      var best = PLACES[0];
      var bestSlack = -Infinity;
      for (var j = 0; j < PLACES.length; j += 1) {
        var slack = space[PLACES[j]] - needOf(PLACES[j], bubble);
        if (slack > bestSlack) { bestSlack = slack; best = PLACES[j]; }
      }
      chosen = best;
      fallback = true;
    }

    // 4) 放锚点 → 夹紧（唯一能让「不越界」成立的收尾）
    var at = anchorAt(chosen, spot, bubble);
    var box = clampBox({ left: at.left, top: at.top, width: bubble.width, height: bubble.height }, viewport, DEFAULTS.margin);
    return {
      placement: chosen, left: box.left, top: box.top,
      width: box.width, height: box.height,
      narrow: false, request: request, fallback: fallback
    };
  }

  /* ═════════════ localStorage 标记：隐私模式下必须安静地失败 ═════════════ */

  // 允许注入（自检里用假 store）；只认 getItem/setItem/removeItem 三件套
  function pickStore(store) {
    if (store && typeof store.getItem === 'function') return store;
    try {
      if (typeof localStorage !== 'undefined' && localStorage && typeof localStorage.getItem === 'function') return localStorage;
    } catch (e) {
      // 某些浏览器在隐私模式/被策略禁用时，光读 localStorage 就抛 —— 当没有处理
    }
    return null;
  }

  function readFlag(storageKey, store) {
    var s = pickStore(store);
    if (!s) return false;
    try { return s.getItem(storageKey || DEFAULTS.storageKey) === FLAG_ON; } catch (e) { return false; }
  }

  function writeFlag(storageKey, store) {
    var s = pickStore(store);
    if (!s) return false;
    try { s.setItem(storageKey || DEFAULTS.storageKey, FLAG_ON); return true; } catch (e) { return false; }
  }

  function clearFlag(storageKey, store) {
    var s = pickStore(store);
    if (!s) return false;
    try { s.removeItem(storageKey || DEFAULTS.storageKey); return true; } catch (e) { return false; }
  }

  /** 该不该弹引导：没有 localStorage 时一律 true（宁可比用户多看一次，也不能一次都不弹） */
  function shouldShow(storageKey, store) {
    return !readFlag(storageKey, store);
  }

  /** 「再看一次引导」：清掉标记 */
  function reset(storageKey, store) {
    return clearFlag(storageKey, store);
  }

  /* ═════════════ DOM 层 ═════════════ */

  function safeCall(fn, args) {
    // 调用方回调抛错不能带崩引导：自身状态必须保持一致，否则会留下半张遮罩
    if (typeof fn !== 'function') return;
    try { fn.apply(null, args || []); } catch (e) { /* 静默：错在调用方 */ }
  }

  function stubController(steps) {
    // Node / 无 DOM 环境的同接口空控制器：所有方法可调用、不抛、也不改任何状态
    var c = {
      start: function () { return c; },
      next: function () { return c; },
      prev: function () { return c; },
      end: function () { return c; },
      index: function () { return 0; },
      isActive: function () { return false; },
      refresh: function () { return c; },
      destroy: function () { return c; },
      steps: steps || [],
      stub: true        // 显式标出「这是桩」，调用方可以据此决定是否降级
    };
    return c;
  }

  function create(config) {
    var cfg = config && typeof config === 'object' ? config : {};
    var steps = Array.isArray(cfg.steps) ? cfg.steps.filter(function (s) {
      return s && typeof s === 'object' && (typeof s.selector === 'string' || typeof s.selector === 'function');
    }) : [];

    var doc = typeof document !== 'undefined' ? document : null;
    var win = typeof window !== 'undefined' ? window : null;

    // 没有 DOM：返回桩（构建器里 require、或 Node 自检都会走这里）
    if (!doc || !win || typeof doc.createElement !== 'function') return stubController(steps);

    var total = steps.length;
    var storageKey = typeof cfg.storageKey === 'string' && cfg.storageKey ? cfg.storageKey : DEFAULTS.storageKey;
    var store = cfg.store || null;
    var once = cfg.once !== false;       // 默认 true

    var idx = -1;                        // 当前步（-1 = 还没开始）
    var active = false;
    var targetEl = null;
    var rootEl = null;
    var veilEl = null;
    var spotEl = null;
    var bubbleEl = null;
    var stepEl = null;
    var titleEl = null;
    var textEl = null;
    var dotsEl = null;
    var skipBtn = null;
    var prevBtn = null;
    var nextBtn = null;

    var lastFocus = null;                // 进来前的焦点，结束时还回去
    var prevOverflow = null;             // 进来前的 html overflow 原值
    var overflowTouched = false;
    var rafId = 0;
    var listeners = [];

    /* ── 小工具 ───────────────────────────────────────────────── */

    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = String(text);
      return n;
    }

    function btn(cls, text) {
      var b = el('button', cls, text);
      b.type = 'button';
      return b;
    }

    function on(target, type, fn, opts) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(type, fn, opts);
      listeners.push([target, type, fn, opts]);
    }

    function offAll() {
      for (var i = 0; i < listeners.length; i += 1) {
        var L = listeners[i];
        try { L[0].removeEventListener(L[1], L[2], L[3]); } catch (e) { /* 已卸载就算了 */ }
      }
      listeners = [];
    }

    function viewportSize() {
      var de = doc.documentElement || {};
      return {
        width: num(win.innerWidth, num(de.clientWidth, 0)),
        height: num(win.innerHeight, num(de.clientHeight, 0))
      };
    }

    /** selector 支持字符串或函数；拿不到/抛错都返回 null（= 跳过该步，不是崩溃） */
    function resolveEl(step) {
      if (!step) return null;
      var found = null;
      try {
        if (typeof step.selector === 'function') found = step.selector();
        else if (typeof step.selector === 'string' && step.selector) found = doc.querySelector(step.selector);
      } catch (e) {
        return null;
      }
      if (!found || typeof found.getBoundingClientRect !== 'function') return null;
      return found;
    }

    /** 尺寸为 0 基本等于 display:none（含祖先隐藏）；这种目标高亮出来是个点，直接跳过 */
    function measurable(node) {
      try {
        var r = node.getBoundingClientRect();
        return r.width > 1 || r.height > 1;
      } catch (e) { return false; }
    }

    /* ── 滚动锁：存原值、写 hidden、结束时写回 ────────────────── */

    function lockScroll() {
      var de = doc.documentElement;
      if (!de) return;
      prevOverflow = de.style.overflow;   // 先存（可能是空串，也可能有站点自己的值）
      overflowTouched = true;
      de.style.overflow = 'hidden';
    }

    function unlockScroll() {
      if (!overflowTouched) return;
      var de = doc.documentElement;
      if (de) de.style.overflow = prevOverflow == null ? '' : prevOverflow;
      prevOverflow = null;
      overflowTouched = false;
    }

    /* ── DOM 构建（只用 textContent，不拼 HTML 字符串） ────────── */

    function buildDom() {
      rootEl = el('div', 'onboard');
      rootEl.setAttribute('role', 'dialog');
      rootEl.setAttribute('aria-modal', 'true');
      rootEl.setAttribute('aria-label', '新手引导');
      rootEl.setAttribute('data-avpw-onboard', '1');

      veilEl = el('div', 'veil');         // 点击什么都不做：误触不该结束引导
      spotEl = el('div', 'spot');         // theme.css 里已 pointer-events:none
      bubbleEl = el('div', 'bubble');
      bubbleEl.tabIndex = -1;             // 可聚焦，键盘焦点有落点

      stepEl = el('div', 'ob-step');
      titleEl = el('h4');
      textEl = el('p');

      var actions = el('div', 'ob-actions');
      skipBtn = btn('btn ghost', '跳过');
      var growA = el('div', 'grow');      // theme.css: .ob-actions .grow { flex:1 } → 把点居中
      dotsEl = el('div', 'dots');
      var growB = el('div', 'grow');
      prevBtn = btn('btn ghost', '上一步');
      nextBtn = btn('btn primary', '下一步');

      actions.appendChild(skipBtn);
      actions.appendChild(growA);
      actions.appendChild(dotsEl);
      actions.appendChild(growB);
      actions.appendChild(prevBtn);
      actions.appendChild(nextBtn);

      bubbleEl.appendChild(stepEl);
      bubbleEl.appendChild(titleEl);
      bubbleEl.appendChild(textEl);
      bubbleEl.appendChild(actions);

      rootEl.appendChild(veilEl);
      rootEl.appendChild(spotEl);
      rootEl.appendChild(bubbleEl);

      var host = cfg.mount && cfg.mount.nodeType === 1 && cfg.mount.appendChild ? cfg.mount : (doc.body || doc.documentElement);
      host.appendChild(rootEl);

      on(skipBtn, 'click', function () { end(true); });
      on(prevBtn, 'click', function () { prev(); });
      on(nextBtn, 'click', function () { next(); });
    }

    /* ── 气泡内容 ─────────────────────────────────────────────── */

    function renderBubble(step, i) {
      stepEl.textContent = '第 ' + (i + 1) + ' 步 / 共 ' + total + ' 步';
      var title = step.title == null ? '' : String(step.title);
      var text = step.text == null ? '' : String(step.text);
      titleEl.textContent = title;
      textEl.textContent = text;
      titleEl.style.display = title ? '' : 'none';   // 空标题不留一条空白
      textEl.style.display = text ? '' : 'none';
      prevBtn.disabled = i === 0;                    // 首步不能再退
      nextBtn.textContent = i === total - 1 ? '完成' : '下一步';
      renderDots(i);
    }

    function renderDots(i) {
      var n = dotsEl.children.length;
      if (n !== total) {
        while (dotsEl.firstChild) dotsEl.removeChild(dotsEl.firstChild);
        for (var k = 0; k < total; k += 1) dotsEl.appendChild(el('i'));
      }
      for (var j = 0; j < dotsEl.children.length; j += 1) {
        dotsEl.children[j].className = j === i ? 'on' : '';
      }
    }

    /* ── 定位（唯一读布局的地方） ──────────────────────────────── */

    function measure() {
      if (!active || !rootEl || !targetEl || !doc.contains(targetEl)) return;
      var vp = viewportSize();
      var step = steps[idx] || {};
      var spot = padRect(targetEl.getBoundingClientRect(), num(step.pad, DEFAULTS.pad));

      // 先定气泡宽度再量高度：窄屏宽度由我们写死，宽屏交回 CSS 的 min(340px,86vw)。
      // 顺序反了会先按旧宽度算高度，出现「气泡被自己挤到屏幕外」的抖动。
      if (vp.width < DEFAULTS.narrow) bubbleEl.style.width = Math.max(0, vp.width - DEFAULTS.margin * 2) + 'px';
      else bubbleEl.style.width = '';

      var b = bubbleEl.getBoundingClientRect();
      var pos = computePlacement({
        spot: spot,
        viewport: vp,
        bubble: { width: b.width, height: b.height },
        place: step.place || DEFAULTS.place
      });

      spotEl.style.left = Math.round(spot.left) + 'px';
      spotEl.style.top = Math.round(spot.top) + 'px';
      spotEl.style.width = Math.round(spot.width) + 'px';
      spotEl.style.height = Math.round(spot.height) + 'px';

      bubbleEl.style.left = Math.round(pos.left) + 'px';
      bubbleEl.style.top = Math.round(pos.top) + 'px';
      if (pos.narrow) bubbleEl.style.width = Math.round(pos.width) + 'px';

      // 窄屏时气泡贴底，遮罩仍要暗场；spot 允许被视口裁切（它本来就在目标处，裁掉的是空气）
    }

    function schedule() {
      if (!active) return;
      if (rafId) return;                 // rAF 节流：一帧最多算一次，resize/scroll 风暴下不打爆布局
      if (typeof win.requestAnimationFrame !== 'function') { measure(); return; }
      rafId = win.requestAnimationFrame(function () {
        rafId = 0;
        measure();
      });
    }

    function scrollTargetIntoView(target) {
      try {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } catch (e) {
        try { target.scrollIntoView(); } catch (e2) { /* 连老方法都不支持就只靠 measure 夹紧 */ }
      }
    }

    /* ── 焦点 ─────────────────────────────────────────────────── */

    function focusNext() {
      if (!nextBtn || typeof nextBtn.focus !== 'function') return;
      try { nextBtn.focus({ preventScroll: true }); } catch (e) { try { nextBtn.focus(); } catch (e2) { /* 无焦点能力 */ } }
    }

    function bubbleFocusable() {
      var list = [skipBtn, prevBtn, nextBtn];
      var out = [];
      for (var i = 0; i < list.length; i += 1) if (list[i] && !list[i].disabled) out.push(list[i]);
      return out;
    }

    function restoreFocus() {
      try {
        if (lastFocus && lastFocus !== doc.body && typeof lastFocus.focus === 'function' && doc.contains(lastFocus)) {
          lastFocus.focus({ preventScroll: true });
          return;
        }
      } catch (e) { /* 掉到 body 兜底 */ }
      try {
        var body = doc.body;
        if (!body) return;
        // body 默认不可聚焦，加 tabindex=-1 才接得住焦点；这是临时属性，不动样式
        if (!body.hasAttribute('tabindex')) body.setAttribute('tabindex', '-1');
        body.focus({ preventScroll: true });
      } catch (e) { /* 尽力而为 */ }
    }

    /* ── 键盘 ─────────────────────────────────────────────────── */

    function trapTab(e) {
      var list = bubbleFocusable();
      if (!list.length) { e.preventDefault(); if (bubbleEl) bubbleEl.focus(); return; }
      var first = list[0];
      var last = list[list.length - 1];
      var now = doc.activeElement;
      if (!bubbleEl || !bubbleEl.contains(now)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (now === first && e.shiftKey) { e.preventDefault(); last.focus(); }
      else if (now === last && !e.shiftKey) { e.preventDefault(); first.focus(); }
    }

    function onKey(e) {
      if (!active || !e) return;
      var k = e.key || '';
      if (k === 'Escape' || k === 'Esc' || e.keyCode === 27) { e.preventDefault(); end(true); return; }
      if (k === 'ArrowRight') { e.preventDefault(); next(); return; }
      if (k === 'ArrowLeft') { e.preventDefault(); prev(); return; }
      if (k === 'Enter') {
        // 焦点在气泡按钮上时交给浏览器原生 click —— 否则「点跳过按回车」会变成走下一步
        if (e.target && bubbleEl && bubbleEl.contains(e.target) && e.target.tagName === 'BUTTON') return;
        e.preventDefault();
        next();
        return;
      }
      if (k === 'Tab') trapTab(e);
    }

    /* ── 步骤切换 ─────────────────────────────────────────────── */

    /** 试着展示第 i 步；目标不可用则返回 false（调用方继续找下一步），不抛错 */
    function tryShow(i) {
      if (i < 0 || i >= total) return false;
      var step = steps[i] || {};
      var target = resolveEl(step);
      if (!target || !measurable(target)) return false;

      idx = i;
      targetEl = target;
      renderBubble(step, i);
      scrollTargetIntoView(target);
      measure();      // 先按当前 rect 摆一次，避免首帧闪在 (0,0)
      schedule();     // 再等一帧（smooth 滚动推进后）矫正；滚动期间 scroll 事件会持续纠偏
      focusNext();
      safeCall(cfg.onStep, [i, step]);
      return true;
    }

    /* ── 生命周期 ─────────────────────────────────────────────── */

    function teardown(giveFocusBack) {
      if (rafId && typeof win.cancelAnimationFrame === 'function') {
        try { win.cancelAnimationFrame(rafId); } catch (e) { /* 无所谓 */ }
      }
      rafId = 0;
      offAll();
      if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
      rootEl = null; veilEl = null; spotEl = null; bubbleEl = null;
      stepEl = null; titleEl = null; textEl = null; dotsEl = null;
      skipBtn = null; prevBtn = null; nextBtn = null;
      unlockScroll();                  // 无论怎么结束，滚动一定要还回去
      active = false;
      targetEl = null;
      if (giveFocusBack) restoreFocus();
      lastFocus = null;
    }

    function start() {
      if (!total) return controller;    // 没步骤就没有引导：不建 DOM、不锁滚动、不回调
      teardown(false);                  // 每次 start 先清掉上一次的 DOM（不写标记、不回调）
      idx = -1;
      lastFocus = (function () { try { return doc.activeElement || null; } catch (e) { return null; } })();
      buildDom();
      lockScroll();
      on(win, 'resize', schedule);
      on(win, 'scroll', schedule, { passive: true, capture: true });  // capture: 内层滚动容器也算
      on(doc, 'keydown', onKey, true);
      active = true;
      rootEl.classList.add('on');       // theme.css: .onboard.on { display:block }

      for (var i = 0; i < total; i += 1) if (tryShow(i)) return controller;
      end(true);                        // 一个目标都不在页面上：按「跳过」收尾，不留空遮罩
      return controller;
    }

    function next() {
      if (!active) return controller;
      for (var i = idx + 1; i < total; i += 1) if (tryShow(i)) return controller;
      end(false);                       // 后面没有可用步骤 = 走完了
      return controller;
    }

    function prev() {
      if (!active) return controller;
      for (var i = idx - 1; i >= 0; i -= 1) if (tryShow(i)) return controller;
      focusNext();                      // 前面没有可用步骤：留在原地
      return controller;
    }

    function end(skipped) {
      if (!active) return controller;   // 幂等：重复 end 不重复回调
      var info = { skipped: !!skipped, steps: total, index: Math.max(0, idx) };
      if (once) writeFlag(storageKey, store);   // 做过/跳过都记下（内部 try/catch，隐私模式不崩）
      teardown(true);
      safeCall(cfg.onDone, [info]);
      return controller;
    }

    function refresh() {
      if (!active) return controller;
      var step = steps[idx];
      var target = resolveEl(step);
      if (!target || !measurable(target)) { next(); return controller; }  // 目标被页面重绘掉了：跳过
      targetEl = target;
      measure();
      schedule();
      return controller;
    }

    function destroy() {
      teardown(true);                   // 彻底移除 + 恢复滚动 + 还焦点；不写标记、不回调
      idx = -1;
      return controller;
    }

    var controller = {
      start: start,
      next: next,
      prev: prev,
      end: end,
      index: function () { return idx; },
      isActive: function () { return active; },
      refresh: refresh,
      destroy: destroy,
      steps: steps,
      storageKey: storageKey
    };
    return controller;
  }

  return {
    VERSION: VERSION,
    DEFAULTS: DEFAULTS,
    PLACES: PLACES,
    create: create,
    shouldShow: shouldShow,
    reset: reset,
    readFlag: readFlag,
    writeFlag: writeFlag,
    padRect: padRect,
    clampBox: clampBox,
    computePlacement: computePlacement
  };
});