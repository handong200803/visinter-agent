# 14 · 蓝图 vs 现状：逐节偏差对照

> 对照对象：[`docs/00-blueprint-v1.0.md`](00-blueprint-v1.0.md)（876 行，42 节，目标形态）↔ 本仓库当前代码（v0.1 工作副本）
> 写法约束：**只做对照，不整段抄蓝图**；每行的「依据」必须是仓库里真实存在的文件（能到行就到行）。
> 判定四态：**已落地**（功能等价且在本仓可跑）· **等价替代**（换了实现但能力在）· **未做**（能力缺）· **决定不做**（技术上可做，路线明确放弃，理由见列尾）
> 未取得实测数据的一律标「未核实」，不填估计值。

---

## 0. 一句话结论

蓝图是「FastAPI + Vue3 + Redis + MinIO + ComfyUI 全栈的商用产线」，现状是「零依赖 Node 单体 + 原生 HTML 单文件 + 系统 ffmpeg」。
**偏差不是没做完，而是一条技术路线替换**：`零第三方依赖 + 双击即开 + 单机单用户` 这三条硬约束，把蓝图的中间件层整体删掉了（Redis→进程内 Map、MinIO→本地盘、FastAPI→Node `http`、Vue/TS→原生 HTML+Canvas）。
**能力层（求解器 / 参数注册表 / 逐帧质检 / 模板 / 插件 / 帧检查器）保留度最高；服务层与交付层缺口最大。**

---

## 1. 逐节对照表

