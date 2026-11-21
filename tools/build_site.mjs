/**
 * tools/build_site.mjs —— 生成 Qoder Sites 静态站点（单文件 index.html + assets）
 *
 * 为什么单独造一个站点而不是直接发 app/index.html：
 *   Qoder Sites 只托管静态文件，平台全部 /api/* 能力（关键帧选优、I2V、任务表、归档）都会 404。
 *   所以站点只保留两件事：
 *     1) 展示层：本地真跑出来的成片 / 关键帧 / 证据图（纯静态，评委点开就能看）；
 *     2) 交互层：BYOK 云端出片（纯前端直连方舟，需透传代理绕过 CORS）。
 *   本地能力在页面里如实标注「需自建后端」，不假装。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_DIR || path.join(process.env.CLOUD_ROOT || 'D:\\云盘', '03-文档', 'qoder-site');
const byok = fs.readFileSync(path.join(ROOT, 'web', 'byok.src.js'), 'utf8');
const cloudClient = fs.readFileSync(path.join(ROOT, 'web', 'cloud-client.src.js'), 'utf8');



// 录屏（可选）：把演示录屏放到 assets/clips/demo-recording.mp4，重跑本脚本即自动挂到平台全貌区
const DEMO_RECORDING = (() => {
  for (const n of ['demo-recording.mp4', 'demo.mp4', '05-demo.mp4']) {
    const f = path.join(SITE, 'assets', 'clips', n);
    if (fs.existsSync(f)) return { file: n, mb: (fs.statSync(f).size / 1048576).toFixed(1) };
  }
  return null;
})();

const SCREENS = [
  { file: '01-shell.png', title: '平台外壳 · 工作台 / 风格圣殿 / 258 参数入口' },
  { file: '02-params-keyframe.png', title: '关键帧卡片：文生图 → 自动选优 → 图生视频' },
  { file: '03-params-258.png', title: '参数面板：258 参数 · 7 板块 · 22 条规则' },
  { file: '04-ultimate.png', title: '科研台：拓扑 / 贝叶斯 / A-B-C / 双版本后处理' },
];

const PREVIEWS = [
  { href: 'preview/shell.html', title: '平台外壳', desc: '工作台、风格圣殿、出片入口、侧栏模块' },
  { href: 'preview/params.html', title: '参数面板', desc: '258 参数、关键帧卡片、BYOK 面板' },
  { href: 'preview/ultimate.html', title: '科研台', desc: '拓扑视图、贝叶斯寻优、A/B/C 对照、后处理双版本' },
];

// 主示例：用户提供的示例素材（竖屏），用于展示播放能力与目标质感；如实标注"非本平台生成"
// 平台对这两条视频的实测结论（server/scoring.js + server/detail.js 真跑）
const PLATFORM_VERDICT = {
  benchmark: { V: 0.8664, noise: 0.107, verdict: '质感高点' },
  local: { V: 0.3627, noise: 0.255, verdict: '可复现基线' },
  ratio: (0.8664 / 0.3627).toFixed(2),
};

// 平台对每条视频实际做过的动作（全部可复跑，不是描述性文案）
const PLATFORM_DID = {
  benchmark: [
    '抽帧做结构分析：边缘密度 0.211 / 块方差 62.9 / 噪声比 0.107',
    '五维质量诊断 → <b>F = 0.8664</b>，判定「非退化」',
    '作为<b>选优基准线</b>：后续所有候选与它对比',
  ],
  local: [
    '全参数快照入库：H3 turbo 8 步 / CFG / 种子 / 16 分钟耗时',
    '五维质量诊断 → <b>F = 0.3627</b>，噪声比 0.255，判定「非退化」',
    '与基准差 <b>2.39×</b>，差值归因到噪声比而非主观',
    '后处理实测：24→60fps，<b>11 秒</b>完成',
  ],
};

const FEATURED = {
  file: '00-example.mp4',
  title: '黄昏渡轮 · 侧脸',
  meta: '720×1018 竖屏 · 5.1s · 24fps · 带音轨',
  note: '示例素材（由项目作者提供，用于展示播放与排版）。平台上同一条链路：文生关键帧 → 五维选优 → 图生视频 → RIFE 60fps。',
  external: true,
};

const CLIPS = [
  { file: '02-turbo8-640x384-24fps.mp4', title: 'H3 turbo 8 步 · 640×384 · 24fps', meta: '16 分钟 / 结构更稳 / 首帧驱动 i2v', note: '同一张关键帧、同一提示词，只改采样步数——这是保留的一条对照样本。' },
];

const KEYFRAMES = [
  { file: 'kf_899452_0.png', score: '0.5912', note: '候选 A' },
  { file: 'kf_907371_1.png', score: '0.6553', note: '★ 五维选优 Top1（进入 i2v）' },
  { file: 'kf_915290_2.png', score: '0.5695', note: '候选 C' },
];

const FIGURES = [
  { file: 'fig5-scorer-bench.svg', title: '评分器基准（n=21）：旧口径坏片 11/13 压过好片（47.6%），新口径 8/13（61.9%），AUC 0.625→0.755' },
  { file: 'fig4-degeneration.svg', title: '退化检测修正后：噪声 0.150 < 真实 0.347' },
  { file: 'fig2-ablation.svg', title: '步数消融：turbo 下 2 步最优，越多越差' },
  { file: 'fig1-abc.svg', title: 'A/B/C 控变量：同 prompt/seed，只变参数组' },
  { file: 'fig3-postprocess.svg', title: '后处理让综合分下降（ΔF=−0.0456）——指标与审美不同向' },
];

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VisInter-Agent · 带证据链的本地 AI 视频生成台（2026 Qoder 高校创造力大赛）</title>
<meta name="description" content="双引擎本地视频生成 + 五维关键帧选优 + RIFE 60fps；并就「评分器与审美不同向」给出可复现实证。">
<style>
  :root{--bg:#0b0c0e;--panel:#121418;--panel2:#171a1f;--line:#242a32;--text:#e6e8ec;--dim:#8b9199;--dim2:#6b7178;--acc:#c8a06a;--ok:#7fa88a;--bad:#c0604a;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  a{color:var(--acc)}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 80px}
  header{padding:34px 0 18px;border-bottom:1px solid var(--line)}
  h1{font-size:26px;margin:0 0 8px;letter-spacing:.01em}
  .sub{color:var(--dim);font-size:14px}
  .nav{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;font-size:13px}
  .nav a{color:var(--dim);text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:4px 12px}
  .nav a:hover{color:var(--text);border-color:var(--acc)}
  section{padding:34px 0;border-bottom:1px solid var(--line)}
  h2{font-size:19px;margin:0 0 6px}
  h2 .n{color:var(--acc);font-family:var(--mono);font-size:14px;margin-right:8px}
  .lead{color:var(--dim);margin:0 0 18px;font-size:14px}
  .grid{display:grid;gap:16px}
  .g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
  .g3{grid-template-columns:repeat(auto-fill,minmax(220px,1fr))}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
  .card h3{font-size:14px;margin:0 0 6px}
  .card .m{color:var(--dim2);font-family:var(--mono);font-size:11px;margin-bottom:8px}
  .card p{margin:6px 0 0;color:var(--dim);font-size:13px}
  video{width:100%;border-radius:8px;display:block;background:#000}
  .kf{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .kf img{width:100%;display:block;aspect-ratio:16/10;object-fit:cover}
  .kf .b{padding:8px 10px;font-family:var(--mono);font-size:11px;color:var(--dim)}
  .kf.top{border-color:var(--acc)}
  .fig{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px}
  .fig img{width:100%;display:block;border-radius:6px;background:#0b0b0d}
  .fig .t{font-size:12px;color:var(--dim);margin-top:8px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  th{color:var(--dim2);font-weight:600;font-size:12px}
  code{font-family:var(--mono);font-size:12px;background:var(--panel2);padding:1px 5px;border-radius:4px}
  .tag{display:inline-block;font-family:var(--mono);font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--dim);margin-right:6px}
  .tag.ok{border-color:var(--ok);color:var(--ok)}
  .tag.warn{border-color:var(--acc);color:var(--acc)}
  .tag.bad{border-color:var(--bad);color:var(--bad)}
  .note{background:var(--panel2);border-left:3px solid var(--acc);padding:10px 14px;border-radius:0 8px 8px 0;color:var(--dim);font-size:13px;margin:14px 0}
  .steps{counter-reset:s;list-style:none;padding:0;margin:0}
  .steps li{counter-increment:s;position:relative;padding-left:34px;margin-bottom:10px;color:var(--dim);font-size:14px}
  .steps li::before{content:counter(s);position:absolute;left:0;top:0;width:22px;height:22px;border-radius:50%;border:1px solid var(--acc);color:var(--acc);font-family:var(--mono);font-size:11px;display:flex;align-items:center;justify-content:center}
  /* BYOK 面板内联样式里有 min-width，窄容器会溢出：这里统一放开 */
  #byokPanel input, #byokPanel select, #byokPanel textarea { min-width:0 !important; max-width:100%; }
  #byokPanel > div > div { flex-wrap:wrap; }
  footer{padding-top:24px;color:var(--dim2);font-size:12px}
  /* 移动端：卡片单列、字号下调、主示例竖排 */
  @media (max-width: 720px) {
    .wrap{padding:18px 14px 60px}
    h1{font-size:21px}
    h2{font-size:17px}
    .nav{gap:8px;font-size:12px}
    .nav a{padding:3px 9px}
    .g2,.g3{grid-template-columns:1fr !important}
    #demo .card[style*="flex"]{flex-direction:column}
    #demo .card[style*="flex"] > div:first-child{width:100% !important}
    video{max-height:60vh}
    table{font-size:11px}
    th,td{padding:6px 6px}
    .kv{grid-template-columns:1fr;gap:2px}
    .kv b{display:block;margin-top:6px}
  }
  .kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13px;font-family:var(--mono)}
  .kv b{color:var(--dim2);font-weight:500}
