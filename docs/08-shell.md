# 08 · 平台外壳（app/）

> 唯一入口：`app/index.html`。双击即开，`file://` 下可用。
> 写域：`app/**`、`tools/build_app.mjs`、`docs/08-shell.md`、项目根 `README.md`。
> 本文件是外壳的自述；其余模块的实现细节归各自 docs。

## 1. 它是什么，不是什么

外壳只做四件事：**入口聚合 / 显式状态机 / 实时估算 / 异常兜底**。

- **不是** 参数面板的替代品——258 参数的工作台在 `web/params.html`，外壳只给一张卡片跳过去。
- **不是** 画布 / 检查器 / 市场 / 插件 / 质检 / 服务的 UI——那些是并行子任务的写域，外壳不复制、不内嵌、不假设其内部实现。
- **不假装有硬件探测**——浏览器没有读取显存的 API，见 §3。

### 1.1 视觉层：玻璃拟态 + 两层烟雾

身份令牌唯一源 `ui/tokens.css` + 皮肤层 `ui/glass-skin.css`（构建期经 `/*__TOKENS__*/` / `/*__SKIN__*/` 内联）：
深黑底 + 冷银强调 + 半透明白 .06 卡片 + 1px 银边 + 圆角 16 + backdrop 毛玻璃。

- **背景烟雾 `#mistBg`**：fixed 全屏 canvas，z-index 0，垫在所有玻璃之下让毛玻璃「有东西可透」。
  5 团银雾（径向渐变 puff）+ 26 粒疏银粒，rAF 常驻；`document.hidden` 即停、回页恢复；
  `prefers-reduced-motion` 只画一帧静态；dpr 上限 1.5。2026-11-18 浏览器实测 alpha 采样随时间变化（在动）。
- **铸造加载器 `#forgeCanvas`**：只在状态机「渲染中」存活，90 银粒 + 7 雾团，与背景层同一套银色渲染语言。
- 两层都只用银灰（rgba 200,205,212 / 216,221,228），不引入彩色光晕；循环动画只挂加载器与烟雾选择器（rule 03 第 11 条）。

## 2. 构建与自检

```bash
node tools/build_app.mjs     # app/index.src.html + engine + state.js + 三份 spec → app/index.html
node app/selftest.mjs        # 静态断言 12 项 + 状态机 28 项
```

构建做三件事：占位符替换（`/*__ENGINE__*/` `/*__STATE__*/` `/*__DATA__*/`）、`</script>` 截断检查、产物断言（内联变量在、`参数 N 个` 与注册表对得上）。任一失败即中止，不留半成品。

当前产物：约 232KB，单 `<script>`、零外链、零外部字体。

## 3. 首启向导：三屏各解决什么

| 屏 | 解决的问题 | 关键做法 |
|---|---|---|
| ① 本机条件 | 机器能跑多重 | WebGL 只取 GPU **型号字符串**；可用显存由用户在分档表里选或手填 MiB；界面明说这是**用户侧确认**，不是探测 |
| ② 画质档 | 三档差多少 | 每档真跑 `AVP.applyPreset` → `AVP.resolve` → `AVP.estimate`，给单格秒 / 单集分钟 / 显存比 / 质量分 |
| ③ 生成工作台 | 落地 | 推荐 values + 档位 + 显存预算写入 localStorage，项目置为 `configured`，进主界面 |

**为什么显存必须手填**：`WebGL` 只暴露 `UNMASKED_RENDERER_WEBGL` 字符串，没有总显存，更没有可用显存。任何"用 GPU 型号反查显存"的技巧在核显/共享内存机器上会给出荒谬数字，比没探测更糟。所以外壳的选择是：把不确定性交给用户确认，并把这件事写在脸上。

## 4. 状态机（`app/state.js`）

```
draft(草稿) → configured(已配置) → rendering(渲染中) → reviewing(审片中) → exported(已导出)
```

动作用白名单表 `ACTIONS` 约束（`from` 是合法来源集合），非法路径在数据层抛 `ILLEGAL_TRANSITION`：

