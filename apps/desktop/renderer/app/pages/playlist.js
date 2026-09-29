'use strict';

// One playlist's page (All Songs and Favourites included): name, totals, Shuffle and Play,
// a search box, and the songs. Each list remembers its own search and sort
// while the app runs, and the player follows the list exactly as shown.
//
// "Adding songs to" mode: the + on a row of the Playlists page opens All Songs
// with `pickFor` set, and every row's + then adds straight to that list.

const PlaylistPage = {
  id: null,
  pickFor: null,
  views: new Map(), // playlist id -> { filter, sort }
  _playButtons: new Map(),

  init() {
    $('plSearchIcon').innerHTML = Icons.search;
    $('plSearch').addEventListener('input', () => {
      this._view(this.id).filter = $('plSearch').value;
      this.renderTable();
    });
    $('plSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('plSearch').value) {
        e.stopPropagation();
        $('plSearch').value = '';
        this._view(this.id).filter = '';
        this.renderTable();
      }
    });
    $('plShuffle').onclick = () => Player.setShuffle(!Player.queue.shuffle);
    $('plPlay').onclick = () => Player.togglePlaylist(this.id);
    $('plOffline').onclick = () => {
      const on = !Store.isOffline(this.id);
      attempt(() => window.flow.setOffline(this.id, on));
    };
    Store.onServer(() => {
      if (Nav.page === 'playlist') this._drawOffline();
    });
    $('plPickDone').onclick = () => {
      const target = this.pickFor;
      this.pickFor = null;
      Nav.openPlaylist(Store.playlist(target) ? target : 'all');
    };
    $('plEmptyAction').onclick = () => {
      if (this.id === 'all') Nav.show('add');
      else Nav.openPlaylist('all', { pickFor: this.id });
    };

    new ResizeObserver(() => this._sizeColumns()).observe($('plTableWrap'));

    Player.orderOf = (contextId) => this.orderedIds(contextId);
    Store.onLibrary(() => {
      if (Nav.page !== 'playlist') return;
      if (!Store.playlist(this.id)) {
        Nav.openPlaylist('all');
        return;
      }
      if (this.pickFor && !Store.playlist(this.pickFor)) this.pickFor = null;
      this.render();
    });
    Player.onChange(() => {
      if (Nav.page === 'playlist') this._drawPlayState();
    });
  },

  _view(id) {
    if (!this.views.has(id)) this.views.set(id, { filter: '', sort: { key: null, dir: null } });
    return this.views.get(id);
  },

  show(id, opts = {}) {
    this.id = id;
    this.pickFor = id === 'all' && opts.pickFor && Store.playlist(opts.pickFor) ? opts.pickFor : null;
    if (opts.filter !== undefined) this._view(id).filter = opts.filter;
    $('plSearch').value = this._view(id).filter;
    this.render();
  },

  _sortValue(row, key) {
    const s = row.song;
    if (key === 'title') return s.title;
    if (key === 'artist') return s.artist;
    if (key === 'mix') return s.mix;
    if (key === 'duration') return s.duration || 0;
    if (key === 'added') return row.addedAt;
    return '';
  },

  /**
   * A list's rows as shown: newest first unless sorted, then the search. The
   * Listen behaviour lists keep their own order, best match first.
   */
  rowsFor(id) {
    const view = this._view(id);
    let rows = Store.rowsOf(id)
      .filter((r) => Util.matches(view.filter, r.song.title, r.song.artist, r.song.mix));
    if (!SmartLists.isSmart(id)) rows = rows.sort((a, b) => b.addedAt - a.addedAt);
    return Util.sortRows(rows, view.sort, (r, k) => this._sortValue(r, k));
  },

  orderedIds(id) {
    return this.rowsFor(id).map((r) => r.song.id);
  },

  render() {
    const p = Store.playlist(this.id);
    if (!p) return;
    $('plTitle').textContent = p.name;
    const all = Store.rowsOf(this.id);
    const total = all.reduce((sum, r) => sum + (r.song.duration || 0), 0);
    $('plMeta').textContent = `${Util.plural(all.length, 'song')} · ${Util.fmtClock(total)}`;
    $('plSearch').placeholder = `Search in ${p.name}`;

    const target = this.pickFor ? Store.playlist(this.pickFor) : null;
    $('plPickBanner').hidden = !target;
    if (target) $('plPickName').textContent = target.name;

    this._drawOffline();
    this.renderTable();
  },

  /**
   * With a Flow Server: Download keeps a playlist's songs on this computer
   * too, and says how many have arrived. Only for playlists of your own.
   */
  _drawOffline() {
    const p = Store.playlist(this.id);
    const btn = $('plOffline');
    const note = $('plOfflineNote');
    const can = !!p && Store.server.on && !p.isAll && !p.isFavourites && !p.isSmart;
    btn.hidden = !can;
    note.hidden = !can;
    if (!can) return;
    const on = Store.isOffline(this.id);
    btn.classList.toggle('toggle--on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML = `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.download}<span>Download</span>`;
    const rows = Store.rowsOf(this.id);
    const here = rows.filter((r) => r.song.file).length;
    note.textContent = !rows.length ? ''
      : here === rows.length ? (on ? 'All downloaded' : `All ${rows.length} on this computer`)
        : on ? `${here} of ${rows.length} downloaded` : here ? `${here} of ${rows.length} on this computer` : '';
  },

  renderTable() {
    const p = Store.playlist(this.id);
    if (!p) return;
    const view = this._view(this.id);
    const rows = this.rowsFor(this.id);
    const count = Store.rowsOf(this.id).length;

    const empty = count === 0;
    $('plEmpty').hidden = !empty;
    $('plTableWrap').hidden = empty;
    $('plNoMatch').hidden = empty || rows.length > 0;
    if (empty) {
      const smart = SmartLists.isSmart(this.id);
      const favourites = this.id === FAVOURITES_ID;
      if (this.id === 'all') $('plEmptyText').textContent = 'No songs yet. Download your first one on the Add Songs page.';
      else if (favourites) $('plEmptyText').textContent = 'No favourites yet. Click the star on any song to add it here.';
      else if (smart) $('plEmptyText').textContent = 'Nothing here yet. This list fills itself as you listen to your songs.';
      else $('plEmptyText').textContent = 'This playlist is empty.';
      $('plEmptyAction').hidden = smart || favourites;
      $('plEmptyAction').textContent = this.id === 'all' ? 'Add Songs' : 'Add songs from All Songs';
    }
    $('plFiltered').textContent = view.filter && !empty ? `Showing ${rows.length} of ${count}` : '';

    this._playButtons = new Map();
    const pickTarget = this.pickFor ? Store.playlist(this.pickFor) : null;
    const pickSet = pickTarget ? new Set(pickTarget.entries.map((e) => e.songId)) : null;

    renderTable($('plTable'), {
      rows,
      sort: view.sort,
      rowKey: (r) => r.song.id,
      onSort: (key) => {
        view.sort = Util.cycleSort(view.sort, key);
        this.renderTable();
      },
      onRowDblClick: (r) => Player.load(r.song.id, this.id),
      columns: [
        { key: 'title', label: 'Title', cls: 'col-title', render: (r) => this._title(r.song), onClick: (r) => this._playFromTitle(r.song) },
        { key: 'artist', label: 'Artist', cls: 'col-artist', render: (r) => h('span', { title: r.song.artist }, r.song.artist) },
        { key: 'mix', label: 'Mix', cls: 'col-mix', render: (r) => h('span.muted-text', { title: r.song.mix }, r.song.mix) },
        { key: 'duration', label: 'Duration', cls: 'col-num', render: (r) => Util.fmtClock(r.song.duration) },
        { key: 'added', label: 'Added', cls: 'col-date', render: (r) => Util.fmtDate(r.addedAt) },
        { key: 'actions', label: 'Actions', sortable: false, cls: 'col-actions', render: (r) => this._actions(r, pickTarget, pickSet) },
      ],
    });
    this._drawPlayState();
  },

  /**
   * The width left for Title, Artist and Mix, which the stylesheet splits.
   * Measured on the wrapper, which is as wide as the page allows: the table
   * itself never gets narrower than its columns, so after the window shrank
   * (maximized, then back) it would still report the old width, and Title,
   * which takes what is left, would be squeezed to nothing.
   */
  _sizeColumns() {
    const table = $('plTable');
    const width = $('plTableWrap').clientWidth;
    if (!width) return;
    const fixed = parseFloat(getComputedStyle(table).getPropertyValue('--fixed')) || 0;
    table.style.setProperty('--rest', Math.max(0, width - fixed) + 'px');
  },

  /** The title, in a cell that plays the song on a click (_playFromTitle). */
  _title(song) {
    return h('span.cell-title', { title: `Play "${song.title}"` }, song.title);
  },

  /**
   * A click anywhere in the Title cell. Unlike the play button it never
   * pauses: a click on the song already playing leaves it playing.
   */
  _playFromTitle(song) {
    if (Player.currentId === song.id && Player.contextId === this.id && Player.isPlaying) return;
    Player.toggleSong(song.id, this.id);
  },

  /**
   * Add to Queue and Play, and More with Favourite, Details, Edit and Delete
   * (All Songs) or Remove (a playlist of one's own). While adding songs to a
   * playlist, its + takes Add to Queue's place, which moves into More.
   */
  _actions(row, pickTarget, pickSet) {
    const song = row.song;
    const play = iconButton('act.act--green', Icons.play, 'Play', () => Player.toggleSong(song.id, this.id));
    this._playButtons.set(song.id, play);
    const queue = () => iconButton('act.act--green', Icons.plus, 'Add to Queue', () => Player.addToQueue(song.id));
    const listId = this.id;
    const more = () => {
      const buttons = [
        this._favButton(song),
        iconButton('act.act--green', Icons.search, 'Details', () => SongDetails.open(song.id)),
        iconButton('act.act--grey', Icons.pencil, 'Edit', () => this.edit(song)),
      ];
      if (listId === 'all') {
        buttons.push(iconButton('act.act--red', Icons.x, 'Delete Song', () => this.deleteSong(song)));
      } else if (!SmartLists.isSmart(listId) && listId !== FAVOURITES_ID) {
        buttons.push(iconButton('act.act--red', Icons.x, 'Remove from Playlist', () => this.removeFromList(song)));
      }
      if (pickTarget) buttons.unshift(queue());
      return buttons;
    };
    let first = queue();
    if (pickTarget && pickSet.has(song.id)) {
      first = iconButton('act.act--done', Icons.check, `Already in ${pickTarget.name}`, null);
      first.disabled = true;
    } else if (pickTarget) {
      first = iconButton('act.act--green', Icons.plus, `Add to ${pickTarget.name}`, () => attempt(async () => {
        await window.flow.addSongsToPlaylist(pickTarget.id, [song.id]);
        toast(`Added to ${pickTarget.name}`, 'success');
      }));
    }
    return SongActions.cell([first, play], more);
  },

  /** An empty green star, or a filled golden one for a favourite; a click turns it over. */
  _favButton(song) {
    const on = !!song.favouriteAt;
    return iconButton(on ? 'act.act--fav.act--fav-on' : 'act.act--fav',
      on ? Icons.starFilled : Icons.star, on ? 'Unfavourite' : 'Favourite',
      () => attempt(() => window.flow.setFavourite(song.id, !on)));
  },

  _drawPlayState() {
    const p = Store.playlist(this.id);
    const listActive = Player.contextId === this.id && !!Player.currentId;
    const listPlaying = listActive && Player.isPlaying;
    $('plPlay').innerHTML = (listPlaying ? Icons.pause : Icons.play) + `<span>${listPlaying ? 'Pause' : 'Play'}</span>`;
    $('plPlay').disabled = !p || !Store.rowsOf(this.id).length;
    $('plShuffle').classList.toggle('toggle--on', Player.queue.shuffle);
    $('plShuffle').setAttribute('aria-pressed', String(Player.queue.shuffle));
    $('plShuffle').innerHTML = `<span class="toggle__box">${Player.queue.shuffle ? Icons.check : ''}</span>`
      + '<img class="toggle__img" src="../images/shuffle.png" alt="" /><span>Shuffle</span>';

    for (const tr of document.querySelectorAll('#plTable tbody tr')) {
      const current = tr.dataset.id === Player.currentId;
      tr.classList.toggle('row--current', current);
    }
    for (const [songId, btn] of this._playButtons) {
      const playing = songId === Player.currentId && Player.isPlaying;
      btn.innerHTML = playing ? Icons.pause : Icons.play;
      btn.title = playing ? 'Pause' : 'Play';
    }
  },

  async removeFromList(song) {
    const p = Store.playlist(this.id);
    await attempt(async () => {
      await window.flow.removeFromPlaylist(this.id, song.id);
      toast(`Removed "${song.title}" from ${p ? p.name : 'the playlist'}`, 'success');
    });
  },

  async edit(song) {
    const meta = await editSongDialog(song);
    if (!meta) return;
    if (meta.artist === song.artist && meta.title === song.title && meta.mix === song.mix) return;
    const token = Player.release(song.id);
    await attempt(() => window.flow.editSong(song.id, meta));
    Player.resume(token);
  },

  async deleteSong(song) {
    const onServer = Store.server.on;
    const answer = await confirmDialog({
      title: 'Delete song',
      message: onServer
        ? `Delete "${Util.songLine(song)}" from the server's library and every playlist? Its file stays in the server's trash for 30 days.`
        : `Delete "${Util.songLine(song)}" from your library and every playlist?`,
      confirmLabel: 'Delete',
      danger: true,
      checkbox: onServer && !song.file ? null : {
        label: onServer ? 'Also delete its file from Local Files on this computer' : 'Also delete the file from Local Files',
        checked: true,
      },
    });
    if (!answer) return;
    const token = Player.release(song.id);
    const ok = await attempt(async () => {
      await window.flow.deleteSong(song.id, !!answer.checked);
      return true;
    });
    if (ok) toast(`Deleted "${song.title}"`, 'success');
    else Player.resume(token);
  },
};
