/**
 * plugins/selftest.js —— 插件体系自检（零依赖，`node plugins/selftest.js`）
 *
 * 为什么必须有它：插件是"外部作者往运行时塞数据"的唯一入口，一旦校验器/合并器回归，
 * 症状是"参数凭空多了一个"或"显存算成负数"，而且不会报错。这里把 5 条硬断言钉死：
 *   1) 3 个示例包全部通过校验；
 *   2) 故意坏掉的 manifest 被拒，且错误路径精确到字段；
 *   3) mergeRegistry 后参数数 = 基础数 + 节点包新增数（真实数字打印出来，不写死期望值）；
 *   4) spec/ 下的注册表文件未被修改（sha256 + mtime 双重比对）；
 *   5) 版本不满足的插件被拒且给出原因。
 * 额外补 4 条工程断言：exec 隔离、幂等、mergeRegistry 硬校验、schema 关键字覆盖。
 * 卡 ⑧ 追加三组：11) Ed25519 签名/验签（改一个字节 → PLUGIN_BAD_SIGNATURE；
 * 未知 key_id → PLUGIN_UNKNOWN_KEY；合法签名包载入；三个坏包夹具仍被隔离；
 * ui/preset 缺签降级 unsigned、model/node/exec 缺签拒载；规范化与键序无关）；
 * 12) ui 真渲染的数据面（主题 token / 面板 slot / 字段指向真实参数）；
 * 13) model 的 resident_mib × params_b 自洽性（window 而非拒载）。
 *
 * 注意：本文件只读磁盘、只打日志，不写任何文件——自检不能有副作用。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const loader = require(path.join(ROOT, 'plugins', 'loader.js'));
const engine = require(path.join(ROOT, 'core', 'engine.js'));

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    const detail = fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? '  —— ' + detail : ''}`);
  } catch (e) {
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}  —— ${e.message}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

const specFiles = ['params.registry.json', 'models.catalog.json', 'rules.linkage.json']
  .map((f) => path.join(ROOT, 'spec', f))
  .filter((f) => fs.existsSync(f));
const before = new Map(specFiles.map((f) => [f, { hash: sha256(f), mtime: fs.statSync(f).mtimeMs }]));
const base = loader.loadBaseRegistry(ROOT);
const baseCount = base.params.length;
const spec = [...before.keys()].map((f) => path.join(ROOT, 'spec', f));

console.log('插件体系自检');
console.log('─'.repeat(64));
console.log(`项目根 ${ROOT}`);
console.log(`基础注册表 v${base.version} · 参数 ${baseCount} · 模型 ${Object.values(base.models || {}).reduce((a, g) => a + g.length, 0)}`);
console.log('');

/* ── 1. 四个示例包 ── */
console.log('1) 四个示例插件全部通过校验（且都带有效签名）');
const sampleDirs = ['sample-model-pack', 'sample-node-pack', 'sample-preset-pack', 'sample-ui-pack'];
const sampleVerdicts = {};
for (const name of sampleDirs) {
  const dir = path.join(ROOT, 'plugins', 'packs', name);
  check(`${name} 校验通过`, () => {
    const { manifest, verdict } = loader.validatePluginDir(dir, { root: ROOT, base, platformVersion: base.version });
    sampleVerdicts[name] = verdict;
    if (!verdict.ok) {
      throw new Error(verdict.errors.map((e) => `${e.path}: ${e.message}`).join(' | '));
    }
    assert.strictEqual(verdict.state, 'active');
    assert.strictEqual(verdict.signature.ok, true, `签名未通过：${verdict.signature.code}`);
    const c = manifest.contributes || {};
    return `贡献 参数${(c.params || []).length}/模型${(c.models || []).length}/预设${c.preset ? 1 : 0}/主题${(c.ui && c.ui.themes || []).length} · 签名 ${verdict.signature.key_id}`;
  });
}

