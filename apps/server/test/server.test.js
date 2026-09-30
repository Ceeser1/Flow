'use strict';

// A real server on a free port with its own folders: signing in, the library,
// commands, uploads and streaming with Range.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');
const configMod = require('../src/config');
const tailscaleMod = require('../src/tailscale');
const discoveryMod = require('@flow/core/discovery');

// The fake songs below are no real audio: ffprobe would call them broken.
process.env.FLOW_SERVER_FFMPEG = 'off';

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-server-test-'));
  return { root, home: path.join(root, 'home'), music: path.join(root, 'music') };
}

async function withServer(fn, { password, tailscale = null } = {}) {
  const dirs = tempDirs();
  if (password) {
    const c = configMod.open({ home: dirs.home, music: dirs.music });
    c.set({ password: configMod.hashPassword(password) });
  }
  // Never the real machine's Tailscale.
  const server = await startServer({
    home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => tailscale, discoveryPort: null,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await fn({ server, base, dirs });
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);

async function upload(base, id, meta, body = FAKE_MP3, headers = {}) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
    method: 'PUT', body, headers,
  });
  return { status: r.status, json: await r.json() };
}

async function command(base, commands, headers = {}) {
  const r = await fetch(`${base}/api/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ commands }),
  });
  return r.json();
}

test('hello, an upload, and the library it ends up in', async () => {
  await withServer(async ({ base, dirs }) => {
    const hello = await (await fetch(`${base}/api/hello`)).json();
    assert.equal(hello.app, 'flow-server');
    assert.equal(hello.password, false);
    assert.match(hello.id, /^[0-9a-f]{24}$/);

    const up = await upload(base, 'abc123', {
      title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330, sourceUrl: 'https://youtu.be/u7K72X4eo_s',
    });
    assert.deepEqual(up.json, { existing: false, id: 'abc123', rev: 1 });
    assert.ok(fs.existsSync(path.join(dirs.music, 'Massive Attack - Teardrop.mp3')));

    const lib = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib.rev, 1);
    assert.equal(lib.library.songs[0].file, 'Massive Attack - Teardrop.mp3');
    assert.equal((await fetch(`${base}/api/library?since=1`)).status, 204);

    // The same source again is not stored twice.
    const again = await upload(base, 'zzz999', { title: 'Teardrop', format: 'mp3', sourceUrl: 'https://www.youtube.com/watch?v=u7K72X4eo_s' });
    assert.deepEqual(again.json, { existing: true, id: 'abc123', rev: 1 });
    // So is the same artist and title at the same length.
    const copy = await upload(base, 'yyy888', { title: 'Teardrop', artist: 'massive attack', format: 'mp3', duration: 331 });
    assert.equal(copy.json.id, 'abc123');
    const other = await upload(base, 'xxx777', { title: 'Teardrop', artist: 'Massive Attack', mix: 'Live', format: 'mp3', duration: 331 });
    assert.equal(other.json.id, 'xxx777');
    assert.equal(fs.readdirSync(dirs.music).filter((f) => !f.startsWith('.')).length, 2);
  });
});

test('audio is streamed whole or in the part asked for, with CORS', async () => {
  await withServer(async ({ base }) => {
    await upload(base, 's1', { title: 'Windowlicker', artist: 'Aphex Twin', format: 'mp3' });
    const whole = await fetch(`${base}/api/songs/s1/audio`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get('content-type'), 'audio/mpeg');
    assert.equal(whole.headers.get('access-control-allow-origin'), '*');
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);

    const part = await fetch(`${base}/api/songs/s1/audio`, { headers: { Range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], new Array(10).fill(7));

    const tail = await fetch(`${base}/api/songs/s1/audio`, { headers: { Range: 'bytes=-3' } });
    assert.equal(tail.headers.get('content-range'), 'bytes 997-999/1000');
    assert.equal((await fetch(`${base}/api/songs/s1/audio`, { headers: { Range: 'bytes=5000-' } })).status, 416);
    assert.equal((await fetch(`${base}/api/songs/nope/audio`)).status, 404);
  });
});

test('commands: edits rename the file, deletes go to the trash, repeats count once', async () => {
  await withServer(async ({ base, dirs }) => {
    await upload(base, 's1', { title: 'Windowlicker', artist: 'Aphex Twin', format: 'mp3' });
    const t = Date.now();
    const r1 = await command(base, [
      { cid: 'c1', at: t, type: 'createPlaylist', playlistId: 'p1', name: 'Night' },
      { cid: 'c2', at: t + 1, type: 'addSongsToPlaylist', playlistId: 'p1', songIds: ['s1'] },
      { cid: 'c3', at: t + 2, type: 'editSong', songId: 's1', artist: 'Aphex Twin', title: 'Xtal', mix: '' },
      { cid: 'c4', at: t + 3, type: 'addSong', song: { id: 'x' } },
    ]);
    assert.deepEqual(r1.results.map((r) => r.ok), [true, true, true, false]);
    assert.ok(fs.existsSync(path.join(dirs.music, 'Aphex Twin - Xtal.mp3')));
    assert.ok(!fs.existsSync(path.join(dirs.music, 'Aphex Twin - Windowlicker.mp3')));

    const repeat = await command(base, [{ cid: 'c1', at: t, type: 'createPlaylist', playlistId: 'p1', name: 'Night' }]);
    assert.equal(repeat.results[0].skipped, 'repeat');
    assert.equal(repeat.rev, r1.rev);

    // An edit made earlier (an app that was offline) loses to the one above.
    const stale = await command(base, [{ cid: 'c5', at: t - 50, type: 'editSong', songId: 's1', title: 'Old name' }]);
    assert.equal(stale.results[0].skipped, 'stale');
    // Nothing changed, so the revision stays.
    assert.equal(stale.rev, r1.rev);
    const refused = await command(base, [{ cid: 'c5b', at: t + 60, type: 'launch' }]);
    assert.equal(refused.results[0].ok, false);
    assert.equal(refused.rev, r1.rev);

    await command(base, [{ cid: 'c6', at: t + 100, type: 'deleteSong', songId: 's1' }]);
    assert.ok(!fs.existsSync(path.join(dirs.music, 'Aphex Twin - Xtal.mp3')));
    assert.equal(fs.readdirSync(path.join(dirs.music, '.flow-trash')).length, 1);
    const lib = await (await fetch(`${base}/api/library`)).json();
    assert.equal(lib.library.songs.length, 0);
    assert.equal(lib.library.playlists[0].entries.length, 0);
  });
});

test('with a password only a signed-in device gets in', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await (await fetch(`${base}/api/hello`)).json()).password, true);
    assert.equal((await fetch(`${base}/api/library`)).status, 401);
    const wrong = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '0000' }) });
    assert.equal(wrong.status, 401);
    // Straight after a wrong one: wait.
    const quick = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '4711' }) });
    assert.equal(quick.status, 429);
    await new Promise((r) => setTimeout(r, 1100));
    const ok = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '4711', device: 'Test PC' }) });
    const { token } = await ok.json();
    assert.ok(token);
    assert.equal((await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
    await upload(base, 's1', { title: 'Xtal', format: 'mp3' }, FAKE_MP3, { Authorization: `Bearer ${token}` });
    assert.equal((await fetch(`${base}/api/songs/s1/audio?t=${token}`)).status, 200);
    assert.equal((await fetch(`${base}/api/songs/s1/audio?t=nope`)).status, 401);
  }, { password: '4711' });
});

test('songs dropped into the folder by hand are found, and dropped when deleted', async () => {
  await withServer(async ({ server, base, dirs }) => {
    const file = path.join(dirs.music, 'Portishead - Glory Box.mp3');
    fs.writeFileSync(file, FAKE_MP3);
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(file, old, old);
    const found = await (await fetch(`${base}/api/rescan`, { method: 'POST' })).json();
    assert.equal(found.added, 1);
    const song = server.library.data.songs[0];
    assert.equal(song.artist, 'Portishead');
    assert.equal(song.title, 'Glory Box');
    fs.rmSync(file);
    const gone = await (await fetch(`${base}/api/rescan`, { method: 'POST' })).json();
    assert.equal(gone.removed, 1);
  });
});

test('profiles share the songs and keep their own playlists, also after a restart', async () => {
  const dirs = tempDirs();
  const open = () => startServer({ home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1' });
  let server = await open();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    await upload(base, 's1', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330, favouriteAt: 9 });
    await command(base, [{ cid: 'c1', at: Date.now(), type: 'createPlaylist', playlistId: 'p1', name: 'Evening' }]);

    let lib = server.library;
    lib.createProfile('anna');
    lib.createProfile('ben');
    const annaEvening = lib.snapshot('anna').playlists;
    assert.deepEqual(annaEvening.map((p) => p.name), ['Evening'], 'a new profile gets a copy of the default playlists');
    assert.notEqual(annaEvening[0].id, 'p1');
    assert.deepEqual(lib.snapshot('ben').playlists.map((p) => p.name), ['Evening']);
    assert.equal(lib.snapshot('anna').songs[0].favouriteAt, null, 'favourites stay with the default');
    assert.equal(lib.snapshot().songs[0].favouriteAt, 9);
    assert.deepEqual(lib.snapshot().playlists.map((p) => p.id), ['p1'], 'the default keeps its playlists');

    // An upload brings its favourite and playlists into the profile it came from.
    const tmp = path.join(dirs.music, '.flow-upload-test.mp3');
    fs.writeFileSync(tmp, FAKE_MP3);
    lib.runCommands([{ cid: 'c2', at: Date.now(), type: 'createPlaylist', playlistId: 'p2', name: 'Lunch' }], 'ben');
    lib.addUploaded(tmp, 's2', { title: 'Roads', artist: 'Portishead', format: 'mp3', favouriteAt: 4 }, ['p2', annaEvening[0].id], 'ben');
    const ben = lib.snapshot('ben');
    assert.equal(ben.songs.length, 2);
    assert.equal(ben.songs.find((s) => s.id === 's2').favouriteAt, 4);
    assert.deepEqual(ben.playlists.find((p) => p.id === 'p2').entries.map((e) => e.songId), ['s2'], "Anna's playlist is not his to fill");
    assert.deepEqual(lib.snapshot('anna').playlists[0].entries.map((e) => e.songId), [], "nor is the default's copy");
    assert.equal(lib.snapshot('anna').songs.find((s) => s.id === 's2').favouriteAt, null);
    assert.equal(lib.snapshot().songs.find((s) => s.id === 's2').favouriteAt, null);
    assert.throws(() => lib.runCommands([], 'nobody'), /no longer exists/);

    // All of it survives a restart.
    await server.close();
    server = await open();
    lib = server.library;
    assert.deepEqual(lib.profileIds().sort(), ['anna', 'ben']);
    assert.deepEqual(lib.snapshot('anna').playlists.map((p) => p.id), [annaEvening[0].id]);
    assert.deepEqual(lib.snapshot('ben').playlists.map((p) => p.name).sort(), ['Evening', 'Lunch']);
    assert.equal(lib.snapshot('ben').songs.find((s) => s.id === 's2').favouriteAt, 4);
    assert.equal(fs.readFileSync(path.join(dirs.home, 'library.json'), 'utf8').includes('"profiles"'), true);

    // Deleting a song reaches every profile; deleting a profile keeps the songs.
    const base2 = `http://127.0.0.1:${server.port}`;
    await command(base2, [{ cid: 'c3', at: Date.now(), type: 'deleteSong', songId: 's1' }]);
    assert.deepEqual(lib.snapshot('anna').playlists[0].entries, []);
    lib.deleteProfile('anna');
    assert.deepEqual(lib.profileIds(), ['ben']);
    assert.deepEqual(lib.snapshot().songs.map((s) => s.id), ['s2']);
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

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

test('profiles over the network: make, sign in with a PIN, rename, sign out, delete', async () => {
  await withServer(async ({ base }) => {
    assert.deepEqual((await get(base, '/api/hello')).json.features, ['profiles']);
    await upload(base, 's1', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 });
    await command(base, [{ cid: 'c1', at: Date.now(), type: 'createPlaylist', playlistId: 'p1', name: 'Evening' }]);
    assert.deepEqual((await get(base, '/api/profiles')).json, { profiles: [], current: null });

    const anna = await post(base, '/api/profiles', { name: '  Anna ', pin: '1234', device: 'pc' });
    assert.equal(anna.status, 200);
    assert.equal(anna.json.profile.name, 'Anna');
    assert.equal(anna.json.profile.pin, true);
    const tAnna = anna.json.token;
    let lib = await get(base, '/api/library', tAnna);
    assert.equal(lib.json.profile.name, 'Anna');
    assert.deepEqual(lib.json.library.playlists.map((p) => p.name), ['Evening'], 'she got a copy of the default playlists');
    const annaCopy = lib.json.library.playlists[0].id;
    assert.notEqual(annaCopy, 'p1');
    const rev = lib.json.rev;
    assert.equal((await get(base, `/api/library?since=${rev}&as=${anna.json.profile.id}`, tAnna)).status, 204);
    // Asking as someone else (the app just switched) gets the whole library.
    assert.equal((await get(base, `/api/library?since=${rev}&as=`, tAnna)).status, 200);
    assert.deepEqual((await get(base, '/api/library')).json.library.playlists.map((p) => p.id), ['p1'], 'without a profile: the default keeps its playlists');

    assert.equal((await post(base, '/api/profiles', { name: 'anna', device: 'phone' })).status, 409);
    assert.equal((await post(base, '/api/profiles', { name: 'None', device: 'phone' })).status, 400);
    assert.equal((await post(base, '/api/profiles', { name: 'Default / Shared', device: 'phone' })).status, 400);
    const ben = await post(base, '/api/profiles', { name: 'Ben', device: 'phone' });
    const tBen = ben.json.token;
    assert.equal(ben.json.profile.pin, false);
    await command(base, [{ cid: 'c2', at: Date.now(), type: 'createPlaylist', playlistId: 'p2', name: 'Lunch' }], { Authorization: `Bearer ${tBen}` });
    assert.deepEqual((await get(base, '/api/library', tBen)).json.library.playlists.map((p) => p.name).sort(), ['Evening', 'Lunch']);
    assert.deepEqual((await get(base, '/api/library', tAnna)).json.library.playlists.map((p) => p.id), [annaCopy]);

    const list = (await get(base, '/api/profiles', tBen)).json;
    assert.deepEqual(list.profiles.map((p) => p.name), ['Anna', 'Ben']);
    assert.equal(list.current, ben.json.profile.id);

    // Signing in: the PIN is checked; Ben's has none.
    assert.equal((await post(base, '/api/profiles/login', { profileId: anna.json.profile.id, pin: '9999', device: 'tablet' })).status, 403);
    await new Promise((r) => setTimeout(r, 1100)); // the wait after a wrong try
    const again = await post(base, '/api/profiles/login', { profileId: anna.json.profile.id, pin: '1234', device: 'tablet' });
    assert.equal(again.status, 200);
    assert.equal((await post(base, '/api/profiles/login', { profileId: ben.json.profile.id, device: 'laptop' })).status, 200);

    assert.equal((await post(base, '/api/profiles/rename', { name: 'Benjamin' }, tBen)).json.profile.name, 'Benjamin');
    assert.equal((await post(base, '/api/profiles/rename', { name: 'Anna' }, tBen)).status, 409);
    assert.equal((await post(base, '/api/profiles/rename', { name: 'X' })).status, 409, 'no profile to rename');

    await post(base, '/api/profiles/logout', {}, tAnna);
    assert.equal((await get(base, '/api/library', tAnna)).json.profile, null);

    // Deleting Ben takes his playlists; the song stays, and his devices are signed out of him.
    assert.equal((await post(base, '/api/profiles/delete', {}, tBen)).status, 200);
    lib = await get(base, '/api/library', tBen);
    assert.equal(lib.json.profile, null);
    assert.equal(lib.json.library.songs.length, 1);
    assert.deepEqual((await get(base, '/api/profiles')).json.profiles.map((p) => p.name), ['Anna']);
  });
});

test('with a server password, profiles are behind it', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await get(base, '/api/profiles')).status, 401);
    assert.equal((await post(base, '/api/profiles', { name: 'Anna' })).status, 401);
    const { token } = (await post(base, '/api/login', { password: 'secret', device: 'pc' })).json;
    const anna = await post(base, '/api/profiles', { name: 'Anna', device: 'pc' }, token);
    assert.equal(anna.status, 200);
    // The new token lets in as well; the old one was replaced.
    assert.equal((await get(base, '/api/library', anna.json.token)).json.profile.name, 'Anna');
    assert.equal((await get(base, '/api/library', token)).status, 401);
  }, { password: 'secret' });
});

