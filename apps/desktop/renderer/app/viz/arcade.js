'use strict';

// Arcade: the old arcade games playing themselves to the music, on a glowing
// screen of big pixels.
//   Pong       the ball crosses the court in exactly one beat, so every
//              return lands on it; the scores are the tempo and the rally
//   Breakout   one beat up to a brick, one beat back down to the paddle;
//              the bricks glow with their part of the spectrum
//   Invaders   the fleet marches a step on every beat (quicker as it thins
//              out), the cannon fires on the hits, the invaders drop bombs
//              on the kicks, the shields crumble
// Without a clear beat they keep a steady 120 a minute.
//
// Its cogwheel: which game (a different one each song, or one of them), the
// colours (the arcade's own, green or amber phosphor), the screen's lines.
// A click starts the next game.
//
// Canvas 2D: the games at a few hundred pixels across into a small canvas
// that fades rather than clears (the phosphor glows on a moment), coloured,
// then onto the screen with no smoothing, a soft glow and scan lines.

(() => {
  const H = 225;
  const GAMES = ['pong', 'breakout', 'invaders'];

  // A 3 x 5 font: five rows, each a base-8 digit of three dots.
  const FONT = {};
  ('0:75557 1:26227 2:71747 3:71717 4:55711 5:74717 6:74757 7:71111 8:75757 9:75717 A:25755 B:65656 C:34443 E:74647 '
    + 'H:55755 I:72227 L:44447 M:57755 N:65555 O:25552 P:65644 R:65655 S:34216 T:72222 V:55552 W:55775 K:55655 -:00700 '
    + '::02020 <:12421 >:42124').split(' ').forEach((e) => {
    FONT[e[0]] = [...e.slice(2)].map(Number);
  });

  /** Sprites from rows of '#' and '.'. */
  const sprite = (rows) => rows.map((r) => [...r].map((c) => c === '#'));
  const SQUID = [
    sprite(['...##...', '..####..', '.######.', '##.##.##', '########', '..#..#..', '.#.##.#.', '#.#..#.#']),
    sprite(['...##...', '..####..', '.######.', '##.##.##', '########', '.#.##.#.', '#......#', '.#....#.']),
  ];
  const CRAB = [
    sprite(['..#.....#..', '...#...#...', '..#######..', '.##.###.##.', '###########', '#.#######.#', '#.#.....#.#', '...##.##...']),
    sprite(['..#.....#..', '#..#...#..#', '#.#######.#', '###.###.###', '###########', '.#########.', '..#.....#..', '.#.......#.']),
  ];
  const OCTO = [
    sprite(['....####....', '.##########.', '############', '###..##..###', '############', '...##..##...', '..##.##.##..', '##........##']),
    sprite(['....####....', '.##########.', '############', '###..##..###', '############', '..###..###..', '.##..##..##.', '..##....##..']),
  ];
  const CANNON = sprite(['......#......', '.....###.....', '.....###.....', '.###########.', '#############', '#############', '#############', '#############']);
  const UFO = sprite(['.....######.....', '...##########...', '..############..', '.##.##.##.##.##.', '################', '..###..##..###..', '...#........#...']);
  const BOOM = sprite(['....#...#....', '.#...#.#...#.', '..#.......#..', '...#.....#...', '##.........##', '...#.....#...', '..#..#.#..#..', '.#..#...#..#.']);

  const PHOSPHOR = { green: '#41ff7a', amber: '#ffb12e' };
  const BRICKS = ['#c84848', '#c84848', '#c66c3a', '#c66c3a', '#a2a22a', '#a2a22a', '#48a048', '#48a048'];

  function canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /** x folded back into lo..hi as a ball bouncing between two walls. */
  function fold(x, lo, hi) {
    const span = hi - lo;
    let u = (x - lo) % (2 * span);
    if (u < 0) u += 2 * span;
    return lo + (u <= span ? u : 2 * span - u);
  }

  class Arcade {
    constructor(cv) {
      this.canvas = cv;
      this.ctx = cv.getContext('2d');
      this.low = canvas(400, H);
      this.g = this.low.getContext('2d');
      this.col = canvas(400, H);
      this.cg = this.col.getContext('2d');
      this.glow = canvas(100, 56);
      this.W = 400;
      this.ph = 0;
      this.beat = 0;
      this.age = 0;
      this.songFor = undefined;
      this.game = null;
      this.choice = null;
      this.pick = 0;
      this.sparks = [];
    }

    size(w, h) {
      this.w = w;
      this.h = h;
      this.W = Math.max(300, Math.round((H * w) / h));
      for (const c of [this.low, this.col]) {
        c.width = this.W;
        c.height = H;
      }
      this.glow.width = Math.round(this.W / 4);
      this.glow.height = Math.round(H / 4);
      this.scan = null;
      if (this.game) this._start(this.game.kind);
    }

    destroy() {}

    /** The next game (a click). */
    next() {
      const kind = GAMES[(GAMES.indexOf(this.game ? this.game.kind : 'pong') + 1) % GAMES.length];
      this._start(kind);
    }

    _start(kind) {
      const W = this.W;
      this.sparks = [];
      if (kind === 'pong') {
        this.game = { kind, ly: H / 2, ry: H / 2, bx: 16, by: H / 2, leg: null, dir: 1, rally: 0, flashL: 0, flashR: 0 };
      } else if (kind === 'breakout') {
        const cols = 14;
        const bw = Math.floor((W - 16) / cols);
        const g = {
          kind, cols, rows: 8, bw, bh: 6, x0: Math.floor((W - bw * cols) / 2), y0: 34, px: W / 2, pw: 30, py: 206, leg: null, score: 0, bricks: [], build: 0,
        };
        this.game = g;
        this._wall(g);
        g.bx = g.px;
        g.by = g.py - 3;
      } else {
        const g = {
          kind, score: 0, wave: 1, fx: 0, fy: 40, dir: 1, frame: 0, step: 0, alive: [], cx: W / 2, shot: null, bombs: [], booms: [], ufo: null, ufoAt: 12, dead: 0, shields: [],
        };
        this.game = g;
        this._fleet(g);
        this._shields(g);
      }
    }

    // ---- the beat --------------------------------------------------------

    /** The beat's phase and whether one landed this frame: the tempo's, or a steady 120 without one. */
    _clock(a, dt) {
      if (!a.playing) return false;
      let tick;
      if (a.sure >= 0.35 && a.bpm) {
        tick = a.tick;
        this.ph = a.phase;
      } else {
        this.ph += dt * 2;
        tick = this.ph >= 1;
        if (tick) this.ph -= 1;
      }
      if (tick) this.beat += 1;
      return tick;
    }

    // ---- Pong ------------------------------------------------------------

    _pong(a, dt, tick) {
      const g = this.game;
      const W = this.W;
      const lx = 14;
      const rx = W - 17;
      const ph = 18;
      if (tick) {
        // A return: the ball off this paddle, to land on the other at the next beat.
        if (g.leg) {
          g.dir = -g.dir;
          g.rally += 1;
          if (g.dir > 0) g.flashL = 1;
          else g.flashR = 1;
          this._burst(g.dir > 0 ? lx + 3 : rx, g.by + 2, '#ffffff', 6);
        }
        const from = g.by;
        const to = 12 + Math.random() * (H - 28);
        // Off a wall now and then: aimed at the target's mirror image.
        const r = Math.random();
        const lo = 2;
        const hi = H - 6;
        const target = r < 0.25 ? 2 * lo - to : r < 0.5 ? 2 * hi - to : to;
        g.leg = { from, target, to };
      }
      if (g.leg) {
        const f = this.ph;
        const x0 = g.dir > 0 ? lx + 3 : rx - 4;
        const x1 = g.dir > 0 ? rx - 4 : lx + 3;
        g.bx = x0 + (x1 - x0) * f;
        g.by = fold(g.leg.from + (g.leg.target - g.leg.from) * f, 2, H - 6);
        // The paddle it flies to gets there in time; the other drifts back.
        const k = 1 - Math.exp(-dt * 7);
        const want = g.leg.to + 2 - ph / 2 + Math.sin(this.beat) * 5;
        if (g.dir > 0) {
          g.ry += (want - g.ry) * Math.min(1, k * (0.6 + f * 2));
          g.ly += (H / 2 - ph / 2 - g.ly) * k * 0.3;
        } else {
          g.ly += (want - g.ly) * Math.min(1, k * (0.6 + f * 2));
          g.ry += (H / 2 - ph / 2 - g.ry) * k * 0.3;
        }
      } else {
        g.bx = lx + 3;
        g.by = g.ly + ph / 2 - 2;
      }
      g.flashL *= Math.exp(-dt * 8);
      g.flashR *= Math.exp(-dt * 8);

      const c = this.g;
      // The net, brighter with the bass.
      c.fillStyle = `rgba(255, 255, 255, ${0.45 + 0.55 * a.bass})`;
      for (let y = 2; y < H; y += 10) c.fillRect(Math.floor(W / 2) - 1, y, 2, 5);
      c.fillStyle = '#ffffff';
      this._number(c, a.sure >= 0.35 && a.bpm ? Math.round(a.bpm) : '--', W / 2 - 30, 10, 4, 'right');
      this._number(c, g.rally % 1000, W / 2 + 30, 10, 4, 'left');
      c.fillStyle = `rgb(255, 255, ${Math.round(255 - 120 * g.flashL)})`;
      c.fillRect(lx, Math.round(g.ly), 3, ph);
      c.fillStyle = `rgb(255, 255, ${Math.round(255 - 120 * g.flashR)})`;
      c.fillRect(rx, Math.round(g.ry), 3, ph);
      const s = 4 + Math.round(a.kick * 1.5);
      c.fillStyle = '#ffffff';
      c.fillRect(Math.round(g.bx - (s - 4) / 2), Math.round(g.by - (s - 4) / 2), s, s);
    }

    // ---- Breakout --------------------------------------------------------

    _wall(g) {
      g.bricks = [];
      for (let r = 0; r < g.rows; r += 1) for (let c = 0; c < g.cols; c += 1) g.bricks.push({ r, c, on: true });
      g.build = 1;
    }

    _breakout(a, dt, tick) {
      const g = this.game;
      const W = this.W;
      const lo = 6;
      const hi = W - 9;
      g.build = Math.max(0, g.build - dt);
      if (tick && g.build <= 0) {
        if (g.leg && g.leg.up) {
          // Arrived at its brick: gone.
          const b = g.leg.brick;
          b.on = false;
          g.score += (8 - b.r) * 1 + 1;
          this._burst(g.x0 + b.c * g.bw + g.bw / 2, g.y0 + b.r * (g.bh + 2) + g.bh / 2, BRICKS[b.r], 14);
        }
        const left = g.bricks.filter((b) => b.on);
        if (!left.length) {
          this._wall(g);
          g.leg = null;
        } else if (g.leg && g.leg.up) {
          // Back down to wherever the paddle will be.
          const to = lo + 12 + Math.random() * (hi - lo - 24);
          g.leg = { up: false, fx: g.bx, fy: g.by, tx: this._bank(to, lo, hi), ty: g.py - 3, to };
        } else {
          // Up to a brick at the front of the wall (the lowest left in its column).
          const front = new Map();
          for (const b of left) if (!front.has(b.c) || front.get(b.c).r < b.r) front.set(b.c, b);
          const fronts = [...front.values()];
          const deepest = Math.max(...fronts.map((b) => b.r));
          const pool = fronts.filter((b) => b.r === deepest || Math.random() < 0.15);
          const brick = pool[Math.floor(Math.random() * pool.length)];
          const tx = g.x0 + brick.c * g.bw + g.bw / 2;
          const ty = g.y0 + brick.r * (g.bh + 2) + g.bh + 1;
          g.leg = { up: true, brick, fx: g.bx, fy: g.by, tx: this._bank(tx, lo, hi), ty, to: tx };
        }
      }
      if (g.leg) {
        const f = this.ph;
        g.bx = fold(g.leg.fx + (g.leg.tx - g.leg.fx) * f, lo, hi);
        g.by = g.leg.fy + (g.leg.ty - g.leg.fy) * f;
        const k = 1 - Math.exp(-dt * 6);
        const want = g.leg.up ? g.px + (g.bx - g.px) * 0.15 : g.leg.to + Math.sin(this.beat * 1.7) * 8;
        g.px += (want - g.px) * Math.min(1, k * (g.leg.up ? 0.5 : 0.8 + f * 2));
      } else {
        g.bx = g.px;
        g.by = g.py - 3;
      }

      const c = this.g;
      // The walls round the court and the score.
      c.fillStyle = '#8c8c8c';
      c.fillRect(0, 22, W, 4);
      c.fillRect(0, 22, 5, H);
      c.fillRect(W - 5, 22, 5, H);
      c.fillStyle = '#ffffff';
      this._text(c, `SCORE ${String(g.score).padStart(4, '0')}`, 8, 9, 2);
      this._text(c, a.sure >= 0.35 && a.bpm ? `BPM ${Math.round(a.bpm)}` : 'BPM ---', W - 8, 9, 2, 'right');
      // The bricks, each column glowing with its part of the spectrum.
      for (const b of g.bricks) {
        if (!b.on) continue;
        const shown = 1 - g.build * 1.2 + (7 - b.r) * 0.1;
        if (shown <= 0) continue;
        const band = Math.floor(((b.c + 0.5) / g.cols) * a.BANDS * 0.85);
        const lit = 0.55 + 0.45 * Math.min(1, a.dynamic[band] * 1.2);
        c.globalAlpha = Math.min(1, shown) * lit;
        c.fillStyle = BRICKS[b.r];
        c.fillRect(g.x0 + b.c * g.bw + 1, g.y0 + b.r * (g.bh + 2), g.bw - 2, g.bh);
        c.globalAlpha = 1;
      }
      c.fillStyle = '#48a0c8';
      c.fillRect(Math.round(g.px - g.pw / 2), g.py, g.pw, 4);
      c.fillStyle = '#ffffff';
      c.fillRect(Math.round(g.bx - 1.5), Math.round(g.by - 1.5), 3, 3);
    }

    /** A target x, or its mirror image in a side wall now and then (the ball banks off it). */
    _bank(x, lo, hi) {
      const r = Math.random();
      if (r < 0.2) return 2 * lo - x;
      if (r < 0.4) return 2 * hi - x;
      return x;
    }

    // ---- Invaders --------------------------------------------------------

    _fleet(g) {
      g.alive = [];
      for (let r = 0; r < 5; r += 1) for (let c = 0; c < 11; c += 1) g.alive.push({ r, c, on: true });
      g.fx = Math.round((this.W - 11 * 16) / 2);
      g.fy = 40 + Math.min(4, g.wave - 1) * 4;
      g.dir = 1;
    }

    _shields(g) {
      g.shields = [];
      const n = 4;
      for (let i = 0; i < n; i += 1) {
        const px = new Uint8Array(22 * 16);
        for (let y = 0; y < 16; y += 1) {
          for (let x = 0; x < 22; x += 1) {
            const corner = y < 4 && (x < 4 - y || x > 17 + y);
            const arch = y > 10 && x > 6 && x < 15 && (y - 10) * 2 > Math.abs(x - 10.5) - 1;
            px[y * 22 + x] = corner || arch ? 0 : 1;
          }
        }
        g.shields.push({ x: Math.round(((i + 0.5) / n) * this.W - 11), y: 176, px });
      }
    }

    _alienSprite(r, frame) {
      return (r === 0 ? SQUID : r < 3 ? CRAB : OCTO)[frame];
    }

    /** Where invader a is: x, y, w, h. */
    _alienBox(g, a) {
      const s = this._alienSprite(a.r, 0);
      const w = s[0].length;
      return { x: g.fx + a.c * 16 + Math.floor((12 - w) / 2), y: g.fy + a.r * 14, w, h: 8 };
    }

    /** A shield's pixel at x, y (screen), or null. */
    _shieldAt(g, x, y) {
      for (const s of g.shields) {
        const sx = Math.floor(x - s.x);
        const sy = Math.floor(y - s.y);
        if (sx >= 0 && sx < 22 && sy >= 0 && sy < 16 && s.px[sy * 22 + sx]) return { s, sx, sy };
      }
      return null;
    }

    _crumble(hit) {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          if (Math.random() < 0.65 - (Math.abs(dx) + Math.abs(dy)) * 0.12) {
            const x = hit.sx + dx;
            const y = hit.sy + dy;
            if (x >= 0 && x < 22 && y >= 0 && y < 16) hit.s.px[y * 22 + x] = 0;
          }
        }
      }
    }

    _invaders(a, dt, tick) {
      const g = this.game;
      const W = this.W;
      const alive = g.alive.filter((x) => x.on);
      if (!alive.length) {
        g.wave += 1;
        this._fleet(g);
        if (g.wave % 3 === 1) this._shields(g);
        return;
      }
      // Marching: a step a beat, two, then four as the fleet thins out.
      const per = alive.length > 30 ? 1 : alive.length > 10 ? 2 : 4;
      const step = Math.floor((this.beat + this.ph) * per);
      if (a.playing && step !== g.step) {
        g.step = step;
        g.frame = 1 - g.frame;
        const boxes = alive.map((x) => this._alienBox(g, x));
        const minX = Math.min(...boxes.map((b) => b.x));
        const maxX = Math.max(...boxes.map((b) => b.x + b.w));
        if ((g.dir > 0 && maxX + 4 > W - 6) || (g.dir < 0 && minX - 4 < 6)) {
          g.fy += 6;
          g.dir = -g.dir;
        } else g.fx += 4 * g.dir;
        const bottom = Math.max(...boxes.map((b) => b.y + b.h));
        if (bottom + 6 > 172) this._fleet(g);
      }

      // The cannon: under an invader it means to hit, firing on the hits.
      if (g.dead > 0) g.dead -= dt;
      const targets = alive.filter((x) => !alive.some((y) => y.c === x.c && y.r > x.r));
      if (!g.aim || !g.aim.on || Math.random() < dt * 0.3) g.aim = targets[Math.floor(Math.random() * targets.length)];
      if (g.aim) {
        const box = this._alienBox(g, g.aim);
        const want = box.x + box.w / 2 + g.dir * 4 * (box.y > 120 ? 0 : 1);
        const d = want - g.cx;
        g.cx += Math.sign(d) * Math.min(Math.abs(d), 110 * dt);
      }
      if (a.playing && a.hit && !g.shot && g.dead <= 0) g.shot = { x: Math.round(g.cx), y: 196 };
      if (g.shot) {
        g.shot.y -= 330 * dt;
        let gone = g.shot.y < 16;
        for (const x of alive) {
          if (gone) break;
          const b = this._alienBox(g, x);
          if (g.shot.x >= b.x && g.shot.x < b.x + b.w && g.shot.y < b.y + b.h && g.shot.y + 4 > b.y) {
            x.on = false;
            g.score += [30, 20, 20, 10, 10][x.r];
            g.booms.push({ x: b.x + b.w / 2, y: b.y + 4, t: 0.25 });
            gone = true;
          }
        }
        if (!gone && g.ufo && Math.abs(g.shot.x - (g.ufo.x + 8)) < 8 && g.shot.y < 27 && g.shot.y > 16) {
          g.booms.push({ x: g.ufo.x + 8, y: 23, t: 0.6, score: 300 });
          g.score += 300;
          g.ufo = null;
          gone = true;
        }
        const hit = !gone && this._shieldAt(g, g.shot.x, g.shot.y);
        if (hit) {
          this._crumble(hit);
          gone = true;
        }
        if (gone) g.shot = null;
      }
      // Bombs on the kicks, from the bottom of a column.
      if (a.playing && a.onset && g.bombs.length < 3 && Math.random() < 0.6) {
        const from = targets[Math.floor(Math.random() * targets.length)];
        const b = this._alienBox(g, from);
        g.bombs.push({ x: b.x + b.w / 2, y: b.y + b.h, t: 0 });
      }
      for (const bomb of g.bombs) {
        bomb.y += 90 * dt;
        bomb.t += dt;
        const hit = this._shieldAt(g, bomb.x, bomb.y + 4);
        if (hit) {
          this._crumble(hit);
          bomb.y = 999;
        } else if (g.dead <= 0 && bomb.y + 4 > 198 && Math.abs(bomb.x - g.cx) < 6) {
          g.dead = 1.2;
          g.booms.push({ x: g.cx, y: 202, t: 0.8, big: true });
          bomb.y = 999;
        }
      }
      g.bombs = g.bombs.filter((b) => b.y < 212);
      // The saucer: now and then, and when the music swells.
      g.ufoAt -= dt * (a.playing ? 1 + a.intensity : 0);
      if (!g.ufo && g.ufoAt <= 0) {
        const left = Math.random() < 0.5;
        g.ufo = { x: left ? -16 : W, v: left ? 50 : -50 };
        g.ufoAt = 18 + Math.random() * 12;
      }
      if (g.ufo) {
        g.ufo.x += g.ufo.v * dt;
        if (g.ufo.x < -20 || g.ufo.x > W + 4) g.ufo = null;
      }
      for (const b of g.booms) b.t -= dt;
      g.booms = g.booms.filter((b) => b.t > 0);

      const c = this.g;
      c.fillStyle = '#ffffff';
      this._text(c, `SCORE ${String(g.score).padStart(4, '0')}`, 8, 6, 2);
      this._text(c, a.sure >= 0.35 && a.bpm ? `BPM ${Math.round(a.bpm)}` : 'BPM ---', W / 2, 6, 2, 'center');
      this._text(c, `WAVE ${g.wave}`, W - 8, 6, 2, 'right');
      for (const x of alive) {
        const b = this._alienBox(g, x);
        this._sprite(c, this._alienSprite(x.r, g.frame), b.x, b.y);
      }
      if (g.ufo) this._sprite(c, UFO, Math.round(g.ufo.x), 19);
      for (const b of g.booms) {
        if (b.score) this._text(c, '300', Math.round(b.x), b.y - 2, 1, 'center');
        else this._sprite(c, BOOM, Math.round(b.x - 6), Math.round(b.y - 4));
      }
      for (const s of g.shields) {
        for (let y = 0; y < 16; y += 1) for (let x = 0; x < 22; x += 1) if (s.px[y * 22 + x]) c.fillRect(s.x + x, s.y + y, 1, 1);
      }
      if (g.dead <= 0 || Math.floor(g.dead * 10) % 2) this._sprite(c, CANNON, Math.round(g.cx - 6), 198);
      if (g.shot) c.fillRect(g.shot.x, Math.round(g.shot.y), 1, 4);
      for (const bomb of g.bombs) {
        const zig = Math.floor(bomb.t * 12) % 2;
        for (let k = 0; k < 4; k += 1) c.fillRect(Math.round(bomb.x) + ((k + zig) % 2 ? 1 : 0), Math.round(bomb.y) + k, 1, 1);
      }
      c.fillRect(0, 214, W, 1);
    }

    // ---- drawing helpers -------------------------------------------------

    _sprite(c, s, x, y) {
      for (let r = 0; r < s.length; r += 1) {
        const row = s[r];
        for (let k = 0; k < row.length; k += 1) if (row[k]) c.fillRect(x + k, y + r, 1, 1);
      }
    }

    /** Text in the 3 x 5 font, each dot `scale` pixels, its top at y. */
    _text(c, text, x, y, scale = 1, align = 'left') {
      const s = String(text).toUpperCase();
      const width = s.length * 4 * scale - scale;
      let cx = align === 'right' ? x - width : align === 'center' ? x - width / 2 : x;
      cx = Math.round(cx);
      for (const ch of s) {
        const rows = FONT[ch];
        if (rows) {
          for (let r = 0; r < 5; r += 1) {
            for (let b = 0; b < 3; b += 1) if (rows[r] & (4 >> b)) c.fillRect(cx + b * scale, y + r * scale, scale, scale);
          }
        }
        cx += 4 * scale;
      }
    }

    _number(c, n, x, y, scale, align) {
      this._text(c, String(n), x, y, scale, align);
    }

    /** Bits flying off a hit. */
    _burst(x, y, color, n) {
      for (let i = 0; i < n; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const v = 30 + Math.random() * 70;
        this.sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 20, t: 0.4 + Math.random() * 0.4, color });
      }
    }

    frame(a, dt) {
      this.age += dt;
      const set = (k) => Visualizer.setting(k);
      // Which game: a chosen one, or another with each song.
      const choice = set('arGame');
      if (choice !== this.choice) {
        this.choice = choice;
        this._start(choice === 'auto' ? GAMES[Math.floor(Math.random() * GAMES.length)] : choice);
        this.songFor = Player.currentId;
      } else if (choice === 'auto' && Player.currentId !== this.songFor) {
        this.songFor = Player.currentId;
        const others = GAMES.filter((x) => x !== this.game.kind);
        this._start(others[Math.floor(Math.random() * others.length)]);
      }
      const tick = this._clock(a, dt);
      const c = this.g;
      // The phosphor fades rather than clears.
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = `rgba(0, 0, 0, ${1 - Math.exp(-dt / 0.022)})`;
      c.fillRect(0, 0, this.W, H);
      if (!a.playing) {
        // Paused: everything holds still where it is.
        c.fillStyle = '#000';
        c.fillRect(0, 0, this.W, H);
      }
      if (this.game.kind === 'pong') this._pong(a, a.playing ? dt : 0, tick);
      else if (this.game.kind === 'breakout') this._breakout(a, a.playing ? dt : 0, tick);
      else this._invaders(a, a.playing ? dt : 0, tick);
      for (const s of this.sparks) {
        s.t -= dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 160 * dt;
        c.fillStyle = s.color;
        c.fillRect(Math.round(s.x), Math.round(s.y), 1, 1);
      }
      this.sparks = this.sparks.filter((s) => s.t > 0);

      // Coloured: the arcade's own overlays, or all in one phosphor.
      const colors = set('arColors');
      const cg = this.cg;
      cg.globalCompositeOperation = 'source-over';
      cg.drawImage(this.low, 0, 0);
      cg.globalCompositeOperation = 'multiply';
      if (colors !== 'arcade') {
        cg.fillStyle = PHOSPHOR[colors] || PHOSPHOR.green;
        cg.fillRect(0, 0, this.W, H);
      } else if (this.game.kind === 'invaders') {
        cg.fillStyle = '#ff4040';
        cg.fillRect(0, 15, this.W, 15);
        cg.fillStyle = '#40ff60';
        cg.fillRect(0, 172, this.W, H - 172);
      }
      cg.globalCompositeOperation = 'source-over';

      const g = this.ctx;
      g.imageSmoothingEnabled = false;
      g.fillStyle = '#000';
      g.fillRect(0, 0, this.w, this.h);
      g.drawImage(this.col, 0, 0, this.w, this.h);
      // The glow.
      const gc = this.glow.getContext('2d');
      gc.clearRect(0, 0, this.glow.width, this.glow.height);
      gc.imageSmoothingEnabled = true;
      gc.drawImage(this.col, 0, 0, this.glow.width, this.glow.height);
      g.imageSmoothingEnabled = true;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.7;
      g.drawImage(this.glow, 0, 0, this.w, this.h);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
      if (set('arCrt')) {
        if (!this.scan) {
          const sc = document.createElement('canvas');
          const step = Math.max(2, Math.round(this.h / H));
          sc.width = 1;
          sc.height = step;
          const s = sc.getContext('2d');
          s.fillStyle = 'rgba(0, 0, 0, 0.4)';
          s.fillRect(0, step - Math.max(1, Math.round(step / 3)), 1, Math.max(1, Math.round(step / 3)));
          this.scan = g.createPattern(sc, 'repeat');
        }
        g.fillStyle = this.scan;
        g.fillRect(0, 0, this.w, this.h);
        const v = g.createRadialGradient(this.w / 2, this.h / 2, this.h * 0.45, this.w / 2, this.h / 2, this.h * 1.05);
        v.addColorStop(0, 'rgba(0, 0, 0, 0)');
        v.addColorStop(1, 'rgba(0, 0, 0, 0.6)');
        g.fillStyle = v;
        g.fillRect(0, 0, this.w, this.h);
      }
    }
  }

  Visualizer.add({
    id: 'arcade',
    name: 'Arcade',
    desc: 'Pong, Breakout and Space Invaders playing themselves to the beat on a glowing screen of big pixels',
    glyph: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="M6 8h2V6h2v2h4V6h2v2h2v3h2v5h-2v-3h-1v3H7v-3H6v3H4v-5h2z"/><path d="M9 11h.01M15 11h.01"/></svg>',
    create: (cv) => new Arcade(cv),
    click: (scene) => scene.next(),
    options: [
      { type: 'choice', key: 'arGame', label: 'Game', choices: [['auto', 'Each song another'], ['pong', 'Pong'], ['breakout', 'Breakout'], ['invaders', 'Invaders']] },
      { type: 'choice', key: 'arColors', label: 'Colours', choices: [['arcade', 'Arcade'], ['green', 'Green'], ['amber', 'Amber']] },
      { type: 'check', key: 'arCrt', label: 'Screen lines' },
    ],
  });
})();
