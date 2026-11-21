/**
 * build_wizard.mjs —— 向导页单文件构建器
 *
 * 干什么：
 *   读 wizard/index.src.html，把里面「独占一行」的 <!--@inline:相对ROOT路径--> 标记
 *   就地换成真实内容（.css → <style>、.js → <script>、.txt → 原文），
 *   产出 wizard/index.html。产物在构建期内联完毕，双击 file:// 即可用。
 *
 * 为什么必须构建期内联，而不是让页面运行时去 fetch：
 *   file:// 下 fetch 任何本地文件都算跨源请求，浏览器直接拒；把依赖在构建期烧进 HTML，
 *   「能不能打开」就从运行时的赌运气，变成构建期的静态保证（与 build_app.mjs 同一条理由）。
 *
 * 为什么标记里的路径写「相对 ROOT」而不是相对 src：
 *   构建器只有一个根。若按 src 相对，<!--@inline:../theme.css--> 这种上行路径会成为常态，
 *   越界检查就形同虚设；统一相对 ROOT，越界判定只需要一次 path.relative。
 *
 * 为什么 --check 把产物拆成「源指纹 + 正文」两段比：
 *   产物头里有生成时间和源清单，每次重跑时间戳都不同 —— 整文件比对必然误报。
 *   所以先把构建头剥掉再逐行比正文；源指纹（文件 · 字节 · mtime 的 sha1 前 8 位）单独比。
 *   「源被重新保存过」和「正文真的变了」因此能分开报，而不是混成一句含糊的「不一致」。
 *
 * 为什么导出 inline()：
 *   check_wizard.mjs 要复用同一套标记解析逻辑，自测也要能在临时目录里造 fixture 跑，
 *   都不该依赖真实源件。核心逻辑必须是纯函数 + 可注入 readFile。
 *
 * 跑法：
 *   node tools/build_wizard.mjs            正常构建
 *   node tools/build_wizard.mjs --check    只校验（一致 → 0；漂移 → 2；源缺失等错误 → 1）
 *   node tools/build_wizard.mjs --dry      只打印将要内联的清单，不写盘
 *
 * 只动自己：不碰 build_all.mjs / build_app.mjs / wizard/* 源件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// WIZARD_ROOT 只为一个用途存在：自测/CI 在临时目录里造 fixture 跑「真实 CLI」，
// 而不把假产物写进仓库。不设就是仓库根，行为和普通构建器一致。
const ROOT = path.resolve(process.env.WIZARD_ROOT || path.join(HERE, '..'));

export const SRC = 'wizard/index.src.html';
export const OUT = 'wizard/index.html';
export const SIZE_LIMIT = 900 * 1024;

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};

const kb = (n) => (n / 1024).toFixed(1) + 'KB';
const pad2 = (n) => String(Math.floor(Math.abs(Number(n)))).padStart(2, '0');
const toPosix = (p) => p.split(path.sep).join('/');

/* ── 标记与扩展名 ───────────────────────────────────────── */

/**
 * 标记必须独占一行（允许行首缩进、行尾空白、CRLF 的 \r）。
 * 为什么用 ^…$ 锚定整行：防止把正文里「提到标记写法」的文档字符串也替换掉 ——
 * 替换错位置比不替换更难查，宁可要求写法严格。
 */
export const MARKER_RE = /^[ \t]*<!--@inline:([^\r\n]*?)-->[ \t]*\r?$/gm;

/** 扩展名决定包裹方式：这是契约，不猜内容 */
const KIND = {
  '.css': { tag: 'style', label: '样式' },
  '.js': { tag: 'script', label: '脚本' },
  '.txt': { tag: '', label: '片段' },
};

/** 只扫描不替换，用于 --dry 与残标定位（返回行号，便于人去找） */
export function scanMarkers(text) {
  const out = [];
  const re = new RegExp(MARKER_RE.source, 'gm');
  let m;
  while ((m = re.exec(text))) {
    out.push({ raw: m[0], spec: m[1], line: text.slice(0, m.index).split('\n').length });
  }
  return out;
}

/**
 * 把标记里的路径解析成 ROOT 内的绝对路径；越界直接抛错。
 * 「必须仍在 ROOT 内」是硬约束：内联可以把任意本地文件烧进产物，
 * 构建期不拦，产物里就会出现本该在 ROOT 之外的东西。
 */
