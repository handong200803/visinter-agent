# DEPLOY · 从零部署 VisInter-Agent

> 这份文档的目标：**一个没参与开发的人，照着做就能把平台跑起来。**
> 分三部分，按需选：云端后端（最常用）、前端站点、本地生成版（重度，可选）。

---

## 0. 先搞清楚你要部署哪部分

| 部分 | 作用 | 难度 | 前置 |
|---|---|---|---|
| **云端后端** `cloud/` | 生成视频 / 打分 / 作品库 / 实验 | ⭐ 简单 | Node 22 + ffmpeg + 一把 API Key |
| **前端站点** `qoder-site/` | 评委打开看的页面 | ⭐ 简单 | 一个静态托管 |
| **本地生成版** `server/` | 用本机显卡跑 H3/Wan | ⭐⭐⭐⭐ 重度 | 42GB 权重 + 8G 显存 + ComfyUI |

**只想让别人能打开、能出片 → 只做前两部分。**

---

## 1. 云端后端

### 1.1 依赖

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | **≥ 22**（用到内置 `node:sqlite`） | `node -v` |
| ffmpeg | 任意版本（后处理插帧用） | `ffmpeg -version` |

**没有任何 npm 依赖** —— 这个项目刻意不用 package.json / node_modules。

### 1.2 拿一把 API Key

本项目支持三个平台，**任选其一**：

| 平台 | 环境变量 | 可用模型 | 说明 |
|---|---|---|---|
| **通义万相（推荐）** | `DASHSCOPE_API_KEY` | `wan2.6-t2v` / `wan2.2-t2v-plus` | 便宜（480P 约 ¥0.14/秒） |
| 火山方舟 | `ARK_API_KEY` | `doubao-seedance-*` | 画质强但贵 |
| Qwen-VL | `DASHSCOPE_API_KEY` | `qwen-vl-max` | 只用于语义打分 |

> **注意**：如果你的 Key 来自「千问AI平台」（`sk-ws-` 开头），端点是
> `https://cn-beijing.maas.qianwenaiapi.com`，不是阿里云百炼主站。
> 用错端点会返回 `InvalidParameter`。

### 1.3 启动（三种方式任选）

#### 方式 A：直接跑（最快，适合本机测试）

```bash
git clone https://github.com/handong200803/visinter-agent.git
cd visinter-agent

DASHSCOPE_API_KEY=sk-你的key \
DASHSCOPE_API=https://cn-beijing.maas.qianwenaiapi.com \
AVP_VIDEO_PROVIDER=wanx \
AVP_IMAGE_PROVIDER=wanx \
ADMIN_TOKEN=自己定一个长字符串 \
PORT=8787 \
node cloud/server.mjs
```

看到这行就成功了：

```
[avp-cloud] listening :8787
[avp-cloud] providers: seedance✗ wanx✓ ark-image✗ wanx-image✓ qwen-vl✓
```

#### 方式 B：Docker

```bash
docker build -f cloud/Dockerfile -t avp-cloud .
docker run -d --name avp -p 8787:8787 -v avpdata:/data \
  -e DASHSCOPE_API_KEY=sk-你的key \
  -e DASHSCOPE_API=https://cn-beijing.maas.qianwenaiapi.com \
  -e AVP_VIDEO_PROVIDER=wanx \
  -e ADMIN_TOKEN=自己定一个长字符串 \
  avp-cloud
```

#### 方式 C：云服务器（阿里云 ECS / 腾讯云 / 任意 VPS）

```bash
# 1. 装环境（Ubuntu）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs ffmpeg unzip git

# 2. 部署（仓库自带脚本）
cd /opt && git clone https://github.com/handong200803/visinter-agent.git avp
cd avp
sudo cp tools/deploy-ecs.sh /root/ && sudo bash /root/deploy-ecs.sh

# 3. 放行端口（云控制台安全组也要加）
sudo ufw allow 8787/tcp
```

脚本会做：装依赖 → 配 **systemd 开机自启** → 起服务 → 输出公网地址。
日志：`tail -f /var/log/avp-cloud.log`

### 1.4 全部环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DASHSCOPE_API_KEY` | 万相/Qwen 必填 | — | 通义万相 + Qwen-VL（同一把） |
| `DASHSCOPE_API` | 否 | `https://dashscope.aliyuncs.com` | 千问AI平台用 `https://cn-beijing.maas.qianwenaiapi.com` |
| `ARK_API_KEY` | 火山必填 | — | 火山方舟标准 Key |
| `ADMIN_TOKEN` | **强烈建议** | 空=不校验 | 实验/寻优写接口的令牌 |
| `ALLOW_ORIGIN` | **建议** | `*` | 填你的站点域名，否则浏览器 CORS 报错 |
| `DATA_DIR` | 建议 | `./data` | SQLite + 视频存放目录 |
| `PORT` | 否 | `8787` | |
| `DEMO_QUOTA` | 否 | `20` | 每 IP 每日生成次数上限（0=不限） |
| `AVP_VIDEO_PROVIDER` | 否 | `wanx,seedance` | 逗号分隔，先 ready 先用 |
| `AVP_IMAGE_PROVIDER` | 否 | `wanx,ark` | |
| `WANX_VIDEO_MODEL` | 否 | `wan2.6-t2v` | |
| `S3_BUCKET`/`S3_ENDPOINT`/`S3_KEY`/`S3_SECRET` | 否 | 不填=本地盘 | 切对象存储（R2/B2/MinIO） |

