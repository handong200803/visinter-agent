#!/usr/bin/env node
/**
 * snap_market.mjs —— 模板市场的 Node 侧快照（真实数据，不手编）
 *
 * 为什么要有这一步：
 *   入口 HTML 是 file:// 双击打开的，页面里既不能 fetch 本地 JSON（CORS 拦死），
 *   也不该在浏览器里重算估算（那会把 core/engine.js 整个搬进页面）。
 *   所以「读包 → 解析 → 与注册表对照 → 验签」全部在这里做完，落成 market/snapshot.json，
 *   再由 tools/build_module.mjs 整块内联成 window.__SNAP。
 *
 * 数据来源（全部只读，本脚本不写除 market/snapshot.json 以外的任何文件）：
 *   market/samples/*.avptpl     模板包正文（5 个）
 *   spec/params.registry.json   参数注册表：stages 中文名 + 258 个参数的默认值/中文名
 *   spec/models.catalog.json    设备档位（显存口径）
 *   market/store/index.json     仓库索引：安装量 / 真实评分（排序口径的输入）
 *   market/sign.js              验签实现（报告里不替它下结论，只搬运返回值）
 *
 * 验签的口径限制（写进页面，不粉饰）：
 *   samples 用 market/build_samples.js 里的 DEMO_SECRET 签名。这个密钥写在仓库里，
 *   所以这里能做的是「用演示密钥复算 HMAC 并对摘要」——它能证明文件未被篡改，
 *   但不能证明来源归属（任何人都能拿这把演示密钥重签）。真正的来源校验需要平台私钥，
 *   仓库里没有私钥，本脚本也不伪造「已验证签发方」的结论。
 *
 * 跑法：node tools/snap_market.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

const OUT = path.join(ROOT, 'market', 'snapshot.json');
const SAMPLES_DIR = path.join(ROOT, 'market', 'samples');
const REG_FILE = path.join(ROOT, 'spec', 'params.registry.json');
const CAT_FILE = path.join(ROOT, 'spec', 'models.catalog.json');
const IDX_FILE = path.join(ROOT, 'market', 'store', 'index.json');
const BUILDER_FILE = path.join(ROOT, 'market', 'build_samples.js');

const sign = require('../market/sign.js');
const pack = require('../market/pack.js');

const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function twoDigit(n) {
  return n < 10 ? '0' + n : String(n);
}
/** 本地时间串（口径条要给人看，ISO 的 Z 反而要换算一次） */
function localStamp(d) {
  return `${d.getFullYear()}-${twoDigit(d.getMonth() + 1)}-${twoDigit(d.getDate())} ${twoDigit(d.getHours())}:${twoDigit(d.getMinutes())}`;
}

/* ── 1. 注册表：板块中文名 + 参数默认值/中文名 ───────────────────────── */
if (!fs.existsSync(REG_FILE)) {
  console.error(`${C.red}缺 spec/params.registry.json，无法生成快照${C.reset}`);
  process.exit(1);
}
const registry = readJSON(REG_FILE);
const paramMap = new Map();
for (const p of registry.params || []) paramMap.set(p.key, p);

const stages = (registry.stages || []).map((s) => ({
  id: s.id,
  code: s.code || '',
  name: s.name || s.id,
  desc: s.desc || '',
  param_count: s.count || (s.params ? s.params.length : 0) || 0,
}));
const stageName = new Map(stages.map((s) => [s.id, s.name]));
const stageCode = new Map(stages.map((s) => [s.id, s.code]));

const catalog = fs.existsSync(CAT_FILE) ? readJSON(CAT_FILE) : { devices: [] };
const devices = (catalog.devices || []).map((d) => ({
  id: d.id,
  name: d.name || d.id,
  usable_mib: typeof d.usable_mib === 'number' ? d.usable_mib : null,
}));

/* ── 2. 仓库索引：安装量 / 真实评分（排序口径的输入） ─────────────────── */
let index = { items: [] };
if (fs.existsSync(IDX_FILE)) {
  try {
    index = readJSON(IDX_FILE);
    if (!Array.isArray(index.items)) index.items = [];
  } catch (e) {
    console.warn(`${C.yellow}  !${C.reset} market/store/index.json 读不动（${e.message}），安装量与评分按 0 计`);
  }
}
const byId = new Map(index.items.map((it) => [it.id, it]));

/* ── 3. 验签密钥：仓库里的演示密钥（找不到就老实说找不到） ───────────── */
const DEMO_SECRET = (() => {
  if (!fs.existsSync(BUILDER_FILE)) return null;
  const m = /DEMO_SECRET\s*=\s*'([^']+)'/.exec(fs.readFileSync(BUILDER_FILE, 'utf8'));
  return m ? m[1] : null;
})();

