'use strict';

// The library's changes pushed to the apps (4.3) over their live channels
// (live.js), instead of each app asking every few seconds. An app opens its
// channel with the revisions its copy is at (?rev= library, ?srev= its
// owner's stats); from then on the server keeps them per channel and sends
//
//   event: library  library.changes() since the channel's revision: { from,
//                   rev, songs, playlists, ... }, or { rev, stale: true } when
//                   too much is missing (the app then asks GET /api/library)
//   event: stats    the owner's statsChanges() since: { from, rev, songs,
//                   playlistListened? }, or { rev, stale: true }
//
// only when something the app sees changed (another profile's playlist
// moves the revision but sends nothing). Changes coming quickly one after
// another (a folder scan, a batch of covers) go together, at most MAX_WAIT_MS
// after the first. An app whose answer to its own commands carried the
// changes already (POST /api/commands) is not sent them again (caughtUp).

const DELAY_MS = 250;
const MAX_WAIT_MS = 2000;

function createPush({ library, live, delayMs = DELAY_MS, maxWaitMs = MAX_WAIT_MS }) {
  let timer = null;
  let first = 0;

  const known = (n) => Number.isFinite(n) && n >= 0;

  /** Brings one channel's app up to date. */
  function pushTo(client) {
    const info = live.info(client);
    // flow-server doctor's test, or signed in to another profile since the
    // channel opened (its revisions are another owner's): nothing.
    if (!info || info.probe || (info.profileId || null) !== (info.syncProfile || null)) return;
    if (known(info.rev) && info.rev < library.rev) {
      const c = library.changes(info.profileId, info.rev);
      if (c.full) live.send(client, 'library', { rev: c.rev, stale: true });
      else if (!library.noChanges(c)) live.send(client, 'library', c);
      info.rev = c.rev;
    }
    const srev = library.statsRev(info.profileId);
    if (known(info.srev) && info.srev < srev) {
      const s = library.statsChanges(info.profileId, info.srev);
      live.send(client, 'stats', s.full ? { rev: s.rev, stale: true } : s);
      info.srev = s.rev;
    }
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    first = 0;
    for (const c of live.clients()) pushTo(c.client);
  }

  /** Something changed: every app is told shortly. */
  function soon() {
    const now = Date.now();
    if (!first) first = now;
    clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(delayMs, first + maxWaitMs - now)));
    if (timer.unref) timer.unref();
  }

  /** An app's answer carried what changed up to these revisions: they are its channel's now. */
  function caughtUp(client, { rev, srev } = {}) {
    const info = client ? live.info(client) : null;
    if (!info) return;
    if (known(rev) && known(info.rev)) info.rev = Math.max(info.rev, rev);
    if (known(srev) && known(info.srev)) info.srev = Math.max(info.srev, srev);
  }

  library.onChange(soon);
  library.onStats(soon);
  // A channel just opened: told at once what its app is missing.
  live.onOpen((client) => pushTo(client));

  return {
    flush, soon, caughtUp, stop: () => clearTimeout(timer),
  };
}

module.exports = { createPush, DELAY_MS, MAX_WAIT_MS };
