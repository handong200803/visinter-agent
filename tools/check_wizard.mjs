/**
 * check_wizard.mjs —— 向导页产物静态守门（10 条）
 *
 * 为什么守的是「产物」而不是 src：
 *   用户双击打开的是 wizard/index.html。只查源件会漏掉构建器拼进来的东西
 *   （旧缓存、被误改的产物、别处塞进来的外链），而那才是真正被看到的那一份。
 *
 * 为什么每条都要有中文原因：
 *   守门脚本的价值不在「红了」，而在「红了之后知道为什么」。
 *   一句「缺 tabular-nums —— 参数数字会整行抖动」比「rule 4 failed」省一次排查。
 *
 * 10 条覆盖的是「向导页能不能承担演示」的硬条件：
 *   无外链 / 无运行时本地 JSON（双击 file:// 的前提）· 一屏一主标题 · 关键挂载点齐
 *   7 个风格 id · 五阶段文案 · 等待时长文案 · 新手引导标记 · 内联完整性 · 体积守门
 *
 * 跑法：
 *   node tools/check_wizard.mjs          人类可读；M>0 → 退出码 1
 *   node tools/check_wizard.mjs --json   机器可读（接 CI 用），仅输出 JSON
 *
 * 标记解析复用 build_wizard.mjs 导出的 inline / scanMarkers，不复制第二份逻辑。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inline, scanMarkers, OUT, SRC, SIZE_LIMIT } from './build_wizard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.env.WIZARD_ROOT || path.join(HERE, '..'));
const TARGET = path.join(ROOT, OUT);

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const kb = (n) => (n / 1024).toFixed(1) + 'KB';
const firstLine = (s) => String(s).split('\n')[0];

/** 统计正则命中：返回条数 + 前 limit 条带行号的样本（定位用，不刷屏） */
function findAll(text, re, limit = 2) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const all = [];
  let m;
  while ((m = g.exec(text))) {
    all.push({ index: m.index, hit: m[0] });
    if (all.length > 400) break; // 防御：别让一个满页命中把内存和时间拖死
  }
  const samples = all.slice(0, limit).map((x) => {
    const line = text.slice(0, x.index).split('\n').length;
    const row = text.split('\n')[line - 1] || '';
    return `L${line} ${row.trim().slice(0, 90)}`;
  });
  return { count: all.length, samples };
}

/* ── 10 条断言 ────────────────────────────────────────── */

const KEY_IDS = ['styles', 'prompt', 'btn-generate', 'stage-list', 'player', 'library'];
const STYLE_IDS = ['cinematic', 'photo', 'anime', 'guofeng', 'cyberpunk', 'dark', 'fantasy'];
const STAGE_TEXT = ['正在理解', '正在选择最优参数', '正在绘制画面', '正在让画面动起来', '正在检查画面质量'];

