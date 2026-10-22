'use strict';

// When and what was listened to, for the Statistics (3.6): kept by every
// library owner (the Local Files library, a Flow Server's Default / Shared and
// each of its profiles) next to the songs' own stats, which only know how
// much in all. Filled by every listen libraryModel.recordListen counts. Pure.
//
//   days        { 'YYYY-MM-DD': seconds } heard that day
//   grid        168 numbers: seconds heard per weekday and hour, Monday 0-1
//               o'clock first ([] until the first listen)
//   songMonths  { 'YYYY-MM': { songId: seconds } }; a deleted song stays in
//               the months it was heard in
//   run         the listening session going on last: songs heard with gaps of
//               at most RUN_GAP between them { start, end, seconds }, or null
//   late        the session of listens arriving after newer ones (an app that
//               was offline sends its evening later), the same shape, or null
//   longest     the longest such session so far, the same shape, or null
//
// Next to it each owner keeps its Statistics totals (3.6), which only ever
// grow: deleting songs does not lower them, unlike the songs' stats.
//
//   statistics  { since, seconds, listens, months, days, sessions, run, late,
//               longest }: since when it counts (ms; 0: not started, a
//               library from before 3.6: the Flow Server starts every owner
//               at 0 when it first runs 3.6), seconds heard, listens of 30
//               seconds or more, seconds heard per month { 'YYYY-MM': seconds }
//               and per day { 'YYYY-MM-DD': seconds }, the longest session
//               of each month (by the month it ended in) { 'YYYY-MM':
//               { start, end, seconds } },
//               and run / late / longest as above
//
// Dates and hours are the app's own: a listen carries its time zone offset
// (Date.getTimezoneOffset(), minutes), and one without (an app from before
// 3.5) goes by the clock of whoever counts it. A listen is laid out
// backwards from when it was counted (the song changing), and split where an
// hour, a day or a month ends.

const HOUR = 3600 * 1000;
const RUN_GAP = 10 * 60 * 1000;
const GRID = 7 * 24;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const SONG_ID = /^[\w-]{1,64}$/;

// A listen this long or longer is one for the Statistics' Listened songs.
const LISTEN_SECONDS = 30;

function emptyStatistics(since = 0) {
  return {
    since: Number(since) || 0, seconds: 0, listens: 0, months: {}, days: {}, sessions: {}, run: null, late: null, longest: null,
  };
}

function cleanStatistics(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    since: Math.max(0, Number(r.since) || 0),
    seconds: Math.max(0, Number(r.seconds) || 0),
    listens: Math.max(0, Math.floor(Number(r.listens) || 0)),
    months: cleanSeconds(r.months, (k) => MONTH.test(k)),
    days: cleanSeconds(r.days, (k) => DAY.test(k)),
    sessions: cleanSessions(r.sessions),
    run: cleanRun(r.run),
    late: cleanRun(r.late),
    longest: cleanRun(r.longest),
  };
}

function copyStatistics(st) {
  const src = st || emptyStatistics();
  return {
    ...src,
    months: { ...(src.months || {}) },
    days: { ...(src.days || {}) },
    sessions: Object.fromEntries(Object.entries(src.sessions || {}).map(([k, v]) => [k, { ...v }])),
    run: src.run ? { ...src.run } : null,
    late: src.late ? { ...src.late } : null,
    longest: src.longest ? { ...src.longest } : null,
  };
}

function emptyListening() {
  return { days: {}, grid: [], songMonths: {}, run: null, late: null, longest: null };
}

/** Seconds kept to a tenth: enough, and short in the library file. */
const tenth = (n) => Math.round(n * 10) / 10;

function cleanSeconds(raw, keyOk) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, secs] of Object.entries(raw)) {
    const n = Number(secs);
    if (keyOk(key) && Number.isFinite(n) && n > 0) out[key] = n;
  }
  return out;
}

function cleanRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const start = Number(raw.start);
  const end = Number(raw.end);
  const seconds = Number(raw.seconds);
  if (!(start > 0) || !(end >= start) || !(seconds > 0)) return null;
  return { start, end, seconds };
}

/** The statistics' longest session of each month: { 'YYYY-MM': run }. */
function cleanSessions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [month, run] of Object.entries(raw)) {
    const r = cleanRun(run);
    if (MONTH.test(month) && r) out[month] = r;
  }
  return out;
}

/** Repairs anything a hand edit or an older version could have left behind. */
function cleanListening(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const grid = Array.isArray(r.grid) && r.grid.length === GRID
    ? r.grid.map((v) => Math.max(0, Number(v) || 0))
    : [];
  const songMonths = {};
  const months = r.songMonths && typeof r.songMonths === 'object' ? r.songMonths : {};
  for (const [month, songs] of Object.entries(months)) {
    if (!MONTH.test(month)) continue;
    const list = cleanSeconds(songs, (k) => SONG_ID.test(k));
    if (Object.keys(list).length) songMonths[month] = list;
  }
  return {
    days: cleanSeconds(r.days, (k) => DAY.test(k)),
    grid,
    songMonths,
    run: cleanRun(r.run),
    late: cleanRun(r.late),
    longest: cleanRun(r.longest),
  };
}

