/**
 * cloud/core.mjs —— 云端版基础设施：状态机、统一错误码、SQLite 存储、对象存储双适配
 *
 * 原则：
 *   1. 零第三方依赖（Node ≥22 内置 node:sqlite / node:crypto），部署只需 node server.mjs；
 *   2. DB 与对象存储都走「适配器接口」，换 Postgres/R2 只换实现，不动业务；
 *   3. 状态机与错误码与本地版语义一致，前端可复用同一套判断。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);   // ESM 里取内置 node:sqlite

/* ── 统一错误码（前后端共用同一张表） ─────────────── */
export const E = {
  BAD_REQUEST: [400, '参数非法'],
  UNAUTHORIZED: [401, '需要管理令牌'],
  FORBIDDEN: [403, '无权限'],
  NOT_FOUND: [404, '资源不存在'],
  RATE_LIMIT: [429, '请求过于频繁'],
  UPSTREAM_KEY_INVALID: [502, '上游 Key 无效或过期（检查后端 Secrets 里的 ARK_API_KEY）'],
  UPSTREAM_FORBIDDEN: [502, '上游额度不足 / 模型未开通'],
  UPSTREAM_BAD_PARAM: [502, '上游参数非法'],
  UPSTREAM_TIMEOUT: [504, '上游超时'],
  UPSTREAM_FAILED: [502, '上游任务失败'],
  PROVIDER_MISSING: [503, '该 provider 未配置（缺 Key 或未启用）'],
  STATE_INVALID: [409, '当前状态不允许该操作'],
  QUOTA: [429, '超出演示配额（评委模式有次数上限）'],
};

export class ApiError extends Error {
  constructor(code, message, detail) {
    super(message || (E[code] || [500, code])[1]);
    this.code = code;
    this.status = (E[code] || [500])[0];
    this.detail = detail || null;
  }
}
export const fail = (code, msg, detail) => { throw new ApiError(code, msg, detail); };

/* ── 状态机 ───────────────────────────────────────── */
export const STATES = ['queued', 'submitting', 'running', 'postprocessing', 'succeeded', 'failed', 'expired', 'cancelled'];
const TRANSITIONS = {
  queued: ['submitting', 'cancelled', 'failed'],
  submitting: ['running', 'failed', 'expired'],
  running: ['postprocessing', 'succeeded', 'failed', 'expired', 'cancelled'],
  postprocessing: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['queued'],       // 允许重试
  expired: ['queued'],
  cancelled: ['queued'],
};
export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}
export function assertTransition(from, to) {
  if (!canTransition(from, to)) fail('STATE_INVALID', `任务状态不能从 ${from} 变为 ${to}`);
}

