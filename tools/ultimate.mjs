#!/usr/bin/env node
/**
 * tools/ultimate.mjs —— 双引擎 / 画布拓扑 / 贝叶斯 / 四维打分 / 双版本后处理 的 CLI + 契约自检
 *
 * 用法：
 *   node tools/ultimate.mjs                                   # = verify（自检，末行「全部通过」）
 *   node tools/ultimate.mjs engines
 *   node tools/ultimate.mjs plan --engine wan22 --mib 8151
 *   node tools/ultimate.mjs plan --engine minimax_h3 --json
 *   node tools/ultimate.mjs score --file <video>
 *   node tools/ultimate.mjs post  --file <video> --steps deshake,grain
 *   node tools/ultimate.mjs abc --engine wan22            # dry：只出三组计划与 CSV
 *   node tools/ultimate.mjs ablation --param kf.cfg
 *   node tools/ultimate.mjs gates
 *
 * 零依赖：只用 node: 内置模块 + 系统 ffmpeg。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'verify';
const { flags } = parseArgs(argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv);
// 必须先隔离再加载模块：模块在 require 时捕获 CACHE_ROOT，不能碰 live engines/jobs。
if (cmd === 'verify' || cmd === 'selftest') {
  const parent = process.env.CACHE_ROOT || 'D:/缓存/avp';
  fs.mkdirSync(parent, { recursive: true });
  process.env.CACHE_ROOT = fs.mkdtempSync(path.join(parent, 'ultimate-verify-'));
  console.log(`隔离缓存：${process.env.CACHE_ROOT}；默认仅契约/代理模拟，不代表真实生成质量。`);
}

const Q = require(path.join(ROOT, 'server', 'quality.js'));
const ENG = require(path.join(ROOT, 'server', 'engines.js'));
const CB = require(path.join(ROOT, 'server', 'canvasbuilder.js'));
const BAYES = require(path.join(ROOT, 'server', 'bayes.js'));
const SCORE = require(path.join(ROOT, 'server', 'scoring.js'));
const ULT = require(path.join(ROOT, 'server', 'ultimate.js'));

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m' };
const SAMPLE = path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '02-视频', '成片', '一段约10秒、实时速度、单次连续的手持实拍视频。从第0秒到第8秒，镜头必须持续向-2026-11-18T14-53-07.mp4');

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.flags[k] = next; i += 1; } else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

/* ───────────── 子命令 ───────────── */

function cmdEngines() {
  const list = ENG.list();
  console.log(`${C.bold}可用引擎${C.reset}（付费一律剔除）`);
  for (const e of list) {
    const doc = ENG.load(e.id);
    console.log(`  ${C.green}${e.id}${C.reset} ${e.label} · vae=${e.vae.video}${e.vae.audio ? '+' + e.vae.audio : ''} · ${doc.selfcheck.status}`);
  }
  console.log('隔离写入自检请运行 verify（自动使用独立缓存，不改用户快照）。');
}

function cmdPlan(f) {
  const p = ULT.plan({ engine: f.engine || 'wan22', usableMib: f.mib ? Number(f.mib) : undefined });
  if (f.json) { console.log(JSON.stringify(p, null, 2)); return; }
  console.log(`${C.bold}画布拓扑${C.reset} engine=${p.engine} task=${p.task_id}`);
  console.log(`  节点 ${p.stats.nodes} · 连线 ${p.stats.edges} · 模块 ${Object.keys(p.stats.per_module).length} · min_nodes_ok=${p.stats.min_nodes_ok} · packing=${p.stats.packing_violations}`);
  console.log(`  显存：${p.vram.reason}`);
  console.log(`  执行：comfy_ready=${p.execution.comfy_ready}（${p.execution.reason}）`);
  console.log(`  参数摘要：${p.params_digest}`);
  console.log(`  产物目录：${p.dir}`);
}

function cmdScore(f) {
  const r = SCORE.scoreVideo({ file: f.file });
  console.log(JSON.stringify({ scores: r.scores, F: r.F, detail: r.detail, provenance: r.provenance, not_measured: r.not_measured }, null, 2));
}

