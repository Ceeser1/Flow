'use strict';

// Piano Roll: the notes the music plays, as on a sequencer's piano roll.
// A keyboard of six octaves (C2 to B7) along the bottom; each note heard
// presses its key and rises from it as a glowing bar as long as it was
// held, sparks flying off the key while it sounds. Lines rise with them on
// every beat, brighter on the first of a bar.
//
// Its cogwheel: the colours (left and right hand as in Synthesia, a colour
// per note, neon), how fast the roll rises, the sparks.
//
// The notes come from notes.js (one level per semitone, how far it stands
// out from the sound around it): a semitone held above ON, among the
// strongest few, is a note until it sinks below OFF.
//
// Canvas 2D: the keyboard drawn once per size (the black keys on a canvas
// of their own, so a pressed white key can be lit under them); the bars and
// sparks on a layer of their own, drawn back small for the glow.

(() => {
  const LOW = 36;             // C2, as notes.js
  const KEYS = 72;
  const ON = 0.42;
  const OFF = 0.2;
  const MAX_NOTES = 7;
  const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];
  // Black keys sit a little off the middle between their whites, as on a piano.
  const SHIFT = { 1: -0.12, 3: 0.12, 6: -0.14, 8: 0, 10: 0.14 };

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function hsl(h, s, l) {
    return `hsl(${Math.round(((h % 1) + 1) % 1 * 360)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
  }

  class PianoRoll {
    constructor(cv) {
      this.canvas = cv;
      this.ctx = cv.getContext('2d');
      this.level = new Float32Array(KEYS);
      this.held = new Array(KEYS).fill(null);   // the note sounding on each key
      this.notes = [];
      this.sparks = [];
      this.lines = [];
      this.age = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      this.lit = canvas(w, h);
      this.lctx = this.lit.getContext('2d');
      this.s1 = canvas(w / 4, h / 4);
      this.s2 = canvas(w / 16, h / 16);
      this._build();
    }

    destroy() {}

    /** Where each key lies, and the keyboard drawn: the room with its lanes, the white keys, the black ones apart. */
    _build() {
      const { w, h } = this;
      const kh = Math.max(60, Math.round(h * 0.16));
      const top = h - kh;
      const whites = KEYS / 12 * 7;
      const ww = w / whites;
      const bw = ww * 0.6;
      const bh = kh * 0.62;
      this.top = top;
      this.kh = kh;
      this.keys = [];
      let wi = 0;
      for (let k = 0; k < KEYS; k += 1) {
        const pc = (LOW + k) % 12;
        if (BLACK[pc]) {
          const x = wi * ww - bw / 2 + SHIFT[pc] * bw;
          this.keys.push({ black: true, x, w: bw, h: bh, lane: [x + 1, bw - 2] });
        } else {
          const x = wi * ww;
          this.keys.push({ black: false, x, w: ww, h: kh, lane: [x + 2, ww - 4] });
          wi += 1;
        }
      }

      // The room: dark, a lane line at every C and F.
      const bg = canvas(w, h);
      const g = bg.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 0, top);
      grad.addColorStop(0, '#05060a');
      grad.addColorStop(1, '#10121a');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      for (let k = 0; k < KEYS; k += 1) {
        const pc = (LOW + k) % 12;
        if (pc !== 0 && pc !== 5) continue;
        g.fillStyle = pc === 0 ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.035)';
        g.fillRect(Math.round(this.keys[k].x), 0, 1, top);
      }

      // The white keys, a felt strip over them, C named.
      for (let k = 0; k < KEYS; k += 1) {
        const key = this.keys[k];
        if (key.black) continue;
        const kg = g.createLinearGradient(0, top, 0, h);
        kg.addColorStop(0, '#d9d9d6');
        kg.addColorStop(0.08, '#f4f4f1');
        kg.addColorStop(0.92, '#fbfbf9');
        kg.addColorStop(1, '#c9c9c5');
        g.fillStyle = kg;
        g.fillRect(key.x + 0.5, top, key.w - 1, kh);
        g.fillStyle = 'rgba(0, 0, 0, 0.35)';
        g.fillRect(Math.round(key.x), top, 1, kh);
        if ((LOW + k) % 12 === 0) {
          g.font = `600 ${Math.max(9, ww * 0.32)}px "Segoe UI", Arial, sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = 'bottom';
          g.fillStyle = 'rgba(0, 0, 0, 0.35)';
          g.fillText(`C${Math.floor((LOW + k) / 12) - 1}`, key.x + key.w / 2, h - kh * 0.05);
        }
      }
      const felt = g.createLinearGradient(0, top - kh * 0.05, 0, top + 2);
      felt.addColorStop(0, '#2a0507');
      felt.addColorStop(1, '#7a1015');
      g.fillStyle = felt;
      g.fillRect(0, top - kh * 0.04, w, kh * 0.04 + 2);
      this.bg = bg;

      // The black keys, glossy, on their own.
      const bl = canvas(w, h);
      const b = bl.getContext('2d');
      for (const key of this.keys) {
        if (!key.black) continue;
        this._blackKey(b, key, null);
      }
      this.blacks = bl;
    }

    _blackKey(g, key, color) {
      const top = this.top;
      g.fillStyle = 'rgba(0, 0, 0, 0.45)';
      g.fillRect(key.x + key.w * 0.1, top, key.w, key.h + 3);
      const kg = g.createLinearGradient(key.x, 0, key.x + key.w, 0);
      kg.addColorStop(0, '#161618');
      kg.addColorStop(0.5, '#2c2c30');
      kg.addColorStop(1, '#0d0d0e');
      g.fillStyle = kg;
      g.fillRect(key.x, top, key.w, key.h);
      if (color) {
        g.globalAlpha = 0.85;
        g.fillStyle = color;
        g.fillRect(key.x + 1, top, key.w - 2, key.h - 2);
        g.globalAlpha = 1;
      }
      g.fillStyle = 'rgba(255, 255, 255, 0.12)';
      g.fillRect(key.x + key.w * 0.15, top + key.h * 0.72, key.w * 0.7, key.h * 0.22);
    }

    /** A note's colour: the hand (below or above middle C), its pitch class, or along the keyboard. */
    _color(k, scheme, light = 0.58) {
      const midi = LOW + k;
      const black = BLACK[midi % 12];
      if (scheme === 'rainbow') return hsl((midi % 12) / 12, 0.9, black ? light - 0.14 : light - 0.06);
      if (scheme === 'neon') return hsl(0.88 - 0.42 * (k / KEYS), 1, black ? light - 0.08 : light);
      return midi < 60 ? hsl(0.6, 0.9, black ? light - 0.16 : light - 0.06) : hsl(0.37, 0.8, black ? light - 0.18 : light - 0.1);
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      const scheme = set('prColors');
      const speed = this.h * 0.28 * (set('prSpeed') / 100);
      const now = this.age;

      // Which keys sound: each semitone's level held a moment; the strongest
      // few over ON start a note, which ends once its level sinks below OFF.
      const notes = a.notes();
      const fall = Math.exp(-dt / 0.12);
      for (let k = 0; k < KEYS; k += 1) {
        const v = a.playing ? notes.level[k] : 0;
        this.level[k] = Math.max(v, this.level[k] * fall);
      }
      const order = [...this.level.keys()].filter((k) => this.level[k] > ON).sort((x, y) => this.level[y] - this.level[x]).slice(0, MAX_NOTES);
      for (let k = 0; k < KEYS; k += 1) {
        const on = this.held[k];
        if (on && this.level[k] < OFF) {
          on.end = now;
          this.held[k] = null;
        } else if (on) on.level = Math.max(on.level, this.level[k]);
      }
      for (const k of order) {
        if (this.held[k]) continue;
        const n = { k, start: now, end: null, level: this.level[k] };
        this.held[k] = n;
        this.notes.push(n);
      }
      // Gone off the top.
      this.notes = this.notes.filter((n) => n.end === null || this.top - (now - n.end) * speed > -10);

      // The beat lines.
      if (a.tick) this.lines.push({ at: now, bar: a.beats % 4 === 0 });
      this.lines = this.lines.filter((l) => this.top - (now - l.at) * speed > 0);

      const g = this.ctx;
      const lg = this.lctx;
      g.drawImage(this.bg, 0, 0);
      for (const l of this.lines) {
        const y = Math.round(this.top - (now - l.at) * speed);
        g.fillStyle = l.bar ? 'rgba(255, 255, 255, 0.09)' : 'rgba(255, 255, 255, 0.035)';
        g.fillRect(0, y, this.w, l.bar ? 2 : 1);
      }
      lg.clearRect(0, 0, this.w, this.h);

      // The bars: those on white keys first, the black ones' over them.
      for (const black of [false, true]) {
        for (const n of this.notes) {
          const key = this.keys[n.k];
          if (key.black !== black) continue;
          const y1 = n.end === null ? this.top : this.top - (now - n.end) * speed;
          const y0 = this.top - (now - n.start) * speed;
          const len = Math.max(3, y1 - y0);
          const [x, wd] = key.lane;
          lg.globalAlpha = 0.55 + 0.45 * Math.min(1, n.level * 1.3);
          lg.fillStyle = this._color(n.k, scheme);
          lg.beginPath();
          lg.roundRect(x, y1 - len, wd, len, Math.min(5, wd / 3, len / 2));
          lg.fill();
          lg.globalAlpha = 1;
          lg.fillStyle = 'rgba(255, 255, 255, 0.25)';
          lg.fillRect(x + 2, y1 - len + 1, Math.max(1, wd * 0.18), Math.max(1, len - 2));
        }
      }

      // Sparks off the keys that sound.
      if (set('prSparks')) {
        for (let k = 0; k < KEYS; k += 1) {
          const n = this.held[k];
          if (!n || Math.random() > dt * 40 * n.level) continue;
          const key = this.keys[k];
          this.sparks.push({
            x: key.lane[0] + Math.random() * key.lane[1], y: this.top - 2, vx: (Math.random() - 0.5) * 60, vy: -(80 + Math.random() * 220) * (this.h / 1080), life: 0.5 + Math.random() * 0.5, age: 0, k,
          });
        }
        if (this.sparks.length > 600) this.sparks.splice(0, this.sparks.length - 600);
        for (const s of this.sparks) {
          s.age += dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.vy += 60 * dt;
          const life = 1 - s.age / s.life;
          if (life <= 0) continue;
          lg.globalAlpha = life;
          lg.fillStyle = this._color(s.k, scheme, 0.75);
          const r = Math.max(1, this.h / 600) * (0.6 + life);
          lg.fillRect(s.x - r / 2, s.y - r / 2, r, r);
        }
        lg.globalAlpha = 1;
        this.sparks = this.sparks.filter((s) => s.age < s.life);
      } else this.sparks.length = 0;

      // The keys pressed: a glow on the felt, the white keys lit (on the
      // glow layer, under the black keys), then the black keys over them.
      for (let k = 0; k < KEYS; k += 1) {
        const n = this.held[k];
        if (!n) continue;
        const key = this.keys[k];
        lg.fillStyle = this._color(k, scheme, 0.65);
        lg.fillRect(key.lane[0] - 1, this.top - this.kh * 0.04, key.lane[1] + 2, this.kh * 0.04);
        if (!key.black) {
          lg.globalAlpha = 0.7;
          lg.fillRect(key.x + 1, this.top, key.w - 2, this.kh - 2);
          lg.globalAlpha = 1;
        }
      }
      g.drawImage(this.lit, 0, 0);
      g.drawImage(this.blacks, 0, 0);
      for (let k = 0; k < KEYS; k += 1) {
        if (!this.held[k] || !this.keys[k].black) continue;
        const color = this._color(k, scheme, 0.6);
        this._blackKey(g, this.keys[k], color);
        lg.fillStyle = color;
        lg.fillRect(this.keys[k].x, this.top, this.keys[k].w, this.keys[k].h);
      }

      // The glow.
      const s1 = this.s1.getContext('2d');
      const s2 = this.s2.getContext('2d');
      s1.clearRect(0, 0, this.s1.width, this.s1.height);
      s1.drawImage(this.lit, 0, 0, this.s1.width, this.s1.height);
      s2.clearRect(0, 0, this.s2.width, this.s2.height);
      s2.drawImage(this.s1, 0, 0, this.s2.width, this.s2.height);
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.35;
      g.drawImage(this.s1, 0, 0, this.w, this.h);
      g.globalAlpha = 0.6;
      g.drawImage(this.s2, 0, 0, this.w, this.h);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
  }

  Visualizer.add({
    id: 'pianoroll',
    name: 'Piano Roll',
    desc: 'The notes the music plays pressing the keys of a piano and rising from them as glowing bars, as long as they are held',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="14" width="20" height="7" rx="1"/><path d="M7 14v4M12 14v4M17 14v4"/>'
      + '<path d="M5 3v8M10 6v5M15 2v9M19 7v4"/></svg>',
    sharp: true,
    create: (cv) => new PianoRoll(cv),
    options: [
      { type: 'choice', key: 'prColors', label: 'Colours', choices: [['hands', 'Two hands'], ['rainbow', 'Per note'], ['neon', 'Neon']] },
      { type: 'slider', key: 'prSpeed', label: 'Speed', min: 25, max: 300, step: 5 },
      { type: 'check', key: 'prSparks', label: 'Sparks' },
    ],
  });
})();
