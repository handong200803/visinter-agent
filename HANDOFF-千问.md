# HANDOFF-千问 · ai-video-platform 交接包

> 给接手的 AI/工程师：这份文档是唯一入口。读完第 0、1、2 节就能跑起来；第 6、7 节是**必须知道的坑**，能省你半天。

## 0. 一句话与当前状态

本地一体化 AI 视频平台（`VisInter-Agent`）：双开源引擎（Wan2.2 / MiniMax H3）+ 画布拓扑 + 贝叶斯寻优 + 四维评分 + 双版本后处理 + 三处 UI（外壳/参数面板/科研台）。

- 完成度（对照 `docs/18` 的 PDF 标准）：条款加权 **88%**、可答辩 **90%**、可复现 **85%**。
- 门禁：`node tools/selftest_all.mjs` → **PASS 12 · FAIL 0**；`node tools/lint_ui.mjs` → **9 页全绿**；`node tools/ultimate.mjs` → **44 项全过**。
- 真机验证：H3 出片 9 条（480×512/640×384，5s，带 AAC），Wan2.2 5B 出片 1 条（320×480/17 帧），全部归档在 `%CLOUD_ROOT%\02-视频\成片`。

## 1. 环境（缺一不可）

| 件 | 版本/位置 | 说明 |
|---|---|---|
| Node | ≥ 22（实测 24.21） | **零第三方依赖，没有 package.json，不要 npm install** |
| Python | 3.11（系统） | 仅用于 `tools/score_cv.py`（OpenCV 光流评分） |
| ffmpeg / ffprobe | `C:/Users/mechrevo/AppData/Local/Microsoft/WinGet/Links/`（可用 `AVP_FFMPEG` 覆盖） | 后处理、抽帧、评分 |
| ComfyUI | `D:\云盘\01-代码\AI视频\ComfyUI`（0.44.0，自带 `.venv` + torch 2.11.0+cu128） | **不在本包内**，需按第 3 节装 |
| 模型权重 | 见第 3 节 | **不在本包内**（H3 42GB / Wan 17GB） |
| GPU | RTX 5060 Laptop 8G（实测） | 24G 卡可开 fp16 全速（未验证） |

## 2. 三条命令

```bash
# 起平台（http://127.0.0.1:8418/app/index.html）
PORT=8418 node tools/serve.mjs

# 起 ComfyUI（另开一个终端）
bash tools/comfy_start.sh          # = .venv python main.py --lowvram --reserve-vram 0.5

# 三条门禁（改完必跑）
node tools/selftest_all.mjs && node tools/lint_ui.mjs && node tools/ultimate.mjs
```

自检与出片：

```bash
node tools/h3.mjs check            # H3 节点/权重/显存三层自检（期望 MEASURED）
node tools/h3_run.mjs              # 直接提交 templates/h3_t2v_min.json
node tools/h3abc.mjs --prompt "…"  # A/B/C 真机对照（3 条 ≈12 分钟）
```

## 3. 模型与 ComfyUI（本包不含，需自取）

ComfyUI：`git clone https://gitee.com/mirrors/ComfyUI`（GitHub 在本机不可达），然后 `.venv` + `pip install torch --index-url https://download.pytorch.org/whl/cu128` + `-r requirements.txt`。

权重（`hf-mirror.com` 或 `modelscope.cn`，后者对 Wan 更快）：

