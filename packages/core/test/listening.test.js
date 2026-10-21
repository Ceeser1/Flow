'use strict';

// When and what was listened to (listening.js), and how it travels with the
// library and its profiles.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/listening');
const m = require('../src/libraryModel');
const prof = require('../src/profiles');
const { applyCommand } = require('../src/commands');

const MIN = 60 * 1000;
const at = (iso) => Date.parse(iso);

test('a listen is split by hour, day and month in the app\'s time zone', () => {
  const d = { listening: L.emptyListening() };
  // Thursday 15 October 2026, 9:58 to 10:01 UTC.
  L.recordListening(d, 's1', 180, at('2026-10-15T10:01:00Z'), 0);
  assert.deepEqual(d.listening.days, { '2026-10-15': 180 });
  assert.equal(d.listening.grid.length, 168);
  assert.equal(d.listening.grid[3 * 24 + 9], 120, 'Thursday 9 o\'clock');
  assert.equal(d.listening.grid[3 * 24 + 10], 60, 'Thursday 10 o\'clock');
  assert.equal(d.listening.grid.reduce((a, b) => a + b, 0), 180);
  assert.deepEqual(d.listening.songMonths, { '2026-10': { s1: 180 } });

  // An hour from 23:30 to 0:30 at UTC+2 (offset -120): two days, two months.
  const e = { listening: L.emptyListening() };
  L.recordListening(e, 's1', 3600, at('2026-10-31T22:30:00Z'), -120);
  assert.deepEqual(e.listening.days, { '2026-10-31': 1800, '2026-11-01': 1800 });
  assert.deepEqual(e.listening.songMonths, { '2026-10': { s1: 1800 }, '2026-11': { s1: 1800 } });
  assert.equal(e.listening.grid[5 * 24 + 23], 1800, 'Saturday 23 o\'clock');
  assert.equal(e.listening.grid[6 * 24 + 0], 1800, 'Sunday 0 o\'clock');
});

test('without a time zone the counter\'s own clock is used', () => {
  const d = {};
  const end = at('2026-10-15T12:00:00Z');
  L.recordListening(d, 's1', 60, end);
  const local = new Date(end - 30 * 1000);
  const day = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  assert.deepEqual(d.listening.days, { [day]: 60 });
});

test('listens close together are one session; the longest is kept', () => {
  const d = {};
  const t = at('2026-10-15T20:00:00Z');
  L.recordListening(d, 's1', 200, t, 0);
  // Starts 5 minutes after the first ended: the same session.
  L.recordListening(d, 's2', 180, t + 5 * MIN + 180 * 1000, 0);
  assert.equal(d.listening.run.seconds, 380);
  assert.equal(d.listening.run.start, t - 200 * 1000);
  // 40 minutes later: a new one.
  const later = t + 40 * MIN;
  L.recordListening(d, 's1', 100, later, 0);
  assert.equal(d.listening.run.seconds, 100);
  assert.equal(d.listening.longest.seconds, 380);
  // An old listen arriving late (an app that was offline): a session of its
  // own, the current one stays.
  L.recordListening(d, 's2', 50, t - 2 * 3600 * 1000, 0);
  assert.equal(d.listening.run.seconds, 100);
  assert.equal(d.listening.longest.seconds, 380);
  // The current session grows past the longest.
  L.recordListening(d, 's1', 300, later + 300 * 1000, 0);
  assert.equal(d.listening.run.seconds, 400);
  assert.deepEqual(d.listening.longest, d.listening.run);
  assert.notEqual(d.listening.longest, d.listening.run, 'a copy, not the same object');
});

test('cleaning drops what does not belong; a copy is independent', () => {
  const clean = L.cleanListening({
    days: { '2026-10-15': 30, nonsense: 5, '2026-10-16': -3 },
    grid: [1, 2, 3],
    songMonths: { '2026-10': { s1: 10, 'bad id!': 5 }, '2026-1': { s1: 4 }, '2026-11': {} },
    run: { start: 10, end: 5, seconds: 3 },
    longest: { start: 10, end: 20, seconds: 7 },
  });
  assert.deepEqual(clean, {
    days: { '2026-10-15': 30 }, grid: [], songMonths: { '2026-10': { s1: 10 } }, run: null, late: null, longest: { start: 10, end: 20, seconds: 7 },
  });
  assert.deepEqual(L.cleanListening(null), L.emptyListening());
  const copy = L.copyListening(clean);
  copy.songMonths['2026-10'].s1 = 99;
  copy.days.x = 1;
  assert.equal(clean.songMonths['2026-10'].s1, 10);
  assert.equal(clean.days.x, undefined);
  assert.equal(L.cleanTz('x'), null);
  assert.equal(L.cleanTz(-120), -120);
  assert.equal(L.cleanTz(5000), null);
});

