'use strict';

// An import on Add Songs (ImportBatch, pages/import.js): its panel, with its states, progress line, footer, and Cancel and Retry failed.

extend(ImportBatch, {
  /**
   * Cancel in the progress line. While a list, a folder or a song's link is
   * read, that ends the batch at once. While downloading it stops there: what
   * is ready so far stays for trimming.
   */
  cancel() {
    if (this.server) {
      // The server still reading the link: the batch goes.
      ServerImport.touch();
      ServerImport.cancelBatch(this.server.id).catch(() => {});
      this._end();
      toast(T('common.downloadCancelled'), 'info');
      return;
    }
    if (this._singleTask) {
      // Its read or download fails as cancelled, which ends the batch.
      window.flow.cancelDownload().catch(() => {});
      return;
    }
    if (this._task) window.flow.cancelImport().catch(() => {});
    if (this.state !== 'listing') return;
    this._newRun();
    this._end();
    toast(T('common.downloadCancelled'), 'info');
  },

  /** Cancel under the checklist: the batch goes (a server's checklist: there too). */
  close() {
    if (this.state === 'listing' || this.state === 'downloading' || this.state === 'saving') return;
    if (this.server && this.state === 'review') {
      ServerImport.touch();
      ServerImport.cancelBatch(this.server.id).catch((err) => toast(err.message, 'error'));
    }
    this._end();
  },

  /** The batch is over, whatever state it is in: its panel goes. */
  _end() {
    if (this.ended) return;
    const hadFocus = this.el.contains(document.activeElement);
    this._closeEditor(false);
    this.ended = true;
    this.state = 'idle';
    if (this.server) Covers.forgetServerPending(this.server.id);
    this.el.remove();
    ImportPanel.remove(this);
    ImportPanel.changed();
    // Without scrolling up to it: the page stays where it is.
    if (hadFocus) $('linkInput').focus({ preventScroll: true });
  },

  /** Ended by a failure: the error under the link box (a cancel only says so). */
  _fail(err, title = '') {
    this._end();
    if (AddPage.isCancelled(err)) {
      toast(T('common.downloadCancelled'), 'info');
      return;
    }
    AddPage.showFailure(title, err);
  },

  _setState(state) {
    if (this.ended) return;
    const was = this.state;
    this.state = state;
    // Downloaded: folded up to its title, unless opened by hand (or its editor is open).
    if (!this._userFolded) {
      if (state === 'trimming' && was !== 'trimming' && was !== 'saving' && this.openIndex === null) this.collapsed = true;
      else if (ACTIVE_STATES.includes(state)) this.collapsed = false;
    }
    this._drawShell();
    this._drawFooter();
    if (state !== 'idle' && state !== 'listing') this.render();
    else this._drawHead();
    ImportPanel.changed();
  },

  /** What of the panel shows in its state, folded or not, and where on the page it sits. */
  _drawShell() {
    const p = this.p;
    const st = this.state;
    this.el.hidden = st === 'idle';
    this.el.classList.toggle('import-batch--collapsed', this.collapsed);
    const foldable = st !== 'idle' && st !== 'listing';
    p.toggle.hidden = !foldable;
    p.toggle.title = this.collapsed ? T('import.batch.expand') : T('import.batch.collapse');
    p.toggle.setAttribute('aria-label', p.toggle.title);
    p.toggle.setAttribute('aria-expanded', String(!this.collapsed));
    p.body.hidden = this.collapsed || st === 'listing' || st === 'idle';
    p.buttons.hidden = st !== 'review';
    p.toolbar.hidden = st !== 'review';
    ImportPanel.place(this);
  },

  /** A click on the head folds or opens the batch (its buttons and boxes do their own). */
  _headClick(e) {
    const onToggle = this.p.toggle.contains(e.target);
    if (!onToggle && e.target.closest('button, input, label, a, select, textarea')) return;
    if (this.p.toggle.hidden) return;
    this.toggleCollapsed();
  },

  /** Folds or opens the batch. A song alone opens straight into its editor. */
  toggleCollapsed(force) {
    const want = typeof force === 'boolean' ? force : !this.collapsed;
    this._userFolded = true;
    if (want && this.openIndex !== null) this._closeEditor(true);
    this.collapsed = want;
    this._drawShell();
    this._drawHead();
    if (!want && this.oneSong && this.state === 'trimming' && this.openIndex === null) {
      const ready = this._ready()[0];
      if (ready) {
        this.toggleFrame(ready.index);
        return;
      }
    }
    if (!want) this._drawList();
  },

  /** busy: a spinner after the title, for a wait that reports nothing back. */
  _progress({
    title, frac, status, cancel = true, busy = false,
  }) {
    const p = this.p;
    p.progress.hidden = false;
    p.progError.hidden = true;
    p.progTitle.textContent = title || '';
    p.progTitle.classList.toggle('prog-title--busy', busy);
    p.progBar.hidden = false;
    if (frac === null || frac === undefined) p.progBar.removeAttribute('value');
    else p.progBar.value = frac;
    p.progCancel.hidden = !cancel;
    p.progStatus.textContent = status || '';
  },

  _hideProgress() {
    this.p.progress.hidden = true;
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
    if (this.state !== 'downloading' || this.ended) {
      this._dirty.clear();
      this._lastProgress = null;
      return;
    }
    for (const it of this._dirty) this._redrawFrame(it);
    this._dirty.clear();
    this._drawFailSummary();
    this._drawFooter();
    ImportPanel._drawBadge();
    if (this._lastProgress) this._progress(this._lastProgress);
    this._lastProgress = null;
  },

  /** Its footer: Cancel import and "Finish all" while importing. */
  _drawFooter() {
    const p = this.p;
    const mine = this.ownsFooter;
    p.footer.hidden = !mine;
    if (!mine) return;
    this._drawCopyMove(this.local);
    this._drawPlaylistButton();
    p.addToPlaylist.disabled = this.state === 'saving';
    const ready = this._ready().length;
    const trimmed = this.included.filter((it) => it.trim && it.state === 'ready').length;
    // Local files that failed are summed up above the frames instead.
    const failed = this.local ? 0 : this.included.filter((it) => it.state === 'failed').length;
    const r = this.retry && !this.retry.done ? this.retry : null;
    const waiting = this.included.filter((it) => !it.existingId && (!it.state || it.state === 'current')
      && !(r && r.indexes.includes(it.index))).length;
    const saved = this.job ? this.job.totals.saved : 0;
    const parts = [T('import.summary.ready', { songs: Util.plural(ready, 'song') })];
    if (failed) parts.push(T('import.done.failed', { count: failed }));
    if (trimmed) parts.push(T('import.summary.trimmed', { count: trimmed }));
    if (saved) parts.push(T('import.done.saved', { count: saved }));
    if (waiting && this.state === 'downloading') {
      parts.push(T(this.local ? 'import.summary.stillPreparing' : (this.server ? 'import.summary.stillDownloadingOnServer' : 'import.summary.stillDownloading'), { count: waiting }));
    }
    p.footerText.textContent = parts.join(' · ');
    this._drawRetry(failed);
    p.finish.textContent = this.state === 'saving' ? T('common.saving') : T('import.finishAll');
    const anything = ready || this._existingEntries().length;
    p.finish.disabled = this.state !== 'trimming' || !anything;
    p.finish.title = this.state === 'downloading'
      ? T(this.local ? 'import.finishAll.notYet.prepared.tooltip' : 'import.finishAll.notYet.downloaded.tooltip') : '';
    p.cancelAll.disabled = this.state === 'saving';
  },

  /**
   * "Retry failed" while songs failed, or instead of it the turning circle
   * with how far the retry is; after one, how many failed again.
   */
  _drawRetry(failed) {
    this._settleRetry();
    const p = this.p;
    const r = this.retry;
    const busy = !!(r && !r.done);
    const btn = p.retryFailed;
    btn.hidden = busy || !failed || !this._canRetry();
    btn.disabled = this.state === 'saving';
    let line = '';
    if (busy) {
      const mine = this.included.filter((it) => r.indexes.includes(it.index));
      const started = mine.filter((it) => it.existingId || it.state).length;
      line = T('import.progress.retry', { number: Math.min(Math.max(started, 1), mine.length), total: mine.length });
    } else if (r && failed && r.failedAgain) {
      line = T('import.progress.retry.failedAgain', { count: r.failedAgain });
    }
    p.retryText.textContent = line;
    p.retryText.hidden = !line;
    p.retryText.classList.toggle('import-retry--busy', busy);
    p.footer.classList.toggle('add-footer--retry', !btn.hidden || !!line);
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
   * saving, here once the list is through and nothing else downloads here
   * (one import task at a time).
   */
  _canRetry() {
    if (this.local) return false;
    if (this.server) return this.state !== 'saving';
    return this.state === 'trimming' && !this.single && !ImportPanel.clientBusy;
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
      this._redrawFrame(it);
    }
    this._drawFooter();
    if (this.server) {
      const batch = await ServerImport.retry(items.map((it) => it.index), this.server.id);
      if (this.retry !== r || this.ended) return;
      r.sending -= 1;
      if (batch) this.syncServer(batch);
      else ServerImport.poll();
      this._drawFooter();
      ServerImport.schedule();
      return;
    }
    if (!await this._downloadAgain(items, T('import.progress.downloadingAgain', { songs: Util.plural(items.length, 'song') }))) return;
    r.sending -= 1;
    this._setState('trimming');
    ImportPanel._setPending();
  },

  /**
   * Songs of this computer's batch fetched once more (Retry failed, or those
   * cut off by a restart): downloaded again, or for local files prepared
   * again. False when the batch was cancelled meanwhile.
   */
  async _downloadAgain(items, title) {
    const run = this._newRun();
    this.progress = { number: 0, total: items.length };
    this._setState('downloading');
    this._progress({ title, frac: null, status: T('import.progress.starting') });
    this._task = true;
    try {
      const list = items.map((it) => ({ index: it.index, title: it.title, url: it.url, path: this.local ? it.path || '' : '', meta: it.meta }));
      if (this.local) await window.flow.prepareLocal(list, AddPage.downloadOptions(), run);
      else await window.flow.downloadImport(list, AddPage.downloadOptions(), run);
    } catch (err) {
      if (run === this.run) toast(err.message, 'error');
    } finally {
      this._task = false;
    }
    // Cancelled with "Cancel import": that has already ended the batch.
    if (run !== this.run || this.ended) return false;
    await this._lateStates(items, run);
    if (run !== this.run || this.ended) return false;
    this._flush();
    this._hideProgress();
    // Stopped with Cancel: what was not reached can be tried again.
    for (const it of items) {
      if (!it.existingId && (!it.state || it.state === 'current' || it.state === 'cancelled')) {
        it.state = 'failed';
        it.reason = it.reason || T('import.song.cancelled');
      }
    }
    return true;
  },
});
