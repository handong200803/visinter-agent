/**
 * build.mjs —— 把 spec/*.json + core/engine.js 内联进 web/params.src.html，产出可双击打开的单文件。
 *
 * 为什么内联而不是 fetch：
 *   单文件 HTML 用 file:// 打开时 fetch 本地 JSON 会被 CORS 拦，双击即开是这个项目的硬要求。
 *   生成物 web/params.html 是纯静态产物，改参数请改 spec/ 或 gen_registry，然后重跑本文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readByok = () => { try { return fs.readFileSync(path.join(ROOT, 'web', 'byok.src.js'), 'utf8'); } catch { return ''; } };

const engine = read('core/engine.js');
const registry = read('spec/params.registry.json');
const catalog = read('spec/models.catalog.json');
const rules = read('spec/rules.linkage.json');
const muse = read('spec/muse.presets.json');
const models = read('spec/model.configs.json');
const aesthetics = read('spec/aesthetics.json');
const src = read('web/params.src.html');
const tokens = read('ui/tokens.css');
const skin = read('ui/glass-skin.css');

if (/<\/script/i.test(engine + registry + catalog + rules + muse + models + aesthetics)) {
  throw new Error('内联数据里出现 </script>，会截断页面');
}

const data = [
  'window.__REG = ' + registry.trim() + ';',
  'window.__CATALOG = ' + catalog.trim() + ';',
  'window.__RULES = ' + rules.trim() + ';',
  // Muse 数据压成单行：风格 emoji 只允许存在于这一行（lint 的 data-emoji-ok/__MUSE 豁免口径）
  'window.__MUSE = ' + JSON.stringify(JSON.parse(muse)) + ';',
  'window.__MODELS = ' + JSON.stringify(JSON.parse(models)) + ';',
  'window.__AESTH = ' + JSON.stringify(JSON.parse(aesthetics)) + ';',
].join('\n');

const out = src
  .replace('/*__TOKENS__*/', () => tokens)
  .replace('/*__SKIN__*/', () => skin)
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__DATA__*/', () => data);

if (/\/\*__(TOKENS|SKIN|ENGINE|DATA)__\*\//.test(out)) throw new Error('产物里仍有未填占位符');

const target = path.join(ROOT, 'web', 'params.html');
  // BYOK 模块内联（Key 永不写进产物：这里只内联代码，不含任何凭据）
  // out 是 const：BYOK 内联用新变量承接（函数形态替换，避免 $' 被当成替换模式）
  const outFinal = (typeof out === 'string' && out.indexOf('/*__BYOK__*/') >= 0) ? out.replace('/*__BYOK__*/', () => readByok()) : out;
fs.writeFileSync(target, outFinal, 'utf8');
const kb = (n) => (n / 1024).toFixed(0) + 'KB';
console.log(`写入 ${target}  ${kb(Buffer.byteLength(out))}（注册表 ${kb(Buffer.byteLength(registry))} / 引擎 ${kb(Buffer.byteLength(engine))}）`);
console.log(`参数 ${JSON.parse(registry).counts.total} 个 · 板块 ${JSON.parse(registry).stages.length} 个 · 规则 ${JSON.parse(rules).rules.length} 条`);