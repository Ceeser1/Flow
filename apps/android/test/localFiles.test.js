'use strict';

// Songs of the phone's own (src/localFiles.js) against a stand-in phone: the
// picked files listed, copied into the cache with their names and pictures,
// then saved whole into Local Files (with a playlist), and with a Flow Server
// handed on to go up.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('@flow/core/libraryModel');
const { createLocalFiles } = require('../src/localFiles');

const CACHE = '/data/cache';
const MUSIC = '/data/files/Music';

function setup({ serverOn = false, serverSongs = [] } = {}) {
  const files = new Map(); // path -> bytes (a string)
  const path = {
    join: (...p) => p.join('/').replace(/\/{2,}/g, '/'),
    dirname: (p) => p.slice(0, p.lastIndexOf('/')),
    extname: (p) => {
      const name = p.slice(p.lastIndexOf('/') + 1);
      return name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '';
    },
  };
  const fs = {
    exists: (p) => files.has(p),
    remove: (p) => files.delete(p),
    mkdir: () => {},
    rename: (a, b) => {
      if (!files.has(a)) throw new Error(`no ${a}`);
      files.set(b, files.get(a));
      files.delete(a);
    },
  };
  // What the phone's picker and Android's tags give for each picked file.
  const phone = {
    'content://a/1': { name: 'Moby - Porcelain.mp3', tags: { title: '', artist: '' }, duration: 241.5, picture: true },
    'content://a/2': { name: 'track02.flac', tags: { title: 'Teardrop', artist: 'Massive Attack' }, duration: 330.2, picture: false },
    'content://a/3': { name: 'broken.ogg', fail: 'This file has no audio in it.' },
  };
  const plugin = {
    pickAudio: async ({ folder }) => ({
      items: Object.entries(phone).map(([uri, f]) => ({ uri, name: f.name, size: 100 })),
      name: folder ? 'Music' : '',
      truncated: false,
    }),
    importAudio: async ({ uri, stem, cover }) => {
      const f = phone[uri];
      if (f.fail) throw new Error(f.fail);
      const ext = f.name.split('.').pop();
      files.set(`${stem}.${ext}`, `audio of ${uri}`);
      if (f.picture) files.set(cover, 'jpeg');
      return { path: `${stem}.${ext}`, format: ext, ...f.tags, album: '', duration: f.duration, cover: !!f.picture, bytes: 100 };
    },
  };
  let data = model.emptyLibrary();
  let ids = 0;
  const library = {
    get: () => data,
    mutate: (fn) => fn(data),
    newId: () => `id${(ids += 1)}`,
  };
  const coverStore = new Map();
  const told = [];
  const covers = {
    LOCAL: 'local',
    localStore: () => ({
      take: (id, file) => {
        fs.rename(file, `/data/files/Covers/local/${id}.jpg`);
        coverStore.set(id, 'abcd12');
        return 'abcd12';
      },
    }),
    tell: (scope, list) => told.push([scope, ...list]),
  };
  const exporter = {
    uniquePath: (stem, ext) => {
      let dest = `${MUSIC}/${stem}.${ext}`;
      for (let n = 2; files.has(dest); n += 1) dest = `${MUSIC}/${stem} (${n}).${ext}`;
      return dest;
    },
  };
  const pushed = [];
  const remote = { active: () => serverOn, pushImport: (x) => pushed.push(x), view: () => ({ songs: serverSongs }) };
  const events = [];
  const stagedSeen = [];
  const local = createLocalFiles({
    plugin, fs, path, stageDir: CACHE, library, covers, exporter, remote,
    progress: (p, run) => events.push({ ...p, run }),
    onStaged: (s) => stagedSeen.push(s),
  });
  return { local, files, events, stagedSeen, pushed, told, coverStore, data: () => data };
}

/** Picks, lists and prepares every file; the window's ready items as import.js keeps them. */
async function prepared(t, folder = false) {
  const picked = await t.local.pick(folder);
  const listing = t.local.listLocal(picked);
  const summary = await t.local.prepareLocal(listing.items, 7);
  const ready = t.events.filter((e) => e.phase === 'item' && e.status === 'ready');
  return { listing, summary, ready };
}

function entryOf(it) {
  return {
    position: it.index, cachePath: it.media.path, start: 0, end: it.media.duration, duration: it.media.duration, meta: it.song.meta, sourceUrl: '', sourceKey: '',
  };
}

test('picked files: listed, prepared with their names and picture, a broken one failed', async () => {
  const t = setup();
  const { listing, summary, ready } = await prepared(t);
  assert.equal(listing.local, true);
  assert.equal(listing.name, '3 files');
  assert.deepEqual(listing.items.map((i) => i.title), ['Moby - Porcelain.mp3', 'track02.flac', 'broken.ogg']);
  assert.deepEqual(summary, { ready: 2, fromLibrary: 0, failed: 1, cancelled: false });
  // Names from the tags, else from the file's name.
  assert.deepEqual(ready.map((e) => e.song.meta), [
    { artist: 'Moby', title: 'Porcelain', mix: '' },
    { artist: 'Massive Attack', title: 'Teardrop', mix: '' },
  ]);
  assert.ok(ready.every((e) => e.run === 7 && e.media.local && e.media.path.startsWith(`${CACHE}/local-`)));
  assert.equal(ready[0].media.duration, 241.5);
  const failed = t.events.find((e) => e.status === 'failed');
  assert.equal(failed.reason, 'This file has no audio in it.');
  // The picture of the first is staged for the window.
  assert.equal(t.stagedSeen.length, 1);
  assert.equal(t.stagedSeen[0].cachePath, ready[0].media.path);
  assert.deepEqual(t.local.stagedCover(ready[0].media.path), t.stagedSeen[0]);
});

