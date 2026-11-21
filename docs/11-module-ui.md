# 11 · 模块入口界面契约（market / plugins / quality / server）

> 适用于：`market/index.html`、`plugins/index.html`、`quality/index.html`、`server/index.html`
> 令牌：`ui/tokens.css`（构建期内联）· 骨架：`ui/module-ui.css`（构建期内联）
> 视觉守门：`node tools/lint_ui.mjs`（含这四个入口）
> 构建：`node tools/snap_<mod>.mjs` → `node tools/build_module.mjs <mod>`

---

## 1. 为什么需要契约

外壳 `app/index.html` 的卡片按「约定入口是否存在」判断模块装没装（`docs/08-shell.md` §7）。
四个模块的逻辑层已经跑通并通过自检，缺的是**入口**：一个双击就能开、不用起服务的页面。

契约要解决的问题不是「好看」，是**四份界面看起来像同一个产品**：

| 不统一会怎样 | 后果 |
|---|---|
| 各写一套栅格与行高 | 四个页面的表格密度不同，来回切页时眼睛要重新对焦 |
| 各写一套徽标 | 「已经是最新版本」在一个页面是绿色实心、另一个是灰色描边，状态语义失效 |
| 各写一套空态 | 同一个「没有数据」在不同页面有四种说法，用户以为是四种不同故障 |
| 装饰性动效 | 这是工作台，不是展示页；动效只允许做状态切换 |

---

## 2. 页面骨架（必须用 `module-ui.css` 的类名）

```html
<div class="app">
  <header class="topbar">
    <div class="brand"><b>模板市场</b><span>本地一体化 AI 视频平台 v0.1</span></div>
    <span class="crumbs">工作台<i>/</i>模板市场</span>
    <span class="spacer"></span>
    <span class="badge acc"><span class="dot acc"></span>5 个模板</span>
    <button class="btn">刷新</button>
  </header>

  <div class="body" style="--col:320px">
    <aside class="aside">
      <div class="aside-h">列表<span class="spacer"></span><span>按评分</span></div>
      <div class="aside-b"><div class="list">…行…</div></div>
    </aside>
    <main class="main">
      <div class="main-h"><h2>标题</h2><span class="sub">副标题</span><span class="spacer"></span><button class="btn acc">主操作</button></div>
      <div class="main-b">…详情…</div>
      <div class="main-f">…局部口径…</div>
    </main>
  </div>

  <footer class="statusbar">
    <span>数据来源 snapshot.json · 2026-11-16 21:30</span>
    <span class="spacer"></span>
    <span class="num">4 项</span>
  </footer>
</div>
```

不用左栏的模块（如 server）加 `no-aside`，主体单列铺满。

## 3. 每个入口必须有的六件东西

1. **真实数据**：页面首屏渲染的内容全部来自 `window.__SNAP`（构建期注入的 `snapshot.json`），不允许在 JS 里手写假条目。
2. **空态**：数据为空时给出**为什么空 + 怎么让它不空**。例：`还没有安装任何模板 —— 从左侧选中一个，点「安装」；安装记录写在 localStorage，键前缀 avp.market.`。
3. **状态语义**：`ok / warn / bad / 中性` 四档，配 `.badge` 或 `.dot`，同一含义全站同一档。
4. **口径条**：底部写明数据来源文件、生成时间、以及哪些数字是估算。**估算必须标注**。
5. **键盘可达**：Tab 能走完所有控件（`:focus-visible` 由 tokens 基础层提供），列表行用 `aria-selected` 表达选中。
6. **回程链接**：顶栏第一个元素是 `<a class="btn mini ghost" data-backlink href="../app/index.html" title="返回平台工作台">← 工作台</a>`。由 `node tools/backlink.mjs` 幂等注入，`tools/lint_ui.mjs` 逐页判定，`tools/e2e.mjs` 断言「目标文件真的在」。理由很实际：`file://` 下点浏览器后退会把整页重新解析（内联 200KB+），等于关掉重开。

## 4. 交互规矩

- **每个按钮都要有真实结果**：改页面内状态 / 改 localStorage / 触发 fetch（仅 server 模块）/ 下载一份 JSON。不许出现点了没反应、或写着「即将支持」的按钮。
- **写本地存储用自己的前缀**：`avp.market.*` `avp.plugins.*` `avp.quality.*` `avp.server.*`。禁止碰 `avp.shell.store.v1` 与 `ai-video-platform/project`（外壳与状态机的 key）。
- **不联网**：除 server 模块访问 `http://127.0.0.1:8388/api/*` 外，不发任何外部请求。
- **不引第三方库**：零依赖是本项目的硬约束，`npm install` 一律禁止。

## 5. 视觉禁令（lint 逐条判定，命中即失败）

```
backdrop-filter / text-shadow / 彩色 box-shadow / 任何渐变
--violet / 旧荧光色值（#39e6c4 #6c8cff #b98bff #f7c451 #ff6272 #4ade80 …）
border-radius ≥ 8px（--r-pill 与 50% 除外）
emoji 作图标（U+1F300–U+1FAFF）→ 图标一律内联 SVG，stroke-width 1.5，currentColor
animation: … infinite / filter: blur() / drop-shadow()
```

正向要求：`:root` 必须与 `ui/tokens.css` 逐字一致（由构建器内联，不要手写第二份）、必须出现 `tabular-nums` 与 `:focus-visible`（tokens 基础层已含，别删）。

## 6. 文案规矩

- 不写营销词：赋能、一站式、极致、革命性、AI 驱动。
- 不写假大空状态：不要「加载中…」占位到底，要么真加载，要么直接说「离线快照」。
- 数字与单位分开：`<span class="num">1.8</span> <span class="hint">GB</span>`。
- 中文标点，句末不加感叹号。

## 7. 验收

```bash
node tools/snap_<mod>.mjs          # 快照落地，打印条目数
node tools/build_module.mjs <mod>  # 产物 <mod>/index.html，双击能开
node tools/lint_ui.mjs             # 必须 0 失败（其余入口未建时会显示「跳过」）
node <mod>/selftest.js             # 逻辑层不得被界面改动破坏
```

自查三条（构建器查不了）：

1. 把浏览器窗口缩到 1100px 宽，不出现横向滚动、不出现文字压字。
2. 断网 / 直接 `file://` 双击打开，页面不空白、不弹错误对话框。
3. 清空 localStorage 后重开，空态文案与恢复路径正确。