'use strict';

// The menu on the left and which page the content frame shows.

const Nav = {
  page: null,
  playlistId: null,

  init() {
    $('menuSearch').innerHTML = Icons.search + '<span>Search</span>';
    $('menuAdd').innerHTML = Icons.add + '<span>Add Songs</span>'
      + '<span id="menuAddBadge" class="menu__badge" hidden title="Playlist import running"></span>';
    this._entry('menuPlaylists', 'Playlists', 'playlistsMenuOpen');
    this._entry('menuFollowed', 'Followed Playlists', 'followedMenuOpen');
    $('menuSearch').onclick = () => this.show('search');
    $('menuAdd').onclick = () => this.show('add');
    $('menuPlaylists').onclick = () => this.show('playlists');
    $('menuFollowed').onclick = () => this.show('followed');
    Store.onLibrary(() => this.drawMenu());
    Store.onServer(() => this.drawMenu());
    Player.onChange(() => this.drawMenu());
  },

  /**
   * A main entry with the icon, then an arrow that opens and closes the lists
   * under it (remembered in `key`), then the name. The rest of the button
   * still opens the page.
   */
  _entry(id, label, key) {
    const arrow = h('span.menu__chevron.menu__chevron--toggle', {
      role: 'button',
      html: Icons.chevron,
      onclick: (e) => {
        e.stopPropagation();
        Store.saveSettings({ [key]: Store.settings[key] === false });
        this.drawMenu();
      },
    });
    $(id).innerHTML = Icons.playlists;
    $(id).append(arrow, h('span', label));
    (this._arrows = this._arrows || {})[key] = arrow;
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
    this.page = page;
    for (const node of document.querySelectorAll('.page')) {
      node.hidden = node.id !== 'page-' + page;
    }
    $('pages').scrollTop = 0;
    if (page === 'search') SearchPage.show(opts);
    else if (page === 'add') AddPage.show(opts);
    else if (page === 'playlists') PlaylistsPage.show(opts);
    else if (page === 'followed') FollowedPage.show(opts);
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
    $('menuFollowed').classList.toggle('menu__item--active', this.page === 'followed');
    const playlistsOpen = Store.settings.playlistsMenuOpen !== false;
    const followedOpen = Store.settings.followedMenuOpen !== false;
    this._drawArrow('playlistsMenuOpen', playlistsOpen, 'the playlists');
    this._drawArrow('followedMenuOpen', followedOpen, 'the followed playlists');
    $('menuPlaylistList').hidden = !playlistsOpen;

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

    for (const p of Store.sortedPlaylists()) list.appendChild(item(p));

    // Followed Playlists: a main entry of its own, only while one is followed.
    const followed = Store.followedPlaylists();
    $('menuFollowed').hidden = !followed.length;
    $('menuFollowedList').hidden = !followed.length || !followedOpen;
    const followedList = clear($('menuFollowedList'));
    for (const p of followed) followedList.appendChild(item(p));
  },
};
