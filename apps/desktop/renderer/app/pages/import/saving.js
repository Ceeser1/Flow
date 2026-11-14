'use strict';

// An import on Add Songs (ImportBatch, pages/import.js): downloading the chosen songs, and saving them (Finish, Finish all).

extend(ImportBatch, {
  // ---- importing ----

  async start(everything) {
    if (this.state !== 'review' || !this.listing) return;
    const l = this.listing;
    const chosen = l.items.filter((it) => {
      if (it.existing) return everything || this.keepKnown.has(it.index);
      return it.status === 'ok' && (everything || this.checked.has(it.index));
    });
    if (!chosen.length) return;
    if (this.server) {
      await this._chooseOnServer(chosen);
      return;
    }
    const source = { url: l.sourceUrl, kind: String(l.source || '').toLowerCase() };
    if (l.fromServer) {
      // An Update read by the server: the songs ticked go there as a batch
      // that keeps the link, shown in its frames as any of the server's.
      const updating = this.updating;
      this._end();
      await ServerImport._create({
        items: chosen.map((it) => ({
          url: it.url, title: it.title, duration: it.duration, key: it.key, meta: it.meta, existing: it.existing ? it.existing.id : undefined, listUrl: it.listUrl,
        })),
        name: l.name,
        source,
      }, updating);
      return;
    }
    await this._run(chosen, { source });
  },

  /** A job's start: base, the playlist time, fixed at the first save; playlistId: the playlist that save made; totals: what every save did, for the toast. */
  _newJob(source, extra = {}) {
    return {
      source,
      local: false,
      ...extra,
      base: 0,
      playlistId: null,
      saves: 0,
      totals: { playlistId: null, name: '', saved: 0, fromLibrary: 0, failed: [], kept: [] },
    };
  },

  /**
   * Fetches the chosen songs into the cache (downloads, or for local files
   * prepares them), each a frame, then leaves them for trimming.
   */
  async _run(chosen, job) {
    const run = this._newRun();
    this.job = this._newJob(job.source || null, job);
    this.included = chosen.map((it) => ({
      index: it.index,
      title: it.title,
      duration: it.duration,
      url: it.url,
      path: it.path || '',
      meta: it.meta && it.meta.title ? { ...it.meta } : null,
      existingId: it.existing ? it.existing.id : null,
      // Of several links read as one (listMany): the one it was found in.
      listUrl: typeof it.listUrl === 'string' ? it.listUrl : undefined,
      state: null,
    }));
    const toFetch = this.included.filter((it) => !it.existingId);
    this.progress = { number: 0, total: toFetch.length };
    this._setState('downloading');
    if (toFetch.length) {
      this._progress({
        title: job.local ? T('import.progress.openingFiles', { files: Util.plural(toFetch.length, 'file') })
          : (this.picked ? T('import.progress.downloadingSongs', { songs: Util.plural(toFetch.length, 'song') }) : T('import.progress.importing', { playlist: this._finalName() })),
        frac: null,
        status: T('import.progress.starting'),
      });
      const items = toFetch.map((it) => ({ index: it.index, title: it.title, url: it.url, path: it.path, meta: it.meta }));
      this._task = true;
      try {
        if (job.local) await window.flow.prepareLocal(items, AddPage.downloadOptions(), run);
        else await window.flow.downloadImport(items, AddPage.downloadOptions(), run);
      } catch (err) {
        if (run === this.run) toast(err.message, 'error');
      } finally {
        this._task = false;
      }
    }
    // Cancelled with "Cancel import": that has already ended the batch.
    if (run !== this.run || this.ended) return;
    await this._lateStates(toFetch, run);
    if (run !== this.run || this.ended) return;
    this._flush();
    this._hideProgress();
    // Anything not reached (cancelled) stays out.
    for (const it of this.included) {
      if (!it.existingId && (!it.state || it.state === 'current')) it.state = 'cancelled';
    }
    this._setState('trimming');
    ImportPanel._setPending();
    // Every song was finished one by one while the rest downloaded.
    if (this._endIfDone()) return;
    // Finishing by itself: every song saved as it came; nothing to save (all failed) ends it too.
    if (this.auto && this.auto.finish) {
      await this.finishAll();
      if (!this.ended && this.state === 'trimming') {
        const failed = this.included.filter((it) => it.state === 'failed').length;
        if (failed) toast(T('serverImport.done.failed', { count: failed }), 'error');
        this._end();
      }
      return;
    }
    const ready = this._ready().length;
    const failed = this.included.filter((it) => it.state === 'failed').length;
    const finish = this._wholeOnly() ? 'import.summary.namesOnlyToFinish' : job.local ? 'import.summary.readyToFinish' : 'import.summary.downloadedToFinish';
    toast(T(failed ? `${finish}.withFailed` : finish, { songs: Util.plural(ready, 'song'), failed }), ready ? 'success' : 'error');
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

  /** Local files where they cannot be cut (the phone): saved whole, only their names change. */
  _wholeOnly() {
    return this.local && !Store.can('localTrim');
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
      ...(typeof it.listUrl === 'string' ? { sourcePlaylistUrl: it.listUrl } : {}),
      originalPath: it.song.originalPath || '',
      lyrics: this._ownLyrics(it),
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
   * A song of its own whose names are a library song's: saved only once that
   * is confirmed (not asked when auto-completed). False when it is not to be saved.
   */
  async _confirmNames(it) {
    if (!this.single || (this.auto && this.auto.complete)) return true;
    const meta = it.meta && it.meta.title ? it.meta : null;
    if (!meta) return true;
    try {
      const dup = await window.flow.findByMeta(meta);
      if (!dup) return true;
      return !!await confirmDialog({
        title: T('add.known.title'),
        message: T('add.known.save', { song: Util.songLine(dup) }),
        confirmLabel: T('add.known.save.confirm'),
      });
    } catch {
      // Checking is a courtesy.
      return true;
    }
  },

  /**
   * "Finish this song": keeps the open frame's edits and saves just that
   * song, into the playlist (made now if this is the first). Saves wait for
   * each other, so the first one's playlist is there for the next.
   */
  async finishOne(index) {
    const it = this.included.find((x) => x.index === index);
    if (!it || it.state !== 'ready' || this.state === 'saving') return;
    if (this.openIndex === index) this._closeEditor(true);
    if (!await this._confirmNames(it)) {
      this._drawList();
      return;
    }
    if (it.state !== 'ready' || this.ended) return;
    it.state = 'saving';
    this._drawList();
    this._drawFooter();
    this._chain = (this._chain || Promise.resolve()).then(() => this._finishOneNow(it));
    await this._chain;
  },

  async _finishOneNow(it) {
    const job = this.job;
    if (!job || this.ended) return;
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
      toast(T('import.song.notSaved', { song: title, reason: err.message }), 'error');
    }
    // Cancelled meanwhile: what was saved stays saved.
    if (this.job !== job || this.ended) return;
    if (summary) this._record(summary, entries);
    const ok = summary && summary.saved;
    it.state = ok ? 'saved' : 'ready';
    // A saved song just leaves the list (the footer counts it); only trouble gets a toast.
    if (summary && !ok) toast(T('import.song.notSaved', { song: title, reason: (summary.failed[0] || {}).reason || T('import.song.failed') }), 'error');
    ImportPanel._setPending();
    this._drawName();
    this._drawWarnings();
    this._redrawFrame(it);
    this._drawFooter();
    ImportPanel._drawBadge();
    this._endIfDone();
  },

  /**
   * Ends the batch once every song is saved (or failed): no song is ready,
   * downloading or being saved, and something was saved. True when it did.
   */
  _endIfDone() {
    if (this.state !== 'trimming' || !this._saved()) return false;
    if (this.included.some((it) => it.state === 'ready' || it.state === 'saving')) return false;
    if (this._existingEntries().length) return false;
    this._toastSummary(this.job.totals, !!this.job.local, !!this.job.local && this.moveOriginals);
    this._end();
    return true;
  },

  /**
   * "Finish all": saves every downloaded song with its cut into the playlist,
   * and ends the batch: whatever happens, its panel goes afterwards.
   */
  async finishAll() {
    if (this.state !== 'trimming') return;
    this._closeEditor(true);
    // A song still being saved by "Finish this song" first.
    await this._chain;
    if (this.state !== 'trimming' || this.ended) return;
    if (this.server) {
      await this._finishAllOnServer();
      return;
    }
    if (this.single) {
      const it = this._ready()[0];
      if (it && !await this._confirmNames(it)) {
        this._drawList();
        return;
      }
      if (this.state !== 'trimming' || this.ended) return;
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
    this._progress({
      title: local ? (move ? T('import.progress.movingFiles') : T('import.progress.copyingFiles')) : (job.playlist ? T('import.progress.saving', { playlist: job.name }) : T('common.saving')),
      frac: 0,
      status: '',
      cancel: false,
    });
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
      this._end();
    }
  },

  _toastSummary(summary, local, move) {
    // One song of its own saved into All Songs: by its name, as a song's link always said.
    if (this.single && !summary.playlistId && summary.saved === 1 && !summary.failed.length) {
      const it = this.included[0];
      toast(T('add.saved', { song: Util.songLine(it && it.meta && it.meta.title ? it.meta : { title: this._finalName() }) }), 'success');
      return;
    }
    const parts = [];
    if (summary.saved) parts.push(T(local ? (move ? 'import.done.moved' : 'import.done.copied') : 'import.done.saved', { count: summary.saved }));
    if (summary.fromLibrary) parts.push(T(local ? 'common.alreadyInLibrary' : 'import.done.fromLibrary', { count: summary.fromLibrary }));
    const failedDownloads = this.included.filter((it) => it.state === 'failed').length;
    const failed = summary.failed.length + failedDownloads;
    if (failed) parts.push(T('import.done.failed', { count: failed }));
    const kept = (summary.kept || []).length;
    if (kept) parts.push(T('import.done.originalsKept', { count: kept }));
    const kind = summary.saved || summary.fromLibrary ? 'success' : 'error';
    if (!summary.playlistId && (local || this.optionalList || !this.keepList)) {
      const key = local ? 'import.done.localFilesAdded' : (summary.saved === 1 ? 'import.done.addedToAllSongs.song' : 'import.done.addedToAllSongs.songs');
      toast(T(key, { result: parts.join(', ') || T('import.done.nothingAdded') }), kind);
      return;
    }
    const id = summary.playlistId;
    const update = !!this.updating && id === this.updating.id;
    const key = local ? 'import.done.localFilesAddedToPlaylist' : update ? 'import.done.playlistUpdated' : 'import.done.playlistImported';
    toast(T(key, { playlist: summary.name, result: parts.join(', ') || (update ? T('import.done.nothingNew') : T('import.done.nothingImported')) }), kind,
      id ? { label: T('import.done.openPlaylist'), onClick: () => Store.playlist(id) && Nav.openPlaylist(id) } : null);
  },

  /**
   * Cancel import: ends the whole batch at once. Whatever runs for it is
   * stopped (in the background; the panel does not wait for it), nothing
   * of it starts any more, and what is in the cache is thrown away.
   */
  async cancelAll() {
    const ready = this._ready().length;
    const local = this.local;
    const picked = this.picked;
    const saved = this.job ? this.job.totals.saved : 0;
    if (ready || this.state === 'downloading') {
      const originals = local ? ` ${T('import.cancel.originalsStay')}` : '';
      const kept = saved
        ? ` ${T('import.cancel.finishedStays', { songs: Util.plural(saved, 'song'), count: saved })}`
        : ` ${T('import.cancel.nothingSaved')}`;
      const ok = await confirmDialog({
        title: T('common.cancelImport.title'),
        message: this.single && ready ? T('add.cancel.text') : (ready
          ? T(`import.cancel.text${saved ? (local ? '.remainingPrepared' : '.remaining') : (local ? '.prepared' : '')}`, { songs: Util.plural(ready, 'song') })
          : T('import.cancel.text.stop')) + kept + originals,
        confirmLabel: T('common.cancelImport'),
        danger: true,
      });
      if (!ok) return;
    }
    if (this.ended || this.state === 'idle' || this.state === 'saving') return;
    if (this.server) {
      ServerImport.touch();
      ServerImport.cancelBatch(this.server.id).catch((err) => toast(err.message, 'error'));
      this._end();
      toast(saved ? T('import.server.cancelled.finishedStays', { songs: Util.plural(saved, 'song'), count: saved }) : T('import.server.cancelled'), 'info');
      return;
    }
    // The task's number is retired first: anything it still says is ignored.
    this._newRun();
    if (this._task) window.flow.cancelImport().catch(() => {});
    if (this._singleTask) window.flow.cancelDownload().catch(() => {});
    this._closeEditor(false);
    for (const it of this.included) {
      if (it.state === 'ready' && it.media) window.flow.discardDownload(it.media.path).catch(() => {});
    }
    const single = this.single;
    this._end();
    if (single) {
      toast(T('add.cancel.done'), 'info');
      return;
    }
    const message = local ? T('import.cancelled.localFiles') : (picked ? T('common.downloadCancelled') : T('import.cancelled.playlist'));
    toast(saved ? T('import.cancelled.finishedStays', { message, songs: Util.plural(saved, 'song'), count: saved }) : message, 'info');
  },
});
