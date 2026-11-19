'use strict';

// Global hotkeys (5.1.3): keys that work while Flow is in the background
// (another window in front, Flow in the tray), each sent to Flow's window as
// an action ('keys:global'; Show Flow is done here). Settings: globalKeysOn
// and globalKeys { action: accelerator, '' for none }, changed in the window
// Show Keybinds opens (keys.js).
//
// A combo is refused before it is tried when it is one the system keeps for
// itself (RESERVED), when it has no Ctrl, Alt or Super (it would take a key
// away from typing everywhere), when it is Ctrl+Alt with a key that types a
// character (Ctrl+Alt is AltGr on many keyboards: @, €, { }), or when another
// of Flow's own actions has it. A combo another program holds already is
// "taken": Electron's register says so (Windows' RegisterHotKey fails), and
// the action keeps the combo it had.
//
// Linux: X11 works as Windows does. Wayland gives programs no keys of other
// windows; main.js turns on Chromium's GlobalShortcutsPortal there, where the
// desktop (KDE, GNOME 48+) asks the user once to allow them.

const ACTIONS = ['playPause', 'next', 'prev', 'volumeUp', 'volumeDown', 'mute', 'favourite', 'showFlow'];

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'];
// Keys a combo may end with (Electron's names).
const NAMED = ['Space', 'Left', 'Right', 'Up', 'Down', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Backspace', 'Tab', 'Enter',
  'num0', 'num1', 'num2', 'num3', 'num4', 'num5', 'num6', 'num7', 'num8', 'num9', 'numadd', 'numsub', 'nummult', 'numdiv', 'numdec'];
// What the systems keep for themselves (compared without regard to order).
const RESERVED = [
  'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'Ctrl+Alt+Escape', 'Alt+Tab', 'Alt+Shift+Tab', 'Alt+F4', 'Alt+Space', 'Ctrl+Escape',
  'Super+L', 'Super+D', 'Super+E', 'Super+R', 'Super+Tab', 'Super+Space', 'Super+V', 'Super+.', 'Super+Left', 'Super+Right', 'Super+Up', 'Super+Down',
  // Linux desktops: terminal, log out, switch workspaces.
  'Ctrl+Alt+T', 'Ctrl+Alt+L', 'Ctrl+Alt+Left', 'Ctrl+Alt+Right', 'Ctrl+Alt+Up', 'Ctrl+Alt+Down', 'Ctrl+Alt+Backspace',
  'Ctrl+Alt+F1', 'Ctrl+Alt+F2', 'Ctrl+Alt+F3', 'Ctrl+Alt+F4', 'Ctrl+Alt+F5', 'Ctrl+Alt+F6', 'Ctrl+Alt+F7',
];

/** Its parts: { mods: Set, key } or null when it is not a combo Flow takes. */
function parse(accel) {
  const parts = String(accel || '').split('+').filter(Boolean);
  if (parts.length < 1 || parts.length > 5) return null;
  const key = parts.pop();
  const mods = new Set();
  for (const m of parts) {
    if (!MODIFIERS.includes(m) || mods.has(m)) return null;
    mods.add(m);
  }
  if (!(/^[A-Z0-9]$/.test(key) || /^F([1-9]|1\d|2[0-4])$/.test(key) || NAMED.includes(key))) return null;
  return { mods, key };
}

/** The combo written the one way (Ctrl, Alt, Shift, Super, then the key), or '' when it is none. */
function normalize(accel) {
  const p = parse(accel);
  if (!p) return '';
  return [...MODIFIERS.filter((m) => p.mods.has(m)), p.key].join('+');
}

const RESERVED_SET = new Set(RESERVED.map(normalize).filter(Boolean));

/**
 * Why a combo can not be a hotkey: 'invalid', 'modifier' (no Ctrl, Alt or
 * Super; F13 to F24 may go alone), 'altgr', 'system'; '' when it can.
 */
