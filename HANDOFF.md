# HANDOFF · 交接速查（给 Qoder / 新会话 / 未来的我）

> 完整版：[`docs/12-handoff.md`](docs/12-handoff.md) ｜ 架构契约：[`docs/01-architecture.md`](docs/01-architecture.md) ｜ 任务卡：[`docs/13-task-cards.md`](docs/13-task-cards.md) ｜ 规则：[`AGENTS.md`](AGENTS.md) + [`.qoder/rules/`](.qoder/rules/)
> 快照：2026-11-17 11:19 本机实测 ｜ 仓库：`D:\云盘\01-代码\AI视频\ai-video-platform` ｜ 133 文件 / 4.6 MB / **无 git**

## 一句话

本地部署、按显存自适应、零第三方依赖、双击即开的 AI 视频工作台。**界面、求解器、质检、模板、插件是真的；出片链路是 mock**（本机没有 ComfyUI）。

## 现状（实测，不是号称）

| 项 | 结果 |
|---|---|
| `node tools/selftest_all.mjs` | PASS 9 · FAIL 0 · 5.1s（后端 195/0） |
| `node tools/lint_ui.mjs` | 7 个页面全绿 |
| `node tools/e2e.mjs` | 通过 52 · 失败 0 |
| 模块自检 | market 91/0 · plugins 50/0 · server 195/0 |
| 数据面 | 258 参数 / 7 板块 · 7 档设备（T0 6900MiB→T5 45000MiB）· 14 条联动 · 5 模板（带版本目录）· 4 插件包（Ed25519 签名）+ 3 坏包夹具 |
| 环境 | Node 24.19(runtime)/24.21 · ffmpeg 9.0.2 · RTX 5060 Laptop 8151MiB / cc12.0 / 576.80 · ComfyUI **未安装** · 出片走 DashScope/cine；Qwen 推荐通道 2026-11-18 欠费（QWEN_HTTP_ERROR），降规则轨 |
| 本轮新增（11-19 晚 · ultimate 入外壳） | **外壳一键出片**：`app/index.html` header 新增「出片」→ 动态注入模态（引擎/提示词/进度/预览/作品库/科研台入口）· 复用 `/api/jobs` engine 分支 · 实测 `job_mwnau15s_6e7a52` 450s 出片 `…_00009_.mp4` · 踩坑：静态 modal 被外壳重渲染冲掉、脚本插入点多一个 `})();` 导致整段语法错误（已用 node --check 兜住）· docs/26 |
| 本轮新增（11-19 傍晚 · 双引擎入面板） | **参数面板一键生成接双引擎**：`/api/jobs` 新增 `engine` 分支（H3 13 节点带音频 / Wan 12 节点），前端加引擎下拉（修 `.input width:100%` 把摘要挤成竖排）· 页面实测 405.7s 出片 + 缓存命中 0.5s · 修 `[object Object]` 显示并加预览链接 · docs/25 |
| 本轮新增（11-19 傍晚 · 最后工程） | **OpenCV 真光流**（`tools/score_cv.py` + scoring 接入，Sflow → measured；Sface 因 cv2 5.0 无 CascadeClassifier + YuNet 镜像限流仍 proxy）· **五步后处理全链实测**（interp/upscale/lut/deshake/grain 20s，ΔF=−0.0456，揭示「指标与观感不相关」）· 页面全部接真机数据（snapshot 真机优先）· 完成度 85%→88% · docs/24 |
| 本轮新增（11-19 傍晚 · 补齐） | **四缺口补齐**：Wan2.2 TI2V-5B 部署（9.4G+6.3G+1.4G，ModelScope 源；320×480/17帧/6步 **110s 出片**）· `canvasbuilder.executableFor` 130 规划→12/13 真节点可执行图（Wan 含 SaveLatent，H3 因 NestedTensor 关闭）· `h3real.bayesReal` 真机 3 轮（0.8326/0.8099/0.8265，最优回填）· `ablationReal` steps 2/4/6 → **0.8433/0.8326/0.8186**（2 步最优且最快，121s）+ SVG · 发现 kitchen CUDA 后端因 torch cu128 < cu130 被禁用（H3 int8 VAE 报错的根因）· 完成度 70%→85% |
| 本轮新增（11-19 下午 · 通道对比） | **直连 vs 平台实测**：同 prompt/参数下 200.4s vs 200.3s（差 −0.14s，噪声）；同 seed 缓存命中 8.1s；首帧像素 md5 一致（平台不改结果）；平台增量 = 归档/索引/job 记录/统一错误/可复现（<0.1% 开销）· docs/22 |
| 本轮新增（11-19 下午 · 四项收尾） | **归档/并发/分辨率/ABC**：`server/archive.js`（成片→云盘+`_index.json`，EPERM 重试与读写回退）+ `/api/works{,/preview}` 与页面作品库（6 条）· `/api/h3/status` 并发建议（按总显存，只提示）· `estimateRisk` 分辨率守卫 + `/api/h3/upscale`（lanczos 2x，标注非模型超分）· `server/h3abc.js` + `tools/h3abc.mjs` 真机 A/B/C（A 0.8326 / B 0.8090 / C 0.8253，结论：H3 turbo 4 步默认最优） |
| 本轮新增（11-19 中午 · H3 接入平台） | **本地 H3 走平台任务通道**：`server/h3workflow.js` 定点注入（帧数 17k+5 / 32 倍数 / turbo 4 步）+ `providers/comfy` 支持 `job.workflow` 直传 + `/api/h3/{status,plan,run,direct,job/:id,preview}` + `ultimate` 页 H3 面板（排队/轮询/预览/记忆上次任务）· 修 ComfyUI WS clientId 不匹配导致任务永远 running 的 bug（统一 id + 15s history 兜底）· 页面提交实测 157s 出片 |
| 本轮新增（11-19 上午 · 本地部署） | **ComfyUI 0.44.0 + MiniMax H3 全量本地部署**：`D:\云盘-代码\AI视频\ComfyUI`（.venv + torch 2.11.0+cu128）· H3 42GB 权重（diffusion int8 20.97G / text encoder nvfp4 15.69G / VAE / turbo 4step LoRA）· `tools/h3.mjs check` → MEASURED · `tools/h3_run.mjs` 首条 5s 480×512 音画同步成片成功（461s）· 踩坑：int8 VAE 的 kitchen kernel 与驱动 576.80 不兼容 → 换 fp16 VAE |
| 本轮新增（11-19 上午 · 终极版） | **按 PDF 改造**：`spec/engines.json` 双引擎（Wan2.2 保留 + MiniMax H3 注册，均免费本地）· `canvasbuilder` 130 节点七模块拓扑（locked 复用）· `bayes` GP-RBF+EI 寻优 · `scoring` 四维本地评分 · `ultimate` A/B/C+消融+双版本后处理+五关卡 · `ultimate/` 科研页 · 付费视频模型已全部删除（provider/模型/档位） · 门禁 12 模块 PASS / ultimate 41 项 / lint 9 页 |
| 本轮新增（11-18 深夜 · 二改） | **VisInter 三项改造**：自检改问 ComfyUI（/object_info + /models，global/face 两层 + landscape_ok + 报告三块）· 6 键小白面板与 258 全量共用 `avp.shell.store.v1` 双向同步（含 manualKeys 持久化与「偏离默认不覆盖」）· 脸型关键词+场景预设+preconditions 前置到 UI（下拉可改）· 断言 41→58 项 |
| 本轮新增（11-18 深夜） | **VisInter-Agent 装配层**：`spec/visinter.agent.json` + `server/visinter.js` + `tools/visinter.mjs`（41 项自检）+ `visinter/` 第 8 个模块页（双模式/六类风险弹窗/一键自检）+ `jobs` 新增 `kind=local`（固定本机 ComfyUI，不烧云端） |
| 上轮新增 | 卡④ 显存真值探测 · 卡⑦ 模板版本目录与编译贯通 · 卡⑧ 插件 Ed25519 签名 + ui 真渲染 · 卡⑩ docs/05+14 · 低置信阻断确认卡 · 角色设定自动提取（`docs/16`）· **11-18 晚：两个逆向能力上真机**（`spec/reverse.capabilities.json` + `server/providers/seedream.js` + `tools/capability.mjs` + `/api/capability*`；cine FACE_POS 与能力包对齐，删塑料条款） |

