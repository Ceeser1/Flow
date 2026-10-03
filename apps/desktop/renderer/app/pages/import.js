'use strict';

// A whole playlist (or Mix, or Spotify list) on the Add Songs page:
//
//   listing -> review -> downloading -> trimming -> saving -> (idle)
//
// listing      the list is read (for Spotify: every song looked up on YouTube),
//              shown in the progress frame, with Cancel.
// review       the checklist. Songs already in the library and a playlist name
//              that is taken are listed as warnings on top, each with a box to
//              untick. Cancel, Download Selected, Download All.
// downloading  one song after another into the cache. Every song is a frame;
//              a downloaded one can be opened right away.
// trimming     clicking a frame opens the trim editor in it (waveform, cut,
//              preview, names) with Cancel Edits, Apply Edits and "Finish this
//              song"; one frame at a time. "Finish all" at the bottom right
//              saves every song left with its cut.
// saving       the songs go into the music folder, All Songs and the playlist.
//              Then the import is over: the panel empties and a toast sums it
//              up (with Open playlist), so nothing is left to click away.
//
// "Finish this song" saves one song at once, even while others still
// download; it leaves the list, and the first one saved makes the playlist.
// Every song goes into the playlist at its place in the source (job.base,
// see importer.finish), whatever order they are saved in. Once the last song
// is saved the import ends by itself. Nothing else reaches the library before
// it is finished; closing the app before that asks first (main.js), since the
// downloads are only in the cache.
//
// Local files ("Open local File(s) / Folder") skip the review: a folder is
// looked through in the listing step (with Cancel), then the files are
// prepared into the cache (converted where needed) as the downloading step,
// and "Finish all" saves them into All Songs, with no playlist. The footer
// then has "Copy Files / Move Originals"; moving deletes each original once
// its song is saved. Files that turn out to have no audio are summed up in
// one line rather than a frame each.
//
// A download on the server ("Download (Server)", serverImport.js) is shown in
// the same frames (`server`): its songs download there, and are trimmed here
// with the waveform and the preview from the server; "Finish this song" and
// "Finish all" save them there, Cancel import throws the batch away there. It
// outlives the app, so closing asks nothing.
//
// A song that failed to download has "Try again" in its frame; "Retry failed"
// in the footer tries every failed one again, one after another, and the
// footer says how far that is and how many failed again. Here that waits
// until the list is through; on the server it can be asked any time.
//
// "Cancel import" ends the whole task at once, whatever step it is in. Every
// task has a number (`run`) that its progress messages carry; a cancelled
// task's number is retired, so whatever it still says is ignored.

const SOURCE_NAMES = {
  youtube: 'YouTube', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', spotify: 'Spotify', vimeo: 'Vimeo', local: 'Local files',
};

