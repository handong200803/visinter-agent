/**
 * market/selftest.js —— 模板市场的端到端自检（node market/selftest.js）
 *
 * 自检只做一件事：**用真数据把 8 组承诺逐条证伪**。数字全部现算现打印，不写死期望值——
 * 写死期望值的测试会在参数表微调后"假通过"，这比没有测试更危险。
 *
 * 覆盖：
 *   1. 5 个样例全部 verify 通过（结构/版本/checksum/值域/定价）
 *   2. 篡改任一 values 后 verify 失败（checksum 检出）
 *   3. registry_version 不匹配 → 不兼容错误；platform 太低 → platform_too_old
 *   4. sign/verify 往返一致，篡改后失败；键序打乱不影响（规范化载荷）
 *   5. store install → list → search → rate → remove → rebuild 全链路（打印真实条数）
 *   6. applyTo 后显存估算 == 打包时 estimate_meta（同一条 hydrate 管道）
 *   7. 定价规则表可复算（档位边界/板块加价/4K 加价/分成折价）
 *   8. .avptpl 与 engine 的 .preset 互操作（checksum 同构）
 *   9. 版本目录（store/tpl/<id>/<version>.avptpl）/ 回滚 / 索引自愈（卡⑦）
 *  10. 模板 → 工作流编译贯通：用真的 server/wf.js#compileWorkflow 对拍（卡⑦）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AVP = require('../core/engine.js');
const pack = require('./pack.js');
const sign = require('./sign.js');
const storeMod = require('./store.js');

const ROOT = path.join(__dirname, '..');
const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/params.registry.json'), 'utf8'));
const SAMPLES = path.join(__dirname, 'samples');
// 自检需要建一个临时仓库。默认放在项目内（跑完即删），但安装目录只读时（例如装在 Program Files、
// 或受宿主沙箱限制）可以用 AVP_SELFTEST_DIR 指到别处——否则"环境不可写"会被误读成"代码有 bug"。
const TMP_STORE = process.env.AVP_SELFTEST_DIR
  ? path.resolve(process.env.AVP_SELFTEST_DIR)
  : path.join(__dirname, '.selftest-store');
const SECRET = 'avp-selftest-secret';
const DEMO = 'avp-demo-signing-key-2026-11'; // 与 build_samples.js 同一演示密钥

let fail = 0;
let pass = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg, extra === undefined ? '' : JSON.stringify(extra).slice(0, 200)); }
};
const head = (t) => console.log('\n== ' + t + ' ==');

/* 收集样例（不依赖 build 脚本跑过，缺文件就直接报） */
const files = fs.existsSync(SAMPLES)
  ? fs.readdirSync(SAMPLES).filter((f) => f.endsWith('.avptpl')).sort().map((f) => path.join(SAMPLES, f))
  : [];
const tpls = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));

/* ───────── 1. 样例 verify ───────── */
head('1. 样例模板校验（' + files.length + ' 个 .avptpl）');
ok(tpls.length === 5, '样例数量 = 5，实际 ' + tpls.length);
for (const t of tpls) {
  const v = pack.verify(t, reg);
  const e = t.estimate_meta || {};
  ok(v.ok, `${t.id}@${t.version} 校验通过（参数 ${Object.keys(t.values).length} 项，${e.device} 显存比 ${(e.ratio * 100).toFixed(1)}%，单格 ${e.shot_sec}s，质量 ${e.quality}）`,
    v.errors);
  ok(v.warnings.every((w) => w.code !== 'unsigned'), `  └ ${t.id} 已签名（signature.key_id=${t.signature && t.signature.key_id}）`);
}

