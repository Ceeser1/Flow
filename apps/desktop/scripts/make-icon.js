'use strict';

// Makes every app's icons from the two at the top of the repo: icons/flow.png
// (the wave alone, see-through around it) and icons/flow-bg.jpg (the same wave
// on its dark background).
// - Desktop: build/icon.ico (16 to 256 px, PNG inside) for the installer and
//   the .exe, build/icon.png, and renderer/assets/icon.png for the window, the
//   welcome page and the Windows media overlay's cover art: the wave alone.
// - Android: the launcher icon, an adaptive one: the wave in the middle of its
//   foreground, on ic_launcher_background's colour (values/ic_launcher_
//   background.xml, the background's #131315); the square and round ones
//   older launchers take are flow-bg.jpg. The splash pictures Android 8 to 11
//   show (12 and up show the launcher icon), at the sizes they have.
// - iPhone: AppIcon.png, flow-bg.jpg at 1024 px with no alpha channel.
// Run with: npm run icon

const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
// Android's densities against mdpi; a launcher icon is 48 dp, an adaptive
// icon's layers 108 dp, of which a mask shows the middle 72 dp at most.
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
// The picture's side in the foreground, in dp: the wave's farthest point
// (0.95 of the way out) then sits about at the 66 dp circle every mask keeps.
const FOREGROUND_WAVE = 70;
// The background's colour, as in flow-bg.jpg.
const BACKGROUND = { r: 0x13, g: 0x13, b: 0x15 };

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

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG without an alpha channel (nativeImage writes one always) from `rgb` rows. */
function opaquePng(rgb, width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Pictures as nativeImage's bitmaps: 4 bytes a pixel, the colours multiplied
// by the alpha already. The byte order is the platform's; `order` finds it.
let order = null;

function findOrder() {
  // A 1 px picture whose red and blue differ: where they land.
  const probe = nativeImage.createFromBuffer(opaquePng(Buffer.from([255, 128, 0]), 1, 1)).toBitmap();
  return { r: probe.indexOf(255), g: probe.indexOf(128), b: probe.indexOf(0), a: 3 };
}

function picture(width, height, colour) {
  const data = Buffer.alloc(width * height * 4);
  if (colour) {
    for (let i = 0; i < data.length; i += 4) {
      data[i + order.r] = colour.r;
      data[i + order.g] = colour.g;
      data[i + order.b] = colour.b;
      data[i + order.a] = 255;
    }
  }
  return { width, height, data };
}

function scaled(image, side) {
  const s = image.resize({ width: side, height: side, quality: 'best' });
  const { width, height } = s.getSize();
  return { width, height, data: Buffer.from(s.toBitmap()) };
}

/** `top` laid over `under` with its top left corner at x, y. */
function lay(under, top, x, y) {
  for (let ty = 0; ty < top.height; ty += 1) {
    const uy = y + ty;
    if (uy < 0 || uy >= under.height) continue;
    for (let tx = 0; tx < top.width; tx += 1) {
      const ux = x + tx;
      if (ux < 0 || ux >= under.width) continue;
      const t = (ty * top.width + tx) * 4;
      const u = (uy * under.width + ux) * 4;
      const keep = 1 - top.data[t + 3] / 255;
      for (let c = 0; c < 4; c += 1) under.data[u + c] = Math.round(top.data[t + c] + under.data[u + c] * keep);
    }
  }
  return under;
}

/** Only what lies inside `inside(x, y)` (in 0..1 across the picture) kept, its edge smoothed. */
function masked(pic, inside) {
  const N = 4;
  for (let y = 0; y < pic.height; y += 1) {
    for (let x = 0; x < pic.width; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < N; sy += 1) {
        for (let sx = 0; sx < N; sx += 1) {
          if (inside((x + (sx + 0.5) / N) / pic.width, (y + (sy + 0.5) / N) / pic.height)) hits += 1;
        }
      }
      const i = (y * pic.width + x) * 4;
      for (let c = 0; c < 4; c += 1) pic.data[i + c] = Math.round((pic.data[i + c] * hits) / (N * N));
    }
  }
  return pic;
}

