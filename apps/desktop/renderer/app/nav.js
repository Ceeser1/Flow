'use strict';

// The menu on the left and which page the content frame shows.

const Nav = {
  page: null,
  playlistId: null,

  init() {
    $('menuSearch').innerHTML = Icons.search + '<span>Search</span>';
    $('menuAdd').innerHTML = Icons.add + '<span>Add Songs</span>'
      + '<span id="menuAddBadge" class="menu__badge" hidden title="Playlist import running"></span>';
    $('menuPlaylists').innerHTML = Icons.playlists + '<span>Playlists</span>';
    $('menuSearch').onclick = () => this.show('search');
    $('menuAdd').onclick = () => this.show('add');
    $('menuPlaylists').onclick = () => this.show('playlists');
    Store.onLibrary(() => this.drawMenu());
    Store.onServer(() => this.drawMenu());
    Player.onChange(() => this.drawMenu());
  },

  currentPlaylistId() {
    return this.page === 'playlist' ? this.playlistId : null;
  },

  show(page, opts = {}) {
    // Leaving All Songs ends "adding songs to" mode.
    if (page !== 'playlist' && typeof PlaylistPage !== 'undefined') PlaylistPage.pickFor = null;
    // The preview belongs to the Add Songs page and stops when it is left.
    if (this.page === 'add' && page !== 'add') AddPage.audio.pause();
    this.page = page;
    for (const node of document.querySelectorAll('.page')) {
      node.hidden = node.id !== 'page-' + page;
    }
    $('pages').scrollTop = 0;
    if (page === 'search') SearchPage.show(opts);
    else if (page === 'add') AddPage.show(opts);
    else if (page === 'playlists') PlaylistsPage.show(opts);
    else if (page === 'playlist') PlaylistPage.show(this.playlistId, opts);
    this.drawMenu();
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

    const list = clear($('menuPlaylistList'));
    const item = (p, extra = '') => {
      const active = this.page === 'playlist' && this.playlistId === p.id;
      const playing = Player.contextId === p.id && Player.isPlaying;
      return h('button.menu__sub'
        + (active ? '.menu__sub--active' : '')
        + (p.isAll ? '.menu__sub--all' : '')
        + extra, {
        type: 'button',
        title: p.name,
        onclick: () => this.openPlaylist(p.id),
      },
      h('span.menu__sub-name', p.name),
      playing ? h('span.menu__playing', { html: Icons.speaker, title: 'Playing' }) : null);
    };

    list.appendChild(item(Store.allSongsPlaylist()));
    list.appendChild(item(Store.favouritesPlaylist()));

    // Listen behaviour: a group that opens and closes, remembered.
    const open = Store.settings.listenGroupOpen !== false;
    const smartPlaying = SmartLists.isSmart(Player.contextId) && Player.isPlaying;
    list.appendChild(h('button.menu__group' + (open ? '.menu__group--open' : ''), {
      type: 'button',
      title: open ? 'Hide these lists' : 'Show these lists',
      'aria-expanded': String(open),
      onclick: () => {
        Store.saveSettings({ listenGroupOpen: !open });
        this.drawMenu();
      },
    },
    h('span.menu__chevron', { html: Icons.chevron }),
    h('span.menu__sub-name', 'Listen behaviour'),
    !open && smartPlaying ? h('span.menu__playing', { html: Icons.speaker, title: 'Playing' }) : null));
    if (open) {
      for (const p of Store.smartPlaylists()) list.appendChild(item(p, '.menu__sub--nested'));
    }

    // Followed Playlists: what other profiles share and this one follows.
    if (Store.canShare()) {
      const followed = Store.followedPlaylists();
      const openF = Store.settings.followedGroupOpen !== false;
      const followedPlaying = followed.some((p) => Player.contextId === p.id) && Player.isPlaying;
      list.appendChild(h('button.menu__group' + (openF ? '.menu__group--open' : ''), {
        type: 'button',
        title: openF ? 'Hide these lists' : 'Show these lists',
        'aria-expanded': String(openF),
        onclick: () => {
          Store.saveSettings({ followedGroupOpen: !openF });
          this.drawMenu();
        },
      },
      h('span.menu__chevron', { html: Icons.chevron }),
      h('span.menu__sub-name', 'Followed Playlists'),
      !openF && followedPlaying ? h('span.menu__playing', { html: Icons.speaker, title: 'Playing' }) : null));
      if (openF) {
        for (const p of followed) list.appendChild(item(p, '.menu__sub--nested'));
        if (!followed.length) list.appendChild(h('div.menu__empty', 'Nothing followed yet. Follow the playlists other profiles share on the Playlists page.'));
      }
    }

    for (const p of Store.sortedPlaylists()) list.appendChild(item(p));
  },
};
