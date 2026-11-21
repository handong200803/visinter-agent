/**
 * build_canvas.mjs —— 把 spec/*.json + core/engine.js 内联进 canvas/canvas.src.html，
 * 产出 canvas/canvas.html（单文件，双击 file:// 直接能开）。
 *
 * 为什么和 core/build.mjs 一个套路：
 *   file:// 下 fetch 本地 JSON 会被 CORS 拦死，所以数据必须在构建时写进 HTML；
 *   共用同一份 spec/ 与同一个 engine.js，画布和参数面板的估算口径才不会漂。
 *
 * 跑法：node tools/build_canvas.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const engine = read('core/engine.js');
const registry = read('spec/params.registry.json');
const catalog = read('spec/models.catalog.json');
const rules = read('spec/rules.linkage.json');
const src = read('canvas/canvas.src.html');
const tokens = read('ui/tokens.css');
const skin = read('ui/glass-skin.css');

// 内联数据里若出现 </script，浏览器会提前闭合脚本块，页面直接烂掉
if (/<\/script/i.test(engine + registry + catalog + rules)) {
  throw new Error('内联数据里出现 </script>，会截断页面');
}

const data = [
  'window.__REG = ' + registry.trim() + ';',
  'window.__CATALOG = ' + catalog.trim() + ';',
  'window.__RULES = ' + rules.trim() + ';',
].join('\n');

for (const marker of ['/*__ENGINE__*/', '/*__DATA__*/', '/*__TOKENS__*/', '/*__SKIN__*/']) {
  if (!src.includes(marker)) throw new Error('源文件缺少占位符 ' + marker);
}

// 用函数式 replace：数据里若含 $& / $1 这类序列，字符串式 replace 会把它们当替换模式吃掉
const out = src
  .replace('/*__TOKENS__*/', () => tokens)
  .replace('/*__SKIN__*/', () => skin)
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__DATA__*/', () => data);

if (out.includes('/*__APP_JS__*/')) throw new Error('canvas.src.html 里还有未填的 /*__APP_JS__*/ 占位');

const target = path.join(ROOT, 'canvas', 'canvas.html');
fs.writeFileSync(target, out, 'utf8');

const kb = (n) => (n / 1024).toFixed(0) + 'KB';
const reg = JSON.parse(registry);
console.log(`写入 ${path.relative(ROOT, target)}  ${kb(Buffer.byteLength(out))}`);
console.log(`  内联：引擎 ${kb(Buffer.byteLength(engine))} · 注册表 ${kb(Buffer.byteLength(registry))} · 模型目录 ${kb(Buffer.byteLength(catalog))} · 规则 ${kb(Buffer.byteLength(rules))}`);
console.log(`  参数 ${reg.counts.total} 个（L3 ${reg.counts.l3} / L4 ${reg.counts.l4}）· 板块 ${reg.stages.length} 个 · 联动规则 ${JSON.parse(rules).rules.length} 条`);