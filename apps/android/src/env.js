'use strict';

// What the shared Flow Server client (@flow/core/client/remote) gets from the
// Android app, as the desktop's apps/desktop/src/env.js gives it there: files
// in the app's own storage, requests through the WebView, secrets in the
// Android Keystore, the phone's name. Settings, the Local Files library and
// the client's own files are JSON files in the app's storage.

const { createSettings } = require('@flow/core/client/settings');
const { createLocalLibrary } = require('@flow/core/client/localLibrary');
const { fs, path, plugin, info, secrets, isMetered } = require('./native');
const { request, stream } = require('./http');
const { createCovers } = require('./covers');

function readJson(file) {
  try {
    return JSON.parse(fs.readText(file) || 'null');
  } catch {
    return null;
  }
}

const writeJson = (file, value) => fs.writeText(file, JSON.stringify(value));

/** A server's answer to the discovery question (as @flow/core/discovery parseReply). */
function parseReply(text, address) {
  try {
    const m = JSON.parse(text);
    const port = Math.round(Number(m && m.port));
    if (!m || m.app !== 'flow-server' || !address || !(port > 0 && port < 65536)) return null;
    return {
      ip: String(address),
      port,
      name: String(m.name || 'Flow Server').slice(0, 60),
      id: String(m.id || ''),
      protocol: Number(m.protocol) || 0,
    };
  } catch {
    return null;
  }
}

/** tellCovers(scope, ids): covers arrived. */
function createEnv({ tellCovers }) {
  const phone = info();
  const root = phone.files;
  const file = (name) => path.join(root, name);
  const musicDir = file('Music');
  const cacheDir = phone.cache;

  const settings = createSettings({
    read: () => readJson(file('settings.json')),
    write: (value) => writeJson(file('settings.json'), value),
  });

  // Local Files: songs kept on the phone, downloaded from a server or added
  // from the phone's own files (localFiles.js). Only Flow puts files in its
  // Music folder, so there is nothing to scan.
  const library = createLocalLibrary({
    read: () => readJson(file('library.json')),
    write: (data) => writeJson(file('library.json'), data),
  });
  library.quietly = async (fn) => fn();
  library.scan = async () => ({ added: 0, removed: 0, moved: 0 });

  const covers = createCovers({ root: file('Covers'), tell: tellCovers });

  // The addresses this phone had at the last search: a server answering from
  // one of them runs on the phone itself.
  let own = [];

  return {
    settings,
    library,
    covers,
    // The client's own files (server-library.json, server-sync.json, server-trims.json).
    jsonFiles: {
      read: (name) => readJson(file(name)),
      write: (name, value) => writeJson(file(name), value),
    },
    files: {
      exists: (p) => fs.exists(p),
      rm: (p, { recursive = false, force = false } = {}) => {
        try {
          fs.remove(p, { recursive });
        } catch (err) {
          if (!force) throw err;
        }
      },
      rename: (from, to) => fs.rename(from, to),
      read: (p) => {
        const bytes = fs.readBytes(p);
        if (!bytes) throw new Error(`Not there: ${p}`);
        return bytes;
      },
      mkdir: (dir) => fs.mkdir(dir),
      join: path.join,
      dirname: path.dirname,
      extname: path.extname,
    },
    paths: { musicDir: () => musicDir, cacheDir: () => cacheDir },
    exporter: {
      uniquePath(stem, ext) {
        let dest = path.join(musicDir, `${stem}.${ext}`);
        for (let n = 2; fs.exists(dest); n += 1) dest = path.join(musicDir, `${stem} (${n}).${ext}`);
        return dest;
      },
      // A server's song is cut by the server; the phone cuts no files itself.
      trimSong: async () => {
        throw new Error('Songs are cut by the Flow Server, not on the phone.');
      },
    },
    http: { request, stream },
    secrets,
    device: { name: () => phone.device || 'Android' },
    discovery: {
      async find() {
        const r = await plugin.discover({ timeout: 2500, sends: 3 });
        own = r.own || [];
        const found = new Map();
        for (const a of r.answers || []) {
          const server = parseReply(a.text, a.address);
          if (server) found.set(server.id || `${server.ip}:${server.port}`, server);
        }
        return [...found.values()];
      },
      addressOf: (server) => `${own.includes(server.ip) ? 'localhost' : server.ip}:${server.port}`,
    },
    network: { isMetered: async () => isMetered() },
  };
}

module.exports = { createEnv };
