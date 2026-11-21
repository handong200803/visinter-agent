# 09 · 视觉设计系统（暗黑玻璃拟态 · 冷银基调）

> 令牌唯一源：`ui/tokens.css`（66 个令牌）
> 自动化守门：`node tools/lint_ui.mjs`（把「像不像暗黑玻璃」变成可判定的断言）
> 适用范围：七个产物页（params / canvas / app / market / plugins / quality / server）
> 品牌显示名：**VisInter-Agent**（原「本地一体化 AI 视频平台」，仅改显示文案，不动逻辑/接口）

---

## 1. 为什么是这套

平台做的是「黑白高反差、雕塑感、古典悲剧气质」的画面。界面统一为**暗黑玻璃拟态**：
深黑 `#08080a` 上悬浮两团冷色光晕（左上蓝灰、右下紫灰），所有卡片/面板/输入/弹窗
是一层半透明白玻璃——光从玻璃后面透出来，边缘靠 1px 亮线勾勒，hover 上浮并泛一圈冷光。
**界面必须是作品的第一帧**：玻璃的「景」就是那两团光晕，没有它们 blur 透出来的只是死黑。

四条可执行原则（不是风格形容词）：

1. **玻璃面统一**：背景 `rgba(255,255,255,.06)`、边框 `rgba(255,255,255,.12)`、圆角 16px、
   `backdrop-filter: blur(20px) saturate(1.4)`、黑阴影 `0 8px 32px rgba(0,0,0,.3)` +
   顶部内亮线 `inset 0 1px 0 rgba(255,255,255,.08)`。配方抽成通用类，不各写一份。
2. **冷银唯一的光**：`--acc #c8cdd4`，高亮 `#eef1f5`。渐变/外发光的色标只许
   「中性银灰」(通道差 ≤ 28) 或「冷调」(通道差 ≤ 64 且蓝 ≥ 红)；语义暖色(琥珀/血红)
   只作边框/填充，不得进入光晕。循环动画只给「铸造中」的银粒子/烟雾加载器。
3. **hover 三件套**：背景提亮到 `.10`、边框提亮到 `.25`、上浮 `translateY(-3px)` +
   冷光 `0 0 20px rgba(180,200,230,.15)`。按钮是玻璃底 `.10` 圆角 12px，**不是实心色块**。
4. **碑铭与密排并存**：平台名/卡片标题走 `--serif` 宽字距（Cinzel + 中文宋体 fallback）；
   正文仍是 12.5px 小字号、1.6 松行高、4 的倍数间距；数字一律 tabular-nums。颗粒层保留。

---

## 2. 令牌表（`ui/tokens.css` 为准）

### 2.1 玻璃明度阶梯（半透明白膜叠在深黑上）
| 变量 | 值 | 用在哪 |
|---|---|---|
| `--bg` | `#08080a` | 应用底（双光晕落点） |
| `--bg-deep` | `#0a0a0d` | 画布凹槽 / 时间轴（比玻璃面更暗） |
| `--panel` | `rgba(255,255,255,0.06)` | 标准玻璃面（卡片/面板/弹窗） |
| `--panel2` | `rgba(255,255,255,0.04)` | 输入框 / 膜内凹槽 |
| `--panel3` | `rgba(255,255,255,0.10)` | 悬停态 |
| `--panel4` | `rgba(255,255,255,0.14)` | 按下 / 选中填充 |
| `--glass` | `rgba(255,255,255,0.06)` | 导航/顶栏/侧栏玻璃底 |

### 2.2 线条与文字
`--line rgba(255,255,255,.12)` · `--line2 rgba(255,255,255,.18)` · `--line3 rgba(255,255,255,.25)`
`--text #d4d8de` · `--text-dim #7a8089` · `--text-dim2 #565c66` —— **不用纯白**。

### 2.3 强调与状态
```
--acc #c8cdd4   --acc-hover #eef1f5   --acc-dim #8a9099   --acc-fill rgba(200,205,212,.10)
--ok #7d9b84   --warn #b3985a   --bad #6b2020   --bad-ink #c98080
--ok-fill rgba(125,155,132,.12)   --warn-fill rgba(179,152,90,.12)   --bad-fill rgba(107,32,32,.16)
```
`--bad` 是暗血红，只作边框/填充；它作文字色对比度不够，错误文案一律 `--bad-ink`。