| 动作 | 合法来源 | 去向 | 守卫 |
|---|---|---|---|
| `configure` 确认配置 | draft, configured | configured | 参数集非空且含 `kf.resolution` |
| `render` 开始渲染 | configured | rendering | 显存比不得为 `block` |
| `review` 进审片 | rendering | reviewing | — |
| `rework` 返工 | reviewing | configured | — |
| `export` 导出成片 | reviewing | exported | — |
| `fail` 渲染失败退回 | rendering | configured | — |
| `restart` 新起一轮 | configured/rendering/reviewing/exported | draft | — |

`export` 的合法来源只有 `reviewing`：草稿与已配置都没有产物，任何直达导出的路径都会被拒。

**参数一改就回草稿**：在 `configured` 状态改任一参数，外壳自动执行 `restart`，历史里留一条「参数变更 kf.steps=50」。配置是"被确认过的参数集"，参数变了它就不成立。

项目对象与参数同落一个 JSON（`ai-video-platform/project`），支持另存为 / 切换 / 导入 / 导出。

## 4.1 服务桥：`render` 怎么真的落到队列

状态机是本地真相，但「渲染中」如果没有任务支撑就只是个标签。外壳因此接了一条窄桥（`app/index.src.html` 里的「服务桥」段）：

```
点「开始渲染」→ 本地 apply('render') → POST http://127.0.0.1:8388/api/jobs
             → 每 1.6s GET /api/jobs/:id → succeeded 时 apply('review')
```

| 环节 | 接口 | 失败时外壳怎么表现 |
|---|---|---|
| 探测 | `GET /api/health` | 状态行变灰「未连接」+ 给出 `node tools/serve.mjs` |
| 提交 | `POST /api/jobs`（`{values, device, note}`） | 保留 `rendering` 但标「任务未提交」，给「重试提交」 |
| 轮询 | `GET /api/jobs/:id` | 停止轮询，显示错误码，不自动跳状态 |
| 取消 | `POST /api/jobs/:id/cancel` | 状态转「已取消」；`fail` 动作会顺带取消 |
| 重启一轮 | 本地 `restart` | 清掉 timer 与 jobId，回到未提交态 |

三条诚实边界（写进代码注释，不许被"体验优化"掉）：

1. **不伪造产物**：外壳不生成缩略图、帧、时长、质量分。任务成功只把状态推到「审片中」，产物由服务与质检模块负责。
2. **成功才推进**：`failed` / `canceled` 都不自动跳状态，用户必须显式用「渲染失败退回」。
3. **离线不装在线**：后端没起时动作照旧在本地生效（状态机可用性优先），但整条明确写「未提交任务」，不留"看起来跑了"的假象。

后端 `comfy` 不可达时进入 `mock` 模式（`/api/health` 的 `comfy.mode`），队列仍会跑一遍真实的任务状态机与进度事件——所以这套链路在没有 ComfyUI 的机器上也能验证，只是没有真实画面。

## 5. 存储降级三档

`localStorage` 在 `file://`、隐私模式、配额打满时都会抛。`createStore().save()` 返回三档，绝不假装成功：

| mode | 含义 | UI 表现 |
|---|---|---|
| `full` | 全量写入成功 | 无提示 |
| `slim` | 裁剪历史与其它项目参数后写入成功 | 黄色降级条 + 提示导出备份 |
| `memory` | 落盘失败，只存在内存（刷新即丢） | 黄色降级条，明说"刷新即丢失" |

`ok` 字段只表示"是否落盘"，`mode` 才是真相——调用方必须同时看。

## 6. 异常兜底

| 场景 | 处理 |
|---|---|
| `engine.resolve/estimate` 抛错 | 结构化错误卡片（错误 / 位置 / 建议 + 重置参数 + 复制详情），其余界面继续可用 |
| 任意未捕获异常 / Promise 拒绝 | `window.onerror` / `unhandledrejection` → 同一张卡片，不白屏 |
| `fetch` 探测失败（含 file://） | 静默降级为「未验证」，卡片给「尝试打开」，不崩、不谎报 |
| localStorage 不可用 / 写满 | 降级条 + 内存继续工作 |
| 内联资产缺失 | 整页替换为「构建产物不完整」说明 |

## 7. 模块接入约定

外壳按**相对路径 fetch 是否成功**判断模块是否安装。任何模块只要产出下表的入口文件，就会被外壳识别为「存在」，卡片出现「打开」按钮。

