'use strict';

// The server's backups (4.0, @flow/core/backup): <home>/backups, one a week
// (looked at when it starts and every 6 hours), the last 6 kept. Each holds
// library.json and the profiles of server.json (names, PIN hashes, admin
// flags), never the password, the level or a device's token, and none of
// the songs' files.
//
// The master admin restores one in Administration, or flow-server restore
// asks the running server through server.json (restoreRequest), as
// tag-songs does. A backup of what is there is made first.

const path = require('path');
const { createBackupStore, isName } = require('@flow/core/backup');

const CHECK_MS = 6 * 60 * 60 * 1000;
const PROFILE_FIELDS = ['id', 'name', 'createdAt', 'pin', 'admin', 'master', 'disabled'];

/** What a backup keeps of a profile in server.json. */
const profileEntry = (p) => Object.fromEntries(PROFILE_FIELDS.map((k) => [k, p[k]]));

/** A store for the server at `home`, made from its files alone (flow-server backup, the tests). */
function storeFor(config, collect, log) {
  return createBackupStore({
    dir: path.join(config.home, 'backups'),
    kind: 'server',
    collect,
    summary: (payload) => ({
      songs: (payload.library.songs || []).length,
      // The Default / Shared's and every profile's.
      playlists: (payload.library.playlists || []).length + Object.values(payload.library.profiles || {})
        .reduce((n, part) => n + ((part && part.playlists) || []).length, 0),
      profiles: (payload.profiles || []).length,
    }),
    log,
  });
}

/**
 * The profiles a restore leaves in server.json: the backup's (its names,
 * PINs, admins, disabled), each keeping what it has now of its addresses and
 * last seen; those made since stay. The master stays who it is now.
 */
function restoreProfiles(config, saved) {
  const cfg = config.get();
  const now = new Map(cfg.profiles.map((p) => [p.id, p]));
  const master = cfg.profiles.find((p) => p.master);
  const back = (Array.isArray(saved) ? saved : [])
    .filter((b) => b && /^[\w-]{1,64}$/.test(String(b.id || '')) && String(b.name || '').trim())
    .map((b) => ({ ...(now.get(b.id) || {}), ...profileEntry(b) }));
  const ids = new Set(back.map((p) => p.id));
  const since = cfg.profiles.filter((p) => !ids.has(p.id));
  const all = [...back, ...since];
  // A name taken twice (a profile made since under a restored one's name) gets a number.
  const taken = new Set();
  for (const p of all) {
    let name = p.name;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${p.name} (${n})`;
    taken.add(name.toLowerCase());
    p.name = name;
    if (master) p.master = p.id === master.id;
    if (p.master) p.admin = true;
  }
  config.set({ profiles: all });
}

/**
 * The running server's backups. deps: { config, library, log }. Returns
 * { list, make, restore, check, stop }.
 */
function createBackups({ config, library, log = () => {} }) {
  const collect = () => {
    const cfg = config.get();
    return {
      server: { id: cfg.id, name: cfg.name },
      library: library.backupData(),
      profiles: cfg.profiles.map(profileEntry),
    };
  };
  const store = storeFor(config, collect, log);

  /** Puts a backup back (made first: one of what is there). Returns the library's counts. */
  function restore(name) {
    const doc = store.read(name);
    if (doc.kind !== 'server') throw new Error('That is a backup of a Flow app, not of a Flow Server.');
    store.make('restore', name);
    restoreProfiles(config, doc.profiles);
    const counts = library.restoreBackup(doc.library);
    library.scan().catch(() => {});
    return { ...counts, profiles: Array.isArray(doc.profiles) ? doc.profiles.length : 0 };
  }

  /** flow-server restore's request, taken once. */
  function checkRequest() {
    const want = config.get().restoreRequest;
    if (!want) return;
    config.set({ restoreRequest: '' });
    try {
      restore(want);
    } catch (err) {
      log(`restore: ${want} could not be restored: ${err.message}`);
    }
  }

  const timer = setInterval(() => store.weekly(), CHECK_MS);
  if (timer.unref) timer.unref();

  return {
    list: store.list,
    make: (reason) => store.make(reason),
    weekly: store.weekly,
    restore,
    checkRequest,
    stop: () => clearInterval(timer),
  };
}

module.exports = {
  createBackups, storeFor, restoreProfiles, profileEntry, isName,
};
