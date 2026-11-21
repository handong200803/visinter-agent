# 10 · 参数工作台（`web/params.html`）

> 源件：`web/params.src.html` · 产物：`web/params.html`（`node core/build.mjs` 内联注册表、引擎与 Muse 预设）
> 视觉标准：`docs/09-design-system.md` + `ui/tokens.css`（银雕塑体系 59 令牌）· 守门：`node tools/lint_ui.mjs`
> 数据来源：`spec/params.registry.json`（258 参数 / 7 板块 / 14 条联动规则）+ `spec/muse.presets.json`（三层定义 + 7 个风格预设）+ `spec/model.configs.json`（9 个开源模型配置）
> 推荐后端：`POST /api/recommend`（双轨，见 `docs/02-backend.md` §6.1）

---

## 1. 这个界面要解决什么

258 个参数一次性摊开，小白会死在滚动条里；全藏起来，专家又觉得被当成傻子。这一版的答案是**双轨 + 三层折叠**：

| 目标 | 做法 |
|---|---|
| 零门槛电影通道 | 向导（选风格 → 一句话描述 → 自动处理 → 预览 → 作品库）经 header「一句话电影」按钮进入，全程不碰 258 参数；首次访问有遮罩引导。**小白模式 tab 已移除**，默认专家工作台 |
| AI 帮调 | 输入提示词 → `/api/recommend`（Qwen 轨；无 key / 失败诚实降级规则轨），三层分别填入，高级层只覆盖需要改的键 |
| 一键电影感 | 7 个风格预设卡片（电影感 / 写实摄影 / 二次元动漫 / 国风古风 / 赛博朋克 / 暗黑电影 / 梦幻仙气），参数组合 + 提示词工程，**不换模型权重** |
| 模型随便换 | 模型库下拉（6 图像 + 3 视频，分组 + 标签），选中即切采样器 / CFG / 步数 / 分辨率 / 负面词 / 提示词口径，配置数组可扩展 |
| 专家要能下去 | 「专家模式」加开常用层，「全部参数」三层全开（258 行），高级层标「高级用户慎用」 |
| 手动改有感知 | 覆盖横幅「你正在手动调整「XX」· 推荐值已被覆盖（共 n 项）」+ 一键恢复推荐 |
| 改这个值付出什么 | 右侧常驻四向读数（显存 / 耗时 / 质量 / 成本）+ 每行影响标签 + 护栏警告徽标，改任何参数即时重算 |
| 找得到参数 | 搜索框按 key / 中文名 / hint 定位，命中层自动展开并滚动到首个命中 |
| 攒得下经验 | 「保存为我的预设」（localStorage）+ 导出 / 导入 `.preset.json`（engine checksum 校验） |

**258 参数数据结构一个键都没动**——三层与推荐都是叠加层（`muse.presets.json` 的 `layers` / `core_keys` + 预设 values 补丁）。

对应数据流：`AVP.resolve`（联动改写）→ `AVP.estimate`（四向读数）→ `AVP.degrade`（超预算降档），与旧版一致。

## 2. 三层折叠（实测计数）

| 层 | 定义 | 参数数 | 默认状态 |
|---|---|---|---|
| core 核心 | `core_keys`：`kf.sampler / kf.cfg / kf.steps / kf.resolution / kf.refine_denoise` | **5** | 专家模式即展开 |
| common 常用画质 | L3（43）去掉 core 中的 4 个 L3 键 | **39** | 折叠，专家模式展开 |
| advanced 高级管线 | 其余全部（L4 215 去掉 core 中的 `kf.sampler`） | **214** | 折叠，标「高级用户慎用」，全部参数模式展开 |

5 + 39 + 214 = 258。注意 `kf.sampler` 在注册表里是 L4，但按用户口径提进 core 层——分层是展示层概念，不改注册表 tier。

每层折叠头 = 标题 + 一句话说明 + 参数计数 + 展开箭头（▸/▾）；advanced 层额外挂「高级用户慎用」警示。

两档模式（header 分段按钮；**小白模式 tab 已移除**，默认专家）：

| 模式 | 展开 |
|---|---|
| 专家模式（默认） | core + common |
| 全部参数 | core + common + advanced（258 行全量） |

5 步向导（选风格 → 一句话 → 处理 → 预览 → 作品库）**保留**，但不再由模式 tab 进入：改由 header 独立按钮「一句话电影」打开（`showWizard()`）；首次访问遮罩引导仍指向向导。

