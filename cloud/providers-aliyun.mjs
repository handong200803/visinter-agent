/**
 * cloud/providers-aliyun.mjs —— 阿里云百炼（DashScope / 通义万相 + 千问）
 *
 * 复用同一套 provider 契约：submitTask / pollTask / fetchResult
 *
 * 契约要点（2026-11 官方文档）：
 *   · 所有视频/图像生成都是**异步任务**，必须带请求头 X-DashScope-Async: enable
 *   · 创建：POST /api/v1/services/aigc/{video-generation/video-synthesis | text2image/image-synthesis}
 *   · 轮询：GET  /api/v1/tasks/{task_id}
 *   · 状态：PENDING / RUNNING / SUCCEEDED / FAILED / CANCELED / UNKNOWN
 *   · 结果：视频 output.video_url；图像 output.results[].url（24 小时有效）
 *
 * 定价（官方刊例）：万相 480P ¥0.14/秒，1080P ¥0.7/秒 —— 比 Seedance 便宜。
 */
import { fail } from './core.mjs';

const KEY = () => String(process.env.DASHSCOPE_API_KEY || '').trim();
const BASE = () => String(process.env.DASHSCOPE_API || 'https://dashscope.aliyuncs.com').replace(/\/$/, '');
const STATUS_MAP = { PENDING: 'queued', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'cancelled', UNKNOWN: 'expired' };

async function dsJson(method, pathname, body, timeoutMs = 60000) {
  if (!KEY()) fail('PROVIDER_MISSING', '后端未配置 DASHSCOPE_API_KEY');
  let r;
  try {
    r = await fetch(BASE() + pathname, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY(), 'X-DashScope-Async': 'enable' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) { fail('UPSTREAM_TIMEOUT', '百炼请求失败：' + (e && e.message)); }
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) {
    const code = j?.code || '';
    const map = { InvalidApiKey: 'UPSTREAM_KEY_INVALID', AccessDenied: 'UPSTREAM_FORBIDDEN', Throttling: 'RATE_LIMIT', DataInspectionFailed: 'UPSTREAM_BAD_PARAM' };
    fail(map[code] || (r.status === 401 ? 'UPSTREAM_KEY_INVALID' : r.status === 403 ? 'UPSTREAM_FORBIDDEN' : r.status === 429 ? 'RATE_LIMIT' : 'UPSTREAM_FAILED'),
      `百炼 ${r.status} ${code}：${(j?.message || text).slice(0, 200)}`, { status: r.status, code });
  }
  return j || {};
}

/* ── 万相 文生视频 / 图生视频 ─────────────────────── */
// 默认用 2.6（1080p / 15s / 音画同步，官方当前主力）；追最新可设 wan2.7-t2v，求稳求便宜可设 wan2.2-t2v-plus
const WX_MODEL = () => String(process.env.WANX_VIDEO_MODEL || 'wan2.6-t2v');
const WX_I2V_MODEL = () => String(process.env.WANX_I2V_MODEL || 'wan2.6-i2v');

