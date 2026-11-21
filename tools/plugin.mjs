#!/usr/bin/env node
/**
 * tools/plugin.mjs —— 插件 CLI（ESM / 零依赖 / Node ≥ 20）
 *
 * 用法：
 *   node tools/plugin.mjs list
 *   node tools/plugin.mjs validate <dir>
 *   node tools/plugin.mjs install <dir> [--apply]     # 默认 dry-run
 *   node tools/plugin.mjs info <id>
 *   node tools/plugin.mjs selftest
 *
 * 设计取舍：
 *   1) CLI 不重复实现校验逻辑，一律走 plugins/loader.js（同一份校验器 → 命令行与运行时不会打架）。
 *   2) install 默认 dry-run：插件装错会污染"参数 → 求解器"链路，宁可多一次 --apply 确认。
 *   3) CLI 不写 spec/：注册表是只读真相源，插件永远是叠加层。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loader = require(path.join(ROOT, 'plugins', 'loader.js'));

/* ── 终端对齐：中文占 2 列，按显示宽度 pad，否则表格会歪 ── */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60)
      || (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1;
  }
  return w;
}
function pad(s, n) {
  const text = String(s);
  return text + ' '.repeat(Math.max(0, n - dispWidth(text)));
}

const err = (msg) => { process.stderr.write(msg + '\n'); process.exitCode = 1; };

/* ─────────────────────── 统计辅助（list / sign 共用） ─────────────────────── */
function signatureCell(info) {
  const s = info.signature || {};
  if (!s.present) return '缺签';
  if (s.ok) return 'ok';
  return s.code || 'bad';
}

/* ─────────────────────────── list ─────────────────────────── */
function cmdList() {
  const res = loader.loadAll({ root: ROOT });
  const base = loader.loadBaseRegistry(ROOT);
  const modelCount = Object.values(base.models || {}).reduce((a, g) => a + g.length, 0);

  console.log(`插件根：${ROOT}`);
  console.log(`注册表：v${base.version} · 参数 ${base.params.length} · 模型 ${modelCount}`);
  console.log('');
  const head = [pad('ID', 22), pad('类型', 8), pad('版本', 8), pad('状态', 12), pad('签名', 22), pad('参数', 5), pad('模型', 5), pad('预设', 5), '主题/面板'].join('');
  console.log(head);
  console.log('-'.repeat(dispWidth(head)));
  for (const p of res.plugins) {
    const a = p.applied || { params: 0, models: 0, presets: 0, themes: 0, panels: 0 };
    console.log([
      pad(p.id, 22), pad(p.type || '-', 8), pad(p.version || '-', 8), pad(p.state, 12), pad(signatureCell(p), 22),
      pad(a.params, 5), pad(a.models, 5), pad(a.presets, 5), `${a.themes}/${a.panels}`,
    ].join(''));
  }
  const active = res.plugins.filter((p) => p.state === 'active');
  const review = res.plugins.filter((p) => p.state === 'needs-review');
  const unsigned = res.plugins.filter((p) => p.state === 'unsigned');
  const rejected = res.plugins.filter((p) => p.state === 'rejected');
  const mergedParams = res.registry.params.length;
  const mergedModels = Object.values(res.registry.models || {}).reduce((a, g) => a + g.length, 0);
  console.log('');
  console.log(`合计：${res.plugins.length} 个包 / active ${active.length} · needs-review ${review.length} · unsigned ${unsigned.length} · rejected ${rejected.length}`);
  console.log(`运行时：参数 ${mergedParams}（基础 ${base.params.length} + 插件 ${mergedParams - base.params.length}）· 模型 ${mergedModels} · 预设 ${(res.registry.presets || []).length}`);
  if (res.errors.length) {
    console.log('');
    console.log(`错误 ${res.errors.length} 条：`);
    for (const e of res.errors) console.log(`  [${e.id}] ${e.path} — ${e.code}: ${e.message}`);
  }
  if (res.warnings.length) {
    console.log(`提示 ${res.warnings.length} 条：`);
    for (const w of res.warnings) console.log(`  [${w.id}] ${w.path} — ${w.code}: ${w.message}`);
  }
  if (res.errors.length) process.exitCode = 1;
}

