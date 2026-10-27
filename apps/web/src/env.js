'use strict';

// What the shared Flow Server client (@flow/core/client/remote) gets from the
// web player, as the desktop's apps/desktop/src/env.js gives it there. The
// page keeps no songs: Local Files stays empty, covers are shown straight
// from the server (streamCovers; main.js's fileUrl), and what the client
// writes goes to the browser (storage.js) or the page's memory (memfs.js).

const { createSettings } = require('@flow/core/client/settings');
const { createLocalLibrary } = require('@flow/core/client/localLibrary');
const { createStorage } = require('./storage');
const { createMemFs, path, ROOT } = require('./memfs');
const { createHttp } = require('./http');

const LOCAL = 'local';
const COVERS = path.join(ROOT, 'Covers');

/** The browser and the system it runs on, as a session's device name: "Firefox - Windows". */
function deviceName(ua = (globalThis.navigator && navigator.userAgent) || '') {
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  let system = '';
  if (/Android/.test(ua)) system = 'Android';
  else if (/iPhone|iPad|iPod/.test(ua)) system = 'iOS';
  else if (/Windows/.test(ua)) system = 'Windows';
  else if (/Mac OS X|Macintosh/.test(ua)) system = 'macOS';
  else if (/CrOS/.test(ua)) system = 'ChromeOS';
  else if (/Linux/.test(ua)) system = 'Linux';
  return system ? `${browser} - ${system}` : browser;
}

/**
 * Covers as the shared client asks for them (the desktop's covers.js), with
 * none kept: the window loads each from the server. Only the folders' names
 * matter, which main.js's fileUrl turns into the server's addresses.
 */
function createCovers({ tell }) {
  const dirOf = (scope) => path.join(COVERS, scope);
  const storeOf = (scope) => ({
    dir: dirOf(scope),
    file: (id) => path.join(dirOf(scope), `${id}.jpg`),
    has: () => false,
    read: () => null,
    write: () => '',
    remove: () => {},
    ids: () => [],
    size: () => ({ count: 0, bytes: 0 }),
  });
  return {
    LOCAL,
    dirOf,
    storeOf,
    localStore: () => storeOf(LOCAL),
    tell: (scope, ids) => {
      if (ids && ids.length) tell(scope, ids);
    },
    versionOf: () => '',
    copyToLocal: () => null,
    copyToServer: () => false,
    serverIds: () => [],
    removeServer: () => {},
  };
}

/** tellCovers(scope, ids): covers arrived. vorbis: whether this browser plays Ogg Vorbis. */
function createEnv({ tellCovers, vorbis = true, storage = createStorage() }) {
  const memfs = createMemFs();
  const http = createHttp(memfs);
  const musicDir = path.join(ROOT, 'Music');
  const cacheDir = path.join(ROOT, 'Cache');

  const settings = createSettings({
    read: () => storage.readJson('settings.json'),
    write: (value) => storage.writeJson('settings.json', value),
  });

  // Local Files: always empty, the page has no songs of its own.
  const library = createLocalLibrary({ read: () => null, write: () => {} });
  library.quietly = async (fn) => fn();
  library.scan = async () => ({ added: 0, removed: 0, moved: 0 });

  return {
    storage,
    memfs,
    settings,
    library,
    covers: createCovers({ tell: tellCovers }),
    streamCovers: true,
    jsonFiles: {
      read: (name) => storage.readJson(name),
      write: (name, value) => storage.writeJson(name, value),
      remove: (name) => storage.removeJson(name),
    },
    // The Lyrics folder (@flow/core/client/lyricsFolder), in memory.
    lyricsFiles: {
      dir: () => path.join(ROOT, 'Lyrics'),
      join: path.join,
      fs: {
        readText: (p) => memfs.readText(p),
        writeText: (p, text) => memfs.writeText(p, text),
        list: (p) => memfs.list(p),
        remove: (p, opts) => {
          if (memfs.exists(p)) memfs.remove(p, opts);
        },
        mkdir: (p) => memfs.mkdir(p),
      },
    },
    files: {
      exists: (p) => memfs.exists(p),
      rm: (p, { recursive = false, force = false } = {}) => {
        try {
          memfs.remove(p, { recursive });
        } catch (err) {
          if (!force) throw err;
        }
      },
      rename: (from, to) => memfs.rename(from, to),
      read: (p) => {
        const bytes = memfs.readBytes(p);
        if (!bytes) throw new Error(`Not there: ${p}`);
        return bytes;
      },
      mkdir: (dir) => memfs.mkdir(dir),
      join: path.join,
      dirname: path.dirname,
      extname: path.extname,
    },
    paths: { musicDir: () => musicDir, cacheDir: () => cacheDir },
    exporter: {
      uniquePath(stem, ext, folders = []) {
        const dir = path.join(musicDir, ...folders);
        let dest = path.join(dir, `${stem}.${ext}`);
        for (let n = 2; memfs.exists(dest); n += 1) dest = path.join(dir, `${stem} (${n}).${ext}`);
        return dest;
      },
      trimSong: async () => {
        throw new Error('Songs are cut by the Flow Server, not in the browser.');
      },
    },
    http,
    secrets: storage.secrets,
    device: { name: () => deviceName() },
    // A browser without an Ogg Vorbis decoder (Safari) gets such a song as Opus.
    audioQuery: vorbis ? '' : 'vorbis=0',
    // No ffmpeg here: anything sent up is converted by the server.
    convertUploads: true,
    // A browser cannot look for servers on the network: the address is typed in.
    discovery: {
      find: async () => [],
      addressOf: (server) => `${server.ip}:${server.port}`,
    },
    network: { isMetered: async () => false },
  };
}

module.exports = { createEnv, deviceName };
