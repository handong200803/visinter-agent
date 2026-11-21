# 13 · Qoder 任务卡（一次一张，粘贴即用）

> 用法：把「卡片全文」+ 一句 `按 docs/12-handoff.md 与 .qoder/rules 的约束执行` 丢给 Qoder。
> **一次只开一张卡**。每张卡都带验收命令，命令不过就是没做完，别让它自己宣布完成。
> 依赖顺序：① → ② → ③，③ 之后 ④⑤ ∥ ⑥ ∥ ⑦ → ⑧ → ⑨；⑩ 随时可做。

---

## 卡 ① · provider 抽象：把「假出片」拆成可替换的一条缝

**目标**：`server/` 现在只有 mock 与 comfy 两条分支，comfy 不可达就静默 mock。改成显式 provider 层。

- **改动面**：`server/comfy.js`（重构为 `server/providers/{index,mock,comfy}.js` 或同级新文件）、`server/jobs.js`（只依赖 provider 接口）、`server/app.js`（`/api/health` 增字段）、`docs/02-backend.md`。
- **接口形状**：`provider = { id, probe(), submit(workflow), status(id), cancel(id), events(id) }`；`probe()` 返回 `{reachable, mode:'real'|'mock', detail}`。
- **硬要求**：
  - `GET /api/health` 必须报 `provider.id` 与 `mode`，**禁止**「comfy 挂了就静默 mock」；要降级必须显式 `degraded:true` + 原因。
  - mock 仍要能跑通全链路（`e2e` 第 3 节依赖它），用环境变量选择：`AVP_PROVIDER=mock|comfy|dashscope`。
  - 不许引入任何 npm 依赖；HTTP 用内置 `fetch`。
- **验收**：`node server/selftest.js` + `node tools/selftest_all.mjs` 全绿；`curl :8388/api/health` 能看到 `provider` 字段；`AVP_PROVIDER=comfy` 且 8188 不通时报 `reachable:false`、`mode:"real"`、`degraded:true`，而不是假装成功。
- **完成定义**：新增一种 provider 不改 `jobs.js` 一行。

---

## 卡 ② · 打通一条链的 bind 覆盖（不求 258 全覆盖）

**目标**：258 个参数里 252 个没有 `bind`，`server/wf.js` 只能报 `unbound`。先让**一条链**能编译出可执行 workflow。

- **改动面**：`spec/params.registry.json`（加 `bind` 字段）、`tools/gen_registry.mjs`（若字段来自生成器）、`server/wf.js`（`unbound` 上报口径）、`docs/02-backend.md`。
- **范围建议**：`keyframe`（56 项）里出图必需的 12–20 项 + `motion`（38 项）里 i2v 必需的 8–12 项 + `export` 的编码 5 项。先覆盖「分辨率/步数/CFG/采样器/调度器/种子/模型/帧数/帧率/编码」，其余留 `unbound` 并**在页面上显式列出未绑定清单**。
- **硬要求**：`bind` 指向真实 ComfyUI 节点字段路径（如 `KSampler.steps`），不许编；未绑定的参数必须在 `POST /api/workflow/compile` 的 `unbound[]` 里可见。
- **验收**：`node server/selftest.js` 全绿；`curl -X POST :8388/api/workflow/compile -d '{...}'` 返回 `applied ≥ 20`，且 `unbound` 与页面显示一致；`node tools/build_all.mjs` 后 `e2e` 仍 47/0。
- **完成定义**：`docs/state/` 存一份 compile 输出，能数出 applied/unbound 比例（当前基线 2.3%，卡完成后写真实新值）。

---

## 卡 ③ · 真出片端到端（本项目的成人礼）