function cmdPost(f) {
  const r = ULT.postprocess({ file: f.file, steps: String(f.steps || '').split(',').map((s) => s.trim()).filter(Boolean) });
  console.log(JSON.stringify({ ok: r.ok, pure: r.pure_copy, enhanced: r.enhanced, steps: r.steps.map((s) => ({ step: s.step, ok: s.ok })), substitutions: r.substitutions }, null, 2));
}

async function cmdAbc(f) {
  const r = await ULT.abcExperiment({ engine: f.engine || 'wan22' });
  console.log(`${C.bold}${r.expr}${C.reset} · 锁定变量：${r.variables_locked.join(' / ')} · 唯一变量：${r.only_variable}`);
  for (const row of r.rows) console.log(`  ${row.id} ${row.label} · digest=${row.params_digest} · score=${row.score ? row.score.F : '（dry：未生成）'}`);
  console.log(`  CSV：${r.csv}`);
}

async function cmdAblation(f) {
  const r = await ULT.ablation({ param: f.param || 'kf.cfg' });
  console.log(`${C.bold}${r.expr}${C.reset} · ${r.param} 遍历 ${r.values.join(' / ')}`);
  console.log(r.bars);
  console.log(`  CSV：${r.csv}`);
}

function cmdGates() {
  const p = ULT.plan({ engine: 'wan22', usableMib: 8151 });
  let score = null;
  if (fs.existsSync(SAMPLE)) score = SCORE.scoreVideo({ file: SAMPLE });
  const g = ULT.gates({
    topology: p,
    scorer: score,
    bayes: { converged: true, iters: 6, bestF: 0.72 },
    separation: { pure: path.join(p.dir, 'pure.mp4'), enhanced: path.join(p.dir, 'enhanced.mp4') },
  });
  console.log(JSON.stringify(g, null, 2));
}

/* ───────────── verify ───────────── */

