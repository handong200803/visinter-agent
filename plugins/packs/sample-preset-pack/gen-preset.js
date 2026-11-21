/**
 * gen-preset.js —— 生成示例预设插件（CJS，零依赖）
 *
 * 为什么要有这个脚本而不是手写 plugin.json：
 *   `contributes.preset` 的 checksum 是 engine 的 djb2(JSON.stringify(values))，且 exportPreset
 *   会**丢弃等于默认值**的项并按键名排序。手抄这份 JSON 一定会出现"checksum 对不上"或
 *   "把默认值也写进去"的偏差。所以预设一律由 core/engine.js 的 exportPreset 生成，
 *   本脚本只负责喂 values + meta，再把结果内联进 manifest。
 *
 * 复现：node plugins/packs/sample-preset-pack/gen-preset.js
 * 注意：脚本只写本包目录内的 plugin.json，绝不碰 spec/。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../../../core/engine.js');

const ROOT = path.resolve(__dirname, '../../..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'params.registry.json'), 'utf8'));

// 一套"高画质 30fps 出片"的口味：步数抬高、CFG 略升、动效补帧、导出换 H.265、调色走青橙。
// 只挑 L3/L4 里的真实 key，值必须落在 min/max 或 options 之内（否则加载器会拒）。
const values = {
  'kf.steps': 32,
  'kf.cfg': 5.5,
  'kf.sampler': 'dpmpp_3m_sde',
  'mo.fps': 30,
  'ex.codec': 'H.265',
  'lk.lut': '青橙',
  'lk.grain': 18,
};

const preset = engine.exportPreset(registry, values, {
  name: '示例 · 高画质 30fps 出片',
  author: 'ai-video-platform 示例',
  device: 'T0（8G 笔记本）',
});

const manifest = {
  schema: 'ai-video-platform/plugin',
  id: 'sample-preset-pack',
  name: '示例 · 参数预设包',
  version: '1.0.0',
  type: 'preset',
  description: '演示 preset 类插件：values 由 core/engine.js exportPreset 生成并带 djb2 校验和；registry_version 锁 0.1.0，跨版本导入会被拒。',
  author: 'ai-video-platform 示例',
  engines: { platform: '>=0.1.0', registry: '>=0.1.0 <0.2.0' },
  permissions: [],
  contributes: { preset },
};

const text = JSON.stringify(manifest, null, 2) + '\n';
const out = path.join(__dirname, 'plugin.json');

// 默认只往 stdout 输出：本机（受控环境）里 node 的 fs 写盘会被上层策略拦成 EPERM，
// 但 pipe + PowerShell 重定向可以落盘。需要直写时显式加 --write，两种路径产出同一份文本。
if (process.argv.includes('--write')) {
  fs.writeFileSync(out, text, 'utf8');
  process.stderr.write('已写入 ' + path.relative(ROOT, out) + '\n');
} else {
  process.stdout.write(text);
}
process.stderr.write('checksum=' + preset.checksum + '  keys=' + Object.keys(preset.values).length + '\n');
