# 05 · 逐帧检视器（inspector）

> 产物：`inspector/index.html`（单文件、`file://` 双击可用）· 源件：`inspector/index.src.html`
> 构建：`node tools/build_inspector.mjs`（`tools/build_all.mjs` 第 30 项）· 自检：无独立自检，由 `quality/selftest.js` 校验字段契约
> 契约方：`quality/frames.js` 产出 `frames[]` → `quality/export.js` 注入副本
> 本文只写仓库里能找到依据的东西；找不到的一律标「未实现」或「未核实」，并给依据位置。

---

## 1. 定位与入口

`inspector` 是平台分层里的 **L3 交互层**（`docs/01-architecture.md` §2 第 23 行：「L3 交互层 canvas/ web/ inspector/ quality/live」）。
它负责一件事：把 `quality/` 算出来的逐帧分数变成**可看、可点、可改**的画面
（`docs/01-architecture.md` 第 54–56 行的数据流：生成产物 → `quality/` → `frames[]` → inspector 逐帧擦洗／框选重绘／A/B）。

| 项 | 事实 | 依据 |
|---|---|---|
| 产物形态 | 单文件 HTML，无外链、无网络请求 | `inspector/index.html`（68 KB，实测 69 730 字节） |
| 源件 | `inspector/index.src.html`（含 `/*__TOKENS__*/` `/*__SKIN__*/` 两个占位符） | `tools/build_inspector.mjs:19-31` |
| 构建做什么 | 把 `ui/tokens.css` 与 `ui/glass-skin.css` 内联进源件；缺占位符直接抛错 | `tools/build_inspector.mjs:25-36` |
| 为什么走构建 | 「它是界面视觉验收台的活样本，必须和七个界面吃同一份令牌」 | `tools/build_inspector.mjs:5-8` |
| 产物在总构建里 | `build_all` 第 30 项 `id:'inspector'`，label「视觉验收台」 | `tools/build_all.mjs:30` |
| 浏览器要求 | Chrome / Edge（Canvas2D + `ctx.filter`，需 Chromium 内核） | `inspector/README.md:7` |
| 尺寸守门 | 集成 e2e 检查 `inspector/index.html` 可探测且 ≥20 000 字节 | `tools/e2e.mjs:63` |

三条入口：

1. **双击** `inspector/index.html`（`file://` 直开，README:5-7）。
2. **外壳内**：`app/` 的模块表登记 `probe: '../inspector/index.html'`，侧栏「帧检查器 ◐」切换过去
   （`app/index.src.html:746`、`:979-981`）。
3. **HTTP**：`node tools/serve.mjs` 后访问 `/inspector/index.html`（e2e 用的就是这条路径，`tools/e2e.mjs:63`）。

两处**不在**覆盖范围，别误以为有守门：

- **不在视觉 lint 的 7 页里**：`tools/lint_ui.mjs:26-34` 的 `TARGETS` 只有 params / canvas / app / market / plugins / quality / server 七个，没有 inspector。
- **不在回程链接契约里**：`tools/e2e.mjs:107` 明确 `if (e.id === 'inspector') continue; // 帧检查器是早期独立产物，未纳入回程契约`；
  `docs/08-shell.md:126` 记为「✅ 早期独立产物，未纳入回程链接契约」。

---

## 2. `frames[]` 五字段契约

这是整个 inspector 唯一的数据接口，**改字段名等于改接口**（`docs/01-architecture.md:99`）。

| 字段 | 类型 / 值域 | 含义 | 谁产出 | 产出位置 |
|---|---|---|---|---|
| `score` | `int`，`1..99` | 0–100 综合质量分；结构性缺陷封顶（黑 10 / 白 15 / 模糊 45 / 亮度跳变 60 / 冻结 30） | `quality/frames.js` 逐帧打分 | `quality/frames.js:243-253`、`:297` |
| `sharp` | `number`，`0..1`（保留 4 位） | 锐度：拉普拉斯方差对数归一化，越大越锐 | `quality/frames.js` `frameMath()` | `quality/frames.js:238`、`:258` |
| `flicker` | `number`，亮度级（保留 2 位） | 闪烁：与前一帧 `YAVG` 绝对差，`≥20` 判可感知闪/切 | 同上（读 `signalstats` 的 YAVG） | `quality/frames.js:236`、`:259` |
| `flowResidual` | `number`，`0..0.32`（保留 4 位） | 帧差残差：下采样灰度帧相邻平均绝对差按 `flowRaw` 映射（**不是真光流**，见 §5） | 同上 | `quality/frames.js:239`、`:260` |
| `status` | `'ok' \| 'warn' \| 'bad'` | 三档：`ok ≥ 80 / warn ≥ 65 / bad < 65` | 同上 | `quality/frames.js:253`（阈值表 `:335`） |

