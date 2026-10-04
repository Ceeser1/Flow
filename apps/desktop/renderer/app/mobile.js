'use strict';

// The phone's layout (body.mobile, mobile.css): a top bar with the menu
// button and the page's name, the menu as a drawer from the left with Settings
// at its bottom, and the player as a mini player at the bottom that opens to
// a full-screen Now Playing. The desktop's own elements are moved into place,
// so everything wired to them works as it does there. Swipes to the sides
// bring out the menu and Settings and go to the list playing, then Now
// Playing, a panel to the right of it (_bindSwipes, _bindSwipeBack);
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
    const collapse = iconButton('mp__collapse', Icons.chevronLeft, 'Back to the list', () => this.collapsePlayer());
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

    // A tap on the mini player (not on its buttons) opens Now Playing. The path is the
    // one at the tap: Play swaps its icon first, so the icon tapped is no longer in it.
    bar.addEventListener('click', (e) => {
      const onButton = e.composedPath().some((n) => n.matches && n.matches('button, input'));
      if (!this.playerOpen && !onButton) this.expandPlayer();
    });
    this._bindSwipeBack(bar);
  },

  // Now Playing is a panel to the right of the page: it slides in from the
  // right as the page moves aside to the left, and back out the same way.
  SLIDE_MS: 250,

  /** `pulled`: a finger brings it in (it is where the finger is, not sliding by itself). */
  expandPlayer(pulled = false) {
    if (this.playerOpen) return;
    this.playerOpen = true;
    const bar = $('player');
    clearTimeout(this._leaving);
    bar.classList.remove('mp--leaving');
    bar.classList.toggle('mp--pulled', pulled);
    bar.classList.add('mp--open');
    document.body.classList.add('player-open');
  },

  collapsePlayer() {
    if (!this.playerOpen) return;
    this.playerOpen = false;
    const bar = $('player');
    // Out to the right from where it is (a finger may have it halfway), then the mini player again.
    bar.classList.remove('mp--dragging');
    bar.style.transform = '';
    bar.classList.add('mp--leaving');
    document.body.classList.remove('player-open');
    this._leaving = setTimeout(() => bar.classList.remove('mp--open', 'mp--leaving', 'mp--pulled'), this.SLIDE_MS);
  },

  /** The page beside Now Playing, `d` px from its own place (a finger moving both). */
  _placePages(d) {
    for (const el of [$('pages'), $('mobileBar')]) {
      el.style.transition = d === null ? '' : 'none';
      el.style.transform = d === null ? '' : `translateX(${Math.min(0, d)}px)`;
    }
  },

  /** Now Playing follows a finger pulling it to the right, the page coming back from the left with it. */
  _bindSwipeBack(bar) {
    const width = () => window.innerWidth || 1;
    this.follow(bar, {
      decide: (dx, dy, target) => {
        if (!this.playerOpen || dx <= 0 || Math.abs(dx) <= Math.abs(dy) * 1.2 || target.closest(this.NO_SWIPE)) return false;
        // Pulled too: its slide in (a tap opened it) would start over once the finger lets go.
        bar.classList.add('mp--dragging', 'mp--pulled');
        return true;
      },
      move: (dx) => {
        const d = Math.max(0, dx);
        bar.style.transform = `translateX(${d}px)`;
        this._placePages(-width() / 4 + d / 4);
      },
      end: (dx, dy, fast, cancelled) => {
        this._placePages(null);
        bar.classList.remove('mp--dragging');
        if (!cancelled && dx > 0 && (fast || dx > width() / 3)) this.collapsePlayer();
        else bar.style.transform = '';
      },
    });
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
   *
   * The rest of a touch is heard on the element it started on, which gets
   * all of it even once it is out of the page: lists drawn again while a
   * song plays (the menu, the Queue) replace the rows under a finger, and
   * from a row no longer in the page nothing reaches `el`.
   */
  follow(el, { decide, move, end }) {
    let s = null;
    const finish = (was, e, cancelled) => {
      was.node.removeEventListener('touchmove', was.onMove);
      was.node.removeEventListener('touchend', was.onDone);
      was.node.removeEventListener('touchcancel', was.onDone);
      if (!was.on) return;
      const along = Math.max(Math.abs(was.dx), Math.abs(was.dy));
      const fast = !cancelled && along > 48 && along / Math.max(1, e.timeStamp - was.time) > 0.6;
      end(was.dx, was.dy, fast, cancelled);
    };
    el.addEventListener('touchstart', (e) => {
      // One whose end never came (it should not happen) is let go first, as cancelled.
      if (s) finish(s, e, true);
      s = null;
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      const g = { x: t.clientX, y: t.clientY, time: e.timeStamp, target: e.target, node: e.target, on: false, off: false, dx: 0, dy: 0 };
      g.onMove = (ev) => {
        if (s !== g || g.off) return;
        const p = ev.touches[0];
        if (!p) return;
        g.dx = p.clientX - g.x;
        g.dy = p.clientY - g.y;
        if (!g.on) {
          if (Math.abs(g.dx) < 10 && Math.abs(g.dy) < 10) return;
          if (!decide(g.dx, g.dy, g.target)) {
            g.off = true;
            return;
          }
          g.on = true;
        }
        if (ev.cancelable) ev.preventDefault();
        move(g.dx, g.dy);
      };
      g.onDone = (ev) => {
        if (s !== g || ev.touches.length) return;
        s = null;
        finish(g, ev, ev.type === 'touchcancel');
      };
      g.node.addEventListener('touchmove', g.onMove, { passive: false });
      g.node.addEventListener('touchend', g.onDone);
      g.node.addEventListener('touchcancel', g.onDone);
      s = g;
    }, { passive: true });
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
        if (mode === 'onward' && this._onPlayingList() && Player.currentId) {
          // On the list playing: Now Playing comes in from the right under the finger.
          mode = 'player';
          const bar = $('player');
          this.expandPlayer(true);
          bar.classList.add('mp--dragging');
          bar.style.transform = `translateX(${window.innerWidth + dx}px)`;
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
        } else if (mode === 'player') {
          const w = window.innerWidth;
          $('player').style.transform = `translateX(${Math.max(0, w + dx)}px)`;
          this._placePages(Math.max(-w / 4, dx / 4));
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
        } else if (mode === 'player') {
          const bar = $('player');
          this._placePages(null);
          bar.classList.remove('mp--dragging');
          if (dx < 0 && !cancelled && (fast || -dx > window.innerWidth / 3)) bar.style.transform = '';
          else this.collapsePlayer();
        }
        mode = null;
      },
    });
  },

  /** A swipe to the left with nothing out: to the list playing (or last played), and from there to Now Playing. */
  _onward() {
    const list = this._playingList();
    if (list && !this._onPlayingList()) Nav.openPlaylist(list);
    else if (Player.currentId) this.expandPlayer();
  },

  /** The list playing (or last played), when it is one Flow can show. */
  _playingList() {
    return Player.contextId && Store.playlist(Player.contextId) ? Player.contextId : null;
  },

  _onPlayingList() {
    const list = this._playingList();
    return !list || (Nav.page === 'playlist' && Nav.playlistId === list);
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