**作品库独立功能按钮**（header「作品库」`#libBtn` → `#libPanel`）：两 tab **电影库**（`avp.works.v1`，向导/cine 产出）与**专家库**（`avp.works.expert.v1`，专家模式一键生成产出，`genDone→saveExpertWork` 单独入库）。支持播放/删除/复用参数（专家）/在向导中打开（电影）。向导内部 `wizLibBtn` 仍保留电影库视图（现状）。

## 3. 布局

```
┌──────────────────────────────────────────────────────────────────┐
│ header  品牌 · 模式三档 · 设备档 · 搜索框 · 保存/导入/导出           │
├────────┬──────────────────────────────────────┬──────────────────┤
│ rail   │ board                                │ meters           │
│ 板块   │ 风格预设条（7 卡片横向滑动）           │ 显存/耗时/质量/成本 │
│ 导轨   │ 模型库卡（分组下拉 + 特点行 + 提示）   │ 红线降档/护栏/联动  │
│        │ AI 推荐卡（提示词 + 推荐按钮 + 结果）  │                  │
│        │ 一键生成卡（提交队列 + SSE 进度）      │                  │
│        │ 覆盖横幅（手动调整时出现）             │                  │
│        │ 我的预设 chips · 搜索命中提示          │                  │
│        │ 三层折叠参数区（core/common/advanced） │                  │
└────────┴──────────────────────────────────────┴──────────────────┘
```

- 数据构建期内联（`window.__REG / __CATALOG / __RULES / __MUSE`），**双击 `file://` 可用**；运行时不 fetch 本地 JSON。
- `/api/recommend` 是唯一的运行时 API 依赖：http 模式走 `location.origin`，file:// 模式走 `http://127.0.0.1:8388`；后端不可达时**显式标注**走本地规则轨（关键词 → Muse 预设 → engine resolve），不伪装 AI。
- 产物实测 266KB（`node tools/build_all.mjs` 输出，含一键生成 + 5 步向导 + 作品库 + 模型库）。

## 4. 风格预设（7 个，values 补丁数实测，共 213）

| 预设 | 补丁数 | 核心口径（实测填入值） |
|---|---|---|
| 🎬 电影感 `muse_cinematic` | 39 | DPM++ 3M SDE + Karras · CFG 6.2 · 28 步 · 1344 × 2.35:1（≈1344×576）· HD 0.45 · grain 15 · vignette 35 · texture_pass 0.3 · 色温 4300K + 分离 8 · 青橙 LUT 60 · 24fps · 运镜速度 0.3 · 提示词追加 `cinematic film still, 35mm, shallow DOF, film grain,` |
| 📷 写实摄影 `real_photo` | 31 | DPM++ 2M SDE + Karras · CFG 6.5 · 24 步 · 1536 × 4:3 · 侧光 5600K 光比 2 · 无 LUT · 写实皮肤纹理 |
| 🎨 二次元动漫 `anime` | 24 | SDXL + 赛璐璐风格 + 宫崎式镜头语言 + lineart 线稿模型 · CFG 6.0 · 24 步 · 1536 × 16:9 · 锐化 45 / 饱和 115 / 无 LUT / grain 0 · 移镜头 0.65 |
| 🏮 国风古风 `guofeng_immortal` | 33 | 雾气 65 · 中式 LoRA 权重 0.6 · 工笔风格 · 东方暖调 LUT 75 · 墨晕 30 · 拉镜头（8G 档风险护栏口径） |
| 🌃 赛博朋克 `cyberpunk` | 25 | 赛博 LUT 85 · 饱和 140 / 对比 120 / 色温 -30 · bloom 45 / 镜头光斑 25 · 雨 60 / 光晕 55 · 移镜头 0.7 · 镜头畸变 15 · 30fps · CFG 6.8 · 26 步 |
| 🖤 暗黑电影 `dark_sculpture` | 36 | CFG 7.0 · 30 步 · 1344 · 对比 145 / 饱和 60 · 黑白 LUT 80 · 顶光光比 6 · 材质粗粝 85 · 黑白灰色板 |
| ✨ 梦幻仙气 `dreamy` | 25 | 景深 70 · 光比 1.5 顺光 · bloom 60 / 高光滚降 60 / 光晕 65 / 雾 35 · 饱和 90 / 色温 +15 / 暗角 10 · 水光肌 + 莫兰迪色板 · 移镜头 0.25 · CFG 5.5 · 26 步 |