### 2.4 光与影
```
--shadow-pop   0 8px 32px rgba(0,0,0,.3)                          玻璃托底黑阴影
--shadow-inset inset 0 1px 0 rgba(255,255,255,.08)                顶部 1px 内亮线
--glow         0 0 0 1px rgba(255,255,255,.25), 0 0 20px rgba(180,200,230,.15)   hover/焦点
--glow-soft    0 0 20px rgba(180,200,230,.08)                     常驻极淡冷外光
--glow-cool    rgba(180,200,230,.15)                              hover 冷光色
```

### 2.5 玻璃配方与环境光（通用类共用）
```
--glass-blur       blur(20px) saturate(1.4)     卡片/面板/弹窗（移动端自动降 12px）
--glass-blur-lite  blur(12px) saturate(1.3)     按钮/输入/小件
--glass-hover      rgba(255,255,255,.10)        hover 背景
--glass-line-hover rgba(255,255,255,.25)        hover 边框
--amb-blue         rgba(98,118,158,.16)         左上蓝灰环境光
--amb-purple       rgba(126,106,160,.14)        右下紫灰环境光
```

### 2.6 端口/类型色（节点图 3-4px 圆点专用，全部灰调）
`--t-model #8d84a0` · `--t-latent #a08489` · `--t-image #a09678` · `--t-number #7f948c` · `--t-text #84909f`

### 2.7 字体 / 尺寸 / 动效
```
--serif  Cinzel, Palatino Linotype, Book Antiqua, Georgia, Noto Serif SC, Source Han Serif SC, STSong, SimSun, serif
--sans   系统黑体栈（正文）   --mono 等宽栈（数字/代码）
字号 10.5 / 11.5 / 12.5 / 13.5 / 15   行高 1.6
圆角 --r 8（小件）/ --r2 12（按钮/输入）/ --r3 16（卡片/面板/弹窗）/ --r-pill 999（状态点/徽标/胶囊开关）
动效 --t-fast 90ms / --t 140ms / --t-slow 320ms（入场与铸造加载）
```
Cinzel 为本地 woff2（SIL OFL，许可证见 `assets/fonts/LICENSE-Cinzel.txt`），`@font-face` 在
tokens 基础层声明，相对路径 `../assets/fonts/…` 在 file:// 与本地服务下都成立。
中文无 Cinzel 字形，自然落宋体——碑铭感靠字距（0.14em+）与字重，不靠假字体。

### 2.8 底与颗粒（基础层）
- `html`：双冷色径向光晕叠深黑，`background-attachment: fixed`：
  `radial-gradient(56% 46% at 10% 4%, var(--amb-blue), rgba(98,118,158,0) 72%)`，
  `radial-gradient(52% 44% at 92% 98%, var(--amb-purple), rgba(126,106,160,0) 72%)`，`var(--bg)`。
  `body` 透明——模块骨架与三套主界面的 body 规则都必须保持透明，否则光晕被盖掉。
- `body::after`：`assets/grain.png`（160×160 单色噪点）repeat，`opacity .045`、
  `mix-blend-mode: overlay`、`pointer-events: none`、`z-index 9999`——胶片颗粒铺满视口。

---

## 3. 通用玻璃类与组件规范

配方只此一份（`ui/tokens.css` 底部），组件直接挂类，不各写一份玻璃配方：

| 类 | 配方 |
|---|---|
| `.glass-card` | `--panel` 底 + 1px `--line` + `--r3` + `±backdrop-filter:--glass-blur` + `--shadow-pop,--shadow-inset` |
| `.glass-card.hoverable` | hover：`--glass-hover` 底 + `--glass-line-hover` 边 + `translateY(-3px)` + `0 0 20px --glow-cool` |
| `.glass-btn` | `rgba(255,255,255,.10)` 底 + 1px `--line` + `--r2` + `±blur-lite`；hover `.14` 底 + 亮边 + `--acc-hover` 字 + 冷光 |
| `.glass-input` | `--panel2` 底 + 1px `--line` + `--r2` + `±blur-lite`；focus 亮边 + `--glow` |
| `.glass-modal` / `.glass-toast` | 弹窗与吐司：`--panel` 底 + 1px `--line` + `--r3` + `±--glass-blur` + `--shadow-pop/inset` |
| `.glass-toolbar` | 悬浮横条（画布/参数板顶部）：`margin 12–16px` + `--r3` + 玻璃面 + `--shadow-pop` |
| `.glass-rail` | 侧栏/导航栏：从贴边条改悬浮板（`margin 16px` + `--r3` + `±--glass-blur`） |
| `.glass-well` | 膜内凹槽（画布底、日志、代码块）：`--bg-deep`/`--panel2` 底，**不铺毛玻璃** |
| `.glass-chip` | 胶囊标签/状态徽：`--r-pill` + 玻璃面 + 1px `--line` |

