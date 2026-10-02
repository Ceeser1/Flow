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

  /** "Download (Client)" and "Download (Server)", or the one Download without such a server. */
  drawButtons() {
    const on = this.available;
    $('serverDownloadBtn').hidden = !on;
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

  /** Download (Server): the link in the box goes to the server. */
  async start() {
    if (!this.available) return;
    const url = $('linkInput').value.trim();
    if (!url) {
      AddPage._showError('Paste a link into the box first.');
      $('linkInput').focus();
      return;
    }
    if (ImportPanel.busy) {
      AddPage._showError('An import is still open. Finish it or cancel it first.');
      return;
    }
    if (AddPage.editorReady) {
      const ok = await confirmDialog({
        title: 'Discard current song?',
        message: 'The song in the editor has not been saved yet. Download the new link and discard it?',
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    if (ImportPanel.state === 'review') ImportPanel.close();
    AddPage._discard();
    $('progressPanel').hidden = true;
    let kind = AddPage._linkKind(url);
    if (kind === 'ask') {
      kind = await AddPage._askSongOrList(url);
      if (!kind) return;
    }
    this.touch();
    $('serverDownloadBtn').disabled = true;
    let batch;
    try {
      batch = await window.flow.serverDownloads('create', { url, kind, options: AddPage.downloadOptions() });
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

  /** "Try again" on a song that failed. */
  async retry(index) {
    this.touch();
    try {
      ImportPanel.syncServer(await window.flow.serverDownloads('retry', { index }));
    } catch (err) {
      toast(err.message, 'error');
    }
    this.schedule();
  },
};
