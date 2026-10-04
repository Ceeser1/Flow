'use strict';

// The trim editor's two drawn parts, copied from LWClipper's simple editing
// mode: the dual-handle slider (renderer/app/core.js there) and the waveform
// (drawWaveform in renderer/app/media.js). Same colours, same pixel mapping,
// and the same Shift = 10x / Ctrl = 100x finer dragging.

const FINE_SHIFT = 0.10;
const FINE_CTRL = 0.01;

const AUDIO_SELECTED = '#5a8cdc';
const AUDIO_UNSELECTED = '#8a8a94';
const AUDIO_WALL_START = '#78c88c';
const AUDIO_WALL_END = '#dc7878';
// SponsorBlock's marked parts (Settings, Website Downloads): the waveform in
// them, bright inside the selection and dimmed outside, over a faint band.
const SEGMENT_COLOURS = {
  sponsor: { selected: '#e6c84a', unselected: '#8c8158', band: 'rgba(230, 200, 74, 0.13)' },
  intro: { selected: '#e05a5a', unselected: '#8c5c5c', band: 'rgba(224, 90, 90, 0.13)' },
};

function modifierFactor(evt) {
  if (evt.ctrlKey) return FINE_CTRL;
  if (evt.shiftKey) return FINE_SHIFT;
  return 1.0;
}

/**
 * Where a time sits across a slider or canvas `cssWidth` wide: the handles'
 * centres travel between 8px + half a handle from either edge, and the
 * waveform uses the very same inset so the two can never disagree.
 */
function sliderMetrics(cssWidth, handleW = 16) {
  return { inset: 8 + handleW / 2, usable: Math.max(1, cssWidth - 16 - handleW) };
}

/**
 * The phone's fine control (no Shift or Ctrl there): -0.1 s and +0.1 s
 * buttons after the Start and End fields. Nothing on the desktop's layout.
 */
function addTrimNudges(slider, startGroup, endGroup) {
  if (!document.body.classList.contains('mobile')) return;
  const nudge = (isStart, by) => h('button.btn.trim-nudge', {
    type: 'button',
    'aria-label': `${isStart ? 'Start' : 'End'} ${by > 0 ? '+' : '-'}0.1 seconds`,
    onclick: () => {
      if (isStart) slider.setStart(Math.round((slider.start + by) * 1000) / 1000);
      else slider.setEnd(Math.round((slider.end + by) * 1000) / 1000);
    },
  }, by > 0 ? '+0.1' : '-0.1');
  startGroup.append(nudge(true, -0.1), nudge(true, 0.1));
  endGroup.append(nudge(false, -0.1), nudge(false, 0.1));
}

class TrimSlider {
  constructor(rootEl, startHandleEl, endHandleEl, fillEl) {
    this.root = rootEl;
    this.startHandle = startHandleEl;
    this.endHandle = endHandleEl;
    this.fill = fillEl;
    this.duration = 1;
    this.start = 0;
    this.end = 1;
    this.minSpan = 0.5;
    this.onChange = null;        // (start, end, which) while dragging or typing
    this.onDragStateChange = null;
    this._drag = null;

    this._bindHandle(this.startHandle, true);
    this._bindHandle(this.endHandle, false);
    window.addEventListener('resize', () => this._reposition());
  }

  setRange(duration, start, end) {
    this.duration = Math.max(duration, this.minSpan);
    this.start = this._clamp(start);
    this.end = this._clamp(end);
    this._enforceGap(false);
    this._reposition();
  }

  setStart(value, notify = true) {
    this.start = this._clamp(value);
    this._enforceGap(true);
    this._reposition();
    if (notify && this.onChange) this.onChange(this.start, this.end, 'start');
  }

  setEnd(value, notify = true) {
    this.end = this._clamp(value);
    this._enforceGap(false);
    this._reposition();
    if (notify && this.onChange) this.onChange(this.start, this.end, 'end');
  }

  _clamp(v) { return Math.min(Math.max(v, 0), this.duration); }

  _enforceGap(startMoved) {
    if (this.end - this.start >= this.minSpan) return;
    if (startMoved) {
      this.end = Math.min(this.duration, this.start + this.minSpan);
      this.start = Math.min(this.start, this.end - this.minSpan);
    } else {
      this.start = Math.max(0, this.end - this.minSpan);
      this.end = Math.max(this.end, this.start + this.minSpan);
    }
  }

  _handleW() {
    return this.startHandle.offsetWidth || 16;
  }

  valueToX(value) {
    const { inset, usable } = sliderMetrics(this.root.clientWidth, this._handleW());
    return inset + (value / this.duration) * usable;
  }

  xToValue(x) {
    const { inset, usable } = sliderMetrics(this.root.clientWidth, this._handleW());
    return this._clamp(((x - inset) / usable) * this.duration);
  }

  _xToValueDelta(deltaPixels) {
    const { usable } = sliderMetrics(this.root.clientWidth, this._handleW());
    return (deltaPixels / usable) * this.duration;
  }

  _reposition() {
    const startX = this.valueToX(this.start);
    const endX = this.valueToX(this.end);
    const half = this._handleW() / 2;
    this.startHandle.style.left = (startX - half) + 'px';
    this.endHandle.style.left = (endX - half) + 'px';
    // The fill lives inside the track, which starts 8px in.
    this.fill.style.left = (startX - 8) + 'px';
    this.fill.style.width = Math.max(0, endX - startX) + 'px';
  }

