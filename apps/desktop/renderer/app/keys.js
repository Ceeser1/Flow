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
//
// 5.1.3, the desktop app: global hotkeys, which work while Flow is in the
// background too (src/globalKeys.js registers them with the system). Each
// press comes here as its action. The Show Keybinds window has them below
// the others: on / off, and each action's combo, changed by clicking it and
// pressing the new one (Esc leaves it, Backspace or Delete clears it).

const Keys = {
  // While a global hotkey's new combo is being pressed: the function that takes the key.
  _capture: null,

  init() {
    window.addEventListener('keydown', (e) => this._down(e), true);
    if (window.flow.globalKeys) window.flow.globalKeys.onPress((action) => this._global(action));
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
        window.flow.globalKeys ? this._globalSection() : null,
      ],
      buttons: [{ label: T('common.close') }],
      onClose: () => {
        this._capture = null;
      },
    });
  },

  /** A global hotkey pressed (5.1.3): what it does, as the player bar's buttons would. */
  _global(action) {
    if (action === 'playPause') Player.toggle();
    else if (action === 'next') Player.next();
    else if (action === 'prev') Player.prev();
    else if (action === 'volumeUp' || action === 'volumeDown') {
      // In steps of 5 %, as Ctrl+Up / Ctrl+Down: this device's, or a host's that allows it.
      const step = action === 'volumeUp' ? 1 : -1;
      Player._barVolume((Math.round(Player._shownVolume() * 20) + step) / 20);
    } else if (action === 'mute') {
      if (!Player._hostVolume() && (!Player.remote || Player.remote.here)) Player.toggleMute();
      else Player._barVolume(Player._shownVolume() > 0 ? 0 : (Player._muteRestore || 0.8));
    } else if (action === 'favourite') {
      const btn = $('btnFavourite');
      if (btn && !btn.disabled) btn.click();
    }
  },

  /** The global hotkeys' actions, in the order the window lists them. */
  GLOBAL: ['playPause', 'next', 'prev', 'volumeUp', 'volumeDown', 'mute', 'favourite', 'showFlow'],

  /**
   * The Show Keybinds window's Global hotkeys (5.1.3): a tick for all of
   * them, each action with its combo (click, then press the new one) and an
   * X to clear it, what is taken by another program, and Reset.
   */
  _globalSection() {
    const box = h('input', { type: 'checkbox' });
    const rows = h('tbody');
    const message = h('p.settings__note.keybinds__msg', { role: 'status' });
    const reset = h('button.btn.btn--small', { type: 'button' }, T('keybinds.global.reset'));
    let state = { on: false, keys: {}, taken: [] };
    const say = (text = '', bad = false) => {
      message.textContent = text;
      message.classList.toggle('keybinds__msg--bad', !!bad);
    };
    const draw = () => {
      box.checked = !!state.on;
      rows.replaceChildren(...this.GLOBAL.map((action) => {
        const accel = state.keys[action] || '';
        const set = h('button.keybinds__set', { type: 'button', title: T('keybinds.global.change') },
          ...(accel ? this._comboNodes(accel) : [h('span.keybinds__none', T('keybinds.global.none'))]));
        set.onclick = () => listen(action, set);
        const clear = accel ? iconButton('keybinds__clear', Icons.x, T('keybinds.global.clear'), () => change(action, '')) : null;
        const taken = state.on && state.taken.includes(action) ? h('span.keybinds__taken', T('keybinds.global.takenNow')) : null;
        return h('tr' + (state.on ? '' : '.keybinds__off'),
          h('td.keybinds__keys', set, clear),
          h('td.keybinds__what', T(`keybinds.global.${action}`), taken));
      }));
    };
    const change = async (action, accel) => {
      const r = await window.flow.globalKeys.set(action, accel);
      state = r.status;
      draw();
      if (r.ok) say('');
      else say(T(`keybinds.global.refused.${r.reason}`, { action: r.other ? T(`keybinds.global.${r.other}`) : '' }), true);
    };
    const listen = (action, button) => {
      button.replaceChildren(h('span.keybinds__none', T('keybinds.global.press')));
      button.classList.add('keybinds__set--listening');
      say(T('keybinds.global.pressHint'));
      this._capture = (e) => {
        if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS'].includes(e.key)) return;
        this._capture = null;
        const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
        if (plain && e.key === 'Escape') {
          say('');
          draw();
          return;
        }
        if (plain && (e.key === 'Backspace' || e.key === 'Delete')) {
          change(action, '');
          return;
        }
        const accel = this.accelOf(e);
        if (!accel) {
          say(T('keybinds.global.refused.invalid'), true);
          draw();
          return;
        }
        change(action, accel);
      };
    };
    box.onchange = async () => {
      state = await window.flow.globalKeys.setOn(box.checked);
      say('');
      draw();
    };
    reset.onclick = async () => {
      state = await window.flow.globalKeys.reset();
      say('');
      draw();
    };
    window.flow.globalKeys.status().then((st) => {
      state = st;
      draw();
    });
    return h('div.keybinds__global',
      h('h4.keybinds__head', T('keybinds.global.title')),
      h('label.check.keybinds__on', box, h('span', T('keybinds.global.on'))),
      h('p.settings__note', T('keybinds.global.desc')),
      h('table.keybinds', rows),
      message,
      h('div.keybinds__actions', reset));
  },

  /** A combo (Electron's way of writing it) as keys to show. */
  _comboNodes(accel) {
    const names = {
      Ctrl: T('keybinds.key.ctrl'), Alt: T('keybinds.key.alt'), Shift: T('keybinds.key.shift'), Super: T('keybinds.key.super'),
      Space: T('keybinds.key.space'), Left: '←', Right: '→', Up: '↑', Down: '↓',
    };
    const parts = accel.split('+');
    return [h('span.keybinds__combo', ...parts.flatMap((p, i) => {
      const key = h('kbd.keybinds__key', names[p] || p.replace(/^num/, 'Num '));
      return i ? ['+', key] : [key];
    }))];
  },

  /**
   * A key pressed as Electron writes a combo ('Ctrl+Alt+Shift+P'), or '' for
   * a key a hotkey can not end with. Letters as the keyboard's layout has
   * them (a German Z is Z), the rest by where they are.
   */
  accelOf(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const c = e.code || '';
    const named = {
      Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Backspace: 'Backspace', Tab: 'Tab', Enter: 'Enter',
      NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
    };
    let key = '';
    if (/^[a-z]$/i.test(e.key || '')) key = e.key.toUpperCase();
    else if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
    else if (/^Digit[0-9]$/.test(c)) key = c.slice(5);
    else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) key = c;
    else if (/^Numpad[0-9]$/.test(c)) key = `num${c.slice(6)}`;
    else key = named[c] || '';
    return key ? [...mods, key].join('+') : '';
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
    // A global hotkey's new combo being pressed: the key is only that.
    if (this._capture) {
      e.preventDefault();
      e.stopPropagation();
      this._capture(e);
      return;
    }
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
