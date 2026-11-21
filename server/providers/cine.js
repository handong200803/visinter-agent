/**
 * providers/cine.js —— 一句话电影（job.kind==='cine'）
 *
 * 2026-11-20 变更（用户重点要求）：云端计费管线（qwen-image + wan2.2 i2v）仍然下线，
 * 但不再「直接 failed」——改为**本地免费回退**：
 *   一句话 → 本地 MiniMax H3 文生视频（音画同步，一条短片）→ 归档进作品库。
 * 本地没有图像模型，所以跳过「关键帧候选 → 选帧 → i2v」这三步，cineReport 里如实写明。
 *
 * 诚实边界：
 *   - 不扣费、不假装云端可用；返回 report.mode='local-t2v'。
 *   - 本地 ComfyUI/H3 不可达时才抛 CINE_CLOUD_RETIRED（保留原错误码，历史任务读得出）。
 *   - 仍不静默改投云：AVP_ALLOW_CLOUD=1 也不会真的打云（云通道已删），只在 hint 里说明。
 */
'use strict';

const H3 = require('../h3workflow.js');
const Q = require('../quality.js');

const RETIRED = {
  code: 'CINE_CLOUD_RETIRED',
  message: '一句话电影的云端管线（qwen-image + wan2.2 i2v，按量计费）已下线，且本地 ComfyUI/H3 当前不可用',
  hint: '先起本地 ComfyUI（bash tools/comfy_start.sh）并确认 node tools/h3.mjs check 为 MEASURED；本地可用时会自动走 H3 文生视频，不产生费用。',
};

const LOCAL_DEFAULTS = {
  width: Number(process.env.AVP_CINE_WIDTH || 640),
  height: Number(process.env.AVP_CINE_HEIGHT || 384),
  seconds: Number(process.env.AVP_CINE_SECONDS || 5),
  outputFps: Number(process.env.AVP_CINE_OUTPUT_FPS || 60),
};