/* ── SQLite 存储 ──────────────────────────────────── */
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;
export function openDb() {
  if (db) return db;
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
  if (!sqlite) throw new Error('需要 Node ≥22（node:sqlite 内置）');
  db = new sqlite.DatabaseSync(path.join(DATA_DIR, 'avp.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,              -- keyframes | video
      provider TEXT NOT NULL,
      model TEXT,
      state TEXT NOT NULL,
      prompt TEXT,
      params TEXT,                     -- JSON
      selected TEXT,                   -- 选中候选（keyframes）
      variant TEXT,                    -- native | enhanced
      upstream_id TEXT,
      output_url TEXT,
      output_key TEXT,                 -- 对象存储 key
      error TEXT,                      -- JSON {code,message}
      ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scores (
      task_id TEXT PRIMARY KEY,
      total REAL, Sface REAL, Ssharp REAL, Sstyle REAL, Scomp REAL, Sbad REAL,
      degenerate INTEGER, detail TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY, kind TEXT, payload TEXT, result TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS library (
      id TEXT PRIMARY KEY, task_id TEXT, title TEXT, provider TEXT, model TEXT,
      variant TEXT, key TEXT, url TEXT, bytes INTEGER, meta TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_lib_created ON library(created_at DESC);
  `);
  return db;
}
const now = () => new Date().toISOString();
const j = (v) => (v == null ? null : JSON.stringify(v));
const pj = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

export const store = {
  createTask(t) {
    const d = openDb();
    const id = t.id || 'tk_' + crypto.randomBytes(8).toString('hex');
    const ts = now();
    d.prepare(`INSERT INTO tasks (id,kind,provider,model,state,prompt,params,selected,variant,upstream_id,output_url,output_key,error,ms,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, t.kind, t.provider, t.model || null, t.state || 'queued', t.prompt || null,
      j(t.params), t.selected || null, t.variant || 'native', t.upstream_id || null,
      t.output_url || null, t.output_key || null, null, null, ts, ts,
    );
    return this.getTask(id);
  },
  getTask(id) {
    const r = openDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!r) return null;
    return { ...r, params: pj(r.params), error: pj(r.error) };
  },
  updateTask(id, patch) {
    const cur = this.getTask(id);
    if (!cur) fail('NOT_FOUND', '任务不存在: ' + id);
    if (patch.state && patch.state !== cur.state) assertTransition(cur.state, patch.state);
    const f = ['state', 'selected', 'variant', 'upstream_id', 'output_url', 'output_key', 'error', 'ms'];
    const sets = [], vals = [];
    for (const k of f) {
      if (patch[k] !== undefined) { sets.push(`${k} = ?`); vals.push(k === 'error' ? j(patch[k]) : patch[k]); }
    }
    if (patch.params !== undefined) { sets.push('params = ?'); vals.push(j(patch.params)); }
    if (!sets.length) return cur;
    sets.push('updated_at = ?'); vals.push(now(), id);
    openDb().prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getTask(id);
  },
  listTasks({ state, kind, limit = 50, offset = 0 } = {}) {
    const w = [], v = [];
    if (state) { w.push('state = ?'); v.push(state); }
    if (kind) { w.push('kind = ?'); v.push(kind); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const rows = openDb().prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...v, Number(limit), Number(offset));
    return rows.map((r) => ({ ...r, params: pj(r.params), error: pj(r.error) }));
  },
  setScore(taskId, s) {
    openDb().prepare(`INSERT INTO scores (task_id,total,Sface,Ssharp,Sstyle,Scomp,Sbad,degenerate,detail,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET total=excluded.total,Sface=excluded.Sface,Ssharp=excluded.Ssharp,
        Sstyle=excluded.Sstyle,Scomp=excluded.Scomp,Sbad=excluded.Sbad,degenerate=excluded.degenerate,detail=excluded.detail`)
      .run(taskId, s.total, s.Sface, s.Ssharp, s.Sstyle, s.Scomp, s.Sbad, s.degenerate ? 1 : 0, j(s.detail), now());
  },
  getScore(taskId) {
    const r = openDb().prepare('SELECT * FROM scores WHERE task_id = ?').get(taskId);
    return r ? { ...r, detail: pj(r.detail) } : null;
  },
  saveExperiment(e) {
    const id = e.id || 'ex_' + crypto.randomBytes(6).toString('hex');
    openDb().prepare('INSERT INTO experiments (id,kind,payload,result,created_at) VALUES (?,?,?,?,?)')
      .run(id, e.kind || null, j(e.payload), j(e.result), now());
    return { id, ...e };
  },
  listExperiments(kind, limit = 20) {
    const rows = kind
      ? openDb().prepare('SELECT * FROM experiments WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, Number(limit))
      : openDb().prepare('SELECT * FROM experiments ORDER BY created_at DESC LIMIT ?').all(Number(limit));
    return rows.map((r) => ({ ...r, payload: pj(r.payload), result: pj(r.result) }));
  },
  addLibrary(item) {
    const id = item.id || 'lb_' + crypto.randomBytes(6).toString('hex');
    openDb().prepare(`INSERT INTO library (id,task_id,title,provider,model,variant,key,url,bytes,meta,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, item.task_id || null, item.title || null, item.provider || null,
      item.model || null, item.variant || 'native', item.key || null, item.url || null,
      item.bytes || null, j(item.meta), now());
    return id;
  },
  listLibrary(limit = 50) {
    return openDb().prepare('SELECT * FROM library ORDER BY created_at DESC LIMIT ?').all(Number(limit))
      .map((r) => ({ ...r, meta: pj(r.meta) }));
  },
};

/* ── 对象存储：本地卷 / S3 兼容双适配 ─────────────── */
const OBJ_DIR = process.env.OBJECT_DIR || path.join(DATA_DIR, 'objects');
fs.mkdirSync(OBJ_DIR, { recursive: true });

/**
 * 本地卷后端：返回 /files/<key> 由 HTTP 层直接流式返回。
 * 生产建议切 S3 兼容（R2/B2/S3）：设 S3_ENDPOINT/S3_BUCKET/S3_KEY/S3_SECRET 即可启用。
 */
/**
 * 对象 key → 磁盘路径，禁止 ../ 逃逸（真 bug 修复 2026-11-21）：
 * /files/../../etc/passwd 这类请求会被 path.join 规范化到对象目录之外。
 */
function safeObjectPath(key) {
  const root = path.resolve(OBJ_DIR);
  const rel = String(key || '').split(String.fromCharCode(92)).join('/').replace(/^\/+/, '');
  if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) return null;
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

export const objects = {
  backend: process.env.S3_BUCKET ? 's3' : 'local',
  async put(key, buf, contentType = 'video/mp4') {
    if (this.backend === 's3') return s3Put(key, buf, contentType);
    const f = safeObjectPath(key);
    if (!f) fail('BAD_REQUEST', '非法对象路径');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
    return { key, url: '/files/' + encodeURI(key), bytes: buf.length, backend: 'local' };
  },
  async get(key) {
    if (this.backend === 's3') return s3Get(key);
    const f = safeObjectPath(key);
    if (!f) fail('BAD_REQUEST', '非法对象路径');
    if (!fs.existsSync(f)) fail('NOT_FOUND', '对象不存在: ' + key);
    return fs.readFileSync(f);
  },
  pathOf(key) { return path.join(OBJ_DIR, key.replace(/^\/+/, '')); },
  publicUrl(key) {
    if (this.backend === 's3' && process.env.S3_PUBLIC_BASE) return process.env.S3_PUBLIC_BASE.replace(/\/$/, '') + '/' + key;
    return '/files/' + encodeURI(key);
  },
};

/* S3 签名（SigV4），零依赖手写 —— 只用于 put/get 两个动作 */
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function sha256hex(d) { return crypto.createHash('sha256').update(d).digest('hex'); }
function s3Signed(method, key, body, contentType) {
  const endpoint = String(process.env.S3_ENDPOINT || '').replace(/\/$/, '');
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || 'auto';
  const ak = process.env.S3_KEY, sk = process.env.S3_SECRET;
  if (!endpoint || !bucket || !ak || !sk) fail('PROVIDER_MISSING', '对象存储 S3 配置不完整');
  const host = new URL(endpoint).host;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body || '');
  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + sk, date);
  k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  const headers = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (contentType) headers['Content-Type'] = contentType;
  return { url: endpoint + canonicalUri, headers };
}
async function s3Put(key, buf, contentType) {
  const { url, headers } = s3Signed('PUT', key, buf, contentType);
  const r = await fetch(url, { method: 'PUT', headers, body: buf });
  if (!r.ok) fail('UPSTREAM_FAILED', '对象上传失败 HTTP ' + r.status);
  return { key, url: objects.publicUrl(key), bytes: buf.length, backend: 's3' };
}
async function s3Get(key) {
  const { url, headers } = s3Signed('GET', key, '', '');
  const r = await fetch(url, { headers });
  if (!r.ok) fail('NOT_FOUND', '对象读取失败 HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

export const paths = { DATA_DIR, OBJ_DIR };