/* ───────── 2. 篡改检测 ───────── */
head('2. 篡改 values → checksum 必须失败');
{
  const base = JSON.parse(JSON.stringify(tpls[0]));
  const k = Object.keys(base.values)[0];
  const before = base.values[k];
  base.values[k] = typeof before === 'number' ? before + 1 : before + 'x';
  const v = pack.verify(base, reg);
  ok(!v.ok && v.errors.some((e) => e.code === 'checksum_mismatch'),
    `改 ${k}（${JSON.stringify(before)} → ${JSON.stringify(base.values[k])}）被 checksum 检出`,
    v.errors.map((e) => e.code));
  // 连 checksum 一起改也不行：签名会当场失败（见第 4 组）
  const refake = JSON.parse(JSON.stringify(base));
  refake.checksum = pack.checksumOf(refake.values);
  const sv = sign.verifySignature(refake, DEMO);
  ok(!sv.ok && sv.reason === 'digest_mismatch', '改 values + 重算 checksum → 签名仍失败（reason=' + sv.reason + '）');
}

/* ───────── 3. 版本兼容 ───────── */
head('3. 版本兼容拦截');
{
  const old = JSON.parse(JSON.stringify(tpls[0]));
  old.registry_version = '0.0.9';
  const v1 = pack.verify(old, reg);
  ok(!v1.ok && v1.errors.some((e) => e.code === 'registry_version_mismatch'),
    `registry_version 0.0.9 ≠ 平台 ${reg.version} → registry_version_mismatch`, v1.errors.map((e) => e.code));

  const fut = JSON.parse(JSON.stringify(tpls[0]));
  fut.compat.min_platform = '9.9.9';
  const v2 = pack.verify(fut, reg);
  ok(!v2.ok && v2.errors.some((e) => e.code === 'platform_too_old'),
    'compat.min_platform 9.9.9 > 平台 → platform_too_old', v2.errors.map((e) => e.code));

  const newer = JSON.parse(JSON.stringify(tpls[0]));
  newer.compat.max_tested = '0.0.1';
  const v3 = pack.verify(newer, reg);
  ok(v3.ok && v3.warnings.some((w) => w.code === 'untested_platform'),
    '未测过的更高平台只告警不拦（untested_platform）');
}

/* ───────── 4. 签名 ───────── */
head('4. HMAC 签名往返 / 篡改 / 键序');
{
  const t = tpls[1];
  const signed = sign.sign(t, SECRET, { signed_at: '2026-11-16T00:00:00.000Z', issuer: 'selftest' });
  const r1 = sign.verifySignature(signed, SECRET);
  ok(r1.ok, 'sign→verify 往返一致（value=' + signed.signature.value.slice(0, 16) + '…）');
  ok(signed.signature.key_id === sign.keyId(SECRET), 'key_id = sha256(secret) 前 16 位');

  // 篡改正文（不动 signature）
  const bad = JSON.parse(JSON.stringify(signed));
  bad.name = bad.name + '（改）';
  const r2 = sign.verifySignature(bad, SECRET);
  ok(!r2.ok && r2.reason === 'digest_mismatch', '改 name 后验签失败（reason=' + r2.reason + '）');

  // 换密钥
  const r3 = sign.verifySignature(signed, SECRET + 'x');
  ok(!r3.ok && r3.reason === 'key_mismatch', '换密钥验签失败（reason=' + r3.reason + '）');

  // 键序打乱：canonical 载荷保证内容相同则签名相同
  const reorder = (v) => (Array.isArray(v) ? v.map(reorder)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v);
  const shuffled = reorder(JSON.parse(JSON.stringify(signed)));
  ok(sign.verifySignature(shuffled, SECRET).ok, '键序完全打乱（含嵌套）后签名仍有效（递归规范化）');

  // 未签名（样例全部签过名，所以显式造一个反例）
  const unsigned = JSON.parse(JSON.stringify(tpls[2]));
  delete unsigned.signature;
  const r4 = sign.verifySignature(unsigned, SECRET);
  ok(!r4.ok && r4.reason === 'unsigned', 'signature 被摘掉 → reason=' + r4.reason);
  ok(pack.verify(unsigned, reg).warnings.some((x) => x.code === 'unsigned'),
    'verify 对未签名模板给 unsigned 警告（可上架但标"未验签"）');
  const r5 = sign.verifySignature(sign.sign(tpls[2], DEMO, { signed_at: '2026-11-16T00:00:00.000Z' }), DEMO);
  ok(r5.ok, '样例用演示密钥可验签（market/build_samples.js 的 DEMO_SECRET）');
}

