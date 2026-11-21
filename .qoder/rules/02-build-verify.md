---
name: 构建与验收门
description: 改什么要重跑什么、每次提交必须过的四条验收命令、常见假绿与契约漂移陷阱。
trigger: always_on
---

# 构建与验收（每次改动都要过）

## 四条验收命令（必须全绿才算完成）

```bash
node tools/build_all.mjs      # 改了源件/注册表才需要
node tools/selftest_all.mjs   # 期望 PASS 9 · FAIL 0 · 约 5s
node tools/lint_ui.mjs        # 期望 7 个页面全绿
node tools/e2e.mjs            # 期望 通过 47 · 失败 0
```

`selftest_all` 覆盖：core / prompt / quality / market / plugins / server / canvas / app / e2e。
`lint_ui` 守的是视觉身份（`ui/tokens.css` 51 令牌一致、无渐变/荧光/AI 紫/emoji 图标/彩色阴影/过大圆角、`tabular-nums` 与 `:focus-visible` 在场、回程链接在场）。
`e2e` 守的是**契约漂移**：外壳声明的探测路径必须与真实产物逐一对应，七个入口必须 HTTP 200 且能点回工作台，`POST /api/jobs` 必须走到终态，静态层白名单外后缀 403、越界 404。

## 改什么 → 重跑什么

| 你改了 | 必须跑 |
|---|---|
| `spec/params.registry.json` / `spec/models.catalog.json` / `spec/rules.linkage.json` | `node tools/gen_registry.mjs && node core/build.mjs` → `node tools/build_all.mjs` → 四条验收 |
| `core/engine.js` | `node core/selftest.js` → `node tools/build_all.mjs` → 四条验收 |
| `web/params.src.html` | `node tools/gen_registry.mjs`（面板由注册表生成）→ `node tools/build_all.mjs` |
| `canvas/canvas.src.html` | `node tools/build_canvas.mjs` → `e2e` |
| `app/index.src.html` | `node tools/build_app.mjs` → `e2e` |
| `market/*.src.html` `plugins/*.src.html` `quality/*.src.html` `server/*.src.html` | `node tools/build_module.mjs <模块>`（或 `tools/snap_*.mjs` 后再构建） |
| `ui/tokens.css` / `ui/module-ui.css` | `node tools/build_all.mjs` → `lint_ui` 必须全绿（禁用项命中即失败） |
| `server/*.js` | `node server/selftest.js` → `node tools/serve.mjs` 手工过一遍 `/api/health` |
| 任何模块新增入口页 | 同步 `app/index.src.html` 的探测表 + `tools/e2e.mjs` 断言 + `tools/backlink.mjs` 回程链接 |

## 运行与自测

```bash
node tools/serve.mjs                    # PORT=8388 COMFY_URL=http://127.0.0.1:8188（不可达自动 mock）
node tools/qa.mjs run <mp4>             # 逐帧质检 → %CACHE_ROOT%\avp\qc\out\<片名>.quality.json
node tools/prompt.mjs compose --preset standard --stage keyframe
node tools/tpl.mjs list | pack | verify
node tools/plugin.mjs list | install | enable
```

## 三个真实踩过的坑

1. **契约漂移**：外壳探测 `../canvas/index.html`，画布实际产出 `canvas.html` → 八模块全绿、用户看到「未验证」。别绕开 `e2e`。
2. **假绿**：模块自检早退但 exit 0。总自检同时校验「全部通过」这句话；新增自检必须遵守该协议。
3. **把估算当实测**：`core/engine.js` 是估算模型（`W_resident + c1·(Mpix·frames) + decode + overhead`）。写进文档/回答必须标 `provenance: estimate|measured`，没跑过的数字不许写成实测。

## 交付纪律

- 产出（代码/成片/文档/模板）→ `%CLOUD_ROOT%`（= `D:\云盘`）：代码 `01-代码\AI视频\ai-video-platform`、成片 `02-视频\成片`、文档 `03-文档`。
- 中间物（帧缓存/任务记录/质检报告/临时 JSON）→ `%CACHE_ROOT%`（= `D:\缓存`，默认 `D:\缓存\avp\`）。**禁止**把缓存塞进 `D:\云盘`，禁止写 C 盘。
- 不新建 `package.json`；不引入第三方依赖；HTML 产物必须双击 `file://` 可用（数据构建期内联，运行时不 fetch 本地 JSON）。