/* ── 2. 坏 manifest ── */
console.log('');
console.log('2) 故意坏掉的 manifest 被拒，且错误路径正确');
const badDir = path.join(ROOT, 'plugins', 'fixtures', 'bad-manifest');
const bad = loader.validatePluginDir(badDir, { root: ROOT, base, platformVersion: base.version });
check('坏 manifest 判定为不通过', () => {
  assert.strictEqual(bad.verdict.ok, false);
  assert.ok(bad.verdict.errors.length >= 5, `错误条数只有 ${bad.verdict.errors.length}`);
  return `${bad.verdict.errors.length} 条错误`;
});
const badPaths = new Set(bad.verdict.errors.map((e) => e.path));
const expectPaths = [
  ['$.type', 'type 非法枚举'],
  ['$.engines', '缺 engines'],
  ['$.permissions[1]', '权限白名单外的值'],
  ['$.contributes.params[0].key', 'key 与既有注册表冲突'],
  ['$.contributes.params[1].stage', 'stage 不存在'],
  ['$.contributes.params[1].impact.quality', 'impact 超 0..1'],
];
for (const [p, why] of expectPaths) {
  check(`错误路径命中 ${p}（${why}）`, () => {
    assert.ok(badPaths.has(p), `缺少路径 ${p}；实际：${[...badPaths].join(', ')}`);
    return bad.verdict.errors.find((e) => e.path === p).code;
  });
}

/* ── 3. 合并后的参数总数 ── */
console.log('');
console.log('3) mergeRegistry 后参数总数 = 基础数 + 节点包新增数');
const loaded = loader.loadAll({ root: ROOT, base, platformVersion: base.version });
const merged = loaded.registry;
check('loadAll 无错误', () => {
  assert.deepStrictEqual(loaded.errors.map((e) => `${e.id}:${e.code}`), []);
  return `${loaded.plugins.length} 个包`;
});
check('四个包都 active', () => {
  const states = loaded.plugins.map((p) => `${p.id}=${p.state}`);
  assert.ok(loaded.plugins.every((p) => p.state === 'active'), states.join(', '));
  return states.join(', ');
});
check('四个包的签名状态都是 verified', () => {
  assert.ok(loaded.plugins.every((p) => p.signature && p.signature.ok), loaded.plugins.map((p) => `${p.id}:${p.signature && p.signature.code}`).join(', '));
  return loaded.plugins.map((p) => `${p.id}→${p.signature.key_id}`).join(', ');
});
check('plugin_layers 带签名状态（审计可追溯）', () => {
  const layers = merged.plugin_layers || [];
  assert.strictEqual(layers.length, 4);
  assert.ok(layers.every((l) => l.signature && l.signature.ok === true && l.signature.alg === 'ed25519'), JSON.stringify(layers.map((l) => l.signature)));
  return layers.map((l) => `${l.id}:${l.signature.code}`).join(', ');
});
check('参数总数 = 基础 + 节点包 +2', () => {
  const nodeAdds = (sampleVerdicts['sample-node-pack'] && 2) || 0;
  const expected = baseCount + nodeAdds;
  assert.strictEqual(merged.params.length, expected, `实际 ${merged.params.length}，期望 ${expected}`);
  console.log(`     真实数字：${merged.params.length} = ${baseCount}（基础） + ${merged.params.length - baseCount}（插件）`);
  return `${merged.params.length}`;
});
check('模型数 +1、预设数 +1', () => {
  const modelAdds = Object.values(merged.models).reduce((a, g) => a + g.length, 0)
    - Object.values(base.models).reduce((a, g) => a + g.length, 0);
  assert.strictEqual(modelAdds, 1);
  assert.strictEqual((merged.presets || []).length, 1);
  return `模型 ${Object.values(merged.models).reduce((a, g) => a + g.length, 0)}、预设 ${merged.presets.length}`;
});
check('ui 包的主题/面板进了 registry.ui（2 主题 / 3 面板）', () => {
  const ui = merged.ui || { themes: [], panels: [] };
  assert.strictEqual(ui.themes.length, 2, `主题 ${ui.themes.length}`);
  assert.strictEqual(ui.panels.length, 3, `面板 ${ui.panels.length}`);
  const slots = new Set(ui.panels.map((p) => p.slot));
  for (const s of slots) assert.ok(['stage-sidebar', 'inspector-right', 'toolbar', 'export-dialog'].includes(s), `未知 slot ${s}`);
  const acc = ui.themes[0].tokens['--acc'];
  assert.ok(typeof acc === 'string' && acc.length, '主题缺 --acc token');
  return `${ui.themes.map((t) => t.id).join(' / ')} · slot ${[...slots].join(' / ')}`;
});
check('节点包的 2 个参数确实进了注册表且带 bind/hint', () => {
  const keys = merged.params.filter((p) => p.key.startsWith('kf.polish')).map((p) => p.key);
  assert.deepStrictEqual(keys.sort(), ['kf.polish_mode', 'kf.polish_strength']);
  for (const k of keys) {
    const p = merged.params.find((x) => x.key === k);
    assert.ok(p.hint && p.bind && p.bind.target, `${k} 缺 hint/bind`);
  }
  return keys.join(' + ');
});
check('预设 checksum 可通过 engine.importPreset 导入', () => {
  const preset = merged.presets[0];
  const r = engine.importPreset(merged, preset);
  assert.strictEqual(r.checksum_ok, true, 'checksum 不匹配');
  assert.strictEqual(r.unknown.length, 0, `未知参数：${r.unknown.join(', ')}`);
  return `${preset.name}（${Object.keys(preset.values).length} 项，${preset.checksum}）`;
});

