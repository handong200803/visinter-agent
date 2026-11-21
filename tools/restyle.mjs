/**
 * restyle.mjs —— 视觉迁移器：把「AI 味」界面机械迁移到 ui/tokens.css 体系
 *
 * 为什么写成脚本而不是手工改：
 *   三份源合计 50 处渐变、52 处大圆角、33 处阴影、13 处 --violet、上百个硬编码 hex。
 *   手工改一遍要半天，而且改完没有可复现的凭据；下次再来一份旧界面又得重做。
 *   这里把迁移规则固化：跑一遍，diff 可审，随时可重跑。
 *
 * 核心算法（关键设计）：
 *   不逐色手写映射表——源里的青绿蓝紫深浅变体有几十个，手写必然漏。
 *   改成**按饱和度分流**：
 *     · 低饱和（s < 0.35）→ 色相归零，明度**量化到 tokens 的六档灰/三档文字**
 *       （量化而不是保留原值，是为了让整个界面收敛到同一套灰阶，而不是留一堆 15% 亮度的中间灰）
 *     · 高饱和（s ≥ 0.35）→ 视为语义色，按色相映射到 --acc/--ok/--warn/--bad
 *   这样：#39e6c4(青, s=0.8) → var(--acc)；#123a34(深青绿, s=0.53) → 也走语义？不——
 *   深色但高饱和的一律先看明度：l < 0.35 视为「带色的暗底」，按灰阶处理（否则按钮底会变成荧光块）。
 *
 * 用法：
 *   node tools/restyle.mjs --dry        只报统计，不写盘
 *   node tools/restyle.mjs              就地迁移三份 src
 *   node tools/restyle.mjs --only canvas
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null;
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const TARGETS = [
  { id: 'params', label: '参数面板', file: 'web/params.src.html' },
  { id: 'canvas', label: '三视图画布', file: 'canvas/canvas.src.html' },
  { id: 'app', label: '平台外壳', file: 'app/index.src.html' },
];

/* ── 色值工具 ─────────────────────────────────────────── */
function hex2rgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const rgb2hex = (r, g, b) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hsl2rgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/* ── 灰阶/文字档位（与 ui/tokens.css 一致） ────────────── */
const GRAYS = [0.075, 0.102, 0.129, 0.161, 0.196, 0.231];           // #131313 #1a1a1a #212121 #292929 #323232 #3b3b3b
const TEXTS = [0.435, 0.608, 0.863];                                 // #6f6f6f #9b9b9b #dcdcdc
const nearest = (arr, v) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), arr[0]);

/** 单个颜色 → 迁移后的 CSS 取值（可能是 hex 或 var()） */
function migrateColor(h, s, l, alpha) {
  // 语义色：够亮、够饱和，才当成「有意义的颜色」而不是「带色的暗底」
  if (s >= 0.35 && l >= 0.35) {
    let v;
    if (h >= 130 && h < 205) v = 'var(--acc)';            // 青绿系（原主色）
    else if (h >= 205 && h < 265) v = 'var(--acc)';       // 蓝系
    else if (h >= 265 && h < 330) v = 'var(--acc-dim)';   // 紫系（去 AI 紫）
    else if (h >= 330 || h < 20) v = 'var(--bad)';        // 红
    else if (h >= 20 && h < 70) v = 'var(--warn)';        // 橙黄
    else v = 'var(--ok)';                                  // 绿
    // 带透明度的语义色不能直接用 var（会丢 alpha），退回灰阶
    if (alpha !== undefined && alpha < 1) {
      const g = nearest(GRAYS, Math.min(0.20, Math.max(0.10, l * 0.55)));
      return `rgba(${hsl2rgb(0, 0, g).map(Math.round).join(', ')}, ${alpha})`;
    }
    return v;
  }
  // 低饱和或暗色 → 归零色相 + 明度量化
  if (l >= 0.55) {
    const g = nearest(TEXTS, Math.min(0.9, Math.max(0.40, l)));
    return rgb2hex(...hsl2rgb(0, 0, g));
  }
  const g = nearest(GRAYS, Math.min(0.26, Math.max(0.06, l)));
  const rgb = hsl2rgb(0, 0, g);
  if (alpha !== undefined && alpha < 1) return `rgba(${rgb.map(Math.round).join(', ')}, ${alpha})`;
  return rgb2hex(...rgb);
}

