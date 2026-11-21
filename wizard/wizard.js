/**
 * wizard/wizard.js —— 小白模式的流程主控（5 步状态机）
 *
 * 这份文件只做「把零件串起来」与「状态推进」，具体能力都在旁边三个模块里：
 *   styles.js   七个风格 + 五阶段文案（唯一文案源）
 *   engine.js   本地 Canvas 出片 + MediaRecorder 录制（离线也能出真 webm）
 *   library.js  IndexedDB 作品库（存参数 + 成片 + 缩略图）
 *   onboard.js  首次访问的半透明遮罩引导
 *
 * 四条设计取舍（改代码前先读）：
 *   1. **不引入框架**：整个平台零依赖、双击 file:// 就要能开。所以这里只有 DOM API，
 *      状态全在一个 state 对象里，切屏就是切 display 类，没有虚拟 DOM 的收益也没有它的成本。
 *   2. **一屏一件事**：屏幕用 `.screen.on` 控制，隐藏屏是真 display:none，
 *      用户不可能在第二步看到第四步的按钮——这是小白最容易被劝退的地方。
 *   3. **永不空手**：没有后端、没有模型、没有 IndexedDB 时都要出东西。
 *      本地引擎是默认路径，后端只是「有就更好」的增强；任何一环失败都降级而不是报错停住。
 *   4. **自动保存**：第四步一出来就已经进库了。「满意，保存」只是把这条标成收藏，
 *      因为小白最常犯的错就是「看完就关掉，片子没了」。
 *
 * 与后端的关系（server/app.js 的契约）：
 *   POST /api/jobs          建任务（prompt / profile / seed / kind）
 *   GET  /api/jobs/:id      轮询状态与产物
 *   后端在线时并行提交；它的产物如果可用，第四步会切成真模型出片，否则一直用本地成片。
 */
