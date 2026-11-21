# 12 · 交接总纲（给 Qoder / 下一个 AI IDE / 新接手的人）

> 快照时间：2026-11-17 11:19（本机实测，日志见 [`docs/state/acceptance-2026-11-17.clean.txt`](state/acceptance-2026-11-17.clean.txt)）
> 本文件是**唯一入口**。读完它 + `docs/01-architecture.md`，就可以开始改代码。
> 蓝图（目标形态，未完全落地）：[`docs/00-blueprint-v1.0.md`](00-blueprint-v1.0.md)（875 行，第七部分是长期方向）
> 逐帧检视器：[`docs/05-inspector.md`](05-inspector.md) · 蓝图 vs 现状逐节偏差：[`docs/14-blueprint-gap.md`](14-blueprint-gap.md) · 角色设定自动提取：[`docs/16-character-autofill.md`](16-character-autofill.md)

---

## 0. 三十秒结论

| 问题 | 答案 |
|---|---|
| 这是什么 | 本地部署、按显存自适应、零第三方依赖、双击即开的 AI 视频生成工作台 |
| 在哪 | `D:\云盘\01-代码\AI视频\ai-video-platform`（133 个文件 / 4.6 MB / 无 git；交接前 123 个 / 5.0 MB） |
| 技术栈 | Node ≥22 内置模块 + 原生 HTML/CSS/JS + 系统 ffmpeg；**没有 package.json，不 npm install** |
| 怎么跑 | 双击 `启动平台.cmd`，或 `node tools/serve.mjs` → `http://127.0.0.1:8388/app/index.html` |
| 现在成不成 | 9 个模块自检全 PASS、7 个页面视觉守门全通过、集成验收 47/47 |
| 真实到哪一步 | 界面/求解器/质检/模板/插件**是真的**；**出片链路是 mock**（本机没有 ComfyUI，8188 不可达） |
| 最大单点缺口 | 注册表 258 个参数里 **252 个没有 `bind`**，工作流编译器只能报 `unbound` → 真出不了图 |
| 第一个该做的任务 | M1-任务卡 ①：接一条**真实出片通路**（provider 抽象 + bind 覆盖），验收标准是产出一个真 mp4 并回填 estimate |

---

## 1. 环境事实（2026-11-17 实测，不是文档抄来的）

| 项 | 实测值 | 影响 |
|---|---|---|
| OS | Windows（WDDM 显存模型） | 显存只能看 `mem_get_info`，不能看 `nvidia-smi` total |
| GPU | RTX 5060 Laptop / 8151 MiB / compute cap **12.0**（=sm_120）/ 驱动 576.80 | 50 系，必须有 cu128 轮子；`spec/models.catalog.json` 的 T0 档就是按它写的 |
| Node | v24.21.0 | 全部构建器/自检靠它 |
| 系统 Python | 3.11.9，`torch 2.15.0+cpu`，`torch.cuda.is_available() == False` | **不能**直接跑本地扩散模型；系统 Python 别当推理环境用 |
| ComfyUI | **不在盘上**（曾装在 `D:\AI\comfyui`，2026-11-13 有运行日志，现已移除；8188 无响应） | 这就是 `server/` 只能走 mock 的原因 |
| ffmpeg / ffprobe | 9.0.2-full_build（gyan.dev） | `quality/` 全链路依赖它，已在 PATH |
| 端口 | 后端 8388（`PORT` 覆盖），ComfyUI 期望 8188（`COMFY_URL` 覆盖） | 两端口都不占就是干净状态 |
| 盘位 | 产出 `D:\云盘`（`%CLOUD_ROOT%`）；中间物 `D:\缓存`（`%CACHE_ROOT%`） | 任务落盘在 `D:\缓存\avp\jobs`，**不许**写 C 盘 |
| 版本控制 | **无 git**（`.git` 不存在） | AI IDE 靠 diff 回滚，建议第一步 `git init`（见 §8 M0） |

---

## 2. 数据流（一句话版）

