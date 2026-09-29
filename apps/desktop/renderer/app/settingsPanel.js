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
  ['white', 'White'],
  ['red', 'Red'],
  ['green', 'Green'],
  ['yellow', 'Yellow'],
  ['blue', 'Blue'],
  ['purple', 'Purple'],
  ['black', 'Black'],
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

  init() {
    $('menuSettings').innerHTML = '<img class="settings-btn__icon" src="../images/settings.png" alt="" />';
    $('menuSettings').onclick = () => this.open();
    window.flow.onFolderProgress((p) => {
      if (this._onProgress) this._onProgress(p);
    });
    Store.onLibrary(() => {
      if (this.modal) this._drawMeasured();
    });
    Store.onServer(() => {
      if (this.modal) this._drawServer();
    });
  },

  open() {
    if (this.modal) return;
    this._refresh = [];
    const body = h('div.settings',
      h('h3.settings__section', 'General'),
      this._savedSongsRow(),
      this._row({
        key: 'crossfade',
        label: 'Song Transition',
        desc: 'Smoothly transition between songs for the set time.',
        right: this._slider({ key: 'crossfadeSeconds', min: 0.1, max: 10, step: 0.1, format: (v) => `${v.toFixed(1)} s`, when: () => Store.settings.crossfade }),
      }),
      this._row({
        key: 'normalize',
        label: 'Equalize volume',
        desc: 'Play all songs at an equal volume. It reduces loud spikes and makes quiet songs louder.',
        right: this._measuredNode = h('span.settings__note'),
      }),

      ...this._serverRows(),

      h('h3.settings__section', 'Downloads'),
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
        desc: 'Spectrum colors bars by their height. Rainbow runs colors across the bars.',
        sub: true,
        when: () => Store.settings.eqOn,
        right: this._select({ key: 'eqColors', options: EQ_SCHEMES, when: () => Store.settings.eqOn }),
      }),
      this._row({
        key: 'flashOn',
        label: 'Screen Flash',
        desc: 'The window\'s edges glow white from kick and bass peaks. A flash on each punch of the deep bass (up to 80 Hz). More triggers: smaller punches count and flashes may follow each other sooner.',
        right: this._slider({ key: 'flashTriggers', label: 'Triggers', when: () => Store.settings.flashOn }),
      }),
      this._row({
        label: 'Flash range',
        desc: 'How far the edge flash and its fade-out reach, and how bright it starts at the edges.',
        sub: true,
        when: () => Store.settings.flashOn,
        right: this._slider({ key: 'flashRange', when: () => Store.settings.flashOn }),
      }),

      h('h3.settings__section', 'Music Visualizer'),
      this._visualizerRow());

    this.modal = Modal.open({
      title: 'Settings',
      className: 'modal--settings',
      body: [body],
      buttons: [{ label: 'Close', kind: 'primary' }],
      onClose: () => {
        this.modal = null;
        this._refresh = [];
      },
    });
    this._refreshAll();
    this._drawStats();
    this._drawMeasured();
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
   */
  _row({ key, label, desc, right = null, sub = false, when = null }) {
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
      row.classList.toggle('settings__row--off', !on);
      if (box) box.disabled = !on;
      // Its own box unticked: the value beside it does nothing either.
      row.classList.toggle('settings__row--unset', !!box && !box.checked);
    });
    return row;
  },

  /** A slider with its value beside it. Percent 1-100 unless told otherwise. */
  _slider({ key, label = '', min = 1, max = 100, step = 1, format = (v) => `${Math.round(v)}%`, when }) {
    const input = h('input.volume-slider.settings__slider', { type: 'range', min, max, step, value: Store.settings[key] });
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

  // ---- Streaming, Download and Synchronization ----

  /**
   * The Flow Server rows: on/off with its state, the two addresses (home
   * first, then remote), the PIN, and what goes up and down when.
   */
  _serverRows() {
    const on = () => Store.settings.serverOn;
    this._serverNode = h('div.settings__desc.server-state');
    const main = this._row({
      key: 'serverOn',
      label: 'Streaming, Download and Synchronization',
      desc: 'Use the library on a Flow Server (a Raspberry Pi, another PC). Songs play straight from it, and '
        + 'changes made here go to it. Turned on, your Local Files are uploaded to the server.',
    });
    main.querySelector('.settings__left').appendChild(this._serverNode);
    this._syncBtn = h('button.btn.btn--small', { type: 'button', onclick: () => this._syncNow() }, 'Synchronize now');
    return [
      h('h3.settings__section', 'Flow Server'),
      main,
      this._profileRow(),
      this._row({
        label: 'Home Server in WiFi/LAN',
        desc: 'Tried first. The address the server shows when it starts.',
        sub: true,
        when: on,
        right: this._textField({ key: 'serverHome', placeholder: '192.168.0.63:7878', when: on }),
      }),
      this._row({
        label: 'Remote Server',
        desc: 'Tried when the home one does not answer: its public IP or domain, for when you are away.',
        sub: true,
        when: on,
        right: this._textField({ key: 'serverRemote', placeholder: '203.0.113.7:7878 or flow.example.com', when: on }),
      }),
      this._row({
        key: 'serverAuth',
        label: 'Pin or Password if the Server requires one',
        desc: 'Entered once; Flow keeps it encrypted for your Windows account.',
        sub: true,
        when: on,
        right: this._secretField(() => on() && Store.settings.serverAuth),
      }),
      this._row({
        key: 'serverMetered',
        label: 'Always Download & Synchronize on mobile internet/metered connections',
        desc: 'Otherwise songs only go up and come down on connections that are not metered. Streaming works either way.',
        sub: true,
        when: on,
      }),
      this._row({
        key: 'serverKeepFiles',
        label: 'Keep downloaded files after sync with the server',
        desc: 'Songs downloaded here stay in Local Files once they are on the server, to play them without it. '
          + 'Unticked, each is removed here once uploaded (unless a playlist marked for download holds it).',
        sub: true,
        when: on,
      }),
      this._row({
        key: 'serverAutoSync',
        label: 'Synchronize local changes',
        desc: 'Songs added to or removed from Local Files by hand go to the server by themselves. '
          + 'Unticked, only with Synchronize now. Songs downloaded in Flow always go up.',
        sub: true,
        when: on,
        right: this._syncBtn,
      }),
    ];
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
    if (when) this._refresh.push(() => { input.disabled = !when(); });
    return input;
  },

  /** The PIN: never shown, only replaced. Saved (encrypted) when left. */
  _secretField(when) {
    const input = h('input.input.settings__input.settings__input--short', {
      type: 'password', placeholder: 'Pin/PW', autocomplete: 'new-password', spellcheck: false,
    });
    const draw = () => {
      input.placeholder = Store.server.hasSecret ? '••••••' : 'Pin/PW';
    };
    input.addEventListener('change', () => attempt(async () => {
      if (!input.value) return;
      await window.flow.setServerSecret(input.value);
      input.value = '';
      input.placeholder = '••••••';
    }));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
    });
    draw();
    this._refresh.push(() => {
      input.disabled = !when();
      draw();
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
    else if (!s.serverHome && !s.serverRemote) text = 'Enter the home or remote address below.';
    else ({ text, kind } = ServerChip.describe(st));
    const lines = [text, st.on ? st.transfer : '', st.on ? st.note : ''].filter(Boolean);
    clear(this._serverNode);
    this._serverNode.className = `settings__desc server-state server-state--${kind}`;
    for (const line of lines) this._serverNode.appendChild(h('div', line));
    if (this._syncBtn) {
      this._syncBtn.disabled = !st.on || !!st.syncing;
      this._syncBtn.textContent = st.syncing ? 'Synchronizing...' : 'Synchronize now';
    }
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
    const btn = (label, onclick, extra = '') => h(`button.btn.btn--small${extra}`, { type: 'button', disabled: p.busy, onclick }, label);
    node.append(
      h('span.profile-who', 'Logged in as ', h('strong', profile.name)),
      btn('Rename', () => {
        p.mode = 'rename';
        this._drawProfile(true);
      }),
      btn('Delete', () => this._deleteProfile(profile)),
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
        h('option', { value: '' }, 'None'),
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
    this._pathNode.textContent = Store.musicDir;
    this._pathNode.title = Store.musicDir;
    try {
      const st = await window.flow.folderStats();
      Store.musicDir = st.dir;
      this._pathNode.textContent = st.dir;
      this._pathNode.title = st.dir;
      this._statsNode.textContent = `${Util.plural(st.count, 'song')} · ${fmtBytes(st.bytes)}`;
    } catch {
      this._statsNode.textContent = '';
    }
  },

  _drawMeasured() {
    if (!this._measuredNode) return;
    const songs = Store.library.songs;
    const done = songs.filter((s) => s.loudness !== null && s.loudness !== undefined).length;
    this._measuredNode.textContent = !songs.length ? ''
      : done >= songs.length ? `All ${songs.length} songs measured`
        // With a server, songs only streamed are measured by the server (with ffmpeg).
        : `${done} of ${songs.length} songs measured${Store.settings.normalize && !Store.server.on ? '...' : ''}`;
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