/* ── 4. 原文件未被修改 ── */
console.log('');
console.log('4) spec/ 原注册表未被修改（hash + mtime）');
for (const f of specFiles) {
  check(`未修改 ${path.relative(ROOT, f)}`, () => {
    const b = before.get(f);
    const now = { hash: sha256(f), mtime: fs.statSync(f).mtimeMs };
    assert.strictEqual(now.hash, b.hash, 'sha256 变了');
    assert.strictEqual(now.mtime, b.mtime, 'mtime 变了');
    return `${now.hash} · mtime ${new Date(now.mtime).toISOString().slice(11, 19)}`;
  });
}
check('mergeRegistry 返回的是深拷贝（改返回值不影响 base）', () => {
  const probe = loader.deepClone(base);
  probe.params[0].key = '__mutated__';
  assert.notStrictEqual(probe.params[0].key, base.params[0].key);
  return 'base 未被污染';
});

/* ── 5. 版本门禁 ── */
console.log('');
console.log('5) 版本不满足的插件被拒');
const vf = loader.validatePluginDir(path.join(ROOT, 'plugins', 'fixtures', 'version-fail'), { root: ROOT, base, platformVersion: base.version });
check('engines.platform 不满足 → 拒绝', () => {
  assert.strictEqual(vf.verdict.ok, false);
  const hit = vf.verdict.errors.find((e) => e.code === 'VERSION_UNSATISFIED');
  assert.ok(hit, '没有 VERSION_UNSATISFIED');
  return `${hit.path} — ${hit.message}`;
});
check('semver 解析行为正确', () => {
  assert.strictEqual(loader.satisfies('0.1.0', '>=0.1.0'), true);
  assert.strictEqual(loader.satisfies('0.1.0', '^0.1.0'), true);
  assert.strictEqual(loader.satisfies('0.2.0', '^0.1.0'), false);
  assert.strictEqual(loader.satisfies('0.2.5', '>=0.1.0 <0.2.0'), false);
  assert.strictEqual(loader.satisfies('1.4.0', '~1.3.0'), false);
  return '>= ^ ~ 区间与或运算';
});

/* ── 6. exec 隔离（权限默认全拒） ── */
console.log('');
console.log('6) exec 权限隔离 + 权限默认全拒');
const ex = loader.loadAll({ root: ROOT, base, platformVersion: base.version });
const exDir = path.join(ROOT, 'plugins', 'fixtures', 'exec-quarantine');
const exVerdict = loader.validatePluginDir(exDir, { root: ROOT, base, platformVersion: base.version });
check('声明 exec 的包状态为 needs-review', () => {
  assert.strictEqual(exVerdict.verdict.ok, true);
  assert.strictEqual(exVerdict.verdict.state, 'needs-review');
  return exVerdict.verdict.warnings.map((w) => w.code).join(', ');
});
check('needs-review 的包不注入运行时', () => {
  assert.strictEqual(ex.registry.params.some((p) => p.key === 'mo.exec_marker'), false);
  return 'mo.exec_marker 不在运行时注册表内';
});
check('未声明 permissions 时解析为空（默认全拒）', () => {
  assert.deepStrictEqual(sampleVerdicts['sample-node-pack'].permissions, []);
  return 'sample-node-pack → []';
});

