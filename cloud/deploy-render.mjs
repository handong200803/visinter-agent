/**
 * cloud/deploy-render.mjs —— 用 Render API 一键部署（需要你的 RENDER_API_KEY）
 *
 * 用法：
 *   RENDER_API_KEY=rnd_xxx node cloud/deploy-render.mjs \
 *     --repo https://gitee.com/你的用户名/avp.git \
 *     --origin https://你的站点.qodersite.com \
 *     --ark-key sk-xxx        （可选，用万相则填 --dashscope-key）
 *
 * 做的事：
 *   1. 创建一个 Web Service（Node runtime，零依赖，无需 build）
 *   2. 配环境变量（ALLOW_ORIGIN / ADMIN_TOKEN 自动生成 / DATA_DIR / Key）
 *   3. 挂 1GB 持久盘到 /data（SQLite + 对象文件都在里面）
 *   4. 等部署完成，输出访问地址 + 自检命令
 *
 * 注意：Render 免费实例不支持持久盘；脚本默认 starter。想省钱可加 --free（数据重启即丢）。
 */
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

const KEY = String(process.env.RENDER_API_KEY || '').trim();
const REPO = argOf('--repo', '');
const ORIGIN = argOf('--origin', '*');
const DASHSCOPE = argOf('--dashscope-key', '');
const ARK = argOf('--ark-key', '');
const PLAN = has('--free') ? 'free' : 'starter';
const REGION = argOf('--region', 'singapore');
const NAME = argOf('--name', 'avp-cloud');

if (!KEY) { console.error('缺 RENDER_API_KEY\n  获取：Render Dashboard → Account Settings → API Keys'); process.exit(2); }
if (!REPO) { console.error('缺 --repo（public git 地址，如 https://gitee.com/you/avp.git）'); process.exit(2); }

const API = 'https://api.render.com/v1';
const H = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Accept: 'application/json' };

async function call(method, path, body) {
  const r = await fetch(API + path, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* text */ }
  if (!r.ok) { console.error(`✗ ${method} ${path} → ${r.status}\n${t.slice(0, 500)}`); process.exit(1); }
  return j;
}

async function main() {
  // ADMIN_TOKEN 自动生成（避免用户手填弱口令）
  const ADMIN = 'avp_' + (await import('node:crypto')).randomBytes(16).toString('hex');
  const envVars = [
    { key: 'DATA_DIR', value: '/data' },
    { key: 'ALLOW_ORIGIN', value: ORIGIN },
    { key: 'ADMIN_TOKEN', value: ADMIN },
    { key: 'DEMO_QUOTA', value: '20' },
    { key: 'AVP_VIDEO_PROVIDER', value: 'wanx,seedance' },
    { key: 'AVP_IMAGE_PROVIDER', value: 'wanx,ark' },
  ];
  if (DASHSCOPE) envVars.push({ key: 'DASHSCOPE_API_KEY', value: DASHSCOPE });
  if (ARK) envVars.push({ key: 'ARK_API_KEY', value: ARK });

  console.log('创建服务：' + NAME);
  console.log('  仓库：' + REPO);
  console.log('  计划：' + PLAN + '　区域：' + REGION);
  console.log('  允许来源：' + ORIGIN);

  const body = {
    type: 'web_service',
    name: NAME,
    ownerId: null,          // 先置空，下面自动补
    repo: REPO,
    autoDeploy: 'yes',
    branch: argOf('--branch', 'master'),
    envVars,
    serviceDetails: {
      env: 'node',
      plan: PLAN,
      region: REGION,
      envSpecificDetails: {
        buildCommand: 'echo no-build-needed',
        startCommand: 'node cloud/server.mjs',
      },
      healthCheckPath: '/api/health',
      disk: PLAN === 'free' ? undefined : { name: 'avp-data', mountPath: '/data', sizeGB: 1 },
    },
  };

  // 取 ownerId（API 要求）
  const owners = await call('GET', '/owners?limit=1');
  const ownerId = owners?.[0]?.owner?.id || owners?.[0]?.id;
  if (!ownerId) { console.error('拿不到 ownerId，检查 API Key 权限'); process.exit(1); }
  body.ownerId = ownerId;

  const svc = await call('POST', '/services', body);
  const id = svc?.service?.id || svc?.id;
  const url = svc?.service?.serviceDetails?.url || svc?.serviceDetails?.url || '';
  console.log('\n✓ 服务已创建：' + id);
  console.log('  地址：' + (url || '（部署中，稍后到 Dashboard 查看）'));

  if (svc?.service?.serviceDetails?.url) {
    console.log('\n自检（部署约 2-3 分钟后跑）：');
    console.log(`  node cloud/smoke.mjs ${url} --admin ${ADMIN}`);
    console.log('\n把下面这行保存好（站点注入地址要用）：');
    console.log('  ' + url);
  } else {
    console.log('\n先到 Render Dashboard 看部署进度，拿到地址后跑：');
    console.log('  node cloud/smoke.mjs <你的地址> --admin ' + ADMIN);
  }
  console.log('\nADMIN_TOKEN（务必记下，写接口要用）：');
  console.log('  ' + ADMIN);

}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
