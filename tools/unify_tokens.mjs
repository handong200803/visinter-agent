/**
 * unify_tokens.mjs —— 把散落在各页面源件里的「令牌副本」收口回 ui/tokens.css
 *
 * 为什么需要这个：
 *   三个主页面早期是「逐字复制 tokens.css 的 :root」当基线，后来 tokens 一改就漂移，
 *   典型症状是环境光晕比真源淡一个档、玻璃再对也显得发灰，而 lint 只看第一个 :root，
 *   漂移就悄悄藏在后面。
 *   现在 tokens.css 由构建期内联（源件 /*__TOKENS__*／* 标记），页面自己不该再声明任何
 *   同名令牌；本脚本把「tokens.css 里有的变量」从页面 :root 里删掉，只留页面私有的。
 *
 * 跑法：node tools/unify_tokens.mjs          # 改源件
 *       node tools/unify_tokens.mjs --check  # 只报不改（CI 用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const TARGETS = [
  'app/index.src.html',
  'canvas/canvas.src.html',
  'web/params.src.html',
  'market/market.src.html',
  'plugins/plugins.src.html',
  'quality/quality.src.html',
  'server/server.src.html',
  'inspector/index.src.html',
];

const tokenCss = fs.readFileSync(path.join(ROOT, 'ui/tokens.css'), 'utf8');
const firstRoot = /:root\s*\{([\s\S]*?)\}/.exec(tokenCss);
const TOKENS = new Set([...firstRoot[1].matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

let touched = 0;
let removedTotal = 0;

for (const rel of TARGETS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.log(`${C.yellow}—${C.reset} ${rel} 不存在，跳过`); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  let removed = [];
  // 只处理源件里在 /*__TOKENS__*/ 之后出现的 :root 块（标记之前不该有，之前有也先留着让 lint 报）
  const out = src.replace(/:root\s*\{([\s\S]*?)\}/g, (whole, body) => {
    const kept = body.split('\n').filter((line) => {
      const m = /^\s*(--[\w-]+)\s*:/.exec(line);
      if (!m) return true;                 // 注释/空行照留
      if (!TOKENS.has(m[1])) return true;   // 页面私有变量：留着
      removed.push(m[1]);
      return false;
    });
    // 剩下的都是空行/注释：整块删掉
    const hasDecl = kept.some((l) => /^\s*--?[\w-]+\s*:/.test(l) || /^\s*[a-z-]+\s*:/.test(l));
    if (!hasDecl) return '/* :root 已收口到 ui/tokens.css（构建期内联） */';
    return `:root {\n${kept.join('\n')}}`;
  });

  if (!removed.length) { console.log(`${C.green}✓${C.reset} ${rel} ${C.dim}已是干净状态${C.reset}`); continue; }
  touched++;
  removedTotal += removed.length;
  const uniq = [...new Set(removed)];
  if (CHECK) {
    console.log(`${C.cyan}·${C.reset} ${rel} ${C.yellow}有 ${removed.length} 处令牌副本${C.reset} ${C.dim}(${uniq.slice(0, 5).join(', ')}${uniq.length > 5 ? ' …' : ''})${C.reset}`);
    continue;
  }
  fs.writeFileSync(abs, out, 'utf8');
  console.log(`${C.green}✓${C.reset} ${rel} ${C.dim}删除 ${removed.length} 处令牌副本（${uniq.slice(0, 5).join(', ')}${uniq.length > 5 ? ' …' : ''}）${C.reset}`);
}

if (CHECK && touched) {
  console.log(`\n${C.yellow}${touched} 个源件仍有令牌副本，共 ${removedTotal} 处${C.reset}  跑 node tools/unify_tokens.mjs 收口`);
  process.exit(1);
}
console.log(`\n${C.dim}令牌源 ui/tokens.css · ${TOKENS.size} 个变量 · 处理 ${TARGETS.length} 个源件${C.reset}`);