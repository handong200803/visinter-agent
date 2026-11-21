/**
 * lint_ui.mjs —— 界面视觉守门（把「暗黑玻璃拟态」变成可判定断言）
 *
 * 存在理由：
 *   「暗黑玻璃拟态 · 冷调银灰」如果只写在文档里，下一次改样式就会漂回去。
 *   这里把 docs/09-design-system.md 的原则拆成可机械判定的规则：
 *   令牌一致性（1 条）+ 禁用特征（9 条）+ 正向要求（7 条）。
 *
 * 教义摘要（详见 docs/09）：
 *   - 冷调银灰：渐变/外发光的色标只许「中性银灰」(通道差 ≤ 28) 或「冷调」(通道差 ≤ 64 且蓝 ≥ 红)
 *   - 语义暖色(琥珀/血红)只作边框/填充，不得进入渐变或外发光；纯白文字禁止
 *   - 玻璃模糊给所有卡片/面板/输入/弹窗（正向要求 backdrop-filter + -webkit- 前缀在场）
 *   - 循环动画只给铸造加载器（粒子/烟雾）；圆角上限 16px（玻璃卡）；碑铭衬线 --serif 与噪点颗粒必须在场
 *
 * 判定对象是**产物**（用户实际双击打开的那个文件），不是 src：
 *   只检查 src 会漏掉构建器拼进来的旧样式。
 *
 * 退出码 0 = 全部通过；1 = 有违规（含违规样本行号，便于定位）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = path.join(ROOT, 'ui/tokens.css');
const TARGETS = [
  ['参数面板', 'web/params.html'],
  ['三视图画布', 'canvas/canvas.html'],
  ['平台外壳', 'app/index.html'],
  ['模板市场', 'market/index.html'],
  ['插件管理', 'plugins/index.html'],
  ['质检面板', 'quality/index.html'],
  ['本地服务', 'server/index.html'],
  ['VisInter 装配', 'visinter/index.html'],
  ['Ultimate 科研台', 'ultimate/index.html'],
];

/* ── 工具 ─────────────────────────────────────────────── */
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

/** 从文本里抽出第一个 :root{...} 的变量表 */
function rootVars(css) {
  const m = /:root\s*\{([\s\S]*?)\}/.exec(css);
  if (!m) return null;
  const out = new Map();
  for (const line of m[1].split(/[;\n]/)) {
    const mm = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (mm) out.set(mm[1], mm[2].replace(/\s+/g, ' ').trim());
  }
  return out;
}

