'use strict';

// Writes renderer/app/strings.js from translations/translations.txt, so every
// app that carries the renderer (desktop, phones, web player) has the texts in
// every language. Run by npm start and the builds; test/i18n.test.js fails
// while strings.js is older than the sheet.
//
// Also copies the @flow/core modules the window runs too into renderer/app
// (4.3.3: libraryPatch.js, the library's changes applied); test/renderer.test.js
// fails while a copy is older.

const fs = require('fs');
const path = require('path');
const { parseSheet } = require('@flow/core/i18nSheet');

const SHEET = path.join(__dirname, '..', '..', '..', 'translations', 'translations.txt');
const OUT = path.join(__dirname, '..', 'renderer', 'app', 'strings.js');
// [the copy in renderer/app, the module in packages/core/src]
const SHARED = [['libraryPatch.js', path.join(__dirname, '..', '..', '..', 'packages', 'core', 'src', 'libraryPatch.js')]];

/** The renderer's copy of a core module. */
function sharedSource(name, src) {
  return `// Copied from packages/core/src/${name} by scripts/build-strings.js: change that one.
${src}`;
}

function writeIfChanged(out, src) {
  const old = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (src !== old) fs.writeFileSync(out, src);
  console.log(`${path.relative(process.cwd(), out)} ${src === old ? 'up to date' : 'written'}`);
}

function stringsSource(sheetText) {
  const json = JSON.stringify(parseSheet(sheetText));
  return `'use strict';

// Made by scripts/build-strings.js from translations/translations.txt: change
// the sheet, not this file.

(function (root, strings) {
  if (typeof module === 'object' && module.exports) module.exports = strings;
  else root.FlowStrings = strings;
}(typeof self !== 'undefined' ? self : this, ${json}));
`;
}

if (require.main === module) {
  writeIfChanged(OUT, stringsSource(fs.readFileSync(SHEET, 'utf8')));
  for (const [name, from] of SHARED) writeIfChanged(path.join(__dirname, '..', 'renderer', 'app', name), sharedSource(name, fs.readFileSync(from, 'utf8')));
}

module.exports = {
  stringsSource, sharedSource, SHARED, SHEET, OUT,
};
