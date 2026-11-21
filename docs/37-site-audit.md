# 37 · 全站漏洞扫描与修复（2026-11-21 第二轮）

> 触发：用户要求「检测并修复平台所有出现漏洞的地方：图片不显示、介绍与本体不符、功能无法使用」。
> 方法：真实浏览器加载 → 逐页滚动触发懒加载 → 抓 `img.naturalWidth` / `video.readyState` / 文本异常标记 → 逐个定位。

## 修复清单（4 个真 bug）

| # | 缺陷 | 现象 | 根因 | 修法 |
|---|---|---|---|---|
| 1 | **`fig4-degeneration.svg` 非法 XML** | 图 4 在页面上永远空白 | `award_report.mjs` 把标题里的 `<` 直接写进 SVG 文本（`噪声 0.15 < 真实 0.354`），SVG 是严格 XML | 加 `xmlEsc()`，对 title/note/数值/类别全部转义；4 张图重新生成并校验 |
| 2 | **preview 页 9 张封面全 404** | 点进「平台外壳」副本，风格圣殿一片空白 | ① 封面图 `assets/covers/*.jpg` 没打包进站点；② preview 页在子目录，`assets/...` 被解析成 `preview/assets/...` | ① `build_site` 自动同步 covers；② preview 页注入 `<base href="../">` 还原路径基准 |
| 3 | **页面 0 个移动端断点** | 手机上排版挤压、卡片不折行 | 模板里 `@media` 数量为 0 | 补 `@media (max-width:720px)`：单列、字号下调、主示例竖排、表格压缩 |
| 4 | **文案残留旧数据 n=10** | 「核心发现」区写「n=10 基准 5/5 → 2/5，准确率 80%」，与实际的 n=21 数据矛盾 | 基准扩到 n=21 后只更新了 docs，没同步页面 | 改为「n=21：11/13（47.6%）→ 8/13（61.9%），AUC 0.625→0.755，d 0.557→1.22」；图注同步 |

## 全站体检结果（修复后）

| 页面 | 图片 | 视频 | 异常标记（`undefined`/`NaN`） | 横幅 |
|---|---|---|---|---|
| `index.html` | **13 / 13** | **2 / 2** | 0 | — |
| `preview/shell.html` | **9 / 9** | — | 0 | ✅ |
| `preview/params.html` | — | — | 0 | ✅ |
| `preview/ultimate.html` | — | — | 0 | ✅ |

移动端（390×812）实测：`scrollWidth 477 < innerWidth 492`，**无横向溢出**，`@media` 命中。

## 被判定为「假报警」的两类

| 现象 | 判定 | 依据 |
|---|---|---|
| 首屏 8 张图 `naturalWidth=0` | 懒加载 | 对全部 15 个资源发 `HEAD` 请求全部 200；滚到底后 13/13 加载成功 |
| `fig4` 修复后仍不显示 | 浏览器缓存 | 直接 `curl` 该 URL 返回 200 / `image/svg+xml` / 951B 合法 SVG；强刷后正常 |

## 功能可用性核对

| 功能 | 状态 | 条件 |
|---|---|---|
| 「连接并自检」 | ✅ 可用 | 填任意 http(s) 地址即请求 |
| 「生成候选」 | ⚠️ 依赖后端 | 缺 Key 时明确返回 `PROVIDER_MISSING` |
| 「生成视频」 | ✅ 未选候选时置灰 | 选候选后解禁 |
| 「增强 60fps」 | ✅ 出片后出现 | 需后端 ffmpeg |
| 「用合成图打分」 | ✅ 无 Key 可用 | 实测 total 0.5344 |
| 「拉取数据」（实验） | ✅ 无 Key 可用 | 返回 4 条真实实验 |
| 「刷新」（作品库/任务） | ✅ 无 Key 可用 | 空列表给明确文案 |
| BYOK「云端出片」 | ✅ 未填 Key 置灰 | 填 Key 后经代理可用 |

## 复现命令

```bash
node tools/award_report.mjs        # 重新生成 4 张图（含 XML 转义）
node tools/build_preview_pages.mjs # 重建 3 个 preview（注入 base href）
node tools/build_site.mjs          # 重建站点（自动同步 covers）
node tools/publish_site.mjs https://你的后端   # 注入地址 + 打包 + 4 项体检
```
