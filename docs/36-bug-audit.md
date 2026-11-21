# 36 · 缺陷修复记录（2026-11-21 全面排查）

> 触发：用户要求「检查所有的 bug」。做法：写 `cloud/audit.mjs`（53 项自动审计，含负面用例与安全），
> 加上状态机全组合穷举、UTF-8 编码链路验证、前端/文档一致性核对。

## 自动化审计能力

```bash
node cloud/audit.mjs --base https://你的后端 --admin <TOKEN>
```

- **A 静态**：模块存在性、ESM 里裸用 require、硬编码 Key、.env 覆盖度
- **B 契约**：8 个接口的正向返回结构（config/states/weights/postprocess/tasks/library/experiments）
- **C 负面用例**（14 项）：非法 JSON、未知路由、缺参、不存在资源、超大 body、超大 limit、空 body…
- **D 安全**：3 种路径穿越、响应体不含 Key、无令牌写管理接口
- **E 一致性**：文档接口清单 vs 实现、站点无本机硬编码、站点无内置 Key

**当前结果：PASS 53 · FAIL 0 · WARN 0**

---

## 本轮修掉的 12 个缺陷

| # | 缺陷 | 严重度 | 现象 | 修复 |
|---|---|---|---|---|
| 1 | **对象存储路径穿越** | 🔴 严重 | `/files/../../etc/passwd` 可读出对象目录外的文件 | 加 `safeObjectPath()`：拒绝 `..`、校验 `path.resolve` 结果必须在对象根目录内；put/get 都走它 |
| 2 | **异步生图未轮询** | 🔴 严重 | 接万相后 `/api/keyframes` 拿到 `undefined` url，静默失败 | 统一 `settleImage()`：有 url 直接用；只有 task_id 就轮询 `/api/v1/tasks/{id}`（3s 间隔、5 分钟超时） |
| 3 | 非法 UTF-8 静默入库 | 🟠 中 | 非 UTF-8 字节被存成乱码（`Сè����תͷ`） | 加 `TextDecoder('utf-8',{fatal:true})`，真正非法字节 → 400 |
| 4 | `.cmd` 含中文 | 🟠 中 | cmd 在 `chcp` 前渲染中文乱码，且门禁断言全 ASCII 失败 | 全英文化，中文说明另放文档 |
| 5 | `.cmd` 直接起服务 | 🟠 中 | 绕过项目统一的 `tools/launch.mjs`（动态端口、单实例、健康门槛） | 改为只转发 `node "%~dp0tools\launch.mjs" %*` |
| 6 | `task-recovery` 冷启动必现超时 | 🟡 低 | 首次运行 100% 失败，重试才过 | worker 用测试专属 `CACHE_ROOT`；恢复期等待 12s→30s；`until()` 超时输出任务状态快照 |
| 7 | `publish_site` 注入静默失效 | 🟠 中 | 正则不支持 CRLF，地址没注入却"看起来成功" | 正则改 `\r?\n` + 函数形态替换（避免 `$'` 被当替换模式） |
| 8 | `selftest --src` 参数解析 | 🟡 低 | `--src` 是第一个参数时 `i > 0` 不命中，链路测试被静默跳过 | 改 `i >= 0` |
| 9 | 后处理把相对路径喂 fetch | 🔴 严重 | `/files/...` 触发 `Failed to parse URL`，增强永远失败 | 有 `output_key` 直接读对象存储；否则用 `PUBLIC_BASE` 补绝对地址 |
| 10 | 后处理输出目录 EACCES | 🟠 中 | 写源目录/`os.tmpdir()` 都被拒 | 统一落 `DATA_DIR/tmp`（云端 `/data/tmp` 持久盘） |
| 11 | `quality.js` 丢失 NaN 校验 | 🟠 中 | `steps:'NaN'` 不再被拒（改双区间时漏掉） | 恢复 `Number.isFinite` 检查并抛 `QUALITY_BAD_SAMPLING` |
| 12 | `quality.js` 引用未定义 `spec` | 🟡 低 | turbo 路径抛 `spec is not defined` | 改用 `load().engine_overrides` |

---

## 已验证但发现"无法根治"的一条

**GBK 字节常恰好构成合法 UTF-8**：

```
GBK "小猫" = d0 a1 c3 a8  →  按 UTF-8 解码 = "Сè"（合法字符）
```

所以后端**无法从字节层区分**"GBK 中文"与"合法的西里尔字符"。当前策略：
- 真正非法字节（如 `0xFF 0xFE`）→ 400 ✅ 实测
- Header 声明 `charset=gbk` 的请求，后端仍按 UTF-8 解（HTTP JSON 规范）
- 浏览器永远发 UTF-8 ✅；只有手写 `curl` 在 Windows 下会踩坑

**缓解**：文档与自检脚本里所有示例都用 `node` 或 UTF-8 文件发送，不用 Windows `curl -d` 直接带中文。

---

## 状态机穷举

8 个状态 × 8 = **64 对转移全部与设计表一致**，终态（succeeded）不可再转移。

```
queued → submitting|cancelled|failed
submitting → running|failed|expired
running → postprocessing|succeeded|failed|expired|cancelled
postprocessing → succeeded|failed
succeeded → （终态）
failed|expired|cancelled → queued（仅重试）
```

---

## 复现全部检查

```bash
# 1. 后端全面审计（53 项）
node cloud/audit.mjs --base http://127.0.0.1:8787 --admin dev

# 2. 离线全链路（15 项，不需 Key）
node cloud/selftest.mjs --src "某条成片.mp4"

# 3. 部署后连通性（12 项）
node cloud/smoke.mjs https://你的后端 --admin <TOKEN>

# 4. 平台门禁（18 模块）
node tools/selftest_all.mjs

# 5. 前端门禁（9 页）
node tools/lint_ui.mjs
```
