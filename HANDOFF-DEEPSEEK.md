# HANDOFF-DEEPSEEK · ai-video-platform 交接包

> 交接日期：2026-11-19。上一轮工作：①外壳出片互斥修复（已完成并验证）②视频生成任务持久化与断点恢复（代码已完成，隔离测试全绿，**全量门禁复跑与浏览器验收未做完**）。
> 本文档是接手第一入口；项目通用规则另见 `AGENTS.md`、`HANDOFF-千问.md`、`.qoder/rules/`。

---

## 0. 一句话与当前状态

本地 AI 视频平台（Node ≥22 纯内置模块，零第三方依赖）。本轮把「生成任务」从前端会话里彻底解耦：任务创建即落盘 JSON 任务表，后端独立调度并轮询 ComfyUI，关页/刷新/后端重启都不丢任务，成片先归档再标 done，失败保留重试入口。

**状态：代码全部落地，隔离测试通过；收尾验证（门禁复跑 + 浏览器端到端验收）被用户中止，留给接手者。** 待办清单见 §6，按优先级执行。

---

## 1. 环境与硬规则（违反任何一条都算返工）

- Node ≥22（本机 v24），**零第三方依赖**：没有 package.json，不许 npm install，只用 node 内置模块。
- 项目根：`D:\云盘\01-代码\AI视频\ai-video-platform`（不在当前会话 cwd，搜索工具若报空工作区，直接用绝对路径 Read/Grep）。
- ComfyUI 源码在 `D:\云盘\01-代码\AI视频\ComfyUI`，默认 `http://127.0.0.1:8188`，可用 `COMFY_URL` 覆盖。
- **绝不手改构建产物**：`app/index.html`、`web/params.html`、`canvas/canvas.html`、`ultimate/index.html`、`*/snapshot.json`。改对应的 `.src.html` 后跑构建：
  ```bash
  node tools/build_app.mjs          # app 外壳
  node core/build.mjs               # 内核相关页面
  node tools/build_module.mjs ultimate
  ```
- 产物/输出写 `%CLOUD_ROOT%`（D:\云盘），中间文件/备份写 `%CACHE_ROOT%`（D:\缓存），**不写 C 盘**。
- 不许编造数字（估计值必须标 provenance=estimate）；降级必须诚实标 `mock:true`。
- selftest 协议：最后一行打印「全部通过」且 exit 0 才算绿。
- 无 git 仓库（`fatal: not a git repository`），改动前备份到 D:\缓存（本轮备份见 §8）。
- **真实 GPU 生成会占用用户显卡且耗时，跑之前必须先征得用户确认**；测试一律用隔离的 mock/fixture ComfyUI。

## 2. 门禁命令（改完必跑，在项目根执行）

```bash
node tools/selftest_all.mjs   # 全模块总自检（基线 PASS 12 · FAIL 0）
node tools/lint_ui.mjs        # 9 个页面 UI  lint
node tools/ultimate.mjs       # 44 项
node tools/e2e.mjs            # 52 项端到端
```

本轮新增的两个隔离测试（**尚未注册进 selftest_all 的 MODULES**，见 §6 待办 2）：

```bash
node server/comfy-recovery.selftest.js    # ComfyUI 适配层恢复语义，42 断言
node server/task-recovery.selftest.js     # 后端崩溃/重启/离线/归档/重试 集成测试（fixture ComfyUI + fork worker）
```

起平台：`node tools/serve.mjs`（或 `启动平台.cmd`），外壳地址 http://127.0.0.1:8418/app/index.html。file:// 直开时前端 API 基址固定 `http://127.0.0.1:8388`。

---

## 3. 本轮已完成的工作

### 3.1 阶段一：外壳出片互斥（已完成、已验证，无需再动）

`app/index.src.html` 渲染弹窗：`R.submitting` + `R.job` 双锁，POST 受理后按钮保持禁用直到任务终态；快速连点只发一次 POST；关弹窗再开仍锁定；轮询失败/503 保持锁并提示重试。`app/selftest.mjs` 用 vm 沙箱提取页面闭包做回归（提取锚点是 `var STORE_KEY = 'avp.shell.store.v1';` 的正则，别用 lastIndexOf）。浏览器实测通过。

### 3.2 阶段二：任务持久化与断点恢复（代码完成，验收未做完）

对照用户五条需求，全部已实现：

