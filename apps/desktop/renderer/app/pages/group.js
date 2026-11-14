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
// The group and each of its playlists have a Shuffle of their own (kept per
// device, settings listShuffle): a list started here plays with its own, and
// while it plays its Shuffle is the player's. The group's Play picks one of
// its playlists at random and plays it; with the group's Shuffle on it plays
// the whole group as one list instead (Store's "group:<id>"), each next song
// a random song of a random one of its playlists (queue.js poolsOf), so a
// short playlist comes up as often as a long one. Pressed while something else plays
// (one of its playlists started by its own Play too), it starts anew with a
// new queue; only while the group itself plays it pauses and carries on. The
// playlist a song plays from has the speaker beside its icon. Download marks every playlist in it to be kept on this device.
//
// Share (4.5.3) shares a group of yours with the other profiles, its
// playlists with it. A group another profile shares and you follow opens
// here too (its folder in the menu is green): its owner's playlists, to
// play and download, with Unfollow Group instead of Share.

const GroupPage = {
  id: null,
  filter: '',
  // The playlists open on this page, per group (while the app runs): group id -> Set of playlist ids.
  _open: new Map(),
  _playButtons: new Map(), // playlist id -> (song id -> its row's Play)
  _sorts: new Map(), // playlist id -> its frame's sort (while the app runs)
  _picked: new Map(), // group id -> the playlist its Play picked, while that plays
  _frames: new Map(), // playlist id -> { play, shuffle } of its head, for the play state

  init() {
    // A group's mix is shuffled by its playlists: each song a random song of a random one (queue.js).
    Player.queue.poolsOf = (contextId) => {
      const id = String(contextId || '');
      if (!id.startsWith(GROUP_PREFIX)) return null;
      return Store.playlistsInGroup(id.slice(GROUP_PREFIX.length)).map((p) => Store.rowsOf(p.id).map((r) => r.song.id));
    };
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
    $('grShare').onclick = () => {
      const g = Store.group(this.id);
      if (!g) return;
      if (g.isShared) Groups.setFollowing(g, false);
      else Groups.setShared(g, !g.shared);
    };
    Store.onLibrary((lib, change) => {
      if (Nav.page !== 'group') return;
      // Nothing its lists show changed: it stays as it is drawn.
      if (change.quiet()) return;
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
      this._followPlayer();
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

  /**
   * Whether the group itself is the list playing (or paused): the whole
   * group, or the playlist its Play picked.
   */
  _groupActive() {
    if (!Player.currentId) return false;
    return Player.contextId === this.listId || (!!Player.contextId && this._picked.get(this.id) === Player.contextId);
  },

  // ---- each list's own Shuffle ----

  /** A list's Shuffle here: the player's while it plays, else its own kept one. */
  shuffleOf(listId) {
    if (Player.currentId && Player.contextId === listId) return !!Player.queue.shuffle;
    return !!(Store.settings.listShuffle || {})[listId];
  },

  _keepShuffle(listId, on) {
    const all = { ...(Store.settings.listShuffle || {}) };
    if (!!all[listId] === on) return;
    if (on) all[listId] = true;
    else delete all[listId];
    Store.saveSettings({ listShuffle: all });
  },

  /** A list's Shuffle turned: kept, and the player's too while that list plays. */
  setShuffleOf(listId, on) {
    this._keepShuffle(listId, on);
    if (Player.currentId && Player.contextId === listId) Player.setShuffle(on);
    else this._drawPlayState();
  },

  /**
   * The player's Shuffle turned (its own button too) while a list of a group
   * plays: that list keeps it. The group's pick is forgotten once something
   * else plays.
   */
  _followPlayer() {
    // The Shuffle set for a list about to start is not the one playing's.
    if (this._switching || !Player.currentId || !Player.contextId) return;
    const ctx = String(Player.contextId);
    for (const [gid, pid] of this._picked) if (pid !== ctx) this._picked.delete(gid);
    const ours = ctx.startsWith(GROUP_PREFIX) ? !!Store.group(ctx.slice(GROUP_PREFIX.length)) : Store.groupsOf(Store.playlist(ctx)).length > 0;
    if (ours) this._keepShuffle(ctx, !!Player.queue.shuffle);
  },

  /** The player's Shuffle set to a list's own, for that list to start with. */
  _shuffleFor(listId) {
    const on = this.shuffleOf(listId);
    if (!!Player.queue.shuffle === on) return;
    this._switching = true;
    try {
      Player.setShuffle(on);
    } finally {
      this._switching = false;
    }
  },

  /** A list started here anew (a new queue), with its own Shuffle; `songId`: from that song. */
  _start(listId, songId = null) {
    this._shuffleFor(listId);
    if (songId) {
      Player.load(songId, listId);
      return;
    }
    // Loaded already but paused: a new queue from it all the same.
    if (Player.contextId === listId) Player.contextId = null;
    Player.togglePlaylist(listId);
  },

  /** A playlist's own Play: pauses and carries on while it plays, else starts it anew. */
  playList(listId) {
    if (Player.currentId && Player.contextId === listId) {
      Player.toggle();
      return;
    }
    this._picked.delete(this.id);
    this._start(listId);
  },

  /** A song of a frame: in its playlist, with that playlist's Shuffle when it starts the list. */
  playSong(song, listId) {
    if (Player.contextId !== listId) this._shuffleFor(listId);
    Player.toggleSong(song.id, listId);
  },

  // ---- the group's buttons ----

  /**
   * Play: pauses or carries on while the group itself plays; otherwise
   * anew, with a new queue: with the group's Shuffle on the whole group as
   * one list, else one of its playlists at random (with its own Shuffle).
   */
  play() {
    if (this._groupActive()) {
      Player.toggle();
      return;
    }
    this._picked.delete(this.id);
    if (this.shuffleOf(this.listId)) {
      if (Store.rowsOf(this.listId).length) this._start(this.listId);
      return;
    }
    const lists = this._lists().filter((p) => Store.rowsOf(p.id).length);
    if (!lists.length) return;
    const pick = lists[Math.floor(Math.random() * lists.length)].id;
    this._start(pick);
    this._picked.set(this.id, pick);
    this._drawPlayState();
  },

  /**
   * The group's own Shuffle. Turned on while its Play's pick plays, the
   * whole group carries on with the song playing.
   */
  shuffle() {
    const on = !this.shuffleOf(this.listId);
    const picked = this._picked.get(this.id);
    this.setShuffleOf(this.listId, on);
    if (on && picked && Player.currentId && Player.contextId === picked) {
      Player.carryOnIn(this.listId);
      Player.setShuffle(true);
    }
  },

  /** The playlists Download can keep here: yours, and the ones you follow. */
  _offlineLists() {
    return this._lists().filter((p) => this._canOffline(p));
  },

  _canOffline(p) {
    return Store.server.on && Store.can('offline') && !p.isRuled && !p.isSmart && (!p.isShared || Store.followsList(p.id));
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
    setText($('grTitle'), g.name);
    const lists = this._lists();
    const rows = Store.rowsOf(this.listId);
    const seconds = rows.reduce((sum, r) => sum + (r.song.duration || 0), 0);
    setText($('grMeta'), [Util.plural(lists.length, 'playlist'), Util.plural(rows.length, 'song'), Util.fmtClock(seconds),
      g.isShared ? T('common.byOwner', { profile: g.ownerName }) : ''].filter(Boolean).join(' · '));
    $('grSearch').placeholder = T('group.search.placeholder', { group: g.name });
    this._drawShare(g);
    this._drawOffline(rows);
    this.renderFrames();
  },

  /** Share (a group of yours) or Unfollow Group (one you follow), where the server keeps shared groups (4.5.3). */
  _drawShare(g) {
    const btn = $('grShare');
    btn.hidden = !Store.canShareGroups();
    if (btn.hidden) return;
    if (g.isShared) {
      // A plain button: the group is someone else's, there is nothing to tick.
      btn.className = 'btn gr-unfollow';
      btn.removeAttribute('aria-pressed');
      btn.title = T('groups.unfollow.tooltip', { group: g.name });
      setText(btn, T('groups.unfollow'));
      btn._html = undefined;
      return;
    }
    const on = !!g.shared;
    btn.className = 'toggle' + (on ? ' toggle--on' : '');
    btn.setAttribute('aria-pressed', String(on));
    btn.title = T(on ? 'groups.share.on.tooltip' : 'groups.share.tooltip', { group: g.name });
    btn.setAttribute('aria-label', T('common.share'));
    setHtml(btn, Store.uiMode === 'mobile' ? Icons.share
      : `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.share}<span>${T('common.share')}</span>`);
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
      setHtml(btn, Icons.download);
      btn.setAttribute('aria-label', btn.title);
    } else {
      setHtml(btn, `<span class="toggle__box">${on ? Icons.check : ''}</span>${Icons.download}<span>${T('common.download')}</span>`);
    }
    const here = rows.filter((r) => r.song.file).length;
    setText(note, !rows.length || !lists.some((p) => Store.isOffline(p.id)) ? ''
      : here === rows.length ? T('playlist.download.state.allDownloaded') : T('playlist.download.state.someDownloaded', { done: here, count: rows.length }));
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
    // Drawn again in place (4.6): a playlist's frame stays in the page (its
    // own scrolling with it), its head while it comes out the same, and its
    // song list keeps the rows that show the same; only what changed is put
    // in anew (a library change while songs come down draws it often). The
    // page's place is kept, and the frames keep their height meanwhile.
    const pages = $('pages');
    const pageTop = pages.scrollTop;
    box.style.minHeight = `${box.offsetHeight}px`;
    // Another group's frames are not this one's, also of a playlist in both.
    const was = this._drawnFor === this.id
      ? new Map([...box.children].filter((n) => n._frame).map((n) => [n.dataset.id, n])) : new Map();
    this._drawnFor = this.id;
    const draws = [];
    const frames = [];
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
      frames.push(this._frame(p, rows, words.length > 0 || this._isOpen(p), was.get(p.id), draws));
    }
    // The Play buttons of song lists no longer in the page are let go.
    const withSongs = new Set(frames.filter((f) => f._frame.kind === 'songs').map((f) => f.dataset.id));
    for (const id of [...this._playButtons.keys()]) if (!withSongs.has(id)) this._playButtons.delete(id);
    setChildren(box, frames, { alike: false, gone: (node) => releaseCovers([node]) });
    // The open frames' songs, now that their boxes are in the page and can measure where their rows show.
    for (const draw of draws) draw();
    box.style.minHeight = '';
    pages.scrollTop = pageTop;
    $('grEmpty').hidden = lists.length > 0;
    setText($('grEmptyText'), T('group.empty'));
    $('grNoMatch').hidden = !words.length || shown > 0 || !lists.length;
    setText($('grFiltered'), words.length && lists.length ? T('playlist.showing', { shown: found, count: total }) : '');
    this._drawPlayState();
  },

  /**
   * A playlist's frame: `was`, the one in the page, when it is of the same
   * kind (closed, open with songs, open and empty), else a new one. Its head
   * is made each time and put in only when it came out differently, or from
   * a playlist that changed (what its buttons were made with).
   */
  _frame(p, rows, open, was, draws) {
    const count = Store.songCount(p);
    const seconds = Store.durationOf(p);
    const play = h('button.btn.btn--play.gframe__play', { type: 'button', onclick: () => this.playList(p.id) });
    const shuffle = h('button.toggle.gframe__shuffle', { type: 'button', title: T('group.frame.shuffle.tooltip', { playlist: p.name }), onclick: () => this.setShuffleOf(p.id, !this.shuffleOf(p.id)) });
    // The speaker beside its icon while a song of it plays (_drawPlayState).
    const playing = h('span.gframe__playing', { html: Icons.speaker, title: T('common.playing'), hidden: true });
    const songsOf = new Set((p.entries || []).map((e) => e.songId));
    const head = h('div.gframe__head', {
      role: 'button',
      tabIndex: 0,
      'aria-expanded': String(open),
      title: open ? T('group.frame.hide.tooltip', { playlist: p.name }) : T('group.frame.show.tooltip', { playlist: p.name }),
      onclick: (e) => {
        // A button of the head (Play, Shuffle ...) never opens or closes it: also when
        // its press redrew the button first, so the node clicked is no longer in the page.
        if (!e.currentTarget.contains(e.target) || e.target.closest('button')) return;
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
    h('span.gframe__icon', { html: listIcon(p, this.id) }),
    // The speaker right beside its icon while a song of it plays, its name and numbers moved over.
    playing,
    h('span.gframe__text',
      h('span.gframe__name', { title: p.name }, p.name),
      h('span.gframe__sub', [Util.plural(count, 'song'), Util.fmtClock(seconds), p.ownerName ? T('common.byOwner', { profile: p.ownerName }) : ''].filter(Boolean).join(' · '))),
    h('span.gframe__buttons', play, shuffle, this._offlineButton(p)),
    this._shareButton(p));
    const kind = !open ? 'closed' : rows.length ? 'songs' : 'empty';
    const html = head.outerHTML;
    let frame = was && was._frame.kind === kind ? was : null;
    if (frame) {
      const f = frame._frame;
      if (f.html === html && sameDeep(f.p, p)) {
        // The head in the page stays, with its buttons (the play state is drawn into them).
        this._frames.set(p.id, {
          play: f.play, shuffle: f.shuffle, count, playing: f.playing, songs: songsOf,
        });
      } else {
        frame.replaceChild(head, frame.firstChild);
        Object.assign(f, {
          html, p, play, shuffle, playing,
        });
        this._frames.set(p.id, {
          play, shuffle, count, playing, songs: songsOf,
        });
      }
    } else {
      frame = h('div.gframe' + (open ? '.gframe--open' : ''), { dataset: { id: p.id } }, head);
      frame._frame = {
        kind, html, p, play, shuffle, playing,
      };
      this._frames.set(p.id, {
        play, shuffle, count, playing, songs: songsOf,
      });
      if (kind === 'empty') frame.appendChild(h('p.muted-text.gframe__empty', T('playlist.empty.playlist')));
      if (kind === 'songs') {
        const songs = h('div.gframe__songs', { dataset: { id: p.id } });
        const table = h('table.table.table--songs.gframe__table', { dataset: { id: p.id } });
        songs.appendChild(table);
        frame.appendChild(songs);
        frame._frame.songs = songs;
        frame._frame.table = table;
      }
    }
    if (kind === 'songs') {
      const { songs, table } = frame._frame;
      draws.push(() => this._songTable(table, songs, p, rows));
    }
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

  /**
   * Share for a playlist of yours, Following for one you follow (both need a
   * server with profiles). In a group you follow (4.5.3) Following is that
   * group's: turned off, the playlist leaves this group only.
   */
  _shareButton(p) {
    if (!Store.canShare() || p.isRuled || p.isFavourites) return null;
    const g = Store.group(this.id);
    if (g && g.isShared && p.isShared) {
      const btn = h('button.toggle.toggle--on.gframe__share', {
        type: 'button',
        'aria-pressed': 'true',
        title: T('groups.inGroup.unfollow.tooltip', { playlist: p.name, group: g.name }),
        onclick: () => Groups.setFollowingIn(g.id, p, false),
      });
      btn.innerHTML = Store.uiMode === 'mobile' ? Icons.share
        : `<span class="toggle__box">${Icons.check}</span>${Icons.share}<span>${T('playlist.follow.following')}</span>`;
      return btn;
    }
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
      this.playSong(song, p.id);
    };
    // The Play buttons of the rows that stay are kept with them.
    const buttons = this._playButtons.get(p.id) || new Map();
    this._playButtons.set(p.id, buttons);
    const offline = !!(Store.server.on && Store.can('offline'));
    const extra = PlaylistPage._extraColumns(false);
    PlaylistPage._shareColumns(extra.map((c) => c.key), table);
    const sort = this._sortOf(p);
    renderTable(table, {
      rows,
      sort,
      rowKey: (r) => r.song.id,
      // As the playlist's own page: a row shows its song as the lists show it and when it was added.
      shows: (r) => [Store.look(r.song), r.addedAt],
      look: [p.id, offline ? 1 : 0].join('\u0000'),
      onSort: (key) => {
        this._sorts.set(p.id, Util.cycleSort(this._sortOf(p), key));
        this.renderFrames();
      },
      onRowDblClick: (r) => this._start(p.id, r.song.id),
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
        { key: 'actions', label: T('common.actions'), sortable: false, cls: 'col-actions', render: (r) => PlaylistPage._actions(r, null, null, p.id, buttons, (song) => this.playSong(song, p.id)) },
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
    // Buttons of rows that went without a word (the table made anew).
    for (const [songId, btn] of buttons) if (!btn.isConnected) buttons.delete(songId);
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
    setHtml($('grPlay'), (playing ? Icons.pause : Icons.play) + `<span>${playing ? T('common.pause') : T('common.play')}</span>`);
    $('grPlay').disabled = !Store.rowsOf(this.listId).length;
    const drawShuffle = (btn, mobileIcon, shuffle) => {
      btn.classList.toggle('toggle--on', shuffle);
      btn.setAttribute('aria-pressed', String(shuffle));
      btn.setAttribute('aria-label', T('common.shuffle'));
      setHtml(btn, mobileIcon ? Icons.shuffle
        : `<span class="toggle__box">${shuffle ? Icons.check : ''}</span>${Icons.shuffle}<span>${T('common.shuffle')}</span>`);
    };
    drawShuffle($('grShuffle'), Store.uiMode === 'mobile', this.shuffleOf(this.listId));
    for (const [id, f] of this._frames) {
      // Playing: a song of it, played from it or from the whole group.
      f.playing.hidden = !(Player.isPlaying && Player.currentId && f.songs.has(Player.currentId)
        && (Player.contextId === id || Player.contextId === this.listId));
      // Its name's room as much narrower, so the buttons stay lined up with the other frames'.
      f.playing.parentNode.classList.toggle('gframe__head--playing', !f.playing.hidden);
      const on = Player.contextId === id && !!Player.currentId && Player.isPlaying;
      setHtml(f.play, label(on));
      f.play.title = on ? T('common.pause') : T('group.frame.play.tooltip', { playlist: (Store.playlist(id) || {}).name || '' });
      f.play.setAttribute('aria-label', on ? T('common.pause') : T('common.play'));
      f.play.disabled = !f.count;
      drawShuffle(f.shuffle, Store.uiMode === 'mobile', this.shuffleOf(id));
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
