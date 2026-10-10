'use strict';

// Fountain Show: a row of lit water jets on a pool at night, the music's
// equalizer. Each jet is a band (by default the bass in the middle, the
// highs out to both sides) and rises as high as its band sounds: the water
// is thrown up and falls back under gravity, so a loud band leaves its spray
// hanging a moment and a mist drifting where it turned. The strong kicks
// fire the bass jets up as bursts, the stronger the higher, and as a big
// fountain's do, the higher ones climb and fall slower, their spray floating
// down. Where a jet's peak or a high burst comes down it sends rings across
// the pool, the higher it went the wider. Where the water lands it foams; the pool mirrors it
// all, rippling, each jet's lamp glowing under its foot.
//
// Its cogwheel: the lamps' colours (rainbow, by the chords, warm white,
// blue), where the bass is (the middle, the left), how many jets (spread
// evenly, the edges as far off as the jets are apart), the bursts' ripples.
//
// WebGL (viz/gl.js): the water is streaks of light drawn into a texture,
// blurred for the glow; the mist is soft round points drawn at half size
// and blurred; the
// sky, the far bank, the pool with its reflections and foam and the stone
// ledge in front in one pass over it all.

(() => {
  const MAX_DROPS = 9000;
  const MAX_MIST = 700;
  const MAX_JETS = 64;
  const FOAM_BINS = 160;
  const MAX_RIPPLES = 48;
  // Where the water is (from the top) and the front ledge's top, as parts of the height.
  const WATER = 0.76;
  const LEDGE = 0.045;

  const SHOW_FS = VizGL.NOISE + VizGL.STARS + `
    in vec2 uv;
    uniform sampler2D drops, glowA, glowB, mist, foam;
    uniform vec2 res;
    uniform float wl, ledge, time, boom;
    uniform vec3 ambient;
    uniform int n;
    uniform float jx[${MAX_JETS}], jl[${MAX_JETS}];
    uniform vec3 jc[${MAX_JETS}];
    // The ripples: x (uv), age (seconds), size 0..1 (how high the burst went), its jet.
    uniform int nr;
    uniform vec4 rips[${MAX_RIPPLES}];
    out vec4 o;

    // The top of the far bank: low wooded hills, a few roofs.
    float bank(float x) {
      float hill = fbm(vec2(x * 5.0 + 3.1, 1.7));
      float trees = vnoise(vec2(x * 70.0, 2.0)) * 0.009 + vnoise(vec2(x * 190.0, 5.0)) * 0.004;
      return wl + 0.008 + 0.05 * hill * hill + trees;
    }

    // The sky and the far bank at p (uv, above the water).
    vec3 sky(vec2 p) {
      vec3 col = mix(vec3(0.03, 0.035, 0.07), vec3(0.005, 0.007, 0.02), smoothstep(wl, 1.0, p.y));
      // A town's glow beyond the hills.
      col += vec3(0.05, 0.032, 0.03) * exp(-(p.y - wl) * 14.0);
      col += starField(vec2(p.x, p.y) * res, time, boom) * smoothstep(wl + 0.08, wl + 0.3, p.y);
      float b = bank(p.x);
      if (p.y < b) {
        col = vec3(0.007, 0.008, 0.013) + ambient * 0.012;
        // Lit windows, here and there.
        vec2 g = floor(vec2(p.x * res.x / 9.0, (p.y - wl) * res.y / 7.0));
        if (hash12(g + 4.2) > 0.97 && p.y < b - 0.006) {
          vec2 f = fract(vec2(p.x * res.x / 9.0, (p.y - wl) * res.y / 7.0)) - 0.5;
          col += vec3(1.0, 0.7, 0.4) * 0.35 * hash12(g + 1.3) * smoothstep(0.35, 0.15, max(abs(f.x), abs(f.y)));
        }
      }
      return col;
    }

    void main() {
      float aspect = res.x / res.y;
      vec3 col;
      if (uv.y >= wl) {
        col = sky(uv);
        col += texture(drops, uv).rgb + texture(glowA, uv).rgb * 0.8 + texture(glowB, uv).rgb * 1.3 + texture(mist, uv).rgb;
      } else {
        float d = wl - uv.y;
        // Ripples, smaller far off (by the line) and larger near.
        float z = 0.02 / (d + 0.004);
        vec2 w = vec2((uv.x - 0.5) * aspect * z, z) * 6.0;
        vec2 off = vec2(vnoise(w * vec2(1.0, 3.0) + vec2(0.0, time * 1.3)) - 0.5,
                        vnoise(w * vec2(1.3, 2.0) - vec2(time * 0.7, 0.0) + 7.0) - 0.5);
        off *= vec2(0.008, 0.012) * (0.15 + 6.0 * d);
        // The bursts' rings, flat ellipses running out from where they came
        // down: a train of crests behind the front, the water's slope there
        // bending the reflections out and back (as on Rainy Pond) and
        // tilting them towards the light and away, bright and dark in turn.
        float slope = 0.0;
        vec2 bend = vec2(0.0);
        vec3 ripc = vec3(0.0);
        for (int i = 0; i < ${MAX_RIPPLES}; i++) {
          if (i >= nr) break;
          vec4 R = rips[i];
          float t = R.y / (4.0 + 7.5 * R.z);
          if (t >= 1.0) continue;
          float rx = 0.01 + (0.12 + 1.3 * R.z) * pow(t, 0.75);
          float ry = rx * 0.3;
          vec2 q = vec2((uv.x - R.x) * aspect / rx, (d - ry * 0.6) / ry);
          float e = length(q);
          // The crests: about five across the ring's width, sharp enough to see however small.
          float k = min(30.0, 0.5 * ry * res.y);
          float env = smoothstep(1.04, 0.97, e) * smoothstep(0.15, 0.55, e) * exp(-clamp(1.0 - e, 0.0, 1.0) * 1.6);
          // Flatter as it spreads: the same water moved round an ever longer ring.
          float amp = (0.35 + 0.65 * R.z) * pow(1.0 - t, 1.5) * sqrt(0.15 / (0.15 + rx));
          float s = cos((1.0 - e) * k) * env * amp;
          slope += s;
          bend += s * q / max(e, 0.001) * vec2(rx * 0.16 / aspect, ry * 0.3);
          ripc += jc[int(R.w)] * max(0.0, s);
        }
        // Many rings crossing add up; a little less each, so the water stays water.
        off += bend / (1.0 + length(bend) / 0.02);
        slope = slope / (1.0 + abs(slope) * 0.7);
        vec2 r = vec2(uv.x + off.x, wl + d + off.y);
        vec3 refl = sky(r) * 0.75;
        refl += texture(drops, r).rgb * 0.55 + texture(glowA, r).rgb * 0.6 + texture(glowB, r).rgb * 0.9 + texture(mist, r).rgb * 0.7;
        // The water darker near, mirroring more far off.
        refl *= mix(0.9, 0.35, smoothstep(0.0, wl, d));
        refl *= clamp(1.0 + 1.2 * slope, 0.2, 2.4);
        col = vec3(0.004, 0.008, 0.016) + refl;
        // The crests catch the lamps.
        col += ripc * 0.06 + ambient * max(0.0, slope) * 0.08;
        // Each jet's lamp under the water, glowing at its foot.
        for (int i = 0; i < ${MAX_JETS}; i++) {
          if (i >= n) break;
          float dx = (uv.x - jx[i]) * aspect;
          float spread = 0.004 + 0.008 * jl[i];
          col += jc[i] * jl[i] * 0.35 * exp(-dx * dx / (spread * spread) - d * d / 0.00012);
        }
        // Foam where the water lands, along the line.
        float f = texture(foam, vec2(uv.x, 0.5)).r;
        float speckle = vnoise(vec2(uv.x * res.x * 0.12, d * res.y * 0.4 + time * 3.0));
        col += vec3(0.75, 0.8, 0.85) * 0.6 * min(1.2, f) * speckle * speckle * exp(-d * d / 0.00001);
        // The ledge's shadow on the water just behind it.
        col *= mix(0.4, 1.0, smoothstep(ledge, ledge + 0.02, uv.y));
      }
      // The stone ledge in front, its top lit by the lamps.
      if (uv.y < ledge) {
        float grain = vnoise(gl_FragCoord.xy * 0.15) * 0.5 + vnoise(gl_FragCoord.xy * 0.03) * 0.5;
        vec3 stone = vec3(0.028, 0.026, 0.025) * (0.7 + 0.6 * grain);
        // Joints between the slabs.
        stone *= mix(0.55, 1.0, smoothstep(0.0, 0.002, abs(fract(uv.x * aspect * 3.0) - 0.5) - 0.497));
        float top = smoothstep(ledge - 0.008, ledge, uv.y);
        col = stone + (ambient * 0.16 + vec3(0.02)) * top;
      }
      col = 1.0 - exp(-col * 1.35);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  // The mist: round points, soft all the way out.
  const MIST_VS = `
    layout(location = 0) in vec2 pos;
    layout(location = 1) in float size;
    layout(location = 2) in vec4 color;
    uniform vec2 res;
    uniform float scale, most;
    out vec4 c;
    void main() {
      c = color;
      gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
      gl_PointSize = min(most, size * scale);
    }`;
  const MIST_FS = `
    in vec4 c;
    out vec4 o;
    void main() {
      vec2 p = gl_PointCoord * 2.0 - 1.0;
      float d2 = dot(p, p);
      float f = exp(-d2 * 3.0) * (1.0 - smoothstep(0.6, 1.0, d2));
      o = vec4(c.rgb * c.a * f, c.a * f);
    }`;

  function hsv(h, s, v, out) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    out[0] = f(5);
    out[1] = f(3);
    out[2] = f(1);
    return out;
  }

  /** About normal, mean 0 and spread 1. */
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 2;

  class Fountain {
    constructor(canvas) {
      this.starShift = VizGL.starShift();
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.show = VizGL.program(gl, VizGL.SCREEN_VS, SHOW_FS);
      this.lines = VizGL.lines(gl, MAX_DROPS * 6 + 600);
      this.mistProg = VizGL.program(gl, MIST_VS, MIST_FS);
      this.mistBuf = VizGL.stream(gl, [[0, 2], [1, 1], [2, 4]], MAX_MIST);
      this.pointMax = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;
      this.ripples = [];
      // Rings on their way: a jet's peak rings the water when its water comes down.
      this.pending = [];
      this.foamTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.foamTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.foam = new Float32Array(FOAM_BINS);
      this.drops = [];
      this.mist = [];
      this.jets = [];
      this.layout = '';
      this.map = null;
      this.age = 0;
      this.lastBurst = -1;
      this.ambient = [0, 0, 0];
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.s, this.qa, this.qb, this.ea, this.eb, this.ma, this.mb]) VizGL.freeTarget(gl, t);
      const q = (d) => [Math.max(1, Math.round(w / d)), Math.max(1, Math.round(h / d))];
      this.s = VizGL.target(gl, w, h);
      this.qa = VizGL.target(gl, ...q(3));
      this.qb = VizGL.target(gl, ...q(3));
      this.ea = VizGL.target(gl, ...q(6));
      this.eb = VizGL.target(gl, ...q(6));
      this.ma = VizGL.target(gl, ...q(2));
      this.mb = VizGL.target(gl, ...q(2));
      // The water already in the air goes on from where it is; the jets move to their new places.
      this.layout = '';
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** The jets: where each stands, which part of the spectrum it shows, how high it is now. */
    _jets(a, count, layout) {
      const key = `${count}/${layout}/${this.w}`;
      if (key === this.layout) return;
      this.layout = key;
      const middle = layout === 'middle';
      const slots = middle ? Math.ceil(count / 2) : count;
      // Each slot's bands, 40 Hz to 14 kHz on a log axis (as Skyline's).
      this.map = [];
      for (let i = 0; i <= slots; i += 1) {
        const hz = 40 * (14000 / 40) ** (i / slots);
        this.map.push(Math.max(0, Math.min(a.BANDS, Math.round(Math.log(hz / a.MIN_HZ) / Math.log(a.MAX_HZ / a.MIN_HZ) * a.BANDS))));
      }
      const old = this.jets;
      this.jets = [];
      for (let j = 0; j < count; j += 1) {
        const slot = middle ? Math.floor(Math.abs(j - (count - 1) / 2)) : j;
        this.jets.push({
          x: ((j + 1) / (count + 1)) * this.w,
          slot,
          t: slot / Math.max(1, slots - 1),
          level: old[j] ? old[j].level : 0,
          rising: false, trough: 0, rang: -1,
          owed: Math.random(),
          flash: 0,
          rgb: [1, 1, 1],
        });
      }
    }

    frame(a, dt) {
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      const unit = this.h / 1080;
      const WL = this.h * WATER;
      const maxH = WL - this.h * 0.08;
      const g = 3900 * unit;
      this._jets(a, Math.max(4, Math.min(MAX_JETS, set('fnJets') | 0)), set('fnLayout'));
      const jets = this.jets;

      // Each slot's level, then each jet's, rising fast and sinking slower.
      const slots = this.map.length - 1;
      const levels = new Float32Array(slots);
      for (let k = 0; k < slots; k += 1) {
        const from = this.map[k];
        const to = Math.max(from + 1, this.map[k + 1]);
        let v = 0;
        for (let i = from; i < to; i += 1) v = Math.max(v, 0.35 * a.smooth[Math.min(a.BANDS - 1, i)] + 0.7 * a.dynamic[Math.min(a.BANDS - 1, i)]);
        // A band holding steady low down, what jumps out up high.
        levels[k] = Math.max(0, Math.min(1, (v - 0.3) / 0.7)) ** 1.3;
      }
      // The lamps' colours.
      const colors = set('fnColors');
      const chord = colors === 'notes' && a.playing ? a.noteHue() : null;
      if (chord) this.chordHue = this.chordHue === undefined ? chord.hue : this.chordHue + ((((chord.hue - this.chordHue + 1.5) % 1) - 0.5) * Math.min(1, dt * 3 * chord.strength));
      const amb = [0, 0, 0];
      for (const jet of jets) {
        const target = a.playing ? levels[jet.slot] : 0;
        const was = jet.level;
        jet.level += (target - jet.level) * Math.min(1, dt * (target > jet.level ? 18 : 5));
        // A peak: risen well above the dip before it, high enough, and now
        // turning. Its water rings the pool as it lands, the higher the wider.
        if (jet.level > was) {
          if (!jet.rising) jet.trough = was;
          jet.rising = true;
        } else if (jet.rising) {
          jet.rising = false;
          if (was > 0.7 && was - jet.trough > 0.2 && this.age - jet.rang > 0.9) {
            jet.rang = this.age;
            const flight = 2 * Math.sqrt((2 * maxH * (0.03 + 0.97 * was)) / g);
            this.pending.push({ at: this.age + flight, x: jet.x / this.w, high: was * 0.8, j: jets.indexOf(jet) });
          }
        }
        jet.flash *= Math.exp(-dt * 4);
        if (colors === 'white') hsv(0.09 - 0.03 * jet.t, 0.28, 1, jet.rgb);
        else if (colors === 'blue') hsv(0.6 - 0.1 * jet.t, 0.75 - 0.35 * jet.t, 1, jet.rgb);
        else if (colors === 'notes') hsv((((this.chordHue || 0.6) + 0.12 * (jet.t - 0.5)) % 1 + 1) % 1, 0.75, 1, jet.rgb);
        else hsv(0.82 * jet.t, 0.8, 1, jet.rgb);
        const lamp = (0.35 + 0.8 * jet.level + 0.5 * jet.flash) * (a.playing ? 1 : 0.45);
        jet.lamp = lamp;
        for (let c = 0; c < 3; c += 1) amb[c] += (jet.rgb[c] * lamp) / jets.length;
      }
      this.ambient = amb;

      // The water: each jet throws drops up as fast as reaches its height.
      const drops = this.drops;
      for (let j = 0; j < jets.length; j += 1) {
        const jet = jets[j];
        const height = maxH * (0.03 + 0.97 * jet.level);
        const v0 = Math.sqrt(2 * g * height);
        const width = unit * (1.5 + 2.2 * (1 - jet.t));
        jet.owed += dt * (60 + 40 * jet.level);
        while (jet.owed >= 1) {
          jet.owed -= 1;
          if (drops.length >= MAX_DROPS) continue;
          const d = {
            j, kind: 0, top: false,
            x: jet.x + gauss() * unit * 0.8,
            y: WL - unit,
            vx: gauss() * unit * (6 + 22 * jet.level),
            vy: -v0 * (1 + gauss() * 0.02),
            w: width,
          };
          // Born somewhere within this frame, so the stream has no gaps.
          const f = Math.random() * dt;
          d.x += d.vx * f;
          d.vy += g * f;
          d.y += d.vy * f;
          drops.push(d);
        }
      }
      // The bursts: a strong kick fires the bass jets up.
      const kicked = a.playing && (a.lock > 0.5 ? a.tick : a.onset) && a.beat > 0.25;
      if (kicked && this.age - this.lastBurst > 0.18) {
        this.lastBurst = this.age;
        // How high: a soft kick a quarter of the way, the strongest past the top.
        const high = 0.25 + 0.8 * Math.max(0, Math.min(1, (a.beat - 0.25) / 0.75));
        // A big fountain is slow: the higher it goes, the slower it climbs
        // and falls (as if seen from further off), its spray floating down
        // no faster than half the speed it left with.
        const gb = g * (0.75 - 0.4 * high);
        const v0 = Math.sqrt(2 * gb * maxH * high);
        // One burst for all the bass jets: its rings spread from between them.
        const fired = jets.filter((jet) => jet.slot <= 1);
        const burst = {
          x: fired.reduce((sum, jet) => sum + jet.x, 0) / Math.max(1, fired.length) / this.w,
          j: jets.indexOf(fired[0]), high, landed: 0, count: 0,
        };
        for (let j = 0; j < jets.length; j += 1) {
          const jet = jets[j];
          if (jet.slot > 1) continue;
          jet.flash = 1;
          for (let i = 0; i < 34 && drops.length < MAX_DROPS; i += 1) {
            const d = {
              j, kind: 1, top: false, burst,
              g: gb, vt: v0 * 0.5,
              x: jet.x + gauss() * unit * 3,
              y: WL - unit,
              vx: gauss() * unit * 38 * Math.sqrt(gb / g),
              vy: -v0 * (0.88 + 0.12 * Math.random()),
              w: unit * (2.5 + 2 * Math.random()),
            };
            // A gush over a tenth of a second, not one lump.
            const f = Math.random() * 0.1;
            d.x += d.vx * f;
            d.vy += gb * f;
            d.y += d.vy * f;
            drops.push(d);
            burst.count += 1;
          }
        }
      }
      for (const r of this.ripples) r.age += dt;
      if (set('fnRipples')) {
        for (const p of this.pending) {
          if (p.at <= this.age) this.ripples.push({ x: p.x, age: 0, high: p.high, j: p.j });
        }
      }
      this.pending = this.pending.filter((p) => p.at > this.age);
      while (this.ripples.length > MAX_RIPPLES) this.ripples.shift();
      this.ripples = this.ripples.filter((r) => r.age < 4.0 + 7.5 * r.high);

      // Moving the drops; where they land, foam and a little spray.
      const lines = this.lines;
      const mist = this.mist;
      const foam = this.foam;
      for (let k = 0; k < FOAM_BINS; k += 1) foam[k] *= Math.exp(-dt * 3);
      const STREAK = 0.03;
      let alive = 0;
      for (let i = 0; i < drops.length; i += 1) {
        const d = drops[i];
        // Falling, a burst's spray slows towards its terminal speed.
        const gg = d.g || g;
        if (d.vt && d.vy > 0) d.vy += gg * dt * Math.max(0, 1 - (d.vy / d.vt) ** 2);
        else d.vy += gg * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        const jet = jets[d.j];
        if (!jet) continue;
        if (!d.top && d.vy >= 0) {
          d.top = true;
          // Falling, the water opens out and breaks into drops.
          d.vx += gauss() * unit * (10 + 30 * jet.level);
          // Where the water turns, a loud jet leaves mist hanging.
          const chance = d.kind === 1 ? 0.12 : d.kind === 0 && jet.level > 0.55 ? 0.05 * jet.level : 0;
          if (Math.random() < chance && mist.length < MAX_MIST) {
            mist.push({
              j: d.j, x: d.x, y: d.y,
              vx: gauss() * unit * 12, vy: -unit * (4 + 8 * Math.random()),
              r: unit * (20 + 34 * Math.random()), life: 1, fade: 1 / (2.2 + 2 * Math.random()),
            });
          }
        }
        if (d.vy > 0 && d.y >= WL) {
          const bin = Math.max(0, Math.min(FOAM_BINS - 1, Math.floor((d.x / this.w) * FOAM_BINS)));
          // A burst coming down rings the water: once as it starts, again with the bulk of it.
          const b = d.burst;
          if (b) {
            b.landed += 1;
            // Only a burst gone most of the way up.
            if (set('fnRipples') && b.high >= 0.85 && (b.landed === 1 || b.landed === Math.round(b.count * 0.5))) {
              this.ripples.push({ x: b.x, age: 0, high: Math.min(1, b.landed === 1 ? b.high : b.high * 0.75), j: b.j });
              if (this.ripples.length > MAX_RIPPLES) this.ripples.shift();
            }
          }
          if (d.kind !== 2) {
            foam[bin] = Math.min(2, foam[bin] + (d.kind === 1 ? 0.06 : 0.025));
            if (Math.random() < 0.22 && drops.length < MAX_DROPS) {
              drops.push({
                j: d.j, kind: 2, top: true, x: d.x, y: WL - unit,
                vx: gauss() * unit * 40, vy: -unit * (50 + 110 * Math.random()), w: unit * 1.1,
              });
            }
          }
          continue;
        }
        drops[alive++] = d;
        // Lit from below: brightest near the lamp.
        const lit = jet.lamp * (0.35 + 0.65 * Math.exp(-(WL - d.y) / (0.8 * maxH)));
        // Falling as bright as rising: the lamps light the water both ways.
        const alpha = (d.kind === 2 ? 0.3 : 0.4) * lit;
        lines.seg(d.x - d.vx * STREAK, d.y - d.vy * STREAK, d.x, d.y, d.w, jet.rgb, alpha);
      }
      drops.length = alive;

      const gl = this.gl;
      gl.disable(gl.BLEND);
      VizGL.into(gl, this.s);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      lines.draw(this.w, this.h);

      // The mist: soft, slowly sinking and drifting, drawn at half size and blurred.
      const md = this.mistBuf.data;
      let kept = 0;
      for (let i = 0; i < mist.length; i += 1) {
        const m = mist[i];
        m.life -= m.fade * dt;
        if (m.life <= 0) continue;
        m.vy += unit * 7 * dt;
        m.x += (m.vx + unit * 8) * dt;
        m.y += m.vy * dt;
        m.r += unit * 10 * dt;
        const jet = jets[m.j] || jets[0];
        md.set([m.x, m.y, m.r * 2.4, jet.rgb[0], jet.rgb[1], jet.rgb[2], 0.05 * Math.sin(Math.PI * m.life) * Math.min(1, jet.lamp)], kept * 7);
        mist[kept++] = m;
      }
      mist.length = kept;
      gl.disable(gl.BLEND);
      VizGL.into(gl, this.ma);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (kept) {
        gl.enable(gl.BLEND);
        gl.useProgram(this.mistProg.p);
        gl.uniform2f(this.mistProg.u.res, this.w, this.h);
        gl.uniform1f(this.mistProg.u.scale, this.ma.w / this.w);
        gl.uniform1f(this.mistProg.u.most, this.pointMax);
        this.mistBuf.put(kept);
        gl.drawArrays(gl.POINTS, 0, kept);
        gl.bindVertexArray(null);
        gl.disable(gl.BLEND);
      }
      VizGL.blur(gl, this.ma, this.mb, this.ma, 1.5);

      // The glow of the water.
      VizGL.blur(gl, this.s, this.qa, this.qb, 1.3);
      VizGL.blur(gl, this.qb, this.ea, this.eb, 2.2);

      // The foam along the line, as a strip.
      for (const jet of jets) {
        const bin = Math.max(0, Math.min(FOAM_BINS - 1, Math.floor((jet.x / this.w) * FOAM_BINS)));
        foam[bin] = Math.min(2, foam[bin] + dt * (0.3 + 1.5 * jet.level));
      }
      gl.bindTexture(gl.TEXTURE_2D, this.foamTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, FOAM_BINS, 1, 0, gl.RED, gl.FLOAT, foam);

      // The sky, the water, the pool, the ledge.
      VizGL.into(gl, null);
      gl.useProgram(this.show.p);
      const u = this.show.u;
      VizGL.bind(gl, u.drops, this.s.tex, 0);
      VizGL.bind(gl, u.glowA, this.qb.tex, 1);
      VizGL.bind(gl, u.glowB, this.eb.tex, 2);
      VizGL.bind(gl, u.mist, this.ma.tex, 3);
      VizGL.bind(gl, u.foam, this.foamTex, 4);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.wl, 1 - WATER);
      gl.uniform1f(u.ledge, LEDGE);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.boom, a.kick);
      gl.uniform2f(u.starShift, ...this.starShift);
      gl.uniform3f(u.ambient, ...this.ambient);
      gl.uniform1i(u.n, jets.length);
      const jx = new Float32Array(MAX_JETS);
      const jl = new Float32Array(MAX_JETS);
      const jc = new Float32Array(MAX_JETS * 3);
      jets.forEach((jet, i) => {
        jx[i] = jet.x / this.w;
        jl[i] = jet.lamp;
        jc.set(jet.rgb, i * 3);
      });
      gl.uniform1fv(u.jx, jx);
      gl.uniform1fv(u.jl, jl);
      gl.uniform3fv(u.jc, jc);
      const rips = new Float32Array(MAX_RIPPLES * 4);
      this.ripples.forEach((r, i) => rips.set([r.x, r.age, r.high, Math.min(r.j, jets.length - 1)], i * 4));
      gl.uniform1i(u.nr, this.ripples.length);
      gl.uniform4fv(u.rips, rips);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'fountain',
    name: 'Fountain Show',
    desc: 'A row of lit water jets on a pool at night, each a band rising as high as it sounds, the bass jets bursting up on the kicks',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18M12 20V7M12 7c0-2 2-4 5-3M12 7c0-2-2-4-5-3M8 20c0-3-2-6-4-6M16 20c0-3 2-6 4-6"/></svg>',
    gl: true,
    create: (canvas) => new Fountain(canvas),
    options: [
      { type: 'choice', key: 'fnColors', label: 'Lights', choices: [['rainbow', 'Rainbow'], ['notes', 'By the chords'], ['white', 'Warm white'], ['blue', 'Blue']] },
      { type: 'choice', key: 'fnLayout', label: 'Bass', choices: [['middle', 'In the middle'], ['left', 'On the left']] },
      { type: 'slider', key: 'fnJets', label: 'Jets', min: 16, max: MAX_JETS, step: 4, unit: '' },
      { type: 'check', key: 'fnRipples', label: 'Ripples' },
    ],
  });
})();
