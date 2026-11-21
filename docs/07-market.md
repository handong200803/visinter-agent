# 07 · 模板市场：`.avptpl` 格式、打包器、签名、本地仓库

> 这一层解决的是"**创作者愿意做、平台能收钱**"：模板必须可打包、可校验、可交易。
> 代码在 `market/`（能力库）与 `tools/tpl.mjs`（CLI），格式定义在 `market/spec/`，零依赖、不联网。

---

## 1. 为什么是单文件 JSON（而不是 zip）

`.avptpl` 就是一份 UTF-8 JSON 文本，后缀只是给系统和用户看的标记。这个取舍是刻意的：

| 维度 | 单文件 JSON（采用） | zip / tar 包（否决） |
|---|---|---|
| 用户打开 | 双击→记事本能直接读，光标一搜就知道某个参数是多少 | 要装解包工具；预览图/元数据藏在压缩流里 |
| 版本管理 | git 按行 diff，"这个版本把 `kf.steps` 从 28 改成 32"一眼可见 | 二进制整体变化，diff 无意义，评审只能靠人肉比对 |
| 安装安全 | 只需 `JSON.parse`；没有 zip-slip 路径穿越、没有解压炸弹、没有损坏的中央目录 | 解包器要防路径穿越/符号链接/递归炸弹，攻击面大一截 |
| 签名 | 规范化 JSON 直接 HMAC，语义清楚 | 要先解包或对压缩字节签名，任一工具重打包都会破签名 |
| 体积 | 存的是"与默认值的差异"，5 个样例实测 3.2–3.7 KB | 同量级，压缩后只小 1–2 KB，不构成理由 |

代价：**参数明文可读 → 抄参数几乎没有门槛**。这是明确的取舍（可 diff > 防拷贝），
所以本方案不声称"签名=防盗版"，见 §5。

---

## 2. 格式（`market/spec/template.schema.json`）

顶层字段（全部必填，`signature` 可为 `null`）：

| 字段 | 含义 | 校验点 |
|---|---|---|
| `schema` | 固定 `ai-video-platform/template` | 与 engine 的 `/preset` 区分 |
| `format` | 包格式版本，当前 `1` | `>1` 必须拒绝解析 |
| `id` | 市场唯一标识，`^[a-z0-9][a-z0-9._-]{2,63}$` | 文件名/URL/索引键都用它 |
| `name`/`version`/`author` | 展示与版本 | version 必须 `x.y.z` |
| `license` | `free` / `paid` / `revenue_share` | 必须等于 `pricing.mode` |
| `registry_version` | 打包时的参数表版本 | **不等于当前平台 → 拒绝安装** |
| `created` | ISO 时间 | 打包时可固定，便于复现 |
| `tags` / `stage_focus` / `cover_params` | 检索、主张板块、卡片展示参数 | 板块必须属于 7 个已知 stage |
| `values` | **与默认值的差异**（`exportPreset` 语义） | 键必须存在；越界即错 |
| `checksum` | `djb2:xxxxxxxx`，对键名排序后的 `values` 求 djb2 | 与 `engine._internal.djb2` 同构 |
| `lineage.derived_from` | 血缘 id 列表 | 派生结算用（见 `license.md` §4） |
| `compat` | `min_platform` / `max_tested` | 低版本拦、高版本只告警 |
| `pricing` | `mode` / `price_cny` / `share` / `basis` | 三条自洽规则见 license.md R1–R3 |
| `signature` | HMAC-SHA256（`algo`/`key_id`/`value`/`signed_at`） | 不校验内容，只校验完整性 |
| `estimate_meta` | 打包时的估算快照（显存/耗时/质量/电费） | 可选，但市场列表靠它排序 |

`values` 只存差异的理由：258 参数全量约 40 KB，而一个模板通常只动 60–70 项；
只存差异让"这个模板到底主张什么"变成可读的短列表，也让 diff 干净。

---

## 3. 三个核心函数（`market/pack.js`）

