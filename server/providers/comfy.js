/**
 * providers/comfy.js —— 可恢复的本地 ComfyUI provider（零第三方依赖）。
 * 提交前由同步 onCheckpoint 固化 workflow/UUID；不确定的提交只对账，不自动重投。
 * 网络错误原样交给调度层延后恢复，不静默转 mock。
 */
'use strict';

const { randomUUID } = require('node:crypto');
const { createComfy, ComfyError } = require('../comfy.js');
const { compileWorkflow } = require('../wf.js');

function checkSignal(signal) {
  if (!signal || !signal.aborted) return;
  if (signal.reason && signal.reason.code === 'JOB_DETACHED') throw signal.reason;
  throw Object.assign(new Error('已取消'), { code: 'JOB_CANCELED' });
}

function createComfyProvider(opts = {}) {
  const comfy = opts.comfy || createComfy({ base: opts.comfyUrl || opts.base });
  const registry = opts.registry || null;

  return {
    id: 'comfy',
    mode: 'real',
    comfy,
    async probe() {
      const p = await comfy.ping({ force: true });
      return { reachable: p.ok, mode: 'real', detail: p.detail };
    },
    async run(job, { signal, onProgress = () => {}, onSubmitted = () => {}, onCheckpoint = () => {} } = {}) {
      checkSignal(signal);
      let submission = job.comfySubmission;
      let promptId = job.comfyPromptId || job.providerTaskId ||
        (submission && submission.phase === 'submitted' && submission.promptId);
      let meta = { workflowStats: job.workflowStats || null, workflowWarnings: job.workflowWarnings || [] };

      // 先同步持久化，再更新内存；持久化抛错时绝不能发送 POST。
      const checkpoint = (patch) => { onCheckpoint(patch); Object.assign(job, patch); };
      const submitted = (id) => {
        submission = { promptId: id, clientId: submission.clientId, phase: 'submitted' };
        meta = { ...meta, comfySubmission: submission };
        onSubmitted({ taskId: id, meta });
        Object.assign(job, { comfySubmission: submission, comfyPromptId: id, providerTaskId: id });
        promptId = id;
      };

      if (!promptId) {
        if (!submission) {
          // 先编译/复制一次，再生成 ID；恢复时不再绑定参数或随机化 seed。
          let compiled;
          if (job.workflow && typeof job.workflow === 'object') {
            compiled = {
              workflow: JSON.parse(JSON.stringify(job.workflow)),
              stats: { applied: 0, bound: 0, unbound: 0, direct: true },
              warnings: [{ code: 'WF_DIRECT', text: '工作流直传，未经 wf.js 槽位绑定' }],
            };
          } else {
            compiled = compileWorkflow({ ...job.valueSnapshot }, { registry, template: job.template });
            if (compiled.synthetic) {
              throw Object.assign(new Error('没有传入可执行模板，仅生成了合成工作流，未投递 ComfyUI'), {
                code: 'WF_SYNTHETIC_TEMPLATE', detail: { stats: compiled.stats, unbound: compiled.unbound.length },
              });
            }
          }
          const checked = require('../quality.js').assertWorkflow(compiled.workflow);
          compiled.warnings = [...(compiled.warnings || []), ...checked.warnings];
          submission = { promptId: randomUUID(), clientId: 'avp-' + job.id, phase: 'prepared' };
          meta = { workflowStats: compiled.stats, workflowWarnings: compiled.warnings };
          checkpoint({ workflow: compiled.workflow, comfySubmission: submission });
        }

        if (!submission.promptId || !submission.clientId || !['prepared', 'submitting'].includes(submission.phase)) {
          throw new ComfyError('COMFY_SUBMISSION_UNCERTAIN', '提交检查点不完整，不能安全重新提交', { submission });
        }
        if (submission.phase === 'submitting') {
          // POST 超时/进程退出后只能查同一个 UUID。空队列后二次 history 防完成切换竞态。
          const id = submission.promptId;
          let found = await comfy.history(id, { signal });
          if (!found) {
            const q = await comfy.queue({ signal });
            found = ['queue_running', 'queue_pending'].some((key) =>
              Array.isArray(q && q[key]) && q[key].some((item) => Array.isArray(item) && item[1] === id));
            if (!found) found = await comfy.history(id, { signal });
          }
          checkSignal(signal);
          if (!found) throw new ComfyError('COMFY_SUBMISSION_UNCERTAIN', `无法确认任务 ${id} 是否已提交，未重新投递`, { prompt_id: id });
          submitted(id);
        } else {
          if (!job.workflow || typeof job.workflow !== 'object') {
            throw Object.assign(new Error('prepared 检查点缺少固定工作流，不能重新编译后投递'), { code: 'WF_BAD_TEMPLATE' });
          }
          require('../quality.js').assertWorkflow(job.workflow);
          // 已知离线时保留 prepared，恢复在线后仍可安全提交。
          const alive = await comfy.ping({ force: true });
          checkSignal(signal);
          if (!alive.ok) {
            const d = alive.detail || {};
            throw new ComfyError(d.code || 'COMFY_UNREACHABLE', d.message || `ComfyUI 不可达：${comfy.base}`, d.detail || d);
          }
          submission = { ...submission, phase: 'submitting' };
          checkpoint({ comfySubmission: submission });
          checkSignal(signal);
          // 不给 POST 隐式重试；即使响应丢失，也保留 submitting 供下次 run 对账。
          const { prompt_id } = await comfy.prompt(job.workflow, {
            clientId: submission.clientId,
            promptId: submission.promptId,
            extraData: { avp_task_id: job.id, experiment_id: job.experimentId ?? job.experiment_id ?? null },
          });
          // 必须在检查 detach/cancel 之前保存服务器返回的 ID。
          submitted(prompt_id);
        }
      }

      // confirmed 分支不编译、不探测、不 POST；waitFor 始终经 history/queue 收敛。
      const clientId = (submission && submission.clientId) || 'avp-' + job.id;
      meta = { ...meta, comfySubmission: { promptId, clientId, phase: 'submitted' } };
      checkSignal(signal);
      const res = await comfy.waitFor(promptId, { signal, clientId, onProgress });
      checkSignal(signal);
      if (res.canceled) throw Object.assign(new Error('已取消'), { code: 'JOB_CANCELED' });
      if (!res.ok) {
        if (res.error instanceof Error) throw res.error;
        throw new ComfyError(res.errorCode || 'COMFY_EXEC_ERROR', '执行失败', res.error || {});
      }
      return { taskId: promptId, images: res.images || [], meta };
    },
    async cancel(job) {
      const submission = job && job.comfySubmission;
      const id = job && (job.comfyPromptId || job.providerTaskId || (submission && submission.phase !== 'prepared' && submission.promptId));
      return comfy.cancel(id);
    },
  };
}

module.exports = { createComfyProvider };
