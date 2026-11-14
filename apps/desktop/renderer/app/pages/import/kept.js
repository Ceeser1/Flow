'use strict';

// An import on Add Songs (ImportBatch, pages/import.js): kept over a restart of Flow, and brought back.

extend(ImportBatch, {
  // ---- kept over a restart (4.5.3, keptDownloads.js) ----

  /** The batch as kept: what it was choosing, its songs with their cuts and names (plain data). */
  _keep() {
    const item = (it) => {
      const out = {};
      for (const [key, value] of Object.entries(it)) {
        if (key === 'lyrics' || typeof value === 'function' || (value && typeof value === 'object' && value.nodeType)) continue;
        out[key] = value;
      }
      if (it.lyrics && it.lyrics.own) out.ownLyrics = it.lyrics.own;
      return out;
    };
    return {
      state: this.state,
      entry: this.entry || null,
      auto: this.auto,
      updating: this.updating,
      single: this.single,
      listing: this.listing,
      checked: [...this.checked],
      keepKnown: [...this.keepKnown],
      name: this.name,
      merge: this.merge,
      createList: this.createList,
      keepList: this.keepList,
      playlistIds: this.playlistIds,
      moveOriginals: this.moveOriginals,
      bulkInfo: this.bulkInfo,
      job: this.job,
      included: this.included.map(item),
    };
  },

  /**
   * Back as it was kept: its checklist, or its songs (those saved as Flow
   * closed gone from the cache: saved). Resolves the indexes of the songs
   * cut off downloading, which download again at their turn (_resume).
   */
  _restore(k) {
    this._newRun();
    this.single = !!k.single;
    const choices = () => {
      this.name = typeof k.name === 'string' ? k.name : this.name;
      this.merge = k.merge !== false;
      this.createList = !!k.createList;
      this.keepList = k.keepList !== false;
      this.playlistIds = Array.isArray(k.playlistIds) ? k.playlistIds : [];
      this.moveOriginals = !!k.moveOriginals;
      if (k.bulkInfo) this.bulkInfo = { ...this.bulkInfo, ...k.bulkInfo };
    };
    if (k.state === 'review') {
      this._review(k.listing);
      this.checked = new Set(k.checked || []);
      this.keepKnown = new Set(k.keepKnown || []);
      choices();
      this.render();
      return [];
    }
    this.listing = k.listing;
    choices();
    this.job = k.job || this._newJob(null);
    const cut = [];
    this.included = (k.included || []).map((raw) => {
      const it = { ...raw };
      delete it.ownLyrics;
      delete it.missing;
      const done = it.state === 'ready' || it.state === 'saving';
      if (done && raw.missing) it.state = 'saved';
      else if (it.state === 'saving') it.state = 'ready';
      else if (!it.existingId && (!it.state || it.state === 'current' || (it.state === 'failed' && it.interrupted))) {
        it.state = 'failed';
        it.interrupted = true;
        it.reason = T('import.song.interrupted');
        cut.push(it.index);
      }
      if (it.state === 'ready') {
        it.lyrics = AddPage.newLyrics(() => this._redrawFrame(it));
        if (it.lyrics && raw.ownLyrics) it.lyrics.own = raw.ownLyrics;
        this._lookLyrics(it);
        Covers.askStaged(it.coverKey || (it.media && it.media.path) || '');
      }
      return it;
    });
    this._setState('trimming');
    ImportPanel._setPending();
    return cut;
  },

  /** Its songs cut off by the restart, downloaded again (the Client queue's turn for it). */
  async _resume(indexes) {
    if (this.ended || this.state !== 'trimming') return;
    const items = this.included.filter((it) => indexes.includes(it.index) && it.interrupted && it.state === 'failed');
    if (!items.length) return;
    for (const it of items) {
      it.state = null;
      it.reason = '';
      it.interrupted = false;
      this._redrawFrame(it);
    }
    if (!await this._downloadAgain(items, T('import.progress.resuming', { songs: Util.plural(items.length, 'song') }))) return;
    this._setState('trimming');
    ImportPanel._setPending();
    if (this._endIfDone()) return;
    if (this.auto && this.auto.finish) await this.finishAll();
  },

  /** Its resume taken out of the Client queue: the songs stay failed, to be tried again by hand. */
  _dropResume(indexes) {
    for (const it of this.included) {
      if (!indexes.includes(it.index) || !it.interrupted) continue;
      it.interrupted = false;
      this._redrawFrame(it);
    }
    this._drawFooter();
  },

  /** Copy Files / Move Originals, in the middle of the footer for local files. */
  _drawCopyMove(shown) {
    const p = this.p;
    p.copyMove.hidden = !shown || !Store.can('moveOriginals');
    if (p.copyMove.hidden) return;
    const move = this.moveOriginals;
    p.copyMoveSwitch.setAttribute('aria-checked', String(move));
    p.copyMoveCopy.classList.toggle('copy-move__label--on', !move);
    p.copyMoveMove.classList.toggle('copy-move__label--on', move);
    const saving = this.state === 'saving';
    for (const b of [p.copyMoveSwitch, p.copyMoveCopy, p.copyMoveMove]) b.disabled = saving;
    p.copyMoveTip.textContent = T('import.moveOriginals.warning', { folder: Store.musicDir });
  },

  _ready() {
    return this.included.filter((it) => it.state === 'ready');
  },
});
