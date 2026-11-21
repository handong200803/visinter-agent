# 两个逆向能力 · Muse 氛围感 & Seedream 抖音网红脸

> 落地日期 2026-11-18｜落点 `prompt/styles.json`（18 风格 / 8 张圣殿卡）、`prompt/lexicon.zh.json`（light 组 +4 条）、`tools/build_app.mjs`（内联 `window.__STYLES`）
> 本文是这两个能力的**逆向记录 + 配方卡 + 平台接线说明**。改风格请改数据文件，不要改产物 `app/index.html`。

---

## 1. 结论（先看这段）

| 能力 | 逆向来源 | 落到哪 | 状态 |
|---|---|---|---|
| Muse 氛围感 | 本机 Muse 九段式提示词实录（`02-视频/成片/江山人间_3min_Muse提示词包.md` 36 镜、`_4min` 50 镜）+ 成片观感 | 风格 `muse-atmosphere`（圣殿第 1 卡） | 编译可用、自检通过 |
| 抖音网红脸（Seedream 5.0 pro） | 抖音人像视觉共识 + Seedream 5.0 已知行为（无实测，缺 key） | 风格 `douyin-face`（圣殿第 2 卡） | 编译可用、自检通过；**出图未实测** |

两句话讲清逆向结论：

1. **氛围感不是雾滤镜**，是"单一方向的画内光 + 空气介质 + 抬起暗部"三件同时成立，再用轻颗粒 / 高光光晕收尾。只加雾 = 发灰塑料片。
2. **"网红脸"这个词本身有害**：在 Seedream 5.0 pro 的训练语料里它绑的是修图 App 的液化模板，直接写只会发散成大眼塑料娃（平台词库黑名单里就有它）。必须拆成**骨相几何 + 皮相光点 + 镜头位**三组可判定的描述。

---

## 2. 逆向过程（可复现）

### 2.1 Muse：从产出反推，而不是从 APK 里捞

- 解包 `_收件箱/muse/muse-12.0.0.14.169.apk`（1028 entries），扫描 5 个 dex 的字符串池共 1036 条 prompt/style 相关串 → **没有风格词表**，全是 `bodyStyle`/`biometricPrompt` 这类 UI 串。
  结论：Muse 的风格与提示词是**服务端下发**，客户端逆向拿不到配方，别在这上面耗时间。
- 有效路径是**行为逆向**：拿它在真实项目里已经跑通的分镜提示词（36 / 50 镜九段式）当样本，统计出反复出现的结构性特征：
  - 每镜只给**一条**运镜路径（"缓慢前推，落幅极稳"），运镜多了动作就散
  - 光：侧逆光 / 轮廓光 / 体积光 / 暖金主光 + 青蓝天光
  - 质感：轻胶片颗粒、浅景深、柔高光滚降
  - 负面集固定：卡通大眼、塑料感、过曝死白、文字水印
- 把这些压成 `structured_delta`（槽位增量），而不是一段成品提示词——成品不可合并、不可追溯，这是本平台的既有取舍。

### 2.2 Seedream：从模型短板倒推提示词

Seedream 5.0 pro 的三个已知行为决定了配方形状：

| 已知行为 | 对策 |
|---|---|
| 一次只出一张（无组图），候选数 = 成本乘数 | 先在 1K 档试骨相，定稿上 2K；别用"多出几张挑一张"的思路 |
| 对"美颜类社会标签"响应发散（网红/纯欲/清冷） | 全部改成几何与光学描述，标签词只留在卡片名与别名里 |
| 默认会把皮肤磨平（塑料脸） | 显式写"保留毛孔 + 水光高光点"两条并存，权重 1.2 |

配方三段（缺一不可）：

1. **骨相**：瓜子脸 / 下颌线收窄 / 尖下巴 / 颧骨略宽于下颌 / 山根起点低 / 鼻梁窄直 / 眼大卧蚕饱满 / 人中短唇峰清晰
2. **皮相**：保留毛孔 + 颧骨与鼻尖水光高光点（这两条必须同时写，只写水光=油脸，只写毛孔=不水润）
3. **镜头位**：85–105mm / 正面偏侧 10–15° / 机位高于视线 5–8° / 焦点在眼睛 + 双眼眼神光