const ImportPanel = {
  state: 'idle',
  listing: null,
  checked: new Set(),     // indexes of new songs ticked
  keepKnown: new Set(),   // indexes of library songs ticked (added to the list)
  merge: true,            // add to the playlist of the same name, if there is one
  job: null,              // source, local: fixed when downloading starts
  name: '',               // the playlist's name, editable until the songs are saved
  createList: false,      // local files: make a playlist of them ("Create new Playlist")
  playlistIds: [],        // existing playlists every song joins ("Add to Playlist")
  editingName: false,
  _nameDraft: '',
  _nameHint: '',
  included: [],           // the chosen songs, in order, each with its own state
  openIndex: null,        // the frame whose editor is open
  progress: { number: 0, total: 0 },
  moveOriginals: false,   // local files: move rather than copy them
  run: 0,                 // the number of the task now running (see above)
  _dirty: new Set(),      // frames to redraw at the next animation frame
  _lastProgress: null,    // the latest progress line, drawn with them
  _flushQueued: false,
  _chain: null,           // the "Finish this song" saves, one after another
  server: null,           // a download on the server: { id, single } of its batch
  retry: null,            // failed songs tried again: { indexes, sending, done, failedAgain }

  /** A list is being read or imported: single-link downloads wait. */
  get busy() {
    return ['listing', 'downloading', 'trimming', 'saving'].includes(this.state);
  },

  /** The songs are files from the computer, not a playlist. */
  get local() {
    return !!(this.listing && this.listing.local);
  },

  /**
   * The songs make a playlist only when asked to ("Create new Playlist"):
   * local files, and one song downloaded by the server.
   */
  get optionalList() {
    return this.local || !!(this.server && this.server.single);
  },

  /** The footer at the bottom of the page shows "Finish all". */
  get ownsFooter() {
    return this.state === 'downloading' || this.state === 'trimming' || this.state === 'saving';
  },

  init() {
    window.flow.onImportProgress((p) => this._onProgress(p));
    $('importCancel').onclick = () => this.close();
    $('importSelected').onclick = () => this.start(false);
    $('importEverything').onclick = () => this.start(true);
    $('importSelectAll').onclick = () => this._selectAll(true);
    $('importSelectNone').onclick = () => this._selectAll(false);
    // Shared with the single song's footer.
    $('importCancelAll').onclick = () => (this.ownsFooter ? this.cancelAll() : AddPage.cancelSingle());
    $('copyMoveSwitch').onclick = () => this._setMove(!this.moveOriginals);
    $('copyMoveCopy').onclick = () => this._setMove(false);
    $('copyMoveMove').onclick = () => this._setMove(true);
    $('importRetryFailed').onclick = () => this.retryFailed(this.included.filter((it) => it.state === 'failed').map((it) => it.index));
    Store.onLibrary(() => {
      if (this.state !== 'idle' && this.state !== 'listing') this._drawWarnings();
    });
  },

  /**
   * Reads a playlist link and shows its checklist. Resolves the probed song
   * when the link turned out to be one song, else null.
   */
  async open(url) {
    const run = this._newRun();
    this._setState('listing');
    AddPage._progress({ title: 'Reading playlist...', frac: null, status: url });
    let listing;
    try {
      listing = await window.flow.listImport(url, run);
    } catch (err) {
      if (run !== this.run) return null;
      this._setState('idle');
      AddPage._failed(err);
      return null;
    }
    if (run !== this.run) return null;
    if (listing.single) {
      this._setState('idle');
      return listing.probed;
    }
    this.listing = listing;
    this.checked = new Set(listing.items.filter((it) => !it.existing && it.status === 'ok').map((it) => it.index));
    this.keepKnown = new Set(listing.items.filter((it) => it.existing).map((it) => it.index));
    this._resetName(listing.name);
    $('progressPanel').hidden = true;
    this._setState('review');
    return null;
  },

  /**
   * Files and folders picked on the computer: listed, then prepared one after
   * another, each a frame as for a playlist.
   */
  async openLocal(picked) {
    if (this.state !== 'idle') return;
    const drive = picked.length === 1 && /^([A-Za-z]:[\\/]?|\/)$/.test(picked[0]) ? picked[0] : '';
    if (drive) {
      const ok = await confirmDialog({
        title: 'Look through the whole drive?',
        message: `Looking through all of ${drive} takes a while. Program and system folders are left out, `
          + 'and at most 2000 files are listed. Opening the folder your music is in is quicker.',
        confirmLabel: 'Look through it',
      });
      if (!ok || this.state !== 'idle') return;
    }
    const run = this._newRun();
    this._setState('listing');
    AddPage._progress({ title: 'Looking through the folder...', frac: null, status: 'Starting...' });
    let listing;
    try {
      listing = await window.flow.listLocal(picked, run);
    } catch (err) {
      if (run !== this.run) return;
      this._setState('idle');
      if (err.cancelled) {
        AddPage._failed(err);
      } else {
        $('progressPanel').hidden = true;
        $('progTitle').textContent = '';
        AddPage._showError(err.message);
      }
      return;
    }
    if (run !== this.run) return;
    $('progressPanel').hidden = true;
    this.listing = listing;
    this.moveOriginals = false;
    this._resetName(listing.name);
    await this._run(listing.items, { local: true });
  },

  _setMove(on) {
    if (this.state === 'saving') return;
    this.moveOriginals = !!on;
    this._drawFooter();
  },

  _newRun() {
    this.run += 1;
    return this.run;
  },

  /**
   * Cancel in the progress frame. While a list or folder is read, that ends
   * the import at once. While downloading it stops there: what is ready so
   * far stays for trimming.
   */
  cancel() {
    if (this.server) {
      // The server still reading the link: the batch goes.
      ServerImport.touch();
      window.flow.serverDownloads('cancel').catch(() => {});
      this._reset();
      $('progressPanel').hidden = false;
      AddPage._failed({ cancelled: true, message: 'Cancelled.' });
      return;
    }
    window.flow.cancelImport().catch(() => {});
    if (this.state !== 'listing') return;
    this._newRun();
    this._setState('idle');
    AddPage._failed({ cancelled: true, message: 'Cancelled.' });
  },

  /** Leaves the import (the checklist, or the frames) and empties the panel. */
  close() {
    if (this.state === 'listing' || this.state === 'downloading' || this.state === 'saving') return;
    this._reset();
  },

  /** Back to nothing, whatever state the import is in. */
  _reset() {
    this._closeEditor(false);
    this.listing = null;
    this.included = [];
    this.job = null;
    this.server = null;
    this.retry = null;
    this.moveOriginals = false;
    this._resetName('');
    this._setState('idle');
    this._setPending();
    $('progressPanel').hidden = true;
    $('linkInput').focus();
  },

  _setState(state) {
    this.state = state;
    const reviewing = state === 'review';
    $('importPanel').hidden = state === 'idle' || state === 'listing';
    $('importButtons').hidden = !reviewing;
    $('importToolbar').hidden = !reviewing;
    $('downloadBtn').disabled = this.busy;
    $('linkInput').disabled = this.busy;
    AddPage.drawLocalPick();
    if (typeof ServerImport !== 'undefined') ServerImport.drawButtons();
    this._drawBadge();
    this._drawFooter();
    if (state !== 'idle' && state !== 'listing') this.render();
  },

  /**
   * Progress messages can come by the hundred a second (a folder of files
   * without audio fails as fast as ffprobe starts): the frames, the footer
   * and the progress line are drawn once per animation frame, so the window,
   * and Cancel import with it, stays responsive.
   */
  _scheduleDraw() {
    if (this._flushQueued) return;
    this._flushQueued = true;
    requestAnimationFrame(() => this._flush());
  },

  _flush() {
    this._flushQueued = false;
    if (this.state !== 'downloading') {
      this._dirty.clear();
      this._lastProgress = null;
      return;
    }
    let current = null;
    for (const it of this._dirty) {
      if (it.state === 'current') current = it;
      this._redrawFrame(it, false);
    }
    this._dirty.clear();
    if (current && this.openIndex === null) {
      const node = $('importList').querySelector(`[data-index="${current.index}"]`);
      if (node) node.scrollIntoView({ block: 'nearest' });
    }
    this._drawFailSummary();
    this._drawFooter();
    this._drawBadge();
    if (this._lastProgress) AddPage._progress(this._lastProgress);
    this._lastProgress = null;
  },

  _drawBadge() {
    const badge = $('menuAddBadge');
    if (!badge) return;
    let text = '';
    if (this.state === 'listing') text = '...';
    else if (this.state === 'downloading') text = `${this.progress.number}/${this.progress.total}`;
    else if (this.state === 'trimming') text = String(this._ready().length);
    badge.hidden = !text;
    badge.textContent = text;
    badge.title = this.state === 'trimming' ? 'Imported songs waiting for "Finish all"' : 'Playlist import running';
  },

  /** The page's sticky footer: Cancel import and "Finish all" while importing. */
  _drawFooter() {
    const mine = this.ownsFooter;
    $('importFooterText').hidden = !mine;
    this._drawCopyMove(mine && this.local);
    AddPage._drawPlaylistButton();
    if (!mine) {
      $('importRetryFailed').hidden = true;
      $('importRetryText').hidden = true;
      $('addFooter').classList.remove('add-footer--retry');
      // Back to the single song's footer, shown with its editor.
      const saving = AddPage.phase === 'saving';
      $('finishBtn').textContent = saving ? 'Saving...' : 'Finish';
      $('finishBtn').disabled = saving;
      $('importCancelAll').disabled = saving;
      $('addToPlaylistBtn').disabled = saving;
      $('addFooter').hidden = !(AddPage.phase === 'ready' || saving);
      return;
    }
    $('addToPlaylistBtn').disabled = this.state === 'saving';
    $('addFooter').hidden = false;
    const ready = this._ready().length;
    const trimmed = this.included.filter((it) => it.trim && it.state === 'ready').length;
    // Local files that failed are summed up above the frames instead.
    const failed = this.local ? 0 : this.included.filter((it) => it.state === 'failed').length;
    const r = this.retry && !this.retry.done ? this.retry : null;
    const waiting = this.included.filter((it) => !it.existingId && (!it.state || it.state === 'current')
      && !(r && r.indexes.includes(it.index))).length;
    const saved = this.job ? this.job.totals.saved : 0;
    const parts = [`${Util.plural(ready, 'song')} ready`];
    if (failed) parts.push(`${failed} failed`);
    if (trimmed) parts.push(`${trimmed} trimmed`);
    if (saved) parts.push(`${saved} saved`);
    if (waiting && this.state === 'downloading') {
      parts.push(`${waiting} still ${this.local ? 'preparing' : (this.server ? 'downloading on the server' : 'downloading')}`);
    }
    $('importFooterText').textContent = parts.join(' · ');
    this._drawRetry(failed);
    $('finishBtn').textContent = this.state === 'saving' ? 'Saving...' : 'Finish all';
    const anything = ready || this._existingEntries().length;
    $('finishBtn').disabled = this.state !== 'trimming' || !anything;
    $('finishBtn').title = this.state === 'downloading'
      ? `Available once every song is ${this.local ? 'prepared' : 'downloaded'}` : '';
    $('importCancelAll').disabled = this.state === 'saving';
  },

  /**
   * "Retry failed" while songs failed, or instead of it the turning circle
   * with how far the retry is; after one, how many failed again.
   */
  _drawRetry(failed) {
    this._settleRetry();
    const r = this.retry;
    const busy = !!(r && !r.done);
    const btn = $('importRetryFailed');
    btn.hidden = busy || !failed || !this._canRetry();
    btn.disabled = this.state === 'saving';
    let line = '';
    if (busy) {
      const mine = this.included.filter((it) => r.indexes.includes(it.index));
      const started = mine.filter((it) => it.existingId || it.state).length;
      line = `Reattempting to download song ${Math.min(Math.max(started, 1), mine.length)} of ${mine.length}`;
    } else if (r && failed && r.failedAgain) {
      line = `Reattempt: ${r.failedAgain} failed again`;
    }
    const text = $('importRetryText');
    text.textContent = line;
    text.hidden = !line;
    text.classList.toggle('import-retry--busy', busy);
    $('addFooter').classList.toggle('add-footer--retry', !btn.hidden || !!line);
  },

  /** A retry is over once none of its songs is waiting or downloading. */
  _settleRetry() {
    const r = this.retry;
    if (!r || r.done || r.sending) return;
    const mine = this.included.filter((it) => r.indexes.includes(it.index));
    if (mine.some((it) => !it.existingId && (!it.state || it.state === 'current'))) return;
    r.done = true;
    r.failedAgain = mine.filter((it) => it.state === 'failed').length;
  },

  /**
   * Failed songs can be downloaded again: on the server any time it is not
   * saving, here once the list is through (one download task at a time).
   */
  _canRetry() {
    if (this.local) return false;
    if (this.server) return this.state !== 'saving';
    return this.state === 'trimming';
  },

  /**
   * "Try again" on one song, "Retry failed" on all: the songs that failed are
   * downloaded once more, one after another.
   */
  async retryFailed(indexes) {
    if (!this._canRetry()) return;
    const items = this.included.filter((it) => indexes.includes(it.index) && it.state === 'failed');
    if (!items.length) return;
    // Asked while one runs (only on the server): it takes these as well.
    let r = this.retry;
    if (r && !r.done) r.indexes.push(...items.map((it) => it.index));
    else r = this.retry = { indexes: items.map((it) => it.index), sending: 0, done: false, failedAgain: 0 };
    r.sending += 1;
    for (const it of items) {
      it.state = null;
      it.reason = '';
      this._redrawFrame(it, false);
    }
    this._drawFooter();
    if (this.server) {
      const batch = await ServerImport.retry(items.map((it) => it.index));
      if (this.retry !== r) return;
      r.sending -= 1;
      if (batch) this.syncServer(batch);
      else ServerImport.poll();
      this._drawFooter();
      ServerImport.schedule();
      return;
    }
    const run = this._newRun();
    this.progress = { number: 0, total: items.length };
    this._setState('downloading');
    AddPage._progress({ title: `Downloading ${Util.plural(items.length, 'song')} again`, frac: null, status: 'Starting...' });
    try {
      const list = items.map((it) => ({ index: it.index, title: it.title, url: it.url, path: '', meta: it.meta }));
      await window.flow.downloadImport(list, AddPage.downloadOptions(), run);
    } catch (err) {
      if (run === this.run) toast(err.message, 'error');
    }
    // Cancelled with "Cancel import": that has already emptied the panel.
    if (run !== this.run) return;
    await this._lateStates(items, run);
    if (run !== this.run) return;
    this._flush();
    $('progressPanel').hidden = true;
    // Stopped with Cancel: what was not reached can be tried again.
    for (const it of items) {
      if (!it.existingId && (!it.state || it.state === 'current' || it.state === 'cancelled')) {
        it.state = 'failed';
        it.reason = it.reason || 'cancelled';
      }
    }
    r.sending -= 1;
    this._setState('trimming');
    this._setPending();
  },

  /** Copy Files / Move Originals, in the middle of the footer for local files. */
  _drawCopyMove(shown) {
    $('copyMove').hidden = !shown;
    if (!shown) return;
    const move = this.moveOriginals;
    const sw = $('copyMoveSwitch');
    sw.setAttribute('aria-checked', String(move));
    $('copyMoveCopy').classList.toggle('copy-move__label--on', !move);
    $('copyMoveMove').classList.toggle('copy-move__label--on', move);
    $('copyMoveMove').classList.add('copy-move__label--move');
    const saving = this.state === 'saving';
    for (const b of [sw, $('copyMoveCopy'), $('copyMoveMove')]) b.disabled = saving;
    $('copyMoveTip').textContent = 'Warning! Moving original files will remove them from their source folder '
      + `and move them into '${Store.musicDir}'!`;
  },

  _ready() {
    return this.included.filter((it) => it.state === 'ready');
  },

  /** Songs only in the cache, which closing the app would lose (a server's batch stays there). */
  _setPending() {
    window.flow.setImportPending(this.state === 'idle' || this.server ? 0 : this._ready().length).catch(() => {});
  },

  // ---- the checklist ----

  _newItems() {
    return this.listing ? this.listing.items.filter((it) => !it.existing) : [];
  },

  _knownItems() {
    return this.listing ? this.listing.items.filter((it) => it.existing) : [];
  },

  /** A playlist of the same name, which the songs would be added to (see merge). */
  _takenPlaylist() {
    if (!this._makesPlaylist()) return null;
    const name = this._finalName().toLowerCase();
    return Store.library.playlists.find((p) => p.name.toLowerCase() === name) || null;
  },

  /** Local files (see optionalList) only make a playlist when "Create new Playlist" is ticked. */
  _makesPlaylist() {
    return !this.optionalList || this.createList;
  },

  _finalName() {
    return this.name.replace(/\s+/g, ' ').trim() || (this.listing ? this.listing.name : '') || 'Imported playlist';
  },

  _resetName(name) {
    this.name = name || '';
    this.editingName = false;
    this.createList = false;
    this.playlistIds = [];
    this.merge = true;
  },

  /**
   * The name at the top, changeable until the songs are saved. A playlist's
   * is text with a pencil, which turns it into a box with Apply and Cancel
   * (Enter and Escape do the same). Local files have "Create new Playlist"
   * in front: unticked the name is only the list's label, ticked it is a box
   * with the name the playlist gets.
   */
  _drawName() {
    const box = $('importNameBox');
    if (!box) return;
    clear(box);
    // Once a song is saved the playlist exists: it is renamed on its own page.
    const fixed = this.state === 'saving' || this._saved();
    if (this.optionalList) {
      const tick = h('input', { type: 'checkbox', checked: this.createList, disabled: fixed });
      tick.addEventListener('change', () => {
        this.createList = tick.checked;
        this._drawName();
        this._drawWarnings();
        const input = box.querySelector('input[type="text"]');
        if (input) {
          input.focus();
          input.select();
        }
      });
      box.appendChild(h('label.check.import__create', tick, h('span', 'Create new Playlist')));
      if (this.createList) {
        const input = h('input.input.import__name-box', {
          type: 'text', maxLength: 75, spellcheck: false, value: this.name, disabled: fixed, 'aria-label': 'Playlist name',
        });
        input.addEventListener('input', () => {
          this.name = input.value;
          this._drawWarnings();
        });
        box.appendChild(input);
      } else {
        box.appendChild(h('span.import__heading', this.name));
      }
      return;
    }
    if (this.editingName && !fixed) {
      const hint = h('span.import__name-hint', { hidden: !this._nameHint }, this._nameHint);
      const input = h('input.input.import__name-box', {
        type: 'text', maxLength: 75, spellcheck: false, value: this._nameDraft, 'aria-label': 'Playlist name',
      });
      input.addEventListener('input', () => {
        this._nameDraft = input.value;
        this._nameHint = '';
        hint.hidden = true;
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._applyName();
        } else if (e.key === 'Escape') {
          // Only ends the editing; nothing else on the page reacts to it.
          e.preventDefault();
          e.stopPropagation();
          this._cancelName();
        }
      });
      box.append(input,
        h('button.btn.btn--small.btn--light-green', { type: 'button', onclick: () => this._applyName() }, 'Apply'),
        h('button.btn.btn--small', { type: 'button', onclick: () => this._cancelName() }, 'Cancel'),
        hint);
      requestAnimationFrame(() => input.focus());
      return;
    }
    box.append(h('span.import__heading', this.name));
    if (!fixed) box.append(iconButton('icon-btn.import__rename', Icons.pencil, 'Rename the playlist', () => this._editName()));
  },

  _editName() {
    this.editingName = true;
    this._nameDraft = this.name;
    this._nameHint = '';
    this._drawName();
    requestAnimationFrame(() => {
      const input = $('importNameBox') && $('importNameBox').querySelector('input');
      if (input) input.select();
    });
  },

  _applyName() {
    const name = this._nameDraft.replace(/\s+/g, ' ').trim();
    if (!name) {
      this._nameHint = 'A playlist needs a name.';
      this._drawName();
      return;
    }
    this.name = name;
    this.editingName = false;
    this._drawName();
    this._drawWarnings();
  },

  _cancelName() {
    this.editingName = false;
    this._nameHint = '';
    this._drawName();
  },

  /** Add to Playlist for a whole import: existing playlists every song joins. */
  async choosePlaylists() {
    const chosen = await pickPlaylists({
      subtitle: `Every song of ${this._makesPlaylist() ? `"${this._finalName()}"` : 'this import'}`,
      selectedIds: this.playlistIds,
    });
    if (chosen === null) return;
    this.playlistIds = chosen;
    AddPage._drawPlaylistButton();
  },

  render() {
    const l = this.listing;
    if (!l) return;
    const kind = String(l.source || '').toLowerCase();
    const source = SOURCE_NAMES[kind] || l.source || 'Playlist';
    const head = clear($('importSource'));
    head.appendChild(h('span.import__badge', source));
    head.appendChild(h('span.import__name', { id: 'importNameBox' }));
    this._drawName();
    if (this.state === 'review') {
      head.appendChild(h('span', `${Util.plural(l.items.length, 'song')} in this list`));
    }
    if (l.truncated === 'files') {
      head.appendChild(h('span.import__warn-text', `The folder holds more files: only the first ${l.items.length} are listed.`));
    } else if (l.truncated === 'spotify') {
      head.appendChild(h('span.import__warn-text', 'Spotify only showed the first 100 songs; the rest of the list is missing.'));
    } else if (l.truncated === 'mix') {
      head.appendChild(h('span.import__warn-text', 'A Mix never ends: its first 50 songs are listed.'));
    }
    if (this.state !== 'review') {
      const hint = `Click a ${this.local ? 'ready' : 'downloaded'} song to trim it or change its names.`;
      head.appendChild(h('span.muted-text', hint));
    }
    this._drawWarnings();
    this._drawList();
    this._drawCount();
  },

  _drawWarnings() {
    const box = clear($('importWarnings'));
    const rows = [];
    const taken = this.state === 'saving' || this._saved() ? null : this._takenPlaylist();
    if (taken) {
      const tick = h('input', { type: 'checkbox', checked: this.merge });
      tick.addEventListener('change', () => {
        this.merge = tick.checked;
      });
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div',
          h('div', `A playlist called "${taken.name}" already exists.`),
          h('label.check', tick,
            h('span', `Add the songs to it (unticked: a new playlist "${taken.name} (2)")`)))));
    }
    const known = this.state === 'review' ? this._knownItems() : [];
    if (known.length) {
      const list = h('div.import__known');
      for (const it of known) {
        const tick = h('input', { type: 'checkbox', checked: this.keepKnown.has(it.index) });
        tick.addEventListener('change', () => {
          if (tick.checked) this.keepKnown.add(it.index);
          else this.keepKnown.delete(it.index);
          this._drawCount();
        });
        list.appendChild(h('label.check.import__known-row', tick,
          h('span', it.title),
          h('span.muted-text', ` - in your library as "${Util.songLine(it.existing)}"`)));
      }
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div',
          h('div', `${Util.plural(known.length, 'song')} ${known.length === 1 ? 'is' : 'are'} already in your library `
            + 'and will not be downloaded again. Ticked ones are added to the playlist:'),
          list)));
    }
    box.hidden = !rows.length;
    for (const r of rows) box.appendChild(r);
  },

  _drawList() {
    const list = clear($('importList'));
    list.classList.toggle('import__list--frames', this.state !== 'review');
    if (this.state === 'review') {
      const items = this._newItems();
      if (!items.length) {
        list.appendChild(h('div.import__empty', 'Every song of this list is already in your library (see above).'));
        return;
      }
      const frag = document.createDocumentFragment();
      for (const it of items) frag.appendChild(this._checkRow(it));
      list.appendChild(frag);
      return;
    }
    // The frames. The open one keeps its editor: it is moved, not redrawn.
    // Clearing the list took the editor out of the document with the old
    // frame, so it is put back by reference.
    const frag = document.createDocumentFragment();
    frag.appendChild(h('div.import__summary', { id: 'importFailSummary', hidden: true }));
    for (const it of this.included) frag.appendChild(this._frame(it));
    list.appendChild(frag);
    this._drawFailSummary();
    if (this.openIndex !== null && AddPage.embedded) {
      const body = list.querySelector(`[data-index="${this.openIndex}"] .import__frame-body`);
      if (body) {
        body.prepend(AddPage.editorEl);
        requestAnimationFrame(() => AddPage._redraw());
      } else {
        // The frame is gone: keep what was set and close the editor.
        this._closeEditor(true);
      }
    }
  },

  /**
   * Local files that could not be opened, as one line per reason instead of
   * a frame each: a folder can hold hundreds of files that only look like
   * audio by their name.
   */
  _drawFailSummary() {
    const box = $('importFailSummary');
    if (!box) return;
    const failed = this.local ? this.included.filter((it) => it.state === 'failed') : [];
    clear(box);
    box.hidden = !failed.length;
    if (!failed.length) return;
    const byReason = new Map();
    for (const it of failed) {
      const r = it.reason || 'failed';
      if (!byReason.has(r)) byReason.set(r, []);
      byReason.get(r).push(it.title);
    }
    for (const [reason, titles] of byReason) {
      const n = titles.length;
      const text = /no audio/i.test(reason)
        ? `${Util.plural(n, 'file')} had no audio in ${n === 1 ? 'it' : 'them'} and ${n === 1 ? 'was' : 'were'} left out.`
        : `${Util.plural(n, 'file')} could not be opened: ${reason}`;
      const more = n > 20 ? `\n... and ${n - 20} more` : '';
      box.appendChild(h('div.import__sub.import__sub--bad', { title: titles.slice(0, 20).join('\n') + more }, text));
    }
  },

  _checkRow(it) {
    const usable = it.status === 'ok';
    const tick = h('input', { type: 'checkbox', checked: this.checked.has(it.index), disabled: !usable });
    tick.addEventListener('change', () => {
      if (tick.checked) this.checked.add(it.index);
      else this.checked.delete(it.index);
      this._drawCount();
    });
    const text = h('div.import__text', h('div.import__title', { title: it.title }, it.title));
    const sub = this._matchLine(it);
    if (sub) text.appendChild(sub);
    return h('label.import__row' + (usable ? '' : '.import__row--off'), { dataset: { index: String(it.index) } },
      tick,
      h('span.import__num', String(it.index + 1)),
      text,
      h('span.import__dur', it.duration ? Util.fmtClock(it.duration) : ''));
  },

  /** For a Spotify song: the YouTube upload it was matched to. */
  _matchLine(it) {
    if (it.status === 'unavailable') return h('div.import__sub.import__sub--bad', it.note || 'not available');
    const m = it.match;
    if (!m) {
      return it.status === 'notfound' ? h('div.import__sub.import__sub--bad', `Not found: ${it.note || 'no match on YouTube'}`) : null;
    }
    const diff = Math.round((m.duration || 0) - (it.duration || 0));
    const off = diff === 0 ? 'same length' : `${diff > 0 ? '+' : ''}${diff} s`;
    const link = h('button.link-btn.import__link', {
      type: 'button',
      title: 'Open on YouTube to check',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.flow.openUrl(`https://www.youtube.com/watch?v=${m.id}`);
      },
    }, m.title || 'YouTube');
    const parts = [h('span', 'YouTube: '), link,
      h('span', ` · ${m.channel || '?'} · ${Util.fmtClock(m.duration)} (${off})`)];
    if (it.status === 'notfound') parts.unshift(h('span.import__flag.import__flag--bad', 'not found'));
    else if (m.quality === 'shaky') parts.unshift(h('span.import__flag', 'check'));
    return h('div.import__sub', ...parts);
  },

  _selectAll(on) {
    for (const it of this._newItems()) {
      if (it.status !== 'ok') continue;
      if (on) this.checked.add(it.index);
      else this.checked.delete(it.index);
    }
    this._drawList();
    this._drawCount();
  },

  _drawCount() {
    if (this.state !== 'review') return;
    const usable = this._newItems().filter((it) => it.status === 'ok');
    const chosen = usable.filter((it) => this.checked.has(it.index));
    const seconds = chosen.reduce((sum, it) => sum + (it.duration || 0), 0);
    const kbps = Store.settings.alwaysMp3 ? Number(Store.settings.mp3Quality) || 192 : 160;
    const mb = (kbps * 1000 / 8) * seconds / 1e6;
    let text = `${chosen.length} of ${usable.length} selected`;
    if (chosen.length) text += ` · about ${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    const known = this._knownItems().filter((it) => this.keepKnown.has(it.index)).length;
    if (known) text += ` · ${known} from your library`;
    $('importCount').textContent = text;
    $('importSelected').disabled = !chosen.length && !known;
    $('importEverything').disabled = !usable.length && !this._knownItems().length;
  },

  // ---- the frames ----

  _frame(it) {
    const st = it.existingId ? 'library' : (it.state || 'waiting');
    const open = this.openIndex === it.index;
    const meta = it.meta || {};
    const name = meta.title ? [meta.artist, meta.title].filter(Boolean).join(' - ') + (meta.mix ? ` (${meta.mix})` : '') : it.title;

    let sub = '';
    let subBad = false;
    if (st === 'library') sub = 'from your library';
    else if (st === 'failed') { sub = it.reason || 'failed'; subBad = true; }
    else if (st === 'cancelled') { sub = 'cancelled'; subBad = true; }
    else if (st === 'current') sub = it.note || (this.local ? 'preparing...' : 'downloading...');
    else if (st === 'saving') sub = 'saving...';
    else if (st === 'waiting') sub = 'waiting';
    else if (it.trim) {
      sub = `trimmed ${Util.fmtClock(it.trim.start)} - ${Util.fmtClock(it.trim.end)}, `
        + `${Util.fmtClock(it.trim.end - it.trim.start)} of ${Util.fmtClock(it.media.duration)}`;
    } else sub = open ? '' : 'click to trim or rename';

    const length = st === 'ready'
      ? Util.fmtClock(it.trim ? it.trim.end - it.trim.start : it.media.duration)
      : (it.duration ? Util.fmtClock(it.duration) : '');
    const clickable = st === 'ready' && this.state !== 'saving';
    // A failed download has "Try again" in its row, in front of the length
    // (a row with a button in it is no button itself).
    const retry = st === 'failed' && this._canRetry();

    const head = h(retry ? 'div.import__frame-head' : 'button.import__frame-head', retry ? {} : {
      type: 'button',
      disabled: !clickable,
      title: clickable ? (open ? 'Close (keeps the changes)' : 'Trim or rename this song') : '',
      onclick: () => this.toggleFrame(it.index),
    },
    h('span.import__state', { html: { ready: Icons.check, library: Icons.check, failed: Icons.x, cancelled: Icons.x }[st] || '' }),
    h('span.import__num', String(it.index + 1)),
    this._cover(it),
    h('span.import__text',
      h('span.import__title', { title: name }, name),
      sub ? h('span.import__sub' + (subBad ? '.import__sub--bad' : ''), sub) : null),
    it.trim ? h('span.import__flag.import__flag--trim', 'trimmed') : null,
    retry ? h('button.btn.btn--small.btn--light-green', { type: 'button', onclick: () => this.retryFailed([it.index]) }, 'Try again') : null,
    h('span.import__dur', length),
    clickable ? h('span.import__chevron', { html: Icons.chevron }) : null);

    const frame = h('div.import__frame.import__frame--' + st + (open ? '.import__frame--open' : ''),
      { dataset: { index: String(it.index) } }, head);
    // Summed up in one line instead (_drawFailSummary); a saved song is done.
    if ((st === 'failed' && this.local) || st === 'saved' || st === 'discarded') frame.hidden = true;
    if (open) {
      frame.appendChild(h('div.import__frame-body',
        h('div.import__frame-foot',
          h('button.btn.btn--light-grey', { type: 'button', title: 'Back to the cut and names it had when opened', onclick: () => this.cancelEdits() }, 'Cancel Edits'),
          h('button.btn.btn--light-green', { type: 'button', onclick: () => this.apply() }, 'Apply Edits'),
          h('button.btn.btn--primary', { type: 'button', title: 'Save this song now', onclick: () => this.finishOne(it.index) }, 'Finish this song'))));
    }
    return frame;
  },

  /**
   * A frame's cover: the library song's for one the library has, else the
   * one found right after the download (the note until then).
   */
  _cover(it) {
    const song = it.existingId ? Store.song(it.existingId) : null;
    if (song) return Covers.el(song, 'frame');
    return Covers.pendingEl(it.coverKey || (it.media && it.media.path) || '', 'frame');
  },

  toggleFrame(index) {
    if (this.openIndex === index) {
      this.apply();
      return;
    }
    this._closeEditor(true);
    const it = this.included.find((x) => x.index === index);
    if (!it || it.state !== 'ready') return;
    this.openIndex = index;
    this._drawList();
    const body = $('importList').querySelector(`[data-index="${index}"] .import__frame-body`);
    AddPage.openEmbedded(body, {
      media: it.media,
      meta: it.meta,
      title: it.song ? it.song.title : it.title,
      start: it.trim ? it.trim.start : 0,
      end: it.trim ? it.trim.end : it.media.duration,
      artistFromChannel: it.artistFromChannel,
    });
    body.closest('.import__frame').scrollIntoView({ block: 'nearest' });
  },

  /** Apply Edits: keeps the open frame's cut and names, and closes it. */
  apply() {
    this._closeEditor(true);
    this._drawList();
    this._drawFooter();
  },

  /** Cancel Edits: the cut and names go back to what they were when the frame was opened. */
  cancelEdits() {
    this._closeEditor(false);
    this._drawList();
    this._drawFooter();
  },

  /**
   * Closes the open frame's editor. With `keep` its cut and names are kept (a
   * cut that is the whole song counts as none).
   */
  _closeEditor(keep) {
    if (this.openIndex === null) return;
    const it = this.included.find((x) => x.index === this.openIndex);
    const result = AddPage.closeEmbedded();
    this.openIndex = null;
    if (!keep || !it || !result) return;
    if (result.meta.title) it.meta = result.meta;
    const whole = result.start < 0.01 && result.end > it.media.duration - 0.01;
    it.trim = whole ? null : { start: result.start, end: result.end };
  },

  // ---- importing ----

  async start(everything) {
    if (this.state !== 'review' || !this.listing) return;
    const l = this.listing;
    const chosen = l.items.filter((it) => {
      if (it.existing) return everything || this.keepKnown.has(it.index);
      return it.status === 'ok' && (everything || this.checked.has(it.index));
    });
    if (!chosen.length) return;
    await this._run(chosen, {
      source: { url: l.sourceUrl, kind: String(l.source || '').toLowerCase() },
    });
  },

  /**
   * Fetches the chosen songs into the cache (downloads, or for local files
   * prepares them), each a frame, then leaves them for trimming.
   */
  async _run(chosen, job) {
    const run = this._newRun();
    // base: the playlist time, fixed at the first save; playlistId: the
    // playlist that save made; totals: what every save did, for the toast.
    this.job = {
      ...job,
      base: 0,
      playlistId: null,
      saves: 0,
      totals: { playlistId: null, name: '', saved: 0, fromLibrary: 0, failed: [], kept: [] },
    };
    this.included = chosen.map((it) => ({
      index: it.index,
      title: it.title,
      duration: it.duration,
      url: it.url,
      path: it.path || '',
      meta: it.meta && it.meta.title ? { ...it.meta } : null,
      existingId: it.existing ? it.existing.id : null,
      state: null,
    }));
    const toFetch = this.included.filter((it) => !it.existingId);
    this.progress = { number: 0, total: toFetch.length };
    this._setState('downloading');
    if (toFetch.length) {
      AddPage._progress({
        title: job.local ? `Opening ${Util.plural(toFetch.length, 'file')}` : `Importing "${this._finalName()}"`,
        frac: null,
        status: 'Starting...',
      });
      const items = toFetch.map((it) => ({ index: it.index, title: it.title, url: it.url, path: it.path, meta: it.meta }));
      try {
        if (job.local) await window.flow.prepareLocal(items, AddPage.downloadOptions(), run);
        else await window.flow.downloadImport(items, AddPage.downloadOptions(), run);
      } catch (err) {
        if (run === this.run) toast(err.message, 'error');
      }
    }
    // Cancelled with "Cancel import": that has already emptied the panel.
    if (run !== this.run) return;
    await this._lateStates(toFetch, run);
    if (run !== this.run) return;
    this._flush();
    $('progressPanel').hidden = true;
    // Anything not reached (cancelled) stays out.
    for (const it of this.included) {
      if (!it.existingId && (!it.state || it.state === 'current')) it.state = 'cancelled';
    }
    this._setState('trimming');
    this._setPending();
    // Every song was finished one by one while the rest downloaded.
    if (this._endIfDone()) return;
    const ready = this._ready().length;
    const failed = this.included.filter((it) => it.state === 'failed').length;
    toast(`${Util.plural(ready, 'song')} ${job.local ? 'ready' : 'downloaded'}${failed ? `, ${failed} failed` : ''}. `
      + 'Trim any you like, then "Finish all".', ready ? 'success' : 'error');
  },

  /**
   * The last song's state can come in just after the download task's answer
   * (they travel separately): a moment's wait for it, so a song that got
   * there is not counted as cancelled.
   */
  async _lateStates(items, run) {
    const open = () => items.some((it) => !it.existingId && (!it.state || it.state === 'current'));
    for (let n = 0; n < 10 && run === this.run && open(); n += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  },

  /** True once a song of this import has been saved. */
  _saved() {
    return !!(this.job && this.job.saves);
  },

  /** One song as importer.finish takes it, with its place in the source. */
  _entryOf(it) {
    const meta = it.meta && it.meta.title ? it.meta : { artist: '', title: it.song.title, mix: '' };
    return {
      position: it.index,
      cachePath: it.media.path,
      start: it.trim ? it.trim.start : 0,
      end: it.trim ? it.trim.end : it.media.duration,
      duration: it.media.duration,
      meta,
      sourceUrl: it.song.url,
      sourceKey: it.song.key,
      originalPath: it.song.originalPath || '',
    };
  },

  /**
   * The library songs ticked to go along, not added yet. They need no
   * saving: they go into the playlist with the first song that is saved
   * (or with "Finish all"), at their own places.
   */
  _existingEntries() {
    return this.included.filter((it) => it.existingId && !it.added)
      .map((it) => ({ existingId: it.existingId, position: it.index }));
  },

  /** The job for one save. The first fixes the time and the playlist; later ones add to them. */
  _jobFor(entries) {
    const job = this.job;
    if (!job.base) job.base = Date.now();
    const taken = job.playlistId ? null : this._takenPlaylist();
    return {
      source: job.source,
      local: !!job.local,
      name: job.totals.name || this._finalName(),
      playlist: job.playlistId ? true : (job.saves ? false : this._makesPlaylist()),
      mergeInto: job.playlistId || (taken && this.merge ? taken.id : null),
      playlistIds: this.playlistIds.filter((id) => Store.playlist(id)),
      base: job.base,
      move: !!job.local && this.moveOriginals,
      entries,
    };
  },

  /** Adds one save's summary to the job's totals. */
  _record(summary, entries) {
    const job = this.job;
    const t = job.totals;
    job.saves += 1;
    this.editingName = false;
    if (summary.playlistId) job.playlistId = summary.playlistId;
    t.playlistId = job.playlistId;
    if (summary.name) t.name = summary.name;
    t.saved += summary.saved;
    t.fromLibrary += summary.fromLibrary;
    t.failed.push(...summary.failed);
    t.kept.push(...(summary.kept || []));
    for (const e of entries) {
      if (!e.existingId) continue;
      const it = this.included.find((x) => x.existingId === e.existingId);
      if (it) it.added = true;
    }
  },

  /**
   * "Finish this song": keeps the open frame's edits and saves just that
   * song, into the playlist (made now if this is the first). Saves wait for
   * each other, so the first one's playlist is there for the next.
   */
  finishOne(index) {
    const it = this.included.find((x) => x.index === index);
    if (!it || it.state !== 'ready' || this.state === 'saving') return Promise.resolve();
    if (this.openIndex === index) this._closeEditor(true);
    it.state = 'saving';
    this._redrawFrame(it, false);
    this._drawFooter();
    this._chain = (this._chain || Promise.resolve()).then(() => this._finishOneNow(it));
    return this._chain;
  },

  async _finishOneNow(it) {
    const job = this.job;
    if (!job) return;
    if (this.server) {
      await this._finishOnServer(it);
      return;
    }
    const entries = [this._entryOf(it), ...this._existingEntries()];
    const title = Util.songLine(entries[0].meta);
    let summary;
    try {
      summary = await window.flow.finishImport(this._jobFor(entries), this.run);
    } catch (err) {
      summary = null;
      toast(`"${title}" could not be saved: ${err.message}`, 'error');
    }
    // Cancelled meanwhile: what was saved stays saved.
    if (this.job !== job) return;
    if (summary) this._record(summary, entries);
    const ok = summary && summary.saved;
    it.state = ok ? 'saved' : 'ready';
    // A saved song just leaves the list (the footer counts it); only trouble gets a toast.
    if (summary && !ok) toast(`"${title}" could not be saved: ${(summary.failed[0] || {}).reason || 'failed'}`, 'error');
    this._setPending();
    this._drawName();
    this._drawWarnings();
    this._redrawFrame(it, false);
    this._drawFooter();
    this._drawBadge();
    this._endIfDone();
  },

  /**
   * Ends the import once every song is saved (or failed): no song is ready,
   * downloading or being saved, and something was saved. True when it did.
   */
  _endIfDone() {
    if (this.state !== 'trimming' || !this._saved()) return false;
    if (this.included.some((it) => it.state === 'ready' || it.state === 'saving')) return false;
    if (this._existingEntries().length) return false;
    this._toastSummary(this.job.totals, !!this.job.local, !!this.job.local && this.moveOriginals);
    $('progressPanel').hidden = true;
    this._reset();
    return true;
  },

  /**
   * "Finish all": saves every downloaded song with its cut into the playlist,
   * and ends the import: whatever happens, the panel empties afterwards.
   */
  async finishAll() {
    if (this.state !== 'trimming') return;
    this._closeEditor(true);
    // A song still being saved by "Finish this song" first.
    await this._chain;
    if (this.state !== 'trimming') return;
    if (this.server) {
      await this._finishAllOnServer();
      return;
    }
    const entries = [];
    for (const it of this.included) {
      if (it.existingId && !it.added) entries.push({ existingId: it.existingId, position: it.index });
      else if (it.state === 'ready') entries.push(this._entryOf(it));
    }
    if (!entries.length) {
      this._endIfDone();
      return;
    }
    const local = !!this.job.local;
    const move = local && this.moveOriginals;
    // A name being typed and not applied stays as it was.
    this.editingName = false;
    const job = this._jobFor(entries);
    this._setState('saving');
    AddPage._progress({ title: local ? (move ? 'Moving the files' : 'Copying the files') : `Saving "${job.name}"`,
      frac: 0, status: '', cancel: false });
    let summary;
    try {
      summary = await window.flow.finishImport(job, this._newRun());
    } catch (err) {
      summary = { playlistId: null, name: job.playlist ? job.name : '', saved: 0, fromLibrary: 0, failed: [{ title: '', reason: err.message }], kept: [] };
    }
    try {
      this._record(summary, entries);
      this._toastSummary(this.job.totals, local, move);
    } finally {
      $('progressPanel').hidden = true;
      this._reset();
    }
  },

  _toastSummary(summary, local, move) {
    const parts = [];
    if (summary.saved) parts.push(`${summary.saved} ${local ? (move ? 'moved' : 'copied') : 'saved'}`);
    if (summary.fromLibrary) parts.push(`${summary.fromLibrary} ${local ? 'already in your library' : 'from your library'}`);
    const failedDownloads = this.included.filter((it) => it.state === 'failed').length;
    const failed = summary.failed.length + failedDownloads;
    if (failed) parts.push(`${failed} failed`);
    const kept = (summary.kept || []).length;
    if (kept) parts.push(`${kept} original${kept === 1 ? '' : 's'} could not be removed (in use?)`);
    const kind = summary.saved || summary.fromLibrary ? 'success' : 'error';
    if (local && !summary.playlistId) {
      toast(`Local files added to All Songs: ${parts.join(', ') || 'nothing added'}`, kind);
      return;
    }
    const id = summary.playlistId;
    const head = local ? `Local files added to playlist "${summary.name}"` : `Playlist "${summary.name}" imported`;
    toast(`${head}: ${parts.join(', ') || 'nothing imported'}`, kind,
      id ? { label: 'Open playlist', onClick: () => Store.playlist(id) && Nav.openPlaylist(id) } : null);
  },

  /**
   * Cancel import: ends the whole task at once. Whatever runs is stopped (in
   * the background; the panel does not wait for it), nothing queued starts,
   * and what is in the cache is thrown away.
   */
  async cancelAll() {
    const ready = this._ready().length;
    const local = this.local;
    const saved = this.job ? this.job.totals.saved : 0;
    if (ready || this.state === 'downloading') {
      const originals = local ? ' The original files stay where they are.' : '';
      const kept = saved
        ? ` The ${Util.plural(saved, 'song')} already finished ${saved === 1 ? 'stays' : 'stay'} saved.`
        : ' Nothing of this import is saved.';
      const ok = await confirmDialog({
        title: 'Cancel import?',
        message: (ready
          ? `Throw away the ${saved ? 'remaining ' : ''}${Util.plural(ready, 'song')} ${local ? 'prepared' : 'downloaded'} so far?`
          : 'Stop the import?') + kept + originals,
        confirmLabel: 'Cancel import',
        danger: true,
      });
      if (!ok) return;
    }
    if (this.state === 'idle' || this.state === 'saving') return;
    if (this.server) {
      ServerImport.touch();
      window.flow.serverDownloads('cancel').catch((err) => toast(err.message, 'error'));
      this._closeEditor(false);
      this._reset();
      toast(`Download on the server cancelled${saved ? ` (${Util.plural(saved, 'song')} finished before ${saved === 1 ? 'stays' : 'stay'} saved)` : ''}`, 'info');
      return;
    }
    // The task's number is retired first: anything it still says is ignored.
    this._newRun();
    window.flow.cancelImport().catch(() => {});
    this._closeEditor(false);
    for (const it of this.included) {
      if (it.state === 'ready' && it.media) window.flow.discardDownload(it.media.path).catch(() => {});
    }
    this._reset();
    const keptText = saved ? ` (${Util.plural(saved, 'song')} finished before ${saved === 1 ? 'stays' : 'stay'} saved)` : '';
    toast((local ? 'Import of local files cancelled' : 'Playlist import cancelled') + keptText, 'info');
  },

  // ---- a download on the server ----

  /** Shows the server's batch: started here, on another device, or before a restart. */
  openServer(batch) {
    if (!batch || (this.state !== 'idle' && !this.server)) return;
    const saved = batch.items.some((x) => x.state === 'saved' || x.state === 'added');
    Covers.forgetServerPending();
    this.server = { id: batch.id, single: !!batch.single };
    this.listing = {
      local: false, source: batch.source.kind || 'server', sourceUrl: batch.source.url, name: batch.source.name, truncated: batch.truncated, items: [],
    };
    this.included = [];
    this.moveOriginals = false;
    this._resetName(batch.source.name || '');
    this.job = {
      source: { url: batch.source.url, kind: batch.source.kind },
      local: false,
      base: 0,
      playlistId: batch.playlistId || null,
      saves: saved ? 1 : 0,
      totals: { playlistId: batch.playlistId || null, name: '', saved: 0, fromLibrary: 0, failed: [], kept: [] },
    };
    const list = batch.playlistId && Store.playlist(batch.playlistId);
    if (list) {
      this.name = list.name;
      this.job.totals.name = list.name;
    }
    this.syncServer(batch);
  },

  /**
   * The server's batch as it is now (null: gone). Frames follow their songs;
   * a batch finished or cancelled on another device empties the panel.
   */
  syncServer(batch) {
    if (!this.server) {
      if (batch && this.state === 'idle') this.openServer(batch);
      return;
    }
    if (!batch || batch.id !== this.server.id) {
      if (this.state === 'saving') return;
      this._closeEditor(false);
      this._reset();
      toast('The download on the server was finished or cancelled on another device.', 'info');
      if (batch) this.openServer(batch);
      return;
    }
    if (this.state === 'listing' && batch.state === 'ready') {
      this._resetName(batch.source.name);
      Object.assign(this.listing, { name: batch.source.name, source: batch.source.kind, truncated: batch.truncated });
      this.server.single = !!batch.single;
    }
    const changed = [];
    for (const x of batch.items) {
      const old = this.included.find((i) => i.index === x.index);
      const before = old ? `${old.state}|${old.note}|${old.existingId}|${old.added}` : '';
      const it = this._serverItem(x, old);
      if (!old) this.included.push(it);
      else if (before !== `${it.state}|${it.note}|${it.existingId}|${it.added}`) changed.push(it);
      if (x.state === 'saved' || x.state === 'added') this.job.saves = Math.max(this.job.saves, 1);
    }
    if (batch.playlistId) this.job.playlistId = batch.playlistId;
    if (this._applyServerState(batch)) return;
    for (const it of changed) this._redrawFrame(it, false);
    this._drawFailSummary();
    this._drawName();
    this._drawFooter();
    this._drawBadge();
  },

  /** One song of the batch as a frame's item (`old`: the frame's, kept with its edits). */
  _serverItem(x, old) {
    const it = old || {
      index: x.index, title: x.title, duration: x.duration, url: x.url, path: '', meta: null, existingId: null, state: null,
    };
    it.title = x.title;
    it.duration = x.duration || it.duration;
    it.reason = x.error || '';
    // Its cover, once the server found one (the frame's box fills in by itself).
    it.coverKey = `server:${x.index}`;
    if (x.cover && x.state === 'ready') Covers.serverPending(x.index, x.cover);
    const doing = x.state === 'converting' ? 'converting' : 'downloading';
    it.note = `${doing} on the server${x.progress && x.progress.text ? `: ${x.progress.text}` : '...'}`;
    const states = {
      queued: null, downloading: 'current', converting: 'current', ready: 'ready', failed: 'failed',
      saving: 'saving', saved: 'saved', discarded: 'discarded', library: null, added: null,
    };
    // Being saved from here: the server may not have heard yet.
    if (!(it.state === 'saving' && x.state === 'ready')) it.state = states[x.state] === undefined ? null : states[x.state];
    if (x.state === 'library' || x.state === 'added') {
      it.existingId = x.existing ? x.existing.id : null;
      it.added = x.state === 'added';
    }
    if (x.state === 'ready' && !it.media) {
      const index = x.index;
      it.media = {
        path: '',
        duration: x.duration,
        summary: x.summary,
        src: () => this._serverAudio(index),
        peaks: () => window.flow.serverDownloads('peaks', { index }),
      };
      it.song = { title: x.title, url: x.url, key: '' };
      it.meta = x.meta && x.meta.title ? { ...x.meta } : { artist: '', title: x.title, mix: '' };
      it.artistFromChannel = !!x.artistFromChannel;
    }
    return it;
  },

  /** The prepared song on the server, for the preview (an <audio> sends no headers: ?t=). */
  _serverAudio(index) {
    const st = Store.server;
    return `${st.base}/api/downloads/items/${index}/audio${st.token ? `?t=${encodeURIComponent(st.token)}` : ''}`;
  },

  /**
   * The panel's state from the batch's: reading the link, songs still
   * coming, or all there. True when it ended the panel (nothing to do).
   */
  _applyServerState(batch) {
    if (batch.state === 'failed') {
      // The link could not be read: nothing to keep.
      ServerImport.touch();
      window.flow.serverDownloads('cancel').catch(() => {});
      this._reset();
      $('progTitle').textContent = 'The server could not read the link.';
      AddPage._showError(batch.error || 'The link could not be read.');
      return true;
    }
    if (batch.state === 'listing') {
      if (this.state !== 'listing') this._setState('listing');
      AddPage._progress({
        title: 'Reading the link on the server...',
        frac: batch.progress ? batch.progress.frac : null,
        status: batch.progress && batch.progress.text ? batch.progress.text : batch.source.url,
        busy: true,
      });
      return false;
    }
    const open = ['queued', 'downloading', 'converting'];
    const coming = batch.items.filter((x) => open.includes(x.state));
    const toDo = batch.items.filter((x) => open.includes(x.state) || ['ready', 'saving'].includes(x.state));
    if (!toDo.length && !batch.items.some((x) => x.state === 'saved')) {
      // Nothing to download: every song is in the library already, or failed.
      const failed = batch.items.find((x) => x.state === 'failed');
      ServerImport.touch();
      window.flow.serverDownloads('cancel').catch(() => {});
      this._reset();
      toast(failed ? `Nothing could be downloaded: ${failed.error || 'failed'}` : 'Every song of this link is already in your library.', failed ? 'error' : 'info');
      return true;
    }
    if (this.state === 'saving') return false;
    const want = coming.length ? 'downloading' : 'trimming';
    const all = batch.items.filter((x) => x.state !== 'library' && x.state !== 'added').length;
    const current = batch.items.find((x) => x.state === 'downloading' || x.state === 'converting');
    this.progress = { number: current ? all - coming.length + 1 : all, total: all };
    if (this.state !== want) {
      $('progressPanel').hidden = true;
      this._setState(want);
      if (want === 'trimming' && this._endIfDone()) return true;
    }
    if (current) {
      AddPage._progress({
        title: `Downloading on the server, song ${this.progress.number} of ${all}: ${current.title}`,
        frac: current.progress ? current.progress.frac : null,
        status: current.progress ? current.progress.text : 'Starting...',
        cancel: false,
      });
    } else if (!coming.length) {
      $('progressPanel').hidden = true;
    }
    return false;
  },

  /** "Finish this song" for a song on the server: saved there. */
  async _finishOnServer(it) {
    const job = this.job;
    const existing = this.included.filter((x) => x.existingId && !x.added);
    const meta = it.meta && it.meta.title ? it.meta : { artist: '', title: it.title, mix: '' };
    const wantsList = job.playlistId ? true : (!job.saves && this._makesPlaylist());
    const taken = wantsList && !job.playlistId ? this._takenPlaylist() : null;
    const body = {
      meta,
      start: it.trim ? it.trim.start : 0,
      end: it.trim ? it.trim.end : it.media.duration,
      playlistIds: this.playlistIds.filter((id) => Store.playlist(id)),
      playlist: wantsList ? { name: this._finalName(), mergeInto: job.playlistId || (taken && this.merge ? taken.id : null) } : null,
      existing: existing.map((x) => x.index),
    };
    ServerImport.touch();
    let r;
    try {
      r = await window.flow.serverDownloads('finish', { index: it.index, body });
    } catch (err) {
      toast(`"${Util.songLine(meta)}" could not be saved: ${err.message}`, 'error');
      if (this.job === job) {
        it.state = 'ready';
        this._redrawFrame(it, false);
        this._drawFooter();
      }
      // The batch may be gone (cancelled on another device): the panel follows.
      ServerImport.poll();
      return;
    }
    if (this.job !== job) return;
    this._record({
      playlistId: r.playlistId,
      name: wantsList ? (job.totals.name || this._finalName()) : '',
      saved: 1,
      fromLibrary: existing.length,
      failed: [],
      kept: [],
    }, existing.map((x) => ({ existingId: x.existingId })));
    it.state = 'saved';
    this._drawName();
    this._drawWarnings();
    this._redrawFrame(it, false);
    this._drawFooter();
    this._drawBadge();
    if (this.state === 'saving') return;
    if (r.batch) {
      this.syncServer(r.batch);
    } else {
      // Every song dealt with: the server closed the batch.
      if (this.state !== 'trimming') this._setState('trimming');
      if (!this._endIfDone()) this._reset();
    }
    ServerImport.schedule();
  },

  /** "Finish all" for a download on the server: each song left, one after another. */
  async _finishAllOnServer() {
    const ready = this._ready();
    if (!ready.length) {
      this._endIfDone();
      return;
    }
    this._setState('saving');
    for (let n = 0; n < ready.length && this.job; n += 1) {
      const it = ready[n];
      AddPage._progress({
        title: `Saving song ${n + 1} of ${ready.length}`,
        frac: n / ready.length,
        status: Util.songLine(it.meta && it.meta.title ? it.meta : { title: it.title }),
        cancel: false,
      });
      it.state = 'saving';
      await this._finishOnServer(it);
    }
    if (!this.job) return;
    this._toastSummary(this.job.totals, false, false);
    $('progressPanel').hidden = true;
    ServerImport.touch();
    this._reset();
    ServerImport.poll();
  },

  _onProgress(p) {
    if (p.run !== this.run) return;
    if (p.phase === 'scanning' && this.state === 'listing') {
      AddPage._progress({
        title: 'Looking through the folder...',
        frac: null,
        status: `${Util.plural(p.found, 'file')} found   ${p.dir || ''}`,
      });
    } else if (p.phase === 'listing' && this.state === 'listing') {
      AddPage._progress({ title: 'Reading playlist...', frac: null, status: p.text });
    } else if (p.phase === 'matching' && this.state === 'listing') {
      AddPage._progress({
        title: 'Looking up the songs on YouTube...',
        frac: p.total ? p.done / p.total : null,
        status: `${p.done} of ${p.total}${p.title ? `   ${p.title}` : ''}`,
      });
    } else if (p.phase === 'item' && this.state === 'downloading') {
      const it = this.included.find((x) => x.index === p.index);
      if (!it) return;
      it.state = p.status;
      if (p.reason) it.reason = p.reason;
      if (p.status === 'ready') {
        it.media = p.media;
        it.song = p.song;
        it.meta = p.song.meta && p.song.meta.title ? { ...p.song.meta } : { artist: '', title: p.song.title, mix: '' };
        it.artistFromChannel = p.song.artistFromChannel;
        this._setPending();
      }
      if (p.status === 'library') {
        it.existingId = p.existingId;
        it.state = null;
      }
      this._dirty.add(it);
      this._scheduleDraw();
    } else if (p.phase === 'download' && this.state === 'downloading') {
      this.progress = { number: p.number, total: p.total };
      this._lastProgress = {
        title: `${this.local ? 'Preparing file' : 'Downloading song'} ${p.number} of ${p.total}: ${p.title}`,
        frac: p.frac,
        status: p.text,
      };
      this._scheduleDraw();
    } else if (p.phase === 'saving' && this.state === 'saving') {
      AddPage._progress({
        title: `Saving song ${p.number} of ${p.total}`,
        frac: p.total ? (p.number - 1) / p.total : null,
        status: p.title,
        cancel: false,
      });
    }
  },

  /** Redraws one frame, unless it is the open one (its editor stays put). */
  _redrawFrame(it, scroll) {
    if (this.openIndex === it.index) return;
    const node = $('importList').querySelector(`[data-index="${it.index}"]`);
    if (!node) return;
    const fresh = this._frame(it);
    node.replaceWith(fresh);
    if (scroll && this.openIndex === null) fresh.scrollIntoView({ block: 'nearest' });
  },
};