/* ───────── 5. 仓库全链路 ───────── */
head('5. store 全链路（临时目录 ' + path.relative(ROOT, TMP_STORE) + '）');
{
  fs.rmSync(TMP_STORE, { recursive: true, force: true });
  const st = storeMod.openStore({ dir: TMP_STORE, registry: reg });
  for (const f of files) st.install(f);
  const l1 = st.list();
  ok(l1.length === 5, 'install 5 个 → list 返回 ' + l1.length + ' 条');
  ok(!!st.get('cyber-night-dolly'), 'get(cyber-night-dolly) 命中，文件 ' + path.basename(st.get('cyber-night-dolly').file));

  const tag = st.search({ tag: '古风' });
  const stage = st.search({ stage: 'motion' });
  const kw = st.search({ q: '赛博' });
  const pricey = st.search({ min_price: 1 });
  console.log(`     tag=古风 → ${tag.length} 条：${tag.map((x) => x.id).join(', ') || '—'}`);
  console.log(`     stage=motion → ${stage.length} 条：${stage.map((x) => x.id).join(', ')}`);
  console.log(`     q=赛博 → ${kw.length} 条：${kw.map((x) => x.id).join(', ') || '—'}`);
  console.log(`     min_price=1 → ${pricey.length} 条`);
  ok(tag.length >= 1, 'tag 过滤命中（' + tag.length + '）');
  ok(stage.length === 3, 'stage=motion 命中 3 条（' + stage.map((x) => x.id).join(',') + '）');
  ok(kw.length === 1 && kw[0].id === 'cyber-night-dolly', '关键词 赛博 唯一命中 cyber-night-dolly');

  // 评分改变排序：只给最低分那条打 5 分，它应该爬到第一
  const before = st.list().map((x) => x.id);
  st.rate(before[before.length - 1], 5, { rater: 'tester' });
  st.rate(before[before.length - 1], 5, { rater: 'tester' }); // 同人重复评分只计一次
  const after = st.list();
  const rated = st.get(before[before.length - 1]).item;
  ok(rated.rating.count === 1 && rated.rating.avg === 5, `重复评分去重：count=${rated.rating.count} avg=${rated.rating.avg}`);
  ok(after[0].id === before[before.length - 1], `评分后从末位(${before[before.length - 1]}) 升到首位，rank=${after[0].rank}`);

  // 重复安装累加安装量
  const i1 = st.get('cyber-night-dolly').item.installs;
  st.install(files.find((f) => f.includes('cyber-night-dolly')));
  ok(st.get('cyber-night-dolly').item.installs === i1 + 1, '重复安装同一 checksum → installs ' + i1 + ' → ' + (i1 + 1) + '（不新建条目）');

  // 冲突：同 id 不同内容必须显式 --upgrade
  // 注意顺序：先改 values 再重算 checksum，否则会被 checksum_mismatch 先拦下（见下面那条断言）
  const clash = JSON.parse(JSON.stringify(tpls.find((t) => t.id === 'doc-interview-real')));
  clash.version = '2.0.1';
  clash.values['lk.grain'] = 30;
  const brokenChecksum = JSON.parse(JSON.stringify(clash));
  clash.checksum = pack.checksumOf(clash.values);
  let csErr = '';
  try { st.install(brokenChecksum); } catch (e) { csErr = e.message.split(':')[0]; }
  ok(csErr === 'E_INVALID_TEMPLATE', '改了 values 没重算 checksum → 安装器先拦 checksum（' + csErr + '）');
  let conflictCode = '';
  try { st.install(clash); } catch (e) { conflictCode = e.message.split(':')[0]; }
  ok(conflictCode === 'E_VERSION_CONFLICT', '同 id 不同 checksum 拒绝安装（' + conflictCode + '）');
  st.install(clash, { upgrade: true });
  ok(st.get('doc-interview-real').item.version === '2.0.1', '带 upgrade 安装成功，版本 → 2.0.1');

  // 删除 + 重建
  const rm = st.remove('product-turntable-pro');
  ok(rm.removed && st.list().length === 4, 'remove 后剩 ' + st.list().length + ' 条（fileDeleted=' + rm.fileDeleted + '）');
  fs.rmSync(path.join(TMP_STORE, 'index.json'));
  const rebuilt = st.rebuild();
  ok(rebuilt === 4, 'index.json 删掉后 rebuild 从 tpl/ 目录重扫出 ' + rebuilt + ' 条');
  // 口径说明：索引是安装量的唯一载体，索引文件整体丢失时只能按"至少装过 1 次"重算——
  // 但索引还在、只是与文件不同步时（手删正文）安装量与评分会被保留，见第 9 组。
  ok(st.list().every((it) => it.installs === 1), 'index.json 全丢后安装量按 1 重算（历史不可恢复，不是幽灵条目）');
  const stats = st.stats();
  console.log(`     最终索引：${stats.count} 条（付费 ${stats.paid} / 免费 ${stats.free}），${stats.versions} 个版本，安装量合计 ${stats.installs}，评分 ${stats.ratings} 次`);
}

