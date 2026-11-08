'use strict';

// 4.3: the library as what changed since an app's copy, the stats apart from
// it, Favourites as playlists, and the changes pushed on the live channel
// (library.js changes / statsChanges, push.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { startServer } = require('../src/server');
const { connect } = require('../testing/liveClient');

process.env.FLOW_SERVER_FFMPEG = 'off';

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);

async function withServer(fn, { prepare } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-sync-test-'));
  const dirs = { root, home: path.join(root, 'home'), music: path.join(root, 'music') };
  if (prepare) prepare(dirs);
  const server = await startServer({
    home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, pushDelayMs: 20,
  });
  try {
    await fn({ server, base: `http://127.0.0.1:${server.port}`, dirs });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const as = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

async function get(base, route, token) {
  const r = await fetch(`${base}${route}`, { headers: as(token) });
  return { status: r.status, json: r.status === 204 ? null : await r.json() };
}

async function post(base, route, body, token) {
  const r = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...as(token) }, body: JSON.stringify(body) });
  return r.json();
}

async function upload(base, id, meta, token) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, { method: 'PUT', body: FAKE_MP3, headers: as(token) });
  return r.json();
}

let cids = 0;
const cmd = (type, args) => ({
  cid: `c${(cids += 1)}`, at: Date.now(), type, ...args,
});

test('a listen moves only the stats; what changed comes as itself, the rest of the library not', async () => {
  await withServer(async ({ base, server }) => {
    await upload(base, 's1', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 300 });
    await upload(base, 's2', { title: 'Roads', artist: 'Portishead', format: 'mp3', duration: 300 });
    const anna = await post(base, '/api/profiles', { name: 'Anna', pin: '1111', device: 'pc' });
    const ben = await post(base, '/api/profiles', { name: 'Ben', device: 'phone' });

    const first = (await get(base, '/api/library', anna.token)).json;
    assert.equal(first.full, true);
    assert.deepEqual(first.library.songs.map((s) => s.id).sort(), ['s1', 's2']);
    assert.equal(first.library.songs[0].stats, undefined, 'no stats in the songs');
    assert.equal(first.library.songs[0].favouriteAt, undefined, 'nor stars');
    assert.equal(first.library.songs[0].tagged, undefined);
    assert.deepEqual(first.library.playlists.map((p) => [p.id, !!p.favourites]), [[`fav-${anna.profile.id}`, true]], 'her Favourites');
    const rev = first.rev;
    assert.equal((await get(base, `/api/library?since=${rev}&as=${anna.profile.id}`, anna.token)).status, 204);

    // A listen: the library stays, her stats move.
    const s0 = (await get(base, '/api/stats', anna.token)).json;
    assert.deepEqual([s0.full, s0.songs], [true, {}]);
    const r = await post(base, '/api/commands', { commands: [cmd('recordListen', { songId: 's1', listened: 300, duration: 300 })], rev, srev: s0.rev }, anna.token);
    assert.equal(r.rev, rev, 'a listen does not move the library');
    assert.equal(r.changes, undefined);
    assert.deepEqual([r.stats.from, r.stats.rev, r.stats.songs.s1.plays], [s0.rev, s0.rev + 1, 1], 'the answer carries the song\'s stats');
    assert.equal((await get(base, `/api/library?since=${rev}&as=${anna.profile.id}`, anna.token)).status, 204);
    const since = (await get(base, `/api/stats?since=${s0.rev}`, anna.token)).json;
    assert.deepEqual([since.full, Object.keys(since.songs)], [false, ['s1']]);
    assert.equal((await get(base, '/api/stats', ben.token)).json.songs.s1, undefined, "Ben's are his");

    // A star is Favourites: a change of her own playlist, the song itself unchanged.
    const starred = await post(base, '/api/commands', { commands: [cmd('setFavourite', { songId: 's2', on: true })], rev }, anna.token);
    assert.equal(starred.rev, rev + 1);
    assert.deepEqual(starred.changes.songs, []);
    assert.deepEqual(starred.changes.playlists.map((p) => [p.id, p.entries.map((e) => e.songId)]), [[`fav-${anna.profile.id}`, ['s2']]]);
    // Not Ben's business: nothing for him, though the revision moved.
    assert.equal((await get(base, `/api/library?since=${rev}&as=${ben.profile.id}`, ben.token)).status, 204);

    // A rename reaches everyone as the one song; a delete as its id.
    const renamed = await post(base, '/api/commands', { commands: [cmd('editSong', { songId: 's1', artist: 'Massive Attack', title: 'Teardrop', mix: 'Live' })] }, ben.token);
    const forAnna = (await get(base, `/api/library?since=${rev + 1}&as=${anna.profile.id}`, anna.token)).json;
    assert.deepEqual([forAnna.full, forAnna.from, forAnna.rev], [false, rev + 1, renamed.rev]);
    assert.deepEqual(forAnna.songs.map((s) => [s.id, s.mix]), [['s1', 'Live']]);
    await post(base, '/api/commands', { commands: [cmd('deleteSong', { songId: 's2' })] }, ben.token);
    const gone = (await get(base, `/api/library?since=${renamed.rev}&as=${anna.profile.id}`, anna.token)).json;
    assert.deepEqual(gone.deletedSongs, ['s2']);
    assert.deepEqual(gone.playlists.map((p) => [p.id, p.entries.length]), [[`fav-${anna.profile.id}`, 0]], 'out of her Favourites too');

    // An app further back than the server remembers gets everything.
    assert.equal((await get(base, `/api/library?since=${server.library.rev + 5}&as=${anna.profile.id}`, anna.token)).json.full, true);
  });
});

