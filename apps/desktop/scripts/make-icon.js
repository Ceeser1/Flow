'use strict';

// Makes the app icon from build/flow.png (the wave): build/icon.ico (16 to
// 256 px, PNG inside) for the installer and the .exe, build/icon.png, and
// renderer/assets/icon.png for the window, the menu and the Windows media
// overlay's cover art.
// Run with: npm run icon

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZE = 256;

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(() => {
  const root = path.join(__dirname, '..');
  const source = nativeImage.createFromPath(path.join(root, 'build', 'flow.png'));
  if (source.isEmpty()) {
    console.error('build/flow.png could not be read.');
    app.exit(1);
    return;
  }
  const at = (size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG();

  fs.mkdirSync(path.join(root, 'renderer', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'renderer', 'assets', 'icon.png'), at(SIZE));
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), at(SIZE));
  const pngs = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: at(size) }));
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngs));
  console.log('Wrote build/icon.ico, build/icon.png and renderer/assets/icon.png from build/flow.png');
  app.quit();
});
