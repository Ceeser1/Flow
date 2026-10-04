'use strict';

// What the player (player.js) plays its songs through. The player decides
// what plays and when; the engine only sounds it: one current song, and during
// a song transition a second one faded in over it, which then becomes the
// current song (promote) or is let go (cancelFade).
//
// The engine's events are the current song's only: play, pause, ended,
// timeupdate, seeking, durationchange, loadedmetadata and error; fadefailed
// when the song coming in cannot be played.
//
// HtmlAudioEngine plays through the window's two <audio> elements, routed
// through Web Audio by the equalizer (equalizer.js), which gives each its own
// loudness and fade gains. Without Web Audio the elements play as they are,
// with no transition or evening out (canFade is false, gains do nothing).

class HtmlAudioEngine {
  constructor(main, spare) {
    this.main = main;     // the current song
    this.spare = spare;   // the song coming in during a transition
    this._handlers = {};
    // The equalizer puts itself between the elements and the speakers, and
    // the volume then lives on its gain so the picture does not shrink with it.
    Equalizer.attach([main, spare]);

    // Both elements get the same handlers, which only pass on what the one
    // that is `main` at the time does: they swap at every transition.
    const mine = (type) => (e) => {
      if (e.target === this.main) this._emit(type);
    };
    for (const el of [main, spare]) {
      for (const type of ['play', 'pause', 'ended', 'timeupdate', 'seeking', 'durationchange', 'loadedmetadata']) {
        el.addEventListener(type, mine(type));
      }
      el.addEventListener('error', (e) => {
        if (e.target === this.main) this._emit('error');
        else if (e.target.getAttribute('src')) this._emit('fadefailed');
      });
    }
  }

  on(type, fn) {
    (this._handlers[type] = this._handlers[type] || []).push(fn);
  }

  _emit(type) {
    for (const fn of this._handlers[type] || []) fn();
  }

  // ---- the current song ----

  get paused() {
    return this.main.paused;
  }

  get time() {
    return this.main.currentTime;
  }

  /** As the element knows it: NaN before it is loaded. */
  get duration() {
    return this.main.duration;
  }

  /** How far loading has come, as HTMLMediaElement.readyState (1 = length known, 2 = can play). */
  get readyState() {
    return this.main.readyState;
  }

  /** Whether a song is loaded at all. */
  get loaded() {
    return !!this.main.getAttribute('src');
  }

  /**
   * Loads a song (paused) at loudness `gain`, at full fade. False when there
   * is nothing to play it from (src ''). `at` is where it is to start: the
   * player seeks there once the length is known (an engine that can start
   * there at once passes over that seek); the elements wait for that seek.
   */
  load(src, gain) {
    const ok = this._setSource(this.main, src);
    this._setNorm(this.main, gain);
    this._setFade(this.main, 1);
    return ok;
  }

  unload() {
    this.main.pause();
    this.main.removeAttribute('src');
    this.main.load();
  }

  /** Resolves once it plays; rejects when it cannot (AbortError: replaced by another load). */
  play() {
    return this.main.play() || Promise.resolve();
  }

  pause() {
    if (!this.main.paused) this.main.pause();
  }

  seek(seconds) {
    this.main.currentTime = seconds;
  }

  /** Plays a little faster or slower (in step with a session's host). */
  setRate(rate) {
    this.main.playbackRate = rate;
  }

  /** The current song's loudness gain; `smooth` glides there. */
  setGain(gain, smooth = false) {
    this._setNorm(this.main, gain, smooth);
  }

  setVolume(v) {
    for (const el of [this.main, this.spare]) el.volume = Equalizer.active ? 1 : v;
    if (Equalizer.active) Equalizer.setVolume(v);
  }

  /**
   * What the system shows of the song ({ title, artist, album, artwork }, or
   * null). Here the player keeps navigator.mediaSession itself.
   */
  setMeta() {}