/* ───────── 6. applyTo 与打包估算一致 ───────── */
head('6. applyTo 估算 == 打包估算');
for (const t of tpls) {
  const a = pack.applyTo(t, reg);
  const m = t.estimate_meta;
  const same = a.estimate.vram.peak_mib === m.peak_mib
    && a.estimate.vram.ratio === m.ratio
    && a.estimate.time.shot_sec === m.shot_sec
    && a.estimate.quality.score === m.quality;
  ok(same && Object.keys(a.values).length === reg.params.length,
    `${t.id}：${Object.keys(a.values).length}/${reg.params.length} 参数，显存 ${a.estimate.vram.peak_mib}MiB (${(a.estimate.vram.ratio * 100).toFixed(1)}%)，单格 ${a.estimate.time.shot_sec}s，质量 ${a.estimate.quality.score} —— 与 estimate_meta 一致`);
}

/* ───────── 7. 定价规则表 ───────── */
head('7. 定价规则可复算');
{
  const s = pack.suggestPrice;
  ok(s({ license: 'free', quality: 95 }).price_cny === 0, 'free 一律 0 元（即使 95 分）');
  ok(s({ license: 'paid', quality: 55 }).mode === 'free', '质量 <60 强制 free（draft 档无付费）');
  ok(s({ license: 'paid', quality: 65, stage_count: 1 }).price_cny === 8, 'basic(65) 单板块 = ¥8');
  ok(s({ license: 'paid', quality: 78, stage_count: 1 }).price_cny === 18, 'pro(78) 单板块 = ¥18');
  ok(s({ license: 'paid', quality: 84, stage_count: 3, ex_resolution: '4K' }).price_cny === 40, 'plus(84) + 2 个额外板块(+4) + 4K(+4) = ¥40');
  ok(s({ license: 'paid', quality: 95, stage_count: 7, ex_resolution: '4K' }).price_cny === 64, 'flagship(95) 全 7 板块 4K = ¥64');
  const rs = s({ license: 'revenue_share', quality: 78, stage_count: 1 });
  ok(rs.mode === 'revenue_share' && rs.price_cny === 11 && rs.share.creator_pct + rs.share.platform_pct === 100,
    `revenue_share：前置价 = round(18×0.6) = ¥${rs.price_cny}，分成 ${rs.share.creator_pct}/${rs.share.platform_pct}`);
  // 全部样例的价格都必须落在建议值 ±1 档内（这里断言"不为 0/不为负/不超天花板"这类硬约束）
  for (const t of tpls) {
    ok(t.pricing.price_cny >= 0 && t.pricing.price_cny <= pack.PRICE_ADJ.cap,
      `${t.id} 定价 ¥${t.pricing.price_cny}（${t.license}）在 [0, ${pack.PRICE_ADJ.cap}] 内`);
  }
}

