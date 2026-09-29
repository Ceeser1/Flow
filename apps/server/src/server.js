'use strict';

// A Flow Server: the library, its music folder and the HTTP side put
// together. main.js starts one from the command line; the tests start their
// own on a free port.

const configMod = require('./config');
const { createLibrary } = require('./library');
const { createHttpServer } = require('./http');
const { version } = require('../package.json');

const RESCAN_MS = 5 * 60 * 1000;
const TRASH_MS = 24 * 60 * 60 * 1000;

/**
 * opts: { home, music, port, host, log }. Resolves { port, config, library, close }.
 * Port 0 picks a free one.
 */
async function startServer(opts = {}) {
  const log = opts.log || (() => {});
  const config = configMod.open({ home: opts.home, music: opts.music });
  const library = createLibrary(config, log);
  const server = createHttpServer({ config, library, version, log });

  const port = opts.port !== undefined ? opts.port : config.get().port;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, opts.host || '0.0.0.0', resolve);
  });

  // Songs dropped into the folder by hand turn up within a few minutes (or at
  // once through an app's "Synchronize now").
  await library.scan().catch((err) => log(`Scan failed: ${err.message}`));
  library.queueLoudness();
  const timers = [
    setInterval(() => library.scan().catch(() => {}), RESCAN_MS),
    setInterval(() => library.emptyTrash(), TRASH_MS),
  ];

  return {
    port: server.address().port,
    config,
    library,
    close() {
      for (const t of timers) clearInterval(t);
      library.stop();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

module.exports = { startServer };
