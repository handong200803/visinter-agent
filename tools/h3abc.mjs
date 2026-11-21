#!/usr/bin/env node
/**
 * tools/h3abc.mjs —— 本地 H3 的 A/B/C 真机对照（三条真生成 + 四维打分 + CSV）
 *
 * 用法：
 *   node tools/h3abc.mjs --prompt "雨夜江南水乡，镜头缓慢前推" --seconds 5
 *   node tools/h3abc.mjs --prompt "..." --width 640 --height 512 --seed 42
 *
 * 说明：C 组参数来自 proxy 寻优（GP+EI），分数来自真机四维打分；两者在输出里分开标注，
 * 不把「proxy 挑的参数」说成「proxy 评的分数」。
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ABC = require(path.join(ROOT, 'server', 'h3abc.js'));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

(async () => {
  const prompt = arg('prompt', '清晨的江南水乡，湿石板路向前延伸，白墙黑瓦倒映在运河里，镜头缓慢前推');
  const r = await ABC.run({
    prompt,
    width: Number(arg('width', 480)),
    height: Number(arg('height', 512)),
    seconds: Number(arg('seconds', 5)),
    seed: Number(arg('seed', 20261119)),
    usableMib: Number(arg('mib', 8151)),
    onProgress: (m) => console.log('[abc] ' + m),
  });
  console.log('\n== A/B/C（真机）==');
  for (const row of r.rows) {
    console.log(`  ${row.id} steps=${row.steps} cfg=${row.cfg} shift=${row.shift} → F=${row.F == null ? '失败 ' + (row.error || '') : row.F.toFixed(4)}`);
  }
  console.log('\n' + r.bars);
  console.log(`\n贝叶斯参数（proxy）：steps=${r.bayes.steps} cfg=${r.bayes.cfg} shift=${r.bayes.shift} · ${r.bayes.iters} 轮`);
  console.log(`CSV：${r.csv}`);
  console.log(`目录：${r.dir}`);
  process.exit(0);
})().catch((e) => { console.error('ABC 失败：', e.code || '', e.message); process.exit(1); });