export function resolveInside(root, specRaw) {
  const rel = String(specRaw == null ? '' : specRaw).trim();
  if (!rel) throw new Error('标记里的路径是空的：<!--@inline:-->');
  if (/^[\\/]/.test(rel) || /^[A-Za-z]:/.test(rel)) {
    throw new Error('标记里只能写「相对 ROOT 的路径」，不要写绝对路径：' + rel);
  }
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (!back || back === '..' || back.startsWith('..' + path.sep) || path.isAbsolute(back)) {
    throw new Error('内联路径越出 ROOT，已拦下：' + rel + '（解析为 ' + abs + '）');
  }
  return { abs, rel: toPosix(back) };
}

/**
 * 源指纹：mtime 毫秒值的 sha1 前 8 位。
 * 为什么哈希一个时间戳而不是文件内容：产物头是给人看的，8 位十六进制既能把
 * 「这份产物是拿哪一版源构建的」标出来，又不会把一长串数字糊满注释；
 * 正文本身由 --check 逐行比对，不靠指纹兜底。
 */
export const stampOf = (mtimeMs) => crypto
  .createHash('sha1')
  .update(String(Math.round(Number(mtimeMs) || 0)))
  .digest('hex')
  .slice(0, 8);

/** 默认读文件：返回 { text, bytes, mtimeMs }。bytes 取 stat.size（真实字节，不是字符数） */
function fsRead(abs) {
  const st = fs.statSync(abs);
  return { text: fs.readFileSync(abs, 'utf8'), bytes: st.size, mtimeMs: st.mtimeMs };
}

/* ── 核心：内联（纯函数，可注入 readFile） ───────────────── */

/**
 * inline(srcText, { root, readFile }) → { text, files, markers }
 *
 * @param {string} srcText 源 HTML 全文
 * @param {{root?:string, readFile?:(abs:string)=>{text:string,bytes?:number,mtimeMs?:number}|string}} opts
 * @returns {{text:string, markers:number, files:Array<{rel:string,bytes:number,mtimeMs:number,stamp:string,ext:string,kind:string,count:number}>}}
 */
export function inline(srcText, { root = ROOT, readFile = fsRead } = {}) {
  if (typeof srcText !== 'string') throw new Error('inline() 的第一个参数必须是源 HTML 文本');

  const files = [];
  const byAbs = new Map();
  let markers = 0;

  // 回调式 replace：内联内容里若含 $& / $1 这类序列，字符串式 replace 会把它们当替换模式吃掉
  const text = srcText.replace(MARKER_RE, (_raw, specRaw) => {
    markers += 1;
    const { abs, rel } = resolveInside(root, specRaw);
    const ext = path.extname(rel).toLowerCase();
    const kind = KIND[ext];
    if (!kind) {
      throw new Error('不支持的扩展名 ' + (ext || '（无）') + '：' + rel
        + '\n  只认 .css → <style> · .js → <script> · .txt → 原文');
    }

    let entry = byAbs.get(abs);
    if (!entry) {
      let got;
      try {
        got = readFile(abs);
      } catch (err) {
        const why = err && err.code === 'ENOENT' ? '文件不存在' : ((err && err.message) || String(err));
        throw new Error('内联目标读不到：' + rel + '（' + why + '）'
          + '\n  标记里的路径是相对 ROOT 的，不是相对 ' + SRC);
      }
      const body = typeof got === 'string' ? got : String(got && got.text != null ? got.text : '');
      const bytes = got && typeof got === 'object' && Number.isFinite(got.bytes)
        ? got.bytes : Buffer.byteLength(body);
      const mtimeMs = got && typeof got === 'object' ? got.mtimeMs : 0;
      entry = { rel, bytes, mtimeMs, stamp: stampOf(mtimeMs), ext, kind: kind.label, count: 0, body };
      byAbs.set(abs, entry);
      files.push(entry);
    }
    entry.count += 1;

    // 提前闭合是「页面后半段变纯文本」的唯一成因，构建期就必须拦死，不留到浏览器里猜
    if (kind.tag === 'style' && /<\/style/i.test(entry.body)) {
      throw new Error('样式 ' + rel + ' 里出现 </style>，会把 <style> 块提前闭合');
    }
    if (kind.tag === 'script' && /<\/script/i.test(entry.body)) {
      throw new Error('脚本 ' + rel + ' 里出现 </script>，浏览器会提前闭合 <script>；请改写成 <\\/script>');
    }

    return kind.tag ? '<' + kind.tag + '>\n' + entry.body + '\n</' + kind.tag + '>' : entry.body;
  });

  // 一条标记都没有 → 八成是模板没写或者路径写错，不能默默产出「看起来构建成功」的空壳
  if (!markers) throw new Error('源文件里没有任何 <!--@inline:…--> 标记：' + SRC + '（构建中止，避免产出空壳）');
  // 契约：替换后不允许残留任何标记（写法不标准、没独占一行都会落在这里）
  if (text.indexOf('<!--@inline:') >= 0) {
    throw new Error('替换后仍残留 <!--@inline:'
      + '\n  说明有标记没独占一行（行内混了别的字符），或标记写错；标准写法：<!--@inline:wizard/theme.css-->');
  }

  return {
    text,
    markers,
    files: files.map((f) => ({
      rel: f.rel, bytes: f.bytes, mtimeMs: f.mtimeMs,
      stamp: f.stamp, ext: f.ext, kind: f.kind, count: f.count,
    })),
  };
}

