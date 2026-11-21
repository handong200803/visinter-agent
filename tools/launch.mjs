#!/usr/bin/env node
// Discovery is read-only. Only startBackend may create logs or start a scheduler.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVICE = 'ai-video-platform/backend';
const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 2147483647;
const validPort = (port) => Number.isInteger(port) && port >= 1 && port <= 65535;

export function assertNodeVersion(version = process.versions.node) {
  if (Number(version.split('.')[0]) < 22) throw new Error('Node.js >= 22 is required. No npm install is needed.');
}

export function parsePort(value = '8388') {
  if (!/^\d+$/.test(String(value)) || !validPort(Number(value))) {
    throw new Error('PORT must be a numeric integer in 1..65535.');
  }
  return Number(value);
}

export function cachePaths(env = process.env, root = PROJECT_ROOT) {
  const cacheRoot = path.resolve(root, env.CACHE_ROOT || 'D:\\缓存');
  const dir = path.join(cacheRoot, 'avp');
  return { cacheRoot, dir, record: path.join(dir, 'backend.json'), jobs: path.join(dir, 'jobs'), lock: path.join(dir, 'jobs', '.worker.lock') };
}

export function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  const canonical = (p) => {
    try { p = fs.realpathSync(p); } catch { p = path.resolve(p); }
    p = path.normalize(p);
    return process.platform === 'win32' ? p.toLowerCase() : p;
  };
  return canonical(a) === canonical(b);
}

export function processAlive(pid) {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code !== 'ESRCH'; } // Access denied is not evidence of a dead owner.
}

function readJson(file) {
  try { return { exists: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) {
    if (e.code === 'ENOENT') return { exists: false };
    if (e instanceof SyntaxError) return { exists: true, data: null };
    throw new Error(`Cannot read launcher metadata (${e.code || 'IO_ERROR'}): ${file}`);
  }
}

export function assertEntries(root = PROJECT_ROOT) {
  for (const entry of ['tools/serve.mjs', 'server/app.js', 'app/index.src.html', 'app/index.html']) {
    const file = path.join(root, entry);
    let present = false;
    try { present = fs.statSync(file).isFile() && fs.statSync(file).size > 0; } catch {}
    if (!present) {
      const fix = entry === 'app/index.html'
        ? 'Restore the complete source package, then run node tools/build_all.mjs to rebuild the entry.'
        : 'Restore the missing source from the complete package/backup; no npm install is needed.';
      throw new Error(`Missing or empty ${entry === 'app/index.html' ? 'built entry' : 'source entry'}: ${file}. ${fix}`);
    }
  }
}

// Never follow redirects, use proxy environment variables, or trust a host/URL from metadata.
export function probeHealth(port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (data) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(data);
    };
    const req = http.get({ hostname: '127.0.0.1', port: parsePort(port), path: '/api/health', agent: false }, (res) => {
      if (res.statusCode !== 200) { finish(null); res.destroy(); return; }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (text.length > 256 * 1024) { finish(null); res.destroy(); }
      });
      res.on('error', () => finish(null));
      res.on('end', () => {
        try { finish(JSON.parse(text)); } catch { finish(null); }
      });
    });
    const timer = setTimeout(() => { finish(null); req.destroy(); }, timeoutMs);
    req.on('error', () => finish(null));
  });
}

function verifiedHealth(data, alive) {
  return data && data.service === SERVICE && data.ok !== false && validPid(data.pid) && alive(data.pid)
    && (data.project_root == null || (typeof data.project_root === 'string' && path.isAbsolute(data.project_root)));
}

function workerOwner(paths, alive) {
  const lock = readJson(paths.lock);
  if (!lock.exists) return null;
  if (!validPid(lock.data?.pid)) {
    throw new Error(`Worker lock owner is unreadable: ${paths.lock}. Nothing was removed; inspect the existing backend before launching.`);
  }
  return alive(lock.data.pid) ? lock.data.pid : null;
}

function activeWorkerError(pid, paths) {
  return new Error(`JOB_WORKER_ACTIVE: existing backend PID ${pid} owns task store ${paths.jobs}, but its matching local health endpoint was not found. Connect to that backend/check its logs and port. No second scheduler was started; no process or lock was changed.`);
}

export async function discover({ root = PROJECT_ROOT, env = process.env, probe = probeHealth, alive = processAlive, log = console.log, probeTimeoutMs = 6000 } = {}) {
  const port = parsePort(env.PORT);
  const paths = cachePaths(env, root);
  const record = readJson(paths.record);
  const runtime = record.data;
  const usableRecord = validPid(runtime?.pid) && validPort(runtime?.port);
  const ports = [...new Set([...(usableRecord ? [runtime.port] : []), port, 8388, 8418])];
  const results = await Promise.all(ports.map(async (p) => {
    try {
      const health = await probe(p, probeTimeoutMs);
      return verifiedHealth(health, alive) ? { ...health, port: p } : null;
    } catch { return null; }
  }));
  if (record.exists && (!usableRecord || !results.some((r) => r?.port === runtime.port && r.pid === runtime.pid))) {
    log('[avp] Ignoring stale/unusable backend runtime record (left untouched).');
  }
  const owner = workerOwner(paths, alive);
  const candidates = results.filter(Boolean).filter((r) => {
    const jobDir = r.jobs?.dir;
    if (typeof jobDir === 'string' && path.isAbsolute(jobDir) && !samePath(jobDir, paths.jobs)) {
      log(`[avp] Ignoring backend PID ${r.pid} on port ${r.port}: different task store.`);
      return false;
    }
    const related = samePath(jobDir, paths.jobs) || r.pid === owner || (usableRecord && r.pid === runtime.pid && r.port === runtime.port);
    if (r.project_root && !samePath(r.project_root, root) && !related) {
      log(`[avp] Ignoring another project root on port ${r.port}; shared task store is not established.`);
      return false;
    }
    return true;
  });
  const rank = (r) => samePath(r.project_root, root) ? 0 : !r.project_root ? 1 : 2;
  candidates.sort((a, b) => rank(a) - rank(b));
  const selected = owner ? candidates.find((r) => r.pid === owner) : candidates[0];
  if (owner && !selected) throw activeWorkerError(owner, paths);
  return { selected, paths, port };
}

