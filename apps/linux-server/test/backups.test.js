'use strict';

// Backups (4.0): the server's library data and profiles once a week, the
// last 6 kept, put back by the master admin or flow-server restore.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { startServer } = require('../src/server');
const configMod = require('../src/config');

process.env.FLOW_SERVER_FFMPEG = 'off';

const FAKE_MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);
const MAIN = path.join(__dirname, '..', 'src', 'main.js');

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-backup-test-'));
  return { root, home: path.join(root, 'home'), music: path.join(root, 'music') };
}

const start = (dirs) => startServer({
  home: dirs.home, music: dirs.music, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null,
});

async function call(base, route, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${base}${route}`, body === undefined ? { headers } : { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: r.status, json: r.status === 204 ? null : await r.json() };
}

async function upload(base, id, meta, token) {
  const r = await fetch(`${base}/api/songs/${id}?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
    method: 'PUT', body: FAKE_MP3, headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return r.json();
}

const commands = (base, list, token) => call(base, '/api/commands', {
  token, body: { commands: list.map((c, i) => ({ cid: `c${Date.now()}-${i}-${Math.random()}`, at: Date.now(), ...c })) },
});

test('a backup, changes, and the backup put back by the master admin', async () => {
  const dirs = tempDirs();
  const server = await start(dirs);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Made at the start: the library was empty.
    assert.equal(server.backups.list().length, 1);
    assert.equal(server.backups.list()[0].reason, 'weekly');

    const anna = await call(base, '/api/profiles', { body: { name: 'Anna', pin: '1234', device: 'pc' } });
    const annaId = anna.json.profile.id;
    server.config.set({ profiles: server.config.get().profiles.map((p) => (p.id === annaId ? { ...p, master: true } : p)) });
    const token = (await call(base, '/api/profiles/login', { body: { profileId: annaId, pin: '1234', device: 'pc' } })).json.token;
    // Set now: Anna's device is signed in already.
    server.config.set({ password: configMod.passwordEntry('Secret12') });
    await upload(base, 'aaa111', { title: 'Porcelain', artist: 'Moby', format: 'mp3', duration: 240 }, token);
    await upload(base, 'bbb222', { title: 'Teardrop', artist: 'Massive Attack', format: 'mp3', duration: 330 }, token);
    await commands(base, [
      { type: 'createPlaylist', playlistId: 'pl1', name: 'Evening' },
      { type: 'addSongsToPlaylist', playlistId: 'pl1', songIds: ['aaa111', 'bbb222'] },
      { type: 'setFavourite', songId: 'bbb222', on: true },
    ], token);

    const made = await call(base, '/api/admin/backups/make', { body: {}, token });
    assert.equal(made.status, 200);
    assert.deepEqual([made.json.backup.songs, made.json.backup.playlists, made.json.backup.profiles, made.json.backup.reason], [2, 1, 1, 'manual']);
    // Only the data: no password, no tokens, no addresses.
    const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dirs.home, 'backups', made.json.backup.name))).toString('utf8'));
    assert.equal(doc.kind, 'server');
    assert.deepEqual(Object.keys(doc.profiles[0]).sort(), ['admin', 'createdAt', 'disabled', 'id', 'master', 'name', 'pin']);
    const text = JSON.stringify(doc);
    assert.ok(!text.includes(server.config.get().password.hash), 'never the password');
    assert.ok(!text.includes('"tokens"'));
    assert.equal(doc.library.profiles[annaId].playlists[0].name, 'Evening');

    // Since: Teardrop deleted (its file to the trash), Porcelain renamed, the
    // playlist gone, Ben made, a new song.
    await commands(base, [
      { type: 'deleteSong', songId: 'bbb222' },
      { type: 'editSong', songId: 'aaa111', artist: 'Moby', title: 'Natural Blues' },
      { type: 'deletePlaylist', playlistId: 'pl1' },
    ], token);
    await call(base, '/api/profiles', { body: { name: 'Ben', device: 'phone' }, token });
    await upload(base, 'ccc333', { title: 'Angel', artist: 'Massive Attack', format: 'mp3', duration: 380 }, token);
    assert.ok(fs.existsSync(path.join(dirs.music, 'Moby - Natural Blues.mp3')));
    assert.ok(!fs.existsSync(path.join(dirs.music, 'Massive Attack - Teardrop.mp3')));

    // An admin who is not the master may back up, not restore.
    const ben = server.config.get().profiles.find((p) => p.name === 'Ben');
    server.config.set({ profiles: server.config.get().profiles.map((p) => (p.id === ben.id ? { ...p, admin: true, pin: configMod.pinEntry('5555') } : p)) });
    const benToken = (await call(base, '/api/profiles/login', { body: { profileId: ben.id, pin: '5555', device: 'phone' }, token })).json.token;
    assert.equal((await call(base, '/api/admin/backups', { token: benToken })).status, 200);
    const refused = await call(base, '/api/admin/backups/restore', { body: { name: made.json.backup.name }, token: benToken });
    assert.equal(refused.status, 403);

    const r = await call(base, '/api/admin/backups/restore', { body: { name: made.json.backup.name }, token });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.songs, r.json.back, r.json.kept, r.json.missing, r.json.profiles], [3, 1, 1, 0, 1]);
    const lib = (await call(base, '/api/library', { token })).json.library;
    const byId = Object.fromEntries(lib.songs.map((s) => [s.id, s]));
    assert.equal(byId.aaa111.title, 'Porcelain', 'its name as it was');
    assert.equal(byId.aaa111.file, 'Moby - Natural Blues.mp3', 'its file as it is');
    assert.equal(byId.bbb222.file, 'Massive Attack - Teardrop.mp3', 'back from the trash');
    assert.ok(fs.existsSync(path.join(dirs.music, 'Massive Attack - Teardrop.mp3')));
    assert.ok(byId.ccc333, 'the song from since stays');
    const evening = lib.playlists.find((p) => p.name === 'Evening');
    assert.deepEqual(evening.entries.map((e) => e.songId), ['aaa111', 'bbb222']);
    assert.ok(byId.bbb222.favouriteAt, 'its favourite back');
    // Ben, made since, stays; Anna is still the master.
    assert.deepEqual(server.config.get().profiles.map((p) => [p.name, p.master]), [['Anna', true], ['Ben', false]]);
    assert.ok(server.config.get().password, 'the password stays');
    assert.equal(server.library.trashList().length, 0);
    // What was there before the restore was backed up first.
    const list = (await call(base, '/api/admin/backups', { token })).json;
    assert.equal(list.keep, 6);
    assert.deepEqual(list.backups.map((b) => b.reason), ['restore', 'manual', 'weekly']);
    assert.equal(list.backups[0].songs, 2);
    assert.equal((await call(base, '/api/admin/backups/restore', { body: { name: '../server.json' }, token })).status, 404);
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('flow-server backup, backups and restore, the last taken by the running server', async () => {
  const dirs = tempDirs();
  const env = {
    ...process.env, FLOW_SERVER_HOME: dirs.home, FLOW_SERVER_MUSIC: dirs.music, FLOW_SERVER_FFMPEG: 'off',
  };
  const cli = (...args) => execFileSync(process.execPath, [MAIN, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const server = await start(dirs);
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await upload(base, 'aaa111', { title: 'Porcelain', artist: 'Moby', format: 'mp3', duration: 240 });
    await commands(base, [{ type: 'createPlaylist', playlistId: 'pl1', name: 'Evening' }]);
    const out = cli('backup');
    assert.match(out, /1 songs, 1 playlists, 0 profiles/);
    const listed = cli('backups').trim().split('\n');
    assert.equal(listed.length, 2);
    assert.match(listed[0], /manual/);
    const name = listed[0].split(/\s+/)[0];
    await commands(base, [{ type: 'deletePlaylist', playlistId: 'pl1' }]);
    assert.match(cli('restore', name), /within a few seconds/);
    await new Promise((resolve) => setTimeout(resolve, 6500));
    assert.equal(server.config.get().restoreRequest, '');
    assert.deepEqual(server.library.data.playlists.map((p) => p.name), ['Evening']);
    assert.throws(() => cli('restore', 'flow-backup-20200101-000000.json.gz'), /no backup called/);
  } finally {
    await server.close();
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
