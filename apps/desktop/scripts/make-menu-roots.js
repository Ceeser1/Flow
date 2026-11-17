// Makes the menu's roots pictures (renderer/assets/roots-*.svg; style.css .roots, menuRoots.js):
// a few main roots grow down from the top edge of the menu, taper, and branch into side roots
// that spread outwards, ending in fine hairs; some reach out of the menu over the content's
// background, fading out as they go. Fainter towards the bottom. Seeded: the same arguments give
// the same picture.
//
// node scripts/make-menu-roots.js <out.svg> [--seed=3] [--opacity=0.045] [--mains=3]
//   [--menu=268] [--reach=640] [--height=1400] [--reachers=4] [--thin=1] [--blur=0]
//   [--top=0.3] [--life=1]
//   menu: the menu's part (its width and 10 px more on each side, the layer's margin),
//   reach: how far beyond it roots may go, thin: their widths times this, blur: a soft edge (px),
//   top: how strong they are at the very top (rising to whole by 45 % of the height, where the
//   menu's entries no longer are, 85 % at the bottom), life: the main roots' length times this.
// The ones in use:
//   node scripts/make-menu-roots.js renderer/assets/roots-near.svg --seed=3 --opacity=0.017 --reach=500 --life=1.3
//   node scripts/make-menu-roots.js renderer/assets/roots-far.svg --seed=11 --opacity=0.012 --mains=4 --thin=0.6 --blur=0.8 --reachers=5 --reach=500 --life=1.3
const fs = require('fs');

const out = process.argv[2];
const opt = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, Number(v)]));
let seed = opt.seed ?? 3;
const OPACITY = opt.opacity ?? 0.045;
const MAINS = opt.mains ?? 3;
const MENU = opt.menu ?? 268;
const REACH = opt.reach ?? 640;
const H = opt.height ?? 1400;
const REACHERS = opt.reachers ?? 4;
const THIN = opt.thin ?? 1;
const BLUR = opt.blur ?? 0;
const TOP = opt.top ?? 0.3;
const LIFE = opt.life ?? 1;
const W = MENU + REACH;

const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;

const strokes = []; // { pts, w0, w1, depth }

function grow(x, y, angle, w0, life, depth, gravityOf = null) {
  const pts = [[x, y]];
  let turn = 0;
  let w = w0;
  // Side roots fall less steeply than the main ones: they spread.
  const gravity = gravityOf ?? ([0.03, 0.012, 0.008, 0.006][depth] || 0.005);
  for (let step = 0; step < life; step += 1) {
    turn = turn * 0.8 + gauss() * (0.07 + depth * 0.025);
    angle += turn + (Math.PI / 2 - angle) * gravity;
    const len = 4.5 + rnd() * 2.5;
    x += Math.cos(angle) * len;
    y += Math.sin(angle) * len;
    if (x < -30 || x > W + 30 || y > H + 20 || y < -30) break;
    pts.push([x, y]);
    // Tapering towards the tip.
    w = w0 * (1 - (step + 1) / (life + 1)) + 0.35 * ((step + 1) / (life + 1));
    const chance = ([0.06, 0.045, 0.035, 0.05][depth] || 0) * Math.min(1, 0.35 + y / 500);
    if (depth < 4 && step > 3 && step < life - 4 && rnd() < chance) {
      const side = rnd() < 0.5 ? -1 : 1;
      const childLife = Math.round((life - step) * (0.35 + rnd() * 0.35) + 6);
      grow(x, y, angle + side * (0.6 + rnd() * 0.6), Math.max(0.5, w * (0.5 + rnd() * 0.15)), childLife, depth + 1);
    }
  }
  if (pts.length > 1) strokes.push({ pts, w0, w1: w, depth });
}

// The main roots, inside the menu's part.
for (let i = 0; i < MAINS; i += 1) {
  const x = 10 + ((MENU - 20) * (i + 0.5)) / MAINS + gauss() * 18;
  grow(x, -12, Math.PI / 2 + gauss() * 0.35, 3.6 + rnd() * 1.2, Math.round((190 + rnd() * 60) * LIFE), 0);
}
// The ones reaching out: from the main roots' right side, off to the right, slowly bending down.
const mains = strokes.filter((s) => s.depth === 0);
for (let i = 0; i < REACHERS && mains.length; i += 1) {
  const from = mains[Math.floor(rnd() * mains.length)];
  const along = from.pts.filter(([x, y]) => x > MENU * 0.35 && y > 60 && y < H * 0.75);
  if (!along.length) continue;
  const [x, y] = along[Math.floor(rnd() * along.length)];
  grow(x, y, -0.1 + rnd() * 0.5, 1.6 + rnd() * 0.8, 120 + Math.round(rnd() * 90), 1, 0.004);
}

const f = (n) => Math.round(n * 10) / 10;
// A strand as pieces of a few points each, each a little thinner: the taper.
const paths = [];
strokes.sort((a, b) => a.depth - b.depth);
for (const s of strokes) {
  const n = s.pts.length;
  const PIECE = 6;
  for (let i = 0; i < n - 1; i += PIECE) {
    const part = s.pts.slice(i, Math.min(n, i + PIECE + 1));
    if (part.length < 2) continue;
    const t = (i + part.length / 2) / n;
    const width = (s.w0 + (s.w1 - s.w0) * t) * THIN;
    let d = `M${f(part[0][0])} ${f(part[0][1])}`;
    for (let j = 1; j < part.length - 1; j += 1) {
      const [x1, y1] = part[j];
      const [x2, y2] = part[j + 1];
      d += `Q${f(x1)} ${f(y1)} ${f((x1 + x2) / 2)} ${f((y1 + y2) / 2)}`;
    }
    const last = part[part.length - 1];
    d += `L${f(last[0])} ${f(last[1])}`;
    paths.push(`<path d='${d}' stroke-width='${Math.max(0.35, width).toFixed(2)}'/>`);
  }
}
// Faint at the top (the menu's entries), whole from 45 % down, and beyond the menu's part fading out to nothing at the far end.
const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>`
  + '<defs>'
  + `<linearGradient id='v' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='${TOP}'/><stop offset='0.45' stop-color='#fff'/><stop offset='1' stop-color='#fff' stop-opacity='0.85'/></linearGradient>`
  + `<linearGradient id='h' gradientUnits='userSpaceOnUse' x1='${MENU - 40}' y1='0' x2='${W}' y2='0'><stop offset='0' stop-color='#fff'/><stop offset='0.45' stop-color='#fff' stop-opacity='0.45'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>`
  + `<mask id='mv'><rect width='${W}' height='${H}' fill='url(#v)'/></mask>`
  + `<mask id='mh'><rect width='${W}' height='${H}' fill='url(#h)'/></mask>`
  + (BLUR ? `<filter id='b' x='-5%' y='-5%' width='110%' height='110%'><feGaussianBlur stdDeviation='${BLUR}'/></filter>` : '')
  + '</defs>'
  + `<g mask='url(#mv)'><g mask='url(#mh)'><g opacity='${OPACITY}'${BLUR ? " filter='url(#b)'" : ''} fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round'>${paths.join('')}</g></g></g></svg>`;
fs.writeFileSync(out, svg);
console.log(out, 'strands', strokes.length, 'bytes', svg.length);
