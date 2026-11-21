# 17 · VisInter-Agent（本地开源管线装配层）

> 落地 2026-11-18｜规格真源 [`spec/visinter.agent.json`](../spec/visinter.agent.json)｜规则引擎 [`server/visinter.js`](../server/visinter.js)｜页面 [`visinter/index.html`](../visinter/index.html)｜CLI [`tools/visinter.mjs`](../tools/visinter.mjs)
> 定位：wan2.2 + ComfyUI 的**本地**装配层。Muse 电影氛围 + IP-Adapter 定妆 + FaceDetailer 精修，258 参数全开放，风险只提示不拦截。

## 1. 一句话结论

双模式、主体识别、六类风险、自检状态机都已经是可以跑的东西（41 项契约自检 + 浏览器实测），**不是文案**：
小白点一下拿到 Muse 提示词与稳定预设；专家一个值都不填、只被提示；人像自动开人脸模块、风景自动摘词关模块；风险弹窗三按钮（返回调整 / 切换推荐预设 / 继续生成）；自检在本机如实报 `fail`（ComfyUI 未安装）。

## 2. 文件与职责

| 文件 | 职责 |
|---|---|
| `spec/visinter.agent.json` | 规格真源：提示词三条、稳定预设、8 档分辨率白名单、6 条风险（阈值 + 文案 + 按钮）、人像/风景联动、自检 4 张与模型清单 |
| `server/visinter.js` | 纯逻辑：`detectSubject / assemble / risks / selfCheck / resolutionWH`；不碰网络（自检除外） |
| `tools/visinter.mjs` | CLI + 契约自检（无参数=verify，41 项） |
| `tools/snap_visinter.mjs` | 构建期快照 → `visinter/snapshot.json`（file:// 可开） |
| `visinter/visinter.src.html` | 页面源件 → `node tools/build_module.mjs visinter` 出单文件产物 |
| `server/app.js` | `GET /api/visinter`、`POST /api/visinter/plan`、`POST /api/visinter/selfcheck` |
| `server/jobs.js` | 新增 `kind='local'`：固定走本机 ComfyUI，**不落云端 provider** |
| `tools/selftest_all.mjs` / `tools/lint_ui.mjs` / `tools/build_module.mjs` | 接入总自检、视觉守门（第 8 页）、模块清单 |

## 3. 规则实现（不是 UI 文案）

| 规则 | 落点 | 可验证断言 |
|---|---|---|
| 用户手改优先 | `assemble({manualKeys})` 只写未手改的键；`kf.prompt_prefix/kf.negative` 手改后永不覆盖 | 「手改 CFG/运动/提示词不被覆盖」3 项 + `skipped` 记录 |
| 不拦截 | `assemble` 永远返回 `submit_allowed:true`，`risks()` 永远返回数组 | 六类风险同时触发仍 `submit_allowed=true` |
| 双模式 | `modes.novice.auto_fill=true` 填 9 项；`expert` 不填且**不做联动**（连开关都不替用户拨） | 「专家模式不填任何值」 |
| 主体联动 | 关键词计分，打平/无命中 → `unknown`，不动任何开关 | 人像开 0.75/0.8/0.4、风景置 0 并摘人像词 |
| 风险只提示 | 阈值在 spec，命中即带上原文与 `detail` | 六类各 1 项 + 文案逐字 |
| 自检诚实 | 无 ComfyUI → `fail`；缺模型 → `fail` + `path_hint`；齐备未跑 → `inferred`；只有跑完并验收才 `measured` | 三种结局各 1 项（注入 fake，不依赖本机环境） |

**采样器命名坑**：规格写的 `DPM++ 2M SDE Karras` 是 ComfyUI 显示名，注册表 `kf.sampler` 是枚举（`euler/euler_a/dpmpp_2m/dpmpp_2m_sde/dpmpp_3m_sde/uni_pc/lcm`），`Karras` 属于 `kf.scheduler`。
直接写显示名会被 coerce 静默回落默认——现在落库为 `kf.sampler=dpmpp_2m_sde` + `kf.scheduler=karras`，展示名单独放 `presets.display.sampler_ui`，并加了「预设键全部存在 + 枚举值合法」两条断言。

**分辨率风险只在用户动过时判**：默认 `kf.resolution=1536` 是平台自己的合法档，一上来就弹窗等于把异常提示做成开机广告。判定时把「长边 × 比例」换算成 `W*H` 再比 8 档白名单（1536×9:16 → 864\*1536）。

## 4. 页面（8 个模块页之一）

`node tools/build_module.mjs visinter` → `visinter/index.html`（单文件，file:// 双击可开）。
http 模式（`node tools/serve.mjs`）下可：生成装配、看 AI 提取、改参数/提示词、弹风险窗、切推荐预设、一键自检、提交生成。
file:// 模式只展示内联规格并提示起服务——不假装修配可用。

实测（`http://127.0.0.1:8414/visinter/index.html`，2558×1520）：
- 输入「雨夜街头，一个穿米色针织衫的22岁女孩回眸」→ `主体 portrait`、填充 9 项、`【AI提取】ch.subject/ch.age=22/ch.outfit_1=米色针织衫`
- 手改 CFG=12 → 风险「1 条 · 高危」，文案与规格逐字，`submit_allowed=true`
- 点提交 → 风险弹窗（返回调整 / 切换推荐预设 / 继续生成）；切预设后 CFG 回 5.5、风险 0 条
- 一键自检 → `fail`：`ComfyUI 不可达` + 三条模型路径（`ComfyUI/models/loras/influencerBeauty_v1.safetensors` 等）

