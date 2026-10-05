'use strict';

// Where an element really is after a seek. In an MP3 the browser seeks by the
// file's coarse table (or a guess from its bitrate), lands up to a second or
// more away from the place asked for, and then says it is at that place: the
// sound and currentTime stay that far apart until the next seek. Alone that
// is hardly heard; playing in step with other devices (Active Sessions) it is
// an echo. So after a seek in such a song a moment of what the element sounds
// (seekTap.js) is matched against the song decoded once from its start (at
// RATE, one channel), which tells the real place, and with it how far off
// currentTime is.

const SeekCheck = {
  RATE: 8000,
  // How much is heard and matched, and how far around the place said it is looked for.
  LISTEN_S: 2,
  SPAN_S: 6,
  // How alike the best match must be (1: the same) to be believed, and how
  // close another place (RIVAL_MS away or more) may come to it: music that
  // repeats itself (a loop, a held tone) fits more than one place, and then
  // nothing is corrected rather than the wrong thing.
  MIN_SCORE: 0.5,
  MAX_RIVAL: 0.8,
  RIVAL_MS: 40,
  _module: null,
  _refs: new Map(),
  _asks: 0,

  /** A tap on `node`'s sound (an element's own gain), or null without AudioWorklet. Resolves. */
  async tap(ctx, node) {
    try {
      this._module = this._module || ctx.audioWorklet.addModule('app/seekTap.js');
      await this._module;
      const tap = new AudioWorkletNode(ctx, 'seek-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
      node.connect(tap);
      const waiting = new Map();
      tap.port.onmessage = (m) => {
        const done = waiting.get(m.data.id);
        waiting.delete(m.data.id);
        if (done) done(m.data);
      };
      return {
        /** The last `seconds` sounded: { data (at the context's rate), end (context time) }. */
        listen: (seconds) => new Promise((resolve) => {
          this._asks += 1;
          waiting.set(this._asks, resolve);
          tap.port.postMessage({ id: this._asks, seconds });
        }),
      };
    } catch (err) {
      console.warn('No seek check:', err);
      return null;
    }
  },

  /** A song decoded from its start at RATE, one channel (two kept at most). Resolves, or rejects. */
  reference(songId) {
    if (!this._refs.has(songId)) {
      const p = (async () => {
        const bytes = await window.flow.songAudio(songId);
        const own = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const decoded = await new OfflineAudioContext(1, 1, this.RATE).decodeAudioData(own);
        const mono = new Float32Array(decoded.length);
        for (let c = 0; c < decoded.numberOfChannels; c += 1) {
          const d = decoded.getChannelData(c);
          for (let i = 0; i < d.length; i += 1) mono[i] += d[i] / decoded.numberOfChannels;
        }
        return mono;
      })();
      p.catch(() => this._refs.delete(songId));
      this._refs.set(songId, p);
      while (this._refs.size > 2) this._refs.delete(this._refs.keys().next().value);
    }
    return this._refs.get(songId);
  },

  /**
   * How far `el`'s currentTime is ahead of what it sounds (s), from what the
   * tap heard: { error, score }, or null when nothing can be told (silence,
   * a match not alike enough, the element moved meanwhile). `times` are
   * { c, e } pairs (context time, currentTime) sampled while it listened.
   */
  async measure(tap, ctx, songId, times) {
    const ref = await this.reference(songId);
    const heard = await tap.listen(this.LISTEN_S);
    const start = heard.end - heard.data.length / ctx.sampleRate;
    const e0 = this._elementAt(times, start);
    if (!Number.isFinite(e0) || heard.data.length < ctx.sampleRate * this.LISTEN_S * 0.9) return null;
    const x = this._down(heard.data, ctx.sampleRate / this.RATE);
    const m = this._match(ref, x, Math.round(e0 * this.RATE), Math.round(this.SPAN_S * this.RATE));
    if (!m || m.score < this.MIN_SCORE || m.rival > this.MAX_RIVAL) return null;
    return { error: e0 - m.index / this.RATE, score: m.score };
  },

  /** currentTime at context time `c`, between the samples around it. */
  _elementAt(times, c) {
    for (let i = times.length - 1; i > 0; i -= 1) {
      const a = times[i - 1];
      const b = times[i];
      if (a.c <= c && b.c >= c) {
        // Jumped in between (a seek): not to be trusted.
        if (Math.abs(b.e - a.e) > 0.5) return NaN;
        return b.c === a.c ? b.e : a.e + (b.e - a.e) * ((c - a.c) / (b.c - a.c));
      }
    }
    return NaN;
  },

  /** To RATE, by averaging. */
  _down(data, factor) {
    const out = new Float32Array(Math.floor(data.length / factor));
    for (let i = 0; i < out.length; i += 1) {
      const a = Math.floor(i * factor);
      const b = Math.max(a + 1, Math.floor((i + 1) * factor));
      let s = 0;
      for (let j = a; j < b; j += 1) s += data[j];
      out[i] = s / (b - a);
    }
    return out;
  },

  /**
   * Where in `ref` `x` fits best, around index `center` (+-`span`): { index,
   * score, rival } (score: the match's likeness, 1 the same shape; rival: how
   * close the best other place comes, 1 as good), or null. First every 8th
   * place on every 8th sample, then around the best one exactly.
   */
  _match(ref, x, center, span) {
    let xe = 0;
    for (let i = 0; i < x.length; i += 1) xe += x[i] * x[i];
    if (xe < 1e-6 * x.length) return null;
    const corr = (step, from, to, all = null) => {
      let best = null;
      for (let lag = Math.max(0, from); lag <= to && lag + x.length <= ref.length; lag += step) {
        let dot = 0;
        let energy = 0;
        for (let i = 0; i < x.length; i += step) {
          const r = ref[lag + i];
          dot += r * x[i];
          energy += r * r;
        }
        const score = energy > 0 ? dot / Math.sqrt(energy) : -Infinity;
        if (all) all.push(lag, score);
        if (!best || score > best.score) best = { index: lag, score };
      }
      return best;
    };
    const scores = [];
    const coarse = corr(8, center - span, center + span, scores);
    if (!coarse || !(coarse.score > 0)) return null;
    const apart = (this.RIVAL_MS / 1000) * this.RATE;
    let rival = 0;
    for (let i = 0; i < scores.length; i += 2) {
      if (Math.abs(scores[i] - coarse.index) > apart && scores[i + 1] > rival) rival = scores[i + 1];
    }
    const fine = corr(1, coarse.index - 16, coarse.index + 16);
    return fine ? { index: fine.index, score: fine.score / Math.sqrt(xe), rival: rival / coarse.score } : null;
  },
};
