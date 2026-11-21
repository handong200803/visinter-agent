# 14 · 小白模式（5 步引导）

> 入口：`wizard/index.html`（构建产物）· 源件 `wizard/index.src.html`
> 面向：**完全不懂 AI 的人**。目标是把「打开网站 → 拿到一条视频」压进 1 分钟、5 个动作以内。
> 与专业模式的关系：不是替代，是前置。`app/index.html`（258 参数工作台）保留，小白页侧栏有「专业模式」入口，专业页顶栏有「小白模式」入口。

---

## 1. 五步流程（一屏一件事）

| 步 | 屏幕 | 用户要做的 | 系统自动做的 | 关键实现 |
|---|---|---|---|---|
| 1 | `#screen-1` | 点一张风格卡 | 高亮银灰发光 → 280ms 后自动进第二步 | `selectStyle()` + `go(2)` |
| 2 | `#screen-2` | 写一句人话（或点示例） | 输入框自动聚焦，placeholder = 该风格示例，示例 chip 一点即填 | `enterPrompt()` / `renderChips()` |
| 3 | `#screen-3` | **什么都不用做** | 五阶段进度 + 环形百分比 + 计时 + 轮播小提示；后端在线时并行提交任务 | `startProgress()` / `paintProgress()` |
| 4 | `#screen-4` | 看（可选：保存 / 换一版 / 手动调整） | 自动播放循环；生成即自动入库；换一版换种子 | `enterPreview()` / `generate()` |
| 5 | `#screen-5` | 点一个作品 | 重播 · 复用这个风格 · 下载 · 删除 | `renderLibrary()` / `reuseStyle()` |

**为什么不设「下一步」按钮**：小白的失败点不在「不会点下一步」，而在「不确定自己点对了没有」。选风格这个动作本身就是完成信号，再让他找一个按钮是多一次判断。

**为什么输入框支持裸回车生成**：真实用户不会按 `Shift+Enter` 换行，`Enter` 直接生成 + `Ctrl+Enter` 同效，是在替他们做决定；换行需求在这个场景不存在（一句话）。

---

## 2. 七个风格（唯一真相源 `wizard/styles.js`）

| id | 名字 | 副标（一个词级别，不是定义句） | 画面语言 |
|---|---|---|---|
| `cinematic` | 电影感 | 宽银幕 · 逆光 | 上下黑边、暖金逆光、公路尘土 |
| `photo` | 写实摄影 | 真实光线 · 街景 | 灰蓝玻璃幕墙、浅景深深景光点 |
| `anime` | 二次元 | 动画 · 清透 | 天蓝粉天空、云、樱花、星芒 |
| `guofeng` | 国风古风 | 水墨 · 留白 | 宣纸底、水墨远山、红日、孤舟 |
| `cyberpunk` | 赛博朋克 | 霓虹 · 雨夜 | 紫品红招牌、雨丝、湿地面、扫描线 |
| `dark` | 暗黑电影 | 低调光 · 悬念 | 黑蓝、烛光暖点、冷窗光、强暗角 |
| `fantasy` | 梦幻仙气 | 云雾 · 光尘 | 粉紫云雾、光尘上升、飘带、尖塔 |

- 缩略图是**内联 SVG 字符串**，不是图片文件：`file://` 双击直接可见，零请求，也不会图裂。
- 每个风格带 3 句示例（人话，禁术语），第一句同时是第二步输入框的 placeholder。
- 卡片**不写风格定义**，只写名字 + 副标：看画面就懂，解释反而是噪音。

---

## 3. 数据与文件

```
wizard/
├─ index.src.html    结构源件（五屏 + 内联标记）
├─ index.html        构建产物（双击可用，勿手改）
├─ theme.css         暗黑玻璃拟态（#08080a + 两团冷光 + 16px + blur20 + 银灰发光选中）
├─ styles.js         7 风格 / 5 阶段文案 / TIPS
├─ engine.js         本地出片：Canvas 2D 程序化场景 + MediaRecorder 录 webm
├─ library.js        作品库：IndexedDB（含 localStorage 降级）
├─ onboard.js        首次访问遮罩引导（spotlight + 气泡 + 键盘）
├─ wizard.js         5 步状态机（唯一有全局状态的文件）
└─ selftest.js       Node 侧验收
tools/
├─ build_wizard.mjs  内联构建（--check / --dry）
└─ check_wizard.mjs  静态守门（外链 / 关键 id / 文案 / 体积）
```

