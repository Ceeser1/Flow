'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const backup = require('../src/backup');
const model = require('../src/libraryModel');

const DAY = 24 * 60 * 60 * 1000;

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flow-backup-test-'));
}

test('one backup a week, the last 6 kept, the one being restored never deleted', () => {
  const dir = tempDir();
  try {
    let t = Date.UTC(2026, 9, 1, 12, 0, 0);
    let songs = 0;
    const store = backup.createBackupStore({
      dir, kind: 'app', now: () => t, collect: () => ({ library: { songs: Array.from({ length: songs }, (_, i) => ({ id: `s${i}` })), playlists: [] } }),
    });
    assert.equal(store.due(), true, 'none yet');
    const first = store.weekly();
    assert.equal(first.name, 'flow-backup-20261001-120000.json.gz');
    assert.equal(first.reason, 'weekly');
    t += 6 * DAY;
    assert.equal(store.weekly(), null, 'not a week yet');
    t += DAY;
    songs = 3;
    assert.equal(store.weekly().songs, 3);
    // A backup made by hand counts as the newest.
    t += 6 * DAY;
    store.make('manual');
    t += 2 * DAY;
    assert.equal(store.due(), false);
    for (let i = 0; i < 5; i += 1) {
      t += 7 * DAY;
      store.weekly();
    }
    const list = store.list();
    assert.equal(list.length, 6);
    assert.ok(list[0].createdAt > list[5].createdAt, 'newest first');
    assert.ok(!list.some((b) => b.name === first.name), 'the oldest went');
    // Two in the same second get numbers; the protected oldest one stays.
    const oldest = list[5].name;
    store.make('restore', oldest);
    store.make('restore', oldest);
    const names = store.list().map((b) => b.name);
    assert.equal(names.length, 6);
    assert.ok(names.includes(oldest));
    assert.ok(names.some((n) => /-2\.json\.gz$/.test(n)));
    // The file is gzip'd JSON with what the app gave.
    const doc = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, names[0]))).toString('utf8'));
    assert.equal(doc.app, 'flow-backup');
    assert.equal(doc.kind, 'app');
    assert.equal(doc.library.songs.length, 3);
    assert.deepEqual(store.read(names[0]).summary, { songs: 3, playlists: 0, profiles: 0 });
    assert.throws(() => store.read('../server.json'), /no such backup/);
    assert.throws(() => backup.unpack(Buffer.from('not gzip')), /not a Flow backup/);
    assert.throws(() => backup.unpack(backup.pack({ app: 'flow-backup', format: 99, library: {} })), /newer Flow/);
    // Files that are no backups are left alone.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(dir, 'flow-backup-20260101-000000.json.gz'), 'broken');
    assert.equal(store.list().length, 6);
    assert.ok(fs.existsSync(path.join(dir, 'notes.txt')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restore: the backup\'s names and lists, the files as they are now, songs from since kept', () => {
  const song = (id, file, extra = {}) => ({ id, file, title: id.toUpperCase(), artist: 'Moby', ...extra });
  const before = model.sanitize({
    songs: [
      song('a', '/m/a.mp3', { title: 'Porcelain', cover: 'aaaa', loudness: -9 }),
      song('b', '/m/b.mp3'),
      song('c', '/m/c.mp3', { cover: 'cccc' }),
      song('d', '/m/d.mp3'),
    ],
    playlists: [{ id: 'p1', name: 'Play', entries: [{ songId: 'a' }, { songId: 'b' }, { songId: 'c' }, { songId: 'd' }] }],
    ignoredFiles: ['/m/old.wav'],
  });
  // Since then: a renamed (its file too) and trimmed, b deleted with its file
  // (in the trash), c deleted but its file left, d deleted for good, e new,
  // the playlist gone.
  const now = model.sanitize({
    songs: [
      song('a', '/m/Moby - Natural Blues.mp3', { title: 'Natural Blues', cover: 'bbbb', cut: 'c0ffee', duration: 200 }),
      song('e', '/m/e.mp3'),
    ],
    playlists: [],
    ignoredFiles: ['/m/other.wav'],
    infoRound: 2,
  });
  const there = new Set(['/m/Moby - Natural Blues.mp3', '/m/c.mp3', '/m/e.mp3']);
  const asked = [];
  const { data, counts } = backup.mergeRestore(now, before, {
    fileExists: (f) => there.has(f),
    takeBack: (s) => {
      asked.push(s.id);
      return s.id === 'b' ? '/m/b (2).mp3' : '';
    },
  });
  assert.deepEqual(asked, ['b', 'd']);
  assert.deepEqual(data.songs.map((s) => [s.id, s.file]), [
    ['a', '/m/Moby - Natural Blues.mp3'], ['b', '/m/b (2).mp3'], ['c', '/m/c.mp3'], ['e', '/m/e.mp3'],
  ]);
  const a = data.songs[0];
  assert.equal(a.title, 'Porcelain', 'the backup\'s names');
  assert.deepEqual([a.cover, a.cut, a.duration], ['bbbb', 'c0ffee', 200], 'the file\'s fields as they are now');
  assert.equal(a.loudness, null, 'measured for the cut file');
  assert.equal(data.songs[2].cover, null, 'looked for again');
  assert.deepEqual(data.playlists[0].entries.map((e) => e.songId), ['a', 'b', 'c', 'd']);
  // Sanitized again (as the apps do): d is out of the playlist.
  assert.deepEqual(model.sanitize(data).playlists[0].entries.map((e) => e.songId), ['a', 'b', 'c']);
  assert.deepEqual(data.ignoredFiles.sort(), ['/m/old.wav', '/m/other.wav']);
  assert.equal(data.infoRound, 2);
  assert.deepEqual(counts, {
    songs: 4, back: 1, missing: 1, kept: 1,
  });
});