export function parseArguments(argv) {
  for (const arg of argv) {
    if (!['--no-open', '--dry-run', '--help'].includes(arg)) throw new Error(`Unknown launcher argument: ${arg}`);
  }
  return { noOpen: argv.includes('--no-open'), dryRun: argv.includes('--dry-run'), help: argv.includes('--help') };
}

export async function startBackend({ root, env, paths, port }) {
  fs.mkdirSync(paths.dir, { recursive: true });
  const logs = [path.join(paths.dir, 'serve.log'), path.join(paths.dir, 'serve.err.log')];
  const fds = [];
  let child;
  try {
    for (const file of logs) fds.push(fs.openSync(file, 'a'));
    child = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs')], {
      cwd: root, env: { ...env, PORT: String(port), CACHE_ROOT: paths.cacheRoot },
      detached: true, windowsHide: true, stdio: ['ignore', ...fds],
    });
    // Install observers before unref: readiness must belong to this child, not a port squatter.
    const state = { pid: null, exited: false, code: null, logs };
    child.once('exit', (code, signal) => { state.exited = true; state.code = code ?? signal; });
    child.on('error', (e) => { state.exited = true; state.code = e.code || 'SPAWN_FAILED'; });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    state.pid = child.pid;
    child.unref();
    return state;
  } catch (e) {
    throw new Error(`Backend process start failed (${e.code || 'SPAWN_FAILED'}). Logs: ${logs.join(', ')}`);
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
}

export async function openBrowser(port) {
  const url = `http://127.0.0.1:${parsePort(port)}/app/index.html`;
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `start "" "${url}"`] : [url];
  // cmd.exe does not understand the backslash-escaped quotes used by normal Windows argv quoting.
  // The command string contains only a fixed loopback URL and the validated numeric port.
  const child = spawn(command, args, { detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32', stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
}

export async function runLauncher({ argv = [], root = PROJECT_ROOT, env = process.env, log = console.log,
  probe = probeHealth, alive = processAlive, start = startBackend, open = openBrowser,
  readyTimeoutMs = 30000, probeTimeoutMs = 6000, pollMs = 350 } = {}) {
  assertNodeVersion();
  const { noOpen, dryRun, help } = parseArguments(argv);
  if (help) { log('Usage: node tools/launch.mjs [--no-open] [--dry-run]\n--dry-run: read-only discovery; never starts a process, writes logs, or opens a browser.'); return { action: 'help' }; }
  root = path.resolve(root);
  parsePort(env.PORT);
  assertEntries(root);
  const found = await discover({ root, env, probe, alive, log, probeTimeoutMs });
  let endpoint = found.selected;
  let action = 'reuse';
  if (endpoint) {
    if (!endpoint.project_root) {
      log(`[avp] Reusing legacy backend PID ${endpoint.pid}; server root unreported. Selected copy was NOT started: ${root}`);
    } else if (!samePath(endpoint.project_root, root)) {
      log(`[avp] Reusing OTHER PROJECT ROOT: ${endpoint.project_root} (PID ${endpoint.pid}). It serves the SAME task store: ${found.paths.jobs}. Selected copy was NOT started: ${root}`);
    } else {
      log(`[avp] Reusing same-root backend PID ${endpoint.pid}: ${root}`);
    }
  } else if (dryRun) {
    log(`[avp] Dry run: no reusable backend found; would start ${path.join(root, 'tools', 'serve.mjs')} on port ${found.port}. No files or processes changed.`);
    return { action: 'would-start', port: found.port };
  } else {
    // Recheck immediately before spawning; the scheduler's own exclusive lock covers the remaining race.
    const owner = workerOwner(found.paths, alive);
    if (owner) throw activeWorkerError(owner, found.paths);
    const child = await start({ root, env, paths: found.paths, port: found.port });
    log(`[avp] Starting backend PID ${child.pid}. Append logs: ${child.logs.join(', ')}`);
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exited || !alive(child.pid)) break;
      let health;
      try { health = await probe(found.port, Math.min(probeTimeoutMs, Math.max(1, deadline - Date.now()))); } catch {}
      if (verifiedHealth(health, alive) && health.pid === child.pid && (!health.project_root || samePath(health.project_root, root))) {
        endpoint = { ...health, port: found.port };
        break;
      }
      // A referenced timer is intentional: an unref'ed child plus a memory-only promise can exit early.
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    if (!endpoint) {
      throw new Error(`Backend PID ${child.pid} ${child.exited ? `exited (${child.code}) before readiness` : 'did not become healthy before the deadline'}. Logs: ${child.logs.join(', ')}. No process was killed or lock deleted; inspect this backend before retrying.`);
    }
    action = 'started';
  }
  const url = `http://127.0.0.1:${endpoint.port}/app/index.html`;
  log(`[avp] ${dryRun ? 'Dry run: discovered' : 'Ready:'} ${url} (PID ${endpoint.pid})`);
  if (!noOpen && !dryRun) {
    try { await open(endpoint.port); }
    catch { log(`[avp] Browser could not be opened automatically. Open ${url} manually.`); }
  }
  return { action, url, pid: endpoint.pid, port: endpoint.port };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLauncher({ argv: process.argv.slice(2) }).catch((e) => { console.error('[avp] ' + e.message); process.exitCode = 1; });
}
