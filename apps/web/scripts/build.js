// Builds the web player into dist/: the desktop renderer and its images, with
// the browser's window.flow (src/main.js) bundled as flow-web.js, which
// index.html loads before the window's own scripts. dist/ is a folder of
// plain files for any web server, at any path (all addresses in it are
// relative): copy it there as it is.
//
// What differs from the phone's page (apps/android/scripts/build-web.js):
// the page is served from a folder of a website, not the root of an app, so
// the renderer's ../images become images/; and a website may keep scripts
// and styles cached for long (ceeser.de: 30 days), so every address of one
// gets ?v=<this build> and a new build is loaded at once.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const desktop = path.join(root, '..', 'desktop');
const SCRIPT = 'flow-web.js';

// The page talks to Flow Servers itself (fetch, the live channel, <audio>,
// their covers), at whatever address they have.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' data: blob: http: https:",
  "connect-src 'self' http: https:",
  "worker-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/** Every file under `dir`, as paths relative to it. */
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, p));
    else out.push(p);
  }
  return out;
}

function build({ out = path.join(root, 'dist') } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(path.join(desktop, 'renderer'), out, { recursive: true });
  fs.cpSync(path.join(desktop, 'images'), path.join(out, 'images'), {
    recursive: true,
    filter: (src) => !src.endsWith('.psd'),
  });
  esbuild.buildSync({
    entryPoints: [path.join(root, 'src', 'main.js')],
    outfile: path.join(out, SCRIPT),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'error',
  });

  // One version for the whole build: what the files hold.
  const hash = crypto.createHash('sha1');
  for (const f of walk(out).sort()) hash.update(f).update(fs.readFileSync(path.join(out, f)));
  const v = hash.digest('hex').slice(0, 10);

  // ../images (beside the renderer in the desktop app) is images/ here, and
  // a script loaded by a script (the seek check's worklet) gets the version too.
  for (const f of walk(out)) {
    if (!/\.(js|css|html)$/.test(f)) continue;
    const file = path.join(out, f);
    const text = fs.readFileSync(file, 'utf8');
    let next = text.replace(/\.\.\/images\//g, 'images/');
    if (f === path.join('app', 'seekCheck.js')) next = next.replace("addModule('app/seekTap.js')", `addModule('app/seekTap.js?v=${v}')`);
    if (next !== text) fs.writeFileSync(file, next);
  }

  const indexFile = path.join(out, 'index.html');
  let html = fs.readFileSync(indexFile, 'utf8');
  const csp = /(<meta http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/;
  const firstScript = /<script src="app\//;
  if (!csp.test(html) || !firstScript.test(html)) throw new Error('index.html changed: its CSP or its first script was not found.');
  html = html.replace(csp, `$1${CSP}$2`);
  html = html.replace(firstScript, `<script src="${SCRIPT}"></script>\n$&`);
  html = html.replace(/(<(?:script|link)\b[^>]*\b(?:src|href)=")([^"?#:]+\.(?:js|css))(")/g, `$1$2?v=${v}$3`);
  html = html.replace('<title>Flow</title>', '<title>Flow</title>\n  <meta name="robots" content="noindex" />\n  <link rel="icon" href="assets/icon.png" />');
  fs.writeFileSync(indexFile, html);
  return { out, version: v };
}

module.exports = { build, CSP };

if (require.main === module) {
  const { out, version } = build();
  console.log(`${path.relative(process.cwd(), out) || out} built from apps/desktop/renderer and images, with ${SCRIPT} (version ${version})`);
}