const RULES = [
  {
    id: 1,
    name: '无外链资源',
    why: '缩略图必须是内联 SVG；外链 http(s) 一断网就全是破图',
    run: (t) => {
      const PATS = [
        [/src\s*=\s*["']https?:/i, 'src="http'],
        [/href\s*=\s*["']https?:/i, 'href="http'],
        [/@import\s+url\(\s*["']?https?:/i, '@import url(http'],
        [/url\(\s*["']?https?:\/\//i, 'url(https://'],
      ];
      const bad = [];
      const samples = [];
      for (const [re, label] of PATS) {
        const r = findAll(t, re);
        if (r.count) {
          bad.push(`${label} ×${r.count}`);
          samples.push(...r.samples);
        }
      }
      if (bad.length) return { ok: false, detail: '外链 ' + bad.join(' · '), samples };
      return { ok: true, detail: '外链 0 处（缩略图走内联 SVG）' };
    },
  },
  {
    id: 2,
    name: '无运行时本地 JSON 读取',
    why: 'file:// 下 fetch 本地 .json 属跨源请求，必然失败；数据必须构建期内联',
    run: (t) => {
      const samples = [];
      const bad = [];
      const f = findAll(t, /fetch\s*\(\s*["'][^"']*\.json/i);
      if (f.count) { bad.push('fetch(.json) ×' + f.count); samples.push(...f.samples); }
      const x = findAll(t, /XMLHttpRequest/);
      if (x.count) { bad.push('XMLHttpRequest ×' + x.count); samples.push(...x.samples); }
      if (bad.length) return { ok: false, detail: '运行时读取 ' + bad.join(' · '), samples };
      return { ok: true, detail: 'fetch(.json) 0 处 · XMLHttpRequest 0 处' };
    },
  },
  {
    id: 3,
    name: '一屏一个主标题',
    why: '一屏一件事：每屏恰好一个 h1 是节奏，整页只有一个 h1 是另一种（单页应用）写法。向导是多屏单页，按屏校验',
    run: (t) => {
      const screens = t.split(/<section[^>]*class="screen/i).slice(1);
      if (!screens.length) {
        const n = (t.match(/<h1[\s>]/gi) || []).length;
        return n === 1 ? { ok: true, detail: '<h1> ×1' } : { ok: false, detail: `<h1> ×${n}（该页必须恰好 1 个）` };
      }
      const bad = [];
      screens.forEach((chunk, i) => {
        const head = chunk.split('</section>')[0];
        const n = (head.match(/<h1[\s>]/gi) || []).length;
        if (n !== 1) bad.push(`第 ${i + 1} 屏 h1 ×${n}`);
      });
      if (bad.length) return { ok: false, detail: bad.join(' · ') + '（每屏必须恰好 1 个）' };
      return { ok: true, detail: `${screens.length} 屏，每屏 <h1> ×1` };
    },
  },
  {
    id: 4,
    name: '关键挂载点齐备',
    why: '这 6 个 id 是脚本的挂载点；缺一个就是一段功能静默失效，界面上看不出来',
    run: (t) => {
      const miss = [];
      for (const id of KEY_IDS) {
        const re = new RegExp('id\\s*=\\s*["\']' + id.replace(/[-.]/g, '\\$&') + '["\']');
        if (!re.test(t)) miss.push(id);
      }
      if (miss.length) return { ok: false, detail: `缺 id：${miss.join('、')}（共 ${KEY_IDS.length} 个关键 id）` };
      return { ok: true, detail: `${KEY_IDS.length} 个关键 id 齐备：${KEY_IDS.join('、')}` };
    },
  },
  {
    id: 5,
    name: '七个风格 id',
    why: '风格卡片的 id 是数据契约：少一个，卡片区就少一格，且不会报错',
    run: (t) => {
      const miss = [];
      for (const id of STYLE_IDS) {
        // 要求字符串字面量：裸词 dark 会命中 prefers-color-scheme: dark，那不算风格卡
        if (!new RegExp('["\']' + id + '["\']').test(t)) miss.push(id);
      }
      if (miss.length) return { ok: false, detail: `缺风格 id：${miss.join('、')}（应含 ${STYLE_IDS.join(', ')}）` };
      return { ok: true, detail: `7 个风格 id 齐备：${STYLE_IDS.join(', ')}` };
    },
  },
  {
    id: 6,
    name: '五阶段进度文案',
    why: '进度阶段是「等 30~60 秒不焦虑」的唯一支撑；文案缺失等于进度条空转',
    run: (t) => {
      const miss = STAGE_TEXT.filter((s) => t.indexOf(s) < 0);
      if (miss.length) return { ok: false, detail: `缺阶段文案：${miss.join('、')}` };
      return { ok: true, detail: '五阶段文案齐全' };
    },
  },
  {
    id: 7,
    name: '等待时长文案',
    why: '不写「约 30~60 秒」，用户会以为卡死并刷新页面，进而以为产品坏了',
    run: (t) => {
      const m = /30\s*[~～\-—]\s*60/.exec(t);
      if (!m) return { ok: false, detail: '缺「约 30~60 秒」等待时长文案' };
      const line = t.slice(0, m.index).split('\n').length;
      const row = (t.split('\n')[line - 1] || '').trim().slice(0, 90);
      return { ok: true, detail: '命中 ' + m[0] + '（L' + line + '）', samples: ['L' + line + ' ' + row] };
    },
  },
  {
    id: 8,
    name: '新手引导标记',
    why: '引导遮罩与 localStorage 键是「第二次访问不再打扰」的开关，缺了要么天天弹要么永不弹',
    run: (t) => {
      const hasKey = t.indexOf('avp.wizard.onboarded') >= 0;
      // 类名可能出现在 HTML class、JS className、或 CSS 选择器里，三种都算在场
      const classForms = [
        [/class(Name)?\s*=\s*["'][^"']*\bonboard\b/i, 'class="onboard"'],
        [/\.onboard\b/i, 'CSS .onboard'],
        [/["']onboard["']/i, "字符串 'onboard'"],
      ];
      const hit = classForms.find(([re]) => re.test(t));
      if (!hasKey && !hit) return { ok: false, detail: '缺 onboard 类名 与 avp.wizard.onboarded 键' };
      if (!hasKey) return { ok: false, detail: '缺 localStorage 键 avp.wizard.onboarded' };
      if (!hit) return { ok: false, detail: '缺引导遮罩类名 onboard' };
      return { ok: true, detail: `onboard（${hit[1]}）· avp.wizard.onboarded 在场` };
    },
  },
  {
    id: 9,
    name: '内联完整性',
    why: '残留标记 = 构建没跑或写错；脚本提前闭合 = 后半页变纯文本，而浏览器不报错',
    run: (t) => {
      const samples = [];
      if (t.indexOf('<!--@inline:') >= 0) {
        // 用构建器同一个扫描器定位行号，而不是在这里另写一套正则
        const left = scanMarkers(t).map((m) => 'L' + m.line + ' ' + m.raw.trim().slice(0, 90));
        return {
          ok: false,
          detail: `残留 <!--@inline: 标记 ${left.length || '≥1'} 处（构建没跑完或标记没独占一行）`,
          samples: left.slice(0, 5),
        };
      }
      const open = (t.match(/<script\b/gi) || []).length;
      const close = (t.match(/<\/script\s*>/gi) || []).length;
      if (open !== close) {
        return {
          ok: false,
          detail: `<script> 不配对：开 ${open} · 闭 ${close}（有脚本在字符串里写了 </script>，把页面截断了）`,
          samples,
        };
      }
      const sOpen = (t.match(/<style\b/gi) || []).length;
      const sClose = (t.match(/<\/style\s*>/gi) || []).length;
      if (sOpen !== sClose) {
        return { ok: false, detail: `<style> 不配对：开 ${sOpen} · 闭 ${sClose}` };
      }
      return { ok: true, detail: `无残标 · <script> ${open}/${close} · <style> ${sOpen}/${sClose}` };
    },
  },
  {
    id: 10,
    name: '体积守门',
    why: '内联 SVG + 逻辑才几百 KB；一旦逼近 900KB，八成是有人把位图塞进了 HTML',
    run: (t) => {
      const bytes = Buffer.byteLength(t);
      if (bytes < SIZE_LIMIT) return { ok: true, detail: `${kb(bytes)} < ${kb(SIZE_LIMIT)}` };
      return { ok: false, detail: `${kb(bytes)} ≥ 守门线 ${kb(SIZE_LIMIT)}（检查是否有 base64 图片或大段冗余数据）` };
    },
  },
];

/* ── 跑 ───────────────────────────────────────────────── */

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const unknown = argv.filter((a) => !['--json', '--help', '-h'].includes(a));

  const out = (obj) => {
    if (asJson) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  };

  if (unknown.length) {
    const msg = '未知参数：' + unknown.join(' ') + '；用法：node tools/check_wizard.mjs [--json]';
    if (asJson) out({ ok: false, error: 'bad-args', message: msg, checks: [] });
    else console.log(`${C.red}✗ ${msg}${C.reset}`);
    process.exit(1);
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`${C.bold}check_wizard.mjs${C.reset} ${C.dim}向导页产物静态守门（10 条）· 断言对象 ${OUT}${C.reset}`);
    console.log('  （无参数）  人类可读；M>0 → 退出码 1');
    console.log('  --json      机器可读，仅输出 JSON');
    return;
  }

  if (!fs.existsSync(TARGET)) {
    const msg = `产物不存在：${OUT}；请先运行 node tools/build_wizard.mjs 再守门`;
    if (asJson) out({ ok: false, error: 'missing-product', target: OUT, pass: 0, fail: 0, checks: [], message: msg });
    else {
      console.log(`${C.red}${C.bold}✗ 还没构建${C.reset}`);
      console.log(`  ${C.dim}${msg}${C.reset}`);
    }
    process.exit(1);
  }

  const text = fs.readFileSync(TARGET, 'utf8');
  const bytes = Buffer.byteLength(text);

  let pass = 0;
  let fail = 0;
  const results = [];
  for (const rule of RULES) {
    let r;
    try {
      r = rule.run(text);
    } catch (err) {
      r = { ok: false, detail: '断言自身异常：' + firstLine(err && err.message ? err.message : err) };
    }
    if (r.ok) pass += 1; else fail += 1;
    results.push({ id: rule.id, name: rule.name, ok: r.ok, detail: r.detail, samples: r.samples || [] });
  }

  if (asJson) {
    out({
      ok: fail === 0,
      target: OUT,
      bytes,
      sizeKB: Number((bytes / 1024).toFixed(1)),
      pass,
      fail,
      checks: results,
    });
    process.exit(fail ? 1 : 0);
  }

  console.log(`${C.bold}向导页守门${C.reset} ${C.dim}${OUT} · ${kb(bytes)} · ${RULES.length} 条断言${C.reset}\n`);
  for (let i = 0; i < results.length; i += 1) {
    const r = results[i];
    const why = RULES[i].why;
    if (r.ok) {
      console.log(`  ${C.green}✓${C.reset} ${String(r.id).padStart(2, ' ')} ${r.name.padEnd(9, '　')} ${C.dim}${r.detail}${C.reset}`);
    } else {
      console.log(`  ${C.red}✗${C.reset} ${String(r.id).padStart(2, ' ')} ${r.name.padEnd(9, '　')} ${C.red}${r.detail}${C.reset}`);
      console.log(`      ${C.dim}为什么算错：${why}${C.reset}`);
      for (const s of (r.samples || []).slice(0, 3)) console.log(`      ${C.yellow}│${C.reset} ${C.dim}${s}${C.reset}`);
    }
  }

  // 顺手用构建器的 inline() 复核源还能不能内联：非致命，只是提前暴露「源坏了」
  const srcAbs = path.join(ROOT, SRC);
  if (fs.existsSync(srcAbs)) {
    try {
      const r = inline(fs.readFileSync(srcAbs, 'utf8'), { root: ROOT });
      console.log(`\n  ${C.dim}源${C.reset} ${SRC} ${C.dim}可内联：${r.files.length} 个文件 · ${r.markers} 处标记${C.reset}`);
    } catch (err) {
      console.log(`\n  ${C.yellow}源${C.reset} ${SRC} ${C.yellow}当前内联会失败：${firstLine(err.message)}${C.reset}`);
    }
  } else {
    console.log(`\n  ${C.dim}源${C.reset} ${SRC} ${C.dim}不存在（只校验产物，跳过源复核）${C.reset}`);
  }

  console.log(`\n${C.bold}结果${C.reset}  通过 ${pass} · 失败 ${fail}`);
  if (fail) {
    console.log(`${C.red}${C.bold}向导页守门未通过：${fail} 条${C.reset}  ${C.dim}见上方中文原因${C.reset}`);
    process.exit(1);
  }
  console.log(`${C.green}${C.bold}全部通过${C.reset}`);
}

try {
  main();
} catch (err) {
  console.log(`${C.red}✗ 守门脚本异常：${firstLine(err && err.message ? err.message : err)}${C.reset}`);
  process.exit(1);
}