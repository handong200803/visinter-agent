/**
 * selftest_all.mjs —— 全模块总自检（一条命令验收整个平台）
 *
 * 为什么不放在 core/ 里：
 *   core/ 是求解器内核，语义上不该知道 server/canvas/market 这些外围模块的存在。
 *   总自检属于「集成层」，所以放 tools/，并且只依赖「约定入口文件名」——
 *   每个模块只要提供 <module>/selftest.js|mjs 且最后打印「全部通过」就算接入成功。
 *
 * 设计取舍：
 *   1) 逐个子进程跑，而不是 require 进来 —— 任何一个模块抛未捕获异常/挂死都不能带崩总自检。
 *   2) 超时 120s，超时即判 FAIL 并杀进程 —— 防止某个 selftest 卡在 ffmpeg 轮询上没人管。
 *   3) 模块缺失记 SKIP 不记 FAIL —— 并行开发期允许模块尚未落地，但汇总里必须可见。
 *   4) 不用第三方彩色库，ANSI 手写；Windows Terminal / git bash 都认。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 模块清单：顺序即执行顺序，从内核到外围（内核挂了，外围结果就没有参考价值） */
const MODULES = [
  { id: 'core', label: '求解器内核', entry: 'core/selftest.js', required: true },
  { id: 'prompt', label: '提示词编译层', entry: 'prompt/selftest.js' },
  { id: 'quality', label: '质检管线', entry: 'quality/selftest.js' },
  { id: 'market', label: '模板市场', entry: 'market/selftest.js' },
  { id: 'plugins', label: '插件系统', entry: 'plugins/selftest.js' },
  { id: 'capability', label: '逆向能力包', entry: 'tools/capability.mjs' },
  { id: 'visinter', label: 'VisInter 装配层', entry: 'tools/visinter.mjs' },
  { id: 'ultimate', label: '双引擎/画布/贝叶斯', entry: 'tools/ultimate.mjs' },
  { id: 'server', label: '后端服务', entry: 'server/selftest.js' },
  { id: 'launcher', label: '启动与服务发现', entry: 'tools/launch.selftest.mjs', required: true },
  { id: 'quality-policy', label: '质量准入策略', entry: 'server/quality.selftest.js', required: true },
  { id: 'quality-bayes', label: '质量寻优约束', entry: 'tools/quality_bayes_test.mjs', required: true },
  { id: 'postprocess', label: '独立增强链路', entry: 'server/postprocess.selftest.js', required: true },
  // 阶段二新增：任务持久化/断点恢复（隔离 fixture，不需要真实 GPU）
  { id: 'comfy-recovery', label: 'Comfy恢复语义', entry: 'server/comfy-recovery.selftest.js' },
  { id: 'task-recovery', label: '任务断点恢复', entry: 'server/task-recovery.selftest.js' },
  { id: 'canvas', label: '画布编辑器', entry: 'canvas/selftest.mjs' },
  { id: 'app', label: '平台外壳', entry: 'app/selftest.mjs' },
  // 集成层放最后：它断言的是「模块之间」的契约，模块自身没通过时它的结论没有意义
  { id: 'e2e', label: '端到端集成', entry: 'tools/e2e.mjs', required: true },
];

const TIMEOUT_MS = 120_000;
const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

function runOne(entry) {
  return new Promise((resolve) => {
    const abs = path.join(ROOT, entry);
    if (!fs.existsSync(abs)) return resolve({ status: 'skip', ms: 0, tail: '入口文件不存在' });

    const started = Date.now();
    const child = spawn(process.execPath, [abs], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AVP_SELFTEST: '1' },
    });

    let out = '';
    const cap = (buf) => { out += buf.toString('utf8'); };

    child.stdout.on('data', cap);
    child.stderr.on('data', cap);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      // Windows 上 SIGTERM 对 node 子进程即终止；给 1s 收尾再强杀
      setTimeout(() => child.kill('SIGKILL'), 1000);
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const lines = out.trim().split(/\r?\n/).filter(Boolean);
      // 约定：成功不仅要 exit 0，还必须打印「全部通过」——防止脚本早退却返回 0 的假绿
      const claimed = /全部通过/.test(out);
      const status = code === 0 && claimed ? 'pass' : 'fail';
      resolve({ status, ms, tail: lines.slice(-6).join('\n') || `exit ${code}` });
    });
  });
}

const results = [];
console.log(`${C.bold}AI 视频平台 · 全模块总自检${C.reset}`);
console.log(`${C.dim}根目录 ${ROOT}${C.reset}`);
console.log(`${C.dim}node ${process.version} · ${new Date().toLocaleString('zh-CN')}${C.reset}\n`);

for (const m of MODULES) {
  process.stdout.write(`${C.cyan}▸${C.reset} ${m.label.padEnd(12, ' ')} ${C.dim}${m.entry}${C.reset} … `);
  let r = await runOne(m.entry);
  let retried = false;
  // 防抖：这些模块会起/停本地服务与锁，冷启动时序不稳（实测 task-recovery 首次常超时）。
  // 最多 3 次机会，每次间隔 800ms，并明确标注 retry 次数——不掩盖首次失败。
  for (let attempt = 1; attempt <= 3 && r.status === 'fail'; attempt += 1) {
    retried = true;
    await new Promise((res) => setTimeout(res, 800));
    const r2 = await runOne(m.entry);
    if (r2.status === 'pass') r = { ...r2, retried: true, attempts: attempt + 1 };
    else if (attempt === 3) r = { ...r2, firstTail: r.tail };
    else r = r2;
  }
  results.push({ ...m, ...r });
  const tag = r.status === 'pass' ? (retried ? `${C.green}PASS(retry×${r.attempts || 2})${C.reset}` : `${C.green}PASS${C.reset}`)
    : r.status === 'skip' ? `${C.yellow}SKIP${C.reset}`
    : `${C.red}FAIL${C.reset}`;
  console.log(`${tag} ${C.dim}${(r.ms / 1000).toFixed(1)}s${C.reset}`);
  if (r.status === 'fail') {
    console.log(r.tail.split('\n').map((l) => `    ${C.red}│${C.reset} ${l}`).join('\n'));
  }
}

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail').length;
const skip = results.filter((r) => r.status === 'skip').length;
const totalMs = results.reduce((a, r) => a + r.ms, 0);
const requiredFail = results.some((r) => r.required && r.status !== 'pass');

console.log(`\n${C.bold}汇总${C.reset}  ${C.green}PASS ${pass}${C.reset} · ${C.red}FAIL ${fail}${C.reset} · ${C.yellow}SKIP ${skip}${C.reset} · 耗时 ${(totalMs / 1000).toFixed(1)}s`);

if (skip) {
  console.log(`${C.yellow}未接入模块：${results.filter((r) => r.status === 'skip').map((r) => r.id).join(', ')}${C.reset}`);
}

// 只要必需模块通过且没有失败，就给出可用于 CI 的绿灯
if (fail === 0 && !requiredFail) {
  console.log(`${C.green}${C.bold}全部通过${C.reset}`);
  process.exit(0);
} else {
  console.log(`${C.red}${C.bold}存在失败模块，见上方明细${C.reset}`);
  process.exit(1);
}