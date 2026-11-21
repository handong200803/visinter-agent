#!/usr/bin/env node
/**
 * tools/tpl.mjs —— 模板市场命令行（ESM，零依赖，不装 npm 包）
 *
 * 为什么 CLI 单独放 tools/ 而不是 market/：market/ 是"能力库"（CJS，可被其它脚本 require），
 * tools/ 是"入口"（ESM，参考 tools/gen_registry.mjs 的既有范式）。混在一起会让
 * `node --experimental-* ` 之类的开关互相干扰，也会让库文件里出现 process.argv 这种副作用。
 *
 * 子命令：
 *   pack --from-preset <file> --name 名称 [--id ...] [--out ...] [--secret ...] [--sign]
 *   verify <file>            [--json]
 *   install <file>           [--upgrade] [--force]
 *   list                     [--limit N]
 *   search --tag 古风 | --q 赛博 --stage motion --license paid --max-price 20 --sort rank|price|new|rating
 *   apply <id|file> [--version x.y.z] --to-json [--estimate]
 *   versions <id>            仓库里该模板的全部版本（卡⑦）
 *   rollback <id> <version>  回滚激活版本（幂等）
 *   workflow <id|file>       编译成 ComfyUI API 图（--payload 出整份 POST /api/jobs body）
 *   show <id>                [--json]
 *   rate <id> <1-5>          [--rater 名字]
 *   remove <id>              [--version x.y.z]
 *   sign <file> [--secret S] [--out <file>]
 *   selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVP = require(path.join(ROOT, 'core/engine.js'));
const pack = require(path.join(ROOT, 'market/pack.js'));
const sign = require(path.join(ROOT, 'market/sign.js'));
const { openStore } = require(path.join(ROOT, 'market/store.js'));

const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec/params.registry.json'), 'utf8'));
const store = openStore({ registry: reg });

/* ───────── 参数解析：--k v / --flag / 位置参数 ───────── */
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[k] = true;
      else { args[k] = next; i++; }
    } else args._.push(a);
  }
  return args;
}

/* CJK 宽度对齐：中文名在终端占两格，用 padEnd 会歪，市场列表必须对得齐才看得下去 */
function w(s) {
  let n = 0;
  for (const ch of String(s)) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return n;
}
function pad(s, n) {
  const t = w(s);
  return t >= n ? String(s) : String(s) + ' '.repeat(n - t);
}

