# 24 · 最后工程：OpenCV 真光流 / 五步后处理实测 / 页面接真机数据

> 承接 `docs/23`（85%）。本轮把「评分器升级、后处理全链、页面真数据」三件事收掉。

## 1. 评分器：Sflow 从代理升级为 measured

| 项 | 实现 |
|---|---|
| 后端 | `tools/score_cv.py`（系统 Python + **cv2 5.0.0**），`server/scoring.js` 通过 `spawnSync` 调用；失败自动回退块匹配代理 |
| 指标 | `calcOpticalFlowFarneback` 稠密光流：`mean_mag / jitter / jerk / big_ratio`，外加亮度/闪烁 |
| 打分 | `Sflow = exp(-jitter/1.5) · exp(-max(0, big_ratio-0.55)/0.35)`，`provenance: measured(opencv-farneback)` |
| 实测 | 样片 `Sflow 0.392`（mean_mag 3.149、jitter 0.407、big_ratio 0.783）——手持前推片运动大，分数低是**真实结果** |

**人脸（Sface）仍为代理**，原因如实记录：
- cv2 5.0 **移除了 `CascadeClassifier`**（`cv2.objdetect` 也不存在）；
- 可用 `FaceDetectorYN`，但需 YuNet ONNX 模型，而 hf-mirror 对该仓库返回 **限流文本**（317 字节），拿不到实体；
- 故 `tools/score_cv.py` 输出 `faces.available=false` 与原因，Sface 继续标 `rule-proxy`。

### 三个 Windows 坑（都修了）
1. `cv2.VideoCapture` / ffmpeg 打不开**中文路径** → 先复制到 ASCII 临时路径再读。
2. Python 的 `tempfile` 判定中文临时目录不可用（`FileNotFoundError: No usable temporary directory`）→ 显式 `tempfile.tempdir = D:/avp_cv_tmp`。
3. Python argv 在 GBK 控制台下乱码 → 调用时加 `-X utf8` + `PYTHONUTF8=1`。

## 2. 五步后处理全链实测（纯净 vs 增强）

| 项 | 结果 |
|---|---|
| 链路 | interp → upscale → lut → deshake → grain，**五步全成功，耗时 20 秒** |
| 纯净版 | F = **0.6252** |
| 增强版 | F = **0.5796** |
| ΔF | **−0.0456**（24fps 归一化后仍 −0.0361） |

**这个负值是真实测量，不是 bug**：
- 插帧把 24fps 变 48fps、颗粒增加高频纹理，都会让 `big_ratio` 从 0.783 升到 0.87，光流判「异常运动更多」；
- 也就是说：**当前指标（光流稳定性）与「观感是否更好」不相关**，后处理收益只能靠人眼或 VL 模型判断。

这恰好是 PDF §一.8「打分器相关性预校验」关卡的现实案例：**打分器必须先证明它测的东西与目标相关，否则会误导优化方向**。已在 `ultimate.gates` 的 scorer 关卡保留该结论。

## 3. 页面：全部真机数据

| 区块 | 数据来源 |
|---|---|
| 贝叶斯 | `04-数据/h3real/2026-11-19_bayes_real.json`（3 轮，evaluator=measured） |
| A/B/C | `04-数据/h3abc/2026-11-19_h3_abc.json`（0.8326 / 0.8090 / 0.8253） |
| 消融 | `04-数据/h3real/2026-11-19_ablation_steps.json`（2/4/6 步，2 步最优） |
| 四维评分 | 真实样片 + OpenCV 光流 |
| 双版本后处理 | `04-数据/h3real/2026-11-19_post5.json`（五步、ΔF、替换说明） |
| 拓扑 | 130 规划 / 12 或 13 可执行，「可执行」标签 |

`snap_ultimate.mjs` 的取数顺序改为「真机 JSON → 缺失才 dry」，页面不再把计划画成分数。

## 4. 最终完成度

| 口径 | 数值 | 依据 |
|---|---|---|
| 按条款加权 | **约 88%** | Wan2.2 可跑、画布可执行、贝叶斯/消融真机、回填、光流 measured、双版本实测 |
| 能答辩演示 | **约 90%** | A/B/C + 消融 + 收敛 + 双版本 + 五关卡，全部有真数据与图 |
| 别人能复现 | **约 85%** | 权重、模板、工作流、数据、文档齐；差 24G 卡 fp16 全速验证 |

剩余不可消除部分（如实标注）：
1. RIFE / Real-ESRGAN：第三方 ML 运行时，铁律禁止 → `minterpolate` / `lanczos` 替代。
2. 68 点人脸：需 YuNet/landmarks 模型，镜像限流；Sface 保持 `rule-proxy`。
3. 24G+ 显存档位的 fp16 全速路径：本机 8G，无法验证。
