'use strict';

// The apps' live channels (src/live.js) on a real server: who may open one,
// one per app, and ending when the sign-in no longer holds.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');
const configMod = require('../src/config');
const { connect } = require('../testing/liveClient');

process.env.FLOW_SERVER_FFMPEG = 'off';

async function withServer(fn, { password, livePingMs } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-live-test-'));
  const dirs = { home: path.join(root, 'home'), music: path.join(root, 'music') };
  if (password) configMod.open(dirs).set({ password: configMod.passwordEntry(password) });
  const server = await startServer({
    ...dirs, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, livePingMs,
  });
  try {
    await fn({ server, base: `http://127.0.0.1:${server.port}` });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const signIn = async (base, password, client, device = 'PC') => (await (await fetch(`${base}/api/login`, {
  method: 'POST', body: JSON.stringify({ password, device, client }),
})).json()).token;

test('an app opens its live channel and is greeted; a second one of the same app replaces it', async () => {
  await withServer(async ({ server, base }) => {
    assert.ok((await (await fetch(`${base}/api/hello`)).json()).features.includes('sessions'));
    assert.equal((await connect(base, null)).status, 400, 'no id, no channel');
    assert.equal((await connect(base, 'x y')).status, 400);

    const first = await connect(base, 'app-one-1234', { device: 'Ceeser - Headphones' });
    assert.equal(first.status, 200);
    const hello = await first.next('hello');
    assert.equal(hello.client, 'app-one-1234');
    assert.ok(Math.abs(hello.serverTime - Date.now()) < 5000);
    assert.deepEqual(server.live.clients().map((c) => [c.client, c.device]), [['app-one-1234', 'Ceeser - Headphones']]);

    const other = await connect(base, 'app-two-1234');
    await other.next('hello');
    assert.equal(server.live.clients().length, 2);
    assert.ok(server.live.send('app-two-1234', 'test', { n: 1 }));
    assert.deepEqual(await other.next('test'), { n: 1 });
    assert.equal(server.live.send('nobody-1234', 'test', {}), false);

    const again = await connect(base, 'app-one-1234');
    await again.next('hello');
    assert.deepEqual(await first.next('end'), { reason: 'replaced' });
    assert.equal(server.live.clients().length, 2);

    // Gone when the app goes.
    again.close();
    other.close();
    for (let i = 0; i < 50 && server.live.clients().length; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.equal(server.live.clients().length, 0);
  });
});

test('with a password: only a signed-in app, only its own channel, and it ends with the sign-in', async () => {
  await withServer(async ({ server, base }) => {
    assert.equal((await connect(base, 'app-one-1234')).status, 401);
    const token = await signIn(base, '4711', 'app-one-1234');
    assert.equal((await connect(base, 'app-two-1234', { token })).status, 403, 'another app\'s id');
    const live = await connect(base, 'app-one-1234', { token });
    assert.equal(live.status, 200);
    await live.next('hello');
    // A new password signs every device out: the channel ends at the next ping.
    server.config.set({ password: configMod.passwordEntry('0815'), tokens: [] });
    assert.deepEqual(await live.next('end', 2000), { reason: 'auth' });
    assert.equal(server.live.clients().length, 0);
  }, { password: '4711', livePingMs: 200 });
});

test('pings keep the channel open, and the profile signed in to is known', async () => {
  await withServer(async ({ server, base }) => {
    const made = await (await fetch(`${base}/api/profiles`, { method: 'POST', body: JSON.stringify({ name: 'Anna', device: 'PC', client: 'app-one-1234' }) })).json();
    const live = await connect(base, 'app-one-1234', { token: made.token });
    await live.next('hello');
    const [c] = server.live.clients();
    assert.equal(c.profileName, 'Anna');
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(live.ended, false);
    assert.equal(server.live.clients().length, 1);
    live.close();
  }, { livePingMs: 100 });
});

test('the doctor\'s probe: a second event a second later, then the end', async () => {
  await withServer(async ({ base }) => {
    const live = await connect(base, 'flow-server-doctor', { probe: true });
    await live.next('hello');
    const t = Date.now();
    await live.next('probe', 3000);
    assert.ok(Date.now() - t > 700);
  });
});
