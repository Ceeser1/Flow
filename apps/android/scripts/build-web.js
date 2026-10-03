// Gathers the desktop renderer into www/ for Capacitor, and the shared client
// as www/flow-core.js. The renderer loads its images from ../images; from
// www/index.html that resolves to www/images.
const fs = require('fs');
const path = require('path');
const { bundle } = require('./bundle');

const desktop = path.join(__dirname, '..', '..', 'desktop');
const www = path.join(__dirname, '..', 'www');

fs.rmSync(www, { recursive: true, force: true });
fs.cpSync(path.join(desktop, 'renderer'), www, { recursive: true });
fs.cpSync(path.join(desktop, 'images'), path.join(www, 'images'), {
  recursive: true,
  filter: (src) => !src.endsWith('.psd'),
});
bundle(path.join(www, 'flow-core.js'));
console.log('www/ built from apps/desktop/renderer and images, with flow-core.js');
