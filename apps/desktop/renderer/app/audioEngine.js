'use strict';

// What the player (player.js) plays its songs through. The player decides
// what plays and when; the engine only sounds it: one current song, and during
// a song transition a second one faded in over it, which then becomes the
// current song (promote) or is let go (cancelFade).
//
// The engine's events are the current song's only: play, pause, ended,
// timeupdate, seeking, durationchange, loadedmetadata and error (with the
// server's answer when the engine knows it, 401: signed out); fadefailed
// when the song coming in cannot be played. An engine that moves on to the
// next song by itself (the phone's, apps/android/src/engine.js) also says
// advanced (movesOn), and may start with a song already playing (current). One that
// keeps the sleep timer itself (ownSleep: fades and pauses) is handed it with
// setSleep.
//
// HtmlAudioEngine plays through the window's two <audio> elements, routed
// through Web Audio by the equalizer (equalizer.js), which gives each its own
// loudness and fade gains. Without Web Audio the elements play as they are,
// with no transition or evening out (canFade is false, gains do nothing).
//
// A song whose seeks are not exact (an MP3: the element lands up to a second
// or more away and says it is where it was asked to be) is checked after each
// seek (seekCheck.js): once it has played a moment, what it sounds is matched
// against the song itself, and `time` is the place really heard from then on.
// Meanwhile `settling` is true; a check that moves the place says `corrected`.
// The next seek nearby goes that much further at once, so it lands closer.

// How long a song plays on after a seek before it is checked (the decoder settled, a second heard).
const CHECK_AFTER_MS = 1600;

