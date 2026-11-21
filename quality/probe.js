'use strict';
/**
 * quality/probe.js —— 真实元数据抽取（只调 ffprobe，零第三方依赖）
 *
 * 为什么单独一层：
 *   逐帧质检最怕"容器说的"和"解码出来的"不一致（VFR、可变帧率、缺 nb_frames）。
 *   所以这里只负责把 ffprobe 的 JSON 翻译成稳定字段，并明确标注帧数是"容器声明"
 *   还是"数出来的（nb_read_frames）"，下游 frames.js 才有资格拿它做长度断言。
 *
 * 失败不抛异常、不崩进程：返回 { ok:false, code, message, hint }，
 * 让 CLI / selftest 能把错误码原样打给用户（这是 QC 工具该有的行为）。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';
let probeBinChecked = false;
let probeBinOk = false;

/** 帧率分数 "30000/1001" -> 29.97；"0/0" -> 0 */
function parseRate(str) {
  if (!str || typeof str !== 'string') return 0;
  const m = str.split('/');
  const a = Number(m[0]);
  const b = m.length > 1 ? Number(m[1]) : 1;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  return Math.round((a / b) * 1000) / 1000;
}

/** ffprobe 把缺失值写成字符串 "N/A"，统一转 null */
function num(v) {
  if (v === undefined || v === null || v === 'N/A' || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v) {
  return v === undefined || v === null || v === 'N/A' || v === '' ? null : String(v);
}

function checkBin() {
  if (probeBinChecked) return probeBinOk;
  probeBinChecked = true;
  const r = spawnSync(FFPROBE, ['-version'], { encoding: 'utf8', timeout: 10000 });
  probeBinOk = !r.error && r.status === 0;
  return probeBinOk;
}

function version() {
  const r = spawnSync(FFPROBE, ['-version'], { encoding: 'utf8', timeout: 10000 });
  if (r.error || r.status !== 0) return null;
  const m = /ffprobe version (\S+)/.exec(r.stdout || '');
  return m ? m[1] : null;
}

/**
 * 数真实解码帧数。只在容器没给 nb_frames（或给 0）时调用：
 * -count_frames 会把整条流解一遍，所以不能无条件用。
 */
function countFrames(file) {
  const r = spawnSync(
    FFPROBE,
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
     '-show_entries', 'stream=nb_read_frames', '-print_format', 'json', file],
    { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout || '{}');
    return num(j.streams && j.streams[0] && j.streams[0].nb_read_frames);
  } catch {
    return null;
  }
}

/**
 * @param {string} file 视频路径
 * @returns {{ok:boolean, code:string, [k:string]:any}}
 */