  /** Plays on output device `id` ('' for the default). Rejects when that is refused. */
  async setSink(id) {
    if (Equalizer.ctx && Equalizer.ctx.setSinkId) {
      if (Equalizer.ctx.sinkId !== id) await Equalizer.ctx.setSinkId(id);
      return;
    }
    for (const el of [this.main, this.spare]) if (el.setSinkId && el.sinkId !== id) await el.setSinkId(id);
  }

  // ---- song transition ----

  get canFade() {
    return Equalizer.active;
  }

  /**
   * Starts the next song (at loudness `gain`) and fades it in over `seconds`
   * while the current one fades out.
   */
  fadeIn(src, gain, seconds) {
    const incoming = this.spare;
    this._setSource(incoming, src);
    this._setNorm(incoming, gain);
    // Equal power: the two together stay as loud as one all the way across.
    const n = 64;
    const down = new Float32Array(n);
    const up = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * (Math.PI / 2);
      down[i] = Math.cos(x);
      up[i] = Math.sin(x);
    }
    const out = Equalizer.channel(this.main).fade.gain;
    const inn = Equalizer.channel(incoming).fade.gain;
    const t = Equalizer.ctx.currentTime;
    out.cancelScheduledValues(t);
    inn.cancelScheduledValues(t);
    inn.value = 0;
    try {
      out.setValueCurveAtTime(down, t + 0.02, seconds);
      inn.setValueCurveAtTime(up, t + 0.02, seconds);
    } catch {
      out.linearRampToValueAtTime(0, t + seconds);
      inn.linearRampToValueAtTime(1, t + seconds);
    }
    const p = incoming.play();
    if (p && p.catch) p.catch(() => this._emit('fadefailed'));
  }

  /** The song coming in's loudness gain. */
  setIncomingGain(gain, smooth = false) {
    this._setNorm(this.spare, gain, smooth);
  }

  /**
   * The song coming in becomes the current one, at full fade; the old one is
   * let go. Returns how far into the new one it already is.
   */
  promote() {
    const old = this.main;
    const incoming = this.spare;
    this.main = incoming;
    this.spare = old;
    old.pause();
    old.removeAttribute('src');
    old.load();
    this._holdFade(incoming, 1, 0.05);
    this._setFade(old, 1);
    return incoming.currentTime || 0;
  }

  /** Calls the transition off: the song coming in stops, the current one is back to full. */
  cancelFade() {
    const b = this.spare;
    b.pause();
    b.removeAttribute('src');
    b.load();
    this._holdFade(this.main, 1, 0.08);
  }

  // ---- the elements ----

  /**
   * Points an element at a song's file or stream. A stream is asked for with
   * CORS, or the Web Audio graph behind the equalizer would only hear
   * silence. False when there is nothing to play it from.
   */
  _setSource(el, src) {
    if (/^https?:/i.test(src)) el.crossOrigin = 'anonymous';
    else el.removeAttribute('crossorigin');
    if (src) {
      el.src = src;
      return true;
    }
    el.removeAttribute('src');
    el.load();
    return false;
  }

  _setNorm(el, gain, smooth = false) {
    const ch = Equalizer.channel(el);
    if (!ch) return;
    const t = Equalizer.ctx.currentTime;
    if (Math.abs(ch.norm.gain.value - gain) < 0.001) return;
    ch.norm.gain.cancelScheduledValues(t);
    if (smooth) ch.norm.gain.setTargetAtTime(gain, t, 0.3);
    else ch.norm.gain.setValueAtTime(gain, t);
  }

  _setFade(el, value) {
    const ch = Equalizer.channel(el);
    if (!ch) return;
    const t = Equalizer.ctx.currentTime;
    ch.fade.gain.cancelScheduledValues(t);
    ch.fade.gain.setValueAtTime(value, t);
  }

  /** Stops a fade where it is and glides to `value` from there. */
  _holdFade(el, value, glide) {
    const ch = Equalizer.channel(el);
    if (!ch) return;
    const g = ch.fade.gain;
    const t = Equalizer.ctx.currentTime;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else g.cancelScheduledValues(t);
    g.setTargetAtTime(value, t, glide);
  }
}