async function waitDone(promptId, { signal, onProgress, limitMs = 60 * 60 * 1000 } = {}) {
  const t0 = Date.now();
  let lastStage = null;
  for (;;) {
    if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { code: 'JOB_CANCELED' });
    if (Date.now() - t0 > limitMs) throw Object.assign(new Error('本地生成超时'), { code: 'COMFY_TIMEOUT' });
    const st = await H3.status(promptId);
    if (st.done) return st;
    // H3 没有细粒度进度时，用"已等待秒数"当阶段文本，避免前端看起来卡死
    const stage = 'sampling';
    if (stage !== lastStage) {
      lastStage = stage;
      if (onProgress) onProgress({ percent: null, stage, text: `本地 H3 生成中（已 ${Math.round((Date.now() - t0) / 1000)}s）` });
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
}

function createCineProvider(opts = {}) {
  const probeComfy = opts.probeComfy || (async () => {
    try {
      const r = await fetch(String(process.env.COMFY_URL || 'http://127.0.0.1:8188') + '/system_stats', { signal: AbortSignal.timeout(4000) });
      return r.ok;
    } catch { return false; }
  });

  return {
    id: 'cine',
    mode: 'local-fallback',
    retired: false,

    async probe() {
      const comfy = await probeComfy();
      return {
        reachable: comfy,
        mode: 'local-fallback',
        detail: {
          cloud: { available: false, code: RETIRED.code, reason: 'paid-video-models-removed' },
          local: {
            available: comfy,
            engine: 'minimax_h3',
            size: `${LOCAL_DEFAULTS.width}×${LOCAL_DEFAULTS.height}`,
            seconds: LOCAL_DEFAULTS.seconds,
            output_fps: LOCAL_DEFAULTS.outputFps,
            note: comfy ? '一句话 → 本地 H3 文生视频（跳过关键帧选择）' : '本地 ComfyUI 不可达，cine 任务会失败并给出启动命令',
          },
        },
      };
    },

    async run(job, ctx = {}) {
      // AVP_CINE_LOCAL=0：回到「只拒绝」的语义（selftest / 明确不想跑本地时用）
      if (process.env.AVP_CINE_LOCAL === '0') {
        const e0 = new Error(RETIRED.message);
        e0.code = RETIRED.code;
        e0.hint = RETIRED.hint;
        e0.detail = { retired: true, reason: 'AVP_CINE_LOCAL=0' };
        throw e0;
      }
      const comfyOk = await probeComfy();
      if (!comfyOk) {
        const e = new Error(RETIRED.message);
        e.code = RETIRED.code;
        e.hint = RETIRED.hint;
        e.detail = { retired: true, reason: 'cloud-removed-and-local-unreachable' };
        throw e;
      }

      const sentence = String(job.cinePrompt || job.prompt || job.note || '').trim();
      if (!sentence) {
        const e = new Error('一句话电影缺少描述文本（cinePrompt 为空）');
        e.code = 'CINE_NO_PROMPT';
        e.hint = '在「一句话电影」里填一句话描述再提交';
        throw e;
      }

      // 质量优先准入：本地默认尺寸走 custom（不进档位），显存不足就拒绝而不是降档
      const quality = Q.guard({
        engine: 'minimax_h3',
        width: LOCAL_DEFAULTS.width,
        height: LOCAL_DEFAULTS.height,
        frames: H3.snapFrames(LOCAL_DEFAULTS.seconds).frames,
        usable_mib: job.__usableMib || null,
        output_fps: LOCAL_DEFAULTS.outputFps,
      });
      if (!quality.ok) {
        const first = quality.errors[0];
        const e = new Error(first.message);
        e.code = first.code;
        e.detail = first.detail;
        e.hint = '本地 cine 也遵守质量优先：显存不足不会自动降档';
        throw e;
      }

      const built = H3.build({
        prompt: sentence,
        width: LOCAL_DEFAULTS.width,
        height: LOCAL_DEFAULTS.height,
        seconds: LOCAL_DEFAULTS.seconds,
        seed: job.seed,
        fps: quality.fps.native_fps,
      });

      if (ctx.onProgress) ctx.onProgress({ percent: 1, stage: 'submitting', text: '提交本地 H3' });
      const sub = await H3.run({
        prompt: sentence,
        width: LOCAL_DEFAULTS.width,
        height: LOCAL_DEFAULTS.height,
        seconds: LOCAL_DEFAULTS.seconds,
        seed: job.seed,
        fps: quality.fps.native_fps,
      });
      if (!sub.ok) {
        const e = new Error('本地 H3 提交失败：' + JSON.stringify(sub.error).slice(0, 200));
        e.code = 'COMFY_SUBMIT_FAILED';
        e.hint = '确认 ComfyUI 已起且 H3 权重齐（node tools/h3.mjs check）';
        throw e;
      }
      if (ctx.onSubmitted) {
        ctx.onSubmitted({
          taskId: sub.prompt_id,
          meta: {
            localComfy: true,
            workflowStats: { nodes: Object.keys(built.workflow).length },
            cineReport: {
              mode: 'local-t2v',
              engine: 'minimax_h3',
              skipped: ['keyframe-candidates', 'frame-pick', 'image-to-video'],
              reason: '本地无图像模型，一句话直接转文生视频',
              sentence,
              size: `${LOCAL_DEFAULTS.width}×${LOCAL_DEFAULTS.height}`,
              seconds: LOCAL_DEFAULTS.seconds,
              native_fps: quality.fps.native_fps,
              output_fps: quality.fps.output_fps,
            },
          },
        });
      }

      const done = await waitDone(sub.prompt_id, { signal: ctx.signal, onProgress: ctx.onProgress });
      if (done.state !== 'success') {
        const e = new Error('本地 H3 执行失败：' + done.state);
        e.code = 'COMFY_EXEC_FAILED';
        e.detail = { status: done.status || null };
        throw e;
      }
      const images = (done.images || []).filter((im) => /\.(mp4|webm|mov)$/i.test(im.filename || ''));
      return {
        taskId: sub.prompt_id,
        images,
        meta: {
          localComfy: true,
          workflowStats: { nodes: Object.keys(built.workflow).length },
          cineReport: {
            mode: 'local-t2v',
            engine: 'minimax_h3',
            skipped: ['keyframe-candidates', 'frame-pick', 'image-to-video'],
            reason: '本地无图像模型，一句话直接转文生视频',
            sentence,
            size: `${LOCAL_DEFAULTS.width}×${LOCAL_DEFAULTS.height}`,
            seconds: LOCAL_DEFAULTS.seconds,
            native_fps: quality.fps.native_fps,
            output_fps: quality.fps.output_fps,
          },
        },
      };
    },

    async cancel() {
      return { remote: false, reason: '本地 cine 由任务取消按钮中断（不涉及云端）' };
    },
  };
}

module.exports = { createCineProvider, RETIRED, LOCAL_DEFAULTS };
