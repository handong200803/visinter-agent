# quality/ —— 质检入口（页面）与快照生成

> 产物：`quality/index.html`（单文件，`file://` 双击可用，零第三方依赖）
> 源件：`quality/quality.src.html`（含 `/*__TOKENS__*/` `/*__UI__*/` `/*__SNAP__*/` 三占位符）
> 快照：`quality/snapshot.json`（由 `tools/snap_quality.mjs` 生成，页面上的每个数字都出自这里）
> 逻辑层：`probe.js` / `frames.js` / `report.js` / `export.js` / `fixtures.js` / `selftest.js`（本文档不改它们）

---

## 1. 构建

```bash
node tools/snap_quality.mjs            # 1. 跑真实管线，落 quality/snapshot.json（--force 重造测试素材）
node tools/build_module.mjs quality    # 2. 拼装产物 quality/index.html
node tools/lint_ui.mjs                 # 3. 视觉 lint，必须 0 失败
node quality/selftest.js               # 4. 逻辑层自检，应当 28 项全过
```

第 2 步用全平台统一的 `tools/build_module.mjs`（TOKENS / UI / SNAP 三占位符 + 快照校验 + `</script` 护栏）。

> 历史说明：这个构建器一度因为自身文档注释里的占位符字面量提前闭合块注释而 `node --check` 失败，
> 本轮临时写了 `quality/build_entry.mjs` 等价替代；构建器修好后已删除，构建路径回到唯一一条。

---

## 2. 页面读什么

`window.__SNAP` 就是 `quality/snapshot.json` 的原文，结构：

| 字段 | 用途 |
|---|---|
| `mode` / `mode_note` / `mode_caveat` | `real` 或 `synthetic`，顶部徽标与底部口径条都读它 |
| `generated_at` | 口径条的「生成时间」 |
| `env` | ffmpeg / ffprobe / `FFMPEG_BIN` / `FFPROBE_BIN` / 缓存目录，排障用 |
| `samples[]` | 每个样片的 `verdict` / `summary`（mean·p5·p95·min·max·status·segments·worst）/ `checks[]` / `detect` / `probe` / `coverage` |
| `thresholds.items` | `DEFAULTS` 全量（17 项：键、值、分组、含义、备注） |
| `thresholds.extra` | 派生常量（权重、三档切点、封顶分、anchorEps 等） |
| `cross_check` | 坏片的注入帧号 vs 检出帧号对照 |
| `gaps` | `docs/06-quality.md` §7 的 6 条已知缺口 |
| `capabilities` | 已实现 / 未实现的检查项清单（降级态下唯一能显示的内容） |

页面不发起任何网络请求，不读 localStorage 之外的任何东西；选中态写在 `avp.quality.sample.v1`。

---

## 3. 两种模式，不混

| 模式 | 触发条件 | 页面表现 | 数字来源 |
|---|---|---|---|
| `real` | 本机 ffmpeg 与 ffprobe 都能跑，`fixtures.generate()` 成功 | 总判/分数/检查项/时间轴/最差帧全部渲染 | 真实解码：fixtures 合成 → ffprobe → 单次 ffmpeg 逐帧分析 → `report.build()` |
| `synthetic` | 探测不到 ffmpeg/ffprobe，或素材合成、分析任一环节失败 | 顶部「本页为口径说明，真实报告需本机 ffmpeg」+ 恢复路径 | 只有 `DEFAULTS`、报告结构与缺口清单，**不含任何帧号与分数** |

降级由 `tools/snap_quality.mjs` 自己判定并写进快照，页面不猜。
`FFMPEG_BIN` / `FFPROBE_BIN` 是 `fixtures.js`、`frames.js`、`probe.js` 共同支持的覆盖入口：

```bat
set FFMPEG_BIN=D:\path\to\ffmpeg.exe
set FFPROBE_BIN=D:\path\to\ffprobe.exe
node tools/snap_quality.mjs
```

测试素材按管线约定落在 `%CACHE_ROOT%\avp\qc\fixtures`（缓存区，不进云盘）。

---

## 4. 页面口径（不在代码里的那几条规则）

1. **总判**：`bad > 0 → 不通过`；`bad = 0 且 warn > 0 → 有警告`；`bad = 0 且 warn = 0 → 通过`。
   逐帧三档切点（`ok ≥ 80 / warn ≥ 65`）来自 `frames.js:253` 与 `inspector` 前端一致，总判只是把计数翻成一句话。
2. **时间段配色**：段内均分 `< 65` 用 `--bad`，`65–79` 用 `--warn`。段本身来自 `report.js` 的 `segments()`（同缺陷连续帧合并）。
3. **时间列**：`帧号 ÷ fps` 推算，用于阅读定位；真实时间戳在 `probe.duration` 与 `detect` 的区间里。
4. **检查项状态**：`达标`（未命中）/ `命中`（命中结构性缺陷）/ `注意`（元数据回退或 fps 不一致）/ `未实现`（管线没有这项能力）。
   结构性缺陷不设「警告」档：黑帧 1 帧就是事故。
5. **音频静音**标「未实现」而不是「通过」：`probe.js` 只取音轨参数，`astats` 未接（`docs/06-quality.md` §7-3）。

---

## 5. 已知限制

- **样片是合成的**：`fixtures.js` 用 ffmpeg 现场生成（缺陷定点注入、帧号已知），不是真实拍摄/生成影片。
  阈值在真机素材上的灵敏度见 `docs/06-quality.md` §7-1（`sharpBlurAt` 对轻微虚焦未标定）。
- **快照是构建期固化的**：换了片子或改了 `DEFAULTS` 都要重跑 `tools/snap_quality.mjs`，页面不会自己更新。
- **页面只展示汇总**：`frames[]`（逐帧契约）不进快照，逐帧看数据请开 `../inspector/index.html`
  （已有模块；`node tools/qa.mjs run <video> --patch-inspector` 生成的副本是 `quality/inspector.live.html`）。
- **窄屏**：≤1100px 时左栏改为顶部横排，时间轴按百分比定位，不产生横向滚动。