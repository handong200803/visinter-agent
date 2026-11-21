#!/usr/bin/env node
/**
 * tools/capability.mjs —— 两个逆向能力（Muse 氛围感 / 抖音网红脸）的命令行入口 + 契约自检
 *
 * 为什么要有这条命令：
 *   能力包的价值不在文档，而在「换台机器、换个会话，也能一条命令复现同一份 payload」。
 *   styles.json 是风格真源，reverse.capabilities.json 是模型接线真源，providers/seedream.js 是执行真源——
 *   三者一旦漂移（改了风格没改接线、改了尺寸没改白名单），出图会静默变差。verify 就是那道闸。
 *
 * 用法：
 *   node tools/capability.mjs                       # = verify（自检，末行「全部通过」）
 *   node tools/capability.mjs list
 *   node tools/capability.mjs show --ability muse-atmosphere [--json]
 *   node tools/capability.mjs payload --ability douyin-face --tier 1.5K --ratio 9:16 [--out p.json]
 *   node tools/capability.mjs payload --ability muse-atmosphere --stage motion --note "雨夜街头"
 *   node tools/capability.mjs probe                 # 探活：无 key 如实报 SR_NO_API_KEY，不假装可用
 *
 * 零依赖：只用 node: 内置模块。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SPEC = path.join(ROOT, 'spec', 'reverse.capabilities.json');
const compose = require(path.join(ROOT, 'prompt', 'compose.js'));
const seedream = require(path.join(ROOT, 'server', 'providers', 'seedream.js'));

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m' };

function caps() { return JSON.parse(fs.readFileSync(SPEC, 'utf8')); }
function stylesDoc() { return JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt', 'styles.json'), 'utf8')); }

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

function parseValues(str) {
  const v = {};
  for (const seg of String(str || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    const k = seg.slice(0, i).trim();
    let val = seg.slice(i + 1).trim();
    if (val === 'true') val = true; else if (val === 'false') val = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    v[k] = val;
  }
  return v;
}

function makeProvider() {
  const p = seedream.createSeedreamProvider({ registry: null });
  return p;
}

/* ───────────── 子命令 ───────────── */

function cmdList() {
  const c = caps();
  console.log(`${C.bold}逆向能力包${C.reset} v${c.version} · 目标 ${c.target.provider} / ${c.target.default_model}`);
  for (const a of c.abilities) {
    const r = a.seedream_recipe || {};
    console.log(`  ${C.green}${a.id}${C.reset}  ${a.name}  [${a.reverse_mode}]  默认 ${r.tier || '1.5K'} × ${r.ratio || '9:16'}  ${C.dim}${a.stage_prompt && Object.keys(a.stage_prompt).length} 段${C.reset}`);
  }
}

function cmdShow(flags) {
  const c = caps();
  const a = c.abilities.find((x) => x.id === flags.ability);
  if (!a) { console.error(`未知能力 ${flags.ability}；可选：${c.abilities.map((x) => x.id).join(', ')}`); process.exit(2); }
  if (flags.json) { console.log(JSON.stringify(a, null, 2)); return; }
  console.log(`${C.bold}${a.name}${C.reset}（${a.id}）· 逆向方式 ${a.reverse_mode}`);
  console.log(`\n${C.yellow}不变量（缺一条就退化成别的风格）${C.reset}`);
  a.invariants.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log(`\n${C.yellow}失败模式${C.reset}`);
  for (const f of a.failure_modes) console.log(`  · ${f.symptom} ← ${f.cause}\n    修：${f.fix}`);
  console.log(`\n${C.yellow}各阶段提示词${C.reset}`);
  for (const [k, v] of Object.entries(a.stage_prompt)) console.log(`  [${k}] ${v}`);
  const r = a.seedream_recipe || {};
  console.log(`\n${C.yellow}Seedream 接线${C.reset}`);
  console.log(`  tier=${r.tier} ratio=${r.ratio} model=${r.model} optimize=${JSON.stringify(r.optimize_prompt_options)}`);
  console.log(`  软负面（5.0 无 negative_prompt 字段，只能并入 prompt 尾部）：${r.soft_negative}`);
  if (r.consistency_plan) console.log(`  一致性：${r.consistency_plan}`);
  console.log(`\n${C.dim}验收闸（yield_gate）：正向段必须命中 ${a.yield_gate.must_contain_any.length} 组关键词；禁止出现 ${a.yield_gate.must_not_contain.join('、')}${C.reset}`);
}