/* ── 产物头（生成时间 + 源清单 + 禁手改） ───────────────── */

const HEADER_OPEN = '<!--@wizard-build';
const HEADER_CLOSE = '@wizard-end-->';

// 注释里出现 -- 会让 HTML 注释校验不通过；路径若含 -- 先替换成人眼等价的写法
const safe = (s) => String(s).replace(/--/g, '- -');

/** 本地时区的 ISO（带偏移），比 UTC 好读，也仍可排序 */
export function isoLocal(ts) {
  const d = new Date(ts);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    + sign + pad2(a / 60) + ':' + pad2(a % 60);
}

export function renderHeader({ stemList, fileCount, markers, bodyBytes, now }) {
  const lines = [
    HEADER_OPEN,
    '  ' + OUT + ' · 单文件产物（构建期内联，双击 file:// 可用）',
    '  生成时间：' + isoLocal(now),
    '  源清单（相对 ROOT · 字节 · mtime 的 sha1 前 8 位）：',
  ];
  for (const s of stemList) lines.push('    ' + safe(s.rel) + ' · ' + s.bytes + 'B · ' + s.stamp);
  lines.push('  内联 ' + fileCount + ' 个文件 · ' + markers + ' 处标记 · 正文 ' + bodyBytes + 'B');
  lines.push('  本文件由 tools/build_wizard.mjs 生成，不要手改；改源后重跑：node tools/build_wizard.mjs');
  return lines.join('\n') + '\n' + HEADER_CLOSE + '\n';
}

/**
 * 头放在 DOCTYPE 后面，而不是最前面。
 * 为什么：HTML5 允许注释在 doctype 前（浏览器会忽略），但严格校验会报「doctype 不是首个节点」；
 * 放在 doctype 之后既合规，又不影响任何解析行为。
 */
export function attachHeader(srcText, header) {
  const m = /^(?:\uFEFF)?[ \t]*<!doctype[^>]*>[ \t]*\r?\n/i.exec(srcText);
  if (m) return srcText.slice(0, m[0].length) + header + srcText.slice(m[0].length);
  return header + srcText;
}

/** 取出构建头（含定界） */
export function headerMatch(text) {
  return /<!--@wizard-build\r?\n([\s\S]*?)\r?\n@wizard-end-->/.exec(text);
}

/** 剥掉构建头，得到「可与重新内联结果逐行对比」的正文 */
export function stripHeader(text) {
  const m = headerMatch(text);
  if (!m) return text;
  // 头插进来时自带一个结尾换行，剥的时候要一起剥掉，否则每比一次都多一个空行
  let end = m.index + m[0].length;
  if (text[end] === '\r') end += 1;
  if (text[end] === '\n') end += 1;
  return text.slice(0, m.index) + text.slice(end);
}