test('shared playlists: details until followed, then kept in step; unshared, they go', async () => {
  await withServer(async ({ base }) => {
    await upload(base, 's1', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 300 });
    const anna = await post(base, '/api/profiles', { name: 'Anna', pin: '1111', device: 'pc' });
    const ben = await post(base, '/api/profiles', { name: 'Ben', device: 'phone' });
    const fav = `fav-${anna.profile.id}`;
    await post(base, '/api/commands', { commands: [cmd('setFavourite', { songId: 's1', on: true }), cmd('setPlaylistShared', { playlistId: fav, shared: true })] }, anna.token);
    const details = (await get(base, '/api/shared', ben.token)).json.playlists;
    assert.deepEqual(details.map((p) => [p.id, p.ownerName, !!p.favourites, p.songCount]), [[fav, 'Anna', true, 1]], 'her Favourites, shared');

    const before = (await get(base, '/api/library', ben.token)).json.rev;
    const followed = await post(base, '/api/commands', { commands: [cmd('followPlaylist', { playlistId: fav })], rev: before }, ben.token);
    assert.deepEqual(followed.changes.follows, [fav]);
    assert.deepEqual(followed.changes.sharedPlaylists.map((p) => [p.id, p.entries.length, p.ownerName]), [[fav, 1, 'Anna']]);

    // Her star taken back reaches him as the list; unshared, it goes.
    await post(base, '/api/commands', { commands: [cmd('setFavourite', { songId: 's1', on: false })] }, anna.token);
    let c = (await get(base, `/api/library?since=${followed.rev}&as=${ben.profile.id}`, ben.token)).json;
    assert.deepEqual(c.sharedPlaylists.map((p) => [p.id, p.entries.length]), [[fav, 0]]);
    await post(base, '/api/commands', { commands: [cmd('setPlaylistShared', { playlistId: fav, shared: false })] }, anna.token);
    c = (await get(base, `/api/library?since=${c.rev}&as=${ben.profile.id}`, ben.token)).json;
    assert.deepEqual([c.sharedPlaylists, c.unshared], [[], [fav]]);
  });
});

