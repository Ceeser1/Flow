'use strict';

// Collaborative playlists (5.4.0): an owner's shared playlist made a
// collaboration, others asking to join, the owner answering, members adding
// and removing songs in it from their own views, and what each profile sees.
// The commands run on a profile's view and absorb() puts them back, as the
// server does (apps/linux-server/src/library.js runCommands).

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../src/libraryModel');
const prof = require('../src/profiles');
const { applyCommand } = require('../src/commands');

const T = 1700000000000;

function server() {
  const song = (n) => ({ id: `s${n}`, file: `/music/${n}.mp3`, title: `Song ${n}`, artist: 'A', duration: 100, addedAt: T + n });
  const data = model.sanitize({ songs: [1, 2, 3, 4, 5, 6].map(song), playlists: [] });
  const profiles = {};
  prof.ensureFavourites(data, profiles);
  let n = 0;
  for (const id of ['owner', 'mia', 'ben']) prof.addProfile(data, profiles, id, () => `x${++n}`);
  return { data, profiles };
}

/** Commands of `profileId` run the way the server runs them; answers each result (or the error's message). */
function run(l, profileId, ...commands) {
  const v = prof.view(l.data, l.profiles, profileId, { owner: 'Owner', mia: 'Mia', ben: 'Ben' });
  const out = commands.map((c, i) => {
    try {
      return applyCommand(v, { at: T + 1000 + i, ...c }, null, profileId, { noProfile: !profileId });
    } catch (err) {
      return err.message;
    }
  });
  prof.absorb(l.data, l.profiles, profileId, v);
  return out;
}

const own = (l, id) => l.profiles.owner.playlists.find((p) => p.id === id);
const seen = (l, profileId, id) => prof.view(l.data, l.profiles, profileId).sharedPlaylists.find((p) => p.id === id);

function withCollab() {
  const l = server();
  run(l, 'owner',
    { type: 'createPlaylist', playlistId: 'mix', name: 'Party' },
    { type: 'addSongsToPlaylist', playlistId: 'mix', songIds: ['s1', 's2'] });
  return l;
}

test('only a shared playlist can be a collaboration, and only the owner turns it on', () => {
  const l = withCollab();
  assert.match(String(run(l, 'owner', { type: 'setPlaylistCollab', playlistId: 'mix', on: true })[0]), /Share the playlist first/);
  run(l, 'owner', { type: 'setPlaylistShared', playlistId: 'mix', shared: true }, { type: 'setPlaylistCollab', playlistId: 'mix', on: true });
  assert.deepEqual(own(l, 'mix').collab, { on: true, members: [], requests: [], counts: {} });
  // Others see it is open to join, and nothing more.
  assert.deepEqual(seen(l, 'mia', 'mix').collab, { on: true, me: '' });
  assert.deepEqual(seen(l, null, 'mix').collab, { on: true, me: '' }, 'the Default sees it, but cannot ask to join (below)');
  // Another profile has no such playlist of its own to switch.
  assert.deepEqual(run(l, 'mia', { type: 'setPlaylistCollab', playlistId: 'mix', on: false })[0], { skipped: 'gone' });
  assert.equal(own(l, 'mix').collab.on, true);
});

test('asking to join, taking it back, being declined and approved; approved means followed', () => {
  const l = withCollab();
  run(l, 'owner', { type: 'setPlaylistShared', playlistId: 'mix', shared: true }, { type: 'setPlaylistCollab', playlistId: 'mix', on: true });
  run(l, 'mia', { type: 'requestCollab', playlistId: 'mix', on: true });
  run(l, 'ben', { type: 'requestCollab', playlistId: 'mix', on: true });
  assert.deepEqual(own(l, 'mix').collab.requests, ['mia', 'ben']);
  assert.equal(seen(l, 'mia', 'mix').collab.me, 'requested');
  run(l, 'ben', { type: 'requestCollab', playlistId: 'mix', on: false });
  assert.deepEqual(own(l, 'mix').collab.requests, ['mia']);
  // A member cannot add songs yet: the playlist is not its to change.
  assert.deepEqual(run(l, 'mia', { type: 'addSongsToPlaylist', playlistId: 'mix', songIds: ['s3'] })[0], { skipped: 'gone' });
  run(l, 'ben', { type: 'requestCollab', playlistId: 'mix', on: true });
  run(l, 'owner', { type: 'answerCollab', playlistId: 'mix', profileId: 'ben', approve: false }, { type: 'answerCollab', playlistId: 'mix', profileId: 'mia', approve: true });
  assert.deepEqual(own(l, 'mix').collab.members, ['mia']);
  assert.deepEqual(own(l, 'mix').collab.requests, []);
  assert.equal(seen(l, 'ben', 'mix').collab.me, '', 'declined: may ask again');
  assert.ok(l.profiles.mia.follows.includes('mix'), 'approved: followed at once');
  assert.ok(!l.profiles.ben.follows.includes('mix'));
  assert.deepEqual(seen(l, 'mia', 'mix').collab, { on: true, me: 'member', members: [{ id: 'owner', added: 0, removed: 0 }, { id: 'mia', added: 0, removed: 0 }] });
});

