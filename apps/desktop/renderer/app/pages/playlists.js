'use strict';

// Playlists: create one at the top, "Your Playlists" below. All Songs and the
// three Listen behaviour lists are always the first rows, whatever the sort,
// and have no actions.

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
    Store.onLibrary(() => {
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
    const rows = [...Store.builtInPlaylists(), ...lists];
    $('playlistsCount').textContent = `${Util.plural(Store.library.playlists.length + 1, 'playlist')}`;

    // Clearing the table takes the rename box out, which blurs it, and a blur
    // must not start another redraw in the middle of this one.
    this._drawing = true;
    try {
      this._drawTable(rows);
    } finally {
      this._drawing = false;
    }

    const input = document.querySelector('#playlistsTable .rename-input');
    if (input) {
      input.focus();
      input.select();
    }
  },

  _drawTable(rows) {
    renderTable($('playlistsTable'), {
      rows,
      sort: this.sort,
      rowKey: (p) => p.id,
      rowClass: (p) => (p.isAll || p.isFavourites || p.isSmart ? 'row--pinned' : ''),
      onSort: (key) => {
        this.sort = Util.cycleSort(this.sort, key);
        this.render();
      },
      onRowDblClick: (p) => Nav.openPlaylist(p.id),
      columns: [
        { key: 'name', label: 'Name', cls: 'col-name', render: (p) => this._nameCell(p) },
        { key: 'songs', label: 'Songs', cls: 'col-num', render: (p) => String(p.entries.length) },
        { key: 'duration', label: 'Duration', cls: 'col-num', render: (p) => Util.fmtClock(Store.totalDuration(p.id)) },
        { key: 'actions', label: 'Actions', sortable: false, cls: 'col-actions', render: (p) => this._actions(p) },
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
      h('span', p.name));
  },

  _actions(p) {
    if (p.isAll || p.isFavourites || p.isSmart) return h('span.muted', '');
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
