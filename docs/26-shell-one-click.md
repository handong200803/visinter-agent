# 26 · ultimate 能力融合进 VisInter-Agent 外壳（一键出片）

> 目标：在外壳（`app/index.html`，VisInter-Agent）里直接完成「选引擎 → 生成 → 预览」，不用跳页。
> 实现：外壳顶部新增「出片」按钮 → 动态注入的模态（引擎 / 提示词 / 进度 / 预览 / 作品库 / 科研台入口）。

## 1. 入口与交互

| 元素 | 行为 |
|---|---|
| header「出片」按钮 | 打开模态；自动读取当前项目 `avp.shell.store.v1` 的 `kf.prompt_prefix` 或 `ch.subject` 填入提示词 |
| 引擎下拉 | `MiniMax H3（音画同步）` / `Wan2.2（5B 本地）` |
| 状态徽标 | `GET /api/h3/status` → ComfyUI 在线/离线 + 并发建议 |
| 生成 | `POST /api/jobs { engine, values }` → 轮询 `/api/jobs/:id`（4s） |
| 完成 | 显示耗时与成片绝对路径 + 「打开」；`<video>` 走 `/api/works/preview` |
| 作品库 | `GET /api/works?limit=5`，每条带「播放」 |
| 科研台 | 链接到 `../ultimate/index.html`（贝叶斯/消融/双版本/五关卡） |

## 2. 三个实现要点（都是踩出来的）

1. **模态必须动态注入 body**：第一版把 `#renderModal` 写在 `<div id="app">` 里，外壳重渲染（`renderProjectBar`/`renderFlow`）会把它冲掉，表现为「点了没反应 / 元素消失」。现在由 JS 在点击时 `insertAdjacentHTML('beforeend')` 到 `document.body`，与外壳渲染解耦。
2. **脚本插入位置**：第一版插在 `try { boot(); }` 前但被 boot 抛错跳过；第二版插到 IIFE 末尾时误留了一个多余的 `})();`，导致整段脚本语法错误（`node --check` 抓到）。现在固定插在**最后一个 `})();` 之前**，并在构建后用 `node --check` 校验内联脚本。
3. **seed 语义**：项目 `kf.seed` 可能是 `-1`（随机），ComfyUI 的 `KSampler.seed` 下限是 0 —— 已在 engine 入口统一收敛（见 docs/25 §3.5）。

## 3. 实测

| 动作 | 结果 |
|---|---|
| 外壳「出片」→ H3 → 生成 | `job_mwnau15s_6e7a52` → **450s** → `20261119_minimax_h3_t2v_00009_.mp4`（1.04 MB，640×384 / 5.17s / 带 AAC） |
| 模态状态 | `ComfyUI 在线`、提示词自动填充 56 字符、作品库 5 条 |
| 重复点击 | 会产生多个任务（已取消两条多余 queued/running）——**下一步应加「已有运行中任务时禁用生成」** |

## 4. 与 ultimate 页的分工

| 页面 | 职责 |
|---|---|
| `app/index.html`（外壳） | 一键出片：选引擎、生成、预览、作品库。面向「快速出片」 |
| `ultimate/index.html` | 科研台：130 节点拓扑、贝叶斯曲线、A/B/C、消融、双版本、五关卡。面向「可复现实验」 |
| `web/params.html`（参数面板） | 258 参数细调 + 同样带引擎下拉的一键生成 |

三者共用同一套 API（`/api/jobs` 的 engine 分支、`/api/works`、`/api/h3/*`），不是三份实现。

## 5. 已知缺口

1. 重复点击会重复提交（无「进行中」互斥）——建议加 `R.job` 存在时按钮保持禁用，直到终态。
2. 模态不显示 `params_digest` 与 workflow 摘要（科研追溯仍要回 `ultimate` 页）。
3. 外壳是 `file://` 可开，但出片需要 http（`/api`）；`file://` 下会提示接口不可达（已有文案）。
