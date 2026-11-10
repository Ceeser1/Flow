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
    // The main scroll bar's track reaches the window's top once the page is scrolled, and stops where
    // the contents do once it is scrolled to the end (style.css).
    const pages = $('pages');
    const edges = () => {
      pages.classList.toggle('pages--scrolled', pages.scrollTop > 0);
      pages.classList.toggle('pages--end', pages.scrollTop + pages.clientHeight >= pages.scrollHeight - 1);
    };
    pages.addEventListener('scroll', edges, { passive: true });
    const sizes = new ResizeObserver(edges);
    sizes.observe(pages);
    for (const node of pages.querySelectorAll('.page')) sizes.observe(node);
    $('menuSearch').innerHTML = Icons.search + `<span>${T('common.search')}</span>`;
    $('menuAdd').innerHTML = Icons.add + `<span>${T('common.addSongs')}</span>`
      + `<span id="menuAddBadge" class="menu__badge" hidden title="${T('import.bar.running.tooltip')}"></span>`;
    this._entry('menuAllSongs', T('common.allSongs'), 'allSongsMenuOpen', { icon: Icons.library });
    // The speaker while All Songs plays, or a part of it that is folded away.
    this._allPlaying = h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') });
    $('menuAllSongs').appendChild(this._allPlaying);
    this._entry('menuPlaylists', T('common.playlists'), 'playlistsMenuOpen');
    this._entry('menuGroups', T('common.playlistGroups'), 'groupsMenuOpen', { icon: Icons.folder });
    // The speaker while one of the groups' lists plays and they are folded away.
    this._groupsPlaying = h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') });
    $('menuGroups').appendChild(this._groupsPlaying);
    this._entry('menuFollowed', T('common.followedPlaylists'), 'followedMenuOpen');
    this._entry('menuSessions', T('common.activeJams'), 'sessionsMenuOpen', { icon: Icons.sessions });
    $('menuSessions').appendChild(h('span.menu__badge', { id: 'menuSessionsBadge', hidden: true }));
    this._entry('menuTrend', T('common.yourListeningTrend'), 'trendMenuOpen', {
      icon: '<img class="menu__img" src="../images/trend.png" alt="" />',
      shut: true,
    });
    // The speaker while one of its lists plays and they are folded away.
    this._trendPlaying = h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') });
    $('menuTrend').appendChild(this._trendPlaying);
    $('menuSearch').onclick = () => this.show('search');
    $('menuAdd').onclick = () => this.show('add');
    $('menuAllSongs').onclick = () => this.openPlaylist('all');
    $('menuPlaylists').onclick = () => this.show('playlists');
    // Playlist Groups: the Playlists page at its groups.
    $('menuGroups').onclick = () => this.show('playlists', { at: 'groups' });
    $('menuFollowed').onclick = () => this.show('followed');
    $('menuSessions').onclick = () => this.show('sessions');
    $('menuTrend').onclick = () => this.show('trend');
    // A playlist dragged anywhere on the Playlists entry or its list but a group leaves its group (4.5).
    Groups.dropTarget($('menuPlaylistList'), '');
    Groups.dropTarget($('menuPlaylists'), '');
    // And on Followed Playlists (4.5.1), as a followed one leaves its group.
    Groups.dropTarget($('menuFollowedList'), '');
    Groups.dropTarget($('menuFollowed'), '');
    Store.onLibrary(() => this.drawMenu());
    Store.onServer(() => this.drawMenu());
    Player.onChange(() => this.drawMenu());
    Session.onChange(() => this.drawMenu());
    Store.onSettings((patch) => {
      if (!('showTrend' in patch)) return;
      // Hidden while its page or one of its lists is open: back to All Songs.
      if (!patch.showTrend && (this.page === 'trend' || (this.page === 'playlist' && SmartLists.isSmart(this.playlistId)))) {
        this.openPlaylist('all');
      } else {
        this.drawMenu();
      }
    });
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

  /** A jam's song for its tooltip: "Title - Artist", "Paused: " in front while it is. */
  _jamSong(s) {
    const line = s.song.artist ? `${s.song.title} - ${s.song.artist}` : s.song.title;
    return s.playing ? line : `${T('common.paused')} ${line}`;
  },

  _drawArrow(key, open, what) {
    const arrow = this._arrows[key];
    arrow.classList.toggle('menu__chevron--open', open);
    arrow.title = open ? T('nav.section.hide.tooltip', { what }) : T('nav.section.show.tooltip', { what });
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
    $('menuAllSongs').classList.toggle('menu__item--active', this.page === 'playlist' && this.playlistId === 'all');
    $('menuPlaylists').classList.toggle('menu__item--active', this.page === 'playlists');
    $('menuFollowed').classList.toggle('menu__item--active', this.page === 'followed');
    $('menuSessions').classList.toggle('menu__item--active', this.page === 'sessions');
    $('menuTrend').classList.toggle('menu__item--active', this.page === 'trend');
    const playlistsOpen = this._open('playlistsMenuOpen');
    const groupsOpen = this._open('groupsMenuOpen');
    const followedOpen = this._open('followedMenuOpen');
    const trendOpen = this._open('trendMenuOpen');
    this._drawArrow('playlistsMenuOpen', playlistsOpen, T('nav.section.what.playlists'));
    this._drawArrow('groupsMenuOpen', groupsOpen, T('nav.section.what.playlistGroups'));
    this._drawArrow('followedMenuOpen', followedOpen, T('nav.section.what.followedPlaylists'));
    this._drawArrow('trendMenuOpen', trendOpen, T('nav.section.what.listeningTrend'));
    $('menuPlaylistList').hidden = !playlistsOpen;

    // The list playing has the speaker, and its bar on the left stays green.
    const item = (p) => {
      const active = this.page === 'playlist' && this.playlistId === p.id;
      const playing = Player.contextId === p.id && Player.isPlaying;
      return h('button.menu__sub'
        + (active ? '.menu__sub--active' : '')
        + (playing ? '.menu__sub--playing' : ''), {
        type: 'button',
        title: p.name,
        onclick: () => this.openPlaylist(p.id),
      },
      // Downloaded Songs has its icon before its name, a followed playlist its green one (4.5.1).
      p.isDevice || p.isShared ? h('span.menu__sub-icon', { html: listIcon(p) }) : null,
      h('span.menu__sub-name', p.menuName || p.name),
      playing ? h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') }) : null);
    };

    // All Songs: with a Flow Server, under it Downloaded Songs (every song on
    // this device) and the songs each profile added ("from ..."); the arrow
    // only while there are any.
    const device = Store.devicePlaylist();
    const froms = [...(device ? [device] : []), ...Store.fromPlaylists()];
    const allOpen = this._open('allSongsMenuOpen');
    this._drawArrow('allSongsMenuOpen', allOpen, T('nav.section.what.downloaded'));
    this._arrows.allSongsMenuOpen.hidden = !froms.length;
    $('menuAllSongsList').hidden = !froms.length || !allOpen;
    const allList = clear($('menuAllSongsList'));
    for (const p of froms) allList.appendChild(item(p));
    const fromPlaying = froms.some((p) => p.id === Player.contextId);
    this._allPlaying.hidden = !Player.isPlaying || !(Player.contextId === 'all' || (fromPlaying && !allOpen));

    // Playlists: Favourites, then the playlists in no group.
    const list = clear($('menuPlaylistList'));
    list.appendChild(item(Store.favouritesPlaylist()));
    for (const p of Store.singlePlaylists()) {
      const el = item(p);
      Groups.draggable(el, p);
      list.appendChild(el);
    }

    // Playlist Groups (4.5; their own entry since 4.5.1): each group as a
    // folder, a click opens or closes it (remembered per device, as on the
    // Playlists page). Closed, it shows the speaker while one of its lists
    // plays and its bar while one of them is open. Followed playlists can
    // be in them too. On the computer a playlist can be dragged onto a
    // folder, or onto the single ones to leave its group (groups.js).
    const groups = Store.groups();
    $('menuGroups').hidden = !Store.canGroup();
    this._arrows.groupsMenuOpen.hidden = !groups.length;
    $('menuGroupsList').hidden = !Store.canGroup() || !groups.length || !groupsOpen;
    const groupList = clear($('menuGroupsList'));
    const inGroups = new Set(groups.flatMap((g) => Store.playlistsInGroup(g.id).map((p) => p.id)));
    this._groupsPlaying.hidden = groupsOpen || !Player.isPlaying || !inGroups.has(Player.contextId);
    $('menuGroups').classList.toggle('menu__item--active', this.page === 'playlist' && !groupsOpen && inGroups.has(this.playlistId));
    for (const g of groups) {
      const inside = Store.playlistsInGroup(g.id);
      const open = Groups.isOpen(g.id);
      const playing = !open && inside.some((p) => Player.contextId === p.id && Player.isPlaying);
      const active = !open && this.page === 'playlist' && inside.some((p) => p.id === this.playlistId);
      const folder = h('button.menu__sub.menu__group'
        + (active ? '.menu__sub--active' : '')
        + (playing ? '.menu__sub--playing' : ''), {
        type: 'button',
        title: open ? T('groups.hide.tooltip', { group: g.name }) : T('groups.show.tooltip', { group: g.name }),
        'aria-expanded': String(open),
        onclick: () => {
          Groups.toggle(g.id);
          this.drawMenu();
          if (this.page === 'playlists') PlaylistsPage.render();
        },
      },
      h('span.menu__chevron' + (open ? '.menu__chevron--open' : ''), { html: Icons.chevron }),
      h('span.menu__sub-icon', { html: Icons.folder }),
      h('span.menu__sub-name', g.name),
      playing ? h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') }) : null);
      Groups.dropTarget(folder, g.id);
      groupList.appendChild(folder);
      if (!open) continue;
      for (const p of inside) {
        const el = item(p);
        el.classList.add('menu__sub--in-group');
        Groups.draggable(el, p);
        Groups.dropTarget(el, g.id);
        groupList.appendChild(el);
      }
    }

    // Followed Playlists: a main entry of its own, only while one is
    // followed; under it the ones in no group (4.5.1).
    const followed = Store.followedPlaylists();
    const singleFollowed = Store.singleFollowed();
    $('menuFollowed').hidden = !followed.length;
    this._arrows.followedMenuOpen.hidden = !singleFollowed.length;
    $('menuFollowedList').hidden = !singleFollowed.length || !followedOpen;
    const followedList = clear($('menuFollowedList'));
    for (const p of singleFollowed) {
      const el = item(p);
      Groups.draggable(el, p);
      followedList.appendChild(el);
    }

    // Active Sessions: only while another device plays on the server, or this one has company.
    $('menuSessions').hidden = !Session.visible;
    const others = Session.others().length;
    $('menuSessionsBadge').hidden = !others;
    $('menuSessionsBadge').textContent = String(others);
    $('menuSessionsBadge').title = T('nav.jams.othersPlaying.tooltip', { devices: Util.plural(others, 'other device'), count: others });
    // Under it the sessions, as the playlists: one opens the page at it.
    const sessionsOpen = this._open('sessionsMenuOpen');
    this._drawArrow('sessionsMenuOpen', sessionsOpen, T('nav.section.what.jams'));
    $('menuSessionsList').hidden = !Session.visible || !sessionsOpen;
    const sessionList = clear($('menuSessionsList'));
    if (Session.visible && sessionsOpen) {
      // A guest in another server's session: that server's songs, to play and queue.
      const guestList = Store.guestPlaylist();
      if (Session.guest && guestList) {
        sessionList.appendChild(h('button.menu__sub', {
          type: 'button',
          title: T('nav.jams.guestQueue.tooltip', { session: guestList.name }),
          onclick: () => this.openPlaylist(GUEST_ID),
        }, h('span.menu__sub-name', guestList.name)));
      }
      const inId = Session.mine ? Session.mine.session.id : null;
      const sessions = [...Session.list].sort((a, b) => a.name.localeCompare(b.name));
      for (const s of sessions) {
        // Its tag as on the page, kept whole when a long name is cut.
        const tag = s.host.client === Store.server.clientId ? T('common.you') : s.id === inId ? T('common.joined') : '';
        const song = s.song ? this._jamSong(s) : T('common.nothingLoaded');
        const lower = s.host.client === Store.server.clientId ? T('common.you.lower') : T('nav.jams.tag.joined.lower');
        sessionList.appendChild(h('button.menu__sub' + (s.playing ? '.menu__sub--playing' : ''), {
          type: 'button',
          title: tag ? `${s.name} (${lower})\n${song}` : `${s.name}\n${song}`,
          onclick: () => this.show('sessions', { sessionId: s.id }),
        },
        h('span.menu__sub-name', s.name),
        tag ? h('span.session-tag', tag) : null,
        s.playing ? h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') }) : null));
      }
      // Other servers' sessions on this network, as "Server - Device": one opens the page at it (Join as guest).
      const nearby = Store.can('guests') ? Session.nearby.flatMap((n) => n.sessions.map((s) => ({ s, n, label: `${n.name} - ${Session.deviceOf(s)}` }))) : [];
      nearby.sort((a, b) => a.label.localeCompare(b.label));
      for (const { s, n, label } of nearby) {
        const joined = !!Session.guest && Session.guest.serverId === n.id && s.id === inId;
        const song = s.song ? this._jamSong(s) : T('common.nothingLoaded');
        sessionList.appendChild(h('button.menu__sub' + (s.playing ? '.menu__sub--playing' : ''), {
          type: 'button',
          title: T(joined ? 'nav.jams.nearby.joined.tooltip' : 'nav.jams.nearby.tooltip', { session: s.name, server: n.name, song }),
          onclick: () => this.show('sessions', { sessionId: s.id }),
        },
        h('span.menu__sub-name', label),
        joined ? h('span.session-tag', T('common.joined')) : null,
        s.playing ? h('span.menu__playing', { html: Icons.speaker, title: T('common.playing') }) : null));
      }
    }

    // Your listening trend: there unless switched off in Settings, its lists closed until opened.
    const trendOn = Store.settings.showTrend !== false;
    $('menuTrend').hidden = !trendOn;
    $('menuTrendList').hidden = !trendOn || !trendOpen;
    const trendList = clear($('menuTrendList'));
    for (const p of Store.smartNames()) trendList.appendChild(item(p));
    this._trendPlaying.hidden = trendOpen || !(SmartLists.isSmart(Player.contextId) && Player.isPlaying);
  },
};