/* ───────── 8. 与 engine 预设互通 ───────── */
head('8. .avptpl 与 engine .preset 互通');
{
  const t = tpls[0];
  const imp = AVP.importPreset(reg, {
    schema: 'ai-video-platform/preset',
    registry_version: reg.version,
    checksum: t.checksum,
    values: t.values,
  });
  ok(imp.checksum_ok, '模板 checksum 直接被 engine.importPreset 认可（checksum_ok=' + imp.checksum_ok + '）');
  ok(pack.checksumOf(t.values) === t.checksum, 'pack.checksumOf 与 engine djb2 同构：' + t.checksum);
  const exp = AVP.exportPreset(reg, imp.values, { name: t.name });
  ok(exp.checksum === t.checksum, 'engine.exportPreset 再导一次得到同一 checksum（' + exp.checksum + '）');
  const demoVals = { 'kf.resolution': 2048, 'kf.steps': 25 };
  const tpl2 = pack.pack(reg, demoVals, { name: '互通测试', license: 'free', device: 'T0', created: '2026-11-16T00:00:00.000Z' });
  ok(pack.verify(tpl2, reg).ok && tpl2.registry_version === reg.version,
    '从裸 values 打包（无 id/无标签）也能过校验，id 自动生成 ' + tpl2.id);
  ok(tpl2.stage_focus.length > 0 && tpl2.stage_focus.every((x) => pack.stagesOf(reg).includes(x)),
    'stage_focus 由参数反推得到：' + tpl2.stage_focus.join('/'));
}

