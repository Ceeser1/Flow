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
  assert.equal(m.playlistById(d, 'p2').groups, undefined);
  m.renameGroup(d, 'g1', 'Rock & Metal');
  assert.equal(m.groupById(d, 'g1').name, 'Rock & Metal');
  m.deleteGroup(d, 'g1');
  assert.equal(m.groupById(d, 'g1'), null);
  assert.ok(m.playlistById(d, 'p1'));
  assert.equal(m.playlistById(d, 'p1').groups, undefined);
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
  // A library from 4.5 keeps one `group`: it becomes the first of its groups (4.5.3).
  assert.deepEqual(d.playlists[0].groups, ['g1']);
  assert.equal('group' in d.playlists[0], false);
  assert.equal('groups' in d.playlists[1], false);
  assert.equal('groups' in d.playlists[2], false);
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
  assert.deepEqual(m.playlistById(d, 'p1').groups, ['g2']);
  // Renames: the later one stands.
  applyCommand(d, { type: 'renameGroup', groupId: 'g1', name: 'Rock 2', at: 30 }, touched);
  assert.deepEqual(applyCommand(d, { type: 'renameGroup', groupId: 'g1', name: 'Rock 1', at: 25 }, touched), { skipped: 'stale' });
  assert.equal(m.groupById(d, 'g1').name, 'Rock 2');
  // A delete wins, whenever it was made; moving into it afterwards is gone.
  applyCommand(d, { type: 'deleteGroup', groupId: 'g2', at: 1 }, touched);
  assert.equal(m.playlistById(d, 'p1').groups, undefined);
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
  assert.deepEqual(copy.groups, [anna.groups[0].id]);
  assert.equal(anna.playlists.find((p) => p.name === 'Chill').groups, undefined);
  // Anna's group is hers: the Default does not see it change.
  run(l, 'anna', { type: 'renameGroup', groupId: anna.groups[0].id, name: 'Anna Rock' });
  assert.equal(prof.view(l.data, l.profiles, null).groups[0].name, 'Rock');
  assert.equal(prof.view(l.data, l.profiles, 'anna').groups[0].name, 'Anna Rock');
  // Kept through a save and load.
  const again = prof.sanitizeProfiles(l.data, JSON.parse(JSON.stringify(l.profiles)));
  assert.equal(again.anna.groups[0].name, 'Anna Rock');
  assert.deepEqual(again.anna.playlists.find((p) => p.name === 'Rock Classics').groups, [again.anna.groups[0].id]);
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
  assert.equal(prof.view(l.data, l.profiles, 'anna').playlists.find((p) => p.id === 'pa').groups, undefined);
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

test('sanitize keeps a followed playlist only while followed (4.5.1), in several groups too (4.5.3)', () => {
  const d = m.sanitize({
    ...lib(),
    follows: ['x1', 'x2'],
    groups: [{ id: 'g1', name: 'A', followed: ['x1', 'x3'] }, { id: 'g2', name: 'B', followed: ['x1', 'x2'] }],
  });
  assert.deepEqual(d.groups.map((g) => g.followed), [['x1'], ['x1', 'x2']]);
});

test('a new profile copies the Default groups without its followed playlists (4.5.1)', () => {
  const l = { data: lib(), profiles: {} };
  l.data.groups = [{ id: 'g1', name: 'Rock', createdAt: 1, followed: ['x1'] }];
  prof.addProfile(l.data, l.profiles, 'anna', () => 'n1');
  assert.equal(l.profiles.anna.groups[0].followed, undefined);
});

