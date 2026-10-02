'use strict';

// A Flow Server: the library, its music folder and the HTTP side put
// together. main.js starts one from the command line; the tests start their
// own on a free port.

const configMod = require('./config');
const { createLibrary } = require('./library');
const { createHttpServer, PROTOCOL } = require('./http');
const { createDownloads } = require('./downloads');
const { createLive } = require('./live');
const { createSessions } = require('./sessions');
const model = require('@flow/core/libraryModel');
const tools = require('./tools');
const tailscaleMod = require('./tailscale');
const { startDiscovery } = require('./discovery');
const { DISCOVERY_PORT } = require('@flow/core/discovery');
const { version } = require('../package.json');

const RESCAN_MS = 5 * 60 * 1000;
const TRASH_MS = 24 * 60 * 60 * 1000;

/**
 * opts: { home, music, port, host, log, detectTailscale, discoveryPort, livePingMs }.
 * Resolves { port, config, library, tailscale, close }. discoveryPort: the UDP
 * port the apps' search is answered on (null: not at all; left out: the
 * default port if the server's settings say so).
 * Port 0 picks a free one.
 */
async function startServer(opts = {}) {
  const log = opts.log || (() => {});
  const config = configMod.open({ home: opts.home, music: opts.music });
  const library = createLibrary(config, log);
  // The Tailscale address, looked for again now and then: Tailscale may come
  // up after the server does when the machine boots.
  const detectTailscale = opts.detectTailscale || tailscaleMod.detect;
  let tailscale = null;
  const lookForTailscale = async () => {
    try {
      tailscale = await detectTailscale();
    } catch {
      tailscale = null;
    }
  };
  // Downloads by the server itself; batches left from before a restart carry on.
  const downloads = createDownloads({ config, library, tools, log });
  // The apps' live channels (the Active Sessions); nothing about them outlives a restart.
  const live = createLive({ log, pingMs: opts.livePingMs });
  const sessions = createSessions({ live, library: sessionLibrary(library), log });
  const server = createHttpServer({
    config, library, version, log, tailscale: () => tailscale, downloads, live, sessions,
  });

  const port = opts.port !== undefined ? opts.port : config.get().port;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host || '0.0.0.0', resolve);
  });

  // The apps' "who is here?" on the network is answered on its own UDP port.
  const wantedDiscoveryPort = opts.discoveryPort !== undefined ? opts.discoveryPort : (config.get().discovery ? DISCOVERY_PORT : null);
  const discovery = wantedDiscoveryPort === null ? null : await startDiscovery({
    port: wantedDiscoveryPort,
    info: () => ({ id: config.get().id, name: config.get().name, port: server.address().port, protocol: PROTOCOL }),
    log,
  });

  // Songs dropped into the folder by hand turn up within a few minutes (or at
  // once through an app's "Synchronize now").
  await lookForTailscale();
  await library.scan().catch((err) => log(`Scan failed: ${err.message}`));
  library.queueLoudness();
  const timers = [
    setInterval(() => library.scan().catch(() => {}), RESCAN_MS),
    setInterval(() => library.emptyTrash(), TRASH_MS),
    setInterval(() => downloads.expire(), TRASH_MS),
    setInterval(lookForTailscale, RESCAN_MS),
  ];

  return {
    port: server.address().port,
    config,
    library,
    downloads,
    live,
    sessions,
    tailscale: () => tailscale,
    discovery: () => discovery,
    close() {
      if (discovery) discovery.close();
      for (const t of timers) clearInterval(t);
      downloads.stop();
      sessions.stop();
      live.close();
      library.stop();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/**
 * What the sessions need of the library: whether a song is here, and a
 * playlist's songs in order (by id or, for a controller, by name), as the
 * profile sees it. All Songs is the newest first, as the apps show it.
 */
function sessionLibrary(library) {
  let ids = null;
  let rev = -1;
  const songIds = () => {
    if (rev !== library.rev || !ids) {
      ids = new Set(library.data.songs.map((s) => s.id));
      rev = library.rev;
    }
    return ids;
  };
  return {
    songExists: (id) => songIds().has(id),
    playlist(profileId, ref) {
      const v = library.snapshot(profileId && library.profileIds().includes(profileId) ? profileId : null);
      const wanted = (p) => (ref.id ? p.id === ref.id : p.name.toLowerCase() === String(ref.name || '').toLowerCase());
      if (ref.id === model.ALL_SONGS_ID || (!ref.id && String(ref.name || '').toLowerCase() === model.ALL_SONGS_NAME.toLowerCase())) {
        const songs = v.songs.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        return { id: model.ALL_SONGS_ID, name: model.ALL_SONGS_NAME, ids: songs.map((s) => s.id) };
      }
      const p = (v.playlists || []).find(wanted) || (v.sharedPlaylists || []).find(wanted);
      return p ? { id: p.id, name: p.name, ids: p.entries.map((e) => e.songId) } : null;
    },
  };
}

module.exports = { startServer };