function refusal(accel) {
  const p = parse(accel);
  if (!p) return 'invalid';
  const big = /^F(1[3-9]|2[0-4])$/.test(p.key);
  if (!big && !p.mods.has('Ctrl') && !p.mods.has('Alt') && !p.mods.has('Super')) return 'modifier';
  const typed = /^[A-Z0-9]$/.test(p.key) || p.key === 'Space';
  if (typed && p.mods.has('Ctrl') && p.mods.has('Alt') && !p.mods.has('Shift') && !p.mods.has('Super')) return 'altgr';
  if (RESERVED_SET.has(normalize(accel))) return 'system';
  return '';
}

/**
 * `globalShortcut`: Electron's (or a stand-in for the tests). `settings`:
 * get / set. `onAction(action)`: a hotkey was pressed.
 */
function createGlobalKeys({ globalShortcut, settings, onAction }) {
  // action -> the combo registered for it now.
  let held = {};
  // Actions whose combo another program holds.
  let taken = new Set();

  const wanted = () => ({ ...(settings.get('globalKeys') || {}) });

  function release() {
    for (const accel of Object.values(held)) {
      try {
        globalShortcut.unregister(accel);
      } catch {
        // Gone already.
      }
    }
    held = {};
  }

  function tryRegister(action, accel) {
    try {
      return globalShortcut.register(accel, () => onAction(action)) === true;
    } catch {
      return false;
    }
  }

  /** Every combo set registered anew (Flow starting, the tick changed). */
  function apply() {
    release();
    taken = new Set();
    if (!settings.get('globalKeysOn')) return status();
    const keys = wanted();
    for (const action of ACTIONS) {
      const accel = normalize(keys[action]);
      if (!accel || refusal(accel)) continue;
      if (tryRegister(action, accel)) held[action] = accel;
      else taken.add(action);
    }
    return status();
  }

  /** What the Show Keybinds window shows: { on, keys, taken: [action] }. */
  function status() {
    return { on: !!settings.get('globalKeysOn'), keys: wanted(), taken: [...taken] };
  }

  /**
   * A new combo for `action` ('' for none). Answers { ok, reason?, status }:
   * reason 'invalid', 'modifier', 'altgr', 'system', 'own' (another of
   * Flow's actions has it; `other` names it) or 'taken'.
   */
  function set(action, accel) {
    if (!ACTIONS.includes(action)) return { ok: false, reason: 'invalid', status: status() };
    const next = accel ? normalize(accel) : '';
    if (accel && !next) return { ok: false, reason: 'invalid', status: status() };
    if (next) {
      const why = refusal(next);
      if (why) return { ok: false, reason: why, status: status() };
      const keys = wanted();
      const other = ACTIONS.find((a) => a !== action && normalize(keys[a]) === next);
      if (other) return { ok: false, reason: 'own', other, status: status() };
    }
    const on = !!settings.get('globalKeysOn');
    const was = held[action];
    if (on && next && was !== next) {
      // Tried before the old one is let go: a combo that is taken keeps the old one working.
      if (!tryRegister(action, next)) return { ok: false, reason: 'taken', status: status() };
    }
    if (was && was !== next) {
      try {
        globalShortcut.unregister(was);
      } catch {
        // Gone already.
      }
      delete held[action];
    }
    if (on && next) held[action] = next;
    taken.delete(action);
    settings.set({ globalKeys: { ...wanted(), [action]: next } });
    return { ok: true, status: status() };
  }

  function setOn(on) {
    settings.set({ globalKeysOn: !!on });
    return apply();
  }

  /** Every action back to its first combo. */
  function reset(defaults) {
    settings.set({ globalKeys: { ...defaults } });
    return apply();
  }

  return {
    apply, status, set, setOn, reset, release,
  };
}

module.exports = {
  createGlobalKeys, normalize, refusal, parse, ACTIONS, RESERVED,
};
