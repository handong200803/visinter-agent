#!/usr/bin/env node
/**
 * build_module.mjs —— 功能模块入口的通用构建器
 *
 * 为什么要有这个：
 *   平台是本地应用，双击 app/index.html 就要能用，不能要求起 dev server。
 *   于是每个模块的入口 HTML 都必须自带样式与数据（file:// 下 fetch 本地 JSON 会被 CORS 拦死）。
 *   四个模块（market / plugins / quality / server）如果各写一份内联脚本，
 *   令牌一旦改动就会出现四份不同步的副本——这正是上一代三套界面「各持一份配色」的老路。
 *   所以内联这件事收敛到这一个构建器：源件只写界面，令牌与快照由构建期注入。
 *
 * 约定（与 docs/08-shell.md 的模块接入约定一致）：
 *   <mod>/<mod>.src.html   源件，含三个占位符：TOKENS / UI / SNAP（写法见 docs/11-module-ui.md）
 *   <mod>/snapshot.json    构建期快照（该模块的真实数据，由 tools/snap_<mod>.mjs 产出）
 *   <mod>/index.html       产物，单文件，双击可开
 *
 * 三个占位符各管一件事，不合并：
 *   TOKENS → ui/tokens.css（视觉令牌 + 基础层，身份唯一）
 *   UI     → ui/module-ui.css（四模块共享骨架：顶栏 / 左列表 / 右详情 / 口径条）
 *   SNAP   → window.__SNAP（该模块的真实数据）
 *   合并成一个「内联全部 CSS」会让人以为骨架和令牌是同一层东西，改令牌时会顺手动栅格。
 *
 * 跑法：
 *   node tools/build_module.mjs                # 构建全部已存在的模块源件
 *   node tools/build_module.mjs market         # 只构建一个
 *   node tools/build_module.mjs market quality # 构建多个
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };
const kb = (n) => (n / 1024).toFixed(0) + 'KB';

/** 模块清单：id 必须等于目录名；顺序只影响日志可读性 */
const MODULES = ['market', 'plugins', 'quality', 'server', 'visinter', 'ultimate'];

const tokens = fs.readFileSync(path.join(ROOT, 'ui', 'tokens.css'), 'utf8');
const shellCss = fs.readFileSync(path.join(ROOT, 'ui', 'module-ui.css'), 'utf8');
const skinCss = fs.readFileSync(path.join(ROOT, 'ui', 'glass-skin.css'), 'utf8');

/** 内联进 <script> 的 JSON 若含 </script 会让浏览器提前闭合脚本块 */
function guardInline(text, where) {
  if (/<\/script/i.test(text)) throw new Error(`${where} 里出现 </script>，内联会截断页面`);
}

function buildOne(id) {
  const srcPath = path.join(ROOT, id, `${id}.src.html`);
  if (!fs.existsSync(srcPath)) return { id, skipped: '源件不存在' };

  const src = fs.readFileSync(srcPath, 'utf8');
  for (const marker of ['/*__TOKENS__*/', '/*__UI__*/', '/*__SKIN__*/', '/*__SNAP__*/']) {
    if (!src.includes(marker)) throw new Error(`${id}: 源文件缺少占位符 ${marker}`);
  }

  const snapPath = path.join(ROOT, id, 'snapshot.json');
  let snapText = 'null';
  let snapNote = '无快照';
  if (fs.existsSync(snapPath)) {
    const raw = fs.readFileSync(snapPath, 'utf8');
    JSON.parse(raw); // 先验一遍，坏 JSON 不该等到浏览器里才炸
    guardInline(raw, `${id}/snapshot.json`);
    snapText = raw.trim();
    snapNote = kb(Buffer.byteLength(raw));
  } else {
    console.log(`${C.yellow}  !${C.reset} ${id} 缺 snapshot.json，页面将以空数据启动`);
  }

  guardInline(tokens, 'ui/tokens.css');
  guardInline(shellCss, 'ui/module-ui.css');
  guardInline(skinCss, 'ui/glass-skin.css');
  // token 里的注释含有 /* */ 嵌套风险：只允许整块文本，不允许再被替换模式吃掉 → 用函数式 replace
  const data = `window.__SNAP = ${snapText};`;
  const out = src
    .replace('/*__TOKENS__*/', () => tokens)
    .replace('/*__UI__*/', () => shellCss)
    .replace('/*__SKIN__*/', () => skinCss)
    .replace('/*__SNAP__*/', () => data);

  if (/\/\*__(TOKENS|UI|SKIN|SNAP)__\*\//.test(out)) throw new Error(`${id}: 产物里仍有未填占位符`);

  const target = path.join(ROOT, id, 'index.html');
  fs.writeFileSync(target, out, 'utf8');
  return { id, target, size: Buffer.byteLength(out), snapNote };
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = only.length ? only : MODULES;

console.log(`${C.bold}模块入口构建${C.reset}`);
let built = 0, skipped = 0;

for (const id of list) {
  if (!MODULES.includes(id)) {
    console.log(`${C.yellow}—${C.reset} ${id} ${C.dim}不在模块清单里，跳过${C.reset}`);
    skipped++;
    continue;
  }
  try {
    const r = buildOne(id);
    if (r.skipped) {
      console.log(`${C.yellow}—${C.reset} ${id.padEnd(8)} ${C.dim}跳过：${r.skipped}${C.reset}`);
      skipped++;
      continue;
    }
    built++;
    console.log(`${C.green}OK${C.reset} ${id.padEnd(8)} ${C.dim}→ ${path.relative(ROOT, r.target)} ${kb(r.size)} · 快照 ${r.snapNote}${C.reset}`);
  } catch (e) {
    console.log(`${C.red}FAIL${C.reset} ${id.padEnd(8)} ${e.message}`);
    process.exitCode = 1;
  }
}

console.log(`${C.dim}汇总 成功 ${built} · 跳过 ${skipped}${C.reset}`);