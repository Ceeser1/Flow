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

async function withServer(fn, { password, tailscale = null, settings = null } = {}) {
  const dirs = tempDirs();
  if (password || settings) {
    const c = configMod.open({ home: dirs.home, music: dirs.music });
    if (password) c.set({ password: configMod.passwordEntry(password) });
    if (settings) c.set(settings);
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

test('two apps on machines of the same name keep their own tokens', async () => {
  await withServer(async ({ base, server }) => {
    const signIn = async (body) => (await (await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '4711', ...body }) })).json()).token;
    const ok = async (token) => (await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).status === 200;
    // An app from before 2.8 (no install id) is replaced by the first new one of its machine.
    const old = await signIn({ device: 'PC' });
    const a = await signIn({ device: 'PC', client: 'client-aaaaaaaa' });
    assert.equal(await ok(old), false);
    const b = await signIn({ device: 'PC', client: 'client-bbbbbbbb' });
    assert.ok(await ok(a));
    assert.ok(await ok(b));
    // The same app signing in again replaces only its own.
    const a2 = await signIn({ device: 'PC', client: 'client-aaaaaaaa' });
    assert.equal(await ok(a), false);
    assert.ok(await ok(a2));
    assert.ok(await ok(b));
    // A profile signed in to keeps the app's id.
    const r = await (await fetch(`${base}/api/profiles`, { method: 'POST', headers: { Authorization: `Bearer ${b}` }, body: JSON.stringify({ name: 'Anna', device: 'PC' }) })).json();
    assert.ok(await ok(r.token));
    assert.ok(await ok(a2));
    assert.deepEqual(server.config.get().tokens.map((t) => t.client).sort(), ['client-aaaaaaaa', 'client-bbbbbbbb']);
    // Nonsense is no id.
    await signIn({ device: 'Other', client: 'x y' });
    assert.equal(server.config.get().tokens.find((t) => t.device === 'Other').client, '');
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

  // Level 1 is the home network only: the tailnet isn't offered.
  await withServer(async ({ base }) => {
    assert.equal((await (await fetch(`${base}/api/hello`)).json()).tailscale, undefined);
  }, { tailscale: { ip: '100.101.102.103', dns: '' }, settings: { level: 1 } });
});

const via = (forwardedFor, more = {}) => ({ 'X-Forwarded-For': forwardedFor, ...more });

test('through a proxy from outside, nobody gets in without a strong password', async () => {
  // Levels 1 and 2: the home network is let in as before, also through a
  // proxy on this machine; someone from the internet it passes on is not.
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/library`)).status, 200);
    assert.equal((await fetch(`${base}/api/library`, { headers: via('192.168.0.5') })).status, 200);
    const outside = await fetch(`${base}/api/library`, { headers: via('203.0.113.7') });
    assert.equal(outside.status, 403);
    assert.match((await outside.json()).error, /has no password/);
    assert.equal((await fetch(`${base}/api/hello`, { headers: via('203.0.113.7') })).status, 200, 'hello stays open');
    // Plain http through the proxy from outside: not even hello.
    assert.equal((await fetch(`${base}/api/hello`, { headers: via('203.0.113.7', { 'X-Forwarded-Proto': 'http' }) })).status, 403);
    assert.equal((await fetch(`${base}/api/hello`, { headers: via('192.168.0.5', { 'X-Forwarded-Proto': 'http' }) })).status, 200);
  });

  // Level 3 with a PIN: too weak, for everyone, from anywhere.
  await withServer(async ({ base }) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: '4711' }) });
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /too weak/);
    const hello = await (await fetch(`${base}/api/hello`)).json();
    assert.equal(hello.publicUrl, 'https://music.example.com');
  }, { password: '4711', settings: { level: 3, publicUrl: 'https://music.example.com/' } });

  // Level 3 with a strong password: in, through the proxy too.
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/api/library`, { headers: via('203.0.113.7') })).status, 401);
    const r = await fetch(`${base}/api/login`, {
      method: 'POST', headers: via('203.0.113.7', { 'X-Forwarded-Proto': 'https' }), body: JSON.stringify({ password: 'Portis8head', device: 'phone' }),
    });
    assert.equal(r.status, 200);
    const { token } = await r.json();
    assert.equal((await fetch(`${base}/api/library`, { headers: via('203.0.113.7', { Authorization: `Bearer ${token}` }) })).status, 200);
  }, { password: 'Portis8head', settings: { level: 3 } });

  // No public address below level 3, and nothing from outside at all once
  // level 1 or 2 is chosen, strong password or not; the home network through
  // the same proxy is fine.
  await withServer(async ({ base }) => {
    assert.equal((await (await fetch(`${base}/api/hello`)).json()).publicUrl, undefined);
    const outside = await fetch(`${base}/api/hello`, { headers: via('203.0.113.7') });
    assert.equal(outside.status, 403);
    assert.match((await outside.json()).error, /set to level 2/);
    assert.equal((await fetch(`${base}/api/hello`, { headers: via('192.168.0.5') })).status, 200);
  }, { password: 'Portis8head', settings: { level: 2, publicUrl: 'https://music.example.com' } });
});