### 3.1 样式通道（三层，全部构建期内联）

| 层 | 文件 | 进产物的方式 | 管什么 |
|---|---|---|---|
| 令牌层 | `ui/tokens.css` | 源件 `/*__TOKENS__*/` 占位，构建器整块内联 | `:root` 69 个变量 + 基础层（光晕底/噪点/滚动条/焦点环）+ 9 个 `.glass-*` 通用类 |
| 皮肤层 | `ui/glass-skin.css` | 源件 `/*__SKIN__*/` 占位，构建器整块内联 | 页面级映射：悬浮侧栏、圆角补齐、hover 三件套、工具条/弹窗/Toast、画布节点、表单控件、窄屏降档 |
| 外壳层 | `ui/module-ui.css` | 四模块源件 `/*__UI__*/` 占位 | 四模块共用骨架（侧栏/口径条/卡片/表格） |

- 三个主页面（`app|canvas|web/params`）与四个模块页源件都带这两个标记，**标记不许删、不许移位、标记之前不许再写 `:root`**。
- 构建器：`tools/build_app.mjs` · `tools/build_canvas.mjs` · `core/build.mjs` · `tools/build_module.mjs` · `tools/build_inspector.mjs`（验收台也走构建，源件 `inspector/index.src.html`）。
- lint 增加了两道哨兵：① 产物里必须有 `.glass-card/.glass-input` 与 `.glass-toolbar/.glass-modal`（证明两层真的内联进来了）；② 页面自有的后续 `:root` 只允许「同值复述」，同名不同值即判漂移（`--glass-blur`/`--glass-blur-lite` 的断点降档除外）。

| 组件 | 规范 |
|---|---|
| 顶栏（悬浮） | `margin 16px` + `--r3` + `--glass` 底 + `±--glass-blur` + 1px `--line` + `--shadow-pop/inset`，sticky |
| 侧栏/口径条/状态栏 | `±--glass-blur` 玻璃面 |
| 主卡片/面板/弹窗 | `.glass-card` 配方；标题碑铭体 |
| 主操作 `.btn.acc` | `--panel3` 底 + 1px `--acc-dim` 边 + `--acc-hover` 字。**不是实心色块** |
| 列表选中 | `inset 2px 0 0 var(--acc)` 左银竖线 + `--acc-fill` 极淡底 |
| 滑杆 | 轨道 `--panel4`、已选段 `--acc`、滑块 `--r` |
| 胶囊开关 | `--r-pill` 轨道 + 50% 圆钮 |
| 状态点 | 8px 圆点 `--ok/--warn/--bad` 实心；不做脉冲 |
| 滚动条 | 8px、thumb `--line2`、hover `--acc-dim`、track 透明 |
| 加载态 | 银粒子/烟雾（选择器含 forge/particle/smoke），禁彩色转圈 |
| 图标 | 内联 SVG，stroke-width 1.5，currentColor；不用 emoji（风格标签豁免，用户口径） |
| Toast/提示 | 玻璃圆角、水平居中、`--shadow-pop/inset` |

**移动端**：`@media (max-width:900px){ :root{ --glass-blur: blur(12px) saturate(1.3); } }`
自动降档，避免大面积毛玻璃拖垮帧率。所有 `backdrop-filter` 都带 `-webkit-` 前缀（Safari/旧 WebKit）。

---

## 4. 逐页面落地

- **外壳首页 app**：悬浮玻璃顶栏；输入区裹大玻璃卡；八张风格卡 `.glass-card.hoverable`；
  参数推荐面板玻璃；铸造粒子/烟雾背景 Canvas **保留**。
- **参数面板 web/params**：258 参数按板块分组，每组玻璃小卡；折叠展开走 `tierOpen`
  入场关键帧（`renderBoard` 切换时重渲染触发动画，不改 markup/JS）；滑杆/下拉/输入玻璃；
  作品库 `#wizLibList` 改网格玻璃卡，hover/focus-within 浮现操作按钮（`@media(hover:none)` 常显）。
