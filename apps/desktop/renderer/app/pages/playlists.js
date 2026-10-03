'use strict';

// Playlists: create one at the top; both tables also show when each was created
// and how long you have listened to it; "Shared Playlists" (All Songs, and the
// playlists other profiles share, which can be followed or not; the section
// can be closed, All Songs stays); "Your Playlists" below. Favourites is
// always the first row of those, whatever the sort, and has no actions. The
// listening trend lists have their own page (trend.js).

const PlaylistsPage = {
  sort: { key: null, dir: null },
  renaming: null, // id of the row being renamed
  _drawing: false,

  init() {
    const box = $('newPlaylistName');
    $('newPlaylistBtn').onclick = () => this.create();
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.create();
    });
    box.addEventListener('input', () => {
      $('newPlaylistError').textContent = '';
    });
    $('sharedHead').onclick = () => {
      Store.saveSettings({ sharedGroupOpen: Store.settings.sharedGroupOpen === false });
      this.render();
    };
    Store.onLibrary(() => {
      if (Nav.page === 'playlists') this.render();
    });
    Store.onServer(() => {
      if (Nav.page === 'playlists') this.render();
    });
  },

  show() {
    this.renaming = null;
    this.render();
  },

  async create() {
    const box = $('newPlaylistName');
    try {
      const p = await window.flow.createPlaylist(box.value);
      box.value = '';
      $('newPlaylistError').textContent = '';
      toast(`Playlist "${p.name}" created`, 'success');
    } catch (err) {
      $('newPlaylistError').textContent = err.message;
      box.focus();
    }
  },

  _value(p, key) {
    if (key === 'name') return p.name;
    if (key === 'songs') return p.entries.length;
    if (key === 'duration') return Store.totalDuration(p.id);
    if (key === 'created') return p.createdAt || 0;
    if (key === 'listened') return Store.listenedTo(p.id);
    return '';
  },

  render() {
    const lists = Util.sortRows(Store.sortedPlaylists(), this.sort, (p, k) => this._value(p, k));
    const rows = [Store.favouritesPlaylist(), ...lists];
    $('playlistsCount').textContent = Util.plural(Store.library.playlists.length, 'playlist');

    // Shared Playlists: All Songs always, the shared ones only while open.
    const open = Store.settings.sharedGroupOpen !== false;
    const shared = Util.sortRows(Store.sharedPlaylists(), this.sort, (p, k) => this._value(p, k));
    const sharedRows = [Store.allSongsPlaylist(), ...(open ? shared : [])];
    $('sharedHead').className = `section-head__btn${open ? ' section-head__btn--open' : ''}`;
    $('sharedHead').setAttribute('aria-expanded', String(open));
    $('sharedHead').title = open ? 'Hide the shared playlists' : 'Show the shared playlists';
    clear($('sharedHead')).append(h('span.menu__chevron', { html: Icons.chevron }), h('span', 'Shared Playlists'));
    $('sharedCount').textContent = Store.canShare() ? Util.plural(shared.length, 'shared playlist') : '';

    // Clearing the table takes the rename box out, which blurs it, and a blur
    // must not start another redraw in the middle of this one.
    this._drawing = true;
    try {
      this._drawTable($('sharedTable'), sharedRows, (p) => this._sharedActions(p));
      this._drawTable($('playlistsTable'), rows, (p) => this._actions(p));
    } finally {
      this._drawing = false;
    }

    const input = document.querySelector('#playlistsTable .rename-input');
    if (input) {
      input.focus();
      input.select();
    }
  },

  _drawTable(table, rows, actions) {
    renderTable(table, {
      rows,
      sort: this.sort,
      rowKey: (p) => p.id,
      rowClass: (p) => (p.isAll || p.isFavourites ? 'row--pinned' : ''),
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      onRowDblClick: (p) => Nav.openPlaylist(p.id),
      columns: [
        { key: 'name', label: 'Name', cls: 'col-name', render: (p) => this._nameCell(p) },
        { key: 'songs', label: 'Songs', cls: 'col-num', render: (p) => String(p.entries.length) },
        { key: 'duration', label: 'Duration', cls: 'col-num', render: (p) => Util.fmtClock(Store.totalDuration(p.id)) },
        // Listen Duration: your own time listening to it, as the list playing.
        // Created: the lists the app keeps itself have no date.
        { key: 'listened', label: 'Listen Duration', cls: 'col-listened', render: (p) => Util.fmtClock(Store.listenedTo(p.id)) },
        { key: 'created', label: 'Created', cls: 'col-date', render: (p) => (p.createdAt ? Util.fmtDate(p.createdAt) : '') },
        { key: 'actions', label: 'Actions', sortable: false, cls: 'col-actions', render: actions },
      ],
    });
  },

  _nameCell(p) {
    if (this.renaming === p.id) {
      const input = h('input.input.rename-input', { type: 'text', value: p.name, maxLength: 80 });
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        const name = input.value;
        this.renaming = null;
        if (save && name.trim() !== p.name) {
          try {
            await window.flow.renamePlaylist(p.id, name);
          } catch (err) {
            toast(err.message, 'error');
            this.renaming = p.id;
          }
        }
        this.render();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(false);
        }
      });
      input.addEventListener('blur', () => {
        if (!this._drawing) finish(true);
      });
      return input;
    }
    return h('button.link-cell', { type: 'button', onclick: () => Nav.openPlaylist(p.id) },
      h('span.link-cell__icon', { html: listIcon(p) }),
      h('span.link-cell__name', p.name),
      p.ownerName ? h('span.link-cell__by', `by ${p.ownerName}`) : null);
  },

  /**
   * A shared playlist can only be changed by whoever shared it, so its Actions
   * are Follow and Unfollow. All Songs has none.
   */
  _sharedActions(p) {
    if (p.isAll) return h('span.muted', '');
    const on = Store.isFollowing(p.id);
    return h('div.actions', h('button.btn.btn--small' + (on ? '' : '.btn--primary'), {
      type: 'button',
      title: on ? `Stop following "${p.name}"` : `Follow "${p.name}": it shows in the menu`,
      onclick: () => attempt(() => window.flow.setFollowing(p.id, !on)),
    }, on ? 'Unfollow' : 'Follow'));
  },

  _actions(p) {
    if (p.isFavourites) return h('span.muted', '');
    return h('div.actions',
      iconButton('act.act--green', Icons.plus, 'Add Songs', () => Nav.openPlaylist('all', { pickFor: p.id })),
      iconButton('act.act--grey', Icons.pencil, 'Rename', () => {
        this.renaming = p.id;
        this.render();
      }),
      iconButton('act.act--red', Icons.x, 'Delete', () => this.remove(p)));
  },

  async remove(p) {
    const answer = await confirmDialog({
      title: 'Delete playlist',
      message: `Do you really want to delete the playlist "${p.name}"?`,
      confirmLabel: 'Delete',
      danger: true,
      checkbox: { label: 'Also delete all songs that exist only in this playlist', checked: false },
    });
    if (!answer) return;
    const withSongs = !!answer.checked;
    await attempt(async () => {
      const r = await window.flow.deletePlaylist(p.id, withSongs);
      let text = `Playlist "${p.name}" deleted`;
      if (withSongs && !r) text += '. Its songs in no other playlist are deleted on the server.';
      else if (withSongs) {
        text += r.deleted ? `, and ${Util.plural(r.deleted, 'song')} only in it` : '. It had no songs only in it';
        if (r.kept) text += `. ${Util.plural(r.kept, 'song')} could not be deleted (in use) and stayed`;
      }
      toast(text, 'success');
    });
  },
};
