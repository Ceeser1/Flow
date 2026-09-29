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
//              preview, names) with Apply; one frame at a time. "Finish all"
//              at the bottom right saves every song with its cut.
// saving       the songs go into the music folder, All Songs and the playlist.
//              Then the import is over: the panel empties and a toast sums it
//              up (with Open playlist), so nothing is left to click away.
//
// Nothing reaches the library before "Finish all". Closing the app before it
// asks first (main.js), since the downloads are only in the cache.
//
// Local files ("Open local File(s) / Folder") skip listing and review: they
// are prepared into the cache (converted where needed) as the downloading
// step, and "Finish all" saves them into All Songs, with no playlist. The
// footer then has "Copy Files / Move Originals"; moving deletes each original
// once its song is saved.

const SOURCE_NAMES = {
  youtube: 'YouTube', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', spotify: 'Spotify', vimeo: 'Vimeo', local: 'Local files',
};

const ImportPanel = {
  state: 'idle',
  listing: null,
  checked: new Set(),     // indexes of new songs ticked
  keepKnown: new Set(),   // indexes of library songs ticked (added to the list)
  merge: true,            // add to the playlist of the same name, if there is one
  job: null,              // name, mergeInto, source: fixed when downloading starts
  included: [],           // the chosen songs, in order, each with its own state
  openIndex: null,        // the frame whose editor is open
  progress: { number: 0, total: 0 },
  moveOriginals: false,   // local files: move rather than copy them

  /** A list is being read or imported: single-link downloads wait. */
  get busy() {
    return ['listing', 'downloading', 'trimming', 'saving'].includes(this.state);
  },

  /** The songs are files from the computer, not a playlist. */
  get local() {
    return !!(this.listing && this.listing.local);
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
    $('importName').addEventListener('input', () => this._drawWarnings());
    $('importCancelAll').onclick = () => this.cancelAll();
    $('copyMoveSwitch').onclick = () => this._setMove(!this.moveOriginals);
    $('copyMoveCopy').onclick = () => this._setMove(false);
    $('copyMoveMove').onclick = () => this._setMove(true);
    Store.onLibrary(() => {
      if (this.state === 'review') this._drawWarnings();
    });
  },

  /**
   * Reads a playlist link and shows its checklist. Resolves the probed song
   * when the link turned out to be one song, else null.
   */
  async open(url) {
    this._setState('listing');
    AddPage._progress({ title: 'Reading playlist...', frac: null, status: url });
    let listing;
    try {
      listing = await window.flow.listImport(url);
    } catch (err) {
      this._setState('idle');
      AddPage._failed(err);
      return null;
    }
    if (listing.single) {
      this._setState('idle');
      return listing.probed;
    }
    this.listing = listing;
    this.checked = new Set(listing.items.filter((it) => !it.existing && it.status === 'ok').map((it) => it.index));
    this.keepKnown = new Set(listing.items.filter((it) => it.existing).map((it) => it.index));
    this.merge = true;
    $('importName').value = listing.name;
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
    let listing;
    try {
      listing = await window.flow.listLocal(picked);
    } catch (err) {
      AddPage._showError(err.message);
      return;
    }
    this.listing = listing;
    this.moveOriginals = false;
    await this._run(listing.items, { name: listing.name, local: true });
  },

  _setMove(on) {
    if (this.state === 'saving') return;
    this.moveOriginals = !!on;
    this._drawFooter();
  },

  /** Cancel in the progress frame: stops reading or downloading. */
  cancel() {
    window.flow.cancelImport().catch(() => {});
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
    this.moveOriginals = false;
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
    $('importName').disabled = !reviewing;
    $('importName').closest('.import__name').hidden = !reviewing;
    $('downloadBtn').disabled = this.busy;
    $('linkInput').disabled = this.busy;
    AddPage.drawLocalPick();
    this._drawBadge();
    this._drawFooter();
    if (state !== 'idle' && state !== 'listing') this.render();
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
    $('importCancelAll').hidden = !mine;
    $('importFooterText').hidden = !mine;
    $('addToPlaylistBtn').hidden = mine;
    $('addPlaylistNames').hidden = mine;
    this._drawCopyMove(mine && this.local);
    if (!mine) {
      // Back to the single song's footer, shown with its editor.
      $('finishBtn').textContent = 'Finish';
      $('finishBtn').disabled = false;
      $('addFooter').hidden = !(AddPage.phase === 'ready' || AddPage.phase === 'saving');
      return;
    }
    $('addFooter').hidden = false;
    const ready = this._ready().length;
    const trimmed = this.included.filter((it) => it.trim).length;
    const waiting = this.included.filter((it) => !it.existingId && (!it.state || it.state === 'current')).length;
    const parts = [`${Util.plural(ready, 'song')} ready`];
    if (trimmed) parts.push(`${trimmed} trimmed`);
    if (waiting && this.state === 'downloading') parts.push(`${waiting} still ${this.local ? 'preparing' : 'downloading'}`);
    $('importFooterText').textContent = parts.join(' · ');
    $('finishBtn').textContent = this.state === 'saving' ? 'Saving...' : 'Finish all';
    const anything = ready || this.included.some((it) => it.existingId);
    $('finishBtn').disabled = this.state !== 'trimming' || !anything;
    $('finishBtn').title = this.state === 'downloading'
      ? `Available once every song is ${this.local ? 'prepared' : 'downloaded'}` : '';
    $('importCancelAll').disabled = this.state === 'saving';
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

  _setPending() {
    window.flow.setImportPending(this.state === 'idle' ? 0 : this._ready().length).catch(() => {});
  },

  // ---- the checklist ----

  _newItems() {
    return this.listing ? this.listing.items.filter((it) => !it.existing) : [];
  },

  _knownItems() {
    return this.listing ? this.listing.items.filter((it) => it.existing) : [];
  },

  _takenPlaylist() {
    const name = $('importName').value.trim().toLowerCase();
    return name ? Store.library.playlists.find((p) => p.name.toLowerCase() === name) || null : null;
  },

  render() {
    const l = this.listing;
    if (!l) return;
    const kind = String(l.source || '').toLowerCase();
    const source = SOURCE_NAMES[kind] || l.source || 'Playlist';
    const head = clear($('importSource'));
    head.appendChild(h('span.import__badge', source));
    if (this.state === 'review') {
      head.appendChild(h('span', `${Util.plural(l.items.length, 'song')} in this list`));
    } else {
      head.appendChild(h('span.import__heading', this.job ? this.job.name : l.name));
    }
    if (l.truncated === 'spotify') {
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
    if (this.state !== 'review') {
      box.hidden = true;
      return;
    }
    const rows = [];
    const taken = this._takenPlaylist();
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
    const known = this._knownItems();
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
    for (const it of this.included) frag.appendChild(this._frame(it));
    list.appendChild(frag);
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
    else if (st === 'current') sub = this.local ? 'preparing...' : 'downloading...';
    else if (st === 'waiting') sub = 'waiting';
    else if (it.trim) {
      sub = `trimmed ${Util.fmtClock(it.trim.start)} - ${Util.fmtClock(it.trim.end)}, `
        + `${Util.fmtClock(it.trim.end - it.trim.start)} of ${Util.fmtClock(it.media.duration)}`;
    } else sub = open ? '' : 'click to trim or rename';

    const length = st === 'ready'
      ? Util.fmtClock(it.trim ? it.trim.end - it.trim.start : it.media.duration)
      : (it.duration ? Util.fmtClock(it.duration) : '');
    const clickable = st === 'ready' && this.state !== 'saving';

    const head = h('button.import__frame-head', {
      type: 'button',
      disabled: !clickable,
      title: clickable ? (open ? 'Close (keeps the changes)' : 'Trim or rename this song') : '',
      onclick: () => this.toggleFrame(it.index),
    },
    h('span.import__state', { html: { ready: Icons.check, library: Icons.check, failed: Icons.x, cancelled: Icons.x }[st] || '' }),
    h('span.import__num', String(it.index + 1)),
    h('span.import__text',
      h('span.import__title', { title: name }, name),
      sub ? h('span.import__sub' + (subBad ? '.import__sub--bad' : ''), sub) : null),
    it.trim ? h('span.import__flag.import__flag--trim', 'trimmed') : null,
    h('span.import__dur', length),
    clickable ? h('span.import__chevron', { html: Icons.chevron }) : null);

    const frame = h('div.import__frame.import__frame--' + st + (open ? '.import__frame--open' : ''),
      { dataset: { index: String(it.index) } }, head);
    if (open) {
      frame.appendChild(h('div.import__frame-body',
        h('div.import__frame-foot',
          h('button.btn.btn--primary', { type: 'button', onclick: () => this.apply() }, 'Apply'))));
    }
    return frame;
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

  /** Apply: keeps the open frame's cut and names, and closes it. */
  apply() {
    this._closeEditor(true);
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
    const taken = this._takenPlaylist();
    await this._run(chosen, {
      name: $('importName').value.trim() || l.name,
      mergeInto: taken && this.merge ? taken.id : null,
      source: { url: l.sourceUrl, kind: String(l.source || '').toLowerCase() },
    });
  },

  /**
   * Fetches the chosen songs into the cache (downloads, or for local files
   * prepares them), each a frame, then leaves them for trimming.
   */
  async _run(chosen, job) {
    this.job = job;
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
        title: job.local ? `Opening ${Util.plural(toFetch.length, 'file')}` : `Importing "${job.name}"`,
        frac: null,
        status: 'Starting...',
      });
      const items = toFetch.map((it) => ({ index: it.index, title: it.title, url: it.url, path: it.path, meta: it.meta }));
      try {
        if (job.local) await window.flow.prepareLocal(items, AddPage.downloadOptions());
        else await window.flow.downloadImport(items, AddPage.downloadOptions());
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    $('progressPanel').hidden = true;
    // Anything not reached (cancelled) stays out.
    for (const it of this.included) {
      if (!it.existingId && (!it.state || it.state === 'current')) it.state = 'cancelled';
    }
    this._setState('trimming');
    this._setPending();
    const ready = this._ready().length;
    const failed = this.included.filter((it) => it.state === 'failed').length;
    toast(`${Util.plural(ready, 'song')} ${job.local ? 'ready' : 'downloaded'}${failed ? `, ${failed} failed` : ''}. `
      + 'Trim any you like, then "Finish all".', ready ? 'success' : 'error');
  },

  /**
   * "Finish all": saves every downloaded song with its cut into the playlist,
   * and ends the import: whatever happens, the panel empties afterwards.
   */
  async finishAll() {
    if (this.state !== 'trimming') return;
    this._closeEditor(true);
    const entries = [];
    for (const it of this.included) {
      if (it.existingId) {
        entries.push({ existingId: it.existingId });
      } else if (it.state === 'ready') {
        const meta = it.meta && it.meta.title ? it.meta : { artist: '', title: it.song.title, mix: '' };
        entries.push({
          cachePath: it.media.path,
          start: it.trim ? it.trim.start : 0,
          end: it.trim ? it.trim.end : it.media.duration,
          duration: it.media.duration,
          meta,
          sourceUrl: it.song.url,
          sourceKey: it.song.key,
          originalPath: it.song.originalPath || '',
        });
      }
    }
    if (!entries.length) return;
    const local = !!this.job.local;
    const move = local && this.moveOriginals;
    this._setState('saving');
    AddPage._progress({ title: local ? (move ? 'Moving the files' : 'Copying the files') : `Saving "${this.job.name}"`,
      frac: 0, status: '', cancel: false });
    let summary;
    try {
      summary = await window.flow.finishImport({ ...this.job, move, entries });
    } catch (err) {
      summary = { playlistId: null, name: local ? '' : this.job.name, saved: 0, fromLibrary: 0, failed: [{ title: '', reason: err.message }], kept: [] };
    }
    try {
      this._toastSummary(summary, local, move);
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
    if (local) {
      toast(`Local files added to All Songs: ${parts.join(', ') || 'nothing added'}`, kind);
      return;
    }
    const id = summary.playlistId;
    toast(`Playlist "${summary.name}" imported: ${parts.join(', ') || 'nothing imported'}`, kind,
      id ? { label: 'Open playlist', onClick: () => Store.playlist(id) && Nav.openPlaylist(id) } : null);
  },

  /** Cancel import: stops downloading and throws the downloads away. */
  async cancelAll() {
    const ready = this._ready().length;
    const local = this.local;
    if (ready || this.state === 'downloading') {
      const originals = local ? ' The original files stay where they are.' : '';
      const ok = await confirmDialog({
        title: 'Cancel import?',
        message: (ready
          ? `Throw away the ${Util.plural(ready, 'song')} ${local ? 'prepared' : 'downloaded'} so far? Nothing of this import is saved.`
          : 'Stop the import? Nothing of it is saved.') + originals,
        confirmLabel: 'Cancel import',
        danger: true,
      });
      if (!ok) return;
    }
    if (this.state === 'downloading') {
      window.flow.cancelImport().catch(() => {});
      // start() carries on to 'trimming' once the download stops.
      await new Promise((resolve) => {
        const wait = () => (this.state === 'downloading' ? setTimeout(wait, 100) : resolve());
        wait();
      });
    }
    this._closeEditor(false);
    for (const it of this.included) {
      if (it.state === 'ready' && it.media) window.flow.discardDownload(it.media.path).catch(() => {});
    }
    this._reset();
    toast(local ? 'Import of local files cancelled' : 'Playlist import cancelled', 'info');
  },

  _onProgress(p) {
    if (p.phase === 'listing' && this.state === 'listing') {
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
      this._redrawFrame(it, p.status === 'current');
      this._drawFooter();
      this._drawBadge();
    } else if (p.phase === 'download' && this.state === 'downloading') {
      this.progress = { number: p.number, total: p.total };
      this._drawBadge();
      AddPage._progress({
        title: `${this.local ? 'Preparing file' : 'Downloading song'} ${p.number} of ${p.total}: ${p.title}`,
        frac: p.frac,
        status: p.text,
      });
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
