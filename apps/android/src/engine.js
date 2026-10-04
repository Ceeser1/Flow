'use strict';

// The phone's audio engine, with the contract of the desktop's
// (renderer/app/audioEngine.js): the songs play natively in FlowPlayer
// (FlowPlayer.java, through the FlowAudio plugin), so they go on in the
// background and show in the notification and on the lock screen. The page's
// view of it (paused, time, length) follows the player's state events, and
// the time moves on by the clock between them.
//
// What the page asks within one turn goes over as one list of operations: a
// song loaded and played straight away starts playing in one go, at its start
// place, with its notification text. While a list is on its way, state events
// sent before it arrived are passed over; its answer is the state after it.
//
// The player also holds the songs that come next (setNext, the player's
// queue) and moves on to them by itself, without a gap and whether the page
// is awake or not: "advanced" (song id, seconds the one before was heard,
// reason) tells the page. A page that starts while the player still plays
// (Flow was swiped away and opened again) finds that song in `current`, and
// the listens of the songs played meanwhile in `heardAway`.
//
// No song transitions yet (canFade is false), and a song's loudness gain only
// turns it down.

// Player.STATE_* in Media3.
const IDLE = 1;
const BUFFERING = 2;
const READY = 3;
const ENDED = 4;

/**
 * `plugin`: FlowAudio (run, addListener). `toPath`: a page address of a file
 * in the app's storage (Util.fileUrl) back to its path, else as it is.
 * `attached`: what FlowAudio.attach() answered as the page started.
 * `prefix`: this page's own start of the ids it gives songs, so none is
 * taken for one an earlier page gave (the player may still have it).
 */