/* ── 迁移步骤 ─────────────────────────────────────────── */

/** 1) rgba() 去饱和（保留 alpha） */
function desatRgba(text, stat) {
  return text.replace(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)\s*(?:[,/]\s*([\d.]+))?\s*\)/gi, (m, r, g, b, a) => {
    const alpha = a === undefined ? 1 : parseFloat(a);
    // 黑色/白色不动（阴影常用，动了会破坏层次）
    if ((r === '0' && g === '0' && b === '0') || (r === '255' && g === '255' && b === '255')) return m;
    const [h, s, l] = rgb2hsl(+r, +g, +b);
    if (s < 0.08) return m;                     // 已经是灰的
    stat.rgba++;
    const out = migrateColor(h, s, l, alpha);
    return out.startsWith('var(') ? out : out;
  });
}

/** 2) hex 全局映射（:root 稍后整体替换，所以这里包含旧变量也能被吃掉） */
function migrateHex(text, stat) {
  return text.replace(/#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g, (m) => {
    const [r, g, b] = hex2rgb(m);
    const [h, s, l] = rgb2hsl(r, g, b);
    if (s < 0.08) return m;                     // 本来就是灰
    if ((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255)) return m;
    stat.hex++;
    return migrateColor(h, s, l);
  });
}

/** 3) 用 tokens.css 的 :root + 基础层替换源里的 :root 块 */
function replaceRoot(text, tokensCss, stat) {
  const m = /(:root\s*\{[\s\S]*?\n\s*\})/.exec(text);
  if (!m) { stat.warn.push('没找到 :root 块'); return text; }
  // 取 tokens.css 里 :root 块 + 之后的基础层（去掉文件头注释）
  const body = tokensCss.replace(/^\/\*[\s\S]*?\*\/\s*/, '');
  stat.root = true;
  return text.slice(0, m.index) + body.trim() + text.slice(m.index + m[1].length);
}

/** 4) 渐变 → 纯色（取渐变里第一个可解析颜色；透明渐变退回容器底色） */
function flattenGradients(text, stat) {
  const RE = /(background(?:-image)?|background-color)\s*:\s*((?:linear|radial|conic)-gradient\()/gi;
  let out = text, guard = 0;
  while (guard++ < 400) {
    RE.lastIndex = 0;
    const m = RE.exec(out);
    if (!m) break;
    // 括号配平找结束位置
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < out.length && depth > 0) {
      if (out[i] === '(') depth++;
      else if (out[i] === ')') depth--;
      i++;
    }
    const inner = out.slice(start, i - 1);
    const tail = /^\s*([^;}]*)/.exec(out.slice(i))[1];   // 渐变后可能还有 / cover 之类
    // 取第一个颜色
    const colorM = /(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))/.exec(inner);
    let color = 'var(--panel)';
    if (colorM) {
      const c = colorM[1];
      if (/^#/.test(c)) {
        const [r, g, b] = hex2rgb(c.slice(0, 7));
        const [h, s, l] = rgb2hsl(r, g, b);
        color = (s < 0.08 || l < 0.2) ? rgb2hex(...hsl2rgb(0, 0, nearest(GRAYS, Math.max(0.06, l)))) : migrateColor(h, s, l);
      }
    }
    const prop = /^background-color/i.test(m[1]) ? 'background' : 'background';
    out = out.slice(0, m.index) + `${prop}: ${color};` + out.slice(i + tail.length);
    stat.gradient++;
  }
  return out;
}

/** 5) 删掉装饰性模糊/无限动画 */
function dropEffects(text, stat) {
  let out = text;
  out = out.replace(/(^|[;{\s])(backdrop-filter|filter)\s*:\s*[^;}]*?(blur|drop-shadow)\([^;}]*?\)\s*[^;}]*;/gi, (m, pre) => {
    stat.effect++;
    return pre === ';' || pre === '{' ? pre : pre;
  });
  out = out.replace(/(^|[;{\s])animation\s*:\s*[^;}]*\binfinite\b[^;}]*;/gi, (m, pre) => {
    stat.anim++;
    return pre === ';' || pre === '{' ? pre : pre;
  });
  return out;
}

