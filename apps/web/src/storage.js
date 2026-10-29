'use strict';

// Where the web player keeps what it must: the page itself holds no data, so
// all of it is in the browser that opened it.
//
//   localStorage    the settings and the few small files that say which
//                   server, which profile, what still waits to go to it
//                   (KEEP), so a reload finds them again; in them the
//                   server's token (secrets.keep), so the next visit is
//                   signed in to the same server and profile, until Logout
//                   or the browser clears it
//   sessionStorage  passwords and PINs, through secrets: gone when the
//                   browser closes, never kept longer
//   memory          everything else (the server's library, lyrics, a
//                   download's cover): fetched again after a reload
//
// A browser that refuses storage (a private window, cookies blocked) gets
// memory for all of it: Flow still plays, it only forgets on a reload.

const PREFIX = 'flow:';
const SECRET_PREFIX = 'flow-secret:';
const KEEP = new Set(['settings.json', 'server-sync.json', 'server-others.json', 'tracked-profiles.json', 'private-statistics.json']);

function store(kind) {
  try {
    const s = globalThis[kind];
    const probe = `${PREFIX}probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function createStorage({ local = store('localStorage'), session = store('sessionStorage') } = {}) {
  const memory = new Map();
  // Logout: nothing is written any more until the page loads again.
  let frozen = false;

  /** A JSON file by name: its value, or null when there is none. */
  function readJson(name) {
    let text = null;
    if (KEEP.has(name) && local) {
      try {
        text = local.getItem(PREFIX + name);
      } catch {
        text = null;
      }
    } else {
      text = memory.has(name) ? memory.get(name) : null;
    }
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  function writeJson(name, value) {
    if (frozen) return;
    const text = JSON.stringify(value);
    if (KEEP.has(name) && local) {
      try {
        local.setItem(PREFIX + name, text);
        return;
      } catch {
        // Full or refused: kept in memory instead.
      }
    }
    memory.set(name, text);
  }

  function removeJson(name) {
    memory.delete(name);
    try {
      if (local) local.removeItem(PREFIX + name);
    } catch {
      // Nothing kept.
    }
  }

  // Secrets: what the shared client keeps "encrypted" is a key into
  // sessionStorage ('w:<key>'), never the text itself.
  const vault = new Map();
  function encrypt(text) {
    if (!text) return '';
    const key = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(16).padStart(2, '0')).join('');
    vault.set(key, String(text));
    try {
      if (session) session.setItem(SECRET_PREFIX + key, String(text));
    } catch {
      // Kept for this page only.
    }
    return `w:${key}`;
  }

  // The server's token: in the file that holds it ('k:<token>'), so it stays
  // as long as the file does (Logout removes it).
  const keep = (text) => (text ? `k:${text}` : '');

  function decrypt(value) {
    const kept = /^k:(.+)$/.exec(String(value || ''));
    if (kept) return kept[1];
    const m = /^w:([0-9a-f]{18})$/.exec(String(value || ''));
    if (!m) return '';
    if (vault.has(m[1])) return vault.get(m[1]);
    try {
      return (session && session.getItem(SECRET_PREFIX + m[1])) || '';
    } catch {
      return '';
    }
  }

  /** Whether `value` still opens a secret here (a key from a browser session that ended does not). */
  const hasSecret = (value) => !!decrypt(value);

  /**
   * Logout: the files of `names` and every secret of this browser session
   * go, and nothing more is written (what the page still saves on its way
   * out would bring them back).
   */
  function forget(names) {
    for (const name of names) removeJson(name);
    vault.clear();
    try {
      if (session) {
        const keys = [];
        for (let i = 0; i < session.length; i += 1) keys.push(session.key(i));
        for (const k of keys) if (k && k.startsWith(SECRET_PREFIX)) session.removeItem(k);
      }
    } catch {
      // Gone with the browser session anyway.
    }
    frozen = true;
  }

  return {
    readJson, writeJson, removeJson, secrets: { encrypt, decrypt, keep }, hasSecret, forget,
  };
}

module.exports = { createStorage, KEEP, PREFIX };
