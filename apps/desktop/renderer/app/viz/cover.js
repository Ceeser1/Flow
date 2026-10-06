'use strict';

// The song playing's cover, for the visualizers that show it (Halo, Prism):
// as a WebGL texture with its mipmaps, and its colours, the two most
// colourful hues in it. A song without a cover gets a stand-in drawn for it
// in a colour of its own (taken from its id): a record, or a pattern.
//
//   const cover = new VizCover(gl, { standIn: 'record' });
//   each frame: if (cover.update()) the song changed (cover.song: it, or null)
//   cover.tex, cover.loaded, cover.colors ([primary, secondary] rgb 0..1)

const VizCover = (() => {
  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  function hash(text) {
    let x = 2166136261;
    for (let i = 0; i < text.length; i += 1) x = Math.imul(x ^ text.charCodeAt(i), 16777619);
    return (x >>> 0) / 4294967296;
  }

  /**
   * The two most colourful hues of an image: [primary, secondary] as rgb,
   * read from it at 24 x 24; null for one with hardly any colour.
   */
  function paletteOf(img) {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 24;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 24, 24);
    const px = ctx.getImageData(0, 0, 24, 24).data;
    const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i] / 255;
      const g = px[i + 1] / 255;
      const b = px[i + 2] / 255;
      const max = Math.max(r, g, b);
      const sat = max ? (max - Math.min(r, g, b)) / max : 0;
      const w = sat * sat * max;
      if (w < 0.02) continue;
      const bin = bins[Math.floor(hueOf(r, g, b) / 30) % 12];
      bin.w += w;
      bin.r += r * w;
      bin.g += g * w;
      bin.b += b * w;
    }
    const order = bins.map((b, i) => ({ ...b, i })).filter((b) => b.w > 0).sort((x, y) => y.w - x.w);
    if (!order.length || order[0].w < 2) return null;
    const colour = (b) => {
      const rgb = [b.r / b.w, b.g / b.w, b.b / b.w];
      // As bright as a light: the strongest channel up to 1.
      const m = Math.max(...rgb, 0.01);
      return rgb.map((v) => Math.min(1, (v / m) * 0.95));
    };
    const first = order[0];
    const second = order.find((b) => Math.min(Math.abs(b.i - first.i), 12 - Math.abs(b.i - first.i)) >= 2 && b.w > first.w * 0.15);
    const a = colour(first);
    return [a, second ? colour(second) : a.map((v) => Math.min(1, v * 0.6 + 0.4))];
  }

  /** A record: dark grooves, a shine, and a label in the song's colour. */
  function record(hue) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(0, 0, 512, 512);
    for (let r = 250; r > 110; r -= 3) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.025 + 0.03 * Math.abs(Math.sin(r * 0.37))})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(256, 256, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    const shine = ctx.createConicGradient(0.6, 256, 256);
    shine.addColorStop(0, 'rgba(255,255,255,0)');
    shine.addColorStop(0.08, 'rgba(255,255,255,0.08)');
    shine.addColorStop(0.16, 'rgba(255,255,255,0)');
    shine.addColorStop(0.5, 'rgba(255,255,255,0)');
    shine.addColorStop(0.58, 'rgba(255,255,255,0.08)');
    shine.addColorStop(0.66, 'rgba(255,255,255,0)');
    ctx.fillStyle = shine;
    ctx.fillRect(0, 0, 512, 512);
    const [r, g, b] = hsv(hue, 0.75, 0.9).map((v) => Math.round(v * 255));
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.beginPath();
    ctx.arc(256, 256, 100, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0b0b0e';
    ctx.beginPath();
    ctx.arc(256, 256, 9, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  /** A pattern for a kaleidoscope to turn: bands and dots in three hues near the song's. */
  function pattern(hue) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const ctx = c.getContext('2d');
    const css = (hh, s, v) => `rgb(${hsv(((hh % 1) + 1) % 1, s, v).map((x) => Math.round(x * 255)).join(', ')})`;
    const bg = ctx.createLinearGradient(0, 0, 512, 512);
    bg.addColorStop(0, css(hue, 0.8, 0.35));
    bg.addColorStop(1, css(hue + 0.15, 0.8, 0.15));
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 512);
    let seed = Math.floor(hue * 1e6) || 1;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 26; i += 1) {
      ctx.strokeStyle = css(hue + (rand() - 0.5) * 0.3, 0.7, 0.6 + rand() * 0.4);
      ctx.lineWidth = 4 + rand() * 26;
      ctx.globalAlpha = 0.5 + rand() * 0.5;
      ctx.beginPath();
      ctx.moveTo(rand() * 512, rand() * 512);
      ctx.bezierCurveTo(rand() * 512, rand() * 512, rand() * 512, rand() * 512, rand() * 512, rand() * 512);
      ctx.stroke();
    }
    for (let i = 0; i < 40; i += 1) {
      ctx.fillStyle = css(hue + 0.5 + (rand() - 0.5) * 0.2, 0.6, 1);
      ctx.globalAlpha = 0.4 + rand() * 0.6;
      ctx.beginPath();
      ctx.arc(rand() * 512, rand() * 512, 3 + rand() * 14, 0, Math.PI * 2);
      ctx.fill();
    }
    return c;
  }

  class Cover {
    /** standIn: 'record' or 'pattern', for a song without a cover. */
    constructor(gl, { standIn = 'record' } = {}) {
      this.gl = gl;
      this.standIn = standIn;
      this.tex = gl.createTexture();
      this.key = null;
      this.song = null;
      this.loaded = false;
      this.colors = [[0.6, 0.4, 1], [1, 0.5, 0.8]];
    }

    /** True when the song (or its cover) changed since the last call. */
    update() {
      const id = Player.currentId;
      const song = id ? Store.song(id) || (Player.remote ? { ...Player.remote.state, id } : null) : null;
      const src = song ? Covers.src(song) : '';
      const key = `${id}|${src}`;
      if (key === this.key) return false;
      this.key = key;
      this.song = song;
      const hue = hash(id || 'flow');
      const fallback = () => {
        if (this.key !== key) return;
        this._upload(this.standIn === 'pattern' ? pattern(hue) : record(hue));
        this.colors = [hsv(hue, 0.7, 1), hsv((hue + 0.12) % 1, 0.6, 1)];
      };
      if (!src) {
        fallback();
        return true;
      }
      const img = new Image();
      img.onload = () => {
        if (this.key !== key) return;
        this._upload(img);
        let pal = null;
        try {
          pal = paletteOf(img);
        } catch {
          // Unreadable: the song's own colour.
        }
        this.colors = pal || [hsv(hue, 0.6, 1), hsv((hue + 0.1) % 1, 0.5, 1)];
      };
      img.onerror = fallback;
      img.src = src;
      return true;
    }

    _upload(source) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      this.loaded = true;
    }
  }

  Cover.hsv = hsv;
  return Cover;
})();
