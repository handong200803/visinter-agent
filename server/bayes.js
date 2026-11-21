/**
 * bayes.js —— 带约束多目标贝叶斯寻优（改造规格 §4，答辩核心科研点）
 *
 * 目标函数：F(x) = w1·Sface + w2·Sflow + w3·Sstyle − w4·Sbad（默认 0.35/0.35/0.20/0.10）
 * 做法（全部本地、零依赖、零云端）：
 *   1) 参数标准化到 [0,1]（用注册表上下限/枚举索引），越界截断；
 *   2) 种子点 = 当前最优 Muse 参数；邻域 ±10% 扰动生成 4 组初始样本；
 *   3) GP-RBF 代理 + EI 采集（随机候选池取 argmax），每轮 1 次真实评估；
 *   4) 收敛：连续 patience 轮 EI 增益 < tol 或达到 max_iter，早停并返回最优；
 *   5) 每次评估都写入 dataset（CSV 数据源），可完整复现。
 *
 * 不做的两件事（避免虚假学术包装）：
 *   · 不做「降维暴力网格」——只对注册表里可优化参数搜索；
 *   · 不假装 GP 是万能的——若评估函数本身是代理（无 ComfyUI），结果标 evaluator:'proxy'，
 *     与真机评估（evaluator:'measured'）严格区分，二者不可混在一张收敛图上。
 */
'use strict';

const ENG = require('./engines.js');
const Q = require('./quality.js');

/* ── 数学工具：正态 PDF/CDF（Abramowitz-Stegun 7.1.26）、Cholesky、线性解 ── */
function pdf(z) { return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI); }
function cdf(z) {
  const x = Math.abs(z) / Math.SQRT2; // Phi(z) = (1 + erf(z / sqrt(2))) / 2
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function cholesky(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let s = A[i][j];
      for (let k = 0; k < j; k += 1) s -= L[i][k] * L[j][k];
      if (i === j) L[i][j] = Math.sqrt(Math.max(1e-12, s));
      else L[i][j] = s / L[j][j];
    }
  }
  return L;
}

function solveChol(L, b) {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    let s = b[i];
    for (let k = 0; k < i; k += 1) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    let s = y[i];
    for (let k = i + 1; k < n; k += 1) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

function rbf(a, b, ls) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] - b[i]) ** 2;
  return Math.exp(-s / (2 * ls * ls));
}

/** 把参数空间压到 [0,1] 并给出解码函数。 */
function makeSpace(keys) {
  const dims = keys.map((k) => {
    if (Array.isArray(k.enum) && k.enum.length) return { key: k.key, type: 'enum', enum: k.enum, min: 0, max: k.enum.length - 1, step: 1 };
    const min = k.min != null ? Number(k.min) : 0;
    const max = k.max != null ? Number(k.max) : 1;
    return { key: k.key, type: k.type === 'int' ? 'int' : 'float', min, max, step: k.step || null };
  });
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  return {
    dims,
    encode(values) {
      return dims.map((d) => {
        const v = values[d.key] != null ? values[d.key] : (d.type === 'enum' ? d.enum[0] : d.min);
        if (d.type === 'enum') return clamp01(d.enum.indexOf(v) / Math.max(1, d.enum.length - 1));
        return Number.isFinite(Number(v)) ? clamp01((Number(v) - d.min) / Math.max(1e-9, d.max - d.min)) : 0;
      });
    },
    decode(u) {
      const out = {};
      dims.forEach((d, i) => {
        const t = clamp01(u[i]);
        if (d.type === 'enum') out[d.key] = d.enum[Math.min(d.enum.length - 1, Math.round(t * (d.enum.length - 1)))];
        else {
          let v = d.min + t * (d.max - d.min);
          if (d.type === 'int') v = Math.round(v);
          if (d.step) v = Math.round(v / d.step) * d.step;
          out[d.key] = Math.max(d.min, Math.min(d.max, Number(v.toFixed(6))));
        }
      });
      return out;
    },
  };
}

function gpPredict(X, y, xs, ls, noise = 1e-6) {
  const n = X.length;
  const K = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => rbf(X[i], X[j], ls) + (i === j ? noise : 0)));
  const L = cholesky(K);
  const alpha = solveChol(L, y);
  const mu = [], sigma = [];
  for (const x of xs) {
    const k = X.map((xi) => rbf(xi, x, ls));
    let m = 0;
    for (let i = 0; i < n; i += 1) m += k[i] * alpha[i];
    let v = 1;
    for (let i = 0; i < n; i += 1) v -= k[i] * alpha[i] * 0; // 占位，下面用 L 解
    // 方差：1 - k^T K^-1 k，用 L 两段解构造 K^-1 k
    const w = solveChol(L, k);
    let ktk = 0;
    for (let i = 0; i < n; i += 1) ktk += k[i] * w[i];
    v = Math.max(1e-9, 1 - ktk);
    mu.push(m);
    sigma.push(Math.sqrt(v));
  }
  return { mu, sigma };
}

