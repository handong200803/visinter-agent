/**
 * tools/publish_site.mjs —— 一条命令：注入后端地址 → 重建站点 → 打包 zip
 *
 * 用法：
 *   node tools/publish_site.mjs https://your-backend.onrender.com
 *   node tools/publish_site.mjs https://avp.example.com --out D:/云盘/03-文档/site.zip
 *
 * 做的事：
 *   1. 把后端地址写进站点（window.__AVP_API_BASE__，评委打开就自动连上，不用手填）
 *   2. 重跑 build_preview_pages + build_site
 *   3. 打 zip（保留中文名 UTF-8 flag），并做三项体检：无 Key / 无本机硬编码 / 入口在根
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUD = process.env.CLOUD_ROOT || 'D:\\云盘';
const SITE = path.join(CLOUD, '03-文档', 'qoder-site');

const apiBase = (process.argv[2] || '').replace(/\/+$/, '');
const outArg = (() => { const i = process.argv.indexOf('--out'); return i > 0 ? process.argv[i + 1] : null; })();
const OUT = outArg || path.join(CLOUD, '03-文档', 'qoder-site.zip');

if (!apiBase || !/^https?:\/\//.test(apiBase)) {
  console.error('用法: node tools/publish_site.mjs https://your-backend.onrender.com [--out path.zip]');
  process.exit(2);
}

/* 1. 注入 base（写进 build_site 的模板变量，重跑后生效） */
const builder = path.join(ROOT, 'tools', 'build_site.mjs');
let src = fs.readFileSync(builder, 'utf8');
const marker = 'window.__AVP_API_BASE__';
if (src.includes(marker)) {
  src = src.replace(/<script>\s*window\.__AVP_API_BASE__\s*=[^\n]*<\/script>\s*/, '');
}
src = src.replace(/<script>\r?\n\$\{cloudClient\}/, () => `<script>\nwindow.__AVP_API_BASE__ = ${JSON.stringify(apiBase)};\n</script>\n<script>\n\${cloudClient}`);
fs.writeFileSync(builder, src, 'utf8');
console.log('[1/3] 已注入后端地址：' + apiBase);

/* 2. 重建 */
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build_preview_pages.mjs')], { stdio: 'inherit' });
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build_site.mjs')], { stdio: 'inherit' });

/* 3. 打包 + 体检 */
const index = path.join(SITE, 'index.html');
const html = fs.readFileSync(index, 'utf8');
const checks = [
  ['入口在根 index.html', fs.existsSync(index)],
  ['已写入后端地址', html.includes(apiBase)],
  ['无内置 Key（sk-*）', !/sk-[A-Za-z0-9]{8,}/.test(html)],
  ['无本机硬编码', !/127\.0\.0\.1|:8418|:8188/.test(html)],
];
let bad = 0;
for (const [n, okv] of checks) { console.log((okv ? '  ✅ ' : '  ❌ ') + n); if (!okv) bad += 1; }
if (bad) { console.error('体检未通过，已中止打包'); process.exit(1); }

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipDir(dir, out) {
  const entries = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else entries.push({ p, name: path.relative(dir, p).replace(/\\/g, '/') });
    }
  })(dir);
  const chunks = [];
  let offset = 0;
  const central = [];
  for (const e of entries) {
    const data = fs.readFileSync(e.p);
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(deflated.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    chunks.push(lh, nameBuf, deflated);
    central.push({ e, crc, comp: deflated.length, size: data.length, nameBuf, offset });
    offset += lh.length + nameBuf.length + deflated.length;
  }
  const cdStart = offset;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(c.crc, 16); ch.writeUInt32LE(c.comp, 20); ch.writeUInt32LE(c.size, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(c.offset, 42);
    chunks.push(ch, c.nameBuf);
    offset += ch.length + c.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8); eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12); eocd.writeUInt32LE(cdStart, 16); eocd.writeUInt16LE(0, 20);
  chunks.push(eocd);
  const buf = Buffer.concat(chunks);
  fs.writeFileSync(out, buf);
  return { count: entries.length, bytes: buf.length };
}

const z = zipDir(SITE, OUT);
const sha = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex').slice(0, 12);
console.log(`[3/3] 打包完成：${OUT}`);
console.log(`      条目 ${z.count} · ${(z.bytes / 1048576).toFixed(1)}MB · sha256 ${sha}…`);
console.log('\n下一步：把这个 zip 解压后整目录上传到 Qoder Sites，再用手机 4G 打开验证。');
