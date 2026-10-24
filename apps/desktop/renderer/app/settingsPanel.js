'use strict';

// The Settings window, opened with the cog at the bottom of the menu. Every row
// is a setting on the left (a tick box, its name and what it does) and its
// value on the right. Rows under another one ("=>" in the design) only count
// while the one above is ticked, and are greyed out otherwise.
//
// Changes take effect at once: sliders follow along while dragged
// (Store.previewSettings) and are saved when let go.

const EQ_SCHEMES = [
  ['spectrum', 'Spectrum'],
  ['rainbow', 'Rainbow'],
  ['greyscale', 'Greyscale'],
  ['white', 'White'],
  ['red', 'Red'],
  ['green', 'Green'],
  ['yellow', 'Yellow'],
  ['blue', 'Blue'],
  ['purple', 'Purple'],
  ['black', 'Black'],
];

// The clouds: each its own colour, or all one (the equalizer's solid ones).
const CLOUD_SCHEMES = [
  ['rainbow', 'Rainbow'],
  ...EQ_SCHEMES.filter(([v]) => !['spectrum', 'rainbow', 'greyscale'].includes(v)),
];

function fmtBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

// Limit framerate's steps (frames a second; 0: no limit).
const VIZ_FPS = [15, 30, 45, 60, 75, 90, 105, 120, 144, 165, 240, 360, 0];

