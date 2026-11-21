# 04 · 插件体系（声明式 / 可校验 / 可沙箱运行）

> 写域：`plugins/**`、`tools/plugin.mjs`、`docs/04-plugins.md`。本文所有输出均为本机实测（2026-11-16，Node v24.21.0，Windows）。

## 1. 核心决策：插件只能是声明式 JSON，永远不 `require` 插件代码

四类插件（`model` / `node` / `preset` / `ui`）共用一个 `plugin.json`，加载器**只做三件事**：读 JSON、按 schema 校验、把校验通过的数据叠进运行时注册表。全流程没有一次 `require()` 或 `import()` 指向插件目录。

理由（威胁模型，不是洁癖）：

1. **`require` 一次 = 执行任意代码**。Node 里不存在"只读的 JS"：拿到 `require` 就能 `fs` 写盘、`child_process` 起进程、`net` 出网，`permissions` 声明只是自我申报，拦不住 `process.mainModule`。插件目录是唯一由外部作者写入的位置，一旦允许执行，整套"参数 → 求解器 → 工作流"的确定性就没了。
2. **需求本来就不需要代码**。插件要提供的是数据：参数条目、模型标定数字、预设值、主题 token。能力边界与需求完全重合，声明式没有牺牲表达力，却把攻击面压缩到 `JSON.parse` + 字段校验。
3. **可审计**。一份 manifest 能被 diff、被 schema 校验、被人工复读；一个 `.js` 插件不行。审计成本决定插件生态能否在"要跑用户素材"的场景里存在。
4. **失败可解释**。所有拒绝都带字段路径（`$.contributes.params[1].impact.quality`），作者能自己修；代码插件的崩溃只能靠读栈。

## 2. 文件清单

| 文件 | 职责 |
| --- | --- |
| `plugins/schema/plugin.schema.json` | 手写 draft-07 schema，四类插件共用；`if/then` 约束每类必须带的 `contributes` 子字段 |
| `plugins/loader.js` | 最小 JSON-Schema 子集解释器 + 语义校验 + `mergeRegistry` + `loadAll`（CJS，零依赖） |
| `tools/plugin.mjs` | CLI：`list / validate / install / info / selftest`（ESM，零依赖） |
| `plugins/selftest.js` | 10 组、32 条断言的自检，只读磁盘、无副作用 |
| `plugins/packs/sample-model-pack/` | 示例：新增 1 个模型（32B Q4，`provenance=estimate`） |
| `plugins/packs/sample-node-pack/` | 示例：`keyframe` 板块新增节点 `detail-polish` + 2 个参数（带 hint/bind） |
| `plugins/packs/sample-preset-pack/` | 示例：预设包，values 由 `core/engine.js` 的 `exportPreset` 生成、带 djb2 checksum；`gen-preset.js` 是生成器 |
| `plugins/packs/sample-ui-pack/` | 示例：`ui` 类，2 个主题 + 3 块面板（挂 `stage-sidebar` / `inspector-right` / `toolbar`），带 Ed25519 签名 |
| `plugins/keys/trusted.json` | 可信公钥清单（扁平 `{key_id: base64 SPKI}`）；验签只认这里 |
| `plugins/keys/dev-keypair.json` | 本地示例签名用的开发密钥对（含私钥，**仅供可复现**；生产密钥离线保存） |
| `plugins/fixtures/` | 三个反例：坏 manifest、版本不满足、声明 `exec`（selftest 用，**不在** `packs/` 扫描范围内） |

## 3. manifest 最少字段（node 类，可直接落盘）

```json
{
  "schema": "ai-video-platform/plugin",
  "id": "my-node-pack",
  "name": "我的节点包",
  "version": "1.0.0",
  "type": "node",
  "engines": {
    "platform": ">=0.1.0"
  },
  "permissions": [],
  "contributes": {
    "node": {
      "id": "my-node",
      "title": "我的节点",
      "stage": "keyframe"
    },
    "params": [
      {
        "key": "kf.my_strength",
        "stage": "keyframe",
        "type": "int",
        "default": 30,
        "min": 0,
        "max": 100,
        "step": 1,
        "label": "我的强度",
        "hint": "写清影响什么、甜区在哪、过头会怎样。",
        "tier": "L3",
        "impact": {
          "vram": 0,
          "time": 0.05,
          "quality": 0.18
        },
        "bind": {
          "target": "My Node",
          "widget": "strength"
        }
      }
    ]
  },
  "signature": {
    "key_id": "avp-dev-local",
    "alg": "ed25519",
    "sig": "aUDcKDuw4FMqTWYmkfjNn2ay2VQ4FwY4AgNkOonqWp5D+QEopKdfNoYxGNc1FxHLZzfAq2Dx5Zd+HUSYBR4fAw=="
  }
}
```

