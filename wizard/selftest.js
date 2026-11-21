/**
 * wizard/selftest.js —— 小白模式的验收脚本（Node 侧，无浏览器）
 *
 * 为什么需要它：小白模式的全部价值是「流程不卡人」，而流程是跨文件的
 * （HTML 结构 + 7 个风格 + 5 阶段文案 + 主控状态机 + 构建产物）。
 * 任何一处单独改坏，页面都不会报错——只会让用户点着点着停在半路。
 * 所以这里用「静态断言 + 产物一致性」把最容易断的契约钉住：
 *   1. 五屏结构齐全，且每屏只有一个主标题（一屏一件事）
 *   2. 七个风格 id、五阶段文案、等待时长文案都在
 *   3. 自动跳步 / 自动保存 / 换种子 / 复用参数字样都在主控里
 *   4. 构建产物与源一致（改了 src 忘记构建 = 用户看到的还是旧页面）
 *   5. 无外链、无运行时本地 JSON 读取（file:// 双击必须能开）
 *
 * 跑法：node wizard/selftest.js   （成功打印「全部通过 · N 项」，退出码 0）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
const fails = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  \u2713 ' + name); return true; }
  fails.push(name + (detail ? ' — ' + detail : ''));
  console.log('  \u00d7 ' + name + (detail ? ' — ' + detail : ''));
  return false;
}

function read(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch (e) { return null; }
}

console.log('小白模式 · 验收');

/* ── 1. 风格真相源 ─────────────────────────────────────────────────────── */
const styles = require(path.join(ROOT, 'wizard', 'styles.js'));
const list = styles.STYLES || [];
const ids = ['cinematic', 'photo', 'anime', 'guofeng', 'cyberpunk', 'dark', 'fantasy'];
ok('7 个风格都在', list.length === 7, '实际 ' + list.length);
ok('风格 id 与规格一致', ids.every((id) => list.some((s) => s.id === id)), '缺 ' + ids.filter((id) => !list.some((s) => s.id === id)).join(','));
ok('每个风格有中文名', list.every((s) => s.label && /[\u4e00-\u9fa5]/.test(s.label)));
ok('每个风格至少 1 句示例', list.every((s) => Array.isArray(s.examples) && s.examples.length >= 1));
ok('示例是人话（不含提示词术语）', list.every((s) => s.examples.every((t) => !/(景深|体积光|赛博|token|prompt|4k|8k|提示词)/i.test(t))));
ok('每个风格有内联 SVG 缩略图', list.every((s) => typeof s.thumb === 'string' && s.thumb.indexOf('<svg') === 0));
ok('缩略图不引外部图片', list.every((s) => !/<image|xlink:href="https?:|url\(https?:|src="https?:/.test(s.thumb)));
ok('五阶段文案 5 条', (styles.STAGES || []).length === 5);
ok('第三步提示语非空', (styles.TIPS || []).length >= 1);

/* ── 2. 页面结构（源件） ────────────────────────────────────────────────── */
const src = read('wizard/index.src.html');
if (!ok('wizard/index.src.html 存在', !!src)) {
  console.log('\n失败 ' + fails.length + ' 项');
  process.exit(1);
}

ok('五个屏幕都在', [1, 2, 3, 4, 5].every((n) => src.indexOf('id="screen-' + n + '"') >= 0));
ok('每屏一个 h1 主标题', (src.match(/<h1/g) || []).length === 5, '实际 ' + (src.match(/<h1/g) || []).length + ' 个');
ok('第一步标题写明「第一步：选一种风格」', src.indexOf('第一步：选一种风格') >= 0);
ok('第二步标题写明「用一句话描述」', /第二步：用一句话描述/.test(src));
ok('第三步标题在', /第三步/.test(src));
ok('第四步标题在', /第四步/.test(src));
ok('第五步标题在', /第五步/.test(src));

