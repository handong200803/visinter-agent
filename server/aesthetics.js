/**
 * aesthetics.js —— 抖音氛围感审美层（灰境方案）：题材配方匹配 + 词库拼接 + 分题材参数/调色/声音。
 *
 * 真源 spec/aesthetics.json（8 题材 + 词库）。本模块只做读取/匹配/拼接，不改 258 参数结构。
 * 诚实口径：params 里 sampler/CFG/步数/HD 是请求口径（云端 qwen-image 不暴露 → applicable:false）；
 * 分辨率/画幅真生效；duration>5s 受 i2v 模型上限约束（记录 requested，实际 5s）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'spec', 'aesthetics.json'), 'utf8'));

const themes = () => DATA.themes;
const words = () => DATA.words;
const recipeById = (id) => DATA.themes.find((t) => t.id === id) || null;

/** 中文输入 → 题材匹配（关键词命中计分，最高者；无命中返回 null 不硬套）。 */
function matchTheme(prompt) {
  const s = String(prompt || '');
  let best = null, bestScore = 0;
  for (const t of DATA.themes) {
    const score = t.keywords.reduce((a, k) => a + (s.includes(k) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best ? { theme: best, score: bestScore } : null;
}

/** 拼接到关键帧提示词的氛围后缀：光影+色调+镜头+质感（逐字词库/配方）。 */
function promptSuffix(recipe) {
  if (!recipe) return '';
  return [recipe.light, recipe.color, recipe.lens, recipe.texture].filter(Boolean).join('，');
}
/** 氛围通用负面 + 题材负面。 */
function negativeAdd(recipe) {
  return [DATA.words.negative, recipe && recipe.neg].filter(Boolean).join('，');
}
/** 分题材画质参数（请求口径）。 */
function paramRules(recipe) {
  if (!recipe) return null;
  return { ...recipe.params, ratio: recipe.ratio, durationRequested: recipe.duration, applicable: false, reason: '云端 qwen-image 不暴露 sampler/CFG/步数/HD 旋钮；分辨率/画幅真生效；duration 受 i2v 上限 5s 约束', provenance: 'measured' };
}
/** 声音情绪 → 环境声床配方 key（cine.ambientBedFor 消费）。 */
const soundGrade = (recipe) => (recipe ? recipe.grade : null);

module.exports = { DATA, themes, words, recipeById, matchTheme, promptSuffix, negativeAdd, paramRules, soundGrade };