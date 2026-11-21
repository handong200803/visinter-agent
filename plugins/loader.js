/**
 * plugins/loader.js —— 声明式插件加载器（CJS / Node ≥ 20 / 零第三方依赖）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 核心设计决策：插件只能是**声明式 JSON**，全流程不存在 require/import 用户代码
 * ═══════════════════════════════════════════════════════════════════════════
 * 为什么必须这样（不是洁癖，是威胁模型）：
 *   1) 插件目录 `plugins/packs/` 是唯一会让"外部作者"往里写东西的地方。一旦允许
 *      `require(plugin.main)`，等价于把 Node 的完整能力（fs 写、child_process、net）
 *      交给一个我们没审过的文件；Node 里没有"只读 JS"这种东西，`require` 一次就等于
 *      执行任意代码，任何 permissions 声明都只是自我申报，拦不住 `process.mainModule`。
 *   2) 本项目的产物是"参数 → 求解器 → 工作流"，本质是数据变换。插件真正需要提供的
 *      也只有数据：参数条目、模型标定数字、预设值、主题 token。能力边界与需求完全重合，
 *      所以"声明式"没有牺牲表达力，却把攻击面砍到只剩 JSON.parse 与字段校验。
 *   3) 可审计：一份 manifest 可以被 diff、被 schema 校验、被人工复读；一个 .js 插件
 *      不行。审计成本决定插件生态能不能在"本地视频生成平台"这种要跑用户素材的场景里存活。
 *   因此本文件里只出现三类 IO：读 plugin.json、读 spec/*.json、纯内存计算。
 *   下方 `PERMISSION_WHITELIST` 的语义是**声明式能力标签**（给审计/未来的宿主功能开关用），
 *   不是"运行时授权"——因为根本没有运行时。唯一例外语义见 exec 隔离说明。
 *
 * 另一条铁律：mergeRegistry 只返回**深拷贝**，永远不改 baseRegistry、更不写回 spec/*.json。
 * 注册表是唯一真相源，插件是"叠加层"；叠加层污染源文件会让"卸载插件"变成不可能任务。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('../core/engine.js');

const SCHEMA_PATH = path.join(__dirname, 'schema', 'plugin.schema.json');
const PACKS_SUBDIR = path.join('plugins', 'packs');
const PLUGIN_TYPES = ['model', 'node', 'preset', 'ui'];

/**
 * 签名与验签（卡 ⑧）
 *
 * 为什么要有它：`contributes.preset.checksum` 只能证明「作者算的校验和 = 内容算的校验和」，
 * 作者改内容的同时改 checksum 就通过了——它防手滑，不防伪造。插件目录是外部作者唯一能写入的
 * 位置，所以需要一把平台的钥匙：manifest 带 `signature`，公钥从仓库内可信清单读取，用 Node
 * 内置 crypto 验 Ed25519（零依赖、零 npm）。
 *
 * 签名对象是**规范化后的 manifest 正文**（去掉顶层 signature 后的纯数据）：
 *   1) 只剔除顶层 `signature`，其余字段全部参与；
 *   2) 对象键按 UTF-16 码元升序排序（含嵌套对象），数组保持原顺序；
 *   3) 无空白（无缩进/无换行），JSON 转义走 JSON.stringify 的同一套规则；
 *   4) 数字必须是有限值，编码与 JSON.stringify 一致（1 vs 1.0 视为同一个数）；
 *   5) 结果按 UTF-8 编码后喂给 crypto.sign/crypto.verify（Ed25519 不做预哈希）。
 * 验签前一定**重算**这份字节串，绝不复用"读盘时的原始文本"：文本格式（缩进、键序）不是语义，
 * 语义是解析后的对象；只认文本会让"换行符从 CRLF 变 LF"这类无害改动直接废掉签名。
 */
const SIGN_ALG = 'ed25519';
const KEYS_SUBDIR = path.join('plugins', 'keys');
const TRUSTED_KEYS_FILE = 'trusted.json';

/**
 * 签名策略：按包类型分档（不是所有包都值得为"缺签"直接拒载）。
 *   strict  —— 会改变求解器语义/显存账本，或声明了 exec：缺签、验签失败、未知 key_id 一律拒载隔离。
 *   degrade —— 只登记不执行（ui 主题/面板、preset 预设值）：降级为 state='unsigned'，显式打警告。
 * 为什么 ui/preset 能降级：它们不进显存方程、不产生参数语义，最坏情况是"主题没生效/预设导入被拒"，
 * 可逆且用户可见；而 model 的 resident_mib 错了会直接把显存算飞，node 的 impact 错了会让预估假可用。
 */
const SIGN_POLICY_DEGRADABLE = ['ui', 'preset'];

/**
 * 权限白名单。默认全拒：manifest 不写 permissions 就是 `[]`。
 *   fs:read —— 允许宿主在加载阶段读取本包目录内的附属文件（当前仅登记，未开放）
 *   net     —— 允许未来拉取远程资产（当前仅登记，加载阶段不发任何网络请求）
 *   gpu     —— 声明需要 GPU 预算（求解器会把该包模型计入显存账本）
 *   exec    —— 声明需要运行外部进程。**默认隔离**：不注入运行时，只登记为 needs-review。
 */
const PERMISSION_WHITELIST = ['fs:read', 'net', 'exec', 'gpu'];

/* ───────────────────────────── 基础工具 ───────────────────────────── */

