# 32 · 发布到 Qoder Sites（静态站）

> Qoder 只支持静态前端。所以这里把平台拆成两层交付：
> **静态站**（可公开访问：看成片 / 看证据 / 用访客自己的 Key 调云端）+ **本地完整版**（需自建后端）。

## 1. 产物位置

```
D:\云盘\03-文档\qoder-site\
├── index.html          # 单文件页面（内联 BYOK 模块），36KB
└── assets\
    ├── clips\          # 3 条成片（turbo4 / turbo8 / RIFE-60fps），7.9MB
    ├── keyframes\      # 3 张关键帧候选（含 Top1），968KB
    └── figures\        # 5 张证据图（SVG），24KB
```

总计 **6.0 MB**，直接整个目录上传到 Qoder Sites 即可。

## 2. 页面结构（对齐大赛要求）

| 区块 | 内容 | 对应大赛要求 |
|---|---|---|
| ① 成片演示 | 3 条真机成片，标注参数/耗时/帧率 | 作品是什么 |
| ② 关键帧选优 | 3 张候选 + 五维分数 + Top1 标记 | 怎么做的 |
| ③ 核心发现 | 评分器给噪声更高分的实证（0.6808 vs 0.3544）+ 5 张图 | 想法来源 |
| ④ BYOK 出片 | 访客填自己的 ARK Key 实时出片 | 怎么用 |
| ⑤ 能力边界 | 8G 显存上限、静态站不能做什么 | 诚实交代 |
| ⑥ 本地完整版 | 5 步跑起来的命令 | 复现 |

## 3. 部署步骤

1. 打开 Qoder Sites → 新建站点 → 选「静态站点」
2. 上传整个 `qoder-site` 目录（`index.html` 必须在根）
3. 设为**公开访问**，记录地址（形如 `https://<你的>.qodersite.com`）
4. 用手机 4G 网络打开验证一次（确认不是本地缓存）

## 4. BYOK 要真能用，必须配一个透传代理

**原因**：火山方舟不开放 CORS，浏览器从你的 qodersite 域名直连会被拦（页面会提示「跨域被拦」）。
**方案**：Cloudflare Worker（免费额度足够），代码：

```js
// Cloudflare Worker：只转发方舟生成接口，不落盘、不记日志、不存 Key
const ALLOW_ORIGIN = 'https://<你的>.qodersite.com';   // 换成你的站点域名
const ALLOW_PATH = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/';

export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': ALLOW_ORIGIN,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'authorization,content-type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }
    const target = u.searchParams.get('url');
    if (!target || !target.startsWith(ALLOW_PATH)) return new Response('blocked', { status: 403 });
    const r = await fetch(target, { method: req.method, headers: req.headers, body: req.body });
    const out = new Response(r.body, r);
    out.headers.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    out.headers.set('Access-Control-Allow-Headers', 'authorization,content-type');
    return out;
  },
};
```

部署后拿到形如 `https://avp-ark.<你的>.workers.dev` 的地址，两种用法：

- **让访客自己填**：页面上「透传代理地址」一栏；
- **预置（推荐）**：改 `web/byok.src.js` 里 `DEFAULT_CFG.proxy` 为你的 Worker 地址，重跑 `node tools/build_site.mjs`，访客只需填 Key。

> 安全：Worker 里的 `ALLOW_ORIGIN` 必须写死你的域名，否则任何网站都能借用你的代理。Key 只存在访客浏览器 + 经代理转发，Worker 不落盘。

## 5. 大赛帖子需要的五段（可直接改）

**① 自我介绍**
长春理工大学 25 级 · 经管学院 · 大数据管理与应用。日常在 8GB 显存的笔记本上折腾本地 AI 视频生成，关注「生成结果如何被可靠评估」。

**② 作品是什么（一句话）**
一个跑在本地笔记本上的 AI 视频生成台：双引擎（MiniMax H3 / Wan2.2）+ 关键帧自动选优 + RIFE 60fps，并把每一步的参数、打分、产物都留成可复核的证据链。

**③ 为什么做**
做短视频时最痛的不是"生成不出来"，而是"生成出来了但说不清为什么好/坏"。我给自己的流水线加评分器后发现一个反直觉现象：**按现有质量指标优化，画面会越调越差**——纯噪声片能拿到 0.68 分，真实好片只有 0.35，因为指标把"帧间变化小"当成了稳定。这个发现促使我把平台做成"评估优先"的形态。

**④ 怎么用（评委 5 步内）**
1. 打开作品链接（Qoder Sites）
2. 往下滑到「① 成片演示」，直接播放 3 条真机成片（含 60fps 插帧对比）
3. 到「③ 核心发现」，看那张噪声 0.68 vs 真实 0.35 的对照
4. 到「④ 用你自己的 Key 出片」，填自己的火山方舟 `ARK_API_KEY`（只存你本机浏览器）
5. 点「云端出片」，任务 ID、分辨率、时长、种子会一起记在页面下方