test('a member adds and removes any song; who added each and the counts are kept; the owner counts too', () => {
  const l = withCollab();
  run(l, 'owner', { type: 'setPlaylistShared', playlistId: 'mix', shared: true }, { type: 'setPlaylistCollab', playlistId: 'mix', on: true });
  run(l, 'mia', { type: 'requestCollab', playlistId: 'mix', on: true });
  run(l, 'owner', { type: 'answerCollab', playlistId: 'mix', profileId: 'mia', approve: true });
  run(l, 'mia',
    { type: 'addSongsToPlaylist', playlistId: 'mix', songIds: ['s3', 's4'] },
    { type: 'addSongToPlaylists', songId: 's5', playlistIds: ['mix'] },
    { type: 'removeFromPlaylist', playlistId: 'mix', songId: 's1' });
  const p = own(l, 'mix');
  assert.deepEqual(p.entries.map((e) => [e.songId, e.addedBy || '']), [['s2', ''], ['s3', 'mia'], ['s4', 'mia'], ['s5', 'mia']]);
  assert.deepEqual(p.collab.counts, { mia: { added: 3, removed: 1 } });
  run(l, 'owner', { type: 'addSongsToPlaylist', playlistId: 'mix', songIds: ['s6'] }, { type: 'removeFromPlaylist', playlistId: 'mix', songId: 's3' });
  assert.deepEqual(own(l, 'mix').entries.map((e) => [e.songId, e.addedBy || '']), [['s2', ''], ['s4', 'mia'], ['s5', 'mia'], ['s6', 'owner']]);
  assert.deepEqual(own(l, 'mix').collab.counts, { mia: { added: 3, removed: 1 }, owner: { added: 1, removed: 1 } });
  // Mia sees the songs, who added them and the counts.
  const m = seen(l, 'mia', 'mix');
  assert.deepEqual(m.entries.map((e) => e.addedBy || ''), ['', 'mia', 'mia', 'owner']);
  assert.deepEqual(m.collab.members, [{ id: 'owner', added: 1, removed: 1 }, { id: 'mia', added: 3, removed: 1 }]);
  // The name, sharing and collaboration stay the owner's: none of them is Mia's to change.
  assert.deepEqual(run(l, 'mia',
    { type: 'renamePlaylist', playlistId: 'mix', name: 'Mine now' },
    { type: 'setPlaylistShared', playlistId: 'mix', shared: false },
    { type: 'deletePlaylist', playlistId: 'mix' },
    { type: 'answerCollab', playlistId: 'mix', profileId: 'ben', approve: true }), [{ skipped: 'gone' }, { skipped: 'gone' }, { skipped: 'gone' }, { skipped: 'gone' }]);
  assert.equal(own(l, 'mix').name, 'Party');
});

test('turned off or unshared: rights paused, everyone kept; on again: back', () => {
  const l = withCollab();
  run(l, 'owner', { type: 'setPlaylistShared', playlistId: 'mix', shared: true }, { type: 'setPlaylistCollab', playlistId: 'mix', on: true });
  run(l, 'mia', { type: 'requestCollab', playlistId: 'mix', on: true });
  run(l, 'ben', { type: 'requestCollab', playlistId: 'mix', on: true });
  run(l, 'owner', { type: 'answerCollab', playlistId: 'mix', profileId: 'mia', approve: true }, { type: 'setPlaylistCollab', playlistId: 'mix', on: false });
  assert.equal(seen(l, 'mia', 'mix').collab, undefined, 'off: an ordinary shared playlist to the others');
  assert.deepEqual(run(l, 'mia', { type: 'addSongsToPlaylist', playlistId: 'mix', songIds: ['s3'] })[0], { skipped: 'gone' });
  assert.deepEqual(own(l, 'mix').collab, { on: false, members: ['mia'], requests: ['ben'], counts: {} });
  run(l, 'owner', { type: 'setPlaylistCollab', playlistId: 'mix', on: true }, { type: 'setPlaylistShared', playlistId: 'mix', shared: false });
  assert.equal(seen(l, 'mia', 'mix'), undefined);
  run(l, 'owner', { type: 'setPlaylistShared', playlistId: 'mix', shared: true });
  run(l, 'mia', { type: 'addSongsToPlaylist', playlistId: 'mix', songIds: ['s3'] });
  assert.ok(own(l, 'mix').entries.some((e) => e.songId === 's3' && e.addedBy === 'mia'));
});