/* ───────── 9. 版本目录 / 回滚 / 索引自愈（卡⑦） ───────── */
head('9. 版本目录 / 回滚 / 索引自愈（卡⑦）');
{
  const VSTORE = TMP_STORE + '-ver';
  fs.rmSync(VSTORE, { recursive: true, force: true });
  const st = storeMod.openStore({ dir: VSTORE, registry: reg });
  const cur = JSON.parse(JSON.stringify(tpls.find((t) => t.id === 'oriental-ink-portrait')));
  // 造一个真实的历史版本：只改参数再重算 checksum（版本目录要证明"两份正文并存"，不是伪造摘要）
  const old = JSON.parse(JSON.stringify(cur));
  old.version = '1.1.0';
  old.values['kf.steps'] = 24;
  old.values['lk.grain'] = 22;
  old.checksum = pack.checksumOf(old.values);
  const oldEst = pack.applyTo(old, reg).estimate;
  old.estimate_meta = pack.estimateMeta(oldEst, 'T0');
  const oldSigned = sign.sign(old, DEMO, { signed_at: old.created, issuer: 'market/selftest.js' });
  ok(pack.verify(oldSigned, reg).ok, '历史版本 ' + old.id + '@1.1.0 自身合法（kf.steps 24 / lk.grain 22）');

  const i1 = st.install(cur);
  const dirOfId = path.join(VSTORE, 'tpl', cur.id);
  ok(path.relative(VSTORE, i1.file).replace(/\\/g, '/') === `tpl/${cur.id}/${cur.version}.avptpl`,
    '安装落到版本目录：' + path.relative(VSTORE, i1.file).replace(/\\/g, '/'));
  const i2 = st.install(oldSigned, { upgrade: true });
  const files = fs.readdirSync(dirOfId).sort();
  ok(files.length === 2 && files.includes(cur.version + '.avptpl') && files.includes('1.1.0.avptpl'),
    '同 id 两个版本正文并存：' + files.join(' + '));
  const item = st.get(cur.id).item;
  ok(item.versions.length === 2 && item.version === '1.1.0',
    `索引记 2 个版本，激活版本 = 最后安装的 ${item.version}（安装量 ${item.installs}）`);

  // 回滚：激活指针移回 1.2.0，参数与预估都必须回到 1.2.0 的值
  const curEst = pack.applyTo(cur, reg).estimate;
  const rb = st.rollback(cur.id, cur.version);
  const g = st.get(cur.id);
  const backEst = pack.applyTo(g.template, reg, { device: 'T0' }).estimate;
  ok(rb.changed && rb.from === '1.1.0' && rb.to === cur.version,
    `rollback ${rb.from} → ${rb.to}（changed=${rb.changed}）`);
  ok(g.template.checksum === cur.checksum && JSON.stringify(g.template.values) === JSON.stringify(cur.values),
    '回滚后正文 checksum 与参数逐键等于 v1.2.0（checksum ' + g.template.checksum + '）');
  ok(backEst.vram.peak_mib === curEst.vram.peak_mib && backEst.time.shot_sec === curEst.time.shot_sec
    && backEst.quality.score === curEst.quality.score,
    `回滚后预估回到 v1.2.0：显存 ${backEst.vram.peak_mib}MiB / 单格 ${backEst.time.shot_sec}s / 质量 ${backEst.quality.score}（v1.1.0 是 ${oldEst.vram.peak_mib}MiB / ${oldEst.time.shot_sec}s / ${oldEst.quality.score}）`);
  const rb2 = st.rollback(cur.id, cur.version);
  ok(rb2.changed === false, '回滚到当前已激活版本幂等（changed=false，不写盘）');

  // 幂等重装：同一版本同一 checksum 只 +1 安装量，不产生重复版本记录
  const i3 = st.install(cur);
  ok(i3.reinstall && i3.versions === 2 && st.get(cur.id).item.installs === item.installs + 1,
    `同版本重装幂等：版本数仍 ${i3.versions}，安装量 ${item.installs} → ${st.get(cur.id).item.installs}`);

  // 自愈：删掉一个版本正文 → rebuild 不出现幽灵条目，安装量与评分保留
  st.rate(cur.id, 5, { rater: 'selftest' });
  const before = st.get(cur.id).item;
  fs.rmSync(path.join(dirOfId, '1.1.0.avptpl'));
  const ghost = st.list().find((x) => x.id === cur.id);
  ok(ghost.versions.length === 1 && ghost.versions[0].version === cur.version,
    '删掉 1.1.0 正文后 list 立即看不到它（读取自愈，不需手跑 rebuild）');
  const n = st.rebuild();
  const after = st.get(cur.id).item;
  ok(n === 1 && after.versions.length === 1 && after.version === cur.version,
    `rebuild 后剩 ${n} 条 / 该 id ${after.versions.length} 个版本（无幽灵版本）`);
  ok(after.installs === before.installs && after.rating.avg === before.rating.avg,
    `自愈保留安装量 ${after.installs} 与评分 ${after.rating.avg}(${after.rating.count})`);

  // 整条删干净 → 索引里不留条目
  fs.rmSync(dirOfId, { recursive: true, force: true });
  const n2 = st.rebuild();
  ok(n2 === 0 && st.list().length === 0, '正文全删后 rebuild 出 ' + n2 + ' 条（幽灵条目为 0）');
  fs.rmSync(VSTORE, { recursive: true, force: true });
}