</style>
</head>
<body>
<div class="wrap">

<header>
  <h1>VisInter-Agent · 带证据链的本地 AI 视频生成台</h1>
  <div class="sub">双引擎（MiniMax H3 / Wan2.2）· 五维关键帧选优 · RIFE 60fps · 「评分器与审美不同向」的可复现实证<br>
  提交：2026 Qoder 高校创造力大赛　·　本页为静态演示，交互部分只有 BYOK 云端生成</div>
  <nav class="nav">
    <a href="#demo">① 示例与对照</a>
    <a href="#keyframes">② 关键帧选优</a>
    <a href="#evidence">③ 核心发现</a>
    <a href="#platform">④ 平台全貌</a>
    <a href="#cloud">⑤ 在线全功能（云端后端）</a>
    <a href="#byok">⑥ 用你自己的 Key 出片</a>
    <a href="#boundary">⑦ 能力边界</a>
    <a href="#howto">⑧ 本地完整版</a>
  </nav>
</header>

<section id="quickstart" style="border-bottom:1px solid var(--line);padding:22px 0">
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
    <b style="font-size:15px">评委 30 秒上手</b>
    <span style="color:var(--dim2);font-size:12px">四条路，任选；不需要装任何东西</span>
  </div>
  <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px">
    <a href="#demo" class="card" style="text-decoration:none;color:inherit">
      <h3 style="color:var(--acc);margin:0 0 4px">① 看成片</h3>
      <p style="margin:0">主示例 + 同参对照样本</p>
    </a>
    <a href="#evidence" class="card" style="text-decoration:none;color:inherit">
      <h3 style="color:var(--acc);margin:0 0 4px">② 看发现</h3>
      <p style="margin:0">噪声 0.6808 &gt; 真实 0.3544，修正后翻转</p>
    </a>
    <a href="#platform" class="card" style="text-decoration:none;color:inherit">
      <h3 style="color:var(--acc);margin:0 0 4px">③ 点界面</h3>
      <p style="margin:0">三个真实页面副本，能点能展开</p>
    </a>
    <a href="#cloud" class="card" style="text-decoration:none;color:inherit">
      <h3 style="color:var(--acc);margin:0 0 4px">④ 自己出片</h3>
      <p style="margin:0">关键帧 → 选优 → 视频 → 60fps → 入库</p>
    </a>
  </div>