test('removed by the owner or leaving: still followed, read-only; profiles gone leave it too', () => {
  const l = withCollab();
  run(l, 'owner', { type: 'setPlaylistShared', playlistId: 'mix', shared: true }, { type: 'setPlaylistCollab', playlistId: 'mix', on: true });
  run(l, 'mia', { type: 'requestCollab', playlistId: 'mix', on: true });
  run(l, 'ben', { type: 'requestCollab', playlistId: 'mix', on: true });
  run(l, 'owner', { type: 'answerCollab', playlistId: 'mix', profileId: 'mia', approve: true }, { type: 'answerCollab', playlistId: 'mix', profileId: 'ben', approve: true });
  run(l, 'mia', { type: 'leaveCollab', playlistId: 'mix' });
  run(l, 'owner', { type: 'removeCollaborator', playlistId: 'mix', profileId: 'ben' });
  assert.deepEqual(own(l, 'mix').collab.members, []);
  assert.ok(l.profiles.mia.follows.includes('mix') && l.profiles.ben.follows.includes('mix'));
  assert.equal(seen(l, 'mia', 'mix').collab.me, '');
  assert.deepEqual(run(l, 'ben', { type: 'removeFromPlaylist', playlistId: 'mix', songId: 's1' })[0], { skipped: 'gone' });
  // A profile deleted is no longer in it, nor asking.
  run(l, 'ben', { type: 'requestCollab', playlistId: 'mix', on: true });
  prof.removeProfile(l.profiles, 'ben');
  prof.prune(l.data, l.profiles);
  assert.deepEqual(own(l, 'mix').collab.requests, []);
});

test('the Default / Shared cannot own or join a collaboration', () => {
  const l = server();
  run(l, null, { type: 'createPlaylist', playlistId: 'd1', name: 'House' }, { type: 'setPlaylistShared', playlistId: 'd1', shared: true });
  assert.match(String(run(l, null, { type: 'setPlaylistCollab', playlistId: 'd1', on: true })[0]), /Sign in to a profile/);
  const l2 = withCollab();
  run(l2, 'owner', { type: 'setPlaylistShared', playlistId: 'mix', shared: true }, { type: 'setPlaylistCollab', playlistId: 'mix', on: true });
  assert.match(String(run(l2, null, { type: 'requestCollab', playlistId: 'mix', on: true })[0]), /Sign in to a profile/);
});

test('a collaboration and who added each song survive cleaning, also on a shared row', () => {
  const clean = model.sanitize({
    songs: [{ id: 's1', file: 'a' }, { id: 's2', file: 'b' }],
    playlists: [{
      id: 'p', name: 'P', shared: true, collab: { on: true, members: ['m', 'm', ''], requests: ['m', 'r'], counts: { m: { added: 2.7, removed: -1 }, z: {} } }, entries: [{ songId: 's1', addedBy: 'm' }, { songId: 's2', addedBy: 'bad id!' }],
    }, { id: 'q', name: 'Q', rules: { match: 'all', conditions: [{ field: 'title', op: 'contains', value: 'a' }] }, collab: { on: true } }],
    sharedPlaylists: [{ id: 'sh', name: 'S', ownerId: 'o', collab: { on: true, me: 'member', members: [{ id: 'o', added: 1 }] }, entries: [{ songId: 's1', addedBy: 'o' }] }, { id: 'sh2', name: 'S2', ownerId: 'o', collab: { on: false, me: 'member' } }],
  });
  const p = clean.playlists[0];
  assert.deepEqual(p.collab, { on: true, members: ['m'], requests: ['r'], counts: { m: { added: 2, removed: 0 } } });
  assert.deepEqual(p.entries.map((e) => e.addedBy), ['m', undefined]);
  assert.equal(clean.playlists[1].collab, undefined, 'a smart playlist is never one');
  assert.deepEqual(clean.sharedPlaylists[0].collab, { on: true, me: 'member', members: [{ id: 'o', added: 1, removed: 0 }] });
  assert.equal(clean.sharedPlaylists[0].entries[0].addedBy, 'o');
  assert.equal(clean.sharedPlaylists[1].collab, undefined, 'off: nothing to show');
});