- 预设 = **defaults + values 补丁**（逐键 `AVP.coerce` 夹取），套用后成为新基线；提示词后缀写进 `ch.prompt_prefix`。
- 每个预设带 `emoji` + `example`（小白向导的占位示例，用户口径原句）+ `keywords`（规则轨命中词）。
- 用户口径与真实键位的差异在每个预设的 `mapping_note` 里写明（如「VAE emaonly」在 258 键中无对应 → `kf.vae_tile=true` 等效；「film grain 0.15」→ `lk.grain 15`，注册表是 0–100 刻度；**注册表无动漫底模** → SDXL + 赛璐璐 + 宫崎式 + lineart 等效，真动漫底模需改注册表契约）。**不编造不存在的参数。**
- 全部 213 个补丁键经注册表校验合法（键存在、枚举在 options 内、数值在 min/max 内）。
- 风格条 UI：横向滑动不换行，emoji + 风格名小字；选中银灰边框发光（`--glow`）背景微亮，未选中深灰底暗文字——延续银雕塑体系，标签不彩色。emoji 仅出现在 `__MUSE` 数据行与 `data-emoji-ok` 标记元素（lint 窄豁免，见 `tools/lint_ui.mjs`）。

## 5. 模型库（model_configs 叠加层，9 个开源免费模型）

数据源 `spec/model.configs.json`（构建期内联 `window.__MODELS`，file:// 可用），**配置数组可扩展**：加一条 `{id,name,type,tag,features,sampler,scheduler,cfg,steps,res,default_negative,placeholder,tips,registry_map,mapping_note,provenance}` 即入库，不改代码。

| 分组 | 模型 | 标签 | 基线（用户口径 → 注册表落键） |
|---|---|---|---|
| 图像 | Qwen-Image2（默认选中） | 推荐 | dpmpp_2m_sde + karras · CFG 6.5 · 24 步 · 1280 × 1:1（1024×1280 无 4:5 枚举，近似注记）· kf.model→Qwen-Image-GGUF-Q4 · 负面词 cartoon/anime/plastic skin… · 正向后缀 cinematic lighting… |
| 图像 | Flux.1 Schnell | 写实 | euler · CFG 3.5 · 20 步 · 1024 × 1:1 · kf.model→Flux-GGUF-Q4 · 轻负面词 · 常驻提示「CFG 建议 3~4，过高会过饱和」 |
| 图像 | SDXL 1.0 | 通用 | dpmpp_2m + karras · CFG 7.0 · 28 步 · 1024 × 1:1 · kf.model→SDXL · 负面词保留 (…:1.3) 权重语法 |
| 图像 | Kolors | 东亚人脸 | euler_a · CFG 7.5 · 25 步 · 1280 × 1:1 · 注册表无底模枚举→checkpoint 保持当前值 |
| 图像 | HiDream-I1 | 高细节 | dpmpp_2m_sde + karras · CFG 6.0 · 26 步 · 分辨率保持 · 无底模枚举 |
| 图像 | Pony Diffusion V6 | 二次元专用 | dpmpp_2m + karras · CFG 7.0 · 28 步 · Danbooru 负面词 · placeholder 变标签式写法提示 · 无底模枚举 |
| 视频 | Wan 2.1 T2V | 开源视频 | 720p = 1280 × 16:9 · mo.fps 16 · 5s 超 mo.duration 上限→夹取 3s 注记 · mo.i2v_model→Wan2.1-1.3B |
| 视频 | CogVideoX | 中文视频 | 用户口径未给数值基线，只切提示词口径 · 无底模枚举 |
| 视频 | HunyuanVideo | 长时长 | 同上 · 无底模枚举 |

交互（选中即生效，无需手动改参数）：

1. 下拉分组「图像模型 / 视频模型」，选项 = 模型名 · 标签；下方特点行 `Qwen-Image2 | 中文人像 · 局部重绘 · 推荐` + tips + mapping_note（无枚举模型挂警示「权重路径自配」）。
2. 切换 → 补丁叠在**当前 values** 上（保留风格预设其余配置），经 `AVP.coerce` 逐键夹取；基线标「模型·X」；toast「已切换到 X，已自动调整最佳参数」+ 夹取/近似注记。
3. `#aiPrompt` placeholder 变模型示例；Pony 变「二次元风格请用标签式提示词，如：1girl, silver hair, school uniform」。
4. 用户显式选过模型后（`modelTouched`），AI 推荐请求自动带 `model_id`：后端规则轨叠模型基线、Qwen 轨注入模型特性；结果 meta 回显「模型库 X」。向导默认风格驱动不带 model_id，选过模型后也带。
5. 旧后端不认识 model_id（不回显）→ 前端 `ensureModelOverlay` 本地补叠 + 显式注记「旧后端未识别 model_id，模型基线已本地补叠」，不静默丢基线。

