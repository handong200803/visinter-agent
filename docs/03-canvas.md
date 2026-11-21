# 03 · 三视图画布（canvas）

> 唯一产物：`canvas/canvas.html`（225.1 KB 单文件，双击 `file://` 即开，零外链资源）
> 源件：`canvas/canvas.src.html`（1803 行）· 构建器：`tools/build_canvas.mjs`（52 行）· 自检：`canvas/selftest.mjs`（47 项）

---

## 1. 解决了什么问题

小白被 258 个参数吓退，专家被 4 个滑杆饿死——这是同一份数据面对两类人的矛盾。

**结论：不做三个页面，做「一套文件、三份渲染」。**
`S`（状态对象）是唯一真相源，三个视图只是它的三种投影：

```
                 ┌─ 向导视图  7 步 × 每步 3-4 个 L3 参数（收敛）
S { values,   ───┼─ 参数视图  stage 分组 + L4 专家折叠（展开）
    view, cam,   └─ 节点视图  数据流拓扑 + 点击挂参（结构化）
    preset }
```

好处是切换视图**不丢状态、不重算**，且任何一处的改动在另两处立刻可见——这正好对应「同一份参数，三种心智模型」。

---

## 2. 三个视图各解决什么

| 视图 | 面向 | 呈现 | 关键设计 |
|---|---|---|---|
| **向导** `#view-wizard` | 完全新手 | 7 步（角色→分镜→关键帧→动效→配音→质感→输出），每步左侧步骤条 `#wSteps`、右侧一张卡 `#wCard` | 每步只露 2-4 个 L3 参数；每步显示「已改几项」脏标记；`←/→` 翻步 |
| **参数** `#view-params` | 中级 | 左侧板块导航 `#pRail` + 右侧密集表单 `#paramList`；L4 参数收进 `#expertFold` | 每个参数显示 `impact` 三联（显存/耗时/质量）与 `hint`；带「联动」徽标的就是被规则改过的 |
| **节点** `#view-nodes` | 专家 | Canvas2D 画的 11 节点 / 11 条数据流边，`#nodeCanvas` | 拖拽移动、滚轮缩放、空白拖拽平移、点击节点右侧弹参数面板 `#nodePanel`、双击跳参数视图 |

**为什么节点图用 Canvas2D 而不是 DOM/SVG**：258 参数的表单已经占了大量 DOM；节点图需要每帧重绘（拖动、缩放、hover 高亮），走 DOM 会触发 layout。Canvas 方案下拖动只改相机矩阵，配合 `requestAnimationFrame` 单帧重绘。

---

## 3. 节点图的实际拓扑

### 3.1 节点（11 个，`NODES`）
```
板块节点 7    character · storyboard · keyframe · motion · voice · look · export
模型节点 3    m.keyframe(kf.model) · m.motion(mo.i2v_model) · m.voice(vo.lipsync_model)
输出节点 1    output
```
模型节点不是装饰——它们绑定真实参数键，点开编辑的就是"用哪个底模"。

### 3.2 数据流边（11 条，`DATA_LINKS`）
```
character → storyboard → keyframe → { motion, voice } → look → export → output
m.keyframe → keyframe    m.motion → motion    m.voice → voice
```
这条链就是平台的生产管线，和 `docs/01-architecture.md §3` 的数据流是同一件事的两种画法。

### 3.3 坐标系统（关键实现决策）
`BASE_POS` 存的是**世界坐标**，`S.cam{x,y,zoom}` 存相机。缩放平移只改相机，节点坐标恒定——
避免「反复缩放后浮点误差把节点挤成一堆」这个经典 bug。`fitView()` 按包围盒反算相机。

命中测试 `hitTest()` 从数组尾部倒序遍历（后画的在上层），支持端口区域（`hoverPort`）判定，为后续「手动连线」预留。

---

## 4. 实时估算面板（`#estimator`，右下固定）

三视图共用一块面板，250ms 防抖后重算 `AVP.resolve` → `AVP.estimate`，显示：

```
显存        peak_mib / usable_mib = 88.6%   状态色 ok|warn|block
进度条      填充 + 安全线刻度（safety * 100%）
单格/单集    t.shot_sec s · t.episode_min min
质量分      q.score
主导阶段    v.dominant（哪个阶段吃显存最多）
提示        warnings 前 5 条（BLOCK/WARN/NOTE），其余折叠成「另有 N 条」
联动改写    ⚡ 联动改写 N 项 · 已自定义 M 项
```

**口径诚实**：面板底部标注 `估算（provenance 见 spec/models.catalog.json）`——
所有秒数都是估算模型的输出，不是实测，界面上不修饰成"预计耗时 XX"来暗示精度。

---

## 5. 联动可视化的做法

求解器 `resolve()` 返回 `trace[]`，其中 `target` 非空的条目表示「规则把你的值改掉了」。
前端把它做成 `REWRITE` 映射（key → trace 条目）：

