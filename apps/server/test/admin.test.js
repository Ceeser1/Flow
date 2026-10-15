'use strict';

// Administration (3.5): admins and the master admin, what the server keeps
// about each profile, and the admins' routes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');
const configMod = require('../src/config');

process.env.FLOW_SERVER_FFMPEG = 'off';

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-admin-test-'));
  return { root, home: path.join(root, 'home'), music: path.join(root, 'music') };
}

async function withServer(fn) {
  const dirs = tempDirs();
  const server = await startServer({
    home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await fn({ server, base, dirs });
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

async function post(base, route, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: r.status, json: await r.json() };
}

async function get(base, route, token) {
  const r = await fetch(`${base}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, json: r.status === 204 ? null : await r.json() };
}

/** server.json written as an older server left it. */
function oldConfig(home, raw) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'server.json'), JSON.stringify(raw));
  return configMod.open({ home, music: path.join(home, '..', 'music') });
}

test('a server from before 3.5: its oldest profile becomes an admin, once', () => {
  const dirs = tempDirs();
  try {
    const c = oldConfig(dirs.home, {
      profiles: [
        { id: 'ben', name: 'Ben', createdAt: 300 },
        { id: 'anna', name: 'Anna', createdAt: 100 },
        { id: 'carla', name: 'Carla', createdAt: 200 },
      ],
    });
    assert.deepEqual(c.get().profiles.map((p) => [p.id, p.admin]), [['ben', false], ['anna', true], ['carla', false]]);
    assert.equal(c.get().adminSeeded, true);
    assert.equal(c.get().profiles.find((p) => p.id === 'anna').lastSeenAt, 0);
    assert.equal(c.get().profiles.find((p) => p.id === 'anna').createdIp, '');
    // Taken away: not made again.
    c.set({ profiles: c.get().profiles.map((p) => ({ ...p, admin: false })) });
    const again = configMod.open({ home: dirs.home, music: dirs.music });
    assert.deepEqual(again.get().profiles.map((p) => p.admin), [false, false, false]);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('one master, who is an admin and cannot be disabled; addresses kept newest first', () => {
  const dirs = tempDirs();
  try {
    const ips = [];
    for (let i = 0; i < 120; i += 1) ips.push({ ip: `192.168.1.${i}`, device: 'Phone', at: i });
    const c = oldConfig(dirs.home, {
      adminSeeded: true,
      profileCreation: 'nonsense',
      songDelete: 'owner',
      profiles: [
        { id: 'anna', name: 'Anna', createdAt: 1, master: true, disabled: true, ips: [...ips, { ip: '::ffff:10.0.0.1', device: 'PC', at: 500 }, { ip: 'not an ip', at: 9 }] },
        { id: 'ben', name: 'Ben', createdAt: 2, master: true, createdIp: '::FFFF:192.168.1.7' },
      ],
    });
    const [anna, ben] = c.get().profiles;
    assert.deepEqual([anna.master, anna.admin, anna.disabled], [true, true, false]);
    assert.deepEqual([ben.master, ben.admin], [false, false]);
    assert.equal(ben.createdIp, '192.168.1.7');
    assert.equal(anna.ips.length, configMod.MAX_IPS);
    assert.deepEqual(anna.ips[0], { ip: '10.0.0.1', device: 'PC', at: 500 });
    assert.equal(anna.ips[1].at, 119);
    assert.equal(c.get().profileCreation, 'anyone');
    assert.equal(c.get().songDelete, 'owner');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('the first profile made in an app is an admin; the apps are told who is', async () => {
  await withServer(async ({ base }) => {
    const anna = await post(base, '/api/profiles', { name: 'Anna', pin: '1234', device: 'pc' });
    assert.equal(anna.json.profile.admin, true);
    assert.equal(anna.json.profile.master, false);
    assert.ok(anna.json.profile.createdAt > 0);
    const ben = await post(base, '/api/profiles', { name: 'Ben', device: 'phone' });
    assert.equal(ben.json.profile.admin, false);
    const lib = await get(base, '/api/library', anna.json.token);
    assert.equal(lib.json.profile.admin, true);
  });
});

test('a profile made on the command line gets its part of the library from the running server', async () => {
  await withServer(async ({ base, server, dirs }) => {
    await post(base, '/api/profiles', { name: 'Anna', device: 'pc' });
    // What flow-server admin master Ben --create does: server.json only.
    const cli = configMod.open({ home: dirs.home, music: dirs.music });
    const ben = {
      id: configMod.newProfileId(), name: 'Ben', createdAt: Date.now(), pin: configMod.pinEntry('Secret12'), admin: true, master: true,
    };
    cli.set({ profiles: [...cli.get().profiles, ben] });
    assert.equal(cli.get().profiles.find((p) => p.id === ben.id).pin.strong, true);
    assert.ok(!server.library.profileIds().includes(ben.id));
    await new Promise((r) => setTimeout(r, 1100)); // the server looks at server.json once a second at most
    const list = (await get(base, '/api/profiles')).json.profiles;
    assert.deepEqual(list.map((p) => [p.name, p.admin, p.master]), [['Anna', true, false], ['Ben', true, true]]);
    assert.ok(server.library.profileIds().includes(ben.id));
    const signedIn = await post(base, '/api/profiles/login', { profileId: ben.id, pin: 'Secret12', device: 'phone' });
    assert.equal(signedIn.status, 200);
    assert.equal(signedIn.json.profile.master, true);
    assert.equal((await post(base, '/api/profiles', { name: 'ben', device: 'pc' })).status, 409, 'the name is taken');
  });
});