(function () {
  'use strict';

  var D = document;
  var W = window;

  var S = W.AVPW_STYLES || {};
  var STYLES = S.STYLES || [];
  var STAGES = S.STAGES || [];
  var TIPS = S.TIPS || [];
  var Engine = W.AVPW_ENGINE || {};
  var Library = W.AVPW_LIBRARY || {};
  var Onboard = W.AVPW_ONBOARD || {};

  /* 画幅 → 出片像素。录 960 宽的 webm 已经够清楚，再大只会让浏览器卡。 */
  var ASPECT_SIZE = { '16:9': [960, 540], '9:16': [540, 960], '1:1': [640, 640] };
  var PROFILE_LABEL = { draft: '草稿 · 480p', standard: '标准 · 720p', cinematic: '电影级 · 1080p' };
  var LS_ONBOARD = 'avp.wizard.onboarded';

  var state = {
    step: 1,
    styleId: null,
    prompt: '',
    seed: 0,
    params: { aspect: '16:9', profile: 'standard', duration: 5, quality: 1 },
    generating: false,
    backend: false,
    progress: { pct: 0, stage: -1, done: false },
    timers: { progress: null, elapsed: null, tip: null, backend: null },
    result: null,          // { record, blob, url, source, jobId }
    forceEngine: null,     // 'local' | 'backend' | null（URL 参数 ?engine=）
    works: [],
    openId: null,
    objectUrl: null,
    renderer: null,
    lastAdvancedFrom: null,
  };

  /* ── DOM 短手 ─────────────────────────────────────────────────────────── */
  function $(id) { return D.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(text, bad) {
    var layer = $('toasts');
    if (!layer) return;
    var el = D.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : '');
    el.textContent = text;
    layer.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 220ms';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, bad ? 3600 : 2400);
  }
  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }
  function randSeed() { return Math.floor(Math.random() * 900000000) + 100000000; }
  function pick(obj, names) {
    for (var i = 0; i < names.length; i += 1) if (obj && typeof obj[names[i]] === 'function') return obj[names[i]].bind(obj);
    return null;
  }

  var engineRecord = pick(Engine, ['record', 'recordVideo', 'capture']);
  var enginePoster = pick(Engine, ['renderPoster', 'poster', 'snapshot']);
  var engineCreate = pick(Engine, ['createRenderer', 'create']);
  var libSave = pick(Library, ['save', 'put', 'add']);
  var libList = pick(Library, ['list', 'all']);
  var libGet = pick(Library, ['get']);
  var libUpdate = pick(Library, ['update', 'patch']);
  var libRemove = pick(Library, ['remove', 'del', 'delete']);
  var libDownload = pick(Library, ['download']);
  var onboardCreate = pick(Onboard, ['create']);

  /* ── 切屏 ─────────────────────────────────────────────────────────────── */
  function go(step) {
    state.step = step;
    D.querySelectorAll('.screen').forEach(function (el) {
      el.classList.toggle('on', el.id === 'screen-' + step);
    });
    D.querySelectorAll('.navbtn').forEach(function (b) {
      var nav = b.getAttribute('data-nav');
      var on = (nav === 'make' && step <= 4) || (nav === 'library' && step === 5);
      b.classList.toggle('on', on);
    });
    if (W.scrollTo) W.scrollTo({ top: 0, behavior: 'smooth' });

    if (step === 1) renderStyles();
    if (step === 2) enterPrompt();
    if (step === 3) { /* 进度屏由 generate() 驱动 */ }
    if (step === 4) enterPreview();
    if (step === 5) renderLibrary();
  }

  /* ── 第一步：风格卡 ───────────────────────────────────────────────────── */
  function renderStyles() {
    var box = $('styles');
    if (!box || box.getAttribute('data-ready') === '1') { markSelected(); return; }
    box.innerHTML = STYLES.map(function (s) {
      return '<button class="style-card" type="button" data-style="' + esc(s.id) + '" aria-pressed="false">'
        + '<span class="thumb">' + s.thumb + '</span>'
        + '<span class="meta">'
        + '<span class="name">' + esc(s.label) + '</span>'
        + '<span class="tagline">' + esc(s.tag || '') + '</span>'
        + '</span>'
        + '</button>';
    }).join('');
    box.setAttribute('data-ready', '1');
    box.addEventListener('click', function (e) {
      var card = e.target.closest ? e.target.closest('.style-card') : null;
      if (!card) return;
      selectStyle(card.getAttribute('data-style'));
    });
    markSelected();
  }

  function markSelected() {
    D.querySelectorAll('.style-card').forEach(function (c) {
      var on = c.getAttribute('data-style') === state.styleId;
      c.classList.toggle('on', on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function selectStyle(id) {
    if (!id || state.generating) return;
    state.styleId = id;
    markSelected();
    // 选完自动进第二步：不要逼小白找「下一步」按钮，这一步的完成信号就是「点了」
    setTimeout(function () {
      if (state.step === 1) go(2);
      else if (state.step === 5) go(1);
    }, 280);
  }

  /* ── 第二步：输入 ─────────────────────────────────────────────────────── */
  function enterPrompt() {
    var box = $('prompt');
    var style = S.byId ? S.byId(state.styleId) : null;
    var example = style && style.examples && style.examples[0] ? style.examples[0] : '雪夜里小木屋亮着灯';
    box.setAttribute('placeholder', '比如：' + example);
    renderChips(style);
    setTimeout(function () { safe(function () { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }); }, 120);
    updateGenerateBtn();
  }

  function renderChips(style) {
    var box = $('chips');
    if (!box) return;
    var list = (style && style.examples) || [];
    box.innerHTML = list.map(function (t) {
      return '<button class="chip" type="button" data-fill="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
  }

  function updateGenerateBtn() {
    var btn = $('btn-generate');
    if (!btn) return;
    var has = !!($('prompt').value || '').trim();
    btn.disabled = false;           // 空也能点：会拿示例顶上，不让用户卡在"为什么按钮是灰的"
    btn.textContent = has ? '生成视频' : '用示例生成视频';
  }

  /* ── 第三步：进度 ─────────────────────────────────────────────────────── */
  var RING_LEN = 2 * Math.PI * 52;

  function renderStages() {
    var box = $('stage-list');
    if (!box) return;
    box.innerHTML = STAGES.map(function (st, i) {
      return '<li class="stage" data-i="' + i + '"><span class="mark">◇</span><span>' + esc(st.text) + '</span></li>';
    }).join('');
  }

  function paintProgress(pct, stageIdx, finished) {
    var bar = $('ringBar');
    var pctEl = $('pct');
    var p = Math.max(0, Math.min(100, Math.round(pct)));
    state.progress.pct = p;
    if (bar) {
      bar.style.strokeDasharray = RING_LEN.toFixed(1);
      bar.style.strokeDashoffset = (RING_LEN * (1 - p / 100)).toFixed(1);
    }
    if (pctEl) pctEl.textContent = p + '%';
    D.querySelectorAll('#stage-list .stage').forEach(function (li, i) {
      var done = finished || i < stageIdx || (i === stageIdx && p >= 100);
      li.classList.toggle('done', done);
      li.classList.toggle('now', !finished && i === stageIdx);
      var mark = li.querySelector('.mark');
      if (mark) mark.textContent = done ? '✓' : (i === stageIdx ? '◆' : '◇');
    });
    state.progress.stage = stageIdx;
  }

  function startProgress(startedAt, totalMs, onDone) {
    renderStages();
    var tipIdx = 0;
    var tipEl = $('tip');
    if (tipEl) tipEl.innerHTML = '<b>' + esc(TIPS[0] || '喝口水，AI 在帮你调 258 个参数') + '</b>';
    clearInterval(state.timers.progress);
    clearInterval(state.timers.tip);
    clearInterval(state.timers.elapsed);

    state.timers.progress = setInterval(function () {
      var t = (Date.now() - startedAt) / totalMs;
      // 前 88% 走时间轴，最后 12% 留给「真的录完了没」，避免 100% 卡着不动骗人
      var pct = Math.min(99, t * 100 * (t < 0.88 ? 1 : 0.88 / Math.max(t, 0.0001)));
      var stageIdx = pct < 8 ? 0 : pct < 22 ? 1 : pct < 56 ? 2 : pct < 88 ? 3 : 4;
      paintProgress(pct, stageIdx, false);
    }, 120);

    state.timers.elapsed = setInterval(function () {
      var s = Math.floor((Date.now() - startedAt) / 1000);
      var el = $('elapsed');
      if (el) el.textContent = '已用 ' + s + ' 秒';
    }, 500);

    state.timers.tip = setInterval(function () {
      tipIdx = (tipIdx + 1) % Math.max(1, TIPS.length);
      var el = $('tip');
      if (el && TIPS[tipIdx]) el.innerHTML = '<b>' + esc(TIPS[tipIdx]) + '</b>';
    }, 3600);

    return function stop() {
      clearInterval(state.timers.progress);
      clearInterval(state.timers.tip);
      clearInterval(state.timers.elapsed);
      var used = Math.round((Date.now() - startedAt) / 100) / 10;
      var el = $('elapsed');
      if (el) el.textContent = '用了 ' + used + ' 秒';
      return used;
    };
  }

  /* ── 后端探测与提交（有就用，没有不影响出片） ────────────────────────── */
  function detectBackend() {
    if (location.protocol === 'file:') return Promise.resolve(false);
    if (typeof fetch !== 'function') return Promise.resolve(false);
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 900);
    return fetch('/api/health', ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { clearTimeout(timer); return !!j; })
      .catch(function () { clearTimeout(timer); return false; });
  }

  function postJob(payload) {
    return fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function pollJob(id, onUpdate, onDone) {
    var tries = 0;
    clearInterval(state.timers.backend);
    state.timers.backend = setInterval(function () {
      tries += 1;
      if (tries > 120) { clearInterval(state.timers.backend); return; }
      fetch('/api/jobs/' + encodeURIComponent(id))
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          if (typeof onUpdate === 'function') safe(function () { onUpdate(j); });
          if (j.state === 'succeeded' || j.state === 'failed' || j.state === 'canceled') {
            clearInterval(state.timers.backend);
            if (typeof onDone === 'function') safe(function () { onDone(j); });
          }
        })
        .catch(function () { /* 单次失败不打断轮询 */ });
    }, 1500);
  }

  /* ── 生成 ─────────────────────────────────────────────────────────────── */
  function generate(reason) {
    if (state.generating) return;
    var style = S.byId ? S.byId(state.styleId) : null;
    if (!style) { toast('先选一个风格', true); go(1); return; }

    var val = ($('prompt').value || '').trim();
    if (!val) {
      val = style.examples[0];
      $('prompt').value = val;
      toast('你没写，先用了一句示例（可以改）');
    }
    state.prompt = val;
    if (!state.seed) state.seed = randSeed();

    state.generating = true;
    state.result = null;
    go(3);
    var startedAt = Date.now();
    var dims = ASPECT_SIZE[state.params.aspect] || ASPECT_SIZE['16:9'];
    var recMs = Math.min(8000, Math.max(4000, state.params.duration * 1000));
    var totalMs = Math.min(20000, Math.max(9000, recMs + 5200));

    var stopTicker = startProgress(startedAt, totalMs);

    // 先放一张静帧当"正在画"的底：让进度屏不是纯文字，等录制完成再换成视频
    var poster = null;
    if (enginePoster) poster = safe(function () {
      return enginePoster({ styleId: state.styleId, prompt: val, seed: state.seed, width: 640, height: Math.round(640 * dims[1] / dims[0]) });
    }, null);

    var recPromise = engineRecord
      ? Promise.resolve(safe(function () {
          return engineRecord({
            styleId: state.styleId, prompt: val, seed: state.seed,
            width: dims[0], height: dims[1], ms: recMs, fps: 30,
          });
        }, { ok: false, reason: 'ENGINE_THROW' }))
      : Promise.resolve({ ok: false, reason: 'NO_ENGINE' });

    // 后端并行提交：它可能比本地慢一个数量级，所以不 await，等结果回来再升级
    var jobPromise = state.backend ? postJob({
      prompt: val, style: state.styleId, seed: state.seed,
      profile: state.params.profile, size: dims[0] + '*' + dims[1],
      duration: state.params.duration, kind: 't2v', note: 'wizard',
    }) : Promise.resolve(null);

    jobPromise.then(function (job) {
      if (!job || !job.id) return;
      state.result = state.result || {};
      state.result.jobId = job.id;
      pollJob(job.id, null, function (j) {
        var url = mediaUrlOf(j);
        if (url && state.result && state.result.record) {
          state.result.remoteUrl = url;
          toast('模型版也出来了，已切到模型出片');
          applyRemote(j, url);
        }
      });
    });

    recPromise.then(function (res) {
      var used = stopTicker();
      state.generating = false;
      paintProgress(100, STAGES.length - 1, true);

      var blob = res && res.blob ? res.blob : null;
      var recPoster = (res && res.poster) || poster;
      var record = {
        id: 'w_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        createdAt: Date.now(),
        styleId: state.styleId,
        styleLabel: style.label,
        prompt: val,
        seed: state.seed,
        params: {
          aspect: state.params.aspect,
          profile: state.params.profile,
          profileLabel: PROFILE_LABEL[state.params.profile] || state.params.profile,
          duration: state.params.duration,
          fps: 24,
          quality: state.params.quality,
        },
        source: 'local',
        jobId: state.result && state.result.jobId ? state.result.jobId : null,
        videoBlob: blob,
        videoUrl: null,
        poster: recPoster,
        durationMs: recMs,
        note: reason || '',
      };

      state.result = {
        record: record,
        blob: blob,
        url: blob ? URL.createObjectURL(blob) : null,
        source: 'local',
        jobId: record.jobId,
        tookMs: used * 1000,
      };

      // 自动入库：先存再显示，避免用户看完就关掉导致丢片
      if (libSave) {
        libSave(record).then(function (saved) {
          if (saved && saved.id) { record.id = saved.id; state.result.record = saved; }
        }).catch(function () { /* 存不进去也不拦着看片 */ });
      }
      go(4);
    });
  }

  function mediaUrlOf(job) {
    if (!job) return null;
    if (job.media && job.media.url) return job.media.url;
    if (job.videoUrl) return job.videoUrl;
    if (job.outputs && job.outputs.length) {
      var o = job.outputs[0];
      var name = o.name || (o.path ? String(o.path).split(/[\\/]/).pop() : null);
      if (name) return '/api/outputs/' + encodeURIComponent(name);
    }
    return null;
  }

  /* ── 第四步：预览 ─────────────────────────────────────────────────────── */
  function enterPreview() {
    var r = state.result;
    var video = $('video');
    var canvas = $('previewCanvas');
    var stage = $('player');
    var badge = $('playerBadge');

    if (!r || !r.record) { toast('这一版没生成出来，点「换一版」再试', true); return; }

    var aspect = r.record.params.aspect;
    if (stage) {
      stage.classList.toggle('vertical', aspect === '9:16');
      stage.style.setProperty('--wz-aspect', aspect === '9:16' ? '9 / 16' : aspect === '1:1' ? '1 / 1' : '16 / 9');
    }

    if (video) {
      if (r.url) {
        video.style.display = '';
        video.src = r.url;
        video.loop = true; video.muted = true; video.playsInline = true;
        safe(function () { video.play(); });
        if (canvas) canvas.style.display = 'none';
      } else {
        video.style.display = 'none';
        if (canvas) {
          canvas.style.display = '';
          paintCanvasLoop(canvas, aspect);
        }
      }
    }
    if (badge) {
      badge.textContent = r.remoteUrl ? '模型出片' : (r.url ? '本地演示成片 · webm' : '实时预览');
      badge.classList.toggle('warn', !r.url);
    }
    renderResultKv();
    if ($('btn-save')) {
      $('btn-save').innerHTML = '<span class="ico">👍</span>满意，保存';
      $('btn-save').disabled = false;
    }
    if ($('btn-play')) $('btn-play').innerHTML = '<span class="ico">⏸</span>暂停';
    var meta = $('playerMeta');
    if (meta) {
      meta.textContent = r.record.params.profileLabel + ' · ' + r.record.params.aspect + ' · ' + r.record.params.duration + ' 秒 · 种子 ' + r.record.seed
        + (r.tookMs ? ' · 用时 ' + Math.round(r.tookMs / 100) / 10 + ' 秒' : '');
    }
  }

  function renderResultKv() {
    var box = $('resultKv');
    var r = state.result;
    if (!box || !r || !r.record) return;
    var rec = r.record;
    box.innerHTML = [
      ['风格', rec.styleLabel],
      ['描述', rec.prompt],
      ['画幅', rec.params.aspect],
      ['画质', rec.params.profileLabel],
      ['时长', rec.params.duration + ' 秒'],
      ['种子', rec.seed],
    ].map(function (kv) {
      return '<div class="kv"><span>' + esc(kv[0]) + '</span><b>' + esc(kv[1]) + '</b></div>';
    }).join('');
  }

  /* 录制失败时的兜底播放：实时 Canvas 循环，用户照样能看到"动起来" */
  function paintCanvasLoop(canvas, aspect) {
    if (!engineCreate) return;
    var dims = ASPECT_SIZE[aspect] || ASPECT_SIZE['16:9'];
    canvas.width = dims[0]; canvas.height = dims[1];
    if (state.renderer) safe(function () { state.renderer.stop(); });
    state.renderer = safe(function () {
      var r = engineCreate(canvas, {
        styleId: state.styleId, prompt: state.prompt, seed: state.seed,
        width: dims[0], height: dims[1], aspect: aspect,
      });
      if (r && r.start) r.start();
      return r;
    }, null);
  }

  function applyRemote(job, url) {
    if (!state.result) return;
    state.result.remoteUrl = url;
    state.result.source = 'backend';
    state.result.record.videoUrl = url;
    state.result.record.source = 'backend';
    var video = $('video');
    if (video) {
      video.style.display = '';
      video.src = url;
      safe(function () { video.play(); });
      var canvas = $('previewCanvas');
      if (canvas) canvas.style.display = 'none';
    }
    var badge = $('playerBadge');
    if (badge) { badge.textContent = '模型出片'; badge.classList.remove('warn'); }
    if (libUpdate && state.result.record.id) libUpdate(state.result.record.id, { videoUrl: url, source: 'backend' });
  }

  /* ── 第五步：作品库 ───────────────────────────────────────────────────── */
  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderLibrary() {
    var box = $('library');
    if (!box) return;
    if (!libList) { box.innerHTML = '<div class="lib-empty">这个浏览器不支持本地作品库，片子仍可当场下载。</div>'; return; }

    libList().then(function (rows) {
      state.works = rows || [];
      if (!state.works.length) {
        box.innerHTML = '<div class="lib-empty">还没有作品。<br>回「开始生成」做一条，自动会存在这里。</div>';
        renderLibDetail(null);
        return;
      }
      box.innerHTML = state.works.map(function (w) {
        var thumb = w.poster
          ? '<img src="' + esc(w.poster) + '" alt="">'
          : (S.byId && S.byId(w.styleId) ? S.byId(w.styleId).thumb : '');
        return '<button class="lib-item" type="button" data-id="' + esc(w.id) + '">'
          + '<span class="lib-thumb">' + thumb + '</span>'
          + '<span class="lib-meta">'
          + '<span class="lib-title">' + esc(w.prompt || '（没写描述）') + '</span>'
          + '<span class="lib-sub">' + esc(w.styleLabel || w.styleId) + ' · ' + esc(fmtTime(w.createdAt)) + (w.videoOmitted ? ' · 仅参数' : '') + '</span>'
          + '</span></button>';
      }).join('');
      if (state.works[0]) {
        var keep = state.openId && state.works.some(function (w) { return w.id === state.openId; }) ? state.openId : state.works[0].id;
        openWork(keep);
      }
    }).catch(function () {
      box.innerHTML = '<div class="lib-empty">读取作品库失败，刷新一次再试。</div>';
    });
  }

  function openWork(id) {
    state.openId = id;
    D.querySelectorAll('#library .lib-item').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-id') === id);
    });
    var get = libGet || function (i) { return Promise.resolve(state.works.filter(function (w) { return w.id === i; })[0] || null); };
    get(id).then(function (w) { renderLibDetail(w); });
  }

  function renderLibDetail(w) {
    var box = $('libDetail');
    if (!box) return;
    if (!w) { box.innerHTML = '<div class="lib-note">左边选一个作品。</div>'; return; }
    var media = '';
    if (w.videoUrl) media = '<video controls loop playsinline src="' + esc(w.videoUrl) + '"></video>';
    else if (w.videoBlob) {
      if (state.libUrl) safe(function () { URL.revokeObjectURL(state.libUrl); });
      state.libUrl = URL.createObjectURL(w.videoBlob);
      media = '<video controls loop playsinline autoplay muted src="' + state.libUrl + '"></video>';
    } else if (w.poster) media = '<img src="' + esc(w.poster) + '" alt="" style="width:100%;height:100%;object-fit:contain">';
    else media = '<div class="lib-note" style="align-self:center">这条只留了参数，没有存视频文件</div>';

    box.innerHTML = ''
      + '<div class="player-stage">' + media + '</div>'
      + '<div>'
      + '<div class="lib-title" style="font-size:15px;white-space:normal">' + esc(w.prompt) + '</div>'
      + '<div class="lib-sub" style="margin-top:4px">' + esc(w.styleLabel) + ' · ' + esc(fmtTime(w.createdAt)) + '</div>'
      + '</div>'
      + '<div>'
      + '<div class="kv"><span>画幅</span><b>' + esc(w.params ? w.params.aspect : '—') + '</b></div>'
      + '<div class="kv"><span>画质</span><b>' + esc(w.params ? (w.params.profileLabel || w.params.profile) : '—') + '</b></div>'
      + '<div class="kv"><span>时长</span><b>' + esc(w.params ? w.params.duration + ' 秒' : '—') + '</b></div>'
      + '<div class="kv"><span>种子</span><b>' + esc(w.seed) + '</b></div>'
      + '</div>'
      + '<div class="lib-actions">'
      + '<button class="btn" data-act="reuse" data-id="' + esc(w.id) + '">↺ 复用这个风格</button>'
      + '<button class="btn" data-act="download" data-id="' + esc(w.id) + '">⤓ 下载视频</button>'
      + '<button class="btn ghost" data-act="delete" data-id="' + esc(w.id) + '">删除</button>'
      + '</div>'
      + '<div class="lib-note">「复用这个风格」会带着这一版的参数回到第一步，你只要写一句新描述。</div>';
  }

  function reuseStyle(id) {
    var w = state.works.filter(function (x) { return x.id === id; })[0];
    if (!w) return;
    state.styleId = w.styleId;
    state.prompt = '';
    state.seed = randSeed();
    state.params = {
      aspect: w.params && w.params.aspect ? w.params.aspect : '16:9',
      profile: w.params && w.params.profile ? w.params.profile : 'standard',
      duration: w.params && w.params.duration ? w.params.duration : 5,
      quality: 1,
    };
    var banner = $('reuseBanner');
    if (banner) {
      banner.classList.add('on');
      $('reuseStyle').textContent = w.styleLabel || w.styleId;
      $('reuseParams').textContent = '参数：' + state.params.aspect + ' · ' + (PROFILE_LABEL[state.params.profile] || state.params.profile) + ' · ' + state.params.duration + ' 秒';
    }
    if ($('prompt')) $('prompt').value = '';
    go(1);
    toast('风格和参数已就位，写一句新描述就行');
  }

  /* ── 事件绑定 ─────────────────────────────────────────────────────────── */
  function bind() {
    D.addEventListener('click', function (e) {
      var t = e.target;
      var nav = t.closest ? t.closest('[data-nav]') : null;
      if (nav) {
        var kind = nav.getAttribute('data-nav');
        if (kind === 'library') { go(5); return; }
        if (kind === 'help') { startOnboard(true); return; }
        if (kind === 'make') { go(state.step === 5 ? 1 : state.step); renderStyles(); return; }
      }
      var chip = t.closest ? t.closest('[data-fill]') : null;
      if (chip) {
        $('prompt').value = chip.getAttribute('data-fill');
        $('prompt').focus();
        updateGenerateBtn();
        return;
      }
      var act = t.closest ? t.closest('[data-act]') : null;
      if (act) {
        var id = act.getAttribute('data-id');
        var kind2 = act.getAttribute('data-act');
        if (kind2 === 'reuse') reuseStyle(id);
        if (kind2 === 'download') downloadWork(id);
        if (kind2 === 'delete') deleteWork(id);
        return;
      }
      var item = t.closest ? t.closest('.lib-item') : null;
      if (item) { openWork(item.getAttribute('data-id')); return; }
    });

    var promptEl = $('prompt');
    if (promptEl) {
      promptEl.addEventListener('input', updateGenerateBtn);
      promptEl.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); generate('keyboard'); }
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          // 小白不会按 Shift+Enter 换行，用单行回车直接生成更符合直觉
          e.preventDefault(); generate('enter');
        }
      });
    }

    on('btn-generate', 'click', function () { generate('button'); });
    on('btn-back-1', 'click', function () { go(1); });
    on('btn-reuse-continue', 'click', function () { go(2); });
    on('btn-cancel', 'click', function () {
      if (state.timers.backend) clearInterval(state.timers.backend);
      state.generating = false;
      if (state.timers.progress) clearInterval(state.timers.progress);
      toast('已取消，再点一次生成就行');
      go(2);
    });

    on('btn-save', 'click', function () {
      var r = state.result;
      if (!r || !r.record) return;
      if (libUpdate) libUpdate(r.record.id, { favorite: true, favoriteAt: Date.now() });
      $('btn-save').innerHTML = '<span class="ico">✓</span>已保存到作品库';
      $('btn-save').disabled = true;
      toast('已保存，作品库里能找到');
    });

    on('btn-regenerate', 'click', function () {
      state.seed = randSeed();
      generate('regenerate');
    });

    on('btn-advanced', 'click', function () {
      var adv = $('advanced');
      var on_ = adv.classList.toggle('on');
      if (on_) {
        $('adv-aspect').value = state.params.aspect;
        $('adv-profile').value = state.params.profile;
        $('adv-duration').value = String(state.params.duration);
        $('adv-seed').value = String(state.seed);
      }
    });
    on('btn-close-advanced', 'click', function () { $('advanced').classList.remove('on'); });
    on('btn-dice', 'click', function () { $('adv-seed').value = String(randSeed()); });
    on('btn-apply-advanced', 'click', function () {
      state.params.aspect = $('adv-aspect').value;
      state.params.profile = $('adv-profile').value;
      state.params.duration = Number($('adv-duration').value) || 5;
      var sd = parseInt($('adv-seed').value, 10);
      state.seed = isNaN(sd) ? randSeed() : sd;
      $('advanced').classList.remove('on');
      generate('advanced');
    });

    on('btn-play', 'click', function () {
      var v = $('video');
      if (!v || !v.src) return;
      if (v.paused) { v.play(); $('btn-play').innerHTML = '<span class="ico">⏸</span>暂停'; }
      else { v.pause(); $('btn-play').innerHTML = '<span class="ico">▶</span>播放'; }
    });
    on('btn-full', 'click', function () {
      var v = $('video');
      if (v && v.requestFullscreen) v.requestFullscreen();
    });

    D.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { var adv = $('advanced'); if (adv) adv.classList.remove('on'); }
    });

    D.querySelectorAll('.navbtn').forEach(function (b) { b.setAttribute('type', 'button'); });
  }

  function on(id, ev, fn) {
    var el = $(id);
    if (el) el.addEventListener(ev, fn);
  }

  function downloadWork(id) {
    var get = libGet || function (i) { return Promise.resolve(state.works.filter(function (w) { return w.id === i; })[0] || null); };
    get(id).then(function (w) {
      if (!w) return;
      if (libDownload) {
        var name = 'VisInter-' + (w.styleLabel || w.styleId) + '-' + w.id + '.webm';
        libDownload(w, name).then(function (r) {
          if (!r || !r.ok) toast('这条没有视频文件，只有参数', true);
          else toast('已开始下载');
        }).catch(function () { toast('下载失败', true); });
        return;
      }
      if (w.videoBlob) {
        var a = D.createElement('a');
        a.href = URL.createObjectURL(w.videoBlob);
        a.download = 'VisInter-' + w.id + '.webm';
        D.body.appendChild(a); a.click(); D.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        toast('已开始下载');
      } else toast('这条没有视频文件，只有参数', true);
    });
  }

  function deleteWork(id) {
    if (!libRemove) { toast('这个浏览器不支持删除', true); return; }
    libRemove(id).then(function (ok) {
      if (!ok) { toast('删除失败', true); return; }
      state.openId = null;
      toast('已删除');
      renderLibrary();
    });
  }

  /* ── 新手引导 ─────────────────────────────────────────────────────────── */
  function startOnboard(force) {
    if (!onboardCreate) return;
    var steps = [
      {
        selector: '#styles', place: 'bottom',
        title: '先点一个你喜欢的风格',
        text: '七张卡片，看画面挑就行。点完自动进下一步，不用找「下一步」按钮。',
      },
      {
        selector: '[data-nav="library"]', place: 'right',
        title: '做过的片子都在这',
        text: '不用手动保存，每次生成都会自动存进作品库，随时回来重播或下载。',
      },
      {
        selector: '.brand', place: 'right',
        title: '就这三步：选风格 → 写一句 → 等',
        text: '写不出描述就点示例，直接生成。想改细节再点「手动调整」，不改也能出片。',
      },
    ];
    var ctrl = safe(function () {
      return onboardCreate({
        steps: steps,
        storageKey: LS_ONBOARD,
        once: !force,
        onDone: function () { renderStyles(); },
      });
    }, null);
    if (ctrl && ctrl.start) safe(function () { ctrl.start(); });
  }

  function maybeOnboard() {
    var seen = false;
    try { seen = localStorage.getItem(LS_ONBOARD) === '1'; } catch (e) { seen = false; }
    if (seen) return;
    setTimeout(function () { startOnboard(false); }, 700);
  }

  /* ── 启动 ─────────────────────────────────────────────────────────────── */
  function setEngineTag(online) {
    var dot = $('engineDot');
    var txt = $('engineText');
    var note = $('engineNote');
    if (dot) dot.classList.toggle('local', !online);
    if (txt) txt.textContent = online ? '后端在线' : '本地演示引擎';
    if (note) note.textContent = online ? '会同时提交模型任务，出了模型版自动换过来' : '没模型也能出片，画面是本地算的';
  }

  function init() {
    state.seed = randSeed();
    // 引擎开关：?engine=local 强制本地（省钱/离线演示），?engine=backend 强制走后端。
    // 默认策略是「后端在线就用后端」——用户点「生成视频」的意思就是让模型出片，
    // 本地引擎只是保证任何环境下都有一版能看的东西。
    var forced = safe(function () { return new URLSearchParams(location.search).get('engine'); }, null);
    state.forceEngine = forced === 'local' || forced === 'backend' ? forced : null;
    renderStyles();
    bind();
    renderStages();
    paintProgress(0, 0, false);
    setEngineTag(false);
    detectBackend().then(function (ok) {
      state.backend = !!ok && state.forceEngine !== 'local';
      if (state.forceEngine === 'local') state.backend = false;
      setEngineTag(state.backend);
    });
    maybeOnboard();
  }

  if (D.readyState === 'loading') D.addEventListener('DOMContentLoaded', init);
  else init();

  // 给自检/调试留一个只读入口（生产页面也是同一个名字，方便在控制台确认状态）
  W.AVPW_WIZARD = {
    state: state,
    go: go,
    generate: generate,
    version: '1.0.0',
  };
})();