// Bundles the Android app's own scripts for the WebView: src/main.js (the
// shared client from @flow/core and window.flow) into www/flow-android.js.
// Built for the browser, so a Node module slipping into the shared client
// fails the build instead of the app.
const path = require('path');
const esbuild = require('esbuild');

const src = (name) => path.join(__dirname, '..', 'src', name);

/** entry: a file in src/; globalName: what the script's exports become on window, if anything. */
function bundle(outfile, { entry = 'main.js', globalName } = {}) {
  esbuild.buildSync({
    entryPoints: [src(entry)],
    outfile,
    bundle: true,
    format: 'iife',
    ...(globalName ? { globalName } : {}),
    platform: 'browser',
    target: 'es2020',
    logLevel: 'error',
  });
  return outfile;
}

module.exports = { bundle };
