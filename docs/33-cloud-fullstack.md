# 33 · 全功能线上版（前端 Sites + 独立云端后端）

> 目标：评委打公开链接就能走 **关键帧 → 选优 → 视频 → 后处理 → 入库**，不需要本地环境。
> 现状：后端已写好并在本地跑通（`cloud/`，零第三方依赖）；前端站点已接后端客户端；**差你把后端部署上线并填 Key**。

## 1. 架构

```
Qoder Sites（静态）                     云端后端（Render/Fly/Docker）
┌─────────────────────┐              ┌──────────────────────────────┐
│ index.html          │  HTTPS/JSON  │ cloud/server.mjs (Node 22)   │
│  ├ 展示层（成片/图） │ ───────────► │  ├ /api/keyframes  生图+选优  │
│  ├ 在线控制台        │              │  ├ /api/video      Seedance   │
│  └ BYOK（直连兜底）  │              │  ├ /api/tasks      状态机     │
└─────────────────────┘              │  ├ /api/scores     四维打分   │
                                     │  ├ /api/experiments /optimize │
                                     │  └ /api/library    作品库     │
                                     ├──────────────────────────────┤
                                     │ SQLite(node:sqlite) 或 PG     │
                                     │ 对象存储：本地卷 或 S3/R2      │
                                     └──────────┬───────────────────┘
                                                │ Bearer <后端 Secrets 里的 Key>
                                     ┌──────────▼───────────────────┐
                                     │ 火山方舟 Seedance / Seedream  │
                                     │ 通义 Qwen-VL（可选语义打分）   │
                                     └──────────────────────────────┘
```

**Key 只在后端**：浏览器拿不到、也发不出。BYOK 那条路是「访客自带 Key 直连方舟」，与后端 Secrets 完全独立。

## 2. 文件

| 文件 | 作用 |
|---|---|
| `cloud/core.mjs` | 状态机、统一错误码、SQLite 存储、对象存储（本地卷 / S3 SigV4 手写） |
| `cloud/providers.mjs` | 统一 provider：`submitTask/pollTask/fetchResult`；Seedance 视频、Seedream 生图、Qwen-VL 打分 |
| `cloud/scoring.mjs` | 四维打分（Sface/Ssharp/Sstyle/Scomp − Sbad·w），语义可用时按 0.6/0.4 融合 |
| `cloud/server.mjs` | HTTP 路由 + 任务驱动（内存轮询）+ 配额 |
| `cloud/.env.example` | 全部环境变量 |
| `cloud/Dockerfile` / `cloud/render.yaml` | 一键部署 |
| `web/cloud-client.src.js` | 前端唯一通道（baseUrl 可配，无硬编码） |

## 3. 接口清单

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 存活 + 存储后端 + 在飞任务数 |
| GET | `/api/config` | provider 就绪状态、模型/分辨率/比例白名单、配额、权重、状态枚举 |
| POST | `/api/keyframes` | 生成 N 张候选（生图），返回候选 URL + 选中项 |
| GET | `/api/keyframes/:id` | 候选与选中 |
| POST | `/api/keyframes/:id/select` | 手动改选 `{index}` |
| POST | `/api/video` | 提交视频（可带 `first_frame` URL/DATA_URI）→ `taskId` |
| GET | `/api/video/:id` | 视频任务状态（queued/running/succeeded/failed/expired/cancelled） |
| GET | `/api/tasks` `?state=&kind=&limit=` | 任务列表 |
| GET | `/api/tasks/:id` | 任务详情 |
| POST | `/api/tasks/:id/retry` | 失败重试（状态机校验） |
| POST | `/api/scores` | 打分（`{gray,w,h,prompt}` 或 `{imageUrl}`） |
| GET | `/api/scores/:taskId` | 取分数 |
| POST/GET | `/api/experiments` | 对照实验记录（写需 `ADMIN_TOKEN`） |
| POST | `/api/optimize` | 贝叶斯寻优一轮（需 admin） |
| GET | `/api/library` | 作品库（跨设备） |
| GET | `/files/:key` | 对象流（本地卷后端） |

**统一错误码**：`BAD_REQUEST / UNAUTHORIZED / NOT_FOUND / RATE_LIMIT / QUOTA / PROVIDER_MISSING / UPSTREAM_KEY_INVALID / UPSTREAM_FORBIDDEN / UPSTREAM_BAD_PARAM / UPSTREAM_TIMEOUT / UPSTREAM_FAILED / STATE_INVALID`。前端按 code 分档提示，与本地版语义一致。

**状态机**：`queued → submitting → running → postprocessing → succeeded`，异常分支 `failed / expired / cancelled`；`failed|expired|cancelled` 可回 `queued` 重试，其余非法转移返回 `STATE_INVALID`。

## 4. 部署（选一条）

### A. Render（最省事）
1. 仓库推到 GitHub → Render → New → Blueprint → 选 `cloud/render.yaml`
2. 填 `ARK_API_KEY`、`ALLOW_ORIGIN`（你的 qodersite 域名）
3. 首次部署自动挂 1GB 持久盘到 `/data`（SQLite + 对象都在里面）

### B. 任意 Docker 主机
```bash
docker build -f cloud/Dockerfile -t avp-cloud .
docker run -d -p 8787:8787 -v avpdata:/data \
  -e ALLOW_ORIGIN=https://your-site.qodersite.com \
  -e ARK_API_KEY=*** -e ADMIN_TOKEN=*** avp-cloud
```

### C. 本地先验证
```bash
PORT=8787 DATA_DIR=D:/缓存/avp/cloud-data node cloud/server.mjs
curl http://127.0.0.1:8787/api/health
```

## 5. 前端接入

