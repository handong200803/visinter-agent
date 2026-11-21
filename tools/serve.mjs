#!/usr/bin/env node
// Direct backend entry. Double-click startup goes through launch.mjs discovery first.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, assertEntries, cachePaths, parsePort, samePath } from './launch.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  assertNodeVersion();
  assertEntries(ROOT);
  // Preserve existing local provider settings; never log the file or its values.
  // The launcher itself never reads secrets. Explicit process environment wins.
  const envFile = process.env.AVP_ENV_FILE || path.join(cachePaths(process.env, ROOT).dir, 'keys.env');
  try {
    for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch { /* No local keys: retain the existing provider selection behavior. */ }

  const port = parsePort(process.env.PORT);
  const host = process.env.HOST || '127.0.0.1';
  const paths = cachePaths(process.env, ROOT);
  process.env.CACHE_ROOT = paths.cacheRoot;
  const started = Date.now();
  let svc, address, shutdownPromise;
  const record = () => ({ pid: process.pid, port: address.port, project_root: ROOT });
  const removeOwnRecord = () => {
    if (!address) return;
    try {
      const current = JSON.parse(fs.readFileSync(paths.record, 'utf8'));
      if (current.pid === process.pid && current.port === address.port && samePath(current.project_root, ROOT)) fs.unlinkSync(paths.record);
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
  };
  const closeHttp = () => new Promise((resolve) => {
    if (!svc?.server.listening) { resolve(); return; }
    svc.server.close(resolve);
    svc.server.closeAllConnections(); // Local HTTP/SSE only, never the ComfyUI queue.
  });
  const shutdown = (code = 0) => {
    if (shutdownPromise) return shutdownPromise;
    // jobs.close may wait on postprocessing whose promise alone cannot keep Node alive.
    const keepAlive = setInterval(() => {}, 1000);
    shutdownPromise = (async () => {
      // Stop accepting health/submit requests immediately, including failed-startup windows.
      const httpClosed = closeHttp();
      try {
        if (svc) await svc.app.jobs.close(); // Detach observation; do not cancel ComfyUI.
        removeOwnRecord(); // Only after our jobs have finished saving and released their lock.
      } catch (e) {
        code = 1;
        console.error(`[avp] Saving shutdown state failed (${e.code || 'CLOSE_FAILED'}); runtime record retained.`);
      } finally {
        try { await httpClosed; }
        finally {
          clearInterval(keepAlive);
          process.exitCode = code;
        }
      }
    })();
    return shutdownPromise;
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(`[avp] ${signal}: saving tasks and detaching observation; ComfyUI is NOT canceled.`);
      console.log('[avp] Waiting for active postprocessing; queued work remains available for recovery.');
      void shutdown();
    });
  }

  try {
    const { createApp } = require(path.join(ROOT, 'server', 'app.js'));
    // Retain a handle before restore can acquire a worker lock or throw.
    svc = createApp({ restore: false });
    address = await new Promise((resolve, reject) => {
      const failed = (e) => reject(e);
      svc.server.once('error', failed);
      svc.server.listen(port, host, () => {
        svc.server.off('error', failed);
        resolve(svc.server.address());
      });
    });
    if (shutdownPromise) { await shutdownPromise; await closeHttp(); return; }
    svc.server.on('error', (e) => {
      console.error(`[avp] Backend HTTP failure (${e.code || 'SERVER_ERROR'}).`);
      void shutdown(1);
    });
    // Binding failure must not begin restoring/scheduling persisted jobs.
    svc.app.jobs.restore();
    fs.mkdirSync(paths.dir, { recursive: true });
    const temporary = path.join(paths.dir, `.backend-${process.pid}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(record()) + '\n', { encoding: 'utf8', flush: true });
      fs.renameSync(temporary, paths.record);
    } finally {
      try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const counts = svc.app.jobs.stats();
    console.log(`[avp] Backend PID ${process.pid} listening on port ${address.port}`);
    console.log(`[avp] Platform http://127.0.0.1:${address.port}/app/index.html`);
    console.log(`[avp] Project root ${ROOT}`);
    console.log(`[avp] Task store ${counts.dir}; concurrency ${counts.concurrency}; startup ${Date.now() - started}ms`);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') console.error('[avp] Missing backend source/dependency. Restore the complete package/backup; no npm install is needed.');
    else if (e.code === 'JOB_WORKER_ACTIVE') console.error('[avp] JOB_WORKER_ACTIVE: another backend owns this task store. Use tools/launch.mjs to discover it. No process or lock was removed.');
    else console.error(`[avp] Backend startup failed (${e.code || 'START_FAILED'}). Check PORT/HOST, package entries and cache access.`);
    await shutdown(1);
  }
}

main().catch((e) => { console.error('[avp] ' + e.message); process.exitCode = 1; });
