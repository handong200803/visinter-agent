#!/usr/bin/env node
/**
 * snap_all.mjs —— 按模块跑一遍快照脚本
 *
 * 为什么快照要单独一步：
 *   入口 HTML 是「构建期内联」的，页面里不该出现临时读文件/读目录的逻辑（file:// 下也读不到）。
 *   每个模块的真实数据（模板清单、插件清单、质检结论、服务状态）都得先在 Node 侧落成 snapshot.json，
 *   构建器再把它整块注入。这一步就是「Node 侧落盘」的那半。
 *
 * 约定：模块自己提供 tools/snap_<mod>.mjs；不存在即跳过（模块还没做快照，不算失败）。
 * 跑法：node tools/snap_all.mjs [market plugins ...]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m' };
const MODULES = ['market', 'plugins', 'quality', 'server'];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = only.length ? only : MODULES;

let ok = 0, skipped = 0, failed = 0;
for (const id of list) {
  const script = path.join(ROOT, 'tools', `snap_${id}.mjs`);
  if (!fs.existsSync(script)) {
    console.log(`${C.yellow}—${C.reset} ${id.padEnd(8)} ${C.dim}跳过：还没有 tools/snap_${id}.mjs${C.reset}`);
    skipped++;
    continue;
  }
  process.stdout.write(`${C.cyan}▸${C.reset} ${id.padEnd(8)} `);
  const r = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.log(`${C.red}FAIL${C.reset}`);
    const msg = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-6).join('\n');
    if (msg) console.log(msg.split('\n').map((l) => `    ${C.red}│${C.reset} ${l}`).join('\n'));
    continue;
  }
  ok++;
  const note = (r.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
  console.log(`${C.green}OK${C.reset} ${C.dim}${note}${C.reset}`);
}

console.log(`${C.dim}汇总 成功 ${ok} · 跳过 ${skipped} · 失败 ${failed}${C.reset}`);
if (failed) process.exitCode = 1;