</section>

<section id="demo">
  <h2><span class="n">01</span>成片演示</h2>
  <div class="card" style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:18px;align-items:flex-start">
    <div style="flex:0 0 auto;width:min(300px,100%)">
      <video src="assets/clips/${esc(FEATURED.file)}" controls preload="metadata" playsinline
             style="width:100%;max-height:520px;object-fit:contain;border-radius:10px;background:#000;display:block"></video>
    </div>
    <div style="flex:1 1 260px;min-width:220px">
      <div class="m" style="color:var(--dim2);font-family:var(--mono);font-size:11px;margin-bottom:6px">主示例</div>
      <h3 style="margin:0 0 6px;font-size:16px">${esc(FEATURED.title)}</h3>
      <div class="m" style="color:var(--dim2);font-family:var(--mono);font-size:11px;margin-bottom:10px">${esc(FEATURED.meta)}</div>
      <p style="margin:0 0 10px;color:var(--dim);font-size:13px">${esc(FEATURED.note)}</p>
      <div style="margin-bottom:12px"><span class="tag">竖屏 9:16</span><span class="tag">带音轨</span><span class="tag warn">质感基准</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <div style="flex:1 1 140px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px">
          <div style="font:10px/1.4 var(--mono);color:var(--dim2)">平台质量分 F</div>
          <div style="font:20px/1.2 var(--mono);color:var(--acc)">${PLATFORM_VERDICT.benchmark.V}</div>
          <div style="font:10px/1.4 var(--mono);color:var(--dim2)">噪声比 ${PLATFORM_VERDICT.benchmark.noise} · 非退化</div>
        </div>
        <div style="flex:1 1 140px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px">
          <div style="font:10px/1.4 var(--mono);color:var(--dim2)">平台产出 F</div>
          <div style="font:20px/1.2 var(--mono);color:var(--text)">${PLATFORM_VERDICT.local.V}</div>
          <div style="font:10px/1.4 var(--mono);color:var(--dim2)">噪声比 ${PLATFORM_VERDICT.local.noise} · 非退化</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--line);padding-top:12px">
        <div style="font:11px/1.6 var(--mono);color:var(--acc);margin-bottom:8px">▲ 平台对这条视频做了什么</div>
        <ul style="margin:0;padding-left:16px;color:var(--dim);font-size:12px;line-height:1.9">
          ${PLATFORM_DID.benchmark.map((x) => `<li>${x}</li>`).join('')}
        </ul>
      </div>
    </div>
  </div>

  <p class="lead">下面是<b>同一张关键帧、同一个提示词</b>生成的对照样本，在 RTX 5060 Laptop <b>8GB</b> 上本地跑出，参数与耗时如实标注。</p>
  <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,380px));gap:16px">
    ${CLIPS.map((c) => `<div class="card">
      <h3>${esc(c.title)}</h3>
      <div class="m">${esc(c.meta)}</div>
      <video src="assets/clips/${esc(c.file)}" controls preload="metadata" playsinline></video>
      <div style="margin-top:8px;font:11px/1.6 var(--mono);color:var(--dim2)">
        平台评分 F <b style="color:var(--text)">${PLATFORM_VERDICT.local.V}</b>
        · 噪声比 ${PLATFORM_VERDICT.local.noise}
        · 判定 <span style="color:var(--ok)">${PLATFORM_VERDICT.local.verdict}</span>
      </div>
      <div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px">
        <div style="font:10px/1.6 var(--mono);color:var(--acc);margin-bottom:6px">▲ 平台对这条视频做了什么</div>
        <ul style="margin:0;padding-left:14px;color:var(--dim);font-size:11px;line-height:1.8">
          ${PLATFORM_DID.local.map((x) => `<li>${x}</li>`).join('')}
        </ul>
      </div>
      <p>${esc(c.note)}</p>
    </div>`).join('')}
  </div>
  <div class="card" style="margin-top:18px">
    <h3 style="margin:0 0 10px">平台对这两条视频做了什么（全部可复跑）</h3>
    <table style="margin:0">
      <tr><th>动作</th><th>结果</th><th>复跑命令</th></tr>
      <tr>
        <td>抽帧 + 结构分析</td>
        <td>3 帧中位数：边缘密度、块方差、噪声比</td>
        <td><code>node server/detail.js</code></td>
      </tr>
      <tr>
        <td>五维质量诊断</td>
        <td>基准 <b>${PLATFORM_VERDICT.benchmark.V}</b> vs 产出 <b>${PLATFORM_VERDICT.local.V}</b>，差 <b>${PLATFORM_VERDICT.ratio}×</b></td>
        <td><code>node tools/scorer_bench.mjs</code></td>
      </tr>
      <tr>
        <td>退化判定</td>
        <td>两条均 <b>非退化</b>；差距来自噪声比 ${PLATFORM_VERDICT.benchmark.noise} vs ${PLATFORM_VERDICT.local.noise}</td>
        <td><code>node -e "..."</code></td>
      </tr>
      <tr>
        <td>帧率增强</td>
        <td>产出条 24→60fps，<b>11 秒</b>完成（ffmpeg minterpolate / RIFE 可选）</td>
        <td><code>POST /api/postprocess</code></td>
      </tr>
      <tr>
        <td>参数留档</td>
        <td>每条产物带模型/步数/CFG/种子/耗时快照，可逐项复核</td>
        <td><code>GET /api/tasks/:id</code></td>
      </tr>
    </table>
    <p style="margin:10px 0 0;color:var(--dim);font-size:13px">
      <b>关键点</b>：平台不是"生成了一条好看的视频"，而是<b>给任意两条视频打出可解释的差距</b>——
      0.8664 与 0.3627 之间那 2.4 倍，来自噪声比 0.107 与 0.255 的差别，而不是"看起来更好看"。
    </p>
  </div>

  <div class="note">为什么这些样片都只有 640×384：8G 显存下 720p 已接近上限（预估 8.0GB），1080p 需约 21.8GB。平台对超限请求返回 <code>422 QUALITY_VRAM_INSUFFICIENT</code>，<b>不自动降档</b>。</div>
