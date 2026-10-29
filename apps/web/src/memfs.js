'use strict';

// Files in the page's memory, for the parts of the shared client that write
// some (a song's cover from the server's download, the Lyrics folder): POSIX
// paths under /flow, gone with the page. url(p) is a file as a blob: address
// for <img> and <audio>, ending in '#' so what the window adds to it (?v=...)
// lands in the fragment instead of breaking the address.

const ROOT = '/flow';

const path = {
  join: (...parts) => parts.filter((p) => p !== '' && p !== undefined && p !== null).join('/').replace(/\/{2,}/g, '/'),
  dirname: (p) => {
    const i = String(p).lastIndexOf('/');
    return i <= 0 ? (i === 0 ? '/' : '.') : String(p).slice(0, i);
  },
  extname: (p) => {
    const name = String(p).slice(String(p).lastIndexOf('/') + 1);
    const i = name.lastIndexOf('.');
    return i <= 0 ? '' : name.slice(i);
  },
  basename: (p) => String(p).slice(String(p).lastIndexOf('/') + 1),
};

const clean = (p) => String(p || '').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

const TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json',
};

function createMemFs() {
  const files = new Map(); // path -> Uint8Array
  const dirs = new Set([ROOT]);
  const urls = new Map(); // path -> blob: address

  function forgetUrl(p) {
    const url = urls.get(p);
    if (!url) return;
    urls.delete(p);
    try {
      URL.revokeObjectURL(url.slice(0, -1));
    } catch {
      // Not a browser (tests).
    }
  }

  function mkdir(p) {
    let d = clean(p);
    while (d && d !== '/' && !dirs.has(d)) {
      dirs.add(d);
      d = path.dirname(d);
    }
  }

  function writeBytes(p, bytes) {
    const f = clean(p);
    mkdir(path.dirname(f));
    forgetUrl(f);
    files.set(f, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  const isDir = (p) => dirs.has(clean(p));
  const exists = (p) => files.has(clean(p)) || isDir(p);

  function remove(p, { recursive = false } = {}) {
    const f = clean(p);
    if (files.has(f)) {
      forgetUrl(f);
      files.delete(f);
      return;
    }
    if (!dirs.has(f)) throw new Error(`Not there: ${p}`);
    const inside = `${f}/`;
    const children = [...files.keys(), ...dirs].some((k) => k.startsWith(inside));
    if (children && !recursive) throw new Error(`Not empty: ${p}`);
    for (const k of [...files.keys()]) {
      if (k.startsWith(inside)) {
        forgetUrl(k);
        files.delete(k);
      }
    }
    for (const k of [...dirs]) if (k.startsWith(inside)) dirs.delete(k);
    dirs.delete(f);
  }

  /** A folder's entries: [{ name, dir, size }]; [] for one that is not there. */
  function list(p) {
    const d = clean(p);
    const inside = d === '/' ? '/' : `${d}/`;
    const out = new Map();
    for (const [k, bytes] of files) {
      if (!k.startsWith(inside)) continue;
      const rest = k.slice(inside.length);
      const name = rest.split('/')[0];
      out.set(name, rest.includes('/') ? { name, dir: true, size: 0 } : { name, dir: false, size: bytes.length });
    }
    for (const k of dirs) {
      if (!k.startsWith(inside)) continue;
      const name = k.slice(inside.length).split('/')[0];
      if (name && !out.has(name)) out.set(name, { name, dir: true, size: 0 });
    }
    return [...out.values()];
  }

  function rename(from, to) {
    const f = clean(from);
    const bytes = files.get(f);
    if (!bytes) throw new Error(`Not there: ${from}`);
    forgetUrl(f);
    files.delete(f);
    writeBytes(to, bytes);
  }

  return {
    mkdir,
    exists,
    isDir,
    list,
    rename,
    remove,
    writeBytes,
    readBytes: (p) => files.get(clean(p)) || null,
    readText: (p) => {
      const bytes = files.get(clean(p));
      return bytes ? new TextDecoder().decode(bytes) : null;
    },
    writeText: (p, text) => writeBytes(p, new TextEncoder().encode(String(text))),
    size: (p) => {
      const bytes = files.get(clean(p));
      return bytes ? bytes.length : -1;
    },
    has: (p) => files.has(clean(p)),
    /** A file here as a blob: address (with a trailing '#'), '' when there is none. */
    url(p) {
      const f = clean(p);
      const bytes = files.get(f);
      if (!bytes) return '';
      if (!urls.has(f)) {
        const blob = new Blob([bytes], { type: TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream' });
        urls.set(f, `${URL.createObjectURL(blob)}#`);
      }
      return urls.get(f);
    },
  };
}

module.exports = { createMemFs, path, ROOT };
