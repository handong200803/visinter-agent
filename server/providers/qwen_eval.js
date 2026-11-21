/**
 * providers/qwen_eval.js —— Qwen（通义千问）在平台里的两处真用
 *
 * 为什么写这个文件：赛事评审会问「你们用 Qwen 做了什么」。这里的答案是两件具体的事：
 *   1) Qwen-VL 对成片帧做**语义打分**（人脸稳定/时序一致/风格匹配/崩坏），替掉规则代理；
 *   2) Qwen 把一句人话**结构化**成提示词字段（主体/场景/镜头/光线/风格/负面），
 *      交给 prompt 编译层与画布注入。
 *
 * 诚实降级（硬规则）：
 *   - 没有 DASHSCOPE_API_KEY → 抛 QWEN_NO_KEY，绝不返回编造的分数；
 *   - 网络/接口失败 → 抛 QWEN_HTTP_*，调用方回退 rule-proxy，并在 provenance 里如实标注；
 *   - 所有返回值都带 `backend: 'qwen-vl-max' | 'qwen-plus'` 与 `model`，便于写进实验记录。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const VL_MODEL = process.env.QWEN_VL_MODEL || 'qwen-vl-max';
const TEXT_MODEL = process.env.QWEN_TEXT_MODEL || 'qwen-plus';

function key() {
  return process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || '';
}

function available() {
  const k = key();
  if (!k) return { ok: false, code: 'QWEN_NO_KEY', reason: '未设置 DASHSCOPE_API_KEY / QWEN_API_KEY，Qwen 评分与结构化不可用（不会编造分数）' };
  return { ok: true, base: BASE, vl: VL_MODEL, text: TEXT_MODEL };
}

function err(code, message, detail = {}) {
  const e = new Error(message);
  e.code = code;
  e.detail = detail;
  return e;
}

async function chat(payload, timeoutMs = 120000) {
  const a = available();
  if (!a.ok) throw err(a.code, a.reason, { hint: 'set DASHSCOPE_API_KEY=sk-xxx 后重启服务' });
  const body = { model: payload.model, messages: payload.messages, temperature: payload.temperature == null ? 0.2 : payload.temperature };
  if (payload.response_format) body.response_format = payload.response_format;
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw err('QWEN_HTTP_' + r.status, `Qwen 接口返回 ${r.status}`, { body: String(text).slice(0, 400) });
  let j;
  try { j = JSON.parse(text); } catch { throw err('QWEN_BAD_JSON', 'Qwen 返回不是 JSON', { body: String(text).slice(0, 200) }); }
  const content = (((j.choices || [])[0] || {}).message || {}).content;
  const flat = Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c.text || '')).join('') : String(content || '');
  return { raw: j, text: flat, usage: j.usage || null, model: body.model };
}

function dataUrl(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,` + fs.readFileSync(file).toString('base64');
}

/** 从模型输出里抠出第一个 JSON 对象（容忍 ```json 包裹与前后废话）。 */
function pickJson(text) {
  const s = String(text || '').replace(/^[\s\S]*?```(?:json)?/i, (m) => m).replace(/```$/m, '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const SCORE_PROMPT = `你是视频质量评审。给你 3 帧（首/中/末）和原始提示词，输出严格 JSON（不要解释）：
{"face_stability":0-1,"temporal_consistency":0-1,"style_match":0-1,"detail_richness":0-1,"artifact_penalty":0-1,"reason":"一句话中文"}
评分口径：
- face_stability：人脸结构是否稳定、有无糊脸/换脸/多手多指
- temporal_consistency：三帧之间主体、光照、构图是否连贯（无跳变、无闪烁）
- style_match：是否命中提示词里的主体/场景/光线/风格
- detail_richness：纹理、边缘、景深是否丰富（不是锐化假细节）
- artifact_penalty：0=无崩坏，1=严重崩坏（噪点、扭曲、文字乱码、结构错乱）
若画面是纯噪声/纯色/无法辨认内容，artifact_penalty 必须 ≥0.9 且 face_stability ≤0.1。`;

/**
 * Qwen-VL 评一条成片（抽 3 帧）。
 * @param {{file:string, frames?:string[], prompt?:string}} o
 */
async function scoreVideo(o = {}) {
  const frames = (o.frames || []).filter((f) => f && fs.existsSync(f));
  if (!frames.length) throw err('QWEN_NO_FRAMES', '没有可评分的帧图片');
  const parts = [{ type: 'text', text: `${SCORE_PROMPT}\n\n原始提示词：${String(o.prompt || '(未提供)')}` }];
  for (const f of frames.slice(0, 3)) parts.push({ type: 'image_url', image_url: { url: dataUrl(f) } });
  const r = await chat({ model: VL_MODEL, messages: [{ role: 'user', content: parts }], temperature: 0.1 });
  const j = pickJson(r.text);
  if (!j) throw err('QWEN_BAD_SCORE', 'Qwen-VL 未返回可解析的 JSON', { text: String(r.text).slice(0, 300) });
  const num = (v) => Math.max(0, Math.min(1, Number(v)));
  const out = {
    backend: r.model,
    usage: r.usage,
    scores: {
      Sface: +num(j.face_stability).toFixed(4),
      Sflow: +num(j.temporal_consistency).toFixed(4),
      Sstyle: +num(j.style_match).toFixed(4),
      Sbad: +num(j.artifact_penalty).toFixed(4),
    },
    detail_richness: +num(j.detail_richness).toFixed(4),
    reason: String(j.reason || '').slice(0, 200),
    provenance: 'measured(qwen-vl)',
  };
  out.F = +(0.35 * out.scores.Sface + 0.35 * out.scores.Sflow + 0.2 * out.scores.Sstyle - 0.1 * out.scores.Sbad).toFixed(4);
  return out;
}

const STRUCT_PROMPT = `把用户的一句话需求结构化成短视频提示词字段，输出严格 JSON（不要解释）：
{"subject":"主体与外形","scene":"场景与环境","shot":"镜头语言（景别/运镜/焦段）","light":"光线与时间","style":"风格与质感","motion":"动作与节奏","negative":"需要避免的崩坏要素"}
要求：中文；每项一句话；不要编造用户没提的关键事实，未提及就写“未指定”。`;

/** Qwen 把一句话结构化成提示词字段。 */
async function structurePrompt(sentence) {
  const s = String(sentence || '').trim();
  if (!s) throw err('QWEN_NO_PROMPT', '缺少一句话描述');
  const r = await chat({ model: TEXT_MODEL, messages: [{ role: 'user', content: `${STRUCT_PROMPT}\n\n需求：${s}` }], temperature: 0.3 });
  const j = pickJson(r.text);
  if (!j) throw err('QWEN_BAD_STRUCT', 'Qwen 未返回可解析的结构化 JSON', { text: String(r.text).slice(0, 300) });
  const pick = (k) => String(j[k] || '未指定').slice(0, 200);
  return {
    backend: r.model, usage: r.usage,
    fields: { subject: pick('subject'), scene: pick('scene'), shot: pick('shot'), light: pick('light'), style: pick('style'), motion: pick('motion'), negative: pick('negative') },
    composed: `${pick('subject')}，${pick('scene')}，${pick('shot')}，${pick('light')}，${pick('style')}`,
    provenance: 'measured(qwen-text)',
  };
}

module.exports = { available, scoreVideo, structurePrompt, BASE, VL_MODEL, TEXT_MODEL };