补一条硬约束：**默认主体模板里写着"鹅蛋脸"**，与本风格的瓜子脸骨相直接冲突，用本风格前先把 `ch.subject` 的脸型改掉（已写进 `usage.preconditions`）。

---

## 3. 平台接线（为什么现在能在页面上看到）

| 环节 | 之前 | 现在 |
|---|---|---|
| 数据源 | `prompt/styles.json` 有 8 个风格，**没有** `noir`/`card` 字段 | 18 个风格：8 基础 + 8 noir（2 个不占卡位）+ 2 个能力；其中 8 个带 `noir:true`+`card` |
| 外壳内联 | `app/index.src.html` 里写着"构建期内联为 `window.__STYLES`"，但**构建工具从没内联过** → 圣殿永远是空的 | `tools/build_app.mjs` 增加 `prompt/styles.json` 内联（产物 +60KB，377KB） |
| 风格覆盖机制 | `compose.js` 实现了 `overrides`（风格声明"我接管这几个参数"），全库 **0 使用** | 两个能力首次启用：接管 `ch.style`/`ch.palette`/`sb.genre`（网红脸另加 `ch.face_shape`/`ch.skin`），否则默认的"厚涂 + 古风 + 东方暖调"会把画面拉成古装插画 |
| 卡片 | 8 张（另有 2 张与会撞图） | **8 张**：Muse氛围感、抖音网红脸、暗黑天使雕像、冷雾墓园、暗黑玄幻人物、银灰神域雪景、堕天使战场废墟、吸血鬼哥特氛围 |

卡位裁决：`gothic-ruin-temple`、`tragic-portrait` 的封面底图与两个能力卡同源（muse 派生自 noir-02、douyin 派生自 noir-07），四张并排像重复 → **取消卡片身份（`noir:false`），风格能力保留**，CLI 里照样 `--style 哥特废墟` 可用。

封面：用平台自己的 `assets/covers/noir-02/07.jpg` 派生（冷暖分离调色 / 柔光人像），未引入外来图。

---

## 4. 怎么用（三条路）

### 4.1 页面：点卡装载

`http://127.0.0.1:8388/app/index.html` → 工作台 → 风格圣殿 → 点「Muse氛围感」/「抖音网红脸」
→ 推荐参数经 `E.coerce` 写入当前项目，`ch.prompt_prefix` 写入卡片提示词，底栏档位/耗时/质量分立刻变化。

### 4.2 命令行：编译提示词

```bash
node tools/prompt.mjs compose --style 氛围感 --stage keyframe --no-structured
node tools/prompt.mjs compose --preset vertical --style 抖音脸 --stage character
node tools/prompt.mjs compose --style muse-atmosphere --stage keyframe --set kf.steps=36 --json
```

### 4.3 出图：把产物喂 Seedream

```bash
S=%CLOUD_ROOT%\01-代码\AI绘图\seedream-5pro\seedream.py
python $S cost --tier 1K --ratio 9:16                     # 先算钱：≤2.61M 像素 0.30 元/张
python $S t2i --prompt "<douyin-face 的 positive_en>" --size 9:16 --out face_v1.png
```

硬规则（来自 `seedream-5pro` 技能）：`size` 只认 `1K/1.5K/2K` 或显式 `WxH`（总像素 921,600–4,624,220）；不要用 4.x 的 `sequential_image_generation`/`stream`。

---

## 5. 配方卡（可直接粘贴）

### 5.1 Muse 氛围感 · 九段式模板

```
主体：<一个 24 岁中国女孩，站在废弃教堂侧门口>
动作：<缓慢转头看向门外光源，只有一个动作>
环境：空气中有薄雾与浮尘，湿地面柔反射，远处拱顶隐入暗部
镜头：35mm，浅景深，前中后三层分离，单条缓慢前推，落幅稳定
一致性：同一人物，面部特征前后一致
光线：画内光源单向打光，侧逆光勾出发丝与肩线轮廓，暖金主光与青蓝天光对撞，暗部抬起不死黑
节奏：一镜一动作，收尾静止 0.5 秒
声音：<环境声：风穿过廊道的低频>
收尾：轻胶片颗粒，高光柔和滚降带轻微光晕，低饱和高对比
负面：平光，均匀亮度，无阴影，塑料感，过曝死白，灰雾一片，过度锐化
```