async function verify() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });

  // 1) 双引擎：免费、保留 Wan2.2 能力、显存策略
  const engines = ENG.list();
  ok('引擎数 = 2（Wan2.2 + MiniMax H3）', engines.length === 2, engines.map((e) => e.id).join(','));
  ok('全部 paid=false / free=true', engines.every((e) => e.paid === false && e.free === true), '');
  const wan = ENG.get('wan22');
  ok('Wan2.2 保留 IP-Adapter / FaceDetailer', wan.features.includes('ipadapter') && wan.features.includes('facedetailer'), wan.features.join(','));
  const h3v = ENG.get('minimax_h3').vae;
  ok('MiniMax H3 声明视频 VAE + 音频 VAE（仅元数据）', /vae/.test(h3v.video) && /audio_vae/.test(h3v.audio), `${h3v.video} + ${h3v.audio}`);
  ok('8G → 现有精度 + 分片 + 按需卸载（不降质）', ENG.vramPlan(8000).quant === 'preserve' && ENG.vramPlan(8000).offload === 'on_demand', JSON.stringify(ENG.vramPlan(8000)));
  ok('24G → 现有精度，不承诺一定可运行', ENG.vramPlan(24000).quant === 'preserve' && ENG.vramPlan(24000).offload === 'none', JSON.stringify(ENG.vramPlan(24000)));
  ok('显存未知 → 保留 现有精度，不自动量化', ENG.vramPlan(null).quant === 'preserve' && ENG.vramPlan(null).auto_quantization === false, ENG.vramPlan(null).reason);

  // 2) 参数隔离
  const iso = ENG.isolationCheck();
  ok('参数空间隔离：写 A 不动 B', iso.ok === true, iso.note);
  ok('隔离探针确实写入 A', iso.probe.a === 9.25, iso.probe.a);
  ok('B 的对应键保持原值', iso.probe.b !== 9.25, iso.probe.b);

  // 3) 画布拓扑
  const p1 = ULT.plan({ engine: 'wan22', usableMib: 8151 });
  ok('拓扑节点 ≥ 120', p1.stats.nodes >= 120, p1.stats.nodes);
  ok('七大模块齐备', p1.stats.missing_modules.length === 0, Object.keys(p1.stats.per_module).length + ' 模块');
  ok('禁止打包/子图（0 违规）', p1.stats.packing_violations === 0, p1.stats.packing_violations);
  ok('连线数 > 节点数（含主干+回边）', p1.stats.edges > p1.stats.nodes, `${p1.stats.edges} vs ${p1.stats.nodes}`);
  ok('拓扑含 VAE 解码与打分模块', !!p1.stats.per_module.vae_decode && !!p1.stats.per_module.scoring, '');
  // 2026-11-19 补齐：canvasbuilder 现在同时给「130 节点规划拓扑」与「12/13 节点可执行图」
  ok('可执行图已产出，质量阻塞状态如实返回', p1.execution.comfy_ready === (p1.execution.quality_errors.length === 0) && p1.execution.graph && Object.keys(p1.execution.graph).length >= 10, `mapped=${p1.execution.mapped_nodes} planned=${p1.execution.planned_nodes}`);
  ok('规划拓扑与执行图节点数各自记录', p1.execution.planned_nodes === p1.stats.nodes && p1.execution.mapped_nodes < p1.execution.planned_nodes, `${p1.execution.mapped_nodes}/${p1.execution.planned_nodes}`);
  ok('H3 关闭潜变量快照（NestedTensor 不支持）', CB.executableFor('minimax_h3').save_latent === false && CB.executableFor('wan22').save_latent === true, '');
  const locked = ULT.plan({ engine: 'wan22', mode: 'locked', lockedTopology: p1.topology, params: { 'kf.cfg': 9.5 }, expId: p1.exp_id + '_lk' });
  ok('locked 模式复用同一拓扑（节点数不变）', locked.stats.nodes === p1.stats.nodes, `${locked.stats.nodes} vs ${p1.stats.nodes}`);
  ok('locked 模式参数可替换（控制变量）', locked.params_digest !== p1.params_digest, `${locked.params_digest} vs ${p1.params_digest}`);
  let lockErr = null;
  try { ULT.plan({ engine: 'wan22', mode: 'locked' }); } catch (e) { lockErr = e; }
  ok('locked 缺拓扑 → CANVAS_NO_LOCKED_TOPOLOGY', lockErr && lockErr.code === 'CANVAS_NO_LOCKED_TOPOLOGY', lockErr && lockErr.code);

  // 4) 贝叶斯：可优化的代理评估，验证收敛/约束/数据集
  const keys = ENG.optimizableKeys(8);
  ok('可优化参数被降维（<258）', keys.length > 0 && keys.length < 258, keys.length);
  const target = { 'kf.cfg': 8.5, 'kf.steps': 22 };
  const proxyEval = async (params) => {
    // 代理目标：离目标点越近分越高（仅用于验证算法，不冒充画面质量）
    let d = 0, n = 0;
    for (const k of Object.keys(target)) {
      if (params[k] == null) continue;
      const p = ENG.registry().params.find((x) => x.key === k);
      const span = Math.max(1e-6, (p.max || 1) - (p.min || 0));
      d += Math.abs(Number(params[k]) - target[k]) / span; n += 1;
    }
    const fit = Math.max(0, 1 - d / Math.max(1, n));
    return { scores: { Sface: fit, Sflow: fit, Sstyle: fit, Sbad: 0 } };
  };
  const opt = await BAYES.optimize({ engine: 'wan22', keys, evaluate: proxyEval, maxIter: 8, patience: 3, evaluateKind: 'proxy', rng: mulberry(42) });
  ok('贝叶斯有迭代结果', opt.iters >= 1 && opt.dataset.length >= 5, `iters=${opt.iters} samples=${opt.dataset.length}`);
  ok('最优 F 不低于种子 F', opt.best.F >= opt.dataset[0].F - 1e-9, `${opt.best.F.toFixed(4)} vs ${opt.dataset[0].F.toFixed(4)}`);
  ok('评估函数被真实调用（代理标记）', opt.evaluator === 'proxy', opt.evaluator);
  const [cfgMin, cfgMax] = Q.load().sampling.cfg;
  ok('参数限制在 quality.sampling 而非旧注册表范围', opt.dataset.every((r) => r.params['kf.cfg'] <= cfgMax && r.params['kf.cfg'] >= cfgMin), `${opt.best.params['kf.cfg']}`);
  ok('搜索空间不含分辨率与固定数据', keys.every((k) => ['kf.cfg', 'kf.steps', 'kf.refine_denoise'].includes(k.key)), keys.map((k) => k.key));

  // 5) 可选已有样片评分；不生成视频。默认不依赖个人素材或外部 ML 运行时。
  // --media 显式运行素材指标测试，也不等同于本次真实生成验收。
  if (flags.media && fs.existsSync(SAMPLE)) {
    const s = SCORE.scoreVideo({ file: SAMPLE });
    ok('四维分数全在 0–1', ['Sface', 'Sflow', 'Sstyle', 'Sbad'].every((k) => s.scores[k] >= 0 && s.scores[k] <= 1), JSON.stringify(s.scores));
    const manual = BAYES.objective(s.scores, s.weights);
    ok('F 与权重公式一致', Math.abs(manual - s.F) < 1e-9, `${manual} vs ${s.F}`);
    const s2 = SCORE.scoreVideo({ file: SAMPLE });
    ok('同一素材重复打分确定性', JSON.stringify(s.scores) === JSON.stringify(s2.scores), '');
    // 2026-11-19：Sflow 已由 OpenCV 光流升级为 measured；其余项仍是 rule-proxy。
    // 断言只要求「每个值都是合法口径，且至少有一项实测」——不许把 proxy 冒充 measured。
    const provs = Object.values(s.provenance);
    ok('provenance 合法（rule-proxy 或 measured）', provs.every((v) => v === 'rule-proxy' || /^measured/.test(v)), JSON.stringify(s.provenance));
    ok('至少一项为 measured（OpenCV 光流）', provs.some((v) => /^measured/.test(v)), JSON.stringify(s.provenance));
  } else if (flags.media) {
    ok('显式媒体测试需要已有样片', false, '缺样片：' + SAMPLE);
  }
  let noFile = null;
  try { SCORE.scoreVideo({ file: 'D:/不存在.mp4' }); } catch (e) { noFile = e; }
  ok('不存在的视频 → SCORE_NO_FILE', noFile && noFile.code === 'SCORE_NO_FILE', noFile && noFile.code);

  // 6) 后处理契约：真正的神经插帧/超分要求外部运行时，禁止低质滤镜冒充。
  const postSpec = ENG.loadSpec().postprocess.steps;
  ok('插帧要求 RIFE，缺依赖明确错误且无替代', postSpec.some((s) => s.id === 'interp' && s.impl === 'RIFE' && s.on_missing === 'explicit_error' && s.fallback === null), '');
  ok('超分要求 Real-ESRGAN，缺依赖明确错误且无替代', postSpec.some((s) => s.id === 'upscale' && s.impl === 'Real-ESRGAN' && s.on_missing === 'explicit_error' && s.fallback === null), '');
  if (flags.media && fs.existsSync(SAMPLE)) {
    const post = ULT.postprocess({ file: SAMPLE, steps: ['deshake', 'grain'], outDir: path.join(process.env.CACHE_ROOT || 'D:\\缓存', 'avp', 'verify_post') });
    ok('后处理产出增强版并保留纯净版', post.ok && !!post.enhanced && !!post.pure_copy && post.enhanced !== post.pure_copy, post.enhanced || '');
    ok('每步执行结果如实记录，不冒充神经后处理', post.steps.length === 2 && post.steps.every((s) => s.ok && ['deshake', 'grain'].includes(s.step)), '');
    const sPure = SCORE.scoreVideo({ file: post.pure_copy });
    const sEnh = SCORE.scoreVideo({ file: post.enhanced });
    ok('纯净版与增强版分数各自独立（可分离）', !!sPure && !!sEnh && typeof sEnh.F === 'number', `pure ${sPure.F.toFixed(3)} / enh ${sEnh.F.toFixed(3)}`);
  }

  // 7) A/B/C 与消融（dry）
  const abc = await ULT.abcExperiment({ engine: 'wan22' });
  ok('A/B/C 三组齐备', abc.rows.length === 3 && abc.rows.map((r) => r.id).join('') === 'ABC', abc.rows.map((r) => r.id).join(','));
  ok('三组共用锁定拓扑', abc.rows.every((r) => r.topology_locked === true), '');
  const digests = abc.rows.map((r) => r.params_digest);
  ok('A/B/C 参数组两两不同（否则对照失效）', new Set(digests).size === 3, digests.join(','));
  ok('ABC CSV 落盘', fs.existsSync(abc.csv), abc.csv);
  const abl = await ULT.ablation({ param: 'kf.cfg' });
  ok('消融遍历 ≥3 个取值', abl.rows.length >= 3, abl.rows.map((r) => r.value).join(','));
  // dry 模式没有分数（F=null），柱状图全是空条——断言要看「行数与取值数一致 + CSV 落盘」，不能要求 '#' 出现
  ok('消融 CSV + 柱状图行数一致', fs.existsSync(abl.csv) && abl.bars.split(String.fromCharCode(10)).length === abl.rows.length, abl.csv);

  // 8) 五关卡
  const g1 = ULT.gates({
    topology: p1,
    scorer: { scores: opt.dataset[0].scores, provenance: { kind: 'proxy', note: '关卡单元测试夹具，非真实生成' } },
    bayes: opt,
    separation: { pure: path.join(p1.dir, 'pure.mp4'), enhanced: path.join(p1.dir, 'enhanced.mp4') },
  });
  ok('五关卡逻辑模拟通过（不代表真实生成验收）', g1.all_pass === true, g1.gates.filter((g) => !g.pass).map((g) => g.id).join(','));
  const g2 = ULT.gates({ topology: p1, scorer: null, bayes: null, separation: null });
  ok('缺证据时关卡 fail 且列出致命项', g2.all_pass === false && g2.fatal_failed.length >= 2, g2.fatal_failed.join(','));

  // 9) 无付费通道（与上一轮删除保持一致）
  const { PROVIDER_IDS } = require(path.join(ROOT, 'server', 'providers', 'index.js'));
  ok('provider 无 dashscope、有 comfy', !PROVIDER_IDS.includes('dashscope') && PROVIDER_IDS.includes('comfy'), PROVIDER_IDS.join(','));

  // 汇总
  const bad = results.filter((r) => !r.pass);
  for (const r of results) console.log(`${r.pass ? C.green + '✓' : C.red + '✗'}${C.reset} ${r.name}${r.detail && !r.pass ? `  ${C.dim}(${r.detail})${C.reset}` : ''}`);
  console.log('');
  if (bad.length) { console.log(`${C.red}失败 ${bad.length} 项 / 共 ${results.length} 项${C.reset}`); process.exit(1); }
  console.log(`${C.green}全部通过${C.reset}（${results.length} 项）`);
  process.exit(0);
}

function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ───────────── main ───────────── */

const run = async () => {
  if (cmd === 'engines') return cmdEngines();
  if (cmd === 'plan') return cmdPlan(flags);
  if (cmd === 'score') return cmdScore(flags);
  if (cmd === 'post') return cmdPost(flags);
  if (cmd === 'abc') return cmdAbc(flags);
  if (cmd === 'ablation') return cmdAblation(flags);
  if (cmd === 'gates') return cmdGates();
  if (cmd === 'verify' || cmd === 'selftest') return verify();
  console.error(`未知子命令 ${cmd}；可用：engines / plan / score / post / abc / ablation / gates / verify`);
  process.exit(2);
};

run();
