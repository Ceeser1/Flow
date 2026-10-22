'use strict';

// Settings' Statistics as statistics.js works them out: the profiles to
// pick from, the numbers and the Activity months.

const test = require('node:test');
const assert = require('node:assert/strict');
const Statistics = require('../renderer/app/statistics');

const at = (y, m, d = 15) => new Date(y, m - 1, d, 12).getTime();
const profile = { id: 'anna1', name: 'Anna', createdAt: at(2026, 3, 2) };

test('a server named on this device shows that name, its own in brackets', () => {
  const Util = require('../renderer/app/util');
  assert.deepEqual(Util.serverName({ s1: 'Upstairs' }, 's1', 'Pi'), {
    name: 'Upstairs', original: 'Pi', renamed: true, label: 'Upstairs (Pi)',
  });
  assert.equal(Util.serverName({ s1: 'Upstairs' }, 's2', 'Pi').label, 'Pi');
  // Its own name given again is no name of its own.
  assert.equal(Util.serverName({ s1: 'Pi' }, 's1', 'Pi').renamed, false);
  assert.equal(Util.serverName(undefined, 's1', '').name, 'Flow Server');
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

test('the numbers in two columns: created, added, listened (30 s or more), time as dd:hh:mm; streaks, sessions', () => {
  const rows = Statistics.facts({
    name: 'Anna',
    createdAt: at(2026, 3, 2),
    addedSongs: 12,
    statistics: {
      listens: 40,
      seconds: 2 * 86400 + 3 * 3600 + 5 * 60,
      days: { '2026-10-19': 60, '2026-10-20': 900, '2026-10-21': 30 },
      sessions: { '2026-09': { start: 1, end: at(2026, 9, 12), seconds: 9000 }, '2026-10': { start: 1, end: at(2026, 10, 3), seconds: 2700 } },
      longest: { start: at(2026, 9, 12, 10), end: at(2026, 9, 12), seconds: 9000 },
    },
  }, at(2026, 10, 21));
  assert.deepEqual(rows, [[
    ['Created at', '02.03.26'], ['Added songs', '12'], ['Listened songs', '40'], ['Time listened', '02:03:05'],
  ], [
    ['Current streak', '3 days'], ['Highest daily streak', '3 days'], ['Longest session (month)', '45 min (03.10.26)'], ['Longest session (ever)', '2 h 30 min (12.09.26)'],
  ]]);
  const none = Statistics.facts({ name: 'Private' });
  assert.equal(none[0][0][1], '-');
  assert.deepEqual(none[1].map((x) => x[1]), ['0 days', '0 days', '-', '-']);
  // The heading: the server as named on this device; Private has none.
  const anna = { id: 's1/anna1', name: 'Anna', server: 'Pi', serverId: 's1' };
  assert.equal(Statistics.title(anna, { s1: 'Upstairs' }), 'Statistics for profile: Anna at server Upstairs');
  assert.equal(Statistics.title(anna), 'Statistics for profile: Anna at server Pi');
  assert.equal(Statistics.title(Statistics.privateSource({})), 'Statistics for profile: Private');
});

test('the streaks: days in a row with something heard, today not over yet', () => {
  const days = {
    '2026-09-28': 10, '2026-09-29': 10, '2026-09-30': 10, '2026-10-01': 10, '2026-10-03': 10, '2026-10-19': 5, '2026-10-20': 5,
  };
  // Over a month's end: four days.
  assert.deepEqual(Statistics.streaks(days, at(2026, 10, 20)), { current: 2, best: 4 });
  // Nothing yet today: yesterday's streak goes on.
  assert.deepEqual(Statistics.streaks(days, at(2026, 10, 21)), { current: 2, best: 4 });
  // A whole day without: over.
  assert.deepEqual(Statistics.streaks(days, at(2026, 10, 22)), { current: 0, best: 4 });
  assert.deepEqual(Statistics.streaks({ '2026-10-21': 0 }, at(2026, 10, 21)), { current: 0, best: 0 });
  assert.deepEqual(Statistics.streaks(undefined), { current: 0, best: 0 });
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

test('Activity\'s lines: whole steps of 1, 2 or 5, the top one at or just above the highest month', () => {
  const at = (max) => {
    const x = Statistics.scale(max);
    return [x.step, x.lines.length, x.top];
  };
  assert.deepEqual(at(2.7), [0.5, 6, 3]);
  assert.deepEqual(at(44), [10, 5, 50]);
  assert.deepEqual(at(0.5), [0.1, 5, 0.5]);
  // Fitting exactly when it works out.
  assert.deepEqual(at(3), [0.5, 6, 3]);
  assert.deepEqual(at(17.45), [2, 9, 18]);
  assert.deepEqual(at(1000), [200, 5, 1000]);
  // 0.1 h at the least; nothing listened, no lines.
  assert.deepEqual(at(0.02), [0.1, 1, 0.1]);
  assert.deepEqual(Statistics.scale(0), { step: 0, top: 0, lines: [] });
  assert.deepEqual(Statistics.scale(0.74).lines, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  for (let max = 0.05; max < 5000; max *= 1.07) assert.ok(Statistics.scale(max).lines.length <= 10, String(max));
});

test('the Monthly Activity: from January of the year it was made, each year\'s total after its December and after now', () => {
  const st = { months: { '2025-12': 7200, '2026-03': 3600, '2026-10': 1800 } };
  const items = Statistics.timeline(st, at(2025, 11, 5), at(2026, 10, 21));
  assert.equal(items.map((x) => x.name).join(', '), 'January, February, March, April, May, June, July, August, September, October, November, December, 2025, '
    + 'January, February, March, April, May, June, July, August, September, October, 2026');
  assert.deepEqual(items.filter((x) => x.isYear).map((x) => [x.year, x.hours]), [['2025', 2], ['2026', 1.5]]);
  // Made this year: from its January, the year last.
  const now = Statistics.timeline(null, at(2026, 10, 2), at(2026, 10, 21));
  assert.equal(now.length, 11);
  assert.equal(now[0].key, '2026-01');
  assert.deepEqual([now[10].isYear, now[10].hours], [true, 0]);
});

test('the daily Activity: one month\'s days, the current week by weekday, its total after them', () => {
  // Wednesday 21 October 2026.
  const st = { days: { '2026-09-30': 1800, '2026-10-15': 3600, '2026-10-19': 900, '2026-10-21': 1800 } };
  const now = at(2026, 10, 21);
  // The current month: up to today, then its total.
  const oct = Statistics.daily(st, null, now);
  assert.equal(oct.length, 22);
  assert.equal(oct[0].key, '2026-10-01');
  assert.deepEqual(oct.slice(-4).map((x) => `${x.name}/${x.short}/${x.hours}`), ['Monday/Mon/0.25', 'Tuesday/Tue/0', 'Wednesday/Wed/0.5', 'October/Oct/1.75']);
  assert.deepEqual([oct[21].isTotal, oct[21].key, oct[21].year], [true, '2026-10', '2026']);
  // Before this week: dates.
  const sun = oct.find((x) => x.key === '2026-10-18');
  assert.deepEqual([sun.name, sun.short, sun.title], ['18.10', '18.10', 'Sun 18.10.2026']);
  // A month clicked: all its days.
  const sep = Statistics.daily(st, '2026-09', now);
  assert.equal(sep.length, 31);
  assert.deepEqual([sep[29].key, sep[29].name, sep[30].name, sep[30].hours], ['2026-09-30', '30.09', 'September', 0.5]);
  assert.equal(Statistics.daily(null, '2026-02', now).length, 29);
});
