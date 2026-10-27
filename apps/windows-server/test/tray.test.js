'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const tray = require('../tray/compile');

// Compiled once with Windows' own C# compiler; only --status and --quit are run
// (the icon itself would show in the notification area).
const windows = process.platform === 'win32';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-tray-'));
const exe = path.join(dir, 'Flow Server Tray.exe');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Names of its own: a --quit here must never close the icon of the real server on this PC.
const exitCode = (args, env) => new Promise((resolve, reject) => {
  const p = spawn(exe, args, { env: { ...process.env, FLOW_SERVER_TRAY_ID: `-test-${process.pid}`, ...env }, windowsHide: true });
  p.on('error', reject);
  p.on('exit', resolve);
});

/** A home whose server.json has this port. */
function home(port) {
  const h = fs.mkdtempSync(path.join(dir, 'home-'));
  fs.writeFileSync(path.join(h, 'server.json'), JSON.stringify({ port }, null, 2));
  return h;
}

test('the tray icon compiles, with Flow Server as its name', { skip: !windows }, () => {
  tray.compile(exe, path.join(__dirname, '..', '..', 'desktop', 'build', 'icon.ico'));
  assert.ok(fs.statSync(exe).size > 10000);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.cs')), 'its version file is gone again');
});

test('--status: 0 while a Flow Server answers at the port in server.json, else 1', { skip: !windows }, async () => {
  let body = JSON.stringify({ app: 'flow-server', name: 'Test' });
  const server = http.createServer((req, res) => {
    res.end(req.url === '/api/hello' ? body : '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.strictEqual(await exitCode(['--status'], { FLOW_SERVER_HOME: home(port) }), 0);
    body = JSON.stringify({ app: 'something-else' });
    assert.strictEqual(await exitCode(['--status'], { FLOW_SERVER_HOME: home(port) }), 1, 'not a Flow Server');
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.strictEqual(await exitCode(['--status'], { FLOW_SERVER_HOME: home(port) }), 1, 'nothing at the port');
});

test('--quit without an icon running ends at once', { skip: !windows }, async () => {
  assert.strictEqual(await exitCode(['--quit'], {}), 0);
});