/** 6) 大圆角 → 3px */
function clampRadius(text, stat) {
  return text.replace(/border-radius\s*:\s*([^;}]+)/gi, (m, v) => {
    if (/999|50%/.test(v)) return m;
    let changed = false;
    const nv = v.replace(/(\d+(?:\.\d+)?)px/g, (mm, n) => {
      if (parseFloat(n) >= 8) { changed = true; return '3px'; }
      return mm;
    });
    if (changed) stat.radius++;
    return `border-radius: ${nv.trim()}`;
  });
}

/** 7) 彩色阴影 → 中性浮层阴影或删除 */
function neutralizeShadows(text, stat) {
  return text.replace(/box-shadow\s*:\s*([^;}]+)/gi, (m, v) => {
    const hasColor = /rgba?\(\s*(?!0\s*,\s*0\s*,\s*0)[^)]*\)/i.test(v) || /#[0-9a-f]{3,8}/i.test(v);
    if (!hasColor) return m;
    stat.shadow++;
    // 有偏移量的当浮层处理，其余（光环类 0 0 0 Npx）直接去掉
    const px = (v.match(/(\d+)px/g) || []).map((s) => parseInt(s));
    const spreadLike = /0(px)?\s+0(px)?\s+0(px)?\s+/.test(v.trim());
    return spreadLike || px.length <= 2 ? 'box-shadow: none' : 'box-shadow: var(--shadow-pop)';
  });
}

/** 8) var(--violet) → var(--acc-dim) */
function killViolet(text, stat) {
  const before = text;
  let out = text.replace(/var\(\s*--violet\s*\)/g, () => { stat.violet++; return 'var(--acc-dim)'; });
  return out === before ? text : out;
}

/* ── 主流程 ───────────────────────────────────────────── */
const tokensCss = fs.readFileSync(path.join(ROOT, 'ui/tokens.css'), 'utf8');

console.log(`${C.bold}视觉迁移${C.reset} ${DRY ? `${C.yellow}(dry-run，不写盘)${C.reset}` : ''}\n`);

let totalChanged = 0;
for (const t of TARGETS) {
  if (ONLY && ONLY !== t.id) continue;
  const abs = path.join(ROOT, t.file);
  if (!fs.existsSync(abs)) { console.log(`${C.yellow}—${C.reset} ${t.label} 源文件不存在`); continue; }
  const src = fs.readFileSync(abs, 'utf8');
  const stat = { hex: 0, rgba: 0, gradient: 0, effect: 0, anim: 0, radius: 0, shadow: 0, violet: 0, warn: [] };

  let out = src;
  out = desatRgba(out, stat);
  out = migrateHex(out, stat);
  out = replaceRoot(out, tokensCss, stat);
  out = flattenGradients(out, stat);
  out = dropEffects(out, stat);
  out = clampRadius(out, stat);
  out = neutralizeShadows(out, stat);
  out = killViolet(out, stat);

  const changed = out !== src;
  if (changed) totalChanged++;

  console.log(`${C.bold}${t.label}${C.reset} ${C.dim}${t.file} · ${(src.length / 1024).toFixed(0)}KB → ${(out.length / 1024).toFixed(0)}KB${C.reset}`);
  console.log(`  hex ${stat.hex} · rgba ${stat.rgba} · 渐变 ${stat.gradient} · 模糊/动画 ${stat.effect + stat.anim} · 圆角 ${stat.radius} · 阴影 ${stat.shadow} · violet ${stat.violet} · :root ${stat.root ? '已换' : '未换'}`);
  for (const w of stat.warn) console.log(`  ${C.yellow}!${C.reset} ${w}`);

  if (!DRY && changed) {
    fs.writeFileSync(abs + '.restyle.bak', src, 'utf8');
    fs.writeFileSync(abs, out, 'utf8');
    console.log(`  ${C.green}已写入${C.reset}（原件备份 ${path.basename(abs)}.restyle.bak）`);
  }
  console.log();
}

console.log(DRY ? `${C.dim}dry-run 结束，未改动任何文件${C.reset}` : `${C.green}${C.bold}迁移完成：${totalChanged} 个文件${C.reset}\n下一步：node tools/build_all.mjs && node tools/lint_ui.mjs`);