# 本地一体化 AI 视频平台 · v0.1

一台机器上把「写剧本 → 分镜 → 关键帧 → 动效 → 配音 → 成片 → 质检 → 发布」全流程做完的本地平台。
零第三方依赖，不装包，不联网也能开。

## 从哪里开始

**双击 `启动平台.cmd`** —— 起本地服务（同一端口发平台页与七个模块页）并自动打开 `http://127.0.0.1:8388/app/index.html`，此时模块卡片是「存在 / 打开」。

**或者双击 `app/index.html`** —— 平台的唯一入口，首次打开自动进入三屏向导（确认本机条件 / 选画质档 / 生成工作台），之后每次打开直接进工作台。此路无需任何服务，但 `file://` 下七个模块只能标「未验证 / 尝试打开」（原因见下）。

```bash
node tools/build_all.mjs      # 一键重建全部产物（注册表 → 参数面板 → 画布 → 外壳 → 模块快照 → 四个模块入口）
node tools/selftest_all.mjs   # 全模块自检 + 端到端集成（9 项）
node tools/serve.mjs          # 起本地服务后打开 http://127.0.0.1:8388/app/index.html
```

## 交接（给 Qoder / AI IDE / 新会话）

先读 [`HANDOFF.md`](HANDOFF.md)（一页速查）→ [`docs/12-handoff.md`](docs/12-handoff.md)（现状 / 数据地图 / 缺口 / 路线 / 工作法）→ [`docs/13-task-cards.md`](docs/13-task-cards.md)（一张一张做的任务卡）。
规则写进了 [`AGENTS.md`](AGENTS.md) 与 [`.qoder/rules/`](.qoder/rules/)（Qoder 原生规则优先于 AGENTS.md）。

**双击开与起服务的区别（说清楚，不含糊）**：`file://` 下浏览器禁止 `fetch` 本地文件，外壳无法判定模块在不在，七张卡片会显示「未验证 / 尝试打开」。走 `node tools/serve.mjs` 后同一批卡片变成「存在 / 打开」——因为探测变成了真实 HTTP 200。两条路都能用，区别只是「能不能替你验证」。

## 目录

| 路径 | 是什么 | 状态 |
|---|---|---|
| `启动平台.cmd` | **一键启动**：起后端（最小化窗口）+ 打开 `http://127.0.0.1:8388/app/index.html` | ✅ |
| `app/index.html` | **平台外壳（唯一入口）**，单文件、file:// 可开 | ✅ 已交付 |
| `app/index.src.html` | 外壳源件（构建输入） | ✅ |
| `app/state.js` | 项目状态机 + 多项目存储（浏览器/Node 双端） | ✅ |
| `app/selftest.mjs` | 外壳自检脚本 | ✅ |
| `web/params.html` | 参数面板：258 参数 / 7 板块 + 四向预估（界面口径见 [`docs/10-params-ui.md`](docs/10-params-ui.md)） | ✅ 成品 |
| `inspector/index.html` | 帧检查器 | ✅ 已有 |
| `spec/params.registry.json` | **唯一真相源**：258 个参数的定义、默认值、影响系数 | ✅ |
| `spec/models.catalog.json` | 模型与设备档（T0 6900MiB → T5 45000MiB）、显存/耗时系数 | ✅ |
| `spec/rules.linkage.json` | 14 条参数联动规则 | ✅ |
| `core/engine.js` | 参数求解器：`defaults / applyPreset / resolve / estimate / degrade` | ✅ |
| `tools/build_app.mjs` | 外壳构建 | ✅ |
| `ui/tokens.css` | 视觉令牌（唯一身份，构建期内联进每个页面） | ✅ |
| `ui/module-ui.css` | 四模块共享骨架（顶栏/左列表/右详情/口径条） | ✅ |
| `canvas/canvas.html` | 三视图画布：向导 / 参数 / 节点（`node tools/build_canvas.mjs`） | ✅ 成品 |
| `market/index.html` | 模板市场：浏览、安装、评分与版本回退（5 个真模板） | ✅ 成品 |
| `plugins/index.html` | 插件管理：依赖与权限声明、启用停用、快照回滚 | ✅ 成品 |
| `quality/index.html` | 质检面板：白屏/静音/字幕对开/参数合规，逐帧管线 | ✅ 成品 |
| `server/index.html` | 本地服务面板：队列、GPU 占用、任务日志（接 `/api/*`） | ✅ 成品 |
| `server/static.js` | 静态入口：一个端口发射平台页与七个模块页（白名单后缀、仅本仓库） | ✅ |
| `prompt/` | 提示词编译层（逻辑库，无独立入口页，供流水线调用） | ✅ 逻辑层 |
| `tools/e2e.mjs` | 端到端集成验收：探测契约 / 七入口 200 / 回程链接 / 渲染桥 | ✅ |
| `tools/backlink.mjs` | 幂等注入模块页「← 工作台」回程链接（`--check` 只查不写） | ✅ |
| `tools/lint_ui.mjs` | 视觉守门：令牌一致 / 禁用特征 / 圆角 / 焦点环 / 回程链接 | ✅ |
| `docs/08-shell.md` | 外壳自述 + **模块接入约定** | ✅ |
| `docs/09-design-system.md` `docs/10-params-ui.md` | 视觉令牌与参数工作台界面规范 | ✅ |
| `docs/11-module-ui.md` | 四个模块入口的统一界面契约（骨架 / 五件必备 / 视觉禁令） | ✅ |

