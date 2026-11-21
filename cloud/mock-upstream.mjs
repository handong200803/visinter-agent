/**
 * cloud/mock-upstream.mjs —— 本地模拟通义万相（DashScope）异步任务 API
 *
 * 目的：在没有真 Key 的情况下，验证"填了 Key 之后"的完整链路是否稳定：
 *   提交 → 异步轮询（PENDING→RUNNING→SUCCEEDED）→ 取 URL → 下载 → 后处理 → 入库
 *
 * 它不是单元测试替身，而是**真的 HTTP 服务**：cloud/server.mjs 通过 DASHSCOPE_API 指向它，
 * 走的是完全相同的 fetch / 轮询 / 解析代码路径。
 *
 * 用法：node cloud/mock-upstream.mjs --port 8899
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(argOf('--port', 8899));
const CLOUD = process.env.CLOUD_ROOT || 'D:\\云盘';

// 素材：真实图片与视频（用于返回"像真的" URL）
const IMG_DIR = path.join(CLOUD, '04-数据', 'keyframes');
const VIDEO_SRC = path.join(CLOUD, '02-视频', '成片', 'exp_mwoy00zb_3bcb66_job_mwoy00zb_3bcb66_pure.mp4');
const KEYFRAME_FALLBACK = [
  path.join(IMG_DIR, 'kolors_1795157834329', 'kf_899452_0.png'),
  path.join(IMG_DIR, 'kolors_1795157834329', 'kf_907371_1.png'),
  path.join(IMG_DIR, 'kolors_1795157834329', 'kf_915290_2.png'),
].filter((f) => fs.existsSync(f));

const tasks = new Map();   // task_id → { kind, polls, created, fail }
let seq = 0;

/** 每个任务需要被轮询几次才成功：2 次（PENDING→RUNNING→SUCCEEDED），模拟真实异步 */
const SUCCEED_AFTER = 2;

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Access-Control-Allow-Origin': '*' });
  res.end(b);
}

function pickImage() {
  if (KEYFRAME_FALLBACK.length) return KEYFRAME_FALLBACK[seq % KEYFRAME_FALLBACK.length];
  return null;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }

  // 静态素材（模拟 OSS 公网 URL）
  if (p.startsWith('/mock-assets/')) {
    const name = path.basename(p);
    const isVideo = /\.mp4$/i.test(name);
    const file = isVideo ? VIDEO_SRC : KEYFRAME_FALLBACK[Number(name.replace(/\D/g, '')) % Math.max(1, KEYFRAME_FALLBACK.length)];
    if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': isVideo ? 'video/mp4' : 'image/png', 'Content-Length': buf.length });
    return res.end(buf);
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* ignore */ }

    // ① 文生图
    if (p === '/api/v1/services/aigc/text2image/image-synthesis' && req.method === 'POST') {
      seq += 1;
      const id = 'img-task-' + seq;
      tasks.set(id, { kind: 'image', polls: 0, idx: seq });
      return json(res, 200, { request_id: 'r' + seq, output: { task_id: id, task_status: 'PENDING' } });
    }

    // ② 视频生成（t2v / i2v）
    if (p === '/api/v1/services/aigc/video-generation/video-synthesis' && req.method === 'POST') {
      seq += 1;
      const id = 'vid-task-' + seq;
      const hasImg = !!(body.input && body.input.img_url);
      tasks.set(id, { kind: 'video', polls: 0, idx: seq, i2v: hasImg });
      // 记录收到的 first_frame，便于断言
      if (hasImg) console.log('[mock] i2v 收到首帧:', String(body.input.img_url).slice(0, 60));
      return json(res, 200, { request_id: 'r' + seq, output: { task_id: id, task_status: 'PENDING' } });
    }

    // ③ 查询任务
    const m = p.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const t = tasks.get(id);
      if (!t) return json(res, 404, { code: 'InvalidParameter', message: 'task not found: ' + id });
      t.polls += 1;
      if (t.polls < SUCCEED_AFTER) {
        return json(res, 200, { output: { task_id: id, task_status: t.polls === 1 ? 'PENDING' : 'RUNNING' } });
      }
      if (t.kind === 'image') {
        return json(res, 200, {
          output: {
            task_id: id, task_status: 'SUCCEEDED',
            results: [{ url: `http://127.0.0.1:${PORT}/mock-assets/img-${t.idx}.png` }],
            usage: { image_count: 1 },
          },
        });
      }
      return json(res, 200, {
        output: {
          task_id: id, task_status: 'SUCCEEDED',
          video_url: `http://127.0.0.1:${PORT}/mock-assets/vid-${t.idx}.mp4`,
          video_duration: 5,
          usage: { video_duration: 5 },
        },
      });
    }

    // ④ 调试端点：当前任务表
    if (p === '/__mock/tasks') return json(res, 200, { count: tasks.size, tasks: [...tasks.entries()] });

    json(res, 404, { code: 'NotFound', message: 'unknown path ' + p });
  });
});

server.listen(PORT, () => {
  console.log(`[mock-wanx] listening :${PORT}`);
  console.log(`[mock-wanx] 素材: 图片 ${KEYFRAME_FALLBACK.length} 张 / 视频 ${fs.existsSync(VIDEO_SRC) ? '有' : '缺'}`);
  console.log(`[mock-wanx] 用法: DASHSCOPE_API=http://127.0.0.1:${PORT} DASHSCOPE_API_KEY=mock node cloud/server.mjs`);
});
