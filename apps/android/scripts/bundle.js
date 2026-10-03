// Bundles src/core.js (the shared client from @flow/core) into one script for
// the WebView: window.FlowCore. Built for the browser, so a Node module
// slipping into the shared client fails the build instead of the app.
const path = require('path');
const esbuild = require('esbuild');

function bundle(outfile) {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, '..', 'src', 'core.js')],
    outfile,
    bundle: true,
    format: 'iife',
    globalName: 'FlowCore',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'error',
  });
  return outfile;
}

module.exports = { bundle };
