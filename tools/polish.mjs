/**
 * polish.mjs —— 视觉精修（迁移器之后的第二遍，人工判断固化成补丁）
 *
 * 为什么需要第二遍：
 *   restyle.mjs 只做「机械去色 + 去装饰」，它不认识语义：
 *   · body 的 #292929 被量化成了"面板色"，结果整页比面板还亮
 *   · box-shadow: 0 0 9px var(--ok) 里的颜色是 var()，机械器当成灰阶放过，实际是彩色发光
 *   · hover 位移（translateY）属于展示品语法，规则里没禁，但它和"专业工具"冲突
 *   这些靠正则猜不出来，只能一条条写死。所以补丁表就是这套视觉的判断记录。
 *
 * 幂等：所有替换都是「找到才换」，重复跑不会二次伤害。
 * 用法：node tools/polish.mjs [--dry]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m' };

/** 通用补丁：三份源都适用 */
const COMMON = [
  // 双分号：迁移器整行替换时留下的尾巴，无害但不整洁
  [/;;/g, ';', '双分号'],
  // 彩色发光：var() 色的 box-shadow 在机械器里被当成灰阶放过，实际是荧光光晕
  [/(box-shadow\s*:\s*(?!inset)[^;}]*?0\s+0\s+\d+px\s+var\(--(?:acc|acc2|acc-dim|ok|warn|bad|dim)\))\s*;/g, '', '状态点发光'],
  // hover 位移：工作台不该有"卡片浮起来"这种动效
  [/\s*transform:\s*translateY\(-\d+px\)\s*;?/g, '', 'hover 位移'],
];

/** 每个文件的专属补丁（顺序敏感：先具体后通用） */
const PER_FILE = {
  'app/index.src.html': [
    // body 底色：迁移把它量化成了面板灰，导致「页面底比卡片亮」，层次反了
    [/body\s*\{([^}]*?)background:\s*#292929;/, 'body {$1background: var(--bg);', 'body 底色'],
    [/@keyframes\s+pulse\s*\{[^}]*\}\s*/g, '', '未引用的脉冲动画'],
  ],
  'canvas/canvas.src.html': [
    // Canvas 里若还有 var(--x) 作为绘制色，一律替换为等值 hex（Canvas2D 不认变量）
    [/'var\(--acc\)'/g, "'#4a7fd4'", 'Canvas 误用 CSS 变量'],
  ],
  'web/params.src.html': [],
};

let changed = 0;
for (const [rel, own] of Object.entries(PER_FILE)) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const before = fs.readFileSync(abs, 'utf8');
  let s = before;
  const applied = [];
  for (const [re, to, label] of [...own, ...COMMON]) {
    const n = (s.match(re) || []).length;
    if (!n) continue;
    s = s.replace(re, to);
    applied.push(`${label}×${n}`);
  }
  if (s !== before) {
    changed++;
    if (!DRY) fs.writeFileSync(abs, s, 'utf8');
    console.log(`${C.green}✓${C.reset} ${rel} ${C.dim}${applied.join(' · ')}${C.reset}`);
  } else {
    console.log(`${C.yellow}—${C.reset} ${rel} ${C.dim}无改动${C.reset}`);
  }
}
console.log(DRY ? `\n${C.dim}dry-run，未写盘${C.reset}` : `\n${C.bold}精修完成：${changed} 个文件${C.reset}`);