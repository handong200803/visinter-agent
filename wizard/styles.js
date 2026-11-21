/**
 * wizard/styles.js —— 小白模式唯一的「风格真相源」
 *
 * 为什么单独一个文件：
 *   第一步的 7 张卡片，每张要同时给出「名字 / 缩略图 / 示例描述 / 调色板」。
 *   这四件事必须同源，否则改了名字忘了改示例、改了示例忘了改缩略图，小白就会看到
 *   「二次元」配一句「水墨远山」——那是这类引导页最典型的翻车方式。
 *
 * 三条设计约束：
 *   1. **零外部资源**：缩略图是内联 SVG 字符串，不引任何图片文件。`file://` 双击也能看见。
 *   2. **不解释风格**：只给「看图就懂」的画面，加一个词级别的副标（不是定义句）。
 *   3. **示例是人话**：示例描述必须是普通人能说出口的句子，不允许出现「景深」「体积光」
 *      「赛博」「token」这类词——小白照着念就行。
 *
 * 用法：
 *   Node:  const STYLES = require('./styles.js')           → 数组
 *   浏览器: window.AVPW_STYLES                              → 数组
 *   构建器把本文件原样内联进 wizard/index.html（file:// 下不需要 fetch）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AVPW_STYLES = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ── 缩略图：每个 320×200，画的是「这个风格长什么样」，不是图标 ───────────── */

  function svg(inner, extra) {
    return '<svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true">'
      + (extra || '')
      + inner
      + '</svg>';
  }

  var THUMBS = {
    // 电影感：宽银幕黑边 + 逆光暖金 + 公路剪影
    cinematic: svg(
      '<defs>'
      + '<linearGradient id="cinSky" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#0c1018"/><stop offset=".55" stop-color="#3a2a1c"/>'
      + '<stop offset="1" stop-color="#c9862f"/></linearGradient>'
      + '<radialGradient id="cinSun" cx=".5" cy=".5" r=".5">'
      + '<stop offset="0" stop-color="#ffe6b0" stop-opacity=".95"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>'
      + '</defs>'
      + '<rect width="320" height="200" fill="url(#cinSky)"/>'
      + '<circle cx="164" cy="122" r="62" fill="url(#cinSun)"/>'
      + '<path d="M0 132 L70 126 L150 131 L235 124 L320 130 L320 200 L0 200 Z" fill="#15110d" opacity=".92"/>'
      + '<path d="M104 148 h56 l-6 -10 h-42 z" fill="#07060a"/>'
      + '<rect x="116" y="139" width="30" height="9" rx="3" fill="#0a0a0d"/>'
      + '<circle cx="112" cy="149" r="4" fill="#1c1a17"/><circle cx="152" cy="149" r="4" fill="#1c1a17"/>'
      + '<rect x="188" y="147" width="4" height="16" fill="#0c0b09"/><rect x="186" y="140" width="8" height="7" fill="#0c0b09"/>'
      + '<rect x="0" y="0" width="320" height="17" fill="#040406"/><rect x="0" y="183" width="320" height="17" fill="#040406"/>'
      + '<rect x="0" y="17" width="320" height="1" fill="#ffffff" opacity=".08"/>'
      + '<rect x="0" y="182" width="320" height="1" fill="#ffffff" opacity=".08"/>'
    ),
    // 写实摄影：灰蓝玻璃幕墙 + 浅景深车灯
    photo: svg(
      '<defs><linearGradient id="phBg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#7f8b98"/><stop offset="1" stop-color="#c3cdd6"/></linearGradient>'
      + '<linearGradient id="phGlass" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#4d5f70"/><stop offset=".5" stop-color="#8ea1b2"/><stop offset="1" stop-color="#39485a"/></linearGradient>'
      + '<filter id="phBlur"><feGaussianBlur stdDeviation="4"/></filter></defs>'
      + '<rect width="320" height="200" fill="url(#phBg)"/>'
      + '<rect x="12" y="26" width="132" height="150" fill="url(#phGlass)"/>'
      + '<g stroke="#dbe4ec" stroke-width="1" opacity=".55">'
      + '<path d="M12 62 H144 M12 98 H144 M12 134 H144 M12 168 H144"/>'
      + '<path d="M46 26 V176 M80 26 V176 M112 26 V176"/></g>'
      + '<rect x="12" y="26" width="132" height="150" fill="none" stroke="#eef4f9" stroke-width="1" opacity=".4"/>'
      + '<g filter="url(#phBlur)" opacity=".9">'
      + '<circle cx="196" cy="120" r="17" fill="#fff6dd"/><circle cx="242" cy="138" r="11" fill="#ffe9b8"/>'
      + '<circle cx="286" cy="108" r="8" fill="#f4f7ff"/></g>'
      + '<path d="M0 176 H320 V200 H0 Z" fill="#4a525c"/>'
      + '<path d="M0 176 H320" stroke="#e8eef4" stroke-width="1" opacity=".5"/>'
      + '<circle cx="200" cy="150" r="2.2" fill="#22262b"/><circle cx="232" cy="166" r="2.6" fill="#22262b"/>'
    ),
    // 二次元：粉蓝天空 + 云 + 天台栏杆 + 两个剪影 + 星芒
    anime: svg(
      '<defs><linearGradient id="anSky" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#7fb9ef"/><stop offset=".55" stop-color="#bcd9f7"/>'
      + '<stop offset="1" stop-color="#ffd4c9"/></linearGradient>'
      + '<radialGradient id="anSun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fffdf2"/>'
      + '<stop offset="1" stop-color="#ffe9b8" stop-opacity="0"/></radialGradient></defs>'
      + '<rect width="320" height="200" fill="url(#anSky)"/>'
      + '<circle cx="248" cy="72" r="46" fill="url(#anSun)"/>'
      + '<g fill="#ffffff" opacity=".92">'
      + '<ellipse cx="70" cy="58" rx="34" ry="14"/><ellipse cx="96" cy="50" rx="22" ry="12"/>'
      + '<ellipse cx="222" cy="118" rx="30" ry="11" opacity=".6"/></g>'
      + '<path d="M0 156 H320 V200 H0 Z" fill="#3f4a63"/>'
      + '<g stroke="#dfe9f6" stroke-width="3" opacity=".95">'
      + '<path d="M0 146 H320"/><path d="M26 146 V176 M84 146 V176 M142 146 V176 M200 146 V176 M258 146 V176 M316 146 V176"/></g>'
      + '<g fill="#2b3348">'
      + '<circle cx="132" cy="126" r="9"/><path d="M123 146 q9 -12 18 0 z"/>'
      + '<circle cx="176" cy="130" r="8"/><path d="M168 148 q8 -11 16 0 z"/></g>'
      + '<path d="M244 34 l3 9 9 3 -9 3 -3 9 -3 -9 -9 -3 9 -3 z" fill="#fff" opacity=".9"/>'
    ),
    // 国风古风：宣纸 + 水墨远山 + 红日 + 飞鸟 + 孤舟
    guofeng: svg(
      '<defs><linearGradient id="gfPaper" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#f3ead6"/><stop offset="1" stop-color="#e2d4b8"/></linearGradient>'
      + '<radialGradient id="gfSun" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#c8442e" stop-opacity=".85"/>'
      + '<stop offset="1" stop-color="#c8442e" stop-opacity="0"/></radialGradient></defs>'
      + '<rect width="320" height="200" fill="url(#gfPaper)"/>'
      + '<circle cx="238" cy="58" r="34" fill="url(#gfSun)"/><circle cx="238" cy="58" r="16" fill="#b8402c" opacity=".8"/>'
      + '<path d="M0 118 q40 -34 84 -12 q30 14 60 -2 q34 -18 70 4 q46 30 106 6 V200 H0 Z" fill="#8d9a92" opacity=".55"/>'
      + '<path d="M0 142 q54 -22 96 -2 q40 20 82 2 q48 -20 142 4 V200 H0 Z" fill="#5f6f68" opacity=".6"/>'
      + '<path d="M0 166 q70 -14 128 4 q60 16 192 -2 V200 H0 Z" fill="#39463f" opacity=".55"/>'
      + '<g stroke="#4a4436" stroke-width="1.4" fill="none" opacity=".8">'
      + '<path d="M118 44 q10 -6 20 0"/><path d="M142 54 q8 -5 16 0"/></g>'
      + '<path d="M92 172 q16 8 34 0 q-10 6 -17 8 q-9 -1 -17 -8 z" fill="#2f2a22"/>'
      + '<path d="M104 168 v-14 h1 v14 z" fill="#2f2a22"/><path d="M105 154 l12 -8 -2 9 z" fill="#2f2a22" opacity=".85"/>'
      + '<g stroke="#7d6f56" stroke-width="1" opacity=".5"><path d="M20 22 h280"/></g>'
    ),
    // 赛博朋克：霓虹巷子 + 招牌 + 雨丝
    cyberpunk: svg(
      '<defs><linearGradient id="cpBg" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#160b2a"/><stop offset=".6" stop-color="#2b0f3d"/><stop offset="1" stop-color="#0c0716"/></linearGradient>'
      + '<linearGradient id="cpNeon" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0" stop-color="#ff2d95"/><stop offset="1" stop-color="#22d3ee"/></linearGradient>'
      + '<filter id="cpGlow"><feGaussianBlur stdDeviation="3.4" result="b"/>'
      + '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>'
      + '<rect width="320" height="200" fill="url(#cpBg)"/>'
      + '<path d="M0 200 V54 L86 40 V200 Z" fill="#1b0f2e"/>'
      + '<path d="M320 200 V44 L232 34 V200 Z" fill="#150c26"/>'
      + '<g filter="url(#cpGlow)">'
      + '<rect x="26" y="66" width="10" height="72" rx="2" fill="#ff2d95" opacity=".95"/>'
      + '<rect x="54" y="82" width="6" height="58" rx="2" fill="#22d3ee"/>'
      + '<rect x="262" y="58" width="8" height="84" rx="2" fill="#a855f7"/>'
      + '<rect x="282" y="92" width="6" height="46" rx="2" fill="#f59e0b"/>'
      + '<path d="M120 118 h80" stroke="url(#cpNeon)" stroke-width="5" stroke-linecap="round"/>'
      + '<path d="M112 138 h96" stroke="#22d3ee" stroke-width="2.6" stroke-linecap="round" opacity=".8"/></g>'
      + '<g stroke="#ffffff" stroke-width=".8" opacity=".22">'
      + '<path d="M40 10 l-14 46"/><path d="M96 0 l-12 40"/><path d="M188 6 l-14 44"/><path d="M244 0 l-12 38"/><path d="M300 8 l-14 42"/></g>'
      + '<path d="M0 178 H320 V200 H0 Z" fill="#0a0612"/>'
      + '<path d="M116 178 h92 l-16 -34 h-60 z" fill="#0d0818" opacity=".95"/>'
      + '<g fill="#0a0612"><circle cx="146" cy="164" r="9"/><rect x="142" y="170" width="8" height="22" rx="3"/>'
      + '<circle cx="182" cy="168" r="8"/><rect x="179" y="174" width="7" height="18" rx="3"/></g>'
      + '<g opacity=".18"><rect y="0" width="320" height="2" fill="#fff"/><rect y="8" width="320" height="2" fill="#fff"/>'
      + '<rect y="16" width="320" height="2" fill="#fff"/><rect y="24" width="320" height="2" fill="#fff"/></g>'
    ),
    // 暗黑电影：黑蓝 + 一支蜡烛 + 冷窗光
    dark: svg(
      '<defs><radialGradient id="dkCandle" cx=".5" cy=".5" r=".5">'
      + '<stop offset="0" stop-color="#ffd79a" stop-opacity=".85"/><stop offset=".45" stop-color="#c98a3c" stop-opacity=".22"/>'
      + '<stop offset="1" stop-color="#0a0d14" stop-opacity="0"/></radialGradient>'
      + '<linearGradient id="dkWin" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="#3c4d68"/><stop offset="1" stop-color="#111721"/></linearGradient></defs>'
      + '<rect width="320" height="200" fill="#070910"/>'
      + '<rect x="196" y="26" width="86" height="112" fill="url(#dkWin)" opacity=".8"/>'
      + '<g stroke="#0a0d14" stroke-width="4"><path d="M239 26 V138"/><path d="M196 82 H282"/></g>'
      + '<path d="M282 26 L320 8 V120 L282 138 Z" fill="#141b26" opacity=".55"/>'
      + '<rect x="0" y="164" width="320" height="36" fill="#0b0d13"/>'
      + '<ellipse cx="118" cy="166" rx="86" ry="34" fill="url(#dkCandle)" opacity=".55"/>'
      + '<rect x="110" y="132" width="16" height="34" rx="3" fill="#e8dcc4"/>'
      + '<path d="M118 132 q4 -14 0 -20 q-4 8 0 20" fill="#ffcf7d"/>'
      + '<path d="M118 112 q3 -8 0 -12 q-3 5 0 12" fill="#fff3c4"/>'
      + '<g fill="#0a0d14"><rect x="86" y="150" width="68" height="6" rx="2"/></g>'
      + '<path d="M0 0 H320 V200 H0 Z" fill="none" stroke="#000" stroke-width="18" opacity=".35"/>'
    ),
    // 梦幻仙气：粉紫云雾 + 光尘 + 飘带 + 尖塔
    fantasy: svg(
      '<defs><linearGradient id="fsBg" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="#2a2140"/><stop offset=".45" stop-color="#5b3f74"/>'
      + '<stop offset="1" stop-color="#c98fb6"/></linearGradient>'
      + '<radialGradient id="fsGlow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff0fb" stop-opacity=".95"/>'
      + '<stop offset="1" stop-color="#e8c7ff" stop-opacity="0"/></radialGradient></defs>'
      + '<rect width="320" height="200" fill="url(#fsBg)"/>'
      + '<circle cx="212" cy="70" r="64" fill="url(#fsGlow)" opacity=".8"/>'
      + '<g fill="#f6e8ff" opacity=".35"><ellipse cx="96" cy="150" rx="90" ry="26"/>'
      + '<ellipse cx="236" cy="166" rx="104" ry="22"/></g>'
      + '<path d="M156 168 L166 84 L176 168 Z" fill="#f3e6fb" opacity=".9"/>'
      + '<path d="M166 84 L171 52 L176 84 Z" fill="#ffd9f2" opacity=".95"/>'
      + '<path d="M110 176 q34 -30 74 -14 q30 12 52 -10" stroke="#ffe3f6" stroke-width="2" fill="none" opacity=".7"/>'
      + '<g fill="#fff5ff">'
      + '<circle cx="86" cy="62" r="1.8"/><circle cx="118" cy="42" r="1.3"/><circle cx="64" cy="98" r="1.6"/>'
      + '<circle cx="246" cy="120" r="1.7"/><circle cx="204" cy="46" r="1.2"/><circle cx="282" cy="84" r="1.5"/>'
      + '<circle cx="140" cy="112" r="1.1"/><circle cx="176" cy="30" r="1.4"/></g>'
      + '<circle cx="150" cy="66" r="2.4" fill="#fff" opacity=".9"/>'
    ),
  };

  /* ── 七个风格 ────────────────────────────────────────────────────────────── */

  var STYLES = [
    {
      id: 'cinematic',
      label: '电影感',
      tag: '宽银幕 · 逆光',
      // placeholder 用第一条示例，小白点一下就能直接生成
      examples: [
        '黄昏的公路上，一辆老车开过去，扬起金色的尘土',
        '雨夜的站台，一个人站在灯下等车',
        '海边的悬崖，风把她的头发吹起来',
      ],
      palette: ['#0b0c10', '#3a2a1c', '#c9862f', '#ffe6b0'],
      thumb: THUMBS.cinematic,
    },
    {
      id: 'photo',
      label: '写实摄影',
      tag: '真实光线 · 街景',
      examples: [
        '雨后的城市街道，玻璃楼映着车灯',
        '清晨的菜市场，热气从摊子上冒出来',
        '老房子的窗台，阳光照在积灰的桌面上',
      ],
      palette: ['#7f8b98', '#4d5f70', '#c3cdd6', '#fff6dd'],
      thumb: THUMBS.photo,
    },
    {
      id: 'anime',
      label: '二次元',
      tag: '动画 · 清透',
      examples: [
        '放学后的天台，两个人一起看夕阳',
        '樱花树下，书包放在长椅上',
        '教室窗边，风把窗帘吹起来',
      ],
      palette: ['#7fb9ef', '#bcd9f7', '#ffd4c9', '#3f4a63'],
      thumb: THUMBS.anime,
    },
    {
      id: 'guofeng',
      label: '国风古风',
      tag: '水墨 · 留白',
      examples: [
        '水墨远山，一叶小船从雾里划出来',
        '竹林里，一个人撑着伞慢慢走',
        '雪落在红墙的屋檐上',
      ],
      palette: ['#f3ead6', '#8d9a92', '#b8402c', '#39463f'],
      thumb: THUMBS.guofeng,
    },
    {
      id: 'cyberpunk',
      label: '赛博朋克',
      tag: '霓虹 · 雨夜',
      examples: [
        '霓虹雨夜的巷子，招牌自己在闪',
        '高架桥下的面摊，蒸汽和紫光混在一起',
        '楼顶的天线，远处是全城的灯',
      ],
      palette: ['#160b2a', '#ff2d95', '#22d3ee', '#a855f7'],
      thumb: THUMBS.cyberpunk,
    },
    {
      id: 'dark',
      label: '暗黑电影',
      tag: '低调光 · 悬念',
      examples: [
        '停电的老房子里，只有一支蜡烛在烧',
        '雾里的树林，手电筒照出一道白',
        '空荡的走廊，尽头的门开了一条缝',
      ],
      palette: ['#070910', '#3c4d68', '#c98a3c', '#ffd79a'],
      thumb: THUMBS.dark,
    },
    {
      id: 'fantasy',
      label: '梦幻仙气',
      tag: '云雾 · 光尘',
      examples: [
        '云海上面有一座白塔，光尘慢慢往上飘',
        '湖面上浮着很多灯笼，雾在动',
        '发光的树，叶子一片片亮起来',
      ],
      palette: ['#2a2140', '#5b3f74', '#c98fb6', '#fff0fb'],
      thumb: THUMBS.fantasy,
    },
  ];

  /* ── 进度阶段的唯一文案源（第三步的 5 行） ───────────────────────────────── */
  var STAGES = [
    { key: 'understand', text: '正在理解你的描述…' },
    { key: 'params', text: '正在选择最优参数…' },
    { key: 'draw', text: '正在绘制画面…' },
    { key: 'motion', text: '正在让画面动起来…' },
    { key: 'check', text: '正在检查画面质量…' },
  ];

  /** 第三步的小提示（轮播，不阻塞任何操作） */
  var TIPS = [
    '喝口水，AI 在帮你调 258 个参数',
    '不用写"提示词"，你刚才那句就够',
    '生成好的片子会自动进作品库，不用手动存',
    '不满意就点「换一版」，同一个描述会换个种子重来',
  ];

  function byId(id) {
    for (var i = 0; i < STYLES.length; i += 1) if (STYLES[i].id === id) return STYLES[i];
    return null;
  }

  /** 第一步卡片用的占位提示：该风格的第一条示例 */
  function exampleOf(id) {
    var s = byId(id);
    return s ? s.examples[0] : '';
  }

  return { STYLES: STYLES, STAGES: STAGES, TIPS: TIPS, byId: byId, exampleOf: exampleOf };
});