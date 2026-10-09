// Gathers the desktop renderer into www/ for Capacitor, with the Android app's
// window.flow as www/flow-android.js. The renderer loads its images from
// ../images; from www/index.html that resolves to www/images.
//
// The iPhone app builds the same page (apps/ios/scripts/build-web.js calls
// buildWeb with its own folder): the same window.flow, whose plugins it has in
// Swift, without the Android WebView check.
const fs = require('fs');
const path = require('path');
const { bundle } = require('./bundle');

const desktop = path.join(__dirname, '..', '..', 'desktop');

// The page talks to Flow Servers itself (fetch, the live channel, <audio>),
// at whatever address they have; the desktop's page leaves that to Electron's
// main process. Covers are files of the app's, served by Capacitor ('self').
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' http: https: blob:",
  "connect-src 'self' http: https:",
].join('; ');

/**
 * The page into `out`: the renderer and its images, window.flow bundled as
 * `script`, and before it `checks` (scripts of this folder's ../web, run first).
 */
function buildWeb({ out, script, checks = [] }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(desktop, 'renderer'), out, { recursive: true });
  fs.cpSync(path.join(desktop, 'images'), path.join(out, 'images'), {
    recursive: true,
    filter: (src) => !src.endsWith('.psd'),
  });
  bundle(path.join(out, script));
  for (const check of checks) fs.copyFileSync(path.join(__dirname, '..', 'web', check), path.join(out, check));

  const indexFile = path.join(out, 'index.html');
  let html = fs.readFileSync(indexFile, 'utf8');
  const csp = /(<meta http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/;
  const firstScript = /<script src="app\//;
  if (!csp.test(html) || !firstScript.test(html)) throw new Error('index.html changed: its CSP or its first script was not found.');
  html = html.replace(csp, `$1${CSP}$2`);
  const before = [...checks, script].map((s) => `<script src="${s}"></script>\n`).join('');
  html = html.replace(firstScript, `${before}$&`);
  fs.writeFileSync(indexFile, html);
}

module.exports = { buildWeb };

if (require.main === module) {
  // First of all: a WebView too old for Flow says so (web/webview-check.js).
  buildWeb({ out: path.join(__dirname, '..', 'www'), script: 'flow-android.js', checks: ['webview-check.js'] });
  console.log('www/ built from apps/desktop/renderer and images, with webview-check.js and flow-android.js');
}
