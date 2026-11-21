#!/usr/bin/env node
// All HTTP traffic is to ephemeral mock servers. Never probe/start the installed backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertNodeVersion, parsePort, parseArguments, probeHealth, runLauncher, SERVICE } from './launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = path.resolve('D:/缓存/avp');
assert.ok(fs.statSync(parent).isDirectory(), 'Authorized fixture parent must already exist');
const temporary = fs.mkdtempSync(path.join(parent, 'launch-selftest-'));
const mocks = [];
const running = new Set();
let passed = 0, unexpectedBrowsers = 0;
function pass(label) { passed++; console.log('PASS ' + label); }

function fixture(name) {
  const root = path.join(temporary, name, 'project with spaces 中文');
  const cache = path.join(temporary, name, 'cache with spaces');
  for (const dir of ['tools', 'app', 'server']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.mkdirSync(path.join(cache, 'avp', 'jobs'), { recursive: true });
  for (const file of ['launch.mjs', 'serve.mjs']) fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(root, 'tools', file));
  for (const file of ['index.html', 'index.src.html']) fs.writeFileSync(path.join(root, 'app', file), '<!doctype html><title>fixture</title>');
  fs.writeFileSync(path.join(root, 'server', 'app.js'), MOCK_APP);
  fs.writeFileSync(path.join(root, 'tools', 'test-entry.mjs'), TEST_ENTRY);
  const env = { ...process.env, NODE_OPTIONS: '', CACHE_ROOT: cache, AVP_ENV_FILE: path.join(cache, 'absent.env'), HOST: '127.0.0.1', PORT: '24567', PRIVATE_TEST_SECRET: 'never-print-this-test-value' };
  return { root, cache, env, jobs: path.join(cache, 'avp', 'jobs'), record: path.join(cache, 'avp', 'backend.json'), lock: path.join(cache, 'avp', 'jobs', '.worker.lock') };
}

// This is deliberately not server/app.js from the platform: no model/provider/job imports.
const MOCK_APP = `
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
exports.createApp = (options) => {
  if (options.restore !== false) throw new Error('restore must be deferred');
  const dir = path.join(process.env.CACHE_ROOT, 'avp', 'jobs');
  const record = path.join(process.env.CACHE_ROOT, 'avp', 'backend.json');
  const lock = path.join(dir, '.worker.lock');
  fs.mkdirSync(dir, {recursive:true});
  let closing;
  const jobs = {
    restore() {
      fs.writeFileSync(lock, JSON.stringify({pid:process.pid}), {flag:'wx'});
      if (process.env.TEST_RESTORE_FAIL === '1') throw Object.assign(new Error('fixture restore failed'), {code:'TEST_RESTORE_FAIL'});
    },
    stats() { return {dir, concurrency:1}; },
    close() {
      if (closing) return closing;
      const recordDuringClose = fs.existsSync(record);
      closing = new Promise((resolve) => {
        // No referenced timer here: serve.mjs must keep a pending close alive itself.
        setTimeout(() => {
          if (fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock)).pid === process.pid) fs.unlinkSync(lock);
          fs.writeFileSync(path.join(process.env.CACHE_ROOT, 'avp', 'closed-' + process.pid + '.json'), JSON.stringify({recordDuringClose, recordBeforeResolve:fs.existsSync(record), canceled:false}));
          resolve();
        }, 180).unref();
      });
      return closing;
    },
    cancel() { throw new Error('Must never cancel fixture jobs'); }
  };
  const server = http.createServer((req, res) => {
    if (req.url === '/__test_stop') { res.end('stopping'); process.emit('SIGTERM'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ok:true, service:'ai-video-platform/backend', pid:process.pid, project_root:path.resolve(__dirname,'..'), jobs:jobs.stats()}));
  });
  // A fixture-only safety deadline, not a production backend restart/kill.
  setTimeout(() => process.emit('SIGTERM'), 10000).unref();
  return {server, app:{jobs}};
};
`;

