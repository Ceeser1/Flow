'use strict';

// Vinyl: a turntable seen from above, the song's cover as the record's
// label. The record turns once a bar (with a clear beat; at 33 without), so
// the beats line up into spokes; the stylus moves in with the song, from the
// rim at its start to the label at its end, and the grooves it has played
// keep the music: each place on them as bright as the music was when the
// stylus passed there, coloured by it (the bass warm, the highs cool). The
// light catches the grooves in two bright wedges, as on a real record.
// Round about: the platter's strobe dots, the tonearm and its shadow, the
// lamp, the speed buttons, a pitch fader that shows the tempo.
//
// Its cogwheel: the turntable (wood, black, silver), the grooves' colours
// (the music's, silver).
//
// WebGL (viz/gl.js): one pass. What has been played is kept in a texture
// round the record (across: the way round, down: from the rim in), a row
// for each groove, filled by the stylus as the record turns under it; the
// turntable is drawn round it.

(() => {
  const ANG = 1024;           // the played texture's size: round the record
  const ROWS = 512;           // and from the rim in
  const C = [-0.14, 0.0];     // the record's middle (screen heights from the screen's)
  const R_OUT = 0.388;        // where the music starts
  const R_IN = 0.15;          // and ends
  const PIVOT = [0.42, 0.29]; // the tonearm's pivot
  const ARM = 0.6;            // and its length
  const PLINTHS = { wood: 0, black: 1, silver: 2 };

  const FS = VizGL.NOISE + `
    in vec2 uv;
    uniform vec2 res;
    uniform sampler2D played, cover;
    uniform float rot, stylusR, time, level, lamp, pitch, armAng, onRecord;
    uniform vec2 tip;
    uniform int plinth;
    uniform bool mono;
    out vec4 o;

    const vec2 C = vec2(${C[0]}, ${C[1]});
    const vec2 PIVOT = vec2(${PIVOT[0]}, ${PIVOT[1]});
    const float R_OUT = ${R_OUT};
    const float R_IN = ${R_IN};
    const float PI = 3.14159265;

    float box(vec2 p, vec2 c, vec2 h, float r) {
      vec2 d = abs(p - c) - h + r;
      return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
    }

    // A segment's distance.
    float seg(vec2 p, vec2 a, vec2 b) {
      vec2 pa = p - a, ba = b - a;
      return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
    }

    vec3 plinthColour(vec2 s) {
      // Away from the origin: the noise's hash differs below zero.
      s += vec2(13.7, 11.3);
      if (plinth == 0) {
        float g = vnoise(vec2(s.x * 4.0, s.y * 90.0 + vnoise(s * 6.0) * 6.0));
        return mix(vec3(0.16, 0.08, 0.035), vec3(0.3, 0.16, 0.07), g);
      }
      float brushed = vnoise(vec2(s.x * 600.0, s.y * 3.0)) * 0.5 + vnoise(vec2(s.x * 2000.0, s.y * 9.0)) * 0.5;
      if (plinth == 1) return vec3(0.045, 0.045, 0.05) + 0.02 * brushed;
      return vec3(0.42, 0.43, 0.45) + 0.08 * brushed;
    }

    // The tonearm: the tube from the pivot to the head, the counterweight
    // behind; how much of it covers s (x), and its shade (y).
    vec2 tonearm(vec2 s) {
      vec2 dir = normalize(tip - PIVOT);
      vec2 head = tip - dir * 0.012;
      vec2 bend = PIVOT + (head - PIVOT) * 0.82;
      vec2 n = vec2(-dir.y, dir.x);
      float tube = min(seg(s, PIVOT, bend), seg(s, bend, head - n * 0.0)) - 0.0065;
      float weight = seg(s, PIVOT - dir * 0.03, PIVOT - dir * 0.075) - 0.017;
      float base = length(s - PIVOT) - 0.028;
      // The headshell: a small block round the tip.
      vec2 q = vec2(dot(s - tip, dir), dot(s - tip, n));
      float shell = box(q, vec2(-0.006, 0.0), vec2(0.022, 0.011), 0.003);
      float d = min(min(tube, weight), min(base, shell));
      float px = 1.2 / res.y;
      float a = 1.0 - smoothstep(-px, px, d);
      // Round: lighter along its middle.
      float shade = 0.6 + 0.4 * smoothstep(0.0, -0.006, d);
      if (base < 0.0) shade *= 0.8 + 0.2 * smoothstep(0.028, 0.0, length(s - PIVOT));
      return vec2(a, shade);
    }

    void main() {
      float aspect = res.x / res.y;
      vec2 s = (uv - 0.5) * vec2(aspect, 1.0);
      float px = 1.2 / res.y;
      // The lamp from the top left.
      float light = 0.75 + 0.35 * dot(normalize(vec2(-0.6, 0.8)), s);

      // The room under it, and the turntable.
      vec3 col = vec3(0.01, 0.009, 0.008) * (1.0 - 0.5 * length(s));
      float hw = min(0.82, aspect * 0.5 - 0.04);
      float pl = box(s, vec2(0.0), vec2(hw, 0.47), 0.03);
      // Its shadow on the table.
      col *= 0.4 + 0.6 * smoothstep(-0.01, 0.05, box(s - vec2(0.012, -0.018), vec2(0.0), vec2(hw, 0.47), 0.03));
      if (pl < 0.0) {
        col = plinthColour(s) * light;
        // A bevel catching the light.
        col *= 1.0 + 0.4 * smoothstep(0.006, 0.0, abs(pl + 0.006)) * mix(-0.6, 1.0, smoothstep(-0.35, 0.35, s.y - s.x * 0.4));
      }

      // The controls: the power lamp, 33 and 45, the pitch fader, the strobe's light.
      vec2 btn = vec2(-hw + 0.08, -0.4);
      float b33 = box(s, btn, vec2(0.03, 0.014), 0.004);
      float b45 = box(s, btn + vec2(0.075, 0.0), vec2(0.03, 0.014), 0.004);
      if (min(b33, b45) < 0.0) col = vec3(0.06, 0.06, 0.065) * light * (b33 < 0.0 ? 0.7 : 1.0);
      vec2 power = vec2(-hw + 0.05, 0.42);
      col += vec3(1.0, 0.1, 0.05) * (smoothstep(0.007, 0.004, length(s - power)) * 1.5 + exp(-length(s - power) * 90.0) * 0.4);
      vec2 fader = vec2(hw - 0.07, -0.18);
      float slot = box(s, fader, vec2(0.004, 0.17), 0.002);
      if (slot < 0.0) col = vec3(0.005);
      float marks = step(abs(s.x - fader.x - 0.022), 0.006) * step(abs(fract((s.y - fader.y) / 0.034) - 0.5), 0.06) * step(abs(s.y - fader.y), 0.17);
      col = mix(col, vec3(0.6) * light, marks);
      float knob = box(s, fader + vec2(0.0, clamp(pitch, -1.0, 1.0) * 0.15), vec2(0.022, 0.011), 0.003);
      if (knob < 0.0) col = vec3(0.12, 0.12, 0.13) * light * (0.8 + 0.4 * smoothstep(0.011, -0.011, s.y - fader.y - pitch * 0.15));
      // The strobe's little lamp by the platter.
      vec2 strobe = C + vec2(-0.3, -0.36);
      col += vec3(1.0, 0.2, 0.1) * exp(-length(s - strobe) * 120.0) * 0.6;

      // The platter: its rim with the strobe dots, standing still at the right speed.
      vec2 p = s - C;
      float r = length(p);
      float ang = atan(p.y, p.x);
      float ra = ang - rot;
      if (r < 0.43) {
        float rimLight = 0.5 + 0.5 * cos(ang - 2.2);
        col = vec3(0.4, 0.41, 0.43) * (0.45 + 0.6 * rimLight) * light;
        float dots = step(abs(fract(ra / (2.0 * PI) * 90.0) - 0.5), 0.22) * step(0.412, r) * step(r, 0.424);
        col *= 1.0 - 0.6 * dots;
        col = mix(col, vec3(0.6, 0.15, 0.1) * dots, 0.15 * dots);
        col *= smoothstep(0.43, 0.428, r);
      }
      // The record.
      if (r < 0.405) {
        float a = smoothstep(0.405, 0.405 - px, r);
        vec3 rc = vec3(0.018, 0.018, 0.02);
        // The grooves, a fine pattern of rings; the lead-in and run-out plain.
        float rings = vnoise(vec2(r * 1400.0, 0.5));
        float grooved = step(R_IN - 0.004, r) * step(r, R_OUT + 0.004);
        rc *= 0.8 + 0.4 * rings * grooved;
        // The light in the grooves: two wedges, towards the lamp and away.
        float sheen = pow(abs(cos(ang - 2.25)), 40.0) * 0.6 + pow(abs(cos(ang - 2.25)), 6.0) * 0.06;
        sheen *= 0.7 + 0.6 * rings;
        vec3 sc = vec3(0.75, 0.78, 0.85);
        // Where the stylus has been: the music.
        if (grooved > 0.0 && r > stylusR) {
          vec2 t = vec2(fract(ra / (2.0 * PI)), clamp((R_OUT - r) / (R_OUT - R_IN), 0.0, 1.0));
          vec4 m = texture(played, t);
          if (m.a > 0.0) {
            float lv = m.r;
            vec3 hue = mono ? vec3(0.8, 0.82, 0.88) : mix(vec3(1.0, 0.35, 0.12), vec3(0.25, 0.55, 1.0), smoothstep(0.2, 0.7, m.b / (m.g + m.b + 0.02)));
            rc += hue * lv * 0.3;
            sc = mix(sc, hue, mono ? 0.0 : 0.6) * (0.4 + 1.4 * lv);
          }
        }
        rc += sc * sheen * grooved;
        // The raised edge and the run-out's gloss.
        rc += vec3(0.25) * smoothstep(0.003, 0.0, abs(r - 0.4)) * 0.3 * light;
        rc += vec3(0.6) * sheen * (1.0 - grooved) * step(r, R_IN) * 0.6;
        col = mix(col, rc, a);
      }
      // The label: the song's cover, turning; the spindle.
      if (r < 0.13) {
        vec2 q = vec2(cos(-rot) * p.x - sin(-rot) * p.y, sin(-rot) * p.x + cos(-rot) * p.y) / 0.26 + 0.5;
        vec3 lc = textureLod(cover, vec2(q.x, 1.0 - q.y), 0.5).rgb;
        lc *= 0.85 + 0.15 * light;
        col = mix(col, lc, smoothstep(0.13, 0.13 - px, r));
        float hole = smoothstep(0.009, 0.008, r);
        col = mix(col, vec3(0.55, 0.56, 0.6) * (0.6 + 0.6 * smoothstep(0.009, 0.0, length(p - vec2(-0.003, 0.003)))), hole);
      }

      // The tonearm's shadow, then the arm.
      vec2 sh = tonearm(s - vec2(0.012, -0.016));
      col *= 1.0 - 0.55 * sh.x;
      vec2 arm = tonearm(s);
      vec3 metal = plinth == 1 ? vec3(0.15, 0.15, 0.16) : vec3(0.62, 0.63, 0.66);
      col = mix(col, metal * arm.y * light, arm.x);
      // The stylus's tiny lamp on the headshell? No: a glint where it touches.
      col += vec3(1.0, 0.95, 0.85) * exp(-length(s - tip) * 400.0) * onRecord * (0.2 + 0.6 * level);

      col = 1.0 - exp(-col * 1.5);
      col += (hash12(gl_FragCoord.xy + time) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  class Vinyl {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.prog = VizGL.program(gl, VizGL.SCREEN_VS, FS);
      this.cover = new VizCover(gl, { standIn: 'record' });
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ANG, ROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.row = new Uint8Array(ANG * 4);
      this._clear();
      this.age = 0;
      this.rot = Math.random() * Math.PI * 2;
      this.lastCol = null;
      this.lastRow = null;
      this.armR = null;
      this.level = 0;
      this.bass = 0;
      this.treble = 0;
      this.pitch = 0;
      this.w = 1;
      this.h = 1;
    }

    _clear() {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ANG, ROWS, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(ANG * ROWS * 4));
      this.rows = new Map();
      this.lastCol = null;
      this.lastRow = null;
    }

    size(w, h) {
      this.w = w;
      this.h = h;
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    /** The texture's row `r` (kept here as written so far), with columns from..to (going down, round) set to v. */
    _write(r, from, to, v) {
      let data = this.rows.get(r);
      if (!data) {
        data = new Uint8Array(ANG * 4);
        this.rows.set(r, data);
      }
      let c = from;
      for (let n = 0; n < ANG; n += 1) {
        data.set(v, c * 4);
        if (c === to) break;
        c = (c - 1 + ANG) % ANG;
      }
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, ANG, 1, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    frame(a, dt) {
      const gl = this.gl;
      const set = (k) => Visualizer.setting(k);
      this.age += dt;
      if (this.cover.update()) this._clear();
      const playing = a.playing;
      // Once a bar with a clear beat, else 33 a minute; slowing to a stop when paused.
      const perTurn = a.lock > 0.5 && a.bpm ? (4 * 60) / a.bpm : 60 / 33.3;
      this.speed = this.speed === undefined ? 0 : this.speed;
      const speed = playing ? (Math.PI * 2) / perTurn : 0;
      this.speed += (speed - this.speed) * Math.min(1, dt * (playing ? 3 : 1.2));
      this.rot += this.speed * dt;
      this.level += ((playing ? a.level : 0) - this.level) * Math.min(1, dt * 12);
      this.bass += ((playing ? a.bass : 0) - this.bass) * Math.min(1, dt * 12);
      this.treble += ((playing ? a.treble : 0) - this.treble) * Math.min(1, dt * 12);
      // The fader shows the tempo: 120 in the middle, 90 and 150 at its ends.
      const pitch = a.bpm && a.sure > 0.3 ? (a.bpm - 120) / 30 : 0;
      this.pitch += (pitch - this.pitch) * Math.min(1, dt * 2);

      // Where the stylus is: the song's share played, from the rim in.
      const dur = Player.duration || 0;
      const pos = Player.position || 0;
      const share = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;
      const target = Player.currentId ? R_OUT - share * (R_OUT - R_IN) : 0.47;
      this.armR = this.armR === null ? target : this.armR + (target - this.armR) * Math.min(1, dt * 3);
      const onRecord = this.armR < 0.4 ? 1 : 0;
      // The tip: where a circle round the pivot (the arm) meets one round the record's middle.
      const dx = C[0] - PIVOT[0];
      const dy = C[1] - PIVOT[1];
      const dd = Math.hypot(dx, dy);
      const rr = Math.min(this.armR, dd + ARM - 0.001);
      const along = (ARM * ARM - rr * rr + dd * dd) / (2 * dd);
      const across = Math.sqrt(Math.max(0, ARM * ARM - along * along));
      const ux = dx / dd;
      const uy = dy / dd;
      const tip = [PIVOT[0] + ux * along + uy * across, PIVOT[1] + uy * along - ux * across];

      // Writing the music into the groove under the stylus.
      if (playing && onRecord && this.armR <= R_OUT && this.armR >= R_IN) {
        const ang = Math.atan2(tip[1] - C[1], tip[0] - C[0]) - this.rot;
        const col = Math.floor((((ang / (Math.PI * 2)) % 1) + 1) % 1 * ANG) % ANG;
        const row = Math.min(ROWS - 1, Math.floor(((R_OUT - this.armR) / (R_OUT - R_IN)) * ROWS));
        const v = [Math.min(255, this.level * 255 * 1.6), Math.min(255, this.bass * 255), Math.min(255, this.treble * 255 * 1.5), 255];
        const from = this.lastCol === null || this.lastRow === null || Math.abs(row - this.lastRow) > 3 ? col : this.lastCol;
        // The rows between the last and this one too, so the rings have no gaps.
        const r0 = this.lastRow === null || Math.abs(row - this.lastRow) > 3 ? row : Math.min(row, this.lastRow);
        for (let r = r0; r <= row; r += 1) this._write(r, from, col, v);
        this.lastCol = col;
        this.lastRow = row;
      } else {
        this.lastCol = null;
      }

      gl.disable(gl.BLEND);
      VizGL.into(gl, null);
      gl.useProgram(this.prog.p);
      const u = this.prog.u;
      VizGL.bind(gl, u.played, this.tex, 0);
      VizGL.bind(gl, u.cover, this.cover.tex, 1);
      gl.uniform2f(u.res, this.w, this.h);
      gl.uniform1f(u.rot, this.rot);
      gl.uniform1f(u.stylusR, this.armR);
      gl.uniform1f(u.time, this.age);
      gl.uniform1f(u.level, this.level);
      gl.uniform1f(u.pitch, this.pitch);
      gl.uniform1f(u.onRecord, onRecord);
      gl.uniform2f(u.tip, tip[0], tip[1]);
      gl.uniform1i(u.plinth, PLINTHS[set('vnPlinth')] ?? 0);
      gl.uniform1i(u.mono, set('vnColors') === 'silver' ? 1 : 0);
      VizGL.screen(gl);
    }
  }

  Visualizer.add({
    id: 'vinyl',
    name: 'Vinyl',
    desc: "A record turning once a bar, the song's cover as its label, the grooves the stylus has played keeping the music in rings of light",
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="12" r="8"/><circle cx="10" cy="12" r="2.5"/><path d="M20 3l-4 9-3 1"/></svg>',
    gl: true,
    create: (canvas) => new Vinyl(canvas),
    options: [
      { type: 'choice', key: 'vnPlinth', label: 'Turntable', choices: [['wood', 'Wood'], ['black', 'Black'], ['silver', 'Silver']] },
      { type: 'choice', key: 'vnColors', label: 'Grooves', choices: [['music', "The music's colours"], ['silver', 'Silver']] },
    ],
  });
})();