## 开始干活

```bash
node tools/serve.mjs        # 起服务 → http://127.0.0.1:8388/app/index.html
node tools/build_all.mjs    # 重建全部产物
node tools/selftest_all.mjs && node tools/lint_ui.mjs && node tools/e2e.mjs   # 三条门
```

## 接下来三件事（按顺序）

1. **`git init` + 首次提交**（AI IDE 靠 diff 回滚，没有 baseline 不能放心大改）。
2. **卡 ①**（provider 抽象：mock/comfy/dashscope，禁止静默降级）→ **卡 ②**（打通一条链 20–40 个 `bind`）→ **卡 ③**（真出片端到端）。
3. 顺手：**卡 ⑩** 补 `docs/05-inspector.md` 与蓝图偏差表（低风险，随时可做）。

## 四条铁律（违反即返工）

1. 不建 `package.json`、不 `npm install`（只用 Node 内置模块 + 系统 ffmpeg）。
2. 不手改构建产物（`app/index.html` / `canvas/canvas.html` / `web/params.html` / 四模块 `index.html` / `*/snapshot.json`）——改 `.src.html` 或真源后重跑构建器。
3. 运行时不许 `fetch` 本地 JSON（`file://` 下必被 CORS 拦，数据一律构建期内联）。
4. 产出→`%CLOUD_ROOT%`（`D:\云盘`），中间物→`%CACHE_ROOT%`（`D:\缓存\avp\`），不写 C 盘。

## 本次交接新增（可回滚）

`AGENTS.md` · `.qoder/rules/{01-contract,02-build-verify,03-ui-style}.md` · `HANDOFF.md` · `docs/12-handoff.md` · `docs/13-task-cards.md` · `docs/00-blueprint-v1.0.md`（蓝图归仓）· `docs/state/{acceptance-2026-11-17.clean.txt,inventory.md}` · `.gitignore`
移出仓库：两个 `*.restyle.bak` → `D:\云盘\06-归档\avp-restyle-bak-2026-11-17\`。**零代码改动。**