test('the live channel brings each app what changed for it, once', async () => {
  await withServer(async ({ base }) => {
    await upload(base, 's1', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 300 });
    const anna = await post(base, '/api/profiles', { name: 'Anna', pin: '1111', device: 'pc', client: 'anna-pc-1234' });
    const phone = await post(base, '/api/profiles/login', {
      profileId: anna.profile.id, pin: '1111', device: 'phone', client: 'anna-phone-1234',
    });
    const ben = await post(base, '/api/profiles', { name: 'Ben', device: 'tablet', client: 'ben-tab-1234' });
    const rev = (await get(base, '/api/library', anna.token)).json.rev;
    const srev = (await get(base, '/api/stats', anna.token)).json.rev;

    const pc = await connect(base, 'anna-pc-1234', { token: anna.token, rev, srev });
    const tel = await connect(base, 'anna-phone-1234', { token: phone.token, rev, srev });
    const tab = await connect(base, 'ben-tab-1234', { token: ben.token, rev: (await get(base, '/api/library', ben.token)).json.rev, srev: 0 });
    for (const c of [pc, tel, tab]) await c.next('hello');

    // The PC listens and stars: its answer carries it; the phone is pushed both; Ben gets nothing.
    const r = await post(base, '/api/commands', {
      commands: [cmd('recordListen', { songId: 's1', listened: 300, duration: 300 }), cmd('setFavourite', { songId: 's1', on: true })], rev, srev, client: 'anna-pc-1234',
    }, anna.token);
    assert.ok(r.changes && r.stats);
    const lib = await tel.next('library');
    assert.deepEqual([lib.from, lib.rev, lib.playlists.map((p) => p.entries.length)], [rev, r.rev, [1]]);
    const st = await tel.next('stats');
    assert.deepEqual([st.from, st.rev, st.songs.s1.plays], [srev, r.srev, 1]);
    await assert.rejects(pc.next('library', 300), /No "library"/, 'the PC had it in its answer');
    await assert.rejects(tab.next('library', 300), /No "library"/, "Ben's view did not change");

    // A rename by Ben reaches all three.
    await post(base, '/api/commands', { commands: [cmd('editSong', { songId: 's1', artist: 'Massive Attack', title: 'Angel' })], client: 'ben-tab-1234' }, ben.token);
    for (const c of [pc, tel, tab]) assert.deepEqual((await c.next('library')).songs.map((s) => s.title), ['Angel']);

    // A channel opened from an old copy is brought up to date at once.
    const late = await connect(base, 'anna-phone-1234', { token: phone.token, rev, srev });
    await late.next('hello');
    const caught = await late.next('library');
    assert.deepEqual(caught.songs.map((s) => s.title), ['Angel']);
    assert.ok((await late.next('stats')).songs.s1);
    for (const c of [pc, tab, late]) c.close();
  });
});

test('a library from before 4.3: Favourites made from the stars, every app gets everything once', async () => {
  await withServer(async ({ base, server }) => {
    const anna = server.config.get().profiles[0].id;
    const fav = (await get(base, '/api/library')).json.library.playlists.find((p) => p.favourites);
    assert.deepEqual(fav.entries.map((e) => [e.songId, e.addedAt]), [['s1', 50]], "the Default's star");
    const her = server.library.data.playlists.length;
    assert.equal(her, 1);
    const part = server.library.snapshot(anna);
    assert.deepEqual(part.playlists.find((p) => p.favourites).entries.map((e) => e.songId), ['s2', 's1'], 'hers, in star order');
    assert.equal(part.songs.find((s) => s.id === 's1').favouriteAt, 20);
    const saved = require('../src/libraryFile').readLibrary(server.config); // the file and its log (4.3.4)
    assert.deepEqual(saved.profiles[anna].songs, {}, 'the stars left the songs');
    // An app from before (rev 7) is sent everything, not "nothing new".
    const r = await get(base, '/api/library?since=7&as=');
    assert.equal(r.json.full, true);
  }, {
    prepare: (dirs) => {
      fs.mkdirSync(dirs.home, { recursive: true });
      fs.mkdirSync(dirs.music, { recursive: true });
      for (const n of ['a', 'b']) fs.writeFileSync(path.join(dirs.music, `${n}.mp3`), FAKE_MP3);
      fs.writeFileSync(path.join(dirs.home, 'server.json'), JSON.stringify({ profiles: [{ id: 'anna1', name: 'Anna', createdAt: 1 }] }));
      fs.writeFileSync(path.join(dirs.home, 'library.json'), JSON.stringify({
        songs: [
          { id: 's1', file: path.join(dirs.music, 'a.mp3'), title: 'Teardrop', format: 'mp3', favouriteAt: 50 },
          { id: 's2', file: path.join(dirs.music, 'b.mp3'), title: 'Roads', format: 'mp3' },
        ],
        profiles: { anna1: { playlists: [], songs: { s1: { favouriteAt: 20 }, s2: { favouriteAt: 10 } } } },
      }));
      fs.writeFileSync(path.join(dirs.home, 'state.json'), JSON.stringify({ rev: 7, touched: {}, seen: [] }));
    },
  });
});

