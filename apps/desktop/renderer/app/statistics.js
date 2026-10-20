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
  const pad2 = (n) => String(n).padStart(2, '0');
  const emptyStatistics = () => ({ since: 0, seconds: 0, listens: 0, months: {} });

  /** 'YYYY-MM' of a moment, in this machine's time. */
  function monthKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
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

  /** The rows under "Your Statistics for ...": [label, value]. */
  function facts(src) {
    const st = src.statistics || emptyStatistics();
    return [
      ['Profile', src.name],
      ['Created at', Util.fmtDay(src.createdAt) || '-'],
      ['Added songs', String(src.addedSongs || 0)],
      ['Listened songs', String(st.listens || 0)],
      ['Time listened', Util.fmtListened(st.seconds)],
    ];
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
        since: Number(d.since) || 0, seconds: Number(d.seconds) || 0, listens: Number(d.listens) || 0, months: d.months || {},
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

  /**
   * What the Current Profile says: [{ kind, text }], kind 'green', 'amber'
   * or 'grey'. The server's name while connected; the last one's while not.
   */
  function hints(st) {
    const s = st || {};
    const online = s.on && s.state === 'online';
    const name = (online && s.name) || s.serverName || s.name || 'the Flow Server';
    const own = 'using your App\'s private profile';
    const out = [];
    if (s.on && s.profile) {
      out.push(online
        ? { kind: 'green', text: `Connected to ${name} - Using the connected profile of this server` }
        : { kind: 'amber', text: `Not connected to ${name} - Using last connected profile of this server` });
    } else if (online) {
      out.push({ kind: 'grey', text: `Connected to ${name} - Not logged in to a profile, ${own}` });
    } else if (s.serverId) {
      out.push({ kind: 'grey', text: `Not connected to ${s.on ? name : 'any server'} - ${own[0].toUpperCase()}${own.slice(1)}` });
    } else {
      out.push({ kind: 'grey', text: `Never connected to any server - ${own[0].toUpperCase()}${own.slice(1)}` });
    }
    if (online && !s.statistics) {
      out.push({ kind: 'amber', text: `${name} is older than Flow 3.6: its statistics need the latest Flow Server. Update it to count your listens there.` });
    }
    return out;
  }

  return {
    PRIVATE, MONTHS, months, facts, sources, hints, currentId, privateSource,
  };
}));
