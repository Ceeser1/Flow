'use strict';

// "Download (Server)" on Add Songs. With a Flow Server that downloads songs
// itself (its hello lists the "download" feature), the link goes to the
// server, which reads it and downloads the songs in the background
// (apps/linux-server/src/downloads.js). ImportPanel shows each of the
// profile's batches in a panel of its own (its server mode); this keeps them
// in step:
//
//   - the batches are fetched when the server connects or the profile
//     changes, and when Add Songs opens; every 2 seconds while songs are
//     still coming and the page is open, every 30 seconds otherwise (another
//     device of the same profile may start one, or finish its songs);
//   - an answer that left before something was done here (a song finished,
//     a batch cancelled) is dropped: `seq` counts both.
//   The batches outlive the app: closing it asks nothing, and they are back
//   at the next start.
//
// With a server that queues (its hello lists "downloadQueue", 4.4) a link is
// always taken at once, with the "Auto-accept songs lookup" and "Automate
// 'Finish all'" of that moment ("Queue Download (Server)" while the server
// downloads something): the server's batches take turns, and one waiting
// for "Finish all" holds no one up. The poll brings the queue's lines of
// every profile (rows, drawn by the Server queue frame, queuePanels.js) and
// what batches that finished by themselves did (done), told once each. A
// server from before has one batch per profile: a new link waits until it
// is finished.

