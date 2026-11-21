/**
 * market/sign.js —— 无依赖完整性签名（HMAC-SHA256，node:crypto）
 *
 * 说清楚它是什么、不是什么（写进 license.md 与说明书，避免市场话术夸大）：
 *   是：把模板正文压成一个带密钥的摘要。任何字段被改一个字节，verifySignature 立刻失败；
 *       因为密钥只在作者与平台之间共享，第三方改完 values 再重算 checksum 也没用。
 *   不是：版权保护。它不加密内容、不阻止复制、不分发密钥。模板正文在文件里是明文可读的
 *       （这正是 .avptpl 的取舍，"可 diff"优先于"防拷贝"）。真正收钱靠 license.md 的
 *       结算与审计条款，而不是密码学。
 *
 * 两个坑，代码里显式处理了：
 *   1) 签名的载荷必须规范化。JS 对象键序依赖插入顺序，JSON.parse 后键序跟文件一致，
 *      但任何人重排键就得到不同签名。所以 canonical() 递归按 key 排序后再 stringify。
 *   2) signature 字段自身不能进载荷（否则签名改变载荷、载荷改变签名，永远对不上）。
 */
'use strict';

const crypto = require('node:crypto');

const ALGO = 'HMAC-SHA256';

/** 递归键排序 —— 规范化载荷，保证"内容相同则字符串相同" */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

/**
 * payloadOf —— 取签名载荷：深拷贝模板并去掉 signature
 * 为什么不用 JSON.stringify(tpl) 直接签：那样签完把 signature 写回模板，
 * 下次校验时载荷里多了 signature 字段，必然失败。
 */
function payloadOf(tpl) {
  const clone = canonical(JSON.parse(JSON.stringify(tpl || {})));
  delete clone.signature;
  return clone;
}

function digest(tpl, secret) {
  if (!secret) throw new Error('签名需要 secret（非空字符串）');
  return crypto.createHmac('sha256', String(secret)).update(JSON.stringify(payloadOf(tpl))).digest('hex');
}

/** key_id：密钥的公开指纹。既能区分多把密钥，又不泄露密钥本身 */
function keyId(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16);
}

/**
 * sign —— 返回**新的**模板对象（带 signature），不改入参
 * 为什么不原地改：调用方常常还要保留"未签名版本"去和签名版本做 diff。
 */
function sign(tpl, secret, opts) {
  const o = opts || {};
  const value = digest(tpl, secret);
  const out = JSON.parse(JSON.stringify(tpl));
  out.signature = {
    algo: ALGO,
    key_id: keyId(secret),
    value,
    signed_at: o.signed_at || new Date().toISOString(),
    issuer: o.issuer || '',
    scope: 'payload = 模板对象去掉 signature 字段后按 key 递归排序的 JSON',
  };
  return out;
}

/**
 * verifySignature —— 校验签名
 * @returns {{ok:boolean, reason?:string, expected?:string, actual?:string, key_id?:string}}
 */
function verifySignature(tpl, secret) {
  const sig = tpl && tpl.signature;
  if (!sig) return { ok: false, reason: 'unsigned' };
  if (sig.algo !== ALGO) return { ok: false, reason: 'unknown_algo:' + sig.algo };
  if (!secret) return { ok: false, reason: 'no_secret' };
  const expected = digest(tpl, secret);
  if (sig.key_id && sig.key_id !== keyId(secret)) {
    return { ok: false, reason: 'key_mismatch', key_id: sig.key_id };
  }
  if (expected !== sig.value) {
    return { ok: false, reason: 'digest_mismatch', expected, actual: sig.value };
  }
  return { ok: true, key_id: sig.key_id, signed_at: sig.signed_at };
}

/** 供 selftest / 审计用：只算摘要不写 signature */
function fingerprint(tpl, secret) {
  return digest(tpl, secret);
}

module.exports = { ALGO, sign, verifySignature, payloadOf, canonical, keyId, fingerprint };