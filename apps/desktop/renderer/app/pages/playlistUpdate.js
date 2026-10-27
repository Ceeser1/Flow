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
// with the list read (not read a second time) as its checklist.

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
    this.checking.add(p.id);
    this._redraw();
    toast(`Checking for Updates on ${p.name}...`, 'info');
    let listing;
    try {
      listing = how === 'client' ? await window.flow.checkImport(url) : await window.flow.serverDownloads('check', { url });
    } catch (err) {
      toast(`"${p.name}" could not be checked: ${err.message}`, 'error');
      return;
    } finally {
      this.checking.delete(p.id);
      this._redraw();
    }
    // Deleted meanwhile, or no longer its source.
    const list = Store.playlist(p.id);
    if (!list || !list.source || list.source.url !== url) return;
    if (listing.single) {
      toast(`The link of "${list.name}" leads to one song now, not to a playlist.`, 'error');
      return;
    }
    const changes = this._changes(list, listing);
    if (!changes.added.length && !changes.removed.length) {
      toast(`No changes to ${list.name} found.`, 'info');
      return;
    }
    this._ask(list, listing, how === 'server', changes);
  },

  _redraw() {
    if (Nav.page === 'playlist') PlaylistPage._drawUpdate();
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

  _ask(list, listing, server, changes) {
    // Both lists by the songs' titles, A to Z.
    const titleOf = (it) => (it.existing || (it.meta && it.meta.title ? it.meta : null) || it).title || '';
    const byTitle = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
    const added = [...changes.added].sort((a, b) => byTitle(titleOf(a), titleOf(b)));
    const removed = [...changes.removed].sort((a, b) => byTitle(a.title || '', b.title || ''));
    const column = (title, rows) => h('div.pl-update__col',
      h('div.pl-update__head', `${title} (${rows.length})`),
      h('ul.pl-update__list', rows.length ? rows : h('li.pl-update__empty', 'None')));
    const addedRows = added.map((it) => {
      const line = it.existing ? Util.songLine(it.existing) : (it.meta && it.meta.title ? Util.songLine(it.meta) : it.title);
      return h('li.pl-update__row', { title: line },
        h('span.pl-update__name', line),
        it.existing ? h('span.pl-update__note', 'in your library') : null);
    });
    const removedRows = removed.map((s) => h('li.pl-update__row', { title: Util.songLine(s) }, h('span.pl-update__name', Util.songLine(s))));
    const keep = h('input', { type: 'checkbox', checked: true });
    const add = h('input', { type: 'checkbox', checked: true });
    let go = null;
    const handle = Modal.open({
      title: `Updates for "${list.name}"`,
      className: 'modal--pl-update',
      sticky: true,
      body: [
        h('div.pl-update__lists', column('Added Songs', addedRows), column('Removed Songs', removedRows)),
        h('div.pl-update__checks',
          h('label.check', keep, h('span', 'Keep songs removed from the playlist')),
          h('label.check', add, h('span', 'Add new songs to the playlist'))),
      ],
      buttons: [
        { label: 'Cancel Playlist Update' },
        {
          label: 'Continue',
          kind: 'primary',
          onClick: () => {
            if (add.checked && added.length && ImportPanel.busy) {
              toast('A playlist import is still open on Add Songs. Finish it ("Finish all") or cancel it first.', 'error');
              return false;
            }
            go = { keep: keep.checked, add: add.checked };
            return true;
          },
        },
      ],
      onClose: () => {
        if (go) this._continue(list, listing, server, changes, go);
      },
    });
    // Continue only while it would do something.
    const cont = handle.el.querySelector('.modal__footer .btn--primary');
    const draw = () => {
      cont.disabled = (keep.checked || !removed.length) && (!add.checked || !added.length);
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
        toast(`${Util.plural(done, 'song')} removed from "${list.name}".`, 'success');
      } catch (err) {
        toast(`${done ? `${Util.plural(done, 'song')} removed from "${list.name}", then: ` : ''}${err.message}`, 'error');
      }
    }
    if (!go.add || !changes.added.length) return;
    Nav.show('add');
    if (!await AddPage._clearForNew()) return;
    const p = Store.playlist(list.id);
    if (p) ImportPanel.openUpdate(p, listing, server);
  },
};
