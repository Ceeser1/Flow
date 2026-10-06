'use strict';

// The menu on the left and which page the content frame shows.

const Nav = {
  page: null,
  playlistId: null,
  // The pages shown before this one ({ page, playlistId }), for the phone's
  // Back; the last is the one Back returns to.
  history: [],
  _at: null,

  init() {
    $('menuSearch').innerHTML = Icons.search + '<span>Search</span>';
    $('menuAdd').innerHTML = Icons.add + '<span>Add Songs</span>'
      + '<span id="menuAddBadge" class="menu__badge" hidden title="Playlist import running"></span>';
    this._entry('menuPlaylists', 'Playlists', 'playlistsMenuOpen');
    this._entry('menuFollowed', 'Followed Playlists', 'followedMenuOpen');
    this._entry('menuSessions', 'Active Jams', 'sessionsMenuOpen', { icon: Icons.sessions });
    $('menuSessions').appendChild(h('span.menu__badge', { id: 'menuSessionsBadge', hidden: true }));
    this._entry('menuTrend', 'Your listening trend', 'trendMenuOpen', {
      icon: '<img class="menu__img" src="../images/trend.png" alt="" />',
      shut: true,
    });
    // The speaker while one of its lists plays and they are folded away.
    this._trendPlaying = h('span.menu__playing', { html: Icons.speaker, title: 'Playing' });
    $('menuTrend').appendChild(this._trendPlaying);
    $('menuSearch').onclick = () => this.show('search');
    $('menuAdd').onclick = () => this.show('add');
    $('menuPlaylists').onclick = () => this.show('playlists');
    $('menuFollowed').onclick = () => this.show('followed');
    $('menuSessions').onclick = () => this.show('sessions');
    $('menuTrend').onclick = () => this.show('trend');
    Store.onLibrary(() => this.drawMenu());
    Store.onServer(() => this.drawMenu());
    Player.onChange(() => this.drawMenu());
    Session.onChange(() => this.drawMenu());
  },

  /**
   * A main entry with the icon, then an arrow that opens and closes the lists
   * under it (remembered in `key`; open until closed, or with `shut` closed
   * until opened), then the name. The rest of the button still opens the page.
   */
  _entry(id, label, key, { icon = Icons.playlists, shut = false } = {}) {
    (this._shut = this._shut || {})[key] = shut;
    const arrow = h('span.menu__chevron.menu__chevron--toggle', {
      role: 'button',
      html: Icons.chevron,
      onclick: (e) => {
        e.stopPropagation();
        Store.saveSettings({ [key]: !this._open(key) });
        this.drawMenu();
      },
    });
    $(id).innerHTML = icon;
    $(id).append(arrow, h('span', label));
    (this._arrows = this._arrows || {})[key] = arrow;
  },

  _open(key) {
    return this._shut[key] ? Store.settings[key] === true : Store.settings[key] !== false;
  },

  _drawArrow(key, open, what) {
    const arrow = this._arrows[key];
    arrow.classList.toggle('menu__chevron--open', open);
    arrow.title = open ? `Hide ${what}` : `Show ${what}`;
    arrow.setAttribute('aria-expanded', String(open));
  },

  currentPlaylistId() {
    return this.page === 'playlist' ? this.playlistId : null;
  },

  show(page, opts = {}) {
    // Leaving All Songs ends "adding songs to" mode.
    if (page !== 'playlist' && typeof PlaylistPage !== 'undefined') PlaylistPage.pickFor = null;
    // The preview belongs to the Add Songs page and stops when it is left.
    if (this.page === 'add' && page !== 'add') AddPage.audio.pause();
    const at = { page, playlistId: page === 'playlist' ? this.playlistId : null };
    if (this._at && !opts.back && (this._at.page !== at.page || this._at.playlistId !== at.playlistId)) {
      this.history.push(this._at);
      if (this.history.length > 50) this.history.shift();
    }
    this._at = at;
    this.page = page;
    for (const node of document.querySelectorAll('.page')) {
      node.hidden = node.id !== 'page-' + page;
    }
    $('pages').scrollTop = 0;
    if (page === 'search') SearchPage.show(opts);
    else if (page === 'add') AddPage.show(opts);
    else if (page === 'playlists') PlaylistsPage.show(opts);
    else if (page === 'followed') FollowedPage.show(opts);
    else if (page === 'sessions') SessionsPage.show(opts);
    else if (page === 'trend') TrendPage.show(opts);
    else if (page === 'playlist') PlaylistPage.show(this.playlistId, opts);
    this.drawMenu();
  },

  /** Goes back to the page shown before this one; false when there is none. */
  back() {
    while (this.history.length) {
      const prev = this.history.pop();
      if (prev.page !== 'playlist') {
        this.show(prev.page, { back: true });
        return true;
      }
      // A playlist deleted since is skipped.
      if (Store.playlist(prev.playlistId)) {
        this.openPlaylist(prev.playlistId, { back: true });
        return true;
      }
    }
    return false;
  },

  openPlaylist(id, opts = {}) {
    this.playlistId = Store.playlist(id) ? id : 'all';
    Store.saveSettings({ lastPlaylistId: this.playlistId });
    this.show('playlist', opts);
  },

  drawMenu() {
    $('menuSearch').classList.toggle('menu__item--active', this.page === 'search');
    $('menuAdd').classList.toggle('menu__item--active', this.page === 'add');
    $('menuPlaylists').classList.toggle('menu__item--active', this.page === 'playlists');
    $('menuFollowed').classList.toggle('menu__item--active', this.page === 'followed');
    $('menuSessions').classList.toggle('menu__item--active', this.page === 'sessions');
    $('menuTrend').classList.toggle('menu__item--active', this.page === 'trend');
    const playlistsOpen = this._open('playlistsMenuOpen');
    const followedOpen = this._open('followedMenuOpen');
    const trendOpen = this._open('trendMenuOpen');
    this._drawArrow('playlistsMenuOpen', playlistsOpen, 'the playlists');
    this._drawArrow('followedMenuOpen', followedOpen, 'the followed playlists');
    this._drawArrow('trendMenuOpen', trendOpen, 'the listening trend lists');
    $('menuPlaylistList').hidden = !playlistsOpen;

    const list = clear($('menuPlaylistList'));
    // The list playing has the speaker, and its bar on the left stays green.
    const item = (p) => {
      const active = this.page === 'playlist' && this.playlistId === p.id;
      const playing = Player.contextId === p.id && Player.isPlaying;
      return h('button.menu__sub'
        + (active ? '.menu__sub--active' : '')
        + (playing ? '.menu__sub--playing' : '')
        + (p.isAll ? '.menu__sub--all' : ''), {
        type: 'button',
        title: p.name,
        onclick: () => this.openPlaylist(p.id),
      },
      h('span.menu__sub-name', p.name),
      playing ? h('span.menu__playing', { html: Icons.speaker, title: 'Playing' }) : null);
    };

    list.appendChild(item(Store.allSongsPlaylist()));
    list.appendChild(item(Store.favouritesPlaylist()));
    for (const p of Store.sortedPlaylists()) list.appendChild(item(p));

    // Followed Playlists: a main entry of its own, only while one is followed.
    const followed = Store.followedPlaylists();
    $('menuFollowed').hidden = !followed.length;
    $('menuFollowedList').hidden = !followed.length || !followedOpen;
    const followedList = clear($('menuFollowedList'));
    for (const p of followed) followedList.appendChild(item(p));

    // Active Sessions: only while another device plays on the server, or this one has company.
    $('menuSessions').hidden = !Session.visible;
    const others = Session.others().length;
    $('menuSessionsBadge').hidden = !others;
    $('menuSessionsBadge').textContent = String(others);
    $('menuSessionsBadge').title = `${Util.plural(others, 'other device')} playing`;
    // Under it the sessions, as the playlists: one opens the page at it.
    const sessionsOpen = this._open('sessionsMenuOpen');
    this._drawArrow('sessionsMenuOpen', sessionsOpen, 'the jams');
    $('menuSessionsList').hidden = !Session.visible || !sessionsOpen;
    const sessionList = clear($('menuSessionsList'));
    if (Session.visible && sessionsOpen) {
      const inId = Session.mine ? Session.mine.session.id : null;
      const sessions = [...Session.list].sort((a, b) => a.name.localeCompare(b.name));
      for (const s of sessions) {
        // Its tag as on the page, kept whole when a long name is cut.
        const tag = s.host.client === Store.server.clientId ? 'You' : s.id === inId ? 'Joined' : '';
        const song = s.song ? `${s.playing ? '' : 'Paused: '}${s.song.title}${s.song.artist ? ` - ${s.song.artist}` : ''}` : 'Nothing loaded';
        sessionList.appendChild(h('button.menu__sub' + (s.playing ? '.menu__sub--playing' : ''), {
          type: 'button',
          title: `${s.name}${tag ? ` (${tag.toLowerCase()})` : ''}\n${song}`,
          onclick: () => this.show('sessions', { sessionId: s.id }),
        },
        h('span.menu__sub-name', s.name),
        tag ? h('span.session-tag', tag) : null,
        s.playing ? h('span.menu__playing', { html: Icons.speaker, title: 'Playing' }) : null));
      }
    }

    // Your listening trend: always there, its lists closed until opened.
    $('menuTrendList').hidden = !trendOpen;
    const trendList = clear($('menuTrendList'));
    for (const p of Store.smartPlaylists()) trendList.appendChild(item(p));
    this._trendPlaying.hidden = trendOpen || !(SmartLists.isSmart(Player.contextId) && Player.isPlaying);
  },
};
