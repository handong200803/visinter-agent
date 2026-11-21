# 02 · 后端服务（本地 / 零依赖）

> 实现：`server/` + `tools/serve.mjs`。运行时 **Node v24.21.0**，只用 `node:http` / `fetch` / 内置 `WebSocket` / `fs`，无任何第三方包，无 `package.json`。
> 模块规范：`server/*.js` 为 CJS（与 `core/engine.js` 一致，`require` 同一份引擎实例）；`tools/serve.mjs` 为 ESM 入口，内部 `createRequire` 载入 CJS。两条线各自语法一致，不混用。

## 1. 进程结构

```
tools/serve.mjs            启动器（PORT=8388 默认，HOST=127.0.0.1）
  └─ server/app.js         路由表 + CORS + 统一错误 JSON + SSE
       ├─ server/providers/  执行后端抽象（mock | comfy | dashscope）
       │    ├─ index.js      工厂：AVP_PROVIDER 选择，未知 id → BAD_PROVIDER
       │    ├─ mock.js       计时器模拟（显式 mock:true）
       │    ├─ comfy.js      包 server/comfy.js 适配层
       │    └─ dashscope.js  万相异步任务（提交/轮询/下载/台账）
       ├─ server/comfy.js  ComfyUI 适配层（超时/重试/红字归一化/进度）
       ├─ server/wf.js     Workflow 编译器（bind → ComfyUI API 格式 JSON）
       ├─ server/ds.js     DashScope 请求编译器（bind_ds → 万相 API body）
       └─ server/jobs.js   队列状态机（内存 + %CACHE_ROOT%\avp\jobs 落盘）
```

路径纪律：任务与自测中间物一律 `path.join(process.env.CACHE_ROOT || 'D:\\缓存', 'avp', 'jobs')`；磁盘探测取 `path.parse(CACHE_ROOT).root`。全仓无硬编码 C 盘。

## 2. ComfyUI 适配层（`server/comfy.js`）

基址 `process.env.COMFY_URL || http://127.0.0.1:8188`；超时 `COMFY_TIMEOUT_MS`（默认 15000），重试 `COMFY_RETRIES`（默认 1，仅网络/5xx 重试，校验类不重试）。

端点封装：`POST /prompt`、`GET /history/{id}`、`GET /queue`、`POST /interrupt`、`GET /object_info`、`GET /system_stats`（可达性探测）、`WS /ws`（进度）。

**红字 → 结构化 code**：ComfyUI 的失败是三层嵌套（HTTP status → `error.type` → `node_errors[id].errors[].type`）。适配层把它压成 `{code,message,hint,detail.nodes[]}`，`detail.nodes[]` 保留 `node / class_type / widget / comfy_type`。映射示例：

| ComfyUI type | 本层 code | hint（人话） |
|---|---|---|
| `prompt_outputs_failed_validation` | `COMFY_VALIDATION_FAILED` | 工作流校验没过，看 detail.nodes |
| `missing_node_type` | `COMFY_MISSING_NODE` | 模板里的 class_type 本机没装 |
| `value_not_valid` | `COMFY_VALUE_NOT_VALID` | 某 widget 取值不在枚举/范围 |
| `exception_during_execution` | `COMFY_EXEC_ERROR` | 执行期抛异常（缺模型 / OOM / 采样器名错） |
| — | `COMFY_UNREACHABLE` / `COMFY_TIMEOUT` | 连不上 / 超时 |

**进度为什么默认走 WebSocket，而不是"没装 ws 就轮询"**：`/history` 与 `/queue` 都不返回百分比，轮询只能推断「排队中 / 执行中 / 已出图」三个阶段；`/ws` 的 `progress` 事件才带 `value/max` 真进度。Node 22+ 自带 undici 版全局 `WebSocket`，属于标准库，所以不需要第三方 `ws`。若反代挡了 Upgrade 或设 `COMFY_WS=0`，自动降级轮询，此时进度帧 `percent: null`、`stage: poll`——**不编百分比**。

## 3. Workflow 编译器（`server/wf.js`）

`compileWorkflow(values, {template, registry})` → `{workflow, applied, merged, unbound, warnings, stats, synthetic}`。

**关键事实（实测，不是假设）**：`spec/params.registry.json` 258 个参数里只有 **6 个**有非空 `bind.target`——

```
ch.subject      CLIP Text Encode  → text
ch.face_detail  CLIP Text Encode  → text     ← 与上一条同槽位，合并
ch.age          Character Builder → age
ch.face_shape   Character Builder → face_shape
kf.resolution   EmptyLatentImage  → width
kf.steps        KSampler          → steps
```

其余 **252 个** `target/widget` 为空字符串。编译器的主职责因此是**如实报告**，而不是假装全都绑上了：

- `unbound[]` 覆盖三类原因：`NO_BIND`（252 条）、`BIND_INCOMPLETE`、`NODE_NOT_IN_TEMPLATE`。每条带 `key/stage/type/reason/hadValue`。
- 同一文本槽位多个参数 → 用「，」拼成整句，记 `merged[]`（`ch.subject + ch.face_detail`）；数值槽位无法合并时后写覆盖并记 `warnings[].WF_SLOT_OVERWRITTEN`。
- 节点匹配做归一化（去掉非字母数字再小写），所以 `"CLIP Text Encode"` 能匹配真 ComfyUI 的 `CLIPTextEncode`。
- 不给 `template` 时生成合成模板（每个 target 一个节点），返回 `synthetic:true`；投递真 ComfyUI 会以 `WF_SYNTHETIC_TEMPLATE` 明确失败，不做"假成功"。

## 4. Provider 抽象层（`server/providers/`）与 DashScope 编译（`server/ds.js`）

**为什么要有这一层**：出片后端不止一种（本机 ComfyUI / 云端万相 / 无后端演示），队列不该关心是谁在跑。统一接口：

```
{ id, mode:'real'|'mock', probe(), run(job,{signal,onProgress,onSubmitted}), cancel?(job) }
```

选择：`AVP_PROVIDER=mock|comfy|dashscope`（默认 `mock`），或 `createApp({providerId})`。**禁止静默降级**：选了真实后端而它不可达，`/api/health` 报 `provider.degraded:true` + 原因，任务照常受理但在执行期 `failed`（如 `DS_NO_API_KEY`），`mock:false`——绝不悄悄换成计时器假成功。

| provider | mode | 说明 |
|---|---|---|
| `mock` | mock | 计时器 10 步 0→100（`AVP_MOCK_MS`，默认 3000），出图占位 `mock:true` |
| `comfy` | real | 走 §2 适配层；合成模板投递 → `WF_SYNTHETIC_TEMPLATE` 明确失败 |
| `dashscope` | real | 万相异步视频任务，见下 |

