# 20 · 本地 H3 接入平台任务通道（kind=local）

> 目标：页面上直接点「排队生成」，走平台队列 → comfy provider → 本地 H3，产出可预览的 5s 音画同步视频。

## 1. 链路

```
页面 ultimate/index.html「本地 H3 生成」
  → POST /api/h3/run            （h3workflow.build 注入参数，生成 API 图）
  → jobs.create(kind=local)     （队列；provider 固定 comfy，与视频主通道解耦）
  → providers/comfy.run         （job.workflow 直传，跳过 wf.js 槽位绑定）
  → ComfyUI /prompt → 执行 → /history
  → 页面轮询 /api/jobs/:id      → 成功后用 /api/h3/preview 播放 mp4
```

## 2. 新增/改动

| 文件 | 作用 |
|---|---|
| `server/h3workflow.js` | 读 `templates/h3_t2v_min.json`，定点注入 prompt/宽高/帧数/步数/CFG/seed/shift/LoRA/音频开关；帧数按 **17k+5、24fps、124–362** 对齐；返回 applied/unapplied/warnings |
| `server/providers/comfy.js` | 支持 `job.workflow` **直传**（不再强行走 wf.js 的 Wan2.2 bind）；`clientId` 与提交时一致 |
| `server/comfy.js` | 修 WS 收不到完成事件的 bug：提交用 `avp`、WS 用随机 id → 事件被 ComfyUI 过滤。现在共用同一 clientId，并新增 **15s history 轮询兜底** |
| `server/jobs.js` | 接受 `workflow` 字段并落盘（重跑/复现凭据） |
| `server/app.js` | `GET /api/h3/status`、`POST /api/h3/plan`、`POST /api/h3/run`、`POST /api/h3/direct`、`GET /api/h3/job/:id`、`GET /api/h3/preview`（只读 `ComfyUI/output`，路径穿越 400） |
| `ultimate/ultimate.src.html` | H3 面板：提示词/宽高/时长/步数、排队生成、状态轮询、`<video>` 预览、`localStorage` 记住上次 job（刷新可恢复） |

## 3. 实测

| 项 | 结果 |
|---|---|
| 页面提交 | 点「排队生成」→ `job_mwmzo5au_a1d39c` 入队，页面显示「排队/生成中 · queued」 |
| 任务通道（API 直提） | `job_mwmz6agb_be7fc8` → ComfyUI `history` **status=success**，输出 `h3/t2v_00001_.mp4`，480×512 / 124 帧 / 5.17s；平台侧耗时 **733s** |
| 预览路由 | `GET /api/h3/preview?file=h3/t2v_00001_.mp4` → 200；`?file=../config.json` → 400 |
| 修掉的 bug | 提交 `client_id='avp'` 但 WS 用 `avp-<random>` → ComfyUI 按 client 过滤执行事件，任务永远 `running`；已统一 clientId + history 兜底 |

## 4. 参数面（页面可调 → 注入点）

| 页面字段 | 节点 | 约束 |
|---|---|---|
| 提示词 | `7.inputs.prompt` | 非空；中英均可 |
| 宽 / 高 | `7.inputs.width/height` | 32 倍数（自动对齐，给 warning） |
| 时长（秒） | `7.inputs.length` | 换算到 17k+5 网格：5s=124、7s=173、15s=362 |
| 步数 | `9.inputs.steps` | turbo LoRA 甜区 4；关 LoRA 需 20+ |
| CFG | `9.inputs.cfg` | turbo 1.0；常规 4–6 |
| seed | `9.inputs.seed` | 默认随机 |
| shift_video / shift_audio | `2.inputs` | 默认 12 / 3 |
| LoRA 强度 | `3.inputs.strength_model` | 0 = 关闭（会给 warning） |
| 音频 | `11/12` | 关掉会删 `audio` 输入（不推荐，H3 卖点是音画同步） |

## 5. 已知限制

1. **单条 5s 约 7–13 分钟**（8G 显存 + 16G 内存），受权重换入影响，不是采样慢。
2. 队列并发默认 1（`AVP_CONCURRENCY`），连点会排队。
3. 平台不缓存已加载模型；ComfyUI 自己缓存，**同一进程内第二条会明显变快**。
4. `preview` 只读 `ComfyUI/output`，产物不会自动复制到 `%CLOUD_ROOT%`；要进作品库需再加一步归档（下一步）。