test('hello tells where the server is on the tailnet, to private askers only', async () => {
  await withServer(async ({ base, server }) => {
    const hello = await (await fetch(`${base}/api/hello`)).json();
    assert.deepEqual(hello.tailscale, { ip: '100.101.102.103', dns: 'pi.tail1234.ts.net', port: server.port });
    // A proxy on this machine passes the asker's address along: not for them.
    const proxied = await (await fetch(`${base}/api/hello`, { headers: { 'X-Forwarded-For': '203.0.113.7' } })).json();
    assert.equal(proxied.tailscale, undefined);
  }, { tailscale: { ip: '100.101.102.103', dns: 'pi.tail1234.ts.net' } });

  await withServer(async ({ base }) => {
    assert.equal((await (await fetch(`${base}/api/hello`)).json()).tailscale, undefined);
  });
});

test('the address on the tailnet is read from tailscale status', () => {
  const up = { BackendState: 'Running', Self: { TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], DNSName: 'pi.tail1234.ts.net.' } };
  assert.deepEqual(tailscaleMod.fromStatus(up), { ip: '100.101.102.103', dns: 'pi.tail1234.ts.net' });
  assert.equal(tailscaleMod.fromStatus({ ...up, BackendState: 'Stopped' }), null);
  assert.equal(tailscaleMod.fromStatus({ BackendState: 'Running', Self: { TailscaleIPs: ['192.168.0.4'] } }), null);
  assert.equal(tailscaleMod.fromStatus(null), null);
  assert.deepEqual(
    tailscaleMod.fromInterfaces({ eth0: [{ family: 'IPv4', address: '192.168.0.61', internal: false }], tailscale0: [{ family: 'IPv4', address: '100.90.1.2', internal: false }] }),
    { ip: '100.90.1.2', dns: '' },
  );
  assert.equal(tailscaleMod.fromInterfaces({ lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }] }), null);
});