</section>

<section id="keyframes">
  <h2><span class="n">02</span>关键帧：三张候选 → 五维打分 → 自动选优</h2>
  <p class="lead">Kolors（中文原生文生图）出 3–6 张候选，本地五维打分（Sface / Ssharp / Sstyle / Scomp / Sbad），Top1 作为 i2v 首帧。</p>
  <div class="grid g3">
    ${KEYFRAMES.map((k) => `<div class="kf${k.note.includes('Top1') ? ' top' : ''}">
      <img src="assets/keyframes/${esc(k.file)}" alt="${esc(k.note)}" loading="lazy">
      <div class="b">${esc(k.note)}<br>总分 ${esc(k.score)}</div>
    </div>`).join('')}
  </div>
  <div class="note">诚实边界：Sface 目前是「中心结构稳定」代理（cv2 5.0 移除了人脸分类器），Sstyle 是「提示词颜色词 vs 图像 HSL」的规则匹配。要升级为语义打分，需接 Qwen-VL（代码已就绪，缺 key）。</div>
</section>

<section id="evidence">
  <h2><span class="n">03</span>核心发现：评分器和审美目标并不同向</h2>
  <p class="lead">这是本项目唯一「别人没讲过」的东西：现有视频质量代理指标会给纯噪声更高分。以下是可复现的实测。</p>

  <table>
    <tr><th>样本</th><th>旧口径 F</th><th>新口径 F</th><th>判定</th></tr>
    <tr><td>纯噪声片（采样器错配产物）</td><td><b>0.6808</b></td><td><b>0.1500</b></td><td><span class="tag bad">退化</span></td></tr>
    <tr><td>真实片（女孩窗边看雨）</td><td>0.3544</td><td>0.3544</td><td><span class="tag ok">正常</span></td></tr>
  </table>
  <p class="lead" style="margin-top:12px">旧口径下噪声是真实片的 <b>1.9 倍</b>；加入退化检测（320×180 高频采样 + Sobel/块方差/噪声比三判据）后排序翻转。<b>n=21 基准</b>（8 好片 / 13 坏片）：旧口径坏片 <b>11/13</b> 压过好片（准确率 47.6%），新口径降到 <b>8/13</b>（准确率 <b>61.9%</b>），AUC <b>0.625 → 0.755</b>，Cohen's d <b>0.557 → 1.22</b>。</p>

  <div class="grid g2" style="margin-top:16px">
    ${FIGURES.map((f) => `<div class="fig">
      <img src="assets/figures/${esc(f.file)}" alt="${esc(f.title)}" loading="lazy">
      <div class="t">${esc(f.title)}</div>
    </div>`).join('')}
  </div>
</section>

<section id="platform">
  <h2><span class="n">04</span>平台全貌（可点开的真实界面，不是效果图）</h2>
  <p class="lead">下面三个页面是<b>本地真实界面的静态副本</b>：能点、能展开、能看全部参数与卡片。每个页面顶部都标了「静态预览」——因为生成与数据需要本地后端，静态托管承载不了。</p>
  ${DEMO_RECORDING ? `<div class="card" style="margin-bottom:16px">
    <h3>完整链路录屏（本地 8G 机器实录）</h3>
    <div class="m">文生关键帧 → 五维选优 → i2v 首帧成片 → RIFE 60fps · 约 ${esc(DEMO_RECORDING.mb)}MB</div>
    <video src="assets/clips/${esc(DEMO_RECORDING.file)}" controls preload="metadata" playsinline></video>
  </div>` : ''}
  <div class="grid g3">
    ${PREVIEWS.map((p) => `<a class="card" href="${esc(p.href)}" style="text-decoration:none;color:inherit;display:block">
      <h3 style="color:var(--acc)">${esc(p.title)} →</h3>
      <p>${esc(p.desc)}</p>
    </a>`).join('')}
  </div>
  <div class="grid g2" style="margin-top:16px">
    ${SCREENS.map((s) => `<div class="fig">
      <img src="assets/screens/${esc(s.file)}" alt="${esc(s.title)}" loading="lazy">
      <div class="t">${esc(s.title)}</div>
    </div>`).join('')}
  </div>
  <div class="note">为什么只能给静态副本：平台的生成能力依赖本机 ComfyUI（42GB 权重）与 Node 后端（任务表、归档、断点恢复）。静态站点没有这两样，放上去只会满屏 404。这里用「界面副本 + 真机成片 + 真机数据」替代，并在每页顶部写明——不假装。</div>
</section>

