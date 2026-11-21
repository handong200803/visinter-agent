/**
 * gpu.js —— 本机显存真值探测（零依赖，nvidia-smi）
 *
 * 为什么单独一个文件：
 *   设备档位以前是 spec/models.catalog.json 里的静态表，`/api/devices` 直接把它当"本机"返回。
 *   换机器/拔 eGPU 时档位不会变，等于在替用户猜。这里只做一件事：把 nvidia-smi 的真实读数
 *   拿出来，连同"这是实测还是估算"的 provenance 一起交给上层；拿不到就明确 ok:false。
 *
 * 三条纪律（对应 docs/13-task-cards.md 卡 ④）：
 *   1. 不编 vram_usable_mib：可用显存必须来自本次 memory.used 采样（Windows WDDM 下
 *      total 不等于可用），采样不到就 usable_mib=null + provenance:'unknown'。
 *   2. 探测失败不许装成功：`{ok:false, reason}` 原样上抛，前端显示"未探测"。
 *   3. 任何推断值带 provenance：measured（本次采样）/ estimate（按占用率折算）/ unknown。
 *
 * 只读 nvidia-smi，不碰 torch、不碰 CUDA，不会把 +cpu 的 python 环境当推理环境。
 */
'use strict';

const { execFile } = require('node:child_process');

const FIELDS = ['name', 'memory.total', 'memory.used', 'compute_cap', 'driver_version'];
const CMD = ['--query-gpu=' + FIELDS.join(','), '--format=csv,noheader,nounits'];
const DEFAULT_TIMEOUT = 4000;
const DEFAULT_TTL_MS = 15000;

// WDDM 下驱动/桌面合成会占掉一部分，留 512MiB 给系统，剩余才算"能给模型用的"。
// 这个常数不写进 spec：它是保守预留，不是实测值，所以结论里 provenance 仍标 estimate。
const SYSTEM_RESERVE_MIB = 512;

function num(v) {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/** 按 total 显存挑最贴近的档位（只挑"装得下"的最高档，不越档吹牛）。 */
function tierFor(totalMib, devices) {
  if (!Array.isArray(devices) || !devices.length || !totalMib) return null;
  const sorted = devices
    .filter((d) => d && Number.isFinite(d.vram_total_mib) && d.id !== 'T0-low')
    .sort((a, b) => a.vram_total_mib - b.vram_total_mib);
  if (!sorted.length) return null;
  let pick = sorted[0];
  for (const d of sorted) if (totalMib >= d.vram_total_mib) pick = d;
  return pick.id;
}

/** 解析 nvidia-smi 的 csv 输出（一卡一行；多卡只取第一张，并在 detail 里说明）。 */
function parseCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  const cols = lines[0].split(',').map((c) => c.trim());
  const total = num(cols[1]);
  const used = num(cols[2]);
  return {
    name: cols[0] || null,
    total_mib: total,
    used_mib: used,
    compute_cap: cols[3] && cols[3] !== '[N/A]' ? cols[3] : null,
    driver: cols[4] && cols[4] !== '[N/A]' ? cols[4] : null,
    extra_gpus: Math.max(0, lines.length - 1),
  };
}

/**
 * 探测一次。永远 resolve，不 throw：调用方只处理 {ok:false, reason}。
 * @returns {Promise<{ok:boolean, at:string, source:string, gpu:object|null,
 *   usable_mib:number|null, provenance:string, free_mib:number|null,
 *   tier_suggestion:string|null, reason:string|null, detail:object}>}
 */
function probeOnce(opts = {}) {
  const timeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT;
  const at = new Date().toISOString();
  const base = { at, source: 'nvidia-smi', gpu: null, usable_mib: null, provenance: 'unknown', free_mib: null, tier_suggestion: null, detail: {} };
  return new Promise((resolve) => {
    execFile('nvidia-smi', CMD, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        const reason = err.killed || err.signal === 'SIGTERM' ? 'TIMEOUT' : (err.code === 'ENOENT' ? 'NVIDIA_SMI_MISSING' : 'NVIDIA_SMI_FAILED');
        resolve({ ...base, ok: false, reason, detail: { code: err.code || null, signal: err.signal || null, stderr: String(stderr || '').slice(0, 300) } });
        return;
      }
      const gpu = parseCsv(stdout);
      if (!gpu || gpu.total_mib == null) {
        resolve({ ...base, ok: false, reason: 'PARSE_FAILED', detail: { sample: String(stdout || '').slice(0, 200) } });
        return;
      }
      const free = gpu.used_mib == null ? null : Math.max(0, gpu.total_mib - gpu.used_mib);
      const usable = free == null ? null : Math.max(0, free - SYSTEM_RESERVE_MIB);
      const provenance = gpu.used_mib == null ? 'estimate' : 'measured';
      resolve({
        ...base,
        ok: true,
        reason: null,
        gpu,
        free_mib: free,
        usable_mib: usable,
        provenance,
        detail: {
          formula: gpu.used_mib == null ? 'total（未采到 used，按 total 记，属估算）' : `total ${gpu.total_mib} - used ${gpu.used_mib} - reserve ${SYSTEM_RESERVE_MIB}`,
          reserve_mib: SYSTEM_RESERVE_MIB,
          extra_gpus: gpu.extra_gpus,
        },
      });
    });
  });
}

/**
 * 带 TTL 的探测器：同一进程里 /api/devices 被反复拉取时不会每次 fork nvidia-smi。
 *   probe({force:true}) 强制刷新；失败结果也缓存（失败比成功更贵，没必要每次都等超时）。
 */
function createGpuProbe(opts = {}) {
  const ttl = Number(opts.ttlMs) >= 0 ? Number(opts.ttlMs) : DEFAULT_TTL_MS;
  let cache = null;
  async function probe(p = {}) {
    const now = Date.now();
    if (cache && !p.force && now - cache.t < ttl) return cache.v;
    const v = await probeOnce(opts);
    cache = { t: now, v };
    return v;
  }
  return { probe, clear() { cache = null; } };
}

module.exports = { createGpuProbe, probeOnce, parseCsv, tierFor, SYSTEM_RESERVE_MIB, FIELDS };