test('the library counts listens of 5 seconds or more and keeps them through sanitize', () => {
  const d = m.sanitize({ songs: [{ id: 's1', file: 'a.mp3', duration: 240 }] });
  assert.deepEqual(d.listening, L.emptyListening());
  m.recordListen(d, 's1', { listened: 3, duration: 240, at: at('2026-10-15T10:00:00Z'), tz: 0 });
  assert.deepEqual(d.listening.days, {});
  m.recordListen(d, 's1', { listened: 240, duration: 240, at: at('2026-10-15T10:00:00Z'), tz: 0 });
  assert.deepEqual(d.listening.days, { '2026-10-15': 240 });
  assert.deepEqual(m.sanitize(JSON.parse(JSON.stringify(d))).listening, d.listening);
  // The command carries the app's time zone.
  applyCommand(d, {
    type: 'recordListen', songId: 's1', listened: 60, duration: 240, at: at('2026-10-15T23:30:00Z'), tz: -120,
  });
  assert.equal(d.listening.days['2026-10-16'], 60);
});

test('each profile keeps its own listening; ownerSummary adds up its numbers', () => {
  const data = m.sanitize({
    songs: [
      { id: 's1', file: 'a.mp3', duration: 300, addedBy: 'anna', stats: { plays: 2, stops: 1, skips: 4, listened: 900 } },
      { id: 's2', file: 'b.mp3', duration: 200, addedBy: 'default' },
    ],
  });
  const profiles = {};
  prof.addProfile(data, profiles, 'anna');
  prof.addProfile(data, profiles, 'ben');
  const run = (id, cmd) => {
    const v = prof.view(data, profiles, id);
    applyCommand(v, cmd, null, id);
    prof.absorb(data, profiles, id, v);
  };
  const when = at('2026-10-15T10:00:00Z');
  run('anna', { type: 'recordListen', songId: 's1', listened: 300, duration: 300, at: when, tz: 0 });
  run('anna', { type: 'recordListen', songId: 's2', listened: 20, duration: 200, at: when + MIN, tz: 0 });
  assert.deepEqual(profiles.anna.listening.days, { '2026-10-15': 320 });
  assert.deepEqual(profiles.ben.listening.days, {});
  assert.deepEqual(data.listening.days, {}, 'the Default heard nothing');
  assert.deepEqual(prof.view(data, profiles, 'anna').listening.days, { '2026-10-15': 320 });
  // A view's copy can be changed without changing the profile.
  prof.view(data, profiles, 'anna').listening.days['2026-10-15'] = 1;
  assert.equal(profiles.anna.listening.days['2026-10-15'], 320);
  // Through the library file and back.
  const again = prof.sanitizeProfiles(data, JSON.parse(JSON.stringify(profiles)));
  assert.deepEqual(again.anna.listening, profiles.anna.listening);

  assert.deepEqual(prof.ownerSummary(data, profiles, 'anna'), { addedSongs: 1, listens: 1, seconds: 320 });
  assert.deepEqual(prof.ownerSummary(data, profiles, 'ben'), { addedSongs: 0, listens: 0, seconds: 0 });
  assert.deepEqual(prof.ownerSummary(data, profiles, prof.DEFAULT_OWNER), { addedSongs: 1, listens: 3, seconds: 900 });
});

test('an evening sent late, in order, is one session', () => {
  const d = {};
  const now = Date.parse('2026-10-16T12:00:00Z');
  L.recordListening(d, 's1', 300, now, 0);
  const evening = Date.parse('2026-10-15T20:00:00Z');
  for (let i = 0; i < 6; i += 1) L.recordListening(d, 's2', 300, evening + i * 5 * MIN, 0);
  assert.equal(d.listening.run.end, now, 'the current one stays');
  assert.equal(d.listening.late.seconds, 1800);
  assert.equal(d.listening.longest.seconds, 1800);
  // An even older one apart from both: a new late one.
  L.recordListening(d, 's2', 100, evening - 5 * 3600 * 1000, 0);
  assert.equal(d.listening.late.seconds, 100);
  assert.equal(d.listening.longest.seconds, 1800);
  assert.deepEqual(L.cleanListening(JSON.parse(JSON.stringify(d.listening))).late, d.listening.late);
});