test('a file that is a library song already is not copied again', async () => {
  const t = setup();
  t.data().songs.push({ id: 'have1', artist: 'moby', title: 'Porcelain', mix: '', duration: 241, file: '/x.mp3' });
  const { summary, ready } = await prepared(t);
  assert.equal(summary.fromLibrary, 1);
  assert.deepEqual(ready.map((e) => e.song.meta.title), ['Teardrop']);
  assert.ok(t.events.some((e) => e.status === 'library' && e.existingId === 'have1'));
  // Its copy and picture are gone again.
  assert.equal([...t.files.keys()].filter((p) => p.startsWith(CACHE)).length, 1);
});

test('with a server, its library is the one looked in', async () => {
  const t = setup({ serverOn: true, serverSongs: [{ id: 'srv1', artist: 'Massive Attack', title: 'Teardrop', mix: '', duration: 330 }] });
  const { summary } = await prepared(t);
  assert.equal(summary.fromLibrary, 1);
  assert.ok(t.events.some((e) => e.status === 'library' && e.existingId === 'srv1'));
});

test('a folder is listed under its name', async () => {
  const t = setup();
  const { listing } = await prepared(t, true);
  assert.equal(listing.name, 'Music');
});

test('Finish all: saved whole into the Music folder and Local Files, with the playlist and the cover', async () => {
  const t = setup();
  const { ready } = await prepared(t);
  const job = { local: true, playlist: true, name: 'From the phone', source: null, base: 1000000, playlistIds: [], entries: ready.map(entryOf) };
  const progress = [];
  const summary = t.local.finish(job, (p) => progress.push(p));
  assert.equal(summary.saved, 2);
  assert.deepEqual(summary.failed, []);
  const d = t.data();
  assert.deepEqual(d.songs.map((s) => [s.artist, s.title, s.file, s.format, s.duration]), [
    ['Moby', 'Porcelain', `${MUSIC}/Moby - Porcelain.mp3`, 'mp3', 241.5],
    ['Massive Attack', 'Teardrop', `${MUSIC}/Massive Attack - Teardrop.flac`, 'flac', 330.2],
  ]);
  // Moved out of the cache, not copied.
  assert.equal([...t.files.keys()].filter((p) => p.startsWith(CACHE)).length, 0);
  assert.equal(t.files.get(`${MUSIC}/Moby - Porcelain.mp3`), 'audio of content://a/1');
  // The picture became its cover.
  const moby = d.songs[0];
  assert.equal(moby.cover, 'abcd12');
  assert.deepEqual(t.told, [['local', moby.id]]);
  assert.ok(t.files.has(`/data/files/Covers/local/${moby.id}.jpg`));
  const p = d.playlists.find((x) => x.id === summary.playlistId);
  assert.equal(p.name, 'From the phone');
  assert.deepEqual(p.entries.map((e) => e.songId), summary.songIds);
  assert.deepEqual(progress.map((x) => x.number), [1, 2]);
  assert.deepEqual(t.pushed, []);
});

test('with a Flow Server the saved songs are handed on to go up', async () => {
  const t = setup({ serverOn: true });
  const { ready } = await prepared(t);
  const job = { local: true, playlist: false, name: 'x', base: 1000000, playlistIds: ['server-list'], entries: ready.map(entryOf) };
  const summary = t.local.finish(job, () => {});
  assert.equal(summary.saved, 2);
  assert.equal(t.pushed.length, 1);
  assert.deepEqual(t.pushed[0].songIds, summary.songIds);
  assert.deepEqual(t.pushed[0].playlistIds, ['server-list']);
});

test('a file let go of is deleted from the cache, nothing outside it', async () => {
  const t = setup();
  const { ready } = await prepared(t);
  const first = ready[0].media.path;
  t.local.discard(first);
  assert.equal(t.files.has(first), false);
  assert.equal(t.local.stagedCover(first), null);
  t.files.set('/data/files/Music/keep.mp3', 'x');
  t.local.discard('/data/files/Music/keep.mp3');
  assert.equal(t.files.has('/data/files/Music/keep.mp3'), true);
});

test('cancelled while preparing: the rest is left', async () => {
  const t = setup();
  const picked = await t.local.pick(false);
  const listing = t.local.listLocal(picked);
  const running = t.local.prepareLocal(listing.items, 1);
  t.local.cancel();
  const summary = await running;
  assert.equal(summary.cancelled, true);
  assert.equal(summary.ready, 0);
  assert.equal([...t.files.keys()].filter((p) => p.startsWith(CACHE)).length, 0);
});
