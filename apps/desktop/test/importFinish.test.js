'use strict';

// Saving an import (importer.finish): which playlists the songs go into, and
// in which order. The cut and tagging (exporter.saveSong, ffmpeg) is stood in
// for by a copy, so no tools are needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-finish-'));
process.env.FLOW_HOME = path.join(scratch, 'home');
process.env.FLOW_MUSIC = path.join(scratch, 'music');

const paths = require('../src/paths');
const exporter = require('../src/exporter');
const importer = require('../src/importer');
const library = require('../src/library');
const model = require('@flow/core/libraryModel');

library.load();
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

exporter.saveSong = async ({ cachePath, title }) => {
  const file = path.join(paths.musicDir(), `${title}.mp3`);
  fs.copyFileSync(cachePath, file);
  return { file, duration: 100, format: 'mp3' };
};

let n = 0;
function entry(title) {
  n += 1;
  const cachePath = path.join(scratch, `cache-${n}.mp3`);
  fs.writeFileSync(cachePath, 'x');
  return { cachePath, start: 0, end: 100, duration: 100, meta: { artist: 'Daft Punk', title, mix: '' }, sourceUrl: '', sourceKey: '' };
}

/** A playlist's titles as it shows them: newest first. */
function titlesOf(playlistId) {
  const d = library.get();
  const p = model.playlistById(d, playlistId);
  return [...p.entries].sort((a, b) => b.addedAt - a.addedAt).map((e) => model.songById(d, e.songId).title);
}

test('local files make no playlist unless asked, and join the playlists picked, in order', async () => {
  const picked = library.mutate((d) => model.createPlaylist(d, 'Workout', library.newId()));
  const summary = await importer.finish({
    name: 'Folder', local: true, playlistIds: [picked.id],
    entries: [entry('One'), entry('Two'), entry('Three')],
  }, () => {});
  assert.equal(summary.playlistId, null);
  assert.equal(summary.saved, 3);
  assert.equal(summary.songIds.length, 3);
  assert.ok(!library.get().playlists.some((p) => p.name === 'Folder'));
  assert.deepEqual(titlesOf(picked.id), ['One', 'Two', 'Three']);

  const asked = await importer.finish({
    name: 'My Folder', local: true, playlist: true, playlistIds: [], entries: [entry('Four')],
  }, () => {});
  assert.ok(asked.playlistId);
  assert.equal(asked.name, 'My Folder');
  assert.deepEqual(titlesOf(asked.playlistId), ['Four']);
});

test('a playlist import goes into its own playlist and the ones picked; a taken name gets a number', async () => {
  const extra = library.mutate((d) => model.createPlaylist(d, 'Favourites of 2026', library.newId()));
  library.mutate((d) => model.createPlaylist(d, 'Discovery', library.newId()));
  const summary = await importer.finish({
    name: 'Discovery', mergeInto: null, playlistIds: [extra.id], source: { url: 'https://example.com/list', kind: 'youtube' },
    entries: [entry('Harder'), entry('Digital Love')],
  }, () => {});
  assert.equal(summary.name, 'Discovery (2)');
  assert.deepEqual(titlesOf(summary.playlistId), ['Harder', 'Digital Love']);
  assert.deepEqual(titlesOf(extra.id), ['Harder', 'Digital Love']);
});
