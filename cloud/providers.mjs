/**
 * cloud/providers.mjs —— 云端统一 provider 层
 *
 * 统一接口（三者一致）：
 *   submitTask(ctx, req)  → { upstreamId, raw }
 *   pollTask(ctx, upstreamId) → { status, raw }        status ∈ queued|running|succeeded|failed|expired|cancelled
 *   fetchResult(ctx, upstreamId, last) → { url, meta }
 *
 * 已实现：
 *   video:seedance  火山方舟 Seedance（文生/首帧图生），POST /api/v3/contents/generations/tasks
 *   image:ark       火山方舟生图（Seedream），POST /api/v3/images/generations
 *   eval:qwen       通义千问 VL 语义打分（DashScope 兼容模式），无 Key 时降级到本地四维代理
 *
 * 纪律：任何 Key 只从 process.env 读，绝不出现在响应体/日志里。
 */
import { ApiError, fail } from './core.mjs';
import { videoWanx, imageWanx } from './providers-aliyun.mjs';

const now = () => new Date().toISOString();

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  let r;
  try {
    r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    fail('UPSTREAM_TIMEOUT', '上游请求失败：' + (e && e.message));
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) {
    const msg = (json && (json.error?.message || json.message)) || text.slice(0, 200);
    const map = { 401: 'UPSTREAM_KEY_INVALID', 403: 'UPSTREAM_FORBIDDEN', 400: 'UPSTREAM_BAD_PARAM', 404: 'UPSTREAM_BAD_PARAM', 429: 'RATE_LIMIT' };
    fail(map[r.status] || 'UPSTREAM_FAILED', `上游 ${r.status}：${msg}`, { status: r.status });
  }
  return json || {};
}

/* ── 视频：火山方舟 Seedance ──────────────────────── */
const ARK_BASE = () => String(process.env.ARK_BASE || 'https://ark.cn-beijing.volces.com').replace(/\/$/, '');
const ARK_KEY = () => String(process.env.ARK_API_KEY || '').trim();
const ARK_MODEL = () => String(process.env.ARK_VIDEO_MODEL || 'doubao-seedance-2-0-mini-260615');

export const videoSeedance = {
  id: 'seedance',
  kind: 'video',
  label: '火山方舟 Seedance',
  ready() { return !!ARK_KEY(); },
  models: () => [ARK_MODEL(), 'doubao-seedance-2.0-fast', 'doubao-seedance-2.0', 'doubao-seedance-2.5'],
  resolutions: ['480p', '720p', '1080p', '4k'],
  ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],

  async submitTask(ctx, req) {
    if (!this.ready()) fail('PROVIDER_MISSING', '后端未配置 ARK_API_KEY');
    const content = [];
    if (req.first_frame) content.push({ type: 'image_url', image_url: { url: req.first_frame }, role: 'first_frame' });
    content.push({ type: 'text', text: String(req.prompt || '') });
    const body = {
      model: req.model || ARK_MODEL(),
      content,
      resolution: req.resolution || '720p',
      ratio: req.ratio || '16:9',
      duration: Number(req.duration || 5),
      camera_fixed: !!req.camera_fixed,
      watermark: !!req.watermark,
      generate_audio: !!req.generate_audio,
    };
    if (req.seed != null && req.seed !== '') body.seed = Number(req.seed);
    const j = await httpJson(ARK_BASE() + '/api/v3/contents/generations/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ARK_KEY() },
      body,
    });
    if (!j.id) fail('UPSTREAM_FAILED', '上游未返回任务 id', j);
    return { upstreamId: j.id, raw: { id: j.id } };
  },

  async pollTask(ctx, upstreamId) {
    const j = await httpJson(ARK_BASE() + '/api/v3/contents/generations/tasks/' + encodeURIComponent(upstreamId), {
      headers: { Authorization: 'Bearer ' + ARK_KEY() },
      timeoutMs: 30000,
    });
    return { status: j.status || 'running', raw: j };
  },

  async fetchResult(ctx, upstreamId, last) {
    const j = last?.raw || (await httpJson(ARK_BASE() + '/api/v3/contents/generations/tasks/' + encodeURIComponent(upstreamId), {
      headers: { Authorization: 'Bearer ' + ARK_KEY() },
    }));
    const c = j.content || {};
    let url = (c.video_url && (c.video_url.url || c.video_url)) || j.video_url || null;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      const m = JSON.stringify(j).match(/https:\/\/[^\s"]+?\.(?:mp4|mov)[^\s"]*/);
      url = m ? m[0] : null;
    }
    if (!url) fail('UPSTREAM_FAILED', '任务成功但没有视频地址', j);
    return { url, meta: { tokens: j.usage?.completion_tokens || j.usage?.total_tokens || null, raw: { status: j.status } } };
  },
};