### 1.5 验证部署成功

```bash
# 本地
curl http://127.0.0.1:8787/api/health

# 自检（12 项，期望 PASS 10 以上；seedance/ark-image 没配 Key 属正常）
node cloud/smoke.mjs http://127.0.0.1:8787 --admin 你的ADMIN_TOKEN

# 全链路（15 项，不需要真 Key，用 mock 上游）
node cloud/selftest.mjs --src "任意一条 mp4"
```

**`/api/config` 里 `wanx:true` 就说明生成能力已就绪。**

### 1.6 出一段真视频（花约 ¥2）

```bash
B=http://127.0.0.1:8787

# 提交
curl -X POST $B/api/video -H "Content-Type: application/json" \
  -d '{"prompt":"黄昏海边，浪花拍打礁石，镜头缓慢横移","resolution":"1080p","ratio":"16:9","duration":5}'
# → {"id":"tk_xxx","state":"running"}

# 轮询（15-30 秒）
curl $B/api/video/tk_xxx

# 后处理 60fps
curl -X POST $B/api/postprocess -H "Content-Type: application/json" \
  -d '{"taskId":"tk_xxx","targetFps":60}'

# 作品库
curl $B/api/library?limit=5
```

---

## 2. 前端站点

### 2.1 构建

```bash
# 注入你的后端地址（关键：不注入的话前端连不上）
node tools/publish_site.mjs https://你的后端地址

# 产物：%CLOUD_ROOT%/03-文档/qoder-site.zip
```

`publish_site` 会做 4 项体检：入口在根 / 已写入地址 / **无内置 Key** / 无本机硬编码。

### 2.2 上传

1. 解压 zip
2. 任意静态托管：Qoder Sites / GitHub Pages / Vercel / 阿里云 OSS / Nginx
3. **`index.html` 必须在根目录**

### 2.3 回填域名（否则 CORS 失败）

```bash
# 后端那边
export ALLOW_ORIGIN=https://你的站点域名
# 重启服务
```

---

## 3. 本地生成版（重度，可选）

**只有你需要用本机显卡跑 MiniMax H3 / Wan2.2 时才做这步。**

### 3.1 前置

| 项 | 要求 |
|---|---|
| 显存 | ≥8G（640×384）；720p 需 12G+；1080p 需 22G+ |
| 磁盘 | ≥100GB（H3 权重 42GB + Kolors 22GB + 中间产物） |
| ComfyUI | 需自行安装（本项目只调它的 HTTP API） |

### 3.2 路径配置

本地版所有路径都走环境变量，**默认值是我开发机的路径**，必须覆盖：

```bash
export CLOUD_ROOT=/your/cloud/root      # 原默认 D:\云盘
export CACHE_ROOT=/your/cache/root      # 原默认 D:\缓存
export COMFY_OUTPUT_DIR=/your/comfy/output
```

### 3.3 启动

```bash
# 1. 起 ComfyUI（8188）
bash tools/comfy_start.sh

# 2. 起平台后端
PORT=8418 node tools/serve.mjs

# 3. 打开
# http://127.0.0.1:8418/app/index.html
```

### 3.4 门禁自检

```bash
node tools/selftest_all.mjs   # 期望 PASS 18 · FAIL 0
node tools/lint_ui.mjs        # 9 页
```

> 本地版的 `selftest_all` 里有模块会起/停本地服务，冷启动偶尔需要重试（运行器已内置 3 次机会）。

---

## 4. 常见问题

| 现象 | 原因 | 解法 |
|---|---|---|
| `Cannot find module 'node:sqlite'` | Node < 22 | 升级 Node |
| `PROVIDER_MISSING` | 没配 Key | 设 `DASHSCOPE_API_KEY` 或 `ARK_API_KEY` |
| `UPSTREAM_KEY_INVALID` | Key 错或端点错 | 千问AI平台的 Key 要用 `DASHSCOPE_API=...qianwenaiapi.com` |
| `AccessDenied.Unpurchased` | 模型未开通 | 控制台开通，或换 `wan2.6-t2v`/`wan2.2-t2v-plus` |
| 浏览器报 CORS | `ALLOW_ORIGIN` 没填对 | 填完整域名（带 `https://`，不带末尾 `/`） |
| 后处理报 `PROVIDER_MISSING` | 没装 ffmpeg | `apt install ffmpeg` |
| 视频播放 404 | 前端把相对路径拼到站点域名 | 用 `tools/publish_site.mjs` 重新构建（已修正） |
| `node tools/serve.mjs` 起不来 | 端口占用 | 换 `PORT=84xx` |

---

## 5. 部署清单（照打勾）

- [ ] Node ≥22 与 ffmpeg 已装
- [ ] API Key 已获取，端点已确认
- [ ] `ADMIN_TOKEN` 已设（长随机串）
- [ ] 服务能起，`/api/health` 返回 200
- [ ] `/api/config` 里目标 provider 是 `true`
- [ ] `smoke.mjs` PASS ≥10
- [ ] `publish_site.mjs` 已注入后端地址，4 项体检全过
- [ ] 站点已上传，`index.html` 在根目录
- [ ] `ALLOW_ORIGIN` 填的是站点真实域名
- [ ] 手机 4G 打开能走通「连接后端 → 生成视频 → 增强 60fps → 作品库」

---

## 6. 一句话

**云端后端零依赖、无硬编码路径，`node cloud/server.mjs` 一条命令就能起。**

本地生成版才是重活——那是给自己机器用的，不是给别人的。
