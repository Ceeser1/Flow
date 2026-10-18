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
const { createActivity } = require('../src/activity');

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

test('a server from before 3.5: its oldest profile with a PIN becomes an admin, once', () => {
  const dirs = tempDirs();
  try {
    const pin = configMod.pinEntry('1234');
    const c = oldConfig(dirs.home, {
      profiles: [
        { id: 'ben', name: 'Ben', createdAt: 300, pin },
        { id: 'dora', name: 'Dora', createdAt: 50 },
        { id: 'anna', name: 'Anna', createdAt: 100, pin },
        { id: 'carla', name: 'Carla', createdAt: 200, pin },
      ],
    });
    assert.deepEqual(c.get().profiles.map((p) => [p.id, p.admin]), [['ben', false], ['dora', false], ['anna', true], ['carla', false]]);
    assert.equal(c.get().adminSeeded, true);
    assert.equal(c.get().profiles.find((p) => p.id === 'anna').lastSeenAt, 0);
    assert.equal(c.get().profiles.find((p) => p.id === 'anna').createdIp, '');
    // Taken away: not made again.
    c.set({ profiles: c.get().profiles.map((p) => ({ ...p, admin: false })) });
    const again = configMod.open({ home: dirs.home, music: dirs.music });
    assert.deepEqual(again.get().profiles.map((p) => p.admin), [false, false, false, false]);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
  // None with a PIN: no admin yet; the first to get one becomes it.
  const dirs2 = tempDirs();
  try {
    const c = oldConfig(dirs2.home, { profiles: [{ id: 'anna', name: 'Anna', createdAt: 100 }, { id: 'ben', name: 'Ben', createdAt: 200 }] });
    assert.deepEqual(c.get().profiles.map((p) => p.admin), [false, false]);
    assert.equal(c.get().adminSeeded, false);
    c.set({ profiles: c.get().profiles.map((p) => (p.id === 'ben' ? { ...p, pin: configMod.pinEntry('1234') } : p)) });
    assert.deepEqual(c.get().profiles.map((p) => p.admin), [false, true]);
    assert.equal(c.get().adminSeeded, true);
  } finally {
    fs.rmSync(dirs2.root, { recursive: true, force: true });
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
    // It becomes the admin, so not without a PIN.
    const none = await post(base, '/api/profiles', { name: 'Anna', device: 'pc' });
    assert.equal(none.status, 400);
    assert.match(none.json.error, /needs a PIN/);
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
    await post(base, '/api/profiles', { name: 'Anna', pin: '1111', device: 'pc' });
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

test('an app closed and started again a moment later is in the connection history again', () => {
  const dirs = tempDirs();
  try {
    const config = configMod.open({ home: dirs.home, music: dirs.music });
    let clock = 1_000_000;
    const activity = createActivity({ config, now: () => clock });
    config.set({ profiles: [{ id: 'anna1', name: 'Anna', createdAt: clock }] });
    activity.seen('anna1', { ip: '192.168.0.5', device: 'PC' });
    const at = () => config.get().profiles[0].ips[0].at;
    assert.equal(at(), clock);
    // Its live channel a moment later: not written again.
    clock += 1000;
    activity.seen('anna1', { ip: '192.168.0.5', device: 'PC' }, true);
    assert.equal(at(), clock - 1000);
    // Twenty minutes on, the app is closed (last seen then) and started again 5 seconds later.
    clock += 20 * 60 * 1000;
    activity.left('anna1');
    clock += 5000;
    activity.seen('anna1', { ip: '192.168.0.5', device: 'PC' }, true);
    assert.equal(at(), clock);
    assert.equal(config.get().profiles[0].ips.length, 1, 'the same place: its time moves');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
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
  const anna = await post(base, '/api/profiles', { name: 'Anna', pin: '1111', device: 'PC' });
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

    // A PIN taken away takes admin with it, and a profile without one is made no admin.
    const reset = await post(base, `/api/admin/profiles/${benId}/pin`, {}, tAnna);
    assert.equal(reset.json.revokedAdmin, true);
    assert.equal(profileIn(server, benId).admin, false);
    assert.equal(profileIn(server, benId).pin, null);
    const refused = await post(base, `/api/admin/profiles/${benId}/admin`, { admin: true }, tAnna);
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /no PIN/);
    assert.equal((await post(base, `/api/admin/profiles/${benId}/pin`, {}, tAnna)).json.revokedAdmin, false);
  });
});

test('the overview, the rules and the failed sign-ins', async () => {
  await withServer(async ({ base, server }) => {
    const { tAnna, tBen } = await annaAndBen(base);
    const o = (await get(base, '/api/admin/server', tAnna)).json;
    assert.equal(o.songs, 1);
    assert.equal(o.profiles, 2);
    assert.equal(o.musicBytes, FAKE_MP3.length);
    assert.equal(o.trashBytes, 0);
    assert.equal(o.password, false);
    assert.equal(o.master, '');
    assert.ok(o.startedAt > 0 && typeof o.version === 'string');
    assert.equal((await get(base, '/api/admin/server', tBen)).status, 403);

    assert.deepEqual((await get(base, '/api/admin/rules', tAnna)).json, { profileCreation: 'anyone', songDelete: 'anyone' });
    assert.deepEqual((await post(base, '/api/admin/rules', { songDelete: 'owner' }, tAnna)).json, { profileCreation: 'anyone', songDelete: 'owner' });
    assert.equal(server.config.get().songDelete, 'owner');

    assert.deepEqual((await get(base, '/api/admin/signins', tAnna)).json, { failures: [] });
    const benId = (await get(base, '/api/admin/profiles', tAnna)).json.profiles[1].id;
    await post(base, '/api/profiles/login', { profileId: benId, pin: '0', device: 'X' });
    assert.equal((await get(base, '/api/admin/signins', tAnna)).json.failures.length, 1);
    await post(base, '/api/admin/signins/clear', {}, tAnna);
    assert.equal((await get(base, '/api/admin/signins', tAnna)).json.failures.length, 0);

    assert.deepEqual((await get(base, '/api/admin/downloads', tAnna)).json, { batches: [] });
    assert.equal((await post(base, '/api/admin/downloads/cancel', { key: 'nope' }, tAnna)).status, 404);
    assert.deepEqual((await get(base, '/api/admin/sessions', tAnna)).json, { sessions: [] });
    assert.equal((await post(base, '/api/admin/sessions/end', { id: 'nope' }, tAnna)).status, 404);
  });
});

test('a deleted song comes back from the trash as it was', async () => {
  await withServer(async ({ base, server, dirs }) => {
    const { tAnna, tBen, songId } = await annaAndBen(base);
    const other = await upload(base, 'up2', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 }, tAnna);
    // Anna has it second in her playlist and as a favourite; Ben listened to it (annaAndBen).
    await commands(base, [
      { type: 'createPlaylist', playlistId: 'pa', name: 'Night' },
      { type: 'addSongsToPlaylist', playlistId: 'pa', songIds: [other.json.id, songId] },
      { type: 'setFavourite', songId, on: true },
    ], tAnna);
    await commands(base, [{ type: 'deleteSong', songId }], tBen);
    assert.equal(server.library.data.songs.some((s) => s.id === songId), false);

    let trash = (await get(base, '/api/admin/trash', tAnna)).json;
    assert.equal(trash.items.length, 1);
    assert.deepEqual([trash.items[0].title, trash.items[0].artist, trash.items[0].by, trash.items[0].addedBy, trash.items[0].restorable], ['Glory Box', 'Portishead', 'Ben', 'Ben', true]);
    assert.equal(trash.bytes, FAKE_MP3.length);

    const back = await post(base, '/api/admin/trash/restore', { name: trash.items[0].name }, tAnna);
    assert.equal(back.json.songId, songId);
    const lib = (await get(base, '/api/library', tAnna)).json.library;
    assert.deepEqual(lib.playlists.find((p) => p.id === 'pa').entries.map((e) => e.songId), [other.json.id, songId], 'in its place');
    assert.ok(lib.songs.find((s) => s.id === songId).favouriteAt, 'still a favourite');
    const bens = (await get(base, '/api/library', tBen)).json.library.songs.find((s) => s.id === songId);
    assert.equal(bens.stats.listened, 300, 'the listens kept');
    assert.ok(fs.existsSync(path.join(dirs.music, bens.file)));
    trash = (await get(base, '/api/admin/trash', tAnna)).json;
    assert.equal(trash.items.length, 0);
    assert.equal((await post(base, '/api/admin/trash/restore', { name: 'gone.mp3' }, tAnna)).status, 404);
    assert.equal((await post(base, '/api/admin/trash/restore', { name: '../x' }, tAnna)).status, 404);
  });
});

test('a file in the trash from before comes back as a new song; Empty trash; 30 days from the deleting', async () => {
  await withServer(async ({ base, server, dirs }) => {
    const { tAnna, tBen, songId } = await annaAndBen(base);
    const bin = path.join(dirs.music, '.flow-trash');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, '1700000000000-Old Song.mp3'), FAKE_MP3);
    let trash = (await get(base, '/api/admin/trash', tAnna)).json;
    assert.deepEqual(trash.items.map((t) => [t.title, t.restorable]), [['Old Song.mp3', false]]);
    const back = await post(base, '/api/admin/trash/restore', { name: '1700000000000-Old Song.mp3' }, tAnna);
    assert.equal(back.json.scanned.added, 1);
    assert.ok(fs.existsSync(path.join(dirs.music, 'Old Song.mp3')));

    // A song whose file is a year old still waits 30 days once deleted.
    const file = server.library.data.songs.find((s) => s.id === songId).file;
    const yearAgo = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    fs.utimesSync(file, yearAgo, yearAgo);
    await commands(base, [{ type: 'deleteSong', songId }], tBen);
    server.library.emptyTrash();
    assert.equal(fs.readdirSync(bin).length, 1, 'kept');
    assert.equal((await post(base, '/api/admin/trash/empty', {}, tAnna)).json.deleted, 1);
    assert.deepEqual(fs.readdirSync(bin), []);
    trash = (await get(base, '/api/admin/trash', tAnna)).json;
    assert.deepEqual(trash, { items: [], bytes: 0 });
  });
});