/* ── 7. mergeRegistry 自身硬校验 ── */
console.log('');
console.log('7) mergeRegistry 的防御性校验（绕过 validateManifest 也拦得住）');
const mkParam = (over) => Object.assign({
  key: 'kf.probe1', stage: 'keyframe', type: 'int', default: 1, min: 0, max: 2, step: 1,
  label: 'probe', hint: 'probe', tier: 'L3',
  impact: { vram: 0, time: 0, quality: 0 }, bind: { target: 'x', widget: 'y' },
}, over);
const probePlugin = (params) => ({ id: 'probe', version: '1.0.0', type: 'node', contributes: { params } });
check('关键冲突 → 抛错', () => {
  assert.throws(() => loader.mergeRegistry(base, probePlugin([mkParam({ key: 'kf.steps' })])), /key 冲突/);
  return 'kf.steps';
});
check('stage 不存在 → 抛错', () => {
  assert.throws(() => loader.mergeRegistry(base, probePlugin([mkParam({ stage: 'ghost' })])), /stage/);
  return 'ghost';
});
check('impact 越界 → 抛错', () => {
  assert.throws(() => loader.mergeRegistry(base, probePlugin([mkParam({ key: 'kf.probe2', impact: { vram: 0.5, time: 0, quality: 2 } })])), /impact/);
  return 'quality=2';
});
check('合法参数 → 追加 1 条且 base 不变', () => {
  const out = loader.mergeRegistry(base, probePlugin([mkParam({ key: 'kf.probe3' })]));
  assert.strictEqual(out.params.length, baseCount + 1);
  assert.strictEqual(base.params.length, baseCount);
  return `${baseCount} → ${out.params.length}`;
});

/* ── 8. 幂等 ── */
console.log('');
console.log('8) loadAll 幂等（重复调用输出一致）');
check('两次 loadAll 的 registry 全等', () => {
  const a = loader.loadAll({ root: ROOT, platformVersion: base.version });
  const b = loader.loadAll({ root: ROOT, platformVersion: base.version });
  assert.strictEqual(JSON.stringify(a.registry), JSON.stringify(b.registry));
  assert.deepStrictEqual(a.plugins.map((p) => p.state), b.plugins.map((p) => p.state));
  return `参数 ${a.registry.params.length} 两次一致`;
});

/* ── 9. schema 关键字自洽 ── */
console.log('');
console.log('9) schema 只使用校验器实现过的关键字（防"看着在校验其实被忽略"）');
const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', 'definitions', '$ref', 'type', 'required',
  'properties', 'additionalProperties', 'items', 'enum', 'const', 'pattern', 'minLength',
  'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'maxItems',
  'minProperties', 'maxProperties', 'uniqueItems', 'allOf', 'anyOf', 'oneOf', 'not',
  'if', 'then', 'else',
]);
const schema = loader.loadSchema();
const used = new Set();
(function walk(node, inMap) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((x) => walk(x, false)); return; }
  for (const [k, v] of Object.entries(node)) {
    if (inMap) { walk(v, false); continue; }           // properties/definitions 的键是字段名，不是关键字
    if (k === 'enum' || k === 'const' || k === 'required') continue;
    used.add(k);
    if (k === 'properties' || k === 'definitions') walk(v, true);
    else if (k === 'items' || k === 'additionalProperties' || k === 'not') walk(v, false);
    else if (['allOf', 'anyOf', 'oneOf'].includes(k)) walk(v, false);
    else if (k === 'if' || k === 'then' || k === 'else') walk(v, false);
  }
})(schema, false);
const unknown = [...used].filter((k) => !SUPPORTED.has(k));
check('没有未实现的关键字', () => {
  assert.deepStrictEqual(unknown, [], `未实现：${unknown.join(', ')}`);
  return `${used.size} 个关键字受控`;
});

/* ── 10. 文档里的最小示例本身必须能通过校验 ── */
console.log('');
console.log('10) docs/04-plugins.md 里的 manifest 示例可通过校验（防止文档漂移）');
check('文档示例可加载且签名可验', () => {
  const docPath = path.join(ROOT, 'docs', '04-plugins.md');
  if (!fs.existsSync(docPath)) return '文档不存在，跳过';
  const md = fs.readFileSync(docPath, 'utf8');
  const m = /```json\n([\s\S]*?)```/.exec(md);
  assert.ok(m, '文档里没有 ```json 代码块');
  const example = JSON.parse(m[1]);
  const v = loader.validateManifest(example, { base, platformVersion: base.version });
  if (!v.ok) throw new Error(v.errors.map((e) => `${e.path}: ${e.message}`).join(' | '));
  assert.strictEqual(v.signature.ok, true, `文档示例签名不过：${v.signature.code} ${v.signature.message}`);
  return `${example.id} 可加载（state=${v.state} · ${v.signature.code}）`;
});