function createAudioEngine({
  plugin, toPath = (src) => src, now = () => performance.now(), attached = null,
  prefix = `${Math.random().toString(36).slice(2, 7)}-`,
}) {
  const handlers = {};
  let ops = [];
  let batchLoad = null;   // the load in the list not sent yet
  let inflight = 0;
  let loads = 0;
  let id = '';
  let src = '';
  let paused = true;
  let t = 0;
  let at = 0;             // now() when t was true
  let st = IDLE;
  let dur = NaN;
  let rate = 1;
  let startAt = null;     // the place the load starts at, until something else moves it
  let nexts = 0;
  const sent = { rate: 1, gain: null, volume: null, meta: '', next: '' };

  // Still playing from before this page (or loaded, paused): taken as it is.
  let current = null;
  const was = attached && attached.state;
  if (was && was.id && was.key && was.st !== IDLE) {
    id = was.id;
    src = 'native';
    paused = !was.pwr || was.st === ENDED;
    t = was.t;
    at = now();
    st = was.st;
    dur = was.d > 0 ? was.d : NaN;
    rate = was.rate || 1;
    current = { key: was.key, playing: !paused, heard: Number(attached.heard) || 0 };
  }
  const heardAway = (attached && Array.isArray(attached.away) ? attached.away : [])
    .filter((l) => l && typeof l.key === 'string' && l.heard > 0);

  const metaOut = (meta) => (meta ? { ...meta, artwork: meta.artwork ? toPath(meta.artwork) : '' } : null);

  function emit(type, ...args) {
    for (const fn of handlers[type] || []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  }

  // An <audio> tells what a call did a moment later, never during the call.
  const later = (type) => queueMicrotask(() => emit(type));

  function op(o) {
    if (batchLoad) {
      // Folded into the load: played at once, held, or its notification text.
      if (o.op === 'play') return (batchLoad.play = true);
      if (o.op === 'pause') return (batchLoad.play = false);
      if (o.op === 'meta') return (batchLoad.meta = o.meta);
    }
    if (o.op === 'load') batchLoad = o;
    else if (o.op === 'unload') batchLoad = null;
    ops.push(o);
    if (ops.length === 1) queueMicrotask(flush);
    return true;
  }

  function flush() {
    const list = ops;
    ops = [];
    batchLoad = null;
    if (!list.length) return;
    inflight += 1;
    plugin.run({ ops: list }).then((state) => {
      inflight -= 1;
      if (!inflight && state) onState(state);
    }, (err) => {
      inflight -= 1;
      console.error('Flow audio:', err);
    });
  }

  function time() {
    if (paused || st !== READY) return t;
    const moved = t + ((now() - at) / 1000) * rate;
    return dur > 0 ? Math.min(moved, dur) : moved;
  }

  function onState(s) {
    if (inflight || !s || s.id !== id) return;
    t = s.t;
    at = now();
    rate = s.rate || 1;
    st = s.st;
    if (s.d > 0 && s.d !== dur) {
      const first = !(dur > 0);
      dur = s.d;
      emit('durationchange');
      if (first) emit('loadedmetadata');
    }
    if (st === READY && !paused) startAt = null;
    // An ended song is told by "ended".
    const nowPaused = !s.pwr || st === ENDED;
    if (st !== ENDED && nowPaused !== paused) {
      paused = nowPaused;
      emit(paused ? 'pause' : 'play');
    }
    emit('timeupdate');
  }

  plugin.addListener('state', onState);
  plugin.addListener('ended', (e) => {
    if (!e || e.id !== id) return;
    st = ENDED;
    if (dur > 0) t = dur;
    at = now();
    if (!paused) {
      paused = true;
      emit('pause');
    }
    emit('ended');
  });
  plugin.addListener('advance', (e) => {
    if (!e || e.from !== id) return;
    id = e.id;
    t = 0;
    at = now();
    st = BUFFERING;
    dur = NaN;
    startAt = null;
    // What the player has after it now is not what was last sent: the next list goes again.
    sent.next = '';
    emit('advanced', e.key, Number(e.heard) || 0, e.reason);
  });
  plugin.addListener('error', (e) => {
    if (!e || e.id !== id) return;
    console.warn('Flow audio:', e.message);
    st = IDLE;
    paused = true;
    // With the server's answer when it refused the song (401: its session ended).
    emit('error', Number(e.status) || 0);
  });

  return {
    on(type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
    },

    get paused() {
      return paused;
    },
    get time() {
      return time();
    },
    get duration() {
      return dur;
    },
    get readyState() {
      if (!src) return 0;
      if (st === READY || st === ENDED) return 4;
      return dur > 0 ? 1 : 0;
    },
    get loaded() {
      return !!src;
    },

    /** What was playing (or loaded) before this page started: { key, playing, heard }, else null. */
    get current() {
      return current;
    },
    /** Listens of the songs played while there was no page: [{ key, heard, at }]. */
    heardAway,

    load(source, gain, { at: start = 0, key = '' } = {}) {
      current = null;
      loads += 1;
      id = `${prefix}${loads}`;
      src = source || '';
      paused = true;
      t = start > 0 ? start : 0;
      at = now();
      st = src ? BUFFERING : IDLE;
      dur = NaN;
      rate = 1;
      startAt = start > 0 ? start : null;
      sent.rate = 1;
      sent.gain = gain;
      sent.next = '';
      op({ op: 'load', id, key, src: toPath(src), gain, at: startAt || 0, play: false });
      return !!src;
    },

    unload() {
      current = null;
      sent.next = '';
      src = '';
      paused = true;
      st = IDLE;
      t = 0;
      dur = NaN;
      startAt = null;
      op({ op: 'unload' });
    },

    play() {
      if (!src) return Promise.reject(new Error('No song is loaded.'));
      if (st === ENDED) {
        // As an <audio>: an ended song plays from the start again.
        t = 0;
        st = BUFFERING;
      }
      at = now();
      if (paused) {
        paused = false;
        later('play');
      }
      op({ op: 'play' });
      return Promise.resolve();
    },

    pause() {
      if (paused) return;
      t = time();
      at = now();
      paused = true;
      later('pause');
      op({ op: 'pause' });
    },

    seek(seconds) {
      // The load already starts there (the player seeks once the length is known).
      if (startAt !== null && Math.abs(seconds - startAt) < 0.01) {
        startAt = null;
        return;
      }
      startAt = null;
      t = seconds;
      at = now();
      if (st === ENDED) st = BUFFERING;
      later('seeking');
      op({ op: 'seek', t: seconds });
    },

    setRate(r) {
      if (r === sent.rate) return;
      t = time();
      at = now();
      rate = r;
      sent.rate = r;
      op({ op: 'rate', rate: r });
    },

    setGain(gain) {
      if (gain === sent.gain) return;
      sent.gain = gain;
      op({ op: 'gain', gain });
    },

    setVolume(v) {
      if (v === sent.volume) return;
      sent.volume = v;
      op({ op: 'volume', volume: v });
    },

    /** What the notification and the lock screen show: { title, artist, album, artwork }. */
    setMeta(meta) {
      const m = metaOut(meta);
      const key = JSON.stringify(m);
      if (key === sent.meta) return;
      sent.meta = key;
      if (m) op({ op: 'meta', meta: m });
    },

    /**
     * The songs that come after this one ([{ key, src, gain, meta }], in
     * order), or with `repeat` this one over and over.
     */
    setNext(items, { repeat = false } = {}) {
      const list = (items || []).filter((i) => i && i.src);
      const k = JSON.stringify([repeat, list.map((i) => [i.key, i.src, i.gain, i.meta])]);
      if (k === sent.next) return;
      sent.next = k;
      op({
        op: 'next',
        repeat: !!repeat,
        items: list.map((i) => {
          nexts += 1;
          return { id: `${prefix}n${nexts}`, key: i.key, src: toPath(i.src), gain: i.gain, meta: metaOut(i.meta) };
        }),
      });
    },

    // Output devices are the phone's own business.
    setSink: async () => {},

    // Song transitions come later.
    canFade: false,
    fadeIn() {},
    setIncomingGain() {},
    promote: () => 0,
    cancelFade() {},
  };
}

/**
 * The path of a file the page knows by its Capacitor address
 * (<origin>/_capacitor_file_/data/...), without the query; any other address
 * as it is.
 */
function fileAddressToPath(address, origin) {
  const prefix = `${origin}/_capacitor_file_`;
  if (!address || !address.startsWith(prefix)) return address;
  const rest = address.slice(prefix.length).split(/[?#]/)[0];
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

module.exports = { createAudioEngine, fileAddressToPath };