/** 统计正则命中数，并取前 2 条样本（截断到 80 字符）用于定位 */
function hits(text, re) {
  const list = [];
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) && list.length < 2) {
    const line = text.slice(0, m.index).split('\n').length;
    list.push(`L${line}: ${m[0].replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  const all = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  return { count: all ? all.length : 0, samples: list };
}

/** 解析一个色值为 [r,g,b]；解析不了返回 null */
function parseColor(raw, tokens) {
  let v = String(raw).trim();
  const vm = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
  if (vm) {
    if (!tokens || !tokens.has(vm[1])) return null;
    v = tokens.get(vm[1]);
    // 令牌值里可能还套一层 var（别名），再解一次
    const v2 = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
    if (v2 && tokens.has(v2[1])) v = tokens.get(v2[1]);
  }
  const hx = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (hx) {
    let h = hx[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const rg = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v);
  if (rg) return [+rg[1], +rg[2], +rg[3]];
  if (/^(black|#000)$/i.test(v)) return [0, 0, 0];
  if (/^(white)$/i.test(v)) return [255, 255, 255];
  return null; // transparent / currentColor / 关键字：不参与判定
}

/** 通道差：银灰阶的判据。纯银 12、炭灰 ≤10；语义绿 30、琥珀 89、血红 75 都超线 */
const spread = (rgb) => Math.max(...rgb) - Math.min(...rgb);
/** 玻璃教义：渐变/外发光色标只许中性银灰(≤28)或冷调(≤64 且蓝≥红)。
 *  冷光 rgba(180,200,230) 差 50、环境蓝 rgba(98,118,158) 差 60、环境紫 rgba(126,106,160) 差 54 均放行；
 *  琥珀 #b3985a 差 89、血红 #6b2020 差 75 且红>蓝 → 不得进入光晕。 */
const glowOk = (rgb) => { const s = spread(rgb); return s <= 28 || (s <= 64 && rgb[2] >= rgb[0]); };

/** 取出字符串里所有色标（hex / rgb / rgba / var），供渐变与阴影共用 */
function colorStops(v) {
  const out = [];
  const re = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|var\(\s*--[\w-]+\s*\)/gi;
  let m;
  while ((m = re.exec(v))) out.push(m[0]);
  return out;
}

/* ── 读出令牌 ─────────────────────────────────────────── */
const tokensCss = fs.readFileSync(TOKENS, 'utf8');
const tokens = rootVars(tokensCss);
if (!tokens || !tokens.size) {
  console.error(`${C.red}ui/tokens.css 里没找到 :root 变量${C.reset}`);
  process.exit(1);
}

/* ── 禁用特征：每条都是「漂离暗黑雕塑」的具体来源 ──────────────── */
const BANNED = [
  { id: 'emoji', label: 'emoji 图标', re: /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}\u{2600}-\u{26FF}\u{FE0F}]/u, why: '图标必须是内联 SVG（1.5px stroke）；仅风格标签豁免（__MUSE 数据行 / data-emoji-ok 元素，用户口径）' },
  { id: 'violet', label: 'AI 紫变量', re: /--violet\b|#b98bff/i, why: '紫色双色体系是「AI 产品」的视觉签名' },
  { id: 'old-neon', label: '旧荧光/旧蓝残留', re: /#39e6c4|#6c8cff|#f7c451|#ff6272|#4ade80|#0a0d13|#111621|#151b28|#202838|#4a7fd4|#5a8fe4|#2f5a9e/i, why: '高饱和荧光与旧克制蓝都不属于银灰雕塑体系' },
  { id: 'pure-white', label: '纯白文字', re: /color\s*:\s*(?:#fff\b|#ffffff\b|white\b)/i, why: '纯白在暗底上光晕扩散；冷白上限是 --acc-hover #eef1f5' },
  { id: 'text-shadow', label: '文字发光', re: /text-shadow\s*:/i, why: '碑铭靠字重与字距，不靠光' },
  { id: 'conic', label: '锥形渐变', re: /conic-gradient\s*\(/i, why: '彩色转盘是消费级加载器语言；铸造加载走银粒子' },
  { id: 'drop-shadow', label: '滤镜投影', re: /filter\s*:\s*drop-shadow\s*\(/i, why: '光晕统一走 box-shadow 的银光令牌，便于守门' },
];

/** 彩色渐变：逐个色标解通道差，非银灰/冷调即「彩色横幅」 */
function coloredGradients(text) {
  const out = [];
  const re = /(?:linear|radial)-gradient\(([^;{}]*)\)/gi;
  let m;
  while ((m = re.exec(text))) {
    for (const stop of colorStops(m[1])) {
      const rgb = parseColor(stop, tokens);
      if (rgb && !glowOk(rgb)) {
        const line = text.slice(0, m.index).split('\n').length;
        out.push(`L${line}: 色标 ${stop} 通道差 ${spread(rgb)} 非银灰/冷调`);
        break;
      }
    }
  }
  return out;
}

/** 彩色阴影：外发光必须是银灰或冷调；inset 的语义竖条/内描边放行 */
function coloredShadows(text) {
  const out = [];
  const re = /box-shadow\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const v = m[1];
    if (/inset/i.test(v)) continue; // 选中标记/内描边，不是光晕
    let colored = false;
    for (const stop of colorStops(v)) {
      const rgb = parseColor(stop, tokens);
      if (rgb && !glowOk(rgb)) colored = true;
    }
    if (colored) {
      const line = text.slice(0, m.index).split('\n').length;
      out.push(`L${line}: box-shadow:${v.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  return out;
}

/** 过大圆角：玻璃卡上限 16px；允许 50% 与 999px（状态点/徽标/胶囊开关） */
function bigRadius(text) {
  const out = [];
  const re = /border-radius\s*:\s*([^;{}]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const v = m[1];
    if (/(999|50%)/.test(v)) continue;
    const nums = v.match(/(\d+(?:\.\d+)?)\s*px/g);
    if (!nums) continue;
    for (const n of nums) {
      if (parseFloat(n) >= 17) {
        const line = text.slice(0, m.index).split('\n').length;
        out.push(`L${line}: border-radius:${v.trim().slice(0, 50)}`);
        break;
      }
    }
  }
  return out;
}

/** 循环动画：只允许挂在铸造加载器（粒子/烟雾/mist）上，其余一律禁 */
function strayInfinite(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*animation\s*:[^;{}]*infinite[^{}]*)\}/gi;
  let m;
  while ((m = re.exec(text))) {
    const sel = m[1].trim().split('}').pop().trim();
    if (/(forge|load|particle|smoke|ember|mist)/i.test(sel)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push(`L${line}: ${sel.slice(0, 60)} { animation…infinite }`);
  }
  return out;
}

/* ── 主流程 ───────────────────────────────────────────── */
let totalFail = 0;
console.log(`${C.bold}界面视觉 lint · 暗黑玻璃教义${C.reset}  ${C.dim}令牌源 ui/tokens.css（${tokens.size} 个变量）${C.reset}\n`);

for (const [label, rel] of TARGETS) {
  const abs = path.join(ROOT, rel);
  const kb = fs.existsSync(abs) ? (fs.statSync(abs).size / 1024).toFixed(1) : null;
  console.log(`${C.bold}${label}${C.reset} ${C.dim}${rel}${kb ? ` · ${kb}KB` : ' · 不存在'}${C.reset}`);

  if (!fs.existsSync(abs)) {
    console.log(`  ${C.yellow}—${C.reset} 跳过（产物还没构建）\n`);
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8');
  // 检测前先剥掉注释：注释里解释规则不该算违规，否则作者不敢写注释。
  // 再剥掉构建器内联的纯数据载荷（window.__REG/__MUSE/__SNAP 等顶格赋值块）：
  // 那是 spec 数据不是界面_markup_——例如 muse.presets.json v0.2 的 emoji 字段从不渲染成图标。
  // 用等行数换行占位，保住样本行号不失真。
  const body = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ')
    .replace(/^window\.__[A-Z]+\s*=\s*\{[\s\S]*?\n\};/gm, (m) => '\n'.repeat(m.split('\n').length - 1));
  let fileFail = 0;
  const bad = (msg, samples) => {
    fileFail++; totalFail++;
    console.log(`  ${C.red}✗${C.reset} ${msg}`);
    for (const s of samples || []) console.log(`      ${C.dim}${s}${C.reset}`);
  };
  const good = (msg) => console.log(`  ${C.green}✓${C.reset} ${msg}`);

  // 1) 令牌一致性
  const vars = rootVars(body);
  if (!vars) {
    bad('缺 :root 变量块', ['产物必须先内联 tokens.css 的 :root']);
  } else {
    const missing = [], wrong = [];
    for (const [k, v] of tokens) {
      if (!vars.has(k)) missing.push(k);
      else if (vars.get(k).toLowerCase() !== v.toLowerCase()) wrong.push(`${k}: ${vars.get(k)} ≠ ${v}`);
    }
    if (missing.length) bad(`令牌缺失 ${missing.length} 个`, missing.slice(0, 6));
    else if (wrong.length) bad(`令牌取值不一致 ${wrong.length} 个`, wrong.slice(0, 6));
    else good(`令牌一致（${tokens.size} 个变量逐一比对）`);
  }

  // 1b) 漂移哨兵：产物头部内联的 tokens.css 之后，页面不许再用「同名不同值」的 :root 覆盖。
  //     同名同值是历史抄写残留（无害），同名不同值就是悄悄改设计规范——那是返工的第一来源。
  const laterRoots = [...body.matchAll(/:root\s*\{([\s\S]*?)\}/g)].slice(1);
  // 断点降档是有意的：窄屏 blur 必须变小，不算改规范。
  const BREAKPOINT_OK = new Set(['--glass-blur', '--glass-blur-lite']);
  const drift = [];
  for (const blk of laterRoots) {
    for (const line of blk[1].split(/[;\n]/)) {
      const mm = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
      if (!mm || !tokens.has(mm[1]) || BREAKPOINT_OK.has(mm[1])) continue;
      if (mm[2].replace(/\s+/g, ' ').trim().toLowerCase() !== tokens.get(mm[1]).toLowerCase()) drift.push(`${mm[1]}: ${mm[2]}`);
    }
  }
  if (drift.length) bad(`令牌被页面局部改值 ${drift.length} 处 —— 令牌只许在 ui/tokens.css 里定义`, [...new Set(drift)].slice(0, 6));
  else good('令牌无局部改值（后续 :root 只允许同值复述）');

  // 2) 禁用特征（emoji 窄豁免：用户口径的市面风格标签，仅 __MUSE 数据行与 data-emoji-ok 标记元素放行）
  for (const b of BANNED) {
    const text = b.id === 'emoji' ? body.split('\n').filter((l) => !/window\.__MUSE|data-emoji-ok/.test(l)).join('\n') : body;
    const r = hits(text, b.re);
    if (r.count) bad(`${b.label} ×${r.count} —— ${b.why}`, r.samples);
    else good(`${b.label} 0 处`);
  }

  // 3) 需解析取值的三条：彩色渐变 / 彩色阴影 / 大圆角 / 游离循环动画
  const cg = coloredGradients(body);
  if (cg.length) bad(`彩色渐变 ×${cg.length} —— 渐变只许在银灰阶内走`, cg.slice(0, 2));
  else good('彩色渐变 0 处');
  const cs = coloredShadows(body);
  if (cs.length) bad(`彩色光晕 ×${cs.length} —— 光只能是银或黑`, cs.slice(0, 2));
  else good('彩色光晕 0 处');
  const br = bigRadius(body);
  if (br.length) bad(`过大圆角 ×${br.length} —— 玻璃圆角上限 16px`, br.slice(0, 3));
  else good('过大圆角 0 处');
  const si = strayInfinite(body);
  if (si.length) bad(`游离循环动画 ×${si.length} —— 循环只给铸造加载器`, si.slice(0, 2));
  else good('游离循环动画 0 处');

  // 4) 正向要求：暗黑玻璃的七个在场证明
  if (/font-variant-numeric\s*:\s*tabular-nums/i.test(body)) good('数字等宽（tabular-nums）在场');
  else bad('缺 tabular-nums —— 参数数字会整行抖动');
  if (/:focus-visible/i.test(body)) good('键盘焦点环在场（:focus-visible）');
  else bad('缺 :focus-visible —— 键盘不可达');
  if (/radial-gradient\s*\(/i.test(body)) good('深黑→冷调径向光晕底在场');
  else bad('缺径向渐变底 —— 页面不能是平黑');
  if (/grain\.png/i.test(body)) good('噪点颗粒层在场');
  else bad('缺噪点颗粒 —— 电影感少一层胶片');
  if (/var\(\s*--serif\s*\)/i.test(body)) good('碑铭衬线（--serif）在场');
  else bad('缺 --serif 使用 —— 平台名/卡片标题必须是碑铭体');
  if (/backdrop-filter\s*:/i.test(body)) good('玻璃磨砂层（backdrop-filter）在场');
  else bad('缺 backdrop-filter —— 卡片/面板/输入必须是暗玻璃');
  if (/-webkit-backdrop-filter\s*:/i.test(body)) good('Safari 前缀（-webkit-backdrop-filter）在场');
  else bad('缺 -webkit-backdrop-filter —— Safari/旧 WebKit 玻璃失效');

  // 4b) 共享玻璃层：tokens.css 的通用类与 glass-skin.css 的页面级映射必须真的内联进产物，
  //     否则「抽成通用 class」只是一句口号——各页会退回去各写各的配方。
  if (/\.glass-card\s*\{/.test(body) && /\.glass-input\s*\{/.test(body)) good('通用玻璃类（.glass-card/.glass-input）在场');
  else bad('缺通用玻璃类 —— 构建器没把 ui/tokens.css 内联进来', ['检查源件 /*__TOKENS__*/ 标记与对应 build 脚本']);
  if (/\.glass-toolbar\s*\{/.test(body) && /\.glass-modal\s*\{/.test(body)) good('玻璃映射层（.glass-toolbar/.glass-modal）在场');
  else bad('缺玻璃映射层 —— 构建器没把 ui/glass-skin.css 内联进来', ['检查源件 /*__SKIN__*/ 标记与对应 build 脚本']);
  if (/@media\s*\(max-width:\s*900px\)[\s\S]{0,400}?--glass-blur\s*:\s*blur\(\s*1[0-2]px\)/i.test(body)) good('移动端 blur 降档在场（≤12px）');
  else bad('缺移动端 blur 降档 —— 手机上大面积毛玻璃会掉帧', ['@media (max-width:900px){:root{--glass-blur:blur(12px) saturate(1.3)}}']);

  // 5) 回程链接：进了模块页必须有回工作台的路（file:// 下浏览器后退会重解析整页）
  if (rel === 'app/index.html') good('平台外壳即工作台（不需要回程链接）');
  else if (text.includes('data-backlink') && /href="\.\.\/app\/index\.html"/.test(text)) good('回程链接在场（← 工作台）');
  else bad('缺回程链接 —— 进了本页就没有回程路', ['在 header 内加 <a class="btn" data-backlink href="../app/index.html">← 工作台</a>，由 node tools/backlink.mjs 注入']);

  console.log(fileFail ? `  ${C.dim}→ ${fileFail} 项不通过${C.reset}\n` : `  ${C.dim}→ 全部通过${C.reset}\n`);
}

if (totalFail) {
  console.log(`${C.red}${C.bold}视觉 lint 失败：${totalFail} 项${C.reset}  见 docs/09-design-system.md §5 禁用清单`);
  process.exit(1);
}
console.log(`${C.green}${C.bold}全部通过${C.reset}`);