- **画布 canvas**：节点区 `#nodeWrap` 保持 `--bg-deep` 深色；工具条悬浮玻璃；右侧属性面板
  `#nodePanel` 与估算器 `#estimator` 玻璃卡。
- **作品库/模板市场 market**：列表/详情走 module-ui `.panel/.tbl` 玻璃，自动重肃。
- **插件/质检/服务 plugins/quality/server**：共享骨架玻璃化；质检 `.q-hero`、服务 `.stat` 玻璃；
  插件 Toast 居中玻璃。
- **帧检查器 inspector**（源件 `inspector/index.src.html` → 产物 `inspector/index.html`，同样内联
  tokens + skin，不参与 lint 七页）：同套玻璃令牌，顶栏悬浮、`.sec` 玻璃小卡、时间轴/状态栏玻璃。

八张风格封面 `assets/covers/noir-01…08.jpg` 与提示词/推荐参数绑定逻辑**不变**
（数据真源 `prompt/styles.json`），仅卡片外观玻璃化。

---

## 5. 禁用清单（lint 逐条判定，命中即失败）

```
1. emoji 作图标（__MUSE 数据行 / data-emoji-ok 元素豁免，用户口径）
2. --violet / #b98bff
3. 旧荧光/旧蓝残留（#39e6c4 #6c8cff #f7c451 #ff6272 #4ade80 #0a0d13 #111621 #151b28 #202838 #4a7fd4 #5a8fe4 #2f5a9e）
4. color: #fff / #ffffff / white（纯白文字）
5. text-shadow
6. conic-gradient
7. filter: drop-shadow()
8. 彩色渐变：linear/radial-gradient 任一色标既非中性银灰(通道差≤28)也非冷调(≤64 且蓝≥红)
9. 彩色 box-shadow 外发光：同上判据（inset 选中标记/内描边除外）
10. border-radius ≥ 17px（999px 与 50% 除外；玻璃卡上限 16px）
11. animation … infinite 挂在非加载器选择器（forge/load/particle/smoke/ember/mist 除外）
```

正向要求：七产物 `:root` 与 tokens 逐字一致（66 变量）；`tabular-nums`、`:focus-visible`、
`radial-gradient(`、`grain.png`、`var(--serif)`、`backdrop-filter:`、`-webkit-backdrop-filter:`
七个在场证明；模块页回程链接。

---

## 6. 使用与验收

```bash
node tools/build_all.mjs      # 重建产物（改 src 后必须跑）
node tools/lint_ui.mjs        # 视觉 lint：令牌一致性 + 禁用 + 在场证明
node tools/selftest_all.mjs   # 全模块回归（视觉改动不得破坏结构与交互）
node tools/e2e.mjs            # 跨模块契约 + 渲染桥
```

**改界面的顺序**：改 `ui/tokens.css` → 同步 app/params/canvas 三份逐字 :root → 改组件 CSS →
跑 lint → 跑总自检 → 起服务双击人工看一遍。四模块页（market/plugins/quality/server）由
`build_module` 整文件内联 tokens.css + module-ui.css，改这两个文件即自动重肃，无需手改产物。

---

## 7. 已知取舍

1. **别名是技术债**：`--dim/--dim2/--acc2` 保留是为了少动八千行 CSS，最终应替换干净。
2. **不做亮色主题**：暗黑玻璃是唯一人格；亮色需要重新标定整套灰阶与光晕，不在范围。
3. **对比度**：`--text #d4d8de` on `#08080a` 约 12:1；`--text-dim2 #565c66` 约 3.4:1
   （仅占位/禁用）；`--bad-ink #c98080` on `--bad-fill` 约 6:1。未跑自动化 WCAG 工具。
4. **颗粒层 z-index 9999**：颗粒盖在所有 UI 之上（4.5% 透明度、不拦指针），这是胶片感的
   代价；若未来出现必须绝对干净的浮层（如取色器），再单独豁免。
5. **Cinzel 只覆盖拉丁**：中文题字落宋体栈，字形风格与 Cinzel 的碑铭感靠字距统一。
6. **玻璃性能**：大面积 `backdrop-filter` 在低端机有开销，移动端已降 blur 到 12px；
   粒子/烟雾 Canvas 与玻璃叠加时以帧率为先，必要时再减粒子数。