/** A copy whose parts can be changed without changing `l`. */
function copyListening(l) {
  const src = l || emptyListening();
  const songMonths = {};
  for (const [month, songs] of Object.entries(src.songMonths || {})) songMonths[month] = { ...songs };
  return {
    days: { ...(src.days || {}) },
    grid: (src.grid || []).slice(),
    songMonths,
    run: src.run ? { ...src.run } : null,
    late: src.late ? { ...src.late } : null,
    longest: src.longest ? { ...src.longest } : null,
  };
}

/** A time zone offset as Date.getTimezoneOffset() gives it, or null. */
function cleanTz(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && Math.abs(n) <= 16 * 60 ? n : null;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Counts `seconds` heard of `songId`, ending at `at` (ms), into `data.listening`.
 * `tz`: the app's time zone offset in minutes (null: the counter's own).
 */
function recordListening(data, songId, seconds, at = Date.now(), tz = null) {
  const secs = Number(seconds);
  const end = Number(at) || Date.now();
  if (!(secs > 0)) return;
  if (!data.listening || typeof data.listening !== 'object') data.listening = emptyListening();
  const l = data.listening;
  const offset = (cleanTz(tz) ?? new Date(end).getTimezoneOffset()) * 60000;
  const start = end - secs * 1000;

  // Hour by hour in the app's local time (shifted, then read as UTC).
  let t = start;
  while (t < end) {
    const local = new Date(t - offset);
    const hourEnd = t + (HOUR - (local.getTime() % HOUR));
    const piece = (Math.min(end, hourEnd) - t) / 1000;
    const day = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    const month = day.slice(0, 7);
    l.days[day] = tenth((l.days[day] || 0) + piece);
    if (l.grid.length !== GRID) l.grid = new Array(GRID).fill(0);
    const cell = ((local.getUTCDay() + 6) % 7) * 24 + local.getUTCHours();
    l.grid[cell] = tenth(l.grid[cell] + piece);
    if (!l.songMonths[month]) l.songMonths[month] = {};
    l.songMonths[month][songId] = tenth((l.songMonths[month][songId] || 0) + piece);
    t = hourEnd;
  }

  joinSession(l, start, end, secs);
}

/**
 * The session a listen from `start` to `end` (ms, `secs` heard) belongs to,
 * in `l`'s run / late / longest (listening's or statistics'): it joins the
 * last one when it is close enough to it, else the late one (an app that was
 * offline sends its listens after newer ones, in their order); a newer one
 * starts a new session, an older one apart from both a new late one.
 * Answers the session it is in now.
 */
function joinSession(l, start, end, secs) {
  const near = (r) => r && start <= r.end + RUN_GAP && end >= r.start - RUN_GAP;
  const grow = (r) => {
    r.start = Math.min(r.start, start);
    r.end = Math.max(r.end, end);
    r.seconds = tenth(r.seconds + secs);
    return r;
  };
  let current;
  if (near(l.run)) current = grow(l.run);
  else if (near(l.late)) current = grow(l.late);
  else {
    current = { start, end, seconds: tenth(secs) };
    if (!l.run || end > l.run.end) l.run = current;
    else l.late = current;
  }
  if (!l.longest || current.seconds > l.longest.seconds) l.longest = { ...current };
  return current;
}

/**
 * Counts `seconds` heard, ending at `at` (ms), into `data.statistics`: the
 * time, a listen when 30 seconds or more, the seconds by month and by day in
 * the app's time zone (`tz`, as recordListening), split where a day ends,
 * and the session it is part of.
 */
function recordStatistics(data, seconds, at = Date.now(), tz = null) {
  const secs = Number(seconds);
  const end = Number(at) || Date.now();
  if (!(secs > 0)) return;
  if (!data.statistics || typeof data.statistics !== 'object') data.statistics = emptyStatistics();
  const st = data.statistics;
  if (!st.since) st.since = end;
  st.seconds = tenth(st.seconds + secs);
  if (secs >= LISTEN_SECONDS) st.listens += 1;
  if (!st.days) st.days = {};
  if (!st.sessions) st.sessions = {};
  const offset = (cleanTz(tz) ?? new Date(end).getTimezoneOffset()) * 60000;
  const start = end - secs * 1000;
  let t = start;
  while (t < end) {
    const local = new Date(t - offset);
    const dayEnd = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) + offset;
    const piece = (Math.min(end, dayEnd) - t) / 1000;
    const day = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
    const month = day.slice(0, 7);
    st.months[month] = tenth((st.months[month] || 0) + piece);
    st.days[day] = tenth((st.days[day] || 0) + piece);
    t = dayEnd;
  }
  const session = joinSession(st, start, end, secs);
  const last = new Date(session.end - offset);
  const month = `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}`;
  if (!(st.sessions[month] && st.sessions[month].seconds >= session.seconds)) st.sessions[month] = { ...session };
}

/**
 * What songs' stats add up to: `listens`, the times a song was heard for 30
 * seconds or more (full listens and stops; libraryModel.recordListen), and
 * `seconds` heard in all. `statsList`: the stats of one owner's songs.
 */
function listenTotals(statsList) {
  let listens = 0;
  let seconds = 0;
  for (const st of statsList) {
    if (!st) continue;
    listens += (Number(st.plays) || 0) + (Number(st.stops) || 0);
    seconds += Number(st.listened) || 0;
  }
  return { listens, seconds };
}

module.exports = {
  emptyListening, cleanListening, copyListening, recordListening, listenTotals, cleanTz, RUN_GAP,
  emptyStatistics, cleanStatistics, copyStatistics, recordStatistics, LISTEN_SECONDS,
};
