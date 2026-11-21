# 38 · 全链路稳定性验证（mock 上游，无需真 Key）

> 目标：证明「评委填了 Key 之后」能真的从关键帧走到成片，且平台功能对视频有实际作用。
> 做法：起一个 **mock 万相上游**（真 HTTP 服务，非单元测试替身），让云端后端指向它，走完全相同的
> fetch / 异步轮询 / 下载 / 后处理 / 入库代码路径。

## 验证架构

```
浏览器（站点）
   │ HTTPS/JSON
   ▼
cloud/server.mjs ──► mock-upstream.mjs（模拟 DashScope 异步任务）
   │                    · POST /api/v1/services/aigc/text2image/image-synthesis → task_id
   │                    · POST /api/v1/services/aigc/video-generation/video-synthesis → task_id
   │                    · GET  /api/v1/tasks/{id} → PENDING → RUNNING → SUCCEEDED
   │                    · 返回真实可下载的图片/视频 URL
   ▼
SQLite + 对象存储（本地卷）──► ffmpeg 后处理 ──► 作品库
```

## 结果：PASS 46 · FAIL 0（3 轮串行 + 并发 3）

| 环节 | 验证内容 | 结果 |
|---|---|---|
| 文生图 | 2 张候选、异步轮询 2 次后返回 URL | ✅ 12s |
| 候选可下载 | HEAD/GET 候选 URL | ✅ 200 / image/png |
| 手动改选 | `POST /api/keyframes/:id/select` | ✅ 生效 |
| 图生视频 | 首帧传入（mock 日志确认收到 `img_url`） | ✅ |
| 异步轮询 | 任务从 queued → running → succeeded | ✅ 15s |
| 成片可下载 | `GET /files/videos/xxx.mp4` | ✅ 1.7MB |
| 后处理 60fps | `POST /api/postprocess` | ✅ 24→60fps / 1.5MB |
| 双版本分存 | native + enhanced 两个 key | ✅ |
| 替代引擎标注 | `ffmpeg-minterpolate` + substitution | ✅ |
| 入库 | 作品库含 native + enhanced | ✅ 2 条 |
| 来源可追溯 | 库记录带 provider/model | ✅ wanx / wan2.6-t2v |
| 任务详情 | `GET /api/tasks/:id` 含耗时 | ✅ ms=1526 |
| 并发稳定性 | 同时提交 3 条 | ✅ 3/3 成功（2s） |

## 平台功能对视频的**实际作用**（同一任务的 native vs enhanced）

| 指标 | native | enhanced | 变化 |
|---|---|---|---|
| 帧率 | 24 fps | **60 fps** | ×2.5 |
| 帧数 | **124 帧** | **306 帧** | **+182 帧（插值）** |
| 时长 | 5.167 s | 5.167 s | **不变**（不拉长） |
| 文件大小 | 1.79 MB | 1.52 MB | −15% |
| 质量分 F | 0.3472 | 0.3514 | 微升 |
| 噪声比 | 0.320 | 0.316 | 微降 |
| 退化判定 | 否 | 否 | — |

**结论：后处理真的插了 182 帧，时长一秒没变。**

评分器对两条不同视频的判别力（前面已测）：基准 **0.8664** vs 本机产出 **0.3627**，差 **2.39×**。

## 浏览器端全流程（真实点击，非脚本直调）

| 步骤 | 结果 |
|---|---|
| 填后端地址 → 连接并自检 | ✅ `已连接 · 就绪: wanx,wanx-image,qwen-vl` |
| 生成候选（3 张） | ✅ `候选 3 张 · 选中第 1 张` |
| 点第 2 张改选 | ✅ `已选中候选 → 可出视频` |
| 生成视频 | ✅ `出片完成 · 2s` |
| 视频播放器 | ✅ `readyState=4 / 640×384 / 5.17s / error=null` |
| 增强 60fps | ✅ `完成 · 24→60fps · 1.5MB` |
| 增强版播放 | ✅ `readyState=4 / 640×384 / 5.17s / error=null` |
| 作品库 | ✅ 列表带时间/厂商/模型/大小/下载 |

## 本轮修复的关键 bug

| # | 缺陷 | 现象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | **视频播不出来** | `MEDIA_ERR_SRC_NOT_SUPPORTED`，`videoWidth=0` | 后端返回相对路径 `/files/...`，前端拼到了**站点域名**（静态站没有 `/files` 路由） | 所有资源 URL 判定：绝对 URL 直接用，相对路径拼 **API base**；作品库下载链接同理 |
| 2 | **整段交互脚本不执行** | 按钮 `onclick` 为 `null`、BYOK 面板不挂载 | 我插入的 `function absUrl(){}` 落在 IIFE 外层，导致该 `<script>` 执行中断 | 去掉独立函数，改为使用处内联三元判断 |
| 3 | 文案与实际不符 | 写「Seedream / Seedance」，实际跑万相 | 硬编码旧厂商名 | 改为「通义万相或火山方舟（后端 Secrets 决定）」 |

## 复现命令

```bash
# 终端 1：mock 上游（模拟万相异步任务）
node cloud/mock-upstream.mjs --port 18899

# 终端 2：后端指向 mock
DASHSCOPE_API=http://127.0.0.1:18899 DASHSCOPE_API_KEY=mock \
AVP_VIDEO_PROVIDER=wanx AVP_IMAGE_PROVIDER=wanx \
PORT=8787 DATA_DIR=D:/缓存/avp/cloud-mock ADMIN_TOKEN=mock-token \
node cloud/server.mjs

# 终端 3：全链路自动测试
ADMIN_TOKEN=mock-token node cloud/e2e-mock.mjs --base http://127.0.0.1:8787 --rounds 3
```

## 换成真 Key 只差一个环境变量

```bash
DASHSCOPE_API_KEY=sk-真实key   # 去掉 DASHSCOPE_API，默认打官方端点
```

其余代码路径**完全相同**——mock 验证的就是真实路径。