export const videoWanx = {
  id: 'wanx',
  kind: 'video',
  label: '通义万相 Wanx',
  ready() { return !!KEY(); },
  models: () => [
    WX_MODEL(), WX_I2V_MODEL(),
    'wan2.7-t2v', 'wan2.7-i2v',            // 最新一代
    'wan2.6-t2v', 'wan2.6-i2v', 'wan2.6-i2v-flash',
    'wan2.5-t2v-preview',
    'wan2.2-t2v-plus', 'wan2.2-i2v-plus',  // 最稳最便宜
  ],
  resolutions: ['480p', '720p', '1080p'],   // 2.6 系只支持 720p/1080p；480p 请用 2.2
  ratios: ['16:9', '9:16', '1:1'],

  async submitTask(ctx, req) {
    const i2v = !!req.first_frame;
    const body = {
      model: req.model || (i2v ? WX_I2V_MODEL() : WX_MODEL()),
      input: { prompt: String(req.prompt || '') },
      parameters: {
        size: wanxSize(req.resolution || '720p', req.ratio || '16:9'),
        duration: Number(req.duration || 5),
        prompt_extend: true,
        watermark: !!req.watermark,
      },
    };
    if (i2v) body.input.img_url = String(req.first_frame);
    if (req.seed != null && req.seed !== '') body.parameters.seed = Number(req.seed);
    const j = await dsJson('POST', '/api/v1/services/aigc/video-generation/video-synthesis', body, 90000);
    const tid = j?.output?.task_id;
    if (!tid) fail('UPSTREAM_FAILED', '万相未返回 task_id', j?.output || j);
    return { upstreamId: tid, raw: { task_id: tid } };
  },

  async pollTask(ctx, upstreamId) {
    const j = await dsJson('GET', '/api/v1/tasks/' + encodeURIComponent(upstreamId), null, 30000);
    const st = j?.output?.task_status || 'PENDING';
    return { status: STATUS_MAP[st] || 'running', raw: j?.output || {} };
  },

  async fetchResult(ctx, upstreamId, last) {
    const o = last?.raw || (await dsJson('GET', '/api/v1/tasks/' + encodeURIComponent(upstreamId))).output || {};
    const url = o.video_url || (o.results && o.results[0] && (o.results[0].video_url || o.results[0].url)) || null;
    if (!url) fail('UPSTREAM_FAILED', '万相任务成功但无视频地址', o);
    return { url, meta: { duration: o.video_duration || o.duration || null, usage: o.usage || null } };
  },
};

/* ── 万相 文生图 ──────────────────────────────────── */
const WX_IMG = () => String(process.env.WANX_IMAGE_MODEL || 'wan2.2-t2i-flash');
export const imageWanx = {
  id: 'wanx-image',
  kind: 'image',
  label: '通义万相 文生图',
  ready() { return !!KEY(); },
  models: () => [WX_IMG(), 'wan2.5-t2i-preview', 'wanx2.1-t2i-turbo'],
  async submitTask(ctx, req) {
    const body = {
      model: req.model || WX_IMG(),
      input: { prompt: String(req.prompt || '') },
      parameters: { size: req.size || '1280*720', n: 1, prompt_extend: true, watermark: false },
    };
    if (req.seed != null && req.seed !== '') body.parameters.seed = Number(req.seed);
    const j = await dsJson('POST', '/api/v1/services/aigc/text2image/image-synthesis', body, 60000);
    if (!j?.output?.task_id) fail('UPSTREAM_FAILED', '万相生图未返回 task_id', j?.output || j);
    return { upstreamId: j.output.task_id, raw: { task_id: j.output.task_id } };
  },
  async pollTask(ctx, id) {
    const j = await dsJson('GET', '/api/v1/tasks/' + encodeURIComponent(id), null, 30000);
    return { status: STATUS_MAP[j?.output?.task_status || 'PENDING'] || 'running', raw: j?.output || {} };
  },
  async fetchResult(ctx, id, last) {
    const o = last?.raw || {};
    const url = (o.results && o.results[0] && o.results[0].url) || null;
    if (!url) fail('UPSTREAM_FAILED', '万相生图成功但无图片地址', o);
    return { url, meta: {} };
  },
};

/** 文生图尺寸：默认给 16:9 的 1280*720；i2v 时前端应按目标视频分辨率传 size 保证比例一致 */
export function wanxImageSize(resolution, ratio) { return wanxSize(resolution, ratio); }

/** 分辨率 → 万相 size 字符串（宽*高，需 16 的倍数） */
export function wanxSize(resolution, ratio) {
  const base = String(resolution).toLowerCase();
  const table = {
    '480p': { '16:9': '832*480', '9:16': '480*832', '1:1': '624*624' },
    '720p': { '16:9': '1280*720', '9:16': '720*1280', '1:1': '960*960' },
    '1080p': { '16:9': '1920*1080', '9:16': '1080*1920', '1:1': '1440*1440' },
  };
  return (table[base] && table[base][ratio]) || '1280*720';
}