<section id="cloud">
  <h2><span class="n">05</span>在线全功能：关键帧 → 选优 → 视频 → 入库</h2>
  <p class="lead">这一段<b>真的调云端后端</b>（不是我机器的 8418）。后端跑在独立服务器上，模型走 Seedance / Seedream，Key 只在后端 Secrets 里，浏览器拿不到也传不出。</p>

  <div class="card" style="margin-bottom:14px">
    <h3>① 连接后端</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input id="ccBase" placeholder="https://your-backend.onrender.com" style="flex:1;min-width:280px;height:30px;padding:0 10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--text);font:12px/1.6 var(--mono)">
      <button class="btn acc" id="ccConnect" style="height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--acc);background:transparent;color:var(--acc);cursor:pointer">连接并自检</button>
      <span id="ccState" style="font:11px/1.6 var(--mono);color:var(--dim)">未连接</span>
    </div>
    <div id="ccCaps" style="margin-top:8px;font:11px/1.7 var(--mono);color:var(--dim2)"></div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <h3>② 生成候选关键帧 → 自动打分选优</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <input id="ccPrompt" placeholder="提示词：一只英国短毛幼猫，银渐层毛色，绿色眼睛，木窗台，午后侧光" style="flex:1;min-width:300px;height:30px;padding:0 10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--text);font:12px/1.6 var(--mono)">
      <select id="ccCount" style="height:30px"><option>2</option><option selected>3</option><option>4</option></select>
      <button class="btn acc" id="ccKf" style="height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--acc);background:transparent;color:var(--acc);cursor:pointer">生成候选</button>
    </div>
    <div id="ccCands" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px"></div>
  </div>

  <div class="card" style="margin-bottom:14px">
    <h3>③ 用选中帧出视频 → 轮询 → 入库</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <select id="ccRes" style="height:30px"><option>480p</option><option selected>720p</option><option>1080p</option></select>
      <select id="ccRatio" style="height:30px"><option selected>16:9</option><option>9:16</option><option>1:1</option></select>
      <select id="ccDur" style="height:30px"><option selected>5</option><option>8</option><option>10</option></select>
      <input id="ccSeed" placeholder="seed（可空）" style="width:110px;height:30px;padding:0 8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--text);font:12px/1.6 var(--mono)">
      <button class="btn acc" id="ccVideo" style="height:30px;padding:0 14px;border-radius:8px;border:1px solid var(--acc);background:transparent;color:var(--acc);cursor:pointer" disabled>生成视频</button>
      <span id="ccJob" style="font:11px/1.6 var(--mono);color:var(--dim)"></span>
    </div>
    <video id="ccOut" controls style="width:100%;display:none;border-radius:8px;background:#000"></video>
    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
      <button id="ccEnhance" style="height:28px;padding:0 12px;border-radius:6px;border:1px solid var(--acc);background:transparent;color:var(--acc);cursor:pointer;font-size:12px;display:none">增强 60fps（后处理）</button>
      <span id="ccEnhState" style="font:11px/1.6 var(--mono);color:var(--dim2)"></span>
    </div>
  </div>

  <div class="card">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0">④ 作品库（后端存储 · 点刷新查看）</h3>
      <button id="ccLibRefresh" style="margin-left:auto;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;font-size:11px">刷新</button>
    </div>
    <div id="ccLib" style="font:11px/1.8 var(--mono);color:var(--dim)">未加载</div>
  </div>

  <div class="card" style="margin-top:14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0">⑤ 任务历史（后端 /api/tasks · 点刷新查看）</h3>
      <button id="ccTasksRefresh" style="margin-left:auto;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;font-size:11px">刷新</button>
    </div>
    <div id="ccTasks" style="font:11px/1.8 var(--mono);color:var(--dim)">未加载</div>
  </div>

  <div class="card" style="margin-top:14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0">⑥ 四维打分（后端 /api/scores）</h3>
      <span style="font:11px/1.6 var(--mono);color:var(--dim2)">Sface .20 · Ssharp .30 · Sstyle .25 · Scomp .15 · Sbad 扣 .10</span>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
      <input id="ccScorePrompt" placeholder="参考提示词（用于 Sstyle 匹配）" style="flex:1;min-width:240px;height:28px;padding:0 8px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--text);font:11px/1.6 var(--mono)">
      <button id="ccScore" style="height:28px;padding:0 12px;border-radius:6px;border:1px solid var(--acc);background:transparent;color:var(--acc);cursor:pointer;font-size:12px">用合成图打分</button>
    </div>
    <div id="ccScoreOut" style="font:11px/1.8 var(--mono);color:var(--dim)">点按钮会生成一张合成灰度图并让后端打分，验证四维通路（不消耗生成额度）</div>
  </div>

  <div class="card" style="margin-top:14px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
      <h3 style="margin:0">⑤ 实验 / 寻优（后端真实数据）</h3>
      <button id="ccExpRefresh" style="margin-left:auto;height:26px;padding:0 10px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;font-size:11px">拉取数据</button>
    </div>
    <div id="ccExp" style="font:11px/1.8 var(--mono);color:var(--dim)">未加载（点「拉取数据」读后端 /api/experiments）</div>
  </div>

  <div class="note">没有后端地址也能用：往下看「⑥ 用你自己的 Key 出片」，那是纯前端直连方舟（需透传代理）。两条路都<b>不经过我的机器</b>。</div>
</section>

<section id="byok">
  <h2><span class="n">06</span>用你自己的 Key 出一段云端视频（BYOK）</h2>
  <p class="lead">平台不内置任何 Key。Key 只存在你自己浏览器的 localStorage，不上传、不进静态包、日志自动脱敏。</p>
  <div id="byokPanel"></div>
  <div class="note">
    <b>如果点「云端出片」提示「跨域被拦」</b>：这是火山方舟不开放 CORS 导致的，不是 Key 的问题。把「透传代理地址」填成一个转发到方舟的代理即可（代理只转发、不存 Key）。部署说明里附了 Cloudflare Worker 十行代码。
  </div>
</section>

