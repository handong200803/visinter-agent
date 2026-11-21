# 23 · 补齐记录（Wan2.2 / 可执行画布 / 真机贝叶斯 / 真机消融 / 回填）

> 承接 `docs/18` 的 65% 评估：本轮补四项硬缺口。数据全部来自本机真跑，不是估算。

## 1. Wan2.2 TI2V-5B 本地部署（§1 从"部分"→"完成"）

| 项 | 内容 |
|---|---|
| 来源 | `ModelScope: Comfy-Org/Wan-2.2`（hf-mirror 对该文件限速 1.3 MB/s，换 ModelScope 后 10–12 MB/s） |
| 权重 | `wan2.2_ti2v_5B_fp16.safetensors` **9.4 GB** + `umt5_xxl_fp8_e4m3fn_scaled.safetensors` **6.3 GB** + `wan2.2_vae.safetensors` **1.4 GB** |
| 位置 | `ComfyUI/models/{diffusion_models,text_encoders,vae}` |
| 踩坑 | 第一版下载留下 **207 MB 残片**，脚本用 `-s` 只判非空就 SKIP → 已改为「<1 GB 视为残片并删除重下」 |
| 真机验证（小尺寸） | **320×480 / 17 帧 / 6 步 → 110 秒出片**：`output/wan/t2v_00001_.mp4`（Wan 节点自动上采样到 640×960，17 帧 = 0.71s @24fps），已归档到成片库 |
| 真机验证（大尺寸） | 640×480 / 49 帧 / 20 步：KSampler 跑通并产出 `wan/latent_00001_.latent`（11.9 MB），但 **VAEDecode 解码 49 帧超过 28 分钟**（8G 显存 + 16G 内存反复换入），实测判定为不可接受 → 8G 卡上 Wan 建议 ≤17 帧 / 短边 ≤480 |
| 启动日志关键发现 | `comfy_kitchen backend cuda: disabled` —— 当前 torch **2.11.0+cu128**，而 ComfyUI 要求 **cu130** 才启用优化 CUDA kernel。这同时解释了 H3 int8 VAE 的 `detect_k_anchor` 报错。升级 torch 到 cu130（需驱动 ≥580）可解锁，但本机驱动 576.80 暂不升级 |

## 2. 画布：130 节点规划 → 可执行图（§3 从"部分"→"完成"）

`canvasbuilder.executableFor(engine)` 产出可直接 `POST /prompt` 的真实图：

| 引擎 | 规划节点 | 可执行节点 | 关键节点 |
|---|---|---|---|
| Wan2.2 | 130 | **12** | UNETLoader / CLIPLoader(wan) / VAELoader / CLIPTextEncode×2 / ModelSamplingSD3(shift 8) / **WanImageToVideo** / KSampler / VAEDecode / SaveLatent / CreateVideo / SaveVideo |
| MiniMax H3 | 130 | **13** | UNETLoader / H3SigmaShift(12/3) / turbo LoRA / CLIPLoader(minimax) / 2×VAELoader / H3ImageToVideo / KSampler(4 步) / VAEDecode + VAEDecodeAudio / CreateVideo(24fps) / SaveVideo |

- 返回值里 `execution = { comfy_ready:true, graph, mapped_nodes, planned_nodes, save_latent }`：**规划 130 是实验拆分凭据，执行 12/13 是 ComfyUI 真图**，两者节点数不同不代表缺失。
- `save_latent`：Wan 保留 `SaveLatent`；**H3 关闭**——H3 的 latent 是 `NestedTensor`，`SaveLatent` 会报 `'NestedTensor' object has no attribute 'contiguous'`（实测踩到，已从模板移除）。

## 3. 真机贝叶斯闭环（§4.3/4.4 从"部分"→"完成"）

`server/h3real.js#bayesReal`：每轮 GP+EI 选点 → **真生成** → 四维打分 → 更新数据集。

| 轮 | 来源 | steps | cfg | shift | F | 耗时 |
|---|---|---|---|---|---|---|
| 1 | 基线（turbo 默认） | 4 | 1.0 | 12 | **0.8326** | 32 s（缓存命中） |
| 2 | EI 选点 | 5 | 1.5 | 10.5 | 0.8099 | 377 s |
| 3 | EI 选点 | 2 | 1.4 | 11.5 | 0.8265 | 186 s |

- 结论：**基线仍是最优**；3 轮样本不足以让 GP 找到更优点（EI 选点把 cfg 提到 1.5 反而掉分）。
- **最优参数已回填** `engine:minimax_h3` 的 `kf.steps / kf.cfg / mo.i2v_strength`（`applied` 字段可见）。
- 数据：`%CLOUD_ROOT%\04-数据\h3real\2026-11-19_bayes_real.{csv,json}`

## 4. 真机单参数消融 + SVG（§4.6 从"部分"→"完成"）

| steps | F | 耗时 |
|---|---|---|
| **2** | **0.8433** | 121 s |
| 4 | 0.8326 | 170 s |
| 6 | 0.8186 | 241 s |

- **结论：H3 的 turbo LoRA 用 2 步就够，4 步是上限而不是推荐值**；步数越多越慢且分数越低（过引导/过采样）。
- 输出：CSV + **SVG 柱状图**（`ablation_steps.svg`，手写 SVG，不引绘图库）。
- 数据：`%CLOUD_ROOT%\04-数据\h3real\2026-11-19_ablation_steps.{csv,json,svg}`

## 5. 潜变量快照与回填口径

| 项 | 状态 |
|---|---|
| Wan2.2 潜变量快照 | `SaveLatent` 已进可执行图，输出 `wan/latent` |
| H3 潜变量快照 | **不支持**（NestedTensor），如实关闭并在 `execution.save_latent=false` 标注 |
| 最优参数回填 | `bayes.apply` → 写回引擎 258 参数空间，返回 `applied_keys` |
| 节点清单 / 参数快照 / 拓扑 JSON / 打分 CSV / 运行日志 | 已在 `ultimate.plan/run` 的 artifacts 与 `%CACHE_ROOT%\avp\experiments` 落地 |

## 6. 完成度重估

| 口径 | 之前 | 现在 |
|---|---|---|
| 按条款加权 | 70% | **约 85%**（Wan2.2 已装并可跑、画布有可执行图、贝叶斯与消融都是真机数据、回填与潜变量快照补齐） |
| 按"能答辩演示" | 65% | **约 88%**（A/B/C + 消融 + 收敛数据 + SVG 图都能上 PPT） |
| 按"别人能复现" | 55% | **约 80%**（权重、模板、工作流、数据、文档齐；差的是 24G 卡上的 fp16 全速验证） |

剩余 10–15% 集中在两处**永久性替代**（不是没做，是做不了）：
1. RIFE / Real-ESRGAN：第三方 ML 运行时，铁律禁止；已用 `minterpolate` / `lanczos` 替代并逐条标注。
2. 68 点人脸 / 稠密光流：需 landmarks 与光流模型；当前用中心结构稳定度 + 块匹配代理，标 `rule-proxy`。