test('at level 3 and 4 a session ends, and only the password starts a new one', async () => {
  const { mock } = require('node:test');
  const realNow = Date.now.bind(Date);
  let skew = 0;
  const later = (ms) => { skew += ms; };
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const json = { 'Content-Type': 'application/json' };
  const signIn = async (base, body = { password: 'Portis8head', device: 'pc' }) => fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const library = (base, token) => fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } });
  // Used every 20 minutes for `total`, like an app left open.
  const stay = async (base, token, total) => {
    for (let t = 20 * MIN; t <= total; t += 20 * MIN) {
      later(20 * MIN);
      assert.equal((await library(base, token)).status, 200, `after ${t / MIN} minutes`);
    }
  };
  mock.method(Date, 'now', () => realNow() + skew);
  try {
    for (const level of [3, 4]) {
      skew = 0;
      await withServer(async ({ base, server }) => {
        // No password sent: turned away, and it is no wrong try that makes anyone wait.
        for (const body of [{ device: 'pc' }, { password: '', device: 'pc' }, { password: 4711, device: 'pc' }]) {
          const none = await signIn(base, body);
          assert.equal(none.status, 401);
          assert.match((await none.json()).error, /needs its password/);
        }
        const { token } = await (await signIn(base)).json();
        assert.equal((await library(base, token)).status, 200);

        // Used now and then, a session carries on, past the idle time in all.
        await stay(base, token, 80 * MIN);
        // Left alone for longer than the idle time: over.
        later(31 * MIN);
        const ended = await library(base, token);
        assert.equal(ended.status, 401);
        assert.match((await ended.json()).error, /session has ended/);
        assert.equal((await fetch(`${base}/api/songs/x/audio?t=${token}`)).status, 401, 'audio links too');
        // The password gives a new one.
        const again = await (await signIn(base)).json();
        assert.notEqual(again.token, token);
        assert.equal((await library(base, again.token)).status, 200);
        assert.equal(server.config.get().tokens.length, 1, 'the ended one is gone');

        // However busy, a day is the most.
        await stay(base, again.token, 23 * HOUR + 40 * MIN);
        later(25 * MIN);
        assert.equal((await library(base, again.token)).status, 401, 'over 24 hours, though not idle');
      }, { password: 'Portis8head', settings: { level } });
    }

    // Signing in to a profile does not renew the session; the password does.
    skew = 0;
    await withServer(async ({ base }) => {
      const { token } = await (await signIn(base)).json();
      await stay(base, token, 23 * HOUR + 40 * MIN);
      const made = await fetch(`${base}/api/profiles`, {
        method: 'POST', headers: { ...json, Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: 'Anna', device: 'pc' }),
      });
      assert.equal(made.status, 200);
      const profileToken = (await made.json()).token;
      assert.equal((await library(base, profileToken)).status, 200);
      later(25 * MIN);
      assert.equal((await library(base, profileToken)).status, 401, 'the profile did not start a new session');
    }, { password: 'Portis8head', settings: { level: 3 } });

    // A restart of the server ends every session, however fresh; below level
    // 3 a restart changes nothing.
    for (const level of [2, 4]) {
      skew = 0;
      const dirs = tempDirs();
      const c = configMod.open({ home: dirs.home, music: dirs.music });
      c.set({ password: configMod.passwordEntry('Portis8head'), level });
      const run = () => startServer({
        home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
      });
      try {
        let server = await run();
        let base = `http://127.0.0.1:${server.port}`;
        assert.equal((await (await fetch(`${base}/api/hello`)).json()).session, level >= 4 ? true : undefined);
        const { token } = await (await signIn(base)).json();
        assert.equal((await library(base, token)).status, 200);
        await server.close();
        later(5);
        server = await run();
        base = `http://127.0.0.1:${server.port}`;
        const after = await library(base, token);
        assert.equal(after.status, level >= 4 ? 401 : 200, `level ${level} after a restart`);
        if (level >= 4) assert.match((await after.json()).error, /session has ended/);
        await server.close();
      } finally {
        fs.rmSync(dirs.root, { recursive: true, force: true });
      }
    }

    // Level 2 and below: a token still lasts.
    skew = 0;
    await withServer(async ({ base }) => {
      const { token } = await (await signIn(base, { password: '4711', device: 'pc' })).json();
      later(30 * 24 * HOUR);
      assert.equal((await library(base, token)).status, 200);
    }, { password: '4711', settings: { level: 2 } });

    // A token from before the server went public is no key either.
    skew = 0;
    await withServer(async ({ base, server }) => {
      const { token } = await (await signIn(base, { password: 'Portis8head', device: 'pc' })).json();
      assert.equal((await library(base, token)).status, 200);
      later(2 * HOUR);
      server.config.set({ level: 3 });
      assert.equal((await library(base, token)).status, 401);
    }, { password: 'Portis8head', settings: { level: 2 } });
  } finally {
    mock.restoreAll();
  }
});

