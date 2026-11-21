# 06 · 逐帧质检管线（quality）

> 入口：`node tools/qa.mjs run <video>` · 自检：`node quality/selftest.js`（28 项，实测全通过）
> 依赖：系统 `ffmpeg` / `ffprobe`（本机 9.0.2）· 零第三方包
> 产出：`%CACHE_ROOT%\avp\qc\out\<片名>.quality.json`（可选 `--patch-inspector` → `quality/inspector.live.html`）

---

## 1. 为什么需要它

生成式视频最贵的不是生成，是**返工**：一条 60 秒片里坏 8 帧，人眼要拉时间轴找半小时。
这条管线把「哪一帧坏了、坏在哪、怎么修」变成一次 ffmpeg 调用 + 一张分数表。

设计原则：**能算的都算出来，算不出的不猜**。
所有阈值都在 `quality/frames.js` 的 `DEFAULTS` 里带实测依据注释，代码即文档。

---

## 2. 指标口径（每次只启一次 ffmpeg 进程）

一次 `ffmpeg` 解码把画面降到 **160px 宽灰度裸帧**（720p→284 高，约 45KB/帧），
之后所有指标在 Node 里用 TypedArray 算——避免逐帧起进程（那是这类工具最大的性能坑）。

| 指标 | 算法 | 阈值 | 权重 |
|---|---|---|---|
| **锐度** `sharp` | 拉普拉斯方差，log 归一化到 `[sharpLo 6, sharpHi 400]` | 归一值 < `0.22` 判模糊 | 0.45 |
| **闪烁/跳变** `flicker` | 相邻帧 YAVG 绝对差 / `flickerHard 20` | ≥20 级（≈8% 画幅亮度）= 可感知闪/切 | 0.35 |
| **帧差残差** `flowResidual` | 相邻帧平均绝对差 / `flowRaw 3` | ≥6 级（硬切/大运动）时运动项归零 | 0.20 |
| **亮度** `yavg` | 每帧平均 luma | 黑 `≤24` / 白 `≥235`（limited range：黑=16、白=235） | 判定用 |
| **冻结** | 相邻帧差 < `staticEps 0.05` 连续 ≥ `freezeMinSec 0.1s`（30fps 即 3 帧） | 单独成段，不混进分数 | 判定用 |

综合分 `score` = `sharp*0.45 + flicker*0.35 + flow*0.20` × 100，`status` 三档：**ok ≥80 / warn ≥65 / bad <65**。

阈值为什么这么定（都在代码注释里，摘录关键几条）：
- `sharpLo/Hi` 来自实测：模糊段方差≈2.5，正常帧 130-190 → 取 log 归一化上下界 6/400
- `flickerHard 20` ≈ 8% 画幅亮度跳变，是人眼能明确察觉的闪/切门限
- `staticEps 0.05` 判定"像素级完全相同"；实测同源静帧=0，慢运动每帧 0.13 但会累计超限
- `blackY 24` = limited range 黑 16 + 8 级编码噪声余量，与 `blackdetect` 默认 `pix_th=0.10`（≈25.5）同级

**交叉验证而非覆盖**：`blackdetect` / `freezedetect` 的区间结果写进 `detect`，用来印证逐帧结论，
不替换逐帧分数——因为逐帧分数才是 inspector 要的数据。

---

## 3. 管线

```
probe.js     ffprobe → 分辨率/fps/帧数/码率/pix_fmt/色彩/HDR/音频参数；缺 ffprobe 返回错误码不抛栈
frames.js    单次 ffmpeg → 裸帧 → frameMath() 逐帧算四路指标 + 区间检测 → frames[]
report.js    汇总：均值/p5/p95/status 分布/问题段/最该重绘的 N 帧（带理由与修复建议）
export.js    quality.json + 可选把 frames[] 注入 inspector 副本（原文件 sha256 护栏）
fixtures.js  用 ffmpeg 合成 good/bad 两条测试素材（定点注入缺陷，帧号确定）
```

### 测试素材的缺陷是**定点注入**的
`fixtures.js` 的 `generateBad()` 用 `drawbox enable='gte(t,0.6666)*lt(t,0.8333)'` 这类半开区间精确命中帧号：

