'use strict';

// The Client queue on Add Songs (4.4): links pasted while this computer is
// downloading something wait here, one after another, instead of the
// Download button waiting; so do files picked from the computer and a
// playlist's Update. The server has its own queue (serverImport.js).
//
// A link is looked at when it is queued (a song inside a YouTube playlist
// asks "this song or the whole list?" then), its name and song count are
// read at once (window.flow.peekLink, listing.peek), and it takes Settings ›
// Media Management's "Auto-accept songs lookup" and "Automate 'Finish
// all'" (the boxes under the link box switch them) as they are at its turn:
// switched while it waits or is read, it follows (followAuto). Its
// turn comes once this computer reads and downloads nothing else and no
// checklist waits for its choice; batches waiting for "Finish all" hold no
// one up. Then it is a batch of import.js (AddPage.runEntry): read, the
// checklist (or straight on with Download All when auto-completed),
// downloaded, then trimmed and named (or, finishing by itself, saved as it
// came).
//
// Entries: { id, url, kind ('song', 'list', 'local' or 'update'), title (a
// search's pick), picks + name (several uploads picked from a search), local
// (the files and folders picked), update ({ playlist, listing, server } of a
// playlist's Update), updating, auto: { complete, finish }, peek: null while
// reading, { name, count, single, sourceTotal }, or { error } }. They live in
// the window only: closing Flow asks first (main.js), naming them. The
// Client queue frame draws them (queuePanels.js).

const ClientQueue = {
  entries: [],
  running: false,
  _listeners: [],
  _seq: 0,
  _timer: 0,

  init() {
    // A safety net for a turn no state change announced (a dialog closed, say).
    setInterval(() => {
      if (this.entries.length) this.kick();
    }, 3000);
  },

  /** Songs download on this computer (yt-dlp is there). */
  get available() {
    return Store.can('downloadHere') && DownloadsHelp.here;
  },

  /** This computer reads or downloads something, or a checklist waits: a new link waits for its turn. */
  get busy() {
    return this.running || ImportPanel.clientBusy;
  },

  /** fn(entries) whenever the queue changes (the Client queue frame draws it). */
  onChange(fn) {
    this._listeners.push(fn);
  },

  _changed() {
    for (const fn of this._listeners) {
      try {
        fn(this.entries);
      } catch {
        // A drawer's own problem.
      }
    }
    if (window.flow.setQueuePending) window.flow.setQueuePending({ count: this.entries.length, names: this.entries.map((e) => this.label(e)) }).catch(() => {});
    if (typeof ServerImport !== 'undefined') ServerImport.drawButtons();
  },

  /** What an entry is called: its name once read, else its link (files: their names). */
  label(e) {
    if (e.peek && e.peek.name) return e.peek.name;
    if (e.local) return e.local.map((p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p)).join(', ');
    return e.name || e.title || e.url || '';
  },

  /**
   * A link (or a search's picks, files, an Update) to download: at once when
   * nothing runs here and nothing waits before it, else at the end of the queue.
   */
  offer(entry) {
    const e = { ...entry, id: `q${Date.now().toString(36)}${(this._seq += 1)}`, peek: null };
    if (!this.busy && !this.entries.length) {
      this._run(e);
      return;
    }
    this.entries.push(e);
    toast(T('add.queue.added.client'), 'info');
    this._peek(e);
    this._changed();
  },

  /** A queued link's name and song count, read at once. */
  async _peek(e) {
    if (e.picks || e.local || e.update) {
      let count = 0;
      if (e.picks) count = e.picks.length;
      else if (e.update) count = e.update.listing.items.filter((it) => !it.existing).length;
      const name = e.update ? e.update.playlist.name : (e.local ? this.label(e) : e.name || '');
      e.peek = {
        name, count, single: false, sourceTotal: 0, local: !!e.local,
      };
      this._changed();
      return;
    }
    let got;
    try {
      got = await window.flow.peekLink(e.id, e.url, e.kind === 'song');
    } catch (err) {
      if (err && err.cancelled) return;
      got = { error: (err && err.message) || T('common.wentWrong') };
    }
    if (!this.entries.includes(e)) return;
    e.peek = got;
    this._changed();
  },

  /**
   * The boxes were switched: every link still waiting takes them as they are
   * now, and so do the batches of this computer not past that step yet
   * (ImportPanel.followAuto).
   */
  followAuto(auto) {
    for (const e of this.entries) e.auto = { ...auto };
    ImportPanel.followAuto(auto);
  },

  /** Its Cancel: out of the queue, its reading stopped. */
  cancel(id) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    this.entries = this.entries.filter((x) => x !== e);
    window.flow.cancelPeek(e.id).catch(() => {});
    this._changed();
  },

  /** This computer may be free now: the next one starts (once things have settled). */
  kick() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._next(), 0);
  },

  _next() {
    if (this.busy || !this.entries.length) return;
    const e = this.entries.shift();
    window.flow.cancelPeek(e.id).catch(() => {});
    this._changed();
    this._run(e);
  },

  async _run(e) {
    this.running = true;
    try {
      await AddPage.runEntry(e);
    } catch (err) {
      toast((err && err.message) || T('common.wentWrong'), 'error');
    } finally {
      this.running = false;
      if (typeof ServerImport !== 'undefined') ServerImport.drawButtons();
      this.kick();
    }
  },
};
