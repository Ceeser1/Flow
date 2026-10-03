'use strict';

// Where the music comes out: Windows' default output, or a device chosen in
// the player bar or Settings (a Bluetooth speaker, headphones). Everything the
// player plays runs through the equalizer's one AudioContext, so the choice is
// that context's sink (setSinkId); without Web Audio, the elements' own. The
// Add Songs preview follows along.
//
// The choice is kept by id and name (an id can change when a device is paired
// again). A chosen device that is gone (switched off, out of range) plays on
// the default meanwhile, and back on it once it is there again.

const Output = {
  // The outputs Windows offers: [{ deviceId, label }], its "Default" and
  // "Communications" stand-ins left out.
  devices: [],
  // The default output's own name.
  defaultLabel: '',
  // The device playing now ('' for the default).
  current: '',
  _listeners: [],
  // Set after the first look at the devices (no messages for how Flow starts).
  _ready: false,

  onChange(fn) {
    this._listeners.push(fn);
  },

  init() {
    $('btnOutput').innerHTML = Icons.output;
    $('btnOutput').onclick = () => this.openMenu($('btnOutput'));
    this.onChange(() => {
      const chosen = Store.settings.outputDevice ? this._chosen() : null;
      $('btnOutput').title = `Play on: ${this.label() || 'the default output'}`;
      $('btnOutput').classList.toggle('player__output--on', !!chosen);
    });
    // "Output delay" ticked or unticked, here or in Settings.
    Store.onSettings((patch) => {
      if ('outputDelayOn' in patch) this._emit();
    });
    this.refresh();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this.refresh());
    }
  },

  /** The name of the output playing now, as Windows calls it ('' when unknown). */
  label() {
    const d = this.devices.find((x) => x.deviceId === this.current);
    return d ? d.label : this.defaultLabel;
  },

  /**
   * How long this output's sound is held back (ms, Equalizer.setDelay): set
   * by ear per output, so the faster speakers wait for the slower ones when
   * devices play together (Bluetooth speakers lag 50-300 ms). None while
   * "Output delay" is unticked.
   */
  delay() {
    return Store.settings.outputDelayOn ? this.savedDelay() : 0;
  },

  setDelay(ms) {
    const label = this.label();
    if (!label) return;
    const all = { ...(Store.settings.outputDelays || {}) };
    const v = Math.round(Math.max(0, Math.min(1000, Number(ms) || 0)));
    if (v) all[label] = v;
    else delete all[label];
    Store.saveSettings({ outputDelays: all });
    this._emit();
  },

  /** The chosen device, if it is there: found by id, else by name. */
  _chosen() {
    const s = Store.settings;
    if (!s.outputDevice) return null;
    return this.devices.find((d) => d.deviceId === s.outputDevice)
      || (s.outputDeviceLabel ? this.devices.find((d) => d.label === s.outputDeviceLabel) : null)
      || null;
  },

  /** Looks at the devices again; one look at a time (Windows sends several changes in a row). */
  refresh() {
    this._looking = (this._looking || Promise.resolve()).then(() => this._refresh());
    return this._looking;
  },

  async _refresh() {
    let list = [];
    try {
      list = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return;
    }
    const outs = list.filter((d) => d.kind === 'audiooutput');
    const def = outs.find((d) => d.deviceId === 'default');
    this.defaultLabel = def ? def.label.replace(/^Default\s*-\s*/i, '').trim() : '';
    this.devices = outs
      .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications' && d.label)
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    const was = this.current;
    const wasLabel = this.label();
    await this._apply();
    if (this._ready && Store.settings.outputDevice && was !== this.current) {
      const chosen = Store.settings.outputDeviceLabel || 'The chosen output';
      if (!this.current) toast(`${chosen} is not there right now. Playing on ${this.defaultLabel || 'the default output'} meanwhile.`, 'info');
      else if (was === '' && wasLabel !== this.label()) toast(`${this.label()} is back. Playing there again.`, 'info');
    }
    this._ready = true;
    this._emit();
  },

  /** Plays on `deviceId` from now on ('' for Windows' default). */
  async choose(deviceId) {
    const d = this.devices.find((x) => x.deviceId === deviceId);
    Store.saveSettings({ outputDevice: d ? d.deviceId : '', outputDeviceLabel: d ? d.label : '' });
    const ok = await this._apply();
    if (!ok && d) toast(`Flow could not play on ${d.label}. It plays on the default output.`, 'error');
    this._emit();
  },

  /** Points the audio at the chosen device (or the default). False when that was refused. */
  async _apply() {
    const chosen = this._chosen();
    const id = chosen ? chosen.deviceId : '';
    try {
      if (Equalizer.ctx && Equalizer.ctx.setSinkId) {
        if (Equalizer.ctx.sinkId !== id) await Equalizer.ctx.setSinkId(id);
      } else {
        for (const el of [Player.audio, Player.spare]) if (el.setSinkId && el.sinkId !== id) await el.setSinkId(id);
      }
      const preview = $('previewAudio');
      if (preview.setSinkId && preview.sinkId !== id) await preview.setSinkId(id);
      this.current = id;
      return true;
    } catch (err) {
      console.warn('Output device:', err);
      try {
        if (Equalizer.ctx && Equalizer.ctx.setSinkId) await Equalizer.ctx.setSinkId('');
      } catch {
        // The default it is, as before.
      }
      this.current = '';
      return false;
    }
  },

  _emit() {
    Equalizer.setDelay(this.delay());
    for (const fn of this._listeners) fn();
  },

  /** The player bar's output button: a small menu of the outputs, the one playing ticked. */
  openMenu(anchor) {
    if (this._menu) {
      this._closeMenu();
      return;
    }
    this.refresh();
    const menu = h('div.output-menu', { role: 'menu' });
    const draw = () => {
      clear(menu);
      menu.appendChild(h('div.output-menu__head', 'Play on'));
      const chosen = Store.settings.outputDevice ? this._chosen() : null;
      const item = (id, label, on, note = '') => h('button.output-menu__item' + (on ? '.output-menu__item--on' : ''), {
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(on),
        onclick: () => {
          this._closeMenu();
          this.choose(id);
        },
      }, h('span.output-menu__check', { html: on ? Icons.check : '' }), h('span.output-menu__name', label),
      note ? h('span.output-menu__note', note) : null);
      menu.appendChild(item('', 'Windows default', !Store.settings.outputDevice, this.defaultLabel));
      for (const d of this.devices) menu.appendChild(item(d.deviceId, d.label, !!chosen && chosen.deviceId === d.deviceId));
      if (Store.settings.outputDevice && !chosen) {
        menu.appendChild(h('div.output-menu__gone', `${Store.settings.outputDeviceLabel || 'The chosen device'} is not there: playing on the default meanwhile.`));
      }
      menu.appendChild(this._delayRow());
    };
    draw();
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
    menu.style.bottom = `${window.innerHeight - r.top + 8}px`;
    const away = (e) => {
      if (!menu.contains(e.target) && !anchor.contains(e.target)) this._closeMenu();
    };
    const esc = (e) => {
      if (e.key === 'Escape') this._closeMenu();
    };
    setTimeout(() => document.addEventListener('pointerdown', away), 0);
    document.addEventListener('keydown', esc);
    this.onChange(draw);
    this._menu = {
      el: menu,
      off: () => {
        document.removeEventListener('pointerdown', away);
        document.removeEventListener('keydown', esc);
        this._listeners = this._listeners.filter((fn) => fn !== draw);
      },
    };
  },

  /** The note under "Output delay", in the menu and in Settings. */
  DELAY_NOTE: 'At jam sessions, different speakers may have delays. Bluetooth lags 50 to 300ms. '
    + 'Adjust the slider of the faster speakers until the sounds are in sync. Hold shift for 10x finer control.',

  /**
   * "Output delay" for the output playing: set by ear so devices in a jam
   * sound together. Its slider, value and note only while ticked.
   */
  _delayRow() {
    const on = !!Store.settings.outputDelayOn;
    const box = h('input', { type: 'checkbox', checked: on });
    // The menu is drawn again (Store.onSettings in init).
    box.addEventListener('change', () => Store.saveSettings({ outputDelayOn: box.checked }));
    const label = h('label.check.output-menu__delay-label', box, h('span', 'Output delay (Sync speakers at Jams)'));
    if (!on) return h('div.output-menu__delay', h('div.output-menu__delay-head', label));
    const c = this.delayControl('output-menu__slider', 'output-menu__delay-value');
    return h('div.output-menu__delay',
      h('div.output-menu__delay-head', label, c.value),
      c.slider,
      h('div.output-menu__delay-note', this.DELAY_NOTE));
  },

  /** The delay set for the output playing, ticked or not (ms). */
  savedDelay() {
    const d = (Store.settings.outputDelays || {})[this.label()];
    return Number.isFinite(d) ? d : 0;
  },

  /**
   * The delay's slider (0-500 ms at 1 ms) and its value, for the menu and
   * Settings: { slider, value, sync() } (sync: shows the saved value again).
   * Heard while it moves, saved when let go.
   */
  delayControl(sliderClass, valueClass) {
    const MAX = 500;
    const THUMB = 12;
    const value = h(`span.${valueClass}`);
    const slider = h(`input.volume-slider.${sliderClass}`, {
      type: 'range', min: 0, max: MAX, step: 1, 'aria-label': 'Output delay',
    });
    const show = (v) => {
      slider.value = String(Math.round(Math.max(0, Math.min(MAX, v))));
      value.textContent = `${slider.value} ms`;
      slider.style.setProperty('--fill', `${(Number(slider.value) / MAX) * 100}%`);
    };
    const move = (v) => {
      show(v);
      Equalizer.setDelay(Number(slider.value));
    };
    // The arrow keys move it by 1 ms.
    slider.addEventListener('input', () => move(Number(slider.value)));
    slider.addEventListener('change', () => this.setDelay(Number(slider.value)));

    // Dragged by hand: the thumb follows the pointer, ten times slower while
    // Shift is held (so every single ms can be reached).
    const perPx = () => MAX / Math.max(1, slider.getBoundingClientRect().width - THUMB);
    let drag = null;
    slider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || slider.disabled) return;
      e.preventDefault();
      slider.focus();
      slider.setPointerCapture(e.pointerId);
      // A click on the track puts the thumb there; with Shift it stays where it is.
      const r = slider.getBoundingClientRect();
      const v = e.shiftKey ? Number(slider.value) : (e.clientX - r.left - THUMB / 2) * perPx();
      drag = { x: e.clientX, v, shift: e.shiftKey, at: v };
      move(v);
    });
    slider.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // Shift pressed or let go mid-drag: carries on from where the thumb is.
      if (e.shiftKey !== drag.shift) drag = { x: e.clientX, v: drag.at, shift: e.shiftKey, at: drag.at };
      const v = drag.v + ((e.clientX - drag.x) * perPx()) / (drag.shift ? 10 : 1);
      drag.at = Math.max(0, Math.min(MAX, v));
      move(drag.at);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      this.setDelay(Number(slider.value));
    };
    slider.addEventListener('pointerup', end);
    slider.addEventListener('lostpointercapture', end);

    const sync = () => {
      if (!drag) show(this.savedDelay());
    };
    sync();
    return { slider, value, sync };
  },

  _closeMenu() {
    if (!this._menu) return;
    this._menu.off();
    this._menu.el.remove();
    this._menu = null;
  },
};
