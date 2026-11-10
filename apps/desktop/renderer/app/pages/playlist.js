'use strict';

// One playlist's page (All Songs and Favourites included): name, totals, Shuffle and Play,
// a search box, and the songs. Each list remembers its own search and sort
// while the app runs, and the player follows the list exactly as shown.
//
// "Adding songs to" mode: the + on a row of the Playlists page opens All Songs
// with `pickFor` set (so does creating a playlist), and every row's + then
// adds straight to that list, its X takes a song out again.

// The columns sorted by their text (Util.songSortKey).
const TEXT_COLUMNS = new Set(['title', 'artist', 'mix', 'album', 'genre', 'subGenre']);

const PlaylistPage = {
  id: null,
  pickFor: null,
  views: new Map(), // playlist id -> { filter, sort }
  _playButtons: new Map(),
  // How far the page is scrolled, kept from its scroll events (read while
  // drawing, it would make the browser lay out the old list first).
  _scrollTop: 0,

  init() {
    $('pages').addEventListener('scroll', () => {
      this._scrollTop = $('pages').scrollTop;
    }, { passive: true });
    $('plSearchIcon').innerHTML = Icons.search;
    // Typed fast, the list is drawn once a frame with what is in the box then.
    let typed = 0;
    $('plSearch').addEventListener('input', () => {
      this._view(this.id).filter = $('plSearch').value;
      if (typed) return;
      typed = requestAnimationFrame(() => {
        typed = 0;
        this.renderTable();
      });
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
        const name = this.id === 'all' ? T('common.allSongs') : (p ? p.name : T('playlist.download.thisPlaylistName'));
        const ok = await confirmDialog(on ? {
          title: T('common.download'),
          message: T(`playlist.download.text.${Store.hereKey}`, { songs: Util.plural(total, 'song'), playlist: name }),
          confirmLabel: T('common.download'),
        } : {
          title: T('playlist.download.stop.title'),
          message: T(`playlist.download.stop.text.${Store.hereKey}`, { playlist: name }),
          confirmLabel: T('playlist.download.stop.confirm'),
          danger: true,
        });
        if (!ok) return;
      } else if (on && Store.isAllSongs(this.id)) {
        // All Songs is the whole library (a profile's part of it may be most
        // of it): ask before it starts coming down.
        const total = Store.rowsOf(this.id).length;
        const p = Store.playlist(this.id);
        const ok = await confirmDialog({
          title: T('playlist.downloadAll.title'),
          message: p && p.isFrom ? T('playlist.downloadAll.text.from', { count: total, playlist: p.menuName }) : T('playlist.downloadAll.text', { count: total }),
          confirmLabel: T('playlist.downloadAll.confirm'),
        });
        if (!ok) return;
      }
      attempt(() => window.flow.setOffline(this.id, on));
    };
    // An imported playlist's Update (4.0): its source read again in the background (playlistUpdate.js).
    $('plUpdate').onclick = () => PlaylistUpdate.check(Store.playlist(this.id));
    $('plRules').onclick = () => RulesEditor.open({ playlist: Store.playlist(this.id) });
    // The phone has Update as an icon in the row below the name, with the others (mobile.css orders them).
    if (Store.uiMode === 'mobile') $('plShare').after($('plUpdate'));
    $('plShare').onclick = async () => {
      const p = Store.playlist(this.id);
      if (!p) return;
      if (p.isShared) {
        attempt(() => window.flow.setFollowing(p.id, !Store.isFollowing(p.id)));
        return;
      }
      // The phone's is only an icon: it asks either way, what it is about to do.
      if (Store.uiMode === 'mobile') {
        const ok = await confirmDialog(p.shared ? {
          title: T('playlist.share.stop.title'),
          message: T('playlist.share.stop.text', { playlist: p.name }),
          confirmLabel: T('common.confirm'),
        } : {
          title: T('common.share'),
          message: T('playlist.share.text', { playlist: p.name }),
          confirmLabel: T('common.confirm'),
        });
        if (!ok) return;
      }
      attempt(() => window.flow.setPlaylistShared(p.id, !p.shared));
    };
    Store.onServer(() => {
      if (Nav.page === 'playlist') {
        this._drawOffline();
        this._drawShare();
        this._drawUpdate();
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
    // Settings' "Show filterable columns for Songs".
    Store.onSettings((patch) => {
      if (Nav.page === 'playlist' && ['colMix', 'colAlbum', 'colGenre', 'colSubGenre'].some((k) => k in patch)) this.renderTable();
    });
  },

  // filter: the search box (song titles); field: an artist, album, genre,
  // info or mix picked on the Search page ({ key, value }), or null.
  _view(id) {
    if (!this.views.has(id)) this.views.set(id, { filter: '', field: null, sort: { key: null, dir: null } });
    return this.views.get(id);
  },

  show(id, opts = {}) {
    this.id = id;
    this.pickFor = id === 'all' && opts.pickFor && Store.playlist(opts.pickFor) ? opts.pickFor : null;
    if (opts.filter !== undefined) this._view(id).filter = opts.filter;
    // Picked on the Search page, the list shows that one's songs; opened otherwise, all of them.
    this._view(id).field = opts.field && opts.field.value ? { key: opts.field.key, value: opts.field.value } : null;
    $('plSearch').value = this._view(id).filter;
    // Opened at its top (Nav.show): its first rows are the ones drawn.
    this._scrollTop = 0;
    this._openShared(id);
    this.render();
  },


  // The shared playlist whose songs are being fetched (its id), or null.
  _loading: null,

  /**
   * A playlist another profile shares that is not followed comes with its
   * songs when opened, every time it is opened (4.3); a followed one is kept
   * in step already.
   */
  _openShared(id) {
    const p = Store.playlist(id);
    if (!p || !p.isShared || Store.isFollowing(id) || !window.flow.openShared || Store.server.state !== 'online') return;
    this._loading = id;
    window.flow.openShared(id).catch((err) => {
      if (this.id === id) toast(err.message, 'error');
    }).finally(() => {
      if (this._loading !== id) return;
      this._loading = null;
      if (Nav.page === 'playlist' && this.id === id) this.render();
    });
  },

  /** A row's sort key in a column (Util.sortByKeys): texts as Util.sortKey, numbers as they are. */
  _sortValue(row, key) {
    const s = row.song;
    if (TEXT_COLUMNS.has(key)) return Util.songSortKey(s, key);
    if (key === 'from') return Util.sortKey(this._from(s));
    if (key === 'duration') return s.duration || 0;
    if (key === 'added') return row.addedAt;
    return '';
  },

  // Each list's rows in an order, kept while the list is the same (Store.rowsOf
  // gives the same array): sorting again the same way costs nothing.
  _orders: new WeakMap(),
  // The last search's rows, for one more letter typed: only those are looked through.
  _lastFound: null,

  /** A list's rows newest first (or in its own order), sorted by `sort`, all of them. */
  _ordered(id, sort) {
    const all = Store.rowsOf(id);
    let kept = this._orders.get(all);
    if (!kept) {
      kept = new Map();
      this._orders.set(all, kept);
    }
    const name = sort && sort.key ? `${sort.key}:${sort.dir}` : '';
    if (kept.has(name)) return kept.get(name);
    let rows;
    const keyOf = (r, k) => this._sortValue(r, k);
    if (!name) rows = this._picksItself(id) ? all : all.slice().sort((a, b) => b.addedAt - a.addedAt);
    else if (sort.dir === 'desc') rows = Util.reverseSorted(this._ordered(id, { key: sort.key, dir: 'asc' }), sort.key, keyOf);
    else rows = Util.sortByKeys(this._ordered(id, null), sort, keyOf);
    kept.set(name, rows);
    return rows;
  },

  /**
   * A list's rows as shown: newest first unless sorted, only the songs of
   * the artist (album ...) picked on the Search page, then the search, which
   * looks at song titles only (their artists, albums and the rest are the
   * Search page's). The listening trend lists keep their own order, best
   * match first. Never to be changed (the same array may come again).
   */
  rowsFor(id) {
    const view = this._view(id);
    const ordered = this._picked(this._ordered(id, view.sort), view.field);
    const words = Util.queryWords(view.filter);
    if (!words.length) return ordered;
    const q = words.join(' ');
    // One more letter (or word): what the shorter search found holds all of it.
    const last = this._lastFound;
    const from = last && last.ordered === ordered && q.startsWith(last.q) ? last.rows : ordered;
    const rows = from.filter((r) => Util.hasWords(Util.titleHay(r.song), words));
    this._lastFound = { ordered, q, rows };
    return rows;
  },

  /** "Artist: Dame" by the search box while one was picked on the Search page, its X shows all songs again. */
  _drawField(view) {
    const node = $('plField');
    const field = view.field;
    node.hidden = !field;
    clear(node);
    if (!field) return;
    const label = {
      artist: 'common.artist', album: 'common.album', genre: 'common.genre', subGenre: 'common.info', mix: 'common.mix',
    }[field.key] || 'common.artist';
    node.append(
      h('span.pl-field__text', { title: field.value }, `${T(label)}: ${field.value}`),
      iconButton('pl-field__x', Icons.x, T('playlist.field.clear.tooltip'), () => {
        view.field = null;
        this.renderTable();
      }),
    );
  },

  /** The rows of the artist (album ...) picked on the Search page, kept while the list and the pick stay. */
  _picked(rows, field) {
    if (!field) return rows;
    const name = `${field.key}\u0000${field.value}`;
    const kept = this._lastPicked;
    if (kept && kept.rows === rows && kept.name === name) return kept.picked;
    const has = Util.fieldMatcher(field.key, field.value);
    const picked = rows.filter((r) => has(r.song));
    this._lastPicked = { rows, name, picked };
    return picked;
  },
  _lastPicked: null,

  /** A listening trend list or a smart playlist: its songs are picked for it, in its own order, never by hand. */
  _picksItself(id) {
    if (SmartLists.isSmart(id)) return true;
    const p = Store.playlist(id);
    return !!(p && p.isRuled);
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
    // Known by its details only while its songs are on their way.
    const total = p.partial ? p.seconds || 0 : all.reduce((sum, r) => sum + (r.song.duration || 0), 0);
    const by = p.isShared && p.ownerName ? `${T('playlist.header.sharedBy', { profile: p.ownerName })} ` : '';
    $('plMeta').textContent = `${by}${p.isRuled ? `${T('playlist.header.smartPlaylist')} ` : ''}${Util.plural(p.partial ? p.songCount || 0 : all.length, 'song')} · ${Util.fmtClock(total)}`;
    $('plMeta').title = p.isRuled ? PlaylistRules.describe(p.rules) : '';
    $('plRules').hidden = !p.isRuled;
    if (p.isRuled) {
      $('plRules').title = T('playlist.rules.tooltip', { rules: PlaylistRules.describe(p.rules) });
      $('plRules').innerHTML = Store.uiMode === 'mobile' ? Icons.pulse : `${Icons.pulse}<span>${T('common.editRules')}</span>`;
      $('plRules').setAttribute('aria-label', T('common.editRules'));
    }
    $('plSearch').placeholder = T('playlist.search.placeholder', { playlist: p.name });

    const target = this.pickFor ? Store.playlist(this.pickFor) : null;
    $('plPickBanner').hidden = !target;
    if (target) {
      const [before, after = ''] = T('window.playlist.pick.banner', { playlist: '\u0000' }).split('\u0000');
      clear($('plPickText')).append(before, h('strong', target.name), after);
    }

    this._drawOffline();
    this._drawShare();
    this._drawUpdate();
    this.renderTable();
  },

  /**
   * In the row below the title, after Download: your own playlist gets "Share" (the
   * other profiles on the server can see and follow it); one another profile
   * shares gets "Follow". Both need a server with profiles.
   */
  _drawShare() {
    const p = Store.playlist(this.id);
    const btn = $('plShare');
    // Favourites on a Flow Server (4.3) is a playlist of your own too.
    const mine = !!p && !p.isAll && !p.isFrom && (!p.isFavourites || !!p.favourites) && !p.isSmart && !p.isShared && !p.isDevice && !p.isRuled && !p.isGuest;
    const can = !!p && Store.canShare() && (mine || p.isShared);
    btn.hidden = !can;
    if (!can) return;
    const on = mine ? !!p.shared : Store.isFollowing(p.id);
    btn.classList.toggle('toggle--on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = mine
      ? T('playlist.share.tooltip')
      : T('playlist.follow.tooltip');
    if (Store.uiMode === 'mobile') {
      // Only the icon on the phone, green while shared (or followed).
      btn.innerHTML = Icons.share;
      btn.setAttribute('aria-label', mine ? (on ? T('playlist.share.shared') : T('common.share')) : (on ? T('playlist.follow.following') : T('common.follow')));
    } else {
      btn.innerHTML = `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.share}<span>${mine ? T('common.share') : T('playlist.follow.following')}</span>`;
    }
  },

  /**
   * Update, for a playlist of your own imported from a link (its source):
   * where something can download (yt-dlp here, or the server's downloads). Top right of the
   * title (the phone's in the row below it).
   */
  _drawUpdate() {
    const p = Store.playlist(this.id);
    const can = !!(p && p.source && /^https?:\/\//i.test(p.source.url || '') && !p.isShared && !p.isSmart && !p.isDevice && !p.isFavourites)
      && ((Store.can('downloadHere') && DownloadsHelp.here) || ServerImport.available);
    const btn = $('plUpdate');
    btn.hidden = !can;
    if (!can) return;
    // Light blue with its icon turning while the link is read.
    const busy = PlaylistUpdate.isChecking(p.id);
    btn.classList.toggle('pl-update--busy', busy);
    // Imported from several links at once: all of them are read.
    const links = AddPage.splitLinks(p.source.url).length;
    const several = links > 1 ? '.links' : '';
    btn.title = busy ? T(`playlist.updateFromSource.checking.tooltip${several}`, { url: p.source.url, count: links })
      : T(`playlist.updateFromSource.tooltip${several}`, { url: p.source.url, playlist: p.name, count: links });
    // The phone's is only the icon, as its Download. Drawn once, so a turning icon keeps turning.
    const html = Store.uiMode === 'mobile' ? Icons.refresh : `${Icons.refresh}<span>${T('playlist.updateFromSource.button')}</span>`;
    if (btn.dataset.html !== html) {
      btn.innerHTML = html;
      btn.dataset.html = html;
    }
    btn.setAttribute('aria-label', T('playlist.updateFromSource.button'));
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
    const can = !!p && Store.server.on && Store.can('offline') && (!p.isFavourites || !!p.favourites) && !p.isSmart && !p.isRuled && !p.isDevice && !p.isGuest && (!p.isShared || Store.isFollowing(p.id));
    btn.hidden = !can;
    note.hidden = !can;
    if (!can) return;
    const on = Store.isOffline(this.id);
    btn.classList.toggle('toggle--on', on);
    btn.setAttribute('aria-pressed', String(on));
    if (Store.uiMode === 'mobile') {
      // Only the icon on the phone, golden while the playlist is kept here.
      btn.innerHTML = Icons.download;
      btn.title = T(`playlist.download.button${on ? '.done' : ''}.tooltip.${Store.hereKey}`);
      btn.setAttribute('aria-label', btn.title);
    } else {
      btn.innerHTML = `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.download}<span>${T('common.download')}</span>`;
    }
    const rows = Store.rowsOf(this.id);
    const here = rows.filter((r) => r.song.file).length;
    note.textContent = !rows.length ? ''
      : here === rows.length ? (on ? T('playlist.download.state.allDownloaded') : T(`playlist.download.state.allHere.${Store.hereKey}`, { count: rows.length }))
        : on ? T('playlist.download.state.someDownloaded', { done: here, count: rows.length }) : here ? T(`playlist.download.state.someHere.${Store.hereKey}`, { done: here, count: rows.length }) : '';
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
      if (this.id === 'all') $('plEmptyText').textContent = T('playlist.empty.allSongs');
      else if (p.partial || this._loading === this.id) $('plEmptyText').textContent = T('playlist.empty.loadingShared');
      else if (favourites) $('plEmptyText').textContent = T('playlist.empty.favourites');
      else if (smart) $('plEmptyText').textContent = T('playlist.empty.trend');
      else if (p.isDevice) $('plEmptyText').textContent = T(`playlist.empty.downloaded.${Store.hereKey}`);
      else if (p.isRuled) $('plEmptyText').textContent = T('playlist.empty.smart');
      else $('plEmptyText').textContent = T('playlist.empty.playlist');
      $('plEmptyAction').hidden = smart || favourites || !!p.isShared || !!p.isDevice || !!p.isRuled;
      $('plEmptyAction').textContent = this.id === 'all' ? T('common.addSongs') : T('playlist.empty.addFromAllSongs');
    }
    $('plFiltered').textContent = (view.filter || view.field) && !empty ? T('playlist.showing', { shown: rows.length, count }) : '';
    this._drawField(view);

    this._playButtons = new Map();
    const pickTarget = this.pickFor ? Store.playlist(this.pickFor) : null;
    const pickSet = pickTarget ? new Set(pickTarget.entries.map((e) => e.songId)) : null;

    // A listening trend list also says which of your playlists each song is from.
    const smartList = !!p.isSmart;
    const extra = this._extraColumns(smartList);
    this._shareColumns(extra.map((c) => c.key));
    renderTable($('plTable'), {
      rows,
      sort: view.sort,
      rowKey: (r) => r.song.id,
      onSort: (key) => {
        view.sort = Util.cycleSort(view.sort, key);
        this.renderTable();
      },
      onRowDblClick: (r) => Player.load(r.song.id, this.id),
      // Only the rows on screen and a screen around them are in the page,
      // whatever the length (renderTable's scroller).
      scroller: $('pages'),
      scrollTop: this._scrollTop,
      // The song playing scrolled to: marked as it comes; rows scrolled away forget their Play.
      onRowsAdded: (trs) => {
        if (Player.currentId && trs.some((tr) => tr.dataset.id === Player.currentId)) this._drawPlayState();
      },
      onRowsRemoved: (trs) => {
        for (const tr of trs) this._playButtons.delete(tr.dataset.id);
      },
      columns: [
        { key: 'title', label: T('common.title'), cls: 'col-title', render: (r) => this._title(r.song), onClick: (r) => this._playFromTitle(r.song) },
        { key: 'artist', label: T('common.artist'), cls: 'col-artist', render: (r) => h('span', { title: r.song.artist }, r.song.artist) },
        ...extra,
        { key: 'duration', label: T('common.duration'), cls: 'col-num', render: (r) => Util.fmtClock(r.song.duration) },
        { key: 'added', label: T('common.added'), cls: 'col-date', render: (r) => Util.fmtDate(r.addedAt) },
        { key: 'actions', label: T('common.actions'), sortable: false, cls: 'col-actions', render: (r) => this._actions(r, pickTarget, pickSet) },
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
    const readOnly = !!(p && (p.isShared || p.isDevice || p.isGuest));
    // Downloaded Songs: queued, or deleted from this device; nothing else (some only play).
    // Another server's songs (a guest): queued there.
    const actions = p && p.isGuest ? [
      { icon: Icons.plus, label: T('common.addToQueue'), short: T('playlist.selection.addToQueue.short'), run: (rows) => {
        for (const r of rows) Player.addToQueue(r.song.id);
        toast(T('playlist.selection.addedToQueue', { songs: Util.plural(rows.length, 'song') }), 'success');
      } },
    ] : p && p.isDevice ? [
      { icon: Icons.plus, label: T('common.addToQueue'), short: T('playlist.selection.addToQueue.short'), run: (rows) => {
        for (const r of rows) Player.addToQueue(r.song.id);
        toast(T('playlist.selection.addedToQueue', { songs: Util.plural(rows.length, 'song') }), 'success');
      } },
      { icon: Icons.x, label: T(`playlist.song.deleteHere.${Store.hereKey}`), short: T('common.delete'), kind: 'danger', run: (rows) => this.deleteFromDevice(rows.map((r) => r.song)) },
    ] : [
      { icon: Icons.plus, label: T('common.addToQueue'), short: T('playlist.selection.addToQueue.short'), run: (rows) => {
        for (const r of rows) Player.addToQueue(r.song.id);
        toast(T('playlist.selection.addedToQueue', { songs: Util.plural(rows.length, 'song') }), 'success');
      } },
      { icon: Icons.playlists, label: T('common.addToPlaylists'), short: T('playlist.selection.addToPlaylists.short'), run: async (rows) => {
        const ids = await pickPlaylists({ subtitle: Util.plural(rows.length, 'song') });
        if (!ids || !ids.length) return false;
        await attempt(async () => {
          for (const id of ids) await window.flow.addSongsToPlaylist(id, rows.map((r) => r.song.id));
          toast(T('common.playlistsUpdated'), 'success');
        });
        return true;
      } },
      { icon: Icons.star, label: T('common.favourite'), short: T('common.favourite'), run: (rows) => attempt(async () => {
        for (const r of rows) if (!r.song.favouriteAt) await window.flow.setFavourite(r.song.id, true);
      }) },
    ];
    // With a Flow Server: the chosen songs kept on the phone too.
    const offline = Store.server.on && Store.can('offline');
    if (p && p.isDevice) {
      // Its actions are all there.
    } else if (offline) {
      actions.push({ icon: Icons.download, label: T('common.download'), short: T('common.download'), run: (rows) => {
        // Choosing ends at once; the songs come down one after another.
        this.downloadSongs(rows.map((r) => r.song));
      } });
    }
    if (Store.isAllSongs(listId)) {
      actions.push({ icon: Icons.x, label: T('common.deleteSongs'), short: T('common.delete'), kind: 'danger', run: (rows) => this.deleteSongs(rows.map((r) => r.song)) });
    } else if (!smartList && listId !== FAVOURITES_ID && !readOnly) {
      actions.push({ icon: Icons.x, label: T('playlist.song.removeFromPlaylist'), short: T('common.remove'), kind: 'danger', run: (rows) => attempt(async () => {
        for (const r of rows) await window.flow.removeFromPlaylist(listId, r.song.id);
        toast(p ? T('playlist.selection.removed', { songs: Util.plural(rows.length, 'song'), playlist: p.name })
          : T('playlist.selection.removed.thePlaylist', { songs: Util.plural(rows.length, 'song') }), 'success');
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
        iconButton('act.act--green', Icons.plus, T('common.addToQueue'), () => Player.addToQueue(r.song.id)),
        ...this._moreButtons(r.song),
      ],
      // Adding songs to a playlist, only the + (and X) do anything to a song: no long press.
      select: pickTarget ? null : { actions },
    };
  },

  /**
   * The columns between Artist and Duration: Album, Genre, Info and Mix as
   * Settings shows them, and a listening trend list's From Playlist.
   */
  _extraColumns(smartList) {
    const set = Store.settings;
    const muted = (text) => h('span.muted-text', { title: text }, text);
    return [
      set.colAlbum && { key: 'album', label: T('common.album'), cls: 'col-album', render: (r) => muted(r.song.album || '') },
      set.colGenre && { key: 'genre', label: T('common.genre'), cls: 'col-genre', render: (r) => muted(r.song.genre || '') },
      set.colSubGenre && { key: 'subGenre', label: T('common.info'), cls: 'col-subgenre', render: (r) => muted(r.song.subGenre || '') },
      set.colMix && { key: 'mix', label: T('common.mix'), cls: 'col-mix', render: (r) => muted(r.song.mix) },
      smartList && { key: 'from', label: T('playlist.column.fromPlaylist'), cls: 'col-from', render: (r) => muted(this._from(r.song)) },
    ].filter(Boolean);
  },

  /**
   * Each column's share of the width left (the stylesheet's --w-<column>):
   * Title 45, Artist 35, Album 25, Genre 15, Info 15, Mix 20, From Playlist 22 of
   * what the columns shown add up to, so every one shown makes the others
   * a little narrower. Title takes what is left.
   */
  _shareColumns(keys, table = $('plTable')) {
    const weights = {
      title: 45, artist: 35, album: 25, genre: 15, subGenre: 15, mix: 20, from: 22,
    };
    const shown = ['title', 'artist', ...keys];
    const total = shown.reduce((sum, k) => sum + weights[k], 0);
    for (const k of shown) if (k !== 'title') table.style.setProperty(`--w-${k}`, String(weights[k] / total));
  },

  /**
   * The width left for Title, Artist and the columns beside them, which the stylesheet splits.
   * Measured on the wrapper, which is as wide as the page allows: the table
   * itself never gets narrower than its columns, so after the window shrank
   * (maximized, then back) it would still report the old width, and Title,
   * which takes what is left, would be squeezed to nothing.
   */
  _sizeColumns(table = $('plTable'), wrap = $('plTableWrap')) {
    const width = wrap.clientWidth;
    if (!width) return;
    const fixed = parseFloat(getComputedStyle(table).getPropertyValue('--fixed')) || 0;
    table.style.setProperty('--rest', Math.max(0, width - fixed) + 'px');
  },

  /** The cover and title, in a cell that plays the song on a click (_playFromTitle). */
  _title(song) {
    return h('span.title-cell', Covers.el(song), h('span.cell-title', { title: T('playlist.song.play.tooltip', { song: song.title }) }, song.title));
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
  _actions(row, pickTarget, pickSet, listId = this.id, playButtons = this._playButtons) {
    const song = row.song;
    const play = iconButton('act.act--green', Icons.play, T('common.play'), () => Player.toggleSong(song.id, listId));
    playButtons.set(song.id, play);
    const queue = () => iconButton('act.act--green', Icons.plus, T('common.addToQueue'), () => Player.addToQueue(song.id));
    const more = () => {
      const buttons = this._moreButtons(song, listId);
      if (pickTarget) buttons.unshift(queue());
      return buttons;
    };
    const first = pickTarget ? this._pickButton(song, pickTarget, pickSet) : queue();
    return SongActions.cell([first, play], more);
  },

  /**
   * While adding songs to a playlist: + adds the song to it; once it is
   * there, an orange X takes it out again (a song added by mistake).
   */
  _pickButton(song, pickTarget, pickSet) {
    if (pickSet.has(song.id)) {
      return iconButton('act.act--orange', Icons.x, T('playlist.pick.remove', { playlist: pickTarget.name }), () => attempt(async () => {
        await window.flow.removeFromPlaylist(pickTarget.id, song.id);
        toast(T('common.removedFrom', { playlist: pickTarget.name }), 'success');
      }));
    }
    return iconButton('act.act--green', Icons.plus, T('playlist.pick.add', { playlist: pickTarget.name }), () => attempt(async () => {
      await window.flow.addSongsToPlaylist(pickTarget.id, [song.id]);
      toast(T('common.addedTo', { playlist: pickTarget.name }), 'success');
    }));
  },

  /** More's buttons for a song (on the phone, its action sheet). */
  /** `listId`: the list the song is shown in (a group page's frame shows another than this page's). */
  _moreButtons(song, listId = this.id) {
    // Another server's song (a guest in its session): it plays and queues there, nothing more.
    if (song.foreign) return [];
    // A song here that is not the server's (Downloaded Songs) only plays, and can be deleted from here.
    if (song.isDevice) {
      return [iconButton('act.act--red', Icons.x, T(`playlist.song.deleteHere.${Store.hereKey}`), () => this.deleteFromDevice([song]))];
    }
    // A playlist another profile shares can only be changed by its owner; Downloaded Songs by nobody.
    const list = Store.playlist(listId) || {};
    const readOnly = !!(list.isShared || list.isDevice);
    const buttons = [
      this._favButton(song),
      // With a Flow Server the songs are streamed, and one can be kept here too.
      ...(Store.server.on && Store.can('offline') ? [this._downloadButton(song)] : []),
      iconButton('act.act--grey', Icons.search, T('common.songDetails'), () => SongDetails.open(song.id)),
      iconButton('act.act--grey', Icons.pencil, T('playlist.song.edit'), () => this.edit(song)),
    ];
    if (Store.isAllSongs(listId)) {
      buttons.push(iconButton('act.act--red', Icons.x, T('common.deleteSong'), () => this.deleteSong(song)));
    } else if (this._picksItself(listId)) {
      buttons.push(iconButton('act.act--red', Icons.x, T('playlist.song.removeFromPlaylists'), () => this.removeFromLists(song)));
    } else if (listId !== FAVOURITES_ID && !readOnly) {
      buttons.push(iconButton('act.act--red', Icons.x, T('playlist.song.removeFromPlaylist'), () => this.removeFromList(song, listId)));
    }
    // All Songs and the listening trend lists: put the song into playlists from here, the leftmost button.
    if (Store.isAllSongs(listId) || this._picksItself(listId)) buttons.unshift(SongActions.playlistButton(song));
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
      on ? (Store.uiMode === 'mobile' ? T(`playlist.song.deleteHere.${Store.hereKey}`) : T(`playlist.song.downloaded.tooltip.${Store.hereKey}`)) : T('common.download'),
      () => attempt(async () => {
        if (on) {
          await window.flow.removeServerDownload(song.id);
          toast(T(`playlist.song.deletedHere.${Store.hereKey}`, { song: song.title }), 'success');
        } else {
          await window.flow.downloadServerSong(song.id);
          toast(T('playlist.song.downloadedOne', { song: song.title }), 'success');
        }
      }));
  },

  /** The phone's Download for the songs chosen: one after another, those not here yet. */
  async downloadSongs(songs) {
    const todo = songs.filter((s) => !s.file);
    if (!todo.length) {
      toast(T(`playlist.song.alreadyHere.${songs.length === 1 ? 'one' : 'other'}.${Store.hereKey}`), 'info');
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
    if (done) toast(T('playlist.song.downloadedMany', { songs: Util.plural(done, 'song') }), 'success');
  },

  /** An empty green star, or a filled golden one for a favourite; a click turns it over. */
  _favButton(song) {
    const on = !!song.favouriteAt;
    return iconButton(on ? 'act.act--fav.act--fav-on' : 'act.act--fav',
      on ? Icons.starFilled : Icons.star, on ? T('common.unfavourite') : T('common.favourite'),
      () => attempt(() => window.flow.setFavourite(song.id, !on)));
  },

  _drawPlayState() {
    const p = Store.playlist(this.id);
    const listActive = Player.contextId === this.id && !!Player.currentId;
    const listPlaying = listActive && Player.isPlaying;
    $('plPlay').innerHTML = (listPlaying ? Icons.pause : Icons.play) + `<span>${listPlaying ? T('common.pause') : T('common.play')}</span>`;
    $('plPlay').disabled = !p || !Store.rowsOf(this.id).length;
    $('plShuffle').classList.toggle('toggle--on', Player.queue.shuffle);
    $('plShuffle').setAttribute('aria-pressed', String(Player.queue.shuffle));
    // The phone's is only the icon, green while on.
    $('plShuffle').innerHTML = Store.uiMode === 'mobile' ? Icons.shuffle
      : `<span class="toggle__box">${Player.queue.shuffle ? Icons.check : ''}</span>${Icons.shuffle}<span>${T('common.shuffle')}</span>`;
    $('plShuffle').setAttribute('aria-label', T('common.shuffle'));

    for (const tr of document.querySelectorAll('#plTable tbody tr, #plTableList .mrow')) {
      const current = tr.dataset.id === Player.currentId;
      tr.classList.toggle('row--current', current);
    }
    // Only the buttons that change (each starts as Play).
    for (const [songId, btn] of this._playButtons) {
      const playing = songId === Player.currentId && Player.isPlaying;
      if (!!btn._playing === playing) continue;
      btn._playing = playing;
      btn.innerHTML = playing ? Icons.pause : Icons.play;
      btn.title = playing ? T('common.pause') : T('common.play');
    }
  },

  async removeFromList(song, listId = this.id) {
    const p = Store.playlist(listId);
    await attempt(async () => {
      await window.flow.removeFromPlaylist(listId, song.id);
      toast(p ? T('playlist.remove.done', { song: song.title, playlist: p.name }) : T('playlist.remove.done.thePlaylist', { song: song.title }), 'success');
    });
  },

  /** From a listening trend list: takes the song out of every playlist of yours that holds it. */
  async removeFromLists(song) {
    const lists = Store.playlistsHolding(song.id);
    if (!lists.length) return;
    // More than one list is more than a click should undo unasked.
    if (lists.length > 1) {
      const ok = await confirmDialog({
        title: T('playlist.remove.fromMany.title'),
        message: T('playlist.remove.fromMany.text', { song: Util.songLine(song), playlists: lists.map((p) => p.name).join(', ') }),
        confirmLabel: T('common.remove'),
        danger: true,
      });
      if (!ok) return;
    }
    await attempt(async () => {
      for (const p of lists) await window.flow.removeFromPlaylist(p.id, song.id);
      toast(lists.length === 1 ? T('playlist.remove.done', { song: song.title, playlist: lists[0].name })
        : T('playlist.remove.fromMany.done.count', { song: song.title, count: lists.length }), 'success');
    });
  },

  /** Edit Song (songEdit.js): its names and its trim, saved by the dialog itself. */
  edit(song) {
    return editSongDialog(song);
  },

  /**
   * Downloaded Songs' Delete from this device: the file here goes, the song
   * stays on the servers it is on. One that is on none is asked about apart:
   * its file here is the only copy.
   */
  async deleteFromDevice(songs) {
    const only = songs.filter((s) => s.isDevice && !(s.servers || []).length);
    const one = songs.length === 1 ? `"${Util.songLine(songs[0])}"` : Util.plural(songs.length, 'song');
    const ok = await confirmDialog({
      title: T(`playlist.song.deleteHere.${Store.hereKey}`),
      message: (songs.length === 1
        ? T(`playlist.deleteHere.text.one.${Store.hereKey}`, { song: Util.songLine(songs[0]) })
        : T(`playlist.deleteHere.text.other.${Store.hereKey}`, { songs: one }))
        + (only.length ? ` ${only.length === songs.length
          ? T(songs.length === 1 ? 'playlist.deleteHere.onlyCopy.thisSong' : 'playlist.deleteHere.onlyCopy.theseSongs')
          : T(only.length === 1 ? 'playlist.deleteHere.onlyCopy.someOne' : 'playlist.deleteHere.onlyCopy.someOther', { songs: Util.plural(only.length, 'song') })}` : ''),
      confirmLabel: T('common.delete'),
      danger: true,
    });
    if (!ok) return false;
    let deleted = 0;
    for (const song of songs) {
      const token = Player.release(song.id);
      const done = await attempt(async () => {
        if (song.isDevice) await window.flow.removeDeviceSong(song.id);
        else await window.flow.removeServerDownload(song.id);
        return true;
      });
      if (done) deleted += 1;
      else {
        Player.resume(token);
        break;
      }
    }
    if (deleted) toast(T(`playlist.deleteHere.done.${Store.hereKey}`, { songs: Util.plural(deleted, 'song') }), 'success');
    return true;
  },

  /** The phone's chosen songs: deleted together, after one question. */
  async deleteSongs(songs) {
    if (songs.length === 1) return this.deleteSong(songs[0]);
    const onServer = Store.server.on;
    const answer = await confirmDialog({
      title: T('common.deleteSongs'),
      message: onServer
        ? T('playlist.delete.many.text.server', { count: songs.length })
        : T('playlist.delete.many.text.local', { count: songs.length }),
      confirmLabel: T('common.delete'),
      danger: true,
      checkbox: onServer && !songs.some((s) => s.file) ? null : {
        label: onServer ? T('playlist.delete.many.alsoFiles.device') : T('playlist.delete.many.alsoFiles'),
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
    if (deleted) toast(T('playlist.delete.many.done', { songs: Util.plural(deleted, 'song') }), 'success');
    return true;
  },

  async deleteSong(song) {
    const onServer = Store.server.on;
    const answer = await confirmDialog({
      title: T('common.deleteSong'),
      message: onServer
        ? T('playlist.delete.one.text.server', { song: Util.songLine(song) })
        : T('playlist.delete.one.text.local', { song: Util.songLine(song) }),
      confirmLabel: T('common.delete'),
      danger: true,
      checkbox: onServer && !song.file ? null : {
        label: onServer ? T('playlist.delete.one.alsoFile.computer') : T('playlist.delete.one.alsoFile'),
        checked: true,
      },
    });
    if (!answer) return;
    const token = Player.release(song.id);
    const ok = await attempt(async () => {
      await window.flow.deleteSong(song.id, !!answer.checked);
      return true;
    });
    if (ok) toast(T('common.songDeleted', { song: song.title }), 'success');
    else Player.resume(token);
  },
};
