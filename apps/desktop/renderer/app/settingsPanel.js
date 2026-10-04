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

const SettingsPanel = {
  modal: null,
  _refresh: [],       // re-greys rows after a tick box changes
  _onProgress: null,  // the save folder move, while it runs
  _collapsed: new Set(), // titles of the categories folded shut; kept while the app runs

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
      this._drawMeasured();
      this._drawCovers();
      this._drawStorage();
    });
    Store.onServer(() => {
      if (this.modal) this._drawServer();
      if (this.modal && this._jamNote) this._jamNote();
    });
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
      Store.can('musicFolder') ? this._savedSongsRow() : null,
      this._coversRow(),

      ...this._serverRows(),

      ...this._jamRows(),

      // yt-dlp runs on this device (not on the phone, where the server downloads).
      ...(Store.can('downloadHere') ? [
      h('h3.settings__section', 'Website Downloads'),
      this._row({
        key: 'useCookies',
        label: 'Download using browser cookies from',
        desc: 'Downloads may be blocked by age restrictions or sites may only serve content to signed-in users. '
          + 'Pick your browser to use session cookies (no login data) to bypass restrictions. Firefox works best. '
          + 'Chrome, Edge, Brave may lock cookies on Windows.',
        right: this._cookieBrowser(),
      }),
      this._row({
        key: 'shareCookies',
        label: 'Share session cookies with the server for downloads',
        desc: 'Download (Server) gets the cookies of the link\'s site only (all of YouTube for a YouTube link), '
          + 'for that one download, and deletes them with it. Over a plain http address at home they travel unencrypted.',
        sub: true,
        when: () => Store.settings.useCookies,
        show: () => Store.settings.serverOn,
      }),
      this._row({
        key: 'sponsorBlock',
        label: 'Use Sponsorblock for Youtube',
        desc: 'Shows sponsored segments as yellow in the trim.',
      }),
      this._row({
        key: 'sponsorBlockIntros',
        label: 'Try to detect intros/outros, marked red in the trim',
        desc: 'A music video\'s non-music parts (talk, skits, credits) count as these too.',
        sub: true,
        when: () => Store.settings.sponsorBlock,
      }),
      this._row({
        key: 'alwaysMp3',
        label: 'Always convert downloads into MP3',
        desc: 'Otherwise songs are kept in the format they come in.',
        right: this._mp3Quality(),
      }),
      this._row({
        key: 'keepMp3',
        label: 'Ignore files that are already in .mp3 format',
        desc: 'Leaves MP3s as they are instead of encoding them again at the quality above.',
        sub: true,
        when: () => Store.settings.alwaysMp3,
      }),
      ] : []),

      ...(Store.can('effects') ? [
      h('h3.settings__section', 'Visual Effects'),
      this._row({
        key: 'cloudsOn',
        label: 'Enable Background Clouds',
        desc: 'Slowly drifting clouds of colour behind the pages.',
        right: this._slider({ key: 'cloudsIntensity', label: 'Intensity', when: () => Store.settings.cloudsOn }),
      }),
      this._row({
        key: 'cloudsBass',
        label: 'React to Bass',
        desc: 'The clouds swell and brighten on kicks and bass notes.',
        sub: true,
        when: () => Store.settings.cloudsOn,
        right: this._slider({ key: 'cloudsBassAmount', label: 'Strength', when: () => Store.settings.cloudsOn && Store.settings.cloudsBass }),
      }),
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
      this._row({
        key: 'eqOn',
        label: 'Enable Equalizer',
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
      this._row({
        key: 'flashOn',
        label: 'Screen Flash',
        desc: 'The window\'s edges glow white from kick and bass peaks.',
        right: this._slider({ key: 'flashTriggers', label: 'Triggers', when: () => Store.settings.flashOn }),
      }),
      this._row({
        label: 'Flash range',
        desc: 'How far the edge flash and its fade-out reach, and how bright it starts at the edges.',
        sub: true,
        when: () => Store.settings.flashOn,
        right: this._slider({ key: 'flashRange', name: 'Flash range', when: () => Store.settings.flashOn }),
      }),

      h('h3.settings__section', 'Music Visualizer'),
      this._visualizerRow(),
      ] : []),

      ...(Store.can('updateCheck') || Store.can('batteryHelp') ? this._appRows() : []),
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
      },
    });
    if (mobile) {
      const modal = this.modal;
      this._backBtn = iconButton('modal__back', Icons.chevronLeft, 'Back', () => this.back());
      this._backBtn.hidden = true;
      modal.el.querySelector('.modal__head').prepend(this._backBtn);
      Mobile.swipeToClose(modal, ['left']);
    }
    this._refreshAll();
    this._drawStats();
    this._drawMeasured();
    this._drawCovers();
    this._drawStorage();
    this._drawServer();
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
      const title = node.textContent;
      const chevron = h('span.settings__chevron', { html: Icons.chevron });
      node.prepend(chevron);
      Object.assign(node, { tabIndex: 0, title: 'Show or hide this category' });
      node.setAttribute('role', 'button');
      const own = h('div.settings__group-rows');
      rows = own;
      const draw = () => {
        const shut = this._collapsed.has(title);
        own.hidden = shut;
        chevron.classList.toggle('settings__chevron--down', shut);
        node.setAttribute('aria-expanded', String(!shut));
      };
      const toggle = () => {
        if (this._collapsed.has(title)) this._collapsed.delete(title);
        else this._collapsed.add(title);
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
    return [list, ...groups];
  },

  _openScreen(title) {
    this._screen = title;
    this._screenList.hidden = !!title;
    for (const g of this._screenGroups) g.hidden = g.dataset.title !== title;
    const head = this.modal && this.modal.el.querySelector('.modal__title');
    if (head) head.textContent = title || 'Settings';
    if (this._backBtn) this._backBtn.hidden = !title;
    const body = this.modal && this.modal.el.querySelector('.modal__body');
    if (body) body.scrollTop = 0;
  },

  /** The phone's Back while Settings is open: from a category to the list. False on the list. */
  back() {
    if (!this.modal || !this._screen) return false;
    this._openScreen(null);
    return true;
  },

  /**
   * The phone app's own: Check for Updates, the songs kept on the phone, and
   * help for playing on with the screen off. Updates and the help are not
   * built yet (v3.0, Stage 8).
   */
  _appRows() {
    return [
      h('h3.settings__section', 'App'),
      Store.can('updateCheck') ? this._updateRow() : null,
      this._storageRow(),
      Store.can('batteryHelp') ? this._row({
        label: 'Playing with the screen off',
        desc: 'How to keep the phone from stopping Flow in the background.',
        right: h('button.btn.btn--small', { type: 'button', onclick: () => BackgroundHelp.open() }, 'Show'),
      }) : null,
    ];
  },

  /** Check for Updates: always looks; a newer Flow found earlier shows below it, with its Update. */
  _updateRow() {
    const desc = h('div');
    const check = h('button.btn.btn--small', {
      type: 'button',
      onclick: async () => {
        check.disabled = true;
        try {
          await Updates.check();
        } finally {
          check.disabled = false;
        }
      },
    }, 'Check');
    const draw = () => {
      const found = Updates.found;
      clear(desc);
      desc.append(h('div', `Flow ${Store.version || ''}`.trim()));
      if (found) {
        desc.append(h('div.settings__update',
          h('span', `Flow ${found.version} is available. `),
          h('button.link-btn', { type: 'button', onclick: () => Updates.ask(found) }, 'Update')));
      }
    };
    draw();
    this._refresh.push(draw);
    return this._row({ label: 'Check for Updates', desc, right: check });
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
      if (box) box.disabled = !on;
      // Its own box unticked: the value beside it does nothing either.
      row.classList.toggle('settings__row--unset', !!box && !box.checked);
    });
    return row;
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
   * visualizer.js), the chosen one outlined, and Preview to open it.
   */
  _visualizerRow() {
    const tiles = h('div.viz-picker');
    const draw = () => {
      for (const tile of tiles.children) {
        const on = tile.dataset.id === Store.settings.visualizer;
        tile.classList.toggle('viz-tile--on', on);
        tile.setAttribute('aria-pressed', String(on));
      }
    };
    for (const v of VISUALIZERS) {
      const art = h('span.viz-tile__art');
      // Its picture once there is one; a sign for it until then.
      if (v.image) art.appendChild(h('img.viz-tile__img', { src: v.image, alt: '' }));
      else art.innerHTML = v.glyph || '';
      tiles.appendChild(h('button.viz-tile' + (v.ready ? '' : '.viz-tile--soon'), {
        type: 'button',
        disabled: !v.ready,
        title: v.ready ? v.desc : 'Coming soon',
        dataset: { id: v.id },
        onclick: () => {
          Store.saveSettings({ visualizer: v.id });
          draw();
        },
      }, art, h('span.viz-tile__name', v.name), v.ready ? null : h('span.viz-tile__soon', 'Soon')));
    }
    draw();
    const preview = h('button.btn.btn--small', { type: 'button', onclick: () => Visualizer.open() }, 'Preview selected');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Select your Music Visualizer'),
      h('div.settings__desc', 'Opens in full screen from the visualizer button in the player bar. Escape or the X closes it.'));
    return h('div.settings__viz',
      h('div.settings__row.settings__row--flat', left, h('div.settings__right', preview)),
      tiles);
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
    if (!this._outputWatched) {
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
      select.appendChild(h('option', { value: '' }, `Windows default${Output.defaultLabel ? ` (${Output.defaultLabel})` : ''}`));
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
   * first, then remote), the password, and what goes up and down when.
   */
  _serverRows() {
    const on = () => Store.settings.serverOn;
    this._serverNode = h('div.settings__desc.server-state');
    const main = this._row({
      key: 'serverOn',
      label: 'Use a Flow Server',
      desc: 'Use the library on a Flow Server (a Raspberry Pi, another PC). Songs play straight from it, and '
        + 'changes made here go to it. Turned on, your Local Files are uploaded to the server.',
    });
    main.querySelector('.settings__left').appendChild(this._serverNode);
    this._syncBtn = h('button.btn.btn--small', { type: 'button', onclick: () => this._syncNow() }, 'Synchronize now');
    const rows = [
      h('h3.settings__section', 'Flow Server'),
      main,
      this._profileRow(),
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
        desc: `Entered once; Flow keeps it encrypted ${Store.platform === 'android' ? 'on this phone' : 'for your Windows account'}. Empty the box to forget it.`,
        sub: true,
        when: on,
        right: this._secretField(on),
      }),
      this._row({
        key: 'serverMetered',
        label: 'Always Download & Synchronize on mobile internet/metered connections',
        desc: 'Away from home, songs only go up and come down on connections that are not metered, unless ticked. '
          + 'Streaming works either way, and at home nothing is held back.',
        sub: true,
        when: on,
        show: () => !!Store.settings.serverRemote && Store.settings.serverRemoteOn !== false,
      }),
      this._row({
        key: 'serverKeepFiles',
        label: 'Keep downloaded files after sync with the server',
        desc: 'If disabled, downloaded songs will be removed locally once they are uploaded to the server '
          + '(except if they are marked to download).',
        when: on,
      }),
      this._row({
        key: 'serverAutoSync',
        label: 'Synchronize local changes',
        desc: 'Songs added to or removed from local files go to the server by themselves. '
          + 'If disabled, only the button will sync local changes.',
        when: on,
        right: this._syncBtn,
      }),
    ];
    // The button beside the box works whether or not the box is ticked.
    rows[rows.length - 1].classList.add('settings__row--keep');
    return rows;
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
        desc: 'If enabled, you do not get requests from users who want to join your jam, they can just join.',
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
  },

  // ---- Profiles ----

  /**
   * "Profile": signed in to one of the server's profiles, or to none. Not
   * signed in: the server's profiles and "+ New" (which turns into a box for
   * the new one's name), a PIN, and Login or Create. Signed in: who, with
   * Rename (the name turns into a box with a tick), Delete and Logout.
   */
  _profileRow() {
    this._prof = { mode: 'pick', picked: '', busy: false, key: '' };
    this._profileNode = h('div.settings__control.profile-control');
    return this._row({
      label: 'Profile',
      desc: 'Everyone shares the songs; each profile has its own playlists, favourites and listening stats.',
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
    const key = JSON.stringify([ready, st.on, st.state, st.profilesSupported, st.profile, st.profiles, p.mode, p.picked, p.busy]);
    if (!force && key === p.key) return;
    p.key = key;
    clear(node);
    if (!ready) {
      let text = '';
      if (st.profile) text = `Logged in as ${st.profile.name}`;
      else if (st.on && st.state === 'online' && !st.profilesSupported) text = 'Update the Flow Server to use profiles.';
      else if (st.on) text = 'Available while connected to the server.';
      node.append(h('span.settings__note', text));
      return;
    }
    if (st.profile) this._drawSignedIn(node, st.profile);
    else this._drawSignIn(node, st.profiles);
  },

  _drawSignedIn(node, profile) {
    const p = this._prof;
    if (p.mode === 'rename') {
      const input = h('input.input.settings__input.settings__input--short', {
        type: 'text', value: profile.name, maxLength: 40, spellcheck: false, autocomplete: 'off', disabled: p.busy,
      });
      const save = () => this._profileDo(async () => {
        const renamed = await window.flow.profileRename(input.value);
        p.mode = 'pick';
        toast(`Profile renamed to "${renamed.name}"`, 'success');
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') {
          e.stopPropagation();
          p.mode = 'pick';
          this._drawProfile(true);
        }
      });
      node.append(
        h('span.settings__caption', 'Logged in as'),
        input,
        h('button.btn.btn--small.profile-tick', { type: 'button', title: 'Save the name', disabled: p.busy, onclick: save }, '✓'),
      );
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      return;
    }
    const btn = (label, onclick) => h('button.btn.btn--small', { type: 'button', disabled: p.busy, onclick }, label);
    // Square, as in a song's More menu.
    const icon = (cls, glyph, title, onclick) => {
      const b = iconButton(cls, glyph, title, onclick);
      b.disabled = p.busy;
      return b;
    };
    node.append(
      h('span.profile-who', 'Logged in as ', h('strong', profile.name)),
      icon('act.act--grey', Icons.pencil, 'Rename', () => {
        p.mode = 'rename';
        this._drawProfile(true);
      }),
      icon('act.act--red', Icons.x, 'Delete', () => this._deleteProfile(profile)),
      btn('Logout', () => this._profileDo(async () => {
        await window.flow.profileLogout();
        toast(`Logged out of "${profile.name}"`, 'info');
      })),
    );
  },

  _drawSignIn(node, profiles) {
    const p = this._prof;
    if (p.picked && !profiles.some((x) => x.id === p.picked)) p.picked = '';
    const picked = profiles.find((x) => x.id === p.picked) || null;
    const creating = p.mode === 'new';
    let nameInput = null;
    if (creating) {
      nameInput = h('input.input.settings__input.settings__input--short', {
        type: 'text', placeholder: 'New profile name', maxLength: 40, spellcheck: false, autocomplete: 'off', disabled: p.busy,
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go();
        if (e.key === 'Escape') {
          e.stopPropagation();
          p.mode = 'pick';
          this._drawProfile(true);
        }
      });
      requestAnimationFrame(() => nameInput.focus());
    } else {
      nameInput = h('select.select.profile-select', { disabled: p.busy },
        h('option', { value: '' }, 'Default / Shared'),
        ...profiles.map((x) => h('option', { value: x.id }, x.name)),
        h('option', { value: '+new' }, '+ New'));
      nameInput.value = p.picked;
      nameInput.addEventListener('change', () => {
        if (nameInput.value === '+new') {
          p.mode = 'new';
          p.picked = '';
        } else {
          p.picked = nameInput.value;
        }
        this._drawProfile(true);
      });
    }
    const needsPin = creating || (picked && picked.pin);
    const pin = h('input.input.settings__input.profile-pin', {
      type: 'password',
      placeholder: creating ? 'PIN (optional)' : picked && !picked.pin ? 'No PIN' : 'PIN',
      autocomplete: 'new-password',
      spellcheck: false,
      disabled: p.busy || !needsPin,
    });
    const go = () => {
      if (creating) {
        return this._profileDo(async () => {
          const made = await window.flow.profileCreate(nameInput.value, pin.value);
          p.mode = 'pick';
          toast(`Profile "${made.name}" made. Logged in as ${made.name}.`, 'success');
        });
      }
      if (!picked) return undefined;
      return this._profileDo(async () => {
        const now = await window.flow.profileLogin(picked.id, pin.value);
        toast(`Logged in as ${now.name}`, 'success');
      });
    };
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    node.append(nameInput, pin,
      h('button.btn.btn--small', { type: 'button', disabled: p.busy || (!creating && !picked), onclick: go }, creating ? 'Create' : 'Login'));
    if (picked && picked.pin && !creating) requestAnimationFrame(() => pin.focus());
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
      title: 'Delete profile',
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
      h('div.settings__label.settings__label--plain', 'Covers'),
      h('div.settings__desc', 'Covers are found by the client or server.'));
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', this._coversNode, this._clearCovers)));
  },

  /** The phone's songs and their room; Remove downloads deletes the server's songs kept here. */
  _storageRow() {
    this._storageNode = h('span.settings__note');
    this._removeDownloads = h('button.btn.btn--small', {
      type: 'button',
      onclick: () => this._removeAllDownloads(),
    }, 'Remove downloads');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Storage'),
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
