'use strict';

// Playlist groups (4.5): folders of playlists, each owner's own.

const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/libraryModel');
const prof = require('../src/profiles');
const { applyCommand } = require('../src/commands');

function lib() {
  const d = m.emptyLibrary();
  m.addSong(d, { id: 's1', file: '/music/a.mp3', title: 'Paranoid Android', artist: 'Radiohead', duration: 380, addedAt: 1 });
  m.createPlaylist(d, 'Rock Classics', 'p1', 1);
  m.createPlaylist(d, 'Grunge', 'p2', 2);
  m.createPlaylist(d, 'Chill', 'p3', 3);
  return d;
}

test('a group is made, filled, renamed and deleted; its playlists stay', () => {
  const d = lib();
  m.createGroup(d, '  Rock  ', 'g1', 10);
  assert.deepEqual(d.groups, [{ id: 'g1', name: 'Rock', createdAt: 10 }]);
  m.setPlaylistGroup(d, 'p1', 'g1');
  m.setPlaylistGroup(d, 'p2', 'g1');
  assert.deepEqual(m.playlistsInGroup(d, 'g1').map((p) => p.id), ['p1', 'p2']);
  // One group at most: moving it takes it out of the other.
  m.createGroup(d, 'Old', 'g2', 11);
  m.setPlaylistGroup(d, 'p2', 'g2');
  assert.deepEqual(m.playlistsInGroup(d, 'g1').map((p) => p.id), ['p1']);
  m.setPlaylistGroup(d, 'p2', '');
  assert.equal(m.playlistById(d, 'p2').group, undefined);
  m.renameGroup(d, 'g1', 'Rock & Metal');
  assert.equal(m.groupById(d, 'g1').name, 'Rock & Metal');
  m.deleteGroup(d, 'g1');
  assert.equal(m.groupById(d, 'g1'), null);
  assert.ok(m.playlistById(d, 'p1'));
  assert.equal(m.playlistById(d, 'p1').group, undefined);
});

test('group names: not empty, not too long, not taken', () => {
  const d = lib();
  m.createGroup(d, 'Rock', 'g1');
  assert.throws(() => m.createGroup(d, '   ', 'g2'), /name for the group/);
  assert.throws(() => m.createGroup(d, 'x'.repeat(81), 'g2'), /at most 80/);
  assert.throws(() => m.createGroup(d, 'rock', 'g2'), /already exists/);
  // A playlist may have the same name as a group.
  m.createGroup(d, 'Chill', 'g3');
  assert.equal(m.freeGroupName(d, 'Rock'), 'Rock (2)');
});

test('Favourites never goes into a group; a group that is gone takes no playlists', () => {
  const d = lib();
  d.playlists.unshift({ id: 'fav-x', name: 'Favourites', createdAt: 1, entries: [], source: null, shared: false, rules: null, favourites: true });
  m.createGroup(d, 'Rock', 'g1');
  assert.throws(() => m.setPlaylistGroup(d, 'fav-x', 'g1'), /Favourites/);
  assert.throws(() => m.setPlaylistGroup(d, 'p1', 'nope'), /no longer exists/);
});

test('sanitize keeps the groups and drops a playlist\'s group that is not there', () => {
  const d = m.sanitize({
    songs: [],
    groups: [{ id: 'g1', name: 'Rock', createdAt: 5 }, { id: 'g1', name: 'Twice' }, { id: 'bad id!', name: 'x' }],
    playlists: [
      { id: 'p1', name: 'A', group: 'g1' },
      { id: 'p2', name: 'B', group: 'gone' },
      { id: 'fav', name: 'Favourites', favourites: true, group: 'g1' },
    ],
  });
  assert.deepEqual(d.groups, [{ id: 'g1', name: 'Rock', createdAt: 5 }]);
  assert.equal(d.playlists[0].group, 'g1');
  assert.equal('group' in d.playlists[1], false);
  assert.equal('group' in d.playlists[2], false);
  // A library from before 4.5 has none.
  assert.deepEqual(m.sanitize({ songs: [], playlists: [] }).groups, []);
});