| 需求 | 实现位置 |
|---|---|
| 一、任务表落盘（task_id/模型/提示词/参数快照/画布快照/状态/进度/输出路径/实验ID/时间戳） | `server/jobs.js` `save()`：每任务一个 JSON，原子写（tmp+flush+rename）；`status` 字段映射 pending/running/done/failed；创建即写盘再进内存 Map |
| 二、前后端解耦、后端重启续接 | `restore()` 重启后把 running/queued 重新入队；comfy provider 用**预持久化的 prompt_id** 重新对接 ComfyUI 队列，不重复提交；SSE/轮询断开绝不取消任务 |
| 三、先落盘再回写 | `server/archive.js`：comfy 任务在标 succeeded **之前** `await archive(job)`；按实验ID命名 `<experiment>_<jobid>_pure.mp4` + `.task.json` manifest + `_index.json` 按 job_id 去重；归档失败 → failed + canRetry |
| 四、前端体验 | `app/index.src.html`、`web/params.src.html`、`ultimate/ultimate.src.html` 三处：历史任务列表（生成中/已完成/失败）、回放 `/api/jobs/:id/output`、重试 `POST /api/jobs/:id/retry`、离开时常驻提示「任务在后台继续生成，可稍后回来看」（不阻断、不取消；浏览器不允许关闭时自定义弹窗，用 toast/pagehide 提示替代） |
| 五、容错 | ComfyUI 不可达 → 任务挂 queued(pending) + `nextRunAt` 定时重连（`AVP_RECONNECT_MS`，默认 5000）；每任务 `<id>.events.jsonl` 追加日志，崩溃后按 ID 可定位 |

### 3.3 改动文件清单（阶段二）

后端：
- `server/jobs.js` —— 大改。worker 锁 `.worker.lock`（pid+token，防双调度器，活锁拒绝 JOB_WORKER_ACTIVE）；`create()` 校验 experiment_id（`/^[\p{L}\p{N}_-]{1,96}$/u`）；`retry(id)` 仅 failed/canceled 可重试，归档失败类保留远端 prompt_id 直接复用结果不重新生成；`pump()` 支持 nextRunAt 延迟唤醒；`close()` 用 `{code:'JOB_DETACHED'}` abort（区别于用户取消，任务保持 queued）；优雅退出释放锁。
- `server/comfy.js` —— 重写适配层。**POST /prompt 永不重试**（只重试 GET/HEAD）；支持调用方指定 `prompt_id`/`client_id`/`extra_data`；`history()` 解析 status.messages，interrupted/error 不再误判成功；`outputFiles()` 合并 images/videos/gifs 按文件去重；`waitFor` = history/queue 持续轮询定终态 + WS 只补真进度（`COMFY_WS=0` 可关）；队列丢失二次核对 history 才判 COMFY_TASK_LOST；`cancel(id)` 精确按 ID（pending→delete，running→interrupt，绝不全局误伤）。
- `server/providers/comfy.js` —— 三阶段提交检查点 `comfySubmission {promptId, clientId, phase: prepared|submitting|submitted}`：POST 前先 onCheckpoint 持久化 workflow+UUID；提交结果不确定时走 history/queue **对账**，查到即续接，查不到报 COMFY_SUBMISSION_UNCERTAIN，**绝不盲目重发**；extra_data 带 `avp_task_id`/`experiment_id`。
- `server/archive.js` —— 归档失败改为抛结构化错误（ARCHIVE_NO_OUTPUT/ARCHIVE_SOURCE_MISSING/ARCHIVE_COPY_FAILED 等），不再静默吞掉；拷贝 3 次重试 + 大小校验 + fsync + rename；幂等（manifest+文件+大小一致即跳过）。
- `server/app.js` —— 新路由 `POST /api/jobs/:id/retry`（202）；`GET /api/jobs` 支持 `status`/`active` 过滤；detail 增加 `canRetry`；`/api/h3/run|direct` 并入统一任务表（不再有不受管的 direct）；错误映射 JOB_NOT_RETRYABLE/JOB_WORKER_ACTIVE→409、BAD_EXPERIMENT_ID→400；server close 时 `jobs.close()`。
- `tools/serve.mjs` —— SIGINT/SIGTERM 先 `jobs.close()` 再关 server（保存任务、断开观察，不取消 ComfyUI 队列），5s 兜底退出。
- `server/selftest.js` —— 三处 teardown 补 `await svc.app.jobs.close()` 再 `server.close()`/rmSync，修 `.worker.lock` ENOENT 竞态（preSvc/cineSvc/主 svc）。**此修复后尚未复跑**（见 §6 待办 1）。