**诚实边界**：不下载模型权重，只做配置切换，实际权重路径用户在 ComfyUI 自配；`kf.model` / `mo.i2v_model` 枚举与显存目录绑定（冻结契约），无对应枚举的模型不硬扩——checkpoint 保持当前值并如实说明。所有基线 provenance: user-spec（用户口径推荐值，非实测）。

实测（2026-11-17，PORT=8390 + file:// 打 8388 旧实例，浏览器脚本断言）：

| 场景 | 结果 |
|---|---|
| 默认选中 Qwen-Image2 + 分组/标签/特点行 | PASS：2 个 optgroup（6 图像 + 3 视频），特点行格式正确 |
| 切 SDXL / Kolors → 采样器 CFG 自动变 | PASS：dpmpp_2m+karras/7.0/28 步 → euler_a/7.5/25 步；Kolors 无枚举 checkpoint 保持 SDXL |
| 选 Pony → placeholder 标签式 | PASS：「二次元风格请用标签式提示词，如：1girl, silver hair, school uniform」+ Danbooru 负面词 |
| 选 Flux → CFG 3.5 + 提示 | PASS：cfg 3.5 / euler / 20 步，tips 常驻「CFG 建议 3~4，过高会过饱和」 |
| 负面词自动切换 | PASS：Qwen plastic skin… / SDXL (…:1.3)… / Pony lowres… / Flux 轻模板 |
| Wan 视频基线 | PASS：1280×16:9 / fps 16 / duration 夹取 3 + toast 注记 / 图像参数不动 |
| AI 推荐带 model_id | PASS：规则轨叠 Flux 基线（cfg 3.5 压过风格预设 6.2），meta「模型库 Flux.1 Schnell」 |
| file:// + 旧 8388 | PASS：本地补叠 cfg 3.5 保持 + 显式注记；Pony 离线切换正常 |

## 6. AI 推荐（双轨，前端侧）

1. 输入提示词 → `POST /api/recommend {prompt, device, model_id?}`（用户选过模型库后自动带 `model_id`，见 §5）。
2. 返回 `{source:'qwen'|'rules', core, common, advanced_overrides, reason, muse_level, ai, …}`：
   - core 5 项填第 1 层，common 39 项填第 2 层，`advanced_overrides` **只覆盖需要改的**高级键，其余 214 项保持默认。
   - 结果卡显示来源徽标：`Qwen` 或「规则推荐 · 非 AI」+ 原因（如 `DS_NO_API_KEY`）+ `muse_level`（恒标 `provenance: estimate`，非实测）。
3. 推荐值成为基线；此后手动改任何参数 → 覆盖横幅「你正在手动调整「XX」· {基线名}值已被覆盖（共 n 项）」，点「恢复推荐」回基线。
4. 后端不可达（file:// 且 8388 没起 / 旧版无此路由）→ 本地规则轨，结果卡显式写「后端不可达（HTTP xxx），走本地规则轨」。

## 6.1 低置信阻断确认卡（规则轨时不许替用户脑补参数）

唯一实现：`params.src.html` 内 `LOWCONF`（`web/params.html` 与 `app/index.html` 同一份代码块），三个入口共用。

| 触发点 | 触发条件（真值） | 拦在哪个动作之前 |
|---|---|---|
| 专家工作台 · 一键生成 | `recMeta.source !== 'qwen'` 且本次推荐未确认过（推荐轨 `/api/recommend` 返回 `source:'rules'`，或后端不可达走本地规则轨） | `generate()` 里弹卡，确认后才 `POST /api/jobs` |
| 向导 · 生成视频 | 同次 recommend 返回 `source !== 'qwen'` 或 `rec` 为空 | 先解析再决定推进：不确认就退回第 ② 步并聚焦输入框，不 `goStep(3)` |
| 电影向导 · 成片入库 | 服务端 `cineReport.analysis.source === 'rules'`（槽位分析退规则轨） | `cineFinish()` 在 `saveWork` + `goStep(4)` 之前 |
| 外壳向导 / 开渲 | `detectGpu()` 未取到型号（`wiz.gpuConfident === false`） | `wizFinish()` / `submitJob()` 之前（外壳无 recommend 消费端，这是它唯一的「推断后推进」口） |

