'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('./quality.js');
const CB = require('./canvasbuilder.js');
const H3 = require('./h3workflow.js');
const { createApp } = require('./app.js');
const root = fs.mkdtempSync(path.join(process.env.CACHE_ROOT || 'D:\\缓存', 'avp', 'quality-policy-test-'));
let count = 0;
function check(name, fn) { fn(); count++; console.log('PASS ' + name); }

async function main() {
  check('四档完整且默认不退回低清', () => {
    assert.deepEqual(Q.tiers().map((t) => [t.width, t.height]), [[1280,720],[1536,864],[1920,1080],[2176,912]]);
    assert.equal(Q.guard({}).resolution.width, 1280);
  });
  check('60fps默认原生30；H3固定24；拒绝原生60', () => {
    assert.equal(Q.fpsPlan({ output_fps: 60 }).native_fps, 30);
    assert.equal(Q.fpsPlan({ engine: 'minimax_h3', output_fps: 60 }).native_fps, 24);
    assert.throws(() => Q.fpsPlan({ native_fps: 60 }), { code: 'QUALITY_BAD_NATIVE_FPS' });
  });
  check('采样范围与默认值', () => {
    const s = Q.sampling({ steps: 4, cfg: 1, denoise: 0.2 });
    assert.deepEqual([s.steps,s.cfg,s.denoise,s.sampler,s.scheduler], [16,7,0.55,'dpmpp_2m','karras']);
    assert.equal(Q.sampling({}).denoise, 0.65);
    assert.throws(() => Q.sampling({ steps: 'NaN' }), { code: 'QUALITY_BAD_SAMPLING' });
  });
  check('显存不足不改参数；turbo 锁 4-8 步', () => {
    const r = Q.guard({ tier: '1080p', usable_mib: 8151, steps: 25 });
    assert.equal(r.ok, false); assert.equal(r.resolution.width, 1920); assert.equal(r.sampling.steps, 25);
    assert.equal(r.vram.provenance, 'estimate');
    // 2026-11-20 规则变更：turbo 是模型设计内的 4-8 步路径，允许；但越界步数必须拒
    assert.equal(Q.guard({ engine: 'minimax_h3', turbo: true, steps: 4, width: 640, height: 384, usable_mib: 8151 }).ok, true);
    let t2 = null;
    try { Q.assertAllowed(Q.guard({ engine: 'minimax_h3', turbo: true, steps: 2, width: 640, height: 384, usable_mib: 8151 })); } catch (e) { t2 = e; }
    assert.equal(t2 && t2.code, 'QUALITY_TURBO_STEPS_OUT_OF_RANGE', 'turbo steps=2 必须被拒');
    assert.throws(() => Q.assertAllowed(Q.guard({ width: -32, height: 512 })), { code: 'QUALITY_BAD_RESOLUTION' });
  });
  check('Wan1080原生30图不缩放，仅裁补齐边缘', () => {
    const graph = CB.executableFor('wan22', { tier: '1080p', frames: 153, output_fps: 60, steps: 25 }).graph;
    assert.equal(graph['7'].inputs.width,1920); assert.equal(graph['7'].inputs.height,1088);
    assert.equal(graph['13'].class_type,'ImageCrop'); assert.equal(graph['13'].inputs.height,1080);
    assert.equal(graph['11'].inputs.fps,30); assert.equal(graph['8'].inputs.steps,25);
    assert.equal(graph['8'].inputs.denoise,0.65);
  });
  check('H3质量图无turbo节点，元数据匹配实际fps', () => {
    const r = H3.build({ tier: '1080p', native_fps: 30, output_fps:60 });
    assert.equal(r.workflow['3'],undefined); assert.deepEqual(r.workflow['9'].inputs.model,['2',0]);
    assert.equal(r.workflow['12'].inputs.fps,24); assert.equal(r.meta.native_fps,24);
    assert.equal(r.workflow['14'].inputs.height,1080);
    assert.throws(() => H3.build({ frames:125 }), { code: 'H3_FRAME_GRID' });
    const turboWf = H3.build({ turbo: true, steps: 4, width: 640, height: 384, seconds: 5, usableMib: 8151 });
    assert.ok(turboWf.workflow['3'], 'turbo 路径必须保留 LoRA 节点');
    assert.deepEqual(turboWf.workflow['9'].inputs.model, ['3', 0]);
    assert.equal(turboWf.workflow['9'].inputs.steps, 4);
    let t3 = null;
    try { H3.build({ turbo: true, steps: 2, width: 640, height: 384, usableMib: 8151 }); } catch (e) { t3 = e; }
    assert.equal(t3 && t3.code, 'QUALITY_TURBO_STEPS_OUT_OF_RANGE', 'H3 turbo steps=2 必须被拒');
  });
  check('现有量化权重可用但标注，仍禁止极速采样', () => {
    const checked = Q.assertWorkflow({ a:{ class_type:'CLIPLoader', inputs:{ clip_name:'test_fp8.safetensors' } } });
    assert.equal(checked.ok,true); assert.equal(checked.warnings[0].code,'QUALITY_EXISTING_QUANTIZED_WEIGHTS');
    // turbo LoRA 允许（需配 4-8 步）；但没有 turbo 权重的 4 步采样仍判违规
    assert.equal(Q.assertWorkflow({ a:{ class_type:'LoraLoaderModelOnly', inputs:{ lora_name:'turbo_4step.safetensors' } } }).ok, true);
    assert.throws(() => Q.assertWorkflow({ a:{ class_type:'KSampler', inputs:{steps:4,cfg:1,denoise:1} } }), { code:'QUALITY_BAD_WORKFLOW_SAMPLING' });
  });
  const submitted = [];
  const jobs = { restore() {}, close: async () => {}, create: async (b) => { submitted.push(b); return { id:'fixture-job',state:'queued',quality:b.quality }; } };
  const gpuProbe = { probe:async () => ({ gpu:{total_mib:8151},usable_mib:8151 }) };
  const svc = createApp({ jobs, gpuProbe, providerId:'mock', restore:false });
  const addr = await svc.listen();
  const post = async (url,b) => { const r = await fetch(`http://127.0.0.1:${addr.port}${url}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); return {status:r.status,json:await r.json()}; };
  const previous = { guard:process.env.AVP_QUALITY_GUARD, clip:process.env.AVP_WAN_CLIP };
  try {
    process.env.AVP_QUALITY_GUARD='0';
    for (const url of ['/api/jobs','/api/h3/run','/api/h3/direct']) {
      const r = await post(url,{engine:'wan22',prompt:'fixture',tier:'1080p',output_fps:60});
      assert.equal(r.status,422); assert.equal(r.json.error.code,'QUALITY_VRAM_INSUFFICIENT'); count++;
    }
    const defaultRequest = await post('/api/jobs',{engine:'wan22',prompt:'fixture'});
    assert.equal(defaultRequest.status,422); assert.equal(defaultRequest.json.error.detail.width,1280);
    assert.equal(submitted.length,0); count++;
    const plan = await post('/api/jobs/plan',{engine:'wan22',prompt:'fixture',tier:'1080p',output_fps:60});
    assert.equal(plan.status,200); assert.equal(plan.json.quality.ok,false);
    assert.equal(plan.json.workflow['11'].inputs.fps,30); assert.equal(plan.json.workflow['13'].inputs.height,1080); count++;
    gpuProbe.probe=async () => ({gpu:{total_mib:65536}});
    process.env.AVP_WAN_CLIP='fixture_unquantized_text_encoder.safetensors';
    const accepted = await post('/api/jobs',{engine:'wan22',prompt:'fixture',tier:'1080p',output_fps:60,steps:25});
    assert.equal(accepted.status,202); assert.equal(submitted.length,1);
    assert.equal(submitted[0].workflow['11'].inputs.fps,30);
    assert.equal(submitted[0].quality.sampling.steps,25);
    assert.equal(submitted[0].values['mo.max_frames'],submitted[0].workflow['7'].inputs.length); count++;
    const fast = await post('/api/jobs',{engine:'minimax_h3',prompt:'fixture',turbo:true,steps:4,width:640,height:384});
    assert.equal(fast.status,202);
    assert.equal(fast.json.quality.sampling.turbo,true);
    assert.equal(fast.json.quality.sampling.steps,4); count++;
    gpuProbe.probe=async () => ({gpu:{total_mib:8151}});
    const custom = await post('/api/jobs',{engine:'minimax_h3',prompt:'fixture',width:640,height:384,frames:124,steps:20,cfg:7,output_fps:24});
    assert.equal(custom.status,202);
    assert.deepEqual(custom.json.quality.resolution,{width:640,height:384,megapixels:640*384/1e6});
    assert.equal(custom.json.quality.sampling.steps,20);
    assert.ok(custom.json.quality.warnings.some(w=>w.code==='QUALITY_EXISTING_QUANTIZED_WEIGHTS')); count++;
    const odd = await post('/api/jobs',{engine:'minimax_h3',prompt:'fixture',width:639,height:384});
    assert.equal(odd.status,422); assert.equal(odd.json.error.code,'QUALITY_BAD_RESOLUTION'); count++;
    console.log(`接口与工作流夹具断言 ${count}项；未调用真实GPU生成`);
  } finally {
    for (const [key,value] of [['AVP_QUALITY_GUARD',previous.guard],['AVP_WAN_CLIP',previous.clip]]) { if(value==null) delete process.env[key]; else process.env[key]=value; }
    await new Promise((resolve) => svc.server.close(resolve));
    fs.rmSync(root,{recursive:true,force:true});
  }
  console.log('全部通过');
}
main().catch((e) => { console.error(e); process.exitCode=1; });
