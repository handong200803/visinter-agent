/**
 * cloud/purge.mjs —— 清空后端数据（部署/交付前跑，避免把个人测试记录暴露给评委）
 *
 * 用法：
 *   node cloud/purge.mjs --dry-run          # 只看会删什么，不动
 *   node cloud/purge.mjs --yes              # 真删（requires --yes）
 *   node cloud/purge.mjs --yes --keep-experiments   # 保留实验数据（那是公开证据）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const keepExperiments = has('--keep-experiments');
const dry = has('--dry-run') || !has('--yes');

let sqlite;
try { sqlite = require('node:sqlite'); } catch { console.error('需要 Node ≥22'); process.exit(2); }

const dbFile = path.join(DATA_DIR, 'avp.sqlite');
if (!fs.existsSync(dbFile)) { console.log('没有数据库：' + dbFile + '（无需清理）'); process.exit(0); }

const db = new sqlite.DatabaseSync(dbFile);
const counts = {};
for (const t of ['tasks', 'scores', 'library', 'experiments']) {
  try { counts[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c; } catch { counts[t] = 0; }
}
console.log('数据库：' + dbFile);
console.log('当前记录：', JSON.stringify(counts));
console.log('保留实验数据：' + (keepExperiments ? '是（公开证据）' : '否'));

if (dry) {
  console.log('\n[dry-run] 未做任何修改。要真删请加 --yes');
  const sample = db.prepare('SELECT id, kind, state, prompt FROM tasks ORDER BY created_at DESC LIMIT 5').all();
  console.log('\n最近 5 条任务（将被删除）：');
  for (const s of sample) console.log('  ·', s.id, s.kind, s.state, String(s.prompt || '').slice(0, 28));
  process.exit(0);
}

for (const t of ['tasks', 'scores', 'library']) {
  try { db.prepare(`DELETE FROM ${t}`).run(); } catch { /* 表可能不存在 */ }
}
if (!keepExperiments) { try { db.prepare('DELETE FROM experiments').run(); } catch { /* ignore */ } }
try { db.exec('VACUUM'); } catch { /* ignore */ }

// 对象存储里的视频/图片一并清掉（否则 library 空了但文件还在，占空间）
const objDir = process.env.OBJECT_DIR || path.join(DATA_DIR, 'objects');
let removed = 0;
if (fs.existsSync(objDir)) {
  for (const sub of fs.readdirSync(objDir)) {
    const p = path.join(objDir, sub);
    if (fs.statSync(p).isDirectory()) {
      for (const f of fs.readdirSync(p)) { fs.unlinkSync(path.join(p, f)); removed += 1; }
    } else { fs.unlinkSync(p); removed += 1; }
  }
}
console.log(`\n已清空 tasks / scores / library${keepExperiments ? '' : ' / experiments'}，删除对象文件 ${removed} 个。`);
console.log('下一步：重启后端，评委看到的就是干净的库。');