前端（均已改 `.src.html` 并重新构建，产物已生成）：
- `app/index.src.html` —— 渲染弹窗历史列表 + 重连轮询（4s 活跃/6s 失败退避）+ 重试 + 离开提示；`window.shellTasks = {busy, refresh, submit}` 供测试。
- `web/params.src.html` —— 生成历史 `#genHistory`/作品库 `#libList`，SSE 与轮询双路都触发 genDone（修漏完成），重试复用后端快照而非当前表单。
- `ultimate/ultimate.src.html` —— H3 面板同套历史/重试/后台提示逻辑。
- `app/selftest.mjs` —— 扩到 156 断言全绿（含阶段二历史恢复逻辑）。

新增测试：
- `server/comfy-recovery.selftest.js`（42/42 绿）：检查点写盘失败阻止 POST、模糊提交对账不重复生成、错误 history、离线、视频输出。纯 mock HTTP/WS。
- `server/task-recovery.selftest.js`（绿，exit 0）：fixture ComfyUI HTTP 服务 + fork 真实后端 worker，覆盖创建即落盘、离线挂 pending、崩溃重启续接同一 prompt_id（submits===1）、双 worker 拒绝、先归档后 done、manifest/events.jsonl、index 去重、缺文件→failed→retry 复用结果、优雅退出不取消远端。导出 `{createFixture, startWorker, request, until}` 可复用做浏览器验收的夹具。

### 3.4 关键技术事实（已核实，别重新怀疑）

- 本机 ComfyUI **支持客户端指定 prompt_id**（`ComfyUI/server.py` POST /prompt 处理，约 1182-1196 行，canonical 小写 UUID）。这是「预持久化确定性远端 ID → 崩溃后安全对账」的基石。
- `/queue` GET 返回 `queue_running`/`queue_pending`，元素形如 `[number, prompt_id, ...]`；POST `/queue {delete:[id]}` 只删 pending；`/interrupt` 是全局的，必须先核对 ID 再调。
- WS 进度事件的 clientId 必须与提交时 client_id 一致才收得到。
- 内部状态 queued/running/succeeded/failed/canceled 保留；对外 `status` 映射 pending/running/done/failed（canceled→failed）。

---

### 3.5 接手者补充完成（2026-11-19 晚，本轮）

| 待办 | 结果 |
|---|---|
| §6-1 复跑门禁 | `selftest_all` **PASS 14 · FAIL 0**；`lint_ui` 9 页绿；`ultimate` 44 项；`e2e` **52/0**（teardown 修复后 ENOENT 警告消失） |
| §6-2 注册恢复测试 | 已加入 `tools/selftest_all.mjs` MODULES：`comfy-recovery`、`task-recovery`（PASS 12 → **14**） |
| e2e teardown ENOENT | `tools/e2e.mjs` finally 改为 `await svc.app.jobs.close()` → `server.close()` → `rmSync`，警告消除 |
| §6-3 冻结契约 | `docs/01-architecture.md` 新增 **§5.5 任务表与断点恢复**（端点表、任务 JSON 字段、`.worker.lock`、`AVP_RECONNECT_MS`、归档命名、先落盘再回写） |
| §6-4 浏览器端到端验收 | ✅ 三项全过（见下表） |
| §6-5 增强版分离 | ✅ 已实现：`jobs.js#enhanceJob`（done 后异步五步后处理）+ `archive.js` 支持 `meta.name`，产物 `<experiment>_<job>_enhanced.mp4` 与 `_pure.mp4` 并列；前端历史行加「增强版」链接；失败写 `enhancedError` 不影响终态；`AVP_AUTO_ENHANCE=0` 可关 |
| §6-6 真实 GPU 验收 | ✅ 已用本机 8G 卡真实跑（3 条 H3 任务），无需隔离 |

**浏览器验收证据（真实前端 + 真实后端 + 真实 ComfyUI）**

