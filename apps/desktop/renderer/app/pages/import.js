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
// it is finished. Closing the app loses nothing (4.5.3, keptDownloads.js): every batch
// of this computer's is kept with its songs in the cache and comes back at
// the next start, the songs cut off downloading again by themselves.
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
    // The warnings go by the songs' and playlists' names: not drawn again for a cover or a listen.
    Store.onLibrary((lib, change) => {
      if (change.quiet()) return;
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

  /**
   * A new batch, not on the page until it has a state. `entry`: the Client
   * queue's entry it was made for (ClientQueue._run), to start it again when
   * Flow closed while it was still being read (4.5.3).
   */
  create({ auto = null, updating = null } = {}) {
    const b = Object.create(ImportBatch);
    this._seq += 1;
    b._init(this._seq);
    b.auto = auto;
    b.updating = updating;
    b.entry = this.entry || null;
    this.batches.push(b);
    return b;
  },

  remove(b) {
    this.batches = this.batches.filter((x) => x !== b);
    if (this.editorOwner === b) this.editorOwner = null;
    KeptDownloads.schedule();
  },

  /**
   * A batch kept over a restart (4.5.3, keptDownloads.js): back on the page
   * as it was. Resolves { entry } for one still being read then (its entry
   * goes to the front of the Client queue), { resume: { batch, indexes } }
   * for one whose songs were cut off downloading, else null.
   */
  restore(k) {
    const kept = ['review', 'downloading', 'trimming', 'saving'];
    // Still being read, or its one song downloading: started again from its link.
    if (!k.listing || !kept.includes(k.state) || (k.single && k.state === 'downloading')) return k.entry ? { entry: k.entry } : null;
    const b = this.create({ auto: k.auto || null, updating: k.updating || null });
    b.entry = k.entry || null;
    const indexes = b._restore(k);
    if (indexes.length) return { resume: { batch: b, indexes } };
    // Every song was there already and it was to finish by itself ("Automate
    // 'Finish all'"): finished now, as it would have been had Flow stayed open.
    if (b.auto && b.auto.finish && b.state === 'trimming') {
      setTimeout(() => {
        if (!b.ended && b.state === 'trimming' && !b._endIfDone()) b.finishAll();
      }, 0);
    }
    return null;
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
    KeptDownloads.schedule();
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
    KeptDownloads.schedule();
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
