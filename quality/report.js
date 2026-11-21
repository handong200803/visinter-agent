'use strict';
/**
 * quality/report.js —— 把逐帧断言汇总成可读结论
 *
 * 输出结构（inspector/index.html 直接吃 frames[]，其余给人看）：
 *   { probe, summary:{frames, problem_frames, p5, p95, mean, worst:[...]}, frames[], ... }
 *
 * 为什么 p5 而不是 minimum：
 *   单帧极值可能来自转场/编码抖动，p5 才是"最差的那 5%"的真实水平；
 *   两者都保留（worst 列表给单帧，p5 给整体）。
 *
 * 三档阈值来源（见 docs/06-quality.md）：
 *   80 / 65 直接沿用 inspector/index.html:286 的前端判定，避免"后台说 ok、前端标红"两套口径。
 */
const path = require('node:path');

const DEFECT_CN = { dark: '黑帧', white: '白帧', blur: '模糊', freeze: '卡帧', flicker: '亮度跳变' };

/** 线性插值百分位（p 取 0..100） */
function percentile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  if (a.length === 1) return a[0];
  const pos = ((a.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(a.length - 1, lo + 1);
  return Math.round((a[lo] + (a[hi] - a[lo]) * (pos - lo)) * 10) / 10;
}

/** 为什么这帧该重绘：把指标翻成人话，带实测数字 */
function explain(f, prevFrozen) {
  const reasons = [];
  if (f.defect === 'dark') reasons.push(`整帧接近全黑（YAVG=${f.extra.yavg}）`);
  if (f.defect === 'white') reasons.push(`整帧接近全白（YAVG=${f.extra.yavg}）`);
  if (f.defect === 'blur') reasons.push(`拉普拉斯方差 ${f.extra.lapVar}（低于清晰基线），细节已丢失`);
  if (f.defect === 'freeze') reasons.push('与前序帧完全相同，画面停止变化');
  if (f.defect === 'flicker' || f.flicker >= 20) reasons.push(`亮度跳变 ${f.flicker} 级（相邻帧 YAVG 差）`);
  if (!reasons.length && f.score < 80) reasons.push(`综合分 ${f.score}（锐度 ${f.sharp} / 闪烁 ${f.flicker}）`);
  return reasons;
}

function suggestion(f) {
  if (f.defect === 'dark' || f.defect === 'white') return '整帧重绘：这一帧等于空镜头/过曝，通常是采样或解码失败';
  if (f.defect === 'freeze') return '重绘该帧并补运动：复制帧不能用作关键帧';
  if (f.defect === 'blur') return '重绘该帧（或框选细节区）：锐度不足，放大即穿帮';
  if (f.defect === 'flicker') return '检查前后帧亮度/曝光是否一致，必要时重绘该帧';
  return '整帧重绘或框选问题区域';
}

/** 连续问题帧合并成段（同一缺陷才算一段），给"重绘多少个镜头"用 */
function segments(frames) {
  const out = [];
  let cur = null;
  for (const f of frames) {
    const bad = f.status !== 'ok';
    if (!bad) { cur = null; continue; }
    if (cur && cur.defect === f.defect && f.frame === cur.end + 1) {
      cur.end = f.frame;
      cur.scores.push(f.score);
      continue;
    }
    cur = { start: f.frame, end: f.frame, defect: f.defect || 'low_score', scores: [f.score] };
    out.push(cur);
  }
  return out.map((s) => ({
    start: s.start,
    end: s.end,
    frames: s.end - s.start + 1,
    defect: s.defect,
    defect_cn: DEFECT_CN[s.defect] || '低分',
    score_avg: Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length),
  }));
}

/**
 * @param {object} probeResult quality/probe.js 的返回
 * @param {object} analysis quality/frames.js 的返回
 * @param {object} opts { worstN=10 }
 */
function build(probeResult, analysis, opts = {}) {
  const worstN = opts.worstN || 10;
  const frames = analysis.frames;
  const scores = frames.map((f) => f.score);
  const status = { ok: 0, warn: 0, bad: 0 };
  for (const f of frames) status[f.status] += 1;

  const problems = frames.filter((f) => f.status !== 'ok');
  const worst = [...frames]
    .sort((a, b) => a.score - b.score || a.frame - b.frame)
    .slice(0, worstN)
    .map((f) => ({
      frame: f.frame,
      score: f.score,
      status: f.status,
      defect: f.defect,
      defect_cn: DEFECT_CN[f.defect] || null,
      yavg: f.extra.yavg,
      lapVar: f.extra.lapVar,
      flicker: f.flicker,
      reasons: explain(f),
      suggestion: suggestion(f),
    }));

  return {
    tool: 'avp-qc',
    schema: 'quality.json/1',
    generated_at: new Date().toISOString(),
    video: path.basename(analysis.file),
    probe: probeResult || null,
    analysis: analysis.analysis,
    detect: analysis.detect,
    thresholds: analysis.thresholds,
    summary: {
      frames: frames.length,
      problem_frames: problems.length,
      p5: percentile(scores, 5),
      p95: percentile(scores, 95),
      mean: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10,
      min: percentile(scores, 0),
      max: percentile(scores, 100),
      status,
      segments: segments(frames),
      worst,
      redraw_plan: (opts.redrawN ? worst.slice(0, opts.redrawN) : worst).map((w) => ({
        frame: w.frame,
        reason: w.reasons.join('；'),
        suggestion: w.suggestion,
      })),
    },
    frames,
    timing: analysis.timing,
  };
}

module.exports = { build, percentile, segments, explain };