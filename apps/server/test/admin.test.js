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

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const profileIn = (server, id) => server.config.get().profiles.find((p) => p.id === id);

test('where a profile was made, the addresses it came from, and when it was last seen', async () => {
  await withServer(async ({ base, server }) => {
    const anna = await post(base, '/api/profiles', { name: 'Anna', pin: '1234', device: 'PC' });
    const id = anna.json.profile.id;
    let p = profileIn(server, id);
    assert.equal(p.createdIp, '127.0.0.1');
    assert.deepEqual(p.ips.map((e) => [e.ip, e.device]), [['127.0.0.1', 'PC']]);
    assert.ok(p.lastSeenAt > 0);

    // Signing in from another device puts it first; the same one again only moves its time.
    await post(base, '/api/profiles/login', { profileId: id, pin: '1234', device: 'Phone' });
    await post(base, '/api/profiles/login', { profileId: id, pin: '1234', device: 'Phone' });
    p = profileIn(server, id);
    assert.deepEqual(p.ips.map((e) => e.device), ['Phone', 'PC']);

    // Signing out is the last time seen.
    const before = p.lastSeenAt;
    await tick(5);
    await post(base, '/api/profiles/logout', {}, anna.json.token);
    assert.ok(profileIn(server, id).lastSeenAt > before);

    // An app's live channel: seen when it connects, and when it goes.
    const tablet = await post(base, '/api/profiles/login', { profileId: id, pin: '1234', device: 'Tablet' });
    const stop = new AbortController();
    const r = await fetch(`${base}/api/live?client=client-tablet01&device=Tablet`, { headers: { Authorization: `Bearer ${tablet.json.token}` }, signal: stop.signal });
    assert.equal(r.status, 200);
    await tick();
    assert.equal(server.live.clients()[0].profileId, id);
    const connected = profileIn(server, id).lastSeenAt;
    await tick(5);
    stop.abort();
    await tick(100);
    assert.equal(server.live.clients().length, 0);
    assert.ok(profileIn(server, id).lastSeenAt > connected, 'gone from the live channel');

    // lastSeen(): 'now' while connected; else the newest of its own and its devices' times.
    const later = Date.now() + 60000;
    assert.equal(server.activity.lastSeen(p, { online: true }), 'now');
    assert.equal(server.activity.lastSeen(p, { tokens: [{ profileId: id, lastSeenAt: later }, { profileId: 'x', lastSeenAt: later + 1 }] }), later);
    assert.equal(server.activity.lastSeen({ id: 'y', lastSeenAt: 0 }), 0);
  });
});

test('wrong PINs and wrong passwords are kept for the admins, newest first', async () => {
  await withServer(async ({ base, server, dirs }) => {
    const anna = await post(base, '/api/profiles', { name: 'Anna', pin: '1234', device: 'PC' });
    assert.equal((await post(base, '/api/profiles/login', { profileId: anna.json.profile.id, pin: '0000', device: 'Phone' })).status, 403);
    await tick(1100); // the wait after a wrong try
    server.config.set({ password: configMod.passwordEntry('0815'), tokens: [] });
    assert.equal((await post(base, '/api/login', { password: 'nope', device: 'Laptop' })).status, 401);
    const list = server.activity.failures();
    assert.deepEqual(list.map((f) => [f.kind, f.profileName, f.ip, f.device]), [
      ['password', '', '127.0.0.1', 'Laptop'],
      ['pin', 'Anna', '127.0.0.1', 'Phone'],
    ]);
    assert.equal(list[1].profileId, anna.json.profile.id);
    // Kept in a file of their own, not server.json.
    const kept = JSON.parse(fs.readFileSync(path.join(dirs.home, 'failed-signins.json'), 'utf8'));
    assert.equal(kept.length, 2);
    server.activity.clearFailures();
    assert.deepEqual(server.activity.failures(), []);
  });
});

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);

async function upload(base, id, meta, token) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
    method: 'PUT', body: FAKE_MP3, headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: r.status, json: await r.json() };
}

async function commands(base, list, token) {
  return post(base, '/api/commands', { commands: list.map((c, i) => ({ cid: `t-${Date.now()}-${i}`, at: Date.now(), ...c })) }, token);
}

/** Anna (the first: an admin) and Ben, each signed in, Ben with a song he added and listened to. */
async function annaAndBen(base) {
  const anna = await post(base, '/api/profiles', { name: 'Anna', device: 'PC' });
  const ben = await post(base, '/api/profiles', { name: 'Ben', pin: '1234', device: 'Phone' });
  const song = await upload(base, 'up1', { title: 'Glory Box', artist: 'Portishead', format: 'mp3', duration: 300 }, ben.json.token);
  await commands(base, [{ type: 'recordListen', songId: song.json.id, listened: 300, duration: 300 }], ben.json.token);
  return { anna, ben, songId: song.json.id, tAnna: anna.json.token, tBen: ben.json.token, benId: ben.json.profile.id };
}

