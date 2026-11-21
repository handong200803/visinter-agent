# 01 · 平台架构与模块契约

> 本文件是全平台的**边界契约**。任何模块改动如果违反这里的契约，视为破坏性变更。
> 版本：v0.2 · 2026-11-16 · 对应注册表 `spec/params.registry.json` version 0.1.0

---

## 1. 一句话定位

一个**本地部署、按显存自适应、零依赖、双击即开**的视频生成工作台：
用户在界面上做三件事——描述意图、看真实代价、生成成片；平台在背后做四件事——求解参数、编译提示词、调度生成、验收画质。

商用化路径不靠堆模型，靠**管线可解释**：每个参数都有 `impact{vram,time,quality}`，每一帧都有质检分数，每一分钱都能算出来。

---

## 2. 分层

```
┌──────────────────────────────────────────────────────────┐
│  L4  外壳层   app/          唯一入口 · 首启向导 · 项目状态机 │
├──────────────────────────────────────────────────────────┤
│  L3  交互层   canvas/  web/  inspector/  quality/live       │
│              三视图画布 · 参数面板 · 帧检查器               │
├──────────────────────────────────────────────────────────┤
│  L2  生产层   server/  prompt/  quality/  market/  plugins/ │
│              任务队列 · 提示词编译 · 逐帧质检 · 模板 · 插件   │
├──────────────────────────────────────────────────────────┤
│  L1  内核层   core/engine.js + spec/*.json                 │
│              求解器 · 估算器 · 降档 · 预设编解码（冻结）     │
└──────────────────────────────────────────────────────────┘
```

**依赖方向单向向下**：L1 不知道自己被 L2/L3/L4 使用；L2 只通过 `core/engine.js` 的导出接口取数，绝不直接解析 `spec/*.json` 的内部结构假设（除只读字段）。

---

## 3. 数据流（唯一真相源原则）

```
spec/params.registry.json  ← 唯一真相源（258 参数 / 7 板块）
        │
        ├─→ core/engine.resolve()   规则联动 + 值域夹紧 + 改写留痕(trace)
        │        │
        │        ├─→ estimate()     显存/耗时/质量/成本 四维预测
        │        └─→ degrade()      红线时给 N 套降档方案（带代价）
        │
        ├─→ prompt/compose()        结构化槽位 → 中文整句 / tag 串 / 负向集
        ├─→ server/wf.compile()     参数 → ComfyUI 工作流 JSON（未绑定参数必须上报）
        ├─→ market/pack()           参数快照 → .avptpl 模板（可签名、可交易）
        └─→ plugins/loader.merge()  声明的参数/模型并入运行时注册表
                │
                ▼
        生成产物 mp4 ─→ quality/（ffprobe + 四路指标）→ frames[]
                │                                            │
                └─→ inspector（逐帧擦洗 / 框选重绘 / A/B）←──┘
```

**红线**：`spec/*.json` 是生成物，改它请改 `tools/gen_registry.mjs` 后重跑；`web/params.html`、`canvas/canvas.html`、`app/index.html` 是构建产物，改源文件后重跑构建器。

---

## 4. 模块表

| 模块 | 写域 | 职责 | 入口命令 | 自检 |
|---|---|---|---|---|
| 内核 | `core/` `spec/` `tools/gen_registry.mjs` | 求解/估算/降档/预设 | `node core/build.mjs` | `node core/selftest.js` |
| 提示词 | `prompt/` | 中文意图 → 槽位 → 正负向提示词 | `node tools/prompt.mjs compose` | `node prompt/selftest.js` |
| 质检 | `quality/` | ffprobe + 四路指标 → 逐帧分 | `node tools/qa.mjs run <mp4>` | `node quality/selftest.js` |
| 模板 | `market/` | `.avptpl` 打包/校验/HMAC 签名/本地仓库 | `node tools/tpl.mjs list` | `node market/selftest.js` |
| 插件 | `plugins/` | 声明式 manifest 加载与注册表合并 | `node tools/plugin.mjs list` | `node plugins/selftest.js` |
| 后端 | `server/` | provider 抽象（mock/comfy/dashscope/cine）· 任务队列 · REST/SSE · 一句话电影管线 | `node tools/serve.mjs` | `node server/selftest.js` |
| 画布 | `canvas/` | 向导/参数/节点 三视图同源 | `node tools/build_canvas.mjs` | `node canvas/selftest.mjs` |
| 外壳 | `app/` | 首启向导 · 项目状态机 · 模块聚合 | `node tools/build_app.mjs` | `node app/selftest.mjs` |
| 集成 | `tools/selftest_all.mjs` | 全模块总自检 | `node tools/selftest_all.mjs` | 自身即入口 |

---

## 5. 冻结契约（改前必须同步改本节）

