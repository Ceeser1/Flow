// Writes the pictures of the menu's background textures into a folder, for looking at them (Settings >
// App Visuals > Show a Menu background > Style). Flow itself comes with none: the app makes the chosen
// style's from its seed when it shows it (renderer/app/menuBgMake.js, the same code this script runs).
//
//   node scripts/make-menu-textures.js <folder>                    every style's standard look
//   node scripts/make-menu-textures.js <folder> circuit vines      only these
//   node scripts/make-menu-textures.js <folder> circuit --seed=AB12CD
const fs = require('fs');
const path = require('path');
const MenuBgMake = require('../renderer/app/menuBgMake.js');

const args = process.argv.slice(2);
const seedArg = args.find((a) => a.startsWith('--seed='));
const seed = seedArg ? seedArg.slice(7) : '';
const [out, ...wanted] = args.filter((a) => !a.startsWith('--'));
if (!out) {
  console.error('node scripts/make-menu-textures.js <folder> [style ...] [--seed=AB12CD]');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
for (const name of wanted.length ? wanted : MenuBgMake.STYLES) {
  if (!MenuBgMake.STYLES.includes(name)) {
    console.error(`No such texture: ${name} (${MenuBgMake.STYLES.join(', ')})`);
    process.exitCode = 1;
    continue;
  }
  for (const [file, text] of Object.entries(MenuBgMake.make(name, seed).files)) {
    fs.writeFileSync(path.join(out, file), text);
    console.log(file, text.length, 'bytes');
  }
}