test('only admins get the admins\' routes; the list has every profile\'s numbers', async () => {
  await withServer(async ({ base }) => {
    const { tAnna, tBen, benId, anna } = await annaAndBen(base);
    assert.equal((await get(base, '/api/admin/profiles')).status, 403, 'no profile');
    assert.equal((await get(base, '/api/admin/profiles', tBen)).status, 403, 'no admin');
    assert.ok((await get(base, '/api/hello')).json.features.includes('admin'));
    const r = await get(base, '/api/admin/profiles', tAnna);
    assert.equal(r.status, 200);
    assert.equal(r.json.me, anna.json.profile.id);
    const ben = r.json.profiles.find((p) => p.id === benId);
    assert.deepEqual(
      { ...ben, createdAt: 0, lastSeen: 0 },
      { id: benId, name: 'Ben', createdAt: 0, lastSeen: 0, addedSongs: 1, listens: 1, seconds: 300, admin: false, master: false, disabled: false, pin: true, devices: 1 },
    );
    assert.ok(ben.lastSeen > 0);
    const ips = await get(base, `/api/admin/profiles/${benId}/ips`, tAnna);
    assert.deepEqual([ips.json.createdIp, ips.json.ips.map((e) => e.device)], ['127.0.0.1', ['Phone']]);
    assert.equal((await get(base, '/api/admin/profiles/nobody/ips', tAnna)).status, 404);
    assert.equal((await get(base, '/api/admin/nothing', tAnna)).status, 404);
  });
});

test('an admin takes a PIN away, signs a profile out, disables it and enables it again', async () => {
  await withServer(async ({ base, server }) => {
    const { tAnna, tBen, benId } = await annaAndBen(base);
    assert.equal((await post(base, `/api/admin/profiles/${benId}/pin`, {}, tAnna)).status, 200);
    assert.equal(profileIn(server, benId).pin, null);
    assert.equal((await post(base, '/api/profiles/login', { profileId: benId, device: 'Tablet' })).status, 200, 'no PIN needed now');

    const out = await post(base, `/api/admin/profiles/${benId}/signout`, {}, tAnna);
    assert.equal(out.json.devices, 2);
    assert.equal((await get(base, '/api/library', tBen)).json.profile, null, 'still on the server, no longer Ben');

    await post(base, `/api/admin/profiles/${benId}/disable`, { disabled: true }, tAnna);
    const refused = await post(base, '/api/profiles/login', { profileId: benId, device: 'Phone' });
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /disabled/);
    await post(base, `/api/admin/profiles/${benId}/disable`, { disabled: false }, tAnna);
    assert.equal((await post(base, '/api/profiles/login', { profileId: benId, device: 'Phone' })).status, 200);

    // Not one's own profile, nor the master's.
    const annaId = (await get(base, '/api/admin/profiles', tAnna)).json.me;
    assert.equal((await post(base, `/api/admin/profiles/${annaId}/disable`, { disabled: true }, tAnna)).status, 409);
    server.config.set({ profiles: server.config.get().profiles.map((p) => (p.id === benId ? { ...p, master: true } : p)) });
    assert.equal((await post(base, `/api/admin/profiles/${benId}/signout`, {}, tAnna)).status, 403);
  });
});

test('deleting a profile, with or without the songs it added', async () => {
  await withServer(async ({ base, server, dirs }) => {
    const { tAnna, benId, songId } = await annaAndBen(base);
    const carla = await post(base, '/api/profiles', { name: 'Carla', device: 'Laptop' });
    const carlaSong = await upload(base, 'up2', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 }, carla.json.token);

    // Ben with his song: gone for everyone, its file in the trash.
    const gone = await post(base, `/api/admin/profiles/${benId}/delete`, { songs: true }, tAnna);
    assert.equal(gone.json.deletedSongs, 1);
    assert.equal(profileIn(server, benId), undefined);
    assert.ok(!server.library.profileIds().includes(benId));
    assert.equal(server.library.data.songs.some((s) => s.id === songId), false);
    assert.equal(fs.readdirSync(path.join(dirs.music, '.flow-trash')).length, 1);

    // Carla without hers: the song stays.
    const kept = await post(base, `/api/admin/profiles/${carla.json.profile.id}/delete`, { songs: false }, tAnna);
    assert.equal(kept.json.deletedSongs, 0);
    assert.ok(server.library.data.songs.some((s) => s.id === carlaSong.json.id));
    assert.equal((await get(base, '/api/library', carla.json.token)).json.profile, null);
  });
});

test('only the master admin makes admins', async () => {
  await withServer(async ({ base, server }) => {
    const { tAnna, tBen, benId } = await annaAndBen(base);
    assert.equal((await post(base, `/api/admin/profiles/${benId}/admin`, { admin: true }, tAnna)).status, 403, 'Anna is no master');
    const annaId = (await get(base, '/api/admin/profiles', tAnna)).json.me;
    server.config.set({ profiles: server.config.get().profiles.map((p) => (p.id === annaId ? { ...p, master: true } : p)) });
    assert.equal((await post(base, `/api/admin/profiles/${benId}/admin`, { admin: true }, tAnna)).status, 200);
    assert.equal((await get(base, '/api/admin/profiles', tBen)).status, 200, 'Ben is an admin now');
    assert.equal((await post(base, `/api/admin/profiles/${annaId}/admin`, { admin: false }, tAnna)).status, 409, 'the master stays one');
  });
});
