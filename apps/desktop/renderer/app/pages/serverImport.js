'use strict';

// "Download (Server)" on Add Songs. With a Flow Server that downloads songs
// itself (its hello lists the "download" feature), the link goes to the
// server, which reads it and downloads the songs in the background
// (apps/linux-server/src/downloads.js), one batch per profile. ImportPanel shows
// that batch in its frames (its server mode); this keeps it in step:
//
//   - the batch is fetched when the server connects or the profile changes,
//     and when Add Songs opens; every 2 seconds while songs are still coming
//     and the page is open, every 30 seconds otherwise (another device of the
//     same profile may start one, or finish its songs);
//   - an answer that left before something was done here (a song finished,
//     the batch cancelled) is dropped: `seq` counts both;
//   - while a batch is open the local buttons are hidden, as for any import.
//     The batch outlives the app: closing it asks nothing, and the batch is
//     back at the next start.
//
// With a server that queues (its hello lists "downloadQueue", 4.4) the
// buttons never wait: a link given to the server while Add Songs has
// something open is queued there ("Queue Download (Server)") with the
// "Auto-complete confirmations" and "Automate 'Finish All'" of that moment,
// and downloads meanwhile; the page's frames show the profile's oldest batch.
// The poll also brings the queue's lines of every profile (rows, drawn by the
// Server queue frame) and what batches that finished by themselves did
// (done), told once each.