模块接入约定见 [`docs/08-shell.md`](docs/08-shell.md#模块接入约定)：产出约定的入口 HTML，外壳的卡片就会从「未验证」变成「存在」并给出「打开」按钮。

## 验收（一条命令看清平台到底成不成）

```bash
node tools/selftest_all.mjs   # core / prompt / quality / market / plugins / server / canvas / app / e2e
node tools/lint_ui.mjs        # 七个页面的视觉守门（令牌一致、无渐变、无彩色阴影、回程链接在场）
node tools/e2e.mjs            # 单独跑集成层：探测契约 + 七入口 200 + 渲染桥
```

`e2e` 抓的是模块自检抓不到的那类故障——**契约漂移**：外壳写着探测 `../canvas/index.html`，画布却产出 `canvas.html`，八个模块全绿而用户看到「未验证」。所以它同时断言「外壳写的路径文件真的在」和「每个模块页都能点回工作台」。

## 三条设计决定

1. **单文件内联**。`file://` 下 `fetch` 本地 JSON 会被 CORS 拒，所以构建期把 `engine.js` + `state.js` + 三份 spec 全内联进 `app/index.html`（约 232KB）。"双击必开"是构建时的保证，不是运行时的运气。
2. **不假装有硬件探测**。浏览器拿不到显存（`WebGL` 只给 GPU 型号字符串）。外壳的做法是：读注册表分档表 + 用户确认可用显存 MiB，界面明说这是用户侧确认。诚实比"看起来智能"重要。
3. **状态显式化**。`草稿 → 已配置 → 渲染中 → 审片中 → 已导出`，动作走白名单表。改一个参数就自动退回草稿——因为"配置"指的是被确认过的那套参数。

## 口径

所有秒数、分钟数、显存比、质量分都来自 `core/engine.js` 的**估算模型**，不是实测标定。口径写在 `core/engine.js` 头部：显存按 `W_resident + c1·(Mpix·frames) + decode + overhead` 求和，耗时按区间中值乘系数，质量走进饱和收益曲线。用真实渲染回填标定是下一步。

## 写域

`app/**`、`tools/build_app.mjs`、`docs/08-shell.md`、本文件。
其余目录（`web/` `core/` `spec/` `inspector/` 及并行开发的 `canvas/` `market/` `plugins/` `quality/` `server/` `prompt/`）各归其主，外壳只读不写。