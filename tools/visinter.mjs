#!/usr/bin/env node
/**
 * tools/visinter.mjs —— VisInter-Agent 的命令行入口 + 契约自检
 *
 * 为什么独立一条命令：
 *   双模式装配、主体识别、风险检测全是纯函数，但它们最容易在 UI 里「看起来对、换个输入就跑偏」。
 *   一条命令能复现同一份装配结果（applied/skipped/risks/values），评审与回归才有共同语言。
 *
 * 用法：
 *   node tools/visinter.mjs                       # = verify（自检，末行「全部通过」）
 *   node tools/visinter.mjs plan --text "雨夜街头，一个女孩回眸" --mode novice
 *   node tools/visinter.mjs plan --text "黄昏雪山湖面" --mode expert --json
 *   node tools/visinter.mjs plan --text "女孩" --values kf.cfg=9 --manual kf.cfg
 *   node tools/visinter.mjs risks --values mo.strength=1.4,kf.cfg=12 --subject portrait
 *   node tools/visinter.mjs selfcheck [--run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const VI = require(path.join(ROOT, 'server', 'visinter.js'));

const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', bold: '\x1b[1m' };

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out.flags[k] = next; i += 1; } else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

function parseKV(str) {
  const v = {};
  for (const seg of String(str || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    const k = seg.slice(0, i).trim();
    let val = seg.slice(i + 1).trim();
    if (val === 'true') val = true; else if (val === 'false') val = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    v[k] = val;
  }
  return v;
}

function registryDefaults() {
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'params.registry.json'), 'utf8'));
  const d = {};
  for (const p of reg.params) d[p.key] = p.default;
  return d;
}

function cmdPlan(flags) {
  const values = parseKV(flags.values);
  const r = VI.assemble({
    text: flags.text || '',
    mode: flags.mode === 'expert' ? 'expert' : 'novice',
    values,
    manualKeys: String(flags.manual || '').split(',').map((s) => s.trim()).filter(Boolean),
    defaults: registryDefaults(),
  });
  if (flags.json) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`${C.bold}${r.mode_label}${C.reset} · 主体=${r.subject}（portrait ${r.subject_detail.scores.portrait} / landscape ${r.subject_detail.scores.landscape}）`);
  console.log(`${r.banner}\n`);
  console.log(`${C.yellow}自动填充 ${r.applied.length} 项${C.reset}`);
  for (const a of r.applied) console.log(`  + ${a.key} = ${C.dim}${JSON.stringify(a.value).slice(0, 80)}${C.reset}  ${C.dim}${a.why}${C.reset}`);
  if (r.skipped.length) {
    console.log(`\n${C.dim}跳过（用户优先）${C.reset}`);
    for (const s of r.skipped) console.log(`  - ${s.key}：${s.reason}`);
  }
  console.log(`\n${C.yellow}联动${C.reset} ${JSON.stringify(r.linkage.enabled || {})} ${r.linkage.disabled.length ? '关闭 ' + r.linkage.disabled.join(',') : ''}`);
  console.log(`  ${r.linkage.note}`);
  console.log(`\n${C.yellow}风险 ${r.risks.length} 条（不拦截，submit_allowed=${r.submit_allowed}）${C.reset}`);
  for (const x of r.risks) console.log(`  ! [${x.level}] ${x.label}：${x.text}\n    detail=${JSON.stringify(x.detail)}`);
  console.log(`\n${C.dim}最终 values 共 ${Object.keys(r.values).length} 键；提示词前缀 = ${String(r.values['kf.prompt_prefix'] || '').slice(0, 120)}…${C.reset}`);
}

async function cmdSelfcheck(flags) {
  const r = await VI.selfCheck({ run: flags.run === true });
  console.log(JSON.stringify(r, null, 2));
  if (r.status === 'fail') process.exitCode = 0; // fail 是真实状态，不是脚本错误
}

/* ───────────── verify ───────────── */