class HtmlAudioEngine {
  constructor(main, spare) {
    this.main = main;     // the current song
    this.spare = spare;   // the song coming in during a transition
    this._handlers = {};
    // The equalizer puts itself between the elements and the speakers, and
    // the volume then lives on its gain so the picture does not shrink with it.
    Equalizer.attach([main, spare]);
    // Each element's song and how far its currentTime is off (seekCheck.js).
    this._seek = new Map();
    for (const el of [main, spare]) {
      this._seek.set(el, { key: '', inexact: false, error: 0, errorAt: null, checking: 0, tries: 0, measuring: false, tap: null });
      const ch = Equalizer.channel(el);
      if (ch) SeekCheck.tap(Equalizer.ctx, ch.norm).then((tap) => { this._seek.get(el).tap = tap; });
    }

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

  /** The place heard: currentTime less how far a seek left it off. */
  get time() {
    return this.main.currentTime - this._seek.get(this.main).error;
  }

  /** A seek is being checked (seekCheck.js): the place may still move a little. */
  get settling() {
    return this._seek.get(this.main).checking > 0;
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
   * is nothing to play it from (src ''). Options { at, key }: where it is to
   * start (the player seeks there once the length is known; an engine that
   * can start there at once passes over that seek, the elements wait for it),
   * the song's id, and whether its seeks are not exact (an MP3: checked).
   */
  load(src, gain, { key = '', inexact = false } = {}) {
    this._fresh(this.main, key, inexact);
    const ok = this._setSource(this.main, src);
    this._setNorm(this.main, gain);
    this._setFade(this.main, 1);
    return ok;
  }

  unload() {
    this._fresh(this.main, '', false);
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
    const s = this._seek.get(this.main);
    if (!s.inexact) {
      this.main.currentTime = seconds;
      return;
    }
    // Near the last place checked, it lands about as far off again: allowed for at once.
    const guess = s.errorAt !== null && Math.abs(seconds - s.errorAt) < 20 ? s.error : 0;
    this.main.currentTime = Math.max(0, seconds + guess);
    s.error = guess;
    this._check(this.main);
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

  /** The songs that come next: the elements ask the player at each song's end instead. */
  setNext() {}

  /** The sleep timer: here the timer itself fades the volume (sleepTimer.js); see ownSleep. */
  setSleep() {}

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
   * while the current one fades out; `at`: from there instead of its start
   * (playing along with a host whose transition began a moment ago).
   */
  fadeIn(src, gain, seconds, { key = '', inexact = false, at = 0 } = {}) {
    const incoming = this.spare;
    this._fresh(incoming, key, inexact);
    this._setSource(incoming, src);
    this._setNorm(incoming, gain);
    // At its own speed (an element let go of may have been easing in step).
    incoming.playbackRate = 1;
    if (at > 0) {
      incoming.currentTime = at;
      if (this._seek.get(incoming).inexact) this._check(incoming);
    }
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

  /** The place heard of the song coming in, and its playing speed (in step with a host meanwhile). */
  get incomingTime() {
    return this.spare.currentTime - this._seek.get(this.spare).error;
  }

  setIncomingRate(rate) {
    this.spare.playbackRate = rate;
  }

  /** The song coming in to `seconds` (an MP3 checked as after any seek). */
  seekIncoming(seconds) {
    const s = this._seek.get(this.spare);
    this.spare.currentTime = Math.max(0, seconds);
    s.error = 0;
    if (s.inexact) this._check(this.spare);
  }

  /** As `settling`, for the song coming in. */
  get incomingSettling() {
    return this._seek.get(this.spare).checking > 0;
  }

  /** As `readyState`, for the song coming in. */
  get incomingReady() {
    return this.spare.readyState;
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
    this._fresh(old, '', false);
    old.pause();
    old.removeAttribute('src');
    old.load();
    this._holdFade(incoming, 1, 0.05);
    this._setFade(old, 1);
    return this.time || 0;
  }

  /** Calls the transition off: the song coming in stops, the current one is back to full. */
  cancelFade() {
    const b = this.spare;
    this._fresh(b, '', false);
    b.pause();
    b.removeAttribute('src');
    b.load();
    this._holdFade(this.main, 1, 0.08);
  }

  // ---- seeks that are not exact (seekCheck.js) ----

  /** A new song in `el`: from its start its place is exact. Any check under way is void. */
  _fresh(el, key, inexact) {
    const s = this._seek.get(el);
    s.key = key;
    s.inexact = inexact && !!key;
    s.error = 0;
    s.errorAt = null;
    s.checking = 0;
    s.tries = 0;
  }

  /**
   * After a seek in `el`: once it has played CHECK_AFTER_MS on, what it
   * sounds is matched against the song. Tried again a few times when that
   * tells nothing (silence); a newer seek or song takes over.
   */
  _check(el) {
    const s = this._seek.get(el);
    if (!s.tap || !Equalizer.ctx) return;
    const run = (s.checking = (this._checks = (this._checks || 0) + 1));
    const key = s.key;
    // The reference is decoded meanwhile.
    SeekCheck.reference(key).catch(() => {});
    const times = [];
    let played = 0;
    let last = performance.now();
    const timer = setInterval(async () => {
      const now = performance.now();
      if (s.checking !== run || s.key !== key) {
        clearInterval(timer);
        return;
      }
      if (el.paused || el.readyState < 3) {
        played = 0;
        times.length = 0;
      } else played += now - last;
      last = now;
      times.push({ c: Equalizer.ctx.currentTime, e: el.currentTime });
      if (times.length > 1500) times.splice(0, 500);
      if (played < CHECK_AFTER_MS || s.measuring) return;
      s.measuring = true;
      let r = null;
      try {
        r = await SeekCheck.measure(s.tap, Equalizer.ctx, key, times);
      } catch (err) {
        console.warn('Seek check:', err && err.message);
      }
      s.measuring = false;
      if (s.checking !== run || s.key !== key) return;
      s.tries += 1;
      if (!r && s.tries < 4) {
        played = CHECK_AFTER_MS - 1000;
        return;
      }
      clearInterval(timer);
      s.checking = 0;
      s.tries = 0;
      if (!r) return;
      const moved = Math.abs(r.error - s.error) > 0.005;
      s.error = r.error;
      s.errorAt = el.currentTime - r.error;
      if (moved && el === this.main) {
        this._emit('corrected');
        this._emit('timeupdate');
      }
    }, 4);
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
