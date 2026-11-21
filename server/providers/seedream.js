/**
 * providers/seedream.js —— 火山方舟 Seedream 5.0 pro 出图 provider（Muse 氛围感 / 抖音网红脸的真机通路）
 *
 * 协议（官方文档口径，见 spec/reverse.capabilities.json 的 target 段）：
 *   POST {base}/images/generations  同步返回，一次一张
 *   → data[0].url（24h 过期，必须立刻落盘）| data[0].b64_json
 *
 * 硬纪律（与 dashscope.js 同源，别放松）：
 *   1) key 只走环境变量 / 指定 key 文件，不进仓库、不进前端、不落任务记录、不打印；
 *   2) 没有 key → probe 如实 reachable:false（SR_NO_API_KEY），任务 Failed 给人话原因，不静默 mock；
 *   3) 5.0 没有 negative_prompt 字段 —— 负向集软化成「避免：…」拼在 prompt 尾部，并在 meta 里如实标注
 *      `negative_field_supported:false`，不许假装设置过；
 *   4) 同步接口拿不到采样进度：只报 queued → generating → downloading 阶段，不编百分比；
 *   5) url 24h 有效 → 出图后立即下载转存 %CLOUD_ROOT%\02-视频\关键帧，并写 ledger（账单追溯）；
 *   6) 审核失败不计费（4xx），但也不重投 —— 重复计费是这里最贵的错误。
 *
 * 为什么单独一个 provider 而不是塞进 dashscope：dashscope 是「异步视频任务」协议（任务 id + 轮询），
 * Seedream 是「同步出图」协议。混在一起就得在一个文件里维护两套状态机，出错时无法判断是协议还是模型问题。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CLOUD_ROOT = process.env.CLOUD_ROOT || 'D:\\云盘';
const OUTPUT_DIR = path.join(CLOUD_ROOT, '02-视频', '关键帧');
const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedream-5-0-pro-260628';
const SPEC_FILE = path.join(__dirname, '..', '..', 'spec', 'reverse.capabilities.json');

const HINTS = {
  SR_NO_API_KEY: '未找到火山方舟 key：设 ARK_API_KEY（或 ARK_STD_KEY / ARK_KEY），或把 key 写进 %CLOUD_ROOT%\\01-代码\\AI绘图\\seedream-5pro\\keys\\ark_std_key.txt。',
  SR_INVALID_API_KEY: '方舟 key 无效或与通道不匹配（std 通道要按量 key；ark- 开头的是 Agent Plan key，需 --base plan）。',
  SR_UNREACHABLE: '连不上 ark.cn-beijing.volces.com：检查网络/代理；可用 ARK_BASE_URL 换端点。',
  SR_TIMEOUT: 'Seedream 出图超时（同步接口，单张通常 10–40s）。先降档 1K 重试，别连发。',
  SR_EMPTY_PROMPT: '提示词为空：至少给主体（values.ch.subject 或 note）。',
  SR_BAD_SIZE: '尺寸不合法：只认 1K/1.5K/2K 档位组合或显式 WxH（总像素 921600–4624220，比例 1/16–16）。',
  SR_BAD_ABILITY: '未知能力：只支持 spec/reverse.capabilities.json 里声明的 ability id。',
  SR_HTTP_ERROR: '方舟返回非 2xx：看 detail.code/message（常见 InvalidParameter / 内容审核拦截 / 欠费）。',
  SR_NO_URL: '响应里既没有 url 也没有 b64_json：接口形状变了，看 detail.response。',
  SR_DOWNLOAD_FAILED: '出图成功但下载失败：url 24h 有效，可人工续取（meta 里有 url，不落 key）。',
  SR_KIND_UNSUPPORTED: '本 provider 只处理 kind=image 的任务；视频请切 AVP_PROVIDER=dashscope / comfy / cine。',
};

class SeedreamError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'SeedreamError';
    this.code = code;
    this.detail = detail || {};
    this.hint = HINTS[code] || '';
  }
  toJSON() { return { code: this.code, message: this.message, hint: this.hint, detail: this.detail }; }
}

/** 能力包（缓存一次；纯数据，改完文件重启即可生效）。 */
let specCache = null;
function loadCaps() {
  if (!specCache) specCache = JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8'));
  return specCache;
}