**契约方向是单向的**：`frames.js` 出数 → `export.contractFrames()` 补齐字段 → 以 JSON 字面量注入 inspector 副本 → inspector 只读、不写回。

契约外的字段由 `export.contractFrames()` 附加，**不算五字段**（`quality/export.js:34-46`）：

| 字段 | 说明 |
|---|---|
| `frame` | 帧号（与数组下标同值，`quality/frames.js:256`） |
| `defect` | `blur / dark / white / flicker / freeze / null`，结构性缺陷类型（`quality/frames.js:247-251`、`:298`） |
| `repaired` | 注入时恒为 `false`（`quality/export.js:43`）；页内修复后由前端置 `true` |
| `extra` | 原始指标与理由：`yavg / ymin / ymax / satavg / ydif / lapVar / meanAbsDiff / diffAnchor / reasons / freeze`（`quality/frames.js:264-274`） |

契约的**双向校验**在质检自检里，`quality/selftest.js:127-133`：
`contractFrames` 键齐全 → inspector 侧五个字段齐全 → 产出侧含 inspector 需要的全部字段。
另见 `docs/06-quality.md` §4（第 70-79 行）与 `docs/01-architecture.md` §5.3。

**页面默认数据是演的，字段是真的。** `inspector/index.src.html:292-312` 用 `Array.from` 生成 120 条演示记录，
缺陷定点在 `DEFECT = {37:'blur', 38:'blur', 61:'flicker', 62:'blur', 97:'dark'}`，
但每条记录的形状与上面五字段完全一致；真数据靠 §4 的注入流程替换（`inspector/README.md:28-35` 只把这件事叫「数据是假的，接口是真的」）。

---

## 3. 问题帧标注与修复对比

### 3.1 标注怎么画出来

| 元素 | 实现 | 依据 |
|---|---|---|
| 质量热力条 | Canvas，逐帧画柱高 `3..24px`（按 `score/100`）；色值 `ok=rgba(61,220,151)` / `warn=rgba(255,180,84)` / `bad=rgba(255,92,122)`，与蓝图 `#3DDC97 / #FFB454 / #FF5C7A` 一一对应 | `inspector/index.src.html:701-711`；蓝图 `docs/00-blueprint-v1.0.md:858` |
| 已修复 | 该帧柱条改灰白 `#c8cdd4` | `inspector/index.src.html:706` |
| 三条叠加曲线 | 锐度（`f.sharp`）、帧差残差（`1 - flowResidual/0.32`）、亮度（**合成公式**，见 §5-3） | `inspector/index.src.html:729-740` |
| 锚点 ◆ | 时间轴顶部三角标记，`anchors` 集合 | `:713-717`、`:313` |
| 锁定 | 曲线区小方框标记，`locked` 集合 | `:749-753`、`:314` |
| 问题帧画面表现 | `defect==='blur'` → 渲染时整帧模糊（`quality:0.34`）；`dark` → `0.72` + 30% 黑罩；`flicker` → 17% 白罩 | `:598-612` |

### 3.2 修复 / 对比的交互

| 交互 | 操作 | 实际发生了什么 | 依据 |
|---|---|---|---|
| 框选 | 画面上拖框 → 虚线选区 + 「选区 W×H」 | 只存 `S.selection`，用于重绘提示与 toast 文案；**不产生 mask 图** | `:828-855`、`:846` |
| 单帧重绘 | 按钮「重绘选区」或 `R` | 80ms/步的扫光动画 → 就地改 `sharp/flicker/flowResidual/score/status/repaired`，`calls+1`、`cost+0.06`；已达标帧（`score≥93 && !defect`）直接拒绝 | `:861-892` |
| 批量修复 | 按钮「一键修复全部问题帧」 | 每 320ms 处理一个 `status!=='ok'` 的帧，逐帧跳转 + 重绘 | `:893-910` |
| A/B 对比 | 「对比模式」拖动分屏线（限制 `0.12..0.88`） | 左半渲染当前帧，右半渲染 **当前帧 +7** 且 `quality:1` | `:619-622`、`:837-841` |
| 差异热图 | 「差异」开关 | 在 240×135 上取两个 `drawScene` 的 `ImageData` 逐像素求 `abs(ΔR)+abs(ΔG)+abs(ΔB)`，着色后叠加右半屏 | `:663-687` |
| 洋葱皮 | 「洋葱皮」开关 | 以 `alpha .3` 再叠一帧 `f-1`，判运动是否连贯 | `:613-617` |
| 实时显影 | 首屏 280ms 后自动跑一次，或按钮 | `setInterval` 46ms 步进，5 段文案「排队中→语义理解→生成中→高清解码→后处理」，结束 `calls+1`、`cost+0.38` | `:911-930`、`:985` |
| 锚点 / 锁定 / 导出 | 按钮或 `A` | 锚点、锁定进集合；**导出只弹 toast「已导出 PNG（3072×1728 精修版）」，没有落盘** | `:948-950` |
| 引擎切换 | 右上开关 | 只改面板文案（MiniMax H3 ↔ 本地 ComfyUI）与成本口径，**不调用任何 provider** | `:951-956` |