`label/hint/tier/impact/bind` 之所以全部必填：缺 `hint` 的参数用户不知道往哪调；缺 `impact` 求解器算不出显存/耗时；缺 `bind` 的 UI 不知道怎么挂控件。

> 上面这份示例带 `signature`（用 `plugins/keys/dev-keypair.json` 这把本地开发密钥签的）。改它任何一个字段，签名立刻失效（`PLUGIN_BAD_SIGNATURE`），selftest 第 10 组会变红——这是故意的：文档示例必须是一份**真能通过验签**的 manifest。重签：`node tools/plugin.mjs sign <包目录> --write`。

## 4. 四类插件各贡献什么

| type | `contributes` | 合并结果 | 硬校验要点 |
| --- | --- | --- | --- |
| `model` | `models[]`（`group` 运输字段） | `registry.models[group]` 追加 | `group ∈ {keyframe,i2v,voice}`；`id` 大小写不敏感去重；`resident_mib.fp16` 必填；`provenance` 必须自报 |
| `node` | `node` + `params[]` | `registry.params` 追加 + `registry.node_plugins[id]` | `stage` 必须存在；key 前缀必须属同一 stage；key 不得冲突；`impact` 三值 0..1 |
| `preset` | `preset`（`exportPreset` 产物） | `registry.presets[]` 追加 | `registry_version` 必须等于当前注册表版本；values 的 key 必须存在；checksum 实算比对 |
| `ui` | `ui.themes[]` / `ui.panels[]` | `registry.ui` 合并 | token 名必须 `--` 开头；值禁 `url()/javascript:/@import/<script>`；面板字段必须指向已存在参数 |

## 5. 权限模型：默认全拒，`exec` 只登记不注入

- `permissions` 缺省为 `[]`：**全拒**。白名单只有 `fs:read | net | exec | gpu`，schema 用 `enum` 卡死，写别的值直接拒。
- 语义是**声明式能力标签**（给审计与未来的宿主开关用），不是运行时授权——因为根本没有运行时。加载阶段不发网络请求、不分配显存、不打开文件。
- `exec` 是唯一的例外语义：声明 `exec` 的包**不注入**，`plugins[].state = 'needs-review'`，`reason` 写明"等待人工审核"。为什么这么设计：
  1. 当前平台没有任何代码沙箱（见 §1），不能假装能安全执行；
  2. 作者声明 `exec` 往往只是"我需要宿主未来提供外部进程能力"，直接拒掉会丢失信息；
  3. 登记 + 人工审核保留了升级路径，同时保证"今天装进来的插件绝对不改运行时"。
- selftest 第 6 组断言：`fixture-exec-quarantine` 的 `mo.exec_marker` 确实不在运行时注册表内。

## 6. 版本约束

`engines.platform` 是必填项，支持 `>= <= > < = ^ ~` 与空格（与）、`||`（或）。加载器自带 40 行 semver（`parseVersion / satisfies`），不满足即整包拒绝并给原因：

```
$.engines.platform — VERSION_UNSATISFIED: 平台版本 0.1.0 不满足插件要求 >=9.0.0
```

为什么硬拒而非降级：插件贡献的是**语义**（参数位置、模型显存数字）。旧内核加载新语义插件，最坏情况是"看起来能跑，然后 OOM 或参数被当成另一单位"。

## 7. `mergeRegistry(base, plugin)` 的保证

- 返回**深拷贝**（`structuredClone`），`base` 与 `spec/*.json` 一个字节都不动；selftest 用 sha256 + mtime 双重复核。
- 即使调用方跳过 `validateManifest`，`mergeRegistry` 自己再查一遍：key 冲突 / stage 不存在 / key 前缀与 stage 不符 / `impact` 越界 → 直接抛错。静默丢参数比报错更糟——用户会以为装上了却不生效。
- 合并后重算 `counts`：`{ total, l3, l4, plugin_params }`，`plugin_params = total - 258`（基线参数数）。
- `plugin_layers[]` 记录每个叠加层的 id/version/type/state/permissions/`applied`，卸载与审计靠它。

