'use strict';

// An import on Add Songs (ImportBatch, pages/import.js): how one is opened, from a list's or a song's link, files of this computer, or picks of a search.

extend(ImportBatch, {
  // ---- opening ----

  /**
   * Reads a playlist link and shows its checklist. Resolves the probed song
   * when the link turned out to be one song (the batch is gone then), else null.
   */
  async open(url) {
    const run = this._newRun();
    this._title = url;
    this._setState('listing');
    this._progress({ title: T('import.progress.readingPlaylist'), frac: null, status: url });
    let listing;
    this._task = true;
    try {
      listing = await window.flow.listImport(url, run);
    } catch (err) {
      if (run !== this.run) return null;
      this._fail(err, T('import.progress.readingPlaylist'));
      return null;
    } finally {
      this._task = false;
    }
    if (run !== this.run) return null;
    if (listing.single) {
      this._end();
      return listing.probed;
    }
    this._review(listing);
    // Auto-completed: Download All, under the name the list has.
    if (this.auto && this.auto.complete && this.state === 'review' && run === this.run) await this.start(true);
    return null;
  },

  /**
   * A playlist's "Update from source" (playlistUpdate.js): the list its check
   * read, as the checklist, without reading it again. Read by the server
   * (`server`): the songs ticked are downloaded there (start).
   */
  openUpdate(p, listing, server) {
    this._newRun();
    this.updating = { id: p.id, name: p.name, url: p.source.url };
    this._review({ ...listing, local: false, search: false, fromServer: !!server });
  },

  /** The checklist of a list read. */
  _review(listing) {
    this.listing = listing;
    // An Update: the songs the playlist has already are no news.
    const target = this._updateTarget();
    const inTarget = new Set(target ? target.entries.map((e) => e.songId) : []);
    for (const it of listing.items) it.inTarget = !!(it.existing && inTarget.has(it.existing.id));
    this.checked = new Set(listing.items.filter((it) => !it.existing && it.status === 'ok').map((it) => it.index));
    this.keepKnown = new Set(listing.items.filter((it) => it.existing && !it.inTarget).map((it) => it.index));
    this._resetName(listing.name);
    this._hideProgress();
    this._setState('review');
  },

  /**
   * A song's link: read (unless `probed` already), checked against the
   * library (the same link or upload, or the same names at the same length:
   * asked, or skipped when auto-completed), downloaded, and its editor opened
   * once it is there. auto.finish saves it as it came, into All Songs.
   */
  async openSong(url, { probed = null } = {}) {
    // Read where it is needed: the boxes switched meanwhile count (followAuto).
    const auto = () => this.auto || { complete: false, finish: false };
    this.single = true;
    this._title = url;
    let warned = false;
    if (!probed) {
      // A link that is plainly the same (the same YouTube video, the same page).
      try {
        const dup = await window.flow.findBySource(url, null);
        if (dup) {
          if (auto().complete || !await AddPage._confirmDuplicateSource(dup)) {
            if (auto().complete) toast(T('add.queue.skipped', { song: Util.songLine(dup) }), 'info');
            this._end();
            return;
          }
          warned = true;
        }
      } catch {
        // Checking is a courtesy; carry on without it.
      }
      this._setState('listing');
      this._progress({ title: T('common.readingLink'), frac: null, status: url });
      this._singleTask = true;
      try {
        probed = await window.flow.probe(url);
      } catch (err) {
        this._singleTask = false;
        this._fail(err, T('common.readingLink'));
        return;
      }
      this._singleTask = false;
      if (this.ended) return;
    }
    // The same upload under another link (youtu.be vs youtube.com/shorts), or
    // the same song from another upload: its names at the same length.
    const checks = [];
    if (!warned && probed.key) checks.push(() => window.flow.findBySource(null, probed.key).then((dup) => dup && { dup, text: 'add.known.link' }));
    if (!warned && probed.guess && probed.guess.title) {
      checks.push(() => window.flow.findByMeta({ ...probed.guess, duration: probed.duration }).then((dup) => dup && { dup, text: 'add.known.same' }));
    }
    for (const check of checks) {
      let found = null;
      try {
        found = await check();
      } catch {
        // As above.
      }
      if (!found) continue;
      if (auto().complete || !await AddPage._confirmDuplicateSource(found.dup, found.text)) {
        if (auto().complete) toast(T('add.queue.skipped', { song: Util.songLine(found.dup) }), 'info');
        this._end();
        return;
      }
      break;
    }
    if (this.ended) return;

    const site = String(probed.key || '').split(':')[0].toLowerCase() || 'youtube';
    const it = {
      index: 0, title: probed.title, duration: probed.duration, url: probed.url, path: '', meta: null, existingId: null, state: 'current', listUrl: '',
    };
    this.listing = {
      local: false, search: false, single: true, source: site, sourceUrl: probed.url, name: probed.title, truncated: false, items: [it],
    };
    this._resetName(probed.title);
    this.included = [it];
    this.job = this._newJob({ url: '', kind: site });
    this.progress = { number: 1, total: 1 };
    this._setState('downloading');
    this._progress({ title: probed.title, frac: null, status: T('add.progress.startingDownload') });
    let media;
    this._singleTask = true;
    try {
      media = await window.flow.download(probed, AddPage.downloadOptions());
    } catch (err) {
      this._singleTask = false;
      if (!this.ended) this._fail(err, probed.title);
      return;
    }
    this._singleTask = false;
    if (this.ended) {
      window.flow.discardDownload(media.path).catch(() => {});
      return;
    }
    const g = probed.guess || {};
    it.state = 'ready';
    it.media = media;
    it.song = { title: probed.title, url: probed.url, key: probed.key || '' };
    it.meta = {
      artist: g.artist || '', title: g.title || probed.title, mix: g.mix || '', album: g.album || '', genre: g.genre || '', subGenre: g.subGenre || '',
    };
    it.artistFromChannel = !!g.artistFromChannel;
    it.coverKey = media.path;
    this._lookLyrics(it);
    this._lookInfo(it);
    this._hideProgress();
    this._setState('trimming');
    ImportPanel._setPending();
    // Finishing by itself: saved as it came, into All Songs only.
    if (auto().finish) {
      await this.finishAll();
      return;
    }
    // Its editor at once, as a song's link always opened it (unless one is open).
    if (!ImportPanel.editorOwner) this.toggleFrame(0, { scroll: false });
  },

  /**
   * A song downloaded on its own: the album, genre and Info its page did not
   * name, from Apple's and Discogs' search, into those still empty (in the
   * editor's boxes while it is open there).
   */
  async _lookInfo(it) {
    if (!window.flow.lookupInfo || !it.meta) return;
    const m = it.meta;
    if (m.album && m.genre && m.subGenre) return;
    let found;
    try {
      found = await window.flow.lookupInfo({
        artist: m.artist, title: m.title, mix: m.mix, duration: it.media.duration, album: m.album, genre: m.genre, subGenre: m.subGenre,
      });
    } catch {
      return;
    }
    if (this.ended || !found || it.state !== 'ready') return;
    if (this.openIndex === it.index) {
      for (const [key, box] of [['album', 'edAlbum'], ['genre', 'edGenre'], ['subGenre', 'edSubGenre']]) {
        if (found[key] && !$(box).value.trim()) $(box).value = found[key];
      }
      return;
    }
    const meta = { ...it.meta };
    for (const key of ['album', 'genre', 'subGenre']) if (found[key] && !String(meta[key] || '').trim()) meta[key] = found[key];
    it.meta = meta;
    this._redrawFrame(it);
  },

  /**
   * Files and folders picked on the computer: listed, then prepared one after
   * another, each a frame as for a playlist.
   */
  async openLocal(picked) {
    const drive = picked.length === 1 && /^([A-Za-z]:[\\/]?|\/)$/.test(picked[0]) ? picked[0] : '';
    if (drive) {
      const ok = await confirmDialog({
        title: T('import.drive.title'),
        message: T('import.drive.text', { drive }),
        confirmLabel: T('import.drive.confirm'),
      });
      if (!ok) {
        this._end();
        return;
      }
    }
    const run = this._newRun();
    this._title = picked.length === 1 ? picked[0] : '';
    this._setState('listing');
    this._progress({ title: T('import.folder.lookingThrough'), frac: null, status: T('import.progress.starting') });
    let listing;
    this._task = true;
    try {
      listing = await window.flow.listLocal(picked, run);
    } catch (err) {
      if (run !== this.run) return;
      this._fail(err, T('import.folder.lookingThrough'));
      return;
    } finally {
      this._task = false;
    }
    if (run !== this.run) return;
    this._hideProgress();
    this.listing = listing;
    this.moveOriginals = false;
    this._resetName(listing.name);
    await this._run(listing.items, { local: true });
  },

  /**
   * Uploads picked from a search's results, several at once ([{ url, title,
   * duration }]; one alone is downloaded as its link instead): downloaded one
   * after another, each a frame, then saved into All Songs, or into a new
   * playlist named after the search when "Create new Playlist" is ticked.
   */
  async openPicked(name, picks) {
    this.listing = {
      local: false,
      search: true,
      source: 'search',
      sourceUrl: '',
      name,
      truncated: false,
      items: picks.map((r, index) => ({ index, title: r.title, duration: r.duration, url: r.url, meta: null, existing: null })),
    };
    this.moveOriginals = false;
    this._resetName(name);
    await this._run(this.listing.items, { source: { url: '', kind: 'search' } });
  },

  _setMove(on) {
    if (this.state === 'saving') return;
    this.moveOriginals = !!on;
    this._drawFooter();
  },

  _newRun() {
    this.run = ImportPanel.nextRun();
    return this.run;
  },
});