/* ── 4. 读包 ─────────────────────────────────────────────────────────── */
const files = fs.existsSync(SAMPLES_DIR)
  ? fs.readdirSync(SAMPLES_DIR).filter((f) => f.endsWith('.avptpl')).sort()
  : [];

const REASON = {
  unsigned: '包里 signature 为 null，未验签',
  no_secret: '仓库里没有可用密钥，无法复算摘要',
  key_mismatch: 'key_id 与密钥指纹不一致',
  digest_mismatch: '摘要不一致：正文被改过或文件损坏',
};

/** 差异方向：数字比大小，其余只判等（给枚举/text 编一个箭头是假精度） */
function dirOf(tplValue, defValue) {
  const same = JSON.stringify(tplValue) === JSON.stringify(defValue);
  if (same) return 'same';
  if (typeof tplValue === 'number' && typeof defValue === 'number') return tplValue > defValue ? 'up' : 'down';
  return 'diff';
}

const seenIds = new Map(); // 血缘解析要等全部读完：先存原始对象
const rawTemplates = [];

for (const f of files) {
  const absPath = path.join(SAMPLES_DIR, f);
  const text = fs.readFileSync(absPath, 'utf8');
  const bytes = Buffer.byteLength(text);
  let tpl = null;
  let parseError = null;
  try {
    tpl = JSON.parse(text);
  } catch (e) {
    parseError = e.message;
  }
  rawTemplates.push({ file: f, absPath, bytes, tpl, parseError, text });
}

/* 名字表：血缘里出现的 id 若能对上别的包，就显示名字，对不上就说对不上 */
const nameOfId = new Map();
for (const r of rawTemplates) if (r.tpl && r.tpl.id) nameOfId.set(r.tpl.id, r.tpl.name || r.tpl.id);

const templates = [];
const counts = { cover_rows: 0, coverage_rows: 0, noreg: 0, sig_ok: 0, sig_fail: 0, pack_ok: 0, pack_fail: 0, value_rows: 0 };