function maxEI(X, y, bestY, ls, dims, samples = 512, rng = Math.random) {
  const cand = Array.from({ length: samples }, () => Array.from({ length: dims }, () => rng()));
  const { mu, sigma } = gpPredict(X, y, cand, ls);
  let best = null;
  for (let i = 0; i < cand.length; i += 1) {
    const z = (mu[i] - bestY) / Math.max(1e-9, sigma[i]);
    const ei = (mu[i] - bestY) * cdf(z) + sigma[i] * pdf(z);
    if (!best || ei > best.ei) best = { ei, u: cand[i], mu: mu[i], sigma: sigma[i] };
  }
  return best;
}

/** 仅四路质量权重；兼容评分器的 S 名称与既有 w1..4 名称。 */
function qualityWeights(overrides = {}) {
  const defaults = Q.scoringWeights();
  const out = {};
  ['Sface', 'Sflow', 'Sstyle', 'Sbad'].forEach((name, i) => {
    const key = `w${i + 1}`;
    const value = overrides[key] ?? overrides[name] ?? defaults[name];
    if (!Number.isFinite(Number(value)) || Number(value) < 0) throw Object.assign(new Error(`无效质量权重：${name}`), { code: 'BAYES_BAD_WEIGHT' });
    out[key] = Number(value);
  });
  return out;
}

/** 辅助 detail 与耗时不进入目标函数。 */
function objective(scores, weights) {
  const w = qualityWeights(weights || {});
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const F = w.w1 * clamp01(scores.Sface) + w.w2 * clamp01(scores.Sflow) + w.w3 * clamp01(scores.Sstyle) - w.w4 * clamp01(scores.Sbad);
  return Math.max(0, Math.min(1, F));
}

/**
 * 寻优主循环。
 * 权重固定来自 Q.scoringWeights；keys 仅选择白名单维度，不接受调用方范围。
 * @param {{engine?:string, keys?:Array, seedValues?:object, evaluate:Function, maxIter?:number, patience?:number, tol?:number, evaluateKind?:'measured'|'proxy', rng?:Function, apply?:boolean}} o
 */
