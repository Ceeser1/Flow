'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { problem } = require('../src/moveMusic');

const MAIN = path.join(__dirname, '..', 'src', 'main.js');

/** A server's home and two music folders: the old one with songs, the new one with one of their names taken. */
function setUp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-move-'));
  const home = path.join(root, 'home');
  const oldDir = path.join(root, 'old music');
  const newDir = path.join(root, 'new music');
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const a = put(path.join(oldDir, 'Uploads', 'Portishead - Roads.mp3'), 'roads');
  const b = put(path.join(oldDir, 'Uploads', 'Massive Attack', 'Teardrop.opus'), 'teardrop');
  const c = put(path.join(oldDir, 'Downloads', 'Moby - Porcelain.m4a'), 'porcelain');
  const ignored = put(path.join(oldDir, 'Skipped.mp3'), 'skipped');
  put(path.join(oldDir, 'cover.jpg'), 'not a song');
  put(path.join(oldDir, '.flow-trash', '1760000000000-Bjork - Joga.mp3'), 'joga');
  // Taken in the new folder already: the moved one gets " (2)".
  put(path.join(newDir, 'Uploads', 'Portishead - Roads.mp3'), 'another roads');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'library.json'), JSON.stringify({
    version: 1,
    songs: [
      { id: 's1', file: a, title: 'Roads', artist: 'Portishead' },
      // Windows paths come in any case.
      { id: 's2', file: process.platform === 'win32' ? b.toUpperCase() : b, title: 'Teardrop', artist: 'Massive Attack' },
      { id: 's3', file: c, title: 'Porcelain', artist: 'Moby' },
      { id: 's4', file: path.join(root, 'elsewhere', 'Air - La Femme d\'Argent.mp3'), title: 'La Femme d\'Argent', artist: 'Air' },
    ],
    playlists: [{ id: 'p1', name: 'Trip', songIds: ['s1', 's2', 's3'] }],
    ignoredFiles: [ignored.toLowerCase()],
  }));
  fs.writeFileSync(path.join(home, 'trash.json'), JSON.stringify([
    { name: '1760000000000-Bjork - Joga.mp3', at: 1760000000000, by: '', song: { id: 's9', file: path.join(oldDir, 'Bjork - Joga.mp3'), title: 'Joga' }, own: {}, lists: [] },
  ]));
  return { root, home, oldDir, newDir };
}

const run = (dirs, port, ...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [MAIN, '--home', dirs.home, '--port', String(port), ...args], { env: { ...process.env, FLOW_SERVER_MUSIC: '' } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('exit', (code) => resolve({ code, out }));
});

/** A port nothing listens on. */
async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test('move-music: everything comes along, folders merged, the library follows its files', async () => {
  const dirs = setUp();
  try {
    const port = await freePort();
    // Asked before the new folder is set: what the old one holds.
    const dry = await run(dirs, port, '--music', dirs.oldDir, 'move-music', dirs.oldDir, '--dry-run');
    assert.strictEqual(dry.code, 0, dry.out);
    assert.match(dry.out, /^songs=3\r?\nfiles=6\r?$/m);
    assert.ok(fs.existsSync(path.join(dirs.oldDir, 'cover.jpg')), 'a dry run moves nothing');

    const r = await run(dirs, port, '--music', dirs.newDir, 'move-music', dirs.oldDir);
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Backed up first: flow-backup-/);
    assert.match(r.out, /Moved 6 files; 3 songs keep/);
    assert.match(r.out, /1 file was there already under that name/);

    const lib = JSON.parse(fs.readFileSync(path.join(dirs.home, 'library.json'), 'utf8'));
    const file = (id) => lib.songs.find((s) => s.id === id).file;
    assert.strictEqual(file('s1'), path.join(dirs.newDir, 'Uploads', 'Portishead - Roads (2).mp3'));
    assert.strictEqual(file('s2'), path.join(dirs.newDir, 'Uploads', 'Massive Attack', 'Teardrop.opus'));
    assert.strictEqual(file('s3'), path.join(dirs.newDir, 'Downloads', 'Moby - Porcelain.m4a'));
    assert.strictEqual(file('s4'), path.join(dirs.root, 'elsewhere', 'Air - La Femme d\'Argent.mp3'), 'a song elsewhere stays as it is');
    assert.deepStrictEqual(lib.playlists[0].songIds, ['s1', 's2', 's3']);
    assert.deepStrictEqual(lib.ignoredFiles, [path.join(dirs.newDir, 'Skipped.mp3').toLowerCase()]);
    for (const id of ['s1', 's2', 's3']) assert.ok(fs.existsSync(file(id)), id);
    assert.strictEqual(fs.readFileSync(path.join(dirs.newDir, 'Uploads', 'Portishead - Roads.mp3'), 'utf8'), 'another roads', 'the one there stays');
    assert.ok(fs.existsSync(path.join(dirs.newDir, 'cover.jpg')), 'not only songs');

    const trash = JSON.parse(fs.readFileSync(path.join(dirs.home, 'trash.json'), 'utf8'));
    assert.ok(fs.existsSync(path.join(dirs.newDir, '.flow-trash', trash[0].name)));
    assert.strictEqual(trash[0].song.file, path.join(dirs.newDir, 'Bjork - Joga.mp3'), 'restored into the new folder');

    assert.ok(!fs.existsSync(dirs.oldDir), 'the old folder, empty, is gone');
    const cfg = JSON.parse(fs.readFileSync(path.join(dirs.home, 'server.json'), 'utf8'));
    assert.strictEqual(path.resolve(cfg.musicDir), path.resolve(dirs.newDir));
  } finally {
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('move-music: not while the server runs, and not into itself', async () => {
  const dirs = setUp();
  const server = http.createServer((req, res) => res.end(JSON.stringify({ app: 'flow-server' })));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const r = await run(dirs, server.address().port, '--music', dirs.newDir, 'move-music', dirs.oldDir);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /The server is running: stop it first/);
    assert.ok(fs.existsSync(path.join(dirs.oldDir, 'cover.jpg')), 'nothing moved');
    assert.ok(!fs.existsSync(path.join(dirs.home, 'backups')) || !fs.readdirSync(path.join(dirs.home, 'backups')).length, 'no backup either');
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
  const music = path.join(os.tmpdir(), 'music');
  assert.match(problem(music, music), /music folder already/);
  assert.match(problem(music, path.join(music, 'Flow')), /is inside/);
  assert.match(problem(path.join(music, 'Old'), music), /inside the music folder/);
  assert.strictEqual(problem(path.join(music, 'Old'), path.join(music, 'New')), '');
  if (process.platform === 'win32') assert.match(problem('c:\\Users\\A\\Music', 'C:\\USERS\\A\\music'), /music folder already/);
});
