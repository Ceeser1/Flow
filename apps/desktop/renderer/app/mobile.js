'use strict';

// The phone's layout (body.mobile, mobile.css): a top bar with the menu
// button and the page's name, the menu as a drawer from the left with Settings
// at its bottom, and the player as a mini player at the bottom that opens to
// a full-screen Now Playing. The desktop's own elements are moved into place,
// so everything wired to them works as it does there. Does nothing on the
// desktop's layout.

const Mobile = {
  on: false,
  drawerOpen: false,
  playerOpen: false,

  // The top bar's name for each page (a playlist shows its own).
  TITLES: {
    search: 'Search',
    add: 'Add Songs',
    playlists: 'Playlists',
    followed: 'Followed Playlists',
    sessions: 'Active Sessions',
    trend: 'Your listening trend',
  },

  init() {
    this.on = document.body.classList.contains('mobile');
    if (!this.on) return;
    this._buildBar();
    this._buildDrawer();
    this._buildPlayer();
    this._hideByCaps();

    // Any page opened (from the drawer or anywhere else) closes the drawer and Now Playing.
    const show = Nav.show.bind(Nav);
    Nav.show = (page, opts) => {
      TouchList.stopChoosing();
      show(page, opts);
      this.closeDrawer();
      this.collapsePlayer();
      this._drawTitle();
    };
    Store.onLibrary(() => this._drawTitle());
    $('pages').addEventListener('scroll', () => this._drawTitle(), { passive: true });
  },

  // ---- top bar ----

  _buildBar() {
    const menuBtn = iconButton('mbar__menu', Icons.menu, 'Menu', () => this.openDrawer());
    this._title = h('div.mbar__title');
    $('pages').before(h('header.mbar', { id: 'mobileBar' }, menuBtn, this._title));
  },

  /**
   * The page's name; on a playlist only once its own big title has scrolled
   * away under the bar.
   */
  _drawTitle() {
    if (!this._title) return;
    let text = this.TITLES[Nav.page] || '';
    if (Nav.page === 'playlist') {
      const p = Store.playlist(Nav.playlistId);
      const head = $('plTitle');
      const gone = head && head.getBoundingClientRect().bottom < $('pages').getBoundingClientRect().top + 4;
      text = p && gone ? p.name : '';
    }
    this._title.textContent = text;
  },

  // ---- drawer ----

  _buildDrawer() {
    const menu = document.querySelector('.menu');
    menu.id = 'mobileDrawer';
    menu.appendChild(h('button.menu__item.menu__settings', {
      id: 'menuSettingsRow',
      type: 'button',
      html: Icons.cog + '<span>Settings</span>',
      onclick: () => {
        this.closeDrawer();
        SettingsPanel.open();
      },
    }));
    document.querySelector('.app').appendChild(h('div.drawer-scrim', { id: 'drawerScrim', onclick: () => this.closeDrawer() }));
    // The arrows only fold the lists away; they do not close the drawer.
  },

  openDrawer() {
    this.drawerOpen = true;
    document.body.classList.add('drawer-open');
  },

  closeDrawer() {
    this.drawerOpen = false;
    document.body.classList.remove('drawer-open');
  },

  // ---- player ----

  _buildPlayer() {
    const bar = $('player');
    const take = (...ids) => ids.map((id) => $(id));
    const collapse = iconButton('mp__collapse', Icons.chevronDown, 'Close', () => this.collapsePlayer());
    collapse.id = 'playerCollapse';
    const parts = [
      collapse,
      $('playerFrom'),
      $('btnQueue'),
      $('playerCover'),
      h('div.mp__text', $('playerTitle'), h('div.mp__sub', { id: 'playerSub' })),
      h('div.mp__session', ...take('playerSession', 'playerHere', 'playerLeave', 'sleepLeft')),
      $('playerTrack'),
      h('div.mp__times', $('playerTime')),
      h('div.mp__buttons', ...take('btnPrev', 'btnBack10', 'btnPlay', 'btnFwd10', 'btnNext')),
      h('div.mp__extras', ...take('btnShuffle', 'btnRepeat', 'btnSleep', 'btnVisualizer', 'btnOutput')),
      $('volWrap'),
    ];
    clear(bar);
    bar.append(...parts);
    bar.classList.add('mp');

    // A tap on the mini player (not on its buttons) opens Now Playing.
    bar.addEventListener('click', (e) => {
      if (!this.playerOpen && !e.target.closest('button, input')) this.expandPlayer();
    });
    this._bindSwipeDown(bar);
  },

  expandPlayer() {
    if (this.playerOpen) return;
    this.playerOpen = true;
    $('player').classList.add('mp--open');
    document.body.classList.add('player-open');
  },

  collapsePlayer() {
    if (!this.playerOpen) return;
    this.playerOpen = false;
    const bar = $('player');
    bar.classList.remove('mp--open');
    bar.style.transform = '';
    document.body.classList.remove('player-open');
  },

  /** Now Playing follows a finger pulling it down, and closes past a third of the way. */
  _bindSwipeDown(bar) {
    let start = null;
    bar.addEventListener('pointerdown', (e) => {
      if (!this.playerOpen || e.target.closest('button, input, #playerTrack')) return;
      start = { y: e.clientY, id: e.pointerId, moved: 0 };
    });
    bar.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      start.moved = Math.max(0, e.clientY - start.y);
      if (start.moved > 8) {
        bar.classList.add('mp--dragging');
        bar.style.transform = `translateY(${start.moved}px)`;
      }
    });
    const end = (e) => {
      if (!start || e.pointerId !== start.id) return;
      const far = start.moved > window.innerHeight / 3;
      start = null;
      bar.classList.remove('mp--dragging');
      if (far) this.collapsePlayer();
      else bar.style.transform = '';
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  },

  // ---- what the phone does not have ----

  _hideByCaps() {
    if (!Store.can('outputDevices')) $('btnOutput').hidden = true;
    if (!Store.can('effects')) $('btnVisualizer').hidden = true;
  },

  // ---- Back ----

  /**
   * The phone's Back: closes a popup, then Now Playing, then stops choosing
   * rows, then closes the drawer, then goes to the page before. False when there is nothing left to go back to
   * (the app then goes to the background).
   */
  back() {
    const top = Modal.top();
    if (top && top === SettingsPanel.modal && SettingsPanel.back()) return true;
    if (top) {
      top.close();
      return true;
    }
    if (this.playerOpen) {
      this.collapsePlayer();
      return true;
    }
    if (TouchList.choosing) {
      TouchList.stopChoosing();
      return true;
    }
    if (this.drawerOpen) {
      this.closeDrawer();
      return true;
    }
    return Nav.back();
  },
};