test('the master admin changes the server password; everyone else signs in again', async () => {
  await withServer(async ({ base, server }) => {
    const { tAnna, tBen } = await annaAndBen(base);
    const annaId = (await get(base, '/api/admin/profiles', tAnna)).json.me;
    assert.equal((await post(base, '/api/admin/password', { password: 'abcd' }, tAnna)).status, 403, 'no master');
    server.config.set({ profiles: server.config.get().profiles.map((p) => (p.id === annaId ? { ...p, master: true } : p)) });
    assert.equal((await post(base, '/api/admin/password', { password: 'ab' }, tAnna)).status, 400, 'too short');
    let r = await post(base, '/api/admin/password', { password: 'first' }, tAnna);
    assert.equal(r.status, 200);
    const tNew = r.json.token;
    assert.ok(tNew);
    assert.equal((await get(base, '/api/library', tBen)).status, 401, 'Ben enters it again');
    assert.equal((await get(base, '/api/library', tNew)).json.profile.id, annaId, 'Anna carries on');
    assert.equal((await post(base, '/api/login', { password: 'first', device: 'Phone' })).status, 200);

    r = await post(base, '/api/admin/password', { current: 'wrong', password: 'second' }, tNew);
    assert.equal(r.status, 403);
    assert.equal(server.activity.failures()[0].kind, 'password');
    await tick(1100); // the wait after a wrong try
    r = await post(base, '/api/admin/password', { current: 'first', remove: true }, tNew);
    assert.equal(r.status, 200);
    assert.equal(server.config.get().password, null);

    // At level 3 a weak master PIN may change it too (a strong one is only
    // recommended), but the new password follows the internet's rules.
    server.config.set({ level: 3, password: configMod.passwordEntry('Strong123'), tokens: [] });
    const signedIn = (await post(base, '/api/login', { password: 'Strong123', device: 'PC' })).json.token;
    const t3 = (await post(base, '/api/profiles/login', { profileId: annaId, pin: '1111', device: 'PC' }, signedIn)).json.token;
    assert.equal((await post(base, '/api/admin/password', { current: 'Strong123', password: 'weak' }, t3)).status, 400);
    r = await post(base, '/api/admin/password', { current: 'Strong123', password: 'Better456x' }, t3);
    assert.equal(r.status, 200);
  });
});

