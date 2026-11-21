#!/usr/bin/env node
/**
 * tools/prompt.mjs —— 提示词编译层的命令行入口
 *
 * 为什么单独做一个 CLI：编译层是纯函数，它最大的风险是"只在网页里跑通、换个人复现不出来"。
 * 一条命令能复现 full compile 输出，评审/回归/贴 issue 才有共同语言。
 *
 * 用法：
 *   node tools/prompt.mjs compose --preset standard --style 古风 --stage keyframe
 *   node tools/prompt.mjs compose --stage look --style 水墨 --set lk.sharpen=0 --json
 *   node tools/prompt.mjs lint "8K超高清杰作，best quality，一个女孩站在窗边"
 *   node tools/prompt.mjs lint --file ./prompt.txt
 *   node tools/prompt.mjs styles
 *   node tools/prompt.mjs selftest
 *
 * 零依赖：只用 node: 内置模块。compose.js 是 CJS，用 createRequire 引进来，
 * 这样同一份实现在 ESM 与 CJS 两种宿主里都能被加载。
 */

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const compose = require(path.join(ROOT, 'prompt', 'compose.js'));
const safety = require(path.join(ROOT, 'prompt', 'safety.js'));

/* ───────────── 极简参数解析（不引 yargs：零依赖是硬约束） ───────────── */

function parseArgs(argv) {
  const out = { _: [], flags: {}, sets: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) out.flags[key] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.flags[key] = argv[++i];
      else out.flags[key] = true;
      continue;
    }
    out._.push(a);
  }
  if (typeof out.flags.set === 'string') out.sets.push(out.flags.set);
  return out;
}

function die(msg, code) {
  console.error('错误: ' + msg);
  process.exit(code == null ? 2 : code);
}

const USAGE = `提示词编译层 CLI

  compose   编译提示词
    --stage   character|storyboard|keyframe|motion|voice|look|export   (默认 keyframe)
    --style   风格 id 或中文名（古风/水墨/赛博/二次元/漫剧/胶片…）
    --preset  ${Object.keys(compose.PRESETS).join('|')}                     (默认 standard)
    --set     key=value，可重复，优先级最高；例：--set kf.steps=36 --set ch.style=工笔
    --locale  zh|en   (默认 zh：positive 为中文整句，positive_en 始终提供)
    --json    只输出机器可读 JSON（全量 structured + notes + warnings）
    --notes   打印全部 notes（默认只打前 12 条）
    --no-structured  不打印 structured（只要正负向时用）

  lint <text> 或 lint --file <path>   检查黑名单词与超长冗余
  styles                              列出风格预设
  selftest                            跑 prompt/selftest.js
`;

/* ───────────── compose ───────────── */

function buildValues(flags) {
  const presetName = flags.preset || 'standard';
  const preset = compose.PRESETS[presetName];
  if (!preset) die('未知 preset: ' + presetName + '（可选：' + Object.keys(compose.PRESETS).join('/') + '）');
  // 预设只是覆盖层：注册表默认值由 compose 内部补齐
  const values = Object.assign({}, preset.values);
  return values;
}

