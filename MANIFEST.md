# MANIFEST · 交接包清单

生成时间：2026-11-19T13:31:47.517Z

- 文件总数：**271**
- 未压缩总大小：**9.13 MB**

## 关键文件（按职责）

| 文件 | 大小 | sha256(前16) |
|---|---|---|
| 00-先读我.md | 2.9 KB | a8acfc6b4c8ca8c2 |
| HANDOFF-QWEN.md | 20.5 KB | 7bb5fc54fadb5c33 |
| AGENTS.md | 3.9 KB | acf93f7b1a60c41f |
| README.md | 6.8 KB | 36698f2cf6ac28c1 |
| 启动平台.cmd | 1.6 KB | ef40022abae8def2 |
| spec/quality.json | 1.9 KB | 27fa60cb6065998e |
| spec/engines.json | 7.7 KB | 5b57900e338a0a67 |
| spec/params.registry.json | 111.2 KB | c1998e05eeb83ac6 |
| server/quality.js | 7.2 KB | fc401004e5042910 |
| server/jobs.js | 28.6 KB | f0585ce25bc80cf8 |
| server/archive.js | 7.1 KB | b2d93c40a6b17148 |
| server/comfy.js | 17.5 KB | 16a11466925b3924 |
| server/h3workflow.js | 8.4 KB | 3e4de529f4a20fc1 |
| server/canvasbuilder.js | 19.0 KB | aa7457a79f4f8474 |
| server/ultimate.js | 17.4 KB | ed58b61c49996b13 |
| server/scoring.js | 12.6 KB | 6c2a102ffe837fee |
| server/bayes.js | 9.1 KB | 5a7ebc3205adc198 |
| server/app.js | 43.8 KB | cd0490559e0b00e8 |
| tools/serve.mjs | 3.1 KB | 9e924e08a5e15cd2 |
| tools/setup_models.sh | 3.2 KB | 29ef1b88fc99b541 |
| tools/score_cv.py | 6.2 KB | 4d089fe04ecef860 |
| tools/selftest_all.mjs | 5.8 KB | 9b786ec76703fbb5 |
| app/index.src.html | 139.5 KB | 58ef344a795bfbac |
| web/params.src.html | 181.0 KB | 2fe98be57aaa8e87 |
| ultimate/ultimate.src.html | 29.1 KB | ef73146c7f44192c |
| docs/01-architecture.md | 10.4 KB | 13b1afb31c1ec44f |
| docs/27-quality-first.md | 4.8 KB | 5acb3255bdfacee6 |
| docs/26-shell-one-click.md | 3.2 KB | bbe3000a8531e4e9 |

## 文件类型分布

| 扩展名 | 数量 |
|---|---|
| .js | 59 |
| .json | 47 |
| .md | 45 |
| .mjs | 42 |
| .html | 23 |
| .avptpl | 17 |
| .jpg | 10 |
| .png | 10 |
| .txt | 5 |
| .css | 4 |
| (none) | 2 |
| .woff2 | 2 |
| .sh | 2 |
| .ico | 1 |
| .py | 1 |
| .cmd | 1 |

