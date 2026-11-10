'use strict';

// Reads translations/translations.txt, the one sheet with every text Flow
// shows: a key on its own line, then indented "en: ..." / "de: ..." lines
// ("en.one:" / "en.other:" for a text with a number in it). Lines starting
// with # are notes. A key without a de line is shown in English.

/**
 * { en: { key: text | { one, other } }, de: { ... } } from the sheet's text.
 * A \n in a text is a new line.
 */
function parseSheet(text) {
  const out = {};
  let key = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.startsWith('#')) continue;
    if (/^\S/.test(raw)) {
      key = raw.trim();
      continue;
    }
    const m = /^\s+([a-z]{2})(?:\.(one|other))?: (.*)$/.exec(raw);
    if (!m || !key) continue;
    const [, lang, form, value] = m;
    const texts = out[lang] || (out[lang] = {});
    const v = value.replace(/\\n/g, '\n');
    if (form) {
      const cur = texts[key] && typeof texts[key] === 'object' ? texts[key] : {};
      cur[form] = v;
      texts[key] = cur;
    } else {
      texts[key] = v;
    }
  }
  return out;
}

module.exports = { parseSheet };