const mustIds = ['styles', 'prompt', 'btn-generate', 'stage-list', 'player', 'video', 'previewCanvas', 'ringBar', 'library', 'toasts', 'advanced', 'chips', 'tip', 'pct'];
ok('关键 DOM 锚点齐全', mustIds.every((id) => src.indexOf('id="' + id + '"') >= 0), '缺 ' + mustIds.filter((id) => src.indexOf('id="' + id + '"') < 0).join(','));
ok('等待时长文案「约 30~60 秒」', /30~60\s*秒/.test(src));
ok('258 参数彩蛋文案在', src.indexOf('258 个参数') >= 0);
ok('三个结果按钮文案齐全', /满意，保存/.test(src) && /换一版/.test(src) && /手动调整/.test(src));
ok('输入框绑定自动聚焦', /id="prompt"[^>]*autofocus/.test(src) || /autofocus[^>]*id="prompt"/.test(src));
ok('六段内联标记齐全', ['theme.css', 'styles.js', 'engine.js', 'library.js', 'onboard.js', 'wizard.js'].every((f) => src.indexOf('@inline:wizard/' + f) >= 0));

/* ── 3. 主控逻辑（grep 级契约） ─────────────────────────────────────────── */
const js = read('wizard/wizard.js') || '';
ok('主控可读', js.length > 2000);
ok('选完风格自动进第二步', /setTimeout\(function \(\) \{[\s\S]{0,220}go\(2\)/.test(js));
ok('自动保存到作品库', js.indexOf('libSave') >= 0 && js.indexOf('自动') >= 0);
ok('换一版换种子', /state\.seed = randSeed\(\)/.test(js));
ok('种子可控（手动调整面板）', js.indexOf('adv-seed') >= 0);
ok('作品库支持复用风格', js.indexOf('reuseStyle') >= 0);
ok('作品库支持下载', js.indexOf('downloadWork') >= 0);
ok('新手引导存储键正确', js.indexOf('avp.wizard.onboarded') >= 0);
ok('Ctrl+Enter 可直接生成', /ctrlKey/.test(js) && /Enter/.test(js));
ok('后端在线时并行提交任务', js.indexOf('/api/jobs') >= 0);
ok('后端不可用时降级而不是报错', /\.catch\(function \(\) \{[\s\S]{0,80}return false; \}\)/.test(js));

/* ── 4. 构建产物体检 ───────────────────────────────────────────────────── */
const out = read('wizard/index.html');
ok('产物 wizard/index.html 已构建', !!out);
if (out) {
  ok('产物无 @inline 残留', out.indexOf('<!--@inline:') < 0);
  ok('产物无外链资源', !/(src|href)\s*=\s*["']https?:/i.test(out) && !/url\(\s*['"]?https?:/i.test(out));
  ok('产物内联了风格卡片骨架', out.indexOf('style-card') >= 0 && out.indexOf('data-style') >= 0);
  ok('产物含新手引导样式类', out.indexOf('.onboard') >= 0);
  ok('产物体积在守门内（< 900KB）', Buffer.byteLength(out) < 900 * 1024, (Buffer.byteLength(out) / 1024).toFixed(0) + 'KB');
}

const chk = spawnSync(process.execPath, [path.join('tools', 'build_wizard.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
const chkOut = ((chk.stdout || '') + (chk.stderr || '')).trim();
ok('产物与源一致（--check）', chk.status === 0, chkOut.split(/\r?\n/).slice(-3).join(' | '));

/* ── 5. 旁路模块可加载（存在即断言 API） ───────────────────────────────── */
for (const [file, api] of [
  ['wizard/engine.js', (m) => typeof m.record === 'function' && typeof m.createRenderer === 'function'],
  ['wizard/library.js', (m) => typeof m.save === 'function' && typeof m.list === 'function'],
  ['wizard/onboard.js', (m) => typeof m.create === 'function'],
]) {
  let mod = null;
  try { mod = require(path.join(ROOT, file)); } catch (e) { mod = null; }
  if (mod) ok(path.basename(file) + ' 可加载且 API 正确', api(mod), Object.keys(mod).slice(0, 8).join(','));
  else ok(path.basename(file) + ' 可加载', false, '文件缺失或加载抛错');
}

/* ── 结论 ─────────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
  console.log('\n失败 ' + fails.length + ' 项 / 共 ' + total + ' 项');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('\n全部通过 · ' + total + ' 项');