**目标**：`POST /api/jobs` → 真 mp4 落到 `%CLOUD_ROOT%\02-视频\成片\`，并把实测值回填 `estimate`。

- **前置**：卡 ①②。另需一个真实后端（二选一）：
  - 本地：重装 ComfyUI（本机曾装 `D:\AI\comfyui`，已移除；系统 Python 是 `torch 2.15.0+cpu`，**不可**当推理环境；RTX 5060 / sm_120 必须 cu128 轮子）。
  - 云端：DashScope 通义万相（**已有先例**：`D:\云盘\02-视频\成片\仙宫仙境-5s-1080p.mp4` + 同名 `.ledger.json`，`wan2.2-t2v-plus` / `1920*1080` / 5s / 3.3 MB / 2026-11-16T13:58Z 成功），可直接做 provider；key 走环境变量，**不许**写进仓库/前端。
- **改动面**：新增 provider 文件、`server/jobs.js`（产物搬运）、`docs/02-backend.md`（实测段）。
- **硬要求**：产物路径进 `%CLOUD_ROOT%`，中间帧进 `%CACHE_ROOT%`；任务记录里写 `provider`、真实耗时、`actualPeakMib`（拿不到就写 `null` 并说明）；下载/回调失败要可重试。
- **验收**：`node tools/qa.mjs run <新mp4>` 出 `quality.json`；`node tools/selftest_all.mjs` 全绿；`docs/state/` 存 `{provider, model, ms, bytes, actualPeakMib}` 实测记录。
- **完成定义**：拔掉网络（本地路线）或换 key 失效（云端路线）时，任务转 `failed` 并给出人话原因，不静默成功。

---

## 卡 ④ · 显存真值探测 + T0 档 profile

**目标**：`GET /api/devices` 现在是静态表；接上本机真值。

- **改动面**：`server/app.js`（`/api/devices`）、新增 `server/gpu.js`、`spec/models.catalog.json`（`provenance` 标注）。
- **做法**：`nvidia-smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv,noheader,nounits` 取型号与总量；**可用显存**不能只看 total（Windows WDDM 下 8151 MiB 实际约 6.6–7.2G），要么旁路采样 `memory.used`，要么让用户确认后写 `confirmed:true`。禁止编 `vram_usable_mib`。
- **硬要求**：探测失败 → 返回 `{ok:false, reason}`，前端显示「未探测」而不是猜一个档；任何推断值带 `provenance:"estimate"`。
- **验收**：`curl :8388/api/devices` 的 `gpu.name` 与 `nvidia-smi` 逐字一致；`node server/selftest.js` 全绿；`docs/02-backend.md` 记一条实测输出（本机：RTX 5060 Laptop / 8151 MiB / cc 12.0 / 576.80）。
- **完成定义**：换一台机器（或拔掉 eGPU）时档位自动改，且不会假装探测成功。

---

## 卡 ⑤ · 降档方案一键执行

**目标**：`engine.degrade()` 已能算方案，但 UI 只展示不可执行。

- **改动面**：`app/index.src.html`（配置页）、`web/params.src.html`（红线态）、`app/state.js`（动作白名单）、`docs/08-shell.md`。
- **做法**：`POST /api/degrade` → 三套方案（降分辨率 / 降帧数 / 换小模型）带代价 `{vramΔ, timeΔ, qualityΔ}` → 点一套直接写回参数并回到「已配置」，留 `trace` 说明改了哪几项。
- **验收**：`node tools/build_all.mjs && node tools/lint_ui.mjs && node tools/e2e.mjs` 全绿；手工：把分辨率拉到 OOM 红线 → 出三套方案 → 点一套 → 预估从红转绿。
- **完成定义**：不允许出现「ratio>1 显示为可用」的 UI 路径。

---

## 卡 ⑥ · 质检补音频与亮度（对齐既有原子件口径）

**目标**：`quality/` 现在只有锐度/闪烁/帧差，缺音频（`astats` 未接）与亮度白屏黑屏。

- **改动面**：`quality/probe.js`、`quality/frames.js`、`quality/report.js`、`docs/06-quality.md`。
- **做法**：一次 ffmpeg 进程取 `astats` 分窗 RMS（静音窗判定）+ 抽帧亮度（白屏/黑屏门限）；指标进 `extra`，**不改** `frames[]` 五字段契约（见 rule 01）。阈值先在 3 条真实成片上标定，再写默认值。
- **验收**：`node quality/selftest.js` 全绿（新增断言覆盖静音与白屏）；`node tools/qa.mjs run <一条真实成片>` 出的 `quality.json` 含音频与亮度段；文档里的阈值注明「标定样本 + 日期」。
- **完成定义**：故意做一条静音 + 白帧的片子，质检能判 `bad`。

---

## 卡 ⑦ · 模板 → 工作流编译贯通 + 版本目录

**目标**：`.avptpl` 现在只是参数快照，装了也不能跑；且同 id 覆盖安装、无回滚。

- **改动面**：`market/pack.js`、`market/store.js`、`market/spec/template.schema.json`、`tools/tpl.mjs`、`docs/07-market.md`。
- **做法**：模板带 `workflow_ref`（或内嵌最小 workflow 片段）→ `POST /api/jobs {template}` 能直接编译；仓库改 `store/tpl/<id>/<version>.avptpl` 版本目录，安装/回滚幂等；`rebuild()` 保留安装量与评分。
- **验收**：`node market/selftest.js` 全绿；手工：装 v2 → 回滚 v1 → 参数与预估都回到 v1；`node tools/tpl.mjs list` 显示两版本。
- **完成定义**：删掉 `store/tpl` 下某个文件后 `rebuild()` 能自愈索引，不出现幽灵条目。

---

## 卡 ⑧ · 插件签名（Ed25519）+ `ui` 类真渲染

**目标**：`checksum` 只防手改不防伪造；`ui` 类插件只登记不渲染。

- **改动面**：`plugins/loader.js`、`plugins/schema/plugin.schema.json`、`tools/plugin.mjs`、`docs/04-plugins.md`。
- **做法**：manifest 增 `signature{key_id,alg,sig}`，用 Node 内置 `crypto` 验 Ed25519（**零依赖**）；`ui` 插件的 `themes/panels` 接到 `stage-sidebar` 等 slot；`model` 插件加 `resident_mib` 与 `params_b` 自洽校验（不合理给 warning）。
- **验收**：`node plugins/selftest.js` 全绿（含：改一个字节 → 验签失败；坏包 `fixtures/` 三种继续被隔离）；手工：装一个带主题的 ui 插件后页面真的变。
- **完成定义**：伪造包（改值不改签）被拒并给出人话原因。

---

## 卡 ⑨ · 画布手工连线 + 外部 workflow 载入

**目标**：`DATA_LINKS` 是常量拓扑，只能看不能搭。

- **前置**：卡 ②⑦（编译格式定稿）。
- **改动面**：`canvas/canvas.src.html`、`tools/build_canvas.mjs`、`canvas/selftest.mjs`、`docs/03-canvas.md`。
- **做法**：`hitTest` 已预留端口判定 → 拖拽建/删连线；序列化进项目状态；能导入外部 ComfyUI workflow JSON 并映射到节点视图，无法映射的节点显式标灰。
- **验收**：`node canvas/selftest.mjs` 全绿（从 47 项涨上去）；`node tools/build_canvas.mjs && node tools/e2e.mjs` 通过；手工清单（`docs/03-canvas.md` §9）逐条过。
- **完成定义**：画出的图能直接喂 `POST /api/jobs`，且 `unbound` 与参数面板一致。

---

## 卡 ⑩ · 文档补齐（低风险、随时可做）

**目标**：`docs/` 缺 `05`，蓝图与实现的偏差没有对照表。

- **改动面**：新增 `docs/05-inspector.md`、`docs/14-blueprint-gap.md`、`docs/12-handoff.md` §7 同步。
- **做法**：`05` 写帧检查器（`inspector/README.md` 已有素材 + `frames[]` 契约 + 交互与性能口径）；`14` 把 `docs/00-blueprint-v1.0.md` 与现状逐节对照（FastAPI/Vue/Redis/MinIO/ComfyUI 全栈 vs 零依赖 Node 单体），标「已落地 / 等价替代 / 未做 / 决定不做」，每行给理由。
- **验收**：两份文档的链接从 `docs/12-handoff.md` 可达；无死链；不写未运行过的数字。
- **完成定义**：新人只读 `00 → 01 → 12 → 14` 能说清「现在是什么、为什么和蓝图不一样」。