/** 深拷贝：优先 structuredClone（Node 17+ 原生），退化到 JSON 往返。插件数据都是纯 JSON。 */
function deepClone(v) {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** 把字段路径拼成人能读的形式：$.contributes.params[0].impact.quality */
function pathJoin(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent === '$' ? `$.${key}` : `${parent}.${key}`;
}

function err(pathName, code, message) {
  return { path: pathName, code, message };
}

/* ───────────────────────── 规范化序列化（签名对象） ─────────────────────────
   递归实现，规则见文件头 SIGN_ALG 的注释。产出字符串（不是 Buffer），
   调用方决定按 UTF-8 编码；selftest 会断言"换缩进/换键序不影响签名"。
   为什么不用 JSON.stringify(value, Object.keys(value).sort())：replacer 数组只对第一层生效，
   嵌套对象仍按原顺序输出，等于签名对嵌套键序敏感 —— 一个"看起来对其实不对"的经典坑。 */
function canonicalValue(value, where) {
  const t = typeOf(value);
  if (value === null) return 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where}: 非有限数字（${value}）不能参与签名`);
    return JSON.stringify(value);
  }
  if (t === 'string') return JSON.stringify(value);
  if (t === 'array') return '[' + value.map((v, i) => canonicalValue(v, pathJoin(where, i))).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalValue(value[k], pathJoin(where, k))).join(',') + '}';
  }
  throw new Error(`${where}: 类型 ${t} 不能参与签名（插件 manifest 只允许纯 JSON）`);
}

/** manifest 的规范化正文（顶层 signature 不参与签名，否则签名要签自己）。 */
function canonicalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('canonicalizeManifest: manifest 必须是对象');
  }
  const body = {};
  for (const [k, v] of Object.entries(manifest)) {
    if (k === 'signature') continue;
    body[k] = v;
  }
  return canonicalValue(body, '$');
}

/** 真正喂给 crypto.sign / crypto.verify 的字节串（UTF-8）。 */
function signingBytes(manifest) {
  return Buffer.from(canonicalizeManifest(manifest), 'utf8');
}

/** 规范化正文的指纹：只用于错误信息定位（"你改的是哪一版"），不参与验签判定。 */
function signingFingerprint(manifest) {
  try {
    return 'sha256:' + crypto.createHash('sha256').update(signingBytes(manifest)).digest('hex').slice(0, 16);
  } catch (e) {
    return 'sha256:unavailable';
  }
}

/**
 * 读可信公钥清单。格式（扁平 map，便于人读与 diff）：
 *   { "key_id": "<base64(DER/SPKI 公钥)>", ... }
 * 也接受 { keys: { ... } } 包一层（将来加元数据时不必改读法）。
 * 读不到就返回空集合：**失败即全未签名**，由签名策略决定是拒载还是降级，绝不"读不到就放行"。
 */
function loadTrustedKeys(root) {
  const base = path.resolve(root || path.join(__dirname, '..'));
  const file = path.join(base, KEYS_SUBDIR, TRUSTED_KEYS_FILE);
  const out = { path: file, ok: false, keys: {}, error: '' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    out.error = e && e.code === 'ENOENT' ? '缺少可信公钥清单 plugins/keys/trusted.json' : `可信公钥清单不可读：${e.message}`;
    return out;
  }
  const map = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.keys && typeof raw.keys === 'object' ? raw.keys : raw;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    out.error = '可信公钥清单格式错误：应为 { key_id: base64-spki }';
    return out;
  }
  for (const [id, val] of Object.entries(map)) {
    if (typeof val === 'string' && val.trim()) out.keys[id] = val.trim();
  }
  out.ok = Object.keys(out.keys).length > 0;
  if (!out.ok) out.error = '可信公钥清单为空';
  return out;
}

/** 从 SPKI(base64) 还原公钥对象；失败返回 null（不抛，交给调用方转成原因码）。 */
function publicKeyFromBase64(b64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' });
    return key && key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch (e) {
    return null;
  }
}

/**
 * 验签。返回 { present, key_id, alg, ok, code, message, fingerprint }：
 *   code ∈ PLUGIN_SIGNATURE_OK | PLUGIN_UNSIGNED | PLUGIN_UNKNOWN_KEY | PLUGIN_BAD_ALG | PLUGIN_BAD_SIGNATURE
 * 原因码是给人看的：页面与 CLI 直接显示它，作者据此知道"是没签、签错、还是钥匙不对"。
 */
function verifyManifestSignature(manifest, options) {
  const opt = options || {};
  const trusted = opt.trusted || loadTrustedKeys(opt.root);
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const sig = m.signature;
  const res = {
    present: !!sig,
    key_id: '',
    alg: '',
    ok: false,
    code: 'PLUGIN_UNSIGNED',
    message: '',
    fingerprint: signingFingerprint(m),
    trusted_keys: Object.keys(trusted.keys || {}).length,
  };
  if (!sig || typeof sig !== 'object' || Array.isArray(sig)) {
    res.message = trusted.ok
      ? `manifest 没有 signature：无法证明内容未被改动（可信清单有 ${res.trusted_keys} 把公钥）`
      : `manifest 没有 signature，且可信清单不可用（${trusted.error}）`;
    return res;
  }
  res.key_id = typeof sig.key_id === 'string' ? sig.key_id : '';
  res.alg = typeof sig.alg === 'string' ? sig.alg : '';
  if (res.alg !== SIGN_ALG) {
    res.code = 'PLUGIN_BAD_ALG';
    res.message = `signature.alg 必须是 ${SIGN_ALG}，实际 ${JSON.stringify(sig.alg)}`;
    return res;
  }
  if (!res.key_id) {
    res.code = 'PLUGIN_UNKNOWN_KEY';
    res.message = 'signature.key_id 缺失，无法在可信清单里定位公钥';
    return res;
  }
  const b64 = trusted.keys ? trusted.keys[res.key_id] : null;
  if (!b64) {
    res.code = 'PLUGIN_UNKNOWN_KEY';
    res.message = `key_id "${res.key_id}" 不在可信清单里（可用：${Object.keys(trusted.keys || {}).join(', ') || '无'}）`;
    return res;
  }
  const key = publicKeyFromBase64(b64);
  if (!key) {
    res.code = 'PLUGIN_UNKNOWN_KEY';
    res.message = `key_id "${res.key_id}" 的公钥不是合法的 Ed25519 SPKI(base64)`;
    return res;
  }
  let sigBuf;
  try {
    sigBuf = Buffer.from(String(sig.sig || ''), 'base64');
  } catch (e) {
    sigBuf = Buffer.alloc(0);
  }
  if (sigBuf.length !== 64) {
    res.code = 'PLUGIN_BAD_SIGNATURE';
    res.message = `signature.sig 必须是 Ed25519 的 64 字节（base64 后 88 字符），实际 ${sigBuf.length} 字节`;
    return res;
  }
  let verified = false;
  try {
    // Ed25519 是"整段签名"，algorithm 传 null（传 'sha256' 会变成非法用法）
    verified = crypto.verify(null, signingBytes(m), key, sigBuf);
  } catch (e) {
    verified = false;
    res.message = `验签异常：${e.message}`;
  }
  if (!verified) {
    res.code = 'PLUGIN_BAD_SIGNATURE';
    res.message = (res.message ? res.message + '；' : '')
      + `签名与规范化正文不匹配（重算 ${res.fingerprint}）：manifest 被改过，或签名时用的不是这份正文`;
    return res;
  }
  res.ok = true;
  res.code = 'PLUGIN_SIGNATURE_OK';
  res.message = `签名通过（key_id=${res.key_id}，alg=${SIGN_ALG}，正文 ${res.fingerprint}）`;
  return res;
}

/**
 * 签名（CLI 的 keygen/sign 与 selftest 共用）。
 * privateKey 支持 PEM 字符串 / Buffer(DER) / KeyObject；keyId 必须已在可信清单里，
 * 否则签出来的包自己都验不过 —— 这比"签完再发现钥匙不对"省一轮。
 */
function signManifest(manifest, options) {
  const opt = options || {};
  if (!opt.privateKey) throw new Error('signManifest: 需要 privateKey');
  if (!opt.keyId) throw new Error('signManifest: 需要 keyId');
  const key = (opt.privateKey && typeof opt.privateKey === 'object' && opt.privateKey.type === 'private')
    ? opt.privateKey
    : crypto.createPrivateKey(opt.privateKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`signManifest: 私钥类型必须是 ed25519，实际 ${key.asymmetricKeyType}`);
  const body = {};
  for (const [k, v] of Object.entries(manifest || {})) {
    if (k === 'signature') continue;
    body[k] = v;
  }
  const sig = crypto.sign(null, signingBytes(body), key);
  return { key_id: opt.keyId, alg: SIGN_ALG, sig: sig.toString('base64') };
}

/** 生成密钥对；返回 { key_id, public_spki_base64, private_pkcs8_base64, private_pem }。 */
function generateKeyPair(keyId) {
  if (!keyId) throw new Error('generateKeyPair: 需要 key_id');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    key_id: keyId,
    public_spki_base64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    private_pkcs8_base64: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    private_pem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    public_pem: publicKey.export({ format: 'pem', type: 'spki' }),
  };
}

/**
 * 签名策略：strict（拒载隔离）还是 degrade（降级 unsigned）。
 * 声明 exec 的包无论什么类型都走 strict —— exec 是唯一有"执行"语义的声明。
 */
function signaturePolicyOf(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const perms = Array.isArray(m.permissions) ? m.permissions : [];
  if (perms.includes('exec')) return { mode: 'strict', why: '声明了 exec（执行外部能力）' };
  if (SIGN_POLICY_DEGRADABLE.includes(m.type)) {
    return { mode: 'degrade', why: `类型 ${m.type} 只登记不执行，可降级为 unsigned 并显式告警` };
  }
  return { mode: 'strict', why: `类型 ${m.type || '未知'} 不在可降级清单（ui/preset）内，缺签不放行` };
}

/* ───────────────────────────── 版本约束（最小 semver） ───────────────────────────── */

const VER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** 解析 `1.2.3` / `1.2.3-beta.1`；失败返回 null（调用方决定报什么错）。 */
function parseVersion(input) {
  if (typeof input !== 'string') return null;
  const m = VER_RE.exec(input.trim());
  if (!m) return null;
  return { maj: +m[1], min: +m[2], pat: +m[3], pre: m[4] || null, raw: input.trim() };
}

function cmpVersion(a, b) {
  for (const k of ['maj', 'min', 'pat']) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  // 预发布版本低于同号正式版：0.1.0-beta < 0.1.0
  const aw = a.pre ? 0 : 1;
  const bw = b.pre ? 0 : 1;
  return aw === bw ? 0 : aw < bw ? -1 : 1;
}

const CMP_RE = /(\^|~|>=|<=|>|<|=)?\s*(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?/g;

/**
 * 判断 version 是否满足 range。支持：单比较符 / 空（等于）/ ^ / ~，空格为"与"，`||` 为"或"。
 * 为什么自己写：为了零依赖只想引入 semver 的一个函数，代价 40 行，收益是装包 0 MB。
 */
function satisfies(version, range) {
  const v = typeof version === 'string' ? parseVersion(version) : version;
  if (!v || typeof range !== 'string' || !range.trim()) return false;
  return range
    .split('||')
    .some((clause) => {
      const text = clause.trim();
      if (!text) return false;
      const tokens = text.match(CMP_RE);
      // 整段必须被比较式吃干净，否则视为非法范围（宁可拒绝，也不猜作者意图）
      if (!tokens || tokens.join(' ').replace(/\s+/g, ' ') !== text.replace(/\s+/g, ' ')) return false;
      return tokens.every((tok) => {
        CMP_RE.lastIndex = 0;
        const m = CMP_RE.exec(tok);
        if (!m) return false;
        const op = m[1] || '=';
        const target = parseVersion(m[2]);
        if (!target) return false;
        const c = cmpVersion(v, target);
        switch (op) {
          case '>=': return c >= 0;
          case '<=': return c <= 0;
          case '>': return c > 0;
          case '<': return c < 0;
          case '=': return c === 0;
          case '^': {
            // ^1.2.3 → >=1.2.3 <2.0.0；^0.1.2 → >=0.1.2 <0.2.0（0.x 视为不稳定主版本）
            const upper = target.maj === 0
              ? { maj: 0, min: target.min + 1, pat: 0, pre: null }
              : { maj: target.maj + 1, min: 0, pat: 0, pre: null };
            return c >= 0 && cmpVersion(v, upper) < 0;
          }
          case '~': {
            // ~1.2.3 → >=1.2.3 <1.3.0
            const upper = { maj: target.maj, min: target.min + 1, pat: 0, pre: null };
            return c >= 0 && cmpVersion(v, upper) < 0;
          }
          default: return false;
        }
      });
    });
}

/* ────────────────────── 最小 JSON Schema 校验器（draft-07 子集） ────────────────────── */

let schemaCache = null;

/** 读入插件 schema。失败直接抛——schema 缺失属于项目损坏，不该被当成"插件错误"吞掉。 */
function loadSchema(force) {
  if (schemaCache && !force) return schemaCache;
  schemaCache = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return schemaCache;
}

function resolveRef(ref, rootSchema, where) {
  if (typeof ref !== 'string' || ref[0] !== '#') throw new Error(`不支持的 $ref（${where}）：${ref}`);
  let node = rootSchema;
  for (const rawSeg of ref.slice(1).split('/').filter(Boolean)) {
    const seg = rawSeg.replace(/~1/g, '/').replace(/~0/g, '~');
    node = node && node[seg];
    if (node === undefined) throw new Error(`$ref 指向不存在的位置（${where}）：${ref}`);
  }
  return node;
}

/**
 * 校验一个值。只实现本项目 schema 用到的关键字：type/enum/const/required/properties/
 * additionalProperties/items/min/max/exclusive/min|maxLength/min|maxProperties/uniqueItems/
 * pattern/allOf/anyOf/oneOf/not/if-then-else/$ref。
 * 为什么不全实现：full draft-07 解释器要 600+ 行且容易写出"看着像校验其实漏校验"的坑；
 * 这里关键字集合与 schema 文件强绑定，selftest 会断言 schema 里没出现未实现的关键字。
 */
function validateAgainstSchema(value, schema, rootSchema, where, errors, seenRefs) {
  const root = rootSchema || schema;
  const seen = seenRefs || new Set();

  if (schema === true) return errors;
  if (schema === false) {
    errors.push(err('$', 'SCHEMA_FALSE', '该字段不允许存在'));
    return errors;
  }
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.$ref) {
    const guardKey = `${where}|${schema.$ref}`;
    if (seen.has(guardKey)) return errors; // 环引用防护（本项目 schema 无环，防御性保留）
    const next = new Set(seen);
    next.add(guardKey);
    return validateAgainstSchema(value, resolveRef(schema.$ref, root, where), root, where, errors, next);
  }

  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(err(where, 'CONST_MISMATCH', `必须是 ${JSON.stringify(schema.const)}，实际 ${JSON.stringify(value)}`));
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(err(where, 'ENUM_MISMATCH', `取值必须是 ${schema.enum.join(' | ')} 之一，实际 ${JSON.stringify(value)}`));
  }

  if (schema.type) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    const okType = want.some((t) => (t === 'integer' ? Number.isInteger(value) : t === got));
    if (!okType) {
      errors.push(err(where, 'TYPE_MISMATCH', `期望 ${want.join('|')}，实际 ${got}`));
      return errors; // 类型都不对，后续关键字没有意义
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(err(where, 'TOO_SHORT', `长度 ${value.length} < ${schema.minLength}`));
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(err(where, 'TOO_LONG', `长度 ${value.length} > ${schema.maxLength}`));
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push(err(where, 'PATTERN_MISMATCH', `不匹配 ${schema.pattern}：${JSON.stringify(value)}`));
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(err(where, 'TOO_SMALL', `${value} < ${schema.minimum}`));
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(err(where, 'TOO_LARGE', `${value} > ${schema.maximum}`));
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      errors.push(err(where, 'NOT_EXCLUSIVE_MIN', `${value} 必须 > ${schema.exclusiveMinimum}`));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(err(where, 'TOO_FEW_ITEMS', `数组长度 ${value.length} < ${schema.minItems}`));
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(err(where, 'TOO_MANY_ITEMS', `数组长度 ${value.length} > ${schema.maxItems}`));
    }
    if (schema.uniqueItems) {
      const seenItems = new Set();
      value.forEach((item, i) => {
        const sig = JSON.stringify(item);
        if (seenItems.has(sig)) errors.push(err(pathJoin(where, i), 'DUPLICATE_ITEM', '数组成员重复'));
        seenItems.add(sig);
      });
    }
    if (schema.items) value.forEach((item, i) => validateAgainstSchema(item, schema.items, root, pathJoin(where, i), errors, seen));
  }

  if (typeOf(value) === 'object') {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(err(pathJoin(where, req), 'REQUIRED_MISSING', `缺少必填字段 ${req}`));
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      errors.push(err(where, 'TOO_FEW_PROPS', `字段数 ${Object.keys(value).length} < ${schema.minProperties}`));
    }
    if (typeof schema.maxProperties === 'number' && Object.keys(value).length > schema.maxProperties) {
      errors.push(err(where, 'TOO_MANY_PROPS', `字段数 ${Object.keys(value).length} > ${schema.maxProperties}`));
    }
    const props = schema.properties || {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) {
        validateAgainstSchema(v, props[k], root, pathJoin(where, k), errors, seen);
      } else if (schema.additionalProperties === false) {
        errors.push(err(pathJoin(where, k), 'UNKNOWN_FIELD', `未声明的字段（拼错？）`));
      } else if (typeof schema.additionalProperties === 'object') {
        validateAgainstSchema(v, schema.additionalProperties, root, pathJoin(where, k), errors, seen);
      }
    }
  }

  for (const sub of schema.allOf || []) validateAgainstSchema(value, sub, root, where, errors, seen);

  if (schema.anyOf) {
    const results = schema.anyOf.map((sub) => validateAgainstSchema(value, sub, root, where, [], seen));
    if (!results.some((r) => r.length === 0)) {
      errors.push(err(where, 'ANY_OF_FAILED', `anyOf 全部不满足（首条：${results[0][0] && results[0][0].message}）`));
    }
  }

  if (schema.oneOf) {
    const results = schema.oneOf.map((sub) => validateAgainstSchema(value, sub, root, where, [], seen));
    const passes = results.filter((r) => r.length === 0).length;
    if (passes !== 1) {
      errors.push(err(where, 'ONE_OF_FAILED', `oneOf 需要恰好 1 个分支通过，实际 ${passes}`));
    }
  }

  if ('not' in schema) {
    const inner = validateAgainstSchema(value, schema.not, root, where, [], seen);
    if (inner.length === 0) errors.push(err(where, 'NOT_FAILED', '命中了禁止匹配的分支'));
  }

  if (schema.if) {
    const cond = validateAgainstSchema(value, schema.if, root, where, [], seen);
    if (cond.length === 0 && schema.then) validateAgainstSchema(value, schema.then, root, where, errors, seen);
    if (cond.length > 0 && schema.else) validateAgainstSchema(value, schema.else, root, where, errors, seen);
  }

  return errors;
}

/* ───────────────────────────── 语义校验 ───────────────────────────── */

const KEY_RE = /^([a-z]{2,4})\.([a-z][a-z0-9_]*)$/;

/** 从注册表反推"前缀 → stage"映射；插件必须遵守宿主既有前缀，避免出现 kf.xxx 挂在 motion 上。 */
function prefixMap(base) {
  const map = { ...engine.PREFIX };
  for (const p of (base && base.params) || []) {
    const m = KEY_RE.exec(p.key || '');
    if (m) map[m[1]] = p.stage;
  }
  return map;
}

function stageIds(base) {
  return new Set(((base && base.stages) || []).map((s) => (typeof s === 'string' ? s : s.id)));
}

/**
 * 校验 manifest：先 schema（结构），再语义（业务规则）。
 * 返回 { ok, errors[], warnings[], state, permissions }。
 * 每条错误都带 `path`（字段路径），这是硬要求——没有路径的校验错误在插件生态里等于没有错误。
 */
function validateManifest(manifest, ctx) {
  const c = ctx || {};
  const base = c.base || { params: [], stages: [], tiers: {}, version: '0.1.0' };
  const schema = c.schema || loadSchema();
  const errors = [];
  const warnings = [];
  const platforms = c.platformVersion || (base && base.version) || '0.1.0';

  validateAgainstSchema(manifest, schema, schema, '$', errors);

  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const declaredPerms = Array.isArray(m.permissions) ? m.permissions : [];
  const permissions = declaredPerms.filter((p) => PERMISSION_WHITELIST.includes(p));

  /* —— 签名与验签（卡 ⑧） ——
     顺序放在 schema 之后：signature 形状（key_id/alg/sig）先由 schema 卡一遍，
     这里再判"钥匙在不在可信清单""签的是不是这份正文"。
     成败不直接等于拒载：按类型分档（见 signaturePolicyOf），
     ui/preset 降级为 unsigned（只登记不执行），model/node/exec 直接拒载。 */
  const policy = signaturePolicyOf(m);
  const signature = verifyManifestSignature(m, { trusted: c.trusted || loadTrustedKeys(c.root) });
  const signatureNote = signature.message;
  if (!signature.ok) {
    if (policy.mode === 'strict') {
      errors.push(err('$.signature', signature.code, `${signatureNote}；${policy.why} → 拒载并隔离`));
    } else {
      warnings.push({ path: '$.signature', code: signature.code,
        message: `${signatureNote}；${policy.why}（state=unsigned，主题/预设不会被信任执行）` });
    }
  }
  let state = !signature.ok && policy.mode === 'degrade' ? 'unsigned' : 'active';

  // 版本门禁：不满足就整包拒绝。为什么要硬拒而不是降级：插件贡献的是**语义**（参数/模型数字），
  // 在旧内核上加载新语义插件，最坏情况是求解器拿错单位算显存，用户看到"能跑"然后 OOM。
  if (m.engines && typeof m.engines.platform === 'string') {
    if (!satisfies(platforms, m.engines.platform)) {
      errors.push(err('$.engines.platform', 'VERSION_UNSATISFIED',
        `平台版本 ${platforms} 不满足插件要求 ${m.engines.platform}`));
    }
  }
  if (m.engines && typeof m.engines.registry === 'string' && base.version) {
    if (!satisfies(base.version, m.engines.registry)) {
      errors.push(err('$.engines.registry', 'REGISTRY_VERSION_UNSATISFIED',
        `注册表版本 ${base.version} 不满足插件要求 ${m.engines.registry}`));
    }
  }

  const contributes = m.contributes || {};
  const stages = stageIds(base);
  const prefixes = prefixMap(base);
  const tiers = new Set(Object.keys(base.tiers || {}));
  const existingKeys = new Set(((base && base.params) || []).map((p) => p.key));
  const modelGroups = new Set(Object.keys((base && base.models) || { keyframe: 1, i2v: 1, voice: 1 }));
  const modelIds = new Set();
  for (const g of Object.keys((base && base.models) || {})) {
    for (const model of (base.models[g] || [])) modelIds.add(String(model.id).toLowerCase());
  }

  /* —— node / 参数 —— */
  if (Array.isArray(contributes.params)) {
    const within = new Set();
    contributes.params.forEach((p, i) => {
      const at = `$.contributes.params[${i}]`;
      if (!p || typeof p !== 'object') return;

      if (typeof p.stage === 'string' && !stages.has(p.stage)) {
        errors.push(err(`${at}.stage`, 'STAGE_UNKNOWN', `stage "${p.stage}" 不存在，可用：${[...stages].join(', ')}`));
      }
      const km = typeof p.key === 'string' ? KEY_RE.exec(p.key) : null;
      if (p.key && !km) {
        errors.push(err(`${at}.key`, 'KEY_FORMAT', `key 必须是 前缀.名称（小写），例如 kf.polish_strength`));
      } else if (km) {
        const stageOfPrefix = prefixes[km[1]];
        if (!stageOfPrefix) {
          errors.push(err(`${at}.key`, 'KEY_PREFIX_UNKNOWN', `前缀 "${km[1]}" 未在宿主注册，拒绝引入新前缀`));
        } else if (typeof p.stage === 'string' && stages.has(p.stage) && stageOfPrefix !== p.stage) {
          errors.push(err(`${at}.key`, 'KEY_STAGE_MISMATCH',
            `前缀 ${km[1]} 属于 stage "${stageOfPrefix}"，与声明的 "${p.stage}" 不一致`));
        }
      }
      if (p.key && existingKeys.has(p.key)) {
        errors.push(err(`${at}.key`, 'KEY_CONFLICT', `参数 key "${p.key}" 与既有注册表冲突`));
      }
      if (p.key && within.has(p.key)) {
        errors.push(err(`${at}.key`, 'KEY_DUPLICATE_IN_PLUGIN', `本包内 key "${p.key}" 重复`));
      }
      within.add(p.key);

      // impact 三值必须落在 0..1：超出会把求解器的乘性增量算成负显存/负时间
      if (p.impact && typeof p.impact === 'object') {
        for (const dim of ['vram', 'time', 'quality']) {
          const v = p.impact[dim];
          if (typeof v !== 'number' || !(v >= 0 && v <= 1)) {
            errors.push(err(`${at}.impact.${dim}`, 'IMPACT_RANGE', `${dim} 必须是 0..1 的数字，实际 ${JSON.stringify(v)}`));
          }
        }
      }

      if (p.tier && !tiers.has(p.tier)) {
        errors.push(err(`${at}.tier`, 'TIER_UNKNOWN', `tier "${p.tier}" 不在注册表 tiers 内`));
      }

      // 数值类型一致性：插件最容易犯的错是 enum 没带 options、range 反了、default 落在区间外
      const numeric = ['int', 'float', 'seed'].includes(p.type);
      if (numeric) {
        if (typeof p.min !== 'number' || typeof p.max !== 'number') {
          errors.push(err(`${at}.min`, 'RANGE_MISSING', `${p.type} 参数必须同时给出 min / max`));
        } else if (!(p.min < p.max)) {
          errors.push(err(`${at}.max`, 'RANGE_INVERTED', `min ${p.min} 不小于 max ${p.max}`));
        } else if (typeof p.default === 'number' && (p.default < p.min || p.default > p.max)) {
          errors.push(err(`${at}.default`, 'DEFAULT_OUT_OF_RANGE', `default ${p.default} 不在 [${p.min}, ${p.max}]`));
        }
        if (p.type === 'int' && typeof p.default === 'number' && !Number.isInteger(p.default)) {
          errors.push(err(`${at}.default`, 'DEFAULT_NOT_INT', 'int 参数的 default 必须是整数'));
        }
      }
      if (p.type === 'enum') {
        if (!Array.isArray(p.options) || p.options.length === 0) {
          errors.push(err(`${at}.options`, 'OPTIONS_MISSING', 'enum 参数必须提供非空 options'));
        } else if (!p.options.includes(p.default)) {
          errors.push(err(`${at}.default`, 'DEFAULT_NOT_IN_OPTIONS', `default 不在 options 内`));
        }
      }
      if (p.type === 'bool' && typeof p.default !== 'boolean') {
        errors.push(err(`${at}.default`, 'DEFAULT_NOT_BOOL', 'bool 参数的 default 必须是 true/false'));
      }
      if (['text'].includes(p.type) && typeof p.default !== 'string') {
        errors.push(err(`${at}.default`, 'DEFAULT_NOT_STRING', 'text 参数的 default 必须是字符串'));
      }
    });
  }

  /* —— node 节点声明 —— */
  if (contributes.node) {
    const n = contributes.node;
    if (typeof n.stage === 'string' && !stages.has(n.stage)) {
      errors.push(err('$.contributes.node.stage', 'NODE_STAGE_UNKNOWN', `节点挂载的 stage "${n.stage}" 不存在`));
    }
    if (Array.isArray(contributes.params)) {
      const paramsOfStage = new Set(contributes.params.filter((p) => p && p.stage === n.stage).map((p) => p.key));
      if (paramsOfStage.size === 0) {
        errors.push(err('$.contributes.node.stage', 'NODE_WITHOUT_PARAMS', `节点所在 stage "${n.stage}" 没有任何本包参数，节点会渲染成空壳`));
      }
    }
  }

  /* —— model —— */
  if (Array.isArray(contributes.models)) {
    contributes.models.forEach((it, i) => {
      const at = `$.contributes.models[${i}]`;
      if (!it || typeof it !== 'object') return;
      if (it.group && !modelGroups.has(it.group)) {
        errors.push(err(`${at}.group`, 'MODEL_GROUP_UNKNOWN', `模型组 "${it.group}" 不存在，可用：${[...modelGroups].join(', ')}`));
      }
      const idLower = typeof it.id === 'string' ? it.id.toLowerCase() : '';
      if (idLower && modelIds.has(idLower)) {
        errors.push(err(`${at}.id`, 'MODEL_ID_CONFLICT', `模型 id "${it.id}" 与既有目录冲突（大小写不敏感比较）`));
      }
      modelIds.add(idLower);
      if (it.group !== 'voice' && typeof it.params_b !== 'number') {
        // voice 模型没有参数量概念（LatentSync 这类），因此只对 keyframe/i2v 要参数
        errors.push(err(`${at}.params_b`, 'PARAMS_B_MISSING', `图像/视频模型的 params_b 必填（显存方程要用）`));
      }

      /* resident_mib × params_b 自洽性（卡 ⑧）：只给 warning，不拒载。
         为什么给区间而不是精确公式：`resident_mib` 是"常驻显存"（权重 + 文本编码器/VAE + 激活余量），
         各家打包方式不同，宿主自己 spec/models.catalog.json 里的实测值也只能落在 fp16 权重量的
         0.35–1.1 倍之间（SDXL 0.36 / Flux-12B 0.48 / Wan-1.3B 0.93）。所以这里只抓**数量级错**：
         32B 写成 900MiB（少一个量级）或 1B 写成 40GB（多一个量级），那才是会让显存账本飞掉的输入。
         区间 [0.25, 1.5] 对 fp16 权重（params_b × 2048MiB）放宽到覆盖"含/不含编码器"两种口径。 */
      const res = it && it.resident_mib && typeof it.resident_mib === 'object' ? it.resident_mib : null;
      if (res && typeof it.params_b === 'number' && it.params_b > 0) {
        const weightsFp16 = it.params_b * 2048; // B × 2 bytes/参数 = MiB
        const check = (quant, lo, hi) => {
          const v = res[quant];
          if (typeof v !== 'number' || !(v > 0)) return;
          const ratio = v / weightsFp16;
          if (ratio < lo || ratio > hi) {
            warnings.push({ path: `${at}.resident_mib.${quant}`, code: 'MODEL_RESIDENT_MISMATCH',
              message: `resident_mib.${quant}=${v}MiB 与 params_b=${it.params_b} 不自洽：`
                + `fp16 权重理论值 ${Math.round(weightsFp16)}MiB，比值 ${ratio.toFixed(2)} 落在 [${lo}, ${hi}] 之外。`
                + '显存方程会按这个数字记账，请核对是单位写错（MiB/GB）还是量级抄错' });
          }
        };
        check('fp16', 0.25, 1.5);
        // 低精度量化不该比 fp16 更常驻：反了说明作者填串了行
        for (const q of ['fp8', 'gguf_q4', 'int4']) {
          if (typeof res[q] === 'number' && typeof res.fp16 === 'number' && res[q] > res.fp16) {
            warnings.push({ path: `${at}.resident_mib.${q}`, code: 'MODEL_RESIDENT_ORDER',
              message: `resident_mib.${q}=${res[q]}MiB 大于 fp16=${res.fp16}MiB：量化档位的常驻显存不应高于 fp16` });
          }
        }
      }

      if (it.provenance === 'measured') {
        warnings.push({ path: `${at}.provenance`, code: 'MEASURED_CLAIM',
          message: '声明 measured 的插件数字属于作者自报，发布前建议人工复核（本平台不替你背书）' });
      }
    });
  }

  /* —— preset —— */
  if (contributes.preset) {
    const pr = contributes.preset;
    if (typeof pr.registry_version === 'string' && base.version && pr.registry_version !== base.version) {
      // 预设里的 key 语义绑定注册表版本；跨版本导入可能命中"同名不同单位"
      errors.push(err('$.contributes.preset.registry_version', 'PRESET_REGISTRY_MISMATCH',
        `预设绑定 registry ${pr.registry_version}，当前 ${base.version}`));
    }
    if (pr.values && typeof pr.values === 'object') {
      for (const k of Object.keys(pr.values)) {
        if (!existingKeys.has(k)) {
          errors.push(err(`$.contributes.preset.values.${k}`, 'PRESET_UNKNOWN_KEY', `预设引用了不存在的参数 "${k}"`));
        }
      }
      if (typeof pr.checksum === 'string') {
        let actual;
        try {
          actual = 'djb2:' + engine._internal.djb2(JSON.stringify(pr.values));
        } catch (e) {
          actual = 'error';
        }
        if (actual !== pr.checksum) {
          // 校验和存在的意义：插件包在云盘里被同步工具截断/手改时，导入会静默偏参
          errors.push(err('$.contributes.preset.checksum', 'PRESET_CHECKSUM_BAD',
            `checksum 不符：声明 ${pr.checksum}，实算 ${actual}`));
        }
      }
    }
  }

  /* —— ui —— */
  if (contributes.ui) {
    const ui = contributes.ui;
    (ui.themes || []).forEach((t, i) => {
      const tokObj = (t && t.tokens) || {};
      for (const [token, val] of Object.entries(tokObj)) {
        const at = `$.contributes.ui.themes[${i}].tokens.${token}`;
        if (!token.startsWith('--')) {
          errors.push(err(at, 'UI_TOKEN_NAME', 'CSS 变量名必须以 -- 开头'));
        }
        if (/url\s*\(|javascript:|expression\s*\(|@import|<\/?script/i.test(String(val))) {
          // 主题 token 会被注入 <style>；允许 url()/javascript: 等于给插件开了一条 CSS 侧信道
          errors.push(err(at, 'UI_TOKEN_UNSAFE', 'token 值不得包含 url()/javascript:/@import/script'));
        }
      }
    });
    (ui.panels || []).forEach((pnl, i) => {
      (pnl.fields || []).forEach((f, j) => {
        if (f && typeof f.key === 'string' && !existingKeys.has(f.key)) {
          errors.push(err(`$.contributes.ui.panels[${i}].fields[${j}].key`, 'UI_UNKNOWN_PARAM', `面板字段指向不存在的参数 "${f.key}"`));
        }
      });
    });
  }

  // exec 隔离：不是错误，是状态机。登记 + 人工审核，绝不自动进运行时。
  if (permissions.includes('exec')) state = 'needs-review';
  if (state === 'needs-review') {
    warnings.push({ path: '$.permissions', code: 'EXEC_QUARANTINED',
      message: '声明了 exec：包已登记但未注入运行时，需人工审核后由宿主构建期手动放行' });
  }
  if (permissions.includes('net') || permissions.includes('gpu')) {
    warnings.push({ path: '$.permissions', code: 'PERMISSION_REGISTERED',
      message: 'net/gpu 当前只做能力登记：加载阶段不发网络请求、不分配显存' });
  }
  if (declaredPerms.length === 0) warnings.push({ path: '$.permissions', code: 'DEFAULT_DENY', message: '未声明权限 → 全部按拒绝处理' });

  // 有 error 就是 rejected：state 与 ok 不能互相矛盾（页面/审计都直接读 state）
  return { ok: errors.length === 0, errors, warnings, state: errors.length ? 'rejected' : state, permissions, signature, signature_policy: policy };
}

/* ───────────────────────────── 合并 ───────────────────────────── */

function recomputeCounts(reg) {
  const total = reg.params.length;
  const l3 = reg.params.filter((p) => p.tier === 'L3').length;
  const l4 = reg.params.filter((p) => p.tier === 'L4').length;
  reg.counts = { total, l3, l4, plugin_params: total - 258 };
  return reg;
}

/**
 * 把一个已通过校验的插件叠进注册表，返回**新注册表**（深拷贝，base 不动）。
 * 这里再次做硬校验（key 冲突 / stage 存在 / impact 0..1）：mergeRegistry 是公开 API，
 * 调用方可能跳过 validateManifest，所以不能把安全性寄托在"上游记得校验"上。
 * 违反即抛错——静默丢弃插件参数会让用户以为装上了但参数没生效。
 */
function mergeRegistry(baseRegistry, plugin) {
  if (!baseRegistry || !Array.isArray(baseRegistry.params)) throw new Error('mergeRegistry: baseRegistry.params 缺失');
  if (!plugin || typeof plugin !== 'object') throw new Error('mergeRegistry: plugin 不能为空');

  const out = deepClone(baseRegistry);
  const stages = stageIds(out);
  const prefixes = prefixMap(out);
  const keySet = new Set(out.params.map((p) => p.key));
  const contributes = plugin.contributes || {};
  const applied = { params: 0, models: 0, presets: 0, themes: 0, panels: 0 };

  for (const p of contributes.params || []) {
    if (!p || typeof p !== 'object') throw new Error('mergeRegistry: 参数条目必须是对象');
    if (!stages.has(p.stage)) throw new Error(`mergeRegistry: stage "${p.stage}" 不存在（${p.key}）`);
    const km = KEY_RE.exec(String(p.key || ''));
    if (!km) throw new Error(`mergeRegistry: key 格式非法：${p.key}`);
    const stageOfPrefix = prefixes[km[1]];
    if (!stageOfPrefix) throw new Error(`mergeRegistry: 未知前缀 "${km[1]}"（${p.key}）`);
    if (stageOfPrefix !== p.stage) throw new Error(`mergeRegistry: ${p.key} 前缀属 ${stageOfPrefix}，声明 ${p.stage}`);
    if (keySet.has(p.key)) throw new Error(`mergeRegistry: key 冲突 "${p.key}"`);
    for (const dim of ['vram', 'time', 'quality']) {
      const v = p.impact && p.impact[dim];
      if (typeof v !== 'number' || v < 0 || v > 1) throw new Error(`mergeRegistry: ${p.key}.impact.${dim} 必须在 0..1`);
    }
    out.params.push(deepClone(p));
    keySet.add(p.key);
    applied.params += 1;
  }

  for (const item of contributes.models || []) {
    if (!item || !item.group || !item.id) throw new Error('mergeRegistry: 模型条目缺少 group/id');
    out.models = out.models || { keyframe: [], i2v: [], voice: [] };
    if (!Array.isArray(out.models[item.group])) throw new Error(`mergeRegistry: 模型组 "${item.group}" 不存在`);
    const clash = out.models[item.group].some((x) => String(x.id).toLowerCase() === String(item.id).toLowerCase());
    if (clash) throw new Error(`mergeRegistry: 模型 id 冲突 "${item.id}"`);
    const { group, ...model } = item; // group 是"运输字段"，落到 models[group] 后不再重复存
    out.models[item.group].push(deepClone(model));
    applied.models += 1;
  }

  if (contributes.preset) {
    out.presets = Array.isArray(out.presets) ? out.presets : [];
    out.presets.push(deepClone(contributes.preset));
    applied.presets += 1;
  }

  if (contributes.ui) {
    out.ui = out.ui || { themes: [], panels: [] };
    for (const t of contributes.ui.themes || []) { out.ui.themes.push(deepClone(t)); applied.themes += 1; }
    for (const pnl of contributes.ui.panels || []) { out.ui.panels.push(deepClone(pnl)); applied.panels += 1; }
  }

  if (!out.node_plugins) out.node_plugins = {};
  if (contributes.node) out.node_plugins[contributes.node.id] = deepClone(contributes.node);

  out.plugin_layers = (out.plugin_layers || []).concat([{
    id: plugin.id, version: plugin.version, type: plugin.type,
    state: plugin.__state || 'active', permissions: plugin.permissions || [], applied,
    // 签名状态跟着叠加层走：审计报告要能回答"这个包的参数是凭什么被信任的"
    signature: plugin.__signature || null,
  }]);

  return recomputeCounts(out);
}

/* ───────────────────────────── 加载 ───────────────────────────── */

function listPluginDirs(root) {
  const dir = path.join(root, PACKS_SUBDIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ id: d.name, dir: path.join(dir, d.name), manifest: path.join(dir, d.name, 'plugin.json') }))
    .filter((x) => fs.existsSync(x.manifest))
    // 排序是为了幂等：同一磁盘状态每次 loadAll 必须给出同样的 registry
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text); // 语法错误由调用方捕获，转成带路径的错误条目
}

function loadBaseRegistry(root) {
  const specDir = path.join(root, 'spec');
  const registry = JSON.parse(fs.readFileSync(path.join(specDir, 'params.registry.json'), 'utf8'));
  const catalogPath = path.join(specDir, 'models.catalog.json');
  registry.models = fs.existsSync(catalogPath)
    ? (JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models || {})
    : (registry.models || {});
  return deepClone(registry);
}

/**
 * 扫描并加载全部插件。
 *
 * 幂等性怎么保证：函数内部没有任何跨调用可变状态（不缓存 registry、不缓存"已安装"标记），
 * 每次调用都从磁盘重新读 base + packs，按 id 排序折叠。所以同一磁盘状态 ⇒ 同一输出。
 * 反复调用只会覆盖重建，不会出现"第二次调用参数翻倍"。
 *
 * 返回 { plugins, errors, warnings, registry }：
 *   plugins  —— 每个包的登记信息（含 state：active / needs-review / rejected）
 *   errors   —— 硬失败（schema / 语义 / 版本），带 path
 *   registry —— base 深拷贝 + 所有 active 插件的叠加，游标永远是"可用的最新真相"
 */
function loadAll(options) {
  const opt = options || {};
  const root = path.resolve(opt.root || path.join(__dirname, '..'));
  const base = opt.base || loadBaseRegistry(root);
  const platformVersion = opt.platformVersion || base.version || '0.1.0';
  const schema = opt.schema || loadSchema();

  const plugins = [];
  const errors = [];
  const warnings = [];
  const trusted = opt.trusted || loadTrustedKeys(root);
  let registry = deepClone(base);

  for (const entry of listPluginDirs(root)) {
    // packRel 指向包目录（写进 plugins[].dir，CLI info 要用它再拼 plugin.json）
    // rel 指向 manifest 文件（错误定位用：用户需要知道是哪份 plugin.json 错了）
    const packRel = path.relative(root, entry.dir).replace(/\\/g, '/');
    const rel = `${packRel}/plugin.json`;
    let manifest;
    try {
      manifest = readManifest(entry.dir);
    } catch (e) {
      errors.push({ id: entry.id, dir: rel, path: '$', code: 'MANIFEST_UNREADABLE', message: e.message });
      plugins.push({ id: entry.id, dir: rel, state: 'rejected' });
      continue;
    }

    // 用"当前已叠加的 registry"做 ctx，而不是原始 base：
    // 这样 B 包能引用 A 包的参数（排序后确定性），也能立刻发现 A/B 之间的 key 冲突
    const verdict = validateManifest(manifest, { base: registry, platformVersion, schema, trusted, root });
    errors.push(...verdict.errors.map((e) => ({ id: manifest.id || entry.id, dir: rel, ...e })));
    warnings.push(...verdict.warnings.map((w) => ({ id: manifest.id || entry.id, dir: rel, ...w })));

    const info = {
      id: manifest.id || entry.id,
      name: manifest.name || '',
      version: manifest.version || '',
      type: manifest.type || '',
      dir: packRel,
      permissions: verdict.permissions,
      state: 'active',
      applies: false,
      applied: { params: 0, models: 0, presets: 0, themes: 0, panels: 0 },
      reason: '',
      // 签名的三态：verified / unsigned（降级）/ failed（拒载）。页面与 audit 直接读它，不再二次判断
      signature: {
        present: verdict.signature.present,
        ok: verdict.signature.ok,
        key_id: verdict.signature.key_id,
        alg: verdict.signature.alg,
        code: verdict.signature.code,
        policy: verdict.signature_policy.mode,
      },
    };

    if (!verdict.ok) {
      info.state = 'rejected';
      info.reason = verdict.errors[0] ? `${verdict.errors[0].path}: ${verdict.errors[0].message}` : '未通过校验';
      plugins.push(info);
      continue; // 拒绝的包不进运行时
    }
    if (verdict.state === 'needs-review') {
      // exec 包：登记但不注入。为什么不是"拒绝"：作者可能只是声明了未来需要的宿主能力，
      // 但平台当前没有任何执行沙箱，所以默认不进运行时，人工审核后再放行。
      info.state = 'needs-review';
      info.reason = '声明 exec 权限，等待人工审核（不注入运行时）';
      plugins.push(info);
      continue;
    }

    try {
      // unsigned 只可能出现在 ui/preset（其余类型在 validate 阶段已变 error 被拒）：
      // 仍然合并（主题/预设要能被看见与预览），但 state 记为 unsigned，页面与 audit 都显式标警告。
      const state = verdict.state === 'unsigned' ? 'unsigned' : 'active';
      const staging = {
        ...manifest,
        __state: state,
        __signature: { present: verdict.signature.present, ok: verdict.signature.ok, key_id: verdict.signature.key_id, alg: verdict.signature.alg, code: verdict.signature.code },
      };
      registry = mergeRegistry(registry, staging);
      info.state = state;
      info.applies = true;
      info.applied = registry.plugin_layers[registry.plugin_layers.length - 1].applied;
      info.reason = state === 'unsigned'
        ? `验签未通过（${verdict.signature.code}）：按降级规则只登记不执行`
        : `已注入（${verdict.signature.ok ? '签名通过' : verdict.signature.code}）`;
    } catch (e) {
      info.state = 'rejected';
      info.reason = `mergeRegistry 拒绝：${e.message}`;
      errors.push({ id: info.id, dir: rel, path: '$', code: 'MERGE_FAILED', message: e.message });
    }
    plugins.push(info);
  }

  return { plugins, errors, warnings, registry };
}

/** 只校验一个目录（不合并），CLI 的 validate/install 用。 */
function validatePluginDir(dir, options) {
  const opt = options || {};
  const root = path.resolve(opt.root || path.join(__dirname, '..'));
  const base = opt.base || loadBaseRegistry(root);
  const platformVersion = opt.platformVersion || base.version || '0.1.0';
  const schema = opt.schema || loadSchema();
  const trusted = opt.trusted || loadTrustedKeys(root);
  let manifest;
  try {
    manifest = readManifest(path.resolve(dir));
  } catch (e) {
    return { manifest: null, verdict: { ok: false, errors: [err('$', 'MANIFEST_UNREADABLE', e.message)], warnings: [], state: 'rejected', permissions: [], signature: { present: false, ok: false, key_id: '', alg: '', code: 'PLUGIN_UNSIGNED', message: 'manifest 读不出来，无法验签', fingerprint: '' }, signature_policy: { mode: 'strict', why: '无法解析' } } };
  }
  return { manifest, verdict: validateManifest(manifest, { base, platformVersion, schema, trusted, root }) };
}

module.exports = {
  SCHEMA_PATH,
  PLUGIN_TYPES,
  PERMISSION_WHITELIST,
  ENGINE_PREFIX: engine.PREFIX,
  // 签名（卡 ⑧）
  SIGN_ALG,
  TRUSTED_KEYS_FILE,
  SIGN_POLICY_DEGRADABLE,
  canonicalizeManifest,
  signingBytes,
  signingFingerprint,
  loadTrustedKeys,
  verifyManifestSignature,
  signManifest,
  generateKeyPair,
  signaturePolicyOf,
  publicKeyFromBase64,
  // 版本
  parseVersion,
  satisfies,
  // 校验
  loadSchema,
  validateAgainstSchema,
  validateManifest,
  validatePluginDir,
  // 合并 / 加载
  mergeRegistry,
  loadAll,
  loadBaseRegistry,
  listPluginDirs,
  readManifest,
  // 工具（selftest / CLI 复用）
  deepClone,
  recomputeCounts,
};