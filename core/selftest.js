/**
 * selftest —— 求解器口径自检（Node 运行：node core/selftest.js）
 * 只做三件事：跑通、打印真实数字、断言文档里的那几条联动规则确实生效。
 */
const fs = require('node:fs');
const path = require('node:path');
const AVP = require('./engine.js');

const ROOT = path.join(__dirname, '..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/params.registry.json'), 'utf8'));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/models.catalog.json'), 'utf8'));
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/rules.linkage.json'), 'utf8'));

let fail = 0;
const ok = (cond, msg, extra) => {
  if (!cond) { fail++; console.log('  ✗ ' + msg, extra ?? ''); }
  else console.log('  ✓ ' + msg);
};

console.log('== 注册表 ==');
console.log(`  ${reg.counts.total} 参数 / L3 ${reg.counts.l3} / 板块 ${reg.stages.length}`);

function run(values, device) {
  const ctx = { usable_mib: (catalog.devices.find((d) => d.id === device) || catalog.devices[0]).usable_mib, device };
  const r = AVP.resolve(reg, rules, values, { ctx });
  const e = AVP.estimate(reg, catalog, r.values, { device });
  return { ...r, report: e };
}

console.log('\n== 默认参数 · T0 ==');
const d0 = AVP.defaults(reg);
const r0 = run(d0, 'T0');
const rep = r0.report;
console.log(`  显存 peak ${rep.vram.peak_mib} / 可用 ${rep.vram.usable_mib} = ${(rep.vram.ratio * 100).toFixed(1)}%  [${rep.vram.state}]  主导 ${rep.vram.dominant}`);
console.log(`  耗时 单格 ${rep.time.shot_sec}s · 单集 ${rep.time.episode_min}min · 批量 ${rep.time.batch_min}min`);
console.log(`  质量 ${rep.quality.score}（qSum ${rep.quality.qSum}）`);
console.log(`  成本 单集 ¥${rep.cost.episode_yuan} · 功率 ${rep.cost.watts}W @ ¥${rep.cost.price}/kWh`);
console.log('  显存分阶段：' + rep.vram.stages.map((s) => `${s.label} ${s.peak_mib}MiB`).join(' | '));
console.log('  耗时构成：' + rep.time.breakdown.map((b) => `${b.label} ${b.sec}s/${b.pct}%`).join(' | '));
console.log('  质量 TOP：' + rep.quality.top.slice(0, 4).map((t) => `${t.label} ${t.contrib}`).join(' | '));
console.log('  联动改写：' + (r0.trace.filter((t) => t.target).map((t) => `${t.target} ${t.from}→${t.to}`).join(' | ') || '无'));
console.log('  提示：' + (r0.warnings.map((w) => '[' + w.level + '] ' + w.text.slice(0, 26)).join(' || ') || '无'));

console.log('\n== 规则断言 ==');
// 1) 运动强度 >0.6 → 一致性权重抬高
const v1 = { ...d0, 'mo.strength': 0.9 };
const r1 = run(v1, 'T0');
ok(r1.values['kf.identity_weight'] > 1.0, '运动 0.9 时 kf.identity_weight 被抬高到 ' + r1.values['kf.identity_weight']);
// 高分辨率不再通过压低帧数换取速度或显存。
const v2 = { ...d0, 'kf.resolution': 2048 };
const r2 = run(v2, 'T0');
ok(r2.values['mo.max_frames'] === d0['mo.max_frames'], '分辨率2048时保持原帧数');
// 3) 中景 + 仅近景口型 → 自动关口型
const v3 = { ...d0, 'sb.shot_scale': '中景', 'vo.lipsync': true, 'vo.closeup_only': true };
const r3 = run(v3, 'T0');
ok(r3.values['vo.lipsync'] === false, '中景时 vo.lipsync 被联动关闭');
// 4) AI 标识不可关
const r4 = run({ ...d0, 'ex.ai_label': false }, 'T0');
ok(r4.values['ex.ai_label'] === true, 'ex.ai_label=false 被强制改回 true');
const r5 = run({ ...d0, 'kf.steps': 40 }, 'T0');
ok(r5.values['kf.steps'] === 25, '步数按质量区间上限25校验');
ok(run({ ...d0, 'kf.steps': 4 }, 'T0').values['kf.steps'] === 16, '拒绝4步极速采样');
// 6) 720p i2v 在 8G 上告警
const r6 = run({ ...d0, 'mo.i2v_res': '720p' }, 'T0');
ok(r6.warnings.some((w) => w.id === 'i2v-720-on-8g'), '8G 上 720p i2v 触发显存告警');

