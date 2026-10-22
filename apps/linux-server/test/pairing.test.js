'use strict';

// Sharing a server by QR code (4.0): a pairing code for the password, once.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');
const configMod = require('../src/config');
const { createPairing } = require('../src/pairing');

process.env.FLOW_SERVER_FFMPEG = 'off';

async function post(base, route, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json() };
}

test('a pairing code gives the password once, within 10 minutes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-pair-test-'));
  const home = path.join(root, 'home');
  configMod.open({ home, music: path.join(root, 'music') }).set({ password: configMod.passwordEntry('Secret12') });
  const server = await startServer({
    home, music: path.join(root, 'music'), port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const hello = await (await fetch(`${base}/api/hello`)).json();
    assert.ok(hello.features.includes('pair'));
    assert.equal((await post(base, '/api/pair', { password: 'Secret12' })).status, 401, 'only for a signed-in app');
    const { token } = (await post(base, '/api/login', { password: 'Secret12', device: 'pc' })).json;
    assert.equal((await post(base, '/api/pair', { password: 'wrong' }, token)).status, 403);
    const made = await post(base, '/api/pair', { password: 'Secret12' }, token);
    assert.equal(made.status, 200);
    assert.match(made.json.code, /^[A-Z2-9]{10}$/);
    assert.equal(made.json.expiresIn, 600);
    // No token needed to trade it, and it works once.
    const got = await post(base, '/api/pair/redeem', { code: made.json.code.toLowerCase() });
    assert.deepEqual(got.json, { password: 'Secret12' });
    const again = await post(base, '/api/pair/redeem', { code: made.json.code });
    assert.equal(again.status, 404);
    assert.match(again.json.error, /used already/);
    // Nothing kept on disk.
    assert.ok(!fs.readFileSync(path.join(home, 'server.json'), 'utf8').includes(made.json.code));
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('codes run out after 10 minutes; no more than 20 open', () => {
  let t = 0;
  const p = createPairing({ now: () => t });
  const a = p.create('pw');
  t += 10 * 60 * 1000;
  assert.equal(p.redeem(a), null);
  const codes = Array.from({ length: 25 }, () => p.create('pw'));
  assert.equal(p.redeem(codes[0]), null, 'the oldest went');
  assert.equal(p.redeem(codes[24]), 'pw');
});
