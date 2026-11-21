/**
 * build_inspector.mjs —— 把 ui/tokens.css 与 ui/glass-skin.css 内联进 inspector/index.src.html，
 * 产出单文件 inspector/index.html（file:// 双击即开，无外链）。
 *
 * 为什么 inspector 也要走构建：
 *   它是「界面视觉验收台」的活样本，必须和七个界面吃同一份令牌与同一层玻璃映射，
 *   否则验收台自己先漂移，截图对照就没有意义。
 *   手改产物会让下一次重跑把它冲掉，所以真源是 index.src.html。
 *
 * 跑法：node tools/build_inspector.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SRC = 'inspector/index.src.html';
const OUT = 'inspector/index.html';
const tokens = read('ui/tokens.css');
const skin = read('ui/glass-skin.css');

const src = read(SRC);
for (const marker of ['/*__TOKENS__*/', '/*__SKIN__*/']) {
  if (!src.includes(marker)) throw new Error(`${SRC} 缺少占位符 ${marker}`);
}

const out = src
  .replace('/*__TOKENS__*/', () => tokens)
  .replace('/*__SKIN__*/', () => skin);

if (/\/\*__(TOKENS|SKIN)__\*\//.test(out)) throw new Error('产物里仍有未填占位符');
if (!out.includes('--amb-core') || !out.includes('.glass-card')) {
  throw new Error('产物里缺环境光晕变量或玻璃通用类，样式通道没接上');
}

const target = path.join(ROOT, OUT);
fs.writeFileSync(target, out, 'utf8');
console.log(`写入 ${OUT}  ${(Buffer.byteLength(out) / 1024).toFixed(0)}KB`);