```
spec/params.registry.json（唯一真相源，258 参数 / 7 板块）
   → core/engine.js：resolve（联动夹紧）→ estimate（显存/耗时/质量/成本）→ degrade（降档方案）
   → prompt/compose.js（中文槽位→提示词） · server/wf.js（参数→ComfyUI 工作流） · market/pack.js（→.avptpl） · plugins/loader.js（合并注册表）
   → server/jobs.js（队列，mock 或 comfy）→ 产物 mp4
   → quality/（ffprobe + 四路指标 → frames[]）→ inspector（逐帧擦洗/框选重绘）
```

**依赖方向单向向下**：`core/` 不知道谁在用它；上层只经 `core/engine.js` 导出取数，不直接猜 `spec/*.json` 的内部结构。

---

## 3. 数据地图：谁是真源、谁是生成物（**改错会白干**）

| 类别 | 路径 | 性质 | 改完必须做什么 |
|---|---|---|---|
| 真相源 | `spec/params.registry.json`（258 参数）· `spec/models.catalog.json`（T0/T0-low/T1–T5 七档 + 模型显存/耗时系数 + 许可证）· `spec/rules.linkage.json`（14 条联动） | **手写/生成混合，视作数据真源** | `node tools/gen_registry.mjs && node core/build.mjs`，再重建所有依赖页 |
| 冻结内核 | `core/engine.js`（476 行） | 求解/估算/降档/预设，接口冻结见 §5 | 只许加字段，不许改签名 |
| 源件（构建输入） | `app/index.src.html` · `canvas/canvas.src.html` · `web/params.src.html` · `market/market.src.html` · `plugins/plugins.src.html` · `quality/quality.src.html` · `server/server.src.html` | 人读人改的唯一入口 | 对应构建器重跑，见 §4 |
| 构建产物（**禁止手改**） | `app/index.html`（248 KB）· `canvas/canvas.html`（231 KB）· `web/params.html`（179 KB）· `market/index.html` · `plugins/index.html` · `quality/index.html` · `server/index.html` | 单文件内联（engine + state + spec 全打进去），`file://` 双击可用 | 改了会被下次构建覆盖；要改就改 `.src.html` |
| 能力库（有自检、无独立页面） | `prompt/`（提示词编译 + 词库 `lexicon.zh.json` 547 行 + `styles.json` + `safety.js`）· `quality/`（`probe/frames/report/export`）· `market/`（`pack/store/sign`）· `plugins/`（`loader` + schema） | 逻辑层 | 跑自己的 `selftest` |
| 快照（数据资产） | `market/snapshot.json`（4982 行）· `plugins/snapshot.json` · `quality/snapshot.json` · `server/snapshot.json` · `market/store/index.json`（本地仓库索引，5 个模板） | 静态解析产物，喂给各模块页面 | 用 `tools/snap_*.mjs` 重生成，别手改 |
| 样例/夹具 | `market/samples/*.avptpl`（5 个真模板）· `plugins/packs/`（3 个示例包）· `plugins/fixtures/`（3 个坏包：坏 manifest / exec 隔离 / 版本不符） | 验收夹具 | 加样例要同步自检 |
| 视觉身份 | `ui/tokens.css`（51 个令牌，唯一身份）· `ui/module-ui.css`（四模块骨架） | 全局唯一 | 改令牌 = 全页面重构建 + `lint_ui` 必须全绿 |
| 截图/证据 | `docs/shots/*.png` · `inspector/shot-*.png` · `canvas/` 等目录内 `_shot-manifest.png` | 文档证据 | 可删可换，不影响构建 |
| 外部先例（不在本仓库） | `D:\云盘\02-视频\成片\仙宫仙境-5s-1080p.mp4` + `.ledger.json` | 云端真实出片证据：`wan2.2-t2v-plus` · 1920*1080 · 5s · 3.3 MB · 2026-11-16T13:58Z succeeded | **M1 的参照物**：新 provider 的产出格式与 ledger 应能对齐它 |

