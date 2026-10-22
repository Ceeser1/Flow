'use strict';

// What Settings' Statistics (3.6, stats.js) shows, worked out from the
// server status (Store.server: the profile in use, the tracked profiles,
// whether the server keeps Statistics) and the app's Private Statistics
// (window.flow.privateStatistics). Pure, so test/statistics.test.js can pin
// it; the window loads it as a plain script and gets `Statistics` as a global.
//
// A "source" is whose Statistics are shown: { id, server, profile, name,
// createdAt, statistics, addedSongs, current, removable }. id 'private' is
// the app's own; a profile's is "<server id>/<profile id>".

(function (root, factory) {
  // eslint-disable-next-line global-require
  const util = typeof Util !== 'undefined' ? Util : require('./util');
  const api = factory(util);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Statistics = api;
}(typeof self !== 'undefined' ? self : this, (Util) => {
  const PRIVATE = 'private';
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad2 = (n) => String(n).padStart(2, '0');
  const emptyStatistics = () => ({
    since: 0, seconds: 0, listens: 0, months: {}, days: {}, sessions: {}, longest: null,
  });

  /** 'YYYY-MM' of a moment, in this machine's time. */
  function monthKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  /** 'YYYY-MM-DD' of a moment, in this machine's time. */
  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** Midday of a 'YYYY-MM-DD' (clear of a clock change) moved by `by` days. */
  function dayAt(key, by = 0) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d + by, 12).getTime();
  }

  function nextMonth(key) {
    let [y, m] = key.split('-').map(Number);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    return `${y}-${pad2(m)}`;
  }

  /**
   * The Activity graph: a bar per month from the month `createdAt` (the
   * profile was made, Private started) to the month of `now`, oldest first:
   * { key, name ("October"), short ("Oct"), year, hours, share } where share
   * is the month's hours against the highest month's (0 to 1).
   */
  function months(statistics, createdAt, now = Date.now()) {
    const st = statistics || emptyStatistics();
    const start = Number(createdAt) || Number(st.since) || now;
    const last = monthKey(now);
    const out = [];
    for (let k = monthKey(Math.min(start, now)); k <= last && out.length < 1200; k = nextMonth(k)) {
      const index = Number(k.slice(5)) - 1;
      out.push({
        key: k,
        name: MONTHS[index],
        short: MONTHS[index].slice(0, 3),
        year: k.slice(0, 4),
        hours: (Number((st.months || {})[k]) || 0) / 3600,
        share: 0,
      });
    }
    const max = Math.max(0, ...out.map((m) => m.hours));
    for (const m of out) m.share = max ? m.hours / max : 0;
    return out;
  }

  /**
   * The PC's Activity: every month (as months() gives them) from January of
   * the year it was made (or Private started) to the month of `now`, and
   * after each December and after the current month that year's total:
   * { isYear: true, key: 'YYYY', name: 'YYYY', year, hours }. Oldest first.
   */
  function timeline(statistics, createdAt, now = Date.now()) {
    const st = statistics || emptyStatistics();
    const start = Math.min(Number(createdAt) || Number(st.since) || now, now);
    const list = months(st, new Date(new Date(start).getFullYear(), 0, 1).getTime(), now);
    const out = [];
    let total = 0;
    list.forEach((m, i) => {
      out.push(m);
      total += m.hours;
      if (m.key.endsWith('-12') || i === list.length - 1) {
        out.push({
          isTotal: true, isYear: true, key: m.year, name: m.year, short: m.year, year: m.year, hours: total,
        });
        total = 0;
      }
    });
    return out;
  }

  /**
   * The daily Activity of one month ('YYYY-MM'; none: the month of `now`):
   * its days up to today, then its total. Days { key: 'YYYY-MM-DD', name,
   * short, title, hours }, named by their weekday in the current week
   * (Monday, short Mon), else by their date (15.10); the total { isTotal:
   * true, isMonth: true, key: 'YYYY-MM', name ('October'), short ('Oct'),
   * year, hours }. Oldest first.
   */
  function daily(statistics, month, now = Date.now()) {
    const st = statistics || emptyStatistics();
    const days = st.days || {};
    const today = dayKey(now);
    const shown = /^\d{4}-\d{2}$/.test(month || '') ? month : today.slice(0, 7);
    // The current week: from Monday on.
    const monday = dayKey(dayAt(today, -((new Date(now).getDay() + 6) % 7)));
    const [y, mon] = shown.split('-').map(Number);
    const length = new Date(y, mon, 0).getDate();
    const out = [];
    let total = 0;
    for (let d = 1; d <= length; d += 1) {
      const key = `${shown}-${pad2(d)}`;
      if (key > today) break;
      const weekday = WEEKDAYS[new Date(y, mon - 1, d).getDay()];
      const date = `${pad2(d)}.${pad2(mon)}`;
      const hours = (Number(days[key]) || 0) / 3600;
      total += hours;
      out.push({
        key,
        name: key >= monday ? weekday : date,
        short: key >= monday ? weekday.slice(0, 3) : date,
        title: `${weekday.slice(0, 3)} ${date}.${y}`,
        hours,
      });
    }
    out.push({
      isTotal: true, isMonth: true, key: shown, name: MONTHS[mon - 1], short: MONTHS[mon - 1].slice(0, 3), year: String(y), hours: total,
    });
    return out;
  }

  /**
   * The streaks: { current, best } in days in a row with something heard
   * (`days` as statistics.days). The current one goes on through today
   * while nothing was heard yet today (it ends when a day passes without).
   */
  function streaks(days, now = Date.now()) {
    const heard = (k) => (Number((days || {})[k]) || 0) > 0;
    let best = 0;
    let run = 0;
    let before = '';
    for (const k of Object.keys(days || {}).filter(heard).sort()) {
      run = before && dayKey(dayAt(before, 1)) === k ? run + 1 : 1;
      best = Math.max(best, run);
      before = k;
    }
    let k = dayKey(now);
    if (!heard(k)) k = dayKey(dayAt(k, -1));
    let current = 0;
    while (heard(k) && current < 100000) {
      current += 1;
      k = dayKey(dayAt(k, -1));
    }
    return { current, best };
  }

  /** A session's length: 45 min, 2 h 5 min; under a minute <1 min; none -. */
  function fmtSession(seconds) {
    const s = Number(seconds) || 0;
    if (!(s > 0)) return '-';
    const minutes = Math.floor(s / 60);
    if (!minutes) return '<1 min';
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  }

  /**
   * The Activity graph's lines (the PC's): a step of 1, 2 or 5 times a power
   * of ten hours, 0.1 h at the least, the one nearest a fifth of the highest
   * month, and lines up to the first one at or above it (10 at most):
   * { step, top, lines } in hours, lines from the lowest up; the bars are
   * drawn against top. No hours at all: no lines, top 0.
   */
  function scale(maxHours) {
    const max = Number(maxHours) || 0;
    if (!(max > 0)) return { step: 0, top: 0, lines: [] };
    const rough = max / 5;
    const power = 10 ** Math.floor(Math.log10(rough));
    const choices = [1, 2, 5, 10].map((n) => Math.round(n * power * 10) / 10).filter((n) => n >= 0.1);
    const step = choices.length
      ? choices.reduce((best, n) => (Math.abs(n - rough) < Math.abs(best - rough) ? n : best))
      : 0.1;
    // A hair over a whole step is not a step more (2.7000001 h at 0.5 h: 6 lines).
    const count = Math.max(1, Math.ceil(max / step - 1e-9));
    const lines = [];
    for (let k = 1; k <= count; k += 1) lines.push(Math.round(k * step * 10) / 10);
    return { step, top: lines[lines.length - 1], lines };
  }

  /**
   * The heading of the picked one's numbers; `names`: Settings' serverNames
   * (the server as named on this device).
   */
  function title(src, names) {
    if (src.id === PRIVATE) return `Statistics for profile: ${src.name}`;
    return `Statistics for profile: ${src.name} at server ${Util.serverName(names, src.serverId, src.server).name}`;
  }

  /**
   * The picked one's numbers in two columns of [label, value]: the totals,
   * then the streaks and the longest sessions (with the day they ended).
   */
  function facts(src, now = Date.now()) {
    const st = src.statistics || emptyStatistics();
    const streak = streaks(st.days, now);
    const days = (n) => `${n} ${n === 1 ? 'day' : 'days'}`;
    const session = (r) => (r && r.seconds > 0 ? `${fmtSession(r.seconds)} (${Util.fmtDay(r.end)})` : '-');
    return [[
      ['Created at', Util.fmtDay(src.createdAt) || '-'],
      ['Added songs', String(src.addedSongs || 0)],
      ['Listened songs', String(st.listens || 0)],
      ['Time listened', Util.fmtListened(st.seconds)],
    ], [
      ['Current streak', days(streak.current)],
      ['Highest daily streak', days(streak.best)],
      ['Longest session (month)', session((st.sessions || {})[monthKey(now)])],
      ['Longest session (ever)', session(st.longest)],
    ]];
  }

  /** The app's Private Statistics as a source. */
  function privateSource(data) {
    const d = data || {};
    return {
      id: PRIVATE,
      server: '',
      profile: 'Private',
      name: 'Private',
      createdAt: Number(d.since) || 0,
      statistics: {
        since: Number(d.since) || 0,
        seconds: Number(d.seconds) || 0,
        listens: Number(d.listens) || 0,
        months: d.months || {},
        days: d.days || {},
        sessions: d.sessions || {},
        longest: d.longest || null,
      },
      addedSongs: Number(d.added) || 0,
      current: false,
      // Private always counts: there is nothing to remove.
      removable: false,
    };
  }

  /** The id of whose Statistics count now: the profile in use, else Private. */
  function currentId(st) {
    const s = st || {};
    return s.on && s.profile && s.serverId ? `${s.serverId}/${s.profile.id}` : PRIVATE;
  }

  /**
   * Every source to pick from: the tracked profiles (the one online last
   * first), then Private. The profile in use is there even before its first
   * row is written.
   */
  function sources(st, privateData) {
    const s = st || {};
    const now = currentId(s);
    const list = (s.tracked || []).map((r) => ({
      id: `${r.serverId}/${r.profileId}`,
      server: r.serverName || 'Flow Server',
      profile: r.profileName || 'Profile',
      name: r.profileName || 'Profile',
      createdAt: r.createdAt,
      statistics: r.statistics,
      addedSongs: r.addedSongs,
      current: false,
      removable: true,
      serverId: r.serverId,
      profileId: r.profileId,
    }));
    if (now !== PRIVATE && !list.some((x) => x.id === now)) {
      list.unshift({
        id: now,
        server: s.serverName || s.name || 'Flow Server',
        profile: s.profile.name,
        name: s.profile.name,
        createdAt: s.profile.createdAt,
        statistics: emptyStatistics(),
        addedSongs: 0,
        current: false,
        removable: true,
        serverId: s.serverId,
        profileId: s.profile.id,
      });
    }
    list.push(privateSource(privateData));
    for (const x of list) {
      x.current = x.id === now;
      if (x.current) x.removable = false;
    }
    return list;
  }

  return {
    PRIVATE, MONTHS, months, timeline, daily, streaks, scale, title, facts, sources, currentId, privateSource,
  };
}));
