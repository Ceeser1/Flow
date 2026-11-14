'use strict';

// Keyboard: Space plays / pauses, Left and Right skip 10 seconds, whenever no
// text box has the focus; with the visualizer open, Up and Down switch to the
// one before or after it. On Add Songs with a song in the editor they drive
// the preview; everywhere else the player. Media keys go through the media
// session in player.js, so they are not handled here as well.
//
// 4.5.5: Ctrl+Left and Ctrl+Right play the song before or after it, Ctrl+Up
// and Ctrl+Down turn the volume up or down by 5 %, Alt+Left and Alt+Right go
// back and forward through the pages opened (Nav.back / Nav.forward; the
// mouse's side buttons do the same, nav.js). Not while a box is typed in
// (Ctrl+arrows move by words there) nor with a popup open. The web player
// leaves Alt+arrows to the browser, whose history Flow's steps are in.
// Settings > General > Keybinds / Shortcuts lists them all (Keybinds).

const Keys = {
  init() {
    window.addEventListener('keydown', (e) => this._down(e), true);
    // A focused button would also take Space as a click on release.
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space' && !isTypingTarget(e.target) && (!Modal.top() || (Visualizer.shown && !Modal.top().el.closest('.modal-backdrop--over')))) e.preventDefault();
      if (e.code === 'Space' && this._closing(e.target)) e.preventDefault();
    }, true);
  },

  /**
   * Settings > General > Show Keybinds (4.5.5): every key Flow has, each
   * with what it does.
   */
  showList() {
    const key = (text) => h('kbd.keybinds__key', text);
    const ctrl = T('keybinds.key.ctrl');
    const alt = T('keybinds.key.alt');
    const plus = (mod, k) => h('span.keybinds__combo', key(mod), '+', key(k));
    const rows = [
      [[key(T('keybinds.key.space'))], 'keybinds.playPause'],
      [[key('←'), key('→')], 'keybinds.skip'],
      [[plus(ctrl, '←'), plus(ctrl, '→')], 'keybinds.prevNext'],
      Store.can('volume') ? [[plus(ctrl, '↑'), plus(ctrl, '↓')], 'keybinds.volume'] : null,
      [[plus(alt, '←'), plus(alt, '→')], 'keybinds.backForward'],
      [[key(T('keybinds.key.mouseBack')), key(T('keybinds.key.mouseForward'))], 'keybinds.mouse'],
      [[key('↑'), key('↓')], 'keybinds.visualizer'],
      [[plus(ctrl, 'F')], 'keybinds.search'],
      [[key(T('keybinds.key.esc'))], 'keybinds.escape'],
      [[key(T('keybinds.key.mediaKeys'))], 'keybinds.media'],
    ].filter(Boolean);
    Modal.open({
      title: T('keybinds.title'),
      className: 'modal--keybinds',
      body: [
        h('table.keybinds', h('tbody', rows.map(([keys, what]) => h('tr',
          h('td.keybinds__keys', ...keys.flatMap((k, i) => (i ? [h('span.keybinds__or', '/'), k] : [k]))),
          h('td.keybinds__what', T(what)))))),
        h('p.settings__note.keybinds__note', T('keybinds.note')),
      ],
      buttons: [{ label: T('common.close') }],
    });
  },

  /** A window's X or one of its buttons at the bottom (each closes it): Space never presses them. */
  _closing(el) {
    return !!(Modal.top() && el && el.closest && el.closest('.modal__close, .modal__footer > .btn'));
  },

  _target() {
    if (Nav.page === 'add' && AddPage.editorReady) {
      return { toggle: () => AddPage.togglePreview(), skip: (d) => AddPage.skipPreview(d) };
    }
    return { toggle: () => Player.toggle(), skip: (d) => Player.skip(d) };
  },

  /** Ctrl+arrows and Alt+arrows (4.5.5); true when the key was one of them. */
  _combo(e) {
    const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);
    if (!arrow || e.metaKey || e.shiftKey || (e.ctrlKey && e.altKey)) return false;
    if (e.ctrlKey) {
      e.preventDefault();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        // Held down, one song per press.
        if (!e.repeat) {
          if (e.key === 'ArrowLeft') Player.prev();
          else Player.next();
        }
      } else if (Store.can('volume')) {
        // In steps of 5 %, from wherever the slider was.
        const step = e.key === 'ArrowUp' ? 1 : -1;
        Player.setVolume((Math.round(Player.volume * 20) + step) / 20);
      }
      return true;
    }
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (Store.web) return false;
      e.preventDefault();
      if (!e.repeat && !Visualizer.shown) {
        if (e.key === 'ArrowLeft') Nav.back();
        else Nav.forward();
      }
      return true;
    }
    return false;
  },

  _down(e) {
    // The full-screen visualizer: Escape closes a popup opened over it from
    // the player bar first, then only it (and, should the window have left
    // full screen on that press already, nothing else). The player keys work
    // even over the popup it was opened from.
    const over = Modal.top() && Modal.top().el.closest('.modal-backdrop--over') ? Modal.top() : null;
    if (e.key === 'Escape' && !over && (Visualizer.shown || Visualizer.justClosed())) {
      e.preventDefault();
      Visualizer.close();
      return;
    }
    // A box that takes Escape itself (a server's name typed in Settings) keeps its window open.
    if (e.key === 'Escape' && e.target.dataset && 'ownEscape' in e.target.dataset) return;
    const top = Visualizer.shown ? over : Modal.top();
    if (e.key === 'Escape' && top) {
      e.preventDefault();
      top.dismiss();
      return;
    }
    // Space on a window's closing button (focused when it opened): the window
    // stays, the focus going to the window itself.
    if (e.code === 'Space' && this._closing(e.target)) {
      e.preventDefault();
      const win = e.target.closest('.modal');
      if (win) win.focus();
      return;
    }
    if (top) return;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      Nav.show('search');
      return;
    }
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (this._combo(e)) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) this._target().toggle();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this._target().skip(-10);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this._target().skip(10);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && Visualizer.shown) {
      e.preventDefault();
      Visualizer.step(e.key === 'ArrowDown' ? 1 : -1);
    }
  },
};
