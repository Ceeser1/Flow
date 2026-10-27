'use strict';

// Where the web player keeps what it must: the page itself holds no data, so
// all of it is in the browser that opened it.
//
//   localStorage    the settings and the few small files that say which
//                   server, which profile, what still waits to go to it
//                   (KEEP), so a reload finds them again
//   sessionStorage  passwords, PINs and the server's token, through
//                   secrets: gone when the browser closes, so the next
//                   visit asks for the server's password again
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

  function decrypt(value) {
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

  return {
    readJson, writeJson, removeJson, secrets: { encrypt, decrypt }, hasSecret,
  };
}

module.exports = { createStorage, KEEP, PREFIX };