### 5.1 求解器导出
```js
const AVP = require('./core/engine.js');
AVP.defaults(reg)                       // → {key: value}
AVP.resolve(reg, rules, values, {ctx})  // → {values, trace[], warnings[]}
AVP.estimate(reg, catalog, values, {device}) // → {vram, time, quality, cost}
AVP.degrade(reg, catalog, rules, values, {device, ctx}) // → {needed, options[]}
AVP.applyPreset(reg, 'draft'|'standard'|'cinematic')    // → {values,...}
AVP.exportPreset(reg, values, meta) / AVP.importPreset(reg, preset)
```
约束：`estimate` 的 `vram.ratio > 1` 意味着**必然 OOM**，任何 UI 不得把它显示成可用。

### 5.2 参数影响口径
`impact = [vram, time, quality]`：前两者是归一化乘性增量（0.05 = 满量程 +5%），`quality` 是边际权重（0..1）。
物理参数（分辨率/帧数/量化/模型）的 `vram` 记 0——显存由物理方程算，不重复计入。

### 5.3 帧质检记录
`frames[]` 每项：`{score, sharp, flicker, flowResidual, status}`，`status ∈ {ok, warn, bad}`，多余指标进 `extra`。
`inspector/index.html` 只认这五个字段——改字段名等于改接口。

### 5.4 模块自检协议
每个模块提供 `selftest.js|mjs`，**成功时末行打印「全部通过」且 exit 0**。
总自检同时校验退出码与这句话，防止早退假绿。

### 5.5 任务表与断点恢复（2026-11-19 阶段二）

**任务是一等公民，不依附于前端会话。** 创建即落盘，后端独立调度，关页/刷新/后端重启都不丢。

| 端点 | 语义 |
|---|---|
| `POST /api/jobs` | 建任务，**202**；`engine: wan22\|minimax_h3` 时按引擎编译工作流（见 docs/25） |
| `GET /api/jobs?status=&active=&limit=` | 任务列表（`status` 对外取 `pending\|running\|done\|failed`） |
| `GET /api/jobs/:id` | 详情，含 `canRetry`、`status`、`output`、`events_url` |
| `GET /api/jobs/:id/events` | SSE 进度流（断开不取消任务） |
| `POST /api/jobs/:id/retry` | **202**；仅 `failed/canceled` 可重试，否则 **409 JOB_NOT_RETRYABLE** |
| `POST /api/jobs/:id/cancel` | 用户取消（唯一会中断远端的行为） |

**任务 JSON 字段**（每任务一个文件，原子写：tmp + flush + rename）：
`id / task_id / status / state / model / engine / prompt / values / canvasSnapshot / workflow / progress / output_path / images / experiment_id / retryCount / nextRunAt / comfySubmission{promptId,clientId,phase} / error / createdAt / updatedAt`

**调度与恢复**
- 单调度器：`.worker.lock`（pid+token）；第二个进程启动时**拒绝** `JOB_WORKER_ACTIVE`（409），防双写。
- `restore()`：重启后把 `queued/running` 重新入队；`comfySubmission.promptId` 是**提交前就持久化的确定性 ID**，重启后先对账 `/history` 与 `/queue`，查到即续接，**绝不重复提交**。
- ComfyUI 不可达 → 任务保持 `pending/queued` + `nextRunAt`，按 `AVP_RECONNECT_MS`（默认 5000）重连续跑。
- 优雅退出：`jobs.close()` 保存状态并断开观察，**不取消远端队列**。

**先落盘再回写**：成片归档成功后才把状态改为 `succeeded/done`；归档失败 → `failed` + `canRetry`，保留远端结果供重试复用（不重新生成）。
归档命名：`<experiment_id>_<jobid>_pure.mp4` + 同名 `.task.json` manifest，`_index.json` 按 `job_id` 去重。

**日志**：每任务 `<id>.events.jsonl` 追加结构化事件，崩溃后按任务 ID 可定位。

### 5.6 质量优先生成与独立后处理

