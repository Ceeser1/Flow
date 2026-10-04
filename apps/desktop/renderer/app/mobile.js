'use strict';

// The phone's layout (body.mobile, mobile.css): a top bar with the menu
// button and the page's name, the menu as a drawer from the left with Settings
// at its bottom, and the player as a mini player at the bottom that opens to
// a full-screen Now Playing. The desktop's own elements are moved into place,
// so everything wired to them works as it does there. Swipes to the sides
// bring out the menu and Settings and go to the list playing (_bindSwipes);
// popups go away under a finger (swipeToClose). Does nothing on the
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
    this._bindSwipes();

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
    // The phone's Back (button or gesture); with nothing left to close, Flow goes to the background.
    if (window.flow.onBack) {
      window.flow.onBack(() => {
        if (!this.back()) window.flow.leave().catch(() => {});
      });
    }
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
      $('playerCover'),
      h('div.mp__text', $('playerTitle'), h('div.mp__sub', { id: 'playerSub' })),
      h('div.mp__session', ...take('playerSession', 'playerHere', 'playerLeave', 'sleepLeft')),
      $('playerTrack'),
      h('div.mp__times', $('playerTime')),
      h('div.mp__buttons', ...take('btnPrev', 'btnBack10', 'btnPlay', 'btnFwd10', 'btnNext')),
      h('div.mp__extras', ...take('btnShuffle', 'btnRepeat', 'btnSleep', 'btnVisualizer', 'btnOutput', 'btnQueue')),
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

  // ---- swipes ----

  // What a swipe never starts on: controls that take a finger themselves.
  NO_SWIPE: 'input, select, textarea, canvas, .timeline, .settings__slider, [data-noswipe]',

  /**
   * Follows a finger on `el`: after its first 10 px, `decide(dx, dy, target)`
   * says whether the move is ours (then the page does not scroll under it),
   * `move(dx, dy)` follows it and `end(dx, dy, fast)` lets go (`fast`: a
   * flick, 48 px or more at 0.6 px/ms; `cancelled` when the phone took the
   * touch). Touch events, not pointer ones: a scroll the browser starts would
   * cancel a pointer, while a touch it can be kept from.
   */
  follow(el, { decide, move, end }) {
    let s = null;
    el.addEventListener('touchstart', (e) => {
      s = null;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      s = { x: t.clientX, y: t.clientY, time: e.timeStamp, target: e.target, on: false, off: false, dx: 0, dy: 0 };
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!s || s.off) return;
      const t = e.touches[0];
      s.dx = t.clientX - s.x;
      s.dy = t.clientY - s.y;
      if (!s.on) {
        if (Math.abs(s.dx) < 10 && Math.abs(s.dy) < 10) return;
        if (!decide(s.dx, s.dy, s.target)) {
          s.off = true;
          return;
        }
        s.on = true;
      }
      if (e.cancelable) e.preventDefault();
      move(s.dx, s.dy);
    }, { passive: false });
    const done = (e) => {
      const was = s;
      s = null;
      if (!was || !was.on) return;
      const along = Math.max(Math.abs(was.dx), Math.abs(was.dy));
      const fast = along > 48 && along / Math.max(1, e.timeStamp - was.time) > 0.6;
      end(was.dx, was.dy, fast && e.type === 'touchend', e.type === 'touchcancel');
    };
    el.addEventListener('touchend', done);
    el.addEventListener('touchcancel', done);
  },

  /** Whether `node` sits in something the finger scrolls sideways (a row of chips). */
  _scrollsSideways(node) {
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  },

  /**
   * A popup follows a finger pulling it away (`ways`: 'left', 'right',
   * 'down') and closes past a third of the way or on a flick; otherwise it
   * goes back. A move another way is not ours (a list scrolled; pulling down
   * only from a list at its top), nor one while `busy()` (a song dragged).
   */
  swipeToClose(modal, ways, busy = null) {
    const box = modal.el;
    const body = box.querySelector('.modal__body');
    box.classList.add('modal--swipeable');
    const down = ways.includes('down');
    const reach = () => (down ? box.offsetHeight : box.offsetWidth);
    const clamp = (dx, dy) => {
      if (down) return Math.max(0, dy);
      return Math.max(ways.includes('left') ? -Infinity : 0, Math.min(ways.includes('right') ? Infinity : 0, dx));
    };
    const place = (d) => {
      box.style.transform = down ? `translateY(${d}px)` : `translateX(${d}px)`;
    };
    this.follow(box, {
      decide: (dx, dy, target) => {
        if ((busy && busy()) || target.closest(this.NO_SWIPE)) return false;
        if (down) return dy > Math.abs(dx) && !(body && body.scrollTop > 0);
        if (Math.abs(dx) <= Math.abs(dy) || this._scrollsSideways(target)) return false;
        return ways.includes(dx < 0 ? 'left' : 'right');
      },
      move: (dx, dy) => {
        box.classList.add('modal--sliding');
        place(clamp(dx, dy));
      },
      end: (dx, dy, fast, cancelled) => {
        const d = clamp(dx, dy);
        box.classList.remove('modal--sliding');
        if (!cancelled && d !== 0 && (fast || Math.abs(d) > reach() / 3)) {
          // Out from where the finger left it, the way it went; the backdrop fades as usual.
          box.classList.add('modal--swiped');
          place(Math.sign(d) * reach());
          modal.close();
        } else {
          box.style.transform = '';
        }
      },
    });
  },

  /**
   * Swipes on the page: to the right the menu comes out, and with the menu
   * out Settings (from the left too, the menu staying under it); to the left
   * the menu goes, and with nothing out Flow goes to the list playing (or
   * last played), and from that list to Now Playing. The menu and Settings
   * follow the finger.
   */
  _bindSwipes() {
    const menu = $('mobileDrawer');
    const scrim = $('drawerScrim');
    let mode = null;
    let settings = null;
    const width = () => menu.offsetWidth || 1;
    this.follow(document.body, {
      decide: (dx, dy, target) => {
        mode = null;
        if (Math.abs(dx) <= Math.abs(dy) * 1.2) return false;
        if (Modal.top() || this.playerOpen || TouchList.choosing) return false;
        if (target.closest('#modalRoot, .choose-bar') || target.closest(this.NO_SWIPE) || this._scrollsSideways(target)) return false;
        if (this.drawerOpen) mode = dx > 0 ? 'settings' : 'close';
        else mode = dx > 0 ? 'open' : 'onward';
        if (mode === 'settings') {
          SettingsPanel.open();
          settings = SettingsPanel.modal;
          if (!settings) return false;
          // In from where the finger is, not by its own slide.
          settings.el.classList.add('modal--pulled', 'modal--sliding');
          settings.el.style.transform = `translateX(${Math.min(0, dx - settings.el.offsetWidth)}px)`;
        }
        if (mode === 'open' || mode === 'close') document.body.classList.add('drawer-dragging');
        return true;
      },
      move: (dx) => {
        if (mode === 'open') {
          const d = Math.max(0, Math.min(width(), dx));
          menu.style.transform = `translateX(${d - width()}px)`;
          scrim.style.opacity = String(d / width());
        } else if (mode === 'close') {
          const d = Math.min(0, dx);
          menu.style.transform = `translateX(${d}px)`;
          scrim.style.opacity = String(1 + d / width());
        } else if (mode === 'settings') {
          const w = settings.el.offsetWidth;
          settings.el.style.transform = `translateX(${Math.min(0, dx - w)}px)`;
        } else if (mode === 'onward') {
          $('pages').style.transform = `translateX(${Math.max(-48, dx / 4)}px)`;
        }
      },
      end: (dx, dy, fast, cancelled) => {
        const far = (d) => !cancelled && (fast || Math.abs(d) > width() / 3);
        if (mode === 'open' || mode === 'close') {
          document.body.classList.remove('drawer-dragging');
          menu.style.transform = '';
          scrim.style.opacity = '';
          const open = mode === 'open' ? dx > 0 && far(dx) : !(dx < 0 && far(dx));
          if (open) this.openDrawer();
          else this.closeDrawer();
        } else if (mode === 'settings') {
          const box = settings.el;
          box.classList.remove('modal--sliding');
          if (dx > 0 && far(dx)) {
            box.style.transform = '';
          } else {
            box.classList.add('modal--swiped');
            box.style.transform = 'translateX(-100%)';
            settings.close();
          }
          settings = null;
        } else if (mode === 'onward') {
          $('pages').style.transform = '';
          if (dx < 0 && !cancelled && (fast || -dx > 80)) this._onward();
        }
        mode = null;
      },
    });
  },

  /** A swipe to the left with nothing out: to the list playing (or last played), and from there to Now Playing. */
  _onward() {
    const list = Player.contextId && Store.playlist(Player.contextId) ? Player.contextId : null;
    const onIt = Nav.page === 'playlist' && Nav.playlistId === list;
    if (list && !onIt) Nav.openPlaylist(list);
    else if (Player.currentId) this.expandPlayer();
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
