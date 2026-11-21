'use strict';
/**
 * quality/fixtures.js —— 用 ffmpeg 现场生成测试素材（不下载、不联网）
 *
 * 为什么自己造：
 *   质检口径必须拿"已知答案"的片子校准。真机素材没有 ground truth，
 *   所以生成两段对照片：good 全正常，bad 在固定帧号注入黑帧/白帧/模糊/冻结，
 *   selftest 才能把"检出帧号"和"注入帧号"逐条比对。
 *
 * 落盘位置：%CACHE_ROOT%\avp\qc\fixtures\（缓存区，不占云盘）
 *
 * bad 的注入时间轴（30fps，共 120 帧 = 4.0s）：
 *   帧 20-24  纯黑 5 帧   (t 0.6667-0.8333)
 *   帧 40-42  纯白 3 帧   (t 1.3333-1.4333)
 *   帧 60-89  高斯模糊    (t 2.0-2.9667)
 *   帧 100-119 冻结（复制第 99 帧）(t 3.3333-3.9667)
 * good：30fps 90 帧 = 3.0s，720x1280，渐变+网格+运动方块，带 AAC 静音轨（顺带验音频参数）
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CACHE_ROOT = process.env.CACHE_ROOT || 'D:\\缓存';
const QC_DIR = path.join(CACHE_ROOT, 'avp', 'qc');
const FIX_DIR = path.join(QC_DIR, 'fixtures');
const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';

const SIZE = '720x1280';
const FPS = 30;

/** 画面底座：线性渐变（给亮度基线）+ 72px 网格（给锐度足够的高频）+ 往复运动方块（给帧间差） */
function baseSource(dur) {
  // seed 必须写死：gradients 默认 seed=-1（按时间随机），会导致每次生成的素材亮度/纹理都不一样，
  // 那样"实测数字"就无法复现。固定 seed 后同一台机器每次生成像素级一致。
  return `gradients=s=${SIZE}:r=${FPS}:d=${dur}:c0=0x0d2b3a:c1=0xf0c080:speed=0.01:type=linear:seed=20261116`;
}
function baseChain() {
  // 匀速直线运动（不要用 sin：正弦在折返点速度=0，会造出"假冻结"，实测过）
  // 注意用 iw/ih 而不是 W/H：ffmpeg 9 的 drawbox 表达式只认 iw/ih/in_w/in_h（实测 W/H 会报 Unknown function）
  return (
    'drawgrid=w=72:h=72:t=2:c=white@0.28,' +
    "drawbox=x='20+t*120':y='300+t*90':w=240:h=240:c=white@0.92:t=fill," +
    "drawbox=x='560-t*110':y='900-t*70':w=120:h=120:c=0x35E0FF@0.85:t=fill"
  );
}

function run(args, label) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw new Error(`${label} 启动 ffmpeg 失败：${r.error.message}`);
  if (r.status !== 0) throw new Error(`${label} ffmpeg 非零退出 ${r.status}\n${(r.stderr || '').slice(-1200)}`);
  return r;
}

function generateGood(out) {
  run(
    ['-y', '-hide_banner', '-loglevel', 'error',
     '-f', 'lavfi', '-i', baseSource(3),
     '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
     '-vf', baseChain(),
     '-map', '0:v', '-map', '1:a', '-shortest',
     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
     '-fps_mode', 'cfr', '-r', String(FPS), '-g', '30',
     '-c:a', 'aac', '-b:a', '64k', out],
    'good',
  );
}

function generateBad(out) {
  // 注意 setpts=PTS-STARTPTS+2/TB：把模糊段整体平移到 t=2s，
  // 否则 overlay 找不到对齐的次输入帧，会 repeatlast 成一张静帧（那就变成假冻结了）。
  const fc = [
    `[0:v]${baseChain()}[base]`,
    '[base]split=2[norm][bsrc]',
    `[bsrc]trim=start_frame=60:end_frame=90,setpts=PTS-STARTPTS+2/TB,gblur=sigma=14[bl]`,
    `[norm][bl]overlay=enable='gte(t,2.0)*lt(t,2.9667)'[o1]`,
    // 全屏纯黑 5 帧：enable 用半开区间 [0.6666,0.8333) 正好命中帧 20-24
    `[o1]drawbox=x=0:y=0:w=iw:h=ih:c=black:t=fill:enable='gte(t,0.6666)*lt(t,0.8333)'[o2]`,
    // 全屏纯白 3 帧：帧 40-42
    `[o2]drawbox=x=0:y=0:w=iw:h=ih:c=white:t=fill:enable='gte(t,1.3333)*lt(t,1.4333)'[o3]`,
    // 冻结 20 帧：取第 99 帧当"静帧"，在 t>=3.3333 之后盖住主画面。
    // 不用 freezeframes 是因为它（实测）在替换帧耗尽时提前结束输出——只剩 101 帧，
    // overlay 的单帧次输入配合 eof_action=repeat 才不会截断主路。
    `[o3]split=2[main][fsrc]`,
    `[fsrc]trim=start_frame=99:end_frame=100,setpts=PTS-STARTPTS[still]`,
    `[main][still]overlay=enable='gte(t,3.3333)':eof_action=repeat[v]`,
  ].join(';');
  run(
    ['-y', '-hide_banner', '-loglevel', 'error',
     '-f', 'lavfi', '-i', baseSource(4),
     '-filter_complex', fc, '-map', '[v]',
     '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
     '-fps_mode', 'cfr', '-r', String(FPS), '-g', '30', out],
    'bad',
  );
}

/** 生成（默认已存在则复用；force=true 重造） */
function generate(opts = {}) {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const good = path.join(FIX_DIR, 'good-720p30.mp4');
  const bad = path.join(FIX_DIR, 'bad-720p30.mp4');
  const made = [];
  // 0 字节视为"上次生成失败留下的残骸"，必须重造，否则会拿空文件跑出一堆假结论
  const usable = (p) => fs.existsSync(p) && fs.statSync(p).size > 0;
  if (opts.force || !usable(good)) { generateGood(good); made.push(good); }
  if (opts.force || !usable(bad)) { generateBad(bad); made.push(bad); }
  return { dir: FIX_DIR, good, bad, made, expected: { black: [20, 24], white: [40, 42], blur: [60, 89], freeze: [100, 119] } };
}

module.exports = { generate, FIX_DIR, QC_DIR, CACHE_ROOT, FFMPEG, FPS };

if (require.main === module) {
  const r = generate({ force: process.argv.includes('--force') });
  for (const f of [r.good, r.bad]) {
    const st = fs.statSync(f);
    console.log(`${path.basename(f)}  ${(st.size / 1024).toFixed(0)} KB`);
  }
  console.log('注入帧号（30fps）：黑 ' + r.expected.black.join('-') + ' · 白 ' + r.expected.white.join('-') +
    ' · 模糊 ' + r.expected.blur.join('-') + ' · 冻结 ' + r.expected.freeze.join('-'));
}