| 缺陷 | 注入帧号 | 手法 |
|---|---|---|
| 全屏纯黑 5 帧 | 20-24 | `drawbox c=black` + enable 区间 |
| 全屏纯白 3 帧 | 40-42 | `drawbox c=white` + enable 区间 |
| 模糊段 30 帧 | 60-89 | `gblur=sigma=14` over 平移后的 trim 段 |
| 冻结 20 帧 | 100-119 | 取第 99 帧当静帧 overlay（`eof_action=repeat`） |

生成时踩过的两个坑（都写进注释了）：`gradients` 必须固定 `seed`，否则每次素材不同、数字不可复现；
`drawbox` 在 ffmpeg 9 只认 `iw/ih`，用 `W/H` 会 Unknown function。

---

## 4. 与 inspector 的契约

`inspector/index.html` 只认五个字段，`export.contractFrames()` 保证产出侧一定带齐：

```js
{ frame, score, sharp, flicker, flowResidual, defect, status, repaired:false, extra:{yavg, lapVar, ...} }
```
`status ∈ {ok, warn, bad}`。多余指标一律进 `extra`，不污染契约。
`--patch-inspector` 生成的是**副本** `quality/inspector.live.html`，并在写盘后比对原文件 sha256，
不一致立即抛 `E_INSPECTOR_MUTATED`——原 inspector 永不被改。

---

## 5. 实测结果（`node quality/selftest.js`，本机 ffmpeg 9.0.2）

```
── 3 综合分（好片必须显著高于坏片）──
  good 均值 93.9 · p5 93 · 问题帧 0/90 (ok 90/warn 0/bad 0)
  bad  均值 64.3 · p5 14.8 · 问题帧 60/120 (ok 60/warn 0/bad 60)
  ✓ good 均值 93.9 > bad 均值 64.3     ✓ 分差 29.6 ≥ 5
── 4 缺陷定点检出 ──
  黑帧：检出 [20,21,22,23,24] 命中 5/5
  白帧：检出 [40,41,42] 命中 3/3
  冻结：检出 [100-119] 命中 20/20
── 5 锐度 ──
  bad 模糊段 60-88 平均锐度 0.000 · good 全片平均 0.907
── 性能 ──
  good 解码 90 帧 · ffmpeg 302ms · 墙钟 303ms（要求 <10000ms）
```

正常素材**零误报**（黑 0 / 白 0 / 冻结 0），坏片 60 个问题帧全部落在注入区间内。

---

## 6. 命令

```bash
node tools/qa.mjs fixtures              # 生成/复用测试素材（%CACHE_ROOT%\avp\qc\fixtures）
node tools/qa.mjs run <video>           # 单条：探针→逐帧→汇总→quality.json
node tools/qa.mjs run <video> --patch-inspector   # 另出 inspector.live.html
node tools/qa.mjs batch <dir>           # 整目录批量，出对照表 + batch.json
node tools/qa.mjs selftest              # 全量自检
```

退出码：`0` 正常 / `2` 用法错误 / `3` 分析失败 / `4` 自检失败。

---

## 7. 已知缺口

1. **模糊段锐度归零是阈值效应**：`gblur sigma=14` 把高频彻底抹平，锐度归一值到 0.000；真实轻微失焦只会掉到 0.3-0.6，`sharpBlurAt 0.22` 这个门限对「轻微虚焦」是否够灵敏**未做真机标定**。
2. **无光流**：`flowResidual` 实为帧差均值，不是真光流 warp 残差。对快速平移会把「正常大运动」误判成高残差，靠 `flowHard 6` 归零兜住，但不精确。
3. **无音频质检**：`probe` 只取音频参数，不做响度/削波/静音检测（`astats` 未接）。
4. **无色彩质检**：不做色偏、色带（banding）、gamma 异常检测；`inspector` 里的「色带断层」负向词目前没有对应指标支撑。
5. **单帧缺陷定位到帧，不定位到区域**：`defect` 只说"blur/flicker/black"，不给 bbox；框选重绘依赖人工在 inspector 里拖框。
6. **批量不做并行**：`batch` 逐条串行跑 ffmpeg，多片时可用 CPU 空闲；未做 worker 池。