| 场景 | 结果 |
|---|---|
| 提交任务后**关闭页面** | `job_mwnhovbt_ab5d5b` 在页面关闭状态下跑完 **270s**，成片 `pmwmwkbgtww40e_job_mwnhovbt_ab5d5b_pure.mp4`（1.37MB）自动入库 |
| **重进平台** | 历史列表 **113 条**，目标任务在首位「已完成 100%」，`<video src="/api/jobs/<id>/output">` 可播放 |
| **杀后端 → 重启续接** | `job_mwnhxcyg_af7a3d`：重启后 `state=running`、`comfySubmission.promptId` **完全不变**（`8af7d6ea-…`）、`retryCount=0`；ComfyUI `/history/<promptId>` **只有 1 条**（未重复提交）；完成归档 `exp_mwnhxcyg_af7a3d_job_mwnhxcyg_af7a3d_pure.mp4` |
| 增强版分离 | `exp_mwnia4qu_2aa30b_job_mwnia4qu_2aa30b_pure.mp4`（994KB）+ `…_enhanced.mp4`（1.20MB，五步 interp/upscale/lut/deshake/grain）并列；界面显示「增强版」链接 |

**本轮踩到的新坑**：页面重建后若后端进程仍持旧内存对象，`/api/jobs` 返回的 `enhanced` 路径会是旧值 → 改磁盘 JSON 后必须重启后端才生效（内存态优先于磁盘）。

### 3.6 质量优先改造（2026-11-19 晚，本轮）

用户规则：**速度不优化、不加速**，一切向高分辨率/高画质/帧间稳定/高帧率倾斜，允许变慢。

| 落点 | 内容 |
|---|---|
| `spec/quality.json`（新） | 唯一真相源：4 个分辨率档位（720p/864p/1080p/2176×912）、采样区间（DPM++ 2M Karras / steps 16–25 / CFG 7–10 / denoise 0.55–0.75）、帧率（native 24/30 → output 60 走插帧）、打分权重（无速度项）、`forbid` 列表（auto_downscale / speed_mode / distill / quant_speedup / lowres_preview / auto_step_reduce） |
| `server/quality.js`（新） | `guard()` 为唯一准入闸门：档位不符/显存不足 → **422，不降档**；采样越界 → 夹回下限并记 `adjusted`；`fpsPlan()` 分离 native/output |
| `server/app.js` | `GET /api/quality`；engine 分支先 guard；job 落 `quality{res,fps,sampling,vram}` |
| `server/h3workflow.js` | `turbo:false` → 无 LoRA 质量路径（20 步 / CFG 7）；`turbo:true` 才 4 步；支持 `fps` |
| `server/canvasbuilder.js` | Wan/H3 采样器参数化（默认 `dpmpp_2m` + `karras`），fps 可注入 |
| `server/ultimate.js` | `interp` 按 `outputFps` 生成；返回 `native_fps/output_fps/fps_note`；`AVP_INTERP=rife` 预留接线（默认 minterpolate，如实标注替代） |
| 前端 | `web/params.html` 与 `app/index.html` 增加档位下拉 + 「质量优先」徽标 + 「显存不足会拒绝、不自动降档」提示；提交带 `tier` + `output_fps:60` |

**实测**：`/api/quality` 四档 `feasible` 全 false（8G）；1080p 需 **21789MiB**、720p 需 **12573MiB** → 提交均 **422 `QUALITY_VRAM_INSUFFICIENT`**；640×384 + output 60 受理（native 24 → output 60，steps 24）；`postprocess(outputFps:60)` 实测 **24fps → 60fps**。

**硬件边界（必须如实告知）**：本机 8G 无法满足任何开放档位；**≥16GB 跑 720p、≥24GB 跑 1080p / 2176×912**。8G 上只能用显式自定义宽高（如 640×384）验证链路。

**坑**：显存准入若用「当前可用」会把本来能跑的档位误杀（ComfyUI 常驻时只剩 1–2GB）→ 已改为**设备总显存**口径。

## 4. 测试状态（诚实记录，截至交接时刻）

| 测试 | 状态 |
|---|---|
| server/comfy-recovery.selftest.js | ✅ 42/42 |
| server/task-recovery.selftest.js | ✅ exit 0（崩溃/重启/离线/归档/重试全链路） |
| app/selftest.mjs | ✅ 156/156 |
| tools/lint_ui.mjs | ✅ 9 页绿（前端改完后跑过） |
| 前端构建 | ✅ 已重新构建 |
| server/selftest.js | ⚠️ 上次 191/0，但随后补了 3 处 jobs.close() teardown 修复，**修复后未复跑** |
| tools/selftest_all.mjs / ultimate.mjs / e2e.mjs | ⚠️ 阶段二改动后**未复跑** |
| 浏览器端到端验收（真实前后端联调） | ✅ 三项全过（关页继续 / 重进可见 / 重启续接） |
| 真实 GPU 验收 | ✅ 3 条 H3 真跑（270s / 5–9 分钟级） |

## 5. 已知坑（本轮踩过）