function readTpl(file) {
  const f = path.resolve(file);
  if (!fs.existsSync(f)) throw new Error('文件不存在：' + f);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function printVerify(v, label) {
  console.log(`\n[verify] ${label} → ${v.ok ? '通过' : '不通过'}`);
  console.log(`  错误 ${v.errors.length} / 警告 ${v.warnings.length}`);
  for (const e of v.errors) console.log(`  ✗ ${e.code} @ ${e.path}：${e.msg}`);
  for (const w2 of v.warnings) console.log(`  ! ${w2.code} @ ${w2.path}：${w2.msg}`);
}

/**
 * 列表渲染：显存比/单格秒/质量/价格 四列是市场决策的四个关键数，必须同屏。
 * 「版本」列同时给"多版本"信息：同一 id 装过两个版本时，主行显示激活版本 +`+N`，
 * 下面补一行 `↳` 把两个版本都列出来（卡⑦要求 list 能直接看出双版本）。
 */
function printList(items, title) {
  console.log(`\n${title}（${items.length} 条）`);
  if (!items.length) { console.log('  （空）'); return; }
  const H = ['#', 'ID', '名称', '版本', '授权', '价格', '评分', '安装', '显存比', '单格', '质量', '设备', '标签'];
  const rows = items.map((it, i) => {
    const e = it.estimate_meta || {};
    const nv = (it.versions || []).length;
    return [
      String(i + 1), it.id, it.name,
      it.version + (nv > 1 ? ` +${nv - 1}` : ''),
      it.license,
      '¥' + (it.price_cny ?? 0),
      `${(it.rating && it.rating.avg) || 0}(${(it.rating && it.rating.count) || 0})`,
      String(it.installs || 0),
      e.ratio === undefined ? '—' : (e.ratio * 100).toFixed(1) + '%',
      e.shot_sec === undefined ? '—' : e.shot_sec + 's',
      e.quality === undefined ? '—' : String(e.quality),
      e.device || '—',
      (it.tags || []).slice(0, 3).join('/'),
    ];
  });
  const widths = H.map((h, i) => Math.max(w(h), ...rows.map((r) => w(r[i]))) + 2);
  console.log('  ' + H.map((h, i) => pad(h, widths[i])).join(''));
  console.log('  ' + widths.map((n) => '─'.repeat(n - 1) + ' ').join(''));
  for (const r of rows) console.log('  ' + r.map((c, i) => pad(c, widths[i])).join(''));
  const multi = items.filter((it) => (it.versions || []).length > 1);
  for (const it of multi) {
    const vs = (it.versions || []).map((v) => v.version + (v.active ? '(当前)' : ''));
    console.log(`  ↳ ${it.id} 版本：${vs.join(' / ')}（回滚：node tools/tpl.mjs rollback ${it.id} <version>）`);
  }
  console.log(`  排名口径 rank = 安装量 + 2×平均分 + 0.5×评分数`);
}

/* ───────── 各子命令 ───────── */
function cmdPack(a) {
  const src = a['from-preset'] || a.values;
  if (!src) throw new Error('需要 --from-preset <engine 预设或裸 values JSON>');
  const raw = readTpl(src);
  // 两种输入都吃：engine 的 /preset 文件（取 .values）或手写的 {参数:值} 差异表
  const values = raw && raw.schema === 'ai-video-platform/preset' ? raw.values : raw;
  const tagList = (v, d = []) => (typeof v === 'string' ? v.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : d);

  const tpl = pack.pack(reg, values, {
    id: a.id,
    name: a.name || (raw && raw.name) || path.basename(src).replace(/\.(json|avptpl)$/, ''),
    version: a.version,
    author: a.author || '匿名',
    license: a.license || 'free',
    tags: tagList(a.tags),
    stage_focus: tagList(a['stage-focus']),
    cover_params: tagList(a['cover-params']),
    device: a.device || 'T0',
    derived_from: tagList(a['derived-from']),
    origin: 'tools/tpl.mjs pack',
    min_platform: a['min-platform'],
    created: a.created,
  });
  // 显式 --price 覆盖规则表算出来的价（作者要改价时走这条路，但会留下 note 便于审计）
  if (a.price !== undefined) {
    tpl.pricing = { ...tpl.pricing, price_cny: Number(a.price), note: '作者手动定价（规则表建议 ' + tpl.pricing.price_cny + '）' };
  }
  const out = a.sign ? sign.sign(tpl, a.secret || process.env.AVP_SECRET || '') : tpl;
  const v = pack.verify(out, reg);
  printVerify(v, tpl.id);
  if (a.out) {
    const f = path.resolve(a.out.endsWith('.avptpl') ? a.out : a.out + '.avptpl');
    fs.writeFileSync(f, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`\n已写入 ${f}（${fs.statSync(f).size} 字节）`);
  } else {
    console.log('\n（未指定 --out，未落盘；可用 > 重定向或加 --out）');
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  }
  if (!v.ok) process.exitCode = 1;
}

function cmdVerify(a) {
  const tpl = readTpl(a._[0]);
  const v = pack.verify(tpl, reg);
  if (a.json) process.stdout.write(JSON.stringify({ id: tpl.id, version: tpl.version, ...v }, null, 2) + '\n');
  else printVerify(v, `${a._[0]}（${tpl.id}@${tpl.version}）`);
  // 顺带做一次真签名校验（有 --secret 才做）
  if (a.secret) {
    const sv = sign.verifySignature(tpl, a.secret);
    console.log(`  ${sv.ok ? '✓' : '✗'} 签名：${sv.ok ? '有效 key_id=' + sv.key_id : 'reason=' + sv.reason}`);
    if (!sv.ok) process.exitCode = 1;
  }
  if (!v.ok) process.exitCode = 1;
}

function cmdInstall(a) {
  const r = store.install(path.resolve(a._[0]), { upgrade: !!a.upgrade, force: !!a.force });
  console.log(`已安装 ${r.id}@${r.version} → ${r.file}`);
  console.log(`  安装量 ${r.installs}${r.reinstall ? '（同一 checksum 重复安装）' : ''}，该模板共 ${r.versions} 个版本，校验 ${r.verify.ok ? '通过' : '带警告'}`);
  if (r.verify.warnings.length) for (const w2 of r.verify.warnings) console.log('  ! ' + w2.code + '：' + w2.msg);
}

function cmdVersions(a) {
  const id = a._[0];
  if (!id) throw new Error('用法：versions <id>');
  const vs = store.versionsOf(id);
  if (!vs) throw new Error('仓库里没有 ' + id);
  console.log(`\n${id} 共 ${vs.length} 个版本：`);
  const H = ['版本', '当前', 'checksum', '签名', '字节'];
  const rows = vs.map((v) => [v.version, v.active ? '✓' : '', v.checksum, v.signed ? '已签' : '未签', String(v.size_bytes || 0)]);
  const widths = H.map((h, i) => Math.max(w(h), ...rows.map((r) => w(r[i]))) + 2);
  console.log('  ' + H.map((h, i) => pad(h, widths[i])).join(''));
  for (const r of rows) console.log('  ' + r.map((c, i) => pad(c, widths[i])).join(''));
  console.log(`  正文目录：${path.relative(ROOT, path.join(store.dir, 'tpl', id))}`);
}

function cmdRollback(a) {
  const [id, version] = a._;
  if (!id || !version) throw new Error('用法：rollback <id> <version>（版本列表见 versions <id>）');
  const r = store.rollback(id, version);
  if (!r.changed) {
    console.log(`${r.id} 已经在 ${version}，无需回滚（幂等）`);
  } else {
    console.log(`已回滚 ${r.id}：${r.from} → ${r.to}`);
  }
  // 回滚后立刻把"参数与预估"打出来，手工验收不用再跑第二遍
  const g = store.get(id);
  if (!g || !g.template) { console.log('  ! 索引有记录但正文缺失：' + (g && g.file)); return; }
  const ap = pack.applyTo(g.template, reg, {});
  const e = ap.estimate;
  console.log(`  当前生效 ${g.template.id}@${g.template.version}｜差异参数 ${Object.keys(g.template.values).length} 项｜checksum ${g.template.checksum}`);
  console.log(`  预估 设备 ${e.device.name}｜显存 ${e.vram.peak_mib}/${e.vram.usable_mib} MiB = ${(e.vram.ratio * 100).toFixed(1)}%｜单格 ${e.time.shot_sec}s｜质量 ${e.quality.score}`);
  const diff = Object.keys(g.template.values).slice(0, 8).map((k) => `${k}=${JSON.stringify(ap.values[k])}`).join('  ');
  console.log(`  关键参数（前 8 项）：${diff}`);
}

/** workflow：把模板编译成 ComfyUI API 图（可直接当 POST /api/jobs 的 template 字段） */
function cmdWorkflow(a) {
  const arg = a._[0];
  if (!arg) throw new Error('用法：workflow <id|文件路径> [--json] [--payload] [--device T1] [--version x.y.z]');
  let tpl;
  if (fs.existsSync(path.resolve(arg))) tpl = readTpl(arg);
  else {
    const g = store.get(arg, { version: a.version });
    if (!g) throw new Error('仓库里没有 ' + arg + '（也不存在同名文件）');
    if (!g.template) throw new Error('索引有记录但文件缺失：' + g.file);
    tpl = g.template;
  }
  const payload = pack.jobPayload(tpl, reg, { device: a.device, note: a.note });
  if (a.payload) { process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); return; }
  if (a.json) { process.stdout.write(JSON.stringify(payload.template, null, 2) + '\n'); return; }
  const ref = tpl.workflow_ref || {};
  console.log(`\n[workflow] ${tpl.id}@${tpl.version} → ${Object.keys(payload.template).length} 个节点（kind=${ref.kind || '—'}，synthetic=${ref.synthetic ? 'true（绑定快照图，不是可执行采样链）' : 'false'}）`);
  for (const [nid, node] of Object.entries(payload.template)) {
    const slots = Object.entries(node.inputs || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('  ');
    console.log(`  ${nid} ${node.class_type}｜${slots.slice(0, 110)}`);
  }
  const binds = ref.bindings || [];
  console.log(`  落点 ${binds.length} 个参数：${binds.map((b) => `${b.key}→${nodeTitle(payload.template, b.node)}.${b.widget}`).join('  ')}`);
  console.log(`  发送：POST /api/jobs  body = { values, device: '${payload.device}', template }  （--payload 直接输出整份 body）`);
}

function nodeTitle(workflowObj, nodeId) {
  const n = workflowObj[nodeId];
  return n && n._meta && n._meta.title ? n._meta.title : '#' + nodeId;
}

function cmdList(a) {
  printList(store.list({ limit: a.limit ? Number(a.limit) : undefined }), '本地模板仓库');
  const s = store.stats();
  console.log(`  索引：${path.relative(ROOT, store.indexFile)}｜${s.count} 条（付费 ${s.paid} / 免费 ${s.free}），${s.versions} 个版本，安装 ${s.installs} 次，评分 ${s.ratings} 次｜更新于 ${s.updated}`);
  console.log(`  正文目录：${path.relative(ROOT, path.join(store.dir, 'tpl'))}/<id>/<version>.avptpl`);
}

function cmdSearch(a) {
  const items = store.search({
    q: a.q, tag: a.tag, stage: a.stage, license: a.license,
    max_price: a['max-price'] !== undefined ? Number(a['max-price']) : undefined,
    min_price: a['min-price'] !== undefined ? Number(a['min-price']) : undefined,
    signed: a.signed ? true : undefined,
    sort: a.sort || 'rank',
    limit: a.limit ? Number(a.limit) : undefined,
  });
  const cond = Object.entries({ 关键词: a.q, 标签: a.tag, 板块: a.stage, 授权: a.license, 最高价: a['max-price'], 排序: a.sort || 'rank' })
    .filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join(' ');
  printList(items, `搜索结果（${cond || '无条件'}）`);
}

function cmdApply(a) {
  const arg = a._[0];
  if (!arg) throw new Error('用法：apply <id|文件路径> [--version x.y.z] [--to-json] [--estimate]');
  let tpl;
  if (fs.existsSync(path.resolve(arg))) tpl = readTpl(arg);
  else {
    const g = store.get(arg, { version: a.version });
    if (!g) throw new Error('仓库里没有 ' + arg + '（也不存在同名文件）');
    if (!g.template) throw new Error('索引有记录但文件缺失：' + g.file);
    tpl = g.template;
  }
  const r = pack.applyTo(tpl, reg, { device: a.device });
  if (a['to-json']) {
    // 只把 258 参数写 stdout，其它信息走 stderr，保证可以直接管道给别的工具
    process.stdout.write(JSON.stringify(r.values, null, 2) + '\n');
    process.stderr.write(`[apply] ${tpl.id}@${tpl.version}：${Object.keys(r.values).length} 参数，checksum_ok=${r.checksum_ok}\n`);
  } else {
    console.log(`\n[apply] ${tpl.id}@${tpl.version} → ${Object.keys(r.values).length}/${reg.params.length} 参数（已夹紧）`);
    const e = r.estimate;
    console.log(`  设备 ${e.device.name}｜显存 ${e.vram.peak_mib}/${e.vram.usable_mib} MiB = ${(e.vram.ratio * 100).toFixed(1)}% [${e.vram.state}]｜主导 ${e.vram.dominant}`);
    console.log(`  单格 ${e.time.shot_sec}s｜单集 ${e.time.episode_min}min｜批量 ${e.time.batch_min}min｜质量 ${e.quality.score}`);
    console.log(`  单格电费 ¥${e.cost.shot_yuan}｜单集 ¥${e.cost.episode_yuan}`);
    const diff = Object.keys(tpl.values).slice(0, 12).map((k) => `${k}=${JSON.stringify(r.values[k])}`).join('  ');
    console.log(`  差异参数（前 12 项）：${diff}`);
    if (r.linkWarnings.length) console.log('  联动提示：' + r.linkWarnings.map((x) => `[${x.level}] ${x.text.slice(0, 40)}`).join(' | '));
  }
  if (a.estimate) process.stderr.write(`[estimate] peak_mib=${r.estimate.vram.peak_mib} ratio=${r.estimate.vram.ratio} shot_sec=${r.estimate.time.shot_sec} quality=${r.estimate.quality.score}\n`);
}

function cmdShow(a) {
  const g = store.get(a._[0]);
  if (!g) throw new Error('仓库里没有 ' + a._[0]);
  if (a.json) { process.stdout.write(JSON.stringify(g, null, 2) + '\n'); return; }
  const t = g.template;
  console.log(`\n${t.name}  (${t.id}@${t.version})`);
  console.log(`  作者 ${t.author}｜授权 ${t.license}｜价格 ¥${t.pricing.price_cny}`);
  console.log(`  板块 ${t.stage_focus.join('/')}｜标签 ${t.tags.join('、')}`);
  console.log(`  注册表 ${t.registry_version}｜兼容 ≥${t.compat.min_platform}｜签 ${t.signature ? t.signature.key_id : '未签'}`);
  const e = t.estimate_meta || {};
  console.log(`  估算 ${e.device}：${e.peak_mib}/${e.usable_mib} MiB（${(e.ratio * 100).toFixed(1)}%，${e.state}），单格 ${e.shot_sec}s，质量 ${e.quality}`);
  console.log(`  封面参数 ${t.cover_params.map((k) => `${k}=${JSON.stringify(t.values[k])}`).join('  ')}`);
  console.log(`  差异参数 ${Object.keys(t.values).length} 项｜安装 ${g.item.installs}｜评分 ${g.item.rating.avg}(${g.item.rating.count})`);
  const wref = t.workflow_ref;
  console.log(`  编译 ${wref ? `${wref.kind}／${wref.nodes} 节点／${(wref.bindings || []).length} 个参数可落地${wref.synthetic ? '（synthetic 绑定快照图）' : ''}` : '缺 workflow_ref（装了不能直接编译）'}`);
  const vs = (g.item.versions || []).map((v) => v.version + (v.active ? '(当前)' : ''));
  console.log(`  版本 ${vs.join(' / ') || t.version}｜正文 ${path.relative(ROOT, g.file)}`);
}

function cmdRate(a) {
  const r = store.rate(a._[0], a._[1], { rater: a.rater });
  console.log(`${r.id} ← ${r.score} 星：平均 ${r.rating.avg}（${r.rating.count} 人），rank ${r.rank}`);
}

function cmdRemove(a) {
  const r = store.remove(a._[0], { version: a.version });
  if (!r.removed) {
    console.log(a.version ? `仓库里没有 ${a._[0]}@${a.version}` : `仓库里没有 ${a._[0]}`);
    return;
  }
  const tail = a.version
    ? `（剩 ${r.versions} 个版本，当前 ${r.active}）`
    : '（整条卸装）';
  console.log(`已移除 ${r.id}${a.version ? '@' + a.version : ''}${tail}｜文件${r.fileDeleted ? '已删除' : '不存在'}`);
}

function cmdSign(a) {
  const tpl = readTpl(a._[0]);
  const secret = a.secret || process.env.AVP_SECRET;
  if (!secret) throw new Error('需要 --secret 或环境变量 AVP_SECRET');
  const signed = sign.sign(tpl, secret, { signed_at: a['signed-at'] });
  const out = path.resolve(a.out || a._[0]);
  fs.writeFileSync(out, JSON.stringify(signed, null, 2) + '\n', 'utf8');
  const v = sign.verifySignature(signed, secret);
  console.log(`已签名 ${tpl.id}：algo=${signed.signature.algo} key_id=${signed.signature.key_id} value=${signed.signature.value.slice(0, 16)}…`);
  console.log(`  自验：${v.ok ? '通过' : '失败 ' + v.reason}｜写入 ${out}`);
}

function cmdSelftest() {
  // 直接跑 market/selftest.js（同一份代码，CLI 只是入口）
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'market/selftest.js')], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
}