function cmdCompose(args) {
  const f = args.flags;
  const stage = f.stage || 'keyframe';
  if (compose.STAGES.indexOf(stage) < 0) die('未知 stage: ' + stage + '（可选：' + compose.STAGES.join('/') + '）');

  const values = buildValues(f);
  // --set 覆盖优先级最高：先预设、再命令行
  const sets = args.sets.slice();
  if (typeof f.set === 'string' && sets.indexOf(f.set) < 0) sets.push(f.set);
  for (const kv of sets) {
    const i = kv.indexOf('=');
    if (i < 0) die('--set 需要 key=value 形式: ' + kv);
    const k = kv.slice(0, i).trim();
    let v = kv.slice(i + 1).trim();
    if (v === 'true') v = true; else if (v === 'false') v = false;
    else if (v !== '' && !isNaN(Number(v)) && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    values[k] = v;
  }

  const r = compose.compile(values, { stage, style: f.style, locale: f.locale || 'zh' });

  if (f.json) {
    console.log(JSON.stringify({
      stage: r.stage, style: r.style, style_name: r.style_name, target: r.target, preset: f.preset || 'standard',
      positive: r.positive, positive_zh: r.positive_zh, positive_en: r.positive_en, negative: r.negative,
      structured: r.structured, notes: r.notes, warnings: r.warnings,
    }, null, 2));
    return;
  }

  const bar = '─'.repeat(72);
  console.log(bar);
  console.log('stage=' + r.stage + '  target=' + r.target + '  preset=' + (f.preset || 'standard')
    + '  style=' + (r.style ? r.style + '(' + r.style_name + ')' : '无')
    + '  locale=' + (f.locale || 'zh'));
  console.log(bar);

  console.log('\n【正向 zh｜给 Qwen-Image 等中文底模】');
  console.log(r.positive || '(空)');
  console.log('\n【正向 en｜给 SDXL/FLUX，tag 风格】');
  console.log(r.positive_en || '(空)');
  console.log('\n【负向｜第 ' + r.stage + ' 阶段专用集】');
  console.log(r.negative || '(空)');

  const kind = r.structured.normal && r.structured.normal.negative_kind;
  if (kind && kind !== 'diffusion') console.log('（该负向集类型为 ' + kind + '：' + r.structured.normal.negative_note + '）');

  console.log('\n【告警】' + (r.warnings.length ? '' : '无'));
  for (const w of r.warnings) {
    console.log('  [' + w.level + '] ' + w.id + '  ' + w.msg);
    if (w.fix) console.log('       fix: ' + w.fix);
  }

  const limit = f.notes ? r.notes.length : 12;
  console.log('\n【notes】共 ' + r.notes.length + ' 条，显示 ' + Math.min(limit, r.notes.length) + ' 条（来源可追溯）');
  for (const n of r.notes.slice(0, limit)) {
    const tag = n.skipped ? '·跳过(' + n.skipped + ')' : (n.emits && n.emits !== 'text' ? '·' + n.emits : '');
    console.log('  ' + String(n.key).padEnd(26) + ' → ' + String(n.slot || '-').padEnd(12) + ' ' + (n.word || '') + tag);
  }

  if (!f['no-structured']) {
    console.log('\n【structured｜唯一真相源】');
    const view = {
      schema: r.structured.schema, stage: r.structured.stage, style: r.structured.style,
      target: r.structured.target,
      controls: r.structured.controls,
      cost: r.structured.cost,
      conditions: r.structured.conditions,
      slots: {},
      meta: r.structured.meta,
    };
    for (const s of compose.SLOTS) {
      const arr = r.structured.slots[s].filter((i) => !i.skip);
      if (arr.length) view.slots[s] = arr.map((i) => ({ zh: i.zh, en: i.en, w: i.w, key: i.key }));
    }
    console.log(JSON.stringify(view, null, 2));
  }
}

/* ───────────── lint ───────────── */

function cmdLint(args) {
  const f = args.flags;
  let text = args._.join(' ').trim();
  if (f.file) {
    const p = path.resolve(process.cwd(), String(f.file));
    if (!fs.existsSync(p)) die('文件不存在: ' + p);
    text = fs.readFileSync(p, 'utf8');
  }
  if (!text) die('需要一段文本：lint "提示词" 或 lint --file path');

  const r = compose.lint(text);
  const bar = '─'.repeat(72);
  console.log(bar);
  console.log('字符 ' + r.chars + ' 汉字｜tag ' + r.tags + ' 个｜超长 ' + (r.overlong ? '是' : '否')
    + '｜黑名单命中 ' + r.hits.length + '｜复读 ' + r.duplicates.length + '｜结论 ' + (r.ok ? '可用' : '需修'));
  console.log(bar);
  for (const h of r.hits) {
    console.log('  [' + h.severity + '] ' + h.word + '  → ' + h.reason);
    console.log('       改法: ' + h.replace);
  }
  for (const d of r.duplicates) console.log('  复读 ×' + d.times + ': ' + d.text);
  if (r.advice.length) {
    console.log('\n建议：');
    for (const a of r.advice) console.log('  - ' + a);
  }
  if (f.json) console.log('\n' + JSON.stringify(r, null, 2));
  process.exitCode = r.ok ? 0 : 1;
}

/* ───────────── styles ───────────── */

function cmdStyles() {
  const list = compose.listStyles();
  console.log('风格预设 ' + list.length + ' 个：');
  for (const s of list) {
    console.log('  ' + s.id.padEnd(18) + s.name.padEnd(8) + ' 别名: ' + (s.aliases || []).join('/'));
    console.log('    stage: ' + s.stages.join(','));
    console.log('    ' + s.why);
  }
}

/* ───────────── selftest ───────────── */

function cmdSelftest() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'prompt', 'selftest.js')], { stdio: 'inherit' });
  process.exitCode = r.status == null ? 1 : r.status;
}

/* ───────────── 入口 ───────────── */

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  console.log(USAGE);
  process.exit(0);
}

switch (cmd) {
  case 'compose': cmdCompose(args); break;
  case 'lint': cmdLint(args); break;
  case 'styles': cmdStyles(); break;
  case 'selftest': cmdSelftest(); break;
  case 'label': {
    // 附带能力：直接看标识包（显式文案 + 隐式字段），省得再写一个脚本
    const v = buildValues(args.flags);
    const r = compose.compile(v, { stage: args.flags.stage || 'keyframe', style: args.flags.style });
    const b = safety.labelBundle(v, {
      platform: args.flags.platform, producer: args.flags.producer,
      promptText: r.positive, stage: r.stage, style: r.style,
    });
    console.log(JSON.stringify(b, null, 2));
    break;
  }
  default:
    console.error('未知子命令: ' + cmd + '\n');
    console.log(USAGE);
    process.exit(2);
}