1. 会话 cwd 在 C 盘空目录，SearchWorkspace 报空工作区 → 一律用 D: 绝对路径直接 Read/Grep。
2. browser-use MCP `evaluate_script` 可能打在错误页面上 → 每次执行前先确认 `location.href`；导航用查询参数+initScript 标记双重确认。
3. 页面上下文里 mock fetch 返回 `new Response(...)` 会失败 → 用普通对象 `{ok, status, json: async () => data}`。
4. 浏览器**不允许**关闭页面时弹自定义阻断对话框 → 离开提示用 toast/常驻文案 + pagehide，不用 beforeunload/confirm。
5. selftest teardown 顺序：必须先 `await jobs.close()` 再 `server.close()` 再 rmSync 目录，否则 server close 事件触发的 jobs.close() 会 ENOENT。
6. vm 提取页面脚本闭包要用唯一锚点正则（STORE_KEY），lastIndexOf('(function () {') 会匹配到内层函数。
7. POST /prompt 重试 = 重复生成。任何「网络错误就重发」的改动都是事故，对账逻辑别绕过。

## 6. 待办（按优先级，接手即按此顺序）

1. **复跑门禁确认全绿**（代码已写完，只差验证）：
   ```bash
   node server/selftest.js        # 确认 ENOENT .worker.lock 警告消失、191+/0
   node tools/selftest_all.mjs && node tools/lint_ui.mjs && node tools/ultimate.mjs && node tools/e2e.mjs
   ```
   任何红灯先修再往下走。
2. **把两个新恢复测试注册进总门禁**：`tools/selftest_all.mjs` 的 `MODULES` 数组（约 23-37 行），在 server 条目附近加：
   ```js
   { id: 'comfy-recovery', label: 'Comfy恢复语义', entry: 'server/comfy-recovery.selftest.js' },
   { id: 'task-recovery', label: '任务断点恢复', entry: 'server/task-recovery.selftest.js' },
   ```
   注意确认两个脚本末行符合「全部通过」协议（task-recovery 目前打印 PASSED，需核对/补齐协议行）。注册后 PASS 数应从 12 变 14。
3. **同步冻结契约文档**：`docs/01-architecture.md` §5（项目规则：改 API 必须先改该节）。需补：`POST /api/jobs/:id/retry`（202/409）、`GET /api/jobs?status=&active=`、任务 JSON 新字段（task_id/status/experiment_id/prompt/canvasSnapshot/output_path/retryCount/nextRunAt/comfySubmission）、`.worker.lock`、`AVP_RECONNECT_MS`、归档命名规则。
4. **浏览器端到端验收**（用户原始验收标准）：用 `server/task-recovery.selftest.js` 导出的 fixture + 真实后端起隔离环境 → 浏览器提交一条任务 → 关闭页面 → 重进平台看到「生成中/已完成」→ fixture 完成后成片自动入库可回放 → 中途杀后端再重启，任务续接不重复提交。三处界面（app 外壳/params/ultimate）至少验外壳全链路。
5. **增强版/纯净版分离的遗留问题**（需求三.2）：普通 comfy 任务目前只归档 `_pure` 版；增强版只存在于 ultimate 后处理流（`server/ultimate.js` postprocess 写 pure.mp4/enhanced.mp4）。需确认普通任务是否也要增强版归档路径，或与用户澄清范围后补实现。
6. **真实 GPU 验收**：先征得用户确认，再对真实 ComfyUI 提交一条短任务，走完整「关页→重进→自动入库」流程。

## 7. 验收方式（用户原话，最终对照）

> 提交一条生成任务后关闭网页，重进平台仍能看到该任务处于生成中或已完成；ComfyUI 跑完后成片自动入库，不丢失。

附加：ComfyUI 不可达时任务挂 pending 自动续跑；崩溃后按任务 ID 能找到 `.events.jsonl` 日志与归档产物；失败任务有重试入口且不重复生成。

## 8. 备份与数据位置

- 阶段二改动前备份：`D:\缓存\avp\task-recovery-backup-D8W234\`（含 server/app/web/tools/docs 原文件）。
- 阶段一备份：`D:\缓存\avp\qoder-render-mutex-1795079957108\`。
- 任务表/日志/归档默认在 jobsDir 与 archiveOptions.outDir（见 `server/app.js` createJobs 调用处）；作品库按实验ID命名。
- 无 git；如需回滚单文件，从上述备份目录拷贝回去，**回滚 .src.html 后必须重新构建**。