test('the Statistics totals: time, listens of 30 s or more, months in the app\'s time zone', () => {
  const d = m.sanitize({ songs: [{ id: 's1', file: 'a.mp3', duration: 240 }] });
  assert.deepEqual(d.statistics, L.emptyStatistics(), 'not started: a library from before 3.6');
  m.recordListen(d, 's1', { listened: 3, duration: 240, at: at('2026-10-15T10:00:00Z'), tz: 0 });
  assert.equal(d.statistics.seconds, 0, 'under 5 seconds counts nowhere');
  m.recordListen(d, 's1', { listened: 20, duration: 240, at: at('2026-10-15T10:00:00Z'), tz: 0 });
  assert.equal(d.statistics.since, at('2026-10-15T10:00:00Z'), 'started by its first listen');
  assert.deepEqual([d.statistics.seconds, d.statistics.listens], [20, 0]);
  m.recordListen(d, 's1', { listened: 30, duration: 240, at: at('2026-10-15T10:05:00Z'), tz: 0 });
  assert.deepEqual([d.statistics.seconds, d.statistics.listens], [50, 1]);
  // An hour over midnight into November, two hours east of UTC.
  m.recordListen(d, 's1', { listened: 240, duration: 240, at: at('2026-10-31T22:02:00Z'), tz: -120 });
  assert.deepEqual(d.statistics.months, { '2026-10': 170, '2026-11': 120 });
  assert.equal(d.statistics.listens, 2);
  assert.deepEqual(m.sanitize(JSON.parse(JSON.stringify(d))).statistics, d.statistics);
  // Deleting the song does not lower them.
  m.removeSong(d, 's1');
  assert.equal(d.statistics.seconds, 290);
  assert.deepEqual(L.cleanStatistics({ since: -1, seconds: 'x', listens: 2.7, months: { '2026-1': 5, '2026-02': 9 } }), {
    since: 0, seconds: 0, listens: 2, months: { '2026-02': 9 }, days: {}, sessions: {}, run: null, late: null, longest: null,
  });
  const copy = L.copyStatistics(d.statistics);
  copy.months['2026-10'] = 1;
  copy.days['2026-10-15'] = 1;
  copy.longest.seconds = 1;
  assert.equal(d.statistics.months['2026-10'], 170);
  assert.equal(d.statistics.days['2026-10-15'], 50);
  assert.equal(d.statistics.longest.seconds, 240);
});

test('the Statistics by day, and the longest session of each month and ever', () => {
  const d = m.sanitize({ songs: [{ id: 's1', file: 'a.mp3', duration: 600 }] });
  const listen = (listened, when, tz = 0) => m.recordListen(d, 's1', { listened, duration: 600, at: at(when), tz });
  listen(300, '2026-10-14T20:00:00Z');
  listen(600, '2026-10-14T20:10:00Z');
  // Over midnight two hours east of UTC: 22:05 UTC is 00:05 on the 15th.
  listen(600, '2026-10-14T22:05:00Z', -120);
  assert.deepEqual(d.statistics.days, { '2026-10-14': 1200, '2026-10-15': 300 });
  // A gap of more than ten minutes starts a new session.
  assert.deepEqual([d.statistics.run.seconds, d.statistics.longest.seconds], [600, 900]);
  assert.deepEqual(d.statistics.sessions, { '2026-10': { start: at('2026-10-14T19:55:00Z'), end: at('2026-10-14T20:10:00Z'), seconds: 900 } });
  // A session going into November counts there whole.
  listen(600, '2026-11-01T00:05:00Z');
  listen(600, '2026-11-01T00:15:00Z');
  assert.deepEqual(Object.entries(d.statistics.sessions).map(([k, v]) => [k, v.seconds]), [['2026-10', 900], ['2026-11', 1200]]);
  assert.equal(d.statistics.longest.seconds, 1200);
  assert.deepEqual(m.sanitize(JSON.parse(JSON.stringify(d))).statistics, d.statistics);
  // A library from 3.6.0 without them: counted from now on.
  const old = m.sanitize({ songs: [{ id: 's1', file: 'a.mp3', duration: 600 }], statistics: { since: 5, seconds: 90, listens: 1, months: { '2026-10': 90 } } });
  m.recordListen(old, 's1', { listened: 60, duration: 600, at: at('2026-10-20T12:00:00Z'), tz: 0 });
  assert.deepEqual([old.statistics.days, old.statistics.sessions['2026-10'].seconds, old.statistics.seconds], [{ '2026-10-20': 60 }, 60, 150]);
});

test('each profile keeps its own Statistics; startStatistics starts every owner once', () => {
  const data = m.sanitize({ songs: [{ id: 's1', file: 'a.mp3', duration: 300 }] });
  const profiles = prof.sanitizeProfiles(data, { anna: { listening: { days: { '2026-10-01': 50 } } } });
  assert.equal(profiles.anna.statistics.since, 0);
  const t0 = at('2026-10-20T12:00:00Z');
  assert.equal(prof.startStatistics(data, profiles, t0), true);
  assert.equal(data.statistics.since, t0);
  assert.equal(profiles.anna.statistics.since, t0);
  assert.deepEqual(profiles.anna.listening.days, { '2026-10-01': 50 }, '3.5 data is kept');
  assert.equal(prof.startStatistics(data, profiles, t0 + 1), false, 'only once');
  prof.addProfile(data, profiles, 'ben', undefined, t0 + 5);
  assert.equal(profiles.ben.statistics.since, t0 + 5);
  const v = prof.view(data, profiles, 'anna');
  applyCommand(v, { type: 'recordListen', songId: 's1', listened: 300, duration: 300, at: t0 + MIN, tz: 0 });
  prof.absorb(data, profiles, 'anna', v);
  assert.deepEqual([profiles.anna.statistics.seconds, profiles.anna.statistics.listens], [300, 1]);
  assert.equal(profiles.ben.statistics.seconds, 0);
  assert.equal(data.statistics.seconds, 0, 'the core leaves the Default to the server');
  assert.deepEqual(prof.sanitizeProfiles(data, JSON.parse(JSON.stringify(profiles))).anna.statistics, profiles.anna.statistics);
  assert.deepEqual(prof.view(data, profiles, null).statistics, data.statistics);
});
