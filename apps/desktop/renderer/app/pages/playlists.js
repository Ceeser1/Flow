'use strict';

// Playlists: create one at the top; "Shared Playlists" (All Songs, and the
// playlists other profiles share, which can be followed or not; the section
// can be closed, All Songs stays); "Your Playlists" below. Favourites and the
// Listen behaviour lists are always the first rows of those, whatever
// the sort, and have no actions.

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
    return '';
  },

  render() {
    const lists = Util.sortRows(Store.sortedPlaylists(), this.sort, (p, k) => this._value(p, k));
    // Favourites, then Listen behaviour (closed until opened) with its lists under it.
    const listenOpen = Store.settings.listenPageOpen === true;
    const rows = [
      Store.favouritesPlaylist(),
      { id: 'listen-group', name: 'Listen behaviour', entries: [], isListenGroup: true },
      ...(listenOpen ? Store.smartPlaylists() : []),
      ...lists,
    ];
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
      rowClass: (p) => (p.isAll || p.isFavourites || p.isSmart || p.isListenGroup ? 'row--pinned' : ''),
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      onRowDblClick: (p) => (p.isListenGroup ? this._toggleListen() : Nav.openPlaylist(p.id)),
      columns: [
        { key: 'name', label: 'Name', cls: 'col-name', render: (p) => this._nameCell(p) },
        { key: 'songs', label: 'Songs', cls: 'col-num', render: (p) => (p.isListenGroup ? '' : String(p.entries.length)) },
        { key: 'duration', label: 'Duration', cls: 'col-num', render: (p) => (p.isListenGroup ? '' : Util.fmtClock(Store.totalDuration(p.id))) },
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
    if (p.isListenGroup) {
      // Opens and closes; its lists share its icon.
      const open = Store.settings.listenPageOpen === true;
      return h('button.link-cell', {
        type: 'button',
        title: open ? 'Hide these lists' : 'Show these lists',
        'aria-expanded': String(open),
        onclick: () => this._toggleListen(),
      },
      h('span.link-cell__chevron' + (open ? '.link-cell__chevron--open' : ''), { html: Icons.chevron }),
      h('span.link-cell__icon', { html: Icons.pulse }),
      h('span', p.name));
    }
    return h('button.link-cell' + (p.isSmart ? '.link-cell--nested' : ''), { type: 'button', onclick: () => Nav.openPlaylist(p.id) },
      h('span.link-cell__icon', { html: listIcon(p) }),
      h('span.link-cell__name', p.name),
      p.ownerName ? h('span.link-cell__by', `by ${p.ownerName}`) : null);
  },

  _toggleListen() {
    Store.saveSettings({ listenPageOpen: Store.settings.listenPageOpen !== true });
    this.render();
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
    if (p.isFavourites || p.isSmart || p.isListenGroup) return h('span.muted', '');
    return h('div.actions',
      iconButton('act.act--green', Icons.plus, 'Add Songs', () => Nav.openPlaylist('all', { pickFor: p.id })),
      iconButton('act.act--grey', Icons.pencil, 'Rename', () => {
        this.renaming = p.id;
        this.render();
      }),
      iconButton('act.act--red', Icons.x, 'Delete', () => this.remove(p)));
  },

  async remove(p) {
    const ok = await confirmDialog({
      title: 'Delete playlist',
      message: `Delete the playlist "${p.name}"? The songs stay in All Songs.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await attempt(async () => {
      await window.flow.deletePlaylist(p.id);
      toast(`Playlist "${p.name}" deleted`, 'success');
    });
  },
};