/** 从头里解析源清单 → Map<rel, {bytes, stamp}>；没有头返回 null */
export function parseStampList(text) {
  const m = headerMatch(text);
  if (!m) return null;
  const out = new Map();
  const re = /^ {4}(\S+) · (\d+)B · ([0-9a-f]{8})$/gm;
  let x;
  while ((x = re.exec(m[1]))) out.set(x[1], { bytes: Number(x[2]), stamp: x[3] });
  return out;
}

/* ── 渲染整个产物 ─────────────────────────────────────── */

/**
 * renderProduct({ root, readFile, now, srcText, srcMtimeMs }) → { product, files, markers, bodyBytes }
 * srcText / srcMtimeMs 可注入，便于纯函数自测；默认读 ROOT/wizard/index.src.html。
 */
export function renderProduct(opts = {}) {
  const root = opts.root || ROOT;
  const readFile = opts.readFile || fsRead;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  let srcText = opts.srcText;
  let srcBytes = Number.isFinite(opts.srcBytes) ? opts.srcBytes : 0;
  let srcMtimeMs = opts.srcMtimeMs;

  if (typeof srcText !== 'string') {
    const abs = path.join(root, SRC);
    try {
      const st = fs.statSync(abs);
      srcText = fs.readFileSync(abs, 'utf8');
      srcBytes = st.size;
      srcMtimeMs = st.mtimeMs;
    } catch (err) {
      const why = err && err.code === 'ENOENT' ? '文件不存在' : ((err && err.message) || String(err));
      throw new Error('找不到源文件 ' + SRC + '（' + why + '）'
        + '\n  向导页源件可能还没写；构建器不产出半成品，先补源再跑 node tools/build_wizard.mjs');
    }
  }
  if (!Number.isFinite(srcBytes) || !srcBytes) srcBytes = Buffer.byteLength(srcText);
  if (!Number.isFinite(srcMtimeMs)) srcMtimeMs = 0;

  const { text, files, markers } = inline(srcText, { root, readFile });

  const stampList = [{ rel: SRC, bytes: srcBytes, stamp: stampOf(srcMtimeMs) }]
    .concat(files.map((f) => ({ rel: f.rel, bytes: f.bytes, stamp: f.stamp })));

  const bodyBytes = Buffer.byteLength(text);
  const header = renderHeader({ stemList: stampList, fileCount: files.length, markers, bodyBytes, now });
  const product = attachHeader(text, header);

  return { product, files, markers, bodyBytes, header, srcText };
}

/* ── 行级粗 diff ───────────────────────────────────────── */

/**
 * 按行号对齐逐行比较，取前 max 条差异。
 * 为什么不做最长公共子序列：这里的目标是「指出漂移在哪」，不是生成补丁；
 * 插入一行会让后续行号整体偏移（会多报几条），但行号是真的，人可以直接跳过去看。
 */
/**
 * 先用「共同前缀 + 共同后缀」把差异夹到一段区间里。
 * 为什么还要这一手：按行号对齐的粗 diff 在「中间插了几行」时会把后面每一行都报成不同，
 * 人看到的是一屏噪声；先夹区间就能一眼看到「真正改的是 L12 往后这一段」。
 */
export function diffSpan(a, b) {
  const A = String(a).split('\n');
  const B = String(b).split('\n');
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p += 1;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s += 1;
  return { aFrom: p + 1, aTo: A.length - s, bFrom: p + 1, bTo: B.length - s, aLines: A.length, bLines: B.length };
}

export function diffLines(a, b, max = 10) {
  const A = String(a).split('\n');
  const B = String(b).split('\n');
  const out = [];
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n && out.length < max; i += 1) {
    if (A[i] !== B[i]) out.push({ line: i + 1, product: A[i], fresh: B[i] });
  }
  return { diffs: out, productLines: A.length, freshLines: B.length };
}

/* ── CLI ──────────────────────────────────────────────── */
const isMain = (() => {
  try { return path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; }
})();

function fail(msg, code = 1) {
  const lines = String(msg).split('\n');
  console.log(`${C.red}${C.bold}✗${C.reset} ${C.red}${lines[0]}${C.reset}`);
  for (const l of lines.slice(1)) console.log(`  ${C.dim}${l.trim()}${C.reset}`);
  process.exit(code);
}



