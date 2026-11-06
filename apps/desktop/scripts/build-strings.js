'use strict';

// Writes renderer/app/strings.js from translations/translations.txt, so every
// app that carries the renderer (desktop, phones, web player) has the texts in
// every language. Run by npm start and the builds; test/i18n.test.js fails
// while strings.js is older than the sheet.

const fs = require('fs');
const path = require('path');
const { parseSheet } = require('@flow/core/i18nSheet');

const SHEET = path.join(__dirname, '..', '..', '..', 'translations', 'translations.txt');
const OUT = path.join(__dirname, '..', 'renderer', 'app', 'strings.js');

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
  const src = stringsSource(fs.readFileSync(SHEET, 'utf8'));
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (src !== old) fs.writeFileSync(OUT, src);
  console.log(`${path.relative(process.cwd(), OUT)} ${src === old ? 'up to date' : 'written'}`);
}

module.exports = { stringsSource, SHEET, OUT };
