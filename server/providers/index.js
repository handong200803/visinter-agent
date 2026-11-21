/**
 * providers/index.js —— provider 工厂（任务卡①）
 *
 * 为什么要有这一层：原来 jobs.js 直接抱着 comfy 客户端，comfy 不可达就静默 mock，
 * 用户以为在出片其实在跑计时器。现在出片后端是显式选择的一条缝：
 *   AVP_PROVIDER=auto|mock|comfy|dashscope（默认 auto）
 *
 * auto 的选择顺序（v0.2 起）：
 *   1) 有 DASHSCOPE_API_KEY → dashscope（云端真出片，按量计费）
 *   2) 否则 → comfy（本地真出片；连不上时任务如实 failed，health 报 degraded）
 *   3) 显式 AVP_ALLOW_MOCK=1 才允许退到 mock 演示
 * 「静默降级」是不允许的：provider 永远是显式 id，mock 任务一律 job.mock=true。
 *
 * key 怎么来（不写进仓库）：
 *   - 进程环境变量 DASHSCOPE_API_KEY；
 *   - 或 AVP_ENV_FILE 指向一个 .env 文件（KEY=VALUE 行），启动时读入进程内存。
 *
 * provider 统一接口（jobs.js 只认这个形状，新增后端不改 jobs.js 一行）：
 *   { id, mode:'real'|'mock', probe(), run(job, hooks), cancel?(job) }
 */
'use strict';

const fs = require('node:fs');
const { createMockProvider } = require('./mock.js');
const { createComfyProvider } = require('./comfy.js');
const { createCineProvider } = require('./cine.js');
const { createSeedreamProvider } = require('./seedream.js');

const IDS = ['auto', 'mock', 'comfy', 'cine', 'seedream'];
const REAL_IDS = ['mock', 'comfy', 'cine', 'seedream'];
// 2026-11-18：dashscope（wan2.2/2.7 按量计费视频）按用户要求删除。传这个 id 会得到明确错误，不留半可用入口。
const RETIRED_IDS = ['dashscope', 'wan2.2', 'wan2.7'];

/**
 * 读 AVP_ENV_FILE：KEY=VALUE 行，忽略注释与空行。已存在的环境变量优先（不覆盖）。
 * 为什么放在 code 里而不是启动脚本：脚本会有多份（cmd / powershell / IDE），
 * 把「key 从哪来」收敛成一处，少一条漏配的路径。
 */
function loadEnvFile(file) {
  const f = file || process.env.AVP_ENV_FILE || process.env.AVP_KEY_FILE;
  if (!f) return { loaded: false, file: null, keys: [] };
  try {
    const text = fs.readFileSync(f, 'utf8');
    const keys = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!process.env[key]) { process.env[key] = val; keys.push(key); }
    }
    return { loaded: true, file: f, keys };
  } catch (e) {
    return { loaded: false, file: f, error: e.code || e.message, keys: [] };
  }
}

function resolveId(opts = {}) {
  const want = String(opts.id || process.env.AVP_PROVIDER || 'auto').toLowerCase();
  if (RETIRED_IDS.includes(want)) {
    const e = new Error(`provider「${want}」已下线：付费视频模型（DashScope wan2.2 / wan2.7）已按用户要求删除，可选：${IDS.join(' / ')}`);
    e.code = 'PROVIDER_RETIRED';
    throw e;
  }
  if (!IDS.includes(want)) {
    const e = new Error(`未知 provider「${want}」，可选：${IDS.join(' / ')}`);
    e.code = 'BAD_PROVIDER';
    throw e;
  }
  if (want !== 'auto') return want;
  if (String(process.env.AVP_ALLOW_MOCK || '') === '1') return 'mock';
  return 'comfy';
}

function createProvider(opts = {}) {
  const env = loadEnvFile(opts.envFile);
  let id;
  try {
    id = resolveId(opts);
  } catch (e) {
    // 环境变量里残留 AVP_PROVIDER=dashscope 不该让整个服务起不来：
    // 显式传 id（代码/测试）必须报错；仅来自环境的旧配置降级到本地 comfy 并打警告。
    if (e.code === 'PROVIDER_RETIRED' && opts.id == null) {
      id = 'comfy';
      console.warn(`[providers] AVP_PROVIDER=${process.env.AVP_PROVIDER} 已下线（付费视频模型删除），本次降级到 comfy`);
    } else throw e;
  }
  const p = id === 'mock' ? createMockProvider(opts)
    : id === 'comfy' ? createComfyProvider(opts)
      : id === 'cine' ? createCineProvider(opts)
        : createSeedreamProvider(opts);
  // 把"key 从哪个文件读进来的"带到 provider 上，/api/health 才能说清配置来源。
  p.envSource = env;
  p.requested = String(opts.id || process.env.AVP_PROVIDER || 'auto').toLowerCase();
  return p;
}

module.exports = { createProvider, loadEnvFile, resolveId, PROVIDER_IDS: IDS, REAL_IDS };