function doBuild() {
  const t0 = Date.now();
  const r = renderProduct({ root: ROOT });
  const target = path.join(ROOT, OUT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, r.product, 'utf8');
  const ms = Date.now() - t0;
  const bytes = Buffer.byteLength(r.product);

  console.log(`${C.cyan}▸${C.reset} ${C.bold}向导页构建${C.reset} ${C.dim}${SRC} → ${OUT}${C.reset}`);
  for (const f of r.files) {
    console.log(`  ${C.dim}·${C.reset} ${f.rel.padEnd(24, ' ')} ${C.dim}${f.kind} ${kb(f.bytes)} · ${f.count} 处 · ${f.stamp}${C.reset}`);
  }
  // 末行以「写入」开头：build_all.mjs 会跳过以「写入」开头的行，避免同一句话打两遍
  console.log(`写入 ${OUT}  ${C.dim}${kb(bytes)}（${bytes}B） · 内联 ${r.files.length} 个文件 · ${r.markers} 处标记 · ${ms}ms${C.reset}`);
  if (bytes >= SIZE_LIMIT) {
    console.log(`  ${C.yellow}提醒：${kb(bytes)} 已超 ${kb(SIZE_LIMIT)} 守门线，八成是有人塞了图片${C.reset}`);
  }
}