## 8. CLI

```
node tools/plugin.mjs list
node tools/plugin.mjs validate <dir>
node tools/plugin.mjs install <dir> [--apply]   # 默认 dry-run
node tools/plugin.mjs info <id>
node tools/plugin.mjs selftest
```

`install` 默认 dry-run：打印目标目录与"将注入的参数/模型/主题面板数量"，确认后加 `--apply` 才复制到 `plugins/packs/` 并**落盘后复验**。退出码：`0` 正常、`1` 参数错、`2` 校验失败、`3` 复制失败。

## 9. 实测输出

### 9.1 `node plugins/selftest.js`（卡 ⑦ 基线：退出码 0，32 项断言）

```
插件体系自检
────────────────────────────────────────────────────────────────
项目根 D:\云盘\01-代码\AI视频\ai-video-platform
基础注册表 v0.1.0 · 参数 258 · 模型 11

1) 三个示例插件全部通过校验
  ✓ sample-model-pack 校验通过  —— 贡献 参数0/模型1/预设0
  ✓ sample-node-pack 校验通过  —— 贡献 参数2/模型0/预设0
  ✓ sample-preset-pack 校验通过  —— 贡献 参数0/模型0/预设1

2) 故意坏掉的 manifest 被拒，且错误路径正确
  ✓ 坏 manifest 判定为不通过  —— 7 条错误
  ✓ 错误路径命中 $.type（type 非法枚举）  —— ENUM_MISMATCH
  ✓ 错误路径命中 $.engines（缺 engines）  —— REQUIRED_MISSING
  ✓ 错误路径命中 $.permissions[1]（权限白名单外的值）  —— ENUM_MISMATCH
  ✓ 错误路径命中 $.contributes.params[0].key（key 与既有注册表冲突）  —— KEY_CONFLICT
  ✓ 错误路径命中 $.contributes.params[1].stage（stage 不存在）  —— STAGE_UNKNOWN
  ✓ 错误路径命中 $.contributes.params[1].impact.quality（impact 超 0..1）  —— TOO_LARGE

3) mergeRegistry 后参数总数 = 基础数 + 节点包新增数
  ✓ loadAll 无错误  —— 3 个包
  ✓ 三个包都 active  —— sample-model-pack=active, sample-node-pack=active, sample-preset-pack=active
     真实数字：260 = 258（基础） + 2（插件）
  ✓ 参数总数 = 基础 + 节点包 +2  —— 260
  ✓ 模型数 +1、预设数 +1  —— 模型 12、预设 1
  ✓ 节点包的 2 个参数确实进了注册表且带 bind/hint  —— kf.polish_mode + kf.polish_strength
  ✓ 预设 checksum 可通过 engine.importPreset 导入  —— 示例 · 高画质 30fps 出片（7 项，djb2:6d77f641）

4) spec/ 原注册表未被修改（hash + mtime）
  ✓ 未修改 spec\params.registry.json  —— 8f67f8198a2f8605 · mtime 09:28:31
  ✓ 未修改 spec\models.catalog.json  —— acaf2930ba895aca · mtime 09:18:24
  ✓ 未修改 spec\rules.linkage.json  —— 67fe57cb8dd92073 · mtime 09:18:24
  ✓ mergeRegistry 返回的是深拷贝（改返回值不影响 base）  —— base 未被污染

5) 版本不满足的插件被拒
  ✓ engines.platform 不满足 → 拒绝  —— $.engines.platform — 平台版本 0.1.0 不满足插件要求 >=9.0.0
  ✓ semver 解析行为正确  —— >= ^ ~ 区间与或运算

6) exec 权限隔离 + 权限默认全拒
  ✓ 声明 exec 的包状态为 needs-review  —— EXEC_QUARANTINED
  ✓ needs-review 的包不注入运行时  —— mo.exec_marker 不在运行时注册表内
  ✓ 未声明 permissions 时解析为空（默认全拒）  —— sample-node-pack → []

7) mergeRegistry 的防御性校验（绕过 validateManifest 也拦得住）
  ✓ 关键冲突 → 抛错  —— kf.steps
  ✓ stage 不存在 → 抛错  —— ghost
  ✓ impact 越界 → 抛错  —— quality=2
  ✓ 合法参数 → 追加 1 条且 base 不变  —— 258 → 259

8) loadAll 幂等（重复调用输出一致）
  ✓ 两次 loadAll 的 registry 全等  —— 参数 260 两次一致

9) schema 只使用校验器实现过的关键字（防"看着在校验其实被忽略"）
  ✓ 没有未实现的关键字  —— 24 个关键字受控

10) docs/04-plugins.md 里的 manifest 示例可通过校验（防止文档漂移）
  ✓ 文档示例可加载  —— my-node-pack 可加载（state=active）

────────────────────────────────────────────────────────────────
断言 32 项，全部通过
运行时参数 260 · 模型 12 · 预设 1 · 插件 3
全部通过
```