/* ── 生图：火山方舟 Seedream / 兼容 OpenAI images ──── */
const IMG_MODEL = () => String(process.env.ARK_IMAGE_MODEL || 'doubao-seedream-4-0-250828');
export const imageArk = {
  id: 'ark-image',
  kind: 'image',
  label: '火山方舟 Seedream',
  ready() { return !!ARK_KEY(); },
  models: () => [IMG_MODEL()],

  async submitTask(ctx, req) {
    if (!this.ready()) fail('PROVIDER_MISSING', '后端未配置 ARK_API_KEY');
    const body = {
      model: req.model || IMG_MODEL(),
      prompt: String(req.prompt || ''),
      size: req.size || '1280x720',
      response_format: 'url',
      watermark: false,
    };
    if (req.seed != null && req.seed !== '') body.seed = Number(req.seed);
    const j = await httpJson(ARK_BASE() + '/api/v3/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ARK_KEY() },
      body,
      timeoutMs: 120000,
    });
    const url = (j.data && j.data[0] && j.data[0].url) || null;
    if (!url) fail('UPSTREAM_FAILED', '生图未返回 url', j);
    // 生图是同步的：直接返回 succeeded 语义
    return { upstreamId: j.id || ('img_' + Date.now()), raw: { url }, done: true, url };
  },
  async pollTask() { return { status: 'succeeded', raw: {} }; },
  async fetchResult(ctx, id, last) { return { url: last?.raw?.url || last?.url, meta: {} }; },
};

/* ── 打分：Qwen-VL 语义（可选，缺 Key 走本地四维） ── */
const DASH_KEY = () => String(process.env.DASHSCOPE_API_KEY || '').trim();
const DASH_BASE = () => String(process.env.DASHSCOPE_BASE || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');

export const evalQwen = {
  id: 'qwen-vl',
  kind: 'eval',
  label: 'Qwen-VL 语义打分',
  ready() { return !!DASH_KEY(); },
  /**
   * 给一张图打「与提示词的语义贴合度」0–1。
   * 输出严格 JSON，模型不按格式返回时按 0.5 兜底（不假装成功）。
   */
  async scoreImage({ imageUrl, prompt, model }) {
    if (!this.ready()) return { ok: false, code: 'PROVIDER_MISSING', score: null };
    const sys = '你是严格的图像评审。只输出 JSON：{"score":0到1的小数,"why":"不超过30字"}。'
      + '评分标准：与提示词的主体/风格/构图贴合度，越高越贴合；明显不符给 0.1 以下。';
    const user = [{ type: 'text', text: '提示词：' + prompt }, { type: 'image_url', image_url: { url: imageUrl } }];
    const j = await httpJson(DASH_BASE() + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + DASH_KEY() },
      body: { model: model || process.env.QWEN_VL_MODEL || 'qwen-vl-max', temperature: 0, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }] },
      timeoutMs: 60000,
    });
    const text = j.choices?.[0]?.message?.content || '';
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, code: 'BAD_MODEL_OUTPUT', score: null, raw: String(text).slice(0, 200) };
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return { ok: false, code: 'BAD_MODEL_OUTPUT', score: null }; }
    const s = Number(parsed.score);
    if (!Number.isFinite(s)) return { ok: false, code: 'BAD_MODEL_OUTPUT', score: null };
    return { ok: true, score: Math.max(0, Math.min(1, s)), why: String(parsed.why || '').slice(0, 60), raw: parsed };
  },
};

/* ── 注册表 ───────────────────────────────────────── */
export const providers = {
  'video:seedance': videoSeedance,
  'video:wanx': videoWanx,
  'image:ark': imageArk,
  'image:wanx': imageWanx,
  'eval:qwen': evalQwen,
};

/** 选择顺序：AVP_VIDEO_PROVIDER / AVP_IMAGE_PROVIDER 显式指定，否则按优先级取第一个 ready 的 */
const VIDEO_ORDER = (process.env.AVP_VIDEO_PROVIDER || 'wanx,seedance').split(',').map((x) => x.trim()).filter(Boolean);
const IMAGE_ORDER = (process.env.AVP_IMAGE_PROVIDER || 'wanx,ark').split(',').map((x) => x.trim()).filter(Boolean);

export function provider(kind, id) {
  if (id) {
    const p = providers[`${kind}:${id}`];
    if (!p) fail('PROVIDER_MISSING', `未知 ${kind} provider：${id}`);
    if (!p.ready()) fail('PROVIDER_MISSING', `${p.label} 未配置 Key`);
    return p;
  }
  const order = kind === 'video' ? VIDEO_ORDER : kind === 'image' ? IMAGE_ORDER : Object.keys(providers).map((k) => k.split(':')[1]);
  for (const pid of order) {
    const p = providers[`${kind}:${pid}`];
    if (p && p.ready()) return p;
  }
  const labels = order.map((pid) => providers[`${kind}:${pid}`]?.label || pid).join(' / ');
  fail('PROVIDER_MISSING', `没有可用的 ${kind} provider（已配置顺序：${labels}）；请在后端 Secrets 填 DASHSCOPE_API_KEY 或 ARK_API_KEY`);
}

export function capability() {
  return {
    at: now(),
    providers: Object.values(providers).map((p) => ({ id: p.id, kind: p.kind, label: p.label, ready: p.ready(), models: p.models ? p.models() : [], resolutions: p.resolutions || [], ratios: p.ratios || [] })),
    storage: { backend: process.env.S3_BUCKET ? 's3' : 'local' },
    eval: { qwen: evalQwen.ready() },
  };
}
