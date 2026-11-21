/**
 * build_app.mjs —— 把 engine + state.js + spec/*.json 内联进 app/index.src.html，
 * 产出单文件 app/index.html（双击 file:// 即开）。
 *
 * 为什么仍然要内联，而不是让页面去 fetch：
 *   file:// 下 fetch 相对路径的 JSON 属于跨源请求，浏览器直接拒；
 *   三个 spec 加起来 120KB，内联的代价只是文件大一点，换来的是"双击必开"。
 *   所以把"能不能跑"从运行时赌运气，变成构建时的静态保证。
 *
 * 为什么构建时要断言"参数 258"：
 *   外壳的 SSoT 是 spec/params.registry.json。构建产物里出现这个数字，
 *   说明注册表真的被读进来了，而不是占位符替换失败留下一个空对象。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readByok = () => { try { return fs.readFileSync(path.join(ROOT, 'web', 'byok.src.js'), 'utf8'); } catch { return ''; } };
const kb = (n) => (n / 1024).toFixed(0) + 'KB';

const F = {
  src: 'app/index.src.html',
  engine: 'core/engine.js',
  state: 'app/state.js',
  registry: 'spec/params.registry.json',
  catalog: 'spec/models.catalog.json',
  rules: 'spec/rules.linkage.json',
  styles: 'prompt/styles.json',
  tokens: 'ui/tokens.css',
  skin: 'ui/glass-skin.css',
};

for (const k of Object.keys(F)) {
  const abs = path.join(ROOT, F[k]);
  if (!fs.existsSync(abs)) throw new Error('缺少输入文件：' + F[k] + '（构建中止，避免产出半成品）');
}

const src = read(F.src);
const engine = read(F.engine);
const state = read(F.state);
const registry = read(F.registry);
const catalog = read(F.catalog);
const rules = read(F.rules);
const styles = read(F.styles);
const tokens = read(F.tokens);
const skin = read(F.skin);
for (const style of JSON.parse(styles).styles) {
  if (!style.card || !style.card.cover) continue;
  const file = path.resolve(ROOT, 'app', style.card.cover);
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
    throw new Error('缺少风格封面资源：' + style.card.cover + '；请保留完整项目目录，不要只复制HTML');
  }
}

// JSON 里若出现 </script，内联会把 script 提前闭合，页面后半段变成纯文本。
// 这不是"大概不会发生"，所以直接拦在构建期。
const inlinePayload = engine + state + registry + catalog + rules + styles;
if (/<\/script/i.test(inlinePayload)) {
  throw new Error('内联内容里出现 </script>，会截断页面；请先在源文件里转义');
}

const data = [
  '/* 内联资产：注册表 / 设备与模型目录 / 联动规则。改这些请改 spec/ 再重跑构建。 */',
  'window.__REG = ' + registry.trim() + ';',
  'window.__CATALOG = ' + catalog.trim() + ';',
  'window.__RULES = ' + rules.trim() + ';',
  'window.__STYLES = ' + styles.trim() + ';',
].join('\n');

let out = src;
for (const [token, body] of [['/*__TOKENS__*/', tokens], ['/*__SKIN__*/', skin], ['/*__ENGINE__*/', engine], ['/*__STATE__*/', state], ['/*__DATA__*/', data]]) {
  if (out.indexOf(token) < 0) throw new Error('源件里找不到占位符 ' + token + '，请检查 app/index.src.html');
  // 用函数形式替换：避免 $& $1 之类被 String.replace 当成替换模式解释
  out = out.replace(token, () => body);
}

// 产物自检：占位符必须清空，三份数据必须在，参数总数必须对得上
for (const token of ['/*__TOKENS__*/', '/*__SKIN__*/', '/*__ENGINE__*/', '/*__STATE__*/', '/*__DATA__*/']) {
  if (out.indexOf(token) >= 0) throw new Error('占位符未被替换：' + token);
}
if (out.indexOf('--amb-core') < 0 || out.indexOf('.glass-card') < 0) {
  throw new Error('产物里缺 tokens.css 的环境光晕变量或玻璃通用类，样式通道没接上');
}
const reg = JSON.parse(registry);
const cat = JSON.parse(catalog);
const rl = JSON.parse(rules);
if (out.indexOf('window.__REG') < 0 || out.indexOf('window.__CATALOG') < 0 || out.indexOf('window.__RULES') < 0 || out.indexOf('window.__STYLES') < 0) {
  throw new Error('产物里缺少内联资产全局变量');
}
if (out.indexOf('window.AVP') < 0 || out.indexOf('window.AVP_STATE') < 0) {
  throw new Error('产物里缺少 engine 或状态机的浏览器挂载');
}
const expectStamp = '参数 ' + reg.counts.total + ' 个';
if (out.indexOf(expectStamp) < 0) {
  throw new Error('产物里没有静态文案「' + expectStamp + '」，首屏统计与注册表对不上');
}

const target = path.join(ROOT, 'app', 'index.html');
  // BYOK 模块内联（Key 永不写进产物：这里只内联代码，不含任何凭据）
  if (typeof out === 'string' && out.indexOf('/*__BYOK__*/') >= 0) out = out.replace('/*__BYOK__*/', () => readByok());   // 用函数形态：byok 代码里有 $' 等字符，字符串形态会被当替换模式
fs.writeFileSync(target, out, 'utf8');

const size = Buffer.byteLength(out);
console.log('写入 ' + path.relative(ROOT, target).replace(/\\/g, '/') + '  ' + kb(size));
console.log('  内联：styles ' + kb(Buffer.byteLength(styles)) + ' · engine ' + kb(Buffer.byteLength(engine)) + ' · state ' + kb(Buffer.byteLength(state))
  + ' · 注册表 ' + kb(Buffer.byteLength(registry)) + ' · 目录 ' + kb(Buffer.byteLength(catalog)) + ' · 规则 ' + kb(Buffer.byteLength(rules)));
console.log('  口径：参数 ' + reg.counts.total + ' 个 · 板块 ' + reg.stages.length + ' 个 · 规则 ' + rl.rules.length
  + ' 条 · 设备档 ' + cat.devices.length + ' 个 · 注册表 v' + reg.version);
console.log('  体积 ' + (size < 480 * 1024 ? 'OK（< 480KB）' : '超限（≥ 480KB）') + ' · 外链 http(s) 资源 '
  + ((/(src|href)\s*=\s*["']https?:|url\(\s*["']?https?:/i.test(out)) ? '存在（需清理）' : '0 处'));