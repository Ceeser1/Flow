'use strict';

// Smart playlists (4.0): the songs a playlist's rules pick, in the window.

const test = require('node:test');
const assert = require('node:assert/strict');
const PlaylistRules = require('../renderer/app/playlistRules');
const model = require('@flow/core/libraryModel');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22);
const song = (id, extra) => ({
  id, title: id, artist: '', duration: 200, addedAt: NOW - 100 * DAY, stats: {}, ...extra,
});
const SONGS = [
  song('Roads', { artist: 'Portishead', genre: 'Trip Hop', duration: 302, stats: { sessions: 12, plays: 10, lastPlayedAt: NOW - 2 * DAY } }),
  song('Teardrop', { artist: 'Massive Attack, Elizabeth Fraser', genre: 'Trip Hop', subGenre: 'Bristol', stats: { sessions: 4, plays: 1 }, addedAt: NOW - 3 * DAY }),
  song('Numb', { artist: 'Linkin Park', genre: 'Nu Metal', favouriteAt: NOW - DAY, stats: { sessions: 30, plays: 29, lastPlayedAt: NOW - 40 * DAY } }),
  song('Porcelain', { artist: 'Moby', genre: 'Electronic', duration: 241 }),
];
const names = (list) => list.map((s) => s.id);
const pick = (rules) => names(PlaylistRules.evaluate(SONGS, model.cleanRules(rules), NOW));

test('the fields, ways to compare and orders are the model\'s', () => {
  assert.deepEqual(Object.fromEntries(PlaylistRules.FIELDS.map((f) => [f.id, f.kind])), model.RULE_FIELDS);
  for (const [kind, ops] of Object.entries(PlaylistRules.OPS)) assert.deepEqual(ops.map(([id]) => id), model.RULE_OPS[kind]);
  assert.deepEqual(PlaylistRules.SORTS.map(([id]) => id), model.RULE_SORTS);
});

test('the songs the rules pick, in their order', () => {
  assert.deepEqual(pick({ conditions: [{ field: 'genre', op: 'is', value: 'trip hop' }], sort: 'plays' }), ['Roads', 'Teardrop']);
  assert.deepEqual(pick({ conditions: [{ field: 'artist', op: 'is', value: 'Massive Attack' }] }), ['Teardrop'], 'one of its artists');
  assert.deepEqual(pick({ match: 'any', conditions: [{ field: 'favourite', op: 'is', value: true }, { field: 'info', op: 'contains', value: 'brist' }], sort: 'title' }), ['Numb', 'Teardrop']);
  assert.deepEqual(pick({ conditions: [{ field: 'lastPlayed', op: 'within', value: 7 }] }), ['Roads']);
  assert.deepEqual(pick({ conditions: [{ field: 'lastPlayed', op: 'notWithin', value: 7 }], sort: 'title' }), ['Numb', 'Porcelain', 'Teardrop'], 'never played counts');
  assert.deepEqual(pick({ conditions: [{ field: 'added', op: 'within', value: 30 }] }), ['Teardrop']);
  assert.deepEqual(pick({ conditions: [{ field: 'length', op: 'gt', value: 4.5 }] }), ['Roads']);
  assert.deepEqual(pick({ conditions: [{ field: 'fullListens', op: 'lt', value: 2 }], sort: 'length' }), ['Porcelain', 'Teardrop']);
  assert.deepEqual(pick({ conditions: [], sort: 'plays', limit: 2 }), ['Numb', 'Roads'], 'no conditions: every song');
  assert.equal(PlaylistRules.describe(model.cleanRules({ conditions: [{ field: 'genre', op: 'is', value: 'Trip Hop' }, { field: 'added', op: 'within', value: 30 }], limit: 50 })),
    'Genre is "Trip Hop" and Added in the last 30 days (at most 50)');
});