/* ─────────────────────────── validate ─────────────────────────── */
function cmdValidate(dir) {
  if (!dir) return err('用法：node tools/plugin.mjs validate <dir>');
  const abs = path.resolve(process.cwd(), dir);
  const { manifest, verdict } = loader.validatePluginDir(abs, { root: ROOT });
  if (verdict.ok) {
    console.log(`✔ 通过：${manifest.id} v${manifest.version}（type=${manifest.type}）`);
    console.log(`  状态=${verdict.state}  权限=[${verdict.permissions.join(', ') || '无（默认全拒）'}]`);
    const a = manifest.contributes || {};
    console.log(`  贡献：参数 ${(a.params || []).length} · 模型 ${(a.models || []).length} · 预设 ${a.preset ? 1 : 0} · 主题 ${(a.ui && a.ui.themes || []).length} · 面板 ${(a.ui && a.ui.panels || []).length}`);
    const s = verdict.signature || {};
    console.log(`  签名：${s.ok ? '通过' : '未通过'} ${s.code}  key_id=${s.key_id || '（无）'}  策略=${(verdict.signature_policy || {}).mode || '?'}  正文 ${s.fingerprint || ''}`);
    for (const w of verdict.warnings) console.log(`  提示 ${w.path} — ${w.message}`);
    return;
  }
  console.log(`✘ 拒绝：${manifest ? manifest.id : path.basename(abs)}  共 ${verdict.errors.length} 条错误`);
  for (const e of verdict.errors) console.log(`  ${e.path} — ${e.code}: ${e.message}`);
  process.exitCode = 2;
}

