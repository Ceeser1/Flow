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
    $('plOffline').onclick = async () => {
      const on = !Store.isOffline(this.id);
      // The phone's is only an icon: it asks either way, what it is about to do.
      if (Store.uiMode === 'mobile') {
        const p = Store.playlist(this.id);
        const total = Store.rowsOf(this.id).length;
        const name = this.id === 'all' ? 'All Songs' : (p ? p.name : 'this playlist');
        const ok = await confirmDialog(on ? {
          title: 'Download',
          message: `Download all ${Util.plural(total, 'song')} of ${name} to ${Store.here}? New songs of it come down too.`,
          confirmLabel: 'Download',
        } : {
          title: 'Stop downloading',
          message: `${name} is no longer kept on ${Store.here}: its downloaded songs are deleted here `
            + '(except those another download holds). They still play from the server.',
          confirmLabel: 'Delete downloads',
          danger: true,
        });
        if (!ok) return;
      } else if (on && Store.isAllSongs(this.id)) {
        // All Songs is the whole library (a profile's part of it may be most
        // of it): ask before it starts coming down.
        const total = Store.rowsOf(this.id).length;
        const p = Store.playlist(this.id);
        const ok = await confirmDialog({
          title: 'Download all songs',
          message: `Are you sure you want to download all ${total} ${total === 1 ? 'song' : 'songs'}${p && p.isFrom ? ` ${p.menuName}` : ''}?`,
          confirmLabel: 'Yes',
        });
        if (!ok) return;
      }
      attempt(() => window.flow.setOffline(this.id, on));
    };
    $('plShare').onclick = () => {
      const p = Store.playlist(this.id);
      if (!p) return;
      if (p.isShared) attempt(() => window.flow.setFollowing(p.id, !Store.isFollowing(p.id)));
      else attempt(() => window.flow.setPlaylistShared(p.id, !p.shared));
    };
    Store.onServer(() => {
      if (Nav.page === 'playlist') {
        this._drawOffline();
        this._drawShare();
      }
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
    if (key === 'from') return this._from(s);
    if (key === 'duration') return s.duration || 0;
    if (key === 'added') return row.addedAt;
    return '';
  },

  /**
   * A list's rows as shown: newest first unless sorted, then the search. The
   * listening trend lists keep their own order, best match first.
   */
  rowsFor(id) {
    const view = this._view(id);
    let rows = Store.rowsOf(id)
      .filter((r) => Util.matches(view.filter, r.song.title, r.song.artist, r.song.mix));
    if (!SmartLists.isSmart(id)) rows = rows.sort((a, b) => b.addedAt - a.addedAt);
    return Util.sortRows(rows, view.sort, (r, k) => this._sortValue(r, k));
  },

  /** The names of your own playlists holding a song, as one text (a listening trend list's From Playlist column). */
  _from(song) {
    return Store.playlistsHolding(song.id).map((p) => p.name).join(', ');
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
    const by = p.isShared && p.ownerName ? `Shared by ${p.ownerName} · ` : '';
    $('plMeta').textContent = `${by}${Util.plural(all.length, 'song')} · ${Util.fmtClock(total)}`;
    $('plSearch').placeholder = `Search in ${p.name}`;

    const target = this.pickFor ? Store.playlist(this.pickFor) : null;
    $('plPickBanner').hidden = !target;
    if (target) $('plPickName').textContent = target.name;

    this._drawOffline();
    this._drawShare();
    this.renderTable();
  },

  /**
   * Top right of the title: your own playlist gets "Share" (the
   * other profiles on the server can see and follow it); one another profile
   * shares gets "Follow". Both need a server with profiles.
   */
  _drawShare() {
    const p = Store.playlist(this.id);
    const btn = $('plShare');
    const mine = !!p && !p.isAll && !p.isFrom && !p.isFavourites && !p.isSmart && !p.isShared;
    const can = !!p && Store.canShare() && (mine || p.isShared);
    btn.hidden = !can;
    if (!can) return;
    const on = mine ? !!p.shared : Store.isFollowing(p.id);
    btn.classList.toggle('toggle--on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = mine
      ? 'Let the other profiles on this server see this playlist and follow it'
      : `Follow this playlist: it shows in the menu under Followed Playlists`;
    btn.innerHTML = `<span class="toggle__box">${on ? Icons.check : ''}</span><span>${mine ? 'Share' : 'Following'}</span>`;
  },

  /**
   * With a Flow Server: Download keeps a playlist's songs on this device
   * too, and says how many have arrived. For All Songs and each profile's
   * part of it ("from ..."), playlists of your own and ones you follow; each
   * then follows the server (new songs come, deleted ones go).
   */
  _drawOffline() {
    const p = Store.playlist(this.id);
    const btn = $('plOffline');
    const note = $('plOfflineNote');
    // A playlist another profile shares can be downloaded once it is followed.
    const can = !!p && Store.server.on && Store.can('offline') && !p.isFavourites && !p.isSmart && (!p.isShared || Store.isFollowing(p.id));
    btn.hidden = !can;
    note.hidden = !can;
    if (!can) return;
    const on = Store.isOffline(this.id);
    btn.classList.toggle('toggle--on', on);
    btn.setAttribute('aria-pressed', String(on));
    if (Store.uiMode === 'mobile') {
      // Only the icon on the phone, golden while the playlist is kept here.
      btn.innerHTML = Icons.download;
      btn.title = on ? `Downloaded to ${Store.here}` : `Download to ${Store.here}`;
      btn.setAttribute('aria-label', btn.title);
    } else {
      btn.innerHTML = `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.download}<span>Download</span>`;
    }
    const rows = Store.rowsOf(this.id);
    const here = rows.filter((r) => r.song.file).length;
    note.textContent = !rows.length ? ''
      : here === rows.length ? (on ? 'All downloaded' : `All ${rows.length} on ${Store.here}`)
        : on ? `${here} of ${rows.length} downloaded` : here ? `${here} of ${rows.length} on ${Store.here}` : '';
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
      else if (smart) $('plEmptyText').textContent = 'Nothing here yet. This list fills itself as you listen to the songs in your playlists.';
      else $('plEmptyText').textContent = 'This playlist is empty.';
      $('plEmptyAction').hidden = smart || favourites || !!p.isShared;
      $('plEmptyAction').textContent = this.id === 'all' ? 'Add Songs' : 'Add songs from All Songs';
    }
    $('plFiltered').textContent = view.filter && !empty ? `Showing ${rows.length} of ${count}` : '';

    this._playButtons = new Map();
    const pickTarget = this.pickFor ? Store.playlist(this.pickFor) : null;
    const pickSet = pickTarget ? new Set(pickTarget.entries.map((e) => e.songId)) : null;

    // A listening trend list also says which of your playlists each song is from.
    const smartList = !!p.isSmart;
    $('plTable').classList.toggle('table--from', smartList);
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
        ...(smartList ? [{
          key: 'from',
          label: 'From Playlist',
          cls: 'col-from',
          render: (r) => h('span.muted-text', { title: this._from(r.song) }, this._from(r.song)),
        }] : []),
        { key: 'duration', label: 'Duration', cls: 'col-num', render: (r) => Util.fmtClock(r.song.duration) },
        { key: 'added', label: 'Added', cls: 'col-date', render: (r) => Util.fmtDate(r.addedAt) },
        { key: 'actions', label: 'Actions', sortable: false, cls: 'col-actions', render: (r) => this._actions(r, pickTarget, pickSet) },
      ],
      mobile: this._touchRows(pickTarget, pickSet, smartList),
    });
    this._drawPlayState();
  },

  /**
   * The phone's rows (touchList.js): a tap plays the song, More has Add to
   * Queue and the desktop's More; adding songs to a playlist, the + takes
   * More's place. A long press chooses songs for the bar's actions.
   */
  _touchRows(pickTarget, pickSet, smartList) {
    const listId = this.id;
    const p = Store.playlist(listId);
    const readOnly = !!(p && p.isShared);
    const actions = [
      { icon: Icons.plus, label: 'Add to Queue', short: 'Queue', run: (rows) => {
        for (const r of rows) Player.addToQueue(r.song.id);
        toast(`${Util.plural(rows.length, 'song')} added to the queue`, 'success');
      } },
      { icon: Icons.playlists, label: 'Add to Playlists', short: 'Playlist', run: async (rows) => {
        const ids = await pickPlaylists({ subtitle: Util.plural(rows.length, 'song') });
        if (!ids || !ids.length) return false;
        await attempt(async () => {
          for (const id of ids) await window.flow.addSongsToPlaylist(id, rows.map((r) => r.song.id));
          toast('Playlists updated', 'success');
        });
        return true;
      } },
      { icon: Icons.star, label: 'Favourite', short: 'Favourite', run: (rows) => attempt(async () => {
        for (const r of rows) if (!r.song.favouriteAt) await window.flow.setFavourite(r.song.id, true);
      }) },
    ];
    // With a Flow Server: the chosen songs kept on the phone too.
    const offline = Store.server.on && Store.can('offline');
    if (offline) {
      actions.push({ icon: Icons.download, label: 'Download', short: 'Download', run: (rows) => {
        // Choosing ends at once; the songs come down one after another.
        this.downloadSongs(rows.map((r) => r.song));
      } });
    }
    if (Store.isAllSongs(listId)) {
      actions.push({ icon: Icons.x, label: 'Delete Songs', short: 'Delete', kind: 'danger', run: (rows) => this.deleteSongs(rows.map((r) => r.song)) });
    } else if (!smartList && listId !== FAVOURITES_ID && !readOnly) {
      actions.push({ icon: Icons.x, label: 'Remove from Playlist', short: 'Remove', kind: 'danger', run: (rows) => attempt(async () => {
        for (const r of rows) await window.flow.removeFromPlaylist(listId, r.song.id);
        toast(`Removed ${Util.plural(rows.length, 'song')} from ${p ? p.name : 'the playlist'}`, 'success');
      }) });
    }
    return {
      lead: (r) => Covers.el(r.song),
      title: (r) => r.song.title,
      sub: (r) => {
        const line = [r.song.artist, r.song.mix ? `(${r.song.mix})` : ''].filter(Boolean).join(' - ');
        return smartList && this._from(r.song) ? `${line} · ${this._from(r.song)}` : line;
      },
      // A song kept here (downloaded from the server).
      mark: (r) => (offline && r.song.file ? Icons.download : ''),
      sheetTitle: (r) => Util.songLine(r.song),
      tap: (r) => this._playFromTitle(r.song),
      side: (r) => (pickTarget ? this._pickButton(r.song, pickTarget, pickSet) : null),
      more: (r) => [
        iconButton('act.act--green', Icons.plus, 'Add to Queue', () => Player.addToQueue(r.song.id)),
        ...this._moreButtons(r.song),
      ],
      select: { actions },
    };
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

  /** The cover and title, in a cell that plays the song on a click (_playFromTitle). */
  _title(song) {
    return h('span.title-cell', Covers.el(song), h('span.cell-title', { title: `Play "${song.title}"` }, song.title));
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
   * Add to Queue and Play, and More with Download (with a Flow Server),
   * between Favourite and Song Details, Edit and Delete
   * (All Songs), Remove (a playlist of one's own) or Remove from Playlist(s)
   * (a listening trend list: out of every own playlist holding it, the song
   * itself stays in All Songs). All Songs and the listening trend lists also
   * have Add to Playlists, leftmost. While adding songs to a
   * playlist, its + takes Add to Queue's place, which moves into More.
   */
  _actions(row, pickTarget, pickSet) {
    const song = row.song;
    const play = iconButton('act.act--green', Icons.play, 'Play', () => Player.toggleSong(song.id, this.id));
    this._playButtons.set(song.id, play);
    const queue = () => iconButton('act.act--green', Icons.plus, 'Add to Queue', () => Player.addToQueue(song.id));
    const more = () => {
      const buttons = this._moreButtons(song);
      if (pickTarget) buttons.unshift(queue());
      return buttons;
    };
    const first = pickTarget ? this._pickButton(song, pickTarget, pickSet) : queue();
    return SongActions.cell([first, play], more);
  },

  /** While adding songs to a playlist: + adds the song to it, a tick once it is there. */
  _pickButton(song, pickTarget, pickSet) {
    if (pickSet.has(song.id)) {
      const done = iconButton('act.act--done', Icons.check, `Already in ${pickTarget.name}`, null);
      done.disabled = true;
      return done;
    }
    return iconButton('act.act--green', Icons.plus, `Add to ${pickTarget.name}`, () => attempt(async () => {
      await window.flow.addSongsToPlaylist(pickTarget.id, [song.id]);
      toast(`Added to ${pickTarget.name}`, 'success');
    }));
  },

  /** More's buttons for a song (on the phone, its action sheet). */
  _moreButtons(song) {
    const listId = this.id;
    // A playlist another profile shares can only be changed by its owner.
    const readOnly = !!(Store.playlist(listId) || {}).isShared;
    const buttons = [
      this._favButton(song),
      // With a Flow Server the songs are streamed, and one can be kept here too.
      ...(Store.server.on && Store.can('offline') ? [this._downloadButton(song)] : []),
      iconButton('act.act--grey', Icons.search, 'Song Details', () => SongDetails.open(song.id)),
      iconButton('act.act--grey', Icons.pencil, 'Edit', () => this.edit(song)),
    ];
    if (Store.isAllSongs(listId)) {
      buttons.push(iconButton('act.act--red', Icons.x, 'Delete Song', () => this.deleteSong(song)));
    } else if (SmartLists.isSmart(listId)) {
      buttons.push(iconButton('act.act--red', Icons.x, 'Remove from Playlist(s)', () => this.removeFromLists(song)));
    } else if (listId !== FAVOURITES_ID && !readOnly) {
      buttons.push(iconButton('act.act--red', Icons.x, 'Remove from Playlist', () => this.removeFromList(song)));
    }
    // All Songs and the listening trend lists: put the song into playlists from here, the leftmost button.
    if (Store.isAllSongs(listId) || SmartLists.isSmart(listId)) buttons.unshift(SongActions.playlistButton(song));
    return buttons;
  },

  /**
   * With a Flow Server: light grey while the song is only on the server, golden once
   * there is a copy here (Local Files). A click downloads it, or, golden,
   * deletes the copy here (the song stays on the server).
   */
  _downloadButton(song) {
    const on = !!song.file;
    return iconButton(on ? 'act.act--dl.act--dl-on' : 'act.act--dl', Icons.download,
      // On the phone the label is a line of its action sheet.
      on ? (Store.uiMode === 'mobile' ? `Delete from ${Store.here}` : `Downloaded: click to delete it from ${Store.here}`) : 'Download',
      () => attempt(async () => {
        if (on) {
          await window.flow.removeServerDownload(song.id);
          toast(`Deleted "${song.title}" from ${Store.here}`, 'success');
        } else {
          await window.flow.downloadServerSong(song.id);
          toast(`Downloaded "${song.title}"`, 'success');
        }
      }));
  },

  /** The phone's Download for the songs chosen: one after another, those not here yet. */
  async downloadSongs(songs) {
    const todo = songs.filter((s) => !s.file);
    if (!todo.length) {
      toast(`${songs.length === 1 ? 'It is' : 'They are'} on ${Store.here} already`, 'info');
      return;
    }
    let done = 0;
    for (const s of todo) {
      try {
        await window.flow.downloadServerSong(s.id);
        done += 1;
      } catch (err) {
        toast(err.message, 'error');
        break;
      }
    }
    if (done) toast(`Downloaded ${Util.plural(done, 'song')}`, 'success');
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

    for (const tr of document.querySelectorAll('#plTable tbody tr, #plTableList .mrow')) {
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

  /** From a listening trend list: takes the song out of every playlist of yours that holds it. */
  async removeFromLists(song) {
    const lists = Store.playlistsHolding(song.id);
    if (!lists.length) return;
    // More than one list is more than a click should undo unasked.
    if (lists.length > 1) {
      const ok = await confirmDialog({
        title: 'Remove from playlists',
        message: `Remove "${Util.songLine(song)}" from ${lists.map((p) => p.name).join(', ')}? It stays in All Songs.`,
        confirmLabel: 'Remove',
        danger: true,
      });
      if (!ok) return;
    }
    await attempt(async () => {
      for (const p of lists) await window.flow.removeFromPlaylist(p.id, song.id);
      toast(`Removed "${song.title}" from ${lists.length === 1 ? lists[0].name : `${lists.length} playlists`}`, 'success');
    });
  },

  /** Edit Song (songEdit.js): its names and its trim, saved by the dialog itself. */
  edit(song) {
    return editSongDialog(song);
  },

  /** The phone's chosen songs: deleted together, after one question. */
  async deleteSongs(songs) {
    if (songs.length === 1) return this.deleteSong(songs[0]);
    const onServer = Store.server.on;
    const answer = await confirmDialog({
      title: 'Delete songs',
      message: onServer
        ? `Delete ${songs.length} songs from the server's library and every playlist? Their files stay in the server's trash for 30 days.`
        : `Delete ${songs.length} songs from your library and every playlist?`,
      confirmLabel: 'Delete',
      danger: true,
      checkbox: onServer && !songs.some((s) => s.file) ? null : {
        label: onServer ? 'Also delete their files from Local Files on this device' : 'Also delete the files from Local Files',
        checked: true,
      },
    });
    if (!answer) return false;
    let deleted = 0;
    for (const song of songs) {
      const token = Player.release(song.id);
      const ok = await attempt(async () => {
        await window.flow.deleteSong(song.id, !!answer.checked);
        return true;
      });
      if (ok) deleted += 1;
      else Player.resume(token);
    }
    if (deleted) toast(`Deleted ${Util.plural(deleted, 'song')}`, 'success');
    return true;
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
