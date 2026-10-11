'use strict';

// Seismograph: a chart recorder's paper running out to the left under a row
// of pens, one for each part of the spectrum (the bass at the bottom, the
// highs at the top). Each pen trembles about its line as strongly as its
// part sounds, slowly when low, scratching quickly when high; what jumps out
// kicks it into a swing that dies away, as an earthquake's shock does. The
// pens have a little weight, so they swing past and settle. A marker pen in
// the top margin steps up on every beat (higher on a bar's first). The paper
// is grid paper with holes along its edges; the ink is darker while wet and
// lighter where a pen moved fast. On the right the machine: a slot each pen
// arm comes out of, a lamp glowing with its level, its frequency.
//
// Its cogwheel: the paper's grid (green, red, blue), the ink (a colour for
// each pen, black, its own), how many pens, the paper's speed.
//
// WebGL (viz/gl.js): the traces are kept as the pens' positions over the last
// seconds and drawn as lines each frame into a texture of ink; one pass then
// draws the paper, its grid and holes, the ink on it and the machine, and the
// pen arms are drawn over it as lines.

(() => {
  const RATE = 240;          // the pens' positions kept a second
  const KEEP = RATE * 40;    // up to 40 s (the paper's whole width at its slowest)
  const MAX_PENS = 12;
  const BODY = 0.045;        // the machine's guides above and below the paper, in screen heights
  const MARGIN = 0.03;       // the paper's edge with its holes
  const MARKER = 0.04;       // the marker pen's lane under it
  const HOUSING = 0.2;       // the machine on the right
  const ARM = 0.1;           // the pen arms' length out of it
  const PER_S = 0.18;        // the paper's speed at 100%, screen heights a second
  const INK_LINES = 240000;  // vertices: up to 2400 segments a pen and the marker's

  const INKS = [
    [0.78, 0.1, 0.13],  // red
    [0.12, 0.28, 0.72], // blue
    [0.06, 0.48, 0.27], // green
    [0.42, 0.16, 0.6],  // violet
    [0.1, 0.1, 0.12],   // black
    [0.55, 0.28, 0.08], // brown
  ];
  const BLACK = [0.08, 0.09, 0.12];
  const PAPERS = { green: 0, red: 1, blue: 2 };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D ink, labels;
    uniform vec2 res;
    uniform float scroll, penX, laneTop, lane, major, wetPx, time;
    uniform int pens, paper;
    uniform float leds[${MAX_PENS}];
    out vec4 o;

    void main() {
      vec2 f = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);   // pixels, y down
      float H = res.y;
      float px = 1.0;
      float body = ${BODY} * H;
      float hx = res.x - ${HOUSING} * H;
      vec3 col;
      // The paper's grid and its colour.
      vec3 sheet = paper == 1 ? vec3(0.985, 0.95, 0.9) : (paper == 2 ? vec3(0.965, 0.972, 0.982) : vec3(0.96, 0.962, 0.935));
      vec3 grid = paper == 1 ? vec3(0.9, 0.38, 0.33) : (paper == 2 ? vec3(0.35, 0.52, 0.82) : vec3(0.3, 0.6, 0.4));
      if (f.y > body && f.y < H - body) {
        // Along the paper: x as printed on it (it moves left).
        float x = f.x + scroll;
        col = sheet;
        // Fibres, running along.
        col *= 0.975 + 0.025 * vnoise(vec2(x * 0.05, f.y * 0.4)) + 0.012 * (hash12(floor(vec2(x, f.y) * 0.7)) - 0.5);
        float m = ${MARGIN} * H;
        float top = body + m, bottom = H - body - m;
        if (f.y > top && f.y < bottom) {
          // The grid: minor lines a fifth of a major one, the lanes' edges bolder.
          float gy = f.y - laneTop;
          float minor = major / 5.0;
          float lx = abs(fract(x / minor + 0.5) - 0.5) * minor;
          float ly = abs(fract(gy / minor + 0.5) - 0.5) * minor;
          float Lx = abs(fract(x / major + 0.5) - 0.5) * major;
          float Ly = abs(fract(gy / major + 0.5) - 0.5) * major;
          float edge = abs(fract(gy / lane + 0.5) - 0.5) * lane;
          float g = 0.22 * smoothstep(0.9, 0.2, min(lx, ly));
          g = max(g, 0.45 * smoothstep(1.0, 0.3, min(Lx, Ly)));
          if (gy > -1.0) g = max(g, 0.75 * smoothstep(1.4, 0.4, edge));
          col = mix(col, grid * 0.95 + sheet * 0.05, g * 0.55);
        } else {
          // The edges: a line along each, the holes the paper is pulled by.
          float e = f.y < top ? f.y - body : H - body - f.y;
          col = mix(col, grid, 0.5 * smoothstep(1.2, 0.3, abs(e - m + 1.0)));
          vec2 h = vec2(mod(x, major * 2.0) - major, e - m * 0.5);
          float hole = length(h) - m * 0.22;
          col = mix(col, vec3(0.05, 0.05, 0.055), smoothstep(0.8, -0.8, hole));
          col *= 1.0 - 0.15 * smoothstep(2.0, 0.0, abs(hole + 1.0)) * step(0.0, h.y);
        }
        // The ink, darker while wet (just left by the pen).
        vec3 a = texture(ink, vec2(gl_FragCoord.x / res.x, gl_FragCoord.y / res.y)).rgb;
        float wet = exp(-max(0.0, penX - f.x) / wetPx);
        col *= exp(-a * (2.1 + 0.6 * wet));
        // Lit from above left; darker under the machine.
        col *= 0.9 + 0.1 * (1.0 - f.y / H) - 0.06 * (f.x / res.x);
        float shade = min(f.y - body, H - body - f.y);
        col *= 0.7 + 0.3 * smoothstep(0.0, 0.012 * H, shade);
        col *= 0.65 + 0.35 * smoothstep(0.0, 0.03 * H, hx - f.x);
      } else {
        // The guides above and below: dark enamel, a bright rim by the paper.
        float d = f.y < body ? body - f.y : f.y - (H - body);
        col = vec3(0.1, 0.105, 0.11) * (0.85 + 0.15 * vnoise(f * 0.8));
        col += vec3(0.25) * smoothstep(0.004 * H, 0.0, d) * smoothstep(0.0, 1.5, d);
        col *= 0.8 + 0.2 * smoothstep(0.0, body, d);
      }
      if (f.x > hx) {
        // The machine: dark crinkled enamel, its edge catching the light.
        float d = f.x - hx;
        col = vec3(0.12, 0.125, 0.13) * (0.85 + 0.15 * vnoise(f * 0.9) + 0.05 * vnoise(f * 0.05));
        col += vec3(0.22) * smoothstep(0.004 * H, 0.0, d) * smoothstep(0.0, 1.5, d);
        col *= 0.75 + 0.25 * smoothstep(0.0, 0.02 * H, d);
        // Each pen's row: the slot its arm comes out of, its lamp, its frequency.
        // The marker's row first (-1), then the pens from the bottom.
        for (int i = -1; i < ${MAX_PENS}; i++) {
          if (i >= pens) break;
          float y = i < 0 ? H * (${BODY} + ${MARGIN} + ${MARKER} * 0.8) : laneTop + lane * (float(pens - 1 - i) + 0.5);
          float dy = f.y - y;
          if (abs(dy) > 0.03 * H) continue;
          vec2 slot = vec2(d - 0.016 * H, dy);
          vec2 q = abs(slot) - vec2(0.016 * H, 0.0035 * H);
          float s = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
          col = mix(col, vec3(0.015), smoothstep(px, -px, s));
          col += vec3(0.12) * smoothstep(px, 0.0, abs(s)) * step(0.0, dy);
          if (i >= 0) {
            float lv = leds[i];
            vec2 l = vec2(d - 0.045 * H, dy);
            float r = length(l);
            vec3 lamp = vec3(1.0, 0.18, 0.08);
            col = mix(col, mix(vec3(0.18, 0.03, 0.02), lamp * (0.6 + 1.2 * lv), min(1.0, lv * 1.5)), smoothstep(0.0055 * H + px, 0.0055 * H - px, r));
            col += lamp * exp(-r / (0.006 * H)) * lv * 0.5;
          }
          // The label: a cell of the texture, four times as wide as it is high.
          float lh = min(0.026 * H, lane * 0.4);
          vec2 t = vec2((d - 0.06 * H) / (lh * 4.0), dy / lh + 0.5);
          if (t.x > 0.0 && t.x < 1.0 && t.y > 0.0 && t.y < 1.0) {
            float a = texture(labels, vec2(t.x, (float(i + 1) + t.y) / float(${MAX_PENS + 1}))).r;
            col = mix(col, vec3(0.78, 0.76, 0.7), a);
          }
        }
      }
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Seismograph {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.lines = VizGL.lines(gl, INK_LINES);
      this.age = 0;
      this.scroll = 0;
      this.acc = 0;            // time since the last kept position, in steps
      this.count = 0;          // positions kept so far
      this.at = 0;             // where the next goes
      this.pens = 0;
      // Per pen and the marker (the last): its trace, where it is and how fast it moves.
      this.trace = [];
      for (let i = 0; i <= MAX_PENS; i += 1) this.trace.push(new Float32Array(KEEP));
      this.y = new Float32Array(MAX_PENS + 1);
      this.v = new Float32Array(MAX_PENS + 1);
      this.env = new Float32Array(MAX_PENS);
      this.goal = new Float32Array(MAX_PENS);
      this.kick = new Float32Array(MAX_PENS);
      this.spike = new Float32Array(MAX_PENS);   // a kick's jolt, given the pen on the next step
      // Each pen's jumps: their usual size and spread, when it last kicked (s).
      this.mean = new Float32Array(MAX_PENS);
      this.dev = new Float32Array(MAX_PENS);
      this.last = new Float32Array(MAX_PENS).fill(-1);
      this.leds = new Float32Array(MAX_PENS);
      this.ph = [0, 1, 2].map(() => new Float32Array(MAX_PENS).map(() => Math.random() * 6.28));
      this.rough = new Float32Array(MAX_PENS);
      this.drift = new Float32Array(MAX_PENS).map(() => Math.random() * 100);
      this.prev = null;
      this.mark = 0;           // the marker's step, 0 or up
      this.markLeft = 0;       // how long it stays up (s)
      this.labelCanvas = document.createElement('canvas');
      this.labelCanvas.width = 256;
      this.labelCanvas.height = 64 * (MAX_PENS + 1);
      this.labelTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      VizGL.freeTarget(this.gl, this.ink);
      this.ink = VizGL.target(this.gl, w, h);
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** The bands each pen follows: [first, end) of VizAudio's. */
    _group(a, i) {
      return [Math.floor((a.BANDS * i) / this.pens), Math.floor((a.BANDS * (i + 1)) / this.pens)];
    }

    /** The marker's name, then each pen's frequency, a row each, the bass first. */
    _labels(a) {
      const c = this.labelCanvas.getContext('2d');
      c.clearRect(0, 0, 256, this.labelCanvas.height);
      c.fillStyle = '#fff';
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      c.font = '600 40px system-ui, sans-serif';
      c.fillText('BEAT', 4, 34);
      for (let i = 0; i < this.pens; i += 1) {
        const [g0, g1] = this._group(a, i);
        const hz = a.bandHz((g0 + g1 - 1) / 2);
        const text = hz < 1000 ? `${Math.round(hz / (hz < 100 ? 5 : 10)) * (hz < 100 ? 5 : 10)} Hz` : `${(hz / 1000).toFixed(1)} kHz`;
        c.fillText(text, 4, 64 * (i + 1) + 34);
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.labelTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.labelCanvas);
    }

    /** Each pen's goal this frame: how strongly its part sounds, and what jumped out of it. */
    _listen(a, dt) {
      const n = a.BANDS;
      if (!this.prev || this.prev.length !== n) this.prev = new Float32Array(a.bands);
      const keep = 1 - Math.exp(-dt / 1.0);
      for (let i = 0; i < this.pens; i += 1) {
        const [g0, g1] = this._group(a, i);
        let dyn = 0;
        let sm = 0;
        let flux = 0;
        for (let b = g0; b < g1; b += 1) {
          dyn += a.dynamic[b];
          sm += a.smooth[b];
          flux += Math.max(0, a.bands[b] - this.prev[b]);
        }
        const k = Math.max(1, g1 - g0);
        dyn /= k;
        sm /= k;
        flux /= k * Math.max(dt, 0.004);
        let goal = 0;
        let kick = 0;
        if (a.playing) {
          // A part holding steady trembles a little; one standing out swings wide.
          goal = Math.pow(Math.max(0, Math.min(1, (dyn - 0.4) / 0.55)), 1.5) * Math.min(1, sm * 3) * 0.7;
          // A jump well above its own usual (as VizAudio's onsets), at most every 150 ms, kicks it.
          const over = flux - (this.mean[i] + 2.5 * this.dev[i]);
          this.mean[i] += (flux - this.mean[i]) * keep;
          this.dev[i] += (Math.abs(flux - this.mean[i]) - this.dev[i]) * keep;
          const power = over > 0 ? Math.min(1, 0.15 + over / Math.max(1e-4, this.mean[i] + 3 * this.dev[i])) : 0;
          if (power > 0.25 && this.age - this.last[i] > 0.15 && sm > 0.08) {
            kick = power;
            this.last[i] = this.age;
          }
        } else {
          this.mean[i] *= 0.9;
          this.dev[i] *= 0.9;
        }
        if (i < Math.max(1, this.pens / 6) && a.onset) kick = Math.max(kick, a.onsetPower);
        this.goal[i] = goal;
        if (kick > 0) {
          this.kick[i] = Math.max(this.kick[i], kick);
          this.spike[i] = kick * (Math.random() < 0.5 ? -1 : 1);
        }
      }
      this.prev.set(a.bands);
      // The marker: up for a moment on each beat (with no clear beat, each kick), higher on a bar's first.
      const beat = a.playing && (a.lock > 0.5 ? a.tick : a.onset);
      if (beat) {
        this.mark = a.lock > 0.5 && a.beats % 4 === 0 ? 1 : 0.6;
        this.markLeft = 0.08;
      }
    }

    /** One step of the pens (1 / RATE s), keeping where they are. */
    _step() {
      const dt = 1 / RATE;
      const t = this.age;
      for (let i = 0; i < this.pens; i += 1) {
        // The tremble's size: up at once, dying away; a kick on top, ringing down.
        const goal = this.goal[i] + this.kick[i] * 0.8;
        this.kick[i] *= Math.exp(-dt / 0.15);
        const k = goal > this.env[i] ? 30 : 3;
        this.env[i] += (goal - this.env[i]) * Math.min(1, dt * k);
        // Its shape: three waves about the pen's own rate, wandering, and a rough noise.
        const hz = 1.4 * 9 ** (this.pens > 1 ? i / (this.pens - 1) : 0);
        const wander = 1 + 0.3 * Math.sin(t * 0.7 + this.drift[i]) * Math.sin(t * 0.23 + this.drift[i] * 1.7);
        const [p1, p2, p3] = this.ph;
        p1[i] += 2 * Math.PI * hz * wander * dt;
        p2[i] += 2 * Math.PI * hz * 1.618 * (2 - wander) * dt;
        p3[i] += 2 * Math.PI * hz * 2.71 * dt;
        this.rough[i] += ((Math.random() - 0.5) * 2 - this.rough[i]) * Math.min(1, dt * hz * 12);
        const wave = 0.5 * Math.sin(p1[i]) + 0.3 * Math.sin(p2[i]) + 0.15 * Math.sin(p3[i]) + 0.35 * this.rough[i];
        // Where it is pulled: up to most of its lane each way, softly limited; a faint tremor always.
        const target = Math.tanh(this.env[i] * wave) * 0.9 + 0.012 * (Math.random() - 0.5);
        // A kick jolts it: a sharp spike before the swing.
        this.v[i] += this.spike[i] * 2 * Math.PI * 30 * 0.9;
        this.spike[i] = 0;
        this._pen(i, target, 30, 0.5, dt);
      }
      this.markLeft -= dt;
      this._pen(MAX_PENS, this.markLeft > 0 ? this.mark : 0, 45, 0.85, dt);
      for (let i = 0; i < this.pens; i += 1) this.trace[i][this.at] = this.y[i];
      this.trace[MAX_PENS][this.at] = this.y[MAX_PENS];
      this.at = (this.at + 1) % KEEP;
      this.count = Math.min(KEEP, this.count + 1);
    }

    /** Pen i pulled towards target: a little weight, swinging past and settling (hz its own rate, damping its share of critical). */
    _pen(i, target, hz, damping, dt) {
      // In four steps: in one, a stiff pen (the marker's) swings ever wider.
      const w = 2 * Math.PI * hz;
      const h = dt / 4;
      for (let s = 0; s < 4; s += 1) {
        this.v[i] += (w * w * (target - this.y[i]) - 2 * damping * w * this.v[i]) * h;
        this.y[i] += this.v[i] * h;
      }
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      const W = this.w;
      const H = this.h;
      const pens = Math.max(4, Math.min(MAX_PENS, Math.round(set('szPens')) || 8));
      if (pens !== this.pens) {
        // The traces start again: each would mean another part of the spectrum.
        this.pens = pens;
        for (const t of this.trace) t.fill(0);
        this.y.fill(0);
        this.v.fill(0);
        this.env.fill(0);
        this.kick.fill(0);
        this.spike.fill(0);
        this._labels(a);
      }
      this._listen(a, dt);
      const speed = PER_S * H * Math.max(0.5, (set('szSpeed') || 100) / 100);
      this.scroll = (this.scroll + speed * Math.min(dt, 0.25)) % 1e6;
      this.acc += Math.min(dt, 0.25) * RATE;
      while (this.acc >= 1) {
        this.acc -= 1;
        this.age += 1 / RATE;
        this._step();
      }
      for (let i = 0; i < pens; i += 1) this.leds[i] += (Math.min(1, this.env[i] * 1.4) - this.leds[i]) * Math.min(1, dt * 20);

      // Where things are, in pixels (y down).
      const top = H * (BODY + MARGIN + MARKER + 0.008);
      const lane = (H * (1 - BODY - MARGIN) - top) / pens;
      const major = lane / Math.max(1, Math.round(lane / (0.034 * H)));
      const penX = W - (HOUSING + ARM) * H;
      const markY = H * (BODY + MARGIN + MARKER * 0.8);   // the marker's line, low in its lane
      const laneY = (i) => (i === MAX_PENS ? markY : top + lane * (pens - 1 - i + 0.5));
      const reach = (i) => (i === MAX_PENS ? -MARKER * H * 0.55 : -lane * 0.62);
      const ink = (i) => {
        if (i === MAX_PENS) return BLACK;
        const c = set('szInk');
        if (c === 'black') return BLACK;
        if (c === 'custom') {
          const own = VizGL.rgb(set('szColor'));
          return own.map((v) => v * (i % 2 ? 0.7 : 0.95));
        }
        return INKS[i % INKS.length];
      };

      // The ink: each trace back from its pen to the paper's left edge.
      const spacing = speed / RATE;
      const stride = Math.max(1, Math.round(1.5 / spacing), Math.ceil(penX / spacing / 2400));
      const width = Math.max(0.8, (H / 1440) * 1.15);
      const lines = this.lines;
      for (const i of [...Array(pens).keys(), MAX_PENS]) {
        const tr = this.trace[i];
        const absorb = ink(i).map((v) => 1 - v);
        const base = laneY(i);
        const r = reach(i);
        let px = penX;
        let py = base + this.y[i] * r;
        for (let k = 0; k < this.count; k += stride) {
          const x = penX - (k + this.acc) * spacing;
          const y = base + tr[(this.at - 1 - k + KEEP * 2) % KEEP] * r;
          const slope = Math.abs(y - py) / Math.max(0.01, px - x);
          const al = Math.max(0.3, 0.9 / (1 + 0.05 * Math.max(0, slope - 1.5)));
          lines.seg(px, py, x, y, width, absorb, al);
          px = x;
          py = y;
          if (x < -4) break;
        }
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      VizGL.into(gl, this.ink);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      lines.draw(this.ink.w, this.ink.h);

      // The paper, the ink on it, the machine.
      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.ink, this.ink.tex, 0);
      VizGL.bind(gl, u.labels, this.labelTex, 1);
      gl.uniform2f(u.res, W, H);
      gl.uniform1f(u.scroll, this.scroll);
      gl.uniform1f(u.penX, penX);
      gl.uniform1f(u.laneTop, top);
      gl.uniform1f(u.lane, lane);
      gl.uniform1f(u.major, major);
      gl.uniform1f(u.wetPx, speed * 0.8);
      gl.uniform1f(u.time, this.age);
      gl.uniform1i(u.pens, pens);
      gl.uniform1i(u.paper, PAPERS[set('szPaper')] ?? 0);
      gl.uniform1fv(u.leds, this.leds);
      VizGL.screen(gl);

      // The pen arms, out of the machine to their tips: a shadow on the paper, the rod, a tip of ink.
      const hx = W - HOUSING * H;
      const rod = 0.0022 * H;
      const sh = 0.005 * H;
      for (const i of [...Array(pens).keys(), MAX_PENS]) {
        const y = laneY(i) + this.y[i] * reach(i);
        const from = laneY(i);
        lines.seg(penX + sh, y + sh * 1.4, hx, from + sh * 1.4, rod * 2, [0, 0, 0], 0.18);
        lines.seg(penX + 0.004 * H, y, hx + 2, from, rod, [0.5, 0.51, 0.53], 1);
        lines.seg(penX + 0.004 * H, y - rod * 0.3, hx + 2, from - rod * 0.3, rod * 0.4, [0.85, 0.86, 0.88], 0.9);
        lines.dot(penX + 0.009 * H, y, 0.0045 * H, [0.2, 0.2, 0.22], 1);
        lines.dot(penX + 0.009 * H, y, 0.0028 * H, ink(i).map((v) => Math.min(1, v * 1.3)), 1);
        lines.seg(penX, y, penX + 0.006 * H, y, 0.0012 * H, [0.15, 0.15, 0.17], 1);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      lines.draw(W, H);
      gl.disable(gl.BLEND);
    }
  }

  Visualizer.add({
    id: 'seismo',
    name: 'Seismograph',
    desc: "A chart recorder's pens trembling on paper running past, one for each part of the spectrum, kicked into swings by what jumps out, a marker ticking off the beats",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h3l1-3 2 6 1-3h3"/><path d="M2 16h2l2-5 2 9 2-7 1 3h1"/><path d="M15 4v16"/><path d="M15 8h6M15 16h6"/></svg>',
    gl: true,
    sharp: true,
    create: (canvas) => new Seismograph(canvas),
    options: [
      { type: 'choice', key: 'szPaper', label: 'Paper', choices: [['green', 'Green grid'], ['red', 'Red grid'], ['blue', 'Blue grid']] },
      { type: 'choice', key: 'szInk', label: 'Ink', choices: [['classic', 'A colour each'], ['black', 'Black']], color: { value: 'custom', key: 'szColor', presets: Visualizer.OWN_PRESETS } },
      { type: 'slider', key: 'szPens', label: 'Pens', min: 4, max: 12, step: 1, unit: '' },
      { type: 'slider', key: 'szSpeed', label: 'Paper speed', min: 50, max: 200, step: 10 },
    ],
  });
})();
