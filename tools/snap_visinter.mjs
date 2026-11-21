#!/usr/bin/env node
/**
 * snap_visinter.mjs —— 生成 visinter/snapshot.json（VisInter 入口的构建期快照）
 *
 * 为什么需要它：
 *   页面要能双击 file:// 打开，运行时不能 fetch 本地 JSON（CORS），所以规格、默认值、
 *   风险阈值必须在构建期注入 window.__SNAP。这里只读 spec/*.json 与注册表，不连端口、不跑自检。
 *
 * 跑法：node tools/snap_visinter.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const spec = json('spec/visinter.agent.json');
const reg = json('spec/params.registry.json');
const defaults = {};
for (const p of reg.params) defaults[p.key] = p.default;

// 页面只关心这些键的默认值（风险检测 + 联动 + 提示词）
const KEYS = [
  'kf.resolution', 'kf.ratio', 'kf.steps', 'kf.cfg', 'kf.sampler', 'mo.strength',
  'kf.ipadapter_weight', 'kf.identity_weight', 'kf.face_denoise',
  'lk.lut', 'lk.bloom', 'lk.chroma', 'lk.sharpen', 'lk.screen_tone', 'lk.lut_strength',
  'ch.ref_images', 'kf.prompt_prefix', 'kf.negative', 'ch.face_shape', 'ch.subject',
];
const picked = {};
for (const k of KEYS) picked[k] = defaults[k];

const snap = {
  generatedAt: new Date().toISOString(),
  schema: spec.schema,
  version: spec.version,
  banner: '💡 智能风险检测已开启：所有参数完全自由自定义，高风险配置仅提示，不限制提交',
  pipeline: spec.pipeline,
  modes: spec.modes,
  prompts: spec.prompts,
  presets: spec.presets,
  resolutions: spec.resolutions,
  risk_rules: spec.risk_rules,
  risk_thresholds: spec.risk_thresholds,
  linkage: spec.linkage,
  face_presets: spec.face_presets,
  selfcheck: {
    label: spec.selfcheck.label,
    shots: spec.selfcheck.shots,
    model_requirements: spec.selfcheck.model_requirements,
    layers: spec.selfcheck.layers,
    report: spec.selfcheck.report,
    status_words: spec.selfcheck.status,
    // 构建期不跑自检：静态标 inferred，页面上点「一键自检」才会真正探活
    status: 'inferred',
    reason: '未跑自检（构建期快照）。点页面「一键自检」走后端 /api/visinter/selfcheck 探 ComfyUI 与模型文件。',
  },
  defaults: picked,
  registry: { version: reg.version, total: reg.counts.total, staged: reg.counts },
};

const out = path.join(ROOT, 'visinter', 'snapshot.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(snap, null, 2) + '\n', 'utf8');
console.log(`OK visinter/snapshot.json · ${(Buffer.byteLength(JSON.stringify(snap)) / 1024).toFixed(0)}KB · ${reg.counts.total} 参数 · ${spec.risk_rules.length} 条风险`);
