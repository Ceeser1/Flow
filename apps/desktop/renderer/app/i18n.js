'use strict';

// Flow's texts in the language picked in Settings > General > Language
// (strings.js, made from translations/translations.txt). T('key', { name })
// gives the text with {name} filled in; a text with one/other forms picks one
// by vars.count. A key German lacks is shown in English, an unknown key as
// itself.
//
// Elements in index.html carry their key: data-i18n (the text), and
// data-i18n-title, data-i18n-placeholder, data-i18n-aria-label (attributes).
//
// The language: the desktop app's window.flow.language (its settings), else
// the one this browser kept (the web player and phones), else the device's.

(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('./strings') : root.FlowStrings, node ? null : root);
  if (node) module.exports = api;
  else {
    root.I18n = api;
    root.T = api.t;
  }
}(typeof self !== 'undefined' ? self : this, (STRINGS, win) => {
  const LANGUAGES = ['en', 'de'];
  const STORE_KEY = 'flowLanguage';

  /** 'de' or 'en' for '' (the device's language). */
  function resolve(chosen) {
    if (LANGUAGES.includes(chosen)) return chosen;
    const device = (win && win.navigator && (win.navigator.language || '')) || '';
    return /^de\b/i.test(device) ? 'de' : 'en';
  }

  /** The language chosen in Settings: '' (the device's), 'en' or 'de'. */
  function chosen() {
    if (win && win.flow && typeof win.flow.language === 'string') return win.flow.language;
    try {
      return (win && win.localStorage && win.localStorage.getItem(STORE_KEY)) || '';
    } catch {
      return '';
    }
  }

  let lang = win ? resolve(chosen()) : 'en';

  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (all, name) => (vars[name] === undefined || vars[name] === null ? all : String(vars[name])));
  }

  function lookup(table, key, vars) {
    const v = table && table[key];
    if (v === undefined) return undefined;
    if (typeof v === 'string') return v;
    const n = Number(vars && vars.count);
    return n === 1 ? v.one : v.other;
  }

  /** The text for `key` in the language in use, {name} filled in from vars. */
  function t(key, vars) {
    let text = lookup(STRINGS[lang], key, vars);
    if (text === undefined && lang !== 'en') text = lookup(STRINGS.en, key, vars);
    return fill(text === undefined ? key : text, vars);
  }

  /** `n` with `digits` decimals, written as the language does (1.5 / 1,5). */
  function num(n, digits = 0) {
    const text = Number(n).toFixed(digits);
    return lang === 'de' ? text.replace('.', ',') : text;
  }

  /** True when the sheet has `key` in English. */
  function has(key) {
    return !!(STRINGS.en && STRINGS.en[key] !== undefined);
  }

  /** The keys in `root` (an element) and below: data-i18n and its attribute forms. */
  function apply(rootEl) {
    const all = rootEl.querySelectorAll('[data-i18n], [data-i18n-title], [data-i18n-placeholder], [data-i18n-aria-label]');
    for (const el of all) {
      if (el.dataset.i18n) el.textContent = t(el.dataset.i18n);
      if (el.dataset.i18nTitle) el.title = t(el.dataset.i18nTitle);
      if (el.dataset.i18nPlaceholder) el.placeholder = t(el.dataset.i18nPlaceholder);
      if (el.dataset.i18nAriaLabel) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
    }
  }

  /**
   * Keeps the choice ('' for the device's) where the next start finds it, for
   * apps whose window.flow has no language of its own. The window reloads to
   * switch.
   */
  function remember(choice) {
    try {
      if (win && win.localStorage) win.localStorage.setItem(STORE_KEY, LANGUAGES.includes(choice) ? choice : '');
    } catch {
      // A browser without storage keeps the device's language.
    }
  }

  // The page's own text: this script comes after it (index.html).
  if (win && win.document && win.document.body) {
    win.document.documentElement.lang = lang;
    apply(win.document);
  }

  return {
    LANGUAGES,
    t,
    num,
    has,
    apply,
    remember,
    resolve,
    chosen,
    get lang() { return lang; },
    /** Tests and the desktop app's main process: the language to use from now on. */
    setLanguage(l) { lang = resolve(l); },
  };
}));
