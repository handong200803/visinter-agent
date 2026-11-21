# AGENTS.md · ai-video-platform

本地一体化 AI 视频平台（v0.1）。一台机器上把「写剧本 → 分镜 → 关键帧 → 动效 → 配音 → 成片 → 质检 → 发布」串成工作台：
**本地部署、按显存自适应、零第三方依赖、双击即开**。

> **先读这两份，再动手**
> 1. [`docs/12-handoff.md`](docs/12-handoff.md) —— 交接总纲：现状快照 / 数据地图 / 缺口总表 / 路线 / 工作法
> 2. [`docs/01-architecture.md`](docs/01-architecture.md) —— 架构与模块契约（冻结接口）
>
> 任务卡在 [`docs/13-task-cards.md`](docs/13-task-cards.md)，一次只做一张。

## 技术栈（不可协商）

- Node ≥ 22 **内置模块** + 系统 `ffmpeg`/`ffprobe`。
- **没有 `package.json`，不 `npm install`，不引入任何第三方运行时依赖**（构建脚本也不行）。
- 原生 HTML/CSS/JS；HTML 产物必须双击 `file://` 可用 → 数据构建期内联，运行时**不** `fetch` 本地 JSON。
- 界面是专业工具风（ComfyUI 式）：令牌唯一源 `ui/tokens.css`，禁令见 `.qoder/rules/03-ui-style.md`。

## 跑起来

```bash
# 双击 启动平台.cmd（起后端 + 开浏览器），或：
node tools/serve.mjs          # http://127.0.0.1:8388/app/index.html  PORT=… COMFY_URL=…
node tools/build_all.mjs      # 一键重建全部产物
node tools/selftest_all.mjs   # 全模块自检 + 集成（期望 PASS 9 · FAIL 0）
node tools/lint_ui.mjs        # 视觉守门（期望 7 页全绿）
node tools/e2e.mjs            # 契约漂移（期望 通过 47 · 失败 0）
```

当前状态（2026-11-17 实测）：9/9 模块 PASS · 7 页 lint 全绿 · e2e 47/47。**界面与求解器是真的，出片链路是 mock**（本机无 ComfyUI）。

## 目录速查

| 路径 | 是什么 |
|---|---|
| `app/` | 外壳（唯一入口）+ 项目状态机 `state.js`；改 `index.src.html` 再构建 |
| `web/` | 参数工作台（258 参数 / 7 板块 / 四向预估） |
| `canvas/` | 三视图画布（向导 / 参数 / 节点） |
| `inspector/` | 逐帧检视器（只认 `frames[]` 五字段） |
| `core/` `spec/` | 求解器/估算器（冻结）+ 唯一真相源 JSON |
| `server/` `prompt/` `quality/` `market/` `plugins/` | 生产层：队列/提示词/质检/模板/插件 |
| `ui/` | 视觉令牌与四模块骨架 |
| `tools/` | 构建器、自检、快照、lint、e2e |
| `docs/` | `00` 蓝图 · `01` 架构 · `02`–`11` 模块 · `12` 交接 · `13` 任务卡 · `state/` 验收快照 |

## 四条铁律

1. **不手改构建产物**：`app/index.html`、`canvas/canvas.html`、`web/params.html`、四个模块 `index.html`、`*/snapshot.json` 都是生成物 —— 改 `.src.html` / 真源后重跑构建器。
2. **写域隔离**：只写自己模块目录 + 自己的 `tools/<name>.mjs` + 自己的 `docs/0X-*.md`；跨模块需求走契约。
3. **不许编数字**：写进文档/回答的耗时、显存、分数必须来自本次真实运行；估算标 `provenance: estimate`。
4. **诚实降级**：拿不到真值（无 GPU 探测 API / 无 ComfyUI）就显式标 `mock: true` 或让用户确认，不许假装已探测。

## 产出与缓存去向

- 产出（代码/成片/文档/模板）→ `%CLOUD_ROOT%`（`D:\云盘`）：本仓库 `01-代码\AI视频\ai-video-platform`，成片 `02-视频\成片`。
- 中间物（任务记录/帧缓存/质检报告/临时 JSON）→ `%CACHE_ROOT%`（`D:\缓存`，默认 `D:\缓存\avp\`）。
- 不写 C 盘；不把缓存放进 `D:\云盘`。

## 提交前自检清单

- [ ] `node tools/selftest_all.mjs` → PASS 9 · FAIL 0
- [ ] `node tools/lint_ui.mjs` → 7 页全绿
- [ ] `node tools/e2e.mjs` → 47 · 0（新增模块只许变大）
- [ ] 新自检遵守协议：末行「全部通过」+ exit 0
- [ ] 改了源件 → 已重跑对应构建器；改了注册表 → 已跑 `gen_registry` + `core/build`
- [ ] 文档里的新数字来自本次运行输出