const TEST_ENTRY = `
import {runLauncher, probeHealth} from './launch.mjs';
const map = JSON.parse(process.env.TEST_PORT_MAP || '{}');
const probe = (port, timeout) => {
  if (map[port]) return probeHealth(map[port], timeout);
  if (port === 8388 || port === 8418) return Promise.resolve(null);
  return probeHealth(port, timeout);
};
runLauncher({argv:process.argv.slice(2), probe, readyTimeoutMs:2500, probeTimeoutMs:250, pollMs:25})
  .catch(e => {console.error(e.message); process.exitCode=1;});
`;

async function mock(data, status = 200) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', Location: 'http://example.invalid/' });
    res.end(JSON.stringify(typeof data === 'function' ? data(req) : data));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  mocks.push(server);
  return server.address().port;
}
function mappedProbe(mapping) {
  return (port, timeout) => mapping[port] ? probeHealth(mapping[port], timeout) : Promise.resolve(null);
}
function options(f, extra = {}) {
  const messages = [];
  return {
    root: f.root, env: f.env, argv: ['--no-open'], log: (s) => messages.push(s), messages,
    probe: mappedProbe({}),
    start: async () => { throw new Error('Unexpected scheduler start'); },
    open: async () => { unexpectedBrowsers++; throw new Error('Unexpected browser launch'); },
    ...extra,
  };
}
function tree(dir) {
  const out = {};
  const walk = (folder) => {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name);
      if (item.isDirectory()) walk(file);
      else out[path.relative(dir, file)] = fs.readFileSync(file).toString('base64');
    }
  };
  walk(dir);
  return out;
}
async function runChild(f, entry = 'test-entry.mjs', argv = [], extra = {}) {
  const child = spawn(process.execPath, [path.join(f.root, 'tools', entry), ...argv], { cwd: temporary, env: { ...f.env, ...extra }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.ok(!stdout.includes(f.env.PRIVATE_TEST_SECRET) && !stderr.includes(f.env.PRIVATE_TEST_SECRET), 'No secret environment value printed');
  return { code, stdout, stderr, pid: child.pid };
}
async function waitFor(check, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (check()) return; await delay(25); }
  assert.fail(message);
}
async function stopFixture(f, port) {
  await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/__test_stop`, { agent: false }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.setTimeout(1000, () => { req.destroy(); resolve(); });
  });
  await waitFor(() => !fs.existsSync(f.lock), 'Fixture shutdown did not finish');
  running.delete(f);
}
async function unusedPort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  assert.ok(port !== 8388 && port !== 8418);
  return port;
}

try {
  assert.throws(() => assertNodeVersion('21.9.0'), /Node.js >= 22/);
  assert.doesNotThrow(() => assertNodeVersion('22.0.0'));
  for (const p of ['', '0', '-1', '65536', '8388x', '1.5', '1e3', '0x20', 'http://host', ' 8418 ']) assert.throws(() => parsePort(p), /PORT/);
  assert.equal(parsePort(), 8388);
  assert.equal(parsePort('65535'), 65535);
  assert.deepEqual(parseArguments(['--dry-run', '--no-open']), { noOpen: true, dryRun: true, help: false });
  pass('Node >=22 and strict numeric PORT validation');

  const f = fixture('discovery');
  const legacyPort = await mock({ ok: true, service: SERVICE, pid: process.pid, jobs: { dir: f.jobs } });
  const legacy = options(f, { probe: mappedProbe({ 8418: legacyPort }) });
  const beforeLegacy = tree(f.cache);
  const reused = await runLauncher(legacy);
  assert.equal(reused.action, 'reuse');
  assert.equal(reused.url, 'http://127.0.0.1:8418/app/index.html');
  assert.match(legacy.messages.join('\n'), /server root unreported/);
  assert.deepEqual(tree(f.cache), beforeLegacy);
  pass('Legacy 8418 reused without restarting, writing or claiming a source root');

  let opened;
  const readyOpen = options(f, { argv: [], probe: mappedProbe({ 8418: legacyPort }), open: async (port) => { opened = port; } });
  await runLauncher(readyOpen);
  assert.equal(opened, 8418);
  pass('Browser receives only the discovered ready port');

  const samePort = await mock({ ok: true, service: SERVICE, pid: process.pid, project_root: f.root, port: 'https://evil.invalid', jobs: { dir: f.jobs } });
  const preferred = await runLauncher(options(f, { probe: mappedProbe({ 8388: legacyPort, 8418: samePort }) }));
  assert.equal(preferred.port, 8418);
  assert.equal(preferred.url, 'http://127.0.0.1:8418/app/index.html');
  pass('Same-root preferred; response-supplied port/host cannot redirect the browser');

  const foreign = path.join(temporary, 'another copy');
  const foreignPort = await mock({ service: SERVICE, pid: process.pid, project_root: foreign, jobs: { dir: f.jobs } });
  const other = options(f, { probe: mappedProbe({ 8418: foreignPort }) });
  assert.equal((await runLauncher(other)).action, 'reuse');
  assert.match(other.messages.join('\n'), /OTHER PROJECT ROOT/);
  assert.match(other.messages.join('\n'), /SAME task store/);
  assert.match(other.messages.join('\n'), /Selected copy was NOT started/);
  pass('Other-root shared task store reported explicitly; no second scheduler');

  for (const data of [
    { service: 'unrelated/http-service', pid: process.pid },
    { service: SERVICE, pid: String(process.pid) },
    { service: SERVICE, pid: 2147483647 },
    { service: SERVICE, pid: process.pid, project_root: 'relative/root' },
    { service: SERVICE, pid: process.pid, project_root: f.root, jobs: { dir: path.join(temporary, 'different store') } },
  ]) {
    const port = await mock(data);
    const result = await runLauncher(options(f, { argv: ['--dry-run', '--no-open'], probe: mappedProbe({ 8388: port }) }));
    assert.equal(result.action, 'would-start');
  }
  const redirectPort = await mock({ service: SERVICE, pid: process.pid }, 302);
  assert.equal(await probeHealth(redirectPort), null);
  pass('Other HTTP services, invalid/dead PIDs, different stores and redirects ignored');

  fs.writeFileSync(f.record, JSON.stringify({ pid: 2147483647, port: 24568, project_root: foreign, host: 'example.invalid' }));
  const staleBefore = tree(f.cache);
  const stale = options(f, { argv: ['--dry-run', '--no-open'] });
  assert.equal((await runLauncher(stale)).action, 'would-start');
  assert.match(stale.messages.join('\n'), /stale\/unusable/);
  assert.deepEqual(tree(f.cache), staleBefore);
  fs.writeFileSync(f.record, '{broken');
  assert.equal((await runLauncher(options(f, { argv: ['--dry-run', '--no-open'] }))).action, 'would-start');
  pass('Stale/corrupt runtime records ignored without mutation or remote host requests');

  fs.writeFileSync(f.lock, JSON.stringify({ pid: process.pid, token: 'must-not-touch' }));
  const locked = tree(f.cache);
  await assert.rejects(runLauncher(options(f)), /JOB_WORKER_ACTIVE: existing backend PID/);
  assert.deepEqual(tree(f.cache), locked);
  fs.writeFileSync(f.lock, '{unknown-owner');
  await assert.rejects(runLauncher(options(f)), /Worker lock owner is unreadable/);
  assert.equal(fs.readFileSync(f.lock, 'utf8'), '{unknown-owner');
  fs.unlinkSync(f.lock); // Only this isolated fixture lock, never a real worker lock.
  pass('Active/ambiguous locks stop launch and remain byte-for-byte untouched');

  const dry = fixture('dry-run');
  const dryPort = await mock({ service: SERVICE, pid: process.pid, jobs: { dir: dry.jobs } });
  dry.env.PORT = String(await unusedPort());
  const dryBefore = tree(path.dirname(dry.root));
  const dryRun = await runChild(dry, 'test-entry.mjs', ['--dry-run', '--no-open'], { TEST_PORT_MAP: JSON.stringify({ 8418: dryPort }) });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /Dry run: discovered http:\/\/127\.0\.0\.1:8418/);
  assert.deepEqual(tree(path.dirname(dry.root)), dryBefore);
  const emptyDry = await runChild(dry, 'test-entry.mjs', ['--dry-run', '--no-open'], { TEST_PORT_MAP: '{}' });
  assert.equal(emptyDry.code, 0, emptyDry.stderr);
  assert.match(emptyDry.stdout, /would start/);
  assert.deepEqual(tree(path.dirname(dry.root)), dryBefore);
  pass('Spawned dry-run --no-open discovery is read-only (legacy and absent endpoints)');

  const missing = fixture('missing');
  fs.unlinkSync(path.join(missing.root, 'app', 'index.html'));
  await assert.rejects(runLauncher(options(missing)), /Missing or empty built entry.*build_all/);
  fs.writeFileSync(path.join(missing.root, 'app', 'index.html'), 'fixture');
  fs.unlinkSync(path.join(missing.root, 'server', 'app.js'));
  await assert.rejects(runLauncher(options(missing)), /Missing or empty source entry.*backup/);
  pass('Missing source/built entry has an actionable package/rebuild error');

  const started = fixture('detached startup');
  const port = await unusedPort();
  started.env.PORT = String(port);
  for (const name of ['serve.log', 'serve.err.log']) fs.writeFileSync(path.join(started.cache, 'avp', name), 'existing-log\n');
  running.add(started);
  const launched = await runChild(started, 'test-entry.mjs', ['--no-open']);
  assert.equal(launched.code, 0, launched.stderr);
  assert.match(launched.stdout, new RegExp(`Ready: http://127.0.0.1:${port}/app/index.html`));
  const record = JSON.parse(fs.readFileSync(started.record));
  assert.equal(record.port, port);
  assert.equal(record.project_root, started.root);
  assert.notEqual(record.pid, launched.pid);
  assert.equal((await probeHealth(port)).pid, record.pid);
  for (const name of ['serve.log', 'serve.err.log']) assert.ok(fs.readFileSync(path.join(started.cache, 'avp', name), 'utf8').startsWith('existing-log\n'));
  const second = await runChild(started, 'test-entry.mjs', ['--no-open'], { PORT: String(await unusedPort()) });
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /Reusing same-root/);
  assert.match(second.stdout, new RegExp(`:${port}/app/index.html`));
  assert.equal(JSON.parse(fs.readFileSync(started.record)).pid, record.pid);
  pass('Detached stub startup, append logs, own-PID readiness, nondefault runtime port and spaced paths');
  await stopFixture(started, port);
  await waitFor(() => !fs.existsSync(started.record), 'Own runtime record was not removed');
  const closed = JSON.parse(fs.readFileSync(path.join(started.cache, 'avp', `closed-${record.pid}.json`)));
  assert.equal(closed.recordDuringClose, true);
  assert.equal(closed.recordBeforeResolve, true);
  assert.equal(closed.canceled, false);
  pass('Runtime record retained until jobs.close completes; shutdown does not cancel work');

  const preserved = fixture('preserve foreign record');
  preserved.env.PORT = String(await unusedPort());
  running.add(preserved);
  const own = await runChild(preserved, 'test-entry.mjs', ['--no-open']);
  assert.equal(own.code, 0, own.stderr);
  const foreignRecord = JSON.stringify({ pid: process.pid, port: 8418, project_root: foreign });
  fs.writeFileSync(preserved.record, foreignRecord);
  await stopFixture(preserved, Number(preserved.env.PORT));
  assert.equal(fs.readFileSync(preserved.record, 'utf8'), foreignRecord);
  pass('Shutdown never removes another process runtime record');

  const busy = fixture('bind failure');
  const busyPort = await mock({ service: 'occupied-fixture', pid: process.pid });
  busy.env.PORT = String(busyPort);
  fs.writeFileSync(busy.record, foreignRecord);
  const failed = await runChild(busy, 'serve.mjs');
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /EADDRINUSE/);
  assert.ok(fs.existsSync(path.join(busy.cache, 'avp', `closed-${failed.pid}.json`)));
  assert.ok(!fs.existsSync(busy.lock));
  assert.equal(fs.readFileSync(busy.record, 'utf8'), foreignRecord);
  pass('Bind failure closes own jobs; referenced close wait survives otherwise idle event loop');

  const restore = fixture('restore failure');
  restore.env.PORT = String(await unusedPort());
  const restoreFail = await runChild(restore, 'serve.mjs', [], { TEST_RESTORE_FAIL: '1' });
  assert.equal(restoreFail.code, 1);
  assert.match(restoreFail.stderr, /TEST_RESTORE_FAIL/);
  assert.ok(!fs.existsSync(restore.lock));
  assert.ok(fs.existsSync(path.join(restore.cache, 'avp', `closed-${restoreFail.pid}.json`)));
  pass('Failure after lock acquisition still closes own scheduler cleanly');

  const failedLaunch = fixture('launcher child failure');
  failedLaunch.env.PORT = String(await unusedPort());
  const childFailure = await runChild(failedLaunch, 'test-entry.mjs', ['--no-open'], { TEST_RESTORE_FAIL: '1' });
  assert.equal(childFailure.code, 1);
  assert.match(childFailure.stderr, /before readiness|before the deadline/);
  assert.ok(!childFailure.stdout.includes('Ready:'));
  assert.ok(!fs.existsSync(failedLaunch.lock));
  assert.ok(!fs.existsSync(failedLaunch.record));
  assert.match(fs.readFileSync(path.join(failedLaunch.cache, 'avp', 'serve.err.log'), 'utf8'), /TEST_RESTORE_FAIL/);
  pass('Failed child startup cannot briefly advertise readiness while closing');

  const wrong = fixture('wrong pid readiness');
  const wrongPid = options(wrong, {
    argv: [], readyTimeoutMs: 80, pollMs: 10,
    start: async () => ({ pid: 123456, exited: false, logs: ['fixture.log'] }),
    alive: () => true,
    probe: async () => null,
  });
  // A closure switches health only after discovery so no existing service is reused.
  let spawned = false;
  wrongPid.start = async () => { spawned = true; return { pid: 123456, exited: false, logs: ['fixture.log'] }; };
  wrongPid.probe = async () => spawned ? { service: SERVICE, pid: process.pid } : null;
  await assert.rejects(runLauncher(wrongPid), /did not become healthy before the deadline/);
  pass('Unrelated healthy PID cannot satisfy startup readiness or trigger browser opening');

  const cmd = fs.readFileSync(path.join(ROOT, '启动平台.cmd'));
  assert.ok([...cmd].every((b) => b < 128));
  assert.match(cmd.toString(), /node "%~dp0tools\\launch\.mjs" %\*/);
  assert.ok(!/8388|8418|tools\\serve\.mjs|powershell|start ""/i.test(cmd.toString()));
  assert.match(cmd.toString(), /Node\.js 22/);
  pass('ASCII .cmd routes arguments only to the relative Node launcher, without fixed-port startup');

  assert.equal(unexpectedBrowsers, 0, 'No browser attempt during no-open, dry-run or failed readiness');
  console.log(`PASS ${passed} · FAIL 0`);
  console.log('全部通过');
} finally {
  for (const f of running) await stopFixture(f, Number(f.env.PORT));
  for (const server of mocks) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(temporary, { recursive: true, force: true });
}