| 模块 | 约定入口（相对 `app/`） | 说明 |
|---|---|---|
| 参数面板 | `../web/params.html` | ✅ 已完成（`core/build.mjs` 产物） |
| 画布 | `../canvas/canvas.html` | ✅ 已完成（`tools/build_canvas.mjs` 产物；**不是** `index.html`） |
| 帧检查器 | `../inspector/index.html` | ✅ 早期独立产物，未纳入回程链接契约 |
| 模板市场 | `../market/index.html` | ✅ 已完成（`tools/build_module.mjs`） |
| 插件 | `../plugins/index.html` | ✅ 已完成（`tools/build_module.mjs`） |
| 质检 | `../quality/index.html` | ✅ 已完成（`tools/build_module.mjs`） |
| 服务 | `../server/index.html` | ✅ 已完成（`tools/build_module.mjs`，接 `/api/*`） |

接入要求（四条硬约束）：

1. **必须是单文件或自带内联资产的 HTML**，双击 `file://` 能开——平台是本地应用，不能要求起 dev server。
2. **入口文件名固定**（四个模块页 `index.html`，画布 `canvas.html`，参数面板 `params.html`）。改约定要同时改 `app/index.src.html` 的 `MODULES` 表，并跑 `node tools/e2e.mjs`——它逐条断言「外壳写的探测路径，文件真的在那儿」。
3. **必须带 `data-backlink` 回程链接**（`href="../app/index.html"`）。平台的导航是外壳 → 模块的单向流，没有回程路时用户只能靠浏览器后退，而 `file://` 下后退会重解析整页（内联 200KB+）。由 `node tools/backlink.mjs` 幂等注入，`tools/lint_ui.mjs` 逐页判定。
4. **不反向依赖外壳**：模块自己读写 localStorage 时请用自己的 key 前缀，不要碰 `avp.shell.store.v1` 与 `ai-video-platform/project`。

### 一处起服务：探测从「未验证」变成「存在」

`node tools/serve.mjs` 之后，同一个端口既发 `/api/*` 也发仓库里的页面（`server/static.js`，白名单后缀、只读、不越出仓库根），于是：

| 打开方式 | 七张卡片 | 原因 |
|---|---|---|
| 双击 `app/index.html`（`file://`） | 未验证 / 尝试打开 | 浏览器禁止 `fetch` 本地文件 |
| `http://127.0.0.1:8388/app/index.html` | **存在 / 打开** | 探测是真实 HTTP 200 |

这是同一份外壳、同一份判定逻辑，差别只在协议。界面不撒谎：`file://` 下它说「未验证」，绝不说「未安装」。

### 为什么 file:// 下探测不出东西

`fetch` 相对路径在 `file://` 下属于跨源请求，Chrome/Edge 直接拒绝（`Failed to fetch`）。外壳为此做了两件事：

- 徽标显示「未验证」而不是「未安装」——失败 ≠ 不存在；
- 保留「尝试打开」按钮——点了才知道。

诚实的替代方案是经 `http://` 打开本页（由「服务」模块或任意静态服务器提供），此时 fetch 正常，徽标变成「存在」。用 `iframe` / `<link>` 探测在 `file://` 下实测不可靠：**对不存在的路径同样触发 `load`**，会给出假阳性，因此没有采用。

## 8. 已知缺口

1. **真实渲染只到「任务完成」为止**：`render` 已接到本地队列（见 §4.1），但队列在 `comfy` 不可达时走 mock，产出的是任务记录而不是画面；`review` 仍是人工动作，`export` 只写状态与清单，不搬运成片文件。质检侧的真产物链路在 `quality/`，由它补回。
2. **file:// 下模块探测恒为「未验证」**：浏览器安全模型限制，非代码缺陷；走 http 即恢复。
3. **单集/本批秒数是估算**：口径在 `core/engine.js` 头部，未用真实渲染标定；参数组合极端时会偏乐观。
4. **项目文件不做版本迁移**：`format: 1` 只有一版；将来改结构需要写 upgrade 函数，当前 `deserialize` 会直接拒掉旧格式。
5. **导入不合并**：导入一律生成新 id，不会覆盖同名项目，因此重复导入会产生副本。
6. **向导的自动推荐只按可用显存取档**：没有把"桌面已占用显存"考虑进去（`T0-low` 那档要用户自己选）。