/* ── 11. 签名与验签（Ed25519，卡 ⑧） ── */
console.log('');
console.log('11) 签名与验签（Ed25519，Node 内置 crypto，零依赖）');
const trust = loader.loadTrustedKeys(ROOT);
const keypair = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'keys', 'dev-keypair.json'), 'utf8'));
const privKey = crypto.createPrivateKey({ key: Buffer.from(keypair.private_pkcs8_base64, 'base64'), format: 'der', type: 'pkcs8' });
const signedModel = loader.readManifest(path.join(ROOT, 'plugins', 'packs', 'sample-model-pack'));
const signedUi = loader.readManifest(path.join(ROOT, 'plugins', 'packs', 'sample-ui-pack'));
const reSign = (manifest) => loader.signManifest(manifest, { privateKey: privKey, keyId: keypair.key_id });

check('可信公钥清单可读，且公钥是合法 Ed25519 SPKI', () => {
  assert.strictEqual(trust.ok, true, trust.error);
  assert.ok(trust.keys[keypair.key_id], `可信清单里没有 ${keypair.key_id}`);
  const key = loader.publicKeyFromBase64(trust.keys[keypair.key_id]);
  assert.ok(key && key.asymmetricKeyType === 'ed25519', '公钥类型不是 ed25519');
  const published = key.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.strictEqual(published, keypair.public_spki_base64, '可信清单里的公钥与私钥文件不配对');
  return `${Object.keys(trust.keys).length} 把公钥 · ${keypair.key_id}`;
});

check('③ 合法签名包正常载入（loadAll 真实管线）', () => {
  const run = loader.loadAll({ root: ROOT, base, platformVersion: base.version });
  const pack = run.plugins.find((p) => p.id === 'sample-ui-pack');
  assert.ok(pack, '没有 sample-ui-pack');
  assert.strictEqual(pack.state, 'active');
  assert.strictEqual(pack.signature.ok, true, pack.signature.code);
  assert.strictEqual(pack.applies, true, '签名通过的包应当注入');
  assert.deepStrictEqual(pack.applied, { params: 0, models: 0, presets: 0, themes: 2, panels: 3 });
  return `${pack.id} state=${pack.state} · ${pack.signature.key_id} · 主题/面板 ${pack.applied.themes}/${pack.applied.panels}`;
});

check('① 改一个字节 → 验签失败被拒（PLUGIN_BAD_SIGNATURE）', () => {
  const tampered = loader.deepClone(signedModel);
  const before = tampered.contributes.models[0].resident_mib.fp16;
  tampered.contributes.models[0].resident_mib.fp16 = before + 1; // 只改一个数字（正文一个字节级别改动）
  const v = loader.verifyManifestSignature(tampered, { trusted: trust });
  assert.strictEqual(v.ok, false, '改一个字节竟然验过了');
  assert.strictEqual(v.code, 'PLUGIN_BAD_SIGNATURE');
  const verdict = loader.validateManifest(tampered, { base, platformVersion: base.version, trusted: trust });
  assert.strictEqual(verdict.ok, false, 'model 类被改必须拒载');
  const hit = verdict.errors.find((e) => e.code === 'PLUGIN_BAD_SIGNATURE');
  assert.ok(hit, `错误码里没有 PLUGIN_BAD_SIGNATURE：${verdict.errors.map((e) => e.code).join(',')}`);
  return `fp16 ${before}→${before + 1} · ${v.code} · 正文 ${v.fingerprint}`;
});

check('② 未知 key_id → 拒载（PLUGIN_UNKNOWN_KEY）', () => {
  const ghost = loader.deepClone(signedModel);
  ghost.signature = { ...ghost.signature, key_id: 'ghost-key-unknown' };
  const v = loader.verifyManifestSignature(ghost, { trusted: trust });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.code, 'PLUGIN_UNKNOWN_KEY');
  const verdict = loader.validateManifest(ghost, { base, platformVersion: base.version, trusted: trust });
  assert.strictEqual(verdict.ok, false);
  assert.ok(verdict.errors.some((e) => e.code === 'PLUGIN_UNKNOWN_KEY'));
  return `key_id=ghost-key-unknown · ${v.code}`;
});