| 文件 | 大小 | 目标目录 |
|---|---|---|
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | 20.97 GB | `models/diffusion_models` |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15.69 GB | `models/text_encoders` |
| `minimax_h3_video_vae_fp16.safetensors` | 5.21 GB | `models/vae` |
| `minimax_h3_audio_vae_fp32.safetensors` | 0.61 GB | `models/vae` |
| `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | 1.96 GB | `models/loras` |
| `wan2.2_ti2v_5B_fp16.safetensors` | 9.4 GB | `models/diffusion_models` |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | 6.3 GB | `models/text_encoders` |
| `wan2.2_vae.safetensors` | 1.4 GB | `models/vae` |

## 4. 文件地图（先看这几份）

| 路径 | 作用 |
|---|---|
| `AGENTS.md` / `HANDOFF.md` | 平台铁律与历史交接（**先读铁律**：不建 package.json、不手改构建产物、产出到 `%CLOUD_ROOT%`） |
| `docs/18-visinter-ultimate.md` | 对照 PDF 的条款落点表（改造依据） |
| `docs/19~26` | 部署、H3 通道、四项收尾、真机对比、最后工程、双引擎入面板、外壳一键出片 |
| `spec/engines.json` | 双引擎注册表（免费校验、显存策略、画布模块配额、贝叶斯默认、后处理步骤、关卡） |
| `spec/params.registry.json` | 258 参数唯一真相源（由 `tools/gen_registry.mjs` 生成，勿手改） |
| `server/engines.js` | 引擎隔离存储（`engine:<id>`）与显存策略 |
| `server/canvasbuilder.js` | 130 节点规划拓扑 + `executableFor()` 可执行图（Wan 12 / H3 13 节点） |
| `server/bayes.js` | GP-RBF + EI + 约束截断 + 早停 |
| `server/scoring.js` + `tools/score_cv.py` | 四维评分（Sflow 走 OpenCV 光流 measured，其余 rule-proxy） |
| `server/ultimate.js` | 拓扑/后处理/A-B-C/消融/五关卡编排 |
| `server/h3workflow.js` / `templates/h3_t2v_min.json` | H3 定点注入 + 工作流模板 |
| `server/archive.js` | 成片归档到 `%CLOUD_ROOT%\02-视频\成片` + `_index.json` |
| `app/index.src.html` | 外壳（唯一入口，**改完跑 `node tools/build_app.mjs`**） |
| `web/params.src.html` | 258 参数面板（**改完跑 `node core/build.mjs`**） |
| `ultimate/index.html` + `tools/snap_ultimate.mjs` | 科研台页面与数据快照 |
| `tools/capability.mjs` / `tools/visinter.mjs` / `tools/ultimate.mjs` | 三套契约自检（改对应模块必须保持全绿） |

## 5. 已实现能力（可直接演示）

1. **双引擎**：Wan2.2（12 节点图）与 H3（13 节点图，原生音画同步）都从参数面板/外壳一键出片。
2. **画布**：130 节点七模块规划拓扑（禁打包、locked 复用），另有可执行子图（`execution.graph`）。
3. **贝叶斯**：GP+EI，真机 3 轮（F 0.8326/0.8099/0.8265，最优回填）。
4. **消融**：steps 2/4/6 → 0.8433/0.8326/0.8186（**2 步最优且最快**），带 SVG 柱状图。
5. **评分**：Sface/Sflow/Sstyle/Sbad，Sflow 为 OpenCV 光流 measured。
6. **后处理**：五步（interp/upscale/lut/deshake/grain）20 秒，纯/增强双版本；**ΔF=−0.0456（指标不奖励后处理，见 docs/24）**。
7. **归档与作品库**：成片落云盘 + 索引，页面可播放、可 2x 放大。
8. **五关卡**：link/scorer/dim/converge/separation。

## 6. 必须知道的坑（按踩坑成本排序）

1. **ComfyUI WS clientId**：提交 `/prompt` 与连 `/ws` 必须同一个 clientId，否则 `execution_success` 永远收不到、任务卡 running。已在 `server/comfy.js` 统一 + 15s history 兜底。
2. **`kf.seed = -1`**：面板语义是「随机」，ComfyUI 最小 0 → `value_smaller_than_min`。已在 engine 入口收敛（app / h3workflow / canvasbuilder 三处）。
3. **H3 的 int8 VAE 不能用**：`detect_k_anchor kernel launch failed`（comfy-kitchen CUDA kernel 需要 torch cu130，本机 cu128）。固定用 `minimax_h3_video_vae_fp16`。
4. **H3 latent 是 NestedTensor**：`SaveLatent` 会报 `'NestedTensor' object has no attribute 'contiguous'` → H3 关闭潜变量快照（`execution.save_latent=false`），Wan 保留。
5. **Windows 文件坑**：`copyFile` 偶发 EPERM（重试+读写回退）；Python 子进程中文路径乱码（`-X utf8` + `PYTHONUTF8=1`）；`tempfile` 拒绝中文临时目录（显式 `D:/avp_cv_tmp`）；cv2/ffmpeg 打不开中文路径（先复制到 ASCII）。
6. **构建产物不可手改**：`app/index.html`、`web/params.html`、`canvas/canvas.html`、`ultimate/index.html`、`*/snapshot.json` 都是生成物。
7. **脚本插入 app/index.src.html 的位置**：必须插在**最后一个 `})();` 之前**；插错会多出一个 `})();` 让整段脚本语法错误（按钮全失效）。构建后用 `node --check` 校验内联脚本。
8. **外壳会重渲染**：模态必须动态注入 `document.body`，写在 `#app` 容器里会被 `renderProjectBar` 冲掉。

## 7. 待办（按优先级）

1. **出片互斥**：外壳模态重复点击会重复提交（实测产生 3 个任务，已取消 2 个）→ 加「有运行中任务时按钮保持禁用」。
2. **画布真执行**：130 节点里 `AVP.*` 是规划节点，尚未映射到真实 ComfyUI 自定义节点；目前真跑的是 12/13 节点子图。补齐映射后 `planned_nodes` 才能与执行一致。
3. **贝叶斯轮数**：当前 3 轮（每条 3–7 分钟）。可加"夜间批量/后台队列"，把轮数提到 10+。
4. **Sface 实测**：cv2 5.0 移除了 `CascadeClassifier`，`FaceDetectorYN` 需要 YuNet ONNX（hf-mirror 对该仓库限流）。拿到模型后把 Sface 从 rule-proxy 升到 measured。
5. **24G 卡 fp16 全速**：未验证。
6. **Wan 大尺寸**：832×480/81 帧在 8G 上解码超 28 分钟；建议加"短边 480 / 帧数 17"的安全预设并写进面板提示。

## 8. 验收方式（接手第一件事）

```bash
node tools/selftest_all.mjs        # 期望 PASS 12 · FAIL 0
node tools/lint_ui.mjs             # 期望 9 页全绿
node tools/ultimate.mjs            # 期望 44 项全过
node tools/h3.mjs check            # 期望 MEASURED（没有权重时会是 fail，属正常）
```

三条全绿后，再用任意一条真机生成验证链路（约 5–9 分钟）：

```bash
curl -s -X POST http://127.0.0.1:8418/api/jobs -H "Content-Type: application/json" \
  -d '{"engine":"minimax_h3","values":{"ch.prompt_prefix":"江南水乡清晨，镜头缓慢前推","kf.ratio":"16:9","mo.duration":5},"device":"T0","note":"handoff smoke"}'
```

## 9. 数据与证据（本包内）

| 路径 | 内容 |
|---|---|
| `docs/state/` | 历次门禁/验收快照（capability / visinter / acceptance 等） |
| `04-数据/h3real/`（云盘，不在包内） | 贝叶斯真机 CSV/JSON、消融 CSV+SVG、五步后处理对比 JSON |
| `04-数据/h3abc/`（云盘） | A/B/C 真机 CSV/JSON |
| `docs/19~26` | 每一步的实测数字与踩坑记录（写论文/答辩可直接引用） |