const round = (x, y) => (x - 0.5) ** 2 + (y - 0.5) ** 2 <= 0.25;
// A square with rounded corners, as the launcher icons of Android 7 were.
const rounded = (x, y) => {
  const r = 0.12;
  const dx = Math.max(0, Math.abs(x - 0.5) - (0.5 - r));
  const dy = Math.max(0, Math.abs(y - 0.5) - (0.5 - r));
  return dx * dx + dy * dy <= r * r;
};

const png = (pic) => nativeImage.createFromBitmap(pic.data, { width: pic.width, height: pic.height }).toPNG();

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

app.whenReady().then(() => {
  const repo = path.join(__dirname, '..', '..', '..');
  const root = path.join(__dirname, '..');
  const wave = nativeImage.createFromPath(path.join(repo, 'icons', 'flow.png'));
  const onDark = nativeImage.createFromPath(path.join(repo, 'icons', 'flow-bg.jpg'));
  if (wave.isEmpty() || onDark.isEmpty()) {
    console.error('icons/flow.png or icons/flow-bg.jpg could not be read.');
    app.exit(1);
    return;
  }
  order = findOrder();
  const wrote = [];
  const out = (file, data) => {
    write(file, data);
    wrote.push(path.relative(repo, file).replace(/\\/g, '/'));
  };

  // The desktop.
  const at = (size) => wave.resize({ width: size, height: size, quality: 'best' }).toPNG();
  out(path.join(root, 'renderer', 'assets', 'icon.png'), at(SIZE));
  out(path.join(root, 'build', 'icon.png'), at(SIZE));
  const pngs = [16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: at(size) }));
  out(path.join(root, 'build', 'icon.ico'), ico(pngs));

  // Android.
  const res = path.join(repo, 'apps', 'android', 'android', 'app', 'src', 'main', 'res');
  for (const [name, d] of Object.entries(DENSITIES)) {
    const dir = path.join(res, `mipmap-${name}`);
    const side = Math.round(108 * d);
    const w = scaled(wave, Math.round(FOREGROUND_WAVE * d));
    const fore = lay(picture(side, side), w, Math.round((side - w.width) / 2), Math.round((side - w.height) / 2));
    out(path.join(dir, 'ic_launcher_foreground.png'), png(fore));
    const legacy = Math.round(48 * d);
    out(path.join(dir, 'ic_launcher.png'), png(masked(scaled(onDark, legacy), rounded)));
    out(path.join(dir, 'ic_launcher_round.png'), png(masked(scaled(onDark, legacy), round)));
  }
  for (const dir of fs.readdirSync(res).filter((d) => d === 'drawable' || d.startsWith('drawable-'))) {
    const file = path.join(res, dir, 'splash.png');
    if (!fs.existsSync(file)) continue;
    const { width, height } = nativeImage.createFromPath(file).getSize();
    const w = scaled(wave, Math.round(Math.min(width, height) * 0.4));
    const splash = lay(picture(width, height, BACKGROUND), w, Math.round((width - w.width) / 2), Math.round((height - w.height) / 2));
    out(file, png(splash));
  }

  // The iPhone: no alpha channel (iOS fills a see-through icon with black,
  // and the App Store refuses one).
  const big = scaled(onDark, 1024);
  const rgb = Buffer.alloc(big.width * big.height * 3);
  for (let i = 0, j = 0; i < big.data.length; i += 4, j += 3) {
    rgb[j] = big.data[i + order.r];
    rgb[j + 1] = big.data[i + order.g];
    rgb[j + 2] = big.data[i + order.b];
  }
  out(path.join(repo, 'apps', 'ios', 'App', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon.png'), opaquePng(rgb, big.width, big.height));

  console.log(`Wrote, from icons/flow.png and icons/flow-bg.jpg:\n  ${wrote.join('\n  ')}`);
  app.quit();
});