截图：`D:\缓存\avp\visinter-1.png`（初始）、`visinter-2.png`（装配后）、`visinter-mask.png`（风险弹窗）。

## 5. 提交链路（两个真实缺口都被它照出来了）

1. 页面最初提交走主 provider（`auto`）→ 落到 **dashscope**，返回 `Arrearage`（账号欠费）。这不符合「本地开源、不烧云端钱」的规格。
2. 修法：`jobs.js` 新增 `kind='local'` → 固定 `comfy` provider。实测该任务 `provider=comfy`、`COMFY_UNREACHABLE`（`ECONNREFUSED 127.0.0.1:8188`），如实失败、无计费。

## 6. 已知缺口

1. **ComfyUI 未安装 → 没有真出图**：自检恒为 `fail`，`measured` 一次都没达到；IP-Adapter / FaceDetailer 的实际效果仍是 `inferred`。
2. **`kf.sampler` 枚举与 ComfyUI 采样器名不是一对一**（缺 `dpmpp_2m_sde_karras` 之类的组合命名），靠 `kf.scheduler` 补。
3. **角色提取的 `ch.face_shape` 仍回默认「鹅蛋」**：`spec/character` 的提取规则只认显式词，Muse/网红脸场景需要手动改（或等 `reverse.capabilities` 的 preconditions 覆盖到 UI 层）。
4. 页面只暴露 6 个关键参数，258 全量仍在 `web/params.html`；两边没有共享的「手改清单」存储（各自维护）。

---

## 7. 三项待办改造（2026-11-18 深夜第二轮）

### 7.1 自检：从「猜路径」改成「问 ComfyUI」

| 之前 | 现在 |
|---|---|
| `fs.existsSync` 猜 `models/loras/xxx` 三个固定路径 | `GET /object_info` 查节点（LoraLoader / IPAdapterFaceID / FaceDetailer），`GET /models/{folder}` 查模型清单，拿不到才回退文件系统 |
| 一个总开关，缺人脸就整条 fail | **两层**：`global`（CheckpointLoaderSimple/KSampler/SaveImage）与 `face`（三件套）；face 缺 → `fail` 但 `landscape_ok=true` |
| 只有 status | 报告三块：`models_loaded`（实测）/ `face_consistency` / `texture_score`，后两项标 `rule-proxy` + `not_visual`，不冒充 VL 评分 |
| 文件名匹配用 `includes`，`ip-adapter-faceid-sdxl` vs `ip-adapter-faceid_sdxl.bin` 永远 false | 归一化（去 `-_` 转小写）+ `files[]` 候选表，spec 里写清每个组件的可能文件名 |

自检状态规则：不可达/缺节点/缺模型 → `fail`（并给 path_hint）；组件齐备未跑 → `inferred`；`run=true` 且 4 张全部出图 → `measured`。
风景可用性：`landscape_ok = global 层 ok`，人脸组件缺失时仍为 true（Muse 氛围风景不依赖人脸节点）。
实测（本机无 ComfyUI）：`fail` / `landscape_ok=false` / 报告「模型加载未通过 · 一致性未测 · 质感未测」。

### 7.2 参数分层存储：一套 store，两边同源

- 唯一存储 `avp.shell.store.v1`（schema `ai-video-platform/shell.store`），与外壳 `app/state.js`、`web/params.html`、`canvas` 同一个键。
- 小白面板 6 键（CFG / 步数 / 运动幅度 / 长边 / 人脸精修 / 定妆权重）**读写同一份 values**：改动 200ms 防抖写回，并追加 `projects[active].manualKeys`。
- 全量面板在 `web/params.html` 改任意参数 → 写同一 store → 小白面板 `storage` 事件监听跟上（页面提示「检测到全量参数页改动，已同步 6 项关键参数」）；反向同理。
- 跨页手改不被覆盖：自动填充只写「值等于注册表默认」的键；已偏离默认（例如全量面板把 CFG 调到 8）→ `skipped: 已偏离默认值（跨页手改），保留`，并在小白面板立刻触发 CFG 风险提示。
- 实测（8416 同源双标签页）：小白写 CFG=7 → params 读到 7；params 写 CFG=8 / steps=42 → 小白加载与实时同步都拿到 8/42，装配后仍是 8/42（`填充 8 项`），并弹「CFG 超出稳定区间」1 条高危。

### 7.3 脸型提取：关键词 + 场景预设 + 前置条件

- 关键词（spec `face_presets.keyword_map`）：V脸/瓜子→瓜子、圆脸/娃娃脸→圆、方脸/国字→方、鹅蛋→鹅蛋、长脸→长、心形/倒三角→心形。
- 场景预设（`face_presets.scenes`）：Muse 氛围、抖音网红、二次元命中且提示词没写脸型 → 瓜子（V 脸）；关键词优先于场景（「Muse + 方脸」→ 方）。
- `preconditions` 前置到 UI：网红场景下把默认主体整句里的「，鹅蛋脸」整段删除（只删这一处，不改其它字），并回传 `preconditions_applied` 供页面显示。
- 手改入口：脸型下拉（瓜子/鹅蛋/圆/方/长/心形）；改后写回 258 存储、标【手改】、`manualKeys` 命中则 `manual_overridable=false`，AI 不再覆盖。
- 无脸型词且无场景 → 不写 patch（不脑补），由面板默认值决定。

断言：`tools/visinter.mjs` 从 41 项扩到 **58 项**（脸型 10 项 + 自检 7 项 + 跨页手改 1 项 + 预设枚举合法性 3 项）。