快捷键（`:969-981`）：`空格` 播放 / `←→` 逐帧 / `Shift+←→` 跳 10 帧 / `R` 重绘 / `A` 设锚点 / `1-4` 切 `play·inspect·repair·compare` 四模式。
四种模式的提示文案在 `:932-941`，与蓝图 §40 的四模式设计对应（`docs/00-blueprint-v1.0.md:839-846`）。

**修复结果不落盘**：`frames[]` 是闭包内的普通数组，没有任何 `fetch`／写文件／回写 `quality.json` 的代码；
刷新页面即回到演示数据。要「修完留存」，目前只能在 `quality.json` 里改后重跑导出（未实现，见 §6-7）。

---

## 4. 与 `quality/` 质检管线的关系

```
视频 ─► quality/probe.js    ffprobe：分辨率/fps/帧数/码率/pix_fmt/色彩/音频参数
     ─► quality/frames.js   单次 ffmpeg 解码 → 160 宽灰度裸帧 → 逐帧四路指标 → frames[]
     ─► quality/report.js   汇总（均值/p5/p95/问题段/最该重绘的 N 帧）
     ─► quality/export.js   quality.json ＋ 可选 --patch-inspector → quality/inspector.live.html
                                   │
                                   └─► inspector 只读 frames[] 渲染热力条与曲线
```

| 环节 | 事实 | 依据 |
|---|---|---|
| 生成副本的命令 | `node tools/qa.mjs run <video> --patch-inspector` | `docs/06-quality.md:109`、`tools/qa.mjs:41` |
| 副本路径 | `quality/inspector.live.html`（仓库里已有该产物，74 143 字节 / 72 KB） | `quality/export.js:26` |
| 注入锚点 | 源产物里 `/* ================= 帧质量模型（演示数据） ================= */` 到 `const anchors = new Set(` 之间整块替换 | `quality/export.js:30-31` |
| 三处注入 | ① `const N/FPS` 改成真值 ② 帧质量模型整块换成真 `frames[]` 字面量 ③ 「生成完成 · 120 帧已就位」文案改成真实帧数 | `quality/export.js:8-11`、`:68`、`:76-84`、`:87` |
| 护栏 | 写盘前后各算一次原文件 sha256，变了就抛 `E_INSPECTOR_MUTATED`；只写副本，原文件永不被改 | `quality/export.js:100-104`、`:5-6` |
| 注入后自检 | 字面量能被 `JSON.parse` 回读、长度等于帧数、`const anchors = new Set(` 与 `</html>` 仍在 | `quality/export.js:89-95` |
| 分工 | `quality/index.html` 只展示汇总，「`frames[]` 不进快照，逐帧看数据请开 `../inspector/index.html`」 | `quality/README.md:83-84` |
| 缺帧口径 | 容器声明帧数与实际解码帧数不一致时，写进 `summary.frame_count_mismatch`，不静默 | `quality/export.js:126-128` |

---

## 5. 性能口径

| 项 | 事实 | 依据 |
|---|---|---|
| 页内帧数 | `N = 120`，`FPS = 24` → 覆盖 5 秒窗口 | `inspector/index.src.html:281` |
| 画布尺寸 | 逻辑 960×540（`FW/FH`），实际按容器尺寸重算；`DPR` 上限 2 | `:281-282`、`:582-594` |
| 渲染方式 | 双 Canvas（主画面 `#frame`、时间轴 `#timeline`）；单帧先画到离屏 canvas 再加 `filter`（模糊/灰度/对比），**DOM 不参与逐帧刷新** | `:577-580`、`:563-575` |
| 擦洗延迟 | 页面自测：`seek()` 用 `performance.now()` 包围 `drawAll()`，结果写进状态栏「擦洗延迟 xx ms」 | `:817-822`、`:271` |
| 播放 | `requestAnimationFrame` 累加，按 `1000/FPS` 步进，不靠 `setInterval` | `:799-814` |
| 显影动画 | `setInterval` 46ms；所有高亮走 canvas 内绘制，toast 走 `transform` | `:911-930`、CSS `.toast` 用 `transform` |
| 抽帧策略 | **inspector 不抽帧**：它吃的是 `quality/frames.js` 给出的全片逐帧结果；120 只是演示数据的窗口长度 | `quality/frames.js:217-277` |
| 质检侧开销口径 | 一次 ffmpeg 解码全部算完，实测 good 90 帧 `ffmpeg 302ms / 墙钟 303ms`（**这是质检管线的数，不是 inspector 的数**） | `docs/06-quality.md:96-98` |
| README 的 1.8ms/帧 | `inspector/README.md:15` 自报「40 帧 72ms」，仓库内**没有**对应的采样快照（`docs/state/` 无 inspector 条目）→ **未核实** | `inspector/README.md:37-42` |
| 蓝图目标 | 「120 帧首屏渲染 <120ms，擦洗延迟 <16ms」——前者无采样记录（未核实），后者页面可现场读 `sLat` | 蓝图 `docs/00-blueprint-v1.0.md:876` |
| 窄屏 | 只有一个空的媒体查询壳 `@media (max-width:900px){}`，**没有适配规则** | `inspector/index.src.html:16` |