```
pack(registry, values, meta)  → 模板对象
    内部一定调 engine.exportPreset（checksum 语义与 .preset 完全一致），
    再补 lineage / compat / pricing / estimate_meta。
    定价用"跑出来的质量分"推，不用作者自报（suggestPrice 是纯函数）。

verify(tpl, registry)         → {ok, errors[], warnings[]}
    结构 → 版本兼容 → checksum → 值域 → 板块/标签 → 定价自洽 → 签名/估算缺失。
    能判死的判死，只能提示的给 warning；**不抛异常**（批量校验不能被打断）。

applyTo(tpl, registry, opts)  → {values(258), resolved, unknown, checksum_ok, estimate}
    走 engine.importPreset 的夹紧逻辑 → 再跑 rules.linkage 求解 → 再 estimate。
    与 pack 共用同一条 hydrate 管道，所以"打包估算 = 应用后估算"是可断言的（selftest §6）。
```

`verify` 的错误码全集（CLI 直接打印，前端可映射文案）：
`not_object` `bad_schema` `bad_format` `missing_field` `bad_type` `bad_id` `bad_version`
`registry_version_mismatch` `platform_too_old` `checksum_mismatch` `unknown_param`
`value_out_of_range` `empty_stage_focus` `unknown_stage` `too_many_tags` `bad_tag`
`bad_license` `pricing_mode_mismatch` `bad_price` `free_must_be_zero` `paid_must_cost`
`bad_share` `bad_lineage` `bad_derived_from`
警告：`untested_platform` `unsigned` `unknown_algo` `no_diff` `cover_param_is_default` `no_estimate` `no_share_basis`

---

## 4. 签名（`market/sign.js`）

- 算法：`HMAC-SHA256`（`node:crypto`，零依赖）。
- 载荷：模板对象**去掉 `signature` 字段**后，递归按 key 排序再 `JSON.stringify`。
  两处必须这么做的原因：① 键序不稳会导致"内容相同、签名不同"；② `signature` 自身不能进载荷（否则自指）。
- `key_id = sha256(secret)[0..16]`：公开指纹，能区分多把密钥又不泄露密钥。
- 返回**新对象**，不原地改：作者往往要保留未签名版本做 diff。

**它能保证**：文件从作者发出后没被改过；改一个字节（哪怕连 checksum 一起重算）验签都会失败。
**它不能保证**：版权、防抄、防逆向、授权控制。参数在文件里是明文，读到就能抄——市场话术不得夸大成"加密/防盗版"。
真正约束交易的是 `market/spec/license.md` 的条款与结算流水。

---

## 5. 授权与定价（`market/spec/license.md` 是唯一口径）

三种模式：`free`（免费可再分发）/ `paid`（一次性买断）/ `revenue_share`（分成，前置价 ×0.6 + 净流水 60/40）。
定价不是拍脑袋，是**质量分档基价 + 板块数加价 + 4K 加价**：

| 档位（质量分） | 基价 | 加价项 |
|---|---|---|
| draft <60 | ¥0（强制 free） | — |
| basic 60–69 | ¥8 | 每多 1 个 `stage_focus` +¥2 |
| pro 70–79 | ¥18 | 4K 交付 +¥4 |
| plus 80–89 | ¥32 | 分成模式 ×0.6 |
| flagship 90–99 | ¥48 | 天花板 ¥199 |

样例复算（`selftest §7` 断言）：商业产品转台 质量 77 → pro 18 + 2 板块(+4) + 4K(+4) = **¥26**。

---

## 6. 本地仓库（`market/store.js`，绝不联网）

```
market/store/index.json                     索引（列表页要用的字段，正文不进索引）
market/store/tpl/<id>/<version>.avptpl      模板正文（每个版本一份，永不互相覆盖）
market/store/tpl/<id>.avptpl                旧扁平布局：读到自动搬进版本目录（迁移，不丢文件）
```

- `install(src,{upgrade,force})`：路径或对象都收；先 `verify`（不通过拒绝，`force` 才放行）；
  新版本或同版本不同内容 → `E_VERSION_CONFLICT`，必须显式 `upgrade`；同版本同 checksum 重装 → 安装量 +1，不新建条目、不产生重复版本记录。
