'use strict';
/**
 * static.js —— 本地静态入口（把「平台、七个模块页」从同一个端口发出去）
 *
 * 为什么需要它：
 *   外壳按「相对路径能不能取到」判断模块装没装（docs/08-shell.md §7）。file:// 下浏览器
 *   禁止 fetch 本地文件，于是外壳只能显示「未验证」——诚实，但没用。起一个本地端口把仓库
 *   目录发出去，`../canvas/canvas.html` 这类探测才第一次成为真实判断。
 *
 * 三条边界（不许被"方便"掉）：
 *   1. **只发本仓库目录**。resolve 之后必须仍在 root 内，越界一律拒绝，不做"向上找"。
 *   2. **只认白名单后缀**。列出的类型都是平台自己产出的界面资产；不在表里的一律 403，
 *      免得哪天有人把 .env / .git 放进目录就被顺手发出去。
 *   3. **只读**。没有 PUT/POST/DELETE，写操作全部归 /api。
 *
 * 纯函数：不碰 res/req，方便在 selftest 里直接断言（见 server/selftest.js「静态入口」段）。
 */
const fs = require('node:fs');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

/** 目录请求只认 index.html：不列目录（列目录会把整个仓库结构暴露给浏览器历史） */
const INDEX = 'index.html';

function inside(root, abs) {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @param {string} root 仓库根目录（绝对路径）
 * @param {string} pathname URL 的 pathname（已去掉 query）
 * @returns {{path:string,size:number,type:string}|{error:string,message:string}}
 */
function serveStatic(root, pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return { error: 'BAD_PATH', message: '路径里的百分号编码无法解码' };
  }
  if (p.includes('\0')) return { error: 'BAD_PATH', message: '路径含空字符' };

  const abs = path.resolve(root, '.' + path.posix.normalize(p.startsWith('/') ? p : '/' + p));
  if (!inside(root, abs)) return { error: 'PATH_OUTSIDE_ROOT', message: '路径越出仓库根目录，拒绝' };

  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { error: 'NOT_FOUND', message: '文件不存在' };
  }

  if (st.isDirectory()) {
    const idx = path.join(abs, INDEX);
    try {
      const ist = fs.statSync(idx);
      if (!ist.isFile()) return { error: 'NOT_FOUND', message: '目录里没有 index.html' };
      return { path: idx, size: ist.size, type: TYPES['.html'] };
    } catch {
      return { error: 'NOT_FOUND', message: '目录里没有 index.html，且不列目录' };
    }
  }

  if (!st.isFile()) return { error: 'NOT_FOUND', message: '不是普通文件' };

  const ext = path.extname(abs).toLowerCase();
  const type = TYPES[ext];
  if (!type) return { error: 'TYPE_BLOCKED', message: `后缀 ${ext || '(无)'} 不在发射白名单里` };

  return { path: abs, size: st.size, type };
}

module.exports = { serveStatic, TYPES };