| # | 蓝图能力（§） | 判定 | 现状（本仓实际形态 + 数字） | 依据 | 理由 |
|---|---|---|---|---|---|
| 1 | §1 前端 Web：Vue3 + TS + Pixi/WebGL + LiteGraph | 等价替代 | 原生 HTML/CSS/JS 单文件产物：`app/index.html`（335 KB）· `canvas/canvas.html`（270 KB）· `web/params.html`（350 KB）（三个数实测于 2026-11-18）；图形用 Canvas2D；令牌唯一源 `ui/tokens.css`（51 个令牌） | `AGENTS.md` 技术栈节 · `ui/tokens.css` · 产物字节数由 `Get-Item` 实测 | 零依赖铁律：不引入 Vue/TS/Pixi 任何运行时；单文件内联换掉打包器，`file://` 双击即开 |
| 2 | §1 平台服务：FastAPI（Python） | 等价替代 | Node 内置 `http` 写 REST + SSE：`server/app.js`（436 行）· `server/jobs.js` · `server/static.js`；入口 `node tools/serve.mjs`（默认 8388） | `server/app.js` · `server/jobs.js` · `docs/01-architecture.md:72` | 全仓 `grep fastapi/uvicorn` 零命中；本机系统 Python 是 `torch 2.15.0+cpu`（`cuda.is_available()==False`），不能当推理环境，再养一层 Python 服务无收益 |
| 3 | §1 队列/状态：Redis | 等价替代 | 进程内 `Map` + 每任务一个 JSON 原子写（`.tmp` → `rename`）+ 启动 `restore()`；并发由 `AVP_CONCURRENCY` 控制 | `server/jobs.js:55-74` · `server/jobs.js:44` | 单机单用户，不需要跨进程队列；重启恢复靠落盘 JSON 已够；代价是「无优先级、无分布式锁」（`docs/12-handoff.md:132` 已登记为缺口） |
| 4 | §1 产物存储：MinIO / S3 | 等价替代 | 本地盘：产物 `%CLOUD_ROOT%\02-视频\成片`，中间物 `%CACHE_ROOT%\avp\{jobs,qc}` | `AGENTS.md` 产出与缓存去向 · `server/jobs.js:43` · `quality/README.md:62` | 全仓 `grep redis/minio/s3://` 零命中；单机没有多副本/跨机读需求，对象存储只增加部署成本 |
| 5 | §1 推理内核：ComfyUI 独立进程（HTTP/WS，1 GPU = 1 slot = 1 worker） | 等价替代（未接通） | provider 抽象四后端 `server/providers/{mock,comfy,dashscope,cine}.js`；`AVP_PROVIDER` 显式选择，不可达报 `degraded:true` + 任务如实 failed | `server/providers/index.js` · `docs/12-handoff.md:126` | 本机 ComfyUI 已移除（8188 无响应）；缝留好了，但没有真 worker 进程管理（预热/心跳/看门狗/每 N 任务重启 全仓零命中，只有快照文案里提过）→ **调度器部分未做** |
| 6 | §2 显存探测：`scripts/probe_gpu.py` + `torch.cuda.mem_get_info` | 等价替代 | `server/gpu.js`：只读 `nvidia-smi --query-gpu=name,memory.total,memory.used,compute_cap,driver_version`，WDDM 下用 `memory.used` 采样算可用，留 512 MiB 系统预留；每个结论带 `provenance: measured\|estimate\|unknown` | `server/gpu.js:1-30` | 不碰 torch / CUDA（系统 torch 是 `+cpu`）；零依赖；探测失败不许装成功（`{ok:false,reason}` 上抛） |
| 7 | §2 三段式求解：探测 → 求解 → 自学习 | 已落地 | `core/engine.js`（477 行冻结内核）：`resolve()` 规则联动 + 值域夹紧 + trace、`estimate()` 四向预测、`degrade()` 降档方案；联动规则 `spec/rules.linkage.json` 14 条 | `core/engine.js` · `spec/rules.linkage.json`（`rules: 14`，实测） · `docs/01-architecture.md` §5.1 | 蓝图最核心的差异化能力，本仓保留度最高；「自学习」那一档未做（无历史数据训练闭环，`grep` 无对应实现） |
| 8 | §3 模型矩阵（按档位 + 商用许可） | 已落地（清单）/ 未核实（真机） | `spec/models.catalog.json` 七档：`T0, T0-low, T1, T2, T3, T4, T5`（实测 7 项），每档带 `resident_mib`/`t_factor`/许可字段 | `spec/models.catalog.json` · `docs/12-handoff.md:29` | 参数是数据不是代码，所以能整体落地；但 `resident_mib`/`t_factor` 多为 estimate，8G 卡真机标定未做（`docs/01-architecture.md:145`） |
| 9 | §4 商用画质管线：关键帧 → i2v → 补帧(RIFE) → 超分(Real-ESRGAN) → 质检 → best-of-N | 等价替代 | 后处理改系统 ffmpeg：`minterpolate(mi_mode=mci)` 插帧 48fps、`scale=lanczos` 到 1080p、filmic LUT、deflicker、grain、vignette、h264 8 Mbps；并在 `substitutions[]` 里逐条标明「非 RIFE / 非 ESRGAN」；best-of-N 走 cine 的 `groups[]` 选优 | `server/cine.js:14-15` · `server/cine.js:406-407` · `server/cine.js:879` · `docs/state/cine-realrun-2026-11-18.json` | RIFE / ESRGAN / SeedVR 都是第三方 ML 运行时，铁律禁止引入 → 用 ffmpeg 等价滤镜，并把「不是同一个东西」写进产物字段（诚实降级） |
| 10 | §5 中文提示词引擎（LLM 驱动） | 等价替代 | `prompt/compose.js`（976 行）规则引擎：中文意图 → 槽位 → 正负向提示词；词库 `prompt/lexicon.zh.json`（548 行）+ `styles.json`；零 LLM 依赖 | `prompt/compose.js` · `docs/12-handoff.md:62` | 要可复现（同输入同输出、可入库对拍），LLM 采样做不到；LLM 只用在 cine 的「一句话分析」上（`qc.cine` 的 `analysis.source: qwen`，有 key 才走） |
| 11 | §6 界面：动态科技感设计系统 | 已落地 | `ui/tokens.css`（51 令牌，唯一身份）+ `ui/glass-skin.css` + `ui/module-ui.css`；7 页视觉守门全绿（`node tools/lint_ui.mjs`） | `ui/tokens.css` · `tools/lint_ui.mjs:26-34` · `docs/09-design-system.md:126` | 令牌化 + lint 守门已能压住风格漂移；缺失的是组件库自动化（无 Storybook 类工具，属未做但低优先） |
| 12 | §7 商用工程：认证 / 计费 / 审计 | 部分落地（审计）· 未做（认证/计费） | 审计：`server/audit.js` 五道闸 G0~G4 + 三态 PASS/REJECT/REVIEW，全部留痕进 report；认证：无登录/会话/用户模型（`grep cookie/session/login/password` 只命中 LLM 的 `role: 'system'\|'user'` 与插件 `permissions`），HTTP 层零鉴权；计费：只在 provider 侧统计调用与成本，未形成账单 | `server/audit.js:1-12` · `server/jobs.js` · `docs/12-handoff.md:135` | 本地单机单人部署，认证没有对象（要认证先得有远程入口）；计费在「按量付费的云端 provider」场景才有意义，本仓只有 DashScope 一条云端通道 |
| 13 | §8/§14 里程碑与验收（阶段交付） | 等价替代 | `docs/13-task-cards.md` 9 张任务卡（每卡：目标/前置/改动面/做法/验收命令/完成定义）+ 模块自检协议（末行「全部通过」+ exit 0） | `docs/13-task-cards.md` · `docs/01-architecture.md` §5.4 | 任务卡比里程碑细一层，能被 AI IDE 直接执行并有可跑的验收命令；里程碑退化为卡的依赖关系 |
| 14 | §9 风险登记（按杀伤力排序） | 等价替代 | `docs/12-handoff.md` §7 已知缺口总表：14 行，A/B/C 三级 + 落点 + 判据 | `docs/12-handoff.md:121-138` | 静态风险表会腐坏；改成「缺口 + 判据 + 落点」的可执行表，改完就能划掉一行 |
| 15 | §10 与既有原子件衔接（media-verify · video-compose · video-cover） | 未做 | `quality/` 只到 `probe` + 四路指标；`astats` 未接（快照里显式写「未接入（astats 未接）」）；无合成/封面环节 | `tools/snap_quality.mjs:99`、`:256` · `docs/06-quality.md:122` | 原子件在仓库外的技能侧，接进来要走契约（当前写域隔离要求跨模块需求走契约）；本轮范围未包含 |
| 16 | §11 图编辑器：LiteGraph（先解决许可证） | 决定不做 | 自研三视图画布（向导 / 参数 / 节点），节点视图拓扑为常量 `DATA_LINKS`，只能看不能搭 | `canvas/canvas.src.html` · `docs/12-handoff.md:133` | 零依赖铁律禁第三方运行时（LiteGraph 要打包进单文件）；自研三视图更适合「向导优先」的用户路径；代价：手工连线未做（卡 ⑨ 待做） |
| 17 | §12 插件体系：四类包 + 一套 manifest | 部分落地 | `plugins/loader.js`（1115 行）声明式 manifest 加载与注册表合并，**永不 `require` 插件代码**；坏包三种被隔离；缺 `signature` 验签、`ui` 类只登记不渲染 | `plugins/loader.js` · `docs/12-handoff.md:136` | 安全边界优先（不执行插件代码 = 免掉一整类风险）；签名与 ui 渲染在卡 ⑧，未开工 |
| 18 | §13 创作者参与度：把「做模板」变成 15 分钟的事 | 已落地 | `market/`：`.avptpl` 打包/校验/HMAC 签名/本地仓库；`market/samples/` 5 个真模板；`market/store/index.json` 本地索引 | `market/pack.js` · `market/store.js` · `market/sign.js` · `docs/12-handoff.md:63` | 模板格式先定死，交易层（结算/远端仓库/版本并存）留到后面（`docs/12-handoff.md:135`） |
| 19 | §15 交付规格：mp4(H.264/H.265) + SRT + 封面 + 多平台尺寸 + manifest | 未做 | `app/` 的 `export` 不搬文件（只到任务终态）；SRT 只在参数/提示词侧生成文本，没有 mux 进成片；无封面/多平台尺寸产物 | `docs/12-handoff.md:137` · `spec/params.registry.json`（SRT 相关键） | 交付打包依赖仓库外的 ffmpeg 原子件（见 #15），本轮未接 |
| 20 | §18 质量硬指标（上线前真机标定） | 未做 | 全仓无 `vmaf / ssim / psnr` 实现；只有传统信号量：拉普拉斯方差（锐度）、帧间亮度差（闪烁）、帧差均值（残差） | `quality/frames.js:1-22` · `docs/06-quality.md` §2 | VMAF 需要参考片 + libvmaf 构建，零依赖下拿不到；PSNR/SSIM 可算但缺参考片，无参考时没有意义 |
| 21 | §23 漫剧专用产线（7 段） | 部分落地 | `server/cine.js`（1155 行）一句话电影管线：分析 → 分组 → best-of-N → 后处理 → 报告；真跑记录 `docs/state/cine-realrun-2026-11-18.json`（`provenance: measured`，`durationMs: 223437`，`state: succeeded`） | `server/cine.js` · `docs/state/cine-realrun-2026-11-18.json` · `server/providers/cine.js` | 用一条 pipeline 覆盖 7 段的实质，没有逐段拆成独立模块；拆分收益低、接口成本高 |
| 22 | §25 T0（8G）机型实测预期（耗时/画质目标） | 未核实 | 本机 `RTX 5060 Laptop / 8151 MiB / sm_120`，但本地推理环境 = 0（无 ComfyUI、torch 是 `+cpu`），本地出片耗时**无实测** | `docs/12-handoff.md:29-32` · `docs/01-architecture.md:145` | 编数字违反铁律；只有云端 DashScope 有真跑记录，不能拿来代填本地 8G 预期 |
| 23 | §27–§33 参数五层 / 注册表 / 联动 / 预设 / 护栏 | 已落地 | `spec/params.registry.json` 258 参数 / 7 板块（实测 `params: 258`）；联动 14 条；`applyPreset('draft'\|'standard'\|'cinematic')`；`vram.ratio > 1` 一律不得显示成可用 | `spec/params.registry.json` · `core/engine.js` · `docs/01-architecture.md` §5.1-5.2 | 这是全仓落地最完整的一块；唯一缺口是 `bind` 覆盖率（ComfyUI 链 2.3%，DashScope 链 8.1%，`docs/12-handoff.md:125`） |
| 24 | §35/§36 逐帧质量的正确做法 + 单帧客观验收 | 已落地 | 一次性 ffmpeg 解码 → 160 宽灰度裸帧 → Node 里算四路指标（避免逐帧起进程）；阈值全在 `DEFAULTS` 带实测依据；自检实测：good 均值 93.9 / bad 均值 64.3，注入缺陷帧全部命中 | `quality/frames.js:1-22`、`:34-49` · `docs/06-quality.md:83-100` | 蓝图的核心工程结论（「逐帧起进程 = 性能坑」）被完整继承；缺的是真机标定（#20） |
| 25 | §38 双引擎架构：H3 为主 + 本地为辅 | 等价替代 | `server/providers/dashscope.js`（万相 t2v，云端真出片，按量计费）+ `mock`/`comfy`；`docs/state/cine-realrun-2026-11-18.json` 是云端真跑证据；inspector 的「引擎切换」只是 UI 文案 | `server/providers/dashscope.js` · `docs/state/cine-realrun-2026-11-18.json` · `inspector/index.src.html:951-956` | H3（MiniMax）是第三方私有 API，接入要 key + 商业条款；DashScope 是能力等价的可用通道，且已真出片 |
| 26 | §40 帧检查器（本产品交互核心） | 已落地（界面）/ 演示数据 | `inspector/index.html`：120 帧质量热力条（颜色与蓝图 `#3DDC97/#FFB454/#FF5C7A` 一致）、锐度/残差/亮度三曲线、锚点◆、锁定、四模式、洋葱皮、A/B 分屏 + 差异热图、框选重绘、批量修复；真数据靠 `--patch-inspector` 注入副本 | `inspector/index.src.html:281-314`、`:701-711`、`:861-930` · `quality/export.js:51-106` · `docs/05-inspector.md` | 交互与契约先做到位，数据后接；副作用是画面为程序化绘制、A/B 的 B 侧是 `f+7` 而非真实重绘前后（`docs/05-inspector.md` §6-1、§6-4） |
| 27 | §41 三个「真切感受生成能力」的交互 | 部分落地 | ① 实时显影已做（5 段文案 + 噪点→成形，定时器模拟）；② 参数因果即时反馈（滑块 3 档小图）未做；③ 单帧手术只到「框选 + 整帧重绘」，无局部 mask | `inspector/index.src.html:911-930` · `:828-892` · `docs/05-inspector.md` §6-8 | ②③ 都依赖真实生成端（局部重绘要 ComfyUI inpaint），本机没有推理环境，做了也只能演 |
| 28 | §42 交互性能纪律 | 部分落地（未核实） | 时间轴与热力条走 Canvas ✓；页面内 `seek()` 用 `performance.now()` 自测擦洗延迟并显示 ✓；`IndexedDB + 低清代理 + ±30 帧窗口` 未做（全仓无 `IndexedDB`）；「120 帧首屏 <120ms」无采样记录 → 未核实 | `inspector/index.src.html:695-754`、`:817-822` · 蓝图 `docs/00-blueprint-v1.0.md:873-876` | 120 帧演示数据不足以证明长片场景；真要接长片得先做代理帧管线（未做） |