**规模提示**：单文件 >1000 行的产物有 5 个（最大 `app/index.html` 8678 行）——**不要整读**，用 `grep` 定位后分段读。清单见 [`docs/state/inventory.md`](state/inventory.md)。

---

## 4. 模块表（写域 / 入口 / 自检）

| 模块 | 写域 | 职责 | 构建/入口命令 | 自检 |
|---|---|---|---|---|
| 内核 | `core/` `spec/` `tools/gen_registry.mjs` | 求解·估算·降档·预设 | `node core/build.mjs` | `node core/selftest.js` |
| 提示词 | `prompt/` | 中文意图 → 槽位 → 正负向提示词（零 LLM 依赖的规则引擎） | `node tools/prompt.mjs compose --preset standard --stage keyframe` | `node prompt/selftest.js` |
| 质检 | `quality/` | ffprobe + 四路指标 → 逐帧分 | `node tools/qa.mjs run <mp4>` | `node quality/selftest.js` |
| 模板市场 | `market/` | `.avptpl` 打包/校验/HMAC 签名/本地仓库 | `node tools/tpl.mjs list` | `node market/selftest.js` |
| 插件 | `plugins/` | 声明式 manifest 加载 + 注册表合并（**永不 require 插件代码**） | `node tools/plugin.mjs list` | `node plugins/selftest.js` |
| 后端 | `server/` | ComfyUI 适配 · 任务队列 · REST + SSE | `node tools/serve.mjs` | `node server/selftest.js` |
| 画布 | `canvas/` | 向导/参数/节点 三视图同源 | `node tools/build_canvas.mjs` | `node canvas/selftest.mjs` |
| 外壳 | `app/` | 首启向导 · 项目状态机 · 七模块聚合 | `node tools/build_app.mjs` | `node app/selftest.mjs` |
| 集成 | `tools/selftest_all.mjs` `tools/e2e.mjs` `tools/lint_ui.mjs` `tools/backlink.mjs` | 总自检 / 契约漂移 / 视觉守门 / 回程链接 | `node tools/selftest_all.mjs` | 自身即入口 |

**一键重建**：`node tools/build_all.mjs`（注册表 → 参数面板 → 画布 → 外壳 → 模块快照 → 四个模块入口）。

---

## 5. 冻结契约（改前必须同步改 `docs/01-architecture.md` §5）

1. **求解器导出**：`defaults / resolve / estimate / degrade / applyPreset / exportPreset / importPreset`；`estimate().vram.ratio > 1` 即**必然 OOM**，任何 UI 不得显示成可用。
2. **参数影响口径**：`impact = [vram, time, quality]`，前两者是归一化乘性增量，`quality` 是 0..1 边际权重；物理参数（分辨率/帧数/量化/模型）的 `vram` 记 0（显存由物理方程算，不重复计）。
3. **帧质检记录**：`frames[]` 每项 `{score, sharp, flicker, flowResidual, status}`，`status ∈ {ok,warn,bad}`，多余指标进 `extra`；`inspector` 只认这五个字段。
4. **模块自检协议**：每个模块 `selftest.js|mjs` 成功时**末行打印「全部通过」且 exit 0**；总自检同时校验退出码和这句话（防早退假绿）。
5. **HTTP API**（`server/app.js`，12 个路由 + SSE）：`/api/health` `/api/devices` `/api/params` `/api/estimate` `/api/degrade` `/api/workflow/compile` `/api/jobs`(GET/POST) `/api/jobs/:id` `/api/jobs/:id/cancel` `/api/jobs/:id/events`(SSE) `/api/presets/(export|import)`。错误统一 `{error:{code,message,detail}}`。

---

## 6. 当前状态快照（真实数字，2026-11-17 11:19）