const ServerImport = {
  seq: 0,
  timer: 0,
  lastKey: '',
  mine: [],        // the profile's batches on the server, oldest first
  rows: [],        // the server's queue: every profile's batches waiting or downloading (with the queue)
  _toldDone: new Set(),
  _listeners: [],
  _updates: new Map(), // batch id -> the playlist's Update it is ({ id, name, url }), for its panel

  init() {
    $('serverDownloadBtn').onclick = () => this.start();
    Store.onServer((st) => this._onServer(st));
    // The server says when its downloads change (4.6): asked for then.
    if (window.flow.onServerLive) {
      window.flow.onServerLive((ev) => {
        if (ev && ev.type === 'downloads') this._told();
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.available) this.poll();
    });
    // Connected before this was listening: the batches left open are shown at once.
    this._onServer(Store.server);
  },

  _onServer(st) {
    this.drawButtons();
    // Connected, to another server, or as another profile: fetch at once.
    const key = st && st.downloads ? `${st.base}|${st.profile ? st.profile.id : ''}` : '';
    // The server's word on its downloads began or ended (its live channel opened or was lost): looked at
    // once now, and from then on when it says so, or again every few seconds without it.
    const told = this.announced;
    if (key === this.lastKey && told !== this._wasAnnounced && key) {
      this._wasAnnounced = told;
      this.poll();
      return;
    }
    this._wasAnnounced = told;
    if (key === this.lastKey) return;
    this.lastKey = key;
    if (key) {
      this.poll();
      return;
    }
    clearTimeout(this.timer);
    this.mine = [];
    this.rows = [];
    this._changed();
  },

  /** The connected server downloads songs itself. */
  get available() {
    return !!(Store.server && Store.server.downloads);
  },

  /**
   * The server says on the live channel when its downloads change (4.6):
   * they are asked for then, and no timer asks in between.
   */
  get announced() {
    return this.available && !!Store.server.downloadsLive;
  },

  /**
   * The server's downloads changed: asked for now while Add Songs shows,
   * else 5 seconds after the last look at the earliest (a song's progress
   * comes every second, and is of no use on another page; what batches
   * that finished did is still told).
   */
  _told() {
    if (!this.available) return;
    // One look at a time: a word that comes while the server is being asked
    // is followed right after its answer. (A new look throws away the answer
    // on its way; with words coming faster than answers, none would count.)
    if (this._asking) {
      this._again = true;
      return;
    }
    const showing = Nav.page === 'add' && document.visibilityState === 'visible';
    const wait = showing ? 0 : Math.max(0, (this._polledAt || 0) + 5000 - Date.now());
    clearTimeout(this._toldTimer);
    this._toldTimer = setTimeout(() => this._ask(), wait);
  },

  async _ask() {
    this._asking = true;
    this._again = false;
    try {
      await this.poll();
    } finally {
      this._asking = false;
      if (this._again) this._told();
    }
  },

  /** It keeps several batches, taking turns (4.4). */
  get queues() {
    return this.available && !!Store.server.downloadQueue;
  },

  /** The server downloads something now (anyone's): a link given to it waits for its turn. */
  get downloading() {
    // A checklist waiting for its choice (review) holds no one up on the server.
    const coming = (b) => b.state === 'queued' || b.state === 'listing' || (b.state !== 'review' && (b.items || []).some((x) => ['queued', 'downloading', 'converting'].includes(x.state)));
    return this.rows.length > 0 || this.mine.some(coming) || ImportPanel.serverComing;
  },

  /**
   * A batch of the profile's finishes by itself ("Automate 'Finish all'"):
   * once its songs have come the server saves them and takes the batch away,
   * without a word from here. Looked at as often as one still downloading,
   * so its panel follows the songs being saved and goes when the batch does
   * (it stood there with "Finish all" for up to half a minute).
   */
  get finishing() {
    return this.mine.some((b) => !!(b.auto && b.auto.finish) && b.state === 'ready');
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
   * downloads (downloadsHelp.js). "Queue Download" where a link waits for
   * its turn.
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
    const waitsHere = ClientQueue.busy || ClientQueue.entries.length > 0;
    if (waitsHere && ClientQueue.available) $('downloadBtn').textContent = on ? T('add.queueDownload.client') : T('add.queueDownload');
    else $('downloadBtn').textContent = on ? T('add.download.client') : T('common.download');
    $('serverDownloadBtn').textContent = this.queues && this.downloading ? T('add.queueDownload.server') : T('window.add.downloadServer');
    // A server from before takes one batch at a time.
    $('serverDownloadBtn').disabled = !this.queues && this.mine.length > 0;
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

  /**
   * The songs ticked in the checklist of batch `id`, read by the server and
   * waiting in review (4.4.1): it downloads them at their turn. Resolves the batch.
   */
  async choose(id, indexes) {
    this.touch();
    const batch = await window.flow.serverDownloads('choose', { batchId: id, indexes });
    this.touch();
    this.poll();
    return batch;
  },

  /** Something was done to a batch here: answers that left before it are out of date. */
  touch() {
    this.seq += 1;
  },

  schedule() {
    clearTimeout(this.timer);
    if (!this.available) return;
    // The server says when something changes: nothing to ask for meanwhile.
    if (this.announced) return;
    const fast = (this.downloading || this.finishing) && Nav.page === 'add' && document.visibilityState === 'visible';
    this.timer = setTimeout(() => this.poll(), fast ? 2000 : 30000);
  },

  async poll() {
    clearTimeout(this.timer);
    clearTimeout(this._toldTimer);
    this._polledAt = Date.now();
    // Out of reach: the batches are still on the server; the frames stay as they are.
    if (!this.available) return;
    const seq = ++this.seq;
    let mine;
    let q = null;
    try {
      if (this.queues) {
        q = await window.flow.serverDownloads('queue');
        mine = q.batches || [];
      } else {
        const batch = await window.flow.serverDownloads('get');
        mine = batch ? [batch] : [];
      }
    } catch {
      if (seq === this.seq) this.schedule();
      return;
    }
    if (seq !== this.seq) return;
    this.mine = mine;
    this.rows = q ? q.queue || [] : [];
    const finished = q ? this._tellDone(q.done) : new Set();
    ImportPanel.syncServer(mine, { finished, updates: (id) => this._takeUpdate(id) });
    for (const id of [...this._updates.keys()]) if (!mine.some((b) => b.id === id)) this._updates.delete(id);
    this._changed();
    this.drawButtons();
    this.schedule();
  },

  /** The playlist's Update batch `id` is, once, for its panel. */
  _takeUpdate(id) {
    const u = this._updates.get(id) || null;
    this._updates.delete(id);
    return u;
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
      SongSearch.open(url, 'server');
      return;
    }
    // A server from before: one batch at a time.
    if (!this.queues && this.mine.length) {
      AddPage._showError(T('serverImport.importOpen'));
      return;
    }
    let kind = pick ? 'song' : (many ? 'list' : AddPage._linkKind(url));
    if (kind === 'ask') {
      kind = await AddPage._askSongOrList(url);
      if (!kind) return;
    }
    await this._create({ url, kind });
  },

  /**
   * Several uploads picked from a search's results ("Download Selected",
   * "Download All"; one alone goes to start): one batch on the server, saved
   * into All Songs unless "Create new Playlist" is ticked.
   */
  async startPicked(picks, name) {
    if (!this.available) return;
    if (!this.queues && this.mine.length) {
      AddPage._showError(T('serverImport.importOpen'));
      return;
    }
    await this._create({ items: picks.map((r) => ({ url: r.url, title: r.title, duration: r.duration })), name });
  },

  /**
   * A new batch on the server (remote.serverDownloads 'create'), shown in a
   * panel of its own; `updating`: the playlist's Update it is. With the
   * queue it may wait behind other batches (a line of the Server queue
   * until its turn), finishing by itself as asked.
   */
  async _create(args, updating = null) {
    this.touch();
    const waited = this.queues && this.downloading;
    let batch;
    try {
      // review: without "Auto-accept songs lookup" a list read waits for its checklist (4.4.1).
      const auto = AddPage.autoNow();
      const queued = this.queues ? { queue: true, auto, review: !auto.complete } : {};
      batch = await window.flow.serverDownloads('create', { ...args, options: AddPage.downloadOptions(), ...queued });
    } catch (err) {
      AddPage._showError(err.message);
      // One open already (another device of this profile): it is shown.
      this.poll();
      return;
    }
    if (args.url && $('linkInput').value.trim() === args.url) $('linkInput').value = '';
    if (batch && updating) this._updates.set(batch.id, updating);
    if (batch && waited && batch.state === 'queued') toast(T('add.queue.added.server'), 'info');
    this.poll();
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
      // One still open on a server from before: start() says so, and the link waits in the box.
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
   * "Try again" and "Retry failed" (ImportBatch.retryFailed): the server
   * downloads these failed songs of batch `batchId` once more. Resolves the
   * batch as the last one asked left it, or null when none could be asked.
   */
  async retry(indexes, batchId) {
    let batch = null;
    for (const index of indexes) {
      // A fetch that left before this would bring the song back as failed.
      this.touch();
      try {
        batch = await window.flow.serverDownloads('retry', { index, batchId });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    this.touch();
    return batch;
  },
};