---

## 6. 已知限制

1. **画面是程序化绘制的，不是真实帧位图。** `drawCore()` 逐帧画「黄昏雨后湖面」，`drawScene()` 只负责加模糊/灰度；
   真机要替换成 `drawImage(当前帧位图)` 或 `HTMLVideoElement` 抽帧，UI 层零改动（`inspector/index.src.html:342`、`:564-575`；`inspector/README.md:32-33`）。**未实现真帧显示**。
2. **默认 `frames[]` 是演示数据**，缺陷帧号写死在 `DEFECT`（`:293`）。真数据必须跑 `--patch-inspector` 生成副本，否则看到的是演的。
3. **亮度曲线不是 `yavg`**：热力条下方第三条曲线用 `0.45 + sin(i*0.21)*0.13` 合成，仅对 `flicker` 帧抬高
   （`:733-740`）。真数据副本里 `extra.yavg` 虽然存在，但页面**没有读它**。
4. **A/B 的 B 侧不是「修复前 vs 修复后」**：右半屏固定渲染 `当前帧 + 7` 且 `quality:1`
   （`:619-622`），是「清晰版对照」，开关本身不改变任何 `score`。
5. **导出 PNG 未实现**：按钮只弹 toast（`:950`），没有 `toBlob`／`download`／写文件。
6. **引擎切换不接后端**：只改文案与成本数字（`:951-956`），没有请求 `server/providers/`。
7. **修复不持久化**：改动只在内存里的 `frames[]`，刷新即失（§3.2）；也没有回写 `quality.json` 的接口。
8. **框选不生成 mask**：选区只影响 toast 文案（`:881`），没有真实局部重绘通道；
   质检侧同样「`defect` 只说 blur/flicker/black，不给 bbox」（`docs/06-quality.md:124`）。
9. **无 IndexedDB／低清代理／±30 帧窗口缓存**：蓝图 §42 的这一条未实现（`docs/00-blueprint-v1.0.md:874`；全仓无 `IndexedDB` 命中）。
10. **无视觉守门**：`lint_ui` 的 7 页不含 inspector（`tools/lint_ui.mjs:26-34`），样式漂移只能靠人看。
11. **`flowResidual` 名不副实**：它是帧差均值，不是光流 warp 残差（`docs/06-quality.md:121`），页面上的曲线因此只作趋势参考。
12. **长片未验证**：120 帧窗口 + 单 canvas 的观感未在长片（数千帧）上测过——**未核实**，仓库内无对应记录。

---

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `inspector/index.src.html` | 唯一真源（改这里再重建） |
| `inspector/index.html` | 构建产物（禁止手改） |
| `tools/build_inspector.mjs` | 构建器（内联 tokens + glass skin） |
| `quality/frames.js` | `frames[]` 的生产者，指标与阈值唯一出处 |
| `quality/export.js` | `contractFrames()` + `--patch-inspector` 注入与 sha256 护栏 |
| `quality/inspector.live.html` | 注入真数据后的副本（生成物） |
| `inspector/shot-00-main.png` · `shot-01-problem-frame.png` · `shot-02-repaired-compare.png` | 主界面 / 问题帧（质量 52）/ 重绘后 A/B（52 → 92）截图（`inspector/README.md:45-47`） |
| [`06-quality.md`](06-quality.md) | 质检口径与缺口（§4 契约、§7 已知缺口） |
| [`14-blueprint-gap.md`](14-blueprint-gap.md) | 蓝图与实现的逐节偏差（本模块对应 §40/§41/§42） |
| [`01-architecture.md`](01-architecture.md) | §5.3 帧质检记录契约（五字段的正式出处） |