function cmdPayload(flags) {
  const p = makeProvider();
  const job = {
    id: 'cli', kind: 'image', ability: flags.ability,
    stage: flags.stage || 'keyframe', tier: flags.tier || null, ratio: flags.ratio || null,
    size: flags.size || null, model: flags.model || null, note: flags.note || null,
    values: parseValues(flags.values), dryRun: true,
  };
  const compiled = p.compilePayload(job);
  const out = {
    ability: compiled.ability, ability_name: compiled.ability_name,
    stage: compiled.stage, tier: compiled.tier, ratio: compiled.ratio,
    size: compiled.size, pixels: compiled.pixels, cost_cny_est: compiled.cost_cny_est,
    prompt: compiled.prompt, positive: compiled.positive, soft_negative: compiled.soft_negative,
    payload: compiled.payload, warnings: compiled.warnings,
    negative_field_supported: false,
  };
  if (flags.out) {
    const abs = path.resolve(flags.out);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(out, null, 2) + '\n', 'utf8');
  }
  if (flags.json || flags.out) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`${C.bold}${out.ability_name}${C.reset} · ${out.tier} × ${out.ratio} → ${out.size}（${out.pixels.toLocaleString()} px，¥${out.cost_cny_est}/张）`);
    console.log(`\n${C.yellow}prompt${C.reset}\n${out.prompt}`);
    console.log(`\n${C.yellow}payload${C.reset}\n${JSON.stringify(out.payload, null, 2)}`);
    if (out.warnings.length) console.log(`\n${C.yellow}警告${C.reset}\n${out.warnings.map((w) => `  · ${w.text || w.code}`).join('\n')}`);
    console.log(`\n${C.dim}5.0 无 negative_prompt 字段：软负面已并入 prompt 末句（negative_field_supported:false）${C.reset}`);
  }
}

async function cmdProbe() {
  const p = makeProvider();
  const r = await p.probe({ force: true });
  console.log(JSON.stringify(r, null, 2));
  process.exitCode = 0; // 无 key 是真实状态，不是脚本失败
}

/* ───────────── verify：契约自检 ───────────── */