### 9.2 `node tools/plugin.mjs list`（卡 ⑦ 基线；卡 ⑧ 起多一列「签名」）

```
插件根：D:\云盘\01-代码\AI视频\ai-video-platform
注册表：v0.1.0 · 参数 258 · 模型 11

ID                    类型    版本    状态        参数 模型 预设 主题/面板
--------------------------------------------------------------------------
sample-model-pack     model   1.0.0   active      0    1    0    0/0
sample-node-pack      node    1.0.0   active      2    0    0    0/0
sample-preset-pack    preset  1.0.0   active      0    0    1    0/0

合计：3 个包 / active 3 · needs-review 0 · rejected 0
运行时：参数 260（基础 258 + 插件 2）· 模型 12 · 预设 1
提示 3 条：
  [sample-model-pack] $.permissions — PERMISSION_REGISTERED: net/gpu 当前只做能力登记：加载阶段不发网络请求、不分配显存
  [sample-node-pack] $.permissions — DEFAULT_DENY: 未声明权限 → 全部按拒绝处理
  [sample-preset-pack] $.permissions — DEFAULT_DENY: 未声明权限 → 全部按拒绝处理
```

### 9.3 `node tools/plugin.mjs validate plugins/fixtures/bad-manifest`（退出码 2，卡 ⑧ 后）

```
✘ 拒绝：fixture-bad-manifest  共 8 条错误
  $.engines — REQUIRED_MISSING: 缺少必填字段 engines
  $.type — ENUM_MISMATCH: 取值必须是 model | node | preset | ui 之一，实际 "wat"
  $.permissions[1] — ENUM_MISMATCH: 取值必须是 fs:read | net | exec | gpu 之一，实际 "root"
  $.contributes.params[1].impact.quality — TOO_LARGE: 1.5 > 1
  $.signature — PLUGIN_UNSIGNED: manifest 没有 signature：无法证明内容未被改动（可信清单有 1 把公钥）；类型 wat 不在可降级清单（ui/preset）内，缺签不放行 → 拒载并隔离
  $.contributes.params[0].key — KEY_CONFLICT: 参数 key "kf.steps" 与既有注册表冲突
  $.contributes.params[1].stage — STAGE_UNKNOWN: stage "nonsense" 不存在，可用：character, storyboard, keyframe, motion, voice, look, export
  $.contributes.params[1].impact.quality — IMPACT_RANGE: quality 必须是 0..1 的数字，实际 1.5
```

## 10. 已知缺口

1. **本机 node 的 `fs` 写盘被环境策略拦成 EPERM/EIO**（读正常，PowerShell 写正常）。因此：`install --apply` 在本机会以退出码 3 结束并打印等价的 `Copy-Item` 命令；示例预设包由 `gen-preset.js | Set-Content` 落盘，而不是脚本直写。这是环境限制，不是插件逻辑缺陷——换到写盘正常的机器 `--apply` 可直接用。
2. **semver 不支持 `x`/`*` 通配**（`0.1.x` 会被判为非法范围）。白名单只放 `>= <= > < = ^ ~` 与 `||`；要写"0.1 系列"请用 `>=0.1.0 <0.2.0`。
3. **checksum 只防手改与截断，不防蓄意伪造** → 卡 ⑧ 已补 Ed25519 签名（§11）；`checksum` 保留为"内容自洽"的快速检查。
4. **插件间有顺序依赖**：`loadAll` 按 `packs/` 目录名（= 插件 id）字典序折叠，B 包可以引用 A 包的参数，但反向不行。要表达依赖需加 `depends_on` 字段。
5. **`ui` 类渲染只到 `plugins/index.html` 本页**（§12）：跨模块宿主（`app/` `web/` `canvas/` `inspector/`）还没有订阅插件主题/面板，`stage-sidebar` 等 slot 在那些页面上仍是"登记不渲染"。
6. **`model` 的 `resident_mib × params_b` 只做量级自洽（warning）**，不做逐项实测比对；`estimate` 与 `measured` 的差别仍只有 warning。

