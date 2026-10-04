'use strict';

// The player bar at the bottom of every page, and what the library plays: it
// sounds through an audio engine (audioEngine.js). The Add Songs preview has
// its own element; the two never play at the same time (AudioFocus).
//
// During a song transition (Settings) the engine plays two songs: the next
// one starts a few seconds before the current song ends, the two are faded
// over each other, and only when the current song has really ended does the
// one coming in become the current one and the bar move on. Anything the user does in between (pause,
// previous, seek, another song) calls the transition off; Next goes straight
// into the song already coming in.
//
// "Equalize volume" turns each song up or down to the same loudness, from the
// measurement main.js keeps in song.loudness.
//
// What comes next is the queue (queue.js). Repeat plays the current song over
// and over until it is turned off or another song is started by hand (a song
// clicked, Next, Previous).
//
// A list can also come from another device in an Active Session (a song
// started there, or the queue of the host before this one): its songs are
// given as they are (lists), under an id of its own ("session:..."), since
// that device's playlists are not this one's.
//
// In another device's session (remote mode, `remote`), this player plays
// nothing itself: its song, place, list, queue, Repeat and Shuffle mirror the
// host's (mirror()), and every button (the bar's, a row's Play, the Queue
// popup, the keys) goes to the host instead (_remoteDo). Leaving keeps the
// host's song here, paused at its place, to carry on with.
//
// "Play here" (remote.here) plays the host's song on this device too, in step
// with the host (_hereSync): the place the host is at, by the server's clock.
// Speakers that sound late are evened out by holding back the faster ones'
// sound (Output delay, output.js).
// Small differences are eased away by playing a little faster or slower,
// bigger ones jumped over.

const AudioFocus = {
  owners: {},
  register(name, pause) {
    this.owners[name] = pause;
  },
  /** `name` starts playing: everyone else stops. */
  claim(name) {
    for (const [other, pause] of Object.entries(this.owners)) {
      if (other !== name) pause();
    }
  },
};

