# 31 · BYOK 云端视频生成（访客自带 Key）

> 目标：访客在前端填自己的 API Key 就能云端出片；**平台不内置任何 Key**；与本地 ComfyUI、演示模式并存。
> 实现：纯前端模块 `web/byok.src.js`（构建期内联进两页），无服务端改动、无凭据落盘到服务器。

## 1. 能力

| 项 | 实现 |
|---|---|
| 厂商 | `seedance`（火山方舟，已接）/ `wanx`（万相，预留位，调用即返回 `BYOK_NOT_IMPLEMENTED`） |
| 参数 | prompt、首帧（i2v）、model、resolution、ratio、duration、seed |
| 流程 | 提交 `POST /api/v3/contents/generations/tasks` → 每 4s 轮询 `GET /tasks/{id}` → 成功取 `content.video_url` |
| 超时 | 最长 10 分钟，超时提示「任务可能仍在云端运行，可用 task id 稍后重查」 |
| 产物 | 存浏览器 **IndexedDB**（`avp_byok/works`），标注 `source=byok / vendor / model / taskId / tokens / 时间` |
| Key 存储 | 仅 `localStorage['avp.byok.v1']`；提供「清除 Key」；不上传、不入包 |

## 2. 参数白名单（越界前端拦）

| 字段 | 规则 | 拦截码 |
|---|---|---|
| model | 必须在厂商 models 白名单 | `BYOK_BAD_MODEL` |
| resolution | `480p` / `720p` | `BYOK_BAD_RESOLUTION` |
| ratio | `16:9` / `9:16` / `1:1` | `BYOK_BAD_RATIO` |
| duration | 2–30 秒 | `BYOK_BAD_DURATION` |
| 厂商未接入 | — | `BYOK_NOT_IMPLEMENTED` |

实测：`4k → BYOK_BAD_RESOLUTION（只允许 480p/720p）`、`99s → BYOK_BAD_DURATION（必须在 2–30 秒）`、`wanx → BYOK_NOT_IMPLEMENTED`。

## 3. 错误分类

| 类别 | 码 | 提示 |
|---|---|---|
| Key 无效 | `BYOK_KEY_INVALID`(401) | 检查是否标准方舟 Key（Plan key 打 `/api/v3` 也 401） |
| 额度/权限 | `BYOK_FORBIDDEN`(403) | 余额或模型开通 |
| 参数非法 | `BYOK_BAD_PARAM`(400) | 检查白名单 |
| 限流 | `BYOK_RATE_LIMIT`(429) | 稍后重试 |
| 超时 | `BYOK_TIMEOUT` | 任务可能仍在云端，可用 task id 重查 |
| **跨域被拦** | `BYOK_CORS` | 填「透传代理地址」后重试 |
| 模型报错 | `BYOK_TASK_FAILED` | 读云端 `error` |
| 未填 Key | `BYOK_NO_KEY` | 按钮本身已置灰 |

## 4. 透传代理（CORS 兜底）

约定：代理接收 `?url=<原始地址>`，只转发不存 Key。

```
无代理：https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks
有代理：https://my-proxy.example/relay?url=https%3A%2F%2Fark.cn-beijing.volces.com%2Fapi%2Fv3%2F...
```

## 5. 链路衔接

- **首帧复用关键帧选优**：`params` 页 BYOK 面板的 `getFirstFrameDataUrl()` 会取「关键帧已选定」的那张（`/api/keyframes/:id/frame/:i`）转 dataURL，按 Seedance 契约 **content 先图后文** 提交，即 i2v；
- 未选关键帧时退化为纯文生视频，界面日志会写「未带首帧」。

## 6. 验收（浏览器实测，2026-11-20）

| 验收项 | 结果 |
|---|---|
| 未填 Key → 云端置灰 | ✅ `genDisabled=true`，提示「未填 Key 时云端生成不可用；本地 ComfyUI 与演示模式不受影响」 |
| 填入 Key → 启用 + 脱敏 | ✅ `Key 已配置 · sk-****7890`，存 `localStorage` |
| 点击生成 → 错误分类 | ✅ 真实请求被火山 **CORS 拦** → 显示「跨域被拦：填『透传代理地址』后重试」 |
| **Key 不回显** | ✅ 日志与 DOM 均无 `FAKE-TEST-KEY`（正则检查 false） |
| 清除 Key | ✅ 按钮回置灰、`localStorage` 为 `null`、输入框清空 |
| 静态包无内置 Key | ✅ 产物正则 `sk-[A-Za-z0-9]{8,}` **0 命中**；`ARK_STD_KEY=` 无赋值 |
| 本地/演示模式不受影响 | ✅ 两页门禁与 lint 全绿；本地出片链路未改动 |

