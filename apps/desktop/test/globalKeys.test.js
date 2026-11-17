'use strict';

// Global hotkeys (5.1.3): which combos are taken, refused or registered.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGlobalKeys, normalize, refusal,
} = require('../src/globalKeys');
const { GLOBAL_KEYS, clean } = require('@flow/core/client/settings');

/** Electron's globalShortcut as the tests need it; `others` are held by other programs. */
function fakeShortcut(others = []) {
  const mine = new Map();
  return {
    mine,
    register(accel, fn) {
      if (others.includes(accel) || mine.has(accel)) return false;
      mine.set(accel, fn);
      return true;
    },
    isRegistered: (accel) => mine.has(accel),
    unregister: (accel) => mine.delete(accel),
  };
}

function fakeSettings(initial = {}) {
  let s = clean({ ...initial });
  return {
    get: (k) => s[k],
    set: (patch) => {
      s = clean({ ...s, ...patch });
      return s;
    },
  };
}

test('normalize writes a combo one way; refusal says why one can not be a hotkey', () => {
  assert.equal(normalize('Shift+Alt+Ctrl+p'), '');
  assert.equal(normalize('Shift+Alt+Ctrl+P'), 'Ctrl+Alt+Shift+P');
  assert.equal(normalize('Ctrl+Ctrl+P'), '');
  assert.equal(refusal('Ctrl+Alt+Shift+P'), '');
  assert.equal(refusal('Shift+P'), 'modifier');
  assert.equal(refusal('P'), 'modifier');
  assert.equal(refusal('F13'), '');
  assert.equal(refusal('Ctrl+Alt+Q'), 'altgr', 'AltGr+Q is @ on a German keyboard');
  assert.equal(refusal('Ctrl+Alt+Right'), 'system');
  assert.equal(refusal('Alt+Tab'), 'system');
  assert.equal(refusal('Super+L'), 'system');
  assert.equal(refusal('Ctrl+Hyper+P'), 'invalid');
  // The first combos all pass.
  for (const accel of Object.values(GLOBAL_KEYS)) if (accel) assert.equal(refusal(accel), '', accel);
});

test('apply registers the combos set, and a press reaches onAction', () => {
  const sc = fakeShortcut(['Ctrl+Alt+Shift+N']);
  const pressed = [];
  const keys = createGlobalKeys({ globalShortcut: sc, settings: fakeSettings(), onAction: (a) => pressed.push(a) });
  const st = keys.apply();
  assert.equal(st.on, true);
  assert.deepEqual(st.taken, ['next'], 'another program holds it');
  assert.ok(sc.mine.has('Ctrl+Alt+Shift+P'));
  sc.mine.get('Ctrl+Alt+Shift+P')();
  assert.deepEqual(pressed, ['playPause']);
  // Off: none registered.
  assert.equal(keys.setOn(false).on, false);
  assert.equal(sc.mine.size, 0);
});

test('set: a taken combo keeps the old one, own clashes and refusals are said, a good one replaces it', () => {
  const sc = fakeShortcut(['Ctrl+Alt+Shift+K']);
  const settings = fakeSettings();
  const keys = createGlobalKeys({ globalShortcut: sc, settings, onAction: () => {} });
  keys.apply();
  let r = keys.set('next', 'Ctrl+Alt+Shift+K');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'taken');
  assert.ok(sc.mine.has('Ctrl+Alt+Shift+N'), 'the old one still works');
  r = keys.set('next', 'Ctrl+Alt+Shift+P');
  assert.equal(r.reason, 'own');
  assert.equal(r.other, 'playPause');
  assert.equal(keys.set('next', 'Ctrl+Alt+J').reason, 'altgr');
  r = keys.set('next', 'Ctrl+Alt+Shift+J');
  assert.equal(r.ok, true);
  assert.ok(sc.mine.has('Ctrl+Alt+Shift+J') && !sc.mine.has('Ctrl+Alt+Shift+N'));
  assert.equal(settings.get('globalKeys').next, 'Ctrl+Alt+Shift+J');
  // Cleared.
  assert.equal(keys.set('next', '').ok, true);
  assert.ok(!sc.mine.has('Ctrl+Alt+Shift+J'));
  assert.equal(settings.get('globalKeys').next, '');
  // Reset: the first ones again.
  keys.reset(GLOBAL_KEYS);
  assert.equal(settings.get('globalKeys').next, GLOBAL_KEYS.next);
  assert.ok(sc.mine.has(GLOBAL_KEYS.next));
});