---

## 2. 偏差的三个总因（比逐行更重要）

1. **零依赖铁律 → 服务层与前端框架整体消失。** `AGENTS.md` 技术栈写死：Node ≥22 内置模块 + 系统 ffmpeg，**没有 `package.json`、不 `npm install`**。
   于是一整层中间件（FastAPI / Redis / MinIO / Vue / TS / LiteGraph）被替换成本仓自带的最小实现（`server/app.js`、`server/jobs.js`、原生 HTML）。
   **判定标准**：只要能力还在、验收命令能跑，就记「等价替代」；把实现差异本身当成缺口会让缺口表永远清不完。
2. **本机没有推理环境 → 一切「真出片」能力只能部分落地。** ComfyUI 已移除、系统 torch 是 `+cpu`（`docs/12-handoff.md:31-32`）。
   所以：本地出片耗时/显存峰值**全是未核实**；画质管线只能用 ffmpeg 后处理顶上（#9）；帧检查器的画面只能是程序化绘制（#26）。
   **判定标准**：拿不到真值就标「未做/未核实」，不许用云端数据代填本地结论。
3. **单机单用户 → 商用工程层（认证/计费/多租户/远端仓库）缺对象。** 只有审计（`server/audit.js`）因为「留痕可回溯」对单机也有用，所以落地了（#12）。
   **判定标准**：没有真实使用方的能力记「未做」而不是「决定不做」——它们是产品化时要补的，不是路线放弃。

---

## 3. 「决定不做」只有两条，其余都还有机会

| 决定不做的能力 | 替代物 | 什么时候该翻案 |
|---|---|---|
| LiteGraph 图编辑器（§11） | 自研三视图 + 常量拓扑（#16） | 真需要用户自由搭图（而不是改参数）时；届时仍要按零依赖重新评估许可证与体积 |
| RIFE / Real-ESRGAN 等第三方 ML 后处理（§4 的一半） | ffmpeg `minterpolate` / `lanczos`（#9） | 允许引入第三方运行时之后；现在每条替代都在 `substitutions[]` 里留了证 |

其余「未做」项按优先级见 [`docs/13-task-cards.md`](13-task-cards.md) 与 [`docs/12-handoff.md`](12-handoff.md) §7 缺口总表。

---

## 4. 怎么用这份表

- 新人路线：`00`（要看什么）→ `01`（边界契约）→ `12`（现状与缺口）→ 本文（为什么和蓝图不一样）。
- 想改架构：先看本文第 2 节的总因——若你打算引入第三方依赖，**先改 `AGENTS.md` 的技术栈条款**，否则所有替代方案会被构建/自检打回。
- 想认领缺口：本文只做「差异登记」，不排期；排期在 `docs/13-task-cards.md`。
