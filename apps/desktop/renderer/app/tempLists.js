'use strict';

// Temporary Playlists (5.2): lists that live only while the app runs. A song
// radio or an artist radio (Player.startRadio) is one: it shows in the menu
// under "Temporary Playlists" and has a page like a playlist's, but it is
// kept nowhere (not in the library, not on a Flow Server, not in the
// settings), so it is gone with the session unless it is saved, which makes
// an ordinary playlist of it (PlaylistPage.saveTemp).
//
// Each is shaped like a playlist ({ id, name, entries, isTemp }) under an id
// of its own, "temp:<n>": Store.playlist answers for those ids, and with that
// the menu, a playlist's page, the player ("from ...") and the Queue treat it
// as any list. Its entries all carry the same date, so the page's
// newest-first order is the order the list was made in.
//
// Pure, so the tests can pin it; the window loads it as a plain script and
// gets `TempLists` as a global.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TempLists = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const PREFIX = 'temp:';
  // A playlist's longest name (@flow/core libraryModel MAX_NAME): a list saved must fit.
  const MAX_NAME = 80;

  const TempLists = {
    PREFIX,
    MAX_NAME,
    _lists: [], // in the order they were made
    _count: 0,
    _listeners: [],

    isTemp(id) {
      return String(id || '').startsWith(PREFIX);
    },

    get(id) {
      return this._lists.find((l) => l.id === id) || null;
    },

    /** The lists, the newest first. */
    all() {
      return this._lists.slice().reverse();
    },

    /** The list made last, or null. */
    latest() {
      return this._lists[this._lists.length - 1] || null;
    },

    /** fn() after every change: a list made or thrown away, a song taken out. */
    onChange(fn) {
      this._listeners.push(fn);
    },

    _emit() {
      for (const fn of this._listeners) fn();
    },

    /**
     * A name for a list about `title` (a song's or an artist's name):
     * `wrap(title)` ("<title> Radio"), then "... (2)", "... (3)" while
     * `used(name)` says a name is taken (whatever the case). A long title is
     * cut so that the whole name fits a playlist's, keeping what `wrap` puts
     * around it and the number.
     */
    nameFor(title, wrap, used = () => false) {
      const text = String(title || '').replace(/\s+/g, ' ').trim();
      for (let n = 1; ; n += 1) {
        const tail = n > 1 ? ` (${n})` : '';
        let name = wrap(text) + tail;
        if (name.length > MAX_NAME) {
          const keep = Math.max(1, text.length - (name.length - MAX_NAME) - 1);
          name = wrap(`${text.slice(0, keep).trimEnd()}…`) + tail;
        }
        if (!used(name)) return name;
      }
    },

    _taken(name) {
      const lower = name.toLowerCase();
      return this._lists.some((l) => l.name.toLowerCase() === lower);
    },

    /**
     * Makes a list of `ids` (song ids, in their order) named after `title`
     * (nameFor: `wrap`, and `taken(name)` for the names in use elsewhere, the
     * playlists'; no two temporary lists share one either, so the same radio
     * started again is "... (2)"). `seed`: what it was made from. Returns it.
     */
    add({
      title, wrap = (s) => s, ids, seed = null, taken = () => false, now = Date.now(),
    }) {
      this._count += 1;
      const list = {
        id: PREFIX + this._count,
        name: this.nameFor(title, wrap, (n) => this._taken(n) || taken(n)),
        entries: (ids || []).map((songId) => ({ songId, addedAt: now })),
        isTemp: true,
        createdAt: now,
        seed,
        title: String(title || ''),
        wrap,
      };
      this._lists.push(list);
      this._emit();
      return list;
    },

    /**
     * The name a list is saved under: its own, or the next one free when a
     * playlist took it meanwhile (`taken(name)`).
     */
    saveName(list, taken = () => false) {
      if (!taken(list.name)) return list.name;
      return this.nameFor(list.title, list.wrap, taken);
    },

    /** Throws a list away; false when there is none. */
    remove(id) {
      const at = this._lists.findIndex((l) => l.id === id);
      if (at < 0) return false;
      this._lists.splice(at, 1);
      this._emit();
      return true;
    },

    /**
     * Takes a song out of a list (in memory, as the list itself). Its entries
     * are a new array then: what was worked out for the old one (rows, their
     * order) is not used for it.
     */
    removeSong(id, songId) {
      const list = this.get(id);
      if (!list || !list.entries.some((e) => e.songId === songId)) return false;
      list.entries = list.entries.filter((e) => e.songId !== songId);
      this._emit();
      return true;
    },

    /** All of them go (another server or profile: its songs are not these lists'). */
    clear() {
      if (!this._lists.length) return;
      this._lists = [];
      this._emit();
    },
  };

  return TempLists;
}));