test('a shared group (4.5.3): its playlists shared with it, seen and followed by the others', () => {
  const l = { data: lib(), profiles: {} };
  for (const id of ['anna', 'ben', 'carl']) prof.addProfile(l.data, l.profiles, id, (() => { let n = 0; return () => `${id}${n++}`; })());
  const names = { anna: 'Anna', ben: 'Ben', carl: 'Carl' };
  run(l, 'anna', { type: 'createPlaylist', playlistId: 'pa', name: 'Evening' });
  run(l, 'anna', { type: 'createPlaylist', playlistId: 'ps', name: 'Most heard', rules: { match: 'all', conditions: [{ field: 'plays', op: 'gt', value: 3 }] } });
  run(l, 'anna', { type: 'createGroup', groupId: 'ga', name: 'Moods' });
  run(l, 'anna', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: 'ga' });
  run(l, 'anna', { type: 'setPlaylistGroup', playlistId: 'ps', groupId: 'ga' });
  // Ben's shared playlist, followed by Anna and put into her group.
  run(l, 'ben', { type: 'createPlaylist', playlistId: 'pb', name: 'Jazz' });
  run(l, 'ben', { type: 'setPlaylistShared', playlistId: 'pb', shared: true });
  run(l, 'anna', { type: 'followPlaylist', playlistId: 'pb' });
  run(l, 'anna', { type: 'setPlaylistGroup', playlistId: 'pb', groupId: 'ga' });
  run(l, 'anna', { type: 'setGroupShared', groupId: 'ga', shared: true });
  let anna = prof.view(l.data, l.profiles, 'anna', names);
  assert.equal(anna.groups[0].shared, true);
  assert.equal(anna.playlists.find((p) => p.id === 'pa').shared, true, 'shared with the group');
  assert.equal(anna.playlists.find((p) => p.id === 'ps').shared, false, 'a smart one cannot be');
  assert.equal(prof.view(l.data, l.profiles, 'ben', names).playlists.find((p) => p.id === 'pb').groups, undefined, 'Ben\'s list untouched');
  // A playlist put in later is shared too.
  run(l, 'anna', { type: 'createPlaylist', playlistId: 'pa2', name: 'Morning' });
  run(l, 'anna', { type: 'setPlaylistGroup', playlistId: 'pa2', groupId: 'ga' });
  assert.equal(prof.view(l.data, l.profiles, 'anna').playlists.find((p) => p.id === 'pa2').shared, true);

  // Carl sees the group with its shared playlists (not the smart one), and follows it.
  let carl = prof.view(l.data, l.profiles, 'carl', names);
  assert.deepEqual(carl.sharedGroups.map((g) => [g.id, g.ownerName, g.playlists]), [['ga', 'Anna', ['pa', 'pa2', 'pb']]]);
  assert.deepEqual(anna.sharedGroups, [], 'not her own');
  assert.throws(() => run(l, 'anna', { type: 'followGroup', groupId: 'ga' }), /always yours/);
  run(l, 'carl', { type: 'followGroup', groupId: 'ga' });
  carl = prof.view(l.data, l.profiles, 'carl', names);
  assert.deepEqual(carl.groupFollows, ['ga']);
  assert.deepEqual(carl.follows, []);
  assert.ok(m.isFollowed(carl, 'pa') && m.isFollowed(carl, 'pb'));
  assert.ok(!m.isFollowed(carl, 'ps'));
  assert.deepEqual([...m.followedIds(carl)].sort(), ['pa', 'pa2', 'pb']);
  // Listening to one of its playlists counts, as for one followed.
  run(l, 'anna', { type: 'addSongsToPlaylist', playlistId: 'pa', songIds: ['s1'] });
  run(l, 'carl', { type: 'recordListen', songId: 's1', listened: 200, duration: 380, contextId: 'pa' });
  assert.equal(prof.view(l.data, l.profiles, 'carl').playlistListened.pa, 200);
  // Kept through a save and load.
  const again = prof.sanitizeProfiles(l.data, JSON.parse(JSON.stringify(l.profiles)));
  assert.deepEqual([again.anna.groups[0].shared, again.carl.groupFollows], [true, ['ga']]);

  // Ben stops sharing Jazz: Anna's group loses it, her follow waits.
  run(l, 'ben', { type: 'setPlaylistShared', playlistId: 'pb', shared: false });
  anna = prof.view(l.data, l.profiles, 'anna', names);
  assert.equal(anna.groups[0].followed, undefined);
  assert.deepEqual(anna.follows, ['pb']);
  assert.deepEqual(prof.view(l.data, l.profiles, 'carl', names).sharedGroups[0].playlists, ['pa', 'pa2']);
  // No longer shared: the others no longer see it, its playlists stay shared, the follow waits.
  run(l, 'anna', { type: 'setGroupShared', groupId: 'ga', shared: false });
  carl = prof.view(l.data, l.profiles, 'carl', names);
  assert.deepEqual([carl.sharedGroups, carl.groupFollows], [[], ['ga']]);
  assert.equal(prof.view(l.data, l.profiles, 'anna').playlists.find((p) => p.id === 'pa').shared, true);
  assert.equal(carl.playlistListened.pa, undefined, 'no longer followed: its time goes');
  // Deleted: the follow goes.
  run(l, 'anna', { type: 'deleteGroup', groupId: 'ga' });
  assert.deepEqual(prof.view(l.data, l.profiles, 'carl').groupFollows, []);
});

test('a new profile copies the Default groups unshared (4.5.3); sanitize keeps shared groups and group follows', () => {
  const l = { data: lib(), profiles: {} };
  l.data.groups = [{ id: 'g1', name: 'Rock', createdAt: 1, shared: true }];
  prof.addProfile(l.data, l.profiles, 'anna', () => 'n1');
  assert.equal(l.profiles.anna.groups[0].shared, undefined);
  const d = m.sanitize({
    ...lib(),
    groups: [{ id: 'g1', name: 'A', shared: true }, { id: 'g2', name: 'B', shared: 'yes' }],
    groupFollows: ['x', 'x', ''],
    sharedGroups: [{ id: 'sg', name: ' Mix ', ownerId: 'ben', ownerName: 'Ben', playlists: ['p', 'p', 'q'] }, { id: 'bad id!' }],
  });
  assert.deepEqual(d.groups.map((g) => g.shared), [true, undefined]);
  assert.deepEqual(d.groupFollows, ['x']);
  assert.deepEqual(d.sharedGroups.map((g) => [g.id, g.name, g.playlists]), [['sg', 'Mix', ['p', 'q']]]);
});