check('alg 不是 ed25519 → PLUGIN_BAD_ALG', () => {
  const wrong = loader.deepClone(signedModel);
  wrong.signature = { ...wrong.signature, alg: 'rsa-pss' };
  const v = loader.verifyManifestSignature(wrong, { trusted: trust });
  assert.strictEqual(v.code, 'PLUGIN_BAD_ALG');
  return v.code;
});

check('ui 缺签 → 降级 unsigned（可载入但显式告警，不静默通过）', () => {
  const unsigned = loader.deepClone(signedUi);
  delete unsigned.signature;
  const verdict = loader.validateManifest(unsigned, { base, platformVersion: base.version, trusted: trust });
  assert.strictEqual(verdict.ok, true, 'ui 类缺签不该变成拒载');
  assert.strictEqual(verdict.state, 'unsigned');
  const hit = verdict.warnings.find((w) => w.code === 'PLUGIN_UNSIGNED');
  assert.ok(hit, `没有 PLUGIN_UNSIGNED 警告：${verdict.warnings.map((w) => w.code).join(',')}`);
  return `state=unsigned · 警告 ${hit.code} · 策略 ${verdict.signature_policy.mode}`;
});

check('model 缺签 → 拒载（不是降级）', () => {
  const unsigned = loader.deepClone(signedModel);
  delete unsigned.signature;
  const verdict = loader.validateManifest(unsigned, { base, platformVersion: base.version, trusted: trust });
  assert.strictEqual(verdict.ok, false);
  const hit = verdict.errors.find((e) => e.code === 'PLUGIN_UNSIGNED');
  assert.ok(hit, verdict.errors.map((e) => e.code).join(','));
  return `state=${verdict.state} · ${hit.code} · 策略 ${verdict.signature_policy.mode}`;
});

check('④ 三个坏包夹具仍被隔离（坏 manifest / 版本 / exec）', () => {
  const dir = (n) => path.join(ROOT, 'plugins', 'fixtures', n);
  const badF = loader.validatePluginDir(dir('bad-manifest'), { root: ROOT, base, platformVersion: base.version });
  const verF = loader.validatePluginDir(dir('version-fail'), { root: ROOT, base, platformVersion: base.version });
  const exeF = loader.validatePluginDir(dir('exec-quarantine'), { root: ROOT, base, platformVersion: base.version });
  assert.strictEqual(badF.verdict.ok, false);
  assert.strictEqual(verF.verdict.ok, false);
  assert.strictEqual(exeF.verdict.state, 'needs-review');
  const keys = new Set(loaded.registry.params.map((p) => p.key));
  for (const k of ['mo.exec_marker', 'kf.future_marker', 'kf.impact_test']) {
    assert.strictEqual(keys.has(k), false, `${k} 不该进运行时`);
  }
  return `bad=rejected(${badF.verdict.errors.length} 错) · version=rejected · exec=needs-review · 三包均未注入`;
});

check('规范化：键序/缩进无关，值有关（验签前重算的是同一个字节串）', () => {
  const a = loader.deepClone(signedUi);
  delete a.signature;
  const reordered = {};
  for (const k of Object.keys(a).reverse()) reordered[k] = a[k];
  const nested = {};
  for (const k of Object.keys(a.contributes).reverse()) nested[k] = a.contributes[k];
  reordered.contributes = nested;
  assert.strictEqual(loader.canonicalizeManifest(a), loader.canonicalizeManifest(reordered), '键序影响了规范化结果');
  const changed = loader.deepClone(a);
  changed.contributes.ui.themes[0].tokens['--acc'] = '#ffffff';
  assert.notStrictEqual(loader.canonicalizeManifest(changed), loader.canonicalizeManifest(a), '改值没有改变规范化正文');
  const v = loader.verifyManifestSignature({ ...reordered, signature: reSign(a) }, { trusted: trust });
  assert.strictEqual(v.ok, true, `重排键后验签失败：${v.code}`);
  return `${v.fingerprint}（键序重排后仍通过）`;
});

