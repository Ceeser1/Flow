'use strict';

// "Update from source" on an imported playlist's page. Its link is read again
// in the background: here when yt-dlp is in the tools folder, else by the
// Flow Server (its "downloadCheck" feature; one from before that gets the old
// Update on Add Songs, AddPage.updatePlaylist). Meanwhile the button is light
// blue with its icon turning, and the page stays where it is.
//
// Nothing changed: a toast says so. Otherwise a popup, closed only by X or
// its buttons, lists Added Songs (new in the source, or in the library but
// not in the playlist) and Removed Songs (in the playlist, no longer in the
// source), with "Keep songs removed from the playlist" and "Add new songs to
// the playlist", both ticked. Continue takes the removed ones out of the
// playlist when the first is unticked, and with the second opens Add Songs
// with the list read (not read a second time) as its checklist. Continue
// says what the ticks will do: "Continue (Adding: X, Removing: Y)", only
// the part that applies, or "Continue (no change)" (it then just closes).
//
// A playlist group's Update all (4.5, checkAll) reads each of its imported
// playlists in turn and shows their popups one after another.

const PlaylistUpdate = {
  checking: new Set(), // ids of the playlists whose link is being read

  isChecking(id) {
    return this.checking.has(id);
  },

  /** Where the link is read: 'client' (yt-dlp here), 'server', 'old' (a server without the check), or null. */
  _how() {
    if (Store.can('downloadHere') && DownloadsHelp.here) return 'client';
    if (ServerImport.available) return Store.server.downloadCheck ? 'server' : 'old';
    return null;
  },

  /** Reads one playlist's link again; resolves once its popup (if any) is closed. */
  async check(p) {
    const url = p && p.source && p.source.url;
    if (!url || this.checking.has(p.id)) return;
    const how = this._how();
    if (!how) {
      DownloadsHelp.open();
      return;
    }
    if (how === 'old') {
      AddPage.updatePlaylist(p);
      return;
    }
    toast(T('playlistUpdate.checking', { playlist: p.name }), 'info');
    const r = await this._read(p, how);
    if (r.state === 'same') toast(T('playlistUpdate.noChanges', { playlist: r.list.name }), 'info');
    if (r.state === 'changed') await this._ask(r.list, r.listing, how === 'server', r.changes);
  },

  /**
   * A group's Update all (4.5): its imported playlists read one after
   * another, each one's popup as its read is done (the next one read
   * meanwhile), one at a time. Those without changes are told at the end,
   * all in one.
   */
  async checkAll(group, lists) {
    if (!lists.length || this.groupsChecking.has(group.id)) return;
    const how = this._how();
    if (!how) {
      DownloadsHelp.open();
      return;
    }
    if (how === 'old') {
      toast(T('playlistUpdate.group.tooOld'), 'error');
      return;
    }
    this.groupsChecking.add(group.id);
    this._redraw();
    toast(T('playlistUpdate.group.checking', { group: group.name, playlists: Util.plural(lists.length, 'playlist') }), 'info');
    let popups = Promise.resolve();
    let same = 0;
    let changed = 0;
    try {
      for (const p of lists) {
        if (this.checking.has(p.id)) continue;
        const r = await this._read(p, how);
        if (r.state === 'same') same += 1;
        if (r.state === 'changed') {
          changed += 1;
          popups = popups.then(() => {
            // Changed or gone since its read: read again on its own.
            const now = Store.playlist(r.list.id);
            if (!now || !now.source || now.source.url !== r.list.source.url) return null;
            return this._ask(now, r.listing, how === 'server', this._changes(now, r.listing));
          });
        }
      }
    } finally {
      this.groupsChecking.delete(group.id);
      this._redraw();
    }
    await popups;
    if (!changed && same) toast(T('playlistUpdate.group.noChanges', { group: group.name }), 'info');
    else if (same) toast(T('playlistUpdate.group.someUnchanged', { group: group.name, playlists: Util.plural(same, 'playlist'), count: same }), 'info');
  },

  groupsChecking: new Set(), // ids of the groups whose Update all runs

  isGroupChecking(id) {
    return this.groupsChecking.has(id);
  },

  /**
   * Reads a playlist's link: { state: 'changed', list, listing, changes },
   * 'same' (nothing to change), or 'none' (failed, said why, or the playlist
   * gone or no longer from that link).
   */
  async _read(p, how) {
    const url = p.source.url;
    this.checking.add(p.id);
    this._redraw();
    let listing;
    try {
      listing = how === 'client' ? await window.flow.checkImport(url) : await window.flow.serverDownloads('check', { url });
    } catch (err) {
      toast(T('playlistUpdate.couldNotCheck', { playlist: p.name, reason: err.message }), 'error');
      return { state: 'none' };
    } finally {
      this.checking.delete(p.id);
      this._redraw();
    }
    // Deleted meanwhile, or no longer its source.
    const list = Store.playlist(p.id);
    if (!list || !list.source || list.source.url !== url) return { state: 'none' };
    if (listing.single) {
      toast(T('playlistUpdate.nowOneSong', { playlist: list.name }), 'error');
      return { state: 'none' };
    }
    const changes = this._changes(list, listing);
    if (!changes.added.length && !changes.removed.length) return { state: 'same', list };
    return {
      state: 'changed', list, listing, changes,
    };
  },

  _redraw() {
    if (Nav.page === 'playlist') PlaylistPage._drawUpdate();
    if (Nav.page === 'playlists') PlaylistsPage.render();
  },

  /**
   * added: the listing's songs the playlist lacks (new ones that can be
   * downloaded, and library songs). removed: the playlist's songs that none of
   * the source's is, unless the list was cut short (Spotify's first 100, ...).
   */
  _changes(list, listing) {
    const inList = new Set(list.entries.map((e) => e.songId));
    const added = listing.items.filter((it) => (it.existing ? !inList.has(it.existing.id) : it.status === 'ok'));
    const fromSource = new Set(listing.items.filter((it) => it.existing).map((it) => it.existing.id));
    const removed = listing.truncated ? []
      : [...inList].filter((id) => !fromSource.has(id)).map((id) => Store.song(id)).filter(Boolean);
    return { added, removed };
  },

  /** The popup of what changed; resolves once it is closed (and Continue has done its part). */
  _ask(list, listing, server, changes) {
    return new Promise((resolve) => this._askThen(list, listing, server, changes, resolve));
  },

  _askThen(list, listing, server, changes, resolve) {
    // Both lists by the songs' titles, A to Z.
    const titleOf = (it) => (it.existing || (it.meta && it.meta.title ? it.meta : null) || it).title || '';
    const byTitle = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    const added = [...changes.added].sort((a, b) => byTitle(titleOf(a), titleOf(b)));
    const removed = [...changes.removed].sort((a, b) => byTitle(a.title || '', b.title || ''));
    const column = (title, rows) => h('div.pl-update__col',
      h('div.pl-update__head', `${title} (${rows.length})`),
      h('ul.pl-update__list', rows.length ? rows : h('li.pl-update__empty', T('playlistUpdate.none'))));
    const addedRows = added.map((it) => {
      const line = it.existing ? Util.songLine(it.existing) : (it.meta && it.meta.title ? Util.songLine(it.meta) : it.title);
      return h('li.pl-update__row', { title: line },
        h('span.pl-update__name', line),
        it.existing ? h('span.pl-update__note', T('common.inLibrary')) : null);
    });
    const removedRows = removed.map((s) => h('li.pl-update__row', { title: Util.songLine(s) }, h('span.pl-update__name', Util.songLine(s))));
    const keep = h('input', { type: 'checkbox', checked: true });
    const add = h('input', { type: 'checkbox', checked: true });
    let go = null;
    const handle = Modal.open({
      title: T('playlistUpdate.title', { playlist: list.name }),
      className: 'modal--pl-update',
      sticky: true,
      body: [
        h('div.pl-update__lists', column(T('common.addedSongs'), addedRows), column(T('playlistUpdate.column.removed'), removedRows)),
        h('div.pl-update__checks',
          h('label.check', keep, h('span', T('playlistUpdate.keepRemoved'))),
          h('label.check', add, h('span', T('playlistUpdate.addNew')))),
      ],
      buttons: [
        { label: T('playlistUpdate.cancel') },
        {
          label: T('playlistUpdate.continue.none'),
          kind: 'primary',
          onClick: () => {
            go = { keep: keep.checked, add: add.checked };
            return true;
          },
        },
      ],
      onClose: () => {
        if (!go) {
          resolve();
          return;
        }
        this._continue(list, listing, server, changes, go).then(resolve, resolve);
      },
    });
    // Continue says what the ticks will change.
    const cont = handle.el.querySelector('.modal__footer .btn--primary');
    const draw = () => {
      const adding = add.checked ? added.length : 0;
      const removing = keep.checked ? 0 : removed.length;
      let text = 'playlistUpdate.continue.none';
      if (adding && removing) text = 'playlistUpdate.continue.both';
      else if (adding) text = 'playlistUpdate.continue.adding';
      else if (removing) text = 'playlistUpdate.continue.removing';
      cont.textContent = T(text, { added: adding, removed: removing });
    };
    keep.addEventListener('change', draw);
    add.addEventListener('change', draw);
    draw();
  },

  async _continue(list, listing, server, changes, go) {
    if (!go.keep && changes.removed.length) {
      let done = 0;
      try {
        for (const s of changes.removed) {
          await window.flow.removeFromPlaylist(list.id, s.id);
          done += 1;
        }
        toast(T('playlistUpdate.removed', { songs: Util.plural(done, 'song'), playlist: list.name }), 'success');
      } catch (err) {
        toast(done ? T('playlistUpdate.removedThenFailed', { songs: Util.plural(done, 'song'), playlist: list.name, reason: err.message }) : err.message, 'error');
      }
    }
    if (!go.add || !changes.added.length) return;
    Nav.show('add');
    // Its checklist at its turn, as any link's (Client queue).
    const p = Store.playlist(list.id);
    if (p) ClientQueue.offer({ url: p.source.url, kind: 'update', update: { playlist: { id: p.id, name: p.name }, listing, server } });
  },
};
