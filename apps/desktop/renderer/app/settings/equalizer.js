'use strict';

// Settings > Equalizer: the sound equalizer's rows (a part of SettingsPanel, settingsPanel.js).

extend(SettingsPanel, {
  // ---- Equalizer ----

  /**
   * The sound equalizer (soundEq.js): Bands (8 to 64 points from 20 Hz to
   * 20 kHz), Sound Equalizer (the ready-made curves, and Custom: the user's own),
   * then the curve itself. A point is dragged up or down (Shift: finer) or put
   * back to 0 dB with a double-click; the keys pick one (Left, Right) and move
   * it (Up, Down). On the phone a finger put on a point drags it at once, and the
   * curve is pinched in or out (up to 400%) and slid along. Moving a point
   * makes the curve Custom.
   */
  _soundEqRows() {
    const MAX_ZOOM = 4;
    const shown = () => SoundEq.gainsOf(Store.settings);
    const custom = (gains) => ({ soundEqPreset: 'custom', soundEqCustom: gains });
    const round = (db) => Math.round(Math.max(-SoundEq.MAX_DB, Math.min(SoundEq.MAX_DB, db)) * 10) / 10;

    const { MIN_BANDS, MAX_BANDS } = SoundEq;
    const bands = h('input.volume-slider.settings__slider', {
      type: 'range', min: MIN_BANDS, max: MAX_BANDS, step: 1, value: Store.settings.soundEqBands, 'aria-label': T('settings.equalizer.bands.label'),
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

    const preset = h('select.select', { 'aria-label': T('settings.equalizer.preset.label') });
    for (const id of SoundEq.CHOICES) preset.appendChild(h('option', { value: id }, id === 'custom' ? T('settings.equalizer.preset.custom') : SoundEq.PRESETS[id].name));
    preset.addEventListener('change', () => {
      const patch = { soundEqPreset: preset.value };
      // Custom the first time: the curve shown until then, to change from.
      if (preset.value === 'custom' && !Store.settings.soundEqCustom.length) patch.soundEqCustom = shown();
      Store.saveSettings(patch);
    });

    const canvas = h('canvas.sound-eq__canvas', {
      tabIndex: 0, 'aria-label': T('settings.equalizer.curve.ariaLabel'),
    });
    const readout = h('span.sound-eq__readout');
    // The phone's: the point picked and how far it is zoomed in above the curve
    // (the zoom over its right end), how to use it in two rows under it.
    const zoomNode = h('span.sound-eq__zoom');
    const graph = Store.phone
      ? h('div.sound-eq',
        h('div.sound-eq__head', readout, zoomNode),
        canvas,
        h('div.sound-eq__note', T('settings.equalizer.curve.help.touch')),
        h('div.sound-eq__note', T('settings.equalizer.curve.help.pinch', { percent: MAX_ZOOM * 100 })))
      : h('div.sound-eq', canvas,
        h('div.sound-eq__info', readout, h('span', T('settings.equalizer.curve.help.mouse'))));

    // Room for the dB at the left and the Hz under it.
    const PAD = { l: 38, r: 14, t: 10, b: 22 };
    const LOG = Math.log(SoundEq.HIGH_HZ / SoundEq.LOW_HZ);
    // The part shown, as parts of the whole log scale (zoomed in on the phone).
    const view = { lo: 0, hi: 1 };
    const zoomOf = () => 1 / (view.hi - view.lo);
    const area = () => ({ x0: PAD.l, x1: canvas.clientWidth - PAD.r, y0: PAD.t, y1: canvas.clientHeight - PAD.b });
    const fracOf = (b, x) => view.lo + ((x - b.x0) / (b.x1 - b.x0)) * (view.hi - view.lo);
    const xOf = (b, hz) => b.x0 + ((Math.log(hz / SoundEq.LOW_HZ) / LOG - view.lo) / (view.hi - view.lo)) * (b.x1 - b.x0);
    const hzOf = (b, x) => SoundEq.LOW_HZ * Math.exp(fracOf(b, x) * LOG);
    const yOf = (b, db) => b.y0 + ((SoundEq.MAX_DB - db) / (2 * SoundEq.MAX_DB)) * (b.y1 - b.y0);
    const dbOf = (b, y) => SoundEq.MAX_DB - ((y - b.y0) / (b.y1 - b.y0)) * 2 * SoundEq.MAX_DB;
    const fmtHz = (hz) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2).replace(/\.?0+$/, '')} kHz` : `${Math.round(hz)} Hz`);
    const fmtDb = (db) => `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
    let hot = -1;      // the point under the pointer, picked with the keys, or tapped
    let drag = null;   // { i, gains, from: { y, db, fine }, moved } while one is dragged

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
      // The frequencies shown; zoomed in, those between them too.
      ctx.textBaseline = 'top';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      const marks = zoomOf() >= 2
        ? [20, 30, 50, 70, 100, 150, 200, 300, 500, 700, 1000, 1500, 2000, 3000, 5000, 7000, 10000, 15000, 20000]
        : [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
      for (const hz of marks) {
        const x = Math.round(xOf(b, hz)) + 0.5;
        if (x < b.x0 - 0.5 || x > b.x1 + 0.5) continue;
        line(x, b.y0, x, b.y1);
        ctx.textAlign = x < b.x0 + 12 ? 'left' : x > b.x1 - 12 ? 'right' : 'center';
        ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x, b.y1 + 6);
      }

      // The curve, eased from point to point, filled to 0 dB.
      const curve = [];
      for (let x = b.x0; x < b.x1; x += 1) curve.push([x, yOf(b, SoundEq.at(pts, hzOf(b, x)))]);
      curve.push([b.x1, yOf(b, SoundEq.at(pts, hzOf(b, b.x1)))]);
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

      // The points, smaller where they crowd; those beyond the part shown cut off at its edges.
      const gap = fs.length > 1 ? xOf(b, fs[1]) - xOf(b, fs[0]) : 20;
      const dot = Math.max(1.5, Math.min(4, gap * 0.35));
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x0 - 7, 0, b.x1 - b.x0 + 14, ht);
      ctx.clip();
      ctx.lineWidth = dot < 3 ? 1 : 1.5;
      ctx.strokeStyle = '#1e1e22';
      fs.forEach((f, i) => {
        const x = xOf(b, f);
        if (x < b.x0 - 7 || x > b.x1 + 7) return;
        ctx.beginPath();
        ctx.arc(x, yOf(b, gains[i]), i === hot ? 6 : dot, 0, Math.PI * 2);
        ctx.fillStyle = i === hot ? '#fff' : accent;
        ctx.fill();
        ctx.stroke();
      });
      ctx.restore();
      readout.textContent = hot >= 0 ? `${fmtHz(fs[hot])}: ${fmtDb(gains[hot])}` : '';
      zoomNode.textContent = T('settings.equalizer.curve.zoom', { percent: Math.round(zoomOf() * 100) });
      canvas.classList.toggle('sound-eq__canvas--hot', hot >= 0 || !!drag);
    };

    /** Zoomed `zoom` times (1 to MAX_ZOOM), the part `frac` of the scale staying at `x`. */
    const zoomTo = (zoom, frac, x) => {
      const b = area();
      const span = 1 / Math.max(1, Math.min(MAX_ZOOM, zoom));
      view.lo = Math.max(0, Math.min(1 - span, frac - ((x - b.x0) / (b.x1 - b.x0)) * span));
      view.hi = view.lo + span;
      draw();
    };

    const at = (e) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    /** The point nearest the pointer, within `reach` pixels; -1 for none. */
    const nearest = (e, reach = 14) => {
      const { x, y } = at(e);
      const b = area();
      const gains = shown();
      const fs = SoundEq.freqs(gains.length);
      let best = -1;
      let bestD = reach;
      fs.forEach((f, i) => {
        const d = Math.hypot(xOf(b, f) - x, yOf(b, gains[i]) - y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return best;
    };

    /** A point back to 0 dB (a double-click, a double tap). */
    const zero = (i) => {
      const gains = shown();
      if (i < 0 || gains[i] === 0) return;
      gains[i] = 0;
      Store.saveSettings(custom(gains));
    };

    /**
     * Point `i` dragged from the pointer's place `y`: it moves as far as the
     * pointer, in 0.5 dB steps; with Shift a fifth as far, in 0.1 dB steps.
     * Shift pressed or let go on the way goes on from where the point is.
     */
    const startDrag = (i, y, fine = false) => {
      const gains = shown();
      drag = { i, gains, from: { y, db: gains[i], fine }, moved: false };
      hot = i;
      draw();
    };
    const dragTo = (y, fine) => {
      if (fine !== drag.from.fine) drag.from = { y, db: drag.gains[drag.i], fine };
      const b = area();
      const moved = (dbOf(b, y) - dbOf(b, drag.from.y)) * (fine ? 0.2 : 1);
      const step = fine ? 0.1 : 0.5;
      const db = round(drag.from.db + Math.round(moved / step) * step);
      if (db === drag.gains[drag.i]) return;
      drag.gains = drag.gains.slice();
      drag.gains[drag.i] = db;
      drag.moved = true;
      Store.previewSettings(custom(drag.gains));
    };
    const drop = () => {
      if (!drag) return;
      if (drag.moved) Store.saveSettings(custom(drag.gains));
      drag = null;
      draw();
    };

    // Fingers: a finger put on a point drags it (a tap picks it, a second one soon
    // after on it puts it back to 0 dB), one put anywhere else slides the part shown
    // along, two pinch it in or out. A finger passing over a point never takes it.
    const fingers = new Map();   // pointerId -> { x, y }
    let touch = null;            // one finger: { x0, y0, on (the point under it, or -1), lo, moved }
    let pinch = null;            // two: { d, zoom, frac }
    let tapped = null;           // the last tap on a point, { i, t }
    const spread = () => {
      const [a, c] = [...fingers.values()];
      return { d: Math.hypot(a.x - c.x, a.y - c.y), x: (a.x + c.x) / 2 };
    };
    const touchDown = (e) => {
      fingers.set(e.pointerId, at(e));
      if (fingers.size === 2) {
        drop();
        touch = null;
        const s = spread();
        pinch = { d: Math.max(1, s.d), zoom: zoomOf(), frac: fracOf(area(), s.x) };
      } else if (fingers.size === 1 && !pinch) {
        const p = at(e);
        touch = { x0: p.x, y0: p.y, on: nearest(e, 24), lo: view.lo, moved: false };
      }
    };
    const touchMove = (e) => {
      if (!fingers.has(e.pointerId)) return;
      const p = at(e);
      fingers.set(e.pointerId, p);
      if (pinch) {
        if (fingers.size < 2) return;
        const s = spread();
        zoomTo(pinch.zoom * (s.d / pinch.d), pinch.frac, s.x);
        return;
      }
      if (!touch) return;
      if (!touch.moved) {
        if (Math.hypot(p.x - touch.x0, p.y - touch.y0) < 6) return;
        touch.moved = true;
        if (touch.on >= 0) startDrag(touch.on, touch.y0);
      }
      if (drag) {
        dragTo(p.y, false);
        return;
      }
      const b = area();
      const span = view.hi - view.lo;
      view.lo = Math.max(0, Math.min(1 - span, touch.lo - ((p.x - touch.x0) / (b.x1 - b.x0)) * span));
      view.hi = view.lo + span;
      draw();
    };
    const touchUp = (e) => {
      if (!fingers.delete(e.pointerId)) return;
      if (pinch) {
        // Nothing else until the other finger is lifted too.
        if (!fingers.size) pinch = null;
        return;
      }
      const t = touch;
      touch = null;
      if (drag) {
        drop();
        return;
      }
      if (!t || t.moved || e.type === 'pointercancel') return;
      const i = nearest(e, 20);
      const now = performance.now();
      if (i >= 0 && tapped && tapped.i === i && now - tapped.t < 400) {
        tapped = null;
        zero(i);
      } else {
        tapped = i >= 0 ? { i, t: now } : null;
      }
      hot = i;
      draw();
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        touchDown(e);
        return;
      }
      if (e.button !== 0) return;
      const i = nearest(e);
      if (i < 0) return;
      e.preventDefault();
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      startDrag(i, at(e).y, e.shiftKey);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') {
        touchMove(e);
        return;
      }
      if (!drag) {
        const i = nearest(e);
        if (i !== hot) {
          hot = i;
          draw();
        }
        return;
      }
      dragTo(at(e).y, e.shiftKey);
    });
    for (const type of ['pointerup', 'pointercancel']) {
      canvas.addEventListener(type, (e) => (e.pointerType === 'touch' ? touchUp(e) : drop()));
    }
    canvas.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'touch' || drag || hot < 0) return;
      hot = -1;
      draw();
    });
    // A finger's double tap is its own (touchUp).
    canvas.addEventListener('dblclick', (e) => {
      if (!Store.phone) zero(nearest(e));
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
      h('h3.settings__section', T('settings.equalizer.heading')),
      this._row({
        label: T('settings.equalizer.bands.label'),
        desc: T('settings.equalizer.bands.desc'),
        right: h('div.settings__control', bands, bandsValue),
      }),
      this._row({
        label: T('settings.equalizer.preset.label'),
        desc: T('settings.equalizer.preset.desc'),
        right: preset,
      }),
      graph,
    ];
  },
});