test('at level 3 and 4 the home network needs no password, anyone else does', async () => {
  const get = (base, headers = {}, p = '/api/library') => fetch(`${base}${p}`, { headers });
  for (const settings of [{ level: 3 }, { level: 4, publicUrl: 'https://music.example.com' }]) {
    await withServer(async ({ base }) => {
      // A proxy on this machine names the caller: from the home network, in with no token.
      assert.equal((await get(base, via('192.168.0.5'))).status, 200);
      const hello = await (await get(base, via('192.168.0.5'), '/api/hello')).json();
      assert.equal(hello.password, false, 'no password asked of home');
      assert.equal(hello.session, undefined);
      // Everyone else is asked, and told so.
      for (const who of ['203.0.113.7', '100.64.0.9', '127.0.0.1', '100.101.102.103']) {
        assert.equal((await get(base, via(who))).status, 401, who);
        const away = await (await get(base, via(who), '/api/hello')).json();
        assert.equal(away.password, true, who);
        assert.equal(away.session, true, who);
      }
      // Straight at this machine's own address: nobody can say it is home.
      assert.equal((await get(base)).status, 401, 'the loopback, no proxy');
      // Home can still sign in, and a token (a profile) still works there, however old.
      const { token } = await (await fetch(`${base}/api/login`, {
        method: 'POST', headers: via('192.168.0.5'), body: JSON.stringify({ password: 'Portis8head', device: 'pc' }),
      })).json();
      assert.equal((await get(base, via('192.168.0.5', { Authorization: `Bearer ${token}` }))).status, 200);
      // A token wrong or ended is no reason to turn home away.
      assert.equal((await get(base, via('192.168.0.5', { Authorization: 'Bearer nonsense' }))).status, 200);
    }, { password: 'Portis8head', settings });
  }

  // No password at all: home is in, the internet is locked out until there is one.
  await withServer(async ({ base }) => {
    assert.equal((await get(base, via('192.168.0.5'))).status, 200);
    const outside = await get(base, via('203.0.113.7'));
    assert.equal(outside.status, 403);
    assert.match((await outside.json()).error, /has no password/);
  }, { settings: { level: 3 } });

  // Below level 3 nothing changes: a password set is asked of home too.
  await withServer(async ({ base }) => {
    assert.equal((await get(base, via('192.168.0.5'))).status, 401);
    assert.equal((await (await get(base, via('192.168.0.5'), '/api/hello')).json()).password, true);
  }, { password: '4711', settings: { level: 2 } });

  // Without a proxy: a private address is home, unless it is a proxy of ours
  // that says nothing of who called.
  const { createHttpServer } = require('../src/http');
  const dirs = tempDirs();
  const config = configMod.open({ home: dirs.home, music: dirs.music });
  config.set({ level: 3, password: configMod.passwordEntry('Portis8head') });
  const server = createHttpServer({ config, library: { profileIds: () => [], rev: 1, snapshot: () => ({}) }, version: 'test' });
  const ask = (remoteAddress, headers = {}) => new Promise((resolve) => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method: 'GET', url: '/api/library', headers: lower, socket: { remoteAddress, localPort: 7878 }, complete: true };
    const res = {
      headersSent: false, setHeader() {}, writeHead(status) { this.status = status; }, end() { resolve(this.status); },
    };
    server.emit('request', req, res);
  });
  try {
    assert.equal(await ask('::ffff:192.168.0.5'), 200, 'a caller on the home network');
    assert.equal(await ask('::ffff:100.100.1.1'), 401, 'Tailscale is away from home');
    assert.equal(await ask('198.51.100.20'), 403, 'plain http from a public address');
    config.set({ trustedProxies: ['192.168.0.9'] });
    assert.equal(await ask('192.168.0.9'), 401, 'a trusted proxy that named no caller');
    assert.equal(await ask('192.168.0.9', via('192.168.0.5')), 200, 'a trusted proxy that named a caller from home');
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('a password set from the command line while the server runs takes effect, and is not written back over', async () => {
  const { spawnSync } = require('child_process');
  await withServer(async ({ base, server, dirs }) => {
    const login = (password) => fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password, device: 'pc' }) });
    const { token } = await (await login('Portis8head')).json();
    assert.equal((await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);

    const run = spawnSync(process.execPath, [path.join(__dirname, '../src/main.js'), 'set-password', 'Teardrop9ml'], {
      env: { ...process.env, FLOW_SERVER_HOME: dirs.home, FLOW_SERVER_MUSIC: dirs.music }, encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    // The running server notices within a moment: the new one in, the old one out, every device out.
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await fetch(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` } })).status, 401);
    // Its own writes (a new token) do not bring the old password back.
    const fresh = await login('Teardrop9ml');
    assert.equal(fresh.status, 200);
    assert.equal((await login('Portis8head')).status, 401);
    const saved = JSON.parse(fs.readFileSync(path.join(dirs.home, 'server.json'), 'utf8'));
    assert.ok(configMod.checkPassword(saved.password, 'Teardrop9ml'));
    assert.equal(configMod.checkPassword(saved.password, 'Portis8head'), false);
    assert.ok(configMod.checkPassword(server.config.get().password, 'Teardrop9ml'));
  }, { password: 'Portis8head' });
});

test('plain http straight from a public address gets no answer, unless it is a trusted proxy', async () => {
  const { createHttpServer } = require('../src/http');
  const dirs = tempDirs();
  const config = configMod.open({ home: dirs.home, music: dirs.music });
  const server = createHttpServer({ config, library: {}, version: 'test' });
  // A request as from the router's forwarded port: no real socket needed.
  const ask = (remoteAddress, headers = {}) => new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/hello', headers, socket: { remoteAddress, localPort: 7878 }, complete: true };
    const res = {
      headersSent: false,
      setHeader() {},
      writeHead(status) { this.status = status; },
      end(body) { resolve({ status: this.status, body: JSON.parse(String(body)) }); },
    };
    server.emit('request', req, res);
  });
  try {
    const direct = await ask('203.0.113.7');
    assert.equal(direct.status, 403);
    assert.match(direct.body.error, /plain http/);
    assert.equal((await ask('::ffff:192.168.0.5')).status, 200);
    // A proxy on a machine of its own, once trusted, is answered, and names its caller.
    assert.equal((await ask('198.51.100.20', via('203.0.113.7'))).status, 403);
    config.set({ trustedProxies: ['198.51.100.20'] });
    assert.equal((await ask('::ffff:198.51.100.20', via('203.0.113.7'))).status, 200);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('wrong passwords wait by the caller a trusted proxy names, and all together when there are many', async () => {
  await withServer(async ({ base }) => {
    const tryLogin = (headers, password = 'nope') => fetch(`${base}/api/login`, { method: 'POST', headers, body: JSON.stringify({ password }) });
    assert.equal((await tryLogin(via('203.0.113.7'))).status, 401);
    assert.equal((await tryLogin(via('203.0.113.7'))).status, 429);
    // Another caller behind the same proxy is not held back by that one.
    assert.equal((await tryLogin(via('203.0.113.8'))).status, 401);
    // What the caller wrote in front of the proxy's own entry is not believed.
    assert.equal((await tryLogin(via('198.51.100.1, 203.0.113.7'))).status, 429);

    // Thirty wrong tries from thirty addresses: the next one waits, from anywhere.
    for (let i = 10; i < 38; i += 1) assert.equal((await tryLogin(via(`198.51.100.${i}`))).status, 401);
    const held = await tryLogin(via('198.51.100.99'), 'Portis8head');
    assert.equal(held.status, 429);
    assert.match((await held.json()).error, /on this server lately/);
  }, { password: 'Portis8head' });
});

test('the command line keeps a strong password from level 3 on', () => {
  const { spawnSync } = require('child_process');
  const dirs = tempDirs();
  const main = path.join(__dirname, '..', 'src', 'main.js');
  const run = (...args) => {
    const r = spawnSync(process.execPath, [main, '--home', dirs.home, '--music', dirs.music, ...args], { encoding: 'utf8', timeout: 20000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const saved = () => JSON.parse(fs.readFileSync(path.join(dirs.home, 'server.json'), 'utf8'));
  try {
    assert.equal(run('set-password', '471').code, 1, 'a PIN has 4 or more');
    assert.equal(run('set-password', '4711').code, 0);
    assert.equal(saved().password.strong, false);

    let r = run('--level', '3', 'devices');
    assert.equal(r.code, 1);
    assert.match(r.out, /needs a strong password first/);
    assert.equal(saved().level, null, 'nothing changed');

    r = run('set-password', '--level', '3', 'portishead');
    assert.equal(r.code, 1);
    assert.match(r.out, /an upper-case letter and a number/);
    assert.equal(run('set-password', '--level', '3', '--public-url', 'https://music.example.com', 'Portis8head').code, 0);
    assert.equal(saved().level, 3);
    assert.equal(saved().password.strong, true);
    assert.equal(saved().publicUrl, 'https://music.example.com');

    r = run('clear-password');
    assert.equal(r.code, 1);
    assert.match(r.out, /keeps a password/);
    assert.match(run('set-password', '4711').out, /needs a password with/);
    assert.equal(run('--public-url', 'http://music.example.com', 'devices').code, 1, 'https only');

    // Down to level 2: a PIN is fine again.
    assert.equal(run('--level', '2', 'set-password', '4711').code, 0);
    assert.equal(run('clear-password').code, 0);
    r = run('info');
    assert.match(r.out, /^level=2$/m);
    assert.match(r.out, /^password=none$/m);
    assert.match(r.out, /^public_url=https:\/\/music\.example\.com$/m);
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
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

test('playlists shared by a profile reach the others, with the owner\'s name, and follows are kept', async () => {
  await withServer(async ({ base, server }) => {
    await upload(base, 's1', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 });
    const anna = (await post(base, '/api/profiles', { name: 'Anna', device: 'pc' })).json;
    const ben = (await post(base, '/api/profiles', { name: 'Ben', device: 'phone' })).json;
    const as = (t) => ({ Authorization: `Bearer ${t}` });
    await command(base, [
      { cid: 'a1', at: Date.now(), type: 'createPlaylist', playlistId: 'pa', name: 'Evening' },
      { cid: 'a2', at: Date.now(), type: 'addSongsToPlaylist', playlistId: 'pa', songIds: ['s1'] },
      { cid: 'a3', at: Date.now(), type: 'setPlaylistShared', playlistId: 'pa', shared: true },
    ], as(anna.token));

    let lib = (await get(base, '/api/library', ben.token)).json.library;
    assert.deepEqual(lib.sharedPlaylists.map((p) => [p.id, p.ownerName]), [['pa', 'Anna']]);
    assert.deepEqual(lib.sharedPlaylists[0].entries.map((e) => e.songId), ['s1']);
    assert.equal((await get(base, '/api/library', anna.token)).json.library.sharedPlaylists.length, 0, 'not her own');

    const r = await command(base, [
      { cid: 'b1', at: Date.now(), type: 'followPlaylist', playlistId: 'pa' },
    ], as(ben.token));
    assert.equal(r.results[0].ok, true);
    assert.deepEqual((await get(base, '/api/library', ben.token)).json.library.follows, ['pa']);
    const own = await command(base, [{ cid: 'a4', at: Date.now(), type: 'followPlaylist', playlistId: 'pa' }], as(anna.token));
    assert.equal(own.results[0].ok, false, 'not your own');
    const stranger = await command(base, [{ cid: 'b2', at: Date.now(), type: 'renamePlaylist', playlistId: 'pa', name: 'Mine' }], as(ben.token));
    assert.equal(stranger.results[0].skipped, 'gone', 'only the owner changes it');

    // A rename reaches the others: the revision moves on.
    const rev = server.library.rev;
    await post(base, '/api/profiles/rename', { name: 'Anna B' }, anna.token);
    assert.ok(server.library.rev > rev);
    lib = (await get(base, '/api/library', ben.token)).json.library;
    assert.equal(lib.sharedPlaylists[0].ownerName, 'Anna B');

    // All of it is kept over a restart of the library file.
    const saved = JSON.parse(fs.readFileSync(server.library.file || path.join(server.config.home, 'library.json'), 'utf8'));
    assert.deepEqual(saved.profiles[ben.profile.id].follows, ['pa']);
    assert.equal(saved.profiles[anna.profile.id].playlists[0].shared, true);
  });
});

test('a playlist deleted with its songs keeps those another playlist or profile still has', async () => {
  await withServer(async ({ base, dirs }) => {
    const names = ['Teardrop', 'Roads', 'Glory Box', 'Angel', 'Unfinished Sympathy'];
    for (let i = 0; i < names.length; i += 1) await upload(base, `s${i + 1}`, { title: names[i], artist: 'Massive Attack', format: 'mp3' });
    const anna = (await post(base, '/api/profiles', { name: 'Anna', device: 'pc' })).json;
    const ben = (await post(base, '/api/profiles', { name: 'Ben', device: 'phone' })).json;
    const as = (t) => ({ Authorization: `Bearer ${t}` });
    const t = Date.now();
    await command(base, [
      { cid: 'a1', at: t, type: 'createPlaylist', playlistId: 'pa', name: 'Evening' },
      { cid: 'a2', at: t, type: 'addSongsToPlaylist', playlistId: 'pa', songIds: ['s1', 's2', 's3', 's4'] },
      { cid: 'a3', at: t, type: 'createPlaylist', playlistId: 'pb', name: 'Morning' },
      { cid: 'a4', at: t, type: 'addSongsToPlaylist', playlistId: 'pb', songIds: ['s2'] },
    ], as(anna.token));
    await command(base, [
      { cid: 'b1', at: t, type: 'createPlaylist', playlistId: 'pc', name: 'Mine' },
      { cid: 'b2', at: t, type: 'addSongsToPlaylist', playlistId: 'pc', songIds: ['s3'] },
      { cid: 'b3', at: t, type: 'setFavourite', songId: 's4', on: true },
    ], as(ben.token));

    // Without the box ticked the songs stay.
    const keep = await command(base, [{ cid: 'a5', at: t + 1, type: 'deletePlaylist', playlistId: 'pb' }], as(anna.token));
    assert.equal(keep.results[0].deletedSongs, undefined);
    // s2 was only in Anna's two lists now: still kept, as pb went without its songs.
    await command(base, [{ cid: 'a6', at: t + 1, type: 'addSongsToPlaylist', playlistId: 'pa', songIds: ['s5'] }], as(anna.token));
    await command(base, [{ cid: 'd1', at: t + 1, type: 'createPlaylist', playlistId: 'pd', name: 'Shared' },
      { cid: 'd2', at: t + 1, type: 'addSongsToPlaylist', playlistId: 'pd', songIds: ['s5'] }]);

    const r = await command(base, [{ cid: 'a7', at: t + 2, type: 'deletePlaylist', playlistId: 'pa', deleteSongs: true }], as(anna.token));
    // s3 is in Ben's playlist, s4 one of his favourites, s5 in the Default / Shared one.
    assert.deepEqual(r.results[0].deletedSongs.sort(), ['s1', 's2']);
    const lib = (await get(base, '/api/library', ben.token)).json.library;
    assert.deepEqual(lib.songs.map((s) => s.id).sort(), ['s3', 's4', 's5']);
    assert.equal(fs.readdirSync(path.join(dirs.music, '.flow-trash')).length, 2);
  });
});
