# 21 · 四项收尾（归档 / 并发 / 分辨率 / A-B-C 真机）

> 承接 `docs/20`：H3 已能页面点生成。本文收掉四项遗留。

## 1. 成片归档 + 作品库

| 项 | 实现 |
|---|---|
| 归档 | `server/archive.js`：任务成功后把 ComfyUI output 复制到 `%CLOUD_ROOT%\02-视频\成片\<日期>_<引擎>_<原名>.mp4`，同名自动 `-2/-3`；索引 `_index.json`（最新在前，最多 500 条） |
| 容错 | Windows `copyFile` 偶发 `EPERM`（杀软/索引）→ 3 次重试 + 读写回退；失败只记 `archive_error`，**不把任务打成 failed** |
| 作品库 | `GET /api/works`、`GET /api/works/preview`（只读成片目录，路径穿越 400）；页面「成片作品库」列表 + 播放 + 放大 |
| 回填 | `tools/backfill`（一次性脚本，已跑）：3 条历史 H3 成片 + 3 条 A/B/C 全部入库，当前 **6 条** |

## 2. 并发建议（只建议，不强制）

`GET /api/h3/status` 返回：

```json
"concurrency": { "current": 1, "recommend": 1, "over": false,
  "reason": "可用显存 8151MiB → 建议并发 1（H3 单条即吃满 8G；超配只会互相换页）" }
```

- 推荐值按**总显存**算（≥46G→3、≥23G→2、否则 1）；页面显示「并发 1（建议 1）」，超配标红但**不拦提交**。
- 早期用「当前可用显存」算过，任务跑着时只剩 1.3G，安全线被压到 0.19MP（误报），已改为总显存口径。

## 3. 分辨率守卫 + 2x 放大

| 项 | 实现 |
|---|---|
| 风险估计 | `h3workflow.estimateRisk`：按 `width×height×frames` 与显存缩放（8G 基准 safe ≤ 0.25MP、warn ≤ 0.42MP），返回 `low/mid/high` + 人话理由；`/api/h3/plan` 随包返回 |
| 页面 | 改宽高即时刷新「分辨率风险：低/偏高/高（可能 OOM）」，**只提示不拦截** |
| 放大 | `POST /api/h3/upscale`：ffmpeg `lanczos 2x + unsharp`，输出 `..._2x.mp4`；`substitution` 字段明说「非模型超分；H3 无公开 latent upscale 权重」 |
| 为什么不是模型超分 | Comfy-Org 的 H3 仓库里**没有** latent upscale 权重（查过 `?blobs=true` 全量文件），所以不做虚假承诺 |

实测：`20261119_minimax_h3_t2v_00003_.mp4` → `..._2x.mp4`（2.99 MB，960×1024），接口返回 200。

## 4. A/B/C 真机对照（三条都真跑 + 四维打分）

命令：`node tools/h3abc.mjs --prompt "..." --seconds 5`

| 组 | 参数 | F | Sface | Sflow | Sstyle | Sbad |
|---|---|---|---|---|---|---|
| A 模型默认 | steps 4 / cfg 1.0 / shift 12 | **0.8326** | 0.8075 | 1.0000 | 1.0000 | 0 |
| B 经验参数 | steps 6 / cfg 1.5 / shift 10 | 0.8090 | 0.7400 | 1.0000 | 1.0000 | 0 |
| C 贝叶斯最优（proxy 寻优 → 真跑） | steps 5 / cfg 1.0 / shift 12 | 0.8253 | 0.7866 | 1.0000 | 1.0000 | 0 |

- **结论：H3 的 turbo 4 步默认值就是最优**；加到 6 步 / CFG 1.5 反而让 Sface 掉 6.75%（过引导）。
- C 组参数来自 GP+EI 的 proxy 寻优（目标 steps 6 / cfg 1.6 / shift 10），落点是 5/1.0/12 —— 代理目标本身偏保守，所以没打败 A。**代理寻优不能替代真机搜索**，这条要写进答辩的局限性。
- 三组 Sflow/Sstyle 全 1.0：同一 prompt/seed 下构图与调色几乎一致，差异集中在人脸细节（Sface）。
- CSV/JSON：`%CLOUD_ROOT%\04-数据\h3abc\2026-11-19_h3_abc.{csv,json}`；三条成片已归档（`minimax_h3_abc`）。

## 5. 门禁

`selftest_all` **PASS 12 · FAIL 0**；`lint_ui` **9 页全绿**；页面脚本单独做了 `node --check`（曾因 `split('\')` 反斜杠转义导致整段 IIFE 不执行，已修）。