function abilityOf(id) {
  const caps = loadCaps();
  const a = caps.abilities.find((x) => x.id === id);
  if (!a) throw new SeedreamError('SR_BAD_ABILITY', `未知能力 ${id}`, { allowed: caps.abilities.map((x) => x.id) });
  return a;
}

/** 档位 × 比例 → 显式像素（白名单来自官方 size_map，不现场算比例，避免浮点误差把 9:16 算成 0.5624）。 */
const SIZE_MAP = {
  '1K': { '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1424x800', '9:16': '800x1424', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1568x672' },
  '1.5K': { '1:1': '1536x1536', '4:3': '1792x1344', '3:4': '1344x1792', '16:9': '2048x1152', '9:16': '1152x2048', '3:2': '1872x1248', '2:3': '1248x1872', '21:9': '2352x1008' },
  '2K': { '1:1': '2048x2048', '4:3': '2368x1776', '3:4': '1776x2368', '16:9': '2816x1584', '9:16': '1584x2816', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
};

function parseWH(size) {
  const m = /^\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*$/.exec(String(size || ''));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

/** 显式尺寸校验：总像素 921,600–4,624,220，宽高比 1/16–16（官方口径）。 */
function validateSize(size) {
  const wh = parseWH(size);
  if (!wh) return { ok: false, reason: '不是 WxH' };
  const px = wh.w * wh.h;
  const ratio = wh.w / wh.h;
  if (px < 921600 || px > 4624220) return { ok: false, reason: `总像素 ${px} 越界 [921600, 4624220]` };
  if (ratio < 1 / 16 || ratio > 16) return { ok: false, reason: `宽高比 ${ratio.toFixed(3)} 越界 [1/16, 16]` };
  return { ok: true, w: wh.w, h: wh.h, pixels: px, ratio };
}

function resolveSize({ tier = '1.5K', ratio = '9:16', size = null } = {}) {
  if (size) {
    const v = validateSize(size);
    if (!v.ok) throw new SeedreamError('SR_BAD_SIZE', `尺寸 ${size} 不合法：${v.reason}`, { size });
    return { size, ...v };
  }
  const s = (SIZE_MAP[tier] || {})[ratio];
  if (!s) throw new SeedreamError('SR_BAD_SIZE', `档位/比例组合不存在：${tier} × ${ratio}`, { tier, ratio, allowed: Object.keys(SIZE_MAP) });
  const v = validateSize(s);
  if (!v.ok) throw new SeedreamError('SR_BAD_SIZE', `白名单尺寸 ${s} 未通过校验：${v.reason}`, { tier, ratio, size: s });
  return { size: s, ...v };
}

/** 计费估算（元）：≤2.61M 像素 0.30，>2.61M 0.60；第 2 张起参考图 +0.02。 */
function estimateCost(pixels, refs = 0) {
  const base = pixels > 2610000 ? 0.6 : 0.3;
  return Math.round((base + Math.max(0, refs - 1) * 0.02) * 100) / 100;
}

function zhChars(s) { return ((String(s || '').match(/[\u4e00-\u9fa5]/g) || []).length); }

/**
 * 预算裁剪：把编译结果压到官方建议的 300 中文字以内。
 *
 * 为什么不粗暴截断字符串：截断会切在半个词上（"下颌线收"），模型读到的是另一个意思。
 * 这里删整条槽位条目，并用平台自己的 renderZh 重渲染 —— 与编译层同源，读起来仍是人话。
 * 删除顺序 = 从最不影响骨相的槽位开始：quality → style → camera → scene → outfit → appearance → light → subject。
 * 每条删除都记进 removed[]，出问题时能回答"为什么这句没了"。
 */
function compactStructured(structured, limit) {
  if (!structured || !structured.slots) return { structured, removed: [], before: 0, after: 0 };
  const compose = require('../../prompt/compose.js');
  const work = JSON.parse(JSON.stringify(structured));
  const removed = [];
  const count = () => zhChars(compose.renderZh(work) || '');
  const before = count();
  if (before <= limit) return { structured: work, removed, before, after: before };

  // 1) 去重：同一句渲染文本只留先到的（"暖肤配冷背景"同时被 style 与 look 槽发出过）；
  //    再按逗号短语做段级去重——风格条目常与主体句/画风条目共享半个短语，整条删会丢骨相，只删重复段。
  const seen = new Set();
  const keptText = [];
  const keptSegList = [];
  const isDupSeg = (seg) => keptSegList.some((k) => k === seg || (seg.length >= 4 && k.includes(seg)));
  for (const slot of Object.keys(work.slots)) {
    work.slots[slot] = work.slots[slot].filter((it) => {
      const t = String(it.zh || '').trim();
      if (!t) return true;
      if (seen.has(t) || keptText.some((prev) => prev.includes(t))) {
        removed.push({ slot, key: it.key, zh: t, reason: 'duplicate' });
        return false;
      }
      if (slot !== 'subject') {
        const segs = t.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
        const left = segs.filter((seg) => !isDupSeg(seg));
        if (!left.length) {
          removed.push({ slot, key: it.key, zh: t, reason: 'duplicate-segment' });
          return false;
        }
        if (left.length < segs.length) {
          it.zh = left.join('，');
          removed.push({ slot, key: it.key, zh: segs.filter((seg) => isDupSeg(seg)).join('，'), reason: 'duplicate-segment' });
        }
        left.forEach((seg) => keptSegList.push(seg));
      } else {
        t.split(/[，,]/).map((x) => x.trim()).filter(Boolean).forEach((seg) => keptSegList.push(seg));
      }
      seen.add(t);
      keptText.push(t);
      return true;
    });
  }

  // 2) 按槽位优先级删权重最小条目，直到进预算。
  //    quality 槽里 lk.*（LUT/锐化/暗角等后期参数）在文生图阶段本来就不生效，先删它们再谈别的。
  const order = ['quality', 'style', 'camera', 'scene', 'outfit', 'appearance', 'light', 'subject'];
  for (let guard = 0; guard < 400 && count() > limit; guard += 1) {
    let deleted = false;
    for (const slot of order) {
      const arr = work.slots[slot] || [];
      if (arr.length <= 1) continue;
      let idx = -1;
      for (let i = 0; i < arr.length; i += 1) {
        if (String(arr[i].key || '').startsWith('lk.')) { idx = i; break; }
      }
      if (idx < 0) {
        idx = 0;
        for (let i = 1; i < arr.length; i += 1) if ((arr[i].w || 1) < (arr[idx].w || 1)) idx = i;
      }
      const it = arr.splice(idx, 1)[0];
      removed.push({ slot, key: it.key, zh: it.zh, w: it.w, reason: 'budget' });
      deleted = true;
      break;
    }
    if (!deleted) break;
  }
  return { structured: work, removed, before, after: count() };
}

function createSeedreamProvider(opts = {}) {
  const base = String(opts.base || process.env.ARK_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const registry = opts.registry || null;
  const timeoutMs = Math.max(15000, Number(opts.timeoutMs || process.env.AVP_SR_TIMEOUT_MS || 150000));
  const keyFile = opts.keyFile || process.env.ARK_KEY_FILE
    || path.join(CLOUD_ROOT, '01-代码', 'AI绘图', 'seedream-5pro', 'keys', 'ark_std_key.txt');

  function apiKey() {
    const direct = String(opts.apiKey || process.env.ARK_API_KEY || process.env.ARK_STD_KEY || process.env.ARK_KEY || '').trim();
    if (direct) return direct;
    try {
      const t = fs.readFileSync(keyFile, 'utf8').trim();
      return t && !t.startsWith('#') ? t : '';
    } catch { return ''; }
  }

  let probeCache = { at: 0, result: null };
  const PROBE_TTL = 30000;

  async function raw(pathname, { method = 'GET', body = null } = {}) {
    const key = apiKey();
    if (!key) throw new SeedreamError('SR_NO_API_KEY', '未找到 ARK_API_KEY', { keyFile });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(base + pathname, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new SeedreamError('SR_TIMEOUT', `请求超时（${Math.round(timeoutMs / 1000)}s）`, { pathname });
      throw new SeedreamError('SR_UNREACHABLE', e.message || '网络错误', { pathname });
    }
    clearTimeout(timer);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    if (!res.ok) {
      const msg = (data && (data.message || (data.error && data.error.message))) || `HTTP ${res.status}`;
      const code = res.status === 401 || res.status === 403 ? 'SR_INVALID_API_KEY' : 'SR_HTTP_ERROR';
      throw new SeedreamError(code, msg, { status: res.status, code: data && (data.code || (data.error && data.error.code)) || null, request_id: data && data.request_id || null });
    }
    return data;
  }

  async function probe({ force = false } = {}) {
    const now = Date.now();
    if (!force && probeCache.result && now - probeCache.at < PROBE_TTL) return probeCache.result;
    let result;
    if (!apiKey()) {
      result = { reachable: false, mode: 'real', detail: { code: 'SR_NO_API_KEY', message: '未找到 ARK_API_KEY', hint: HINTS.SR_NO_API_KEY, keyFile } };
    } else {
      try {
        await raw('/models');
        result = { reachable: true, mode: 'real', detail: { base, auth: 'ok' } };
      } catch (e) {
        const d = e.toJSON ? e.toJSON() : { code: e.code, message: e.message };
        result = { reachable: false, mode: 'real', detail: d };
      }
    }
    probeCache = { at: now, result };
    return result;
  }

  /**
   * 编译一条可直接提交的 payload。纯函数式，dry-run / selftest / CLI 共用同一份逻辑
   * （prompt 只在 compilePayload 里拼，避免 CLI 与 provider 各拼一份、跑起来不一样）。
   */
  function compilePayload(job) {
    const caps = loadCaps();
    const ability = abilityOf(job.ability || job.style || caps.abilities[0].id);
    const model = String(job.model || process.env.AVP_SR_MODEL || DEFAULT_MODEL);
    if (!Object.values(caps.target.models).includes(model)) {
      // 不阻断：方舟允许新模型 id，但必须如实记录「不在能力表」。
    }
    const compose = require('../../prompt/compose.js');
    const stage = job.stage || job.imageStage || 'keyframe';
    const values = { ...(job.valueSnapshot || job.values || {}) };

    // 能力前置条件：默认整句里的冲突词先改掉（如 douyin 的『鹅蛋脸』→『瓜子脸』）。
    // 必须在 compile 之后作用在 structured 上：CLI/无 values 调用时，默认主体整句是编译期补进来的，
    // 提前改 values 改不到它（这就是「overrides 管不到字面文本」的坑）。
    const appliedPreconditions = [];
    const pre = ability.preconditions || {};
    let composed;
    try {
      composed = compose.compile(values, { stage, style: ability.id });
    } catch (e) {
      throw new SeedreamError('SR_EMPTY_PROMPT', `提示词编译失败：${e.message}`, {});
    }
    for (const s of (pre.substitutions || [])) {
      if (!s || !s.find) continue;
      let hit = 0;
      for (const slot of Object.keys(composed.structured.slots || {})) {
        for (const it of composed.structured.slots[slot]) {
          if (typeof it.zh === 'string' && it.zh.includes(s.find)) {
            it.zh = it.zh.split(s.find).join(s.replace);
            hit += 1;
          }
        }
      }
      if (hit) appliedPreconditions.push({ key: s.key, find: s.find, replace: s.replace, hits: hit });
    }

    // 预算裁剪：官方建议 ≤300 中文字（含软负面），超了按槽位权重删条目并重渲染（不截字符串）。
    // 软负面先算出来占预算，否则正向段压到 300 再加 30 字负面照样超。
    const recipe0 = ability.seedream_recipe || {};
    const softNegative = String(job.softNegative || recipe0.soft_negative || '').trim();
    const hardLimit = (caps.prompt_policy || {}).zh_char_limit || 300;
    const budget = Math.max(160, hardLimit - (softNegative ? zhChars(softNegative) + 2 : 0));
    const compacted = compactStructured(composed.structured, budget);
    let positive = String(
      compacted.structured ? compose.renderZh(compacted.structured) : (composed.positive_zh || composed.positive || ''),
    ).trim();
    if (job.note && String(job.note).trim()) {
      positive = `${positive.replace(/[。.]$/, '')}。${String(job.note).trim()}`;
    }
    if (!positive) throw new SeedreamError('SR_EMPTY_PROMPT', '提示词为空：至少给主体', {});

    const recipe = recipe0;
    const tier = job.tier || job.imageTier || recipe.tier || '1.5K';
    const ratio = job.ratio || job.imageRatio || recipe.ratio || '9:16';
    const { size, pixels } = resolveSize({ tier, ratio, size: job.size || job.imageSize || null });

    // 5.0 不支持 negative_prompt → 软化并入 prompt 尾部（固定最后一句，权重最低）。
    const prompt = softNegative ? `${positive.replace(/[。.]$/, '')}。${softNegative}` : positive;
    const zhLen = zhChars(prompt);
    const warnings = [];
    if (zhLen > (caps.prompt_policy.zh_char_soft_limit || 180)) {
      warnings.push({ code: 'SR_PROMPT_LONG', text: `中文 ${zhLen} 字超过建议上限 ${caps.prompt_policy.zh_char_soft_limit}：后半段注意力衰减，建议砍氛围词` });
    }
    if (compacted.removed.length) {
      warnings.push({ code: 'SR_PROMPT_COMPACTED', text: `超出 ${compacted.before}→${compacted.after} 预算已裁 ${compacted.removed.length} 条（明细见 compaction.removed）` });
    }
    if (composed.warnings && composed.warnings.length) warnings.push(...composed.warnings);

    const payload = {
      model,
      prompt,
      size,
      response_format: 'url',
      output_format: 'png',
      watermark: false,
      optimize_prompt_options: { mode: (job.optimize || recipe.optimize_prompt_options && recipe.optimize_prompt_options.mode) || 'standard' },
    };
    return {
      ability: ability.id,
      ability_name: ability.name,
      model,
      stage,
      tier,
      ratio,
      size,
      pixels,
      cost_cny_est: estimateCost(pixels, Array.isArray(job.refs) ? job.refs.length : 0),
      prompt,
      positive,
      soft_negative: softNegative || null,
      payload,
      warnings,
      prompt_zh_chars: zhLen,
      prompt_zh_limit: hardLimit,
      prompt_budget_positive: budget,
      applied_preconditions: appliedPreconditions,
      compaction: { before: compacted.before, after: compacted.after, removed: compacted.removed },
      negative_field_supported: false,
      structured: compacted.structured || composed.structured || null,
      notes: composed.notes || [],
    };
  }

  async function download(url, job, meta) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.join(OUTPUT_DIR, day);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `sr_${meta.ability}_${stamp}.png`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      const ledger = {
        provider: 'seedream', model: meta.model, ability: meta.ability, size: meta.size, tier: meta.tier,
        prompt: meta.prompt, cost_cny_est: meta.cost_cny_est, at: new Date().toISOString(),
        file, bytes: buf.length, source_url: url, job_id: job && job.id || null,
      };
      fs.writeFileSync(file.replace(/\.png$/, '.ledger.json'), JSON.stringify(ledger, null, 2) + '\n', 'utf8');
      return { file, bytes: buf.length };
    } finally { clearTimeout(timer); }
  }

  return {
    id: 'seedream',
    mode: 'real',
    supports: ['image'],
    base,
    probe,
    compilePayload,
    resolveSize,
    estimateCost,
    async run(job, { signal, onProgress = () => {}, onSubmitted = () => {} } = {}) {
      if (job.kind && job.kind !== 'image') {
        throw new SeedreamError('SR_KIND_UNSUPPORTED', `seedream 只出图，不支持 kind=${job.kind}`, { kind: job.kind });
      }
      const compiled = compilePayload(job);
      const meta0 = {
        seedream: {
          ability: compiled.ability, ability_name: compiled.ability_name, model: compiled.model,
          stage: compiled.stage, tier: compiled.tier, ratio: compiled.ratio, size: compiled.size,
          pixels: compiled.pixels, cost_cny_est: compiled.cost_cny_est,
          prompt: compiled.prompt, positive: compiled.positive, soft_negative: compiled.soft_negative,
          payload: compiled.payload, negative_field_supported: false,
          prompt_zh_chars: compiled.prompt_zh_chars, prompt_zh_limit: compiled.prompt_zh_limit,
          applied_preconditions: compiled.applied_preconditions, compaction: compiled.compaction,
          warnings: compiled.warnings,
        },
      };

      // dry-run：只回 payload，不请求、不计费。无 key 的机器也能验收协议与提示词。
      if (job.dryRun || String(process.env.AVP_SR_DRYRUN || '') === '1') {
        return { taskId: null, images: [], output: null, meta: { ...meta0, seedream: { ...meta0.seedream, dry_run: true } } };
      }

      onProgress({ percent: null, stage: 'queued', text: '提交 Seedream' });
      const alive = await probe({ force: true });
      if (!alive.reachable) {
        const d = alive.detail || {};
        throw new SeedreamError(d.code || 'SR_UNREACHABLE', d.message || 'Seedream 不可用', { ...d, ability: compiled.ability });
      }
      if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { code: 'JOB_CANCELED' });

      onProgress({ percent: null, stage: 'generating', text: `${compiled.ability_name} · ${compiled.size}` });
      const data = await raw('/images/generations', { method: 'POST', body: compiled.payload });
      const item = data && Array.isArray(data.data) ? data.data[0] : null;
      if (!item || (!item.url && !item.b64_json)) {
        throw new SeedreamError('SR_NO_URL', '响应里没有 url / b64_json', { response: data });
      }
      onSubmitted({ taskId: data.request_id || data.id || null, meta: meta0 });

      onProgress({ percent: null, stage: 'downloading', text: '落盘' });
      let file = null, bytes = null, url = item.url || null;
      if (item.b64_json) {
        const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const dir = path.join(OUTPUT_DIR, day);
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, `sr_${compiled.ability}_${Date.now()}.png`);
        bytes = Buffer.from(item.b64_json, 'base64');
        fs.writeFileSync(file, bytes);
        bytes = bytes.length;
      } else {
        try { const dl = await download(url, job, { ...compiled }); file = dl.file; bytes = dl.bytes; }
        catch (e) { throw new SeedreamError('SR_DOWNLOAD_FAILED', e.message, { url, ability: compiled.ability }); }
      }

      return {
        taskId: data.request_id || data.id || null,
        images: [{
          provider: 'seedream', ability: compiled.ability, file, bytes, url,
          size: item.size || compiled.size, model: compiled.model, tier: compiled.tier,
          cost_cny_est: compiled.cost_cny_est, mock: false,
        }],
        output: { file, bytes, url, ability: compiled.ability },
        meta: meta0,
      };
    },
    async cancel() {
      // 同步接口：请求发出后无法撤回，取消只能停本地等待（远端仍可能计费）。如实返回。
      return { remote: false, reason: 'Seedream 出图为同步接口，提交后不可撤回；已计费请求不回滚' };
    },
  };
}

module.exports = { createSeedreamProvider, SeedreamError, HINTS, SIZE_MAP, resolveSize, validateSize, estimateCost, DEFAULT_BASE, DEFAULT_MODEL, OUTPUT_DIR };
