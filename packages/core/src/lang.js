'use strict';

// Messages the shared code makes, in the app's language. Each carries its key
// in translations/translations.txt and its English: an app with a translator
// (the desktop app: useTranslator in main.js) shows its text, the Flow Server
// has none and stays English.

let translator = null;

/** fn(key, vars): the text, or null for "not translated". */
function useTranslator(fn) {
  translator = typeof fn === 'function' ? fn : null;
}

/** The text for `key`, else `english`; {name} filled in from vars either way. */
function tr(key, english, vars) {
  const own = translator ? translator(key, vars) : null;
  if (typeof own === 'string') return own;
  if (!vars) return english;
  return english.replace(/\{(\w+)\}/g, (all, name) => (vars[name] === undefined || vars[name] === null ? all : String(vars[name])));
}

module.exports = { tr, useTranslator };
