'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseSheet } = require('@flow/core/i18nSheet');
const { stringsSource, SHEET, OUT } = require('../scripts/build-strings');
const I18n = require('../renderer/app/i18n');
const { tr, useTranslator } = require('@flow/core/lang');

const sheetText = fs.readFileSync(SHEET, 'utf8');
const sheet = parseSheet(sheetText);
const ROOT = path.join(__dirname, '..', '..', '..');

function files(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files(p, out);
    else if (/\.(js|html)$/.test(e.name) && p !== OUT) out.push(p); // viz/strings.js is a visualizer
  }
  return out;
}

test('strings.js is made from the sheet as it is now (npm run strings)', () => {
  assert.equal(fs.readFileSync(OUT, 'utf8'), stringsSource(sheetText));
});

test('every key the code asks for is in the sheet', () => {
  const sources = [
    ...files(path.join(__dirname, '..', 'renderer')),
    ...files(path.join(__dirname, '..', 'src')),
    path.join(__dirname, '..', 'main.js'),
    ...files(path.join(ROOT, 'packages', 'core', 'src')),
  ];
  const missing = [];
  for (const f of sources) {
    const text = fs.readFileSync(f, 'utf8');
    // T('key'), tr('key', ...), data-i18n*="key"; keys built with ${} are left to the window.
    for (const m of text.matchAll(/\b(?:T|tr|I18n\.t)\('([a-zA-Z]\w*\.[\w.]+)'/g)) if (!(m[1] in sheet.en)) missing.push(`${path.basename(f)}: ${m[1]}`);
    for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) if (!(m[1] in sheet.en)) missing.push(`${path.basename(f)}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test('the German keeps the English text\'s {placeholders} and forms', () => {
  const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join(' ');
  const bad = [];
  for (const [key, de] of Object.entries(sheet.de || {})) {
    const en = sheet.en[key];
    if (en === undefined) { bad.push(`${key}: no English`); continue; }
    if (typeof en !== typeof de) { bad.push(`${key}: one/other in one language only`); continue; }
    const pairs = typeof en === 'string' ? [[en, de]] : [[en.one, de.one], [en.other, de.other]];
    for (const [a, b] of pairs) if (holes(a) !== holes(b)) bad.push(`${key}: ${holes(a)} / ${holes(b)}`);
  }
  assert.deepEqual(bad, []);
});

test('T fills in the text, picks one/other by count, and falls back to English and then the key', () => {
  I18n.setLanguage('en');
  assert.equal(I18n.t('common.count.songs', { count: 1 }), '1 song');
  assert.equal(I18n.t('common.count.songs', { count: 3 }), '3 songs');
  assert.equal(I18n.t('no.such.key'), 'no.such.key');
  I18n.setLanguage('de');
  assert.equal(I18n.t('common.count.songs', { count: 3 }), '3 Songs');
  assert.equal(I18n.t('settings.general.language.device', { language: 'Deutsch' }), 'Wie dieses Gerät (Deutsch)');
  assert.equal(I18n.num(1.5, 1), '1,5');
  I18n.setLanguage('en');
  assert.equal(I18n.num(1.5, 1), '1.5');
});

test('the shared code speaks English without a translator, and the app\'s language with one', () => {
  useTranslator(null);
  assert.equal(tr('core.link.notALink', 'That does not look like a link.'), 'That does not look like a link.');
  assert.equal(tr('core.match.closestOff', 'closest upload is {seconds} s off', { seconds: 4 }), 'closest upload is 4 s off');
  I18n.setLanguage('de');
  useTranslator((key, vars) => (I18n.has(key) ? I18n.t(key, vars) : null));
  assert.equal(tr('core.link.notALink', 'That does not look like a link.'), sheet.de['core.link.notALink']);
  assert.equal(tr('not.in.sheet', 'As it was.'), 'As it was.');
  useTranslator(null);
  I18n.setLanguage('en');
});
