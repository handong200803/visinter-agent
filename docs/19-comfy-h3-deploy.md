# 19 · 本地部署 ComfyUI + MiniMax H3（2026-11-19）

> 目标：只跑本地双开源——ComfyUI（引擎）+ MiniMax H3（33B 视频+音频模型），无付费 API。
> 机器：RTX 5060 Laptop **8151 MiB** / **系统内存 16 GB（实测 15.2 GiB，空闲约 4 GiB）** / Python 3.11.9 / D 盘 414 GB 空闲。
> ComfyUI 实测版本 **0.44.0**，`/object_info` 共 **1044 节点**，H3 本地节点齐全（EmptyMiniMaxH3LatentAV / MiniMaxH3ImageToVideo / MiniMaxH3ReferenceToVideo / MiniMaxH3SigmaShift / MiniMaxH3LatentUpscaleWithModel）。

## 1. 实际安装位置

| 项 | 路径 |
|---|---|
| ComfyUI 源码 | `D:\云盘\01-代码\AI视频\ComfyUI`（gitee `mirrors/ComfyUI` 克隆，commit `fd71054`） |
| Python 环境 | `ComfyUI\.venv`（Python 3.11.9） |
| torch | **2.11.0+cu128**（CUDA 12.8，`download.pytorch.org/whl/cu128`，轮子 2.75 GB） |
| 权重目录 | `ComfyUI\models\{diffusion_models,text_encoders,vae,loras}` |
| 启动脚本 | `ai-video-platform\tools\comfy_start.sh` |
| 下载日志 | `D:\缓存\avp\h3_download.log` |

## 2. H3 权重清单（Comfy-Org 量化版，hf-mirror 下载）

| 文件 | 大小 | 目标目录 |
|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 20.97 GB | `models/diffusion_models/` |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15.69 GB | `models/text_encoders/` |
| `minimax_h3_video_vae_int8_convrot.safetensors` | 2.81 GB | `models/vae/` |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.61 GB | `models/vae/` |
| `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | 1.96 GB | `models/loras/` |
| **合计** | **≈ 42 GB** | |

来源：`hf-mirror.com/Comfy-Org/MiniMax-H3`（官方 `MiniMaxAI/MiniMax-H3` 是 33B BF16 原版权重，约 130 GB，8G 显存无意义，不下）。
实测下载速度 40 MB/s 左右，42 GB 约 15–20 分钟。

## 3. 启动

```bash
# 默认低显存模式（8G 卡唯一可行配置）
bash tools/comfy_start.sh
# 等价于：
# .venv/Scripts/python.exe main.py --listen 127.0.0.1 --port 8188 --lowvram --reserve-vram 0.5 --preview-method none

# VAE 也扛不住时（更慢但更省）：
CPU_VAE=1 bash tools/comfy_start.sh
```

`--lowvram` 在新版里就是「文本编码器跑 CPU、扩散主干逐层换入」——32B 文本编码器不可能进 8G 显存，必须这样。
（旧文档里的 `--cpu-text-encoder` 参数在当前版本不存在，已从脚本移除。）

平台侧不需要改端口：`providers/comfy.js` 默认 `http://127.0.0.1:8188`，`AVP_PROVIDER` 留空即 auto→comfy。

## 4. 8 GB 显存的真实预期（不要被"能跑"误导）

| 项 | 数值 |
|---|---|
| 权重总量 | 42 GB（是显存的 5 倍） |
| 社区实测（4090 24G，640×512，int8，20 步） | 2.5–3.5 分钟/条 |
| 8G + lowvram 逐层换入 | 明显更慢，且可能因激活峰值 OOM |
| 降速手段 | ① turbo 4-step LoRA（步数 20→4，约 5×） ② 分辨率降到 480×512 ③ 帧数用最小合法值（24fps 下 124 帧≈5s） |
| 现实判断 | 能出 5s 短片，但**单条以十分钟计**；不适合批量 |
| **内存硬约束** | 42 GB 权重 vs **16 GB RAM（空闲 ~4 GB）**：lowvram 需要权重在内存/显存间换入，16 GB 内存会频繁读盘，速度可能比预估再慢一个量级，并有 OOM 风险 → 建议至少 32 GB 内存 |

想跑得舒服：换 24 GB 卡（4090/5090 或租卡），或降到 Wan2.2 5B（另一条路，用户暂不装）。