const COMMANDS = {
  pack: cmdPack, verify: cmdVerify, install: cmdInstall, list: cmdList, search: cmdSearch,
  apply: cmdApply, show: cmdShow, rate: cmdRate, remove: cmdRemove, sign: cmdSign, selftest: cmdSelftest,
  versions: cmdVersions, rollback: cmdRollback, workflow: cmdWorkflow,
};

function usage() {
  console.log(`模板市场 CLI（零依赖）
用法：node tools/tpl.mjs <命令> [参数]

  pack --from-preset <file> --name 名称 [--id x] [--author 人] [--license free|paid|revenue_share]
       [--tags 古风,特写] [--stage-focus character,keyframe] [--device T0] [--derived-from id]
       [--price 18] [--sign --secret S] [--out out.avptpl]
  verify <file> [--json] [--secret S]
  install <file> [--upgrade] [--force]
  list [--limit N]
  search [--tag 古风] [--q 赛博] [--stage motion] [--license paid] [--max-price 20] [--sort rank|price|new|rating]
  apply <id|file> [--version x.y.z] [--to-json] [--device T1] [--estimate]
  versions <id>                   仓库里该模板的全部版本（标出当前激活）
  rollback <id> <version>         回滚到某个版本（幂等；正文不重下载，只移激活指针）
  workflow <id|file> [--json|--payload] [--device T1]
                                  编译成 ComfyUI API 图；--payload 直接输出 POST /api/jobs 的整份 body
  show <id> [--json]
  rate <id> <1-5> [--rater 名字]
  remove <id>
  sign <file> [--secret S] [--out file]
  selftest

注册表 ${reg.version}｜${reg.params.length} 参数｜仓库 ${path.relative(ROOT, store.dir)}`);
}

const argv = process.argv.slice(2);
const cmd = argv[0];
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); process.exit(0); }
if (!COMMANDS[cmd]) { usage(); console.error('\n未知命令：' + cmd); process.exit(2); }
try {
  COMMANDS[cmd](parseArgs(argv.slice(1)));
} catch (e) {
  console.error('[' + cmd + '] ' + e.message);
  process.exit(1);
}