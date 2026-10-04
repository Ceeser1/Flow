// Gathers the desktop renderer into www/ for Capacitor, with the Android app's
// window.flow as www/flow-android.js. The renderer loads its images from
// ../images; from www/index.html that resolves to www/images.
const fs = require('fs');
const path = require('path');
const { bundle } = require('./bundle');

const desktop = path.join(__dirname, '..', '..', 'desktop');
const www = path.join(__dirname, '..', 'www');

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

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(desktop, 'renderer'), www, { recursive: true });
fs.cpSync(path.join(desktop, 'images'), path.join(www, 'images'), {
  recursive: true,
  filter: (src) => !src.endsWith('.psd'),
});
bundle(path.join(www, 'flow-android.js'));
// First of all: a WebView too old for Flow says so (web/webview-check.js).
fs.copyFileSync(path.join(__dirname, '..', 'web', 'webview-check.js'), path.join(www, 'webview-check.js'));

const indexFile = path.join(www, 'index.html');
let html = fs.readFileSync(indexFile, 'utf8');
const csp = /(<meta http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/;
const firstScript = /<script src="app\//;
if (!csp.test(html) || !firstScript.test(html)) throw new Error('index.html changed: its CSP or its first script was not found.');
html = html.replace(csp, `$1${CSP}$2`);
html = html.replace(firstScript, '<script src="webview-check.js"></script>\n<script src="flow-android.js"></script>\n$&');
fs.writeFileSync(indexFile, html);
console.log('www/ built from apps/desktop/renderer and images, with webview-check.js and flow-android.js');
