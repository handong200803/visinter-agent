#!/usr/bin/env node
/**
 * tools/h3.mjs —— 本地 MiniMax H3 部署自检（ComfyUI 0.44 节点 + 量化权重）
 *
 * 只做一件事：回答「H3 现在能不能跑」。检查三层，缺哪层说哪层：
 *   1) ComfyUI 服务可达（/system_stats）
 *   2) H3 节点在位（/object_info 里的 EmptyMiniMaxH3LatentAV / MiniMaxH3ImageToVideo / …）
 *   3) 权重文件在位（ComfyUI/models/{diffusion_models,text_encoders,vae,loras}，按 engines.json 的真实文件名与大小）
 *
 * 用法：node tools/h3.mjs check [--json]
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const COMFY_DIR = process.env.COMFY_DIR || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '01-代码', 'AI视频', 'ComfyUI');
const BASE = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const ENG = require(path.join(ROOT, 'server', 'engines.js'));

const H3_NODES = ['EmptyMiniMaxH3LatentAV', 'MiniMaxH3ImageToVideo', 'MiniMaxH3ReferenceToVideo', 'MiniMaxH3SigmaShift', 'MiniMaxH3LatentUpscaleWithModel', 'UNETLoader', 'VAELoader', 'CLIPLoader'];

async function check() {
  const eng = ENG.get('minimax_h3');
  const out = { engine: eng.id, base: BASE, comfy_dir: COMFY_DIR, nodes: {}, weights: {}, status: 'fail', reason: '' };

  let stats = null;
  try {
    const r = await fetch(BASE + '/system_stats', { signal: AbortSignal.timeout(8000) });
    stats = await r.json();
    out.comfy = { reachable: true, version: stats.system && stats.system.comfyui_version, ram_total_gb: stats.system ? +(stats.system.ram_total / 1e9).toFixed(1) : null, devices: (stats.devices || []).map((d) => ({ name: d.name, vram_total_mib: d.vram_total, vram_free_mib: d.vram_free })) };
  } catch (e) {
    out.comfy = { reachable: false, error: e.message };
    out.reason = 'ComfyUI 不可达：先 bash tools/comfy_start.sh';
    return out;
  }

  try {
    const r = await fetch(BASE + '/object_info', { signal: AbortSignal.timeout(60000) });
    const info = await r.json();
    const keys = Object.keys(info);
    for (const n of H3_NODES) out.nodes[n] = keys.includes(n);
    out.node_count = keys.length;
  } catch (e) {
    out.reason = '拿不到 /object_info：' + e.message;
    return out;
  }

  const files = [
    ['diffusion_models', eng.weights.diffusion, 20.97],
    ['text_encoders', eng.text_encoder, 15.69],
    ['vae', eng.vae.video, 2.81],
    ['vae', eng.vae.audio, 0.61],
    ['loras', eng.weights.lora_turbo, 1.96],
  ];
  let totalGb = 0;
  for (const [folder, name, expectGb] of files) {
    const p = path.join(COMFY_DIR, 'models', folder, name);
    let size = 0;
    try { size = fs.statSync(p).size; } catch { /* 缺失 */ }
    // 统一用十进制 GB（1e9），与 HuggingFace API 的 size 口径一致；用 1024^3 会凭空差 7%，永远判"未完成"
    const gb = size / 1e9;
    totalGb += gb;
    out.weights[name] = { folder, gb: +gb.toFixed(2), expected_gb: expectGb, present: gb > 0.01, complete: gb >= expectGb * 0.98 };
  }
  out.total_gb = +totalGb.toFixed(1);

  const nodesOk = Object.values(out.nodes).every(Boolean);
  const weightsOk = Object.values(out.weights).every((w) => w.complete);
  if (nodesOk && weightsOk) { out.status = 'measured'; out.reason = '节点与权重齐备；可跑 5s（124 帧 @24fps）短片，实际速度取决于 16G 内存换入'; }
  else if (!weightsOk) { out.status = 'fail'; out.reason = '权重未下完：' + Object.entries(out.weights).filter(([, w]) => !w.complete).map(([n, w]) => `${n}(${w.gb}/${w.expected_gb}GB)`).join('；'); }
  else { out.status = 'fail'; out.reason = '节点缺失：' + Object.entries(out.nodes).filter(([, v]) => !v).map(([n]) => n).join('、'); }
  return out;
}

(async () => {
  const r = await check();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`H3 自检 · ${r.status.toUpperCase()} · ${r.reason}`);
  if (r.comfy && r.comfy.reachable) {
    console.log(`  ComfyUI ${r.comfy.version} · RAM ${r.comfy.ram_total_gb}GB · ${(r.comfy.devices || []).map((d) => `${d.name} ${Math.round(d.vram_free_mib / 1024)}/${Math.round(d.vram_total_mib / 1024)}GB`).join(' · ')}`);
  }
  console.log('  节点：' + Object.entries(r.nodes).map(([n, v]) => `${v ? '✓' : '✗'} ${n}`).join('  '));
  for (const [n, w] of Object.entries(r.weights)) console.log(`  权重：${w.complete ? '✓' : '✗'} ${n}  ${w.gb}/${w.expected_gb} GB`);
  console.log(`  合计 ${r.total_gb} GB`);
  process.exitCode = r.status === 'measured' ? 0 : 1;
})();