**DashScope provider（`providers/dashscope.js`）**：

- 鉴权：`DASHSCOPE_API_KEY` **只走环境变量**，不落仓库/前端/任务记录。基址 `DASHSCOPE_BASE_URL`（默认 `https://dashscope.aliyuncs.com/api/v1`）。
- 探测零成本：`GET /tasks/avp-probe-nonexistent`——401/InvalidApiKey 判 key 坏，400/404 判鉴权通（不提交任何生成任务）。缓存 30s。
- 执行：`compileDsRequest` 编译 → `POST /services/aigc/video-generation/video-synthesis`（`X-DashScope-Async: enable`）→ `onSubmitted` 记 `providerTaskId` → 轮询 `GET /tasks/{id}`（默认 5s 一次，超时 20min）→ `SUCCEEDED` 后下载 `output.video_url`（24h 有效）到 `%CLOUD_ROOT%\02-视频\成片`，`.part` 写完再 rename，并写 `<片名>.ledger.json` 台账（对齐 2026-11-16 仙宫仙境实测格式）。
- 进度只报阶段（`queued/generating/downloading`，`percent:null`）：万相轮询接口没有百分比，不编数字。
- 取消：尽力 `POST /tasks/{id}/cancel`；远端不接受时如实返回 `{remote:false,reason}` 并 warn（云端可能继续计费）。
- **计费安全**：`providerTaskId` 一旦存在（已提交云端），任何失败都不自动重投——重投=重复计费。

**DashScope 编译器（`server/ds.js`）**：`compileDsRequest(values,{registry,model,note,promptExtend})` → `{model,request,applied,unbound,warnings,stats,prompt}`。

- 注册表新增 `bind_ds:{path}` 字段（与 ComfyUI 的 `bind` 平行，互不影响），path 是 API body 点路径。**21/258 个参数有 bind_ds**（8.1%，ComfyUI 链仍是 6/258=2.3%），快照见 `docs/state/compile-dashscope.json`。
- 三类落点：① 直写 API 字段（`kf.seed→parameters.seed`、`mo.duration→parameters.duration`、`ex.ai_label→parameters.watermark`）；② 组合字段（`ex.resolution`×`kf.ratio` → `parameters.size`（wan2.2 协议）或 `resolution+ratio`（wan2.7 协议），超范围夹取并记 `DS_RESOLUTION_CLAMPED`/`DS_RATIO_FALLBACK`）；③ 提示词槽位（16 个 ch/kf/mo 参数经 `prompt/compose.js` 编成中文整句 → `input.prompt`/`input.negative_prompt`，结构对齐 Muse 九段式）。
- `prompt_extend` 默认 `true`：交给千问智能改写发挥模型潜能；`mo.duration` 超出模型支持范围夹取并记 `DS_DURATION_CLAMPED`（wan2.2-t2v-plus 仅 5s，实测自台账）。
- 模型能力表带 provenance：`wan2.2-t2v-plus` measured（2026-11-16 台账）、`wan2.2-t2v-flash` estimate（同系推断）、`wan2.7-t2v` doc（官方文档）。模型选择是 provider 级配置（`AVP_DS_MODEL` / `job.model`），不占 258 参数名额。
- `unbound[]` 如实报 237 条 `NO_BIND_DS`——不静默丢弃。

## 5. 任务队列（`server/jobs.js`）

状态机 `queued → running → succeeded | failed | canceled`，并发 `AVP_CONCURRENCY`（默认 1）。每任务落盘 `%CACHE_ROOT%\avp\jobs\<id>.json`，写 `.tmp` 再 `rename` 原子替换；重启时遗留的 `queued/running` 标 `failed/JOB_INTERRUPTED`（不谎报 running）。

每任务记录：`provider / providerTaskId / model / device / values（入参）/ valueSnapshot（258 键求解结果）/ estimate（vram,time,quality,cost）/ startedAt / finishedAt / actualDurationMs / attempt / attempts[] / errors / output`。**`actualPeakMib` 恒为 `null`**：ComfyUI 没有进程级峰值接口，云端万相更拿不到 GPU 数据，拿整机 used 冒充单任务峰值就是编数据。

取消：排队中直接 `canceled`；运行中置 `canceled` 并调 `provider.cancel(job)`——comfy 发 `POST /interrupt`（全局中断，无按 id 定点取消），dashscope 尽力远端取消（失败会 warn 计费风险），mock 循环每步检查标记。失败重试：仅执行期/网络类错误重试 **1 次**（`maxAttempts=2`）；校验类错误不重试；**已提交云端（有 providerTaskId）的任务一律不自动重投**（防重复计费）。

## 6. HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | node 版本、**provider（id/mode/reachable/degraded/reason）**、comfy 可达性+模式、注册表版本、磁盘可用、队列统计 |
| GET | `/api/devices` | 7 档 + 每档默认参数估算 + verdict |
| GET | `/api/params` | 258 参数按 stage 分组，`?stage=` 过滤 |
| POST | `/api/estimate` | `{values,device}` → `engine.estimate` |
| POST | `/api/degrade` | `{values,device}` → `engine.degrade` 方案 |
| POST | `/api/workflow/compile` | 编译预览，不建任务；`{provider:'dashscope',model,…}` 走万相请求编译（applied/unbound/request），缺省走 ComfyUI 图编译 |
| POST | `/api/jobs` | 建任务 `{values,device,template,note,model,promptExtend}` → 202 + queued 快照；`{kind:'cine',prompt}` 走一句话电影管线（见 §11），空 prompt → 400 `CINE_EMPTY_PROMPT`，未知 kind → 400 `BAD_KIND` |
| GET | `/api/jobs` | 列表 `?state=&limit=` |
| GET | `/api/jobs/:id` | 详情（含 valueSnapshot、estimate、attempts；cine 任务含 cineReport/dsRequest/cineLive/cinePick） |
| POST | `/api/jobs/:id/cancel` | 取消（不可取消 → 409 `JOB_NOT_CANCELABLE`） |
| POST | `/api/jobs/:id/pick` | cine 选优窗口内人工改选 `{index}`（0 基）；非窗口/已改选/非运行 → 409 `JOB_NOT_PICKABLE`，越界 → 400 `BAD_PICK` |
| GET | `/api/jobs/:id/events` | SSE：`snapshot → log/progress/state → done`，15s 心跳；cine 任务另发 `cine-group`/`cine-pick` |
| GET | `/api/jobs/:id/output` | 成片发射：`video/mp4` 二进制流（`createReadStream`，支持 Range→206）。无成片（mock/未完成）→ 404 `NO_OUTPUT`；文件丢失 → 404 `OUTPUT_MISSING`；不发射占位假视频 |
| GET | `/api/jobs/:id/candidates/:n` | cine 第 n 组候选关键帧发射：`image/png` 流（只发任务记录的 provider 产物路径）。无该组 → 404 `NO_CANDIDATE`；文件丢失 → 404 `CANDIDATE_MISSING` |
| POST | `/api/presets/export` / `import` | engine 预设导出/导入（含 checksum 校验） |
| POST | `/api/recommend` | `{prompt,device,style,values,model_id}` → 双轨参数推荐（Qwen / 规则），见 §6.1；`model_id` 未知 → 400 `BAD_MODEL` |
| GET | `/api/muse-presets` | Muse 预设叠加层（`spec/muse.presets.json` 原样），http 模式前端取这份 |