test('a playlist unfollowed inside a followed group (4.5.3): only for that group; followed by itself apart', () => {
  const l = { data: lib(), profiles: {} };
  for (const id of ['anna', 'ben', 'carl']) prof.addProfile(l.data, l.profiles, id, (() => { let n = 0; return () => `${id}${n++}`; })());
  // Ben's Jazz is in his shared group and, followed by Anna, in hers.
  run(l, 'ben', { type: 'createPlaylist', playlistId: 'pb', name: 'Jazz' });
  run(l, 'ben', { type: 'createGroup', groupId: 'gb', name: 'Ben Mix' });
  run(l, 'ben', { type: 'setPlaylistGroup', playlistId: 'pb', groupId: 'gb' });
  run(l, 'ben', { type: 'setGroupShared', groupId: 'gb', shared: true });
  run(l, 'anna', { type: 'createPlaylist', playlistId: 'pa', name: 'Evening' });
  run(l, 'anna', { type: 'createGroup', groupId: 'ga', name: 'Moods' });
  run(l, 'anna', { type: 'setPlaylistGroup', playlistId: 'pa', groupId: 'ga' });
  run(l, 'anna', { type: 'followPlaylist', playlistId: 'pb' });
  run(l, 'anna', { type: 'setPlaylistGroup', playlistId: 'pb', groupId: 'ga' });
  run(l, 'anna', { type: 'setGroupShared', groupId: 'ga', shared: true });
  run(l, 'carl', { type: 'followGroup', groupId: 'ga' });
  run(l, 'carl', { type: 'followGroup', groupId: 'gb' });
  const carl = () => prof.view(l.data, l.profiles, 'carl');
  const ga = () => carl().sharedGroups.find((g) => g.id === 'ga');
  // Unfollowed in Anna's group: still followed through Ben's.
  run(l, 'carl', { type: 'setGroupPlaylistFollowed', groupId: 'ga', playlistId: 'pb', on: false });
  assert.deepEqual(m.followedInGroup(carl(), ga()), ['pa']);
  assert.ok(m.isFollowed(carl(), 'pb'));
  run(l, 'carl', { type: 'setGroupPlaylistFollowed', groupId: 'gb', playlistId: 'pb', on: false });
  assert.ok(!m.isFollowed(carl(), 'pb'));
  assert.deepEqual(carl().follows, []);
  // Followed by itself: in follows (Followed Playlists), the groups as they were.
  run(l, 'carl', { type: 'followPlaylist', playlistId: 'pb' });
  assert.deepEqual(carl().follows, ['pb']);
  assert.deepEqual(carl().groupSkips, { ga: ['pb'], gb: ['pb'] });
  // Followed in the group again.
  run(l, 'carl', { type: 'setGroupPlaylistFollowed', groupId: 'ga', playlistId: 'pb', on: true });
  assert.deepEqual(m.followedInGroup(carl(), ga()), ['pa', 'pb']);
  // Kept over a save and load; gone with the group's follow.
  assert.deepEqual(prof.sanitizeProfiles(l.data, JSON.parse(JSON.stringify(l.profiles))).carl.groupSkips, { gb: ['pb'] });
  run(l, 'carl', { type: 'unfollowGroup', groupId: 'gb' });
  assert.deepEqual(carl().groupSkips, {});
  // Not followed: nothing to unfollow inside.
  assert.deepEqual(run(l, 'carl', { type: 'setGroupPlaylistFollowed', groupId: 'gb', playlistId: 'pb', on: false }), { skipped: 'gone' });
});