  _bindHandle(handle, isStart) {
    handle.addEventListener('pointerdown', (evt) => {
      handle.setPointerCapture(evt.pointerId);
      const factor = modifierFactor(evt);
      this._drag = { isStart, anchorX: evt.clientX, anchorValue: isStart ? this.start : this.end, factor };
      if (this.onDragStateChange) this.onDragStateChange(factor, true);
      evt.preventDefault();
      evt.stopPropagation();
    });

    handle.addEventListener('pointermove', (evt) => {
      if (!this._drag || this._drag.isStart !== isStart) return;
      const factor = modifierFactor(evt);
      if (factor !== this._drag.factor) {
        // Modifier changed mid-drag: re-anchor so the new rate continues from
        // where the handle sits now, no jump.
        this._drag.anchorX = evt.clientX;
        this._drag.anchorValue = isStart ? this.start : this.end;
        this._drag.factor = factor;
        if (this.onDragStateChange) this.onDragStateChange(factor, true);
      }
      const delta = this._xToValueDelta(evt.clientX - this._drag.anchorX) * this._drag.factor;
      if (isStart) this.setStart(this._drag.anchorValue + delta);
      else this.setEnd(this._drag.anchorValue + delta);
    });

    const endDrag = (evt) => {
      if (handle.hasPointerCapture(evt.pointerId)) handle.releasePointerCapture(evt.pointerId);
      this._drag = null;
      if (this.onDragStateChange) this.onDragStateChange(1.0, false);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }
}

/**
 * Draws `peaks` (flat min,max pairs) into `canvas`, blue inside [start, end]
 * and grey outside, with a green wall at the start and a red one at the end.
 * Without peaks yet, just the baseline and the walls. `segments`
 * ([{ start, end, kind }], kind 'sponsor' or 'intro') are coloured from
 * their start to their end; a later one wins where two overlap.
 */
function drawWaveform(canvas, peaks, duration, start, end, segments = []) {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  const wantW = Math.round(cssW * dpr);
  const wantH = Math.round(cssH * dpr);
  if (canvas.width !== wantW || canvas.height !== wantH) {
    canvas.width = wantW;
    canvas.height = wantH;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!duration) return;

  const { inset, usable } = sliderMetrics(cssW);
  const mid = cssH / 2;
  const half = mid - 3;
  const selX0 = inset + (start / duration) * usable;
  const selX1 = inset + (end / duration) * usable;

  const segs = (segments || []).filter((s) => SEGMENT_COLOURS[s.kind] && s.end > s.start && s.start < duration);
  const segX = (t) => inset + (Math.min(Math.max(t, 0), duration) / duration) * usable;
  for (const s of segs) {
    ctx.fillStyle = SEGMENT_COLOURS[s.kind].band;
    ctx.fillRect(segX(s.start), 2, Math.max(1, segX(s.end) - segX(s.start)), cssH - 4);
  }
  // The colour at second `t`: its segment's, if it is in one.
  const colourAt = (t, selected) => {
    for (let i = segs.length - 1; i >= 0; i -= 1) {
      if (t >= segs[i].start && t <= segs[i].end) return SEGMENT_COLOURS[segs[i].kind][selected ? 'selected' : 'unselected'];
    }
    return selected ? AUDIO_SELECTED : AUDIO_UNSELECTED;
  };

  // A flat line edge to edge first, so silence reads as silence, not a hole.
  const lineY = mid - 0.5;
  ctx.fillStyle = AUDIO_UNSELECTED;
  ctx.fillRect(0, lineY, cssW, 1);
  ctx.fillStyle = AUDIO_SELECTED;
  ctx.fillRect(selX0, lineY, Math.max(1, selX1 - selX0), 1);
  for (const s of segs) {
    const x0 = segX(s.start);
    const x1 = segX(s.end);
    // Inside and outside the selection, each in its own shade.
    const parts = [[x0, Math.min(x1, selX0), false], [Math.max(x0, selX0), Math.min(x1, selX1), true], [Math.max(x0, selX1), x1, false]];
    for (const [a, b, selected] of parts) {
      if (b <= a) continue;
      ctx.fillStyle = SEGMENT_COLOURS[s.kind][selected ? 'selected' : 'unselected'];
      ctx.fillRect(a, lineY, b - a, 1);
    }
  }

  const wallAt = (x, colour) => {
    ctx.fillStyle = colour;
    ctx.fillRect(x - 1, 2, 2, cssH - 4);
  };

  if (peaks && peaks.length) {
    const buckets = peaks.length / 2;
    for (let px = 0; px < usable; px += 1) {
      const t = (px / usable) * duration;
      // Every bucket this pixel column covers, so no peak falls between two.
      const b0 = Math.min(buckets - 1, Math.floor((px / usable) * buckets));
      const b1 = Math.min(buckets - 1, Math.max(b0, Math.floor(((px + 1) / usable) * buckets) - 1));
      let lo = 0;
      let hi = 0;
      for (let b = b0; b <= b1; b += 1) {
        if (peaks[b * 2] < lo) lo = peaks[b * 2];
        if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1];
      }
      lo = Math.max(-1, lo);
      hi = Math.min(1, hi);
      ctx.fillStyle = colourAt(t, t >= start && t <= end);
      const top = mid - hi * half;
      ctx.fillRect(inset + px, top, 1, Math.max(1, (mid - lo * half) - top));
    }
  }

  wallAt(selX0, AUDIO_WALL_START);
  wallAt(selX1, AUDIO_WALL_END);
}
