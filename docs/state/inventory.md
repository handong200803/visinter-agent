# 目录规模与阅读成本（自动生成 2026-11-17 11:24）

仓库文件 133 个 / 4.5 MB（`docs/state/` 与本文件本身也在内）。

| 目录 | 文件数 | 文本行数 | 角色 |
|---|---|---|---|
| `.qoder/` | 3 | 176 | Qoder 规则 |
| `app/` | 4 | 11093 | 平台外壳（唯一入口） |
| `assets/` | 1 | 0 | 图标 |
| `canvas/` | 3 | 10495 | 三视图画布 |
| `core/` | 3 | 630 | 求解器/估算器（冻结内核） |
| `docs/` | 20 | 2832 | 架构与模块文档 |
| `inspector/` | 5 | 1014 | 帧检查器 |
| `market/` | 21 | 14115 | 模板格式/打包/签名/仓库 |
| `plugins/` | 14 | 5723 | 声明式插件加载与合并 |
| `prompt/` | 5 | 2241 | 提示词编译层 |
| `quality/` | 11 | 6517 | 逐帧质检管线 |
| `server/` | 9 | 4410 | 本地后端/队列/provider |
| `spec/` | 3 | 6050 | 唯一真相源数据 |
| `tools/` | 22 | 4384 | 构建器/自检/快照/lint/e2e |
| `ui/` | 2 | 343 | 视觉令牌与模块骨架 |
| `web/` | 2 | 7919 | 参数工作台 |

## 单文件 >1000 行：**不要整读**，先 grep 定位再分段读

| 文件 | 行数 | 大小 |
|---|---|---|
| `.\app\index.html` | 8679 | 248 KB |
| `.\canvas\canvas.html` | 8455 | 231 KB |
| `.\web\params.html` | 7222 | 179 KB |
| `.\market\index.html` | 6139 | 209 KB |
| `.\spec\params.registry.json` | 5666 | 110 KB |
| `.\market\snapshot.json` | 4982 | 148 KB |
| `.\quality\index.html` | 2337 | 95 KB |
| `.\plugins\index.html` | 2234 | 96 KB |
| `.\canvas\canvas.src.html` | 1930 | 88 KB |
| `.\app\index.src.html` | 1744 | 88 KB |
| `.\server\index.html` | 1720 | 74 KB |
| `.\quality\snapshot.json` | 1275 | 40 KB |
| `.\plugins\plugins.src.html` | 1052 | 53 KB |

生成物（`*/index.html`、`web/params.html`、`canvas/canvas.html`、`*/snapshot.json`）行数大是正常的：它们是构建期内联的单文件产物，改要改对应的 `*.src.html` / 真源。