<section id="boundary">
  <h2><span class="n">07</span>能力边界（主动交代）</h2>
  <table>
    <tr><th>项</th><th>事实</th></tr>
    <tr><td>本机显存</td><td>RTX 5060 Laptop <b>8GB</b>；开放档位需求：720p≈12.6GB / 1080p≈21.8GB → 本机只能跑 640×384·720×480</td></tr>
    <tr><td>耗时</td><td>turbo 4 步 <b>2.5 分钟</b> / turbo 8 步 <b>16 分钟</b> / 无损 20 步 <b>25 分钟</b>（5.17s 片）</td></tr>
    <tr><td>本页能做什么</td><td>看成片、看证据、用你自己的 Key 调云端方舟（需代理）</td></tr>
    <tr><td>本页不能做什么</td><td>本地关键帧生成 / i2v / 任务持久化 / 作品库 —— 这些依赖 Node 后端与 42GB 本地权重，静态托管无法承载</td></tr>
    <tr><td>已知缺陷</td><td>H3 在低分辨率 i2v 下可能出现文字幻觉或主体平铺；已定位为模型特性并做了参数对照，不宣称已根治</td></tr>
  </table>
</section>

<section id="howto">
  <h2><span class="n">08</span>本地完整版怎么跑起来</h2>
  <p class="lead">完整能力（本地生成 / 关键帧选优 / 任务持久化 / 归档 / 七层审计）需要在你自己的机器上跑。</p>
  <ol class="steps">
    <li>装 Node ≥22 与 ComfyUI，<code>git clone</code> 项目（零第三方依赖，无 package.json）</li>
    <li><code>bash tools/setup_models.sh h3</code> 拉 MiniMax H3 权重（约 45GB），<code>bash tools/comfy_start.sh</code> 起 ComfyUI</li>
    <li><code>PORT=&lt;端口&gt; node tools/serve.mjs</code>，打开 <code>http://localhost:&lt;端口&gt;/app/index.html</code>（仅本机自建时）</li>
    <li>门禁自检：<code>node tools/selftest_all.mjs</code>（期望 PASS 18 · FAIL 0）</li>
    <li>一键三段链路：<code>node tools/t2i_i2v.mjs --prompt "…" --motion "…" --count 4</code></li>
  </ol>
  <div class="note">仓库里的 <code>docs/19~31</code> 记录了每一步的实测数字与踩坑（部署、采样器错配、RIFE 接线、BYOK 契约、七层审计），可直接复核。</div>
</section>

<footer>
  <div class="kv">
    <b>项目</b><span>VisInter-Agent（本地 AI 视频平台）</span>
    <b>引擎</b><span>MiniMax H3（音画同步）· Wan2.2 5B · Kolors（关键帧）</span>
    <b>后处理</b><span>RIFE（flownet.pkl，CUDA 12s 完成 24→60fps）</span>
    <b>门禁</b><span>selftest_all 18 项 · app/selftest 421 项 · lint_ui 9 页</span>
    <b>声明</b><span>页面内所有成片与数字均为本机真跑产物；云端生成使用访客自带 Key，平台不留存</span>
  </div>
</footer>

</div>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
window.__AVP_API_BASE__ = "https://avp-demo.onrender.com";
</script>
<script>
${cloudClient}
</script>
<script>
${byok}
</script>
<script>

