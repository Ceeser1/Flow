'use strict';

// Settings > Local Files: saved songs, covers, lyrics, backups, storage and the music folder (a part of SettingsPanel, settingsPanel.js).

extend(SettingsPanel, {
  // ---- Local Files ----

  _savedSongsRow() {
    this._statsNode = h('span.settings__note', '...');
    this._pathNode = h('div.settings__desc.settings__path');
    const open = h('button.btn.btn--small', { type: 'button', onclick: () => this._openFolder() }, T('settings.localFiles.open'));
    const change = h('button.btn.btn--small', { type: 'button', onclick: () => this._changeFolder(change) }, T('common.change'));
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', T('common.localFiles')),
      h('div.settings__desc', T('settings.localFiles.desc')),
      this._pathNode);
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', this._statsNode, open, change)));
  },

  async _drawStats() {
    // No Local Files row where the folder is not the user's to see (the phone).
    if (!Store.can('musicFolder')) return;
    this._pathNode.textContent = T('settings.localFiles.location', { folder: Store.musicDir });
    this._pathNode.title = Store.musicDir;
    try {
      const st = await window.flow.folderStats();
      Store.musicDir = st.dir;
      this._pathNode.textContent = T('settings.localFiles.location', { folder: st.dir });
      this._pathNode.title = st.dir;
      this._statsNode.textContent = `${Util.plural(st.count, 'song')} · ${fmtBytes(st.bytes)}`;
    } catch {
      this._statsNode.textContent = '';
    }
  },

  /**
   * Covers (4.3.1): whether a server's thumbnails are fetched for the lists,
   * the thumbnails kept here and the room they take (with a server: the
   * servers' ones, which can be cleared; they come again as lists are
   * scrolled).
   */
  _coversRow() {
    this._coversNode = h('span.settings__note');
    this._clearCovers = h('button.btn.btn--small', {
      type: 'button',
      title: T('settings.coverCache.clear.tooltip'),
      onclick: () => attempt(async () => {
        await window.flow.clearCoverCache('small');
        toast(T('settings.coverCache.cleared'), 'success');
        this._drawCovers();
      }),
    }, T('settings.coverCache.clear'));
    const row = this._row({
      key: 'thumbCovers',
      label: T('settings.coverCache.heading'),
      desc: T('settings.coverCache.desc'),
      right: h('div.settings__control', this._coversNode, this._clearCovers),
    });
    // Unticked, its Clear button still looks and works as it is.
    row.classList.add('settings__row--btns');
    return row;
  },

  /**
   * "Download high resolution covers (512px)", a setting of its own (4.3.1):
   * off, only those kept already are shown. Its big covers kept here, and
   * "Clear big cover cache" for the servers' (no question: they are only
   * fetched again when shown). The web player keeps none: the tick alone.
   */
  _highResRow(keeps) {
    this._bigNode = keeps ? h('span.settings__note') : null;
    this._clearBig = keeps ? h('button.btn.btn--small', {
      type: 'button',
      title: T('settings.coverCache.highRes.clear.tooltip'),
      onclick: () => attempt(async () => {
        await window.flow.clearCoverCache('big');
        Covers.refresh(null);
        toast(T('settings.coverCache.highRes.cleared'), 'success');
        this._drawCovers();
      }),
    }, T('settings.coverCache.highRes.clear')) : null;
    const row = this._row({
      key: 'highResCovers',
      label: T('settings.coverCache.highRes.label'),
      desc: T('settings.coverCache.highRes.desc'),
      right: keeps ? h('div.settings__control', this._bigNode, this._clearBig) : null,
    });
    row.classList.add('settings__row--btns');
    return row;
  },

  /**
   * Lyrics (4.0): how many the Lyrics folder keeps and the room they take,
   * under Fetch/Sync Lyrics. Clearing leaves those written in Flow for Local
   * Files songs; a server's come down again.
   */
  _lyricsRow() {
    this._lyricsNode = h('span.settings__note');
    const clearBtn = h('button.btn.btn--small', {
      type: 'button',
      title: T('settings.lyricsCache.clear.tooltip'),
      onclick: () => attempt(async () => {
        await window.flow.clearLyricsCache();
        toast(T('settings.lyricsCache.cleared'), 'success');
        Lyrics.forgetAll();
        this._drawLyrics();
      }),
    }, T('settings.lyricsCache.clear'));
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', T('settings.lyricsCache.heading')),
      h('div.settings__desc', T('settings.lyricsCache.desc')));
    const row = h('div.settings__row.settings__row--sub', left, h('div.settings__right', h('div.settings__control', this._lyricsNode, clearBtn)));
    // Greyed out under Fetch/Sync Lyrics unticked, Clear lyrics cache still there to click.
    this._refresh.push(() => row.classList.toggle('settings__row--dim', Store.settings.lyricsOn === false));
    return row;
  },

  async _drawLyrics() {
    if (!this._lyricsNode) return;
    try {
      const st = await window.flow.lyricsStats();
      if (!this._lyricsNode) return;
      // How many, the room they take, and while every song's are looked up, how many still are.
      this._lyricsNode.textContent = st.left ? T('settings.lyricsCache.size.lookingUp', { count: st.count, size: fmtBytes(st.bytes), left: st.left })
        : T('settings.lyricsCache.size', { count: st.count, size: fmtBytes(st.bytes) });
      this._lyricsNode.title = st.none ? T('settings.lyricsCache.noneFound.tooltip', { songs: Util.plural(st.none, 'song') }) : '';
    } catch {
      this._lyricsNode.textContent = '';
    }
  },

  /**
   * Backups of this computer's library (4.0): made once a week, the last 6
   * kept; one picked is put back. A Flow Server backs up its own library
   * (Administration).
   */
  _backupsRow() {
    const pick = h('select.select');
    const restore = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => attempt(async () => {
        const b = this._backupList.find((x) => x.name === pick.value);
        if (!b) return;
        const ok = await confirmDialog({
          title: T('common.restoreBackup'),
          message: T('settings.backups.restore.text', { date: Util.fmtDate(b.createdAt) }),
          confirmLabel: T('common.restore'),
          kind: 'light-red',
        });
        if (!ok) return;
        const r = await window.flow.restoreBackup(b.name);
        toast(r.missing ? T('settings.backups.restored.someMissing', { songs: Util.plural(r.songs, 'song'), missing: r.missing })
          : T('settings.backups.restored', { songs: Util.plural(r.songs, 'song') }), 'success');
        this._drawBackups();
      }),
    }, T('common.restore'));
    const make = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => attempt(async () => {
        await window.flow.makeBackup();
        toast(T('common.backupMade'), 'success');
        this._drawBackups();
      }),
    }, T('common.backUpNow'));
    this._backupList = [];
    this._backupPick = pick;
    this._backupRestore = restore;
    this._drawBackups();
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', T('common.backups')),
      h('div.settings__desc', T('settings.backups.desc')));
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', pick, restore, make)));
  },

  async _drawBackups() {
    const list = await window.flow.backups().catch(() => []);
    const why = { manual: 'settings.backups.entry.byHand', restore: 'settings.backups.entry.beforeRestore' };
    this._backupList = list;
    clear(this._backupPick).append(...(list.length
      ? list.map((b) => { const date = Util.fmtDate(b.createdAt); return h('option', { value: b.name }, why[b.reason] ? T(why[b.reason], { date }) : date); })
      : [h('option', { value: '' }, T('common.noBackups'))]));
    this._backupPick.disabled = !list.length;
    this._backupRestore.disabled = !list.length;
  },

  /** The phone's songs and their room; Remove downloads deletes the server's songs kept here. */
  _storageRow() {
    this._storageNode = h('span.settings__note');
    this._removeDownloads = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => this._removeAllDownloads(),
    }, T('settings.songStorage.removeDownloads'));
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', T('settings.songStorage.heading')),
      h('div.settings__desc', T('settings.songStorage.desc')));
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', this._storageNode, this._removeDownloads)));
  },

  async _drawStorage() {
    if (!this._storageNode || !window.flow.storageStats) return;
    try {
      const st = await window.flow.storageStats();
      if (!this._storageNode) return;
      const parts = [`${Util.plural(st.songs, 'song')} · ${fmtBytes(st.bytes)}`];
      if (st.downloaded && st.downloaded < st.songs) parts.push(T('settings.songStorage.stats.downloaded', { count: st.downloaded }));
      this._storageNode.textContent = parts.join(', ');
      this._removeDownloads.hidden = !Store.server.on || !(st.downloaded || (Store.server.offline || []).length);
    } catch {
      this._storageNode.textContent = '';
    }
  },

  async _removeAllDownloads() {
    const ok = await confirmDialog({
      title: T('settings.songStorage.removeDownloads.title'),
      message: T('settings.songStorage.removeDownloads.text'),
      confirmLabel: T('common.remove'),
      danger: true,
    });
    if (!ok) return;
    await attempt(async () => {
      const r = await window.flow.removeAllDownloads();
      toast(r.inUse ? T('settings.songStorage.removed.someLater', { songs: Util.plural(r.removed, 'song'), inUse: r.inUse, count: r.inUse })
        : T('settings.songStorage.removed', { songs: Util.plural(r.removed, 'song') }), 'success');
    });
    this._drawStorage();
  },

  async _drawCovers() {
    if (!this._coversNode) return;
    this._clearCovers.hidden = !Store.server.on;
    if (this._clearBig) this._clearBig.hidden = !Store.server.on;
    try {
      const st = await window.flow.coverStats();
      const here = Store.server.on ? st.server : st.local;
      if (!here || !this._coversNode) return;
      const line = (n) => (n ? `${Util.plural(n.count, 'cover')} · ${fmtBytes(n.bytes)}` : '');
      this._coversNode.textContent = line(here.small);
      if (this._bigNode) this._bigNode.textContent = line(here.big);
    } catch {
      this._coversNode.textContent = '';
      if (this._bigNode) this._bigNode.textContent = '';
    }
  },

  _drawMeasured() {
    if (!this._measuredNode) return;
    const songs = Store.library.songs;
    const done = songs.filter((s) => s.loudness !== null && s.loudness !== undefined).length;
    this._measuredNode.textContent = !songs.length ? ''
      : done >= songs.length ? (songs.length === 1 ? T('settings.general.equalizeVolume.measured.one') : T('settings.general.equalizeVolume.measured.all', { count: songs.length }))
        // With a server, songs only streamed are measured by the server (with ffmpeg).
        : `${T('settings.general.equalizeVolume.measured.progress', { done, total: songs.length })}${Store.settings.normalize && !Store.server.on && Store.can('measureLoudness') ? '...' : ''}`;
  },

  _openFolder() {
    return attempt(async () => {
      // Resolves to an error message, or '' once Explorer has it.
      const problem = await window.flow.openMusicFolder();
      if (problem) toast(T('settings.localFiles.openFailed', { folder: Store.musicDir, problem }), 'error');
    });
  },

  /**
   * Change: pick a folder, confirm, then move every song file there. The song
   * playing is let go of for the move and picked up again after.
   */
  async _changeFolder(button) {
    let dir;
    try {
      dir = await window.flow.chooseFolder();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!dir) return;
    const count = Store.library.songs.length;
    const ok = await confirmDialog({
      title: T('settings.localFiles.move.title'),
      message: T(count === 1 ? 'settings.localFiles.move.text.one' : 'settings.localFiles.move.text.many', { folder: dir, count, oldFolder: Store.musicDir }),
      confirmLabel: T('settings.localFiles.move.confirm'),
    });
    if (!ok) return;

    button.disabled = true;
    const token = Player.currentId ? Player.release(Player.currentId) : null;
    this._onProgress = ({ done, total }) => {
      if (this._statsNode) this._statsNode.textContent = total ? T('settings.localFiles.move.progress', { done, total }) : T('settings.localFiles.move.moving');
    };
    try {
      const result = await window.flow.moveMusicFolder(dir);
      Store.musicDir = result.dir;
      Store.settings.musicDir = result.dir;
      if (result.failed.length) {
        toast(T('settings.localFiles.move.partly', { songs: Util.plural(result.moved, 'song'), failed: result.failed.length, count: result.failed.length, reason: result.failed[0].reason }), 'error');
      } else {
        toast(T('settings.localFiles.move.done', { songs: Util.plural(result.moved, 'song'), folder: result.dir }), 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      this._onProgress = null;
      button.disabled = false;
      if (token) Player.resume(token);
      if (this.modal) this._drawStats();
    }
  },
});