- `spec/quality.json` 是质量策略源。默认720p，四档均可选择；显存不足返回422 `QUALITY_VRAM_INSUFFICIENT`，不自动降分辨率、减步数或量化。显存需求仅为 `estimate`，不是全精度模型实测保证。
- 采样统一 `dpmpp_2m/karras`、16–25步、CFG 7–10、denoise 0.55–0.75；超区间调整写入 `quality.sampling.adjusted`；turbo/蒸馏极速提交仍被拒绝。经用户确认，允许使用已安装的量化权重，实际精度通过 `QUALITY_EXISTING_QUANTIZED_WEIGHTS` 警告与工作流快照记录，不冒充全精度，也不自动量化或替换权重。模型名可通过 `AVP_WAN_UNET/AVP_WAN_CLIP/AVP_H3_UNET/AVP_H3_CLIP` 配置。
- 四个高分辨率档位保留，并提供显式自定义宽高。自定义请求发送 `width/height`、不发送 `tier`；不因显存自动修改尺寸或步数。`GET /api/quality` 的 `runtime` 响应字段区分模型已安装、确实缺失、未能核验，以及独立后处理依赖；后处理缺失不阻止原生生成。
- 启动器 `tools/launch.mjs` 优先发现并复用同任务表的现有后端，未发现时才新建进程；禁止强删活锁或抢占已有进程。`/api/health`增加 `project_root`，运行端口记录在缓存目录 `avp/backend.json`。HTTP页面使用当前origin，不固定连接8388。
- `POST /api/jobs/plan`（带engine）和 `/api/h3/plan` 只产工作流与 `quality` 准入结果，不生成；生成仍经持久化任务队列。`AVP_QUALITY_GUARD=0` 不再绕过准入。
- `native_fps` 仅24/30，默认输出60时Wan原生30；H3受模型音画同步限制固定24。`output_fps`仅24/30/60，60由RIFE后处理产生，不把容器改帧率冒充插帧。模型尺寸向上对齐后仅裁去补齐边缘，保持目标尺寸，不缩放原生样本。
- 原生归档成功即done，独立 `enhancement.state` 记录排队/运行/完成/失败。`POST /api/jobs/:id/enhance` 返回202，重试仅针对后处理；`POST /api/h3/upscale` 改为接收 `job_id` 并排队同一后处理流水线。原生结果不因后处理失败而丢失。
- RIFE/Real-ESRGAN作为用户要求的本地外部程序调用，Node应用仍无npm依赖；路径由 `AVP_RIFE/AVP_RIFE_MODEL/AVP_REALESRGAN/AVP_REALESRGAN_MODEL` 提供。缺少程序或模型时明确失败，不用minterpolate/lanczos替代，也不把部分处理结果标成完整增强片。
- `POST /api/ultimate/score` 仅接受已归档原生任务的 `job_id` 或对应原生文件路径。返回分辨率、原生帧率、已生成增强片的实际输出帧率（未生成为null）、细节代理分与时序分。细节指标不是参考图保真度模型评分；目标函数始终只有Sface/Sflow/Sstyle/Sbad。
- 贝叶斯搜索固定分辨率、种子、帧率、帧数和时长，不搜索速度或后处理参数。`/api/degrade`保留接口但 `options` 为空，不再提供降质执行方案。

---

## 6. 命令速查

```bash
# 全量验收（先跑这个）
node tools/selftest_all.mjs

# 改参数定义后
node tools/gen_registry.mjs && node core/build.mjs

# 改画布 / 外壳后
node tools/build_canvas.mjs && node tools/build_app.mjs

# 起本地服务（无 ComfyUI 自动进 mock 模式）
node tools/serve.mjs            # PORT=8388 COMFY_URL=http://127.0.0.1:8188

# 质检一条成片
node tools/qa.mjs run D:/云盘/02-视频/成片/某集.mp4

# 提示词试编译
node tools/prompt.mjs compose --preset standard --stage keyframe
```

---

## 7. 开发规则（硬）

1. **零第三方依赖**：只用 Node ≥ 22 内置模块 + 系统 ffmpeg/ffprobe。不建 `package.json`，不 `npm install`。
2. **单文件可交付**：所有 HTML 产物必须双击 `file://` 可用 → 数据一律构建期内联，禁止运行时 `fetch` 本地 JSON（file:// 下必被 CORS 拦）。
3. **产出去向**：产出（代码/成片/文档/模板）写 `%CLOUD_ROOT%`；中间物（帧缓存/临时 JSON/日志）写 `%CACHE_ROOT%`；C 盘零占用。
4. **写域隔离**：模块只写自己目录 + 自己的 `tools/<name>.mjs` + 自己的 `docs/0X-*.md`。跨模块需求走契约，不走改文件。
5. **不许编数字**：任何写进文档的耗时/显存/分数，必须来自本次真实运行输出；推断值标 `provenance: "estimate"|"inferred"`。
6. **诚实降级**：拿不到真值（无 GPU 探测 API、无 ComfyUI）时显式标注 `mock: true` 或让用户确认，不得假装已探测。

---

## 8. 未完成项（下一轮）

- 本机 ComfyUI 真实出片联调（8188 未启动；云端 DashScope 万相 t2v 与一句话电影管线已真出片实测，见 `docs/02-backend.md` §11 与 `docs/state/cine-realrun-2026-11-18.json`）
- 8G 卡真机标定：`spec/models.catalog.json` 的 `resident_mib`/`t_factor` 目前多为 estimate，需要真机跑一轮覆盖
- 隐式水印/元数据写入（合规要求，`prompt/safety.metadataStub()` 已出结构，未接 ffmpeg 写入）
- 多语言（当前中文 UI 单语）