### 5.2 抖音网红脸 · Seedream 5.0 pro（英文更稳）

```
realistic photographic portrait of a young Chinese woman,
V-shaped face, tapered jawline, pointed chin, cheekbones slightly wider than jaw,
low nose root, narrow straight bridge, small refined tip,
large eyes, defined inner and outer canthus, full aegyo-sal,
short philtrum, sharp cupid's bow, slightly upturned mouth corners,
visible pores retained, dewy highlight points on cheekbones and nose tip,
softbox frontal light, low lighting ratio, symmetric soft shadow under nose and chin,
85mm medium close-up, 10-15 degree three-quarter angle, camera slightly above eye level,
focus on the eyes, clear catchlight in both pupils,
low-contrast soft grade, warm skin against cool background, subtle vignette, vertical framing
negative: plastic skin, over-smoothed, cartoon eyes, anime face, deformed features, oily sheen
```

---

## 6. 验收记录

- `node prompt/selftest.js` → **31 条断言全通过**（18 风格、154 份正负向产物黑名单扫描、`provenance` 无伪造实测）
- 页面实测：8 张卡、8 张封面**互不重复**、`window.__STYLES.styles.length === 18`
- 点卡实测：`.noir-card.on` 生效、底栏从"未配置"变为档位/显存/单帧耗时/质量分
- 编译实测：`--style 氛围感` / `--style 抖音脸` 中文别名均可解析

---

## 7. 已知缺口 / 下一步

1. **Seedream 出图未实测**：本机没有可用 Ark key（`keys/` 只有 README，环境变量为空）→ 骨相与皮相权重的实际命中率仍是 `inferred`，不是 `measured`。拿到 key 后跑 4 张（1K 试骨相 ×2 → 2K 定稿 ×2），把结果记进本文第 5 节。
2. **顶栏项目名不刷新**：`applyNoirStyle` 创建项目后未重绘顶栏，仍显示"临时项目（未配置）"（既有 UI 缺口，非本次引入）。
3. **并发写入风险**：21:33 前后另一个会话把 `prompt/styles.json` 覆盖回 16 风格的版本，导致两个能力一度丢失。已改为幂等重建（见 §8），若再被覆盖，重跑一次即可。
4. 参数面板（`web/params.html`）与向导（`wizard/`）的风格下拉尚未消费 `__STYLES`，目前只有圣殿卡与 CLI 用得到。

---

## 8. 幂等重建（被覆盖后跑这条）

```bash
python D:\缓存\tmp\rebuild_capability.py     # upsert 两个能力 + 卡位裁决 + 排序，可重复执行
node tools/build_app.mjs                     # 重新内联 window.__STYLES
node prompt/selftest.js                      # 31 条断言
```

改动前后请确认：`styles.json` 里 `noir` 为真的风格**必须恰好 8 个**（这是"八连廊"的硬约束）。

---

## 9. 真机接线（2026-11-18 晚新增：能力 → 出图通路）

§3 解决了「页面上看得见」，这一节解决「真能出图」。之前两个能力只能编译出提示词，出图要么走 DashScope 的 qwen-image（没有 5.0 的骨相/皮相响应），要么没有通道。

### 9.1 新增/改动文件

| 文件 | 作用 |
|---|---|
| `spec/reverse.capabilities.json` | 能力包真源：不变量、失败模式、各阶段提示词、seedream_recipe（档位/软负面/一致性方案）、preconditions、yield_gate、像素/计价矩阵 |
| `server/providers/seedream.js` | Seedream 5.0 pro 同步出图 provider（`id=seedream`，`mode=real`）：payload 编译、预算裁剪、落盘 + ledger、probe、dry-run |
| `tools/capability.mjs` | CLI + 契约自检：`list / show / payload / probe / verify`（无参数 = verify，已接入 `selftest_all`） |
| `server/providers/index.js` | 注册 `seedream` 到 provider 工厂（`AVP_PROVIDER=seedream`） |
| `server/jobs.js` | 放开 `kind='image'`（走 seedream，与视频主 provider 解耦）；`SR_*` 错误码不重投（防重复计费） |
| `server/app.js` | `GET /api/capability`（能力包 + 探活）、`POST /api/capability/image`（同步出图 / `dryRun`） |
| `server/cine.js` + `server/selftest.js` + `docs/02-backend.md` | 第四真源对齐：cine 的 `FACE_POS/FACE_NEG` 删除 `no visible pores / beauty filter look / natural visible pores`，改为「保毛孔 + 水光高光点并存」 |
| `tools/selftest_all.mjs` | 模块清单加入「逆向能力包」 |

