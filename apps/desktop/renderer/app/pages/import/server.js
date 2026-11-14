'use strict';

// An import on Add Songs (ImportBatch, pages/import.js): a batch the Flow Server downloads, shown and finished from here.

extend(ImportBatch, {
  // ---- a download on the server ----

  /** Shows a batch of the server's: started here, on another device, or before a restart. */
  openServer(batch) {
    const saved = batch.items.some((x) => x.state === 'saved' || x.state === 'added');
    this.server = { id: batch.id, single: !!batch.single };
    this.auto = batch.auto || null;
    this.listing = {
      local: false, search: batch.source.kind === 'search', source: batch.source.kind || 'server', sourceUrl: batch.source.url, name: batch.source.name, truncated: batch.truncated, sourceTotal: batch.sourceTotal || 0, links: batch.links || null, items: [],
    };
    this._title = batch.source.url || '';
    this.included = [];
    this.moveOriginals = false;
    this._resetName(batch.source.name || '');
    this.job = this._newJob({ url: batch.source.url, kind: batch.source.kind });
    this.job.saves = saved ? 1 : 0;
    this.job.playlistId = batch.playlistId || null;
    this.job.totals.playlistId = batch.playlistId || null;
    const list = batch.playlistId && Store.playlist(batch.playlistId);
    if (list) {
      this.name = list.name;
      this.job.totals.name = list.name;
    }
    this.syncServer(batch);
  },

  /** The server's batch as it is now. Frames follow their songs. */
  syncServer(batch) {
    if (this.ended || !batch) return;
    // Read, waiting for its songs to be chosen (4.4.1): its checklist, once.
    if (batch.state === 'review') {
      if (this.state !== 'review' && !this._chosen) this._serverReview(batch);
      return;
    }
    if (this.state === 'listing' && batch.state === 'ready') {
      const keep = this._keptName();
      this._resetName(batch.source.name);
      if (keep) this.name = keep;
      Object.assign(this.listing, {
        name: batch.source.name, source: batch.source.kind, sourceUrl: batch.source.url, truncated: batch.truncated, sourceTotal: batch.sourceTotal || 0, links: batch.links || null,
      });
      this.server.single = !!batch.single;
    }
    const changed = [];
    let added = false;
    for (const x of batch.items) {
      const old = this.included.find((i) => i.index === x.index);
      const before = old ? `${old.state}|${old.note}|${old.existingId}|${old.added}` : '';
      const it = this._serverItem(x, old);
      if (!old) {
        this.included.push(it);
        added = true;
      } else if (before !== `${it.state}|${it.note}|${it.existingId}|${it.added}`) changed.push(it);
      if (x.state === 'saved' || x.state === 'added') this.job.saves = Math.max(this.job.saves, 1);
    }
    if (batch.playlistId) this.job.playlistId = batch.playlistId;
    if (this._applyServerState(batch)) return;
    if (added && this.state !== 'listing') this.render();
    else for (const it of changed) this._redrawFrame(it);
    this._drawFailSummary();
    this._drawName();
    this._drawFooter();
    ImportPanel._drawBadge();
  },

  /** A name given by hand while the list was read: kept over the one the read brings. */
  _keptName() {
    return this.name && this.name !== this._peekName ? this.name : '';
  },

  /**
   * A server's batch read for a choice (review, 4.4.1): its songs as the
   * checklist's, the same as a list read here (Download Selected, Download
   * All, Cancel), with the songs ticked sent back (_chooseOnServer).
   */
  _serverReview(batch) {
    const keep = this._keptName();
    const items = batch.items.map((x) => ({
      index: x.index,
      title: x.title,
      duration: x.duration,
      url: x.url,
      key: '',
      meta: x.meta || null,
      existing: x.state === 'library' && x.existing ? x.existing : null,
      status: x.state === 'failed' ? (x.status && x.status !== 'ok' ? x.status : 'unavailable') : 'ok',
      note: x.error || '',
      match: x.match || null,
    }));
    this.server.single = !!batch.single;
    this.included = [];
    this._review({
      ...this.listing,
      local: false,
      search: false,
      name: batch.source.name,
      source: batch.source.kind,
      sourceUrl: batch.source.url,
      truncated: batch.truncated,
      sourceTotal: batch.sourceTotal || 0,
      links: batch.links || null,
      items,
    });
    if (keep) {
      this.name = keep;
      this._drawHead();
    }
  },

  /** The songs ticked in a server's checklist go there; it downloads them at their turn. */
  async _chooseOnServer(chosen) {
    this._chosen = true;
    let batch;
    try {
      batch = await ServerImport.choose(this.server.id, chosen.map((it) => it.index));
    } catch (err) {
      this._chosen = false;
      toast(err.message, 'error');
      return;
    }
    if (this.ended || !batch) return;
    // Straight on to its frames, keeping the name and ticks of the checklist.
    this.syncServer(batch);
  },

  /**
   * Its batch is no longer on the server: finished or cancelled on another
   * device, or (`finishedThere`) finished by the server itself, whose own
   * message says what it did.
   */
  serverGone(finishedThere) {
    if (this.ended || this.state === 'saving') return;
    this._end();
    if (!finishedThere) toast(T('import.server.endedElsewhere'), 'info');
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
    it.coverKey = Covers.serverKey(x.index, this.server.id);
    if (x.cover && x.state === 'ready') Covers.serverPending(x.index, x.cover, this.server.id);
    const doing = x.state === 'converting' ? 'import.song.convertingOnServer' : 'import.song.downloadingOnServer';
    it.note = x.progress && x.progress.text ? T(`${doing}.progress`, { progress: x.progress.text }) : T(doing);
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
      const batchId = this.server.id;
      it.media = {
        path: '',
        duration: x.duration,
        summary: x.summary,
        src: () => this._serverAudio(index, batchId),
        peaks: () => window.flow.serverDownloads('peaks', { index, batchId }),
      };
      it.song = { title: x.title, url: x.url, key: '' };
      it.meta = x.meta && x.meta.title ? { ...x.meta } : { artist: '', title: x.title, mix: '' };
      this._giveBulk(it);
      it.artistFromChannel = !!x.artistFromChannel;
      this._lookLyrics(it);
    }
    return it;
  },

  /** The prepared song on the server, for the preview (an <audio> sends no headers: ?t=). */
  _serverAudio(index, batchId) {
    const st = Store.server;
    // With the server's queue (4.4) the batch's own, never another one that took its place.
    const of = st.downloadQueue && batchId ? `/${batchId}` : '';
    return `${st.base}/api/downloads${of}/items/${index}/audio${st.token ? `?t=${encodeURIComponent(st.token)}` : ''}`;
  },

  /**
   * The panel's state from the batch's: reading the link, songs still
   * coming, or all there. True when it ended the batch (nothing to do).
   */
  _applyServerState(batch) {
    if (batch.state === 'failed') {
      // The link could not be read: nothing to keep.
      ServerImport.touch();
      ServerImport.cancelBatch(batch.id).catch(() => {});
      this._end();
      AddPage.showFailure(T('import.server.couldNotReadLink'), new Error(batch.error || T('import.server.linkNotRead')));
      return true;
    }
    if (batch.state === 'listing' || batch.state === 'queued') {
      if (this.state !== 'listing') this._setState('listing');
      // Its name and song count from the quick read, while the whole read goes on.
      const peek = batch.peek && !batch.peek.error ? batch.peek : null;
      if (peek && ((peek.name || '') !== this._peekName || (Number(peek.count) || 0) !== this._peekCount)) {
        if (!this._keptName() && peek.name) this.name = peek.name;
        this._peekName = peek.name || '';
        this._peekCount = Number(peek.count) || 0;
        if (this.listing && !this.listing.name) this.listing.name = this._peekName;
        this._drawHead();
      }
      this._progress({
        title: T('import.progress.readingLinkOnServer'),
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
      ServerImport.cancelBatch(batch.id).catch(() => {});
      // An Update: the library's songs its playlist lacks still go into it.
      const target = this._updateTarget();
      if (target) {
        const inList = new Set(target.entries.map((e) => e.songId));
        const missing = [...new Set(this.included.map((it) => it.existingId).filter((id) => id && !inList.has(id)))];
        this._end();
        if (missing.length) {
          window.flow.addSongsToPlaylist(target.id, missing)
            .then(() => toast(T('import.server.playlistUpdated', { playlist: target.name, count: missing.length }), 'success'))
            .catch((err) => toast(err.message, 'error'));
        } else if (failed) toast(T('import.server.nothingDownloaded', { reason: failed.error || T('import.song.failed') }), 'error');
        else toast(T('import.server.upToDate', { playlist: target.name }), 'info');
        return true;
      }
      this._end();
      toast(failed ? T('import.server.nothingDownloaded', { reason: failed.error || T('import.song.failed') }) : T('import.server.allInLibrary'), failed ? 'error' : 'info');
      return true;
    }
    if (this.state === 'saving') return false;
    const want = coming.length ? 'downloading' : 'trimming';
    const all = batch.items.filter((x) => x.state !== 'library' && x.state !== 'added').length;
    const current = batch.items.find((x) => x.state === 'downloading' || x.state === 'converting');
    this.progress = { number: current ? all - coming.length + 1 : all, total: all };
    if (this.state !== want) {
      this._hideProgress();
      this._setState(want);
      if (want === 'trimming' && this._endIfDone()) return true;
    }
    if (current) {
      this._progress({
        title: T('import.progress.downloadingOnServer', { number: this.progress.number, total: all, title: current.title }),
        frac: current.progress ? current.progress.frac : null,
        status: current.progress ? current.progress.text : T('import.progress.starting'),
        cancel: false,
      });
    } else if (!coming.length) {
      this._hideProgress();
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
      r = await window.flow.serverDownloads('finish', { index: it.index, body, batchId: this.server && this.server.id });
    } catch (err) {
      toast(T('import.song.notSaved', { song: Util.songLine(meta), reason: err.message }), 'error');
      if (this.job === job && !this.ended) {
        it.state = 'ready';
        this._redrawFrame(it);
        this._drawFooter();
      }
      // The batch may be gone (cancelled on another device): the panel follows.
      ServerImport.poll();
      return;
    }
    // Lyrics written for it here go to the song the server saved.
    const lines = this._ownLyrics(it);
    if (lines && r.song && r.song.id) {
      window.flow.setLyrics(r.song.id, lines, true)
        .catch((err) => toast(T('import.song.lyricsNotSaved', { song: Util.songLine(meta), reason: err.message }), 'error'));
    }
    if (this.job !== job || this.ended) return;
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
    this._redrawFrame(it);
    this._drawFooter();
    ImportPanel._drawBadge();
    if (this.state === 'saving') return;
    if (r.batch) {
      this.syncServer(r.batch);
    } else {
      // Every song dealt with: the server closed the batch.
      if (this.state !== 'trimming') this._setState('trimming');
      if (!this._endIfDone()) this._end();
      // The next queued batch (and the buttons) follow at once.
      ServerImport.poll();
      return;
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
    for (let n = 0; n < ready.length && this.job && !this.ended; n += 1) {
      const it = ready[n];
      this._progress({
        title: T('import.progress.savingSong', { number: n + 1, total: ready.length }),
        frac: n / ready.length,
        status: Util.songLine(it.meta && it.meta.title ? it.meta : { title: it.title }),
        cancel: false,
      });
      it.state = 'saving';
      await this._finishOnServer(it);
    }
    if (!this.job || this.ended) return;
    this._toastSummary(this.job.totals, false, false);
    ServerImport.touch();
    this._end();
    ServerImport.poll();
  },

  _onProgress(p) {
    if (p.run !== this.run || this.ended) return;
    if (p.phase === 'scanning' && this.state === 'listing') {
      this._progress({
        title: T('import.folder.lookingThrough'),
        frac: null,
        status: T('import.folder.found', { files: Util.plural(p.found, 'file'), folder: p.dir || '' }),
      });
    } else if (p.phase === 'listing' && this.state === 'listing') {
      this._progress({ title: T('import.progress.readingPlaylist'), frac: null, status: p.text });
    } else if (p.phase === 'matching' && this.state === 'listing') {
      this._progress({
        title: T('import.progress.lookingUpSongs'),
        frac: p.total ? p.done / p.total : null,
        status: [T('import.progress.lookingUp.count', { done: p.done, total: p.total }), p.known && T('common.alreadyInLibrary', { count: p.known }), p.title]
          .filter(Boolean).join(' · '),
      });
    } else if (p.phase === 'item' && this.state === 'downloading') {
      const it = this.included.find((x) => x.index === p.index);
      if (!it) return;
      it.state = p.status;
      if (p.reason) it.reason = p.reason;
      it.noAudio = !!p.noAudio;
      if (p.status === 'ready') {
        it.media = p.media;
        it.song = p.song;
        it.meta = p.song.meta && p.song.meta.title ? { ...p.song.meta } : { artist: '', title: p.song.title, mix: '' };
        this._giveBulk(it);
        it.artistFromChannel = p.song.artistFromChannel;
        this._lookLyrics(it);
        ImportPanel._setPending();
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
        title: T(this.local ? 'import.progress.preparingFile' : 'import.progress.downloadingSong', { number: p.number, total: p.total, title: p.title }),
        frac: p.frac,
        status: p.text,
      };
      this._scheduleDraw();
    } else if (p.phase === 'saving' && this.state === 'saving') {
      this._progress({
        title: T('import.progress.savingSong', { number: p.number, total: p.total }),
        frac: p.total ? (p.number - 1) / p.total : null,
        status: p.title,
        cancel: false,
      });
    }
  },

  /** The download of its one song (download:progress). */
  _onSongProgress({ frac, text }) {
    if (this.state !== 'downloading' || this.ended) return;
    const it = this.included[0];
    this._progress({ title: it ? it.title : '', frac, status: text });
  },

  /** Redraws one frame, unless it is the open one (its editor stays put). */
  _redrawFrame(it) {
    if (this.openIndex === it.index || this.ended) return;
    const node = this.p.list.querySelector(`[data-index="${it.index}"]`);
    if (!node) return;
    replaceNode(node, this._frame(it));
  },
});