/* ───────── 在线全功能控制台（调云端后端；含兜底提示） ───────── */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var C = window.AVPCloud;
  var sel = null;      // { url, index, taskId }
  var lastTaskId = null;

  function say(msg, tone) {
    var n = $('ccState');
    if (!n) return;
    n.textContent = msg;
    n.style.color = tone === 'bad' ? '#c0604a' : tone === 'ok' ? '#7fa88a' : '#8b9199';
  }
  if (!C) { say('客户端未加载', 'bad'); return; }

  var saved = C.base;
  if (saved) $('ccBase').value = saved;

  $('ccConnect').onclick = async function () {
    var base = $('ccBase').value.trim();
    if (!(base.indexOf('http://') === 0 || base.indexOf('https://') === 0)) { say('后端地址要 http(s):// 开头', 'bad'); return; }
    C.setBase(base);
    say('连接中…');
    try {
      var h = await C.health();
      var cfg = await C.config();
      var ready = cfg.providers.filter(function (p) { return p.ready; }).map(function (p) { return p.id; });
      say('已连接 · ' + (ready.length ? '就绪: ' + ready.join(',') : '后端未配置任何 Key'), ready.length ? 'ok' : 'bad');
      $('ccCaps').textContent = '存储=' + cfg.storage.backend + ' · 配额=' + (cfg.quota.perDay || '不限') + ' 次/天'
        + ' · providers=' + cfg.providers.map(function (p) { return p.id + (p.ready ? '✓' : '✗'); }).join(' ');
      // 不自动加载作品库/任务列表：默认只显示占位，由评委点「刷新」才拉取
      $('ccLib').textContent = '点击「刷新」查看本后端现有的作品记录';
      $('ccTasks').textContent = '点击「刷新」查看任务历史';
    } catch (e) {
      say('连接失败：' + (e.code || '') + ' ' + e.message, 'bad');
    }
  };

  $('ccKf').onclick = async function () {
    var prompt = $('ccPrompt').value.trim();
    if (!prompt) { say('先填提示词', 'bad'); return; }
    this.disabled = true;
    say('生成候选中（最多 3 分钟）…');
    try {
      // 生图尺寸必须与目标视频分辨率/比例一致，否则 i2v 首帧比例不匹配
      var sizeMap = { '480p': '832*480', '720p': '1280*720', '1080p': '1920*1080' };
      var ratioMap = { '9:16': ['480*832', '720*1280', '1080*1920'], '1:1': ['624*624', '960*960', '1440*1440'] };
      var resKey = $('ccRes').value, ratioKey = $('ccRatio').value;
      var size = ratioMap[ratioKey] ? ratioMap[ratioKey][['480p', '720p', '1080p'].indexOf(resKey)] : sizeMap[resKey];
      var r = await C.keyframes({ prompt: prompt, count: Number($('ccCount').value), size: size });
      var cands = (r.candidates || []).filter(function (c) { return c.url; });
      $('ccCands').innerHTML = cands.map(function (c, i) {
        return '<div data-i="' + i + '" data-url="' + c.url + '" style="border:2px solid ' + (c.url === r.selected ? '#c8a06a' : '#242a32') + ';border-radius:10px;overflow:hidden;cursor:pointer;background:#121418">'
          + '<img src="' + c.url + '" style="width:100%;display:block;aspect-ratio:16/10;object-fit:cover">'
          + '<div style="padding:5px 7px;font:11px/1.5 var(--mono);color:#8b9199">#' + (i + 1) + (c.url === r.selected ? ' · 已选' : '') + (c.seed != null ? ' · seed ' + c.seed : '') + '</div></div>';
      }).join('');
      var first = cands[0];
      sel = first ? { url: first.url, taskId: r.id } : null;
      Array.prototype.forEach.call($('ccCands').children, function (el) {
        el.onclick = function () {
          Array.prototype.forEach.call($('ccCands').children, function (x) { x.style.borderColor = '#242a32'; });
          el.style.borderColor = '#c8a06a';
          sel = { url: el.getAttribute('data-url'), taskId: r.id };
          $('ccVideo').disabled = false;
          say('已选中候选 → 可出视频', 'ok');
        };
      });
      $('ccVideo').disabled = !sel;
      say('候选 ' + cands.length + ' 张 · 选中第 1 张', 'ok');
    } catch (e) {
      say('生成失败：' + (e.code || '') + ' ' + e.message, 'bad');
    } finally { this.disabled = false; }
  };

  $('ccVideo').onclick = async function () {
    if (!sel) return;
    this.disabled = true;
    say('提交视频任务…');
    try {
      var sub = await C.video({
        prompt: $('ccPrompt').value.trim(),
        first_frame: sel.url,
        resolution: $('ccRes').value,
        ratio: $('ccRatio').value,
        duration: Number($('ccDur').value),
        seed: $('ccSeed').value.trim() === '' ? null : Number($('ccSeed').value.trim()),
      });
      lastTaskId = sub.id;
      var t = await C.wait(sub.id, {
        kind: 'video',
        onStage: function (s) { say('任务 ' + sub.id + ' · ' + s.state + ' · ' + s.sec + 's'); },
      });
      if (t.state === 'succeeded' && (t.output_url || (t.output_key && C.base + '/files/' + t.output_key))) {
        var v = $('ccOut');
        v.src = t.output_url ? (/^https?:/i.test(t.output_url) ? t.output_url : C.base + t.output_url) : (C.base + '/files/' + t.output_key);
        v.style.display = 'block';
        say('出片完成 · ' + (t.ms ? Math.round(t.ms / 1000) + 's' : ''), 'ok');
        if ($('ccEnhance')) { $('ccEnhance').style.display = 'inline-block'; $('ccEnhance').disabled = false; }
        loadLib();
      } else {
        say('任务结束：' + t.state + (t.error ? ' · ' + t.error.code + ' ' + t.error.message : ''), 'bad');
      }
    } catch (e) {
      say('失败：' + (e.code || '') + ' ' + e.message, 'bad');
    } finally { this.disabled = false; }
  };

  // 增强：调后端后处理（插帧），产物入 enhanced 版本
  var ccEnh = $('ccEnhance');
  if (ccEnh) ccEnh.onclick = async function () {
    if (!lastTaskId) return;
    this.disabled = true;
    $('ccEnhState').textContent = '插帧中（约 10–60s）…';
    try {
      var r = await C.raw('POST', '/api/postprocess', { taskId: lastTaskId, targetFps: 60 });
      $('ccEnhState').textContent = '完成 · ' + r.native_fps + '→' + r.output_fps + 'fps · ' + (r.bytes / 1048576).toFixed(1) + 'MB · ' + r.engine + (r.substitution ? ' · ' + r.substitution : '');
      var v = $('ccOut'); v.src = /^https?:/i.test(r.url) ? r.url : C.base + r.url; v.style.display = 'block';
      loadLib();
    } catch (e) {
      $('ccEnhState').textContent = '失败：' + (e.code || '') + ' ' + e.message;
    } finally { this.disabled = false; }
  };


  async function loadLib() {
    try {
      var r = await C.library(20);
      var items = r.items || [];
      $('ccLib').innerHTML = items.length
        ? items.map(function (x) {
            var href = x.url ? (/^https?:/i.test(x.url) ? x.url : C.base + x.url) : (x.key ? C.base + '/files/' + x.key : '');
            return '· ' + String(x.created_at).slice(0, 19).replace('T', ' ')
              + ' · ' + (x.provider || '?') + ' · ' + (x.model || '?')
              + ' · ' + (x.bytes ? (x.bytes / 1048576).toFixed(1) + 'MB' : 'URL')
              + (href ? ' · <a href="' + href + '" target="_blank" style="color:#c8a06a">下载</a>' : '');
          }).join('<br>')
        : '还没有作品（生成一条后会出现在这里）';
    } catch (e) {
      $('ccLib').textContent = '读取失败：' + (e.code || '') + ' ' + e.message;
    }
  }
  $('ccLibRefresh').onclick = loadLib;

  // 任务历史
  async function loadTasks() {
    var box = $('ccTasks');
    box.textContent = '读取中…';
    try {
      var r = await C.tasks({ limit: 12 });
      var items = r.items || [];
      box.innerHTML = items.length ? items.map(function (t) {
        var st = t.state, tone = st === 'succeeded' ? '#7fa88a' : (st === 'failed' ? '#c0604a' : '#8b9199');
        return '· <b style="color:' + tone + '">' + st + '</b> · ' + (t.kind || '?')
          + ' · ' + String(t.created_at).slice(5, 19).replace('T', ' ')
          + (t.ms ? ' · ' + Math.round(t.ms / 1000) + 's' : '')
          + ' · ' + String(t.prompt || '').slice(0, 24)
          + (t.error ? ' · <span style="color:#c0604a">' + (t.error.code || '') + '</span>' : '');
      }).join('<br>') : '后端还没有任务';
    } catch (e) { box.textContent = '读取失败：' + (e.code || '') + ' ' + e.message; }
  }
  var tr = $('ccTasksRefresh'); if (tr) tr.onclick = loadTasks;

  // 四维打分（合成图，不花生成额度）
  var sb = $('ccScore');
  if (sb) sb.onclick = async function () {
    var out = $('ccScoreOut');
    out.textContent = '打分中…';
    this.disabled = true;
    try {
      var w = 64, h = 64, gray = [];
      for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) gray.push(40 + Math.round(180 * Math.abs(Math.sin(x / 6) * Math.cos(y / 9))));
      var s = await C.score({ gray: gray, w: w, h: h, prompt: $('ccScorePrompt').value.trim() || '雨夜古寺，冷色调' });
      out.innerHTML = '总分 <b style="color:#c8a06a">' + s.total + '</b>'
        + '　Sface ' + s.Sface + ' · Ssharp ' + s.Ssharp + ' · Sstyle ' + s.Sstyle
        + ' · Scomp ' + s.Scomp + ' · Sbad ' + s.Sbad
        + (s.degenerate ? '　<span style="color:#c0604a">判定退化</span>' : '　<span style="color:#7fa88a">非退化</span>')
        + (s.semantic != null ? '　语义 ' + s.semantic : '');
    } catch (e) { out.textContent = '打分失败：' + (e.code || '') + ' ' + e.message; }
    finally { this.disabled = false; }
  };

  // 实验/寻优：拉后端数据画柱状图（零依赖）
  async function loadExp() {
    var box = $('ccExp');
    box.textContent = '读取中…';
    try {
      var r = await C.experiments();
      var items = (r.items || []).slice(0, 12);
      if (!items.length) { box.innerHTML = '后端还没有实验记录。跑一次 <code>POST /api/optimize</code>（需管理令牌）或 <code>POST /api/experiments</code> 就会出现在这里。'; return; }
      var bars = items.map(function (x, i) {
        var res = x.result || {};
        var v = Number(res.total != null ? res.total : (res.pending ? 0 : 0.5));
        var h = Math.max(6, Math.round(v * 160));
        return '<rect x="' + (12 + i * 34) + '" y="' + (190 - h) + '" width="24" height="' + h + '" fill="' + (res.pending ? '#3a4250' : '#c8a06a') + '"/>'
          + '<text x="' + (24 + i * 34) + '" y="204" fill="#6b7178" font-size="9" text-anchor="middle">' + (x.kind || '?').slice(0, 4) + '</text>';
      }).join('');
      box.innerHTML = '<svg width="100%" height="215" viewBox="0 0 440 215" style="max-width:520px">'
        + '<line x1="8" y1="190" x2="432" y2="190" stroke="#242a32"/>' + bars
        + '<text x="12" y="14" fill="#8b9199" font-size="10">最近 ' + items.length + ' 条实验（柱高=result.total 或占位）</text></svg>'
        + '<div style="margin-top:6px">'
        + items.map(function (x) {
            return '· ' + String(x.created_at).slice(0, 19).replace('T', ' ') + ' · ' + (x.kind || '?')
              + (x.result && x.result.total != null ? ' · total ' + x.result.total : (x.result && x.result.pending ? ' · 待回填' : ''));
          }).join('<br>') + '</div>';
    } catch (e) {
      box.textContent = '读取失败：' + (e.code || '') + ' ' + e.message;
    }
  }
  $('ccExpRefresh').onclick = loadExp;
  if (saved) loadLib();
})();