const ServerImport = {
  seq: 0,
  timer: 0,
  lastKey: '',
  mine: [],        // the profile's batches on the server, oldest first (with the queue)
  rows: [],        // the server's queue: every profile's batches waiting or downloading
  _toldDone: new Set(),
  _listeners: [],

  init() {
    $('serverDownloadBtn').onclick = () => this.start();
    Store.onServer((st) => this._onServer(st));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.available) this.poll();
    });
    // Connected before this was listening: a batch left open is shown at once.
    this._onServer(Store.server);
  },

  _onServer(st) {
    this.drawButtons();
    // Connected, to another server, or as another profile: fetch at once.
    const key = st && st.downloads ? `${st.base}|${st.profile ? st.profile.id : ''}` : '';
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (key) this.poll();
    else clearTimeout(this.timer);
  },

  /** The connected server downloads songs itself. */
  get available() {
    return !!(Store.server && Store.server.downloads);
  },

  /** It keeps several batches, taking turns (4.4). */
  get queues() {
    return this.available && !!Store.server.downloadQueue;
  },

  /** fn({ mine, rows }) whenever the server's queue changes (the Server queue frame draws it). */
  onChange(fn) {
    this._listeners.push(fn);
  },

  _changed() {
    for (const fn of this._listeners) {
      try {
        fn({ mine: this.mine, rows: this.rows });
      } catch {
        // A drawer's own problem.
      }
    }
  },

  /**
   * "Download (Client)" and "Download (Server)", or the one Download without
   * such a server; "Downloads?" instead of the link box where nothing
   * downloads (downloadsHelp.js).
   */
  drawButtons() {
    const on = this.available;
    const computer = Store.can('downloadHere');
    const none = !on && !DownloadsHelp.here;
    $('linkInput').hidden = none;
    $('downloadsHelpBtn').hidden = !none;
    $('autoRow').hidden = none;
    $('serverDownloadBtn').hidden = !on;
    // The phone does not download itself: only the server's button. A computer
    // without yt-dlp shows its own greyed out (a click opens the legal note).
    $('downloadBtn').hidden = !computer || none;
    $('downloadBtn').classList.toggle('btn--off', computer && !DownloadsHelp.here);
    // Something open on the page: a new link is queued (Client queue, Server queue).
    const busy = ImportPanel.busy || ['probing', 'downloading', 'saving'].includes(AddPage.phase);
    const pageOpen = ClientQueue.busy || ClientQueue.entries.length > 0;
    const queuesHere = ClientQueue.available;
    if (pageOpen && queuesHere) $('downloadBtn').textContent = on ? T('add.queueDownload.client') : T('add.queueDownload');
    else $('downloadBtn').textContent = on ? T('add.download.client') : T('common.download');
    $('downloadBtn').disabled = !queuesHere && busy;
    const serverBusy = !!ImportPanel.server || this.mine.length > 0 || ClientQueue.busy;
    $('serverDownloadBtn').textContent = this.queues && serverBusy ? T('add.queueDownload.server') : T('window.add.downloadServer');
    $('serverDownloadBtn').disabled = !this.queues && busy;
    // Only where nothing can be queued does the box wait.
    $('linkInput').disabled = !queuesHere && !this.queues && (busy || AddPage.phase === 'probing');
  },

  /**
   * Cancel import of batch `id`: once the server has it, asked again at once, so
   * the buttons and the next batch follow without waiting for the next poll.
   */
  cancelBatch(id) {
    return window.flow.serverDownloads('cancel', { batchId: id }).then((r) => {
      this.poll();
      return r;
    });
  },

  /** Something was done to the batch here: answers that left before it are out of date. */
  touch() {
    this.seq += 1;
  },

  schedule() {
    clearTimeout(this.timer);
    if (!this.available) return;
    // With the queue: anything of the server's queue moving counts too.
    const coming = (!!ImportPanel.server && (ImportPanel.state === 'listing' || ImportPanel.state === 'downloading'))
      || this.rows.length > 0 || this.mine.some((b) => b.state !== 'ready' || b.items.some((x) => ['queued', 'downloading', 'converting'].includes(x.state)));
    const fast = coming && Nav.page === 'add' && document.visibilityState === 'visible';
    this.timer = setTimeout(() => this.poll(), fast ? 2000 : 30000);
  },

  async poll() {
    clearTimeout(this.timer);
    // Out of reach: the batch is still on the server; the frames stay as they are.
    if (!this.available) return;
    const seq = ++this.seq;
    let batch;
    let q = null;
    try {
      if (this.queues) q = await window.flow.serverDownloads('queue');
      batch = q ? this._shown(q.batches[0] || null) : await window.flow.serverDownloads('get');
    } catch {
      if (seq === this.seq) this.schedule();
      return;
    }
    if (seq !== this.seq) return;
    this.mine = q ? q.batches : (batch ? [batch] : []);
    this.rows = q ? q.queue : [];
    const finished = q ? this._tellDone(q.done) : new Set();
    const shown = ImportPanel.server && ImportPanel.server.id;
    ImportPanel.syncServer(batch, { finishedThere: !!shown && finished.has(shown) });
    this._changed();
    this.drawButtons();
    this.schedule();
  },

  /**
   * The batch the page's frames show: the profile's oldest. One still waiting
   * for its turn reads as one being read, with its place in the queue.
   */
  _shown(b) {
    if (!b || b.state !== 'queued') return b;
    return { ...b, state: 'listing', progress: { frac: null, text: T('serverImport.waitingTurn', { place: b.place || 1 }) } };
  },

  /**
   * What batches that finished by themselves did, told once each: how many
   * songs were saved (Open playlist), or that the song was in All Songs
   * already. The ids of all of them.
   */
  _tellDone(done) {
    const ids = new Set();
    for (const d of done || []) {
      ids.add(d.id);
      if (this._toldDone.has(d.id)) continue;
      this._toldDone.add(d.id);
      if (d.skipped) {
        toast(T('add.queue.skipped', { song: d.existing ? Util.songLine(d.existing) : d.name }), 'info');
        continue;
      }
      const failed = (d.failed || []).length;
      const text = [T('serverImport.done.saved', { name: d.name, count: d.saved || 0 }), failed ? T('serverImport.done.failed', { count: failed }) : ''].filter(Boolean).join(' ');
      const id = d.playlistId;
      toast(text, d.saved ? 'success' : 'error',
        id ? { label: T('import.done.openPlaylist'), onClick: () => Store.playlist(id) && Nav.openPlaylist(id) } : null);
    }
    return ids;
  },

  /**
   * Download (Server): the link in the box goes to the server. Words instead
   * of a link (a song's name) are searched for there first (songSearch.js);
   * one upload picked there comes back as `pick` ({ url, title }), one song.
   */
  async start(pick = null) {
    if (!this.available) return;
    const url = pick ? pick.url : $('linkInput').value.trim();
    if (!url) {
      AddPage._showError(T('common.emptyBox'));
      $('linkInput').focus();
      return;
    }
    // Several links pasted at once ("a, b, c"): read as one list.
    const many = !pick && AddPage.isLinkList(url);
    if (!pick && !many && AddPage.isSearch(url)) {
      if (ImportPanel.busy || (this.queues && ClientQueue.busy)) {
        if (this.queues) toast(T('add.queue.searchBusy'), 'error');
        else AddPage._showError(T('serverImport.importOpen'));
        return;
      }
      SongSearch.open(url, 'server');
      return;
    }
    // With the queue, while the page has something open: queued on the server, the page left as it is.
    if (this.queues && ClientQueue.busy) {
      const updating = !pick && ImportPanel.updating && url === ImportPanel.updating.url;
      let kind = pick ? 'song' : (updating || many ? 'list' : AddPage._linkKind(url));
      if (kind === 'ask') {
        kind = await AddPage._askSongOrList(url);
        if (!kind) return;
      }
      await this._queue({ url, kind });
      return;
    }
    if (!await AddPage._clearForNew()) return;
    // Another link than the one an Update put into the box: no Update.
    if (ImportPanel.updating && (pick || url !== ImportPanel.updating.url)) ImportPanel.updating = null;
    let kind = pick ? 'song' : (ImportPanel.updating || many ? 'list' : AddPage._linkKind(url));
    if (kind === 'ask') {
      kind = await AddPage._askSongOrList(url);
      if (!kind) return;
    }
    await this._create({ url, kind });
  },

  /** A batch queued on the server while the page shows something else: it downloads meanwhile. */
  async _queue(args) {
    this.touch();
    let batch;
    try {
      batch = await window.flow.serverDownloads('create', {
        ...args, options: AddPage.downloadOptions(), queue: true, auto: AddPage.autoNow(),
      });
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    $('linkInput').value = '';
    if (batch) toast(T('add.queue.added.server'), 'info');
    this.poll();
  },

  /**
   * Several uploads picked from a search's results ("Download Selected",
   * "Download All"; one alone goes to start): one batch on the server, saved
   * into All Songs unless "Create new Playlist" is ticked.
   */
  async startPicked(picks, name) {
    if (!this.available) return;
    if (this.queues && ClientQueue.busy) {
      await this._queue({ items: picks.map((r) => ({ url: r.url, title: r.title, duration: r.duration })), name });
      return;
    }
    if (!await AddPage._clearForNew()) return;
    await this._create({ items: picks.map((r) => ({ url: r.url, title: r.title, duration: r.duration })), name });
  },

  /** A new batch on the server (remote.serverDownloads 'create'), shown in the frames. */
  async _create(args) {
    this.touch();
    $('serverDownloadBtn').disabled = true;
    let batch;
    try {
      // With the queue it may wait behind other profiles' batches, finishing by itself as asked.
      const queued = this.queues ? { queue: true, auto: AddPage.autoNow() } : {};
      batch = await window.flow.serverDownloads('create', { ...args, options: AddPage.downloadOptions(), ...queued });
      batch = this._shown(batch);
    } catch (err) {
      this.drawButtons();
      AddPage._showError(err.message);
      // One open already (another device of this profile): it is shown.
      this.poll();
      return;
    }
    $('linkInput').value = '';
    ImportPanel.openServer(batch);
    this.schedule();
  },

  /**
   * A shared link (AddPage.shared): downloaded at once when the server can,
   * else once it connects (Flow may just be starting) while the link is still
   * in the box, within a minute. Without such a server the page's hint says
   * how to get one.
   */
  startShared(url) {
    if (this._waitShare) this._waitShare();
    this._waitShare = null;
    const go = () => {
      // One still open: start() says so, and the link waits in the box.
      if ($('linkInput').value.trim() === url) this.start();
    };
    if (this.available) {
      go();
      return;
    }
    if (!Store.server.on) return;
    let off = null;
    const timer = setTimeout(() => this._waitShare(), 60000);
    this._waitShare = () => {
      clearTimeout(timer);
      if (off) off();
      this._waitShare = null;
    };
    off = Store.onServer(() => {
      if (!this.available) return;
      this._waitShare();
      go();
    });
  },

  /**
   * "Try again" and "Retry failed" (ImportPanel.retryFailed): the server
   * downloads these failed songs once more. Resolves the batch as the last
   * one asked left it, or null when none could be asked.
   */
  async retry(indexes) {
    let batch = null;
    for (const index of indexes) {
      // A fetch that left before this would bring the song back as failed.
      this.touch();
      try {
        batch = await window.flow.serverDownloads('retry', { index, batchId: ImportPanel.server && ImportPanel.server.id });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    this.touch();
    return batch;
  },
};
