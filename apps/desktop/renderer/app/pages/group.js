'use strict';

// A playlist group's page (4.5.2), opened by the group's name in the menu.
// At the top its name, its songs and length all together, Play, Shuffle and
// Download, and below them a search box looking through every playlist in
// it. Then each playlist as a frame of its own: its name (with room for a
// long one), songs and length, Play, Shuffle and Download beside it, and
// Share (or Following) at the right; a click on its head opens or closes it,
// and open it shows its songs as its own page does (the same columns, sorting
// and buttons, playlist.js) in a box of their own that scrolls. The page
// itself scrolls once the frames do not fit.
//
// The group's Play picks one of its playlists at random and plays it; with
// Shuffle on it plays the whole group as one list instead (Store's
// "group:<id>"), so each next song is drawn from all of its playlists.
// Turning Shuffle on here while one of its playlists plays carries on in the
// whole group. The playlist a song plays from has the speaker before its name. Download marks every playlist in it to be kept on this device.

const GroupPage = {
  id: null,
  filter: '',
  // The playlists open on this page, per group (while the app runs): group id -> Set of playlist ids.
  _open: new Map(),
  _playButtons: new Map(), // playlist id -> (song id -> its row's Play)
  _sorts: new Map(), // playlist id -> its frame's sort (while the app runs)
  _frames: new Map(), // playlist id -> { play, shuffle } of its head, for the play state

  init() {
    $('grSearchIcon').innerHTML = Icons.search;
    let typed = 0;
    $('grSearch').addEventListener('input', () => {
      this.filter = $('grSearch').value;
      if (typed) return;
      typed = requestAnimationFrame(() => {
        typed = 0;
        this.renderFrames();
      });
    });
    $('grSearch').addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('grSearch').value) {
        e.stopPropagation();
        $('grSearch').value = '';
        this.filter = '';
        this.renderFrames();
      }
    });
    $('grPlay').onclick = () => this.play();
    $('grShuffle').onclick = () => this.shuffle();
    $('grOffline').onclick = () => this.download();
    Store.onLibrary(() => {
      if (Nav.page !== 'group') return;
      if (!Store.group(this.id)) {
        Nav.show('playlists');
        return;
      }
      this.render();
    });
    Store.onServer(() => {
      if (Nav.page === 'group') this.render();
    });
    Player.onChange(() => {
      if (Nav.page === 'group') this._drawPlayState();
    });
  },

  show(id) {
    if (this.id !== id) {
      this.filter = '';
      $('grSearch').value = '';
    }
    this.id = id;
    this.render();
  },

  /** The group played as one list. */
  get listId() {
    return GROUP_PREFIX + this.id;
  },

  _lists() {
    return Store.playlistsInGroup(this.id);
  },

  _isOpen(p) {
    return (this._open.get(this.id) || new Set()).has(p.id);
  },

  _toggleFrame(p) {
    if (!this._open.has(this.id)) this._open.set(this.id, new Set());
    const open = this._open.get(this.id);
    if (open.has(p.id)) open.delete(p.id);
    else open.add(p.id);
    this.renderFrames();
  },

  /** Whether this group, or one of its playlists, is the list playing (or paused). */
  _groupActive() {
    if (!Player.currentId) return false;
    return Player.contextId === this.listId || this._lists().some((p) => p.id === Player.contextId);
  },

  // ---- the group's buttons ----

  /**
   * Play: pauses or carries on while the group (or one of its playlists)
   * plays; otherwise one of its playlists at random, or with Shuffle on the
   * whole group as one list.
   */
  play() {
    if (this._groupActive()) {
      Player.toggle();
      return;
    }
    if (Player.queue.shuffle) {
      if (Store.rowsOf(this.listId).length) Player.togglePlaylist(this.listId);
      return;
    }
    const lists = this._lists().filter((p) => Store.rowsOf(p.id).length);
    if (!lists.length) return;
    Player.togglePlaylist(lists[Math.floor(Math.random() * lists.length)].id);
  },

  /** Shuffle (the player's); turned on while one of its playlists plays, the whole group goes on. */
  shuffle() {
    const on = !Player.queue.shuffle;
    Player.setShuffle(on);
    if (on && Player.currentId && this._lists().some((p) => p.id === Player.contextId)) Player.carryOnIn(this.listId);
  },

  /** The playlists Download can keep here: yours, and the ones you follow. */
  _offlineLists() {
    return this._lists().filter((p) => this._canOffline(p));
  },

  _canOffline(p) {
    return Store.server.on && Store.can('offline') && !p.isRuled && !p.isSmart && (!p.isShared || Store.isFollowing(p.id));
  },

  /** Download: every playlist in it kept here (or, all of them kept, none any more). */
  async download() {
    const lists = this._offlineLists();
    if (!lists.length) return;
    const on = !lists.every((p) => Store.isOffline(p.id));
    const g = Store.group(this.id);
    if (Store.uiMode === 'mobile') {
      const songs = Store.rowsOf(this.listId).length;
      const ok = await confirmDialog(on ? {
        title: T('common.download'),
        message: T(`group.download.text.${Store.hereKey}`, { songs: Util.plural(songs, 'song'), group: g.name }),
        confirmLabel: T('common.download'),
      } : {
        title: T('playlist.download.stop.title'),
        message: T(`group.download.stop.text.${Store.hereKey}`, { group: g.name }),
        confirmLabel: T('playlist.download.stop.confirm'),
        danger: true,
      });
      if (!ok) return;
    }
    await attempt(async () => {
      for (const p of lists) if (Store.isOffline(p.id) !== on) await window.flow.setOffline(p.id, on);
    });
  },

  // ---- drawing ----

  render() {
    const g = Store.group(this.id);
    if (!g) return;
    $('grTitle').textContent = g.name;
    const lists = this._lists();
    const rows = Store.rowsOf(this.listId);
    const seconds = rows.reduce((sum, r) => sum + (r.song.duration || 0), 0);
    $('grMeta').textContent = `${Util.plural(lists.length, 'playlist')} · ${Util.plural(rows.length, 'song')} · ${Util.fmtClock(seconds)}`;
    $('grSearch').placeholder = T('group.search.placeholder', { group: g.name });
    this._drawOffline(rows);
    this.renderFrames();
  },

  _drawOffline(rows) {
    const lists = this._offlineLists();
    const btn = $('grOffline');
    const note = $('grOfflineNote');
    btn.hidden = !lists.length;
    note.hidden = !lists.length;
    if (!lists.length) return;
    const on = lists.every((p) => Store.isOffline(p.id));
    btn.classList.toggle('toggle--on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = T(on ? 'group.download.on.tooltip' : 'group.download.tooltip', { count: lists.length });
    if (Store.uiMode === 'mobile') {
      btn.innerHTML = Icons.download;
      btn.setAttribute('aria-label', btn.title);
    } else {
      btn.innerHTML = `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.download}<span>${T('common.download')}</span>`;
    }
    const here = rows.filter((r) => r.song.file).length;
    note.textContent = !rows.length || !lists.some((p) => Store.isOffline(p.id)) ? ''
      : here === rows.length ? T('playlist.download.state.allDownloaded') : T('playlist.download.state.someDownloaded', { done: here, count: rows.length });
  },

  _sortOf(p) {
    if (!this._sorts.has(p.id)) this._sorts.set(p.id, { key: null, dir: null });
    return this._sorts.get(p.id);
  },

  /** The songs of a playlist as its page orders them (its frame's sort), those the search finds. */
  _rowsOf(p, words) {
    const rows = PlaylistPage._ordered(p.id, this._sortOf(p));
    if (!words.length) return rows;
    return rows.filter((r) => Util.hasWords(Util.titleHay(r.song), words));
  },

  renderFrames() {
    const box = $('grFrames');
    // The page's place and the song lists' own, kept over the redraw (a
    // library change while songs come down redraws it often). The frames
    // keep their height meanwhile, so the page is never shorter for a moment.
    const pages = $('pages');
    const pageTop = pages.scrollTop;
    const scrolled = new Map([...box.querySelectorAll('.gframe__songs')].map((n) => [n.dataset.id, n.scrollTop]));
    box.style.minHeight = `${box.offsetHeight}px`;
    releaseCovers([box]);
    clear(box);
    const draws = [];
    this._playButtons = new Map();
    this._frames = new Map();
    const lists = this._lists();
    const words = Util.queryWords(this.filter);
    let shown = 0;
    let found = 0;
    let total = 0;
    for (const p of lists) {
      const rows = this._rowsOf(p, words);
      total += Store.songCount(p);
      // Searching: only the playlists with songs found, open.
      if (words.length && !rows.length) continue;
      found += rows.length;
      shown += 1;
      box.appendChild(this._frame(p, rows, words.length > 0 || this._isOpen(p), scrolled.get(p.id) || 0, draws));
    }
    // The open frames' songs, now that their boxes are in the page and can measure where their rows show.
    for (const draw of draws) draw();
    box.style.minHeight = '';
    pages.scrollTop = pageTop;
    $('grEmpty').hidden = lists.length > 0;
    $('grEmptyText').textContent = T('group.empty');
    $('grNoMatch').hidden = !words.length || shown > 0 || !lists.length;
    $('grFiltered').textContent = words.length && lists.length ? T('playlist.showing', { shown: found, count: total }) : '';
    this._drawPlayState();
  },

  _frame(p, rows, open, scrollTop, draws) {
    const count = Store.songCount(p);
    const seconds = Store.durationOf(p);
    const play = h('button.btn.btn--play.gframe__play', { type: 'button', onclick: () => Player.togglePlaylist(p.id) });
    const shuffle = h('button.toggle.gframe__shuffle', { type: 'button', title: T('window.playlist.shuffle.tooltip'), onclick: () => Player.setShuffle(!Player.queue.shuffle) });
    // The speaker beside its icon while a song of it plays (_drawPlayState).
    const playing = h('span.gframe__playing', { html: Icons.speaker, title: T('common.playing'), hidden: true });
    this._frames.set(p.id, {
      play, shuffle, count, playing, songs: new Set((p.entries || []).map((e) => e.songId)),
    });
    const head = h('div.gframe__head', {
      role: 'button',
      tabIndex: 0,
      'aria-expanded': String(open),
      title: open ? T('group.frame.hide.tooltip', { playlist: p.name }) : T('group.frame.show.tooltip', { playlist: p.name }),
      onclick: (e) => {
        if (e.target.closest('button')) return;
        this._toggleFrame(p);
      },
      onkeydown: (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          this._toggleFrame(p);
        }
      },
    },
    h('span.menu__chevron' + (open ? '.menu__chevron--open' : ''), { html: Icons.chevron }),
    h('span.gframe__icon', { html: listIcon(p) }),
    // The speaker right beside its icon while a song of it plays, its name and numbers moved over.
    playing,
    h('span.gframe__text',
      h('span.gframe__name', { title: p.name }, p.name),
      h('span.gframe__sub', [Util.plural(count, 'song'), Util.fmtClock(seconds), p.ownerName ? T('common.byOwner', { profile: p.ownerName }) : ''].filter(Boolean).join(' · '))),
    h('span.gframe__buttons', play, shuffle, this._offlineButton(p)),
    this._shareButton(p));
    const frame = h('div.gframe' + (open ? '.gframe--open' : ''), { dataset: { id: p.id } }, head);
    if (!open) return frame;
    if (!rows.length) {
      frame.appendChild(h('p.muted-text.gframe__empty', T('playlist.empty.playlist')));
      return frame;
    }
    const songs = h('div.gframe__songs', { dataset: { id: p.id } });
    const table = h('table.table.table--songs.gframe__table', { dataset: { id: p.id } });
    songs.appendChild(table);
    frame.appendChild(songs);
    draws.push(() => {
      this._songTable(table, songs, p, rows);
      songs.scrollTop = scrollTop;
    });
    return frame;
  },

  /** A playlist's Download (with a Flow Server): its songs kept on this device too. */
  _offlineButton(p) {
    if (!this._canOffline(p)) return null;
    const on = Store.isOffline(p.id);
    const btn = h('button.toggle.gframe__offline' + (on ? '.toggle--on' : ''), {
      type: 'button',
      'aria-pressed': String(on),
      title: T(`playlist.download.button${on ? '.done' : ''}.tooltip.${Store.hereKey}`),
      onclick: () => attempt(() => window.flow.setOffline(p.id, !on)),
    });
    btn.innerHTML = Store.uiMode === 'mobile' ? Icons.download
      : `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.download}<span>${T('common.download')}</span>`;
    return btn;
  },

  /** Share for a playlist of yours, Following for one you follow (both need a server with profiles). */
  _shareButton(p) {
    if (!Store.canShare() || p.isRuled || p.isFavourites) return null;
    const mine = !p.isShared;
    const on = mine ? !!p.shared : Store.isFollowing(p.id);
    const btn = h('button.toggle.gframe__share' + (on ? '.toggle--on' : ''), {
      type: 'button',
      'aria-pressed': String(on),
      title: mine ? T('playlist.share.tooltip') : T('playlist.follow.tooltip'),
      onclick: () => attempt(() => (mine ? window.flow.setPlaylistShared(p.id, !p.shared) : window.flow.setFollowing(p.id, !on))),
    });
    btn.innerHTML = Store.uiMode === 'mobile' ? Icons.share
      : `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.share}<span>${mine ? T('common.share') : T('playlist.follow.following')}</span>`;
    return btn;
  },

  /**
   * A playlist's songs in its frame's own scrolling box, as its page shows
   * them: the same columns (those Settings shows too), sorting and buttons;
   * they play in that playlist.
   */
  _songTable(table, scroller, p, rows) {
    const playSong = (song) => {
      if (Player.currentId === song.id && Player.contextId === p.id && Player.isPlaying) return;
      Player.toggleSong(song.id, p.id);
    };
    const buttons = new Map();
    this._playButtons.set(p.id, buttons);
    const extra = PlaylistPage._extraColumns(false);
    PlaylistPage._shareColumns(extra.map((c) => c.key), table);
    const sort = this._sortOf(p);
    renderTable(table, {
      rows,
      sort,
      rowKey: (r) => r.song.id,
      onSort: (key) => {
        this._sorts.set(p.id, Util.cycleSort(sort, key));
        this.renderFrames();
      },
      onRowDblClick: (r) => Player.load(r.song.id, p.id),
      scroller,
      scrollTop: scroller.scrollTop,
      onRowsAdded: (trs) => {
        if (Player.currentId && trs.some((tr) => tr.dataset.id === Player.currentId)) this._drawPlayState();
      },
      onRowsRemoved: (trs) => {
        for (const tr of trs) buttons.delete(tr.dataset.id);
      },
      columns: [
        { key: 'title', label: T('common.title'), cls: 'col-title', render: (r) => PlaylistPage._title(r.song), onClick: (r) => playSong(r.song) },
        { key: 'artist', label: T('common.artist'), cls: 'col-artist', render: (r) => h('span', { title: r.song.artist }, r.song.artist) },
        ...extra,
        { key: 'duration', label: T('common.duration'), cls: 'col-num', render: (r) => Util.fmtClock(r.song.duration) },
        { key: 'added', label: T('common.added'), cls: 'col-date', render: (r) => Util.fmtDate(r.addedAt) },
        { key: 'actions', label: T('common.actions'), sortable: false, cls: 'col-actions', render: (r) => PlaylistPage._actions(r, null, null, p.id, buttons) },
      ],
      mobile: {
        lead: (r) => Covers.el(r.song),
        title: (r) => r.song.title,
        sub: (r) => [r.song.artist, r.song.mix ? `(${r.song.mix})` : ''].filter(Boolean).join(' - '),
        mark: (r) => (Store.server.on && Store.can('offline') && r.song.file ? Icons.download : ''),
        sheetTitle: (r) => Util.songLine(r.song),
        tap: (r) => playSong(r.song),
        more: (r) => [iconButton('act.act--green', Icons.plus, T('common.addToQueue'), () => Player.addToQueue(r.song.id)), ...PlaylistPage._moreButtons(r.song, p.id)],
      },
    });
    PlaylistPage._sizeColumns(table, scroller);
    if (!scroller._sized) {
      scroller._sized = true;
      new ResizeObserver(() => PlaylistPage._sizeColumns(table, scroller)).observe(scroller);
    }
    this._drawPlayState();
  },

  _drawPlayState() {
    if (!this.id) return;
    const active = this._groupActive();
    const playing = active && Player.isPlaying;
    const label = (on) => (Store.uiMode === 'mobile' ? (on ? Icons.pause : Icons.play)
      : (on ? Icons.pause : Icons.play) + `<span>${on ? T('common.pause') : T('common.play')}</span>`);
    $('grPlay').innerHTML = (playing ? Icons.pause : Icons.play) + `<span>${playing ? T('common.pause') : T('common.play')}</span>`;
    $('grPlay').disabled = !Store.rowsOf(this.listId).length;
    const shuffle = Player.queue.shuffle;
    const drawShuffle = (btn, mobileIcon) => {
      btn.classList.toggle('toggle--on', shuffle);
      btn.setAttribute('aria-pressed', String(shuffle));
      btn.setAttribute('aria-label', T('common.shuffle'));
      btn.innerHTML = mobileIcon ? Icons.shuffle
        : `<span class="toggle__box">${shuffle ? Icons.check : ''}</span>${Icons.shuffle}<span>${T('common.shuffle')}</span>`;
    };
    drawShuffle($('grShuffle'), Store.uiMode === 'mobile');
    for (const [id, f] of this._frames) {
      // Playing: a song of it, played from it or from the whole group.
      f.playing.hidden = !(Player.isPlaying && Player.currentId && f.songs.has(Player.currentId)
        && (Player.contextId === id || Player.contextId === this.listId));
      // Its name's room as much narrower, so the buttons stay lined up with the other frames'.
      f.playing.parentNode.classList.toggle('gframe__head--playing', !f.playing.hidden);
      const on = Player.contextId === id && !!Player.currentId && Player.isPlaying;
      f.play.innerHTML = label(on);
      f.play.title = on ? T('common.pause') : T('group.frame.play.tooltip', { playlist: (Store.playlist(id) || {}).name || '' });
      f.play.setAttribute('aria-label', on ? T('common.pause') : T('common.play'));
      f.play.disabled = !f.count;
      drawShuffle(f.shuffle, Store.uiMode === 'mobile');
    }
    // The song playing marked in the list it plays from.
    for (const node of document.querySelectorAll('#grFrames .gframe')) {
      const listId = node.dataset.id;
      for (const tr of node.querySelectorAll('tbody tr[data-id], .mrow[data-id]')) {
        tr.classList.toggle('row--current', tr.dataset.id === Player.currentId && (Player.contextId === listId || Player.contextId === this.listId));
      }
    }
    for (const [listId, buttons] of this._playButtons) {
      for (const [songId, btn] of buttons) {
        const on = songId === Player.currentId && Player.isPlaying && Player.contextId === listId;
        if (!!btn._playing === on) continue;
        btn._playing = on;
        btn.innerHTML = on ? Icons.pause : Icons.play;
        btn.title = on ? T('common.pause') : T('common.play');
      }
    }
  },
};