### 9.2 三条命令

```bash
node tools/capability.mjs list
node tools/capability.mjs show --ability douyin-face
node tools/capability.mjs payload --ability muse-atmosphere --tier 1.5K --ratio 9:16 --out D:\缓存\avp\sr_muse.json
node tools/capability.mjs verify          # 72 项断言，末行「全部通过」
node tools/capability.mjs probe           # 无 key → SR_NO_API_KEY（如实，不假装可用）
```

HTTP：

```bash
curl -s http://127.0.0.1:8388/api/capability
curl -s -X POST http://127.0.0.1:8388/api/capability/image \
  -H "Content-Type: application/json" \
  -d '{"ability":"douyin-face","tier":"1.5K","ratio":"9:16","dryRun":true}'   # 只回 payload，不计费
```

真出图去掉 `dryRun`，或走任务队列：`POST /api/jobs {"kind":"image","ability":"douyin-face","tier":"1.5K","ratio":"9:16"}`。
产物落 `%CLOUD_ROOT%\02-视频\关键帧\<YYYYMMDD>\`，同名 `.ledger.json` 记 model/size/prompt/估价。

### 9.3 参数矩阵（按官方 size_map，不现场算比例）

| 档位 × 比例 | 像素 | 价格 | 用途 |
|---|---|---|---|
| 1K × 9:16 = 800×1424 | 1.14M | ¥0.30 | 骨相/构图试错 |
| **1.5K × 9:16 = 1152×2048** | 2.36M | **¥0.30** | **竖屏定稿首选**（高度过 1080p 仍在 0.30 档，等于半价买 2K 可用性） |
| 2K × 9:16 = 1584×2816 | 4.46M | ¥0.60 | 大屏/封面/需二次裁切 |
| 1.5K × 16:9 = 2048×1152 | 2.36M | ¥0.30 | 横屏分镜板 |

### 9.4 prompt 预算裁剪（这轮实测踩到的两个真坑）

1. **「鹅蛋脸」跳不掉**：`overrides` 只能跳过 `ch.face_shape` 这个键，跳不掉 `ch.subject` 默认整句里的字面脸型 → 提示词里同时出现「鹅蛋脸」与「瓜子脸」，模型自己抽签。
   修法：能力包 `preconditions.substitutions` 在**编译之后**作用于 structured（把「，鹅蛋脸」整段删掉，不是换成瓜子脸——换会得到两次瓜子脸，特征被加重）。
2. **超预算**：douyin 原始渲染 425 字符 / 305 汉字，超过官方建议 300 字。
   修法：`compactStructured()` 先做段级去重（`暖肤配冷背景的双色调` vs `暖肤配冷背景`），再按槽位优先级 `quality(lk.* 先删) → style → camera → scene → outfit → appearance → light → subject` 删权重最小条目，用平台自己的 `renderZh` 重渲染（不截字符串，避免切在半个词上）。实测 305 → **293 汉字**，正向段保留完整骨相/皮相/镜头三组。

### 9.5 诚实边界（这轮仍未解决）

- **无 Ark key → 真实出图仍未跑过**：`keys/` 只有 README，`ARK_API_KEY` 为空。所以骨相/皮相权重命中率仍是 `inferred`，不是 `measured`；`probe` 与 `verify` 只能证明协议、尺寸、预算、去重、前置条件全对。
- **5.0 没有 `negative_prompt`**：负面集只能软化成「避免：…」放句尾（`negative_field_supported:false` 已写进 payload meta）。想要真负向，得走 ComfyUI/SD 通道。
- **一致性靠参考图**：同一角色多镜头必须「定妆照 + image 参考」（首张免费、第 2 张起 ¥0.02/张），不要靠同一句提示词赌。