```
node tools/selftest_all.mjs   PASS 9 · FAIL 0 · SKIP 0 · 4.8s
  core 0.1s · prompt 0.1s · quality 1.4s · market 0.2s · plugins 0.1s
  server 1.8s · canvas 0.1s · app 0.1s · e2e 1.1s
node tools/lint_ui.mjs        7 个页面全绿（令牌 51 项一致 · 无用渐变/荧光/AI 紫/emoji 图标/彩色阴影 · 焦点环在场 · 回程链接在场）
node tools/e2e.mjs            通过 47 · 失败 0
  · 外壳声明 7 个探测路径 与 实际产物逐一对应
  · 七个入口经临时端口均 200，且都能点回工作台
  · 渲染桥 POST /api/jobs → 202 → 终态 succeeded（617ms，mock 后端）
  · 静态层白名单外后缀 403、越界路径 404
```

交接文件写入后复跑（2026-11-17 11:24，`docs/state/acceptance-2026-11-17-after-handoff.txt`）：**PASS 9 · FAIL 0 · SKIP 0 · 5.1s，lint 7 页全绿，e2e 47/0** —— 新增的 `AGENTS.md` / `.qoder/` / 四份 md / 两份 state 文件不改变任何运行时行为。

数据面：258 参数（character 42 / storyboard 34 / keyframe 56 / motion 38 / voice 30 / look 32 / export 26）· 7 档设备（T0 6900MiB → T5 45000MiB）· 14 条联动 · 5 个模板 · 3 个插件包 + 3 个坏包夹具 · 4 份快照。

---

## 7. 已知缺口总表（A=挡路，B=质量，C=打磨）

| # | 级 | 缺口 | 落点 | 判据 |
|---|---|---|---|---|
| 1 | **A** | ComfyUI 链 `bind` 覆盖率仍 2.3%（252/258）；**DashScope 链已补 `bind_ds` 21/258（8.1%）**，编译产出可执行万相请求（快照 `docs/state/compile-dashscope.json`，2026-11-17 实测 applied=21/unbound=237） | `spec/params.registry.json` + `server/ds.js` | 剩余：真 mp4 落地（并入 #2）；ComfyUI 链 bind 待真模板 |
| 2 | **A** | ~~无真实 provider / 静默降级~~ **已修**（2026-11-17）：`server/providers/` 三后端 mock\|comfy\|dashscope，`AVP_PROVIDER` 显式选择，不可达报 `degraded:true` + 任务如实 failed，selftest 60/0。**剩余：真出片未实测**——本机未设 `DASHSCOPE_API_KEY`（卡③） | `server/providers/` `server/ds.js` | 设 key 后一条真 mp4 落 `%CLOUD_ROOT%\02-视频\成片` + ledger + 质检 |
| 3 | **A** | 本机 ComfyUI 已移除，本地推理环境 = 0；系统 torch 是 `+cpu` | 环境 | `GET /api/health` 能报出真实 provider 与真实 GPU 真值 |
| 4 | **A** | 合规模板不可执行（`synthetic` 无采样链/SaveImage，仅预览对拍） | `server/wf.js` | 模板与真实图/视频模型对齐 |
| 5 | **B** | `actualPeakMib: null`，显存峰值未采样 | `server/comfy.js` | 用 `nvidia-smi --query-gpu=memory.used` 旁路或节点回传 |
| 6 | **B** | `/interrupt` 全局生效（ComfyUI 不支持按 prompt_id 取消） | `server/comfy.js` | 并发任务互不误伤，或显式声明单任务语义 |
| 7 | **B** | WS 分支未在真 ComfyUI 上跑过 | `server/comfy.js` | 真机 progress + 预览帧 |
| 8 | **B** | 队列是单进程内存态，无优先级/无持久化锁 | `server/jobs.js` | 重启不丢任务或显式标注会丢 |
| 9 | **B** | 画布拓扑固定，不能手工连线、不能加载外部 workflow | `canvas/canvas.src.html` | 与 `server/wf.js` 编译格式定稿后开放 |
| 10 | **B** | 质检：模糊阈值未真机标定；`flowResidual` 实为帧差不是光流；无音频（`astats` 未接）、无色彩质检；缺陷无 bbox；批量串行 | `quality/probe.js` `quality/frames.js` | 接 `media-verify` 的 astats/亮度口径 + 真机标定 |
| 11 | **B** | 模板：索引与正文会不同步、无版本并存/回滚、无密钥轮换、结算只到规则层、无远端仓库 | `market/store.js` `market/sign.js` | 加 `rebuild()` 的幂等 + 版本目录 |
| 12 | **B** | 插件：`checksum` 只防手改不防伪造（无签名）；`ui` 类只登记不渲染；`model` 的 `resident_mib` 不做自洽校验；`loadAll` 按目录名字典序折叠 | `plugins/loader.js` | Ed25519 签名 + ui slot 渲染 |
| 13 | **C** | 外壳：`render` 只到任务终态（mock 记录），`export` 不搬文件；项目格式 `format:1` 无迁移；导入不合并；向导未把桌面占用显存算进去 | `app/state.js` `app/index.src.html` | 成片真落到 `%CLOUD_ROOT%\02-视频\成片` |
| 14 | **C** | ~~`docs/05-*.md` 缺失~~ **已补（卡 ⑩）**：[`05-inspector.md`](05-inspector.md) 逐帧检视器说明 · [`14-blueprint-gap.md`](14-blueprint-gap.md) 蓝图 vs 现状逐节对照（28 行）。仍缺：全仓无 git | `docs/` | 建仓（`git init`） |

