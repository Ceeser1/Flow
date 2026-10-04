'use strict';

// Formatting, sorting and small helpers for the window. Written so that
// test/util.test.js can require it under node as well: the window loads it as
// a plain script and gets `Util` as a global.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Util = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const pad2 = (n) => String(n).padStart(2, '0');

  /** 3:05, or 1:02:03 from an hour up. */
  function fmtClock(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }

  /** dd.mm.yy hh:mm */
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${pad2(d.getFullYear() % 100)} `
      + `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 23:45, the clock time of a moment. */
  function fmtTimeOfDay(ms) {
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  /** 00:01:23.456, the trim fields' format (LWClipper's fmtTime). */
  function fmtPrecise(seconds) {
    const v = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(v / 3600);
    const m = Math.floor((v - h * 3600) / 60);
    const s = v - h * 3600 - m * 60;
    return `${pad2(h)}:${pad2(m)}:${s.toFixed(3).padStart(6, '0')}`;
  }

  /** Accepts 90, 1:30, 01:30.5 or 00:01:30.500. Throws on anything else. */
  function parsePrecise(text) {
    const raw = String(text || '').trim().replace(/,/g, '.');
    if (!raw) throw new Error('empty time');
    const parts = raw.split(':');
    if (parts.length > 3) throw new Error('not a time');
    let total = 0;
    for (const part of parts) {
      const v = Number(part);
      if (part === '' || !Number.isFinite(v)) throw new Error('not a time');
      total = total * 60 + v;
    }
    if (total < 0) throw new Error('negative time');
    return total;
  }

  /** file:/// URL for a Windows path, the same as Node's pathToFileURL. */
  function fileUrl(filePath) {
    const p = String(filePath || '').replace(/\\/g, '/');
    // The phone serves its files itself (Capacitor), at addresses of its own.
    if (typeof window !== 'undefined' && window.flow && window.flow.fileUrl) return window.flow.fileUrl(p);
    const enc = (seg) => encodeURIComponent(seg);
    if (p.startsWith('//')) {
      const [host, ...rest] = p.slice(2).split('/');
      return 'file://' + host + '/' + rest.map(enc).join('/');
    }
    const parts = p.split('/');
    return 'file:///' + parts.map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : enc(seg))).join('/');
  }

  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

  /** Ascending comparison where empty text and missing values always go last. */
  function compareValues(a, b) {
    const emptyA = a === '' || a === null || a === undefined;
    const emptyB = b === '' || b === null || b === undefined;
    if (emptyA || emptyB) return emptyA === emptyB ? 0 : (emptyA ? 1 : -1);
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return collator.compare(String(a), String(b));
  }

  /**
   * One click on a column header: ascending, then descending, then back to the
   * list's own order. A different column always starts at ascending.
   */
  function cycleSort(state, key) {
    if (!state || state.key !== key) return { key, dir: 'asc' };
    if (state.dir === 'asc') return { key, dir: 'desc' };
    return { key: null, dir: null };
  }

  /**
   * rows sorted by `state` using `valueOf(row, key)`, or in their given order
   * when there is no sort. Stable, and empty values stay last either way.
   */
  function sortRows(rows, state, valueOf) {
    if (!state || !state.key) return rows.slice();
    const sign = state.dir === 'desc' ? -1 : 1;
    return rows
      .map((row, i) => ({ row, i, v: valueOf(row, state.key) }))
      .sort((x, y) => {
        const ex = x.v === '' || x.v === null || x.v === undefined;
        const ey = y.v === '' || y.v === null || y.v === undefined;
        if (ex !== ey) return ex ? 1 : -1;
        return (sign * compareValues(x.v, y.v)) || (x.i - y.i);
      })
      .map((x) => x.row);
  }

  /** Case- and accent-insensitive "contains" for the search boxes. */
  function fold(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }

  function matches(query, ...fields) {
    const q = fold(query).trim();
    if (!q) return true;
    const hay = fold(fields.join(' \u0000 '));
    return q.split(/\s+/).every((word) => hay.includes(word));
  }

  /** "Title - Artist - (Mix)", the way the player shows a song. */
  function songLine(song) {
    if (!song) return '';
    let line = song.title || 'Untitled';
    if (song.artist) line += ' - ' + song.artist;
    if (song.mix) line += ' - (' + song.mix + ')';
    return line;
  }

  /** "12 songs" / "1 song" */
  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  /** "just now", "5 minutes ago", "3 hours ago", "2 days ago" ... "1 year ago" */
  function fmtAgo(ms, now = Date.now()) {
    const seconds = Math.max(0, (now - ms) / 1000);
    const steps = [
      [60 * 60 * 24 * 365, 'year'],
      [60 * 60 * 24 * 30, 'month'],
      [60 * 60 * 24 * 7, 'week'],
      [60 * 60 * 24, 'day'],
      [60 * 60, 'hour'],
      [60, 'minute'],
    ];
    for (const [size, word] of steps) {
      if (seconds >= size) return `${plural(Math.floor(seconds / size), word)} ago`;
    }
    return 'just now';
  }

  return {
    fmtClock, fmtDate, fmtTimeOfDay, fmtPrecise, parsePrecise, fileUrl,
    compareValues, cycleSort, sortRows, fold, matches, songLine, plural, fmtAgo,
  };
}));