## 11. 签名与验签（Ed25519，零依赖）

`checksum` 只防手滑——作者改内容同时改 checksum 就过。防伪靠签名：manifest 顶层加 `signature{key_id,alg,sig}`，公钥从仓库内可信清单读，验签用 Node 内置 `crypto`（`crypto.sign/verify` + `createPublicKey`），`alg` 只认 `ed25519`，不装任何包。

**签名对象 = 规范化后的 manifest 正文**（验签前由 `loader.js` 重算，绝不复用读盘原文）：
1) 只剔除顶层 `signature`，其余字段全部参与；2) 对象键按 UTF-16 码元升序**递归**排序，数组保持原顺序；
3) 无空白（无缩进/换行），字符串转义与 `JSON.stringify` 同一套规则；4) 数字必须有限，`1` 与 `1.0` 视为同一个数；
5) 结果按 UTF-8 编码喂给 crypto（Ed25519 不做预哈希）⇒ 换缩进、换键序不影响验签，改任一值必然失败。

可信清单 `plugins/keys/trusted.json` 是扁平 `{ "key_id": "<base64(DER/SPKI 公钥)>" }`；读不到 ⇒ 全部视为未签名（失败即全未签名，绝不"读不到就放行"）。

| 情况 | 原因码 | `model` / `node` / 声明 `exec` | `ui` / `preset` |
| --- | --- | --- | --- |
| 没有 `signature` | `PLUGIN_UNSIGNED` | 拒载（`rejected`） | 降级 `unsigned` + 显式警告 |
| `key_id` 不在清单 | `PLUGIN_UNKNOWN_KEY` | 拒载 | 降级 |
| `alg` 不是 ed25519 | `PLUGIN_BAD_ALG` | 拒载 | 降级 |
| 正文与签名不符 | `PLUGIN_BAD_SIGNATURE` | 拒载 | 降级 |

为什么分档：`ui/preset` 只登记不执行（主题没生效、预设被拒都可逆且用户可见）；`model/node` 的 `resident_mib`/`impact` 直接进显存方程，错了就是"看起来能跑然后 OOM"，必须拒。降级包在页面上带「未签名」标记；`plugin_layers[].signature` 记录每次叠加的签名状态，审计可追。

```
node tools/plugin.mjs keygen --id <key_id> [--force]     # 生成 Ed25519 密钥对，公钥写进 trusted.json
node tools/plugin.mjs sign plugins/packs/<包> --write     # 写回 signature 并当场复验
node tools/plugin.mjs verify plugins/packs/<包>           # 只验签：原因码 + 规范化正文指纹
```

## 12. `ui` 类真渲染：主题真改 CSS 变量，面板真挂 slot

`plugins/index.html` 新增「ui 运行时」页签，数据仍来自 `plugins/snapshot.json`（`entries[].manifest.contributes.ui` + `entries[].state`），页面不二次判断：

- **主题**：选一个主题 → 把 `themes[].tokens` 逐个写进 `document.documentElement.style`（`--acc` / `--bg` / `--line2` …），配色当场改变；「还原」清除覆盖。真实生效范围 = 本页。
- **面板**：按 `slot` 挂进本页的 slot dock（`stage-sidebar` / `inspector-right` / `toolbar` / `export-dialog` 四列），每块面板是真实 DOM：标题、来源包、state 标记、字段（key + label + readonly）。
- **做不到的**：`app/` `web/` `canvas/` `inspector/` 四个宿主页没有订阅插件主题/面板（要改跨模块写域），所以跨模块 slot 目前只登记；页签顶部与结论区都标了「登记不渲染」，不假装宿主已接。