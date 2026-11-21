import fs from 'node:fs';
const BASE = 'http://127.0.0.1:8188';
const wfPath = process.env.H3_WF || new URL('../templates/h3_t2v_min.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const wf = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
const clientId = 'dsh-h3-' + Date.now();

const r = await fetch(BASE + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: clientId }) });
const j = await r.json();
console.log('SUBMIT', r.status, JSON.stringify(j).slice(0, 400));
if (!j.prompt_id) process.exit(1);
const id = j.prompt_id;

const t0 = Date.now();
for (let i = 0; i < 270; i += 1) {
  await new Promise((res) => setTimeout(res, 10000));
  const h = await (await fetch(BASE + '/history/' + id)).json();
  const q = await (await fetch(BASE + '/queue')).json();
  const running = (q.queue_running || []).map((x) => x[1]);
  const pending = (q.queue_pending || []).map((x) => x[1]);
  const el = Math.round((Date.now() - t0) / 1000);
  if (h[id]) {
    const st = h[id].status || {};
    const imgs = [];
    for (const o of Object.values(h[id].outputs || {})) for (const im of o.images || []) imgs.push(im);
    console.log('DONE', el + 's', 'status=' + (st.status_str || 'unknown'), 'outputs=' + imgs.length, JSON.stringify(imgs).slice(0, 300));
    if (st.status_str === 'error') console.log('ERRMSG', JSON.stringify(st).slice(0, 800));
    process.exit(0);
  }
  if (i % 3 === 0) console.log('WAIT', el + 's', 'running=' + (running.includes(id) ? 'yes' : 'no'), 'pending=' + (pending.includes(id) ? 'yes' : 'no'), 'q=' + running.length + '/' + pending.length);
}
console.log('TIMEOUT 45min');
process.exit(2);
