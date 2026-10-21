'use strict';

// The Statistics' "All tracked Profiles" (3.6): every Flow Server profile
// this app was signed in to, with its Statistics as last seen, in
// tracked-profiles.json. remote.js updates a profile's row whenever it builds
// the window's library for it (the server's answer plus the listens still
// waiting to go up); a row stays, also when the profile or its server is gone,
// until it is removed by hand. The Default / Shared gets no row: without a
// profile the app's Private Statistics are the ones shown. Shared by the Flow
// apps; no Node.
//
//   row  { serverId, serverName, profileId, profileName, createdAt,
//          statistics, addedSongs, supported, connectedAt, seenAt }
//
//   createdAt    the profile's (the server's profile list)
//   statistics   the library's (listening.js), as the window last saw them
//   addedSongs   songs the profile added (song.addedBy)
//   supported    the server keeps Statistics (3.6 or newer)
//   connectedAt  the last time the app was online with it: the list's order
//   seenAt       the last time the row changed

const { cleanStatistics, copyStatistics } = require('../listening');

const FILE = 'tracked-profiles.json';
const ID = /^[\w-]{1,64}$/;

const keyOf = (serverId, profileId) => `${serverId}/${profileId}`;

function cleanRow(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const serverId = String(r.serverId || '');
  const profileId = String(r.profileId || '');
  if (!ID.test(serverId) || !ID.test(profileId)) return null;
  return {
    serverId,
    serverName: String(r.serverName || '').slice(0, 80),
    profileId,
    profileName: String(r.profileName || '').slice(0, 80),
    createdAt: Math.max(0, Number(r.createdAt) || 0),
    statistics: cleanStatistics(r.statistics),
    addedSongs: Math.max(0, Math.floor(Number(r.addedSongs) || 0)),
    supported: r.supported === true,
    connectedAt: Math.max(0, Number(r.connectedAt) || 0),
    seenAt: Math.max(0, Number(r.seenAt) || 0),
  };
}

/** jsonFiles: the app's { read(name), write(name, value) }. */
function createTrackedProfiles({ jsonFiles }) {
  let rows = null;

  function load() {
    if (rows) return rows;
    rows = {};
    const raw = jsonFiles.read(FILE);
    const list = raw && Array.isArray(raw.rows) ? raw.rows : [];
    for (const r of list) {
      const row = cleanRow(r);
      if (row) rows[keyOf(row.serverId, row.profileId)] = row;
    }
    return rows;
  }

  function save() {
    try {
      jsonFiles.write(FILE, { rows: Object.values(load()) });
    } catch {
      // Kept in memory; the next change tries again.
    }
  }

  /** Every row, the one online last first. */
  function list() {
    return Object.values(load())
      .map((r) => ({ ...r, statistics: copyStatistics(r.statistics) }))
      .sort((a, b) => b.connectedAt - a.connectedAt || b.seenAt - a.seenAt);
  }

  /**
   * A profile's row as the window sees it now; `online`: the app is
   * connected with it. Answers whether anything changed.
   */
  function update(fields, { online = false, now = Date.now() } = {}) {
    const all = load();
    const key = keyOf(fields.serverId, fields.profileId);
    const before = all[key];
    const row = cleanRow({
      ...(before || {}),
      ...fields,
      connectedAt: online ? now : (before ? before.connectedAt : 0),
    });
    if (!row) return false;
    // While online the order moves on with every change; a row whose
    // numbers are the same is only written again a minute later.
    const same = before && JSON.stringify({ ...before, connectedAt: 0, seenAt: 0 }) === JSON.stringify({ ...row, connectedAt: 0, seenAt: 0 });
    if (same && !(online && now - before.connectedAt > 60000)) return false;
    row.seenAt = now;
    all[key] = row;
    save();
    return true;
  }

  function remove(serverId, profileId) {
    const all = load();
    const key = keyOf(serverId, profileId);
    if (!all[key]) return false;
    delete all[key];
    save();
    return true;
  }

  return { list, update, remove };
}

module.exports = { createTrackedProfiles, FILE };