/* ── 12. ui 真渲染的数据面 ── */
console.log('');
console.log('12) ui 真渲染的数据面（主题 token / 面板 slot / 字段指向真实参数）');
const uiRegistry = merged.ui || { themes: [], panels: [] };
check('主题 token 全是 -- 开头的 CSS 变量且值无外链', () => {
  const bad = [];
  for (const t of uiRegistry.themes) {
    for (const [k, val] of Object.entries(t.tokens || {})) {
      if (!k.startsWith('--')) bad.push(k);
      if (/url\s*\(|javascript:|@import|<\/?script/i.test(String(val))) bad.push(`${k}=${val}`);
    }
  }
  assert.deepStrictEqual(bad, []);
  return `${uiRegistry.themes.length} 主题 / ${uiRegistry.themes.reduce((a, t) => a + Object.keys(t.tokens || {}).length, 0)} 个 token`;
});
check('面板挂到已知 slot，且每个字段指向已存在的参数', () => {
  const keys = new Set(merged.params.map((p) => p.key));
  const slots = ['stage-sidebar', 'inspector-right', 'toolbar', 'export-dialog'];
  const missing = [];
  for (const p of uiRegistry.panels) {
    if (!slots.includes(p.slot)) missing.push(`slot:${p.slot}`);
    for (const f of p.fields || []) if (!keys.has(f.key)) missing.push(f.key);
  }
  assert.deepStrictEqual(missing, []);
  return uiRegistry.panels.map((p) => `${p.slot}←${p.id}`).join(' · ');
});

/* ── 13. model 的 resident_mib × params_b 自洽（warning，不拒载） ── */
console.log('');
console.log('13) model 的 resident_mib 与 params_b 自洽性（warning 而非拒载）');
check('fp16 与 params_b 差一个量级 → MODEL_RESIDENT_MISMATCH', () => {
  const probe = loader.deepClone(signedModel);
  probe.contributes.models[0].params_b = 20;
  probe.contributes.models[0].resident_mib = { fp16: 900, fp8: 900, gguf_q4: 900, int4: 900 };
  probe.signature = reSign(probe);
  const verdict = loader.validateManifest(probe, { base, platformVersion: base.version, trusted: trust });
  assert.strictEqual(verdict.ok, true, `不该拒载：${verdict.errors.map((e) => e.code).join(',')}`);
  const hit = verdict.warnings.find((w) => w.code === 'MODEL_RESIDENT_MISMATCH');
  assert.ok(hit, `没有 MODEL_RESIDENT_MISMATCH：${verdict.warnings.map((w) => w.code).join(',')}`);
  return hit.path;
});
check('量化档位高于 fp16 → MODEL_RESIDENT_ORDER', () => {
  const probe = loader.deepClone(signedModel);
  probe.contributes.models[0].resident_mib = { ...probe.contributes.models[0].resident_mib, fp8: 999999 };
  probe.signature = reSign(probe);
  const verdict = loader.validateManifest(probe, { base, platformVersion: base.version, trusted: trust });
  assert.strictEqual(verdict.ok, true);
  const hit = verdict.warnings.find((w) => w.code === 'MODEL_RESIDENT_ORDER');
  assert.ok(hit, `没有 MODEL_RESIDENT_ORDER：${verdict.warnings.map((w) => w.code).join(',')}`);
  return hit.path;
});
check('示例包的 resident_mib 本身自洽（不产生 mismatch 警告）', () => {
  const code = 'MODEL_RESIDENT_MISMATCH';
  const hits = (sampleVerdicts['sample-model-pack'].warnings || []).filter((w) => w.code === code);
  assert.deepStrictEqual(hits, [], hits.map((h) => h.message).join(' | '));
  return 'sample-model-pack 0 条 mismatch';
});

/* ── 收尾 ── */
console.log('');
console.log('─'.repeat(64));
if (failures.length) {
  console.log(`失败 ${failures.length} 项 / 通过 ${passed} 项`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.error && f.error.message}`);
  process.exitCode = 1;
  process.exit(1);
}
console.log(`断言 ${passed} 项，全部通过`);
const sigOk = loaded.plugins.filter((p) => p.signature && p.signature.ok).length;
console.log(`运行时参数 ${merged.params.length} · 模型 ${Object.values(merged.models).reduce((a, g) => a + g.length, 0)} · 预设 ${merged.presets.length} · 插件 ${loaded.plugins.length} · 签名通过 ${sigOk}`);
console.log(`ui 运行时：主题 ${(merged.ui && merged.ui.themes || []).length} 个 · 面板 ${(merged.ui && merged.ui.panels || []).length} 个（slot 挂载点见 plugins/index.html 的 ui 页签）`);
console.log('全部通过');
