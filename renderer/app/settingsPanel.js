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
    window.yplayer.onFolderProgress((p) => {
      if (this._onProgress) this._onProgress(p);
    });
    Store.onLibrary(() => {
      if (this.modal) this._drawMeasured();
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

  // ---- Saved Songs ----

  _savedSongsRow() {
    this._statsNode = h('span.settings__note', '...');
    this._pathNode = h('div.settings__desc.settings__path');
    const open = h('button.btn.btn--small', { type: 'button', onclick: () => this._openFolder() }, 'Open');
    const change = h('button.btn.btn--small', { type: 'button', onclick: () => this._changeFolder(change) }, 'Change');
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', 'Saved Songs'),
      this._pathNode);
    return h('div.settings__row', left, h('div.settings__right', h('div.settings__control', this._statsNode, open, change)));
  },

  async _drawStats() {
    this._pathNode.textContent = Store.musicDir;
    this._pathNode.title = Store.musicDir;
    try {
      const st = await window.yplayer.folderStats();
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
        : `${done} of ${songs.length} songs measured${Store.settings.normalize ? '...' : ''}`;
  },

  _openFolder() {
    return attempt(async () => {
      // Resolves to an error message, or '' once Explorer has it.
      const problem = await window.yplayer.openMusicFolder();
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
      dir = await window.yplayer.chooseFolder();
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
      const result = await window.yplayer.moveMusicFolder(dir);
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
