'use strict';

// The Settings window, opened with the cog at the bottom of the menu. Every row
// is a setting on the left (a tick box, its name and what it does) and its
// value on the right. Rows under another one ("=>" in the design) only count
// while the one above is ticked, and are greyed out otherwise.
//
// Changes take effect at once: sliders follow along while dragged
// (Store.previewSettings) and are saved when let go.

const EQ_SCHEMES = [
  ['spectrum', T('common.spectrum')],
  ['rainbow', T('common.color.rainbow')],
  ['greyscale', T('common.color.greyscale')],
  ['white', T('common.color.white')],
  ['red', T('common.color.red')],
  ['green', T('common.color.green')],
  ['yellow', T('settings.appVisuals.colorScheme.yellow')],
  ['blue', T('common.color.blue')],
  ['purple', T('common.color.purple')],
  ['black', T('common.color.black')],
];

// The clouds: each its own colour, or all one (the equalizer's solid ones).
const CLOUD_SCHEMES = [
  ['rainbow', T('common.color.rainbow')],
  ...EQ_SCHEMES.filter(([v]) => !['spectrum', 'rainbow', 'greyscale'].includes(v)),
];

function fmtBytes(bytes) {
  if (bytes >= 1e9) return T('common.size.gigabytes', { size: I18n.num(bytes / 1e9, 1) });
  if (bytes >= 1e6) return T('common.size.megabytes', { size: Math.round(bytes / 1e6) });
  return T('common.size.kilobytes', { size: Math.max(0, Math.round(bytes / 1e3)) });
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
    // Not what the player keeps for itself (where the song is, every 5 seconds
    // while one plays; the page last open): none of it shows here.
    const own = ['lastSongId', 'lastContextId', 'lastPosition', 'listenSession', 'lastPlaylistId'];
    Store.onSettings((patch) => {
      if (this.modal && !Object.keys(patch || {}).every((k) => own.includes(k))) this._refreshAll();
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
    // Lyrics kept, or the background lookups moved on (4.0).
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
      h('h3.settings__section', T('settings.general.heading')),
      // Only where the app keeps the choice itself (the desktop app) for now.
      typeof window.flow.language === 'string' ? this._row({
        label: T('settings.general.language.label'),
        desc: T('settings.general.language.desc'),
        right: this._languageSelect(),
      }) : null,
      Store.can('outputDevices') ? this._row({
        label: T('common.outputDevice'),
        desc: T('settings.general.output.desc'),
        right: this._outputSelect(),
      }) : null,
      Store.can('systemOutput') ? this._row({
        label: T('common.outputDevice'),
        desc: T('settings.general.systemOutput.desc'),
        right: this._systemOutput(),
      }) : null,
      Store.can('songTransition') ? this._row({
        key: 'crossfade',
        label: T('settings.general.songTransition.label'),
        desc: T('settings.general.songTransition.desc'),
        right: this._slider({ key: 'crossfadeSeconds', name: T('settings.general.songTransition.slider.name'), min: 0.1, max: 10, step: 0.1, format: (v) => `${I18n.num(v, 1)} s`, when: () => Store.settings.crossfade }),
      }) : null,
      this._row({
        key: 'normalize',
        label: T('settings.general.equalizeVolume.label'),
        desc: T('settings.general.equalizeVolume.desc'),
        right: this._measuredNode = h('span.settings__note'),
      }),
      this._row({
        key: 'showTrend',
        label: T('settings.general.listeningTrends.label'),
        desc: T('settings.general.listeningTrends.desc'),
      }),
      this._row({
        key: 'autoDj',
        label: T('settings.general.similarSongs.label'),
        desc: T('settings.general.similarSongs.desc'),
      }),
      // Also under the Playlist Groups head on the Playlists page (4.5.3).
      Store.canGroup() ? this._row({
        key: 'groupedHideInMenu',
        label: T('settings.general.groupedHideInMenu.label'),
        desc: T('settings.general.groupedHideInMenu.desc'),
      }) : null,
      // The phone's lists have no columns.
      Store.phone ? null : this._row({
        label: T('settings.general.songColumns.label'),
        desc: T('settings.general.songColumns.desc'),
        right: this._columnTicks(),
      }),
      // Every key Flow has, in a window (4.5.5); a phone has no keyboard.
      Store.phone ? null : this._row({
        label: T('settings.general.keybinds.label'),
        desc: T('settings.general.keybinds.desc'),
        right: h('button.btn.btn--small.keybinds-btn', { type: 'button', onclick: () => Keys.showList() }, T('settings.general.keybinds.show')),
      }),

      ...(Store.can('soundEq') ? this._soundEqRows() : []),

      ...this._serverRows(),

      ...this._jamRows(),

      ...this._mediaRows(),

      // The clouds everywhere; what listens to the music (their bass, the
      // equalizer, the visualizers) only where the page hears it (effects).
      h('h3.settings__section', T('settings.appVisuals.heading')),
      Store.phone ? h('div.settings__desc.settings__intro', T('settings.appVisuals.batteryNote')) : null,
      this._row({
        key: 'cloudsOn',
        label: T('settings.appVisuals.clouds.label'),
        desc: T('settings.appVisuals.clouds.desc'),
        right: this._slider({ key: 'cloudsIntensity', label: T('settings.appVisuals.clouds.intensity.label'), when: () => Store.settings.cloudsOn }),
      }),
      Store.can('effects') ? this._row({
        key: 'cloudsBass',
        label: T('settings.appVisuals.clouds.reactToBass.label'),
        desc: T('settings.appVisuals.clouds.reactToBass.desc'),
        sub: true,
        when: () => Store.settings.cloudsOn,
        right: this._slider({ key: 'cloudsBassAmount', label: T('settings.appVisuals.clouds.reactToBass.strength.label'), when: () => Store.settings.cloudsOn && Store.settings.cloudsBass }),
      }) : null,
      this._row({
        label: T('settings.appVisuals.clouds.colorScheme.label'),
        desc: T('settings.appVisuals.clouds.colorScheme.desc'),
        sub: true,
        when: () => Store.settings.cloudsOn,
        right: this._select({ key: 'cloudsColors', options: CLOUD_SCHEMES, when: () => Store.settings.cloudsOn }),
      }),
      this._row({
        label: T('settings.appVisuals.clouds.amount.label'),
        desc: T('settings.appVisuals.clouds.amount.desc'),
        sub: true,
        when: () => Store.settings.cloudsOn,
        right: this._slider({ key: 'cloudsAmount', label: T('settings.appVisuals.clouds.amount.slider.label'), min: 0, max: 100, step: 10, when: () => Store.settings.cloudsOn }),
      }),

      ...(Store.can('effects') ? [
      this._row({
        key: 'eqOn',
        label: T('settings.appVisuals.equalizer.label'),
        desc: T('settings.appVisuals.equalizer.desc'),
        right: this._slider({ key: 'eqHeight', label: T('common.height'), when: () => Store.settings.eqOn }),
      }),
      this._row({
        label: T('settings.appVisuals.equalizer.visibility.label'),
        desc: T('settings.appVisuals.equalizer.visibility.desc'),
        sub: true,
        when: () => Store.settings.eqOn,
        right: this._slider({ key: 'eqVisibility', label: T('settings.appVisuals.equalizer.visibility.alpha.label'), when: () => Store.settings.eqOn }),
      }),
      this._row({
        key: 'eqShine',
        label: T('settings.appVisuals.equalizer.outerShine.label'),
        desc: T('settings.appVisuals.equalizer.outerShine.desc'),
        sub: true,
        when: () => Store.settings.eqOn,
        right: this._slider({ key: 'eqShineSpread', label: T('settings.appVisuals.equalizer.outerShine.spread.label'), when: () => Store.settings.eqOn && Store.settings.eqShine }),
      }),
      this._row({
        label: T('settings.appVisuals.equalizer.colorScheme.label'),
        desc: T('settings.appVisuals.equalizer.colorScheme.desc'),
        sub: true,
        when: () => Store.settings.eqOn,
        right: this._select({ key: 'eqColors', options: EQ_SCHEMES, when: () => Store.settings.eqOn }),
      }),
      ] : []),

      // The song's big cover behind the clouds (ambient.js); not the Mini
      // Player's own Cover as background. A computer's window only.
      Store.phone ? null : this._row({
        key: 'coverBgOn',
        label: T('settings.appVisuals.coverBg.label'),
        desc: T('settings.appVisuals.coverBg.desc'),
        right: this._slider({ key: 'coverBgVisibility', label: T('settings.appVisuals.coverBg.visibility.label'), min: 0, when: () => Store.settings.coverBgOn }),
      }),

      ...(Store.can('effects') ? [
      h('h3.settings__section', T('settings.visualizer.heading')),
      this._visualizerRow([
        ...this._frameRateRows(),
        this._row({
          key: 'vizLyrics',
          label: T('settings.visualizer.showLyrics.label'),
          desc: T('settings.visualizer.showLyrics.desc'),
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
      title: T('common.settings'),
      className: 'modal--settings',
      drawer: mobile,
      body: [body],
      buttons: mobile ? [] : [{ label: T('common.close'), kind: 'primary' }],
      onClose: () => {
        this.modal = null;
        this._refresh = [];
        // The profile's ⋯ tray, should Escape have closed Settings under it.
        if (SongActions.tray && SongActions.tray.classList.contains('act-tray--settings')) SongActions.close();
      },
    });
    if (mobile) {
      const modal = this.modal;
      this._backBtn = iconButton('modal__back', Icons.chevronLeft, T('common.back'), () => this.back());
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
    if (this._shows(T('common.statistics'))) Stats.loadServer();
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
      Object.assign(node, { tabIndex: 0, title: T('settings.window.category.toggle.tooltip') });
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
        if (!shut.has(title)) this._opened(title);
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
    if (head) head.textContent = title || T('common.settings');
    if (this._backBtn) this._backBtn.hidden = !title;
    const body = this.modal && this.modal.el.querySelector('.modal__body');
    if (body) body.scrollTop = 0;
    if (title) this._opened(title);
  },

  /**
   * Whether a category shows: on the phone its screen is open, elsewhere it is
   * not folded shut. Statistics and Administration fetch from the server only
   * while they show (4.3).
   */
  _shows(title) {
    if (document.body.classList.contains('mobile')) return this._screen === title;
    return !(Store.settings.settingsCollapsed || []).includes(title);
  },

  /** A category came into view: what it shows from the server is fetched now. */
  _opened(title) {
    if (title === T('common.statistics')) Stats.loadServer();
    if (title === T('admin.heading') && Store.server.admin) Admin.load();
  },

  /**
   * Administration is there only while an admin profile is logged in: shown
   * or hidden as that changes, and fetched when it shows (or `force`).
   */
  _drawAdmin(force = false) {
    const on = !!Store.server.admin;
    const was = this._adminOn;
    this._adminOn = on;
    const title = T('admin.heading');
    if (document.body.classList.contains('mobile')) {
      const btn = [...this._screenList.querySelectorAll('.settings__category')].find((x) => x.textContent === title);
      if (btn) btn.hidden = !on;
      if (!on && this._screen === title) this._openScreen(null);
    } else {
      const head = [...this.modal.el.querySelectorAll('.settings__section')].find((n) => n.textContent.trim() === title);
      const group = head && head.closest('.settings__group');
      if (group) group.hidden = !on;
    }
    if (on && (force || !was) && this._shows(title)) Admin.load();
  },

  /** The phone's Back while Settings is open: from a category to the list. False on the list. */
  back() {
    if (!this.modal || !this._screen) return false;
    this._openScreen(null);
    return true;
  },

  /** The Android app's own: its version, and help for playing on with the screen off. */
  _appRows() {
    return [
      h('h3.settings__section', T('settings.app.heading')),
      this._row({ label: T('settings.app.version.label'), desc: `Flow ${Store.version || ''}`.trim() }),
      Store.can('batteryHelp') ? this._row({
        label: T('settings.app.screenOff.label'),
        desc: T('settings.app.screenOff.desc'),
        right: h('button.btn.btn--small', { type: 'button', onclick: () => BackgroundHelp.open() }, T('common.show')),
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
      tick('colAlbum', T('common.album')), tick('colGenre', T('common.genre')), tick('colSubGenre', T('common.info')), tick('colMix', T('common.mix')));
  },

  /** A slider with its value beside it. Percent 1-100 unless told otherwise. */
  _slider({ key, label = '', name = label, min = 1, max = 100, step = 1, format = (v) => T('common.percent', { percent: Math.round(v) }), when }) {
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

  /** The texts' language: the device's (named), English or Deutsch. The window reloads to switch. */
  _languageSelect() {
    // Each language by its own name, the same in every language.
    const NAMES = { en: 'English', de: 'Deutsch' };
    const select = h('select.select', { 'aria-label': T('settings.general.language.label') },
      h('option', { value: '' }, T('settings.general.language.device', { language: NAMES[I18n.resolve('')] })),
      ...I18n.LANGUAGES.map((l) => h('option', { value: l }, NAMES[l] || l)));
    select.value = Store.settings.language || '';
    select.addEventListener('change', async () => {
      const choice = select.value;
      await Store.saveSettings({ language: choice });
      I18n.remember(choice);
      if (I18n.resolve(choice) !== I18n.lang) (window.flow.reload || (() => window.location.reload()))();
    });
    return select;
  },

  _select({ key, options, when }) {
    const select = h('select.select');
    for (const [v, text] of options) select.appendChild(h('option', { value: v }, text));
    select.value = String(Store.settings[key]);
    select.addEventListener('change', () => Store.saveSettings({ [key]: select.value }));
    if (when) this._refresh.push(() => { select.disabled = !when(); });
    return select;
  },

  /** The browser the cookies come from: those found on this computer first. */
  /** The outputs Windows offers (output.js). */
  /** The phone's: where the music comes out now, and a button to its own chooser. */
  _systemOutput() {
    const name = h('span.settings__note');
    // (The phone's layout shown on the computer, FLOW_UI=mobile, has no such call: its Settings still open.)
    const draw = () => (window.flow.outputName ? window.flow.outputName() : Promise.resolve('')).then((n) => {
      name.textContent = n;
    }).catch(() => {});
    draw();
    if (!this._outputWatched && window.flow.onOutputChange) {
      this._outputWatched = true;
      window.flow.onOutputChange(() => this._refreshAll());
    }
    this._refresh.push(draw);
    return h('div.settings__output', name,
      h('button.btn.btn--small', { type: 'button', onclick: () => window.flow.chooseOutput().catch(() => {}) }, T('common.change')));
  },

  _outputSelect() {
    const select = h('select.select');
    const fill = () => {
      clear(select);
      select.appendChild(h('option', { value: '' }, Output.defaultLabel
        ? `${Output.defaultName} (${Output.defaultLabel})` : Output.defaultName));
      for (const d of Output.devices) select.appendChild(h('option', { value: d.deviceId }, d.label));
      const s = Store.settings;
      const chosen = s.outputDevice ? Output._chosen() : null;
      if (s.outputDevice && !chosen) select.appendChild(h('option', { value: s.outputDevice }, T('settings.general.output.notThere', { device: s.outputDeviceLabel || T('settings.general.output.chosenDevice') })));
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
        if (b) shown.push({ ...b, name: T('settings.media.cookies.browserNotFound', { browser: b.name }) });
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
      estimate.textContent = T('settings.media.quality.perSong', { mb: mb.toFixed(1) });
    };
    select.addEventListener('change', () => {
      Store.saveSettings({ mp3Quality: Number(select.value) });
      draw();
    });
    draw();
    this._refresh.push(() => { select.disabled = !Store.settings.alwaysMp3; });
    return h('div.settings__control', h('span.settings__caption', T('settings.media.quality.label')), select, h('span', 'kbit/s'), estimate);
  },
};