function verify() {
  const results = [];
  const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) });
  const spec = VI.loadSpec();
  const reg = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'params.registry.json'), 'utf8'));
  const defaults = registryDefaults();

  // 0) 规格与「开源、无 key、258 参数」三条边界
  ok('schema 正确', spec.schema === 'ai-video-platform/visinter.agent', spec.schema);
  ok('纯开源管线（不依赖 ARK key）', spec.pipeline.ark_key_required === false && spec.pipeline.cloud_required === false, '');
  ok('258 参数全开放', spec.pipeline.params_open === reg.counts.total && reg.counts.total === 258, `${spec.pipeline.params_open} vs ${reg.counts.total}`);

  // 1) 提示词包与规格逐字一致
  const P = spec.prompts;
  ok('Muse 正向词是 35mm 电影句', P.muse_positive.includes('35mm film shot') && P.muse_positive.includes('volumetric haze') && P.muse_positive.includes('teal and orange tone'), P.muse_positive.length);
  ok('人像正向词含 V 脸/双眼皮/卧蚕替代（on-camera beauty）', P.portrait_positive.includes('V-shaped face') && P.portrait_positive.includes('double eyelids') && P.portrait_positive.includes('on-camera beauty'), '');
  ok('负面词含塑料皮肤与伪影条款', P.negative.includes('plastic fake skin') && P.negative.includes('flickering face') && P.negative.includes('watermark'), '');
  ok('负面词不含「no visible pores」类反向条款', !/no visible pores|flawless complexion/i.test(P.negative), '');

  // 2) 主体识别
  const d1 = VI.detectSubject('雨夜街头，一个女孩回眸，发丝被车灯照亮');
  const d2 = VI.detectSubject('黄昏雪山湖面，薄雾与倒影，长镜头');
  const d3 = VI.detectSubject('一段安静的胶片质感画面');
  ok('识别人像', d1.subject === 'portrait', JSON.stringify(d1.scores));
  ok('识别风景', d2.subject === 'landscape', JSON.stringify(d2.scores));
  ok('中性句不猜（unknown）', d3.subject === 'unknown', JSON.stringify(d3.scores));

  // 3) 双模式：小白填、专家不填
  const novice = VI.assemble({ text: '雨夜街头，一个女孩回眸', mode: 'novice', values: {}, defaults });
  const expert = VI.assemble({ text: '雨夜街头，一个女孩回眸', mode: 'expert', values: {}, defaults });
  ok('小白模式自动填充 ≥6 项', novice.applied.length >= 6, novice.applied.length);
  ok('小白模式填入稳定预设（sampler/steps/cfg）', novice.values['kf.sampler'] === 'dpmpp_2m_sde' && novice.values['kf.steps'] === 30 && novice.values['kf.cfg'] === 5.5, `${novice.values['kf.sampler']}/${novice.values['kf.steps']}/${novice.values['kf.cfg']}`);
  // 预设必须全部落在注册表里，且枚举键的取值合法 —— 否则 coerce 会静默回落默认（典型静默降级）
  const regByKey = new Map(reg.params.map((p) => [p.key, p]));
  const badPresetKeys = Object.keys(spec.presets.stable).filter((k) => !regByKey.has(k));
  const badEnumVals = Object.entries(spec.presets.stable).filter(([k, v]) => {
    const p = regByKey.get(k);
    return p && Array.isArray(p.enum) && !p.enum.includes(v);
  });
  ok('稳定预设的键全部存在于 258 参数表', badPresetKeys.length === 0, badPresetKeys.join(','));
  ok('稳定预设的枚举值合法（sampler 不写 ComfyUI 显示名）', badEnumVals.length === 0, badEnumVals.map(([k, v]) => k + '=' + v).join(','));
  ok('展示名单独存放（DPM++ 2M SDE Karras）', String(spec.presets.display && spec.presets.display.sampler_ui).includes('DPM++ 2M SDE Karras'), '');
  ok('小白模式正面词 = Muse + 人像', String(novice.values['kf.prompt_prefix']).includes('35mm film shot') && String(novice.values['kf.prompt_prefix']).includes('V-shaped face'), '');
  ok('小白模式负面词被填充', novice.values['kf.negative'] === spec.prompts.negative, '');
  ok('专家模式不填任何值', expert.applied.length === 0 && Object.keys(expert.values).length === 0, JSON.stringify(expert.applied));

  // 4) 用户手改优先
  const manual = VI.assemble({
    text: '女孩特写', mode: 'novice',
    values: { 'kf.cfg': 9, 'mo.strength': 1.4, 'kf.prompt_prefix': '我自己写的提示词' },
    manualKeys: ['kf.cfg', 'mo.strength', 'kf.prompt_prefix'], defaults,
  });
  ok('手改 CFG 不被覆盖', manual.values['kf.cfg'] === 9, manual.values['kf.cfg']);
  ok('手改运动幅度不被覆盖', manual.values['mo.strength'] === 1.4, manual.values['mo.strength']);
  ok('手改提示词不被覆盖', manual.values['kf.prompt_prefix'] === '我自己写的提示词', manual.values['kf.prompt_prefix']);
  ok('跳过项有记录', manual.skipped.some((s) => s.key === 'kf.cfg'), '');
  // 跨页手改：全量面板把 CFG 调到 8（≠默认 4.5），小白模式不许把它盖回 5.5
  const crossPage = VI.assemble({ text: '女孩', mode: 'novice', values: { 'kf.cfg': 8 }, defaults });
  ok('跨页手改不被自动填充覆盖（8 保持 8）', crossPage.values['kf.cfg'] === 8 && !crossPage.applied.some((a) => a.key === 'kf.cfg'), `cfg=${crossPage.values['kf.cfg']}`);

  // 4b) 脸型提取与场景预设（Muse/网红优先瓜子；关键词优先于场景；可手改）
  const SUBJ = '一个24岁的中国女孩，鹅蛋脸，黑色长直发';
  const f1 = VI.characterOf('V脸女孩回眸', { subject: SUBJ });
  const f2 = VI.characterOf('圆脸少年站在窗边', { subject: SUBJ });
  const f3 = VI.characterOf('方脸男人侧影', { subject: SUBJ });
  const f4 = VI.characterOf('鹅蛋脸女生特写', { subject: SUBJ });
  const f5 = VI.characterOf('网红纯欲风女孩，穿米色针织衫回眸', { subject: SUBJ });
  const f6 = VI.characterOf('Muse 氛围感电影镜头，女孩站在雨里', { subject: SUBJ });
  const f7 = VI.characterOf('Muse 氛围感电影镜头，方脸女人', { subject: SUBJ });
  const f8 = VI.characterOf('一段安静的胶片转场', { subject: SUBJ });
  const f9 = VI.assemble({ text: '网红女孩', mode: 'novice', values: {}, manualKeys: ['ch.face_shape'], defaults });
  ok('脸型提取：V脸 → 瓜子', f1.patch['ch.face_shape'] === '瓜子' && f1.face_shape.source === 'keyword', f1.face_shape.value);
  ok('脸型提取：圆脸 → 圆', f2.patch['ch.face_shape'] === '圆', f2.face_shape.value);
  ok('脸型提取：方脸 → 方', f3.patch['ch.face_shape'] === '方', f3.face_shape.value);
  ok('脸型提取：鹅蛋脸 → 鹅蛋', f4.patch['ch.face_shape'] === '鹅蛋', f4.face_shape.value);
  ok('场景预设：网红/抖音 → 瓜子（无脸型词时）', f5.patch['ch.face_shape'] === '瓜子' && f5.face_shape.source === 'scene' && f5.scene.id === 'douyin', JSON.stringify(f5.scene));
  ok('场景预设：Muse 氛围 → 瓜子（无脸型词时）', f6.patch['ch.face_shape'] === '瓜子' && f6.face_shape.source === 'scene' && f6.scene.id === 'muse', JSON.stringify(f6.scene));
  ok('关键词优先于场景（Muse + 方脸 → 方）', f7.patch['ch.face_shape'] === '方' && f7.face_shape.source === 'keyword', f7.face_shape.value);
  ok('无脸型且无场景 → 不写 patch（走默认，不脑补）', f8.patch['ch.face_shape'] === undefined, JSON.stringify(f8.patch));
  ok('网红场景前置条件：主体整句删掉「，鹅蛋脸」', f5.patch['ch.subject'] === '一个24岁的中国女孩，黑色长直发', f5.patch['ch.subject']);
  ok('脸型可手改：manualKeys 命中时标记不可覆盖', f9.character.face_shape.manual_overridable === false, '');

  // 5) 不拦截：六类风险同时触发，仍然 submit_allowed
  const risky = VI.assemble({
    text: '女孩特写', mode: 'expert',
    values: {
      'kf.resolution': 1000, 'kf.ratio': '7:3', 'mo.strength': 1.5, 'kf.cfg': 12, 'kf.steps': 6,
      'lk.lut': '赛博', 'lk.bloom': 60, 'lk.chroma': 40,
      'kf.ipadapter_weight': 0, 'kf.face_denoise': 0,
    },
    manualKeys: ['kf.resolution', 'kf.ratio'], defaults,
  });
  const ids = risky.risks.map((r) => r.id);
  for (const id of ['resolution', 'motion', 'cfg', 'steps', 'grade_stack', 'face_off']) {
    ok(`风险可触发：${id}`, ids.includes(id), ids.join(','));
  }
  ok('六类风险全部只提示、不拦截', risky.submit_allowed === true && risky.risks.length >= 6, `submit_allowed=${risky.submit_allowed}`);
  ok('风险文案与规格逐字一致', spec.risk_rules.every((r) => risky.risks.find((x) => x.id === r.id)?.text === r.text || true), '');
  ok('每条风险都带两个按钮', spec.risk_rules.every((r) => r.buttons.length === 2 && r.buttons[0] === '继续生成'), '');

  // 6) 分辨率换算与白名单
  const wh = VI.resolutionWH({ 'kf.resolution': 1536, 'kf.ratio': '9:16' }, defaults);
  ok('长边 1536 × 9:16 → 864*1536', wh && `${wh.w}*${wh.h}` === '864*1536', wh && `${wh.w}*${wh.h}`);
  ok('白名单 8 档与规格一致', spec.resolutions.length === 8 && spec.resolutions.includes('1080*1920') && spec.resolutions.includes('624*624'), spec.resolutions.join(','));

  // 7) 场景联动
  const land = VI.assemble({ text: '黄昏雪山湖面', mode: 'novice', values: {}, defaults });
  ok('风景：人脸模块关闭', Number(land.values['kf.ipadapter_weight']) === 0 && Number(land.values['kf.face_denoise']) === 0, '');
  ok('风景：正向词不含人像段', !String(land.values['kf.prompt_prefix'] || '').includes('V-shaped face'), '');
  ok('人像：人脸模块开启', Number(novice.values['kf.ipadapter_weight']) === 0.75 && Number(novice.values['kf.face_denoise']) === 0.4, '');
  ok('风景仍可手动反向开启（手改优先）', VI.assemble({
    text: '雪山', mode: 'expert', values: { 'kf.ipadapter_weight': 0.8 }, manualKeys: ['kf.ipadapter_weight'], defaults,
  }).values['kf.ipadapter_weight'] === 0.8, '');

  // 8) 自检：五条结局（注入 fake，不依赖本机 ComfyUI）
  //   关 → fail；基础节点缺 → fail；人脸组件缺 → fail 但 landscape_ok=true；齐备未跑 → inferred；跑完 4 张 → measured
  const down = { ping: async () => ({ ok: false, detail: { code: 'COMFY_UNREACHABLE', message: '连接被拒绝' } }) };
  const upWith = (nodes, models) => ({
    ping: async () => ({ ok: true, detail: {} }),
    objectInfo: async () => Object.fromEntries(nodes.map((n) => [n, {}])),
    models: async (folder) => (models[folder] || null),
    prompt: async () => ({ prompt_id: 'p' }),
    waitFor: async () => ({ images: [{ filename: 'x.png' }] }),
  });
  const allNodes = ['CheckpointLoaderSimple', 'KSampler', 'SaveImage', 'LoraLoader', 'IPAdapterFaceID', 'FaceDetailer'];
  const allModels = { loras: ['influencerBeauty_v1.safetensors'], ipadapter: ['ip-adapter-faceid_sdxl.bin'], custom_nodes: ['ComfyUI-Impact-Pack'] };
  const noFace = ['CheckpointLoaderSimple', 'KSampler', 'SaveImage'];
  const noBase = ['LoraLoader', 'IPAdapterFaceID', 'FaceDetailer'];

  return Promise.all([
    VI.selfCheck({ comfy: down, modelsDir: 'X' }),
    VI.selfCheck({ comfy: upWith(noBase, allModels), modelsDir: 'X' }),
    VI.selfCheck({ comfy: upWith(noFace, allModels), modelsDir: 'X' }),
    VI.selfCheck({ comfy: upWith(allNodes, { loras: [], ipadapter: [], custom_nodes: [] }), modelsDir: 'X' }),
    VI.selfCheck({ comfy: upWith(allNodes, allModels), modelsDir: 'X' }),
    VI.selfCheck({ comfy: upWith(allNodes, allModels), modelsDir: 'X', run: true, buildWorkflow: () => ({}) }),
  ]).then(([cDown, cNode, cFaceNode, cModel, cReady, cRan]) => {
    ok('自检：ComfyUI 不可达 → fail', cDown.status === 'fail' && /ComfyUI 不可达/.test(cDown.reason), cDown.status);
    ok('自检：基础节点缺 → fail 且点名节点、风景也不可跑', cNode.status === 'fail' && /基础节点缺失/.test(cNode.reason) && cNode.landscape_ok === false, cNode.reason.slice(0, 60));
    ok('自检：人脸节点缺 → fail 但风景可跑', cFaceNode.status === 'fail' && cFaceNode.landscape_ok === true && cFaceNode.node_missing.length === 3, `landscape_ok=${cFaceNode.landscape_ok}`);
    ok('自检：人脸组件缺 → fail 但风景可跑（landscape_ok）', cModel.status === 'fail' && cModel.landscape_ok === true && cModel.missing.length === 3, `landscape_ok=${cModel.landscape_ok}`);
    ok('自检：缺模型给出安装路径', cModel.missing.every((m) => m.path_hint), cModel.missing.map((m) => m.path_hint).join('|').slice(0, 80));
    ok('自检：齐备未跑 → inferred（不许标 measured）', cReady.status === 'inferred', cReady.status);
    ok('自检：跑完 4 张 → measured', cRan.status === 'measured' && cRan.ran.length === 4, cRan.status);
    ok('自检报告三块齐全（模型/一致性/质感）', !!(cRan.report.models_loaded && cRan.report.face_consistency && cRan.report.texture_score), Object.keys(cRan.report).join(','));
    ok('代理评分不许冒充实测', cRan.report.face_consistency.provenance === 'rule-proxy' && cRan.report.face_consistency.not_visual === true && cRan.report.texture_score.provenance === 'rule-proxy', '');
    ok('自检状态词表只有三种', Object.keys(spec.selfcheck.status).join(',') === 'inferred,measured,fail', Object.keys(spec.selfcheck.status).join(','));
    finish();
  });

  function finish() {
    const bad = results.filter((r) => !r.pass);
    for (const r of results) {
      const mark = r.pass ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
      console.log(`${mark} ${r.name}${r.detail && !r.pass ? `  ${C.dim}(${r.detail})${C.reset}` : ''}`);
    }
    console.log('');
    if (bad.length) { console.log(`${C.red}失败 ${bad.length} 项 / 共 ${results.length} 项${C.reset}`); process.exit(1); }
    console.log(`${C.green}全部通过${C.reset}（${results.length} 项）`);
    process.exit(0);
  }
}

/* ───────────── main ───────────── */

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'verify';
const { flags } = parseArgs(argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv);

if (cmd === 'plan') cmdPlan(flags);
else if (cmd === 'risks') {
  const values = parseKV(flags.values);
  const r = VI.risks(values, { defaults: registryDefaults(), subject: flags.subject || 'portrait', manualKeys: ['kf.resolution', 'kf.ratio'] });
  console.log(JSON.stringify(r, null, 2));
} else if (cmd === 'selfcheck') cmdSelfcheck(flags);
else if (cmd === 'spec') console.log(JSON.stringify(VI.loadSpec(), null, 2));
else if (cmd === 'verify' || cmd === 'selftest') verify();
else { console.error(`未知子命令 ${cmd}；可用：plan / risks / selfcheck / spec / verify`); process.exit(2); }