- `list()` / `search({q,tag,tags,stage,license,min_price,max_price,signed,sort,limit})`。
- `get(id,{version})` / `versionsOf(id)` / `rollback(id,version)` / `remove(id,{version})` / `rate(id,1..5,{rater})`：**同一 rater 只计最后一次**（防自刷分）。
- `rebuild()`：索引丢了可从 `tpl/` 目录重扫，且**保留**索引里已有的安装量与评分；盘上没有正文的 id 不会进索引（无幽灵条目）。
- 排序口径（写死在 `rankScore`，界面不再另算）：
  `rank = 安装量 + 2×平均分 + 0.5×评分数`——平均分乘 2 让"5 分 vs 3 分"约等于 4 次安装的差距；
  评分数乘 0.5 让"50 个人打 4.8"略优于"1 个人打 5"。
- 索引与正文都原子写（`.tmp` → `rename`），崩溃不会留半截 JSON。

### 6.1 版本目录

同 id 的多个版本按 `store/tpl/<id>/<version>.avptpl` 并存，索引里 `item.versions[]` 列出全部版本、
`item.version` 是**当前激活**的版本，`item.file` 指向激活版本的正文。装 v2 不覆盖 v1 的正文——
所以"回滚"不需要重新下载/重新打包，只是把激活指针移回去。旧扁平布局 `tpl/<id>.avptpl` 首次被
`install`/`rebuild` 遇到时会被搬进版本目录，老用户的文件不会被删掉。

### 6.2 编译贯通（`workflow_ref`）

模板不再只是参数快照：`pack()` 会附一份最小 ComfyUI API 图（`workflow`，当前注册表 4 个节点）
和口径 `workflow_ref{kind,format,registry_version,nodes,targets,bindings}`，两者都进签名载荷。
`node tools/tpl.mjs workflow <id> --payload` 直接输出 `POST /api/jobs` 的整份 body
（`values` 走 `applyTo` 的联动求解，`template` 就是这张图），服务端 `server/wf.js#compileWorkflow`
无需任何改动即可编译：6 个有绑定的参数全部落地，其余 252 个仍如实进 `unbound[]`。
图是**绑定快照图**（`synthetic:true`，没有采样链/SaveImage），不声称能直接喂真 ComfyUI。
老包缺 `workflow_ref` 时 `verify` 只给 `no_workflow` 警告，`jobPayload()` 明确报 `E_NO_WORKFLOW`。

### 6.3 回滚

`node tools/tpl.mjs rollback <id> <version>`：切激活版本，幂等（已是该版本 → `changed:false` 不写盘），
回滚后立刻打印差异参数与预估，便于对拍"参数与预估都回到旧版"。
`node tools/tpl.mjs versions <id>` 看版本表，`tpl list` 在主行标 `+1` 并补一行 `↳ 版本：1.2.0(当前) / 1.1.0`。
回滚不改安装量/评分（它们属于模板，不属于某个版本）。

---

## 7. CLI 一览（`node tools/tpl.mjs <cmd>`）

| 命令 | 作用 |
|---|---|
| `pack --from-preset <file> --name 名称 [--id][--license][--tags 古风,特写][--stage-focus][--device T0][--sign --secret S][--out out.avptpl]` | 从 engine 预设（或裸 values）打模板包 |
| `verify <file> [--json] [--secret S]` | 结构+版本+checksum+值域；带 secret 顺带验签 |
| `install <file> [--upgrade]` | 装入本地仓库 |
| `list [--limit N]` | 仓库列表（价格/评分/安装/显存比/单格秒/质量同屏） |
| `search --tag 古风 [--q][--stage][--license][--max-price][--sort rank\|price\|new\|rating]` | 检索 |
| `apply <id\|file> [--version x.y.z] [--to-json] [--device T1] [--estimate]` | 落地成 258 参数；`--to-json` 只把参数写 stdout |
| `versions <id>` / `rollback <id> <version>` | 版本表（标激活）/ 回滚激活版本（幂等） |
| `workflow <id\|file> [--json\|--payload] [--device T1]` | 编译成 ComfyUI API 图；`--payload` 直接出 `POST /api/jobs` 整份 body |
| `show <id> [--json]` | 详情（含 workflow_ref 与版本列表） |
| `rate <id> <1-5> [--rater 名字]` / `remove <id> [--version X]` / `sign <file> --secret S` | 评分 / 卸装（可只删某版本）/ 补签名 |
| `selftest` | 跑 `market/selftest.js`（同一份代码） |

---

## 8. 五个示例模板（`market/samples/`）

