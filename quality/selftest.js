/**
 * quality/selftest.js —— 质检管线验收（真素材、真 ffmpeg、真数字）
 *
 * 为什么必须造「坏片」而不是 mock ffmpeg 输出：
 *   这条管线的全部价值在于「准确指出第几帧坏了」。如果用假数据跑，只能证明代码没崩，
 *   证明不了检出帧号与注入帧号对得上。所以这里用 ffmpeg 现场合成两条片：
 *     good-720p30.mp4  3s · 渐变底 + 网格高频 + 匀速运动方块（正常素材）
 *     bad-720p30.mp4   4s · 在正常底上定点注入缺陷（帧号是确定的）
 *   注入点位写在 fixtures.js 的 expected 里，自检拿检出结果与它做交集比对。
 *
 * 断言口径：
 *   不断言「平均分等于某个具体数字」——那会随 ffmpeg 版本漂移；
 *   只断言「排序正确 + 定点命中 + 契约字段一致 + 耗时达标」这四类稳定性质。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { probe } = require('./probe.js');
const { analyze } = require('./frames.js');
const { build } = require('./report.js');
const { generate, FIX_DIR, FPS } = require('./fixtures.js');
const { runExport, contractFrames, INSPECTOR } = require('./export.js');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra !== undefined ? `  → ${extra}` : ''}`); }
};
const intersect = (a, b) => { const s = new Set(b); return a.filter((x) => s.has(x)); };

(async () => {
  /* ── 0 素材 ─────────────────────────────────────────── */
  console.log('── 0 测试素材（ffmpeg 现场合成）──');
  const tGen = Date.now();
  const fx = generate();
  ok(fs.existsSync(fx.good), `good 素材就绪 ${path.basename(fx.good)}`);
  ok(fs.existsSync(fx.bad), `bad 素材就绪 ${path.basename(fx.bad)}`);
  console.log(`  目录 ${FIX_DIR} · 生成/复用耗时 ${Date.now() - tGen}ms`);
  const expect = fx.expected;
  console.log(`  注入点位：黑帧 ${expect.black[0]}-${expect.black[1]} · 白帧 ${expect.white[0]}-${expect.white[1]} · ` +
    `模糊 ${expect.blur[0]}-${expect.blur[1]} · 冻结 ${expect.freeze[0]}-${expect.freeze[1]}`);

  /* ── 1 探针 ─────────────────────────────────────────── */
  console.log('\n── 1 ffprobe 探针 ──');
  const pg = probe(fx.good);
  const pb = probe(fx.bad);
  ok(pg.ok !== false, `good 探针成功（${pg.code || 'OK'}）`);
  const goodFrames = pg.video.nbFrames;
  ok(goodFrames === 90, `good 帧数 = 90（实际 ${goodFrames} @ ${FPS}fps × 3s）`);
  ok(pb.video.nbFrames === 120, `bad 帧数 = 120（实际 ${pb.video.nbFrames}）`);
  ok(pg.video.width === 720, `good 宽 720（实际 ${pg.video.width}）`);

  /* ── 2 逐帧分析 ─────────────────────────────────────── */
  console.log('\n── 2 逐帧指标分析 ──');
  const tGood = Date.now();
  const ag = await analyze(fx.good);
  const goodWallMs = Date.now() - tGood;
  const ab = await analyze(fx.bad);
  ok(ag.ok !== false && ab.ok !== false, '两条素材分析均完成');
  console.log(`  good 解码 ${ag.analysis.frames} 帧 · ffmpeg ${ag.timing.ffmpegMs}ms · 墙钟 ${goodWallMs}ms`);
  console.log(`  bad  解码 ${ab.analysis.frames} 帧 · ffmpeg ${ab.timing.ffmpegMs}ms`);
  ok(goodWallMs < 10000, `3 秒片全流程 ${goodWallMs}ms < 10000ms（硬要求）`);

  /* ── 3 综合分排序 ───────────────────────────────────── */
  console.log('\n── 3 综合分（好片必须显著高于坏片）──');
  const rg = build(pg, ag);
  const rb = build(pb, ab);
  console.log(`  good 均值 ${rg.summary.mean} · p5 ${rg.summary.p5} · 问题帧 ${rg.summary.problem_frames}/${rg.summary.frames}` +
    ` (ok ${rg.summary.status.ok}/warn ${rg.summary.status.warn}/bad ${rg.summary.status.bad})`);
  console.log(`  bad  均值 ${rb.summary.mean} · p5 ${rb.summary.p5} · 问题帧 ${rb.summary.problem_frames}/${rb.summary.frames}` +
    ` (ok ${rb.summary.status.ok}/warn ${rb.summary.status.warn}/bad ${rb.summary.status.bad})`);
  ok(rg.summary.mean > rb.summary.mean, `good 均值 ${rg.summary.mean} > bad 均值 ${rb.summary.mean}`);
  ok(rg.summary.mean - rb.summary.mean >= 5, `分差 ${(rg.summary.mean - rb.summary.mean).toFixed(1)} ≥ 5（区分度足够）`);
  ok(rb.summary.problem_frames > rg.summary.problem_frames,
    `bad 问题帧 ${rb.summary.problem_frames} > good 问题帧 ${rg.summary.problem_frames}`);
  ok(rg.summary.problem_frames === 0, `正常素材零问题帧（实际 ${rg.summary.problem_frames}）`);

  /* ── 4 定点检出 ─────────────────────────────────────── */
  console.log('\n── 4 缺陷定点检出（检出帧号 ∩ 注入帧号）──');
  const blackRange = [];
  for (let i = expect.black[0]; i <= expect.black[1]; i++) blackRange.push(i);
  const whiteRange = [];
  for (let i = expect.white[0]; i <= expect.white[1]; i++) whiteRange.push(i);
  const freezeRange = [];
  for (let i = expect.freeze[0]; i <= expect.freeze[1]; i++) freezeRange.push(i);

  const hitBlack = intersect(ab.detect.blackFrames, blackRange);
  const hitWhite = intersect(ab.detect.white, whiteRange);
  const hitFreeze = intersect(ab.detect.frozenFrames, freezeRange);
  console.log(`  黑帧：检出 [${ab.detect.blackFrames.join(',')}] 命中 [${hitBlack.join(',')}]`);
  console.log(`  白帧：检出 [${ab.detect.white.join(',')}] 命中 [${hitWhite.join(',')}]`);
  console.log(`  冻结：检出 [${ab.detect.staticRuns.map((r) => (r.startFrame ?? r.start) + '-' + (r.endFrame ?? r.end)).join(',')}] 命中 ${hitFreeze.length} 帧`);
  ok(hitBlack.length >= blackRange.length - 1,
    `黑帧命中 ${hitBlack.length}/${blackRange.length}（允许边缘 1 帧误差）`);
  ok(hitWhite.length >= whiteRange.length - 1,
    `白帧命中 ${hitWhite.length}/${whiteRange.length}（允许边缘 1 帧误差）`);
  ok(hitFreeze.length >= 10, `冻结帧命中 ${hitFreeze.length}/${freezeRange.length}（≥10）`);
  // 误报：正常素材不该被判黑/白
  ok(ag.detect.blackFrames.length === 0 && ag.detect.white.length === 0,
    `正常素材无误报（黑 ${ag.detect.blackFrames.length} / 白 ${ag.detect.white.length}）`);

  /* ── 5 模糊段锐度 ───────────────────────────────────── */
  console.log('\n── 5 锐度指标：模糊段必须显著低于正常段 ──');
  const blurFrames = ab.frames.filter((f) => f.frame >= expect.blur[0] && f.frame < expect.blur[1]);
  const sharpFrames = ag.frames;
  const avg = (arr, pick) => arr.reduce((a, f) => a + pick(f), 0) / (arr.length || 1);
  const blurSharp = avg(blurFrames, (f) => f.sharp);
  const goodSharp = avg(sharpFrames, (f) => f.sharp);
  console.log(`  bad 模糊段 ${expect.blur[0]}-${expect.blur[1] - 1} 平均锐度 ${blurSharp.toFixed(3)} · good 全片平均 ${goodSharp.toFixed(3)}`);
  ok(blurSharp < goodSharp * 0.75, `模糊段锐度 ${blurSharp.toFixed(3)} < 正常段 ${goodSharp.toFixed(3)} × 0.75`);
  const blurDefect = blurFrames.filter((f) => f.defect === 'blur').length;
  ok(blurDefect >= blurFrames.length * 0.8, `模糊段被判 blur 的帧 ${blurDefect}/${blurFrames.length}（≥80%）`);

  /* ── 6 帧数与契约字段 ───────────────────────────────── */
  console.log('\n── 6 契约：帧数与字段名 ──');
  ok(rg.frames.length === rg.summary.frames, `frames[] 长度 ${rg.frames.length} == summary.frames ${rg.summary.frames}`);
  ok(rg.frames.length === goodFrames, `frames[] 长度与 ffprobe 帧数一致（${goodFrames}）`);

  const contract = contractFrames(rg.frames);
  const wantKeys = ['frame', 'score', 'sharp', 'flicker', 'flowResidual', 'defect', 'status', 'repaired', 'extra'];
  const gotKeys = Object.keys(contract[0] || {});
  ok(wantKeys.every((k) => gotKeys.includes(k)), `contractFrames 键齐全（${gotKeys.join(',')}）`,
    wantKeys.filter((k) => !gotKeys.includes(k)).join(','));
  ok(contract.every((f) => ['ok', 'warn', 'bad'].includes(f.status)), 'status 取值只在 ok/warn/bad');

  // 与 inspector 的字段契约比对：inspector 只认这五个字段
  const inspectorHtml = fs.readFileSync(INSPECTOR, 'utf8');
  const inspectorFields = ['score', 'sharp', 'flicker', 'flowResidual', 'status'];
  const missingInInspector = inspectorFields.filter((k) => !inspectorHtml.includes(k));
  ok(missingInInspector.length === 0, 'inspector 侧五个契约字段齐全', missingInInspector.join(','));
  ok(inspectorFields.every((k) => gotKeys.includes(k)),
    '产出侧包含 inspector 需要的全部字段');

  /* ── 7 导出 ─────────────────────────────────────────── */
  console.log('\n── 7 导出 quality.json ──');
  const ex = await runExport({ video: fx.bad });
  ok(ex.ok === true, `runExport 成功（${ex.ok ? 'ok' : ex.code}）`, ex.message);
  const jsonPath = ex.jsonPath;
  ok(!!jsonPath && fs.existsSync(jsonPath), `quality.json 已落盘 ${jsonPath}`);
  if (jsonPath && fs.existsSync(jsonPath)) {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    ok(parsed.schema === 'quality.json/1', `schema = ${parsed.schema}`);
    ok(Array.isArray(parsed.frames) && parsed.frames.length === rb.frames.length,
      `落盘 frames 数量 ${parsed.frames.length} 与内存一致（${rb.frames.length}）`);
  }
  const worst = rb.summary.worst.slice(0, 3);
  console.log(`  最该重绘：${worst.map((w) => `#${w.frame}(${w.score}/${w.defect_cn || w.defect})`).join(' · ')}`);

  /* ── 汇总 ───────────────────────────────────────────── */
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exit(1);
  console.log('全部通过');
})().catch((e) => {
  console.error('自检异常：' + (e && e.stack || e));
  process.exit(1);
});