const SettingsPanel = {
  modal: null,
  _refresh: [],       // re-greys rows after a tick box changes
  _onProgress: null,  // the save folder move, while it runs

  init() {
    $('menuSettings').innerHTML = '<img class="settings-btn__icon" src="../images/settings.png" alt="" />';
    $('menuSettings').onclick = () => this.open();
    window.flow.onFolderProgress((p) => {
      if (this._onProgress) this._onProgress(p);
    });
    // A setting Flow changed by itself (the Remote address filled in) while this is open.
    Store.onSettings(() => {
      if (this.modal) this._refreshAll();
    });
    Store.onLibrary(() => {
      if (!this.modal) return;
      Stats.soon();
      this._drawMeasured();
      this._drawCovers();
      this._drawLyrics();
      this._drawStorage();
    });
    Store.onServer(() => {
      if (this.modal) this._drawServer();
      if (this.modal) this._drawAdmin();
      if (this.modal) Stats.soon();
      if (this.modal && this._jamNote) this._jamNote();
    });
    // Lyrics kept, or the background lookups moved on (4.0.1).
    if (window.flow.onLyricsChanged) {
      window.flow.onLyricsChanged(() => {
        if (this.modal) this._drawLyrics();
      });
    }
    Output.onChange(() => {
      if (this.modal && this._outputFill) this._outputFill();
      if (this.modal && this._delayFill) this._delayFill();
    });
  },

  open() {
    if (this.modal) return;
    this._refresh = [];
    const body = h('div.settings', ...this._sections([
      h('h3.settings__section', 'General'),
      Store.can('outputDevices') ? this._row({
        label: 'Output device',
        desc: 'Where the music plays from.',
        right: this._outputSelect(),
      }) : null,
      Store.can('systemOutput') ? this._row({
        label: 'Output device',
        desc: 'Where the music plays from: this phone, headphones or a Bluetooth speaker. The phone chooses it; Change opens its chooser.',
        right: this._systemOutput(),
      }) : null,
      Store.can('songTransition') ? this._row({
        key: 'crossfade',
        label: 'Song Transition',
        desc: 'Smoothly transition between songs for the set time.',
        right: this._slider({ key: 'crossfadeSeconds', name: 'Song Transition length', min: 0.1, max: 10, step: 0.1, format: (v) => `${v.toFixed(1)} s`, when: () => Store.settings.crossfade }),
      }) : null,
      this._row({
        key: 'normalize',
        label: 'Equalize volume',
        desc: 'Play all songs at an equal volume. It reduces loud spikes and makes quiet songs louder.',
        right: this._measuredNode = h('span.settings__note'),
      }),
      this._row({
        key: 'showTrend',
        label: 'Show listening trends',
        desc: 'If disabled, your listening trend category will be hidden in the menu and the search.',
      }),
      this._row({
        key: 'autoDj',
        label: 'Continue with similar songs',
        desc: 'When the list playing has played through, songs like the last ones you heard follow (the same artists, genre, Info '
          + 'or album, those you listen to most first) instead of the list starting over. The Queue shows them as "Then similar songs".',
      }),
      // The phone's lists have no columns.
      Store.phone ? null : this._row({
        label: 'Show filterable columns for Songs',
        desc: 'Extra columns in All Songs and the playlists. Each can be sorted by a click on its heading, and the search finds what is in it.',
        right: this._columnTicks(),
      }),

      ...(Store.can('soundEq') ? this._soundEqRows() : []),

      ...this._serverRows(),

      ...this._jamRows(),

      ...this._mediaRows(),

      // The clouds everywhere; what listens to the music (their bass, the
      // equalizer, the visualizers) only where the page hears it (effects).
      h('h3.settings__section', 'App Visuals'),
      Store.phone ? h('div.settings__desc.settings__intro', 'Using background visuals for the app will drain your battery a bit faster than without.') : null,
      this._row({
        key: 'cloudsOn',
        label: 'Enable Background Clouds',
        desc: 'Slowly drifting clouds of colour behind the pages.',
        right: this._slider({ key: 'cloudsIntensity', label: 'Intensity', when: () => Store.settings.cloudsOn }),
      }),
      Store.can('effects') ? this._row({
        key: 'cloudsBass',
        label: 'React to Bass',
        desc: 'The clouds swell and brighten on kicks and bass notes.',
        sub: true,
        when: () => Store.settings.cloudsOn,
        right: this._slider({ key: 'cloudsBassAmount', label: 'Strength', when: () => Store.settings.cloudsOn && Store.settings.cloudsBass }),
      }) : null,
      this._row({
        label: 'Clouds color scheme',
        desc: 'Rainbow gives each cloud a random color as it comes.',
        sub: true,
        when: () => Store.settings.cloudsOn,
        right: this._select({ key: 'cloudsColors', options: CLOUD_SCHEMES, when: () => Store.settings.cloudsOn }),
      }),
      this._row({
        label: 'Clouds amount',
        desc: 'How many clouds drift at once.',
        sub: true,
        when: () => Store.settings.cloudsOn,
        right: this._slider({ key: 'cloudsAmount', label: 'Amount', min: 0, max: 100, step: 10, when: () => Store.settings.cloudsOn }),
      }),

      ...(Store.can('effects') ? [
      this._row({
        key: 'eqOn',
        label: 'Enable Background Equalizer',
        desc: 'The music\'s frequencies glowing up from the player bar.',
        right: this._slider({ key: 'eqHeight', label: 'Height', when: () => Store.settings.eqOn }),
      }),
      this._row({
        label: 'Visibility',
        desc: 'How strongly the equalizer is visible.',
        sub: true,
        when: () => Store.settings.eqOn,
        right: this._slider({ key: 'eqVisibility', label: 'Alpha', when: () => Store.settings.eqOn }),
      }),
      this._row({
        key: 'eqShine',
        label: 'Outer Shine',
        desc: 'A glow around the bars, reaching further the taller they are.',
        sub: true,
        when: () => Store.settings.eqOn,
        right: this._slider({ key: 'eqShineSpread', label: 'Spread', when: () => Store.settings.eqOn && Store.settings.eqShine }),
      }),
      this._row({
        label: 'Equalizer color scheme',
        desc: 'Spectrum colors bars by their height. Rainbow runs colors across the bars. Greyscale turns them whiter the taller they are.',
        sub: true,
        when: () => Store.settings.eqOn,
        right: this._select({ key: 'eqColors', options: EQ_SCHEMES, when: () => Store.settings.eqOn }),
      }),

      h('h3.settings__section', 'Music Visualizer'),
      this._visualizerRow([
        ...this._frameRateRows(),
        this._row({
          key: 'vizLyrics',
          label: 'Show Lyrics in visualizers',
          desc: 'The line being sung and the next one at the bottom of a full-screen visualizer, for songs whose lyrics have their times. A song starting without them says so there for a few seconds.',
        }),
        this._randomEachRow(),
      ]),
      ] : []),

      ...(Store.can('batteryHelp') ? this._appRows() : []),

      // Whose listens count, and the numbers (stats.js); Administration stays last.
      ...Stats.rows(),

      // Last, and only while an admin profile is logged in (_drawAdmin).
      ...Admin.rows(),
    ]));

    // The phone's Settings comes in from the left, where the drawer it is
    // opened from was, and goes back there with the X or a swipe to the left.
    const mobile = document.body.classList.contains('mobile');
    this.modal = Modal.open({
      title: 'Settings',
      className: 'modal--settings',
      drawer: mobile,
      body: [body],
      buttons: mobile ? [] : [{ label: 'Close', kind: 'primary' }],
      onClose: () => {
        this.modal = null;
        this._refresh = [];
        // The profile's ⋯ tray, should Escape have closed Settings under it.
        if (SongActions.tray && SongActions.tray.classList.contains('act-tray--settings')) SongActions.close();
      },
    });
    if (mobile) {
      const modal = this.modal;
      this._backBtn = iconButton('modal__back', Icons.chevronLeft, 'Back', () => this.back());
      this._backBtn.hidden = true;
      modal.el.querySelector('.modal__head').prepend(this._backBtn);
      Mobile.swipeToClose(modal, ['left']);
      // Back on the category open last time: its title and the Back button.
      if (this._screen) this._openScreen(this._screen);
    }
    this._refreshAll();
    this._drawStats();
    this._drawMeasured();
    this._drawCovers();
    this._drawLyrics();
    this._drawStorage();
    this._drawServer();
    this._drawAdmin(true);
    Stats.load();
    // Profiles made or renamed on other devices since.
    if (Store.server.on && Store.server.state === 'online') window.flow.profiles().catch(() => {});
  },

  _refreshAll() {
    for (const fn of this._refresh) fn();
  },

  // ---- building blocks ----

  /**
   * One setting. `key`: its tick box (none for a row that is only a value).
   * `sub`: indented under the row above. `when`: greyed out unless true.
   * `show`: the row is not there unless true.
   */
  /**
   * Groups the flat list (a heading, then its rows) into categories. A heading
   * folds its rows away with a click: an up arrow while they show, a down
   * arrow while they are hidden.
   */
  _sections(nodes) {
    if (document.body.classList.contains('mobile')) return this._screens(nodes.filter(Boolean));
    const groups = [];
    let rows = null;
    for (const node of nodes.filter(Boolean)) {
      if (!node.classList.contains('settings__section')) {
        rows.appendChild(node);
        continue;
      }
      // The heading's own text, without a note beside it (which changes).
      const title = node.childNodes[0].textContent;
      const chevron = h('span.settings__chevron', { html: Icons.chevron });
      node.prepend(chevron);
      Object.assign(node, { tabIndex: 0, title: 'Show or hide this category' });
      node.setAttribute('role', 'button');
      const own = h('div.settings__group-rows');
      rows = own;
      // Folded shut or open as left last time (settingsCollapsed, kept).
      const folded = () => new Set(Store.settings.settingsCollapsed);
      const draw = () => {
        const shut = folded().has(title);
        own.hidden = shut;
        chevron.classList.toggle('settings__chevron--down', shut);
        node.setAttribute('aria-expanded', String(!shut));
      };
      const toggle = () => {
        const shut = folded();
        if (shut.has(title)) shut.delete(title);
        else shut.add(title);
        Store.saveSettings({ settingsCollapsed: [...shut] });
        draw();
      };
      node.addEventListener('click', toggle);
      node.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      draw();
      groups.push(h('div.settings__group', node, own));
    }
    return groups;
  },

  /**
   * The phone's Settings: the categories as a list, each opening on its own
   * screen (Back returns to the list, see back()).
   */
  _screens(nodes) {
    const groups = [];
    let rows = null;
    for (const node of nodes) {
      if (!node.classList.contains('settings__section')) {
        rows.appendChild(node);
        continue;
      }
      const title = node.childNodes[0].textContent;
      rows = h('div.settings__group-rows');
      const group = h('div.settings__group', rows);
      group.dataset.title = title;
      groups.push(group);
    }
    const list = h('div.settings__categories', ...groups.map((g) => h('button.settings__category', {
      type: 'button',
      onclick: () => this._openScreen(g.dataset.title),
    }, h('span', g.dataset.title), h('span.settings__chevron', { html: Icons.chevron }))));
    this._screenList = list;
    this._screenGroups = groups;
    this._screen = null;
    for (const g of groups) g.hidden = true;
    // Open on the category open when Settings last closed (settingsCategory).
    const last = Store.settings.settingsCategory;
    if (last && groups.some((g) => g.dataset.title === last)) {
      this._screen = last;
      list.hidden = true;
      for (const g of groups) g.hidden = g.dataset.title !== last;
    }
    return [list, ...groups];
  },

  _openScreen(title) {
    this._screen = title;
    if ((title || '') !== Store.settings.settingsCategory) Store.saveSettings({ settingsCategory: title || '' });
    this._screenList.hidden = !!title;
    for (const g of this._screenGroups) g.hidden = g.dataset.title !== title;
    const head = this.modal && this.modal.el.querySelector('.modal__title');
    if (head) head.textContent = title || 'Settings';
    if (this._backBtn) this._backBtn.hidden = !title;
    const body = this.modal && this.modal.el.querySelector('.modal__body');
    if (body) body.scrollTop = 0;
  },

  /**
   * Administration is there only while an admin profile is logged in: shown
   * or hidden as that changes, and fetched when it shows (or `force`).
   */
  _drawAdmin(force = false) {
    const on = !!Store.server.admin;
    const was = this._adminOn;
    this._adminOn = on;
    const title = 'Administration';
    if (document.body.classList.contains('mobile')) {
      const btn = [...this._screenList.querySelectorAll('.settings__category')].find((x) => x.textContent === title);
      if (btn) btn.hidden = !on;
      if (!on && this._screen === title) this._openScreen(null);
    } else {
      const head = [...this.modal.el.querySelectorAll('.settings__section')].find((n) => n.textContent.trim() === title);
      const group = head && head.closest('.settings__group');
      if (group) group.hidden = !on;
    }
    if (on && (force || !was)) Admin.load();
  },

  /** The phone's Back while Settings is open: from a category to the list. False on the list. */
  back() {
    if (!this.modal || !this._screen) return false;
    this._openScreen(null);
    return true;
  },

  // ---- Equalizer ----

  /**
   * The sound equalizer (soundEq.js): Bands (8 to 48 points from 20 Hz to
   * 20 kHz), Pre-Defined (the ready-made curves, and Custom: the user's own),
   * then the curve itself. A point is dragged up or down (Shift: finer) or put
   * back to 0 dB with a double-click; the keys pick one (Left, Right) and move
   * it (Up, Down). Moving a point makes the curve Custom.
   */
  _soundEqRows() {
    const shown = () => SoundEq.gainsOf(Store.settings);
    const custom = (gains) => ({ soundEqPreset: 'custom', soundEqCustom: gains });
    const round = (db) => Math.round(Math.max(-SoundEq.MAX_DB, Math.min(SoundEq.MAX_DB, db)) * 10) / 10;

    const { MIN_BANDS, MAX_BANDS } = SoundEq;
    const bands = h('input.volume-slider.settings__slider', {
      type: 'range', min: MIN_BANDS, max: MAX_BANDS, step: 1, value: Store.settings.soundEqBands, 'aria-label': 'Audio bands',
    });
    const bandsValue = h('span.settings__value');
    const drawBands = () => {
      const v = Number(bands.value);
      bandsValue.textContent = String(v);
      bands.style.setProperty('--fill', `${((v - MIN_BANDS) / (MAX_BANDS - MIN_BANDS)) * 100}%`);
    };
    // Custom's points spread over the new number from those it had when the slider was taken.
    let base = null;
    const bandsPatch = () => {
      const n = Number(bands.value);
      if (Store.settings.soundEqPreset !== 'custom') return { soundEqBands: n };
      if (!base) base = shown();
      return { soundEqBands: n, soundEqCustom: SoundEq.resample(base, n) };
    };
    bands.addEventListener('input', () => {
      drawBands();
      Store.previewSettings(bandsPatch());
    });
    bands.addEventListener('change', () => {
      Store.saveSettings(bandsPatch());
      base = null;
    });

    const preset = h('select.select', { 'aria-label': 'Pre-Defined' });
    for (const id of SoundEq.CHOICES) preset.appendChild(h('option', { value: id }, id === 'custom' ? 'Custom' : SoundEq.PRESETS[id].name));
    preset.addEventListener('change', () => {
      const patch = { soundEqPreset: preset.value };
      // Custom the first time: the curve shown until then, to change from.
      if (preset.value === 'custom' && !Store.settings.soundEqCustom.length) patch.soundEqCustom = shown();
      Store.saveSettings(patch);
    });

    const canvas = h('canvas.sound-eq__canvas', {
      tabIndex: 0, 'aria-label': 'Equalizer curve: Left and Right pick a band, Up and Down raise or lower it',
    });
    const readout = h('span.sound-eq__readout');
    const graph = h('div.sound-eq', canvas,
      h('div.sound-eq__info', readout, h('span', 'Drag a point up or down (Shift: finer). A double-click puts it back to 0 dB.')));

    // Room for the dB at the left and the Hz under it.
    const PAD = { l: 38, r: 14, t: 10, b: 22 };
    const LOG = Math.log(SoundEq.HIGH_HZ / SoundEq.LOW_HZ);
    const area = () => ({ x0: PAD.l, x1: canvas.clientWidth - PAD.r, y0: PAD.t, y1: canvas.clientHeight - PAD.b });
    const xOf = (b, hz) => b.x0 + (Math.log(hz / SoundEq.LOW_HZ) / LOG) * (b.x1 - b.x0);
    const hzOf = (b, x) => SoundEq.LOW_HZ * Math.exp(((x - b.x0) / (b.x1 - b.x0)) * LOG);
    const yOf = (b, db) => b.y0 + ((SoundEq.MAX_DB - db) / (2 * SoundEq.MAX_DB)) * (b.y1 - b.y0);
    const dbOf = (b, y) => SoundEq.MAX_DB - ((y - b.y0) / (b.y1 - b.y0)) * 2 * SoundEq.MAX_DB;
    const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz` : `${Math.round(hz)} Hz`);
    const fmtDb = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
    let hot = -1;      // the point under the pointer, or picked with the keys
    let drag = null;   // { i, gains, dy, moved } while one is dragged

    const draw = () => {
      const w = canvas.clientWidth;
      const ht = canvas.clientHeight;
      if (!w || !ht) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(ht * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(ht * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, ht);
      const css = getComputedStyle(document.body);
      const accent = css.getPropertyValue('--accent').trim() || '#5a8cdc';
      const b = area();
      const gains = drag ? drag.gains : shown();
      if (hot >= gains.length) hot = -1;
      const fs = SoundEq.freqs(gains.length);
      const pts = SoundEq.pointsOf(gains);
      const line = (x0, y0, x1, y1) => {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      };

      ctx.font = `11px ${css.fontFamily}`;
      ctx.fillStyle = css.getPropertyValue('--text-dim').trim() || '#8a8a94';
      ctx.lineWidth = 1;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      for (const db of [12, 6, 0, -6, -12]) {
        const y = Math.round(yOf(b, db)) + 0.5;
        ctx.strokeStyle = db === 0 ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.08)';
        line(b.x0, y, b.x1, y);
        ctx.fillText(`${db > 0 ? '+' : ''}${db}`, b.x0 - 8, y);
      }
      ctx.textBaseline = 'top';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      for (const hz of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
        const x = Math.round(xOf(b, hz)) + 0.5;
        line(x, b.y0, x, b.y1);
        ctx.textAlign = hz === 20 ? 'left' : hz === 20000 ? 'right' : 'center';
        ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x, b.y1 + 6);
      }

      // The curve, eased from point to point, filled to 0 dB.
      const curve = [];
      for (let x = b.x0; x < b.x1; x += 1) curve.push([x, yOf(b, SoundEq.at(pts, hzOf(b, x)))]);
      curve.push([b.x1, yOf(b, gains[gains.length - 1])]);
      const zero = yOf(b, 0);
      ctx.beginPath();
      ctx.moveTo(b.x0, zero);
      for (const [x, y] of curve) ctx.lineTo(x, y);
      ctx.lineTo(b.x1, zero);
      ctx.closePath();
      ctx.globalAlpha = 0.16;
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      curve.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#1e1e22';
      fs.forEach((f, i) => {
        ctx.beginPath();
        ctx.arc(xOf(b, f), yOf(b, gains[i]), i === hot ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === hot ? '#fff' : accent;
        ctx.fill();
        ctx.stroke();
      });
      readout.textContent = hot >= 0 ? `${fmtHz(fs[hot])}: ${fmtDb(gains[hot])}` : '';
      canvas.classList.toggle('sound-eq__canvas--hot', hot >= 0 || !!drag);
    };

    /** The point nearest the pointer, within a few pixels; -1 for none. */
    const nearest = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const b = area();
      const gains = shown();
      const fs = SoundEq.freqs(gains.length);
      let best = -1;
      let bestD = 14;
      fs.forEach((f, i) => {
        const d = Math.hypot(xOf(b, f) - x, yOf(b, gains[i]) - y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const i = nearest(e);
      if (i < 0) return;
      e.preventDefault();
      canvas.focus();
      const gains = shown();
      const r = canvas.getBoundingClientRect();
      drag = { i, gains, dy: e.clientY - r.top - yOf(area(), gains[i]), moved: false };
      hot = i;
      canvas.setPointerCapture(e.pointerId);
      draw();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) {
        const i = nearest(e);
        if (i !== hot) {
          hot = i;
          draw();
        }
        return;
      }
      const r = canvas.getBoundingClientRect();
      const step = e.shiftKey ? 0.1 : 0.5;
      const db = round(Math.round(dbOf(area(), e.clientY - r.top - drag.dy) / step) * step);
      if (db === drag.gains[drag.i]) return;
      drag.gains = drag.gains.slice();
      drag.gains[drag.i] = db;
      drag.moved = true;
      Store.previewSettings(custom(drag.gains));
    });
    const drop = () => {
      if (!drag) return;
      if (drag.moved) Store.saveSettings(custom(drag.gains));
      drag = null;
      draw();
    };
    canvas.addEventListener('pointerup', drop);
    canvas.addEventListener('pointercancel', drop);
    canvas.addEventListener('pointerleave', () => {
      if (drag || hot < 0) return;
      hot = -1;
      draw();
    });
    canvas.addEventListener('dblclick', (e) => {
      const i = nearest(e);
      const gains = shown();
      if (i < 0 || gains[i] === 0) return;
      gains[i] = 0;
      Store.saveSettings(custom(gains));
    });
    canvas.addEventListener('keydown', (e) => {
      const gains = shown();
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        hot = Math.max(0, Math.min(gains.length - 1, hot < 0 ? 0 : hot + (e.key === 'ArrowLeft' ? -1 : 1)));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (hot < 0) hot = 0;
        const db = round(gains[hot] + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 0.5));
        if (db !== gains[hot]) {
          gains[hot] = db;
          Store.saveSettings(custom(gains));
        }
      } else {
        return;
      }
      e.preventDefault();
      draw();
    });
    canvas.addEventListener('blur', () => {
      if (drag) return;
      hot = -1;
      draw();
    });
    new ResizeObserver(draw).observe(canvas);

    this._refresh.push(() => {
      bands.value = Store.settings.soundEqBands;
      drawBands();
      preset.value = Store.settings.soundEqPreset;
      draw();
    });

    return [
      h('h3.settings__section', 'Equalizer'),
      this._row({
        label: 'Audio bands',
        desc: 'How many frequencies get separated for fidelity.',
        right: h('div.settings__control', bands, bandsValue),
      }),
      this._row({
        label: 'Pre-Defined',
        desc: 'A ready-made curve, or Custom: your own points. Moving a point makes the curve shown your Custom one.',
        right: preset,
      }),
      graph,
    ];
  },

  /** The Android app's own: its version, and help for playing on with the screen off. */
  _appRows() {
    return [
      h('h3.settings__section', 'App'),
      this._row({ label: 'Version', desc: `Flow ${Store.version || ''}`.trim() }),
      Store.can('batteryHelp') ? this._row({
        label: 'Playing with the screen off',
        desc: 'How to keep the phone from stopping Flow in the background.',
        right: h('button.btn.btn--small', { type: 'button', onclick: () => BackgroundHelp.open() }, 'Show'),
      }) : null,
    ];
  },

  _row({ key, label, desc, right = null, sub = false, when = null, show = null }) {
    const left = h('div.settings__left');
    let box = null;
    if (key) {
      box = h('input', { type: 'checkbox', checked: !!Store.settings[key] });
      box.addEventListener('change', () => {
        Store.saveSettings({ [key]: box.checked });
        this._refreshAll();
      });
      left.appendChild(h('label.check.settings__label', box, h('span', label)));
    } else {
      left.appendChild(h('div.settings__label.settings__label--plain', label));
    }
    if (desc) left.appendChild(h('div.settings__desc', desc));
    const row = h('div.settings__row' + (sub ? '.settings__row--sub' : ''), left, h('div.settings__right', right));
    this._refresh.push(() => {
      const on = when ? !!when() : true;
      if (show) row.hidden = !show();
      row.classList.toggle('settings__row--off', !on);
      if (box) {
        box.disabled = !on;
        // Ticked by Flow too (Switch server ticks Use a Flow Server).
        box.checked = !!Store.settings[key];
      }
      // Its own box unticked: the value beside it does nothing either.
      row.classList.toggle('settings__row--unset', !!box && !box.checked);
    });
    return row;
  },

  /** Album, Mix, Genre and Info: which of the song lists' optional columns show. */
  _columnTicks() {
    const tick = (key, label) => {
      const box = h('input', { type: 'checkbox', checked: !!Store.settings[key] });
      box.addEventListener('change', () => Store.saveSettings({ [key]: box.checked }));
      this._refresh.push(() => {
        box.checked = !!Store.settings[key];
      });
      return h('label.check', box, h('span', label));
    };
    return h('div.settings__ticks',
      tick('colAlbum', 'Album'), tick('colGenre', 'Genre'), tick('colSubGenre', 'Info'), tick('colMix', 'Mix'));
  },

  /** A slider with its value beside it. Percent 1-100 unless told otherwise. */
  _slider({ key, label = '', name = label, min = 1, max = 100, step = 1, format = (v) => `${Math.round(v)}%`, when }) {
    // `name`: what a screen reader calls it (its label when it shows one).
    const input = h('input.volume-slider.settings__slider', { type: 'range', min, max, step, value: Store.settings[key], 'aria-label': name || null });
    const value = h('span.settings__value');
    const draw = () => {
      const v = Number(input.value);
      value.textContent = format(v);
      input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
    };
    input.addEventListener('input', () => {
      draw();
      Store.previewSettings({ [key]: Number(input.value) });
    });
    input.addEventListener('change', () => Store.saveSettings({ [key]: Number(input.value) }));
    draw();
    if (when) this._refresh.push(() => { input.disabled = !when(); });
    return h('div.settings__control', label ? h('span.settings__caption', label) : null, input, value);
  },

  _select({ key, options, when }) {
    const select = h('select.select');
    for (const [v, text] of options) select.appendChild(h('option', { value: v }, text));
    select.value = String(Store.settings[key]);
    select.addEventListener('change', () => Store.saveSettings({ [key]: select.value }));
    if (when) this._refresh.push(() => { select.disabled = !when(); });
    return select;
  },

  // ---- Music Visualizer ----

  /**
   * "Select your Music Visualizer": a 16:9 tile each (VISUALIZERS in
   * visualizer.js), the chosen one outlined, and Preview to open it. Then
   * the rows `above` (Limit framerate, Random for every new song), then the categories
   * (VIZ_CATEGORIES), each with its own Random first, folding away with a
   * click on its heading (vizCollapsed, kept); folded, the heading says which
   * of its own is chosen.
   */
  _visualizerRow(above) {
    const all = [];
    const notes = [];
    const draw = () => {
      for (const tile of all) {
        const on = tile.dataset.id === Store.settings.visualizer;
        tile.classList.toggle('viz-tile--on', on);
        tile.setAttribute('aria-pressed', String(on));
      }
      for (const note of notes) note();
    };
    const tile = (v) => {
      const art = h('span.viz-tile__art');
      // Its picture once there is one; a sign for it until then (or if it is missing).
      const glyph = () => {
        art.innerHTML = v.glyph || '';
      };
      if (v.image) art.appendChild(h('img.viz-tile__img', { src: v.image, alt: '', onerror: glyph }));
      else glyph();
      const el = h('button.viz-tile' + (v.ready ? '' : '.viz-tile--soon'), {
        type: 'button',
        disabled: !v.ready,
        title: v.ready ? v.desc : 'Coming soon',
        dataset: { id: v.id },
        onclick: () => {
          Store.saveSettings({ visualizer: v.id });
          Visualizer.warm(v.id);
          draw();
          this._refreshAll();
        },
      }, art, h('span.viz-tile__name', v.name), v.ready ? null : h('span.viz-tile__soon', 'Soon'));
      all.push(el);
      return el;
    };
    const byId = new Map(VISUALIZERS.map((v) => [v.id, v]));
    const shuffle = VIZ_RANDOM_GLYPH;
    const groups = VIZ_CATEGORIES.map((cat) => {
      const members = cat.ids.map((id) => byId.get(id)).filter(Boolean);
      const random = { id: `random-${cat.id}`, name: 'Random', ready: true, desc: `A different one of the ${cat.name} each time`, glyph: shuffle };
      const grid = h('div.viz-picker', tile(random), ...members.map(tile));
      const chevron = h('span.settings__chevron', { html: Icons.chevron });
      const note = h('span.viz-cat__note');
      const head = h('div.viz-cat', { tabIndex: 0, title: 'Show or hide this category' }, chevron, h('span', cat.name), note);
      head.setAttribute('role', 'button');
      const shut = () => Store.settings.vizCollapsed.includes(cat.id);
      notes.push(() => {
        const chosen = Store.settings.visualizer === random.id ? random : members.find((v) => v.id === Store.settings.visualizer);
        note.textContent = shut() && chosen ? `${chosen.name} chosen` : cat.desc;
      });
      const fold = () => {
        grid.hidden = shut();
        chevron.classList.toggle('settings__chevron--down', shut());
        head.setAttribute('aria-expanded', String(!shut()));
      };
      const toggle = () => {
        const now = new Set(Store.settings.vizCollapsed);
        if (now.has(cat.id)) now.delete(cat.id);
        else now.add(cat.id);
        Store.saveSettings({ vizCollapsed: [...now] });
        fold();
        draw();
      };
      head.addEventListener('click', toggle);
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      fold();
      return h('div.viz-cat-group', head, grid);
    });
    draw();
    const preview = h('button.btn.btn--small', { type: 'button', onclick: () => Visualizer.open() }, 'Preview selected');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Select your Music Visualizer'),
      h('div.settings__desc', 'Opens in full screen from the visualizer button in the player bar. Escape or the X closes it; the Up and Down arrow keys switch to the one before or after.'));
    return h('div.settings__viz',
      h('div.settings__row.settings__row--flat', left, h('div.settings__right', preview)),
      ...above,
      ...groups);
  },

  /**
   * Limit framerate: its box and a slider through VIZ_FPS (the last no
   * limit), and under it V-Sync, as many as the screen shows (its refresh
   * rate, measured, then shown on the slider). The slider is greyed out
   * while the limit is off or V-Sync on.
   */
  _frameRateRows() {
    const values = VIZ_FPS;
    const input = h('input.volume-slider.settings__slider', { type: 'range', min: 0, max: values.length - 1, step: 1, 'aria-label': 'Framerate limit' });
    const value = h('span.settings__value');
    const detected = h('span.settings__note');
    let hz = 0;
    const fpsText = (v) => `${v || '∞'} FPS`;
    const draw = () => {
      const vsync = Store.settings.vizVsync;
      const control = input.parentNode;
      // With V-Sync at the step nearest the screen's rate (no limit above all of them).
      const near = values.slice(0, -1).reduce((best, v, i) => (Math.abs(v - hz) < Math.abs(values[best] - hz) ? i : best), 0);
      const at = vsync ? (hz > values[values.length - 2] ? values.length - 1 : near) : Math.max(0, values.indexOf(Store.settings.vizFps));
      if (document.activeElement !== input) input.value = String(at);
      const shown = vsync ? (hz ? `${hz} FPS` : '…') : fpsText(values[Number(input.value)]);
      value.textContent = shown;
      input.disabled = vsync || !Store.settings.vizFpsOn;
      if (control) control.classList.toggle('settings__control--off', vsync && Store.settings.vizFpsOn);
      input.style.setProperty('--fill', `${(Number(input.value) / (values.length - 1)) * 100}%`);
      detected.textContent = hz ? `${hz} Hz detected` : '';
    };
    input.addEventListener('input', () => {
      Store.previewSettings({ vizFps: values[Number(input.value)] });
      draw();
    });
    input.addEventListener('change', () => Store.saveSettings({ vizFps: values[Number(input.value)] }));
    this._refresh.push(draw);
    Visualizer.refreshRate((rate) => {
      hz = rate;
      draw();
    });
    draw();
    return [
      this._row({
        key: 'vizFpsOn',
        label: 'Limit framerate',
        desc: 'Set the framerate limit for visualizers to save GPU power consumption.',
        right: h('div.settings__control', input, value),
      }),
      this._row({
        key: 'vizVsync',
        label: 'V-Sync (detect monitor refresh rate)',
        desc: 'Set the limit to draw as many frames as your monitor can show automatically.',
        sub: true,
        when: () => Store.settings.vizFpsOn,
        right: detected,
      }),
    ];
  },

  /** Random for every new song: greyed out, it says what it needs. */
  _randomEachRow() {
    const random = () => Store.settings.visualizer.startsWith('random');
    const row = this._row({
      key: 'vizRandomEach',
      label: 'Random for every new song',
      desc: 'When a new song starts playing a new random visualizer from the selected category is chosen. Keeps full screen.',
      when: random,
    });
    const name = row.querySelector('.settings__label span');
    this._refresh.push(() => {
      name.textContent = random() ? 'Random for every new song' : "Random for every new song (requires 'Random' in any category)";
    });
    return row;
  },

  /** The browser the cookies come from: those found on this computer first. */
  /** The outputs Windows offers (output.js). */
  /** The phone's: where the music comes out now, and a button to its own chooser. */
  _systemOutput() {
    const name = h('span.settings__note');
    const draw = () => window.flow.outputName().then((n) => {
      name.textContent = n;
    }).catch(() => {});
    draw();
    if (!this._outputWatched && window.flow.onOutputChange) {
      this._outputWatched = true;
      window.flow.onOutputChange(() => this._refreshAll());
    }
    this._refresh.push(draw);
    return h('div.settings__output', name,
      h('button.btn.btn--small', { type: 'button', onclick: () => window.flow.chooseOutput().catch(() => {}) }, 'Change'));
  },

  _outputSelect() {
    const select = h('select.select');
    const fill = () => {
      clear(select);
      select.appendChild(h('option', { value: '' }, `${Output.defaultName}${Output.defaultLabel ? ` (${Output.defaultLabel})` : ''}`));
      for (const d of Output.devices) select.appendChild(h('option', { value: d.deviceId }, d.label));
      const s = Store.settings;
      const chosen = s.outputDevice ? Output._chosen() : null;
      if (s.outputDevice && !chosen) select.appendChild(h('option', { value: s.outputDevice }, `${s.outputDeviceLabel || 'Chosen device'} (not there)`));
      select.value = chosen ? chosen.deviceId : s.outputDevice;
    };
    select.addEventListener('change', () => Output.choose(select.value));
    // Redrawn while Settings is open (one listener, set up in init).
    this._outputFill = fill;
    fill();
    return select;
  },

  _cookieBrowser() {
    const select = h('select.select');
    const fill = (list) => {
      clear(select);
      const found = list.filter((b) => b.found);
      const shown = found.length ? found : list;
      const chosen = Store.settings.cookiesBrowser;
      if (chosen && !shown.some((b) => b.id === chosen)) {
        const b = list.find((x) => x.id === chosen);
        if (b) shown.push({ ...b, name: `${b.name} (not found)` });
      }
      for (const b of shown) select.appendChild(h('option', { value: b.id }, b.name));
      if (chosen) select.value = chosen;
      else if (shown.length) Store.saveSettings({ cookiesBrowser: shown[0].id });
    };
    select.addEventListener('change', () => Store.saveSettings({ cookiesBrowser: select.value }));
    window.flow.cookieBrowsers().then(fill, () => {});
    this._refresh.push(() => { select.disabled = !Store.settings.useCookies; });
    return h('div.settings__control', select);
  },

  _mp3Quality() {
    const select = h('select.select');
    for (const kbps of Store.mp3Qualities) select.appendChild(h('option', { value: String(kbps) }, String(kbps)));
    select.value = String(Store.settings.mp3Quality);
    const estimate = h('span.settings__note');
    const draw = () => {
      const mb = (Number(select.value) * 1000 / 8) * Store.averageDuration() / 1e6;
      estimate.textContent = `about ${mb.toFixed(1)} MB per song`;
    };
    select.addEventListener('change', () => {
      Store.saveSettings({ mp3Quality: Number(select.value) });
      draw();
    });
    draw();
    this._refresh.push(() => { select.disabled = !Store.settings.alwaysMp3; });
    return h('div.settings__control', h('span.settings__caption', 'At quality'), select, h('span', 'kbit/s'), estimate);
  },

  // ---- Use a Flow Server ----

  /**
   * The Flow Server rows: on/off with its state, the two addresses (home
   * first, then remote), the password and the profile under it, then Switch
   * server on its own.
   */
  _serverRows() {
    const on = () => Store.settings.serverOn;
    this._serverNode = h('div.settings__desc.server-state');
    // Share (the server in use as a QR code) and, on a phone, Scan in front of it (qrShare.js).
    this._shareNode = h('div.settings__control.share-control');
    const main = this._row({
      key: 'serverOn',
      right: this._shareNode,
      label: 'Use a Flow Server',
      desc: 'Use the library on a Flow Server. Songs can be streamed from it and changes made here go to it. '
        + 'When turned on, your local files get uploaded to the server as well.',
    });
    main.querySelector('.settings__left').appendChild(this._serverNode);
    this._syncBtn = h('button.btn.btn--small', { type: 'button', onclick: () => this._syncNow() }, 'Synchronize now');
    const rows = [
      h('h3.settings__section', 'Flow Server'),
      main,
      this._row({
        key: 'serverHomeOn',
        label: 'Home Server in WiFi/LAN',
        desc: 'Flow connects to your home server or finds the server in your local network itself if UDP discovery is enabled.',
        sub: true,
        when: on,
        right: this._textField({ key: 'serverHome', placeholder: '192.168.0.63:7878', when: on }),
      }),
      this._row({
        key: 'serverRemoteOn',
        label: 'Remote Server',
        desc: 'Fallback if no home server is found or you are away. Enter an IP:Port or a website connected to the server.',
        sub: true,
        when: on,
        right: this._textField({ key: 'serverRemote', placeholder: '100.101.102.103:7878 or flow.example.com', when: on }),
      }),
      this._row({
        label: 'Server Password (if the server is password protected)',
        desc: 'Flow keeps it encrypted on your device.',
        sub: true,
        when: on,
        right: this._secretField(on),
      }),
      this._profileRow(),
      this._switchRow(),
    ];
    return rows;
  },

  // ---- Media Management ----

  /**
   * Where the songs and covers are kept, what goes up to a Flow Server, and
   * how downloads are made. The browser-cookie and SponsorBlock rows only
   * where yt-dlp runs (the phone's Download (Server) still takes its MP3 choice).
   */
  _mediaRows() {
    const server = () => Store.settings.serverOn;
    const here = Store.can('downloadHere');
    const sync = this._row({
      key: 'serverAutoSync',
      label: 'Synchronize local changes',
      desc: 'Songs added to or removed from local files go to the server by themselves. '
        + 'If disabled, only the button will sync local changes.',
      when: server,
      right: this._syncBtn,
    });
    // The button beside the box works whether or not the box is ticked.
    sync.classList.add('settings__row--keep');
    return [
      h('h3.settings__section', 'Media Management'),
      Store.can('musicFolder') ? this._savedSongsRow() : this._storageRow(),
      this._coversRow(),
      this._row({
        key: 'lyricsOn',
        label: 'Fetch/Sync Lyrics',
        desc: 'If enabled, songs get their lyrics looked up, saved and synchronized if connected to a server.',
      }),
      this._lyricsRow(),
      Store.can('backups') ? this._backupsRow() : null,
      this._row({
        key: 'serverMetered',
        label: 'Allow downloads on mobile internet',
        desc: 'If the app detects a metered connection/mobile internet, it will not download marked-to-download songs '
          + 'from the Flow Server if it\'s not allowed. Streaming songs always works.',
        when: server,
        show: () => !!Store.settings.serverRemote && Store.settings.serverRemoteOn !== false,
      }),
      this._row({
        key: 'serverKeepFiles',
        label: 'Keep local files after server upload',
        desc: 'If disabled, your local songs will be removed after they got uploaded to the server, '
          + 'unless you have these songs marked to be downloaded.',
        when: server,
      }),
      sync,
      here ? this._row({
        key: 'useCookies',
        label: 'Use browser session-cookies for downloading',
        desc: 'Downloads may be blocked by age restrictions or sites may only serve content to signed-in users. '
          + 'Pick your browser to use its session cookies so such websites can know you are allowed to find/see '
          + 'what you are looking for.',
        right: this._cookieBrowser(),
      }) : null,
      here ? this._row({
        key: 'shareCookies',
        label: 'Share session cookies with the server',
        desc: 'When enabled the Download (Server) button will pass -only the required- session cookies to the '
          + 'Flow Server for this action.',
        sub: true,
        when: () => Store.settings.useCookies,
        show: server,
      }) : null,
      here ? this._row({
        key: 'sponsorBlock',
        label: 'Use Sponsorblock for Youtube',
        desc: 'Shows sponsored segments as yellow in the trim.',
      }) : null,
      here ? this._row({
        key: 'sponsorBlockIntros',
        label: 'Try to detect intros/outros, marked red in the trim',
        desc: 'A music video\'s non-music parts (talk, skits, credits) count as these too.',
        sub: true,
        when: () => Store.settings.sponsorBlock,
      }) : null,
      // A phone converts nothing itself: the server does, for its uploads and Download (Server).
      this._row({
        key: 'alwaysMp3',
        label: here ? 'Always convert downloads into MP3' : 'Upload songs to the server as MP3',
        desc: here ? 'Otherwise songs are kept in the format they come in.'
          : 'Songs you upload from your phone to the server using local files or using the Download (Server) button '
            + 'get converted into MP3 at the chosen quality by the server if enabled. Songs downloaded to this phone are not changed.',
        right: this._mp3Quality(),
      }),
      this._row({
        key: 'keepMp3',
        label: 'Ignore files that are already in .mp3 format',
        desc: 'Leaves MP3s as they are instead of encoding them again at the quality above.',
        sub: true,
        when: () => Store.settings.alwaysMp3,
      }),
    ];
  },

  // ---- Jam session ----

  /** Active Sessions through the Flow Server: who may see and join what plays here. */
  _jamRows() {
    const on = () => Store.settings.serverOn;
    // Filled in only while there is no server to jam through (empty when the
    // categories are made, so folding it keeps working by its title).
    const note = h('span.settings__section-note');
    this._jamNote = () => {
      note.textContent = on() && Store.server.state === 'online' ? '' : '(requires a Flow server connection)';
    };
    this._refresh.push(this._jamNote);
    return [
      h('h3.settings__section', 'Jam session', note),
      this._row({
        key: 'sessionShare',
        label: 'Share your jam session on the server',
        desc: 'Let other devices connected to the same server see your session and they can request to join your jam.',
        when: on,
      }),
      this._row({
        key: 'sessionAutoAccept',
        label: 'Accept jam join requests automatically',
        desc: 'If enabled, you do not get requests from users who want to join your jam, they can just join. '
          + 'Guests from other Flow Servers are still asked about.',
        sub: true,
        when: () => on() && Store.settings.sessionShare,
      }),
      this._row({
        key: 'sessionAllowVolume',
        label: 'Devices in my Active Session may change my volume',
        desc: 'Devices that joined what you play can pause, skip, start and queue songs. Ticked, they can also turn '
          + 'your volume up and down.',
        when: on,
      }),
      this._outputDelayRow(on),
    ];
  },

  /** Output delay, as in the player's output menu: for the output playing now (only with the Flow Server, for jams). */
  _outputDelayRow(on) {
    const c = Output.delayControl('settings__slider', 'settings__value');
    const which = h('span');
    // Redrawn when the output or its delay changes (one listener, set up in init).
    this._delayFill = () => {
      c.sync();
      const label = Output.builtin ? 'this phone\'s speaker' : Output.label();
      which.textContent = label ? ` Kept for each output; this is ${label}.` : '';
    };
    this._delayFill();
    this._refresh.push(() => { c.slider.disabled = !on() || !Store.settings.outputDelayOn; });
    return this._row({
      key: 'outputDelayOn',
      label: 'Output delay (Sync speakers at Jams)',
      desc: h('span', Output.DELAY_NOTE, which),
      right: h('div.settings__control', c.slider, c.value),
      when: on,
    });
  },

  /** A text box saved when left (or on Enter). */
  _textField({ key, placeholder, when }) {
    const input = h('input.input.settings__input', {
      type: 'text', value: Store.settings[key] || '', placeholder, spellcheck: false, autocomplete: 'off',
    });
    input.addEventListener('change', () => {
      const v = input.value.trim();
      // A shared server's link (qrShare.js) pasted into an address: connected to.
      if (/^flow:\/\/connect/i.test(v)) {
        input.value = Store.settings[key] || '';
        QrShare.connect(v);
        return;
      }
      input.value = v;
      if (v !== (Store.settings[key] || '')) Store.saveSettings({ [key]: v });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    this._refresh.push(() => {
      if (when) input.disabled = !when();
      // Filled in by Flow itself (the Remote address).
      if (document.activeElement !== input) input.value = Store.settings[key] || '';
    });
    return input;
  },

  /**
   * The password: never shown. A saved one is shown as dots, to be replaced or
   * emptied (emptied and left, it is forgotten). Saved (encrypted) when left.
   */
  _secretField(when) {
    const MASK = '••••••';
    const input = h('input.input.settings__input', {
      type: 'password', placeholder: 'Password', autocomplete: 'new-password', spellcheck: false,
    });
    let stored = !!Store.server.hasSecret;
    const draw = () => {
      if (document.activeElement !== input) input.value = stored ? MASK : '';
    };
    input.addEventListener('focus', () => {
      if (input.value === MASK) input.select();
    });
    input.addEventListener('change', () => attempt(async () => {
      if (input.value === MASK) return;
      await window.flow.setServerSecret(input.value);
      stored = !!input.value;
      draw();
    }));
    input.addEventListener('blur', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    draw();
    const sync = () => {
      stored = !!Store.server.hasSecret;
      draw();
    };
    this._syncSecret = sync;
    this._refresh.push(() => {
      input.disabled = !when();
      sync();
    });
    return input;
  },

  _drawServer() {
    if (!this._serverNode) return;
    const st = Store.server;
    const s = Store.settings;
    let text;
    let kind = 'off';
    if (!s.serverOn) text = '';
    else if (s.serverHomeOn === false && s.serverRemoteOn === false) text = 'Both the Home and the Remote Server are unticked. Tick one to connect.';
    else if (st.searching && !s.serverHome && s.serverHomeOn !== false) text = 'Looking for a Flow Server on this network...';
    else if (!(s.serverHomeOn !== false && s.serverHome) && !(s.serverRemoteOn !== false && s.serverRemote)) text = 'No Flow Server found on this network. Enter the home or remote address below.';
    else ({ text, kind } = ServerChip.describe(st));
    const lines = [text, st.on ? st.transfer : '', st.on ? st.note : ''].filter(Boolean);
    clear(this._serverNode);
    this._serverNode.className = `settings__desc server-state server-state--${kind}`;
    for (const line of lines) this._serverNode.appendChild(h('div', line));
    if (this._syncBtn) {
      this._syncBtn.disabled = st.state !== 'online' || !!st.syncing;
      this._syncBtn.textContent = st.syncing ? 'Synchronizing...' : 'Synchronize now';
    }
    if (this._syncSecret) this._syncSecret();
    this._drawProfile();
    this._drawSwitch();
    this._drawShare();
  },

  _drawShare() {
    if (!this._shareNode) return;
    const online = Store.server.on && Store.server.state === 'online';
    clear(this._shareNode).append(...[
      Store.can('scanQr') ? h('button.btn.btn--small', { type: 'button', title: 'Connect to a Flow Server by its QR code', onclick: () => QrShare.scan() }, 'Scan') : null,
      online ? h('button.btn.btn--small', { type: 'button', title: 'Show this server as a QR code for another app', onclick: () => QrShare.open() }, 'Share') : null,
    ].filter(Boolean));
  },

  // ---- Switch server ----

  /**
   * "Switch server": a dropdown of the servers used on this device, the one
   * in use picked. Picking another only shows where it was reached and as
   * whom; Switch then connects to it (with that address, its password and its
   * profile), and ✕ forgets it. The pencil names the picked one on this
   * device: Switch becomes the box for it and the pencil a tick. Its own row,
   * usable with Use a Flow Server unticked: Switch ticks it (for the one last
   * in use too).
   */
  _switchRow() {
    this._switch = { picked: '', busy: '', key: '', editing: '' };
    this._switchNode = h('div.settings__control.switch-control');
    const row = this._row({
      label: 'Switch server',
      desc: 'Servers used on this device. Each keeps its downloads, waiting changes, profile and password for when you come back. '
        + 'Pick one and press Switch.',
      show: () => this._knownServers().length > 0,
      right: this._switchNode,
    });
    this._switchRowEl = row;
    return row;
  },

  _knownServers() {
    return Store.server.servers || [];
  },

  /** Drawn afresh only when the list, the pick or a switch under way changed. */
  _drawSwitch(force = false) {
    const node = this._switchNode;
    if (!node) return;
    const list = this._knownServers();
    if (this._switchRowEl) this._switchRowEl.hidden = !list.length;
    const p = this._switch;
    const current = list.find((x) => x.current);
    // Back to the one in use once the picked one is gone or became it.
    if (!list.some((x) => x.id === p.picked) || (current && current.id === p.picked)) p.picked = current ? current.id : '';
    // A name being typed is not lost to a status update.
    if (p.editing && !force) return;
    const names = Store.settings.serverNames || {};
    const key = JSON.stringify([list, p.picked, p.busy, Store.settings.serverOn, names]);
    if (!force && key === p.key) return;
    p.key = key;
    clear(node);
    if (!list.length) return;
    const off = !Store.settings.serverOn;
    const picked = list.find((x) => x.id === p.picked) || list[0];
    const other = !picked.current;
    const named = (x) => Util.serverName(names, x.id, x.name);
    const select = h('select.select.switch-select', { disabled: !!p.busy || !!p.editing },
      ...list.map((x) => h('option', { value: x.id }, x.current ? `${named(x).label} - in use` : named(x).label)));
    select.value = picked.id;
    select.addEventListener('change', () => {
      p.picked = select.value;
      this._drawSwitch(true);
    });
    const forget = iconButton('act.act--grey', Icons.x, `Forget "${named(picked).name}"`, () => this._forgetServer(picked));
    forget.disabled = !!p.busy || !other || !!p.editing;
    let edit;
    let action;
    if (p.editing) {
      const done = (text) => {
        p.editing = '';
        if (text !== null) this._renameServer(picked.id, picked.name, text);
        this._drawSwitch(true);
      };
      ({ input: action, tick: edit } = this._nameBox(named(picked), done, 'switch-name'));
    } else {
      edit = iconButton('act.act--grey', Icons.pencil, `Rename "${named(picked).name}" on ${Store.here}`, () => {
        p.editing = picked.id;
        this._drawSwitch(true);
      });
      edit.disabled = !!p.busy;
      action = h('button.btn.btn--small', {
        type: 'button', disabled: !!p.busy || !(other || off), onclick: () => this._switchTo(picked),
      }, p.busy ? 'Connecting...' : 'Switch');
    }
    node.append(
      h('span.settings__note.switch-where', [picked.address, picked.profile ? `as ${picked.profile}` : ''].filter(Boolean).join(' · ')),
      select,
      edit,
      action,
      forget,
    );
  },

  /**
   * The box a Flow Server is named in (Switch server, Statistics) and its
   * tick: Enter, the tick or leaving the box keeps the name, Escape keeps
   * the old one. done(text), or done(null) for Escape; once.
   */
  _nameBox(name, done, cls) {
    const input = h(`input.input.server-name.${cls}`, {
      type: 'text', maxLength: 80, spellcheck: false, value: name.name, placeholder: name.original, 'aria-label': `Name for "${name.original}"`,
      // Escape is the box's (Keys leaves Settings open).
      dataset: { ownEscape: '' },
    });
    let over = false;
    const finish = (text) => {
      if (over) return;
      over = true;
      done(text);
    };
    input.addEventListener('keydown', (e) => {
      // Only the box's: a row it sits in does not react to them.
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('blur', () => finish(input.value));
    const tick = iconButton('act.act--green', Icons.check, 'Keep the name', (e) => {
      e.stopPropagation();
      finish(input.value);
    });
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return { input, tick };
  },

  /**
   * Names a Flow Server on this device (empty, or its own name: its own
   * again). Switch server and Statistics both show it.
   */
  _renameServer(id, own, text) {
    const names = { ...(Store.settings.serverNames || {}) };
    const name = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name || name === own) delete names[id];
    else names[id] = name;
    Store.saveSettings({ serverNames: names });
    // A box open in the other place stays as it is (drawn when it is done).
    if (!this._switch || !this._switch.editing) this._drawSwitch(true);
    Stats.draw();
  },

  async _switchTo(s) {
    // The one last in use, Use a Flow Server unticked: ticking it is all.
    if (s.current) {
      Store.saveSettings({ serverOn: true });
      this._refreshAll();
      return;
    }
    this._switch.busy = s.id;
    this._drawSwitch();
    const ok = await attempt(async () => {
      await window.flow.switchServer(s.id);
      return true;
    });
    this._switch.busy = '';
    // Not switched: the one in use is picked again.
    if (!ok) this._switch.picked = '';
    this._drawSwitch();
    if (ok) toast(`Switching to "${Util.serverName(Store.settings.serverNames, s.id, s.name).name}"`, 'success');
  },

  async _forgetServer(s) {
    const ok = await confirmDialog({
      title: 'Forget server',
      message: `Forget "${Util.serverName(Store.settings.serverNames, s.id, s.name).name}" on ${Store.here}? It is no longer offered here, and what was waiting to go to it is dropped. `
        + 'Songs downloaded from it stay (under Downloaded Songs); the server and your profile on it are not touched.',
      confirmLabel: 'Forget',
      danger: true,
    });
    if (!ok) return;
    await attempt(() => window.flow.forgetServer(s.id));
  },

  // ---- Profiles ----

  /**
   * "Profile": signed in to one of the server's profiles, or to none. Not
   * signed in: the server's profiles and "+ New" (which opens the Create new
   * Profile window; not there while only admins make profiles), a PIN, and
   * Login. Signed in: who, Logout, and ⋯, whose tray holds Edit Name, Change
   * PIN and Delete Profile; the first two ask in a window, with the current PIN.
   */
  _profileRow() {
    this._prof = { picked: '', busy: false, key: '' };
    this._profileNode = h('div.settings__control.profile-control');
    return this._row({
      label: 'Profile',
      desc: 'Each profile has its own playlists, favourites and stats. Uploaded songs are shared.',
      sub: true,
      when: () => Store.settings.serverOn,
      right: this._profileNode,
    });
  },

  /** Drawn afresh only when something it shows changed: typing is not lost to a status update. */
  _drawProfile(force = false) {
    const node = this._profileNode;
    if (!node) return;
    const st = Store.server;
    const p = this._prof;
    const ready = !!(st.on && st.state === 'online' && st.profilesSupported && Array.isArray(st.profiles));
    // "Only admins make profiles": no "+ New" while not signed in to an admin.
    const mayCreate = !(st.rules && st.rules.createProfiles === false);
    const key = JSON.stringify([ready, st.on, st.state, st.profilesSupported, st.profile, st.profiles, mayCreate, p.picked, p.busy]);
    if (!force && key === p.key) return;
    p.key = key;
    // The ⋯ tray belongs to the row about to be drawn anew.
    if (SongActions.anchor && node.contains(SongActions.anchor)) SongActions.close();
    clear(node);
    if (!ready) {
      let text = '';
      if (st.profile) text = `Logged in as ${st.profile.name}`;
      else if (st.on && st.state === 'online' && !st.profilesSupported) text = 'Update the Flow Server to use profiles.';
      else if (st.on) text = 'Available while connected to the server.';
      node.append(h('span.settings__note', text));
      // Logout works away from the server too (it is told at the next connection).
      if (st.on && st.profile) node.append(this._logoutButton(st.profile));
      return;
    }
    if (st.profile) this._drawSignedIn(node, st.profile);
    else this._drawSignIn(node, st.profiles, mayCreate);
  },

  _drawSignedIn(node, profile) {
    const p = this._prof;
    const btn = (label, onclick, extra = '') => h('button.btn.btn--small' + extra, { type: 'button', disabled: p.busy, onclick }, label);
    // Square, as in a song's More menu, and like it slides its tray out to the
    // left over the row (closed by any of its buttons, or a click elsewhere).
    const more = iconButton('act.act--grey', Icons.more, 'More', () => {
      if (SongActions.anchor === more) {
        SongActions.close();
        return;
      }
      SongActions.open(more, [
        btn('Edit Name', () => this._editProfileName(profile)),
        btn('Change PIN', () => this._changeProfilePin(profile)),
        btn('Delete Profile', () => this._deleteProfile(profile), '.btn--danger'),
      ], 'act-tray--settings');
    });
    more.disabled = p.busy;
    node.append(
      h('span.profile-who', 'Logged in as ', h('strong', profile.name)),
      this._logoutButton(profile),
      more,
    );
  },

  _logoutButton(profile) {
    return h('button.btn.btn--small', {
      type: 'button',
      disabled: this._prof.busy,
      onclick: () => this._profileDo(async () => {
        await window.flow.profileLogout();
        toast(`Logged out of "${profile.name}"`, 'info');
      }),
    }, 'Logout');
  },

  /** The current PIN box: none to type while the profile has none. */
  _currentPinField(profile) {
    return {
      key: 'pin', label: 'Current PIN', type: 'password', disabled: !profile.pin, placeholder: profile.pin ? '' : 'No PIN set',
    };
  },

  _editProfileName(profile) {
    return formDialog({
      title: 'Change Profile Name',
      confirmLabel: 'Submit',
      fields: [
        this._currentPinField(profile),
        { key: 'name', label: 'New Name', value: profile.name, maxLength: 40 },
      ],
      submit: async ({ pin, name }) => {
        const renamed = await window.flow.profileRename(name, pin);
        toast(`Profile renamed to "${renamed.name}"`, 'success');
      },
    });
  },

  _changeProfilePin(profile) {
    // An admin keeps a PIN (only a profile with one is an admin); the master's has 4 characters.
    let hint = 'Leave empty for none';
    if (profile.master) hint = 'At least 4 characters';
    else if (profile.admin) hint = 'An admin needs one';
    return formDialog({
      title: 'Change PIN',
      confirmLabel: 'Submit',
      fields: [
        this._currentPinField(profile),
        { key: 'newPin', label: 'New PIN', type: 'password', placeholder: hint },
        { key: 'confirm', label: 'Confirm new PIN', type: 'password' },
      ],
      submit: async ({ pin, newPin, confirm }) => {
        if (newPin !== confirm) throw new Error('The two PINs are not the same.');
        if (!newPin && profile.admin) throw new Error('An admin profile needs a PIN.');
        if (!newPin && !profile.pin) throw new Error('Enter a PIN.');
        const now = await window.flow.profilePin(pin, newPin);
        toast(now.pin ? 'Your PIN was changed' : 'Your profile has no PIN now', 'success');
      },
    });
  },

  _newProfileDialog() {
    // The server's first profile becomes its admin, so it needs a PIN.
    const first = !(Store.server.profiles || []).length;
    return formDialog({
      title: 'Create new Profile',
      confirmLabel: 'Create',
      fields: [
        { key: 'name', label: 'Profile Name', maxLength: 40 },
        { key: 'pin', label: 'Your PIN', type: 'password', placeholder: first ? 'Needed: the first profile becomes the admin' : 'Optional' },
        { key: 'confirm', label: 'Confirm PIN', type: 'password' },
      ],
      submit: async ({ name, pin, confirm }) => {
        if (pin !== confirm) throw new Error('The two PINs are not the same.');
        if (first && !pin) throw new Error('The first profile becomes this server\'s admin, so it needs a PIN.');
        const made = await window.flow.profileCreate(name, pin);
        toast(`Profile "${made.name}" made. Logged in as ${made.name}.`, 'success');
      },
    });
  },

  _drawSignIn(node, profiles, mayCreate) {
    const p = this._prof;
    if (p.picked && !profiles.some((x) => x.id === p.picked)) p.picked = '';
    const picked = profiles.find((x) => x.id === p.picked) || null;
    const select = h('select.select.profile-select', { disabled: p.busy },
      h('option', { value: '' }, 'Default / Shared'),
      ...profiles.map((x) => h('option', { value: x.id }, x.name)),
      mayCreate ? h('option', { value: '+new' }, '+ New') : null);
    select.value = p.picked;
    select.addEventListener('change', () => {
      if (select.value === '+new') {
        // Back to what was picked; the new one is asked for in a window.
        select.value = p.picked;
        this._newProfileDialog();
        return;
      }
      p.picked = select.value;
      this._drawProfile(true);
    });
    const pin = h('input.input.settings__input.profile-pin', {
      type: 'password',
      placeholder: picked && !picked.pin ? 'No PIN' : 'PIN',
      autocomplete: 'new-password',
      spellcheck: false,
      disabled: p.busy || !(picked && picked.pin),
    });
    const go = () => {
      if (!picked) return undefined;
      return this._profileDo(async () => {
        const now = await window.flow.profileLogin(picked.id, pin.value);
        toast(`Logged in as ${now.name}`, 'success');
      });
    };
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    node.append(select, pin,
      h('button.btn.btn--small', { type: 'button', disabled: p.busy || !picked, onclick: go }, 'Login'));
    if (picked && picked.pin) requestAnimationFrame(() => pin.focus());
  },

  /** One profile action: the row waits for it, and says what went wrong. */
  async _profileDo(fn) {
    const p = this._prof;
    if (p.busy) return;
    p.busy = true;
    this._drawProfile(true);
    try {
      await attempt(fn);
    } finally {
      p.busy = false;
      this._drawProfile(true);
    }
  },

  async _deleteProfile(profile) {
    const answer = await confirmDialog({
      title: 'Delete Profile',
      message: `Delete the profile "${profile.name}"? All its playlists, favourites and listening stats will be gone, `
        + 'on every device. The songs stay for everyone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!answer) return;
    await this._profileDo(async () => {
      await window.flow.profileDelete();
      toast(`Profile "${profile.name}" deleted`, 'info');
    });
  },

  _syncNow() {
    return attempt(async () => {
      const r = await window.flow.syncNow();
      toast(r.sent ? `Synchronized: ${Util.plural(r.sent, 'change')} from Local Files sent` : 'Synchronized', 'success');
    });
  },

  // ---- Local Files ----

  _savedSongsRow() {
    this._statsNode = h('span.settings__note', '...');
    this._pathNode = h('div.settings__desc.settings__path');
    const open = h('button.btn.btn--small', { type: 'button', onclick: () => this._openFolder() }, 'Open');
    const change = h('button.btn.btn--small', { type: 'button', onclick: () => this._changeFolder(change) }, 'Change');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Local Files'),
      this._pathNode);
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', this._statsNode, open, change)));
  },

  async _drawStats() {
    // No Local Files row where the folder is not the user's to see (the phone).
    if (!Store.can('musicFolder')) return;
    this._pathNode.textContent = `Location: ${Store.musicDir}`;
    this._pathNode.title = Store.musicDir;
    try {
      const st = await window.flow.folderStats();
      Store.musicDir = st.dir;
      this._pathNode.textContent = `Location: ${st.dir}`;
      this._pathNode.title = st.dir;
      this._statsNode.textContent = `${Util.plural(st.count, 'song')} · ${fmtBytes(st.bytes)}`;
    } catch {
      this._statsNode.textContent = '';
    }
  },

  /**
   * Covers: how many this computer keeps and the room they take (with a
   * server: the servers' covers kept here, which can be cleared).
   */
  _coversRow() {
    this._coversNode = h('span.settings__note');
    this._clearCovers = h('button.btn.btn--small', {
      type: 'button',
      title: 'Delete the covers downloaded from Flow Servers. Those of this server come down again.',
      onclick: () => attempt(async () => {
        await window.flow.clearCoverCache();
        toast('Cover cache cleared: the covers come down again', 'success');
        this._drawCovers();
      }),
    }, 'Clear cover cache');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Cover Cache'),
      h('div.settings__desc', 'Covers are found by the client or server, synchronized automatically.'));
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', this._coversNode, this._clearCovers)));
  },

  /**
   * Lyrics (4.0.1): how many the Lyrics folder keeps and the room they take,
   * under Fetch/Sync Lyrics. Clearing leaves those written in Flow for Local
   * Files songs; a server's come down again.
   */
  _lyricsRow() {
    this._lyricsNode = h('span.settings__note');
    const clearBtn = h('button.btn.btn--small', {
      type: 'button',
      title: 'Delete the lyrics kept here, except those written in Flow for Local Files songs. Those of a server come down again.',
      onclick: () => attempt(async () => {
        await window.flow.clearLyricsCache();
        toast('Lyrics cache cleared', 'success');
        Lyrics.forgetAll();
        this._drawLyrics();
      }),
    }, 'Clear lyrics cache');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Lyrics Cache'),
      h('div.settings__desc', 'Lyrics are found by the client or server, or manually added using Flow. '
        + 'Synchronized automatically if "Fetch/Sync Lyrics" is enabled.'));
    const row = h('div.settings__row.settings__row--sub', left, h('div.settings__right', h('div.settings__control', this._lyricsNode, clearBtn)));
    // Greyed out under Fetch/Sync Lyrics unticked, Clear lyrics cache still there to click.
    this._refresh.push(() => row.classList.toggle('settings__row--dim', Store.settings.lyricsOn === false));
    return row;
  },

  async _drawLyrics() {
    if (!this._lyricsNode) return;
    try {
      const st = await window.flow.lyricsStats();
      if (!this._lyricsNode) return;
      // How many, the room they take, and while every song's are looked up, how many still are.
      this._lyricsNode.textContent = `${st.count} lyrics · ${fmtBytes(st.bytes)}${st.left ? ` · looking up ${st.left} more` : ''}`;
      this._lyricsNode.title = st.none ? `No lyrics found for ${Util.plural(st.none, 'song')}` : '';
    } catch {
      this._lyricsNode.textContent = '';
    }
  },

  /**
   * Backups of this computer's library (4.0): made once a week, the last 6
   * kept; one picked is put back. A Flow Server backs up its own library
   * (Administration).
   */
  _backupsRow() {
    const pick = h('select.select');
    const restore = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => attempt(async () => {
        const b = this._backupList.find((x) => x.name === pick.value);
        if (!b) return;
        const ok = await confirmDialog({
          title: 'Restore backup',
          message: `Put Local Files back as they were on ${Util.fmtDate(b.createdAt)}? Song names, playlists, favourites and stats `
            + 'go back to how they were then; songs added since stay, songs whose files are gone stay out. What is there now is backed up first.',
          confirmLabel: 'Restore',
          kind: 'light-red',
        });
        if (!ok) return;
        const r = await window.flow.restoreBackup(b.name);
        toast(`Backup restored: ${Util.plural(r.songs, 'song')}${r.missing ? `, ${r.missing} without their files left out` : ''}`, 'success');
        this._drawBackups();
      }),
    }, 'Restore');
    const make = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => attempt(async () => {
        await window.flow.makeBackup();
        toast('Backup made', 'success');
        this._drawBackups();
      }),
    }, 'Back up now');
    this._backupList = [];
    this._backupPick = pick;
    this._backupRestore = restore;
    this._drawBackups();
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Backups'),
      h('div.settings__desc', 'The song names, playlists, favourites and stats of Local Files are backed up every week, '
        + 'the last 6 kept. Never the song files themselves.'));
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', pick, restore, make)));
  },

  async _drawBackups() {
    const list = await window.flow.backups().catch(() => []);
    const why = { weekly: '', manual: ' (by hand)', restore: ' (before a restore)' };
    this._backupList = list;
    clear(this._backupPick).append(...(list.length
      ? list.map((b) => h('option', { value: b.name }, `${Util.fmtDate(b.createdAt)}${why[b.reason] || ''}`))
      : [h('option', { value: '' }, 'No backups yet')]));
    this._backupPick.disabled = !list.length;
    this._backupRestore.disabled = !list.length;
  },

  /** The phone's songs and their room; Remove downloads deletes the server's songs kept here. */
  _storageRow() {
    this._storageNode = h('span.settings__note');
    this._removeDownloads = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => this._removeAllDownloads(),
    }, 'Remove downloads');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Song Storage'),
      h('div.settings__desc', 'The songs kept on this phone, and how much room they take. Remove downloads deletes '
        + 'the Flow Server\'s songs kept here and unmarks every playlist\'s Download; they still play from the server.'));
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', this._storageNode, this._removeDownloads)));
  },

  async _drawStorage() {
    if (!this._storageNode || !window.flow.storageStats) return;
    try {
      const st = await window.flow.storageStats();
      if (!this._storageNode) return;
      const parts = [`${Util.plural(st.songs, 'song')} · ${fmtBytes(st.bytes)}`];
      if (st.downloaded && st.downloaded < st.songs) parts.push(`${st.downloaded} downloaded`);
      this._storageNode.textContent = parts.join(', ');
      this._removeDownloads.hidden = !Store.server.on || !(st.downloaded || (Store.server.offline || []).length);
    } catch {
      this._storageNode.textContent = '';
    }
  },

  async _removeAllDownloads() {
    const ok = await confirmDialog({
      title: 'Remove downloads?',
      message: 'The Flow Server\'s songs kept on this phone are deleted here, and no playlist is downloaded any more. '
        + 'They stay on the server and play from there while it can be reached.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await attempt(async () => {
      const r = await window.flow.removeAllDownloads();
      toast(r.inUse ? `Removed ${Util.plural(r.removed, 'song')}; ${r.inUse} playing now ${r.inUse === 1 ? 'goes' : 'go'} later`
        : `Removed ${Util.plural(r.removed, 'song')} from this phone`, 'success');
    });
    this._drawStorage();
  },

  async _drawCovers() {
    if (!this._coversNode) return;
    this._clearCovers.hidden = !Store.server.on;
    try {
      const st = await window.flow.coverStats();
      const here = Store.server.on ? st.server : st.local;
      if (!here || !this._coversNode) return;
      this._coversNode.textContent = `${Util.plural(here.count, 'cover')} · ${fmtBytes(here.bytes)}`;
    } catch {
      this._coversNode.textContent = '';
    }
  },

  _drawMeasured() {
    if (!this._measuredNode) return;
    const songs = Store.library.songs;
    const done = songs.filter((s) => s.loudness !== null && s.loudness !== undefined).length;
    this._measuredNode.textContent = !songs.length ? ''
      : done >= songs.length ? (songs.length === 1 ? 'The song is measured' : `All ${songs.length} songs measured`)
        // With a server, songs only streamed are measured by the server (with ffmpeg).
        : `${done} of ${songs.length} songs measured${Store.settings.normalize && !Store.server.on && Store.can('measureLoudness') ? '...' : ''}`;
  },

  _openFolder() {
    return attempt(async () => {
      // Resolves to an error message, or '' once Explorer has it.
      const problem = await window.flow.openMusicFolder();
      if (problem) toast(`Could not open ${Store.musicDir}: ${problem}`, 'error');
    });
  },

  /**
   * Change: pick a folder, confirm, then move every song file there. The song
   * playing is let go of for the move and picked up again after.
   */
  async _changeFolder(button) {
    let dir;
    try {
      dir = await window.flow.chooseFolder();
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!dir) return;
    const count = Store.library.songs.length;
    const ok = await confirmDialog({
      title: 'Move your songs?',
      message: `Flow will save songs in ${dir} from now on, and move ${count === 1 ? 'the song' : `all ${count} songs`} `
        + `(with their subfolders) there from ${Store.musicDir}. Playlists and statistics stay as they are.`,
      confirmLabel: 'Move songs',
    });
    if (!ok) return;

    button.disabled = true;
    const token = Player.currentId ? Player.release(Player.currentId) : null;
    this._onProgress = ({ done, total }) => {
      if (this._statsNode) this._statsNode.textContent = total ? `Moving ${done} of ${total}...` : 'Moving...';
    };
    try {
      const result = await window.flow.moveMusicFolder(dir);
      Store.musicDir = result.dir;
      Store.settings.musicDir = result.dir;
      if (result.failed.length) {
        toast(`${Util.plural(result.moved, 'song')} moved. ${result.failed.length} could not be moved `
          + `(${result.failed[0].reason}) and stay where they were.`, 'error');
      } else {
        toast(`${Util.plural(result.moved, 'song')} moved to ${result.dir}`, 'success');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      this._onProgress = null;
      button.disabled = false;
      if (token) Player.resume(token);
      if (this.modal) this._drawStats();
    }
  },
};