/* ─────────────────────────── install ─────────────────────────── */
function cmdInstall(dir, apply) {
  if (!dir) return err('用法：node tools/plugin.mjs install <dir> [--apply]');
  const src = path.resolve(process.cwd(), dir);
  const { manifest, verdict } = loader.validatePluginDir(src, { root: ROOT });
  if (!verdict.ok) {
    console.log(`✘ 校验失败，不安装（${verdict.errors.length} 条）：`);
    for (const e of verdict.errors) console.log(`  ${e.path} — ${e.code}: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  if (verdict.state === 'needs-review') {
    console.log('⚠ 该包声明 exec：可以落盘到 packs/，但加载时只会登记为 needs-review，不会注入运行时。');
  }

  const base = loader.loadBaseRegistry(ROOT);
  const merged = loader.mergeRegistry(base, { ...manifest, __state: 'active' });
  const a = merged.plugin_layers[merged.plugin_layers.length - 1].applied;
  const target = path.join(ROOT, 'plugins', 'packs', manifest.id);
  const exists = fs.existsSync(target);

  console.log(`包：${manifest.id} v${manifest.version}（type=${manifest.type}）`);
  console.log(`源：${src}`);
  console.log(`目标：${target}${exists ? '（已存在）' : ''}`);
  console.log(`将注入：参数 +${a.params} · 模型 +${a.models} · 预设 +${a.presets} · 主题/面板 +${a.themes}/${a.panels}`);
  console.log(`注入后：参数 ${base.params.length} → ${merged.params.length}`);
  if (verdict.state === 'needs-review') {
    console.log('注意：上面的数字是"审核放行后才会生效"的贡献量；当前状态下运行时参数不会变。');
  }

  if (!apply) {
    console.log('');
    console.log('dry-run：未落盘。确认无误后加 --apply。');
    return;
  }
  if (exists) {
    err(`目标已存在，先手动删除后再装：${target}`);
    return;
  }
  try {
    fs.cpSync(src, target, { recursive: true, errorOnExist: false });
  } catch (e) {
    // 本机受控环境里 node 的 fs 写盘可能被上层策略拦成 EPERM（读是正常的），
    // 这时给出等价的 PowerShell 落盘命令，而不是让用户以为插件本身有问题。
    console.error(`✘ 复制失败：${e.code || e.message}`);
    console.error(`  等价命令：Copy-Item -Recurse -Force "${src}" "${target}"`);
    process.exitCode = 3;
    return;
  }
  const recheck = loader.validatePluginDir(target, { root: ROOT });
  if (!recheck.verdict.ok) {
    console.log('✘ 落盘后复验失败：');
    for (const e of recheck.verdict.errors) console.log(`  ${e.path} — ${e.code}: ${e.message}`);
    process.exitCode = 2;
    return;
  }
  const after = loader.loadAll({ root: ROOT });
  console.log(`✔ 已安装并复验通过。运行时参数 ${after.registry.params.length}，插件 ${after.plugins.length} 个。`);
}

/* ─────────────────────────── info ─────────────────────────── */
function cmdInfo(id) {
  if (!id) return err('用法：node tools/plugin.mjs info <id>');
  const res = loader.loadAll({ root: ROOT });
  const hit = res.plugins.find((p) => p.id === id);
  if (!hit) return err(`未找到插件 "${id}"。可用：${res.plugins.map((p) => p.id).join(', ') || '（无）'}`);
  const manifest = loader.readManifest(path.join(ROOT, hit.dir.replace(/\//g, path.sep)));
  console.log(`id      ${hit.id}`);
  console.log(`type    ${hit.type}  v${hit.version}`);
  console.log(`state   ${hit.state}${hit.reason ? '  · ' + hit.reason : ''}`);
  console.log(`dir     ${hit.dir}`);
  console.log(`权限    [${hit.permissions.join(', ') || '无（默认全拒）'}]`);
  const sg = hit.signature || {};
  console.log(`签名    ${sg.ok ? '通过' : '未通过'} · ${sg.code || '?'} · key_id ${sg.key_id || '（无）'} · 策略 ${sg.policy || '?'}`);
  const a = hit.applied || {};
  console.log(`注入    参数 ${a.params || 0} · 模型 ${a.models || 0} · 预设 ${a.presets || 0} · 主题 ${a.themes || 0} · 面板 ${a.panels || 0}`);
  console.log('--- manifest ---');
  console.log(JSON.stringify(manifest, null, 2));
}

/* ─────────────────────────── 签名工具（keygen / sign / verify） ───────────────────────────
   为什么做进 CLI 而不是单独的脚本：签名与验签必须共用同一套规范化实现
   （plugins/loader.js 的 canonicalizeManifest）。CLI 只做 IO 与提示，
   任何"怎么排序、怎么序列化"的判断都在 loader 里 —— 工具与运行时永不打架。 */
const KEYS_DIR = path.join(ROOT, 'plugins', 'keys');
const TRUSTED_PATH = path.join(KEYS_DIR, 'trusted.json');
const DEFAULT_KEYPAIR = path.join(KEYS_DIR, 'dev-keypair.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 读可信清单（扁平 map），缺失就给空对象；keygen 会往里追加 */
function readTrusted() {
  try {
    const raw = readJson(TRUSTED_PATH);
    const map = raw && raw.keys && typeof raw.keys === 'object' ? raw.keys : raw;
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch (e) {
    return {};
  }
}

function cmdKeygen(id, force, outFile, noTrust) {
  const keyId = id || 'avp-dev-local';
  if (!/^[a-z][a-z0-9._-]{2,47}$/.test(keyId)) {
    return err(`key_id 不合法（^[a-z][a-z0-9._-]{2,47}$）：${keyId}`);
  }
  const target = outFile ? path.resolve(process.cwd(), outFile) : DEFAULT_KEYPAIR;
  if (fs.existsSync(target) && !force) {
    return err(`${target} 已存在。确要换钥匙请加 --force（已签名的包会全部验不过）`);
  }
  const pair = loader.generateKeyPair(keyId);
  writeJson(target, {
    note: '本地开发/示例签名用的密钥对。生产签名密钥必须离线保存，禁止进仓库。',
    key_id: pair.key_id,
    alg: loader.SIGN_ALG,
    public_spki_base64: pair.public_spki_base64,
    private_pkcs8_base64: pair.private_pkcs8_base64,
    created: new Date().toISOString(),
  });
  console.log('已生成 Ed25519 密钥对');
  console.log(`  私钥文件  ${path.relative(ROOT, target).split(path.sep).join('/')}`);
  console.log(`  key_id    ${keyId}`);
  console.log(`  公钥 SPKI(base64)  ${pair.public_spki_base64}`);
  if (noTrust) {
    console.log('  --no-trust：没有写 trusted.json（这把钥匙签出来的包会被判 PLUGIN_UNKNOWN_KEY）');
    return;
  }
  const trusted = readTrusted();
  trusted[keyId] = pair.public_spki_base64;
  writeJson(TRUSTED_PATH, trusted);
  console.log(`  可信清单  plugins/keys/trusted.json（新增 key_id: ${keyId}）`);
  console.log('');
  console.log('下一步：node tools/plugin.mjs sign plugins/packs/<包目录> --write   然后重跑快照与构建。');
}

/** 定位 manifest 文件：目录 → 目录/plugin.json；文件 → 原文件 */
function manifestFileOf(target) {
  const abs = path.resolve(process.cwd(), target);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return path.join(abs, 'plugin.json');
  return abs;
}

function loadSigningKey(keyFile) {
  const file = path.resolve(process.cwd(), keyFile || DEFAULT_KEYPAIR);
  if (!fs.existsSync(file)) throw new Error(`找不到私钥文件：${file}（先跑 node tools/plugin.mjs keygen）`);
  const raw = readJson(file);
  if (!raw.private_pkcs8_base64) throw new Error(`${file} 缺 private_pkcs8_base64`);
  return {
    keyId: raw.key_id,
    alg: raw.alg || loader.SIGN_ALG,
    privateKey: crypto.createPrivateKey({ key: Buffer.from(raw.private_pkcs8_base64, 'base64'), format: 'der', type: 'pkcs8' }),
  };
}

function cmdSign(target, keyFile, keyIdOverride, write) {
  if (!target) return err('用法：node tools/plugin.mjs sign <dir|plugin.json> [--key <keypair.json>] [--id <key_id>] [--write]');
  const file = manifestFileOf(target);
  if (!fs.existsSync(file)) return err(`找不到 manifest：${file}`);
  let manifest;
  try {
    manifest = readJson(file);
  } catch (e) {
    return err(`plugin.json 不是合法 JSON：${e.message}`);
  }
  let key;
  try {
    key = loadSigningKey(keyFile);
  } catch (e) {
    return err(e.message);
  }
  const keyId = keyIdOverride || key.keyId;
  const trusted = readTrusted();
  if (!trusted[keyId]) {
    console.log(`⚠ key_id "${keyId}" 不在 plugins/keys/trusted.json 里：签出来的包会被判 PLUGIN_UNKNOWN_KEY。`);
  }
  const signature = loader.signManifest(manifest, { privateKey: key.privateKey, keyId });
  const body = {};
  for (const [k, v] of Object.entries(manifest)) if (k !== 'signature') body[k] = v;
  const fingerprint = loader.signingFingerprint(body);

  console.log(`manifest  ${path.relative(ROOT, file).split(path.sep).join('/')}`);
  console.log(`key_id    ${keyId}（alg=${loader.SIGN_ALG}）`);
  console.log(`规范化正文 ${fingerprint}（键升序 · 无空白 · UTF-8 · 不含顶层 signature）`);
  console.log(`签名      ${signature.sig}`);
  if (!write) {
    console.log('');
    console.log('dry-run：未写盘。加 --write 把 signature 写回 plugin.json。');
    return;
  }
  const next = { ...body, signature };
  writeJson(file, next);
  const verdict = loader.verifyManifestSignature(next, { trusted: loader.loadTrustedKeys(ROOT) });
  console.log('');
  console.log(`✔ 已写回 ${path.relative(ROOT, file).split(path.sep).join('/')}`);
  console.log(`  复验：${verdict.ok ? '通过' : '未通过'} · ${verdict.code} · 正文 ${verdict.fingerprint}`);
  if (!verdict.ok) process.exitCode = 2;
}

function cmdVerify(target) {
  if (!target) return err('用法：node tools/plugin.mjs verify <dir|plugin.json>');
  const file = manifestFileOf(target);
  if (!fs.existsSync(file)) return err(`找不到 manifest：${file}`);
  let manifest;
  try {
    manifest = readJson(file);
  } catch (e) {
    return err(`plugin.json 不是合法 JSON：${e.message}`);
  }
  const trusted = loader.loadTrustedKeys(ROOT);
  const v = loader.verifyManifestSignature(manifest, { trusted });
  const policy = loader.signaturePolicyOf(manifest);
  console.log(`验签对象  ${path.relative(ROOT, file).split(path.sep).join('/')}`);
  console.log(`结论      ${v.ok ? '✔ 通过' : '✘ 未通过'} · ${v.code}`);
  console.log(`原因      ${v.message}`);
  console.log(`key_id    ${v.key_id || '（无）'} · alg ${v.alg || '（无）'}`);
  console.log(`规范化正文 ${v.fingerprint}`);
  console.log(`可信清单  ${trusted.path.replace(ROOT + path.sep, '')} · ${Object.keys(trusted.keys).length} 把公钥${trusted.ok ? '' : `（${trusted.error}）`}`);
  console.log(`策略      ${policy.mode} —— ${policy.why}`);
  if (!v.ok) process.exitCode = 2;
}

/* ─────────────────────────── selftest ─────────────────────────── */
function cmdSelftest() {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'plugins', 'selftest.js')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  process.exitCode = r.status === null ? 1 : r.status;
}

/* ─────────────────────────── main ─────────────────────────── */
const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1).filter((x) => !x.startsWith('--'));
const flags = new Set(argv.filter((x) => x.startsWith('--')));
/** 取 --key value 形式的值（flags 只记布尔开关，带值参数要单独抓） */
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const inline = argv.find((x) => x.startsWith(name + '='));
  return inline ? inline.slice(name.length + 1) : undefined;
}

const HELP = `插件 CLI（零依赖）
  node tools/plugin.mjs list
  node tools/plugin.mjs validate <dir>
  node tools/plugin.mjs install <dir> [--apply]
  node tools/plugin.mjs info <id>
  node tools/plugin.mjs selftest
  node tools/plugin.mjs keygen [--id <key_id>] [--out <keypair.json>] [--force] [--no-trust]   # 生成 Ed25519 密钥对并写入可信清单
  node tools/plugin.mjs sign <dir|plugin.json> [--key <keypair.json>] [--id <key_id>] [--write]
  node tools/plugin.mjs verify <dir|plugin.json>              # 只验签，打印原因码

原则：插件只能是声明式 JSON；本 CLI 不会 require/import 任何插件代码。
签名对象是规范化后的 manifest 正文（键升序 / 无空白 / UTF-8 / 不含顶层 signature），
验签由 plugins/loader.js 用 Node 内置 crypto 的 Ed25519 完成，零第三方依赖。`;

switch (cmd) {
  case 'list': cmdList(); break;
  case 'validate': cmdValidate(args[0]); break;
  case 'install': cmdInstall(args[0], flags.has('--apply')); break;
  case 'info': cmdInfo(args[0]); break;
  case 'selftest': cmdSelftest(); break;
  case 'keygen': cmdKeygen(flagValue('--id'), flags.has('--force'), flagValue('--out'), flags.has('--no-trust')); break;
  case 'sign': cmdSign(args[0], flagValue('--key'), flagValue('--id'), flags.has('--write')); break;
  case 'verify': cmdVerify(args[0]); break;
  case undefined:
  case '--help':
  case 'help': console.log(HELP); break;
  default:
    console.log(HELP);
    process.exitCode = 1;
}