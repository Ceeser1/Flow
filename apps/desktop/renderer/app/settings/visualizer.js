'use strict';

// Settings > Music Visualizer: its rows, the frame rate and Random each (a part of SettingsPanel, settingsPanel.js).

extend(SettingsPanel, {
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
        title: v.ready ? undefined : T('settings.visualizer.comingSoon.tooltip'),
        dataset: { id: v.id },
        onclick: () => {
          Store.saveSettings({ visualizer: v.id });
          Visualizer.warm(v.id);
          draw();
          this._refreshAll();
        },
      }, art, h('span.viz-tile__name', v.name), v.ready ? null : h('span.viz-tile__soon', T('settings.visualizer.comingSoon.badge')));
      all.push(el);
      return el;
    };
    const byId = new Map(VISUALIZERS.map((v) => [v.id, v]));
    const shuffle = VIZ_RANDOM_GLYPH;
    const groups = VIZ_CATEGORIES.map((cat) => {
      const members = cat.ids.map((id) => byId.get(id)).filter(Boolean);
      const random = { id: `random-${cat.id}`, name: T('settings.visualizer.random.name'), ready: true, glyph: shuffle };
      const grid = h('div.viz-picker', tile(random), ...members.map(tile));
      const chevron = h('span.settings__chevron', { html: Icons.chevron });
      const note = h('span.viz-cat__note');
      const head = h('div.viz-cat', { tabIndex: 0, title: T('settings.window.category.toggle.tooltip') }, chevron, h('span', cat.name), note);
      head.setAttribute('role', 'button');
      const shut = () => Store.settings.vizCollapsed.includes(cat.id);
      notes.push(() => {
        const chosen = Store.settings.visualizer === random.id ? random : members.find((v) => v.id === Store.settings.visualizer);
        note.textContent = shut() && chosen ? T('settings.visualizer.chosen', { name: chosen.name }) : cat.desc;
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
    const preview = h('button.btn.btn--small', { type: 'button', onclick: () => Visualizer.open() }, T('settings.visualizer.previewSelected'));
    const left = h('div.settings__left',
      h('div.settings__label.settings__label--plain', T('settings.visualizer.select.heading')),
      h('div.settings__desc', T('settings.visualizer.select.desc')));
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
    const input = h('input.volume-slider.settings__slider', { type: 'range', min: 0, max: values.length - 1, step: 1, 'aria-label': T('settings.visualizer.limitFramerate.slider.name') });
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
      detected.textContent = hz ? T('settings.visualizer.vsync.detected', { hz }) : '';
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
        label: T('settings.visualizer.limitFramerate.label'),
        desc: T('settings.visualizer.limitFramerate.desc'),
        right: h('div.settings__control', input, value),
      }),
      this._row({
        key: 'vizVsync',
        label: T('settings.visualizer.vsync.label'),
        desc: T('settings.visualizer.vsync.desc'),
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
      label: T('settings.visualizer.randomEverySong.label'),
      desc: T('settings.visualizer.randomEverySong.desc'),
      when: random,
    });
    const name = row.querySelector('.settings__label span');
    this._refresh.push(() => {
      name.textContent = random() ? T('settings.visualizer.randomEverySong.label') : T('settings.visualizer.randomEverySong.needsRandom');
    });
    return row;
  },
});
