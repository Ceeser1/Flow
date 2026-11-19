'use strict';

// Makes the pictures of the menu's background textures (Settings > App Visuals >
// Show a Menu background > Style; shown and moved by menuBg.js). Flow comes
// with no pictures of them: menuBg.js has the chosen style's made here, once
// when it is first shown or its seed or the style changes, never while it moves.
// (scripts/make-menu-textures.js writes them to a folder, for looking at them.)
//
// make(style, seed) gives { files: { name: the picture as SVG text }, ... } and
// what else menuBg.js needs with them (Circuit's ways, Scales' look, Vinyl's
// beams). The same style and seed give the same pictures, so none need keeping;
// no seed gives the style's standard look. A seed is up to six of A-Z and 0-9
// (clean).
//
// Every picture is white on nothing, four times as strong as it looks as
// designed: menuBg.js shows it at Settings' Visibility, 25 % by default, so
// 100 % can be four times that. Pictures that are moved on and on (Currents,
// Stars, Mist, Scales) are tiles: they go on into themselves at their edges, so
// the layer showing them can be moved by a whole tile without a seam. Vines and
// Circuit go on into themselves to the sides, and Vinyl's is wide: so every
// style can reach over from the menu into the content's background (Settings'
// Reach over), as far as it is let. (Roots' own pictures end 500 px beyond the
// menu; for reaching over there are two more, of roots hanging down all along,
// which go on into themselves to the sides.)

