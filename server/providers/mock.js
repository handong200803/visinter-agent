/**
 * providers/mock.js —— mock provider：计时器推 0→100，全链路可跑但不出真片。
 *
 * job.mock=true 由 jobs.js 按 provider.mode 打标，不伪装成真实执行。
 * e2e 渲染桥与 server/selftest 依赖它：没有 GPU/没有 key 的机器也能验收全链路。
 */
'use strict';

const { compileWorkflow } = require('../wf.js');

function createMockProvider(opts = {}) {
  const mockMs = Math.max(200, Number(opts.mockMs || process.env.AVP_MOCK_MS || 3000));
  const registry = opts.registry || null;

  return {
    id: 'mock',
    mode: 'mock',
    mockMs,
    async probe() {
      return { reachable: true, mode: 'mock', detail: { note: '计时器模拟，不出真片；真实出片请设 AVP_PROVIDER=comfy 或 dashscope' } };
    },
    async run(job, { signal, onProgress = () => {} } = {}) {
      const compiled = compileWorkflow(job.valueSnapshot, { registry, template: job.template });
      const steps = 10;
      const stepMs = Math.round(mockMs / steps);
      for (let i = 1; i <= steps; i += 1) {
        await new Promise((r) => setTimeout(r, stepMs));
        if (signal && signal.aborted) throw Object.assign(new Error('已取消'), { code: 'JOB_CANCELED' });
        const percent = Math.round((i / steps) * 100);
        onProgress({ percent, stage: i < steps ? 'sampling' : 'finalizing', mock: true });
      }
      return {
        taskId: 'mock_' + job.id,
        images: [{ node: 'mock', filename: job.id + '.png', subfolder: 'mock', type: 'output', mock: true }],
        meta: { workflowStats: compiled.stats, workflowWarnings: compiled.warnings },
      };
    },
  };
}

module.exports = { createMockProvider };