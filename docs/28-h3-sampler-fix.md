# 28 · H3 采样路径修正（噪声灾难复盘）

> 2026-11-20 · 用户反馈「成片是一片纹理噪声」→ 定位为**采样器错配**，已修并真机验证。

## 1. 事故现象

质量优先改造后，H3 任务全部成功、归档正常，但成片是**整屏布纹噪声**（抽帧确认，非风格化）。
坏样本留档：`D:\云盘\04-数据\bad-samples\H3_dpmpp2m_cfg7_崩坏样本_exp_mwof6r2r_89acdc.mp4`

## 2. 根因

`server/quality.js#sampling()` 把**通用高质量参数无差别套到所有引擎**：

```
sampler = dpmpp_2m, scheduler = karras, cfg ∈ [7,10], steps ∈ [16,25]
```

而 **MiniMax H3 是音视频联合模型，官方采样路径是 `euler` + `simple`、CFG 5–7**。
强行用 DPM++ 2M Karras + CFG 7 → 扩散过程完全跑偏，输出噪声。程序无异常，所以「成功」了——这是最危险的一类 bug：**指标全绿，产物是废的**。

## 3. 修复

| 位置 | 改动 |
|---|---|
| `server/quality.js#sampling` | 引擎感知：读 `spec.engine_overrides[engine]`，覆盖 sampler/scheduler/CFG 区间；无覆盖才用通用值；返回 `engine` 与 `label` |
| `server/quality.js#workflowErrors` | KSampler 校验按引擎判定（用工作流内 UNETLoader 的 `unet_name` 推断引擎，避免调用方漏传 engine）：H3 → `euler/simple` + CFG 4–7；其它 → `dpmpp_2m/karras` + CFG 7–10 |
| `spec/quality.json` | `engine_overrides.minimax_h3` 补 `sampler: euler`、`scheduler: simple`、`cfg: [5,7]`，并写明「通用 DPM++ 2M Karras 会让 H3 输出噪声（实测）」 |

验证（`H3.build` 实测输出）：

```
sampler euler · scheduler simple · steps 20 · cfg 5 · denoise 0.65 · fps 24
Wan2.2 仍为 dpmpp_2m / karras / cfg 7（不受影响）
```

## 4. 真机验证（cine 链路）

| 项 | 结果 |
|---|---|
| 任务 | `job_mwofgqgm_c7e492`（一句话电影 → 本地 H3 回退） |
| 提示词 | 一个 24 岁的中国女孩，鹅蛋脸，黑色长直发，米色针织衫，站在窗边看雨 |
| 成片 | `exp_mwofgqgm_c7e492_job_mwofgqgm_c7e492_pure.mp4`（1.65MB / 640×384 / 24fps / AAC / 5.17s） |
| 画面 | **正常**：末帧精确对应 prompt（黑长直发女孩 + 米色针织衫 + 窗边雨景），无噪声 |
| 耗时 | `actualDurationMs` 2828s（47 分钟，含前面 H3 任务排队约 30 分钟；实际采样约 20 分钟 / 20 步） |

## 5. 遗留：60fps 增强未出

`job.enhancedError = POST_BACKEND_MISSING` —— 这份代码的 `postprocess` 是**严格版**：插帧必须用真 RIFE（`AVP_RIFE` 指向 rife-ncnn-vulkan 绝对路径 + `AVP_RIFE_MODEL` 模型目录），
否则**显式失败**，不用 ffmpeg `minterpolate` 顶替（有 selftest 断言守着）。这是对的，不假装。

要拿到 60fps 增强版，二选一：

```bash
# A) 装真 RIFE（推荐）
#    下载 rife-ncnn-vulkan Windows 版 → 解压到 D:\云盘\03-文档\tools\rife\
set AVP_RIFE=D:\云盘\03-文档\tools\rife\rife-ncnn-vulkan.exe
set AVP_RIFE_MODEL=D:\云盘\03-文档\tools\rife\rife-v4.6
node -e "require('./server/ultimate.js').postprocess({file:'<pure.mp4>',steps:['interp'],outputFps:60})"

# B) 显式接受 ffmpeg 替代（需改 postprocess 的严格校验 + selftest 断言，属于契约变更）
```

## 6. 教训

1. **「质量优先」不等于「把最高档参数套满」**：参数必须服从模型，H3 只听 euler/simple。
2. **任务成功 ≠ 产物正确**：必须在验收里加「抽帧人眼/自动核验」，否则噪声片会被当成成功归档。
3. 引擎级参数差异（采样器、CFG、帧率）应集中在 `spec/engine_overrides`，而不是散落在调用方。