test('the rule "only who added a song deletes it"', async () => {
  await withServer(async ({ base, server }) => {
    const { tAnna, tBen, songId } = await annaAndBen(base);
    const annas = (await upload(base, 'up2', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 }, tAnna)).json.id;
    const nobodys = (await upload(base, 'up3', { title: 'Angel', artist: 'Massive Attack', format: 'mp3', duration: 380 })).json.id;
    server.library.data.songs.find((s) => s.id === nobodys).addedBy = '';
    assert.equal((await get(base, '/api/library', tBen)).json.rules.songDelete, 'anyone');
    await post(base, '/api/admin/rules', { songDelete: 'owner' }, tAnna);
    assert.equal((await get(base, '/api/library', tBen)).json.rules.songDelete, 'owner');
    assert.equal((await get(base, '/api/library', tAnna)).json.rules.songDelete, 'anyone', 'an admin may');

    // Ben's list with Anna's song and his own, deleted with its songs: his go, hers stays.
    await commands(base, [
      { type: 'createPlaylist', playlistId: 'pb', name: 'Mix' },
      { type: 'addSongsToPlaylist', playlistId: 'pb', songIds: [annas, songId] },
    ], tBen);
    let r = await commands(base, [{ type: 'deleteSong', songId: annas }], tBen);
    assert.equal(r.json.results[0].ok, false);
    assert.match(r.json.results[0].error, /added by Anna/);
    r = await commands(base, [{ type: 'deletePlaylist', playlistId: 'pb', deleteSongs: true }], tBen);
    assert.deepEqual(r.json.results[0].deletedSongs, [songId]);
    const ids = server.library.data.songs.map((s) => s.id);
    assert.ok(ids.includes(annas) && !ids.includes(songId));
    // A song nobody added (put in by hand): anyone. An admin: any song.
    assert.equal((await commands(base, [{ type: 'deleteSong', songId: nobodys }], tBen)).json.results[0].ok, true);
    const bensSecond = (await upload(base, 'up4', { title: 'Roads', artist: 'Portishead', format: 'mp3', duration: 300 }, tBen)).json.id;
    assert.equal((await commands(base, [{ type: 'deleteSong', songId: bensSecond }], tAnna)).json.results[0].ok, true);
  });
});