CORS 全开（本地工具）。错误统一 `{error:{code,message,detail}}`（5xx 附带 4 行 stack 便于本地排查）；未知路由 404 `NOT_FOUND`，坏 JSON 400 `BAD_JSON`，body > 4MB 413。

### 6.1 AI 参数推荐（`server/recommend.js`，双轨）

三层折叠的推荐层：**core 5**（`kf.sampler / kf.cfg / kf.steps / kf.resolution / kf.refine_denoise`，来自 `muse.presets.json` 的 `core_keys`）→ **common 39**（L3 去掉 core 4 项）→ **advanced_overrides**（L4 中只放非默认、需要改的键）。258 参数数据结构不动，推荐只是叠加层。

- **Qwen 轨**：有 `DASHSCOPE_API_KEY` 时走 compatible-mode `chat/completions`（模型 `AVP_QWEN_MODEL`，默认 `qwen-plus`；`response_format: json_object`；超时 `AVP_QWEN_TIMEOUT_MS`，默认 60s）。system prompt 注入全量参数目录（key|tier|类型范围|默认|中文名），要求输出 `{core, common, advanced_overrides, reason, muse_level}`。
- **规则轨（诚实降级）**：无 key / Qwen 失败 → 关键词命中 Muse 预设（`pickPreset`）+ `engine.resolve`，返回 `source:'rules'` 且 `ai:{attempted, ok:false, error:{code,message}}` 显式说明原因（如 `DS_NO_API_KEY`），**不伪装 AI**。
- **三道防编造闸**（`validateAiPayload`）：未知键 `UNKNOWN_KEY`、枚举非法 `BAD_ENUM`、非数字 `NOT_A_NUMBER`、越界 `CLAMPED`（coerce 夹取）——全部记入 `invalid_keys`，不静默吞。`muse_level` 一律 `provenance:'estimate'`（engine quality.score/10），不是实测。
- 返回体：`{source, model, model_id, model_config, model_notes, preset:{id,name}, reason, core, common, advanced_overrides, values(258 全量 resolved), device, estimate, warnings, muse_level, ai, invalid_keys}`。
- **模型库叠加（`spec/model.configs.json`，9 模型 = 6 图像 + 3 视频）**：请求带 `model_id` 时，规则轨在风格预设补丁之上再叠模型基线（sampler/scheduler/cfg/steps/res→resolution+ratio/负面词/正向后缀/registry_map 底模枚举），Qwen 轨把模型特性与基线注入 user prompt 让千问按模型特性推荐。配置→补丁经 `modelPatchesOf`（与前端同口径）：逐键 coerce，越界夹取与比例近似记 `model_notes[]` 如实上报（如 Wan 5s→mo.duration 上限 3s、1024×1280 无 4:5 枚举→1:1 近似）。`registry_map:null` 的模型（Kolors/HiDream/Pony/CogVideoX/HunyuanVideo）注册表无对应底模枚举——checkpoint 保持当前值，权重路径用户自配，**不扩冻结契约**。旧后端不认识 model_id 时前端本地补叠并显式注记。
- Muse 风格预设 7 个（values 补丁数实测，共 213）：`muse_cinematic` 电影感 39 · `real_photo` 写实摄影 31 · `anime` 二次元动漫 24 · `guofeng_immortal` 国风古风 33 · `cyberpunk` 赛博朋克 25 · `dark_sculpture` 暗黑电影 36 · `dreamy` 梦幻仙气 25。每个带 `emoji`/`example`（小白向导占位示例）、`prompt_suffix`（提示词工程）与 `mapping_note`（用户口径 → 真实键位的映射说明，如注册表无动漫底模 → SDXL + 赛璐璐 + 宫崎式等效）。

## 7. mock 模式

mock 是**显式选择**（`AVP_PROVIDER=mock`，当前默认），不再是"ComfyUI 连不上就自动 mock"。任务 `mock:true`，计时器 10 步推 0→100（`AVP_MOCK_MS`，默认 3000），出图给占位文件名（结构对齐真 `history.images`）。`/api/health` 的 `provider.mode` 为 `"mock"`，绝不伪装成真实执行；选了 `comfy`/`dashscope` 而后端不可达时**不会**退回 mock，而是 `degraded:true` + 任务执行期如实 `failed`。

## 8. 自测与实机验证

```
$ node server/selftest.js
== health ==
  ✓ health 报 provider（默认 mock 显式标记）  id=mock mode=mock degraded=false
== estimate ==
  ✓ 编译器绑定/未绑定如实计数  bound=6 unbound=252 merged=1
  ✓ dashscope 编译 applied≥20（一条链 bind_ds 覆盖）  applied=21 unbound=237 model=wan2.2-t2v-plus
  ✓ dashscope 请求体含 prompt 与 size  size=1920*1080
  ✓ dashscope unbound 清单如实上报  237 条
== jobs · mock 全链路 ==
  ✓ SSE done 事件= succeeded
  ✓ 真实任务详情：succeeded 且 mock:true
  ✓ 实际峰值不编造，明确 null  null
  ✓ mock 任务无成片 → output 路由 404 NO_OUTPUT（不发射占位假视频）  NO_OUTPUT
== recommend · 双轨推荐与防编造闸 ==
  ✓ GET /api/muse-presets 与 spec 一致（预设数 + core 键）  presets=7
  ✓ 每个风格带 emoji + 示例占位（小白向导口径）  count=7
  ✓ 无 key → 规则轨且关键词命中国风预设  source=rules preset=guofeng_immortal
  ✓ 降级原因显式 DS_NO_API_KEY（不伪装 AI）  DS_NO_API_KEY
  ✓ core 层恰好 5 个核心键  kf.resolution,kf.steps,kf.cfg,kf.sampler,kf.refine_denoise
  ✓ common 层 39 项（L3 去 core）  39
  ✓ values 全量 258 键  258
  ✓ advanced_overrides 只放非默认键  14 项
  ✓ 国风补丁落值（fog 65 / LoRA 0.6）  fog=65 lora=0.6
  ✓ muse_level 恒标 estimate（非实测）  score=7.8
  ✓ 未知档位 → 400 BAD_DEVICE  BAD_DEVICE
  ✓ 防编造闸四类全触发  NOT_A_NUMBER,CLAMPED,BAD_ENUM,UNKNOWN_KEY
  ✓ 越界夹取 / 保持默认跳过 / 未知键不入值  steps→50
== provider · 真实后端不可达不静默降级 ==
  ✓ dashscope provider 显式 real  id=dashscope
  ✓ 无 key → reachable:false + degraded:true  reason=未设置 DASHSCOPE_API_KEY
  ✓ dashscope 无 key 仍受理入队（失败在执行期如实报）
  ✓ 无 key 任务 failed 而非假成功  DS_NO_API_KEY
  ✓ 真实 provider 任务不打 mock 标  false
== 结果 ==
  通过 85 · 失败 0
全部通过
```

