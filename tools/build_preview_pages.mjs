/**
 * tools/build_preview_pages.mjs —— 把真实平台页面做成「静态可点开预览页」
 *
 * 为什么：Qoder Sites 只能托管静态文件，直接放 app/index.html 会满屏 404（/api/* 全挂）。
 * 做法：复制页面 → 注入两样东西：
 *   1) 顶部横幅：明确「静态预览，生成需本地后端」；
 *   2) fetch 拦截：把 /api/* 请求替换为空 JSON 200，页面按"无数据"渲染而不是抛错。
 * 这样评委点开能看到完整界面（258 参数、关键帧卡片、出片模态），而不会看到红字报错。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_DIR || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '03-文档', 'qoder-site');
const OUT = path.join(SITE, 'preview');
fs.mkdirSync(OUT, { recursive: true });

const PAGES = [
  { src: path.join(ROOT, 'app', 'index.html'), out: 'shell.html', title: '平台外壳（工作台 · 风格圣殿 · 出片入口）' },
  { src: path.join(ROOT, 'web', 'params.html'), out: 'params.html', title: '参数面板（258 参数 · 关键帧 · BYOK）' },
  { src: path.join(ROOT, 'ultimate', 'index.html'), out: 'ultimate.html', title: '科研台（拓扑 · 贝叶斯 · A/B/C · 双版本后处理）' },
];

const BANNER = `
<div id="avp-preview-banner" style="position:fixed;left:0;right:0;top:0;z-index:99999;background:linear-gradient(90deg,#1a1d22,#242a32);border-bottom:1px solid #3a4250;color:#d4d8de;font:12px/1.6 -apple-system,'Microsoft YaHei',sans-serif;padding:8px 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
  <b style="color:#c8a06a">静态预览</b>
  <span>这是本地真实界面的静态副本：能看、能点、能展开；<b>生成与数据需要本地后端</b>（Node + ComfyUI + 42GB 权重），静态托管无法承载。</span>
  <a href="../index.html" style="color:#c8a06a;text-decoration:none;margin-left:auto">← 返回作品页</a>
</div>
<div style="height:52px"></div>
`;

const GUARD = `
<script>
/* 静态预览：把 /api/* 换成空响应，避免满屏 404 红字；顺便标记当前为预览模式 */
(function () {
  var raw = window.fetch;
  window.fetch = function (u, o) {
    var s = typeof u === 'string' ? u : (u && u.url) || '';
    if (/\/api\/|^api\/|\/comfy\/|^comfy\//.test(s)) {
      // 按端点返回"空但结构完整"的响应，否则页面会走 catch 分支显示"同步失败"红字
      var body = { ok: true };
      if (/\/api\/jobs/.test(s)) body = { jobs: [], items: [], total: 0, ok: true };
      else if (/\/api\/works/.test(s)) body = { works: [], items: [], ok: true };
      else if (/\/api\/tasks/.test(s)) body = { items: [], tasks: [], ok: true };
      else if (/\/api\/library/.test(s)) body = { items: [], ok: true };
      else if (/\/api\/experiments/.test(s)) body = { items: [], ok: true };
      else if (/\/api\/config/.test(s)) body = { ok: true, providers: [], models: [], quotas: {} };
      else if (/\/api\/health/.test(s)) body = { ok: true, comfy: true };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return raw.apply(window, arguments);
  };
  window.__AVP_STATIC_PREVIEW__ = true;
  /* 展示层：把人像默认主体句强制替换为中性示例（值由 registry 运行时注入，纯文本替换无效） */
  (function () {
    var NEUTRAL_PROMPT_FORCE = '江南水乡的乌篷船，晨雾未散，青石板路湿润反光';
    var OLD = /一个\s*24\s*岁的中国女孩/;
    function scrub() {
      var el = document.getElementById('rmPrompt');
      if (el && OLD.test(el.value || '')) { el.value = NEUTRAL_PROMPT_FORCE; }
      // 页面里其他回显位置
      document.querySelectorAll('[data-subject],#rmSubject').forEach(function (n) {
        if (OLD.test(n.textContent || '')) n.textContent = NEUTRAL_PROMPT_FORCE;
      });
    }
    window.addEventListener('load', function () { scrub(); setTimeout(scrub, 400); setTimeout(scrub, 1200); });
    document.addEventListener('DOMContentLoaded', function () { scrub(); setTimeout(scrub, 600); });
  })();

})();
<\/script>
`;

let count = 0;
for (const p of PAGES) {
  if (!fs.existsSync(p.src)) { console.log('SKIP missing', p.src); continue; }
  let html = fs.readFileSync(p.src, 'utf8');
  // guard 必须早于页面脚本
  if (html.indexOf('__AVP_STATIC_PREVIEW__') < 0) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n${GUARD}`);
  }
  if (html.indexOf('avp-preview-banner') < 0) {
    html = html.replace(/<body([^>]*)>/i, `<body$1>\n${BANNER}`);
  }
  // 展示层隐私处理：preview 页里如果有人像默认主体句，替换为中性风景示例
  // （只改静态副本的显示文本，不动 spec —— spec 改会破坏提示词编译链的 yield_gate）
  const NEUTRAL_SUBJECT = '江南水乡的乌篷船，晨雾未散，青石板路湿润反光';
  const OLD_SUBJECT = /一个\s*24\s*岁的中国女孩[^<"']*/g;
  html = html.replace(OLD_SUBJECT, NEUTRAL_SUBJECT);

  // 资源路径改写：preview 在子目录，assets/ 要变成 ../assets/（不用 <base>，它会改变导航行为）
  const rewriteAssetPaths = (h) => h
    .replace(/(src|href)="assets\//g, '$1="../assets/')
    .replace(/url\((['"]?)assets\//g, 'url($1../assets/');
  html = rewriteAssetPaths(html);
  fs.writeFileSync(path.join(OUT, p.out), html, 'utf8');
  console.log('preview →', p.out, Math.round(html.length / 1024) + 'KB', '|', p.title);
  count += 1;
}
console.log('done', count, 'pages →', OUT);
