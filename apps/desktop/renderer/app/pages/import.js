'use strict';

// Imports on the Add Songs page, one panel per batch (4.4): a playlist (or
// Mix, or Spotify, Deezer or Amazon Music list), a song, uploads picked from
// a search, files from the computer, or a batch the Flow Server downloads.
// Several are on the page at once; ImportPanel (at the end) keeps them, and
// each one (ImportBatch) goes
//
//   listing -> review -> downloading -> trimming -> saving -> (gone)
//
// listing      the list is read (for Spotify, Deezer and Amazon Music: every
//              song looked up on YouTube, else SoundCloud, Bandcamp and the
//              Internet Archive), shown in the batch's progress line, with
//              Cancel. A song's link is read here too.
// review       the checklist. Songs already in the library and a playlist name
//              that is taken are listed as warnings on top, each with a box to
//              untick. Cancel, Download Selected, Download All.
// downloading  one song after another into the cache. Every song is a frame;
//              a downloaded one can be opened right away.
// trimming     downloaded: the batch folds up to its title (its playlist's
//              name with the pencil, how many songs, its link) and moves up
//              the page, above the ones still reading or downloading. Opened,
//              clicking a frame opens the trim editor in it (waveform, cut,
//              preview, names) with Cancel Edits, Apply Edits and "Finish this
//              song"; one frame at a time on the whole page (the editor moves
//              to the frame opened). Each batch has its footer: Cancel import
//              at the left, Add to Playlist and "Finish all" at the right.
// saving       the songs go into the music folder, All Songs and the playlist.
//              Then the batch is over: its panel goes and a toast sums it up
//              (with Open playlist), so nothing is left to click away.
//
// One import task runs on this computer at a time (main.js: reading a list,
// downloading or preparing its songs); the Client queue (clientQueue.js)
// hands out the turns, and a batch waiting for "Finish all" holds no one up.
// Saving needs no turn.
//
// "Finish this song" saves one song at once, even while others still
// download; it leaves the list, and the first one saved makes the playlist.
// Every song goes into the playlist at its place in the source (job.base,
// see importer.finish), whatever order they are saved in. Once the last song
// is saved the batch ends by itself. Nothing else reaches the library before
// it is finished; closing the app before that asks first (main.js), since the
// downloads are only in the cache.
//
// A song's link is a batch of one song (openSong): read and downloaded as
// before, it opens its editor when it is there (unless one is open already),
// and is saved into All Songs, or into a new playlist with "Create new
// Playlist" ticked.
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
// the same frames (`server`), one panel per batch of the profile's: its songs
// download there, and are trimmed here with the waveform and the preview from
// the server; "Finish this song" and "Finish all" save them there, Cancel
// import throws the batch away there. It outlives the app, so closing asks
// nothing. Batches still waiting for their turn are lines of the Server queue
// instead (queuePanels.js).
//
// A song that failed to download has "Try again" in its frame; "Retry failed"
// in the footer tries every failed one again, one after another, and the
// footer says how far that is and how many failed again. Here that waits
// until nothing else downloads; on the server it can be asked any time.
//
// "Cancel import" ends the whole batch at once, whatever step it is in. Every
// task has a number (`run`, counted for the whole page) that its progress
// messages carry; a cancelled task's number is retired, so whatever it still
// says is ignored.

const SOURCE_NAMES = {
  search: T('common.search'), youtube: 'YouTube', soundcloud: 'SoundCloud', bandcamp: 'Bandcamp', spotify: 'Spotify', deezer: 'Deezer', 'amazon music': 'Amazon Music', vimeo: 'Vimeo', local: T('common.localFiles'),
};

// The box above the frames: each field's name and the editor's box for it.
const BULK = {
  album: { label: T('common.album'), box: 'edAlbum' },
  genre: { label: T('common.genre'), box: 'edGenre' },
  subGenre: { label: T('common.info'), box: 'edSubGenre' },
};

// A batch in these states sits at the bottom of the page, under the finished ones.
const ACTIVE_STATES = ['listing', 'review', 'downloading'];

