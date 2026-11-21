---
name: 架构契约与写域
description: 本地 AI 视频平台的模块边界、冻结接口、写域隔离。任何跨模块改动前必须先读本规则与 docs/01-architecture.md。
trigger: always_on
---

# 架构契约（硬约束）

## 分层与依赖方向

```
L4 外壳 app/           唯一入口·首启向导·项目状态机
L3 交互 canvas/ web/ inspector/ quality(页面)
L2 生产 server/ prompt/ quality/ market/ plugins/
L1 内核 core/engine.js + spec/*.json（冻结）
```

依赖**单向向下**：L1 不知道谁在用它；L2/L3/L4 只通过 `core/engine.js` 的导出取数，不得假设 `spec/*.json` 的内部结构（只读字段除外）。

## 模块写域（越界即改错文件）

| 模块 | 允许写 |
|---|---|
| 内核 | `core/**`、`spec/**`、`tools/gen_registry.mjs`、`docs/01-architecture.md` |
| 提示词 | `prompt/**`、`tools/prompt.mjs` |
| 质检 | `quality/**`、`tools/qa.mjs` |
| 模板 | `market/**`、`tools/tpl.mjs`、`tools/snap_market.mjs` |
| 插件 | `plugins/**`、`tools/plugin.mjs`、`tools/snap_plugins.mjs` |
| 后端 | `server/**`、`tools/serve.mjs`、`tools/snap_server.mjs` |
| 画布 | `canvas/**`、`tools/build_canvas.mjs`、`docs/03-canvas.md` |
| 外壳 | `app/**`、`tools/build_app.mjs`、`docs/08-shell.md`、根 `README.md` |
| 共享 | `ui/**`（视觉身份）、`docs/`（各自章节）、`tools/build_all.mjs` |

跨模块需求**走契约，不走改别人的文件**。

## 冻结接口（改动必须同步 `docs/01-architecture.md` §5）

```js
AVP.defaults(reg)
AVP.resolve(reg, rules, values, {ctx})       // → {values, trace[], warnings[]}
AVP.estimate(reg, catalog, values, {device}) // → {vram, time, quality, cost}
AVP.degrade(reg, catalog, rules, values, {device, ctx})
AVP.applyPreset(reg, 'draft'|'standard'|'cinematic')
AVP.exportPreset(reg, values, meta) / AVP.importPreset(reg, preset)
```

- `estimate().vram.ratio > 1` = **必然 OOM**，UI 不得显示成可用，只能引导 `degrade()`。
- `impact = [vram, time, quality]`：前两者为归一化乘性增量（0.05 = 满量程 +5%），`quality` 为 0..1 边际权重。物理参数（分辨率/帧数/量化/模型）的 `vram` 记 0——显存由物理方程算，不许重复计入。
- `frames[]` 每项必须含 `{score, sharp, flicker, flowResidual, status}`，`status ∈ {ok,warn,bad}`，额外指标进 `extra`；`inspector/index.html` 只认这五个字段，改名等于改接口。
- 模块自检协议：`selftest.js|mjs` 成功时**末行打印「全部通过」且 exit 0**；总自检同时校验退出码与该文案。

## 数据真源与生成物

- 真源（可改）：`spec/params.registry.json`（258 参数/7 板块）、`spec/models.catalog.json`（7 档设备 T0/T0-low/T1–T5 + 模型系数 + 许可证）、`spec/rules.linkage.json`（14 条联动）。
- 源件（可改）：`*.src.html`（`app/` `canvas/` `web/` `market/` `plugins/` `quality/` `server/`）。
- **禁止手改**的构建产物：`app/index.html`、`canvas/canvas.html`、`web/params.html`、`market/index.html`、`plugins/index.html`、`quality/index.html`、`server/index.html`、`market/store/index.json` 之外的 `*/snapshot.json`（用 `tools/snap_*.mjs` 重生成）。
- 改真源后的重跑链：`node tools/gen_registry.mjs && node core/build.mjs && node tools/build_all.mjs`。

## 技术栈底线

Node ≥22 内置模块 + 系统 ffmpeg/ffprobe。**没有 package.json，不许 npm install，不许引入任何第三方运行时依赖**（构建脚本也别加）。

## HTTP 接口（`server/app.js`，12 路由 + SSE）

`/api/health` · `/api/devices` · `/api/params` · `/api/estimate` · `/api/degrade` · `/api/workflow/compile` · `GET|POST /api/jobs` · `/api/jobs/:id` · `/api/jobs/:id/cancel` · `/api/jobs/:id/events`(SSE) · `/api/presets/export|import`。
错误统一 `{error:{code,message,detail}}`；未知路由 404 `NOT_FOUND`，坏 JSON 400 `BAD_JSON`，body >4MB 413。