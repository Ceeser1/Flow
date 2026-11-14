'use strict';

// An import on Add Songs (ImportBatch, pages/import.js): each downloaded song's frame and its editor.

extend(ImportBatch, {
  // ---- the frames ----

  _frame(it) {
    const st = it.existingId ? 'library' : (it.state || 'waiting');
    const open = this.openIndex === it.index;
    const meta = it.meta || {};
    const name = meta.title ? [meta.artist, meta.title].filter(Boolean).join(' - ') + (meta.mix ? ` (${meta.mix})` : '') : it.title;

    let sub = '';
    let subBad = false;
    if (st === 'library') sub = T('import.song.fromLibrary');
    else if (st === 'failed') { sub = it.reason || T('import.song.failed'); subBad = true; }
    else if (st === 'cancelled') { sub = T('import.song.cancelled'); subBad = true; }
    else if (st === 'current') sub = it.note || (this.local ? T('import.song.preparing') : T('import.song.downloading'));
    else if (st === 'saving') sub = T('import.song.saving');
    else if (st === 'waiting') sub = T('import.song.waiting');
    else if (it.trim) {
      sub = T('import.song.trimmed', { start: Util.fmtClock(it.trim.start), end: Util.fmtClock(it.trim.end), length: Util.fmtClock(it.trim.end - it.trim.start), duration: Util.fmtClock(it.media.duration) });
    } else sub = open ? '' : this._wholeOnly() ? T('import.song.tapToRename') : T(Store.uiMode === 'mobile' ? 'import.song.tapToTrimOrRename' : 'import.song.clickToTrimOrRename');

    // What it will be saved with: the album and genre found (or given), or
    // that there are none, and its info when it has some.
    const info = st === 'ready' && it.meta
      ? [it.meta.album ? T('import.song.album', { album: it.meta.album }) : T('import.song.noAlbum'), it.meta.genre ? T('import.song.genre', { genre: it.meta.genre }) : T('import.song.noGenre'),
        it.meta.subGenre && T('import.song.info', { info: it.meta.subGenre })].filter(Boolean).join(' · ')
      : '';
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
      title: clickable ? (open ? T('import.song.close.tooltip') : T('import.song.open.tooltip')) : '',
      onclick: () => this.toggleFrame(it.index),
    },
    h('span.import__state', { html: { ready: Icons.check, library: Icons.check, failed: Icons.x, cancelled: Icons.x }[st] || '' }),
    h('span.import__num', String(it.index + 1)),
    this._cover(it),
    h('span.import__text',
      h('span.import__title-row', h('span.import__title', { title: name }, name), this._lyricsBadge(it, st)),
      sub ? h('span.import__sub' + (subBad ? '.import__sub--bad' : ''), sub) : null,
      info ? h('span.import__sub.import__info', { title: info }, info) : null),
    it.trim ? h('span.import__flag.import__flag--trim', T('import.song.trimmed.flag')) : null,
    retry ? h('button.btn.btn--small.btn--light-green', { type: 'button', onclick: () => this.retryFailed([it.index]) }, T('common.tryAgain')) : null,
    h('span.import__dur', length),
    clickable ? h('span.import__chevron', { html: Icons.chevron }) : null);

    const frame = h('div.import__frame.import__frame--' + st + (open ? '.import__frame--open' : ''),
      { dataset: { index: String(it.index) } }, head);
    // Summed up in one line instead (_drawFailSummary); a saved song is done.
    if ((st === 'failed' && this.local) || st === 'saved' || st === 'discarded') frame.hidden = true;
    if (open) {
      frame.appendChild(h('div.import__frame-body',
        h('div.import__frame-foot',
          h('button.btn.btn--light-grey', { type: 'button', title: T('import.song.cancelEdits.tooltip'), onclick: () => this.cancelEdits() }, T('import.song.cancelEdits')),
          h('button.btn.btn--light-green', { type: 'button', onclick: () => this.apply() }, T('import.song.applyEdits')),
          h('button.btn.btn--primary', { type: 'button', title: T('import.song.finish.tooltip'), onclick: () => this.finishOne(it.index) }, T('import.song.finish')))));
    }
    return frame;
  },

  /** After a downloaded song's title (4.0): whether lyrics were found for it, once looked up. */
  _lyricsBadge(it, st) {
    const l = it.lyrics;
    if (!l || !['ready', 'saving'].includes(st) || !['found', 'none'].includes(l.state)) return null;
    return LyricsEdit.badge(l.state === 'found');
  },

  /** A song just downloaded (or prepared): its lyrics looked up by its names, its frame redrawn when known. */
  _lookLyrics(it) {
    if (!it.lyrics) it.lyrics = AddPage.newLyrics(() => this._redrawFrame(it));
    if (it.lyrics && it.media && it.meta) AddPage.lookLyrics(it.lyrics, it.meta, it.media.duration);
  },

  /** Lyrics written for the song in Add Songs, moved to the song as trimmed; null when none were. */
  _ownLyrics(it) {
    if (!it.lyrics || !it.lyrics.own) return null;
    return LyricsEdit.cut(it.lyrics.own, it.trim ? it.trim.start : 0, it.trim ? it.trim.end : it.media.duration);
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

  /** Opens a song's frame with the editor in it (closing the one open, in whichever batch). */
  toggleFrame(index, { scroll = true } = {}) {
    if (this.openIndex === index) {
      this.apply();
      return;
    }
    ImportPanel.closeEditor(true);
    const it = this.included.find((x) => x.index === index);
    if (!it || it.state !== 'ready' || this.ended) return;
    if (this.collapsed) {
      this.collapsed = false;
      this._drawShell();
      this._drawHead();
    }
    this.openIndex = index;
    ImportPanel.editorOwner = this;
    this._drawList();
    const body = this.p.list.querySelector(`[data-index="${index}"] .import__frame-body`);
    AddPage.openEmbedded(body, {
      media: it.media,
      meta: it.meta,
      title: it.song ? it.song.title : it.title,
      start: it.trim ? it.trim.start : 0,
      end: it.trim ? it.trim.end : it.media.duration,
      artistFromChannel: it.artistFromChannel,
      sourceKey: it.song ? it.song.key : '',
      sourceUrl: it.song ? it.song.url : '',
      lyrics: it.lyrics || null,
    });
    // Opened by hand: the editor in sight. Opened by itself: the page stays where it is.
    if (scroll) body.closest('.import__frame').scrollIntoView({ block: 'nearest' });
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
    if (ImportPanel.editorOwner === this) ImportPanel.editorOwner = null;
    if (!it || !result) return;
    if (keep) {
      if (result.meta.title) it.meta = result.meta;
      const whole = result.start < 0.01 && result.end > it.media.duration - 0.01;
      it.trim = whole ? null : { start: result.start, end: result.end };
    }
    // Looked up while renamed in the editor: by the names it keeps.
    this._lookLyrics(it);
  },
});