console.log('\n== 三档预设 ==');
for (const name of ['draft', 'standard', 'cinematic']) {
  const p = AVP.applyPreset(reg, name);
  const r = run(p.values, 'T0');
  console.log(`  ${name.padEnd(9)} 显存 ${(r.report.vram.ratio * 100).toFixed(1)}% [${r.report.vram.state}] · 单格 ${r.report.time.shot_sec}s · 单集 ${r.report.time.episode_min}min · 质量 ${r.report.quality.score}`);
}

console.log('\n== 显存红线的降档建议（T0-low 实测可用 4127MiB）==');
const rl = run(d0, 'T0-low');
console.log(`  默认 peak ${rl.report.vram.peak_mib} / ${rl.report.vram.usable_mib} = ${(rl.report.vram.ratio * 100).toFixed(1)}% [${rl.report.vram.state}]`);
const deg = AVP.degrade(reg, catalog, rules, rl.values, { device: 'T0-low', ctx: { usable_mib: 4127, device: 'T0-low' } });
ok(deg.needed, '低可用显存时触发降档');
deg.options.forEach((o, i) => {
  console.log(`  方案${i + 1} ${o.label}：显存 ${(o.report.vram.ratio * 100).toFixed(1)}% [${o.report.vram.state}] · 质量 ${o.deltaQuality >= 0 ? '+' : ''}${o.deltaQuality} · 耗时 ${o.deltaTimePct >= 0 ? '+' : ''}${o.deltaTimePct}%`);
});

console.log('\n== 720p i2v 在 T0 上的降档（能救回来的场景）==');
const v720 = { ...d0, 'mo.mode': '局部i2v', 'mo.i2v_res': '720p' };
const r720 = run(v720, 'T0');
console.log(`  触发峰值 ${r720.report.vram.peak_mib}MiB = ${(r720.report.vram.ratio * 100).toFixed(1)}% [${r720.report.vram.state}]`);
const d720 = AVP.degrade(reg, catalog, rules, r720.values, { device: 'T0', ctx: { usable_mib: 6900, device: 'T0' } });
d720.options.forEach((o, i) => {
  console.log(`  方案${i + 1} ${o.label}：显存 ${(o.report.vram.ratio * 100).toFixed(1)}% [${o.report.vram.state}] · 质量 ${o.deltaQuality >= 0 ? '+' : ''}${o.deltaQuality} · 耗时 ${o.deltaTimePct >= 0 ? '+' : ''}${o.deltaTimePct}% · 改动 ${Object.keys(o.patch).length} 项`);
});

console.log('\n== 预设导出 / 导入 ==');
const out = AVP.exportPreset(reg, r0.values, { name: 'T0 商用基线', device: 'T0' });
console.log(`  checksum ${out.checksum} · 收录 ${Object.keys(out.values).length} 个非默认参数`);
const back = AVP.importPreset(reg, out);
ok(back.checksum_ok, '导出→导入 校验和一致');
ok(Object.keys(back.unknown).length === 0, '无未知参数键');
const bad = { ...out, values: { ...out.values, 'kf.steps': 99 } };
const back2 = AVP.importPreset(reg, bad);
ok(back2.checksum_ok === false, '篡改参数后校验和失配（可检出）');
ok(back2.values['kf.steps'] === 25, '越界值被夹到质量上限25');

console.log('\n== 规则注入防护 ==');
const rInj = AVP.resolve(reg, { rules: [{ id: 'x', if: 'process.exit(1)', warn: 'x' }] }, d0, {});
ok(rInj.trace.some((x) => x.error), '危险表达式被拒绝并记录：' + (rInj.trace.find((x) => x.error) || {}).error);

console.log('\n== 切到「局部 i2v」模式的代价 ==');
const ri = run({ ...d0, 'mo.mode': '局部i2v', 'mo.i2v_res': '480p', 'mo.i2v_strength': 0.5 }, 'T0');
console.log(`  显存 ${(ri.report.vram.ratio * 100).toFixed(1)}% [${ri.report.vram.state}] · 单格 ${ri.report.time.shot_sec}s · 单集 ${ri.report.time.episode_min}min · 质量 ${ri.report.quality.score}`);
const ri7 = run({ ...d0, 'mo.mode': '局部i2v', 'mo.i2v_res': '720p' }, 'T0');
console.log(`  720p i2v：显存 ${(ri7.report.vram.ratio * 100).toFixed(1)}% [${ri7.report.vram.state}] · 单格 ${ri7.report.time.shot_sec}s`);

console.log(fail ? `\n有 ${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);