async function optimize(o = {}) {
  const spec = ENG.loadSpec().bayes;
  const engine = o.engine || 'wan22';
  ENG.get(engine);
  if (typeof o.evaluate !== 'function') throw Object.assign(new Error('贝叶斯寻优需要 evaluate 函数'), { code: 'BAYES_NO_EVALUATOR' });
  const eligible = ENG.optimizableKeys();
  if (o.keys != null && !Array.isArray(o.keys)) throw Object.assign(new Error('keys 必须是质量参数键数组'), { code: 'BAYES_BAD_KEYS' });
  const requested = o.keys == null ? eligible.map((k) => k.key) : o.keys.map((k) => typeof k === 'string' ? k : k && k.key);
  // 调用方只能选白名单中的维度，不能注入类型、枚举、范围或后处理旋钮。
  const keys = eligible.filter((k) => requested.includes(k.key));
  const excludedKeys = requested.filter((key) => !eligible.some((k) => k.key === key));
  if (!keys.length) throw Object.assign(new Error('没有可优化的质量参数；仅允许 ' + eligible.map((k) => k.key).join(', ')), { code: 'BAYES_NO_ELIGIBLE_KEYS', detail: { requested, eligible: eligible.map((k) => k.key) } });
  const seedDoc = ENG.load(engine);
  const seedValues = structuredClone({ ...ENG.defaults(), ...seedDoc.values, ...(o.seedValues || {}) });
  if (!(Number(seedValues['kf.seed']) >= 0)) seedValues['kf.seed'] = Math.floor((o.rng || Math.random)() * 2147483646);
  if (seedValues.seed != null && !(Number(seedValues.seed) >= 0)) seedValues.seed = seedValues['kf.seed'];
  const space = makeSpace(keys);
  const fixedConstraints = Object.fromEntries(Object.entries(seedValues).filter(([key]) => !keys.some((k) => k.key === key)));
  // 固定条件也不能启用降质捷径；拒绝旧快照而非悄悄改写它。
  const sampling = Q.load().sampling;
  const accelerated = new Set(['turbo', 'distill', 'distilled', 'teacache', 'tea_cache', 'sage_attn', 'nunchaku', 'speed_mode', 'lowres_preview']);
  const conflicts = Object.entries(fixedConstraints).filter(([key, value]) => {
    const name = key.split('.').pop().toLowerCase();
    if (accelerated.has(name)) return ![false, null, undefined, 0, '', 'false', 'off', 'none', '0'].includes(value);
    if (['dtype', 'quant', 'weight_dtype'].includes(name)) return /int[48]|fp[48]|awq|gguf/i.test(String(value));
    if (name === 'sampler' || name === 'scheduler') return value !== sampling[name];
    return false;
  });
  if (conflicts.length) throw Object.assign(new Error('固定快照包含不符合质量策略的参数；请显式修正后重试：' + conflicts.map(([key]) => key).join(', ')), { code: 'BAYES_INVALID_FIXED_QUALITY', detail: { conflicts: Object.fromEntries(conflicts) } });
  // 未选中的采样参数也是固定约束，不得在 evaluator 内偷偷夹紧、改变实验条件。
  for (const k of eligible.filter((k) => !keys.some((x) => x.key === k.key))) {
    const value = Number(seedValues[k.key]);
    if (!Number.isFinite(value) || value < k.min || value > k.max) throw Object.assign(new Error(`固定采样参数 ${k.key} 必须在 ${k.min}..${k.max}；请修正快照或将它加入搜索`), { code: 'BAYES_INVALID_FIXED_SAMPLING' });
  }
  const weights = qualityWeights(); // 唯一真源 Q.scoringWeights；不接受速度/第五目标权重。
  const rng = o.rng || Math.random;
  const maxIter = Math.max(1, Number(o.maxIter || spec.search.max_iter));
  const patience = Math.max(1, Number(o.patience || spec.search.converge_patience));
  const tol = Number(o.tol ?? spec.search.converge_tol);
  const evaluateKind = o.evaluateKind || 'measured';

  const X = [], y = [], samples = [];
  const uSeed = space.encode(seedValues);
  const paramsFor = (u) => ({ ...structuredClone(fixedConstraints), ...space.decode(u) });
  const evalU = async (u, source) => {
    const params = paramsFor(u);
    // evaluator 获得完整快照的独立副本，不能通过突变污染下一轮或落盘证据。
    const r = await o.evaluate(structuredClone(params));
    const F = objective(r.scores || r, weights);
    X.push(space.encode(params)); y.push(F);
    samples.push({ round: samples.length, source, params, scores: structuredClone(r.scores || r), F, detail: structuredClone(r.detail || null), evaluator: evaluateKind });
    return F;
  };

  // 1) 种子点 + 邻域 ±10% 扰动 4 组
  let bestF = await evalU(uSeed, 'seed');
  let bestU = uSeed.slice();
  for (let i = 0; i < spec.init.samples; i += 1) {
    const u = uSeed.map((v) => Math.max(0, Math.min(1, v + (rng() * 2 - 1) * spec.init.perturb)));
    const F = await evalU(u, 'init_perturb');
    if (F > bestF) { bestF = F; bestU = u; }
  }

  // 2) GP + EI 迭代
  let stale = 0, converged = false, iter = 0;
  for (; iter < maxIter; iter += 1) {
    const ls = 0.35;
    const { ei, u } = maxEI(X, y, bestF, ls, space.dims.length, 512, rng);
    const F = await evalU(u, 'ei');
    if (F > bestF + 1e-9) { bestF = F; bestU = u; stale = 0; } else stale += 1;
    if (ei < tol && stale >= patience) { converged = true; break; }
    if (stale >= patience + 4) { converged = true; break; }
  }

  const bestParams = paramsFor(bestU);
  const bestTunables = space.decode(bestU);
  // 回填只改搜索维度；返回/落盘的 best.params 始终是完整、可复现的快照。
  const doc = ENG.load(engine);
  let applied = null;
  if (o.apply) {
    doc.values = { ...doc.values, ...bestTunables };
    applied = Object.keys(bestTunables);
  }
  doc.bayes = {
    best: { F: bestF, params: bestParams, evaluator: evaluateKind, at: new Date().toISOString(), weights },
    fixed_constraints: fixedConstraints,
    seed_values: seedValues,
    space: space.dims,
    weights,
    evaluator: evaluateKind,
    dataset: samples,
  };
  ENG.save(engine, doc);

  return {
    engine, converged, iters: Math.min(iter + 1, maxIter), best: { F: bestF, params: bestParams },
    bestF, dataset: samples, weights, evaluator: evaluateKind, applied_keys: applied,
    fixed_constraints: structuredClone(fixedConstraints),
    space: { dims: space.dims.map((d) => d.key), count: space.dims.length, excluded_keys: excludedKeys },
    note: evaluateKind === 'proxy'
      ? '代理评估（无 ComfyUI 时的参数合理性规则），不能与真机评估混同一张收敛图'
      : '真机评估（画布生成 → 四维打分）',
  };
}

module.exports = { optimize, objective, makeSpace, gpPredict, maxEI, cholesky, cdf, pdf };
