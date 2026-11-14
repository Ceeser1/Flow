'use strict';

// Add Songs' downloads on this computer kept over a restart (4.5.3; the app's
// src/keptDownloads.js keeps the file): the Client queue's links and every
// batch of this computer's not saved yet, sent at every change (and every
// few seconds, the cuts and names changed in the editor among them), once
// more as the window closes, and put back once Flow has started:
//
//   being read     its link at the front of the Client queue, read again
//   checklist      as it was, the same songs ticked
//   downloading    the songs downloaded so far ready to trim; those cut off
//                  download again at the queue's next turn, before the links
//                  (its own row there, "Cancel" leaves them failed), a song's
//                  link alone read again
//   to trim        as it was, with the cuts, names and lyrics written
//   saving         to trim again, the songs saved as Flow closed gone
//
// Only where songs download here (the computer); a server's batches outlive
// the app on the server anyway.

const KeptDownloads = {
  _timer: 0,
  _last: '',
  _ready: false,

  get on() {
    return !!window.flow.saveDownloads && Store.can('downloadHere');
  },

  init() {
    if (!this.on) return;
    window.addEventListener('beforeunload', () => this.saveNow());
    this.restore();
  },

  /** Something changed: sent a moment later (several changes at once go together). */
  schedule() {
    if (!this._ready) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), 300);
    this._loop();
  },

  /**
   * Every 3 seconds while something is kept (the cuts and names changed in
   * the editor reach the file so), and not at all while nothing is (4.6; it
   * ran all the time). Started again by the next change.
   */
  _loop() {
    if (this._interval) return;
    this._interval = setInterval(() => {
      this.save();
      if (this._empty) {
        clearInterval(this._interval);
        this._interval = 0;
      }
    }, 3000);
  },

  snapshot() {
    return {
      version: 1,
      queue: ClientQueue.entries.filter((e) => !e.resume).map((e) => ClientQueue.keepOf(e)),
      batches: ImportPanel.batches.filter((b) => !b.server && !b.ended && b.state !== 'idle').map((b) => b._keep()),
    };
  },

  /** The text to send, or null when it is what was sent last. */
  _changed() {
    if (!this._ready) return null;
    let text;
    try {
      const snap = this.snapshot();
      this._empty = !snap.queue.length && !snap.batches.length;
      text = JSON.stringify(snap);
    } catch {
      return null;
    }
    if (text === this._last) return null;
    this._last = text;
    return text;
  },

  save() {
    const text = this._changed();
    if (text === null) return;
    window.flow.saveDownloads(text).catch(() => {
      this._last = '';
    });
  },

  /** As the window closes: at once, before it goes. */
  saveNow() {
    clearTimeout(this._timer);
    const text = this._changed();
    if (text === null) return;
    try {
      window.flow.saveDownloadsNow(text);
    } catch {
      // The last one sent stays.
    }
  },

  /** What was kept, back on the page and in the Client queue. Nothing is sent before (it would write over it). */
  async restore() {
    let state = null;
    try {
      state = await window.flow.loadDownloads();
    } catch {
      state = null;
    }
    try {
      if (state) this._apply(state);
    } finally {
      this._ready = true;
      this.save();
      this._loop();
    }
  },

  _apply(state) {
    const resumes = [];
    const again = [];
    let batches = 0;
    for (const k of Array.isArray(state.batches) ? state.batches : []) {
      if (!k || typeof k !== 'object') continue;
      try {
        const r = ImportPanel.restore(k);
        if (r && r.entry) again.push(r.entry);
        else batches += 1;
        if (r && r.resume) resumes.push({ resume: r.resume.batch, indexes: r.resume.indexes });
      } catch {
        // One that cannot be put back is left out.
      }
    }
    const queue = (Array.isArray(state.queue) ? state.queue : []).filter((e) => e && typeof e === 'object' && (e.url || e.picks || e.local || e.update));
    const entries = [...resumes, ...again, ...queue];
    if (entries.length) ClientQueue.restore(entries);
    const links = again.length + queue.length;
    if (batches || links) toast(T('add.kept.restored', { batches: Util.plural(batches, 'import'), links: Util.plural(links, 'link'), count: batches + links }), 'info');
  },
};