（以上为 2026-11-17 实测输出节选；完整 85 项含 devices/params/presets/取消/静态发射/recommend/模型库/output 路由等，见 `node server/selftest.js`。）

实机启动（`PORT=8399 node tools/serve.mjs`，2 秒后 curl，2026-11-17 实测）：

```
[avp] 后端已启动 http://127.0.0.1:8399
[avp] 平台入口 http://127.0.0.1:8399/app/index.html（同端口发射全部模块页）
[avp] provider mock（mode=mock；AVP_PROVIDER=mock|comfy|dashscope 切换，真实后端不可达会如实报错不静默降级）
[avp] 任务落盘 D:\缓存\avp\jobs
[avp] 并发 1 · 端口 8399 · 启动耗时 23ms
$ curl -s http://127.0.0.1:8399/api/health
{"provider":{"id":"mock","mode":"mock","reachable":true,"degraded":false,"reason":null},
 "comfy":{"reachable":false,"mode":"mock"},"registry":{"version":"0.1.0","params":258,"stages":7},
 "disk":{"mount":"D:\\","free_gib":415.4,"total_gib":652.9}}
```

curl 样例见第 6 节各端点，实测摘要：`/api/devices` → `T0:ok T0-low:block T1..T5:ok`；`/api/jobs` 建任务后 SSE 首帧 `event: snapshot`，随后 `event: progress` 连续推进。

**坏 key 实测（2026-11-17，真实网络请求，零计费探测）**：临时进程内设假 key 起 `providerId:'dashscope'`——

```
health.provider: {"id":"dashscope","mode":"real","reachable":false,"degraded":true,"reason":"Invalid API-key provided."}
job 受理: 202 → 终态: failed  mock:false  耗时 205ms
error.code: DS_INVALID_API_KEY（HTTP 401 / InvalidApiKey）
hint: API key 无效或已失效：检查 DASHSCOPE_API_KEY 是否与模型地域匹配（北京/新加坡 key 不通用）。
```