test('the rule "only admins make profiles"', async () => {
  await withServer(async ({ base, server }) => {
    server.config.set({ profileCreation: 'admins' });
    // A server with no profile yet: the first one can always be made.
    assert.equal((await get(base, '/api/profiles')).json.createProfiles, true);
    server.config.set({ profileCreation: 'anyone' });
    const { tAnna, tBen } = await annaAndBen(base);
    server.config.set({ profileCreation: 'admins' });
    assert.equal((await get(base, '/api/profiles', tBen)).json.createProfiles, false);
    assert.equal((await get(base, '/api/profiles')).json.createProfiles, false, 'no profile signed in');
    const refused = await post(base, '/api/profiles', { name: 'Carla', device: 'Laptop' }, tBen);
    assert.equal(refused.status, 403);
    assert.match(refused.json.error, /only an admin/);
    assert.equal((await post(base, '/api/profiles', { name: 'Carla', device: 'Laptop' })).status, 403);
    // An admin makes one for someone else and stays signed in as itself.
    const made = await post(base, '/api/admin/profiles', { name: 'Carla', pin: '4321' }, tAnna);
    assert.equal(made.status, 200);
    assert.equal(made.json.profile.name, 'Carla');
    assert.equal((await get(base, '/api/library', tAnna)).json.profile.name, 'Anna');
    const carla = server.config.get().profiles.find((p) => p.name === 'Carla');
    assert.ok(carla.pin && server.library.profileIds().includes(carla.id));
    assert.equal(carla.createdIp, '127.0.0.1');
    assert.equal((await post(base, '/api/admin/profiles', { name: 'carla' }, tAnna)).status, 409);
  });
});