const ImportBatch = {
  _init(n) {
    Object.assign(this, {
      n,
      state: 'idle',
      listing: null,
      checked: new Set(),     // indexes of new songs ticked
      keepKnown: new Set(),   // indexes of library songs ticked (added to the list)
      merge: true,            // add to the playlist of the same name, if there is one
      job: null,              // source, local: fixed when downloading starts
      name: '',               // the playlist's name, editable until the songs are saved
      createList: false,      // local files, picked uploads, one song: make a playlist of them ("Create new Playlist")
      keepList: true,         // a playlist's songs: make the playlist ("Create new Playlist"); unticked they only go to All Songs
      playlistIds: [],        // existing playlists every song joins ("Add to Playlist")
      auto: null,             // a queued link's { complete, finish } (4.4): Download All and Finish all by themselves
      single: false,          // a song's link downloaded here (openSong)
      editingName: false,
      _nameDraft: '',
      _nameHint: '',
      _title: '',             // what the head says before the list is read
      included: [],           // the chosen songs, in order, each with its own state
      openIndex: null,        // the frame whose editor is open
      progress: { number: 0, total: 0 },
      moveOriginals: false,   // local files: move rather than copy them
      run: 0,                 // the number of the task now running (see above)
      collapsed: false,       // folded up to its title (finished batches are, at first)
      _userFolded: false,     // folded or opened by hand: left as it is
      _task: false,           // this computer's import task runs for it
      _singleTask: false,     // its one song is read or downloaded (download:probe, download:start)
      ended: false,
      _dirty: new Set(),      // frames to redraw at the next animation frame
      _lastProgress: null,    // the latest progress line, drawn with them
      _flushQueued: false,
      _chain: null,           // the "Finish this song" saves, one after another
      server: null,           // a download on the server: { id, single } of its batch
      _peekName: '',          // a server's batch being read: the name and song count its quick read gave
      _peekCount: 0,
      _chosen: false,         // a server's checklist sent (4.4.1): its review is over
      retry: null,            // failed songs tried again: { indexes, sending, done, failedAgain }
      bulkInfo: { album: '', genre: '', subGenre: '' }, // given to every new song without one (_drawBulk)
      updating: null,         // a playlist's Update (playlistUpdate.js): { id, name, url } of the playlist the songs go into
      _bulkEl: null,
      _nameEl: null,
      _failSummaryEl: null,
    });
    this._build();
  },

  /** Its panel: head, progress line, checklist or frames, and its own footer. */
  _build() {
    const p = {};
    const part = (spec, name, props, ...kids) => {
      p[name] = h(spec, props, ...kids);
      return p[name];
    };
    p.toggle = h('button.icon-btn.import-batch__toggle', { type: 'button', html: Icons.chevron });
    this.el = h('div.panel.import.import-batch', { dataset: { batch: String(this.n) }, hidden: true },
      h('div.import__head.import-batch__head', { onclick: (e) => this._headClick(e) },
        p.toggle,
        part('div.import__source', 'source')),
      part('div.progress-panel.import-batch__progress', 'progress', { hidden: true },
        part('div.prog-title', 'progTitle'),
        h('div.progress-row',
          part('progress', 'progBar', { max: 1 }),
          part('button.btn', 'progCancel', { type: 'button', onclick: () => this.cancel() }, T('common.cancel'))),
        part('div.status-label', 'progStatus'),
        part('div.error-hint', 'progError', { hidden: true })),
      part('div.import-batch__body', 'body',
        part('div.import__warnings', 'warnings', { hidden: true }),
        part('div.import__toolbar', 'toolbar', { hidden: true },
          h('button.link-btn', { type: 'button', onclick: () => this._selectAll(true) }, T('window.add.selectAll')),
          h('span.muted-text', '·'),
          h('button.link-btn', { type: 'button', onclick: () => this._selectAll(false) }, T('window.add.selectNone')),
          part('span.import__count', 'count')),
        part('div.import__list', 'list'),
        part('div.import__buttons', 'buttons', { hidden: true },
          h('button.btn.btn--light-red', { type: 'button', onclick: () => this.close() }, T('common.cancel')),
          part('button.btn.btn--light-green', 'selected', { type: 'button', onclick: () => this.start(false) }, T('window.add.downloadSelected')),
          part('button.btn.btn--light-grey', 'everything', { type: 'button', onclick: () => this.start(true) }, T('window.add.downloadAll')))),
      part('div.add-footer.import-batch__footer', 'footer', { hidden: true },
        h('div.add-footer__left',
          part('button.btn.btn--light-red', 'cancelAll', { type: 'button', onclick: () => this.cancelAll() }, T('common.cancelImport')),
          part('span.muted-text', 'footerText'),
          part('button.btn.btn--small.btn--light-green', 'retryFailed', {
            type: 'button', hidden: true, onclick: () => this.retryFailed(this.included.filter((it) => it.state === 'failed').map((it) => it.index)),
          }, T('window.add.import.retryFailed')),
          part('span.muted-text', 'retryText', { hidden: true })),
        h('div.add-footer__center',
          part('div.copy-move', 'copyMove', { hidden: true },
            part('button.copy-move__label', 'copyMoveCopy', { type: 'button', onclick: () => this._setMove(false) }, T('window.add.import.copyFiles')),
            h('span.copy-move__switch-wrap',
              part('button.switch', 'copyMoveSwitch', {
                type: 'button', 'aria-checked': 'false', 'aria-label': T('window.add.import.moveOriginals.ariaLabel'), onclick: () => this._setMove(!this.moveOriginals),
              }),
              part('span.copy-move__tip', 'copyMoveTip')),
            part('button.copy-move__label.copy-move__label--move', 'copyMoveMove', { type: 'button', onclick: () => this._setMove(true) }, T('window.add.import.moveOriginals')))),
        h('div.add-footer__right',
          part('span.muted-text', 'playlistNames'),
          part('button.btn.btn--green', 'addToPlaylist', { type: 'button', onclick: () => this.choosePlaylists() }),
          part('button.btn.btn--primary.btn--big', 'finish', { type: 'button', onclick: () => this.finishAll() }, T('import.finishAll')))));
    p.copyMoveSwitch.setAttribute('role', 'switch');
    p.copyMoveTip.setAttribute('role', 'tooltip');
    this.p = p;
  },

  /** Its checklist is open, or this computer reads or downloads for it: the Client queue waits. */
  get busy() {
    return !this.server && ACTIVE_STATES.includes(this.state);
  },

  /** The songs are files from the computer, not a playlist. */
  get local() {
    return !!(this.listing && this.listing.local);
  },

  /** Uploads picked from a search's results (songSearch.js), not a playlist. */
  get picked() {
    return !!(this.listing && this.listing.search);
  },

  /** One song: a song's link, here or on the server. */
  get oneSong() {
    return this.single || !!(this.server && this.server.single);
  },

  /**
   * The songs make a playlist only when asked to ("Create new Playlist"):
   * local files, uploads picked from a search, and one song.
   */
  get optionalList() {
    return this.local || this.picked || this.oneSong;
  },

  /** Its footer shows Cancel import and "Finish all". */
  get ownsFooter() {
    return this.state === 'downloading' || this.state === 'trimming' || this.state === 'saving';
  },

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
    const run = this._newRun();
    this.progress = { number: 0, total: items.length };
    this._setState('downloading');
    this._progress({ title: T('import.progress.downloadingAgain', { songs: Util.plural(items.length, 'song') }), frac: null, status: T('import.progress.starting') });
    this._task = true;
    try {
      const list = items.map((it) => ({ index: it.index, title: it.title, url: it.url, path: '', meta: it.meta }));
      await window.flow.downloadImport(list, AddPage.downloadOptions(), run);
    } catch (err) {
      if (run === this.run) toast(err.message, 'error');
    } finally {
      this._task = false;
    }
    // Cancelled with "Cancel import": that has already ended the batch.
    if (run !== this.run || this.ended) return;
    await this._lateStates(items, run);
    if (run !== this.run || this.ended) return;
    this._flush();
    this._hideProgress();
    // Stopped with Cancel: what was not reached can be tried again.
    for (const it of items) {
      if (!it.existingId && (!it.state || it.state === 'current' || it.state === 'cancelled')) {
        it.state = 'failed';
        it.reason = it.reason || T('import.song.cancelled');
      }
    }
    r.sending -= 1;
    this._setState('trimming');
    ImportPanel._setPending();
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

  // ---- the checklist ----

  _newItems() {
    return this.listing ? this.listing.items.filter((it) => !it.existing) : [];
  },

  _knownItems() {
    return this.listing ? this.listing.items.filter((it) => it.existing && !it.inTarget) : [];
  },

  /** The playlist an Update goes into, while it exists and the import keeps its name. */
  _updateTarget() {
    const u = this.updating;
    const p = u && Store.playlist(u.id);
    return p && (!this.name || this._finalName() === u.name) ? p : null;
  },

  /** A playlist of the same name, which the songs would be added to (see merge); an Update's own. */
  _takenPlaylist() {
    if (!this._makesPlaylist()) return null;
    const target = this._updateTarget();
    if (target) return target;
    const name = this._finalName().toLowerCase();
    return Store.library.playlists.find((p) => !p.isRuled && !p.favourites && p.name.toLowerCase() === name) || null;
  },

  /**
   * Local files, picked uploads and one song (see optionalList) only make a
   * playlist when "Create new Playlist" is ticked; a playlist's songs unless
   * "Create new Playlist" is unticked (then they only go to All Songs, each
   * still knowing the playlist it came from: sourcePlaylistUrl).
   */
  _makesPlaylist() {
    return this.optionalList ? this.createList : this.keepList;
  },

  _finalName() {
    return this.name.replace(/\s+/g, ' ').trim() || (this.listing ? this.listing.name : '') || T('common.importedPlaylist');
  },

  _resetName(name) {
    // An Update keeps the playlist's own name, whatever its source calls itself now.
    this.name = (this.updating && Store.playlist(this.updating.id) ? this.updating.name : name) || '';
    this.editingName = false;
    this.createList = false;
    this.keepList = true;
    this.playlistIds = [];
    this.merge = true;
  },

  /**
   * The name in the head, changeable until the songs are saved. A playlist's
   * is text with a pencil, which turns it into a box with Apply and Cancel
   * (Enter and Escape do the same). Local files have "Create new Playlist"
   * in front: unticked the name is only the list's label, ticked it is a box
   * with the name the playlist gets. A playlist's has "Create new Playlist" after
   * it (ticked): unticked its songs only go to All Songs. An Update has none:
   * its songs go into the playlist updated.
   */
  _drawName() {
    const box = this._nameEl;
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
      box.appendChild(h('label.check.import__create', tick, h('span', T('import.playlist.createNew'))));
      if (this.createList) {
        const input = h('input.input.import__name-box', {
          type: 'text', maxLength: 75, spellcheck: false, value: this.name, disabled: fixed, 'aria-label': T('import.playlist.name.ariaLabel'),
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
    const keepTick = () => {
      if (this.updating) return [];
      const tick = h('input', { type: 'checkbox', checked: this.keepList, disabled: fixed });
      tick.addEventListener('change', () => {
        this.keepList = tick.checked;
        this._drawWarnings();
      });
      return [h('label.check.import__create', tick, h('span', T('import.playlist.createNew')))];
    };
    if (this.editingName && !fixed) {
      const hint = h('span.import__name-hint', { hidden: !this._nameHint }, this._nameHint);
      const input = h('input.input.import__name-box', {
        type: 'text', maxLength: 75, spellcheck: false, value: this._nameDraft, 'aria-label': T('import.playlist.name.ariaLabel'),
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
        h('button.btn.btn--small.btn--light-green', { type: 'button', onclick: () => this._applyName() }, T('common.apply')),
        h('button.btn.btn--small', { type: 'button', onclick: () => this._cancelName() }, T('common.cancel')),
        ...keepTick(),
        hint);
      requestAnimationFrame(() => input.focus());
      return;
    }
    box.append(h('span.import__heading', this.name));
    if (!fixed) box.append(iconButton('icon-btn.import__rename', Icons.pencil, T('common.renamePlaylist'), () => this._editName()));
    box.append(...keepTick());
  },

  _editName() {
    this.editingName = true;
    this._nameDraft = this.name;
    this._nameHint = '';
    this._drawName();
    requestAnimationFrame(() => {
      const input = this._nameEl && this._nameEl.querySelector('input');
      if (input) input.select();
    });
  },

  _applyName() {
    const name = this._nameDraft.replace(/\s+/g, ' ').trim();
    if (!name) {
      this._nameHint = T('import.playlist.needsName');
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

  /** Add to Playlist for a whole batch: existing playlists every song joins. */
  async choosePlaylists() {
    const chosen = await pickPlaylists({
      subtitle: this._makesPlaylist() ? T('import.playlist.everySongOf', { playlist: this._finalName() }) : T('import.playlist.everySongOfImport'),
      selectedIds: this.playlistIds,
    });
    if (chosen === null || this.ended) return;
    this.playlistIds = chosen;
    this._drawPlaylistButton();
  },

  /** The footer's Add to Playlist, with the playlists picked. */
  _drawPlaylistButton() {
    const p = this.p;
    this.playlistIds = this.playlistIds.filter((id) => Store.playlist(id));
    const names = this.playlistIds.map((id) => Store.playlist(id).name);
    p.addToPlaylist.innerHTML = Icons.plus + `<span>${names.length ? T('add.addToPlaylist.count', { count: names.length }) : T('common.addToPlaylist')}</span>`;
    p.addToPlaylist.title = names.length ? names.join(', ') : T(this.oneSong ? 'add.addToPlaylist.song.tooltip' : 'add.addToPlaylist.import.tooltip');
    p.playlistNames.textContent = names.length ? names.join(', ') : '';
  },

  render() {
    if (!this.listing || this.ended) return;
    this._drawHead();
    this._drawWarnings();
    this._drawList();
    this._drawCount();
  },

  /** The link (or links) it came from, for the head; '' for local files and picks. */
  _url() {
    const l = this.listing;
    if (!l) return this._title || '';
    if (l.local || l.search) return '';
    return l.sourceUrl || '';
  },

  /**
   * The head: where it is from, its name (with the pencil), how many songs,
   * its link; opened also its notes (a list cut short, links that failed)
   * and the hint how to trim.
   */
  _drawHead() {
    const head = clear(this.p.source);
    const l = this.listing;
    this._nameEl = null;
    if (!l) {
      if (this._title) head.appendChild(h('span.import-batch__url', { title: this._title }, this._title));
      return;
    }
    const kind = String(l.source || '').toLowerCase();
    const source = SOURCE_NAMES[kind] || l.source || T('common.playlist');
    // A server's batch whose site is not known yet: its Server tag says enough.
    if (!(this.server && kind === 'server')) head.appendChild(h('span.import__badge', source));
    // Downloaded by the server: told apart from this computer's.
    if (this.server) head.appendChild(h('span.import__badge.import__badge--server', T('import.batch.onServer')));
    this._nameEl = h('span.import__name');
    head.appendChild(this._nameEl);
    this._drawName();
    let count = this.state === 'review' ? l.items.length : this.included.length;
    // A server's batch being read: the count its quick read gave.
    if (this.state === 'listing' && this._peekCount) count = this._peekCount;
    head.appendChild(h('span.import-batch__count', Util.plural(count, 'song')));
    const url = this._url();
    if (url) head.appendChild(h('span.import-batch__url', { title: url }, url));
    if (this.collapsed) return;
    const notes = h('div.import-batch__notes');
    if (Array.isArray(l.links) && l.links.length > 1) {
      notes.appendChild(h('span.muted-text', T('import.list.fromLinks', { links: Util.plural(l.links.length, 'link') })));
      for (const part of l.links) {
        const text = this._linkNote(part);
        if (text) notes.appendChild(h('span.import__warn-text', text));
      }
      if (l.truncated === 'server') notes.appendChild(h('span.import__warn-text', T('import.list.serverFirst500')));
    } else if (l.truncated === 'files') {
      notes.appendChild(h('span.import__warn-text', T('import.list.folderHasMore', { count: l.items.length })));
    } else if (l.truncated === 'spotify') {
      notes.appendChild(h('span.import__warn-text', l.sourceTotal > l.items.length
        ? T('import.list.spotifyFirstOfTotal', { count: l.items.length, total: l.sourceTotal })
        : T('import.list.spotifyFirst100')));
    } else if (l.truncated === 'amazon') {
      notes.appendChild(h('span.import__warn-text', T('import.list.amazonFirstN', { count: l.items.length })));
    } else if (l.truncated === 'mix') {
      notes.appendChild(h('span.import__warn-text', T('import.list.mixFirst50')));
    }
    if (this.state !== 'review') {
      const hint = this._wholeOnly()
        ? T('import.list.hint.phone')
        : T(`import.list.hint.trimOrRename.${this.local ? 'ready' : 'downloaded'}${Store.uiMode === 'mobile' ? '.touch' : ''}`);
      notes.appendChild(h('span.muted-text', hint));
    }
    if (notes.childNodes.length) head.appendChild(notes);
  },

  /** The note for one of several links read as one: it failed, or was cut short; '' when it is fine. */
  _linkNote(part) {
    const name = part.name || part.url;
    if (part.error) return T('import.list.link.failed', { link: part.url, reason: part.error });
    if (part.truncated === 'spotify') {
      return part.sourceTotal > part.listed
        ? T('import.list.link.spotifyFirstOfTotal', { name, count: part.listed, total: part.sourceTotal })
        : T('import.list.link.spotifyFirstN', { name, count: part.listed });
    }
    if (part.truncated === 'amazon') return T('import.list.link.amazonFirstN', { name, count: part.listed });
    if (part.truncated === 'mix') return T('import.list.link.mixFirst50', { name });
    return '';
  },

  _drawWarnings() {
    if (this.ended) return;
    const box = clear(this.p.warnings);
    const rows = [];
    const taken = this.state === 'saving' || this._saved() ? null : this._takenPlaylist();
    if (taken && taken === this._updateTarget()) {
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div', T('import.playlist.updating', { playlist: taken.name }))));
    } else if (taken) {
      const tick = h('input', { type: 'checkbox', checked: this.merge });
      tick.addEventListener('change', () => {
        this.merge = tick.checked;
      });
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div',
          h('div', T('common.playlistExists', { playlist: taken.name })),
          h('label.check', tick,
            h('span', T('import.playlist.exists.addToIt', { playlist: taken.name }))))));
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
          h('span.muted-text', ` ${T('import.known.inLibraryAs', { song: Util.songLine(it.existing) })}`)));
      }
      rows.push(h('div.import__warning',
        h('span.import__warn-icon', '!'),
        h('div.import__warn-body',
          h('div', T('import.known.note', { songs: Util.plural(known.length, 'song'), count: known.length })),
          list)));
    }
    box.hidden = !rows.length;
    for (const r of rows) box.appendChild(r);
  },

  _drawList() {
    if (this.ended) return;
    const list = clear(this.p.list);
    list.classList.toggle('import__list--frames', this.state !== 'review');
    this._failSummaryEl = null;
    if (this.state === 'review') {
      const items = this._newItems();
      if (!items.length) {
        const target = this._updateTarget();
        list.appendChild(h('div.import__empty', target && !this._knownItems().length
          ? T('import.known.nothingNew', { playlist: target.name })
          : T('import.known.allInLibrary')));
        return;
      }
      const frag = document.createDocumentFragment();
      for (const it of items) frag.appendChild(this._checkRow(it));
      list.appendChild(frag);
      return;
    }
    // Folded: the frames are drawn when it is opened.
    if (this.collapsed) return;
    // The frames. The open one keeps its editor: it is moved, not redrawn.
    // Clearing the list took the editor out of the document with the old
    // frame, so it is put back by reference. So is the Album and Genre box
    // above them, with what is typed into it.
    const typing = this._bulkEl && this._bulkEl.contains(document.activeElement) ? document.activeElement : null;
    const frag = document.createDocumentFragment();
    if (!this.oneSong && this.included.some((it) => !it.existingId)) frag.appendChild(this._drawBulk());
    this._failSummaryEl = h('div.import__summary', { hidden: true });
    frag.appendChild(this._failSummaryEl);
    for (const it of this.included) frag.appendChild(this._frame(it));
    list.appendChild(frag);
    if (typing) typing.focus();
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
   * Above the frames: one Album, Genre and Info for every new
   * song of the import that has none, each with its Apply (clickable once something is
   * typed). Songs still downloading get them as they arrive (_giveBulk).
   * Made once per import and kept, so a redraw keeps what is typed.
   */
  _drawBulk() {
    if (this._bulkEl) return this._bulkEl;
    const field = (key, label, placeholder) => {
      const input = h('input.input.import__bulk-input', {
        type: 'text', maxLength: 150, spellcheck: false, placeholder, 'aria-label': label,
      });
      const apply = h('button.btn.btn--small.btn--light-green', { type: 'button', disabled: true }, T('common.apply'));
      input.addEventListener('input', () => {
        apply.disabled = !input.value.trim();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
          e.preventDefault();
          apply.click();
        }
      });
      apply.onclick = () => this._applyBulk(key, input.value);
      return h('label.import__bulk-field', h('span.import__bulk-label', T('import.bulk.field', { field: label })), input, apply);
    };
    this._bulkEl = h('div.import__bulk',
      h('div.import__bulk-text', T('import.bulk.intro')),
      h('div.import__bulk-row',
        field('album', BULK.album.label, T('import.bulk.album.placeholder')),
        field('genre', BULK.genre.label, 'Hardstyle'),
        field('subGenre', BULK.subGenre.label, T('common.infoPlaceholder'))),
      h('div.import__bulk-note.muted-text',
        T('import.bulk.note')));
    return this._bulkEl;
  },

  /** A new song's empty album, genre or info from the box above the frames, once its names are there. */
  _giveBulk(it) {
    if (!it.meta || it.existingId) return false;
    let given = false;
    for (const key of Object.keys(BULK)) {
      if (this.bulkInfo[key] && !String(it.meta[key] || '').trim()) {
        it.meta = { ...it.meta, [key]: this.bulkInfo[key] };
        given = true;
      }
    }
    return given;
  },

  /** Apply in the box above the frames: every new song without an album (genre, info) gets this one. */
  _applyBulk(key, value) {
    const v = String(value || '').replace(/\s+/g, ' ').trim();
    if (!v || this.state === 'saving') return;
    this.bulkInfo[key] = v;
    // The open frame's box: closing it reads the names back from there.
    let given = 0;
    if (this.openIndex !== null) {
      const box = $(BULK[key].box);
      if (box && !box.value.trim()) {
        box.value = v;
        given += 1;
      }
    }
    const open = (it) => !it.existingId && !['saving', 'saved', 'discarded', 'failed', 'cancelled'].includes(it.state);
    let coming = 0;
    for (const it of this.included) {
      if (!open(it) || it.index === this.openIndex) continue;
      if (it.state !== 'ready') {
        coming += 1;
        continue;
      }
      if (this._giveBulk(it)) {
        given += 1;
        this._redrawFrame(it);
      }
    }
    toast(T(coming ? 'import.bulk.given.alsoComing' : 'import.bulk.given', {
      field: BULK[key].label, value: v, songs: Util.plural(given, 'song'), coming: Util.plural(coming, 'song'),
    }), 'success');
  },

  /**
   * Local files that could not be opened, as one line per reason instead of
   * a frame each: a folder can hold hundreds of files that only look like
   * audio by their name.
   */
  _drawFailSummary() {
    const box = this._failSummaryEl;
    if (!box) return;
    const failed = this.local ? this.included.filter((it) => it.state === 'failed') : [];
    clear(box);
    box.hidden = !failed.length;
    if (!failed.length) return;
    const byReason = new Map();
    for (const it of failed) {
      const r = it.reason || T('import.song.failed');
      if (!byReason.has(r)) byReason.set(r, { titles: [], noAudio: false });
      byReason.get(r).titles.push(it.title);
      if (it.noAudio) byReason.get(r).noAudio = true;
    }
    for (const [reason, { titles, noAudio }] of byReason) {
      const n = titles.length;
      const text = noAudio
        ? T('import.files.noAudio', { files: Util.plural(n, 'file'), count: n })
        : T('import.files.notOpened', { files: Util.plural(n, 'file'), count: n, reason });
      const more = n > 20 ? `\n${T('import.files.andMore', { count: n - 20 })}` : '';
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

  /**
   * For a Spotify (Deezer, Amazon Music) song: the upload it was matched to,
   * on YouTube or the site it was found on instead.
   */
  _matchLine(it) {
    if (it.status === 'unavailable') return h('div.import__sub.import__sub--bad', it.note || T('import.match.notAvailable'));
    const m = it.match;
    if (!m) {
      return it.status === 'notfound' ? h('div.import__sub.import__sub--bad', T('import.match.notFound', { reason: it.note || T('import.match.notFound.noMatch') })) : null;
    }
    const site = m.site || 'YouTube';
    const diff = Math.round((m.duration || 0) - (it.duration || 0));
    const off = diff === 0 ? T('import.match.sameLength') : `${diff > 0 ? '+' : ''}${diff} s`;
    const link = h('button.link-btn.import__link', {
      type: 'button',
      title: T('import.match.openToCheck.tooltip', { site }),
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.flow.openUrl(m.url || `https://www.youtube.com/watch?v=${m.id}`);
      },
    }, m.title || site);
    const parts = [h('span', `${T('import.match.site', { site })} `), link,
      h('span', ` · ${m.channel || '?'} · ${Util.fmtClock(m.duration)} (${off})`)];
    if (it.status === 'notfound') parts.unshift(h('span.import__flag.import__flag--bad', T('import.match.notFound.flag')));
    else if (m.quality === 'shaky') parts.unshift(h('span.import__flag', T('import.match.check.flag')));
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
    let text = T('common.selected', { chosen: chosen.length, total: usable.length });
    if (chosen.length) text += ` ${T('import.selection.size', { mb: mb < 10 ? mb.toFixed(1) : Math.round(mb) })}`;
    const known = this._knownItems().filter((it) => this.keepKnown.has(it.index)).length;
    if (known) text += ` ${T('import.selection.fromLibrary', { count: known })}`;
    this.p.count.textContent = text;
    this.p.selected.disabled = !chosen.length && !known;
    this.p.everything.disabled = !usable.length && !this._knownItems().length;
  },

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
    const fresh = this._frame(it);
    node.replaceWith(fresh);
  },
};