站点「⑤ 在线全功能」里填后端地址 → 点「连接并自检」，会显示 `providers=seedance✓ ark-image✓ qwen-vl✗` 这类状态。
想让它默认连上（评委不用填）：

```bash
# 构建时注入
AVP_API_BASE=https://your-backend.onrender.com node tools/build_site.mjs
```

或在 `build_site.mjs` 的 `<script>` 前加一行 `window.__AVP_API_BASE__='https://…'`。

## 6. 验收对照

| 验收项 | 状态 | 证据 |
|---|---|---|
| 公开链接无需本地环境走通 关键帧→选优→视频→后处理→入库 | ⏳ 差后端上线 + Key | 后端全链路本地已通（打分 0.4735 实测、错误码 PROVIDER_MISSING 正确）；前端控制台已连上并自检 |
| 寻优/对照/消融出真实数据图表 | ⏳ | `/api/experiments` `/api/optimize` 已实现；图表渲染待接（可复用 `assets/figures/`） |
| 作品跨设备可查可下载 | ✅ 结构就绪 | `/api/library` + `/files/:key` 或 S3 公网地址；本地实测库接口返回正常 |
| Key 仅在后端 | ✅ | 站点正则 `sk-[A-Za-z0-9]{8,}` **0 命中**；前端无硬编码主机（`127.0.0.1`/`:8418`/`:8188` 全 0） |
| 本地离线版保留不随站点发布 | ✅ | 站点包只含 `index.html + assets + preview/`，不含 `server/`、`cloud/`、模型或私人产物 |

## 7. 成本与风控

- **Seedance 按成功计费**（约 ¥0.5/秒，mini 720p 刊例）；`DEMO_QUOTA=20` 是每 IP 每日上限，评委场景建议 10–20 次。
- 失败/审核不过不计费，但**排队中的任务会占额度**，必要时 `DELETE /api/v3/contents/generations/tasks/{id}` 取消。
- 对象存储：本地卷最省；切 R2 时把 `S3_PUBLIC_BASE` 指向公开域名即可让作品跨设备直接播放。

## 8. 还没做的两件

1. **部署**：需要你的 Render/Docker 账号 + `ARK_API_KEY`（我无法替你注册、也不该拿你的 Key）。
2. **图表渲染**：`/api/experiments` 已有数据接口，前端图表还没接（可以把 `assets/figures/` 里的 SVG 换成动态渲染）；这属于展示层，不影响功能链路。

## 9. 后处理（2026-11-21 补齐）

本地版用 RIFE；云端容器不带 torch，改用 **ffmpeg minterpolate**（运动补偿 mci + aobmc + vsbmc）。

| 项 | 值 |
|---|---|
| 接口 | `POST /api/postprocess {taskId, targetFps}` / `GET /api/postprocess/capability` |
| 实测 | 5.17s·640×384 片：**11 秒**完成 24→60fps，产物 1.45MB |
| 引擎标注 | `engine: ffmpeg-minterpolate`，`substitution: ffmpeg minterpolate（非 RIFE）` 写入作品 meta |
| 优先 RIFE | 设 `AVP_RIFE_PY` + `AVP_RIFE_MODEL` 即自动切 RIFE（容器装了 python+torch 时） |
| 双版本分存 | `videos/<taskId>-native.mp4`（仅打分） / `videos/<taskId>-enhanced.mp4`（仅展示） |

**踩坑**：输出路径不能写源目录（云盘成片目录 EACCES），也不能写 `os.tmpdir()`（同样被拒）；统一落 `DATA_DIR/tmp`。

## 10. 前端图表（2026-11-21 补齐）

站点「⑤ 在线全功能」新增：
- **增强 60fps 按钮**：出片后出现，调 `/api/postprocess`，显示 `24→60fps · 1.5MB · engine`
- **实验/寻优图表**：`GET /api/experiments` → 零依赖 SVG 柱状图 + 明细行（实测渲染 2 条：ablation total 0.62 / bayes 待回填）

## 11. 接入通义万相（2026-11-21）

同一把 `DASHSCOPE_API_KEY` 同时支持三件事：**万相出视频、万相出图、Qwen-VL 语义打分**。

| provider | id | 模型 | 端点 |
|---|---|---|---|
| 视频 | `wanx` | `wan2.2-t2v-plus` / `wan2.2-i2v-plus` | `POST /api/v1/services/aigc/video-generation/video-synthesis` |
| 图片 | `wanx-image` | `wan2.2-t2i-flash` / `wan2.5-t2i-preview` | `POST /api/v1/services/aigc/text2image/image-synthesis` |
| 打分 | `qwen-vl` | `qwen-vl-max` | 兼容模式 `/chat/completions` |

**必须带 `X-DashScope-Async: enable`**（所有视频/图像模型仅支持异步），否则直接报错。

状态映射：`PENDING→queued`、`RUNNING→running`、`SUCCEEDED→succeeded`、`FAILED→failed`、`CANCELED→cancelled`、`UNKNOWN→expired`。

**provider 优先级**：`AVP_VIDEO_PROVIDER=wanx,seedance` —— 谁有 Key 先用谁，两家都配则万相优先。

### 成本对比（官方刊例）

| 方案 | 480P | 720P | 1080P |
|---|---|---|---|
| 通义万相 | **¥0.14/秒**（5s≈¥0.7） | — | ¥0.7/秒（5s≈¥3.5） |
| Seedance mini | 约 ¥0.5/秒 | 约 ¥0.5/秒 | 更高 |
| 本机 H3（8G） | 免费 | 免费 | 跑不动 |

**结论：演示用万相 480P，出片成本比 Seedance 低 3–4 倍；要视觉冲击再上 1080P（5s≈¥3.5）。**