**重要结论（真实行为）**：火山方舟标准端点**不开放 CORS**，所以纯前端直连必被拦——这不是 bug，是设计约束。要真出片必须二者之一：
1. 填一个透传代理（本模块已支持）；
2. 或用 `ark-seedance-video` skill 的 Python/服务端路径。

我们没有内置代理，也不会硬编码 Key——这条边界写在界面上，不隐藏。

## 7. 文件

| 文件 | 作用 |
|---|---|
| `web/byok.src.js` | BYOK 模块（storage/provider/errors/validate/IDB/mount），构建期内联 |
| `web/params.src.html` | 参数页挂载点（首帧取关键帧选优结果） |
| `app/index.src.html` | 外壳出片模态挂载点（纯文生视频） |
| `tools/build_app.mjs` `core/build.mjs` | 占位符 `/*__BYOK__*/` 内联（用函数形态替换，避免 `$'` 被当替换模式） |

## 8. 已知限制

1. `wanx` 只有能力声明，未实现（`BYOK_NOT_IMPLEMENTED`），适配位已留；
2. 产物存 IndexedDB 而非本地磁盘（浏览器安全模型），导出需手动「打开」链接另存；
3. 首帧 i2v 仅 `params` 页可用，外壳页暂不支持（外壳不做关键帧选优）；
4. 平台侧任务表**不记录** BYOK 任务（它不经过后端），可追溯性靠 IndexedDB 的 `taskId`。

## 9. 契约对齐（2026-11-20 按用户给定规格重写）

| 项 | 规格 | 实现 |
|---|---|---|
| 鉴权 | `ARK_API_KEY` → `Authorization: Bearer <key>` | ✓ 面板 placeholder 就是 `ARK_API_KEY`，只存 localStorage |
| 首帧 | `content` 里 `image_url` + **`role=first_frame`**，Blob→data URI | ✓ content[0] 为 image_url（带 role），content[1] 为 text |
| 参数 | model/resolution(**480p·720p·1080p·4k**)/ratio/duration/seed/**camera_fixed**/watermark/**generate_audio** | ✓ 全部映射，白名单校验 |
| 轮询 | 5–10s，最长 **30 分钟** | ✓ 6s 间隔、30min 上限 |
| 状态 | queued/running 继续；**expired**/failed/cancelled 报错 | ✓ `BYOK_TASK_EXPIRED` / `_FAILED` / `_CANCELLED` |
| 取片 | **`content.video_url.url`** | ✓ 兼容嵌套/字符串/顶层三种形态 |
| 落盘 | 拿到 URL **立即下载 Blob 存 IndexedDB**（URL 24h） | ✓ `grabVideo()`，失败时保留 URL 并标 `downloadError` |
| 作品记录 | 来源/模型/taskId/**分辨率/时长/种子** | ✓ 全字段 + `aiLabel`（AI 生成标识） |
| 合规 | 2.x / 2.5 **不支持真人人脸参考图** | ✓ `compliance()` 前置拦截 `BYOK_FACE_REF_BLOCKED` |

### 契约测试（浏览器内 stub fetch，23/23 通过）

```
content[0] 首帧 image_url ✓   role=first_frame ✓   content[1] text ✓
resolution ✓  camera_fixed ✓  generate_audio ✓  seed ✓
Authorization: Bearer ✓  body 无其他密钥字段 ✓
content.video_url.url 解析 ✓  usage tokens ✓
4k 白名单 ✓  duration 越界拦 ✓  未知模型拦 ✓
2.0+首帧 合规拦截 ✓  mini+首帧 允许 ✓
401/403/400/CORS 分类 ✓  代理 URL ✓  expired 终止表 ✓  无 Key 拒绝 ✓
```