/**
 * The batches on Add Songs: made, placed on the page (finished ones above,
 * those still reading or downloading at the bottom, each group oldest
 * first), and told what concerns them all (the progress of this computer's
 * import task, the server's batches, the one trim editor).
 */
const ImportPanel = {
  batches: [],
  editorOwner: null,  // the batch whose frame has the trim editor
  updating: null,     // a playlist's Update whose link AddPage put into the box: { id, name, url }
  _seq: 0,
  _run: 0,

  init() {
    window.flow.onImportProgress((p) => {
      const b = this.batches.find((x) => x.run === p.run);
      if (b) b._onProgress(p);
    });
    Store.onLibrary(() => {
      for (const b of this.batches) if (b.state !== 'idle' && b.state !== 'listing') b._drawWarnings();
    });
    // The checklist's size estimate follows the MP3 settings.
    Store.onSettings((patch) => {
      if (!('alwaysMp3' in patch || 'mp3Quality' in patch)) return;
      for (const b of this.batches) if (b.state === 'review') b._drawCount();
    });
  },

  nextRun() {
    this._run += 1;
    return this._run;
  },

  /** A new batch, not on the page until it has a state. */
  create({ auto = null, updating = null } = {}) {
    const b = Object.create(ImportBatch);
    this._seq += 1;
    b._init(this._seq);
    b.auto = auto;
    b.updating = updating;
    this.batches.push(b);
    return b;
  },

  remove(b) {
    this.batches = this.batches.filter((x) => x !== b);
    if (this.editorOwner === b) this.editorOwner = null;
  },

  /** A batch of this computer's has its checklist open or reads or downloads: the Client queue waits. */
  get clientBusy() {
    return this.batches.some((b) => b.busy);
  },

  /** Compatible name: as clientBusy. */
  get busy() {
    return this.clientBusy;
  },

  /** A batch of the server's is shown, reading or downloading. */
  get serverComing() {
    return this.batches.some((b) => b.server && (b.state === 'listing' || b.state === 'downloading'));
  },

  serverBatch(id) {
    return this.batches.find((b) => b.server && b.server.id === id) || null;
  },

  /** Puts a batch's panel where its state belongs, in the order the batches came. */
  place(b) {
    if (b.ended || b.state === 'idle') return;
    const box = ACTIVE_STATES.includes(b.state) ? $('importActive') : $('importDone');
    if (b.el.parentNode === box) return;
    const after = [...box.children].find((node) => Number(node.dataset.batch) > b.n);
    box.insertBefore(b.el, after || null);
  },

  /** A batch changed state (or went): what depends on all of them follows. */
  changed() {
    this._drawBadge();
    this._setPending();
    // Retry failed depends on what else downloads here.
    for (const b of this.batches) if (b.ownsFooter) b._drawFooter();
    if (typeof ServerImport !== 'undefined') ServerImport.drawButtons();
    if (typeof ClientQueue !== 'undefined') ClientQueue.kick();
  },

  /** Closes the trim editor wherever it is open, keeping (`keep`) or dropping its edits. */
  closeEditor(keep) {
    const o = this.editorOwner;
    if (!o) return;
    o._closeEditor(keep);
    o._drawList();
    o._drawFooter();
  },

  /** The menu's badge: how far the download is, '...' while a list is read, else how many songs wait for Finish. */
  _drawBadge() {
    const badge = $('menuAddBadge');
    if (!badge) return;
    const down = this.batches.find((b) => b.state === 'downloading');
    let text = '';
    let waiting = false;
    if (down) text = `${down.progress.number}/${down.progress.total}`;
    else if (this.batches.some((b) => b.state === 'listing')) text = '...';
    else {
      const ready = this.batches.reduce((sum, b) => sum + (b.state === 'trimming' ? b._ready().length : 0), 0);
      if (ready) {
        text = String(ready);
        waiting = true;
      }
    }
    badge.hidden = !text;
    badge.textContent = text;
    badge.title = waiting ? T('import.bar.waiting.tooltip') : T('import.bar.running.tooltip');
  },

  /** Songs only in the cache, which closing the app would lose (a server's batch stays there). */
  _setPending() {
    const count = this.batches.reduce((sum, b) => sum + (b.server || b.state === 'idle' ? 0 : b._ready().length), 0);
    window.flow.setImportPending(count).catch(() => {});
  },

  // ---- what AddPage, ClientQueue and the others open ----

  /** A playlist link: its checklist. Resolves the probed song when it is one song. */
  open(url, opts = {}) {
    return this.create(opts).open(url);
  },

  /** A song's link (or one read already: `probed`). */
  openSong(url, opts = {}) {
    return this.create(opts).openSong(url, { probed: opts.probed || null });
  },

  openLocal(picked) {
    return this.create().openLocal(picked);
  },

  openPicked(name, picks, opts = {}) {
    return this.create(opts).openPicked(name, picks);
  },

  openUpdate(p, listing, server) {
    return this.create().openUpdate(p, listing, server);
  },

  /**
   * "Auto-accept songs lookup" / "Automate 'Finish all'" switched (ClientQueue.followAuto):
   * this computer's batches still being read take the first (a list read then
   * goes on with Download All), those not downloaded yet the second.
   */
  followAuto(auto) {
    for (const b of this.batches) {
      if (b.server || !b.auto || b.ended) continue;
      if (b.state === 'idle' || b.state === 'listing') b.auto.complete = !!auto.complete;
      if (b.state === 'idle' || ACTIVE_STATES.includes(b.state)) b.auto.finish = !!auto.finish;
    }
  },

  /** A song's download progress (download:progress) goes to the batch downloading its one song. */
  songProgress(p) {
    const b = this.batches.find((x) => x._singleTask && x.state === 'downloading');
    if (b) b._onSongProgress(p);
  },

  /**
   * The profile's batches on the server as they are now, oldest first: each
   * one reading, downloading or waiting for Finish all has its panel (those
   * still waiting for their turn are the Server queue's lines); a panel whose
   * batch is gone goes (`finished`: the ids the server finished itself).
   */
  syncServer(list, { finished = new Set(), updates = null } = {}) {
    const shown = (list || []).filter((b) => b && b.state !== 'queued');
    for (const batch of shown) {
      const b = this.serverBatch(batch.id);
      if (b) {
        b.syncServer(batch);
        continue;
      }
      const fresh = this.create({ updating: updates ? updates(batch.id) : null });
      fresh.openServer(batch);
    }
    for (const b of this.batches.filter((x) => x.server && !shown.some((batch) => batch.id === x.server.id))) {
      b.serverGone(finished.has(b.server.id));
    }
  },
};