for (const r of rawTemplates) {
  if (!r.tpl) {
    templates.push({
      id: r.file.replace(/\.avptpl$/, ''),
      name: r.file,
      file: 'market/samples/' + r.file,
      size_bytes: r.bytes,
      error: 'JSON 解析失败：' + r.parseError,
    });
    continue;
  }
  const tpl = r.tpl;
  const values = tpl.values && typeof tpl.values === 'object' ? tpl.values : {};
  const valueKeys = Object.keys(values);
  const cover = Array.isArray(tpl.cover_params) ? tpl.cover_params.slice() : [];
  counts.value_rows += valueKeys.length;
  counts.cover_rows += cover.length;

  /* 覆盖参数表：values 全量 + 标记哪几条是封面参数；查不到的键标「注册表未收录」 */
  const coverage = valueKeys.map((k) => {
    const p = paramMap.get(k);
    const row = {
      key: k,
      is_cover: cover.includes(k),
      tpl: values[k],
      def: p ? p.default : null,
      type: p ? p.type : null,
      label: p ? p.label || p.key : null,
      stage: p ? p.stage : null,
      stage_name: p ? stageName.get(p.stage) || p.stage : null,
      in_registry: !!p,
      dir: null,
    };
    if (!p) {
      row.dir = 'noreg';
      counts.noreg++;
    } else {
      row.dir = dirOf(values[k], p.default);
    }
    return row;
  });
  /* 封面参数若没出现在 values 里（作者只写了 cover_params），单独补一行说明，不要静默丢 */
  const coverMissing = cover.filter((k) => !valueKeys.includes(k)).map((k) => {
    const p = paramMap.get(k);
    return { key: k, label: p ? p.label : null, in_registry: !!p, in_values: false };
  });
  coverage.sort((a, b) => (b.is_cover - a.is_cover) || String(a.key).localeCompare(String(b.key)));
  counts.coverage_rows += coverage.length;

  /* 签名：把 sign.js 的返回值原样搬过来，不加工成"已认证" */
  const sig = tpl.signature && typeof tpl.signature === 'object' ? tpl.signature : null;
  let sigVerify;
  if (!sig) {
    sigVerify = { ok: false, reason: 'unsigned' };
  } else if (!DEMO_SECRET) {
    sigVerify = { ok: false, reason: 'no_secret' };
  } else {
    try {
      sigVerify = sign.verifySignature(tpl, DEMO_SECRET);
    } catch (e) {
      sigVerify = { ok: false, reason: 'error:' + e.message };
    }
  }
  const reasonText = sigVerify.ok
    ? '用演示密钥复算 HMAC 并对上摘要（证明文件未改；不能证明来源归属，密钥在仓库里）'
    : REASON[sigVerify.reason] || ('未通过：' + sigVerify.reason);
  if (sigVerify.ok) counts.sig_ok++; else counts.sig_fail++;

  /* 结构校验：pack.verify 是仓库自己的判定（版本、checksum、值域、定价自洽） */
  let packVerify;
  try {
    const v = pack.verify(tpl, registry);
    packVerify = { ok: v.ok, errors: v.errors.map((e) => e.code), warnings: v.warnings.map((e) => e.code) };
  } catch (e) {
    packVerify = { ok: false, errors: ['verify_throw:' + e.message], warnings: [] };
  }
  if (packVerify.ok) counts.pack_ok++; else counts.pack_fail++;

  /* 定价：模板自报价 + 规则算出来的档位/建议价（pack.js 是唯一事实源） */
  const quality = tpl.estimate_meta && typeof tpl.estimate_meta.quality === 'number' ? tpl.estimate_meta.quality : null;
  const stageCount = Array.isArray(tpl.stage_focus) ? tpl.stage_focus.length : 0;
  const band = quality === null ? null : pack.bandOf(quality);
  let suggestion = null;
  if (quality !== null) {
    try {
      suggestion = pack.suggestPrice({
        license: tpl.license,
        quality,
        stage_count: stageCount,
        ex_resolution: values['ex.resolution'],
      });
    } catch (e) {
      suggestion = null;
    }
  }
  const price = tpl.pricing && typeof tpl.pricing.price_cny === 'number' ? tpl.pricing.price_cny : null;
  const priceMatches = !!(suggestion && price !== null && suggestion.mode === (tpl.pricing || {}).mode && suggestion.price_cny === price);

  const st = byId.get(tpl.id) || null;
  const rating = st && st.rating ? { avg: st.rating.avg || 0, count: st.rating.count || 0, sum: st.rating.sum || 0 } : { avg: 0, count: 0, sum: 0 };
  const installs = st && typeof st.installs === 'number' ? st.installs : 0;
  const rank = installs * 1 + rating.avg * 2 + rating.count * 0.5;

  /* 原始包：格式化 JSON，截断到合理长度并标明截断 */
  const LIMIT = 5200;
  const pretty = JSON.stringify(tpl, null, 2);
  const truncated = pretty.length > LIMIT;

  templates.push({
    id: tpl.id,
    name: tpl.name || tpl.id,
    version: tpl.version || '',
    author: tpl.author || '',
    license: tpl.license || '',
    registry_version: tpl.registry_version || '',
    created: tpl.created || '',
    tags: Array.isArray(tpl.tags) ? tpl.tags : [],
    stage_focus: Array.isArray(tpl.stage_focus) ? tpl.stage_focus : [],
    stage_focus_named: (Array.isArray(tpl.stage_focus) ? tpl.stage_focus : []).map((id) => ({
      id,
      code: stageCode.get(id) || '',
      name: stageName.get(id) || null,
    })),
    cover_params: cover,
    cover_params_missing: coverMissing,
    values,
    value_count: valueKeys.length,
    coverage,
    lineage: {
      derived_from: (tpl.lineage && Array.isArray(tpl.lineage.derived_from)) ? tpl.lineage.derived_from : [],
      resolved: ((tpl.lineage && tpl.lineage.derived_from) || []).map((id) => ({ id, name: nameOfId.get(id) || null })),
      parent_checksum: tpl.lineage ? tpl.lineage.parent_checksum || null : null,
      origin: tpl.lineage ? tpl.lineage.origin || '' : '',
    },
    compat: {
      min_platform: (tpl.compat || {}).min_platform || '',
      max_tested: (tpl.compat || {}).max_tested || '',
      platform: (tpl.compat || {}).platform || '',
      registry_version: tpl.registry_version || '',
    },
    pricing: {
      mode: (tpl.pricing || {}).mode || '',
      price_cny: price,
      share: (tpl.pricing || {}).share || null,
      basis: (tpl.pricing || {}).basis || '',
      tier: (tpl.pricing || {}).tier || (band ? band.band : ''),
      band: band ? band.band : null,
      band_max: band ? band.max : null,
      band_price: band ? band.price : null,
      rule_quality: quality,
      suggestion,
      matches_rule: priceMatches,
    },
    signature: {
      present: !!sig,
      algo: sig ? sig.algo || '' : '',
      key_id: sig ? sig.key_id || '' : '',
      signed_at: sig ? sig.signed_at || '' : '',
      issuer: sig ? sig.issuer || '' : '',
      scope: sig ? sig.scope || '' : '',
      value: sig ? sig.value || '' : '',
      verify: { ok: !!sigVerify.ok, reason: sigVerify.reason || (sigVerify.ok ? 'ok' : 'unknown') },
      reason_text: reasonText,
      secret_source: DEMO_SECRET ? 'market/build_samples.js · DEMO_SECRET' : null,
    },
    pack_verify: packVerify,
    estimate_meta: tpl.estimate_meta || null,
    build: tpl.build || null,
    checksum: tpl.checksum || '',
    file: 'market/samples/' + r.file,
    size_bytes: r.bytes,
    manifest_json: truncated ? pretty.slice(0, LIMIT) : pretty,
    manifest_truncated: truncated,
    manifest_chars: pretty.length,
    store: {
      in_repo: !!st,
      installs,
      rating,
      rank: +rank.toFixed(3),
      file: st ? st.file || '' : '',
      size_bytes: st ? st.size_bytes || 0 : 0,
      installed_at: st ? st.installed_at || '' : '',
      updated_at: st ? st.updated_at || '' : '',
      raters: st && st.raters ? Object.keys(st.raters).length : 0,
    },
  });
  seenIds.set(tpl.id, true);
}

