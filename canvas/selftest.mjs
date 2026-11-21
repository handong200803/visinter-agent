/**
 * canvas/selftest.mjs —— 画布产物验收
 *
 * 为什么不跑浏览器：
 *   这个模块的失败模式几乎都是「构建漏了 / 数据没内联 / 视图被删了 / 混进外链」，
 *   全部可以在产物的静态文本上判定。起一个无头浏览器只能证明「能开」，证明不了这些。
 *   真交互回归靠人工双击（见 docs/03-canvas.md 的验收清单）。
 *
 * 判定口径：
 *   断言的是「契约」，不是「实现细节」——例如不检查某个函数怎么写，只要求
 *   三视图 DOM 锚点、注册表口径、引擎调用、零外链这四类必须在场。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'canvas/canvas.html');
const SRC = path.join(ROOT, 'canvas/canvas.src.html');
const BUILD = path.join(ROOT, 'tools/build_canvas.mjs');

let pass = 0, fail = 0;
const ok = (cond, msg, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${detail !== undefined ? `  → ${detail}` : ''}`); }
};
const has = (s, n) => s.includes(n);
const count = (s, n) => s.split(n).length - 1;

console.log('── 产物与源件 ──');
ok(fs.existsSync(SRC), 'canvas.src.html 存在');
ok(fs.existsSync(OUT), 'canvas.html 存在');
ok(fs.existsSync(BUILD), 'tools/build_canvas.mjs 存在');

const html = fs.readFileSync(OUT, 'utf8');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/params.registry.json'), 'utf8'));
const kb = Buffer.byteLength(html) / 1024;
const srcMtime = fs.statSync(SRC).mtimeMs;
const outMtime = fs.statSync(OUT).mtimeMs;
ok(outMtime >= srcMtime, `产物不落后于源件（产物 ${new Date(outMtime).toLocaleTimeString('zh-CN')}）`);

console.log('\n── 单文件可交付（双击 file:// 可用） ──');
ok(has(html, 'window.__REG'), '内联 window.__REG');
ok(has(html, 'window.__CATALOG'), '内联 window.__CATALOG');
ok(has(html, 'window.__RULES'), '内联 window.__RULES');
ok(!has(html, '/*__ENGINE__*/') && !has(html, '/*__DATA__*/'), '构建占位符已全部替换');
ok(has(html, 'root.AVP = api') && has(html, 'module.exports'), '内联的是真 engine（未缩水重写）');
ok(!/src\s*=\s*"https?:/i.test(html) && !/href\s*=\s*"https?:/i.test(html) && !/@import\s+url\(\s*https?:/i.test(html),
  '零外链 http(s) 资源');
ok(kb < 400, `体积 ${kb.toFixed(1)}KB < 400KB`);

console.log('\n── 注册表口径（唯一真相源） ──');
// 注意：注册表里每个 stage 也有自己的 total（该板块参数数），所以不能取第一个匹配，
// 必须精确要求顶层 counts.total 这个数值在场。
const topTotal = `"total": ${reg.counts.total}`;
ok(has(html, topTotal), `内联顶层 counts.total = ${reg.counts.total}`, '未找到顶层计数');
ok(count(html, topTotal) >= 1 && reg.params.length === reg.counts.total,
  `注册表自洽：params.length ${reg.params.length} == counts.total ${reg.counts.total}`);
ok(reg.counts.total >= 200, `参数规模 ${reg.counts.total} 个（≥200）`);
const stageIds = reg.stages.map((s) => s.id);
const missingStage = stageIds.filter((id) => !has(html, id));
ok(missingStage.length === 0, `7 个板块 id 全部出现（${stageIds.join('/')}）`, missingStage.join(','));
ok(has(html, 'REG.stages') && has(html, 'REG.params') && has(html, 'REG.counts'),
  '表单由注册表驱动渲染（非硬编码）');

console.log('\n── 三视图同源 ──');
for (const v of ['wizard', 'params', 'nodes']) {
  ok(has(html, `id="view-${v}"`), `视图容器 #view-${v}`);
}
ok(has(html, 'id="viewSwitch"'), '视图切换器 #viewSwitch');
ok(count(html, 'data-view=') >= 3, `切换按钮 ${count(html, 'data-view=')} 个（≥3）`);
ok(has(html, `setView('wizard')`) && has(html, `setView('params')`) && has(html, `setView('nodes')`),
  '键盘 1/2/3 映射到三视图');
ok(has(html, 'class="view on"'), '默认视图显式标记（首屏不空白）');

console.log('\n── 关键控件 ──');
const controls = [
  ['id="estimator"', '实时估算面板'],
  ['id="nodeCanvas"', '节点画布'],
  ['id="paramList"', '参数表单容器'],
  ['id="wSteps"', '向导步骤'],
  ['id="presets"', '档位/预设入口'],
  ['id="exportBtn"', '导出预设'],
  ['id="importBtn"', '导入预设'],
  ['id="device"', '设备档选择'],
  ['id="expertFold"', '专家参数折叠'],
];
for (const [needle, label] of controls) ok(has(html, needle), label);

console.log('\n── 节点图是真实现（Canvas2D，不是 DOM 拼图） ──');
for (const fn of ['function drawNode', 'function drawEdge', 'function hitTest', 'function fitView', 'function loop']) {
  ok(has(html, fn), `${fn.replace('function ', '')}() 存在`);
}
ok(has(html, 'requestAnimationFrame'), '渲染走 requestAnimationFrame');

console.log('\n── 求解器/预设链路已接通 ──');
for (const call of ['AVP.resolve', 'AVP.estimate', 'AVP.applyPreset', 'AVP.exportPreset', 'AVP.importPreset']) {
  ok(has(html, call), `${call} 被调用`);
}
ok(has(html, 'localStorage'), '参数与视图偏好持久化（localStorage）');
ok(has(html, 'function degrade') && has(html, '风险'), '红线风险提示（degrade/风险）在界面可见');

console.log('\n── 构建器防护 ──');
const buildSrc = fs.readFileSync(BUILD, 'utf8');
ok(/<\/script/i.test(buildSrc), '构建器含 </script> 截断检查');
ok(has(buildSrc, 'params.registry.json'), '构建器读注册表');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) { process.exit(1); }
console.log('全部通过');