test('a playlist in several groups (4.5.3): added to one more, out of one, the others kept', () => {
  const d = lib();
  m.createGroup(d, 'Rock', 'g1', 1);
  m.createGroup(d, 'Evening', 'g2', 2);
  m.addPlaylistToGroup(d, 'p1', 'g1');
  m.addPlaylistToGroup(d, 'p1', 'g2');
  m.addPlaylistToGroup(d, 'p1', 'g2');
  assert.deepEqual(m.playlistById(d, 'p1').groups, ['g1', 'g2']);
  assert.deepEqual([m.playlistsInGroup(d, 'g1'), m.playlistsInGroup(d, 'g2')].map((l) => l.map((p) => p.id)), [['p1'], ['p1']]);
  m.removePlaylistFromGroup(d, 'p1', 'g1');
  assert.deepEqual(m.playlistById(d, 'p1').groups, ['g2']);
  m.addPlaylistToGroup(d, 'p1', 'g1');
  m.deleteGroup(d, 'g2');
  assert.deepEqual(m.playlistById(d, 'p1').groups, ['g1']);
  // The move of the apps from before: into that group only.
  m.createGroup(d, 'Old', 'g3', 3);
  m.addPlaylistToGroup(d, 'p1', 'g3');
  m.setPlaylistGroup(d, 'p1', 'g3');
  assert.deepEqual(m.playlistById(d, 'p1').groups, ['g3']);
  assert.throws(() => m.addPlaylistToGroup(d, 'favourites', 'g1'));
  // By commands, each group's own last change.
  const touched = {};
  applyCommand(d, { type: 'addPlaylistToGroup', playlistId: 'p2', groupId: 'g1', at: 10 }, touched);
  applyCommand(d, { type: 'addPlaylistToGroup', playlistId: 'p2', groupId: 'g3', at: 10 }, touched);
  assert.deepEqual(applyCommand(d, { type: 'removePlaylistFromGroup', playlistId: 'p2', groupId: 'g1', at: 5 }, touched), { skipped: 'stale' });
  applyCommand(d, { type: 'removePlaylistFromGroup', playlistId: 'p2', groupId: 'g3', at: 20 }, touched);
  assert.deepEqual(m.playlistById(d, 'p2').groups, ['g1']);
  assert.deepEqual(applyCommand(d, { type: 'addPlaylistToGroup', playlistId: 'p2', groupId: 'gone', at: 30 }, touched), { skipped: 'gone' });
});

test('a followed playlist in several groups, and an own one in a shared group among others (4.5.3)', () => {
  const l = { data: lib(), profiles: {} };
  for (const id of ['anna', 'ben']) prof.addProfile(l.data, l.profiles, id, (() => { let n = 0; return () => `${id}${n++}`; })());
  run(l, 'anna', { type: 'createPlaylist', playlistId: 'pa', name: 'Evening' });
  run(l, 'anna', { type: 'setPlaylistShared', playlistId: 'pa', shared: true });
  run(l, 'ben', { type: 'createGroup', groupId: 'gb1', name: 'Chill' });
  run(l, 'ben', { type: 'createGroup', groupId: 'gb2', name: 'Night' });
  run(l, 'ben', { type: 'followPlaylist', playlistId: 'pa' });
  run(l, 'ben', { type: 'addPlaylistToGroup', playlistId: 'pa', groupId: 'gb1' });
  run(l, 'ben', { type: 'addPlaylistToGroup', playlistId: 'pa', groupId: 'gb2' });
  let ben = prof.view(l.data, l.profiles, 'ben');
  assert.deepEqual(ben.groups.map((g) => g.followed), [['pa'], ['pa']]);
  run(l, 'ben', { type: 'removePlaylistFromGroup', playlistId: 'pa', groupId: 'gb1' });
  ben = prof.view(l.data, l.profiles, 'ben');
  assert.deepEqual(ben.groups.map((g) => g.followed), [undefined, ['pa']]);
  // Ben's own playlist in a private group and a shared one: the others see it in the shared one.
  run(l, 'ben', { type: 'createPlaylist', playlistId: 'pb', name: 'Jazz' });
  run(l, 'ben', { type: 'addPlaylistToGroup', playlistId: 'pb', groupId: 'gb1' });
  run(l, 'ben', { type: 'setGroupShared', groupId: 'gb2', shared: true });
  assert.equal(prof.view(l.data, l.profiles, 'ben').playlists.find((p) => p.id === 'pb').shared, false, 'not in the shared group yet');
  run(l, 'ben', { type: 'addPlaylistToGroup', playlistId: 'pb', groupId: 'gb2' });
  const seen = prof.view(l.data, l.profiles, 'anna', { ben: 'Ben' }).sharedGroups;
  assert.deepEqual(seen.map((g) => [g.id, g.playlists]), [['gb2', ['pb', 'pa']]]);
  // A new profile's copy keeps its playlists' several groups.
  run(l, null, { type: 'createGroup', groupId: 'd1', name: 'A' });
  run(l, null, { type: 'createGroup', groupId: 'd2', name: 'B' });
  run(l, null, { type: 'addPlaylistToGroup', playlistId: 'p1', groupId: 'd1' });
  run(l, null, { type: 'addPlaylistToGroup', playlistId: 'p1', groupId: 'd2' });
  prof.addProfile(l.data, l.profiles, 'carl', (() => { let n = 0; return () => `c${n++}`; })());
  const carl = prof.view(l.data, l.profiles, 'carl');
  assert.equal(carl.playlists.find((p) => p.name === 'Rock Classics').groups.length, 2);
});
