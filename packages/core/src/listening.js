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
//   longest     the longest such session so far, the same shape, or null
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

function emptyListening() {
  return { days: {}, grid: [], songMonths: {}, run: null, longest: null };
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

  // The session: this listen joins the last one when it is close enough to
  // it; a later one starts a new session; an older one arriving late (an app
  // that was offline) apart from it only counts as a session of its own.
  const r = l.run;
  let current;
  if (r && start <= r.end + RUN_GAP && end >= r.start - RUN_GAP) {
    r.start = Math.min(r.start, start);
    r.end = Math.max(r.end, end);
    r.seconds = tenth(r.seconds + secs);
    current = r;
  } else {
    current = { start, end, seconds: tenth(secs) };
    if (!r || end > r.end) l.run = current;
  }
  if (!l.longest || current.seconds > l.longest.seconds) l.longest = { ...current };
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
};