生成器是 `market/build_samples.js`（只写差异，checksum/估算现算，重跑字节一致）。
`market/samples/prev/` 另存历史版本（当前 1 条：`oriental-ink-portrait-1.1.0`），与当前版一起装进
版本目录，供 `rollback` 演示与自检对拍；它不进 snapshot（快照只扫 `samples/*.avptpl`）。

| 模板 | 设备 | 显存比 | 单格 | 质量 | 授权/定价 | 主张 |
|---|---|---|---|---|---|---|
| 东方古风人物特写 `oriental-ink-portrait` | T0 | 6114/6900 = 88.6% | 181s | 80 | paid ¥36 | 工笔+大留白+局部 i2v(480p) |
| 商业产品转台 `product-turntable-pro` | T1 | 6260/9600 = 65.2% | 205s | 77 | paid ¥26 | 1:1 构图+环绕视差+4K 交付 |
| 漫剧 3 格分镜 `manju-3panel-strip` | T0 | 6114/6900 = 88.6% | 89s | 80 | 分成 ¥22 | 九宫格+双 ControlNet+赛璐璐 |
| 写实纪录访谈 `doc-interview-real` | T2 | 6114/14200 = 43.1% | 170s | 80 | paid ¥36 | 中景保留口型（关掉 closeup_only）+23 LUFS |
| 赛博夜景运镜 `cyber-night-dolly` | T3 | 6177/21800 = 28.3% | 140s | 82 | 分成 ¥22 | 2.35:1+5 层视差+雨雾霓虹 |

注意 T0 两条是 88.6%（平台默认分辨率本身就贴着 8G 上限），在 `T0-low`（可用 4127 MiB）上会 `block`——
这不是模板写错，而是 8G 笔记本 + 桌面占用高的真实边缘，degrade 会给出降档方案。

---

## 9. 自检（`node market/selftest.js`）

91 项断言、10 组，全绿才打印 `全部通过`：
样例全部 verify 通过 → 篡改 values 被 checksum 检出 → 版本不匹配/平台过低被拦 →
签名往返/篡改/换密钥/键序打乱/未签名 → store install→list→search→rate→remove→rebuild 全链路（打印真实条数）→
`applyTo` 估算与打包估算逐项相等 → 定价规则表可复算 → `.avptpl` 与 `.preset` checksum 互通 →
**版本目录/回滚/自愈**（两版本并存、回滚后 checksum 与预估逐项回到旧版、幂等重装、删正文后无幽灵条目且安装量与评分保留）→
**编译贯通**（用真的 `server/wf.js#compileWorkflow` 对拍：6 个参数落地、252 个进 unbound、`ch.subject` 真进了 CLIP Text Encode.text，外加 4 类坏包判死与 1 类老包只告警）。

---

## 10. 已知缺口

1. **索引仍是安装量的唯一载体**：读路径自愈（剔除正文已删的版本）与 `rebuild()`（保留安装量/评分）都只修"索引与文件不同步"；把 `index.json` 整个删掉时，安装量只能按"至少装过 1 次"重算。
2. **版本目录只增不减**：`install`/`rollback` 不会清理旧版本，没有 TTL、容量上限或"只留最近 N 版"的策略；`remove <id> --version X` 可手工瘦身，卸装整条才会删目录。
3. **签名没有密钥轮换与吊销**：`key_id` 只是指纹，没有"某 key 已泄露请重签"的机制；演示密钥写在 `build_samples.js` 里，不属于生产用法。
4. **`estimate_meta` 与真实机器可能偏差**：它基于 `spec/models.catalog.json` 的器件表，实际机器若被别的东西占显存（例如 T0-low 场景）会偏乐观；客户端应以本地 `estimate` 为准，模板里的只作"作者声明"。
5. **派生结算只到规则层**：`license.md` §4 写了 30%/层、累计 ≤45%，但没有任何代码统计订单流水，结算仍需人工/外部系统执行。
6. **无远端仓库**：`store.js` 只做本地文件系统，索引是单机真相；多机同步要另做签名校验+合并（本任务明确要求不联网）。
7. **`stage_focus` 反推是启发式**：按"改了多少个板块的参数"取 top3，作者若只改 1 个板块会得到 1 项，需要手工补 `--stage-focus`。