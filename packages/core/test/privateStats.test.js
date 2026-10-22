'use strict';

// The app's Private Statistics (src/client/privateStats): every listen heard
// on this device, whatever library it was from; and the Jam member's flag
// that keeps a listen out of the server's Default / Shared.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/libraryModel');
const { createActions } = require('../src/client/actions');
const { createLocalLibrary } = require('../src/client/localLibrary');
const { createPrivateStats, cleanPrivate, songKey, FILE } = require('../src/client/privateStats');

function memoryFiles(start = {}) {
  const files = { ...start };
  return {
    files,
    read: (name) => (files[name] ? JSON.parse(JSON.stringify(files[name])) : null),
    write: (name, value) => {
      files[name] = JSON.parse(JSON.stringify(value));
    },
  };
}

test('Private starts once, counts listens of 5 s or more, by month and by song names', () => {
  const jsonFiles = memoryFiles();
  const seen = [];
  const p = createPrivateStats({ jsonFiles, deviceId: () => 'device-1234', onChange: (d) => seen.push(d) });
  const started = p.get().since;
  assert.ok(started > 0);
  assert.equal(jsonFiles.files[FILE].device, 'device-1234');
  const song = { artist: 'Portishead', title: 'Roads', duration: 300 };
  assert.equal(p.recordListen({ song, listened: 4, duration: 300 }), false);
  const at = Date.parse('2026-10-20T20:00:00Z');
  p.recordListen({ song, listened: 20, duration: 300, at, tz: 0 });
  p.recordListen({
    song: { ...song, title: 'roads ' }, listened: 400, duration: 300, at, tz: 0,
  });
  const d = p.get();
  assert.deepEqual([d.seconds, d.listens], [320, 1], 'at most the song, and 30 s or more is a listen');
  assert.deepEqual(d.months, { '2026-10': 320 });
  assert.deepEqual(d.songs[songKey('Portishead', 'Roads')], {
    artist: 'Portishead', title: 'roads ', seconds: 320, listens: 1,
  });
  p.added(3);
  p.added(0);
  assert.equal(p.get().added, 3);
  assert.ok(seen.length >= 3);

  // Read back by a new start: the same, its start kept.
  const again = createPrivateStats({ jsonFiles, deviceId: () => 'other' });
  assert.equal(again.get().since, started);
  assert.equal(again.get().device, 'device-1234', 'the device id stays as written');
  assert.equal(again.get().seconds, 320);
  assert.equal(cleanPrivate({ songs: { bad: { seconds: 5 } }, added: -2 }).added, 0);
});

test('a listen counts for Private wherever it was; a Jam member says so to the server', () => {
  const library = createLocalLibrary({ read: () => null, write: () => {} });
  const view = model.emptyLibrary();
  model.addSong(view, {
    id: 'v1', file: 'v1.mp3', title: 'Glory Box', artist: 'Portishead', duration: 300, format: 'mp3', addedAt: 1,
  });
  const commands = [];
  let active = true;
  const remote = {
    active: () => active,
    view: () => view,
    command: (type, args) => commands.push({ type, ...args }),
  };
  const privateStats = createPrivateStats({ jsonFiles: memoryFiles() });
  const actions = createActions({
    remote, library, files: {}, privateStats,
  });
  actions.recordListen({ songId: 'v1', listened: 100, duration: 300 });
  actions.recordListen({
    songId: 'v1', listened: 100, duration: 300, jamMember: true,
  });
  assert.deepEqual(commands.map((c) => c.jamMember), [undefined, true]);
  assert.equal(privateStats.get().seconds, 200, 'a Jam member hears it too');

  // Local Files.
  active = false;
  library.mutate((d) => model.addSong(d, {
    id: 'l1', file: 'l1.mp3', title: 'Angel', artist: 'Massive Attack', duration: 200, format: 'mp3', addedAt: 1,
  }));
  actions.recordListen({ songId: 'l1', listened: 60, duration: 200 });
  assert.equal(privateStats.get().seconds, 260);
  assert.equal(model.songById(library.get(), 'l1').stats.stops, 1);
  // A song gone: nothing anywhere.
  assert.equal(actions.recordListen({ songId: 'gone', listened: 60, duration: 200 }), null);
  assert.equal(privateStats.get().seconds, 260);
});

test('tracked profiles: one row per server and profile, the one online last first, removed by hand', () => {
  const { createTrackedProfiles, FILE: TRACKED } = require('../src/client/trackedProfiles');
  const jsonFiles = memoryFiles();
  const t = createTrackedProfiles({ jsonFiles });
  const stats = (seconds) => ({ since: 5, seconds, listens: 1, months: { '2026-10': seconds } });
  const row = (serverId, profileId, seconds) => ({
    serverId, serverName: `Server ${serverId}`, profileId, profileName: `P ${profileId}`, createdAt: 3, statistics: stats(seconds), addedSongs: 2, supported: true,
  });
  assert.equal(t.update(row('aaa111', 'anna', 100), { online: true, now: 1000 }), true);
  assert.equal(t.update(row('bbb222', 'ben', 50), { online: true, now: 2000 }), true);
  assert.deepEqual(t.list().map((r) => r.profileId), ['ben', 'anna']);
  // Nothing new: not written again; offline numbers do not move it up.
  assert.equal(t.update(row('bbb222', 'ben', 50), { online: true, now: 2500 }), false);
  assert.equal(t.update(row('aaa111', 'anna', 160), { now: 3000 }), true);
  assert.deepEqual(t.list().map((r) => [r.profileId, r.statistics.seconds, r.connectedAt]), [['ben', 50, 2000], ['anna', 160, 1000]]);
  assert.equal(t.update({ ...row('x', 'bad id!', 1) }), false);
  // Read back by a new start.
  const again = createTrackedProfiles({ jsonFiles });
  assert.deepEqual(again.list(), t.list());
  assert.equal(again.remove('aaa111', 'anna'), true);
  assert.equal(again.remove('aaa111', 'anna'), false);
  assert.deepEqual(jsonFiles.files[TRACKED].rows.map((r) => r.profileId), ['ben']);
  // A copy: changing it changes nothing kept.
  again.list()[0].statistics.months['2026-10'] = 0;
  assert.equal(again.list()[0].statistics.months['2026-10'], 50);
});