卡片内容全部取自响应真值：标题「解析置信低：本次走规则轨（非 AI）」、`被推断的关键项`（规则轨命中的预设 + core 5 项实际值）、`未能确定、将使用默认值的项`（语义槽位未解析、其余参数按预设补丁/注册表默认、AI 通路错误码）；电影轨则列 `analysis` 的 subject/style 与 light/mood/camera/shot 默认值。

- 两个按钮：`按规则轨继续`（确认后才推进，留痕记 `confirmedByUser: true` + ISO 时间）、`返回修改描述`（关卡片、聚焦输入框、不推进）。
- 键盘：`Esc` = 返回修改；`Enter` 只在焦点明确落在「按规则轨继续」时才算确认，其余位置走返回（危险动作不做回车默认）。
- 留痕：localStorage `avp.lowconf.trace.v1`（上限 50 条）+ 任务 `note` / 项目 `history.note` 追加 `低置信确认 confirmedByUser: true @ <时间>`；电影作品库条目另带 `lowConf: confirmed|declined`。
- 样式：只挂既有 `.glass-modal` + tokens（`#lcMask` 遮罩 / `#lcCard` 卡体），无新配色、无动画。

## 7. 参数行语法

一行 = 中文名 + key（等宽小字）+ hint + 影响标签 + 护栏徽标 + 控件 + 还原：

- **影响标签**：`impact{vram,time,quality}` 非零项显示「显存+x% / 耗时+y% / 画质权重」，另按板块给类别标签。
- **护栏徽标**：当前值命中 `guards[].when` → 黄色「警告」（文案来自规则表）；有护栏但未命中 → 灰色「护栏」（title 列条件）。
- **联动**：`resolved.trace` 改写行照常显示；右侧「联动改写」卡常驻。
- **还原**：单参数回 default；行左侧竖条标记「已自定义」。
- 搜索命中：按 key / label / hint 匹配，命中层自动展开，`scrollIntoView` 到首个命中，顶部显示命中数。

## 8. 右侧四向读数（与旧版一致）

顺序固定：**显存 → 耗时 → 质量 → 成本**，之后「红线降档」「护栏」「联动改写」。显存三态 ok/warn/block（`--ok/--warn/--bad`），超预算时数字照实、条封顶 100%；降档方案来自 `AVP.degrade`，「套用这套」直接写 patch 重算。

## 9. 一键生成（当前 258 参数 → 后端任务队列）

AI 推荐卡下方是生成卡：**一键生成**按钮 + 实时状态区。

1. 点击 → `POST /api/jobs {values(258 全量), device, note}` → 202 受理快照。
2. `EventSource /api/jobs/:id/events` 实时推 `snapshot / state / progress / done`：状态徽标（排队中 / 生成中 / 已完成 / 失败 / 已取消）+ 进度条 + 阶段名 + 耗时。
3. **诚实标注**：`job.mock === true` 时挂「mock 演示 · 非真实出片」徽标，完成后明示占位产物不是真实视频，并给出真出片路径（`AVP_PROVIDER=comfy` 或 `dashscope + DASHSCOPE_API_KEY`）；失败显示 `error.code + message`（`DS_NO_API_KEY` 附设置指引）。
4. 运行中可**取消任务**（`POST /api/jobs/:id/cancel`）；SSE 断开自动改 2s 轮询补终态，不卡在「生成中」。
5. 生成卡 meta 常驻当前口径（258 参数 / 档位 / 质量 estimate）；**超预算时红字警示**「超预算 xxx%，建议先套用降档方案」（不阻断提交）。
6. 后端不可达 → 显式「后端不可达（…）：未伪造任何生成结果」+ 启动指引，参数与导出功能不受影响。
7. file:// 模式指向 `http://127.0.0.1:8388`；jobs 是既有路由，**旧版后端也能受理一键生成**（推荐路由才需要重启升级）。

实测（2026-11-17，PORT=8390 · AVP_MOCK_MS=8000）：

