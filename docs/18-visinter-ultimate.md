# 18 · VisInter-Agent 终极版改造（双引擎 / 画布 / 贝叶斯 / 双版本）

> 依据：`VisInter‑Agent 终极最终版合并（画布节点+贝叶斯顶配+双模型+后处理增强）.pdf`（6 页，2026‑11‑19 提取）
> 落地：`spec/engines.json` · `server/{engines,canvasbuilder,bayes,scoring,ultimate}.js` · `tools/{ultimate,snap_ultimate}.mjs` · `ultimate/index.html`
> 门禁：`selftest_all` **PASS 12 · FAIL 0**；`ultimate verify` **41 项全过**；`lint_ui` **9 页全绿**

## 1. PDF 条款 → 落点（逐条）

| PDF 条款 | 落点 | 状态 |
|---|---|---|
| §1 完整保留 Wan2.2（节点/IP‑Adapter/FaceDetailer/自检/显存策略） | `engines.list()[wan22]`，`features` 声明 ipadapter/facedetailer/reference_lock/controlnet；参数空间独立 | 保留（未删一行） |
| §2 新增 MiniMax H3 第二底座，前端下拉切换，全程本地免费 | `spec/engines.json` 第二引擎（video+audio VAE、h3 采样器、reference lock），`paid:false` 硬校验 | 已注册；权重未下载 |
| §3 所有生成入口强制走画布节点 | `canvasbuilder.build()` 产出拓扑；`ultimate.plan/run` 统一入口 | 已实现（run 需 ComfyUI） |
| §4 两套 258 参数完全隔离 | `engines.load/save/patch` 按引擎文件命名空间；`isolationCheck()` 可执行证明「写 A 不动 B」 | 已实现并断言 |
| §5 上层功能永久保留 | 双模式/双向同步/脸型提取/风险预警/自检/玻璃 UI 均未改动（visinter 与 params 页照旧） | 保留 |
| §6 参数不锁不拦截 | 未新增任何校验拦截；风险仍只提示 | 保持 |
| §7 两阶段收益严格分开 | 阶段一 `bayes.optimize`（不碰视频）；阶段二 `postprocess`（不碰打分） | 已实现 |
| §1.8 拓扑自动构建（≥120 节点、七大模块、禁打包/子图、锁定复用） | `canvasbuilder`：130 节点、7 模块、edges>nodes、packing=0；locked 模式节点/边不变 | 已实现并断言 |
| §二 显存智能适配（8G int8 分片卸载 / 12G+ fp16） | `engines.vramPlan()` | 已实现并断言 |
| §4.1 目标函数 F(x)=w1Sface+w2Sflow+w3Sstyle−w4Sbad（0.35/0.35/0.20/0.10） | `bayes.objective` + `scoring` 输出 | 已实现；权重可覆盖 |
| §4.2 初始化：种子 + ±10% 扰动 4 组 | `bayes.optimize` init 段 | 已实现 |
| §4.3/4.4 GP 代理 + EI + 约束截断 + 收敛早停 | `bayes.optimize`（RBF 核 + Cholesky + EI，随机候选池 512） | 已实现（纯 JS） |
| §4.5 四维本地量化评价 | `scoring.scoreVideo`：Sface（中心结构稳定代理）/Sflow（块匹配位移抖动）/Sstyle（HSV+青橙）/Sbad（黑屏过曝纯色闪烁） | 真实计算，**全部标 rule‑proxy** |
| §4.6 A/B/C 对照 + 单参数消融 | `ultimate.abcExperiment`（A 默认 / B Muse 预设 / C 贝叶斯最优，digest 两两不同）、`ablation` | 已实现（dry 计划；真机需 ComfyUI） |
| §五 后处理五步 + 双版本 | `ultimate.postprocess`：minterpolate / lanczos / colorbalance+curves / deshake / noise，产出 `pure.mp4` 与 `enhanced.mp4` | 真实 ffmpeg 跑通（deshake+grain 实测） |
| §8 五关卡自检 | `ultimate.gates`：link / scorer / dim / converge / separation | 已实现，缺证据会列 fatal |
| §4.7 科研级可视化 UI | `ultimate/index.html`（磨砂玻璃）：引擎切换、模块条形、收敛柱、A/B/C、消融、四维、双版本、关卡 | 已上线，lint 通过 |

## 2. 诚实边界（评审会问的三件事）

1. **还不能真出片**：本机 `ComfyUI 127.0.0.1:8188` 未安装，`run` 一律 `COMFY_UNREACHABLE`，**不生成占位视频**。拓扑、参数、打分、后处理、实验表格都已能跑。
2. **H3 权重与节点未下载**：`spec/engines.json` 只声明接口（VAE/文本编码器/采样器/量化），自检状态为 `inferred`；装好后 `engines` 命令会显示 `measured`。
3. **三项「模型能力」是规则替代**：RIFE → `minterpolate(mci)`；Real‑ESRGAN → `lanczos 2x + unsharp`；68 点人脸关键点 → 中心区域结构稳定代理。全部在返回值 `substitutions` / `not_measured` 里逐项标注，不冒充模型打分。

## 3. 命令

```bash
node tools/ultimate.mjs engines                  # 双引擎 + 隔离自检
node tools/ultimate.mjs plan --engine wan22 --mib 8151
node tools/ultimate.mjs plan --engine minimax_h3 --json
node tools/ultimate.mjs score --file <video>
node tools/ultimate.mjs post  --file <video> --steps deshake,grain
node tools/ultimate.mjs abc --engine wan22       # A/B/C（dry：计划 + CSV）
node tools/ultimate.mjs ablation --param kf.cfg
node tools/ultimate.mjs gates
node tools/ultimate.mjs verify                   # 41 项契约自检
node tools/snap_ultimate.mjs && node tools/build_module.mjs ultimate   # 重建页面数据
```

页面：`http://127.0.0.1:8418/ultimate/index.html`（或双击 `ultimate/index.html`，数据内联）。

## 4. 本机实测数字（2026‑11‑19）

- 拓扑：**130 节点 / 131 连线 / 7 模块 / packing 0**，locked 复用后节点数不变、参数 digest 变化。
- 隔离：写 A 的 `kf.cfg=9.25` 后，B 完全未变（探针已还原）。
- 贝叶斯（proxy 目标）：8–9 轮收敛，最优 F 0.84–0.87；参数全部落在注册表区间内。
- 四维评分（3s 水乡样片）：四项 0–1、F 与权重公式逐位一致、重复打分确定性一致。
- 后处理：`deshake → grain` 两步成功，`pure.mp4` 与 `enhanced.mp4` 分离；替换关系两条如实记录。
- A/B/C：三组 digest 两两不同（A 默认 / B Muse / C 贝叶斯），共用锁定拓扑。
- 五关卡：证据齐备时全 PASS；缺打分/缺双版本时 listed fatal。

## 5. 下一步（按优先级）

1. 装 ComfyUI + Wan2.2 权重 → 把 `run` 从规划态变成真机态（`comfy_ready` 才能为 true）。
2. 下 H3 int8 权重与节点 → 引擎自检翻 `measured`。
3. `canvasbuilder` 的 `AVP.*` 自定义节点需要落地成 Impact/自定义节点映射表，否则拓扑只是规划凭据。
4. 页面把 A/B/C 与消融的 `F=null` 换成真机分数（接上第 1 步即可）。