const MenuBgMake = (() => {
  const TAU = Math.PI * 2;
  const f = (n) => String(Math.round(n * 10) / 10);

  /** A row of random numbers (0 up to 1) that is the same for the same `seed`. */
  function random(seed) {
    let s = seed >>> 0;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    rnd.gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    rnd.between = (a, b) => a + rnd() * (b - a);
    rnd.pick = (list) => list[Math.floor(rnd() * list.length)];
    return rnd;
  }

  /** A text as a number to start a row of random numbers from (FNV-1a, stirred once more). */
  function number(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 15;
    h = Math.imul(h, 2246822519);
    h ^= h >>> 13;
    return h >>> 0;
  }

  /** A seed as Settings keeps it: capitals and digits only, six at most. */
  function clean(seed) {
    return String(seed == null ? '' : seed).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  /** A seed nobody typed: six of the letters and digits. */
  function dice() {
    const SIGNS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < 6; i += 1) out += SIGNS[Math.floor(Math.random() * SIGNS.length)];
    return out;
  }

  /**
   * Where a style's rows of random numbers start: for each of its parts (a picture, or one side of it) the
   * number its standard look is made from (`own`) while there is no seed, one from the seed otherwise.
   */
  function starts(style, seed, own) {
    return (part) => (seed ? number(`${style}:${seed}:${part}`) : own[part]);
  }

  const svg = (w, h, defs, body) => `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;

  /** A smooth line through the points. */
  function smooth(pts) {
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    for (let j = 1; j < pts.length - 1; j += 1) {
      const [x1, y1] = pts[j];
      const [x2, y2] = pts[j + 1];
      d += `Q${f(x1)} ${f(y1)} ${f((x1 + x2) / 2)} ${f((y1 + y2) / 2)}`;
    }
    const last = pts[pts.length - 1];
    return `${d}L${f(last[0])} ${f(last[1])}`;
  }

  // ---- Roots: a few main roots grow down from the top edge of the menu, taper, and branch into
  // side roots that spread outwards, ending in fine hairs; some reach out of the menu over the
  // content's background. Fainter towards the bottom.

  /**
   * Grows roots: the function it gives adds a root from x, y (and all that branches off it) to `strokes`
   * ({ pts, w0, w1, depth }). `inside(x, y, home)`: where a root may be (`home`: where its main root began).
   */
  function rootGrower(rnd, strokes, inside) {
    const grow = (x, y, angle, w0, steps, depth, gravityOf = null, home = x) => {
      const pts = [[x, y]];
      let turn = 0;
      let w = w0;
      // Side roots fall less steeply than the main ones: they spread.
      const gravity = gravityOf ?? ([0.03, 0.012, 0.008, 0.006][depth] || 0.005);
      for (let step = 0; step < steps; step += 1) {
        turn = turn * 0.8 + rnd.gauss() * (0.07 + depth * 0.025);
        angle += turn + (Math.PI / 2 - angle) * gravity;
        const len = 4.5 + rnd() * 2.5;
        x += Math.cos(angle) * len;
        y += Math.sin(angle) * len;
        if (!inside(x, y, home)) break;
        pts.push([x, y]);
        // Tapering towards the tip.
        w = w0 * (1 - (step + 1) / (steps + 1)) + 0.35 * ((step + 1) / (steps + 1));
        const chance = ([0.06, 0.045, 0.035, 0.05][depth] || 0) * Math.min(1, 0.35 + y / 500);
        if (depth < 4 && step > 3 && step < steps - 4 && rnd() < chance) {
          const side = rnd() < 0.5 ? -1 : 1;
          const childLife = Math.round((steps - step) * (0.35 + rnd() * 0.35) + 6);
          grow(x, y, angle + side * (0.6 + rnd() * 0.6), Math.max(0.5, w * (0.5 + rnd() * 0.15)), childLife, depth + 1, null, home);
        }
      }
      if (pts.length > 1) strokes.push({ pts, w0, w1: w, depth });
    };
    return grow;
  }

  /** A root as pieces of a few points each, each a little thinner: the taper. */
  function rootPaths(s, thin) {
    const paths = [];
    const n = s.pts.length;
    const PIECE = 6;
    for (let i = 0; i < n - 1; i += PIECE) {
      const part = s.pts.slice(i, Math.min(n, i + PIECE + 1));
      if (part.length < 2) continue;
      const t = (i + part.length / 2) / n;
      const width = (s.w0 + (s.w1 - s.w0) * t) * thin;
      paths.push(`<path d='${smooth(part)}' stroke-width='${Math.max(0.35, width).toFixed(2)}'/>`);
    }
    return paths;
  }

  // Faint at the top (the menu's entries), whole from 45 % down, 85 % at the bottom.
  const rootsDown = (top) => `<linearGradient id='v' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='${top}'/><stop offset='0.45' stop-color='#fff'/><stop offset='1' stop-color='#fff' stop-opacity='0.85'/></linearGradient>`;

  // The menu's picture: main roots inside the menu's part, and some reaching out to the right.
  //   menu: the menu's part (its width and 10 px more on each side, the layer's margin), reach: how
  //   far beyond it roots may go, thin: their widths times this, blur: a soft edge (px), top: how
  //   strong they are at the very top (rising to whole by 45 % of the height, where the menu's
  //   entries no longer are, 85 % at the bottom), life: the main roots' length times this. Towards
  //   its right end it fades out to nothing: from `fadeAt` (px; 40 inside the menu's part unless
  //   given), down to `fadeMid` by 45 % of the way (0: evenly).
  function rootsPicture({ seed = 3, opacity = 0.045, mains = 3, menu = 268, reach = 640, height = 1400, reachers = 4, thin = 1, blur = 0, top = 0.3, life = 1, fadeAt = menu - 40, fadeMid = 0.45 }) {
    const W = menu + reach;
    const H = height;
    const rnd = random(seed);
    const strokes = [];
    const grow = rootGrower(rnd, strokes, (x, y) => !(x < -30 || x > W + 30 || y > H + 20 || y < -30));
    // The main roots, inside the menu's part.
    for (let i = 0; i < mains; i += 1) {
      const x = 10 + ((menu - 20) * (i + 0.5)) / mains + rnd.gauss() * 18;
      grow(x, -12, Math.PI / 2 + rnd.gauss() * 0.35, 3.6 + rnd() * 1.2, Math.round((190 + rnd() * 60) * life), 0);
    }
    // The ones reaching out: from the main roots' right side, off to the right, slowly bending down.
    const main = strokes.filter((s) => s.depth === 0);
    for (let i = 0; i < reachers && main.length; i += 1) {
      const from = main[Math.floor(rnd() * main.length)];
      const along = from.pts.filter(([x, y]) => x > menu * 0.35 && y > 60 && y < H * 0.75);
      if (!along.length) continue;
      const [x, y] = along[Math.floor(rnd() * along.length)];
      grow(x, y, -0.1 + rnd() * 0.5, 1.6 + rnd() * 0.8, 120 + Math.round(rnd() * 90), 1, 0.004);
    }
    strokes.sort((a, b) => a.depth - b.depth);
    const paths = strokes.flatMap((s) => rootPaths(s, thin));
    return `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}' viewBox='0 0 ${W} ${H}'>`
      + '<defs>'
      + rootsDown(top)
      + `<linearGradient id='h' gradientUnits='userSpaceOnUse' x1='${fadeAt}' y1='0' x2='${W}' y2='0'><stop offset='0' stop-color='#fff'/>${fadeMid ? `<stop offset='0.45' stop-color='#fff' stop-opacity='${fadeMid}'/>` : ''}<stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>`
      + `<mask id='mv'><rect width='${W}' height='${H}' fill='url(#v)'/></mask>`
      + `<mask id='mh'><rect width='${W}' height='${H}' fill='url(#h)'/></mask>`
      + (blur ? `<filter id='b' x='-5%' y='-5%' width='110%' height='110%'><feGaussianBlur stdDeviation='${blur}'/></filter>` : '')
      + '</defs>'
      + `<g mask='url(#mv)'><g mask='url(#mh)'><g opacity='${opacity}'${blur ? " filter='url(#b)'" : ''} fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round'>${paths.join('')}</g></g></g></svg>`;
  }

  // The roots beyond the menu, for reaching over further than the menu's own picture does: main roots
  // hanging from the top all along, each with what branches off it staying within SIDE px of where it
  // hangs. A picture that goes on into itself to the sides (a root that leaves it on one side comes in
  // on the other), W wide, so it can be laid over any width.
  const ROOTS_MORE = { W: 960, H: 1400, SIDE: 190, NEAR: 11, FAR: 15 };
  function rootsMore({ seed, mains, opacity, thin = 1, blur = 0, top = 0.3, life = 1 }) {
    const { W, H, SIDE } = ROOTS_MORE;
    const rnd = random(seed);
    const strokes = [];
    const grow = rootGrower(rnd, strokes, (x, y, home) => Math.abs(x - home) <= SIDE && y <= H + 20 && y >= -30);
    for (let i = 0; i < mains; i += 1) {
      const x = (W * (i + 0.5)) / mains + rnd.gauss() * 18;
      grow(x, -12, Math.PI / 2 + rnd.gauss() * 0.35, 3.6 + rnd() * 1.2, Math.round((190 + rnd() * 60) * life), 0);
    }
    strokes.sort((a, b) => a.depth - b.depth);
    const paths = [];
    for (const s of strokes) {
      const own = rootPaths(s, thin);
      if (!own.length) continue;
      // It, and every copy of it a whole picture to the side that reaches into the picture.
      const from = Math.min(...s.pts.map((q) => q[0])) - 6;
      const to = Math.max(...s.pts.map((q) => q[0])) + 6;
      for (let n = Math.ceil(-to / W); from + n * W <= W; n += 1) {
        paths.push(n ? `<g transform='translate(${n * W} 0)'>${own.join('')}</g>` : own.join(''));
      }
    }
    return svg(W, H, rootsDown(top) + `<mask id='mv'><rect width='${W}' height='${H}' fill='url(#v)'/></mask>`
      + (blur ? `<filter id='b' x='-5%' y='-5%' width='110%' height='110%'><feGaussianBlur stdDeviation='${blur}'/></filter>` : ''),
    `<g mask='url(#mv)'><g opacity='${opacity}'${blur ? " filter='url(#b)'" : ''} fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round'>${paths.join('')}</g></g>`);
  }

  // The ones in use (near: crisp; far: fainter, thinner, soft), four times as strong as they look as designed.
  // The menu's two pictures (768 wide: the menu's part and 500 px beyond it, the last 220 of them fading out),
  // and with `more` (the texture reaches over) the two that go on beyond the menu as far as it reaches.
  function roots(start, more) {
    const far = { opacity: 0.048, thin: 0.6, blur: 0.8, life: 1.3 };
    const near = { opacity: 0.068, life: 1.3 };
    const end = { reach: 500, fadeAt: 548, fadeMid: 0 };
    const files = {
      'roots-near.svg': rootsPicture({ seed: start('near'), ...near, ...end }),
      'roots-far.svg': rootsPicture({ seed: start('far'), mains: 4, reachers: 5, ...far, ...end }),
    };
    if (more) {
      files['roots-more-near.svg'] = rootsMore({ seed: start('more-near'), mains: ROOTS_MORE.NEAR, ...near });
      files['roots-more-far.svg'] = rootsMore({ seed: start('more-far'), mains: ROOTS_MORE.FAR, ...far });
    }
    return { files };
  }

  // ---- Currents: streamlines running down the menu, bundling and parting. A tile: every line is
  // a wave of whole turns over the tile's height, and the waves' places a whole turn over its width,
  // so it goes on into itself both ways. Each line in pieces with gaps, thinning out at their ends.
  const CURRENTS = { W: 320, T: 900 };
  function currentsPicture({ seed, lines, opacity, thin, blur }) {
    const { W, T } = CURRENTS;
    const rnd = random(seed);
    // Amplitude (px), turns over the height, turns of its place over the width. Kept under one
    // (sum of amplitude x turns x 2 pi / W), so lines bundle but never cross.
    const waves = [[22, 1, 1], [9, 2, 1], [4, 3, 2]].map(([a, k, c]) => ({ a, k, c, at: rnd() }));
    const xAt = (x0, y) => x0 + waves.reduce((sum, w) => sum + w.a * Math.sin(TAU * ((w.k * y) / T + (w.c * x0) / W + w.at)), 0);
    const paths = [];
    for (let i = 0; i < lines; i += 1) {
      const x0 = ((i + 0.5 + rnd.gauss() * 0.22) * W) / lines;
      const width = Math.max(0.4, (0.6 + rnd() * 0.9) * thin);
      const strength = 0.5 + rnd() * 0.5;
      const start = rnd() * T;
      let y = start;
      while (y < start + T - 120) {
        const len = Math.min(rnd.between(170, 520), start + T - y - rnd.between(30, 110));
        const pts = [];
        for (let s = 0; s <= len; s += 14) pts.push([xAt(x0, y + s), y + s]);
        const d = smooth(pts);
        // Every copy of it that reaches into the tile.
        for (const dy of [-2 * T, -T, 0]) {
          if (y + len + dy < -4 || y + dy > T + 4) continue;
          for (const dx of [-W, 0, W]) {
            if (x0 + dx < -45 || x0 + dx > W + 45) continue;
            paths.push(`<path d='${d}' transform='translate(${dx} ${dy})' stroke-width='${width.toFixed(2)}' stroke-opacity='${strength.toFixed(2)}'/>`);
          }
        }
        y += len + rnd.between(30, 110);
      }
    }
    const defs = "<linearGradient id='t' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fff' stop-opacity='0'/><stop offset='0.14' stop-color='#fff'/><stop offset='0.86' stop-color='#fff'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></linearGradient>"
      + (blur ? `<filter id='b' x='-20%' y='-5%' width='140%' height='110%'><feGaussianBlur stdDeviation='${blur}'/></filter>` : '');
    return svg(W, T, defs, `<g opacity='${opacity}'${blur ? " filter='url(#b)'" : ''} fill='none' stroke='url(#t)' stroke-linecap='round'>${paths.join('')}</g>`);
  }

  function currents(start) {
    return {
      files: {
        'currents-near.svg': currentsPicture({ seed: start('near'), lines: 9, opacity: 0.075, thin: 1, blur: 0 }),
        'currents-far.svg': currentsPicture({ seed: start('far'), lines: 13, opacity: 0.05, thin: 0.6, blur: 0.7 }),
      },
    };
  }

  // ---- Stars: dots at three depths, the nearest with a soft glow, a few joined into
  // constellations by hairlines. Tiles. The middle and near ones in two pictures each, so the
  // halves can twinkle by turns.
  const STARS = { W: 320, T: 640 };
  function stars(start, seeded) {
    const { W, T } = STARS;
    const rnd = random(start('all'));
    const glow = "<radialGradient id='g'><stop offset='0' stop-color='#fff' stop-opacity='0.5'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>";
    // A dot and the copies of it over the tile's edges.
    const dot = (x, y, r, a, halo) => {
      const out = [];
      const reach = halo ? r * 4 : r;
      for (const dx of [-W, 0, W]) {
        for (const dy of [-T, 0, T]) {
          if (x + dx < -reach || x + dx > W + reach || y + dy < -reach || y + dy > T + reach) continue;
          if (halo) out.push(`<circle cx='${f(x + dx)}' cy='${f(y + dy)}' r='${f(r * 4)}' fill='url(#g)' opacity='${(a * 0.5).toFixed(2)}'/>`);
          out.push(`<circle cx='${f(x + dx)}' cy='${f(y + dy)}' r='${r.toFixed(2)}' fill='#fff' opacity='${a.toFixed(2)}'/>`);
        }
      }
      return out.join('');
    };
    const field = (count, r0, r1, a0, a1, halo) => {
      const parts = ['', ''];
      for (let i = 0; i < count; i += 1) parts[i % 2] += dot(rnd() * W, rnd() * T, rnd.between(r0, r1), rnd.between(a0, a1), halo);
      return parts;
    };
    const far = field(150, 0.35, 0.7, 0.35, 0.9, false);
    const mid = field(64, 0.6, 1.0, 0.5, 1, false);
    const near = field(18, 1.0, 1.7, 0.7, 1, true);
    // Constellations, each inside the tile: a few stars a short way from one another, joined in a row,
    // some with a side branch. A seed puts them elsewhere: one in each third of the tile's height.
    const shapes = ['', ''];
    let homes = [[70, 110], [215, 300], [95, 470]];
    if (seeded) {
      const where = random(start('homes'));
      homes = [0, 1, 2].map((n) => [where.between(60, W - 60), (n + where.between(0.25, 0.75)) * (T / 3)]);
    }
    homes.forEach(([hx, hy], n) => {
      let x = hx + rnd.gauss() * 14;
      let y = hy + rnd.gauss() * 14;
      let angle = rnd() * TAU;
      const pts = [[x, y]];
      const count = 4 + Math.floor(rnd() * 3);
      for (let i = 1; i < count; i += 1) {
        angle += rnd.gauss() * 1.1;
        const step = rnd.between(24, 46);
        x = Math.min(W - 24, Math.max(24, x + Math.cos(angle) * step));
        y = Math.min(T - 24, Math.max(24, y + Math.sin(angle) * step));
        pts.push([x, y]);
      }
      let lines = `<path d='M${pts.map(([px, py]) => `${f(px)} ${f(py)}`).join('L')}'/>`;
      if (count > 4) {
        const from = pts[1 + Math.floor(rnd() * (count - 2))];
        const to = [from[0] + rnd.gauss() * 34, from[1] + rnd.between(22, 40) * (rnd() < 0.5 ? -1 : 1)];
        pts.push(to);
        lines += `<path d='M${f(from[0])} ${f(from[1])}L${f(to[0])} ${f(to[1])}'/>`;
      }
      shapes[n % 2] += `<g fill='none' stroke='#fff' stroke-width='0.5' stroke-opacity='0.55'>${lines}</g>`
        + pts.map(([px, py]) => dot(px, py, rnd.between(1.1, 1.6), 1, true)).join('');
    });
    return {
      files: {
        'stars-far.svg': svg(W, T, '', `<g opacity='0.19'>${far[0]}${far[1]}</g>`),
        'stars-mid-a.svg': svg(W, T, '', `<g opacity='0.26'>${mid[0]}</g>`),
        'stars-mid-b.svg': svg(W, T, '', `<g opacity='0.26'>${mid[1]}</g>`),
        'stars-near-a.svg': svg(W, T, glow, `<g opacity='0.36'>${near[0]}${shapes[0]}</g>`),
        'stars-near-b.svg': svg(W, T, glow, `<g opacity='0.36'>${near[1]}${shapes[1]}</g>`),
      },
    };
  }

  // ---- Vinyl: a record lying beyond the menu's bottom left corner. Its grooves as rings round
  // that middle, in bands (the songs) with gaps between, and the label's edge in the corner.
  // A second picture of the same rings, whole: what the turning light shines through (a mask).
  // With a seed also the light's beams (menuBg.js draws them): how wide the two strong ones are
  // and where the two faint ones lie between them. The picture is as wide as any window (the rings are whole
  // circles anyway, and each next one is made after the ones inside it: the menu's part is the same at any width).
  const VINYL = { W: 4000, H: 3200, CX: -40, CY: 3240 };
  function vinyl(start, seeded) {
    const { W, H, CX, CY } = VINYL;
    const rnd = random(start('all'));
    const rings = [];
    const far = Math.hypot(W - CX, CY) + 4;
    let r = 150;
    let band = rnd.between(170, 300);
    while (r < far) {
      rings.push({ r, a: rnd.between(0.4, 1), w: rnd.between(0.45, 0.7) });
      r += 2.9 + rnd() * 0.7;
      band -= 3.2;
      if (band < 0) {
        // The gap between two songs, with the one groove leading over.
        rings.push({ r: r + 5, a: 0.5, w: 0.45 });
        r += 11;
        band = rnd.between(170, 300);
      }
    }
    const circle = (ring, a, w) => `<circle cx='${CX}' cy='${CY}' r='${f(ring.r)}' stroke-width='${w.toFixed(2)}' stroke-opacity='${a.toFixed(2)}'/>`;
    // The label (a faint disc), its edge, and the run-out groove before the first song.
    const label = `<circle cx='${CX}' cy='${CY}' r='96' fill='#fff' fill-opacity='0.16' stroke-width='1' stroke-opacity='0.9'/>`
      + `<circle cx='${CX}' cy='${CY}' r='90' stroke-width='0.5' stroke-opacity='0.5'/>`
      + `<circle cx='${CX}' cy='${CY}' r='124' stroke-width='0.5' stroke-opacity='0.6'/>`;
    const out = {
      files: {
        'vinyl-grooves.svg': svg(W, H, '', `<g opacity='0.085' fill='none' stroke='#fff'>${label}${rings.map((g) => circle(g, g.a, g.w)).join('')}</g>`),
        'vinyl-mask.svg': svg(W, H, '', `<g fill='none' stroke='#fff'>${label}${rings.map((g) => circle(g, 0.45 + g.a * 0.55, g.w + 0.5)).join('')}</g>`),
      },
    };
    if (seeded) {
      const light = random(start('light'));
      const wide = Math.round(light.between(8, 13));
      const at = Math.round(light.between(55, 125));
      const thin = Math.round(light.between(5, 8));
      const faint = Math.round(light.between(35, 60)) / 100;
      // Where (degrees), how wide (to each side), how strong.
      out.beams = [[0, wide, 1], [180, wide, 1], [at, thin, faint], [at + 180, thin, faint]];
    }
    return out;
  }

  // ---- Mist: soft long wisps, nothing with an edge. Tiles (the menu shows them from its bottom
  // up, thinning out: menuBg.css).
  const MIST = { W: 320, T: 800 };
  function mistPicture({ seed, count, opacity, size }) {
    const { W, T } = MIST;
    const rnd = random(seed);
    const parts = [];
    for (let i = 0; i < count; i += 1) {
      const x = rnd() * W;
      const y = rnd() * T;
      const rx = rnd.between(60, 150) * size;
      const ry = rnd.between(14, 40) * size;
      const turn = rnd.gauss() * 24;
      const a = rnd.between(0.35, 1);
      for (const dx of [-W, 0, W]) {
        for (const dy of [-T, 0, T]) {
          if (x + dx < -rx || x + dx > W + rx || y + dy < -rx || y + dy > T + rx) continue;
          parts.push(`<ellipse cx='${f(x + dx)}' cy='${f(y + dy)}' rx='${f(rx)}' ry='${f(ry)}' transform='rotate(${f(turn)} ${f(x + dx)} ${f(y + dy)})' opacity='${a.toFixed(2)}'/>`);
        }
      }
    }
    const defs = "<radialGradient id='m'><stop offset='0' stop-color='#fff' stop-opacity='1'/><stop offset='0.45' stop-color='#fff' stop-opacity='0.45'/><stop offset='1' stop-color='#fff' stop-opacity='0'/></radialGradient>";
    return svg(W, T, defs, `<g opacity='${opacity}' fill='url(#m)'>${parts.join('')}</g>`);
  }

  function mist(start) {
    return {
      files: {
        'mist-near.svg': mistPicture({ seed: start('near'), count: 20, opacity: 0.1, size: 1 }),
        'mist-far.svg': mistPicture({ seed: start('far'), count: 26, opacity: 0.075, size: 0.75 }),
      },
    };
  }

  // ---- Circuit: traces on a grid, from the menu's bottom edge upwards, and higher up from pads
  // of their own, turning at right angles, branching, each ending in a pad. Fainter the higher they
  // are. How full the grid gets is set (FILL: the part of its places a trace lies on) and differs
  // a little from seed to seed (FULL), and every stretch of the height is filled up to it, so no
  // seed leaves a part empty or crams one. The picture goes on into itself to the sides (the grid
  // is round: its last column lies beside its first), so a trace that leaves it on one side comes
  // in on the other: in the menu, from the window's edge.
  // With the picture, the traces' ways for the lights menuBg.js sends along them: for every trace
  // one row of numbers: which way its trunk is (the trace that starts at the bottom edge or at a
  // pad of its own; itself, if it is one), how far along it leaves the trace it branches from (px;
  // 0: a trunk), then its corners from its start to its pad as x, y (y up from the picture's
  // bottom; x may lie beyond the picture's sides, where the trace went round).
  const CIRCUIT = { W: 480, H: 1400, GRID: 12, LEFT: 6, FILL: 0.31, FULL: [0.88, 1.14], START: [0.5, 0.62], BAND: 9 };
  function circuit(start) {
    const { W, H, GRID, LEFT, BAND } = CIRCUIT;
    const rnd = random(start('all'));
    const fill = CIRCUIT.FILL * rnd.between(CIRCUIT.FULL[0], CIRCUIT.FULL[1]);
    const cols = W / GRID;
    // Up to the picture's top.
    const rows = Math.floor(H / GRID) - 1;
    const taken = new Set();
    // How many places are taken in each stretch of BAND rows.
    const bands = new Array(Math.ceil((rows + 1) / BAND)).fill(0);
    // A column counted on beyond the last one (or before the first) is the one it comes to going round.
    const key = (c, r) => (((c % cols) + cols) % cols) * 1000 + r;
    const free = (c, r) => r >= 0 && r <= rows && !taken.has(key(c, r));
    const take = (c, r) => {
      taken.add(key(c, r));
      bands[Math.floor(r / BAND)] += 1;
    };
    const untake = (c, r) => {
      if (taken.delete(key(c, r))) bands[Math.floor(r / BAND)] -= 1;
    };
    const traces = []; // { cells: [[c, r]] (a branch's first: the place it leaves its trace at), pad, parent, at, source }
    // A way from c, r: up a stretch, a few cells sideways, up again, until it is `want` cells long or shut in.
    // Its cells are taken as it goes, so traces run beside one another but never touch.
    const run = (c, r, want, cells, branches) => {
      let left = want;
      let side = rnd() < 0.5 ? -1 : 1;
      while (left > 0) {
        let up = Math.round(rnd.between(3, 14));
        while (up > 0 && left > 0 && free(c, r + 1)) {
          r += 1;
          cells.push([c, r]);
          take(c, r);
          up -= 1;
          left -= 1;
        }
        if (left <= 0 || up > 0) break;
        // A branch from here now and then.
        if (rnd() < 0.3) branches.push({ at: cells.length - 1, side: -side });
        let over = Math.round(rnd.between(1, 3));
        let moved = 0;
        // Sideways only where it can go on up afterwards, and not right under another trace.
        while (over > 0 && free(c + side, r) && free(c + side, r + 1) && free(c + side, r - 1)) {
          c += side;
          cells.push([c, r]);
          take(c, r);
          over -= 1;
          moved += 1;
          left -= 1;
        }
        if (!moved) break;
        side = rnd() < 0.6 ? -side : side;
      }
      return cells;
    };
    const add = (cells, parent = -1, at = 0, source = false) => traces.push({ cells, pad: parent < 0 && rnd() < 0.3 ? 'square' : 'ring', parent, at, source }) - 1;
    // A branch off trace `pi` at its cell `at`: a cell sideways first, then on as any trace (with branches of its own).
    const arm = (pi, at, side, want) => {
      const [c, r] = traces[pi].cells[at];
      if (!free(c + side, r) || !free(c + side, r + 1)) return false;
      take(c + side, r);
      const branches = [];
      const cells = run(c + side, r, want, [[c, r], [c + side, r]], branches);
      if (cells.length < 4) {
        cells.slice(1).forEach(([cc, rr]) => untake(cc, rr));
        return false;
      }
      sprout(add(cells, pi, at), branches);
      return true;
    };
    // Not from a trace's first place (the edge, or where it branches off itself) or from its pad.
    const sprout = (ti, branches) => {
      for (const b of branches) {
        if (b.at > 0 && b.at < traces[ti].cells.length - 2) arm(ti, b.at, b.side, Math.round(rnd.between(4, 18)));
      }
    };
    // A trace that begins at row r, at a pad of its own: a few cells sideways first, then on as any trace.
    const source = (r) => {
      let c = Math.floor(rnd() * cols);
      const dir = rnd() < 0.5 ? -1 : 1;
      if (!free(c, r) || !free(c, r + 1) || !free(c, r - 1)) return false;
      const cells = [[c, r]];
      let over = Math.round(rnd.between(2, 9));
      while (over > 0 && free(c + dir, r) && free(c + dir, r + 1) && free(c + dir, r - 1)) {
        c += dir;
        cells.push([c, r]);
        over -= 1;
      }
      if (cells.length < 3) return false;
      cells.forEach(([cc, rr]) => take(cc, rr));
      const branches = [];
      run(c, r, Math.round(rnd.between(6, 34)), cells, branches);
      sprout(add(cells, -1, 0, true), branches);
      return true;
    };

    // From the bottom edge: a good half of its places (START), in a mixed order; of every length, a few up to the top.
    const first = [];
    for (let c = 0; c < cols; c += 1) first.push(c);
    for (let i = first.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rnd() * (i + 1));
      [first[i], first[j]] = [first[j], first[i]];
    }
    first.length = Math.round(cols * rnd.between(CIRCUIT.START[0], CIRCUIT.START[1]));
    for (const c of first) {
      if (!free(c, 0)) continue;
      take(c, 0);
      const branches = [];
      const cells = run(c, 0, Math.round(6 + (rnd() ** 1.25) * (rows - 8)), [[c, 0]], branches);
      sprout(add(cells), branches);
    }
    // And ones that begin higher up, all the way up.
    for (let r = 10 + Math.round(rnd() * 6); r < rows - 6; r += Math.round(rnd.between(4, 9))) source(r);
    // Filled up: the emptiest stretch of the height gets one more branch off a trace running through it (or
    // one more trace of its own), again and again, until every stretch is as full as this seed is.
    const places = (b) => cols * Math.min(BAND, rows + 1 - b * BAND);
    const shut = new Array(bands.length).fill(0);
    for (let tries = 0; tries < 700; tries += 1) {
      let b = -1;
      let least = fill;
      for (let i = 0; i < bands.length; i += 1) {
        const full = bands[i] / places(i);
        if (shut[i] < 5 && full < least) {
          least = full;
          b = i;
        }
      }
      if (b < 0) break;
      const spots = [];
      traces.forEach((t, ti) => {
        for (let i = 1; i < t.cells.length - 2; i += 1) {
          const [c, r] = t.cells[i];
          if (Math.floor(r / BAND) !== b) continue;
          for (const side of [-1, 1]) if (free(c + side, r) && free(c + side, r + 1) && free(c + side, r - 1)) spots.push([ti, i, side]);
        }
      });
      let done = false;
      // Mostly a branch; a trace of its own now and then, so not everything hangs on a few trunks.
      if (spots.length && rnd() < 0.8) {
        const [ti, i, side] = rnd.pick(spots);
        done = arm(ti, i, side, Math.round(rnd.between(5, 26)));
      }
      if (!done) {
        const r = Math.min(rows - 3, Math.max(4, b * BAND + Math.floor(rnd() * BAND)));
        done = source(r);
      }
      if (!done) shut[b] += 1;
    }

    const X = (c) => LEFT + c * GRID;
    const Y = (r) => H - r * GRID;
    // Only the corners of a way.
    const corners = (cells) => cells.filter((p, i) => i === 0 || i === cells.length - 1
      || (cells[i - 1][0] === p[0]) !== (cells[i + 1][0] === p[0]));
    // The whole way from its trunk's start to a trace's cell `at`, through the traces it branches from.
    const upTo = (t, at) => (t.parent < 0 ? t.cells.slice(0, at + 1) : [...upTo(traces[t.parent], t.at), ...t.cells.slice(1, at + 1)]);
    const trunk = (ti) => (traces[ti].parent < 0 ? ti : trunk(traces[ti].parent));
    const parts = [];
    const ways = [];
    traces.forEach((t, ti) => {
      const pts = corners(t.cells);
      const end = pts[pts.length - 1];
      // The line stops at the pad's rim (and begins at the rim of the pad it starts from, if it has one).
      const before = pts[pts.length - 2];
      const dir = [Math.sign(end[0] - before[0]), Math.sign(end[1] - before[1])];
      const out = [Math.sign(pts[1][0] - pts[0][0]), Math.sign(pts[1][1] - pts[0][1])];
      const d = pts.map(([c, r], i) => {
        if (i === pts.length - 1) return `${f(X(c) - dir[0] * 3)} ${f(Y(r) + dir[1] * 3)}`;
        if (i === 0 && t.source) return `${f(X(c) + out[0] * 3)} ${f(Y(r) - out[1] * 3)}`;
        return `${X(c)} ${Y(r)}`;
      }).join('L');
      const own = [`<path d='M${d}'/>`];
      own.push(t.pad === 'square'
        ? `<rect x='${X(end[0]) - 3}' y='${Y(end[1]) - 3}' width='6' height='6' fill='#fff' fill-opacity='0.55'/>`
        : `<circle cx='${X(end[0])}' cy='${Y(end[1])}' r='3'/>`);
      if (t.source) own.push(`<circle cx='${X(pts[0][0])}' cy='${Y(pts[0][1])}' r='3'/>`);
      if (t.parent >= 0) own.push(`<circle cx='${X(t.cells[0][0])}' cy='${Y(t.cells[0][1])}' r='1.7' fill='#fff' stroke='none'/>`);
      // It, and every copy of it a whole picture to the side that reaches into the picture.
      const left = Math.min(...pts.map((q) => X(q[0]))) - 4;
      const right = Math.max(...pts.map((q) => X(q[0]))) + 4;
      for (let n = Math.ceil(-right / W); left + n * W <= W; n += 1) {
        parts.push(n ? `<g transform='translate(${n * W} 0)'>${own.join('')}</g>` : own.join(''));
      }
      const from = t.parent < 0 ? 0 : (upTo(traces[t.parent], t.at).length - 1) * GRID;
      ways.push([trunk(ti), from, ...corners(upTo(t, t.cells.length - 1)).map(([c, r]) => [X(c), r * GRID]).flat()]);
    });
    const defs = `<linearGradient id='v' gradientUnits='userSpaceOnUse' x1='0' y1='${H}' x2='0' y2='0'><stop offset='0' stop-color='#fff'/><stop offset='0.5' stop-color='#fff' stop-opacity='0.8'/><stop offset='1' stop-color='#fff' stop-opacity='0.3'/></linearGradient>`
      + `<mask id='mv'><rect width='${W}' height='${H}' fill='url(#v)'/></mask>`;
    return {
      files: { 'circuit.svg': svg(W, H, defs, `<g mask='url(#mv)'><g opacity='0.085' fill='none' stroke='#fff' stroke-width='1' stroke-linejoin='miter'>${parts.join('')}</g></g>`) },
      ways,
    };
  }

  // ---- Vines: Roots' counterpart. Tendrils climbing up from the menu's bottom edge to the picture's top, branching,
  // with small leaves by turns left and right. Grown as the roots are (downwards) and turned over. The picture goes
  // on into itself to the sides: a tendril that leaves it on one side comes in on the other.
  // A tendril and all that branches off it stay within SIDE px of where it stands, so they climb rather than spread.
  const VINES = { W: 480, H: 1400, SIDE: 120 };
  function vinesPicture({ seed, mains, opacity, thin, blur, life }) {
    const { W, H } = VINES;
    const rnd = random(seed);
    const strokes = [];
    const grow = (x, y, angle, w0, steps, depth, home) => {
      const pts = [[x, y]];
      let turn = 0;
      let w = w0;
      const gravity = [0.028, 0.012, 0.008][depth] || 0.006;
      for (let step = 0; step < steps; step += 1) {
        turn = turn * 0.8 + rnd.gauss() * (0.075 + depth * 0.03);
        angle += turn + (Math.PI / 2 - angle) * gravity;
        const len = 4.5 + rnd() * 2.5;
        x += Math.cos(angle) * len;
        y += Math.sin(angle) * len;
        if (Math.abs(x - home) > VINES.SIDE || y < -30 || y > H + 10) break;
        pts.push([x, y]);
        w = w0 * (1 - (step + 1) / (steps + 1)) + 0.35 * ((step + 1) / (steps + 1));
        const chance = [0.06, 0.05, 0.03][depth] || 0;
        if (depth < 3 && step > 5 && step < steps - 4 && rnd() < chance) {
          const side = rnd() < 0.5 ? -1 : 1;
          const child = Math.round((steps - step) * (0.3 + rnd() * 0.3) + 8);
          grow(x, y, angle + side * (0.5 + rnd() * 0.6), Math.max(0.5, w * (0.5 + rnd() * 0.15)), child, depth + 1, home);
        }
      }
      if (pts.length > 1) strokes.push({ pts, w0, w1: w, depth });
    };
    for (let i = 0; i < mains; i += 1) {
      const x = (W * (i + 0.5)) / mains + rnd.gauss() * 16;
      grow(x, -12, Math.PI / 2 + rnd.gauss() * 0.3, 3 + rnd() * 1.1, Math.round(rnd.between(215, 285) * life), 0, x);
    }
    // Turned over: the bottom edge is where they start.
    const up = ([x, y]) => [x, H - y];
    const paths = [];
    const leaves = [];
    // A tendril's parts, and every copy of them a whole picture to the side that reaches into the picture.
    const wrapped = (into, own, from, to) => {
      for (let n = Math.ceil((-24 - to) / W); from + n * W <= W + 24; n += 1) {
        if (own.length) into.push(n ? `<g transform='translate(${n * W} 0)'>${own.join('')}</g>` : own.join(''));
      }
    };
    strokes.sort((a, b) => a.depth - b.depth);
    for (const s of strokes) {
      const pts = s.pts.map(up);
      const n = pts.length;
      const PIECE = 6;
      const from = Math.min(...pts.map((q) => q[0]));
      const to = Math.max(...pts.map((q) => q[0]));
      const ownPaths = [];
      const ownLeaves = [];
      for (let i = 0; i < n - 1; i += PIECE) {
        const part = pts.slice(i, Math.min(n, i + PIECE + 1));
        if (part.length < 2) continue;
        const t = (i + part.length / 2) / n;
        const width = (s.w0 + (s.w1 - s.w0) * t) * thin;
        ownPaths.push(`<path d='${smooth(part)}' stroke-width='${Math.max(0.35, width).toFixed(2)}'/>`);
      }
      // Leaves along it, by turns left and right; the main stems only higher up.
      let side = rnd() < 0.5 ? -1 : 1;
      const every = s.depth === 0 ? 9 : 6;
      for (let i = s.depth === 0 ? Math.round(n * 0.3) : 2; i < n - 1; i += every + Math.floor(rnd() * 3)) {
        const [x, y] = pts[i];
        const [nx, ny] = pts[i + 1];
        const along = Math.atan2(ny - y, nx - x);
        const angle = along + side * rnd.between(0.7, 1.15);
        const len = rnd.between(11, 17) * (0.6 + 0.4 * (1 - i / n)) * Math.max(0.75, thin);
        const wide = len * 0.4;
        const deg = (angle * 180) / Math.PI;
        ownLeaves.push(`<path transform='translate(${f(x)} ${f(y)}) rotate(${f(deg)})' d='M0 0Q${f(len * 0.4)} ${f(-wide)} ${f(len)} 0Q${f(len * 0.4)} ${f(wide)} 0 0Z'/>`);
        side = -side;
      }
      wrapped(paths, ownPaths, from, to);
      wrapped(leaves, ownLeaves, from, to);
    }
    // Whole at the bottom, fainter the higher, up to the picture's top.
    const defs = `<linearGradient id='v' gradientUnits='userSpaceOnUse' x1='0' y1='${H}' x2='0' y2='0'><stop offset='0' stop-color='#fff'/><stop offset='0.5' stop-color='#fff' stop-opacity='0.8'/><stop offset='1' stop-color='#fff' stop-opacity='0.3'/></linearGradient>`
      + `<mask id='mv'><rect width='${W}' height='${H}' fill='url(#v)'/></mask>`
      + (blur ? `<filter id='b' x='-5%' y='-5%' width='110%' height='110%'><feGaussianBlur stdDeviation='${blur}'/></filter>` : '');
    return svg(W, H, defs, `<g mask='url(#mv)'><g opacity='${opacity}'${blur ? " filter='url(#b)'" : ''}>`
      + `<g fill='none' stroke='#fff' stroke-linecap='round' stroke-linejoin='round'>${paths.join('')}</g>`
      + `<g fill='#fff' fill-opacity='0.75'>${leaves.join('')}</g></g></g>`);
  }

  function vines(start) {
    return {
      files: {
        'vines-near.svg': vinesPicture({ seed: start('near'), mains: 5, opacity: 0.068, thin: 1, blur: 0, life: 1 }),
        'vines-far.svg': vinesPicture({ seed: start('far'), mains: 7, opacity: 0.048, thin: 0.6, blur: 0.8, life: 1.15 }),
      },
    };
  }

  // ---- Scales: a snake's or a dragon's. One picture: one scale of a row, as wide as the tile
  // (menuBg.js lays the rows under one another, every other one half a scale over, each row over
  // the one below it, and moves each by itself). A scale is its whole body: from under the row
  // above (BAND px that this row above hides: so rows can slide over one another and apart
  // without a gap) down to its tip (DEEP px below its shoulders). The body is filled with the
  // menu's colour, so it hides what lies under it, as a scale does; on it light gathering towards
  // the tip, its rim, some with a ridge down the middle, and under the rim its shadow on the row
  // below.
  //
  // scalesLook(seed): the scales' measures and how they move, which menuBg.js needs with the
  // picture (also for the standard look, no seed). A seed changes the scales' size a little, their
  // shape from round (`point` 0) to a pointed tip (1), the ridge, and how the rows move: the two
  // waves that sway them (px to each side, a swing's seconds, its length down the menu; negative:
  // it runs up), the wave that pushes rows together and apart (`squeeze`: px, seconds, length) and
  // how far each row slides by itself (`own`: px sideways, px up and down).
  const MENU_COLOUR = '#17171a';
  function scalesLook(seed) {
    const look = {
      W: 40, ROW: 24, DEEP: 28, point: 0.2, ridge: 0,
      waves: [[9, 16, 520], [4, 27, -860]],
      squeeze: [1.3, 13, 210],
      own: [2, 0.6],
      key: 1,
    };
    if (seed) {
      const rnd = random(number(`scales:${seed}:look`));
      const way = rnd() < 0.5 ? -1 : 1;
      look.W = Math.round(rnd.between(34, 46));
      look.ROW = Math.round(rnd.between(20, 27));
      look.DEEP = Math.round(look.ROW * rnd.between(1.05, 1.35));
      look.point = Math.round(rnd() * 100) / 100;
      look.ridge = rnd() < 0.45 ? Math.round(rnd.between(0.4, 1) * 100) / 100 : 0;
      look.waves = [
        [Math.round(rnd.between(6, 12)), Math.round(rnd.between(12, 22)), way * Math.round(rnd.between(380, 700))],
        [Math.round(rnd.between(2, 5)), Math.round(rnd.between(22, 34)), -way * Math.round(rnd.between(650, 1000))],
      ];
      look.squeeze = [Math.round(rnd.between(0.9, 1.8) * 10) / 10, Math.round(rnd.between(9, 17)), Math.round(rnd.between(150, 280))];
      look.own = [Math.round(rnd.between(1.4, 3) * 10) / 10, Math.round(rnd.between(0.4, 0.9) * 10) / 10];
      look.key = Math.floor(rnd() * 1000);
    }
    // What the row above hides, and the picture's height (a little more for the shadow).
    look.BAND = look.ROW + 6;
    look.H = look.BAND + look.DEEP + 4;
    return look;
  }

  function scales(seed) {
    const look = scalesLook(seed);
    const { W, DEEP, BAND, H, point } = look;
    const tip = BAND + DEEP;
    // From its left shoulder round the tip to its right one; `dy` lower (the shadow).
    const side = BAND + DEEP * (0.72 - 0.3 * point);
    const under = tip - DEEP * 0.34 * point;
    const rim = (dy) => `M0 ${BAND + dy}C0 ${f(side + dy)} ${f(W * (0.24 + 0.2 * point))} ${f(under + dy)} ${W / 2} ${tip + dy}`
      + `C${f(W * (0.76 - 0.2 * point))} ${f(under + dy)} ${W} ${f(side + dy)} ${W} ${BAND + dy}`;
    const body = `${rim(0)}V0H0Z`;
    const defs = `<linearGradient id='l' gradientUnits='userSpaceOnUse' x1='0' y1='${BAND - 4}' x2='0' y2='${tip}'><stop offset='0' stop-color='#fff' stop-opacity='0'/><stop offset='0.55' stop-color='#fff' stop-opacity='0.12'/><stop offset='1' stop-color='#fff' stop-opacity='0.5'/></linearGradient>`;
    const picture = svg(W, H, defs, `<path d='${rim(2.4)}' fill='none' stroke='#000' stroke-width='3.2' opacity='0.1'/>`
      + `<path d='${rim(1.5)}' fill='none' stroke='#000' stroke-width='1.8' opacity='0.2'/>`
      + `<path d='${body}' fill='${MENU_COLOUR}'/>`
      + `<path d='${body}' fill='url(#l)' opacity='0.1'/>`
      + (look.ridge ? `<path d='M${W / 2} ${f(BAND + DEEP * 0.1)}V${f(tip - 1.5)}' fill='none' stroke='#fff' stroke-width='0.7' opacity='${(0.07 * look.ridge).toFixed(3)}'/>` : '')
      + `<path d='${rim(0)}' fill='none' stroke='#fff' stroke-width='0.9' opacity='0.1'/>`);
    return { files: { 'scales.svg': picture }, look };
  }

  // Each style: how it is made, and the numbers its standard look starts from.
  const STYLES = {
    roots: (seed, more) => roots(starts('roots', seed, { near: 3, far: 11, 'more-near': 41, 'more-far': 57 }), more),
    currents: (seed) => currents(starts('currents', seed, { near: 5, far: 17 })),
    stars: (seed) => stars(starts('stars', seed, { all: 21 }), !!seed),
    vinyl: (seed) => vinyl(starts('vinyl', seed, { all: 8 }), !!seed),
    mist: (seed) => mist(starts('mist', seed, { near: 4, far: 12 })),
    circuit: (seed) => circuit(starts('circuit', seed, { all: 31 })),
    vines: (seed) => vines(starts('vines', seed, { near: 9, far: 23 })),
    scales,
  };

  return {
    STYLES: Object.keys(STYLES),
    clean,
    dice,
    /**
     * A style's pictures (and what goes with them) for a seed; none: its standard look. `more`: also the
     * pictures a style needs only for reaching over beyond the menu (Roots).
     */
    make(style, seed = '', more = false) {
      return STYLES[style](clean(seed), more);
    },
    scalesLook: (seed = '') => scalesLook(clean(seed)),
    // For scripts/make-menu-roots.js: one picture of roots, every number its own.
    rootsPicture,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MenuBgMake;
