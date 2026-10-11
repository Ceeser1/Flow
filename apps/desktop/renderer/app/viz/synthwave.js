'use strict';

// Synthwave: the wireframe landscape (landscape.js) at full screen, its
// mountains filled dark, under a purple sky with stars and a sun sitting in
// the valley's gap, seen from a ship whose nose shows at the bottom. It flies
// in time with the beat (VizAudio's tempo), or pushed on by the kicks while
// there is no clear beat; the kicks make the grid and the sun glow. The car
// rides the floor's bumps: the camera bobs, and the world and the nose tilt.
//
// Its cogwheel: the wireframe's colour, how fast it flies, the floor's bumps,
// and the camera bobbing, the camera tilting and the car tilting on them.
//
// WebGL (viz/gl.js). The terrain is a grid of heights (a texture, refilled
// each frame) drawn in two passes into a texture of its own: first each
// strip between two rows filled dark, nearest first, each strip a step
// further back in the depth buffer, so a strip hidden behind nearer ones
// costs nothing; then the lines, farthest first, each strip's over its own
// fill and behind any nearer strip, as Canvas 2D drew them strip by strip
// from the horizon forwards. Its glow is that texture blurred at a quarter
// of the size. One pass over the screen then draws the sky, the stars, the
// sun and its haze, the glow, the terrain, the band of light along the
// horizon and the ship's nose (drawn once a size, in Canvas 2D).