> 这份表来自各模块文档的「已知缺口」章节 + 本次实测。**改掉一条就把这行挪到 CHANGELOG 或删除**，别让它烂在原地。

---

## 8. 下一步路线（每条都有验收命令，做完才算完）

### M0 · 交接固化（本次已完成，可复查）
- [x] 规则文件 `AGENTS.md` + `.qoder/rules/*.md`
- [x] 本交接总纲 + 任务卡 `docs/13-task-cards.md`
- [x] 验收快照 `docs/state/acceptance-2026-11-17.clean.txt` + 规模清单 `docs/state/inventory.md`
- [x] 蓝图归仓 `docs/00-blueprint-v1.0.md`；历史备份移到 `D:\云盘\06-归档\avp-restyle-bak-2026-11-17\`
- [ ] 建议人工一步：`git init && git add -A && git commit -m "v0.1 基线"`（AI IDE 靠 diff 回滚，没有 baseline 就不能放心大改）

### M1 · 真实出片通路（最优先，2 个任务卡）
目标：一条 5 秒片从 `/api/jobs` 走到**真 mp4**，`estimate` 用实测值回填。
- provider 抽象：`mock | comfy | dashscope`，`GET /api/health` 必须报 `provider:"real"` 与来源，禁止静默降级（缺口 #2 #3）
- 注册表 `bind` 覆盖：先打通「一条链」的 20–40 个参数，不求 258 全覆盖（缺口 #1 #4）
- 验收：`node tools/selftest_all.mjs` 全绿 + `node tools/qa.mjs run <新mp4>` 出分 + `docs/state/` 存一份实测 `actualPeakMib`

### M2 · 显存求解闭环
- `GET /api/devices` 接 `nvidia-smi` 真值（本机 8151 MiB → T0 档），`degrade()` 给的三套方案必须能一键执行
- 验收：T0 档 480p/3s 连续 10 次成功率 ≥90%，ETA 误差 <30%（先松后紧，别抄蓝图里的 20%）

### M3 · 画质闭环
- `quality/` 接 `astats`（响度/静音）+ 亮度口径（对齐 `media-verify` 原子件），`inspector` 回填真实分数
- 最佳-of-N + 封面/字幕走既有原子件（`video-compose` / `video-cover`）
- 验收：一条成片质检报告落到 `%CACHE_ROOT%\avp\qc\out\`，`quality/selftest.js` 扩到覆盖新指标

### M4 · 创作与交易
- 模板 → 工作流编译贯通（模板不再只是参数快照）；`ui` 类插件真渲染；`market` 加版本目录与 Ed25519 签名
- 验收：作者侧 15 分钟产出一个可安装模板，装 v2 后能回滚 v1

### M5 · 交付形态
- 安装包 / 模型增量下载 / 水印与元数据（`prompt/safety.metadataStub()` 已出结构，未接 ffmpeg）/ 多语言
- 验收：干净机器双击 `启动平台.cmd` 到出片 ≤ 15 分钟

---

## 9. 给 AI IDE 的工作法（Qoder 实测有效的用法）

**规则优先级**：`.qoder/rules/*.md` **高于** `AGENTS.md`（Qoder 官方口径）。两侧冲突时以 `rules/` 为准，所以架构硬约束写进 rules，项目介绍写进 AGENTS.md。

**每次开新会话的第一句话**（模板）：
> 读 `docs/12-handoff.md` 与 `docs/01-architecture.md`，然后做 `docs/13-task-cards.md` 里的任务卡 ①。只改卡片「改动面」列出的文件；做完跑卡片上的验收命令，把输出贴给我。

**四条不许**（违反会破坏 `file://` 双击可用与零依赖承诺）：
1. 不许建 `package.json`、不许 `npm install`（只用 Node 内置模块 + 系统 ffmpeg）。
2. 不许手改构建产物（`app/index.html` `canvas/canvas.html` `web/params.html` 和四个模块 `index.html`）——改 `.src.html` 再跑构建器。
3. 不许运行时 `fetch` 本地 JSON（`file://` 下必被 CORS 拦；数据一律构建期内联）。
4. 不许写 C 盘、不许把缓存塞进 `D:\云盘`（产出→`%CLOUD_ROOT%`，中间物→`%CACHE_ROOT%`，默认 `D:\缓存\avp\`）。

**验收门（每次提交前）**：
```bash
node tools/build_all.mjs      # 重建（改了源件才需要）
node tools/selftest_all.mjs   # 必须 PASS 9 · FAIL 0
node tools/lint_ui.mjs        # 必须 7 页全绿
node tools/e2e.mjs            # 必须 47/0（新增模块会让数字变大，不许变小）
```

**Qoder 侧建议**：先让它生成一次 Repo Wiki（把 15 份 docs 和 4 份快照吃成索引），再用任务卡驱动；上下文别塞 8000 行 HTML，按 `grep` 命中行喂片段。

**最常踩的三个坑**（都真实发生过）：
1. **契约漂移**：外壳探测 `../canvas/index.html`，画布实际产出 `canvas.html` → 八个模块全绿而用户看到「未验证」。这就是 `e2e` 存在的原因，别绕开它。
2. **假绿**：模块自检早退但 exit 0；总自检同时校验「全部通过」这句话。
3. **把估算当实测**：`core/engine.js` 的数字是**估算模型**（显存 `W_resident + c1·(Mpix·frames) + decode + overhead`），写进文档必须标 `provenance: estimate|measured`。

---

## 10. 本次交接动了什么（可回滚清单）

| 动作 | 对象 |
|---|---|
| 新增 | `AGENTS.md` · `.qoder/rules/01-contract.md` · `.qoder/rules/02-build-verify.md` · `.qoder/rules/03-ui-style.md` · `HANDOFF.md` · `docs/12-handoff.md` · `docs/13-task-cards.md` · `.gitignore` |
| 新增（数据） | `docs/state/acceptance-2026-11-17.clean.txt`（交接前基线 11:19）· `docs/state/acceptance-2026-11-17-after-handoff.txt`（写入后复跑 11:24）· `docs/state/inventory.md` |
| 复制 | `D:\云盘\03-文档\AI视频平台-最优设计方案.md` → `docs/00-blueprint-v1.0.md`（原件保留） |
| 移出仓库 | `app/index.src.html.restyle.bak` · `canvas/canvas.src.html.restyle.bak` → `D:\云盘\06-归档\avp-restyle-bak-2026-11-17\`（`tools/restyle.mjs` 的自动备份，非构建输入） |
| 未改动 | 全部构建产物、`core/` `spec/` `server/` 源码、四份快照 —— **零代码改动** |