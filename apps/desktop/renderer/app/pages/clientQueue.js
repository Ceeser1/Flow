'use strict';

// The Client queue on Add Songs (4.4): links pasted while this computer is
// downloading something wait here, one after another, instead of the
// Download button waiting. Only where songs download here (yt-dlp on the
// computer); the server has its own queue (serverImport.js).
//
// A link is looked at when it is queued (a song inside a YouTube playlist
// asks "this song or the whole list?" then), its name and song count are
// read at once (window.flow.peekLink, listing.peek), and it takes Settings ›
// Media Management's "Auto-complete confirmations" and "Automate 'Finish
// All'" as they were then (the boxes under the link box switch them). Its
// turn comes once Add Songs has nothing open: no song in the editor, no
// import, no search's results. Then it goes the way a link did before
// (AddPage.runEntry): read, the checklist (or straight on with Download All
// when auto-completed), downloaded, trimmed and named (or, finishing by
// itself, saved as it came).
//
// Entries: { id, url, kind ('song' or 'list'), title (a search's pick),
// picks + name (several uploads picked from a search), updating (a
// playlist's Update that put the link into the box), auto: { complete,
// finish }, peek: null while reading, { name, count, single, sourceTotal },
// or { error } }. They live in the window only: closing Flow asks first
// (main.js), naming them. For now the client and the server share the page's
// one import frame, so a server batch shown there holds this queue up too,
// and the other way round (the server keeps downloading meanwhile).

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

  /** Something is open on Add Songs: a new link waits for its turn. */
  get busy() {
    return this.running || AddPage.phase !== 'idle' || ImportPanel.state !== 'idle' || SongSearch.state !== 'idle';
  },

  /** fn(entries) whenever the queue changes (D9 draws it). */
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

  /** What an entry is called: its name once read, else its link. */
  label(e) {
    if (e.peek && e.peek.name) return e.peek.name;
    return e.name || e.title || e.url || '';
  },

  /**
   * A link (or a search's picks) to download: at once when nothing is open
   * and nothing waits before it, else at the end of the queue.
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
    if (e.picks) {
      e.peek = { name: e.name || '', count: e.picks.length, single: false, sourceTotal: 0 };
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

  /** Its Cancel: out of the queue, its reading stopped. */
  cancel(id) {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    this.entries = this.entries.filter((x) => x !== e);
    window.flow.cancelPeek(e.id).catch(() => {});
    this._changed();
  },

  /** The page may be free now: the next one starts (once things have settled). */
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