test('a large answer goes compressed to an app that takes gzip', async () => {
  await withServer(async ({ base }) => {
    for (let i = 0; i < 12; i += 1) await upload(base, `s${i}`, { title: `Song ${i}`, artist: 'Massive Attack', format: 'mp3', duration: 200 + i });
    const raw = await new Promise((resolve, reject) => {
      http.get(`${base}/api/library`, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        const parts = [];
        res.on('data', (c) => parts.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(parts) }));
      }).on('error', reject);
    });
    assert.equal(raw.headers['content-encoding'], 'gzip');
    const json = JSON.parse(zlib.gunzipSync(raw.body).toString('utf8'));
    assert.equal(json.library.songs.length, 12);
    assert.ok(raw.body.length < JSON.stringify(json).length / 2);
  });
});

test('4.3.4: a change adds a line to the logs instead of writing library.json again, and a restart reads it back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-journal-test-'));
  const opts = {
    home: path.join(root, 'home'), music: path.join(root, 'music'), port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null, pushDelayMs: 20,
  };
  try {
    let server = await startServer(opts);
    let base = `http://127.0.0.1:${server.port}`;
    await upload(base, 's1', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 300 });
    await upload(base, 's2', { title: 'Roads', artist: 'Portishead', format: 'mp3', duration: 300 });
    const lib = path.join(opts.home, 'library.json');
    const wholeAt = fs.statSync(lib).mtimeMs;
    const wholeText = fs.readFileSync(lib, 'utf8');
    await new Promise((r) => setTimeout(r, 30));
    await post(base, '/api/commands', { commands: [cmd('setFavourite', { songId: 's2', on: true }), cmd('editSong', { songId: 's1', artist: 'Massive Attack', title: 'Teardrop (Live)', mix: '' }), cmd('recordListen', { songId: 's1', listened: 300, duration: 300 })] });
    assert.equal(fs.readFileSync(lib, 'utf8'), wholeText, 'library.json itself not written again');
    assert.equal(fs.statSync(lib).mtimeMs, wholeAt);
    const log = fs.readFileSync(`${lib}.log`, 'utf8').trim().split('\n');
    assert.ok(log.length >= 2, 'its changes are lines of the log');
    assert.ok(fs.existsSync(path.join(opts.home, 'state.json.log')));
    await server.close();

    server = await startServer(opts);
    base = `http://127.0.0.1:${server.port}`;
    const again = (await get(base, '/api/library')).json.library;
    assert.equal(again.songs.find((s) => s.id === 's1').title, 'Teardrop (Live)');
    assert.deepEqual(again.playlists.find((p) => p.favourites).entries.map((e) => e.songId), ['s2']);
    assert.equal((await get(base, '/api/stats')).json.songs.s1.plays, 1);
    await server.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
