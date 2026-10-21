'use strict';

// Settings' Statistics as statistics.js works them out: the hint lines,
// the profiles to pick from, the numbers and the Activity months.

const test = require('node:test');
const assert = require('node:assert/strict');
const Statistics = require('../renderer/app/statistics');

const at = (y, m, d = 15) => new Date(y, m - 1, d, 12).getTime();
const profile = { id: 'anna1', name: 'Anna', createdAt: at(2026, 3, 2) };

test('the hint says whose listens count now, and when the server is too old', () => {
  const hint = (st) => Statistics.hints(st).map((x) => `${x.kind}: ${x.text}`);
  assert.deepEqual(hint({ on: false }), ['grey: Never connected to any server - Using your App\'s private profile']);
  assert.deepEqual(hint({ on: false, serverId: 's1', serverName: 'Pi' }), ['grey: Not connected to any server - Using your App\'s private profile']);
  const online = {
    on: true, state: 'online', name: 'Living Room', serverId: 's1', serverName: 'Living Room', statistics: true,
  };
  assert.deepEqual(hint({ ...online, profile }), ['green: Connected to Living Room - Using the connected profile of this server']);
  assert.deepEqual(hint({ ...online, state: 'offline', profile }), ['amber: Not connected to Living Room - Using last connected profile of this server']);
  assert.deepEqual(hint(online), ['grey: Connected to Living Room - Not logged in to a profile, using your App\'s private profile']);
  assert.deepEqual(hint({ ...online, state: 'offline' }), ['grey: Not connected to Living Room - Using your App\'s private profile']);
  const old = hint({ ...online, profile, statistics: false });
  assert.equal(old.length, 2);
  assert.match(old[1], /^amber: Living Room is older than Flow 3\.6/);
});

test('a server named on this device shows that name, its own in brackets', () => {
  const Util = require('../renderer/app/util');
  assert.deepEqual(Util.serverName({ s1: 'Upstairs' }, 's1', 'Pi'), {
    name: 'Upstairs', original: 'Pi', renamed: true, label: 'Upstairs (Pi)',
  });
  assert.equal(Util.serverName({ s1: 'Upstairs' }, 's2', 'Pi').label, 'Pi');
  // Its own name given again is no name of its own.
  assert.equal(Util.serverName({ s1: 'Pi' }, 's1', 'Pi').renamed, false);
  assert.equal(Util.serverName(undefined, 's1', '').name, 'Flow Server');
  const st = {
    on: true, state: 'online', name: 'Pi', serverId: 's1', serverName: 'Pi', statistics: true, profile,
  };
  assert.equal(Statistics.hints(st, { s1: 'Upstairs' })[0].text, 'Connected to Upstairs - Using the connected profile of this server');
});

test('the profiles to pick from: tracked ones, the one in use marked, Private last', () => {
  const tracked = [
    {
      serverId: 's1', serverName: 'Living Room', profileId: 'anna1', profileName: 'Anna', createdAt: profile.createdAt, statistics: { since: 1, seconds: 7200, listens: 3, months: {} }, addedSongs: 4,
    },
    {
      serverId: 's2', serverName: 'Cellar', profileId: 'ben1', profileName: 'Ben', createdAt: 0, statistics: { since: 1, seconds: 60, listens: 1, months: {} }, addedSongs: 0,
    },
  ];
  const priv = {
    since: at(2026, 10, 20), seconds: 90, listens: 2, months: { '2026-10': 90 }, added: 5,
  };
  const st = {
    on: true, state: 'offline', serverId: 's1', serverName: 'Living Room', profile, tracked,
  };
  const list = Statistics.sources(st, priv);
  assert.deepEqual(list.map((x) => [x.id, x.current, x.removable]), [
    ['s1/anna1', true, false], ['s2/ben1', false, true], ['private', false, false],
  ]);
  assert.equal(list[2].addedSongs, 5);
  // Logged out: Private is the one in use.
  const out = Statistics.sources({ ...st, profile: null }, priv);
  assert.deepEqual(out.filter((x) => x.current).map((x) => x.id), ['private']);
  assert.equal(out[0].removable, true);
  // Signed in before the first row was written: there anyway.
  const fresh = Statistics.sources({ ...st, tracked: [] }, priv);
  assert.deepEqual(fresh.map((x) => x.id), ['s1/anna1', 'private']);
  assert.equal(fresh[0].statistics.seconds, 0);
});

test('the numbers: name, created, added, listened (30 s or more), time as dd:hh:mm', () => {
  const rows = Statistics.facts({
    name: 'Anna', createdAt: at(2026, 3, 2), addedSongs: 12, statistics: { listens: 40, seconds: 2 * 86400 + 3 * 3600 + 5 * 60 },
  });
  assert.deepEqual(rows, [
    ['Profile', 'Anna'], ['Created at', '02.03.26'], ['Added songs', '12'], ['Listened songs', '40'], ['Time listened', '02:03:05'],
  ]);
  assert.equal(Statistics.facts({ name: 'Private' })[1][1], '-');
});

test('Activity: a month per bar from when it was made to now, the highest one full', () => {
  const months = Statistics.months({ months: { '2026-08': 7200, '2026-10': 3600, '2026-01': 99 } }, at(2026, 6, 20), at(2026, 10, 20));
  assert.deepEqual(months.map((m) => m.key), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.deepEqual(months.map((m) => m.hours), [0, 0, 2, 0, 1]);
  assert.deepEqual(months.map((m) => m.share), [0, 0, 1, 0, 0.5]);
  assert.deepEqual([months[0].name, months[0].short, months[0].year], ['June', 'Jun', '2026']);
  // Over a new year, and from the start of the Statistics when no date is known.
  const turn = Statistics.months({ since: at(2025, 11, 3), months: {} }, 0, at(2026, 1, 5));
  assert.deepEqual(turn.map((m) => m.key), ['2025-11', '2025-12', '2026-01']);
  assert.ok(turn.every((m) => m.share === 0));
  assert.equal(Statistics.months(null, 0, at(2026, 10, 1)).length, 1);
});