function verify() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  const c = caps();
  const sd = stylesDoc();
  const p = makeProvider();

  ok('spec schema 正确', c.schema === 'ai-video-platform/reverse.capabilities', c.schema);
  ok('能力数 = 2', c.abilities.length === 2, c.abilities.length);

  // 1) 能力 id 必须与 styles.json 一一对应（风格真源不复制，只引用）
  for (const a of c.abilities) {
    const st = sd.styles.find((s) => s.id === a.id);
    ok(`风格存在：${a.id}`, !!st, st ? st.name : '缺失');
    ok(`风格名一致：${a.id}`, st && st.name === a.name, st && `${st.name} vs ${a.name}`);
    ok(`覆盖 overrides：${a.id}`, st && st.structured_delta && Object.values(st.structured_delta).some((arr) => Array.isArray(arr) && arr.some((x) => x.overrides)), '需要接管默认画风，否则渲染成古装厚涂');
  }

  // 2) 档位表自洽：像素/成本与官方约束一致
  for (const t of c.tiers) {
    const v = seedream.validateSize(t.size);
    ok(`档位尺寸合法 ${t.tier}×${t.ratio}`, v.ok, v.ok ? `${t.pixels}px` : v.reason);
    ok(`档位像素记录一致 ${t.size}`, v.ok && v.pixels === t.pixels, `${v.pixels} vs ${t.pixels}`);
    const cost = seedream.estimateCost(t.pixels);
    ok(`档位成本一致 ${t.size}`, cost === t.cost_cny, `${cost} vs ${t.cost_cny}`);
  }
  ok('计费分界 ≤2.61M → 0.30', seedream.estimateCost(2610000) === 0.3, seedream.estimateCost(2610000));
  ok('计费分界 >2.61M → 0.60', seedream.estimateCost(2610001) === 0.6, seedream.estimateCost(2610001));
  ok('尺寸越界会拒（800x800 像素不足）', !seedream.validateSize('800x800').ok, seedream.validateSize('800x800').reason);
  ok('尺寸越界会拒（宽高比 1:20）', !seedream.validateSize('400x8000').ok, seedream.validateSize('400x8000').reason);

  // 3) 每个能力都能编译出可提交 payload，且过 yield_gate
  for (const a of c.abilities) {
    let compiled;
    try {
      compiled = p.compilePayload({ id: 'verify', kind: 'image', ability: a.id, values: {}, dryRun: true });
      ok(`payload 可编译：${a.id}`, true, `${compiled.size} ¥${compiled.cost_cny_est}`);
    } catch (e) {
      ok(`payload 可编译：${a.id}`, false, `${e.code || ''} ${e.message}`);
      continue;
    }
    const pv = seedream.validateSize(compiled.size);
    ok(`payload 尺寸合法：${a.id}`, pv.ok, compiled.size);
    ok(`payload 无 negative_prompt 字段：${a.id}`, !('negative_prompt' in compiled.payload), Object.keys(compiled.payload).join(','));
    ok(`payload 声明 negative_field_supported:false：${a.id}`, compiled.negative_field_supported === false, '');

    // 正向段（不含软负面）必须命中 gate 的每一组
    const positive = compiled.positive;
    for (const group of a.yield_gate.must_contain_any) {
      const hit = group.find((kw) => positive.toLowerCase().includes(String(kw).toLowerCase()));
      ok(`正向命中「${group[0]}」：${a.id}`, !!hit, hit || `缺 ${group.join('/')}`);
    }
    // 正向段不许出现社会标签词（标签只许待在卡片名/别名里）
    for (const bad of a.yield_gate.must_not_contain) {
      ok(`正向不含「${bad}」：${a.id}`, !positive.includes(bad), bad);
    }
    // 平台黑名单：编译层不该放行这些词
    const lint = compose.lint(positive);
    ok(`提示词过平台黑名单：${a.id}`, lint.hits.length === 0, lint.hits.map((h) => h.word).join(','));
    ok(`中文长度 ≤ 300（官方建议）：${a.id}`, compiled.prompt_zh_chars <= 300, `${compiled.prompt_zh_chars} 字`);
    ok(`软负面不产生双句号：${a.id}`, !compiled.prompt.includes('。。'), '');
    // 前置条件必须真的生效（douyin 的『鹅蛋脸』若还在，提示词里就有两套脸型）
    if (a.preconditions && a.preconditions.substitutions && a.preconditions.substitutions.length) {
      for (const s of a.preconditions.substitutions) {
        ok(`前置替换生效「${s.find}→${s.replace}」：${a.id}`, !positive.includes(s.find), s.find);
      }
    }
    if (a.id === 'douyin-face') {
      ok('瓜子脸骨相已进正向段', positive.includes('瓜子脸'), '');
    }
  }

  // 4) 三家真源不许漂移：provider 内置 SIZE_MAP 必须与 spec 档位表一致
  for (const t of c.tiers) {
    ok(`SIZE_MAP 一致 ${t.tier}×${t.ratio}`, seedream.SIZE_MAP[t.tier] && seedream.SIZE_MAP[t.tier][t.ratio] === t.size, `${seedream.SIZE_MAP[t.tier] && seedream.SIZE_MAP[t.tier][t.ratio]}`);
  }

  // 5) provider 形状：jobs.js 只认 { id, mode, probe, run, cancel }
  ok('provider id = seedream', p.id === 'seedream', p.id);
  ok('provider mode = real（不伪装 mock）', p.mode === 'real', p.mode);
  ok('provider 有 probe/run/cancel', typeof p.probe === 'function' && typeof p.run === 'function' && typeof p.cancel === 'function', '');

  // 6) registry 已注册（server 路由/jobs 靠它解析）
  const { PROVIDER_IDS } = require(path.join(ROOT, 'server', 'providers', 'index.js'));
  ok('provider 已注册到工厂', PROVIDER_IDS.includes('seedream'), PROVIDER_IDS.join(','));

  // 6b) 跨模块一致性：cine 一句话电影的人脸正向块不许再写回塑料条款（第四真源）
  try {
    const CINE = require(path.join(ROOT, 'server', 'cine.js'));
    ok('cine FACE_POS 不复读「no visible pores」', !CINE.FACE_POS.includes('no visible pores'), '');
    ok('cine FACE_POS 与能力包皮相同源（保毛孔）', CINE.FACE_POS.includes('visible skin pores retained') && CINE.FACE_POS.includes('dewy highlight'), '');
    ok('cine FACE_NEG 不把毛孔当缺陷', !CINE.FACE_NEG.includes('natural visible pores'), '');
  } catch (e) {
    ok('cine.js 可加载以做一致性检查', false, e.message);
  }

  // 7) 无 key 时必须如实报错，不许 throw、不许静默 mock
  const probe = seedream.createSeedreamProvider({ apiKey: '' });
  probe.probe({ force: true }).then((r) => {
    const noKey = r.reachable === false && r.detail && r.detail.code === 'SR_NO_API_KEY';
    ok('无 key 时 probe 如实 false/SR_NO_API_KEY', noKey, JSON.stringify(r.detail && r.detail.code));
    finish();
  }).catch((e) => { ok('无 key 时 probe 不 throw', false, e.message); finish(); });

  function finish() {
    const bad = results.filter((r) => !r.pass);
    for (const r of results) {
      const mark = r.pass ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      console.log(`${mark} ${r.name}${r.detail && !r.pass ? `  ${C.dim}(${r.detail})${C.reset}` : ''}`);
    }
    console.log('');
    if (bad.length) {
      console.log(`${C.red}失败 ${bad.length} 项 / 共 ${results.length} 项${C.reset}`);
      process.exit(1);
    }
    console.log(`${C.green}全部通过${C.reset}（${results.length} 项）`);
    process.exit(0);
  }
}

/* ───────────── main ───────────── */

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'verify';
const { flags } = parseArgs(argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv);

const run = async () => {
  if (cmd === 'list') return cmdList();
  if (cmd === 'show') return cmdShow(flags);
  if (cmd === 'payload') return cmdPayload(flags);
  if (cmd === 'probe') return cmdProbe();
  if (cmd === 'verify' || cmd === 'selftest') return verify();
  console.error(`未知子命令 ${cmd}；可用：list / show / payload / probe / verify`);
  process.exit(2);
};

run();
