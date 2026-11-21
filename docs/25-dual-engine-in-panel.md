# 25 · 双引擎接入参数面板「一键生成」

> 之前的状态：参数面板点「一键生成」→ `/api/jobs`（无模板）→ `WF_SYNTHETIC_TEMPLATE`，0 秒失败。
> 现在：面板上直接选 **MiniMax H3 / Wan2.2**，点击即按引擎编译可执行工作流并真跑。

## 1. 服务端：`/api/jobs` 增加 engine 分支

```js
POST /api/jobs { engine: 'minimax_h3' | 'wan22', values: {…258…}, device }
```

| engine | 编译 | 尺寸（按 kf.ratio） | 关键参数 |
|---|---|---|---|
| `minimax_h3` | `h3workflow.build()`（13 节点，含音频分支） | 16:9 → 640×384、9:16 → 384×640、1:1 → 512×512、4:3 → 512×384 | steps：`kf.steps≥4 ? 4 : 2`（消融证明 2 步最优）、cfg 1.0、seed 取 `kf.seed`、时长 5–15s |
| `wan22` | `canvasbuilder.executableFor('wan22')`（12 节点） | 16:9 → 832×480、9:16 → 480×832、1:1 → 624×624 | frames 81、steps 取 `kf.steps`（8–30 夹取）、cfg 5.0 |

- 两者都走 `jobs.create({ kind:'local', workflow })` → comfy provider **直传工作流**（不走 wf.js 槽位绑定）。
- job 记录新增 `engine` 字段；归档时按引擎命名（`…_minimax_h3_…` / `…_wan22_…`）。

## 2. 前端：引擎下拉

`web/params.src.html`：

```html
<button id="genBtn">一键生成</button>
<select id="genEngine">
  <option value="minimax_h3">MiniMax H3（音画同步）</option>
  <option value="wan22">Wan2.2（5B 本地）</option>
</select>
```

- `#genEngine { flex: 0 0 auto; width: auto; min-width: 140px; }` —— 修过一次布局：`.input` 默认 `width:100%` 会把右侧参数摘要挤成竖排。
- 提示文案同步改为「引擎可选 MiniMax H3 或 Wan2.2，均免费、无需 API key」。

## 3. 实测（本机）

| 项 | 结果 |
|---|---|
| API 提交（H3） | `job_mwn97t1i_cb83fe`，`kind=local`、`provider=comfy`、`engine=minimax_h3`，202 受理 |
| 阶段 | 先 CPU 文本编码（GPU 14% / 1.8GB）→ 再采样（GPU 98% / 7.2GB），与 32B 文本编码器跑 CPU 的预期一致 |
| 页面 | 引擎下拉正常显示并默认 H3；`gen-meta` 不再竖排 |
| 页面点「一键生成」 | `job_mwn9p5kq_f33370` → **405.7s** 出片（640×384/124 帧/5.17s），归档 `20261119_minimax_h3_t2v_00007_.mp4`；面板显示「已完成 · comfy · 405.7s · 100%」 |
| 缓存命中复跑 | `job_mwna22l0_ffaa90` → **0.5s** 完成（ComfyUI 同参数缓存），归档自动加 `-2` 后缀 |
| 修复 | `renderGen` 里 `job.output` 是对象时显示成 `[object Object]` → 改为取 `output.file` 并加「预览」链接（走 `/api/works/preview`） |

## 3.5 踩坑：`kf.seed = -1` 让工作流校验失败

面板里 `kf.seed` 默认 **-1**（表示「随机」），但 ComfyUI 的 `KSampler.seed` 最小值是 **0**：

```
COMFY_VALIDATION_FAILED · value_smaller_than_min · widget: seed · Value -1 smaller than min of 0
```

- 修复：在 **engine 入口统一收敛** —— `app.js` 的 engine 分支、`h3workflow.build`、`canvasbuilder.executableFor` 三处都做
  `seed < 0 → 随机 [0, 2^31-2]`；不再假设调用方传的是合法值。
- 教训（通用）：**面板语义域 ≠ 引擎值域**。用户侧的「-1 = 随机」到了 ComfyUI 就是非法值；这类转换必须发生在引擎适配层，而不是让 UI 自己记得处理。

## 4. 已知限制（写进面板提示更诚实）

1. **H3 的文本编码器在 CPU**（32B，显存放不下）：采样前的文本编码是主要等待项，整体 3–15 分钟。
2. **Wan2.2 在 8G 卡上慢**：832×480 / 81 帧 / 20 步需要长时间换页；实测 320×480 / 17 帧 / 6 步 110 秒。面板默认 832×480，若觉得慢可把 `kf.ratio` 改 9:16（480×832，帧数仍 81）或直接用 `ultimate` 页的 H3 通道。
3. **分辨率不由面板的 `kf.resolution` 直接决定**：引擎层按 `kf.ratio` 映射到安全尺寸（8G 显存优先），`kf.resolution` 仍进参数快照但不驱动出图尺寸——这是刻意的，避免面板填 1536 直接把 8G 卡打爆。