## 完整文件树
```
.gitignore
.qoder/rules/01-contract.md
.qoder/rules/02-build-verify.md
.qoder/rules/03-ui-style.md
00-先读我.md
AGENTS.md
HANDOFF-DEEPSEEK.md
HANDOFF-QWEN.md
HANDOFF-千问.md
HANDOFF.md
MANIFEST.md
README.md
SHA256SUMS
app/index.html
app/index.src.html
app/selftest.mjs
app/state.js
assets/avp.ico
assets/covers/douyin-face.jpg
assets/covers/muse-atmosphere.jpg
assets/covers/noir-01.jpg
assets/covers/noir-02.jpg
assets/covers/noir-03.jpg
assets/covers/noir-04.jpg
assets/covers/noir-05.jpg
assets/covers/noir-06.jpg
assets/covers/noir-07.jpg
assets/covers/noir-08.jpg
assets/fonts/LICENSE-Cinzel.txt
assets/fonts/cinzel-latin-400.woff2
assets/fonts/cinzel-latin-700.woff2
assets/grain.png
canvas/canvas.html
canvas/canvas.src.html
canvas/selftest.mjs
core/build.mjs
core/engine.js
core/models.js
core/selftest.js
docs/00-blueprint-v1.0.md
docs/01-architecture.md
docs/02-backend.md
docs/03-canvas.md
docs/04-plugins.md
docs/05-inspector.md
docs/06-quality.md
docs/07-market.md
docs/08-shell.md
docs/09-design-system.md
docs/10-params-ui.md
docs/11-module-ui.md
docs/12-handoff.md
docs/13-task-cards.md
docs/14-blueprint-gap.md
docs/14-wizard.md
docs/15-muse-seedream-capability.md
docs/16-character-autofill.md
docs/17-visinter.md
docs/18-visinter-ultimate.md
docs/19-comfy-h3-deploy.md
docs/20-h3-channel.md
docs/21-four-tasks.md
docs/22-compare-direct-vs-platform.md
docs/23-gap-closure.md
docs/24-final-engineering.md
docs/25-dual-engine-in-panel.md
docs/26-shell-one-click.md
docs/27-quality-first.md
docs/shots/10-params-1440-block.png
docs/shots/10-params-1440-ok.png
docs/shots/11-market-backlink.png
docs/shots/11-shell-7modules-http.png
docs/shots/2026-11-18-水乡晨行-10s.md
docs/state/ab-compare-2026-11-17.json
docs/state/acceptance-2026-11-17-after-handoff.txt
docs/state/acceptance-2026-11-17.clean.txt
docs/state/bugscan-2026-11-18.json
docs/state/capability-2026-11-18.txt
docs/state/cine-acceptance-2026-11-18.json
docs/state/cine-aesthetics-2026-11-18.json
docs/state/cine-audit-2026-11-18.json
docs/state/cine-engineering-2026-11-18.json
docs/state/cine-multi-2026-11-18.json
docs/state/cine-realrun-2026-11-18.json
docs/state/compile-dashscope.json
docs/state/device-probe-2026-11-18.json
docs/state/inventory.md
docs/state/provider-verify-2026-11-17.json
docs/state/realrun-2026-11-17.json
docs/state/session-2026-11-18-evening.json
docs/state/validation-hardening-2026-11-18.json
docs/state/visinter-2026-11-18.txt
inspector/README.md
inspector/index.html
inspector/index.src.html
inspector/shot-00-main.png
inspector/shot-01-problem-frame.png
inspector/shot-02-repaired-compare.png
market/build_samples.js
market/index.html
market/market.src.html
market/pack.js
market/samples/cyber-night-dolly.avptpl
market/samples/doc-interview-real.avptpl
market/samples/manju-3panel-strip.avptpl
market/samples/oriental-ink-portrait.avptpl
market/samples/prev/oriental-ink-portrait-1.1.0.avptpl
market/samples/product-turntable-pro.avptpl
market/selftest.js
market/sign.js
market/snapshot.json
market/spec/license.md
market/spec/template.schema.json
market/store.js
market/store/index.json
market/store/tpl/cyber-night-dolly.avptpl
market/store/tpl/cyber-night-dolly/1.3.1.avptpl
market/store/tpl/doc-interview-real.avptpl
market/store/tpl/doc-interview-real/2.0.0.avptpl
market/store/tpl/manju-3panel-strip.avptpl
market/store/tpl/manju-3panel-strip/1.1.0.avptpl
market/store/tpl/oriental-ink-portrait.avptpl
market/store/tpl/oriental-ink-portrait/1.1.0.avptpl
market/store/tpl/oriental-ink-portrait/1.2.0.avptpl
market/store/tpl/product-turntable-pro.avptpl
market/store/tpl/product-turntable-pro/1.0.3.avptpl
market/workflow.js
plugins/_shot-manifest.png
plugins/_shot-ui-runtime.png
plugins/fixtures/bad-manifest/plugin.json
plugins/fixtures/exec-quarantine/plugin.json
plugins/fixtures/version-fail/plugin.json
plugins/index.html
plugins/keys/dev-keypair.json
plugins/keys/trusted.json
plugins/loader.js
plugins/packs/sample-model-pack/plugin.json
plugins/packs/sample-node-pack/plugin.json
plugins/packs/sample-preset-pack/gen-preset.js
plugins/packs/sample-preset-pack/plugin.json
plugins/packs/sample-ui-pack/plugin.json
plugins/plugins.src.html
plugins/schema/plugin.schema.json
plugins/selftest.js
plugins/snapshot.json
prompt/compose.js
prompt/lexicon.zh.json
prompt/safety.js
prompt/selftest.js
prompt/styles.json
quality/README.md
quality/export.js
quality/fixtures.js
quality/frames.js
quality/index.html
quality/inspector.live.html
quality/probe.js
quality/quality.src.html
quality/report.js
quality/selftest.js
quality/snapshot.json
server/aesthetics.js
server/app.js
server/archive.js
server/audit.js
server/bayes.js
server/canvasbuilder.js
server/character.js
server/cine.js
server/comfy-recovery.selftest.js
server/comfy.js
server/ds.js
server/engines.js
server/gpu.js
server/h3abc.js
server/h3real.js
server/h3workflow.js
server/index.html
server/jobs.js
server/providers/cine.js
server/providers/comfy.js
server/providers/index.js
server/providers/mock.js
server/providers/seedream.js
server/quality.js
server/recommend.js
server/scoring.js
server/selftest.js
server/server.src.html
server/snapshot.json
server/static.js
server/task-recovery.selftest.js
server/ultimate.js
server/visinter.js
server/wf.js
spec/aesthetics.json
spec/engines.json
spec/generation.profiles.json
spec/model.configs.json
spec/model_configs.json
spec/models.catalog.json
spec/muse.presets.json
spec/params.registry.json
spec/quality.json
spec/reverse.capabilities.json
spec/rules.linkage.json
spec/visinter.agent.json
templates/h3_t2v_min.json
tools/backlink.mjs
tools/build_all.mjs
tools/build_app.mjs
tools/build_canvas.mjs
tools/build_inspector.mjs
tools/build_module.mjs
tools/build_wizard.mjs
tools/capability.mjs
tools/check_wizard.mjs
tools/comfy_start.sh
tools/doctor.mjs
tools/e2e.mjs
tools/gen_registry.mjs
tools/h3.mjs
tools/h3_run.mjs
tools/h3abc.mjs
tools/lint_ui.mjs
tools/model_selftest.mjs
tools/plugin.mjs
tools/polish.mjs
tools/prompt.mjs
tools/qa.mjs
tools/realrun.mjs
tools/restyle.mjs
tools/score_cv.py
tools/selftest_all.mjs
tools/serve.mjs
tools/setup_models.sh
tools/snap_all.mjs
tools/snap_market.mjs
tools/snap_plugins.mjs
tools/snap_quality.mjs
tools/snap_server.mjs
tools/snap_ultimate.mjs
tools/snap_visinter.mjs
tools/tpl.mjs
tools/ultimate.mjs
tools/unify_tokens.mjs
tools/visinter.mjs
ui/glass-skin.css
ui/module-ui.css
ui/tokens.css
ultimate/index.html
ultimate/snapshot.json
ultimate/ultimate.src.html
visinter/index.html
visinter/snapshot.json
visinter/visinter.src.html
web/params.html
web/params.src.html
wizard/engine.js
wizard/engine.selftest.mjs
wizard/index.html
wizard/index.src.html
wizard/library.js
wizard/library.selftest.mjs
wizard/onboard.js
wizard/onboard.selftest.mjs
wizard/selftest.js
wizard/styles.js
wizard/theme.css
wizard/wizard.js
启动平台.cmd
```
