'use strict';

// "Download (Server)" on Add Songs. With a Flow Server that downloads songs
// itself (its hello lists the "download" feature), the link goes to the
// server, which reads it and downloads the songs in the background
// (apps/server/src/downloads.js), one batch per profile. ImportPanel shows
// that batch in its frames (its server mode); this keeps it in step:
//
//   - the batch is fetched when the server connects or the profile changes,
//     and when Add Songs opens; every 2 seconds while songs are still coming
//     and the page is open, every 30 seconds otherwise (another device of the
//     same profile may start one, or finish its songs);
//   - an answer that left before something was done here (a song finished,
//     the batch cancelled) is dropped: `seq` counts both;
//   - while a batch is open both Download buttons wait and the local buttons
//     are hidden, as for any import. The batch outlives the app: closing it
//     asks nothing, and the batch is back at the next start.

const ServerImport = {
  seq: 0,
  timer: 0,
  lastKey: '',

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
    $('serverDownloadBtn').hidden = !on;
    // The phone does not download itself: only the server's button. A computer
    // without yt-dlp shows its own greyed out (a click opens the legal note).
    $('downloadBtn').hidden = !computer || none;
    $('downloadBtn').classList.toggle('btn--off', computer && !DownloadsHelp.here);
    $('downloadBtn').textContent = on ? 'Download (Client)' : 'Download';
    const busy = ImportPanel.busy || ['probing', 'downloading', 'saving'].includes(AddPage.phase);
    $('serverDownloadBtn').disabled = busy;
  },

  /** Something was done to the batch here: answers that left before it are out of date. */
  touch() {
    this.seq += 1;
  },

  schedule() {
    clearTimeout(this.timer);
    if (!this.available) return;
    const coming = !!ImportPanel.server && (ImportPanel.state === 'listing' || ImportPanel.state === 'downloading');
    const fast = coming && Nav.page === 'add' && document.visibilityState === 'visible';
    this.timer = setTimeout(() => this.poll(), fast ? 2000 : 30000);
  },

  async poll() {
    clearTimeout(this.timer);
    // Out of reach: the batch is still on the server; the frames stay as they are.
    if (!this.available) return;
    const seq = ++this.seq;
    let batch;
    try {
      batch = await window.flow.serverDownloads('get');
    } catch {
      if (seq === this.seq) this.schedule();
      return;
    }
    if (seq !== this.seq) return;
    ImportPanel.syncServer(batch);
    this.schedule();
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
      AddPage._showError('Paste a link, or type the name of a song, into the box first.');
      $('linkInput').focus();
      return;
    }
    if (!pick && AddPage.isSearch(url)) {
      if (ImportPanel.busy) {
        AddPage._showError('An import is still open. Finish it or cancel it first.');
        return;
      }
      SongSearch.open(url, 'server');
      return;
    }
    if (!await AddPage._clearForNew()) return;
    let kind = pick ? 'song' : AddPage._linkKind(url);
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
    if (!await AddPage._clearForNew()) return;
    await this._create({ items: picks.map((r) => ({ url: r.url, title: r.title, duration: r.duration })), name });
  },

  /** A new batch on the server (remote.serverDownloads 'create'), shown in the frames. */
  async _create(args) {
    this.touch();
    $('serverDownloadBtn').disabled = true;
    let batch;
    try {
      batch = await window.flow.serverDownloads('create', { ...args, options: AddPage.downloadOptions() });
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
        batch = await window.flow.serverDownloads('retry', { index });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    this.touch();
    return batch;
  },
};