test('an app looking for servers on the network finds this one, with its real port', async () => {
  const dirs = tempDirs();
  const server = await startServer({
    home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: 0,
  });
  try {
    const port = server.discovery().port;
    const found = await discoveryMod.find({ port, targets: ['127.0.0.1'], timeoutMs: 800, sends: 1 });
    assert.equal(found.length, 1);
    assert.equal(found[0].ip, '127.0.0.1');
    assert.equal(found[0].port, server.port);
    assert.equal(found[0].id, server.config.get().id);
    // Nobody there: nothing found, and no error.
    assert.deepEqual(await discoveryMod.find({ port: port + 1 > 65535 ? 9 : port + 1, targets: ['127.0.0.1'], timeoutMs: 300, sends: 1 }), []);
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('discovery is off unless the server is told to answer', async () => {
  const dirs = tempDirs();
  const server = await startServer({ home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null });
  try {
    assert.equal(server.discovery(), null);
    assert.equal(server.config.get().discovery, false);
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('an asker gets only so many answers a minute', async () => {
  const { startDiscovery } = require('../src/discovery');
  const d = await startDiscovery({ port: 0, info: () => ({ id: 'a', name: 'n', port: 1, protocol: 1 }), maxPerMinute: 2 });
  try {
    const found = [];
    for (let i = 0; i < 4; i += 1) {
      found.push(await discoveryMod.find({ port: d.port, targets: ['127.0.0.1'], timeoutMs: 250, sends: 1 }));
    }
    assert.deepEqual(found.map((f) => f.length), [1, 1, 0, 0]);
  } finally {
    await d.close();
  }
});