function doDry() {
  const srcAbs = path.join(ROOT, SRC);
  if (!fs.existsSync(srcAbs)) {
    fail('找不到源文件 ' + SRC
      + '\n  向导页源件可能还没写；--dry 也需要它才能列出标记。构建器不猜内容。');
  }
  const srcText = fs.readFileSync(srcAbs, 'utf8');
  const marks = scanMarkers(srcText);
  if (!marks.length) fail('源文件里没有 <!--@inline:…--> 标记：' + SRC);

  const order = [];
  const byAbs = new Map();
  for (const m of marks) {
    const { abs, rel: r } = resolveInside(ROOT, m.spec); // 越界在这里就炸，别等到写盘
    if (!byAbs.has(abs)) {
      byAbs.set(abs, { rel: r, ext: path.extname(r).toLowerCase(), hits: [] });
      order.push(abs);
    }
    byAbs.get(abs).hits.push(m.line);
  }

  console.log(`${C.cyan}▸${C.reset} ${C.bold}向导页构建 · 预演（不写盘）${C.reset} ${C.dim}${SRC}${C.reset}`);
  let missing = 0;
  for (const abs of order) {
    const e = byAbs.get(abs);
    const kind = KIND[e.ext];
    let note;
    if (!kind) {
      note = `${C.red}不支持的扩展名 ${e.ext || '（无）'}${C.reset}`;
      missing += 1;
    } else if (!fs.existsSync(abs)) {
      note = `${C.red}缺失${C.reset}`;
      missing += 1;
    } else {
      const st = fs.statSync(abs);
      note = `${C.dim}${kind.label} ${kb(st.size)} · ${e.hits.length} 处 · L${e.hits.join(',')}${C.reset}`;
    }
    console.log(`  ${C.dim}·${C.reset} ${e.rel.padEnd(24, ' ')} ${note}`);
  }
  console.log(`${C.dim}合计 标记 ${marks.length} 处 → 文件 ${order.length} 个${C.reset}`);
  if (missing) {
    console.log(`${C.yellow}${C.bold}有 ${missing} 个目标不可用${C.reset} ${C.dim}（真构建会以退出码 1 中止）${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}清单可用${C.reset} ${C.dim}→ 现在可以跑 node tools/build_wizard.mjs${C.reset}`);
}

function doCheck() {
  const target = path.join(ROOT, OUT);
  if (!fs.existsSync(target)) {
    fail('产物不存在：' + OUT + '\n  先跑 node tools/build_wizard.mjs，再校验', 2);
  }
  const product = fs.readFileSync(target, 'utf8');
  const fresh = renderProduct({ root: ROOT }); // 源缺失/越界 → 抛错，外层按 1 退

  const bodyA = stripHeader(product);
  const bodyB = stripHeader(fresh.product);
  const stampA = parseStampList(product);
  const stampB = parseStampList(fresh.product);

  const bodySame = bodyA === bodyB;
  const rels = new Set([...(stampA ? stampA.keys() : []), ...(stampB ? stampB.keys() : [])]);
  const stampDiff = [];
  for (const r of rels) {
    const a = stampA ? stampA.get(r) : undefined;
    const b = stampB ? stampB.get(r) : undefined;
    if (!a) stampDiff.push({ rel: r, from: '（产物里没有）', to: b ? b.stamp : '?', why: '产物头缺这一项' });
    else if (!b) stampDiff.push({ rel: r, from: a.stamp, to: '（源已移除）', why: '源清单里没有这一项' });
    else if (a.stamp !== b.stamp) stampDiff.push({ rel: r, from: a.stamp, to: b.stamp, why: '源文件被重新保存/改过' });
  }
  const stampSame = !!stampA && !!stampB && stampDiff.length === 0;

  if (bodySame && stampSame) {
    console.log(`${C.green}${C.bold}产物与源一致${C.reset} ${C.dim}${OUT} · 内联 ${fresh.files.length} 个文件 · ${fresh.markers} 处标记 · ${kb(Buffer.byteLength(product))}${C.reset}`);
    return;
  }

  console.log(`${C.red}${C.bold}✗ 产物与源漂移${C.reset} ${C.dim}${OUT}${C.reset}`);
  if (!stampA) {
    console.log(`  ${C.red}·${C.reset} 产物里没有构建头（被手改过或被别的工具覆写过）`);
  }
  for (const d of stampDiff.slice(0, 10)) {
    console.log(`  ${C.yellow}·${C.reset} ${d.rel.padEnd(24, ' ')} ${C.dim}${d.from} → ${d.to}（${d.why}）${C.reset}`);
  }
  if (bodySame) {
    console.log(`  ${C.dim}正文一致，只是头部源指纹过期；重跑构建即可对齐。${C.reset}`);
    process.exit(2);
  }

  const d = diffLines(bodyA, bodyB, 10);
  const sp = diffSpan(bodyA, bodyB);
  const spanA = sp.aTo >= sp.aFrom ? `L${sp.aFrom}–L${sp.aTo}` : `L${sp.aFrom} 前插入`;
  const spanB = sp.bTo >= sp.bFrom ? `L${sp.bFrom}–L${sp.bTo}` : `L${sp.bFrom} 前插入`;
  console.log(`  ${C.dim}正文 ${d.productLines} 行 vs 重新内联 ${d.freshLines} 行 · 改动夹在：产物 ${spanA} ↔ 重内联 ${spanB}${C.reset}`);
  console.log(`  ${C.dim}逐行差异（按行号对齐，取前 ${d.diffs.length} 条）：${C.reset}`);
  for (const x of d.diffs) {
    console.log(`    ${C.cyan}L${x.line}${C.reset} ${C.dim}产物${C.reset}   ${x.product.slice(0, 120)}`);
    console.log(`    ${C.cyan}L${x.line}${C.reset} ${C.dim}重内联${C.reset} ${x.fresh.slice(0, 120)}`);
  }
  if (!d.diffs.length) {
    console.log(`    ${C.dim}（差异只在长度：一侧多出 ${Math.abs(d.productLines - d.freshLines)} 行尾部内容）${C.reset}`);
  }
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const known = new Set(['--check', '--dry', '--help', '-h']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) {
    fail('未知参数：' + unknown.join(' ') + '\n  用法：node tools/build_wizard.mjs [--check | --dry]');
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`${C.bold}build_wizard.mjs${C.reset} ${C.dim}${SRC} → ${OUT}${C.reset}`);
    console.log('  （无参数）  正常构建并写盘');
    console.log('  --check     只校验；一致 0 · 漂移 2 · 源缺失等错误 1');
    console.log('  --dry       只打印将要内联的清单，不写盘');
    return;
  }
  try {
    // --check 自己决定退出码（0 一致 / 2 漂移），build 与 dry 成功即 0
    if (argv.includes('--check')) doCheck();
    else if (argv.includes('--dry')) doDry();
    else doBuild();
  } catch (err) {
    fail((err && err.message) || String(err));
  }
}

if (isMain) main();