/* ───────── 10. 模板 → 工作流编译贯通（卡⑦） ───────── */
head('10. 模板 → 工作流编译贯通（POST /api/jobs {template}）');
{
  for (const t of tpls) {
    const r = t.workflow_ref || {};
    ok(!!(r.kind === 'inline' && t.workflow), `${t.id}@${t.version} 带 workflow_ref：${r.nodes} 节点 / ${(r.bindings || []).length} 个参数落点`);
  }
  const t = tpls.find((x) => x.id === 'cyber-night-dolly');
  const payload = pack.jobPayload(t, reg);
  // 用真的编译器对拍：server/wf.js 只读引用（不改它，也不改它的对外契约）
  const wfMod = require(path.join(ROOT, 'server/wf.js'));
  const c = wfMod.compileWorkflow(payload.values, { registry: reg, template: payload.template });
  ok(c.source === 'custom' && c.synthetic === false, `POST /api/jobs {template} 走自定义图（source=${c.source}, synthetic=${c.synthetic}）`);
  ok(c.applied.length === 6, `6 个有绑定的参数全部落地（applied=${c.applied.length}）`);
  ok(c.unbound.filter((u) => u.reason === 'NODE_NOT_IN_TEMPLATE').length === 0,
    '没有 NODE_NOT_IN_TEMPLATE：图里的节点与注册表绑定一致');
  ok(c.stats.unbound === reg.params.length - 6,
    `其余 ${c.stats.unbound} 个参数如实在 unbound[] 里报告（绑定覆盖率 6/${reg.params.length}）`);
  const clipNode = Object.entries(payload.template).find(([, n]) => n._meta && n._meta.title === 'CLIP Text Encode');
  const text = clipNode && clipNode[1].inputs ? String(clipNode[1].inputs.text) : '';
  ok(text.includes(String(t.values['ch.subject'])), '模板的 ch.subject 真的写进了 CLIP Text Encode.text');
  const ks = Object.entries(payload.template).find(([, n]) => n.class_type === 'KSampler');
  ok(ks && ks[1].inputs.steps === payload.values['kf.steps'],
    `KSampler.steps = 模板值 ${payload.values['kf.steps']}（不是注册表默认值）`);
  ok(payload.device === 'T3' && payload.note === t.id + '@' + t.version,
    `jobPayload 给齐 values/device/template/note（device=${payload.device}, note=${payload.note}）`);

  // 负例：verify 要能判死"声明了却对不上"的四类坏包
  const broken = JSON.parse(JSON.stringify(t));
  delete broken.workflow;
  const v1 = pack.verify(broken, reg);
  ok(!v1.ok && v1.errors.some((e) => e.code === 'missing_workflow_body'), '删掉内嵌图 → missing_workflow_body');
  const badCount = JSON.parse(JSON.stringify(t));
  badCount.workflow_ref.nodes = 99;
  const v2 = pack.verify(badCount, reg);
  ok(!v2.ok && v2.errors.some((e) => e.code === 'workflow_node_count_mismatch'), '节点数对不上 → workflow_node_count_mismatch');
  const badVer = JSON.parse(JSON.stringify(t));
  badVer.workflow_ref.registry_version = '0.0.9';
  const v3 = pack.verify(badVer, reg);
  ok(!v3.ok && v3.errors.some((e) => e.code === 'workflow_registry_mismatch'), '口径版本与模板版本不一致 → workflow_registry_mismatch');
  const badBind = JSON.parse(JSON.stringify(t));
  badBind.workflow_ref.bindings[0].widget = 'not_a_widget';
  const v4 = pack.verify(badBind, reg);
  ok(!v4.ok && v4.errors.some((e) => e.code === 'workflow_bind_unknown'), '落点表与注册表 bind 不一致 → workflow_bind_unknown');
  const oldPkg = JSON.parse(JSON.stringify(t));
  delete oldPkg.workflow_ref;
  delete oldPkg.workflow;
  const v5 = pack.verify(oldPkg, reg);
  ok(v5.ok && v5.warnings.some((x) => x.code === 'no_workflow'), '老包（无 workflow_ref）不判死，只 warning(no_workflow)');
  let noWf = '';
  try { pack.jobPayload(oldPkg, reg); } catch (e) { noWf = e.message.split('（')[0]; }
  ok(noWf.startsWith('E_NO_WORKFLOW'), 'jobPayload 对无图老包明确拒绝（' + noWf + '）');
}

/* 清理临时仓库，不留垃圾 */
fs.rmSync(TMP_STORE, { recursive: true, force: true });

head('结果');
console.log(`  ✓ ${pass} 项通过 / ✗ ${fail} 项失败`);
if (fail === 0) {
  console.log('\n全部通过');
  process.exit(0);
} else {
  console.log('\n有失败项，退出码 1');
  process.exit(1);
}