// Makes one picture of the menu's background texture Roots, every number its own: for trying out
// other roots. The roots are grown by renderer/app/menuBgMake.js (rootsPicture, which says what they
// are), which also makes the two pictures the app shows (it comes with none: menuBg.js).
//
// node scripts/make-menu-roots.js <out.svg> [--seed=3] [--opacity=0.045] [--mains=3]
//   [--menu=268] [--reach=640] [--height=1400] [--reachers=4] [--thin=1] [--blur=0]
//   [--top=0.3] [--life=1]
//   menu: the menu's part (its width and 10 px more on each side, the layer's margin),
//   reach: how far beyond it roots may go, thin: their widths times this, blur: a soft edge (px),
//   top: how strong they are at the very top (rising to whole by 45 % of the height, where the
//   menu's entries no longer are, 85 % at the bottom), life: the main roots' length times this.
// The ones in use, four times as strong as they look as designed (0.017 and 0.012): menuBg.js
// shows them at Settings' Visibility, 25 % by default, so 100 % can be four times that:
//   node scripts/make-menu-roots.js roots-near.svg --seed=3 --opacity=0.068 --reach=500 --life=1.3
//   node scripts/make-menu-roots.js roots-far.svg --seed=11 --opacity=0.048 --mains=4 --thin=0.6 --blur=0.8 --reachers=5 --reach=500 --life=1.3
const fs = require('fs');
const MenuBgMake = require('../renderer/app/menuBgMake.js');

const out = process.argv[2];
if (!out) {
  console.error('node scripts/make-menu-roots.js <out.svg> [--seed=3] [--opacity=0.045] ...');
  process.exit(1);
}
const opt = Object.fromEntries(process.argv.slice(3).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, Number(v)]));
const svg = MenuBgMake.rootsPicture(opt);
fs.writeFileSync(out, svg);
console.log(out, 'bytes', svg.length);