const Player = {
  engine: null,
  fade: null,       // the transition in progress: { id } of the song coming in
  queue: new PlayQueue(),
  // Equalize volume: every song is brought to this loudness, but turned up by
  // at most MAX_BOOST_DB (quiet recordings would only get noisy) and down by
  // at most MAX_CUT_DB.
  TARGET_LUFS: -14,
  MAX_BOOST_DB: 8,
  MAX_CUT_DB: 14,
  currentId: null,
  contextId: null,
  repeat: false,
  // How a playlist's songs are ordered right now (sort and search as shown).
  // Set by the playlist page; the fallback is the list's own order.
  orderOf: (contextId) => Store.rowsOf(contextId).map((r) => r.song.id),
  // Lists from another device (see the top): context id -> { name, ids }.
  lists: new Map(),
  _listCount: 0,
  _listeners: [],
  _dragging: false,
  _saveTimer: null,
  _pendingSeek: null,
  _muteRestore: 0.8,
  volume: 0.8,
  // The listen in progress: which song, and how many seconds of it have been
  // heard. Counted into the song's statistics when the song changes.
  session: null,
  // Remote mode: { state (the host's, as the server sent it), sampledAt (server
  // time of its position), listKey, ticker } or null.
  remote: null,

  get isPlaying() {
    if (this.remote) return !!this.remote.state.playing && !!this.currentId;
    return !!this.engine && !this.engine.paused && !!this.currentId;
  },

  get position() {
    if (this.remote) return this._remotePosition();
    // Still loading a song that starts further in: where it is going to be.
    if (this._pendingSeek !== null) return this._pendingSeek;
    return this.engine ? this.engine.time || 0 : 0;
  },

  /** The current song's length: as the element knows it, or the library (or the host) says. */
  get duration() {
    if (!this.currentId) return 0;
    if (this.remote) return this.remote.state.duration || (Store.song(this.currentId) || {}).duration || 0;
    return this.engine.duration || (Store.song(this.currentId) || {}).duration || 0;
  },

  onChange(fn) {
    this._listeners.push(fn);
  },

  /** The songs of a context in the order they play: a playlist as shown, or a list from another device. */
  idsOf(contextId) {
    const list = this.lists.get(contextId);
    if (list) return list.ids.filter((id) => !!Store.song(id));
    return this.orderOf(contextId);
  },

  /** What the list playing is called ('' for none). */
  listName(contextId = this.contextId) {
    if (!contextId) return '';
    const list = this.lists.get(contextId);
    if (list) return list.name || 'Session';
    const p = Store.playlist(contextId);
    return p ? p.name : '';
  },

  /** A list from another device, kept under a new context id; the few newest are kept. */
  addList(ids, name) {
    this._listCount += 1;
    const id = `session:${this._listCount}`;
    this.lists.set(id, { name: String(name || ''), ids: (ids || []).slice() });
    for (const key of [...this.lists.keys()]) {
      if (this.lists.size <= 4) break;
      if (key !== this.contextId && key !== id) this.lists.delete(key);
    }
    return id;
  },

  /**
   * Plays a list from another device: from songId, or from its start (a
   * random song with shuffle) without one.
   */
  playList(ids, name, songId = null) {
    const context = this.addList(ids, name);
    const order = this.idsOf(context);
    if (songId && Store.song(songId)) {
      this.load(songId, context);
      return;
    }
    if (!order.length) return;
    const first = this.queue.start(context, order);
    this.repeat = false;
    this.load(first, context, { fromQueue: true });
  },

  /**
   * Carries on where another device left off (it was a session's host): its
   * song at its place, its list and queue, Repeat and Shuffle as they were.
   */
  takeOver(state, { autoplay = true } = {}) {
    this._leaveRemote();
    if (!state || !state.songId || !Store.song(state.songId)) return false;
    const context = this.addList(state.ids || [], state.contextName);
    if (state.queue) {
      this.queue.restore({ ...state.queue, contextId: context, currentId: state.songId });
    } else {
      this.queue.start(context, this.idsOf(context), state.songId);
    }
    this.queue.shuffle = !!state.shuffle;
    Store.saveSettings({ shuffle: !!state.shuffle });
    this.load(state.songId, context, {
      fromQueue: true, autoplay: autoplay && !!state.playing, position: state.position || 0,
    });
    this.repeat = !!state.repeat;
    this._emit();
    return true;
  },

  _emit() {
    for (const fn of this._listeners) fn();
    this._drawBar();
  },

  init() {
    // The app's own engine (the phone's plays natively), else the window's <audio>.
    this.engine = window.flow.createAudioEngine
      ? window.flow.createAudioEngine()
      : new HtmlAudioEngine($('mainAudio'), $('fadeAudio'));
    // Without a volume slider (the phone's is its buttons), Flow plays at full volume.
    this.volume = Store.can('volume') ? Store.settings.volume : 1;
    this._applyVolume();
    this.queue.setShuffle(Store.settings.shuffle);

    const e = this.engine;
    e.on('play', () => {
      AudioFocus.claim('player');
      this._emit();
    });
    e.on('pause', () => {
      this._savePosition();
      this._emit();
    });
    e.on('ended', () => {
      // Playing along with a host: its next song comes with its state.
      if (this.remote) return;
      if (this.fade) this._promote();
      else if (this.repeat) this._restart();
      else this._advance();
    });
    e.on('timeupdate', () => {
      this._countListening();
      this._drawTime();
      this._maybeFade();
    });
    // A jump is not listening: the next update starts counting afresh.
    e.on('seeking', () => {
      if (this.session) this.session.lastT = null;
    });
    e.on('durationchange', () => this._drawTime());
    e.on('loadedmetadata', () => {
      const end = Math.max(0, (e.duration || 0) - 0.5);
      if (this.remote && this.remote.here) {
        // Where the host is by now, not where it was when the song was asked for.
        e.seek(Math.min(this._hereTarget(), end));
        this._pendingSeek = null;
      } else if (this._pendingSeek !== null) {
        e.seek(Math.min(this._pendingSeek, end));
        this._pendingSeek = null;
      }
      this._drawTime();
    });
    e.on('error', () => {
      if (!this.currentId || !e.loaded) return;
      const song = Store.song(this.currentId);
      const why = song && !song.file ? 'The server could not send it.' : 'The file may have been moved or deleted.';
      toast(`Could not play "${song ? song.title : 'this song'}". ${why}`, 'error');
      this._emit();
    });
    // The song coming in cannot be played: no transition, the current one
    // ends and Next tries it the ordinary way.
    e.on('fadefailed', () => this._cancelFade());
    AudioFocus.register('player', () => this.pauseHere());

    this._bindBar();
    this._bindMediaSession();

    // Library changes: a deleted song stops, a renamed one keeps playing, and
    // a song whose loudness was just measured is evened out straight away.
    Store.onLibrary(() => {
      this.queue.prune((id) => !!Store.song(id));
      if (this.fade && !Store.song(this.fade.id)) this._cancelFade();
      if (this.remote) {
        // The host's song may be newer than this library: it shows from the host's state.
      } else if (this.currentId && !Store.song(this.currentId)) this.stop();
      else if (this.contextId && !Store.playlist(this.contextId) && !this.lists.has(this.contextId)) this.contextId = 'all';
      if (this.currentId) this.engine.setGain(this._normGain(this.currentId), true);
      this._drawBar();
    });
    Store.onSettings((patch) => {
      if (!('normalize' in patch)) return;
      if (this.currentId) this.engine.setGain(this._normGain(this.currentId), true);
      if (this.fade) this.engine.setIncomingGain(this._normGain(this.fade.id), true);
    });

    setInterval(() => {
      if (this.isPlaying) this._savePosition();
    }, 5000);
    window.addEventListener('beforeunload', () => {
      try {
        window.flow.setSettingsNow({
          lastSongId: this.currentId,
          lastContextId: this.contextId,
          lastPosition: this.position,
          volume: this.volume,
          listenSession: this._sessionToKeep(),
        });
      } catch {
        // Closing anyway.
      }
    });
  },

  /** Puts the song from the last session back in place, paused. */
  restore() {
    const s = Store.settings;
    if (!s.lastSongId || !Store.song(s.lastSongId)) {
      this._drawBar();
      return;
    }
    const context = Store.playlist(s.lastContextId) ? s.lastContextId : 'all';
    const carried = s.listenSession && s.listenSession.songId === s.lastSongId ? s.listenSession.listened : 0;
    this.load(s.lastSongId, context, { autoplay: false, position: s.lastPosition || 0, listened: carried });
  },

  /**
   * Loads a song. `listened` carries on a listen from before (the last
   * session); `keepSession` carries on the one in progress (a song let go of
   * for a rename and picked up again). `fromQueue` means the queue has
   * already moved on to it; otherwise it was picked by hand: a song of the
   * list playing leaves the queue as it is, one of another list starts that
   * list's queue from there.
   */
  load(songId, contextId, { autoplay = true, position = 0, listened = 0, keepSession = false, fromQueue = false } = {}) {
    if (this.remote) {
      this._remotePlaySong(songId, contextId);
      return;
    }
    const song = Store.song(songId);
    if (!song) return;
    this._cancelFade();
    if (!(keepSession && this.session && this.session.songId === songId)) {
      this._endSession();
      this._startSession(songId, listened);
    }
    const context = contextId || 'all';
    if (!fromQueue) {
      if (songId !== this.currentId) this.repeat = false;
      const ids = this.idsOf(context);
      if (this.queue.contextId !== context) this.queue.start(context, ids, songId);
      else this.queue.jump(songId, ids);
    }
    this.contextId = context;
    this.currentId = songId;
    this._pendingSeek = position > 0 ? position : null;
    const playable = this.engine.load(Store.audioSrc(song), this._normGain(songId), position);
    if (!playable && autoplay) {
      toast(`"${song.title}" is on the server, which cannot be reached right now, and is not downloaded.`, 'error');
    } else if (autoplay) this._play();
    this._updateMediaSession();
    this._savePosition();
    this._emit();
  },

  _play() {
    this.engine.play().catch((err) => {
      if (err && err.name === 'AbortError') return; // replaced by another load
      this._emit();
    });
  },

  /**
   * A song's row button: play it, or pause / resume it when it is the current
   * song. Resuming it from another list carries on in that list.
   */
  toggleSong(songId, contextId) {
    if (this.remote) {
      if (songId === this.currentId) this._remoteDo('toggle');
      else this._remotePlaySong(songId, contextId);
      return;
    }
    if (songId !== this.currentId) {
      this.load(songId, contextId);
      return;
    }
    if (!this.engine.paused) {
      this.pause();
      return;
    }
    if (this.contextId !== contextId) {
      this.contextId = contextId;
      this.queue.start(contextId, this.idsOf(contextId), songId);
      this._updateMediaSession();
    }
    this._play();
  },

  /** A playlist's own Play button: a new queue from its top (or a random song). */
  togglePlaylist(contextId) {
    if (this.remote) {
      // A new queue from its top, or a random song with the host's shuffle.
      const order = this.idsOf(contextId);
      if (order.length) this._remotePlaySong(this.queue.shuffle ? order[Math.floor(Math.random() * order.length)] : order[0], contextId);
      return;
    }
    if (this.contextId === contextId && this.currentId) {
      this.toggle();
      return;
    }
    const ids = this.idsOf(contextId);
    if (!ids.length) return;
    const first = this.queue.start(contextId, ids);
    this.repeat = false;
    this.load(first, contextId, { fromQueue: true });
  },

  toggle() {
    if (this._remoteDo('toggle')) return;
    if (!this.currentId) {
      const context = this.contextId || Nav.currentPlaylistId() || 'all';
      this.togglePlaylist(context);
      return;
    }
    if (this.engine.paused) this._play();
    else this.pause();
  },

  pause() {
    if (this._remoteDo('pause')) return;
    this.pauseHere();
  },

  /** Pauses this device's own playback only (another player starting, the sleep timer). */
  pauseHere() {
    this._cancelFade();
    if (this.engine) this.engine.pause();
  },

  /** Next, pressed: another song started by hand, so Repeat goes off. */
  next() {
    if (this._remoteDo('next')) return;
    this.repeat = false;
    this._advance();
  },

  /** On to the next song of the queue. */
  _advance() {
    if (!this.contextId && !this.queue.manual.length) return;
    // The next song is already coming in: go straight to it.
    if (this.fade) {
      this._promote();
      return;
    }
    const id = this.queue.next(this.idsOf(this.contextId));
    if (!id) {
      this.stop();
      return;
    }
    if (id === this.currentId) {
      // The only song in the list, starting over.
      this._restart();
      return;
    }
    this.load(id, this.contextId, { fromQueue: true });
  },

  /** The song playing, from the start: that is a new listen. */
  _restart() {
    this._endSession();
    this._startSession(this.currentId);
    this.engine.seek(0);
    this._play();
  },

  prev() {
    if (this._remoteDo('prev')) return;
    if (!this.contextId) return;
    this.repeat = false;
    this._cancelFade();
    const ids = this.idsOf(this.contextId);
    const id = this.queue.prev(ids);
    if (!id) return;
    if (id === this.currentId) {
      this._endSession();
      this._startSession(id);
      this.engine.seek(0);
      this._emit();
      return;
    }
    this.load(id, this.contextId, { fromQueue: true });
  },

  toggleRepeat() {
    if (this._remoteDo('repeat', { on: !this.repeat })) {
      this.repeat = !this.repeat;
      this._emit();
      return;
    }
    this.repeat = !this.repeat;
    // A transition already under way would leave the song being repeated.
    if (this.repeat) this._cancelFade();
    this._emit();
  },

  /** "Add to Queue": after the songs added before it, ahead of the list's own. */
  addToQueue(songId) {
    const song = Store.song(songId);
    if (!song) return;
    if (this._remoteDo('queueAdd', { songId })) {
      toast(`Added "${song.title}" to the queue of ${Session.sessionName(Session.mine.session.id)}`, 'success');
      return;
    }
    this.queue.add(songId);
    toast(`Added "${song.title}" to the queue`, 'success');
    this._emit();
  },

  /** An entry of the Queue popup clicked: it plays now. */
  playFromQueue(part, index) {
    if (this._remoteDo('queuePlay', { part, index })) return;
    const id = this.queue.playAt(part, index, this.idsOf(this.contextId));
    if (!id || !Store.song(id)) return;
    this.repeat = false;
    this.load(id, this.contextId || 'all', { fromQueue: true });
  },

  /** An entry of the Queue popup dragged to another place in its part. */
  moveInQueue(part, from, to) {
    // In remote mode it moves here at once too; the host's next state confirms it.
    this._remoteDo('queueMove', { part, from, to });
    this.queue.move(part, from, to);
    this._emit();
  },

  removeFromQueue(part, index) {
    if (this._remoteDo('queueRemove', { part, index })) {
      this.queue[part].splice(index, 1);
      this._emit();
      return;
    }
    this.queue.removeAt(part, index, this.idsOf(this.contextId));
    this._emit();
  },

  clearQueue() {
    this._remoteDo('queueClear');
    this.queue.clearManual();
    this._emit();
  },

  seek(seconds) {
    if (!this.currentId) return;
    if (this.remote) {
      const d = this.duration;
      const to = Math.max(0, Math.min(d ? d - 0.05 : seconds, seconds));
      this._remoteDo('seek', { position: to });
      // Shown there at once; the host's next state confirms it.
      this.remote.state = { ...this.remote.state, position: to };
      this.remote.sampledAt = this._serverNow();
      this._drawTime();
      return;
    }
    this._cancelFade();
    const d = this.engine.duration || 0;
    this.engine.seek(Math.max(0, Math.min(d ? d - 0.05 : seconds, seconds)));
    this._drawTime();
    for (const fn of this._seekListeners) fn();
  },

  // Told after every jump (the session's host tells the others).
  _seekListeners: [],

  onSeek(fn) {
    this._seekListeners.push(fn);
  },

  skip(delta) {
    this.seek(this.position + delta);
  },

  // Others showing the same volume (the trim editor's slider), told on every change.
  _volumeListeners: [],

  onVolume(fn) {
    this._volumeListeners.push(fn);
  },

  /** Mute, or back to the volume before it. */
  toggleMute() {
    this.setVolume(this.volume > 0 ? 0 : (this._muteRestore || 0.8));
  },

  setVolume(v) {
    const vol = Math.max(0, Math.min(1, v));
    this.volume = vol;
    this._applyVolume();
    if (vol > 0) this._muteRestore = vol;
    this._drawVolume();
    clearTimeout(this._volTimer);
    this._volTimer = setTimeout(() => Store.saveSettings({ volume: vol }), 300);
  },

  _applyVolume() {
    this.engine.setVolume(this.volume * this.sleepFade);
  },

  // The sleep timer turns the music down over its last seconds (sleepTimer.js)
  // without touching the volume that is saved.
  sleepFade: 1,

  setSleepFade(f) {
    const v = Math.max(0, Math.min(1, f));
    if (v === this.sleepFade) return;
    this.sleepFade = v;
    this._applyVolume();
  },

  setShuffle(on) {
    if (this._remoteDo('shuffle', { on: !!on })) {
      this.queue.shuffle = !!on;
      this._emit();
      return;
    }
    this._cancelFade();
    this.queue.setShuffle(on, this.contextId ? this.idsOf(this.contextId) : []);
    Store.saveSettings({ shuffle: !!on });
    this._emit();
  },

  stop() {
    this._cancelFade();
    this._endSession();
    this.engine.unload();
    this.currentId = null;
    this._pendingSeek = null;
    this._savePosition();
    this._updateMediaSession();
    this._emit();
  },

  /**
   * Lets go of a song's file so it can be renamed or deleted. Resolves a token
   * for resume(), or null when the song was not loaded.
   */
  release(songId) {
    // Nothing of this device's is loaded in remote mode.
    if (this.remote) return null;
    if (this.fade && (songId === this.fade.id || songId === this.currentId)) this._cancelFade();
    if (songId !== this.currentId) return null;
    const token = { songId, contextId: this.contextId, position: this.position, playing: this.isPlaying };
    this.engine.unload();
    return token;
  },

  resume(token) {
    if (!token || !Store.song(token.songId)) return;
    this.load(token.songId, token.contextId,
      { autoplay: token.playing, position: token.position, keepSession: true, fromQueue: true });
  },

  // ---- remote mode (in another device's session) ----

  _serverNow() {
    return Date.now() + (Store.server.timeOffset || 0);
  },

  _remotePosition() {
    const { state, sampledAt } = this.remote;
    let t = state.position || 0;
    if (state.playing && sampledAt) t += Math.max(0, (this._serverNow() - sampledAt) / 1000);
    return state.duration ? Math.min(t, state.duration) : t;
  },

  /** In remote mode: the button goes to the host. True when it was sent. */
  _remoteDo(action, args = {}) {
    if (!this.remote) return false;
    Session.control(action, args);
    return true;
  },

  /** A song started here in remote mode: it plays there, from this device's list. */
  _remotePlaySong(songId, contextId) {
    if (!Store.song(songId)) return;
    const context = contextId || 'all';
    this._remoteDo('playSong', { songId, ids: this.idsOf(context), contextName: this.listName(context) || 'All Songs', contextId: context });
  },

  /**
   * The host's playback, from the server (on joining, then with every change
   * and heartbeat): shown here as if played here. The first one stops this
   * device's own playback.
   */
  mirror(state) {
    if (!state) return;
    if (!this.remote) {
      this._cancelFade();
      this._endSession();
      this.engine.unload();
      this._pendingSeek = null;
      this.remote = { state, sampledAt: 0, listKey: null, ticker: setInterval(() => this._remoteTick(), 250) };
    }
    const r = this.remote;
    if (state.songId !== this.currentId) {
      this._endSession();
      if (state.songId) this._startSession(state.songId);
    }
    r.state = state;
    r.sampledAt = state.sampledAt || this._serverNow();
    // A new list only when the host's list changed.
    const listKey = `${state.contextName || ''}|${(state.ids || []).join(',')}`;
    if (listKey !== r.listKey) {
      r.listKey = listKey;
      this.contextId = this.addList(state.ids || [], state.contextName);
    }
    this.currentId = state.songId || null;
    if (state.queue) this.queue.restore({ ...state.queue, contextId: this.contextId, currentId: this.currentId });
    this.queue.shuffle = !!state.shuffle;
    this.repeat = !!state.repeat;
    if (this.session) this.session.lastT = null;
    // Playing along: a pause, a jump or the next song there, here at once.
    this._hereSync();
    this._updateMediaSession();
    this._emit();
  },

  /** Four times a second in remote mode: the time moves on, and listening is counted. */
  _remoteTick() {
    if (!this.remote) return;
    this._hereSync();
    this._drawTime();
    const s = this.session;
    if (!s || s.songId !== this.currentId) return;
    const t = this.position;
    if (this.isPlaying && s.lastT !== null) {
      const step = t - s.lastT;
      if (step > 0 && step < 1.5) s.listened += step;
    }
    s.lastT = t;
    if (this.remote.state.duration) s.duration = this.remote.state.duration;
  },

  /** Out of remote mode; `keepAudio`: the song playing along goes on as it is (its listen too). */
  _leaveRemote({ keepAudio = false } = {}) {
    if (!this.remote) return null;
    const state = { ...this.remote.state, position: this._remotePosition() };
    if (keepAudio) {
      this.remote.hereSong = null;
      this.engine.setRate(1);
    } else this._stopHere();
    clearInterval(this.remote.ticker);
    this.remote = null;
    if (keepAudio) {
      if (this.session) this.session.lastT = null;
    } else this._endSession();
    return state;
  },

  // ---- Play here: the host's song on this device too, in step ----

  /** Plays along with the host here, or stops doing so. */
  setHere(on) {
    if (!this.remote) return;
    if (!!this.remote.here === !!on) return;
    this.remote.here = !!on;
    if (!on) this._stopHere();
    this._hereSync();
    this._emit();
  },

  /** Where this device's song should be now: the host's place. */
  _hereTarget() {
    return Math.max(0, this._remotePosition());
  },

  _stopHere() {
    const r = this.remote;
    if (!r || !r.hereSong) return;
    r.hereSong = null;
    r.drift = null;
    this.engine.unload();
    this.engine.setRate(1);
  },

  /**
   * Four times a second while playing along: the host's song loaded, playing
   * or paused as there, and at the host's place: under SYNC_OK it is left
   * alone, up to SYNC_JUMP it is eased in (up to SYNC_RATE faster or slower),
   * beyond that jumped to; a jump learns how long playing takes to pick up
   * again (seekLead) and lands that much ahead. SYNC_OK keeps devices well
   * clear of an audible echo while staying above the jitter of the place the
   * element reports; the check itself costs the same at any window.
   */
  SYNC_OK: 0.015,
  SYNC_JUMP: 0.3,
  SYNC_RATE: 0.03,

  _hereSync() {
    const r = this.remote;
    if (!r || !r.here) return;
    const st = r.state;
    const a = this.engine;
    const song = st.songId ? Store.song(st.songId) : null;
    if (!song) {
      // Nothing there, or a song this library does not know yet.
      this._stopHere();
      return;
    }
    const now = performance.now();
    if (r.hereSong !== song.id) {
      r.hereSong = song.id;
      r.settleUntil = now + 800;
      r.correcting = false;
      a.setRate(1);
      a.load(Store.audioSrc(song), this._normGain(song.id));
      if (st.playing) this._play();
      return;
    }
    if (!st.playing) {
      a.pause();
      a.setRate(1);
      r.drift = null;
      if (a.readyState >= 1 && Math.abs(a.time - st.position) > 0.25) a.seek(st.position);
      return;
    }
    if (a.readyState < 2) return;
    if (a.paused) {
      a.seek(this._hereTarget() + (r.seekLead || 0));
      r.settleUntil = now + 800;
      r.jumped = true;
      this._play();
      return;
    }
    if (now < r.settleUntil) return;
    const drift = a.time - this._hereTarget();
    r.drift = drift;
    if (r.jumped) {
      // How far behind the last jump landed: the next one goes that much further.
      r.jumped = false;
      r.seekLead = Math.max(0, Math.min(0.5, (r.seekLead || 0) - drift));
    }
    if (Math.abs(drift) > this.SYNC_JUMP) {
      a.setRate(1);
      r.correcting = false;
      a.seek(this._hereTarget() + (r.seekLead || 0));
      r.settleUntil = now + 800;
      r.jumped = true;
      return;
    }
    // Eased in from SYNC_OK on, until within a third of it.
    if (Math.abs(drift) > this.SYNC_OK) r.correcting = true;
    else if (Math.abs(drift) < this.SYNC_OK / 3) r.correcting = false;
    a.setRate(r.correcting
      ? Math.max(1 - this.SYNC_RATE, Math.min(1 + this.SYNC_RATE, 1 - drift))
      : 1);
  },

  /**
   * Out of the session: the host's song stays, paused at its place, with its
   * list and queue (`keepPlaying`: playing on, for one that played along).
   */
  endRemote({ keepPlaying = false } = {}) {
    const r = this.remote;
    // Playing along already: that goes on without loading it again (the server may be gone).
    const along = keepPlaying && !!r && r.here && r.hereSong === r.state.songId && !this.engine.paused;
    const state = this._leaveRemote({ keepAudio: along });
    if (!state) return;
    if (along) this._adopt(state);
    else if (!this.takeOver(state, { autoplay: keepPlaying })) this.stop();
    this._emit();
  },

  /** The song playing along becomes this player's own: the host's list and queue around it. */
  _adopt(state) {
    const context = this.addList(state.ids || [], state.contextName);
    if (state.queue) this.queue.restore({ ...state.queue, contextId: context, currentId: state.songId });
    else this.queue.start(context, this.idsOf(context), state.songId);
    this.queue.shuffle = !!state.shuffle;
    this.contextId = context;
    this.currentId = state.songId;
    this.repeat = !!state.repeat;
    if (!this.session || this.session.songId !== state.songId) this._startSession(state.songId);
    this._updateMediaSession();
    this._savePosition();
  },

  // ---- song transition ----

  /**
   * On every time update of the current song: is it time to start the next
   * one? The transition is at most a third of either song, so short songs get
   * a short one, and a song that repeats itself (a one-song list) gets none.
   */
  _maybeFade() {
    const s = Store.settings;
    if (this.remote || this.fade || this.repeat || !s.crossfade || !this.engine.canFade || !this.currentId || this.engine.paused) return;
    const d = this.engine.duration;
    if (!d || !Number.isFinite(d)) return;
    const left = d - this.engine.time;
    let length = Math.min(s.crossfadeSeconds, d / 3);
    if (left > length || left < 0.2) return;
    const id = this.queue.peek(this.idsOf(this.contextId));
    if (!id || id === this.currentId) return;
    const song = Store.song(id);
    if (!song) return;
    if (song.duration) length = Math.min(length, song.duration / 3);
    if (left > length) return;
    this._startFade(id, song, left);
  },

  _startFade(id, song, seconds) {
    const src = Store.audioSrc(song);
    if (!src) return;
    this.fade = { id };
    this.engine.fadeIn(src, this._normGain(id), seconds);
  },

  /** The current song has ended (or Next was pressed): the one coming in takes over. */
  _promote() {
    const f = this.fade;
    if (!f) return;
    this.fade = null;
    this._endSession();
    // What played of it during the transition counts as listened.
    const heard = this.engine.promote();
    this.queue.take(f.id, this.idsOf(this.contextId));
    this.currentId = f.id;
    this._startSession(f.id, heard);
    this.session.lastT = heard;
    this._pendingSeek = null;
    if (this.engine.paused) this._play();
    this._updateMediaSession();
    this._savePosition();
    this._emit();
  },

  /** Calls the transition off: the song coming in stops, the current one is back to full. */
  _cancelFade() {
    if (!this.fade) return;
    this.fade = null;
    this.engine.cancelFade();
  },

  // ---- equalize volume ----

  /** The gain that brings a song to the target loudness (1 when off or not measured). */
  _normGain(songId) {
    const song = Store.song(songId);
    if (!Store.settings.normalize || !song || song.loudness === null || song.loudness === undefined) return 1;
    const db = Math.max(-this.MAX_CUT_DB, Math.min(this.MAX_BOOST_DB, this.TARGET_LUFS - song.loudness));
    return 10 ** (db / 20);
  },

  // ---- listening statistics ----

  _startSession(songId, listened = 0) {
    this.session = { songId, listened: Math.max(0, listened || 0), lastT: null };
  },

  /** Adds the time played since the last update, while actually playing. */
  _countListening() {
    // In a session, counted by the host's place (_remoteTick).
    if (this.remote) return;
    const s = this.session;
    if (!s || s.songId !== this.currentId) return;
    const t = this.engine.time || 0;
    if (!this.engine.paused && s.lastT !== null) {
      const step = t - s.lastT;
      // Updates come about four times a second; anything bigger is a jump.
      if (step > 0 && step < 1.5) s.listened += step;
    }
    s.lastT = t;
    // The length as played, for a song whose length is not known yet (one a
    // Flow Server found in its folder without ffprobe).
    if (Number.isFinite(this.engine.duration)) s.duration = this.engine.duration;
  },

  /** Counts the listen in progress (the song is changing) and forgets it. */
  _endSession() {
    const s = this.session;
    this.session = null;
    // Under 5 seconds counts as nothing (the same limit as MIN_LISTEN_SECONDS in libraryModel.js).
    if (!s || s.listened < 5) return;
    const song = Store.song(s.songId);
    const duration = (song && song.duration) || s.duration || 0;
    // The time also counts for the list that was playing, if the song is in it
    // (one queued from elsewhere is not).
    const list = this.contextId ? Store.playlist(this.contextId) : null;
    const inList = !!list && list.entries.some((e) => e.songId === s.songId);
    window.flow.recordListen(s.songId, s.listened, duration, inList ? this.contextId : null).catch(() => {});
  },

  _sessionToKeep() {
    const s = this.session;
    return s && s.songId === this.currentId ? { songId: s.songId, listened: s.listened } : null;
  },

  _savePosition() {
    Store.saveSettings({
      lastSongId: this.currentId,
      lastContextId: this.contextId,
      lastPosition: this.currentId ? this.position : 0,
      listenSession: this._sessionToKeep(),
    });
  },

  // ---- the bar ----

  _bindBar() {
    $('btnPrev').innerHTML = Icons.prev;
    $('btnNext').innerHTML = Icons.next;
    $('btnBack10').innerHTML = Icons.back10;
    $('btnFwd10').innerHTML = Icons.fwd10;
    $('btnPrev').onclick = () => this.prev();
    $('btnNext').onclick = () => this.next();
    $('btnBack10').onclick = () => this.skip(-10);
    $('btnFwd10').onclick = () => this.skip(10);
    $('btnPlay').onclick = () => this.toggle();
    $('btnShuffle').onclick = () => this.setShuffle(!this.queue.shuffle);
    $('btnRepeat').onclick = () => this.toggleRepeat();
    $('btnVisualizer').onclick = () => Visualizer.toggle();
    $('btnQueue').onclick = () => QueueView.open();
    $('playerFrom').onclick = () => {
      if (this.contextId && Store.playlist(this.contextId)) Nav.openPlaylist(this.contextId);
    };

    const vol = $('volSlider');
    vol.addEventListener('input', () => this._barVolume(Number(vol.value) / 100));
    $('volBtn').onclick = () => {
      if (!this.remote || this.remote.here) this.toggleMute();
      else this._barVolume(this._shownVolume() > 0 ? 0 : (this._muteRestore || 0.8));
    };
    // Scrolling over the volume nudges it, as in most players.
    $('volWrap').addEventListener('wheel', (e) => {
      e.preventDefault();
      this._barVolume(this._shownVolume() + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });

    const track = $('playerTrack');
    const timeAt = (clientX) => {
      const r = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      return frac * this.duration;
    };
    track.addEventListener('pointerdown', (e) => {
      if (!this.currentId || !this.duration) return;
      track.setPointerCapture(e.pointerId);
      this._dragging = true;
      track.classList.add('timeline--dragging');
      this._drawTime(timeAt(e.clientX));
      const move = (ev) => this._drawTime(timeAt(ev.clientX));
      const up = (ev) => {
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', up);
        this._dragging = false;
        track.classList.remove('timeline--dragging');
        this.seek(timeAt(ev.clientX));
      };
      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });
  },

  /** The bar's volume: this device's, or in remote mode the host's (when it allows that). */
  _barVolume(v) {
    if (!this.remote || this.remote.here) {
      this.setVolume(v);
      return;
    }
    if (!this.remote.state.allowVolume) return;
    const vol = Math.max(0, Math.min(1, v));
    if (vol > 0) this._muteRestore = vol;
    this.remote.state = { ...this.remote.state, volume: vol };
    this._drawVolume();
    // At most a few a second while dragged; the last one always goes.
    clearTimeout(this._remoteVolTimer);
    const wait = Math.max(0, (this._remoteVolAt || 0) + 200 - Date.now());
    this._remoteVolTimer = setTimeout(() => {
      this._remoteVolAt = Date.now();
      this._remoteDo('volume', { value: vol });
    }, wait);
  },

  _shownVolume() {
    return this.remote && !this.remote.here ? Number(this.remote.state.volume) || 0 : this.volume;
  },

  _drawBar() {
    const known = this.currentId ? Store.song(this.currentId) : null;
    // In remote mode, a song newer than this library shows as the host names it.
    const song = known || (this.remote && this.currentId ? { ...this.remote.state, id: this.currentId } : null);
    const bar = $('player');
    bar.classList.toggle('player--empty', !song);
    bar.classList.toggle('player--remote', !!this.remote);
    $('playerTitle').textContent = song ? Util.songLine(song) : 'Nothing playing';
    $('playerTitle').title = song ? Util.songLine(song) : '';
    // The phone's player (mobile.js): the title alone, the artist and mix below it.
    if ($('playerSub')) {
      if (song) $('playerTitle').textContent = song.title || 'Untitled';
      $('playerSub').textContent = song ? [song.artist, song.mix ? `(${song.mix})` : ''].filter(Boolean).join(' - ') : '';
    }
    // The cover only changes with the song (or its cover): drawn again, it would flicker.
    const coverKey = song ? `${song.id}/${song.cover || ''}` : '';
    if ($('playerCover').dataset.key !== coverKey || !$('playerCover').firstChild) {
      $('playerCover').dataset.key = coverKey;
      Covers.fill($('playerCover'), known);
    }
    const from = song ? this.listName() : '';
    $('playerFrom').hidden = !from;
    $('playerFromName').textContent = from;
    const playing = this.isPlaying;
    $('btnPlay').innerHTML = playing ? Icons.pause : Icons.play;
    $('btnPlay').title = playing ? 'Pause (Space)' : 'Play (Space)';
    for (const id of ['btnPrev', 'btnNext', 'btnBack10', 'btnFwd10']) $(id).disabled = !song;
    const toggles = [['btnShuffle', this.queue.shuffle, 'Shuffle'], ['btnRepeat', this.repeat, 'Repeat this song']];
    for (const [id, on, label] of toggles) {
      $(id).classList.toggle('sq-btn--on', on);
      $(id).setAttribute('aria-pressed', String(on));
      $(id).title = `${label}: ${on ? 'on' : 'off'}`;
    }
    const queued = this.queue.manual.length;
    $('btnQueue').title = queued ? `Queue (${queued} added by you)` : 'Queue';
    this._drawTime();
    this._drawVolume();
  },

  _drawTime(dragTime) {
    const d = this.duration;
    let t = this.currentId ? this.position : 0;
    if (this._pendingSeek !== null && !this.remote) t = this._pendingSeek;
    if (this._dragging && dragTime !== undefined) t = dragTime;
    else if (this._dragging) return;
    const frac = d ? Math.min(1, t / d) : 0;
    $('playerTime').textContent = `${Util.fmtClock(t)} / ${Util.fmtClock(d)}`;
    $('playerFill').style.width = (frac * 100) + '%';
    $('playerKnob').style.left = (frac * 100) + '%';
    if ('mediaSession' in navigator && d && this.currentId && Number.isFinite(d)) {
      try {
        navigator.mediaSession.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: 1 });
      } catch {
        // Position state is only a nicety for the Windows overlay.
      }
    }
  },

  _drawVolume() {
    // In remote mode the slider is the host's volume, and only there when the host allows it.
    const hosts = !!this.remote && !this.remote.here;
    $('volWrap').hidden = hosts && !this.remote.state.allowVolume;
    $('volWrap').title = hosts ? 'The host\'s volume' : '';
    const v = this._shownVolume();
    $('volSlider').value = String(Math.round(v * 100));
    $('volSlider').style.setProperty('--fill', (v * 100) + '%');
    $('volValue').textContent = Math.round(v * 100) + '%';
    $('volBtn').innerHTML = v === 0 ? Icons.mute : (v < 0.5 ? Icons.volumeLow : Icons.volume);
    $('volBtn').title = v === 0 ? 'Unmute' : 'Mute';
    if (!hosts) for (const fn of this._volumeListeners) fn(v);
  },

  // ---- media keys and the Windows media overlay ----

  _bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        // Not supported by this Chromium; the rest still work.
      }
    };
    set('play', () => this.toggle());
    set('pause', () => this.pause());
    set('stop', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
    set('seekbackward', (d) => this.skip(-(d.seekOffset || 10)));
    set('seekforward', (d) => this.skip(d.seekOffset || 10));
    set('seekto', (d) => this.seek(d.seekTime));
  },

  _updateMediaSession() {
    const song = this.currentId ? Store.song(this.currentId) : null;
    // The engine's own notification (the phone's), with the song's cover.
    this.engine.setMeta(song ? {
      title: song.mix ? `${song.title} (${song.mix})` : song.title,
      artist: song.artist || '',
      album: this.listName() || 'Flow',
      artwork: Store.coverSrc(song),
    } : null);
    if (!('mediaSession' in navigator)) return;
    if (!song) {
      navigator.mediaSession.metadata = null;
      return;
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.mix ? `${song.title} (${song.mix})` : song.title,
      artist: song.artist || '',
      album: this.listName() || 'Flow',
      artwork: Store.iconDataUrl ? [{ src: Store.iconDataUrl, sizes: '256x256', type: 'image/png' }] : [],
    });
  },
};
