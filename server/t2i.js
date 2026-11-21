/**
 * server/t2i.js -- 文生图（关键帧候选）
 *
 * 为什么要它：用户要「文生图 → 抓最优关键帧 → 图生视频」这条链路。
 * 纯文生视频在本机 8G 上必然崩（模型要同时想象主体+构图+运动），
 * 先用轻量图像模型出一批候选帧，再挑最好的那张去做 I2V，质量差一个档。
 *
 * 依赖：ComfyUI + 一个 checkpoint（tools/setup_t2i_model.sh 下 SD1.5 fp16 ≈2.1GB）。
 * 节点：CheckpointLoaderSimple → CLIPTextEncode×2 → EmptyLatentImage → KSampler → VAEDecode → SaveImage
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const DEFAULT_CKPT = process.env.AVP_T2I_CKPT || 'v1-5-pruned-emaonly-fp16.safetensors';

function build(o = {}) {
  const prompt = String(o.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('文生图需要非空提示词'), { code: 'T2I_NO_PROMPT', status: 422 });
  const negative = String(o.negative || 'blurry, low quality, watermark, text, deformed, extra limbs, duplicate, collage, multiple heads');
  const width = Math.max(256, Math.round(Number(o.width || 640) / 8) * 8);
  const height = Math.max(256, Math.round(Number(o.height || 384) / 8) * 8);
  const steps = Math.max(12, Math.min(40, Number(o.steps || 24)));
  const cfg = Math.max(4, Math.min(12, Number(o.cfg || 7)));
  const seed = Number.isFinite(Number(o.seed)) && Number(o.seed) >= 0 ? Math.floor(Number(o.seed)) : Math.floor(Math.random() * 2147483646);
  const prefix = String(o.prefix || 'avp_keyframe');
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.ckpt || DEFAULT_CKPT } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], seed, steps, cfg, sampler_name: 'dpmpp_2m', scheduler: 'karras', positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], denoise: 1.0 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: prefix } },
  };
}

async function submit(workflow, clientId = 'avp-t2i') {
  const r = await fetch(BASE + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.prompt_id) throw Object.assign(new Error('T2I 提交失败：' + JSON.stringify(j).slice(0, 300)), { code: 'T2I_SUBMIT_FAILED', status: 502, detail: { status: r.status } });
  return j.prompt_id;
}

async function wait(promptId, { limitMs = 10 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > limitMs) throw Object.assign(new Error('T2I 超时'), { code: 'T2I_TIMEOUT' });
    const h = await (await fetch(`${BASE}/history/${promptId}`)).json().catch(() => ({}));
    const item = h[promptId];
    if (item) {
      const st = item.status || {};
      const images = [];
      for (const out of Object.values(item.outputs || {})) for (const im of out.images || []) images.push(im);
      return { state: st.status_str || 'unknown', images, status: st };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** 出 N 张候选（不同 seed），返回本地绝对路径列表。 */
async function generateCandidates(o = {}) {
  const n = Math.max(1, Math.min(8, Number(o.count || 4)));
  const outDir = o.outDir || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '04-数据', 'keyframes');
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  const baseSeed = Number.isFinite(Number(o.seed)) && Number(o.seed) >= 0 ? Math.floor(Number(o.seed)) : Math.floor(Math.random() * 1000000);
  for (let i = 0; i < n; i += 1) {
    const wf = build({ ...o, seed: baseSeed + i * 7919, prefix: 'avp_kf' });
    const pid = await submit(wf);
    const done = await wait(pid);
    if (done.state !== 'success') { results.push({ ok: false, index: i, state: done.state, error: 'T2I_FAILED' }); continue; }
    const im = done.images[0];
    if (!im) { results.push({ ok: false, index: i, error: 'NO_IMAGE' }); continue; }
    const src = path.join(process.env.COMFY_OUTPUT_DIR || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '01-代码', 'AI视频', 'ComfyUI', 'output'), im.subfolder || '', im.filename);
    const dst = path.join(outDir, `kf_${Date.now()}_${i}${path.extname(im.filename) || '.png'}`);
    fs.copyFileSync(src, dst);
    results.push({ ok: true, index: i, file: dst, seed: baseSeed + i * 7919, prompt_id: pid });
  }
  return { prompt: o.prompt, count: n, outDir, candidates: results };
}

module.exports = { build, submit, wait, generateCandidates, BASE, DEFAULT_CKPT };