(() => {
  const SPEED = 4.7;      // cells per second while a song plays (times Speed in its cogwheel)
  const IDLE = 0.25;      // and this much of it while paused
  const KICK_SPEED = 1.4; // a full kick adds this much of SPEED (no clear beat)
  const BEAT_SPEED = 7.4; // with a clear beat: cells a second at 120 BPM (what the kicks averaged)
  const SURGE = 0.2;      // and how much faster just after each beat, slower between
  const ROWS = 52;        // how far ahead it is drawn
  const COLS = 64;        // each side of the middle
  const FLOOR = 3.5;      // half the valley floor's width
  const CAM_H = 1.1;      // the eye above the floor
  const HORIZON = 0.5;    // of the screen's height
  const FOCAL = 0.5;      // the lens: a cell one ahead is this share of the width
  const BUMPS = 0.14;     // the floor's bumps at the most intense music, in cells
  const BUMPS_KICK = 0.8; // a full kick lifts them by this much more, a calm beat less
  const RIDE_MS = 70;     // how fast the car follows the bumps under it
  const LIFT = 0.536;     // how much of a bump lifts the eye
  const PITCH = 0.235;    // how much the nose tips up as the ground rises ahead
  const ROLL = 0.35;      // radians the car leans per cell one side stands higher
  const ROLL_MS = 110;    // and how fast, a little slower than the bumps, a wobble
  const ROLL_MAX = 0.04;  // and at most (radians)
  const ROLL_EYE = 0.75;  // how much of the lean the world tilts (the eye following it)
  const ROLL_NOSE = 1.125; // and the nose the other way, more, so the car is seen to rock
  const GLOW = 0.8;       // how strongly the blurred terrain is added
  // The wireframe colours offered under the picker; the first is the default.
  const PRESETS = ['#9f38fa', '#00e5ff', '#ff2bd6', '#39ff14', '#ffb000', '#ff3030', '#ffffff'];

  // What both terrain passes share: where a point of the grid lands on the
  // screen (pixels, y down), and each strip's place in the depth buffer.
  const TERRAIN = `
    uniform sampler2D heights;  // a row of the grid a line, ring[0] first
    uniform vec2 res;
    uniform float hy, focal, camH, frac, cols, end, angle;
    float depthOf(float row) { return row + 1.0 - frac; }
    vec2 place(float j, float row) {
      float z = depthOf(row);
      float h = texelFetch(heights, ivec2(int(j), int(row)), 0).r;
      vec2 p = vec2(res.x * 0.5 + (j - cols) / z * focal, hy + (camH - h) / z * focal);
      // Tilted with the world, about the middle of the screen's bottom edge.
      vec2 q = p - vec2(res.x * 0.5, res.y);
      float c = cos(angle), s = sin(angle);
      return vec2(q.x * c - q.y * s, q.x * s + q.y * c) + vec2(res.x * 0.5, res.y);
    }
    // Strip s (between rows s and s + 1): the nearer, the further in front.
    vec4 clip(vec2 p, float s) {
      return vec4(p.x / res.x * 2.0 - 1.0, 1.0 - p.y / res.y * 2.0, (s + 0.5) / end * 2.0 - 1.0, 1.0);
    }
    vec3 hsl(float h, float s, float l) {
      vec3 k = mod(vec3(0.0, 8.0, 4.0) + h / 30.0, 12.0);
      return l - s * min(l, 1.0 - l) * max(min(min(k - 3.0, 9.0 - k), 1.0), -1.0);
    }`;

  // A cell of a strip as two triangles, its fill darker near, lighter far.
  const FILL_VS = TERRAIN + `
    layout(location = 0) in vec2 cell;  // column j, strip s
    flat out vec3 color;
    void main() {
      float s = cell.y;
      if (depthOf(s) < 0.3) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      // far j, far j+1, near j+1 and far j, near j+1, near j
      int v = gl_VertexID;
      float dj = (v == 1 || v == 2 || v == 4) ? 1.0 : 0.0;
      float dr = (v == 0 || v == 1 || v == 3) ? 1.0 : 0.0;
      gl_Position = clip(place(cell.x + dj, s + dr), s);
      color = hsl(236.0, 0.75, (6.0 + 10.0 * depthOf(s + 1.0) / end) / 100.0);
    }`;

  const FILL_FS = `
    flat in vec3 color;
    out vec4 o;
    void main() {
      o = vec4(color, 1.0);
    }`;

  // A strip's line: its far row's from column j to j + 1 (kind 1), or the
  // one running towards you at j (kind 0); a quad a pixel wider than the
  // line each way, for its soft edge. The colour (by default violet near,
  // blue further on) and the width by depth, fading into the distance so
  // new rows come in softly. Kinds 2 and 3 are the same in the strip's own
  // fill colour, a pixel wide, drawn before its lines: the fill's soft edge
  // (the fill itself is hard-edged), which shows where a line has faded.
  const LINE_VS = TERRAIN + `
    layout(location = 0) in vec3 seg;  // column j, strip s, kind
    uniform vec3 line;                 // hue, saturation, lightness (0..100)
    uniform float drift, kick;
    flat out vec4 color;
    flat out float width;
    out float across;
    void main() {
      float s = seg.y;
      if (depthOf(s) < 0.3) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        return;
      }
      bool edge = seg.z > 1.5;
      bool row = mod(seg.z, 2.0) > 0.5;
      vec2 a = place(seg.x, s + 1.0);
      vec2 b = row ? place(seg.x + 1.0, s + 1.0) : place(seg.x, s);
      float d = depthOf(s + 1.0) / end;  // 0 near, 1 at the horizon
      width = edge ? 1.0 : 0.8 + 1.6 * (1.0 - d) * (1.0 - d);
      float hw = max(width, 1.0) * 0.5 + 1.0;
      vec2 dir = b - a;
      float len = length(dir);
      dir = len > 0.0 ? dir / len : vec2(1.0, 0.0);
      // The far rows' pieces reach a little past their ends, so where the
      // row bends no notch is left.
      float ext = row ? width * 0.5 : 0.0;
      int v = gl_VertexID;
      float e = (v == 2 || v == 4 || v == 5) ? 1.0 : 0.0;
      float side = (v == 0 || v == 3 || v == 5) ? -1.0 : 1.0;
      across = side * hw;
      vec2 p = mix(a, b, e) + dir * (e * 2.0 - 1.0) * ext + vec2(-dir.y, dir.x) * across;
      gl_Position = clip(p, s);
      if (edge) {
        color = vec4(hsl(236.0, 0.75, (6.0 + 10.0 * d) / 100.0), 1.0);
        return;
      }
      float fog = min(1.0, (1.0 - d) / 0.35) * (0.55 + 0.45 * (1.0 - d));
      float light = clamp(line.z - 4.0 + 8.0 * (1.0 - d) + 22.0 * kick, 0.0, max(85.0, line.z));
      float alpha = min(1.0, fog);
      color = vec4(hsl(line.x - drift * sqrt(d), line.y / 100.0, light / 100.0) * alpha, alpha);
    }`;

  const LINE_FS = `
    flat in vec4 color;
    flat in float width;
    in float across;
    out vec4 o;
    void main() {
      float w = max(width, 1.0);
      o = color * clamp(w * 0.5 + 0.5 - abs(across), 0.0, 1.0) * min(width, 1.0);
    }`;

  // The picture: everything but the terrain worked out here, in the frame
  // the world is tilted to (the ship's nose in its own), as Canvas 2D drew it.
  const VIEW_FS = VizGL.NOISE + `
    in vec2 uv;
    uniform sampler2D terrain, glow, ship;
    uniform vec2 res;
    uniform float hy, angle, shipAngle, kick, glowAmount, time, pad;
    uniform vec2 shipBox;  // the ship's texture: its top and height, pixels
    out vec4 o;
    vec3 rgb(float r, float g, float b) { return vec3(r, g, b) / 255.0; }
    vec2 turn(vec2 p, float a) {
      vec2 q = p - vec2(res.x * 0.5, res.y);
      float c = cos(a), s = sin(a);
      return vec2(q.x * c - q.y * s, q.x * s + q.y * c) + vec2(res.x * 0.5, res.y);
    }
    void main() {
      vec2 q = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
      vec2 p = turn(q, -angle);
      // Under it all the floor's colour, for the corners the tilt uncovers.
      vec3 col = vec3(0.0105, 0.0177, 0.105);
      if (p.y < res.y - pad && p.x > -pad && p.x < res.x + pad) {
        // The sky, deep purple to magenta at the horizon.
        float t = clamp(p.y / hy, 0.0, 1.0);
        col = t < 0.5 ? mix(rgb(18.0, 0.0, 42.0), rgb(74.0, 10.0, 94.0), t * 2.0)
                      : mix(rgb(74.0, 10.0, 94.0), rgb(176.0, 21.0, 122.0), t * 2.0 - 1.0);
        // Stars, each in a cell of its own, more of them higher up,
        // twinkling, fading towards the horizon.
        vec2 sp = vec2(p.x / res.x, p.y / (0.85 * hy));
        if (sp.x >= 0.0 && sp.x < 1.0 && sp.y >= 0.0 && sp.y < 1.0) {
          vec2 grid = vec2(32.0, 10.0);
          vec2 cell = floor(sp * grid);
          float chance = 0.5 * 0.625 * pow(max((cell.y + 0.5) / grid.y, 0.02), -0.375);
          if (hash12(cell + 17.0) < chance) {
            vec2 at = (cell + 0.15 + 0.7 * vec2(hash12(cell + 41.0), hash12(cell + 73.0))) / grid * vec2(res.x, 0.85 * hy);
            float r = 0.5 + 1.3 * hash12(cell + 97.0);
            float tw = 0.55 + 0.45 * sin(time * (0.5 + 2.0 * hash12(cell + 131.0)) + 6.3 * hash12(cell + 163.0));
            col = mix(col, vec3(1.0), clamp(r + 0.5 - length(p - at), 0.0, 1.0) * tw * (1.0 - at.y / hy));
          }
        }
        // The sun, pink at the top to orange at the bottom, sitting on the
        // horizon; its haze swells on the kicks.
        float r = res.y * 0.22;
        vec2 sun = vec2(res.x * 0.5, hy - r * 0.62);
        float d = length(p - sun);
        if (p.y < hy && p.y > -pad) {
          float h = clamp((d - r * 0.8) / (r * (2.2 + 0.6 * kick) - r * 0.8), 0.0, 1.0);
          col = mix(col, rgb(255.0, 60.0, 140.0), (0.45 + 0.35 * kick) * (1.0 - h));
        }
        float s = clamp((p.y - sun.y + r) / (2.0 * r), 0.0, 1.0);
        vec3 face = s < 0.55 ? mix(rgb(255.0, 31.0, 110.0), rgb(255.0, 61.0, 139.0), s / 0.55)
                             : mix(rgb(255.0, 61.0, 139.0), rgb(255.0, 179.0, 71.0), (s - 0.55) / 0.45);
        col = mix(col, face, clamp(r + 0.5 - d, 0.0, 1.0));
      }
      // The terrain over its glow.
      vec4 land = texture(terrain, uv);
      col = min(col + texture(glow, uv).rgb * glowAmount, 1.0) * (1.0 - land.a) + land.rgb;
      // Where the valley meets the sky, a band of light.
      float b = (p.y - (hy - res.y * 0.04)) / (res.y * 0.07);
      if (b > 0.0 && b < 1.0) {
        float a = (0.25 + 0.25 * kick) * (b < 0.6 ? b / 0.6 : (1.0 - b) / 0.4);
        vec3 c = b < 0.6 ? mix(rgb(255.0, 90.0, 170.0), rgb(255.0, 110.0, 190.0), b / 0.6)
                         : mix(rgb(255.0, 110.0, 190.0), rgb(255.0, 90.0, 170.0), (b - 0.6) / 0.4);
        col = min(col + c * a, 1.0);
      }
      // The ship's nose, leaning its own way.
      vec2 n = turn(q, -shipAngle);
      vec2 st = vec2(n.x / res.x, (n.y - shipBox.x) / shipBox.y);
      if (st.y > 0.0 && st.y < 1.0 && st.x > 0.0 && st.x < 1.0) {
        vec4 hull = texture(ship, st);
        col = col * (1.0 - hull.a) + hull.rgb;
      }
      col += (hash12(gl_FragCoord.xy + fract(time) * 100.0) - 0.5) / 255.0;
      o = vec4(col, 1.0);
    }`;

  /** The ship's nose at the bottom of a w x h screen, onto ctx. */
  function drawShip(ctx, w, hgt) {
    const cx = w / 2;
    const top = hgt * 0.86;
    const half = Math.min(w * 0.16, hgt * 0.3);
    // Down past the screen's edge, so leaning it uncovers nothing.
    const bottom = hgt * 1.05;
    const hull = ctx.createLinearGradient(0, top, 0, hgt);
    hull.addColorStop(0, '#f4f6ff');
    hull.addColorStop(0.35, '#c9d0e6');
    hull.addColorStop(1, '#6f7894');
    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.moveTo(cx - half, top + hgt * 0.02);
    ctx.quadraticCurveTo(cx, top - hgt * 0.012, cx + half, top + hgt * 0.02);
    ctx.lineTo(cx + half * 1.3, bottom);
    ctx.lineTo(cx - half * 1.3, bottom);
    ctx.closePath();
    ctx.fill();

    // The canopy, light blue, on the ridge.
    const canopy = ctx.createLinearGradient(0, top - hgt * 0.02, 0, top + hgt * 0.03);
    canopy.addColorStop(0, '#bff0ff');
    canopy.addColorStop(1, '#3fa9f5');
    ctx.fillStyle = canopy;
    ctx.beginPath();
    ctx.moveTo(cx - half * 0.16, top + hgt * 0.025);
    ctx.lineTo(cx - half * 0.1, top - hgt * 0.012);
    ctx.lineTo(cx + half * 0.1, top - hgt * 0.012);
    ctx.lineTo(cx + half * 0.16, top + hgt * 0.025);
    ctx.closePath();
    ctx.fill();
  }

  /** A vertex array of one attribute at location 0, one value of `size` floats an instance. */
  function instances(gl, data, size) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, size, gl.FLOAT, false, size * 4, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
    return { vao, count: data.length / size };
  }

  class Synthwave {
    constructor(canvas) {
      const gl = VizGL.context(canvas);
      if (!gl) throw new Error('no WebGL 2');
      this.gl = gl;
      this.fill = VizGL.program(gl, FILL_VS, FILL_FS);
      this.line = VizGL.program(gl, LINE_VS, LINE_FS);
      this.view = VizGL.program(gl, VizGL.SCREEN_VS, VIEW_FS);
      this.terrain = new Terrain({ rows: ROWS, cols: COLS, floor: FLOOR, camH: CAM_H, seed: Math.floor(Math.random() * 1e9) });
      const width = this.terrain.width;
      this.heights = new Float32Array(width * (ROWS + 1));
      this.heightTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, ROWS + 1, 0, gl.RED, gl.FLOAT, null);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      // The cells nearest first (each hides what lies behind it before
      // that is drawn), the lines farthest first (each over what it covers).
      const cells = [];
      for (let s = 0; s < ROWS; s += 1) for (let j = 0; j < width - 1; j += 1) cells.push(j, s);
      const segs = [];
      for (let s = ROWS - 1; s >= 0; s -= 1) {
        for (const kind of [2, 0]) {
          for (let j = 0; j < width; j += 1) {
            segs.push(j, s, kind);
            if (j < width - 1) segs.push(j, s, kind + 1);
          }
        }
      }
      this.cells = instances(gl, new Float32Array(cells), 2);
      this.segs = instances(gl, new Float32Array(segs), 3);
      this.shipTex = gl.createTexture();
      this.shipBox = [0, 1];

      this.speed = SPEED;
      this.lift = 0;
      this.pitch = 0;
      this.roll = 0;
      this.eye = eyeOf(Store.settings);
      this.nose = noseOf(Store.settings);
      this.age = 0;
      this.w = 1;
      this.h = 1;
    }

    size(w, h) {
      const gl = this.gl;
      this.w = w;
      this.h = h;
      for (const t of [this.land, this.qa, this.qb, this.qc]) VizGL.freeTarget(gl, t);
      this.land = VizGL.target(gl, w, h, { half: false, depth: true });
      const q = [Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4))];
      this.qa = VizGL.target(gl, ...q);
      this.qb = VizGL.target(gl, ...q);
      this.qc = VizGL.target(gl, ...q);
      // The ship's nose, from a little above its top (as the nose leans) to
      // past the bottom of the screen, where it reaches.
      const top = Math.floor(h * 0.8);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = Math.max(1, Math.ceil(h * 0.3));
      const ctx = c.getContext('2d');
      ctx.translate(0, -top);
      drawShip(ctx, w, h);
      gl.bindTexture(gl.TEXTURE_2D, this.shipTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.shipBox = [top, c.height];
    }

    destroy() {
      VizGL.lose(this.gl);
    }

    frame(a, dt) {
      this.age += dt;
      const { w, h } = this;
      const set = Store.settings;
      const terrain = this.terrain;
      const playing = a.playing;
      const bass = playing ? Equalizer.bass || 0 : 0;
      const kick = a.kick;
      // With a clear beat it flies as fast as the kicks pushed it on average at
      // 120 BPM, far faster for faster songs (VizAudio.rush), swelling gently with each beat
      // (VizAudio.surge); without one the kicks push it on.
      const byKick = SPEED * (1 + KICK_SPEED * kick + 0.4 * bass);
      const byBeat = BEAT_SPEED * a.surge(SURGE);
      const target = (playing ? byKick + (byBeat - byKick) * a.lock : SPEED * IDLE) * (Visualizer.setting('synSpeed') / 100);
      // Eased: slowly for the kicks' push, enough less for the swell to show.
      const ease = 0.6 + (0.15 - 0.6) * a.lock;
      this.speed += (target - this.speed) * (1 - Math.exp(-dt / ease));
      terrain.advance(this.speed * dt, playing ? Equalizer.levels : null);
      // The floor in front of the car is as rough as the music is intense right
      // now, and heaves on the kicks: measured against the song's own recent
      // kicks (VizAudio.beat), since a long electronic kick over a held bass
      // rises much less above it than a rock drum does, and its drops stayed nearly flat.
      terrain.bumps = set.synBumps ? BUMPS * a.intensity * (1 - BUMPS_KICK / 2 + BUMPS_KICK * a.beat) : 0;

      // The car rides the floor's bumps: between its back (under the eye) and
      // its front the ground lifts it and tips its nose, and the view shakes
      // with it. The horizon moving is the nose tipping: up as the ground rises
      // ahead, so the horizon drops. Camera bobbing off (or no bumps), it
      // settles back level.
      const bob = set.synBumps && set.synBobbing ? set.synBobbingAmount / 100 : 0;
      const back = bob ? terrain.groundAt(0.8) * bob : 0;
      const front = bob ? terrain.groundAt(1.8) * bob : 0;
      const ride = 1 - Math.exp(-dt * 1000 / RIDE_MS);
      this.lift += (LIFT * (back + front) / 2 - this.lift) * ride;
      this.pitch += ((front - back) - this.pitch) * ride;
      const hy = h * HORIZON + this.pitch * PITCH * w * FOCAL;
      // And it leans to the side whose wheels sit lower. The eye follows part
      // of the lean (ROLL_EYE), so the world tilts by that much, and the
      // nose the other way (ROLL_NOSE): the car is seen rocking under you.
      // Either can be switched off or set stronger or weaker (Camera tilt, Car
      // tilt, 0-200%), each eased there.
      const left = terrain.groundAt(1.3, -2, -1);
      const right = terrain.groundAt(1.3, 1, 2);
      const lean = Math.max(-ROLL_MAX, Math.min(ROLL_MAX, (right - left) * ROLL));
      const roll = 1 - Math.exp(-dt * 1000 / ROLL_MS);
      this.roll += (lean - this.roll) * roll;
      this.eye += (eyeOf(set) - this.eye) * roll;
      this.nose += (noseOf(set) - this.nose) * roll;
      const angle = this.roll * this.eye;

      const gl = this.gl;
      // 1. The terrain into its texture: the strips' fills, then the lines.
      gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, terrain.width, ROWS + 1, gl.RED, gl.FLOAT, terrain.heights(this.heights));
      VizGL.into(gl, this.land);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.depthMask(true);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      const look = (prog) => {
        const u = prog.u;
        gl.useProgram(prog.p);
        VizGL.bind(gl, u.heights, this.heightTex, 0);
        gl.uniform2f(u.res, w, h);
        gl.uniform1f(u.hy, hy);
        gl.uniform1f(u.focal, FOCAL * w);
        gl.uniform1f(u.camH, terrain.camH + this.lift);
        gl.uniform1f(u.frac, terrain.frac);
        gl.uniform1f(u.cols, COLS);
        gl.uniform1f(u.end, ROWS + 1);
        gl.uniform1f(u.angle, angle);
        return u;
      };
      gl.depthFunc(gl.LESS);
      look(this.fill);
      gl.bindVertexArray(this.cells.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.cells.count);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const u = look(this.line);
      const line = lineOf(Visualizer.setting('synColor'));
      gl.uniform3f(u.line, line.h, line.s, line.l);
      gl.uniform1f(u.drift, line.drift);
      gl.uniform1f(u.kick, kick);
      gl.bindVertexArray(this.segs.vao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.segs.count);
      gl.bindVertexArray(null);
      gl.depthMask(true);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);

      // 2. Its glow, at a quarter of the size.
      VizGL.shrink(gl, this.land, this.qa);
      VizGL.blur(gl, this.qa, this.qb, this.qc, 1.35);

      // 3. The picture.
      VizGL.into(gl, null);
      gl.useProgram(this.view.p);
      const v = this.view.u;
      VizGL.bind(gl, v.terrain, this.land.tex, 0);
      VizGL.bind(gl, v.glow, this.qc.tex, 1);
      VizGL.bind(gl, v.ship, this.shipTex, 2);
      gl.uniform2f(v.res, w, h);
      gl.uniform1f(v.hy, hy);
      gl.uniform1f(v.angle, angle);
      gl.uniform1f(v.shipAngle, -this.roll * this.nose);
      gl.uniform1f(v.kick, kick);
      gl.uniform1f(v.glowAmount, Math.min(1, GLOW * (1 + 0.8 * kick)));
      gl.uniform1f(v.time, this.age);
      gl.uniform1f(v.pad, w * 0.1);
      gl.uniform2f(v.shipBox, ...this.shipBox);
      VizGL.screen(gl);
    }
  }

  /** How much of the lean the world tilts, by Camera tilt and its amount. */
  function eyeOf(set) {
    return set.synCameraTilt ? (ROLL_EYE * set.synCameraTiltAmount) / 100 : 0;
  }

  /** And the nose, by Car tilt and its amount. */
  function noseOf(set) {
    return set.synCarTilt ? (ROLL_NOSE * set.synCarTiltAmount) / 100 : 0;
  }

  /**
   * '#rrggbb' as { h, s, l } for the terrain's lines, the last one kept. The
   * default violet turns blue into the distance; a chosen colour stays itself.
   */
  let lineFor = null;
  let lineHsl = null;
  function lineOf(hex) {
    if (lineFor === hex) return lineHsl;
    const [r, g, b] = VizGL.rgb(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const c = max - min;
    const s = c ? c / (1 - Math.abs(2 * l - 1)) : 0;
    lineFor = hex;
    lineHsl = { h: hueOf(r, g, b), s: s * 100, l: l * 100, drift: hex === PRESETS[0] ? 52 : 0 };
    return lineHsl;
  }

  const amount = (key) => ({ key, min: 0, max: 200, step: 5 });
  Visualizer.add({
    id: 'synthwave',
    name: 'Synthwave',
    desc: 'A flight through neon mountains made of the music, rushing on with every beat and glowing on the kicks',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10" r="4"/><path d="M2 20l6-8 3 4 2-2 4 6"/>'
      + '<path d="M15 16l2-3 5 7"/></svg>',
    gl: true,
    create: (canvas) => new Synthwave(canvas),
    options: [
      { type: 'color', key: 'synColor', label: 'Wireframe color', presets: PRESETS },
      { type: 'slider', key: 'synSpeed', label: 'Speed', min: 50, max: 150, step: 5 },
      {
        type: 'check',
        key: 'synBumps',
        label: 'Ground bumps',
        group: [
          { type: 'check', key: 'synBobbing', label: 'Camera bobbing', amount: amount('synBobbingAmount') },
          { type: 'check', key: 'synCameraTilt', label: 'Camera tilt', amount: amount('synCameraTiltAmount') },
          { type: 'check', key: 'synCarTilt', label: 'Car tilt', amount: amount('synCarTiltAmount') },
        ],
      },
    ],
  });
})();