function probe(file, opts = {}) {
  const t0 = Date.now();
  const fail = (code, message, hint) => ({ ok: false, code, message, hint: hint || null, file, tookMs: Date.now() - t0 });

  if (!file) return fail('E_NO_INPUT', '没有传入视频路径', 'node tools/qa.mjs run <video>');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return fail('E_INPUT_MISSING', '文件不存在：' + abs, '确认路径；Windows 下注意中文目录与盘符');
  if (fs.statSync(abs).isDirectory()) return fail('E_INPUT_IS_DIR', '传入的是目录：' + abs, 'batch 子命令接受目录，run 只接受单个文件');
  if (!checkBin()) {
    return fail(
      'E_FFPROBE_MISSING',
      '找不到可执行的 ffprobe（PATH 里没有，或 FFPROBE_BIN 指向错误）',
      '安装 ffmpeg 全量包并把 bin 目录加入 PATH；或 set FFPROBE_BIN=D:\\path\\ffprobe.exe',
    );
  }

  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-show_error', abs];
  const r = spawnSync(FFPROBE, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error && r.error.code === 'ENOENT') {
    return fail('E_FFPROBE_MISSING', '无法启动 ffprobe：' + r.error.message, '检查 PATH / FFPROBE_BIN');
  }
  if (r.error) return fail('E_PROBE_SPAWN', '启动 ffprobe 失败：' + r.error.message, null);
  if (r.status !== 0) {
    return fail('E_PROBE_FAILED', 'ffprobe 非零退出（code=' + r.status + '）', (r.stderr || '').trim().split('\n').slice(-3).join(' | '));
  }

  let j;
  try {
    j = JSON.parse(r.stdout || '{}');
  } catch (e) {
    return fail('E_PROBE_JSON', 'ffprobe 输出不是合法 JSON：' + e.message, null);
  }
  const streams = j.streams || [];
  const vs = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!vs) return fail('E_NO_VIDEO', '文件里没有视频流（可能只有音频/字幕）', '确认素材；gif/apng 也算视频流，检查容器');

  // 旋转：手机竖拍常见 side_data rotation=90，显示宽高要交换，否则"分辨率"是错的
  let rotation = 0;
  for (const sd of vs.side_data_list || []) {
    if (sd.rotation !== undefined && sd.rotation !== null) rotation = Math.round(Number(sd.rotation)) || 0;
  }
  const swap = Math.abs(rotation) === 90 || Math.abs(rotation) === 270;

  const fps = parseRate(vs.r_frame_rate) || parseRate(vs.avg_frame_rate) || 0;
  const avgFps = parseRate(vs.avg_frame_rate) || fps;
  const duration = num(vs.duration) || num(j.format && j.format.duration) || 0;

  // 帧数三级回退：容器声明 -> 实解计数 -> 时长×帧率（标注来源，避免下游把估算当事实）
  let nbFrames = num(vs.nb_frames);
  let framesSource = 'nb_frames';
  if (!nbFrames || nbFrames <= 0) {
    nbFrames = opts.countFrames === false ? null : countFrames(abs);
    framesSource = 'nb_read_frames';
  }
  if (!nbFrames || nbFrames <= 0) {
    nbFrames = fps > 0 && duration > 0 ? Math.round(fps * duration) : 0;
    framesSource = 'duration*fps';
  }

  const as = streams.find((s) => s.codec_type === 'audio');
  const video = {
    index: vs.index,
    codec: str(vs.codec_name),
    profile: str(vs.profile),
    level: num(vs.level),
    width: num(vs.width),
    height: num(vs.height),
    displayWidth: swap ? num(vs.height) : num(vs.width),
    displayHeight: swap ? num(vs.width) : num(vs.height),
    rotation,
    fps,
    avgFps,
    duration,
    nbFrames,
    framesSource,
    bitrate: num(vs.bit_rate),
    pixFmt: str(vs.pix_fmt),
    colorSpace: str(vs.color_space),
    colorRange: str(vs.color_range),
    colorPrimaries: str(vs.color_primaries),
    colorTransfer: str(vs.color_transfer),
    hdr: ['smpte2084', 'arib-std-b67'].includes(str(vs.color_transfer)),
    sampleAspectRatio: str(vs.sample_aspect_ratio),
    displayAspectRatio: str(vs.display_aspect_ratio),
    fieldOrder: str(vs.field_order),
    nbStreams: streams.length,
  };
  const audio = as
    ? {
        index: as.index,
        codec: str(as.codec_name),
        sampleRate: num(as.sample_rate),
        channels: num(as.channels),
        channelLayout: str(as.channel_layout),
        sampleFmt: str(as.sample_fmt),
        bitrate: num(as.bit_rate),
        duration: num(as.duration),
      }
    : null;

  return {
    ok: true,
    code: 'OK',
    file: abs,
    sizeBytes: num(j.format && j.format.size),
    video,
    audio,
    format: {
      name: str(j.format && j.format.format_name),
      longName: str(j.format && j.format.long_name),
      duration: num(j.format && j.format.duration),
      bitrate: num(j.format && j.format.bit_rate),
      proxied: !!(j.format && String(j.format.format_name || '').includes('mov,mp4')),
    },
    meta: { ffprobe: version(), tookMs: Date.now() - t0 },
  };
}

module.exports = { probe, parseRate, version, FFPROBE };

if (require.main === module) {
  const file = process.argv[2];
  const r = probe(file);
  if (!r.ok) {
    console.error(`[probe] ${r.code}: ${r.message}` + (r.hint ? `\n        提示：${r.hint}` : ''));
    process.exit(2);
  }
  const v = r.video;
  console.log(`${path.basename(r.file)}  ${v.displayWidth}x${v.displayHeight} @ ${v.fps}fps · ${v.duration}s · ${v.nbFrames} 帧(${v.framesSource})`);
  console.log(`  codec=${v.codec} ${v.profile || ''} pix=${v.pixFmt} cs=${v.colorSpace} range=${v.colorRange} br=${v.bitrate}`);
  console.log(`  audio=${r.audio ? `${r.audio.codec} ${r.audio.sampleRate}Hz ${r.audio.channels}ch ${r.audio.channelLayout}` : '无'}`);
}