templates.sort((a, b) => (b.store.rank - a.store.rank) || String(a.id).localeCompare(String(b.id)));

const now = new Date();
const snapshot = {
  schema: 'ai-video-platform/market-snapshot',
  format: 1,
  generated_at: now.toISOString(),
  generated_at_local: localStamp(now),
  generator: 'tools/snap_market.mjs',
  sources: {
    templates: { dir: 'market/samples', pattern: '*.avptpl', files: files.length },
    registry: { file: 'spec/params.registry.json', version: registry.version || '', updated: registry.updated || '', params: paramMap.size },
    catalog: { file: 'spec/models.catalog.json', version: catalog.version || '', devices: devices.length },
    index: { file: 'market/store/index.json', items: index.items.length, updated: index.updated || '' },
    signer: { file: 'market/sign.js', algo: sign.ALGO, secret_source: DEMO_SECRET ? 'market/build_samples.js · DEMO_SECRET' : null },
  },
  rank_w: { installs: 1, avg: 2, count: 0.5 },
  registry: {
    version: registry.version || '',
    updated: registry.updated || '',
    counts: registry.counts || null,
    param_count: paramMap.size,
    stages,
  },
  devices,
  license_note: 'license 三选一（free/paid/revenue_share），口径见 market/spec/license.md；包内 pricing.mode 必须与 license 一致',
  templates,
  totals: {
    templates: templates.length,
    value_rows: counts.value_rows,
    cover_rows: counts.cover_rows,
    coverage_rows: counts.coverage_rows,
    noreg_rows: counts.noreg,
    signature_ok: counts.sig_ok,
    signature_failed: counts.sig_fail,
    pack_ok: counts.pack_ok,
    pack_failed: counts.pack_fail,
    repo_indexed: templates.filter((t) => t.store && t.store.in_repo).length,
  },
};

/* 自检：快照自身不能含 </script（会被构建器拦下，这里先拦一次给出可读报错） */
const outText = JSON.stringify(snapshot, null, 2) + '\n';
if (/<\/script/i.test(outText)) {
  console.error(`${C.red}快照里出现 </script，内联会截断页面${C.reset}`);
  process.exit(1);
}
fs.writeFileSync(OUT, outText, 'utf8');

const kb = (Buffer.byteLength(outText) / 1024).toFixed(1);
console.log(`${C.bold}市场快照${C.reset} ${C.dim}→ ${rel(OUT)}${C.reset}`);
console.log(`  ${C.cyan}模板${C.reset} ${templates.length} 个 · ${C.cyan}覆盖参数${C.reset} ${counts.coverage_rows} 条（封面 ${counts.cover_rows}）· ${C.cyan}注册表未收录${C.reset} ${counts.noreg} 条`);
console.log(`  ${C.cyan}验签${C.reset} 通过 ${counts.sig_ok} / 未通过 ${counts.sig_fail}${DEMO_SECRET ? '' : C.dim + '（无演示密钥）' + C.reset}`);
console.log(`  ${C.cyan}结构校验${C.reset} 通过 ${counts.pack_ok} / 未通过 ${counts.pack_fail} · 索引命中 ${snapshot.totals.repo_indexed}/${templates.length}`);
console.log(`  ${C.green}OK${C.reset} ${templates.length} 个模板 → ${rel(OUT)} ${C.dim}${kb}KB · ${snapshot.generated_at_local}${C.reset}`);