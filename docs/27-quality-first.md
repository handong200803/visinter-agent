# 27 · 质量优先改造（2026-11-19）

> 用户规则：**生成速度不做优化、不做加速**；所有策略优先高分辨率、高画质、帧间稳定、高帧率；允许耗时变长。
> 本文记录落点、实测与**硬件边界**（这条必须说清楚，否则就是骗人）。

## 1. 单一真相源：`spec/quality.json`

| 块 | 内容 |
|---|---|
| `mode` | `quality_first`（唯一模式；无 speed 选项） |
| `resolution_tiers` | 720p 1280×720 · 864p 1536×864 · 1080p 1920×1080 · cinema 2176×912 |
| `sampling` | sampler `dpmpp_2m` + scheduler `karras`（DPM++ 2M Karras）· steps **16–25** · CFG **7–10** · denoise **0.55–0.75** |
| `fps` | native **[24,30]**（默认 24）· output **[24,30,60]**（默认 60）· 60 只走插帧 |
| `scoring.weights` | Sface .35 / Sflow .35 / Sstyle .2 / Sbad .1 —— **无任何速度项** |
| `vram_model` | `5200 + MP×8000`（由实测 480×512 → 7223MiB 反推，仅作准入判断） |
| `forbid` | auto_downscale · speed_mode · distill · quant_speedup · lowres_preview · auto_step_reduce |

## 2. 服务端实现

| 文件 | 改动 |
|---|---|
| `server/quality.js`（新） | `tiers/tierById/tierBySize/vramNeedMib/sampling/fpsPlan/guard/scoringWeights`；`guard` 是唯一准入闸门 |
| `server/app.js` | `GET /api/quality`（档位 + 每档 `required_mib/feasible`）；`/api/jobs` engine 分支先 `guard`，失败 → **422 `QUALITY_VRAM_INSUFFICIENT`**（不是降档）；job 记录 `quality{res,fps,sampling,vram}` |
| `server/h3workflow.js` | `turbo:false` → 无 LoRA 质量路径：默认 **20 步 / CFG 7**；`turbo:true` 才 4 步 / CFG 1.0；支持 `fps`（写入 CreateVideo） |
| `server/canvasbuilder.js` | Wan/H3 可执行图采样器参数化（默认 `dpmpp_2m` + `karras`），fps 可注入 |
| `server/ultimate.js` | `interp` 按 `outputFps` 生成（`minterpolate=fps=<target>`）；返回 `native_fps/output_fps/fps_note`；RIFE 预留可插拔接口（`AVP_INTERP=rife` + `AVP_RIFE`） |
| `server/jobs.js` | job 落 `quality` 字段；增强版记录 `native_fps/output_fps` |

**禁止项的实现方式**：不是写在文档里，而是写在 `forbid` 数组 + `guard` 不提供任何降档分支。想降分辨率只能由调用方显式传更小的档位。

## 3. 前端

| 页面 | 改动 |
|---|---|
| `web/params.html` | 「一键生成」旁新增**分辨率档位**下拉（引擎默认 / 4 档）+ 「质量优先」徽标；提示「高分辨率/高帧率会显著增加生成时长；显存不足会**拒绝**，不自动降档、不自动减步数」；提交带 `tier` + `output_fps:60` |
| `app/index.html`（外壳） | 出片模态新增档位下拉 + 「质量优先 · 输出 60fps（插帧）」标注；提交带 `tier/output_fps` |
| `ultimate/index.html` | 评分/后处理面板沿用真机数据，`post` 现含 `native_fps/output_fps` |

## 4. 实测（本机 RTX 5060 Laptop 8G）

| 项 | 结果 |
|---|---|
| `/api/quality` | `usable_mib=8151`；四档 `feasible` 全 false；需求：720p **12573** / 864p **15817** / 1080p **21789** / cinema **21076** MiB |
| 提交 1080p | **422 `QUALITY_VRAM_INSUFFICIENT`**（need 21789）→ 不降档 ✅ |
| 提交 720p | **422**（need 12573）✅ |
| 提交 640×384 + output 60 | **202 受理**，`quality` 记录：0.246MP / native 24fps → output 60fps（needs_interp）/ steps 24 |
| 60fps 插帧 | `postprocess(outputFps:60)` 实测：**native 24fps → output 60fps**，`fps_note` 正确 |
| 质量路径采样步数 | 面板 steps 28 → 夹到 24（区间 16–25 内），**没有减到 4 步** ✅ |

### 质量路径实测代价（8G 卡真跑）

| 项 | 数值 |
|---|---|
| 任务 | `job_mwnk0911_37209e`（640×384 / **24 步** / 无 turbo LoRA / CFG 7） |
| 耗时 | **1447 秒（约 24 分钟）** —— 对比同尺寸 turbo 4 步的 3–6 分钟，慢 4–6 倍 |
| 产物 | `exp_mwnk0911_37209e_…_pure.mp4`（2.97MB）+ `…_enhanced.mp4`（3.76MB，output 60fps） |
| 结论 | 质量路径在 8G 上**可行但很慢**，符合"允许耗时变长"；显存没爆 |

### 硬件边界（必须如实说）

- **本机 8G 显存无法满足任何一个开放档位**：最低的 720p 需要约 **12.3GB**，1080p 需要约 **21.3GB**。
- 因此「1080P + 60fps」在 8G 上**无法完成**，平台会按规则**拒绝**而不是降分辨率。
- 可行组合：**≥16GB 显存跑 720p**、**≥24GB 跑 1080p / 2176×912**。
- 8G 上仍可验证完整链路：显式 640×384 → native 24fps → 插帧 60fps → 双版本落盘（本文第 4 节已实跑受理）。

## 5. 与既有规则的冲突处理

| 冲突 | 处理 |
|---|---|
| 铁律「禁第三方 ML 运行时」 vs 用户要 RIFE | 保留 `AVP_INTERP=rife` 接线位；默认 `minterpolate`（mci/aobmc），并在 `substitutions` 里如实标注替代关系。**没有假装是 RIFE** |
| H3 turbo 4 步（快、质量略低） vs 质量优先 | 质量模式默认 `turbo:false`（20 步 / CFG 7）；`turbo:true` 需显式请求，且会记 `QUALITY_TURBO_REQUESTED` 警告 |
| 既有脚本/测试依赖 4 步默认 | `turbo` 未显式指定时保持旧行为，只有显式 `turbo:false` 才走质量路径（避免门禁被动变慢） |
| 显存准入用「当前可用」会误杀 | 已改为**设备总显存**口径（ComfyUI 常驻时可用仅 1–2GB，用它判会把能跑的低档也拒掉） |