## 5. 平台接线（已就绪）

| 位置 | 内容 |
|---|---|
| `spec/engines.json` | `minimax_h3` 已写入真实文件名、42GB 体量、24G 推荐显存、ComfyUI 模板名（`video_minimax_h3_t2v / _i2v / _r2v`） |
| `server/engines.js` | `vramPlan(8151)` → int8 + 分片 + 按需卸载（与 `--lowvram` 同口径） |
| `server/visinter.js` | `selfCheck` 走 `GET /object_info` 查节点、`GET /models/{folder}` 查权重；缺什么报什么路径 |
| `ultimate` | `run` 在 ComfyUI 可达后从「规划态」变真机态；否则如实 `COMFY_UNREACHABLE` |

自检命令：

```bash
node tools/visinter.mjs selfcheck          # 节点/模型在位情况
node tools/ultimate.mjs engines            # 引擎与显存策略
node tools/ultimate.mjs plan --engine minimax_h3
```

## 6. 已知风险（按发生概率排序）

1. **nvfp4 文本编码器**：需要 Blackwell（5060 属于）+ ComfyUI 对新量化格式的支持。若加载报错 → 改下 `qwen3vl_32b_minimax_h3_int8_convrot.safetensors`（27.14 GB，多 11 GB 磁盘，但兼容性最好）。
2. **8G 激活峰值**：即使权重能逐层换入，640×512 的注意力激活仍可能 OOM → 降分辨率/帧数，或用 `--novram`（极慢）。
3. **H3 模板版本**：`video_minimax_h3_t2v.json` 需要 ComfyUI 前端模板 ≥0.33 行；当前 clone 是 `fd71054`（frontend 1.58.5），模板包 `comfyui-workflow-templates==0.11.103`，模板库应包含 H3。
4. **磁盘**：42 GB 权重 + torch 2.75 GB + venv 依赖 ≈ 50 GB，落在 D 盘（够）。

## 6.5 首次真机出片实录（2026-11-19 10:39–11:00）

| 尝试 | 配置 | 结果 |
|---|---|---|
| #1 | int8 video VAE（`minimax_h3_video_vae_int8_convrot`） | **失败**：采样跑完，`VAEDecode` 报 `detect_k_anchor kernel launch failed: CUDA driver version is insufficient for CUDA runtime version`（comfy-kitchen 的 int8 解码 kernel 与驱动 576.80 不匹配） |
| #2 | **fp16 video VAE**（`minimax_h3_video_vae_fp16`，5.21 GB） | **成功**：`480×512 / 124 帧 / 24fps / 5.167s / 1.63 MB`，**含 AAC 音轨**（H3 原生音画同步） |

- 命令：`node tools/h3_run.mjs`（读 `templates/h3_t2v_min.json`：UNETLoader → SigmaShift(12/3) → turbo-4step LoRA → KSampler(euler, 4 步, CFG 1.0) → VAEDecode(fp16) + VAEDecodeAudio → CreateVideo(24fps) → SaveVideo）
- 耗时：**461 秒**（含 42 GB 权重冷加载；4 步采样本身仅数十秒），显存 8151 MiB 全程未 OOM
- 产物：`%CLOUD_ROOT%-视频\成片\h3_t2v_min_00001.mp4`（副本），ComfyUI 原始输出 `ComfyUI\output\h3	2v_min_00001_.mp4`
- 结论：**8 GB 显存 + 16 GB 内存可以出 H3 5 秒片，单条约 7–8 分钟**；瓶颈是权重换入（内存小），不是采样

## 7. 验收清单（部署完成后逐条打勾）

- [ ] `curl http://127.0.0.1:8188/system_stats` 返回 JSON（服务起来）
- [ ] `curl http://127.0.0.1:8188/models/diffusion_models` 能看到 `minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- [ ] `/object_info` 里有 `MiniMaxH3` 相关节点 + `VAELoader` / `UNETLoader`
- [ ] `node tools/visinter.mjs selfcheck` → `measured`
- [x] 跑一条 5s 480×512，记录耗时与显存峰值（写回本文第 4 节，替换估算值）
- [x] `node tools/h3.mjs check` → **MEASURED**（节点 8/8、权重 5/5、合计 42 GB）
- [x] `node tools/h3_run.mjs` → 首条成片成功（461s，含音轨）