构建：`node tools/build_wizard.mjs`（`build_all` 里已登记为 `wizard` 一步）。
校验：`node tools/build_wizard.mjs --check`（产物与源一致）、`node tools/check_wizard.mjs`、`node wizard/selftest.js`。

### 一条作品的记录结构

```js
{
  id: 'w_<base36>', createdAt: 1763...,
  styleId: 'cinematic', styleLabel: '电影感',
  prompt: '雪夜里小木屋亮着灯',
  seed: 731928441,
  params: { aspect:'16:9', profile:'standard', profileLabel:'标准 · 720p', duration:5, fps:24, quality:1 },
  source: 'local' | 'backend',
  jobId: null,
  videoBlob: Blob | null,     // 本地录制的 webm
  videoUrl: null,             // 后端产物 /api/outputs/...
  poster: 'data:image/png;base64,...',
  durationMs: 6000,
  videoOmitted: false
}
```

---

## 4. 出片链路（诚实边界）

```
点「生成视频」
  ├─ 本地引擎（默认，永远可用）: engine.record({styleId,prompt,seed,width,height,ms})
  │     → Canvas 逐帧程序化渲染（风格调色 + 关键词影响粒子/光线 + 缓推运镜）
  │     → captureStream(30) + MediaRecorder → webm Blob + poster
  └─ 后端（在线时并行）: POST /api/jobs → 轮询 /api/jobs/:id
        → 成功且有可播产物时，第四步切成「模型出片」，旧本地成片仍留在库里
```

- **本地引擎不是模型**：它按风格调色板与提示词关键词渲染近似画面，用来保证「打开就能出片、不联网也能出片」。
  界面上如实标注「本地演示成片 · webm」；后端真出片时标「模型出片」。这一点不许含糊。
- 后端 mock 时（`server/providers/mock.js`）没有真实文件，`mediaUrlOf()` 拿不到可播地址 → 继续用本地成片，不假装成功。
- 录制失败（浏览器不支持 MediaRecorder）→ 保留实时 Canvas 循环播放，作品库只存参数 + 缩略图，`videoOmitted:true`。

---

## 5. 新手引导（第一次打开）

半透明遮罩 + 高亮圈 + 气泡，三步，可跳过，可键盘 `←/→/Enter/Esc`，跟随 resize/scroll 重新定位：

1. 高亮 `#styles`：「先点一个你喜欢的风格」——点完自动进下一步
2. 高亮侧栏「作品库」：做过的片子自动存在这里
3. 高亮品牌区：就三步，选风格 → 写一句 → 等

标记写入 `localStorage['avp.wizard.onboarded']`，只弹一次；侧栏「怎么用」可强制重看。

---

## 6. 验收

```bash
node tools/build_wizard.mjs        # 构建（内联 6 个源）
node tools/build_wizard.mjs --check# 产物 == 源
node tools/check_wizard.mjs        # 无外链 / 关键 id / 五阶段文案 / 体积
node wizard/selftest.js            # 契约断言（结构 + 状态机 + 产物）
node tools/selftest_all.mjs        # 全平台（含 wizard 四项）
node tools/lint_ui.mjs             # 七页视觉守门（wizard 不在这七页里，独立用 check_wizard）
node tools/e2e.mjs                 # 契约漂移
```

实测（2026-11-17，本机）：`wizard/selftest.js` 全部通过 · `check_wizard.mjs` 通过 · 全平台自检见 `docs/state/`。

---

## 7. 已知边界 / 下一步

1. 本地成片是 **webm（VP9/VP8）**，不是 mp4。要发抖音/视频号需要转码（`ffmpeg -i in.webm -c:v libx264 -pix_fmt yuv420p out.mp4`），可挂到成片流水线的第一步。
2. 一条片只有一个镜头。真正的短剧需要分镜 → 多镜头拼接，属于专业模式 + `video-compose` 的活。
3. 后端在线但注册表 258 参数里 252 个无 `bind`（见 `docs/12-handoff.md`），所以后端链路目前仍是 mock；小白页面不依赖它，这也是把本地引擎做默认的原因。
4. 作品库上限 500 条，超大 blob（>40MB）只存参数不存文件（`videoOmitted`），避免把浏览器配额打满。