| 场景 | 结果 |
|---|---|
| Muse 电影感 → 一键生成 | PASS：258 键提交，SSE 进度 20% sampling → succeeded 8.1s，mock 徽标 + 帧图 1 张 + 诚实提示 |
| 运行中取消 | PASS：canceled（2.4s 处），按钮复位、取消钮隐藏 |
| file:// 双击 → 一键生成（8388 旧实例） | PASS：国风预设 258 键 → succeeded 3.1s，mock 如实标注 |
| T0-low 超预算 meta | PASS：「超预算 148%，建议先套用降档方案」 |

## 10. 小白 5 步向导（basic 模式，默认入口）

目标口径：**完全不懂 AI 的人，照着步骤走，1 分钟出片**。左侧步骤导轨（① 选风格 ② 写描述 ③ 生成中 ④ 预览 + 作品库入口 + 「跳过引导，直接调参」），右侧当前步骤。

1. **第一步：选一种风格** —— 7 张风格卡片（emoji + 名称，横向滑动），默认选中 🎬 电影感；点卡片银灰发光高亮 + 自动套用该风格 258 参数补丁 + **自动进入第二步**（无「下一步」按钮）。
2. **第二步：用一句话描述你想看到什么** —— 大输入框自动聚焦，placeholder 自动变当前风格示例；示例句可点击直接填入；说人话就行。大按钮「生成视频」。
3. **第三步：AI 自动处理** —— 5 阶段进度动画（正在理解你的描述 → 正在选择最优参数 → 正在绘制画面 → 正在让画面动起来 → 正在检查画面质量），阶段映射真实事件：推荐返回 = 前 2 阶段完成，SSE 进度 <55% = 绘制、<95% = 动起来、终态 = 质检完成。预计等待按 provider 如实标注（mock → 「演示链路 · 约几秒（真出片约 30~60 秒，estimate）」；real → 「约 30~60 秒（estimate，非实测）」）。小提示「喝口水，AI 在帮你调 258 个参数」。可取消 / 返回改描述。
4. **第四步：预览视频** —— 真成片（`job.output` 存在）→ `<video autoplay loop muted controls>` 居中播放，源 `GET /api/jobs/:id/output`；mock / 无成片 → 警示色演示卡「演示链路产物 · 没有真实视频」，**不放假播放器**。三个按钮：👍 满意，保存（入作品库）/ 🔄 换一版（同提示词随机 `kf.seed + mo.shake_seed` 重投）/ 🛠 手动调整（切专家模式展开参数面板）。**默认自动保存**，无需操作。meta 如实标注：风格 / 提示词 / 推荐来源（规则轨显式 `DS_NO_API_KEY`）/ 参数合规检查（engine 护栏告警数）/ 显存占比（estimate）。
5. **第五步：作品库** —— 左侧导轨入口（带计数），按时间倒序（localStorage `avp.works.v1`，上限 30 条）。每条：重播 / 复用参数（回第二步，提示词与 258 值还原）/ 复用这个风格（回第一步，风格参数已配好只写新提示词）/ 下载（真成片走 output 路由；mock 明示无文件）/ 删除。mock 条目挂「演示」徽标。

**首次访问遮罩引导**（`avp.guideSeen.v1` 只弹一次）：半透明遮罩 + 聚光高亮，3 步——① 高亮风格选择区「先点一个你喜欢的风格」② 高亮输入框「用一句话描述你想看到的画面」③ 高亮生成按钮「点这里，剩下的交给 AI」。可跳过。

**诚实边界**：推荐走 `/api/recommend` 双轨（无 key → 规则轨，meta 显式标注非 AI）；后端不可达 → 显式报错「未伪造任何结果」；SSE 断开 → 2s 轮询补终态；用户提示词经 HTML 转义后才插入 DOM（防 XSS）。

实测（2026-11-17，PORT=8390 · AVP_MOCK_MS=6000 + file:// 打 8388 旧实例）：

