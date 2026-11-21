# Frame Inspector · 逐帧检视交互原型

对应设计文档 §40《帧检查器（Frame Inspector）》。单文件、零依赖，双击即开。

## 打开

`index.html` 用 Chrome / Edge 打开（Canvas2D + `ctx.filter`，需 Chromium 内核）。

## 已实现的交互

| 能力 | 操作 |
|---|---|
| 质量热力条（120 帧） | 底部色带，绿=合格 橙=临界 红=异常，点击/拖拽直达任意帧 |
| 三条叠加曲线 | 亮度 / 锐度 / 光流残差，一眼定位闪烁与糊帧 |
| 逐帧擦洗 | 拖动时间轴或 ←/→，实测 **1.8ms/帧**（40 帧 72ms） |
| 实时显影 | 首屏自动跑一次：噪点→扫描线→成形，显示 5 段真实阶段文案 |
| 框选重绘 | 画面上拖框 → 「重绘选区」/`R` → 该帧质量分当场跳升，热力条变青 |
| 批量修复 | 「一键修复全部问题帧」逐个重绘 |
| 洋葱皮 | 叠加前一帧，看运动是否连贯 |
| A/B 对比 | 拖动分屏线，可开差异热图（逐像素差值着色） |
| 引擎切换 | 右上开关：MiniMax H3 ↔ 本地 ComfyUI（含调用数/成本变化） |
| 锚点 / 锁定 / 导出 | 帧级操作，锚点在时间轴顶部以 ◆ 标记 |

快捷键：`空格` 播放 · `←/→` 逐帧 · `Shift+←/→` 跳 10 帧 · `R` 重绘 · `A` 设锚点 · `1-4` 切模式

## 数据是假的，接口是真的

改这三处即可接真后端：

1. `frames[]` —— 120 条帧质量记录（`score/sharp/flicker/flowResidual/status`），
   真实数据来自质检管线（拉普拉斯方差 / 帧间亮度差 / 光流 warp 残差）。
2. `drawCore()` —— 现在是程序化绘制的演示画面；
   真机替换为 `drawImage(当前帧位图)` 或 `HTMLVideoElement` 抽帧即可，UI 层零改动。
3. `runReveal()` —— 现在用定时器模拟进度；
   真机替换为 ComfyUI `/ws` 的 `progress` + latent preview，或 H3 的调用状态回调。

## 性能口径

- 时间轴与热力条走 Canvas 绘制（DOM 会卡）
- 擦洗延迟目标 <16ms，实测 1.8ms/帧
- 所有动效仅用 `transform/opacity`，无 layout thrash

## 截图

- `shot-00-main.png` 主界面
- `shot-01-problem-frame.png` 问题帧（模糊帧，质量 52）
- `shot-02-repaired-compare.png` 重绘后 + A/B 对比（52 → 92）