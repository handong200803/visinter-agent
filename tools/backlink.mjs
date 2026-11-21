#!/usr/bin/env node
/**
 * backlink.mjs —— 给六个模块入口注入「返回工作台」链接
 *
 * 为什么要有这一步：
 *   平台的导航是外壳 → 模块的单向流。用户点进画布/市场/质检后没有回程路，只能按浏览器后退
 *   ——在 file:// 下后退经常把整页重新解析一遍（内联 200KB+），体验上等于重启。
 *
 * 为什么是脚本而不是手改六个文件：
 *   六个源件分属三个人写域，手改一次不难，难的是下一个模块接入时没人记得加。放成幂等脚本，
 *   接入流程变成「跑一次 backlink」，漏没漏一眼可见（scripts 会打印每个文件 skipped/injected）。
 *
 * 幂等：源件里已有 data-backlink 就跳过，重复跑不会叠出两个链接。
 *
 * 跑法：node tools/backlink.mjs [--check]
 *   --check 只检查不写入，任何一个目标缺链接就 exit 1（给 lint/CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

/** 两类源件：模块页用 module-ui 的 .btn.mini.ghost；画布/参数面板各自带 .btn */
const TARGETS = [
  { file: 'market/market.src.html', anchor: '<header class="topbar">', cls: 'btn mini ghost' },
  { file: 'plugins/plugins.src.html', anchor: '<header class="topbar">', cls: 'btn mini ghost' },
  { file: 'quality/quality.src.html', anchor: '<header class="topbar">', cls: 'btn mini ghost' },
  { file: 'server/server.src.html', anchor: '<header class="topbar">', cls: 'btn mini ghost' },
  { file: 'canvas/canvas.src.html', anchor: '  <header>', cls: 'btn' },
  { file: 'web/params.src.html', anchor: '  <header>', cls: 'btn' },
];

const LINK = (cls) => `    <a class="${cls}" data-backlink href="../app/index.html" title="返回平台工作台（各模块页共用的回程路）">← 工作台</a>`;

let injected = 0, skipped = 0, missing = 0;
for (const t of TARGETS) {
  const abs = path.join(ROOT, t.file);
  if (!fs.existsSync(abs)) { console.log(`— ${t.file} 不存在，跳过`); missing++; continue; }
  const src = fs.readFileSync(abs, 'utf8');
  if (src.includes('data-backlink')) { console.log(`= ${t.file} 已有回程链接`); skipped++; continue; }
  if (CHECK) { console.log(`✗ ${t.file} 缺回程链接`); missing++; continue; }

  const i = src.indexOf(t.anchor);
  if (i < 0) { console.log(`✗ ${t.file} 找不到锚点 ${JSON.stringify(t.anchor)}`); missing++; continue; }
  const cut = i + t.anchor.length;
  const out = src.slice(0, cut) + '\n' + LINK(t.cls) + src.slice(cut);
  fs.writeFileSync(abs, out, 'utf8');
  console.log(`+ ${t.file} 已注入回程链接`);
  injected++;
}

console.log(`\n回程链接：注入 ${injected} · 已存在 ${skipped} · 问题 ${missing}`);
if (missing) process.exit(1);