- 参数行显示「联动」徽标，悬浮出现 `data-tip`：原值 → 新值 + 触发规则说明
- 用户手动改过的键进 `dirtyKeys()`，面板显示「已自定义 M 项」，避免用户以为是自己改的
- `applyPreset()` 会清空 dirty 集合并重置联动状态

这套设计的目的：**规则不是黑箱**。用户看到值被改，永远能问到"谁改的、凭什么"。

---

## 6. 持久化与导入导出

| 项 | 实现 |
|---|---|
| 自动保存 | `localStorage['avp.canvas.v1']` 存 `{values, view, preset, device}`，改动即存 |
| 隐私模式 | `setItem` 抛错被 try/catch 吞掉并留注释——**不允许因为存不了就崩页面** |
| 导出预设 `#exportBtn` | 走 `AVP.exportPreset()` → Blob 下载 `.preset.json`（带 djb2 checksum） |
| 导入预设 `#importBtn` | `AVP.importPreset()` 校验 schema/版本/checksum，越界值自动夹紧 |

---

## 7. 快捷键

```
1 / 2 / 3        切向导 / 参数 / 节点视图
← / →            向导视图翻步（其他视图不劫持方向键）
Esc              关闭节点参数面板
滚轮              节点视图缩放；空白拖拽平移
```

键位只在对应视图生效（`S.view === 'wizard'` 才响应方向键），避免在全页面范围抢按键。

---

## 8. 构建与验收

```bash
node tools/build_canvas.mjs     # 内联 engine + 三份 JSON → canvas/canvas.html
node canvas/selftest.mjs        # 47 项静态断言
```

`selftest.mjs` 断言的是**契约**而非实现（详见文件头注释）：

| 组 | 断言要点 |
|---|---|
| 产物与源件 | 三件存在、产物不落后于源件 |
| 单文件可交付 | 内联 `__REG/__CATALOG/__RULES`、占位符已替换、内联的是真 engine（`root.AVP = api` + `module.exports`）、**零外链 http(s)**、体积 < 400KB |
| 注册表口径 | 顶层 `counts.total = 258`、`params.length == counts.total` 自洽、7 个 stage id 全在场、表单由 `REG.stages/REG.params` 驱动 |
| 三视图同源 | 三个视图容器 + `#viewSwitch` + 3 个 `data-view` 按钮 + 键盘映射 + 首屏有 `class="view on"` |
| 关键控件 | estimator / nodeCanvas / paramList / wSteps / presets / exportBtn / importBtn / device / expertFold |
| 节点图是真实现 | `drawNode/drawEdge/hitTest/fitView/loop` 五个函数在场 + `requestAnimationFrame` |
| 求解器链路 | `AVP.resolve/estimate/applyPreset/exportPreset/importPreset` 全被调用 + localStorage |
| 构建器防护 | 含 `</script>` 截断检查、读注册表 |

**边界说明**：`selftest` 不打浏览器。它证明不了「拖拽手感」和「hover 高亮是否正确」，那部分只能人工双击验收（见 §9）。

---

## 9. 人工验收清单（双击 canvas.html 逐条过）

1. 首屏是向导视图，步骤条 7 项，第 1 步可改「主体描述」。
2. 改主体描述 → 右下估算面板数字在 250ms 内变化；顶栏脏标记出现。
3. 按 `2` 切参数视图 → 左侧 7 个板块；展开专家参数能看到 L4 项；每项有 impact 三联。
4. 按 `3` 切节点视图 → 11 节点、11 条连线；滚轮缩放不糊；拖动节点跟手；空白拖拽平移。
5. 点 `keyframe` 节点 → 右侧面板出现该板块参数，改值后估算同步变。
6. 把运动强度拉到接近上限 → 显存进度条变黄/红，出现 BLOCK 提示；联动徽标出现在一致性权重那行。
7. 导出预设 → 得到带 `djb2:` 的文件；故意改一个越界值再导入 → 值被夹到范围内。
8. 刷新页面 → 参数与视图都还在（localStorage）；开无痕窗口 → 页面正常但不保存。

---

## 10. 已知缺口

1. **无浏览器自动化回归**：47 项是静态契约断言，交互正确性靠 §9 人工清单。
2. **连线不可手工新增**：`DATA_LINKS` 是常量拓扑，`hitTest` 已预留端口判定，但拖拽新建连线的交互没做。自定义拓扑要等 `server/wf.js` 的 workflow 编译格式定稿。
3. **节点图未接真实工作流**：拓扑固定对应 7 板块管线，不能加载外部 ComfyUI workflow JSON。
4. **无性能实测数字**：源件目标是首屏 < 300ms、拖动 60fps，但本机未做 Lighthouse / Performance 面板测量，文档不写未测的数字。
5. **参数表单未虚拟滚动**：当前按 stage 懒渲染（只渲染当前板块），单板块最大 56 项不需要虚拟化；若参数继续膨胀需补。