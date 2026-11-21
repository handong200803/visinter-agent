---
name: 界面视觉与文案禁令
description: 暗黑雕塑感视觉基线（高反差电影写实）、lint_ui 逐条判定的禁用清单、四模块页面骨架与文案规矩。改任何 HTML/CSS 前必读。
trigger: always_on
---

# 界面纪律（`node tools/lint_ui.mjs` 逐条判定，命中即失败）

## 唯一视觉身份

`ui/tokens.css`（69 个令牌 + 9 个 `.glass-*` 通用类）是唯一真源，构建期内联进每个页面。**不许手写第二份变量表**：
源件只写 `/*__TOKENS__*/`（令牌层）与 `/*__SKIN__*/`（`ui/glass-skin.css` 皮肤映射层）两个占位标记，构建器整块内联；
标记之前不许再写 `:root`，标记之后只允许「同值复述」，同名不同值即被 lint 判为令牌漂移（`--glass-blur` 断点降档除外）。
细则见 `docs/09-design-system.md §3.1`。

视觉人格：**暗黑玻璃拟态 · 冷银基调**。深黑 `#08080a` + 两团冷色径向光晕（左上蓝灰 / 右下紫灰）+ 极细噪点颗粒，
让玻璃「有东西可透」；冷银 `#c8cdd4` 是唯一强调（hover `#eef1f5`）；所有卡片/面板/输入/弹窗 =
`semi-transparent white .06` + `1px rgba(255,255,255,.12)` + 圆角 16 + `backdrop-filter: blur(20px) saturate(1.4)`
+ `0 8px 32px rgba(0,0,0,.3)` + `inset 0 1px 0 rgba(255,255,255,.08)`；文字主 `#d4d8de` 次 `#7a8089`，
**绝不用纯白**。平台名与卡片标题走 `--serif`（Cinzel + 中文宋体 fallback）宽字距碑铭体。

## 禁用清单（命中即 lint 失败）

```
1. emoji 作图标（U+1F300–U+1FAFF）         图标一律内联 SVG，stroke-width 1.5，currentColor
2. --violet 变量 / #b98bff                 AI 紫
3. 旧荧光/旧蓝残留 #39e6c4 #6c8cff #f7c451 #ff6272 #4ade80 #0a0d13 #111621 #151b28 #202838 #4a7fd4 #5a8fe4 #2f5a9e
4. color: #fff / #ffffff / white           纯白文字（冷白上限 --acc-hover）
5. text-shadow                             文字发光
6. conic-gradient                          彩色转盘加载器
7. filter: drop-shadow()                   光晕统一走 box-shadow 银光令牌
8. 彩色渐变：linear/radial-gradient 色标通道差 > 24   渐变只许在银灰阶内走（深黑→炭灰）
9. 彩色 box-shadow 光晕：色标通道差 > 24（inset 选中标记除外）  光只能是银或黑
10. border-radius ≥ 17px（--r-pill 与 50% 除外）       玻璃圆角上限 16px
11. animation: … infinite 挂在非加载器选择器上        循环只给铸造加载器（forge/load/particle/smoke/ember/mist）
```

允许且鼓励：`backdrop-filter: blur()` 只给顶栏/侧栏/口径条的暗玻璃；`filter: blur()` 给烟雾粒子；径向渐变底与噪点层。

## 正向要求（lint 会查）

- 七个产物的 `:root` 必须包含 `tokens.css` 全部令牌且取值一致。
- 产物里必须能查到通用玻璃类（`.glass-card` / `.glass-input`）与皮肤层（`.glass-toolbar` / `.glass-modal`）——证明两层都内联成功。
- 移动端必须有 `@media (max-width:900px){:root{--glass-blur:blur(12px) saturate(1.3)}}` 降档。
- 必须出现 `tabular-nums`、`:focus-visible`、`radial-gradient(`、`grain.png`、`var(--serif)`、`backdrop-filter:` ——tokens 基础层与 module-ui 已含，别删。
- 每个模块页必须有「← 工作台」回程链接，指向 `../app/index.html`（`tools/backlink.mjs` 幂等注入，`--check` 只查不写）。

## 四模块页面骨架（`ui/module-ui.css`）

顶栏（碑铭标题 + 口径条）/ 左列表 / 右详情 / 底部口径条，六个必备件：标题、一句话口径、真实数据区、主操作、空态说明、回程链接。
骨架类名必须复用 `module-ui.css`，不许每页自造一套。选中态 = 左 2px 冷银竖线（`inset 2px 0 0 var(--acc)`），不做亮色填充。按钮 = 深灰底 + 1px 银边 + 冷白字，hover 银边发光；主操作 `.btn.acc` 是银边更亮的深灰碑牌，不是实心色块。

## 文案规矩

- 不写「即将支持 / 敬请期待 / TODO 占位」这类死文案——`e2e` 会扫。
- 不写没有出处的时间/显存/分数；估算值必须标 `estimate`。
- 空态要说清「为什么空 + 怎么填」，不要只放一个图标。
- 中文为主，单位用 `s / GB / MiB` 这类短符号，不写「约莫」「大概」。
- 生成主操作文案统一「铸造画面」；加载态是银粒子/烟雾，不是彩色转圈。

## 三套界面的定位（别把三者做成一样）

| 页面 | 定位 | 不许变成 |
|---|---|---|
| `app/index.html` 外壳 | 唯一入口：风格圣殿八卡 + 向导 + 七模块卡片 + 项目状态机 | 参数编辑器 |
| `web/params.html` 参数工作台 | 258 参数 / 7 板块 + 四向预估（显存/耗时/质量/成本） | 节点图 |
| `canvas/canvas.html` 三视图画布 | 向导 / 参数 / 节点（含 Shift 框选），同源同数据 | 另一个参数表 |

改完必跑 `node tools/build_all.mjs && node tools/lint_ui.mjs`，7 页全绿才算完。