即卡③完成定义「换 key 失效 → failed + 人话原因，不静默成功」已成立；同时证明本机到 DashScope 网络通路正常。质检链路已用先例真片验通：`node tools/qa.mjs run 仙宫仙境-5s-1080p.mp4` → 综合分均值 96 · 问题帧 0/150（报告落 `%CACHE_ROOT%\avp\qc\out\`）。证据存档 `docs/state/provider-verify-2026-11-17.json`。**真出片仅差有效 `DASHSCOPE_API_KEY`。**

**一键真出片（卡③执行器，2026-11-17 新增）**：

```bash
node tools/realrun.mjs --prompt "云海之上的宫殿，雾气缭绕" --style guofeng_immortal
# 可选：--model wan2.2-t2v-plus（默认） --device T0 --no-qa
```

进程内队列直连 DashScope（不占 HTTP 端口、不碰用户 8388 的 jobs 目录，用 `%CACHE_ROOT%\avp\jobs-realrun` 隔离）；key 解析顺序：进程环境 → 用户环境注册表（`setx` 后无需重启 Qoder），不落仓库/日志。链路：风格预设 + `ch.subject` → 提交 → 轮询（只报阶段不编百分比）→ 真 mp4 转存 `%CLOUD_ROOT%\02-视频\成片`（.part + rename + 台账）→ `qa.mjs --json` 逐帧质检 → `docs/state/realrun-<date>.json` 实测记录（`provenance:measured`，`actualPeakMib:null`）。无 key → exit 1 + 设置指引；已提交云端的失败不自动重投（防重复计费），留 taskId 人工续查。无 key 路径与质检 JSON 解析已用先例片实测（2026-11-17）。

## 9. 静态发射（`server/static.js`）

服务同时是平台页面的发射器：`GET/HEAD` 且路径不以 `/api` 开头时，按白名单后缀从仓库根目录发文件。这不是"顺手加的便利"，是外壳能真实探测模块的前提（`docs/08-shell.md` §7）。

| 路径 | 行为 |
|---|---|
| `/app/index.html`、`/app` | 平台外壳（目录请求落到 `index.html`） |
| `/canvas/canvas.html`、`/web/params.html`、`/market|plugins|quality|server/index.html` | 七个模块入口 |
| `/spec/*.json` | 注册表/模型档/联动规则（页面也会 fetch 它们） |
| 后缀不在白名单（如 `.md`） | `403 TYPE_BLOCKED` |
| 解析后越出仓库根（`..` / 反斜杠 / 空字符） | `403 PATH_OUTSIDE_ROOT` / `404` |
| 任何 `/api/*` 未命中 | 仍走结构化 `404 NOT_FOUND`，语义不受静态层影响 |

三条边界写死在 `serveStatic()` 里并逐条自测：只发本仓库目录、只认白名单后缀、只读。`Cache-Control: no-store`——本地改一个文件重开就要看到新的。

## 10. 已知缺口

1. **ComfyUI 链绑定覆盖率 2.3%**：252 个参数没有 `bind`，编译器只能报 `unbound`。DashScope 链已补到 **21/258（8.1%）**（`bind_ds`，快照 `docs/state/compile-dashscope.json`），其余 237 个仍如实报 `NO_BIND_DS`。
2. **合规模板不可执行**：`synthetic` 模板没有采样链/SaveImage，仅用于预览与对拍；真投递需自定义节点（`Character Builder` 等）在本机 ComfyUI 已安装。
3. **真实峰值缺失**：`actualPeakMib:null`。ComfyUI 需旁路 `nvidia-smi` 采样；云端万相无 GPU 数据可取，恒 null 是如实而非缺口可补。
4. **`/interrupt` 是全局的**：ComfyUI 无按 prompt_id 取消，多任务并发时取消会波及同进程其它任务。
5. **WS 路径未在真 ComfyUI 上验证**：本机 8188 未启动，WS 分支只做过语法/降级路径审查，实战表现待接真服务后复测。
6. **单进程内存队列**：无优先级、无持久化锁，多实例会互相覆盖 `%CACHE_ROOT%\avp\jobs`（本地单实例场景可接受）。
7. **DashScope 真出片已实测**：卡③（万相 t2v）与一句话电影管线（§11，cine）均已用有效 `DASHSCOPE_API_KEY` 跑通真实提交→轮询→下载→后处理→转存全链路。最近一次 cine 实测见 `docs/state/cine-realrun-2026-11-18.json`（`job_mwlk1tr5_eb206c`，223.4s，1080×1608@48fps）。`actualPeakMib` 仍恒 null（云端无 GPU 数据）。

## 11. 一句话电影管线（`server/cine.js` + `server/providers/cine.js`）

目标：用户只写一句话，平台自动跑出 Muse 级电影效果，全程零手动调参。这是独立于主 provider 的**第二条出片缝**：`job.kind==='cine'` 的任务由 `cineProvider` 执行（`jobs.js providerFor`），其余任务仍走主 provider。cine provider 复用 dashscope 的 `probe`/`cancel` 与 key 纪律（key 只走 `DASHSCOPE_API_KEY`，不进仓库/前端/任务记录）。

**七步与真实能力映射（诚实降级，不冒充）**：

| 步 | 规格 | 本机真实实现 | provenance |
|---|---|---|---|
| 1 分析 | Qwen3.8 拆解主体/场景/光线/情绪/镜头/画面类型 | `qwen-plus`（compatible-mode chat），无 key 显式降级 | measured |
| 2 八组关键帧 | 8 组风格 + 统一修饰词/负面词 | `qwen-image-2.0` 同步 t2i（`multimodal-generation/generation`，1024×1536），修饰词/负面词逐字照规格 | measured |
| 3 五维评审 | 五维各 2 分满分 10；≥9 通过 / 8~8.9 候选 / <8 重试≤3 | `qwen3-vl-plus` 视觉评审 A-E（符合度/构图/光影/人脸主体/风格），另判 `western_face`/`limb_deformity`；8 条诊断-修正映射 | model-opinion（非像素实测） |
| 4 选优 | 8 组全部≥8 后取总分最高，用户可改选 | `reduce` 取最高；`onPick` 开 `AVP_CINE_PICK_MS`（默认 15s）窗口，`POST /pick` 改选，以用户为准 | measured |
| 5 图生视频 | wan2.2 i2v，首帧=最优帧，5s 720p 16fps，画幅跟随 | `wan2.2-i2v-flash` 异步；运动/负面词逐字；默认固定机位，仅明确推近/拉远/环绕/跟拍才加运镜并标注；提交期失败切备用云端（`AVP_CINE_I2V_BACKUP`），两通道皆败明确报错 | measured |
| 6 电影后处理 | 固定顺序：RIFE48→ESRGAN1080→分风格LUT→颗粒8%→暗角1.5%+中心提亮→±0.5%呼吸→H.264 8Mbps | **ffmpeg 替代**（铁律禁第三方 ML）：`minterpolate(mci)`48 → `scale lanczos` 保aspect → 分风格 33 点 `.cube`+`lut3d` → `noise=alls=8` → `eq`+`vignette` → `crop`±0.5% → `libx264 -b:v 8M` | 替代口径见 `cineReport.substitutions`（`is_rife:false`/`is_esrgan:false`/`face_mask_applicable:false`） |
| 7 播放+入库 | 自动播放、自动存作品库、5 候选可切换 | 前端 `cineFinish`→`saveWork`→`renderPreview`；8 组候选保留可点选切换 | measured |

**关键帧采样器基线**：规格 DPM++ 3M SDE Karras / CFG 6.0 / 30 步在本机 `applicable:false`——无 ComfyUI（实测 ECONNREFUSED），云端 qwen-image 不暴露采样器/CFG/步数旋钮；尺寸 1024×1536 真生效。记于 `cineReport.keyframeBaselineNote`（provenance:measured），不谎称已应用。

**fps 偏差如实告警**：规格基线 16fps，实测 i2v 输出 30fps（`ffprobe` measured），后处理按实测源插帧到 48fps，发 `CINE_FPS_DEVIATION` 告警。竖屏源（784×1168）按 `postTargetSize` 保 aspect 升到 1080×1608，不硬拉 1920×1080 致变形。

**计费安全**：组内已有 ≤3 次打磨重试；任务级一律不重投（`retryable = job.kind!=='cine' && …`），重跑会把已计费的 8 组关键帧再买一遍。提交成功后的失败保留 `providerTaskId` 供人工续查。

**进度文案（照规格）**：`正在分析你的描述...` / `正在打磨8组关键帧（第X/8组）...` / `第3组光影不够，重新生成...` / `8组精品已就绪，正在选最优...` / `正在图生视频...` / `正在电影级后处理...`。

**前端（`web/params.src.html`）**：第二步「电影模式 · 8 组打磨出 Muse 级 / 快速生成 · AI 调 258 参数」切换（默认电影模式）；第三步六阶段进度 + 候选直播网格 + 选优倒计时窗口；第四步成片自动播放 + 8 组候选网格（点选切换大图）+ 后处理真实替代口径展示。作品库回放保留 cine 摘要（`cineSummary` 精简，不存整份重试提示词）。**保留**暗黑玻璃磨砂 UI / 258 参数面板 / 7 风格 / dsRequest 透明展示。**模式精简**：小白模式 tab 移除（默认专家+全部参数两档），向导经 header「一句话电影」独立按钮进入；**作品库独立按钮**分电影库(`avp.works.v1`)/专家库(`avp.works.expert.v1`，专家一键生成单独入库)。

**自测**：`server/selftest.js` cine 块用零计费 fake-transport 跑通纯函数 + 全链路 + HTTP 契约（126/0）；`tools/e2e.mjs` §3b 用 cine 桩验受理/改选/候选路由（52/0，不触发云端计费）。

### 11.1 工程级增量（2026-11-18 晚 · 词库/人脸/采样/评分/视频/后处理/兜底/作品库）

在 §11 七步之上补全规格【一】~【七】的可执行部分；不可执行部分一律 `applicable:false` 如实记录，不冒充。

- **七风格词库（逐字挂载）**：`STYLE_WORDS{cinema,doc,anime,guofeng,cyber,dark,dream}` POS/NEG 逐字；`STYLE_MAP` 把前端 MUSE 预设 id / 分析 style_id 映射到规格 id；每组提示词 = 槽位 + 组方向 + 风格 POS（领词 `(词:1.15)` 加权，单句≤1.25）+ 人脸 + 规格修饰词；负面 = 统一 NEG + 风格 NEG + 人脸 NEG + 重试追加。
- **中国人脸体系**：`FACE_POS`/`FACE_AGE{teen,young,middle,old}`/`FACE_NEG` 逐字；写实类自动挂载（`detectAge` 按关键词追加年龄），anime 不挂（自身脸部美学）。2026-11-18 起皮相组与 `spec/reverse.capabilities.json#douyin-face` 对齐：**(visible skin pores retained:1.1) + (dewy highlight on cheekbones and nose tip:1.2) 必须并存**，旧版 `no visible pores / flawless complexion / beauty filter look` 与 `FACE_NEG` 里的 `natural visible pores` 已删除——那四条合起来就是塑料脸配方，与逆向结论（只磨皮=塑料、只水光=油脸）冲突。技术链 `FACE_TECH`（asianFace_v1 LoRA 0.70 可调 0.50~0.90、FaceDetailer 2×/denoise0.35、人种检测、mask 保护）在本机 `applicable:false`（无 ComfyUI、云端无 LoRA/重绘旋钮）→ 以人脸提示词 + VL `western_face` 意见（model-opinion）真实替代；西方面孔→该组诊断 `western`、LoRA 记录提 0.80、追加人脸 POS 重生成。
- **分风格采样**：`SAMPLING` 七风格 sampler/CFG/步数；`keyframeSize` 横版 1536×1024 / 竖版 1024×1536 真生效；sampler/CFG/步数云端不暴露 → `applicable:false`。`groupSeeds(8)` 互异种子真写入 t2i 请求 `parameters.seed` 并落报告。
- **评分与重试**：五维 A-E 各 0-2（内部×5 存 0-10，total=均值=0-2 之和）；≥9 pass / 8~8.9 candidate / <8 重试≤3；3 次仍<8 保留最高分标 `质量一般` + `CINE_GROUP_BELOW_TARGET`。`diagnoseFix` 8 条规则（plastic/face/light/composition/color/western/style/limbs），CFG5.5/步数+2/LoRA0.80/FaceDetailer 均记录但 `cfgApplicable:false`。
- **i2v**：运动词/视频 NEG 逐字（`almost static locked-off shot…` / `…head turn…`）；`detectCamera` 仅明确运镜才加并标注；提交期（未计费）失败切备用模型，两通道皆败抛 `CINE_I2V_BOTH_CHANNELS_FAILED`，不出占位假视频；已提交（有 taskId）不重投。
- **后处理固定顺序**：插帧48 → lanczos 超分 → 分风格 LUT（`STYLE_GRADE` 七套：cinema 青橙 / doc 中性低饱和 / guofeng 青灰赭石 / cyber 蓝紫品红 / dark 冷灰压暗 / dream 粉奶油 / anime）→ 颗粒8% → 暗角1.5%+中心提亮 → ±0.5% 呼吸 → H.264 8Mbps。人脸 mask 单独保护不可执行 → `face_mask_applicable:false`，靠低饱和偏移近似。
- **兜底与续跑**：每组落 `checkpoint.json`；`job.cineResume`（前端「从失败步重试」）复用已产出帧与已提交 i2v taskId，不重复计费；显存不足降 768×1024/关 FaceDetailer 与「云端不足切本地」属 ComfyUI 口径，本机无 ComfyUI → 记录为策略不假装执行；解析退规则轨（低置信）前端在替代口径区显式提示返回修改。
- **作品库字段补全**：`cineReport`/`cineSummary` 增 `styleWords/face/sampling/seeds/camera/params(sampler,cfg,steps,size,lora,seeds,duration,fps,bitrate)/modelChain/retries/status(success|partial)/paramsFile`；8 帧路径 + 最优帧序号（`candidates[].picked`）+ 五维分 + 重试次数保留；`cine-params.json` 落盘。

### 11.2 工程提级方案对齐（灰境方案 M1~M10 · 2026-11-18 · 不换模型抬上限）

按外部方案「模型可替换、平台做生产线」理念，在**同一模型**上用工程闭环抬出片上限（不靠换模型）。已落地（方案§7 第一步单镜闭环 + 第三步质感/声音）：

- **M1 分镜引擎（单镜行）**：`buildShotTable` 产出 `report.shots[]`（镜号/主体/动作/景别/运镜/时长/情绪/光线/首尾帧描述），多镜扩展预留。
- **M3 选帧台 / M5 多候选**：复用既有 8 组候选网格 + 选优窗口 + 互异种子留档（已存在）。
- **M6 QA 双闸**：像素闸复用 `quality/frames.js analyze`（sharp/flicker/flowResidual，本机传统信号量、零第三方 ML）+ 审美闸（VL 选优分）。阈值 `QA_BASELINE` **实测标定**（2026-11-18 四条验收成片 948 帧，P20/P80 + 好片上限留余量；sharp 饱和=1 取 0.9、flicker 含合法运动故用上限 2.0/均值 0.30 而非 P80、flow 0.20/硬顶 0.32），见 `D:/缓存/avp/qa-calibration-2026-11-18.json`。不达标记 `CINE_QA_GATE_FAIL` + 淘汰原因，**不自动重投计费**（人工重试/换候选）。
- **M8 filmic 调色+光学**：`readExposure`（signalstats YAVG，相对路径绕盘符坑）→ `buildFilmicCube`（ACES 近似 tonemap + 曝光匹配 + 风格轻 tint）；滤镜链加 halation(split+gblur+screen)、deflicker、gate weave(±0.2% 慢正弦) 叠加呼吸 ±0.5%；预设落 `grade-preset.json` 可复用（L3 沉淀）。
- **M9 声音**：`muxAmbientAudio` ffmpeg 零依赖合成环境声床（pink/brown noise 低通 + 正弦 pad tremolo，按风格配方）混流 AAC；**非原生音画同步**如实标 `source:'synthetic-ambient', native:false`；失败标 `silent:true` + `CINE_AUDIO_SKIPPED`。
- **M10 入库**：`cineReport`/`cineSummary` 增 `shots/qa/gradePreset/audio`；前端替代口径区展示 QA/调色/声音/分镜。
- **M1 多镜分镜 / M4 一致性 / M7 组接（§7 第二步）**：`runCineMultiShot`（`job.cineMulti`，前端「多镜短片·3镜」开关）→ `buildMultiShots` 3 镜（广角环境/中景/特写）各带 `lock` 锁定描述（same character/outfit/location/grade）随镜传递；每镜 M3/M5 出 4 候选 VL 选最优（12 图）；逐镜 i2v（**img_url 必须用关键帧远程 URL，本地路径云端报 No connection adapters**）→ 逐镜 M8 filmic → `concatShots` xfade 交叉溶解（失败退硬切 concat + `CINE_CONCAT_FALLBACK`）→ `report.timeline{shots,transition,crossfade,totalDuration}` → M9 整片声 → M6 终审 QA → 入库。**M4 尾帧继承不可执行**：云端 i2v 只收公网 URL，本地尾帧无 URL → `cineContinuity` 请求时发 `CINE_CONTINUITY_UNAVAILABLE` 如实告警，以锁定描述保一致（不假装尾帧继承生效）。

**本轮未做（方案§7 第四步，后续）**：M2 资产参考库、M10 IndexedDB 持久化与五表数据模型、L1 adapter 统一接口重构（现 providers/ 抽象已部分承担）。

**诚实边界（方案§1.2/§9，写进定位不夸大）**：工程闭环把同一模型平均出片拉到其能力上限附近，消除"人不会做"的差距；**消不掉**复杂物理运动、逐帧面部/手部精度、长镜多人一致性、原生音画同步、分辨率/帧率硬规格等模型天花板。RIFE/ESRGAN 类本地 ML 超分插帧仍禁（铁律），M8 只用 ffmpeg 传统滤镜。

### 11.3 严苛质量审核机制（`server/audit.js` · 五道闸 G0~G4 + 三态）

按外部「严苛质量审核机制」方案落地 M6 完整版。**能力边界诚实**：自动闸只跑本机传统信号量（复用 `quality/frames.js`）；结构/人脸/手/一致性/穿帮/水印走云端 VL；**视频的结构项需抽帧公网 URL 或人工（本机无帧托管）→ 视频 VL 置 null → 这些项一律 REVIEW，不假装自动判过**。

- **G0 输入闸**：`inputGate` 提示词空/过短(<4字) → `CINE_INPUT_GATE` 退回补全，不计生成。
- **G1 生图静态闸**：每关键帧 `auditMedia(image)` = 信号量(sharp/曝光/死白死黑/抖动/直方图漂移) + VL 结构/穿帮/水印 → 三态；**REJECT 淘汰不入候选池**（单镜 pick 只在非 REJECT 组里选；全 REJECT → `CINE_ALL_REJECTED`；多镜 G1 REJECT 不投 i2v 省计费）。
- **G2 视频动态闸**：每 i2v _raw_ `auditMedia(video)` 时序信号量(flicker mean/max、flow mean/max、黑帧/冻结比例、jitter、histDrift) + 硬阈值一票否决；REJECT → `CINE_G2_REJECT` 不流入后处理/组接。
- **G3 成片终审闸**：全片复扫 → `report.qa` 增 `decision/tier/total/vetoHits/tags/review/scores/thresholdVersion`；REVIEW 发 `CINE_G3_REVIEW` 进人工复核。
- **G4 入库合规闸**：`complianceGate` 元数据完整性(output/params/modelChain) + 水印/乱码 → `report.compliance`；存疑发 `CINE_G4_COMPLIANCE`。
- **三态 + 一票否决 + 加权**：`decide()` PASS/REJECT/REVIEW；否决项(`VETO`)命中即 REJECT 不被总分抵扣；权重 技术30/结构30/一致20/审美20；分档 ≥9精选 / 7.5–8.9可用 / 6–7.4 REVIEW / <6 REJECT；**结构单项低于合格线最高只能 REVIEW**；VL 缺结论 → REVIEW。
- **留痕 QAReport**（§8.1）：`report.audit[]` 每条含 id/mediaType/spec/metrics/vlCheck/decision/tier/total/scores/vetoHits/deductions/tags/review/reviewer/reason/retryHistory/thresholdVersion/at。
- **缺陷字典**（§8.2）`DEFECT_TAGS` 29 枚举；**阈值版本化**（§8.3）`THRESHOLD_PRESETS.version='2026-11-18.1'` 分组(default=实测标定基线；jitter/histDrift/曝光/结构合格线标 placeholder/estimate)。
- **人工复核**：`POST /api/jobs/:id/review {auditId,decision,reason}` → `jobs.review` 改判 PASS/REJECT、写 reviewer/retryHistory、发 `cine-review` 事件；404 AUDIT_NOT_FOUND / 400 BAD_REVIEW。前端审核抽屉对 REVIEW 条给「改判通过/改判淘汰」。
- **前端**：候选卡三态角标(PASS绿/REVIEW黄/REJECT红)+缺陷 chip；审核报告抽屉逐项指标/阈值版本/VL/否决/扣分/复核按钮。

### 11.4 画幅比例（默认 16:9 + 可选）

`RATIOS{16:9,9:16,1:1,3:2,2:3}` → t2i 尺寸(16:9=1280*720 等) + 回退尺寸；`DEFAULT_RATIO='16:9'`（平台默认横屏电影画幅）；`ratioFor(prompt,ratio)` 显式优先、竖屏关键词→9:16、否则默认。`job.cineRatio` 由前端「画幅比例」开关传入。**输出比例保证**：`postTargetSize(srcW,srcH,ratio)` 按所选比例定目标分辨率(16:9→1920×1080)，`postFilterChain` 加中心裁画幅 `aspectCrop` → 即使 t2i 尺寸回退到别的宽高比，成片仍=用户所选比例。尺寸不被模型支持时 `genImage` 回退 `fallbackSize` 并记 `fellBackFrom`（不假装原尺寸生效）。

### 11.5 氛围审美层（`server/aesthetics.js` + `spec/aesthetics.json` · 抖音氛围感方案）

内置**画面审美体系**（光影/色调/镜头/质感/竖屏），作用于 M3 选帧提示词 / M8 filmic 调色 / M9 声音 / M6 审美闸；不做带货脚本/剧情钩子/CTA。

- **8 题材配方**（`spec/aesthetics.json.themes`）：日落金色人像/公路、冷调夜景霓虹、清冷森林雪境、古风汉服、清感室内窗边、复古胶片日常、海边旷野孤独、暗调 Noir；每类含 scene/light/color/lens/texture/motion/neg/params{cfg,steps,res,hd,negStrength,sampler}/ratio/duration/soundMood/grade。
- **词库**（`words`）：光影(逆光轮廓/黄金时刻丁达尔/侧光伦勃朗/夜景光斑/体积雾)、色调(青橙/银灰/暖棕/红黑/低饱和)、镜头(慢推慢拉环绕跟拍/景别焦段/三分留白)、质感(胶片颗粒/halation/轻暗角/色散/皮肤纹理/空气透视)、通用负面。
- **匹配与拼接**：`matchTheme(prompt)` 关键词计分（无命中不硬套）；`promptSuffix(recipe)` 把 light+color+lens+texture 拼进关键帧提示词；`negativeAdd` 通用+题材负面；`job.cineTheme` 显式优先。
- **参数规则**：`paramRules(recipe)` 输出分题材 CFG/步数/竖屏分辨率/HD/负面强度/采样器（**请求口径 applicable:false**，云端不暴露；分辨率/画幅真生效；duration>5s 受 i2v 上限约束记 requested）。`/api/recommend` 增 `aesthetics` 字段（题材+参数+光影/色调/镜头/质感建议）。
- **M8 光学预设**：`STYLE_GRADE` 增 8 题材 grade（sunset/nightneon/snow/guofeng/window/retro/sea/noir），`buildFilmicCube(grade,…)` 按题材落 filmic+halation+颗粒+暗角；`gradePreset.theme` 留痕。
- **M9 声音情绪**：`ambientBedFor(grade)` 按题材配环境声床（noise 色/低通/pad 频率）。
- **M6 审美闸附加**：VL 增 `lightUnified/colorUnified/textureOk/whitespaceOk/motionRestraint`（光影统一/色调统一/质感在线/竖屏留白/运动克制），并入 aestheticScore。
- **前端**：向导第二步「氛围题材」下拉（8 题材+无），选中套用配方并把比例设为题材建议(9:16，用户可覆盖)；替代口径区展示配方/参数请求口径。`GET /api/aesthetics` + 构建期内联 `__AESTH`（file:// 可用）。
- **诚实边界**：内置的是高赞氛围片共性套路，把素材推到当前模型上限附近；突破不了模型档位（逐帧细节/真人皮肤/复杂动作/4K）；审美主观可微调；不本地跑超分插帧 ML。

### 11.6 参数校验与稳定性加固（P0：杜绝非法分辨率提交云端）

- **分辨率白名单+自动映射**（`ds.js`）：`VIDEO_SIZE_WHITELIST` = wan2.2 实测 8 档（1080*1920/1920*1080/1440*1440/1632*1248/1248*1632/480*832/832*480/624*624）；`LOCAL_IMAGE_SIZES` 仅本地 ComfyUI 用、禁传云端。`mapVideoSize({ratio,res,device})` 按画幅×档位直配，非直配比例(2:3/3:2/2.35:1)按 aspect 就近映射；`res=720p` 或 `device=T0-low` 降低清档；映射记 `DS_SIZE_MAPPED`（原始→映射→档位）。**旧 SIZE_720/SIZE_1080 表含非法值(1280*720/1648*1248)已废**——此即截图 DS_TASK_FAILED 根因。
- **提交前 dry-run 预检**：`validateDsRequest(request,model)` 查 size 白名单/模型注册/必填 prompt/size/duration 区间；`POST /api/jobs`（dashscope 非 cine）入队前预检 + 手动 `ex.resolution` raw 区间检查，非法 → 400 `DS_PRECHECK_FAILED` + `detail.fields[{key,got,legal}]`，**不入队不打云端**；provider run 内再预检一次兜底。
- **图像/视频分辨率解耦**：关键帧用本地图表；i2v 只收 img_url+resolution（画幅跟随首帧），不把图像分辨率串塞视频请求；post `aspectCrop` 中心裁到目标比例保证无拉伸。
- **手动覆盖保护**：前端预检失败红色 banner 列非法项+合法取值并阻止提交；失败态渲染中文可操作建议（`CN` 码表）+ `error.hint`；既有黄色覆盖条+「恢复推荐值」保留。
- **错误兜底**：size 非法云端失败 → hint 给映射档位+「从失败步重试」（**已提交不自动重投防重复计费**）；额度/限流 → hint 切本机 ComfyUI，不可达则「无可用视频通道」不出假视频；mock 与真实链路分离（mock 标占位）。
- **显存档位联动**：T0-low → 低清档；engine.degrade 既有降档保留。
- **留痕**：dsRequest 记映射；作品/任务记原始+映射参数、模型链、重试、失败原因；Muse 分标 provenance estimate/measured。
### 11.7 显存真值探测（卡 ④ · `/api/devices` 不再只是静态表）

以前 `/api/devices` 把 `spec/models.catalog.json` 的 7 档静态表直接当「本机」返回——换机器、拔 eGPU、桌面进程吃掉 1~2G 时档位都不会变，等于替用户猜。现在拆成**两层，永不混写**：

- **静态层 `devices[]`**：仍然是 catalog 的 7 档 + 纯函数估算（`AVP.estimate`），口径不变、selftest 断言不变。
- **真值层 `probe`**：`server/gpu.js` 起一次 `nvidia-smi --query-gpu=name,memory.total,memory.used,compute_cap,driver_version --format=csv,noheader,nounits`（4s 超时，失败不 throw），给出 `{ok, at, source, gpu, free_mib, usable_mib, provenance, tier_suggestion, tier_confirmed:false, enough_for, detail}`。

**三条诚实边界**：

1. `usable_mib = total - used - 512(预留)`，只有真采到 `memory.used` 才标 `provenance:'measured'`；采不到 → `usable_mib:null` + `'estimate'`；探测失败 → `ok:false` + `reason`（`NVIDIA_SMI_MISSING` / `TIMEOUT` / `NVIDIA_SMI_FAILED` / `PARSE_FAILED`），**不编 gpu、不编档位**。
2. 档位只「建议」不改写：`tier_suggestion` 按 total 选装得下的最高档（`tierFor`，跳过 `T0-low` 这种占用态档），`tier_confirmed:false` 等用户确认；`enough_for[]` 列出当前可用显存装得下的档。
3. 探测结果**不进** `devicesCache`（显存是活的）：probe 自己 15s TTL，`GET /api/devices?fresh=1` 强制重采样；`GET /api/health` 增 `gpu:{ok,name,total_mib,usable_mib,provenance,reason,at}` 便于一眼看出「有没有探测到」。

**本机实测（2026-11-18，见 `docs/state/device-probe-2026-11-18.json`）**：`NVIDIA GeForce RTX 5060 Laptop GPU / 8151MiB / cc 12.0 / 驱动 576.80`；采样时 `used=4754MiB` → `free=3397MiB` → `usable=2885MiB`（桌面进程占着近 4.7G，所以除 `T0-low` 外没有档装得下，`enough_for:[]` 就是真话，不是没算）。selftest 侧新增 11 条断言：CSV 解析、`tierFor` 选档/缺输入返回 null、provenance 三态，以及**假探针模拟「没有 GPU 的机器」时接口必须 `ok:false` + `reason` 且仍返回 7 档目录**。