| 场景 | 结果 |
|---|---|
| 首访遮罩 3 步 → 不再弹 | PASS：聚光定位正确，`guideSeen='1'` |
| 赛博朋克卡片 → 自动第二步 | PASS：lut 赛博 / rain 60 / sat 140 / fps 30 / camSpeed 0.7 / prefix 含 cyberpunk，输入框聚焦 + 示例占位 |
| 示例填入 → 生成 → 5 阶段 → 预览 | PASS：中途 phases [2,2,1,0,0]  bar 27.6% → 终态全 done，succeeded mock:true，演示卡 + 自动保存 |
| 🔄 换一版 | PASS：kf.seed -1 → 随机值，新任务，作品库 2 条 |
| 作品库复用风格 / 复用参数 | PASS：回第一步风格已选提示词清空 / 回第二步提示词与 rain 60 还原 |
| 🛠 手动调整 | PASS：切专家模式，向导隐藏工作台显示 |
| 二次元动漫切换 | PASS：SDXL + 赛璐璐 + 宫崎式 + lineart（注册表无动漫底模，mapping_note 如实说明） |
| file:// 双击全流程 | PASS：首访遮罩正常（独立 localStorage），生成打 8388 → succeeded，meta「规则推荐（非 AI：DS_NO_API_KEY）」+ 自动保存 |

## 11. 我的预设 / 导出 / 导入

- **保存为我的预设**：当前 values 存 localStorage（`avp.myPresets.v1`），chips 一键套用 / 删除。
- **导出**：`AVP.exportPreset` → 只含非默认键 + `schema/format/registry_version/checksum(djb2)`。
- **导入**：`AVP.importPreset` 校验 schema 与 checksum，未知键计数提示，越界夹取。

## 12. 本轮验收实测（2026-11-17，浏览器脚本断言 + file:// 双击）

测试环境：`PORT=8390 node tools/serve.mjs`（8388 被旧实例占用）；无 `DASHSCOPE_API_KEY`。下表为三层工作台改造轮次的断言（当时 basic 尚为 core-5 视图；向导落地后 basic 改为 §10 的 5 步流程，工作台断言在专家/全部参数模式下复测仍成立）。

| # | 清单项 | 结果 |
|---|---|---|
| ① | 默认只显示 5 核心参数 | PASS：basic 模式可见 5 行，三层计数 5/39/214 |
| ② | 点 Muse 电影感 → 258 参数填充 | PASS：cfg 6.2 / steps 28 / resolution 1344 / refine_denoise 0.45 / sampler dpmpp_3m_sde / grain 15 / vignette 35 / texture_pass 0.3 / ratio 2.35:1 / prefix 含 cinematic；全部参数模式 258 行 |
| ③ | 提示词 AI 推荐三层填好 | PASS：暗黑雕塑提示词 → 「规则推荐 · 非 AI」+ `DS_NO_API_KEY`，三层 5/39/21，muse_level 7.9（estimate） |
| ④ | 手动改参数 → 覆盖提示 | PASS：改 CFG → 「你正在手动调整「CFG」· 规则推荐值已被覆盖（共 1 项）」；恢复推荐回基线 |
| ⑤ | 搜索「种子」定位 | PASS：4 命中（ch.seed / sb.story_seed / kf.seed / mo.shake_seed），命中层自动展开 |
| 附 | file:// 双击 | PASS：加载即 5 行；推荐按钮 → 旧 8388 实例 HTTP 404 → 显式「后端不可达（HTTP 404），走本地规则轨」，国风 values（fog 65 / lora 0.6）正确填入 |

> Qwen 真 AI 轨待 `DASHSCOPE_API_KEY` 设置后启用（与任务卡③同一把 key）；当前所有推荐结果均为规则轨，界面已如实标注。

## 13. 已知取舍

1. **旧版截图已移除**：`shots/10-params-*.png` 是上一版（蓝色体系）界面，与当前银雕塑三层版不符，不再引用；本轮视觉验证走 lint + 浏览器脚本断言。
2. **本地规则轨不是 AI**：关键词命中预设，覆盖不了提示词的细粒度语义；这是无 key 时的诚实兜底，不是等价替代。
3. **我的预设只在本机浏览器**：localStorage 不跨设备；要带走请用导出 `.preset.json`。
4. **机械迁移器不要重跑**：`tools/restyle.mjs / tools/polish.mjs` 是上一轮一次性工具，在新 src 上重跑会打散手工定的层次。
5. **风格卡片是 emoji + 名称，不是真缩略图**：用户口径「看缩略图就懂」目前用 emoji 语义近似（零依赖、零体积）；升级路径是给预设加可选 `thumb` 字段 + 生成银灰调缩略图，数据层已留位。
6. **作品库只在本机浏览器**：localStorage 上限 30 条，不跨设备；真成片文件在 `%CLOUD_ROOT%\02-视频\成片`，作品库存的是引用与参数快照。