> 若提示「跨域被拦」：把页面上的「透传代理地址」填成部署说明里那个 Worker 地址即可（方舟不开放 CORS，这是云厂商策略）。

**⑤ 用 Qoder 做的过程**
- 交给 Qoder 的部分：静态站页面结构（六个区块的信息架构）、BYOK 面板的交互与表单、错误分类文案、以及把本地跑出的证据图/成片整理成展示序列。
- 我改的部分：**所有生成与评估逻辑都不在 Qoder 里**——双引擎部署、五维评分、退化检测器（320×180 高频采样 + Sobel/块方差/噪声比）、RIFE 接线、七层审计，全部是我在自己机器上用 Node 零依赖手写并真机验证的；Qoder 产出的是"能被评委点开的那一层皮"。
- 截图凭证：建议贴 3 张——① 本地平台出片界面 ② `selftest_all PASS 18` ③ 评分器基准图（坏片 5/5 压过好片）。

## 6. 诚实边界（页面里也写了，帖子里别删）

| 项 | 事实 |
|---|---|
| 显存 | RTX 5060 Laptop **8GB**；720p 需 ≈12.6GB、1080p 需 ≈21.8GB → 本机上限 640×384 / 720×480 |
| 耗时 | turbo 4 步 **2.5 分钟** / 8 步 16 分钟 / 无损 20 步 25 分钟（5.17s 片） |
| 静态站的局限 | 关键帧生成、i2v、任务持久化、作品库都依赖 Node 后端与 42GB 本地权重，**静态托管无法承载**；页面对此明确标注 |
| 已知缺陷 | H3 在低分辨率 i2v 下可能出现文字幻觉或主体平铺，已做参数对照但未根治 |
| 人脸相关 | 2.x/2.5 模型不支持真人人脸参考图，BYOK 面板已前置拦截 |

## 7. 复现命令（本地完整版）

```bash
node tools/selftest_all.mjs                    # 期望 PASS 18 · FAIL 0
bash tools/setup_models.sh h3                  # 约 45GB
bash tools/comfy_start.sh
PORT=8418 node tools/serve.mjs                 # http://127.0.0.1:8418/app/index.html
node tools/t2i_i2v.mjs --prompt "…" --count 4  # 三段链路一条命令
node tools/audit_layers.mjs                    # 七层审计
node tools/scorer_bench.mjs                    # 评分器基准（n=10）
```

## 8. 重新生成站点

内容或素材变了以后：

```bash
node tools/build_site.mjs      # → %CLOUD_ROOT%\03-文档\qoder-site\
```

## 9. 「完整展示」怎么做到（2026-11-21 补）

静态托管放不下后端，但可以把平台拆成三层，评委能看到全部：

| 层 | 内容 | 位置 |
|---|---|---|
| **真机成片** | 3 条 mp4（turbo4 / turbo8 / RIFE 60fps） | `assets/clips/` |
| **可点开的界面副本** | 外壳 / 参数面板 / 科研台 三个真实页面，注入横幅与 `/api/*` 拦截（不报错） | `preview/*.html` |
| **界面截图墙** | 5 张真机截图（工作台、关键帧卡片、258 参数、科研台、出片模态） | `assets/screens/` |

### 预览页注入了什么

1. **顶部横幅**：明确「静态预览，生成与数据需本地后端」；
2. **fetch 拦截**：把 `/api/*` 换成空 JSON 200，避免满屏 404 红字；实测三页 0 报错，分别渲染 24 / 54 / 13 个卡片。

### 还差一段录屏（唯一能把"在跑"拍下来的东西）

把 2–3 分钟录屏命名为 `demo-recording.mp4` 放进 `assets/clips/`，重跑：

```bash
node tools/build_site.mjs        # 自动挂到「④ 平台全貌」顶部
```

录屏脚本（建议按这个顺序录，一镜到底最可信）：
1. `bash comfy_start.sh` 起来 → 浏览器打开 `app/index.html`，展示工作台
2. 进「参数面板」→ 滚到关键帧卡片 → 点「① 生成候选关键帧」→ 等 3–4 分钟出 3 张候选
3. 展示五维分数与 ★Top1 选中 → 点「② 用选中帧生成视频」→ 展示进度与耗时
4. 出片后在「作品库」播放 → 点「增强」出 60fps → 播放对比
5. 最后打开科研台，滚一遍拓扑 / 贝叶斯 / A-B-C 面板

### 重新生成

```bash
node tools/build_preview_pages.mjs   # 刷新 preview/*.html（页面改动后跑）
node tools/build_site.mjs            # 刷新 index.html
```