test('group commands, and last change wins for a playlist\'s group', () => {
  const d = lib();
  const touched = {};
  assert.deepEqual(applyCommand(d, { type: 'createGroup', groupId: 'g1', name: 'Rock', at: 5 }, touched), { value: 'g1' });
  assert.deepEqual(applyCommand(d, { type: 'createGroup', groupId: 'g1', name: 'Rock', at: 5 }, touched), { skipped: 'exists' });
  applyCommand(d, { type: 'createGroup', groupId: 'g2', name: 'Old', at: 6 }, touched);
  // The phone moved it into Old at 20, the PC into Rock at 10 and was heard later.
  applyCommand(d, { type: 'setPlaylistGroup', playlistId: 'p1', groupId: 'g2', at: 20 }, touched);
  assert.deepEqual(applyCommand(d, { type: 'setPlaylistGroup', playlistId: 'p1', groupId: 'g1', at: 10 }, touched), { skipped: 'stale' });
  assert.equal(m.playlistById(d, 'p1').group, 'g2');
  // Renames: the later one stands.
  applyCommand(d, { type: 'renameGroup', groupId: 'g1', name: 'Rock 2', at: 30 }, touched);
  assert.deepEqual(applyCommand(d, { type: 'renameGroup', groupId: 'g1', name: 'Rock 1', at: 25 }, touched), { skipped: 'stale' });
  assert.equal(m.groupById(d, 'g1').name, 'Rock 2');
  // A delete wins, whenever it was made; moving into it afterwards is gone.
  applyCommand(d, { type: 'deleteGroup', groupId: 'g2', at: 1 }, touched);
  assert.equal(m.playlistById(d, 'p1').group, undefined);
  assert.deepEqual(applyCommand(d, { type: 'setPlaylistGroup', playlistId: 'p1', groupId: 'g2', at: 40 }, touched), { skipped: 'gone' });
  assert.deepEqual(applyCommand(d, { type: 'renameGroup', groupId: 'g2', name: 'x', at: 40 }, touched), { skipped: 'gone' });
  assert.deepEqual(applyCommand(d, { type: 'setPlaylistGroup', playlistId: 'nope', groupId: 'g1', at: 40 }, touched), { skipped: 'gone' });
});

test('two apps making the same group name while apart both keep theirs', () => {
  const d = lib();
  applyCommand(d, { type: 'createGroup', groupId: 'g1', name: 'Rock', at: 5 });
  applyCommand(d, { type: 'createGroup', groupId: 'g2', name: 'Rock', at: 6 });
  assert.deepEqual(d.groups.map((g) => g.name), ['Rock', 'Rock (2)']);
});

function run(l, profileId, cmd, touched = null) {
  const v = prof.view(l.data, l.profiles, profileId);
  const r = applyCommand(v, { at: Date.now(), ...cmd }, touched, profileId);
  prof.absorb(l.data, l.profiles, profileId, v);
  return r;
}

test('each profile has its own groups; a new profile copies the Default\'s', () => {
  const l = { data: lib(), profiles: {} };
  run(l, null, { type: 'createGroup', groupId: 'g1', name: 'Rock' });
  run(l, null, { type: 'setPlaylistGroup', playlistId: 'p1', groupId: 'g1' });
  let n = 0;
  prof.addProfile(l.data, l.profiles, 'anna', () => `n${++n}`);
  const anna = prof.view(l.data, l.profiles, 'anna');
  assert.equal(anna.groups.length, 1);
  assert.equal(anna.groups[0].name, 'Rock');
  assert.notEqual(anna.groups[0].id, 'g1');
  const copy = anna.playlists.find((p) => p.name === 'Rock Classics');
  assert.equal(copy.group, anna.groups[0].id);
  assert.equal(anna.playlists.find((p) => p.name === 'Chill').group, undefined);
  // Anna's group is hers: the Default does not see it change.
  run(l, 'anna', { type: 'renameGroup', groupId: anna.groups[0].id, name: 'Anna Rock' });
  assert.equal(prof.view(l.data, l.profiles, null).groups[0].name, 'Rock');
  assert.equal(prof.view(l.data, l.profiles, 'anna').groups[0].name, 'Anna Rock');
  // Kept through a save and load.
  const again = prof.sanitizeProfiles(l.data, JSON.parse(JSON.stringify(l.profiles)));
  assert.equal(again.anna.groups[0].name, 'Anna Rock');
  assert.equal(again.anna.playlists.find((p) => p.name === 'Rock Classics').group, again.anna.groups[0].id);
});