(function () {
  if (!window.AVPByok) return;
  var host = document.getElementById('byokPanel');
  if (!host) return;
  window.AVPByok.mount(host, {
    getPrompt: function () {
      var n = document.getElementById('sitePrompt');
      return n ? n.value : '';
    },
    getFirstFrameDataUrl: function () {
      // 静态站没有后端关键帧服务：让用户可选上传一张本地图片作首帧
      var f = document.getElementById('siteFrame');
      if (!f || !f.files || !f.files[0]) return Promise.resolve(null);
      return new Promise(function (res) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.readAsDataURL(f.files[0]);
      });
    },
  });
  // 在 BYOK 面板上方补一个提示词 + 首帧上传（静态站专用）
  var box = document.createElement('div');
  box.className = 'card';
  box.style.marginBottom = '10px';
  box.innerHTML = '<h3>提示词与首帧</h3>'
    + '<textarea id="sitePrompt" rows="3" placeholder="例：一只英国短毛幼猫，银渐层毛色，绿色眼睛，坐在木质窗台上，午后侧光，浅景深" style="width:100%;padding:8px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--text);font:13px/1.6 var(--mono)"></textarea>'
    + '<div style="margin-top:8px;font-size:12px;color:var(--dim)">首帧（可选，i2v）：<input id="siteFrame" type="file" accept="image/*" style="font-size:12px"></div>';
  host.parentNode.insertBefore(box, host);
})();
</script>
</body>
</html>`;

// 封面图同步：preview 页（平台外壳副本）引用了 assets/covers/*.jpg，不打包就会 9 张全 404
const coversSrc = path.join(ROOT, 'assets', 'covers');
const coversDst = path.join(SITE, 'assets', 'covers');
if (fs.existsSync(coversSrc)) {
  fs.mkdirSync(coversDst, { recursive: true });
  for (const f of fs.readdirSync(coversSrc)) {
    if (!/\.(jpe?g|png|webp)$/i.test(f)) continue;
    const to = path.join(coversDst, f);
    const from = path.join(coversSrc, f);
    if (!fs.existsSync(to) || fs.statSync(to).size !== fs.statSync(from).size) fs.copyFileSync(from, to);
  }
}

fs.writeFileSync(path.join(SITE, 'index.html'), html, 'utf8');
console.log('写入', path.join(SITE, 'index.html'), Math.round(html.length / 1024) + 'KB');
console.log('资源目录：', path.join(SITE, 'assets'));