test('followed playlists go into groups too (4.5.1): one group at most, out again when unfollowed', () => {
  const l = { data: lib(), profiles: {} };
  prof.addProfile(l.data, l.profiles, 'anna', () => 'a1');
  prof.addProfile(l.data, l.profiles, 'ben', () => 'b1');
  // Anna shares a playlist, Ben follows it and puts it into his group.
  run(l, 'anna', { type: 'createPlaylist', playlistId: 'pa', name: 'Evening' });
  run(l, 'anna', { type: 'setPlaylistShared', playlistId: 'pa', shared: true });
  run(l, 'ben', { type: 'createGroup', groupId: 'gb', name: 'Chill' });
  run(l, 'ben', { type: 'createGroup', groupId: 'gc', name: 'Night' });
  // Not followed: skipped.
  assert.deepEqual(run(l, 'ben', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: 'gb' }), { skipped: 'gone' });
  run(l, 'ben', { type: 'followPlaylist', playlistId: 'pa' });
  run(l, 'ben', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: 'gb' });
  let ben = prof.view(l.data, l.profiles, 'ben');
  assert.deepEqual(ben.groups.find((g) => g.id === 'gb').followed, ['pa']);
  assert.equal(m.groupOfFollowed(ben, 'pa').id, 'gb');
  // Anna's playlist itself is not changed.
  assert.equal(prof.view(l.data, l.profiles, 'anna').playlists.find((p) => p.id === 'pa').group, undefined);
  // Moved: out of the other group.
  run(l, 'ben', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: 'gc' });
  ben = prof.view(l.data, l.profiles, 'ben');
  assert.equal(ben.groups.find((g) => g.id === 'gb').followed, undefined);
  assert.deepEqual(ben.groups.find((g) => g.id === 'gc').followed, ['pa']);
  // Kept through a save and load.
  const again = prof.sanitizeProfiles(l.data, JSON.parse(JSON.stringify(l.profiles)));
  assert.deepEqual(again.ben.groups.find((g) => g.id === 'gc').followed, ['pa']);
  // Out of its group with No group, and when unfollowed.
  run(l, 'ben', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: '' });
  assert.equal(m.groupOfFollowed(prof.view(l.data, l.profiles, 'ben'), 'pa'), null);
  run(l, 'ben', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: 'gb' });
  run(l, 'ben', { type: 'unfollowPlaylist', playlistId: 'pa' });
  assert.equal(m.groupOfFollowed(prof.view(l.data, l.profiles, 'ben'), 'pa'), null);
  // Deleted by its owner: gone from the group as from the follows.
  run(l, 'ben', { type: 'followPlaylist', playlistId: 'pa' });
  run(l, 'ben', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: 'gb' });
  run(l, 'anna', { type: 'deletePlaylist', playlistId: 'pa' });
  ben = prof.view(l.data, l.profiles, 'ben');
  assert.deepEqual(ben.follows, []);
  assert.equal(ben.groups.find((g) => g.id === 'gb').followed, undefined);
});

test('sanitize keeps a followed playlist in one group only, and only while followed (4.5.1)', () => {
  const d = m.sanitize({
    ...lib(),
    follows: ['x1', 'x2'],
    groups: [{ id: 'g1', name: 'A', followed: ['x1', 'x3'] }, { id: 'g2', name: 'B', followed: ['x1', 'x2'] }],
  });
  assert.deepEqual(d.groups.map((g) => g.followed), [['x1'], ['x2']]);
});

test('a new profile copies the Default groups without its followed playlists (4.5.1)', () => {
  const l = { data: lib(), profiles: {} };
  l.data.groups = [{ id: 'g1', name: 'Rock', createdAt: 1, followed: ['x1'] }];
  prof.addProfile(l.data, l.profiles, 'anna', () => 'n1');
  assert.equal(l.profiles.anna.groups[0].followed, undefined);
});
