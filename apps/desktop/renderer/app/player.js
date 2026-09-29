'use strict';

// The player bar at the bottom of every page, and the <audio> elements the
// library plays through. The Add Songs preview has its own element; the two
// never play at the same time (AudioFocus).
//
// There are two library elements. `audio` is the song the bar shows; `spare`
// plays the next song during a song transition (Settings): it starts a few
// seconds before the current song ends, the two are faded over each other,
// and only when the current song has really ended does the spare become
// `audio` and the bar move on. Anything the user does in between (pause,
// previous, seek, another song) calls the transition off; Next goes straight
// into the song already coming in.
//
// "Equalize volume" turns each song up or down to the same loudness, from the
// measurement main.js keeps in song.loudness.
//
// What comes next is the queue (queue.js). Repeat plays the current song over
// and over until it is turned off or another song is started by hand (a song
// clicked, Next, Previous).

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
  audio: null,
  spare: null,
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
  _listeners: [],
  _dragging: false,
  _saveTimer: null,
  _pendingSeek: null,
  _muteRestore: 0.8,
  volume: 0.8,
  // The listen in progress: which song, and how many seconds of it have been
  // heard. Counted into the song's statistics when the song changes.
  session: null,

  get isPlaying() {
    return !!this.audio && !this.audio.paused && !!this.currentId;
  },

  get position() {
    return this.audio ? this.audio.currentTime || 0 : 0;
  },

  onChange(fn) {
    this._listeners.push(fn);
  },

  _emit() {
    for (const fn of this._listeners) fn();
    this._drawBar();
  },

  init() {
    this.audio = $('mainAudio');
    this.spare = $('fadeAudio');
    this.volume = Store.settings.volume;
    // The equalizer puts itself between the elements and the speakers, and
    // the volume then lives on its gain so the picture does not shrink with it.
    Equalizer.attach([this.audio, this.spare]);
    this._applyVolume();
    this.queue.setShuffle(Store.settings.shuffle);

    // Both elements get the same handlers, which only act for the one that is
    // `audio` at the time: they swap at every transition.
    const mine = (fn) => (e) => {
      if (e.target === this.audio) fn(e);
    };
    for (const el of [this.audio, this.spare]) {
      el.addEventListener('play', mine(() => {
        AudioFocus.claim('player');
        this._emit();
      }));
      el.addEventListener('pause', mine(() => {
        this._savePosition();
        this._emit();
      }));
      el.addEventListener('ended', mine(() => {
        if (this.fade) this._promote();
        else if (this.repeat) this._restart();
        else this._advance();
      }));
      el.addEventListener('timeupdate', mine(() => {
        this._countListening();
        this._drawTime();
        this._maybeFade();
      }));
      // A jump is not listening: the next update starts counting afresh.
      el.addEventListener('seeking', mine(() => {
        if (this.session) this.session.lastT = null;
      }));
      el.addEventListener('durationchange', mine(() => this._drawTime()));
      el.addEventListener('loadedmetadata', mine(() => {
        const a = this.audio;
        if (this._pendingSeek !== null) {
          a.currentTime = Math.min(this._pendingSeek, Math.max(0, (a.duration || 0) - 0.5));
          this._pendingSeek = null;
        }
        this._drawTime();
      }));
      el.addEventListener('error', (e) => {
        // The song coming in cannot be played: no transition, the current one
        // ends and Next tries it the ordinary way.
        if (e.target !== this.audio) {
          if (e.target.getAttribute('src')) this._cancelFade();
          return;
        }
        if (!this.currentId || !this.audio.getAttribute('src')) return;
        const song = Store.song(this.currentId);
        toast(`Could not play "${song ? song.title : 'this song'}". The file may have been moved or deleted.`, 'error');
        this._emit();
      });
    }
    AudioFocus.register('player', () => this.pause());

    this._bindBar();
    this._bindMediaSession();

    // Library changes: a deleted song stops, a renamed one keeps playing, and
    // a song whose loudness was just measured is evened out straight away.
    Store.onLibrary(() => {
      this.queue.prune((id) => !!Store.song(id));
      if (this.fade && !Store.song(this.fade.id)) this._cancelFade();
      if (this.currentId && !Store.song(this.currentId)) this.stop();
      else if (this.contextId && !Store.playlist(this.contextId)) this.contextId = 'all';
      if (this.currentId) this._setNorm(this.audio, this.currentId, true);
      this._drawBar();
    });
    Store.onSettings((patch) => {
      if (!('normalize' in patch)) return;
      if (this.currentId) this._setNorm(this.audio, this.currentId, true);
      if (this.fade) this._setNorm(this.spare, this.fade.id, true);
    });

    setInterval(() => {
      if (this.isPlaying) this._savePosition();
    }, 5000);
    window.addEventListener('beforeunload', () => {
      try {
        window.yplayer.setSettingsNow({
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
      const ids = this.orderOf(context);
      if (this.queue.contextId !== context) this.queue.start(context, ids, songId);
      else this.queue.jump(songId, ids);
    }
    this.contextId = context;
    this.currentId = songId;
    this._pendingSeek = position > 0 ? position : null;
    this.audio.src = Util.fileUrl(song.file);
    this._setNorm(this.audio, songId);
    this._setFade(this.audio, 1);
    if (autoplay) this._play();
    this._updateMediaSession();
    this._savePosition();
    this._emit();
  },

  _play() {
    const p = this.audio.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err && err.name === 'AbortError') return; // replaced by another load
        this._emit();
      });
    }
  },

  /**
   * A song's row button: play it, or pause / resume it when it is the current
   * song. Resuming it from another list carries on in that list.
   */
  toggleSong(songId, contextId) {
    if (songId !== this.currentId) {
      this.load(songId, contextId);
      return;
    }
    if (!this.audio.paused) {
      this.pause();
      return;
    }
    if (this.contextId !== contextId) {
      this.contextId = contextId;
      this.queue.start(contextId, this.orderOf(contextId), songId);
      this._updateMediaSession();
    }
    this._play();
  },

  /** A playlist's own Play button: a new queue from its top (or a random song). */
  togglePlaylist(contextId) {
    if (this.contextId === contextId && this.currentId) {
      this.toggle();
      return;
    }
    const ids = this.orderOf(contextId);
    if (!ids.length) return;
    const first = this.queue.start(contextId, ids);
    this.repeat = false;
    this.load(first, contextId, { fromQueue: true });
  },

  toggle() {
    if (!this.currentId) {
      const context = this.contextId || Nav.currentPlaylistId() || 'all';
      this.togglePlaylist(context);
      return;
    }
    if (this.audio.paused) this._play();
    else this.pause();
  },

  pause() {
    this._cancelFade();
    if (this.audio && !this.audio.paused) this.audio.pause();
  },

  /** Next, pressed: another song started by hand, so Repeat goes off. */
  next() {
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
    const id = this.queue.next(this.orderOf(this.contextId));
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
    this.audio.currentTime = 0;
    this._play();
  },

  prev() {
    if (!this.contextId) return;
    this.repeat = false;
    this._cancelFade();
    const ids = this.orderOf(this.contextId);
    const id = this.queue.prev(ids);
    if (!id) return;
    if (id === this.currentId) {
      this._endSession();
      this._startSession(id);
      this.audio.currentTime = 0;
      this._emit();
      return;
    }
    this.load(id, this.contextId, { fromQueue: true });
  },

  toggleRepeat() {
    this.repeat = !this.repeat;
    // A transition already under way would leave the song being repeated.
    if (this.repeat) this._cancelFade();
    this._emit();
  },

  /** "Add to Queue": after the songs added before it, ahead of the list's own. */
  addToQueue(songId) {
    const song = Store.song(songId);
    if (!song) return;
    this.queue.add(songId);
    toast(`Added "${song.title}" to the queue`, 'success');
    this._emit();
  },

  /** An entry of the Queue popup clicked: it plays now. */
  playFromQueue(part, index) {
    const id = this.queue.playAt(part, index, this.orderOf(this.contextId));
    if (!id || !Store.song(id)) return;
    this.repeat = false;
    this.load(id, this.contextId || 'all', { fromQueue: true });
  },

  /** An entry of the Queue popup dragged to another place in its part. */
  moveInQueue(part, from, to) {
    this.queue.move(part, from, to);
    this._emit();
  },

  removeFromQueue(part, index) {
    this.queue.removeAt(part, index, this.orderOf(this.contextId));
    this._emit();
  },

  clearQueue() {
    this.queue.clearManual();
    this._emit();
  },

  seek(seconds) {
    if (!this.currentId) return;
    this._cancelFade();
    const d = this.audio.duration || 0;
    this.audio.currentTime = Math.max(0, Math.min(d ? d - 0.05 : seconds, seconds));
    this._drawTime();
  },

  skip(delta) {
    this.seek(this.position + delta);
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
    const v = this.volume * this.sleepFade;
    for (const el of [this.audio, this.spare]) el.volume = Equalizer.active ? 1 : v;
    if (Equalizer.active) Equalizer.setVolume(v);
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
    this._cancelFade();
    this.queue.setShuffle(on, this.contextId ? this.orderOf(this.contextId) : []);
    Store.saveSettings({ shuffle: !!on });
    this._emit();
  },

  stop() {
    this._cancelFade();
    this._endSession();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
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
    if (this.fade && (songId === this.fade.id || songId === this.currentId)) this._cancelFade();
    if (songId !== this.currentId) return null;
    const token = { songId, contextId: this.contextId, position: this.position, playing: this.isPlaying };
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    return token;
  },

  resume(token) {
    if (!token || !Store.song(token.songId)) return;
    this.load(token.songId, token.contextId,
      { autoplay: token.playing, position: token.position, keepSession: true, fromQueue: true });
  },

  // ---- song transition ----

  /**
   * On every time update of the current song: is it time to start the next
   * one? The transition is at most a third of either song, so short songs get
   * a short one, and a song that repeats itself (a one-song list) gets none.
   */
  _maybeFade() {
    const s = Store.settings;
    if (this.fade || this.repeat || !s.crossfade || !Equalizer.active || !this.currentId || this.audio.paused) return;
    const d = this.audio.duration;
    if (!d || !Number.isFinite(d)) return;
    const left = d - this.audio.currentTime;
    let length = Math.min(s.crossfadeSeconds, d / 3);
    if (left > length || left < 0.2) return;
    const id = this.queue.peek(this.orderOf(this.contextId));
    if (!id || id === this.currentId) return;
    const song = Store.song(id);
    if (!song) return;
    if (song.duration) length = Math.min(length, song.duration / 3);
    if (left > length) return;
    this._startFade(id, song, left);
  },

  _startFade(id, song, seconds) {
    const incoming = this.spare;
    this.fade = { id };
    incoming.src = Util.fileUrl(song.file);
    this._setNorm(incoming, id);
    // Equal power: the two together stay as loud as one all the way across.
    const n = 64;
    const down = new Float32Array(n);
    const up = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const x = (i / (n - 1)) * (Math.PI / 2);
      down[i] = Math.cos(x);
      up[i] = Math.sin(x);
    }
    const out = Equalizer.channel(this.audio).fade.gain;
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
    if (p && p.catch) p.catch(() => this._cancelFade());
  },

  /** The current song has ended (or Next was pressed): the one coming in takes over. */
  _promote() {
    const f = this.fade;
    if (!f) return;
    this.fade = null;
    const old = this.audio;
    const incoming = this.spare;
    this._endSession();
    this.audio = incoming;
    this.spare = old;
    old.pause();
    old.removeAttribute('src');
    old.load();
    this._holdFade(incoming, 1, 0.05);
    this._setFade(old, 1);
    this.queue.take(f.id, this.orderOf(this.contextId));
    this.currentId = f.id;
    // What played of it during the transition counts as listened.
    const heard = incoming.currentTime || 0;
    this._startSession(f.id, heard);
    this.session.lastT = heard;
    this._pendingSeek = null;
    if (incoming.paused) this._play();
    this._updateMediaSession();
    this._savePosition();
    this._emit();
  },

  /** Calls the transition off: the song coming in stops, the current one is back to full. */
  _cancelFade() {
    if (!this.fade) return;
    this.fade = null;
    const b = this.spare;
    b.pause();
    b.removeAttribute('src');
    b.load();
    this._holdFade(this.audio, 1, 0.08);
  },

  _setFade(el, value) {
    const ch = Equalizer.channel(el);
    if (!ch) return;
    const t = Equalizer.ctx.currentTime;
    ch.fade.gain.cancelScheduledValues(t);
    ch.fade.gain.setValueAtTime(value, t);
  },

  /** Stops a fade where it is and glides to `value` from there. */
  _holdFade(el, value, glide) {
    const ch = Equalizer.channel(el);
    if (!ch) return;
    const g = ch.fade.gain;
    const t = Equalizer.ctx.currentTime;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(t);
    else g.cancelScheduledValues(t);
    g.setTargetAtTime(value, t, glide);
  },

  // ---- equalize volume ----

  /** The gain that brings a song to the target loudness (1 when off or not measured). */
  _normGain(songId) {
    const song = Store.song(songId);
    if (!Store.settings.normalize || !song || song.loudness === null || song.loudness === undefined) return 1;
    const db = Math.max(-this.MAX_CUT_DB, Math.min(this.MAX_BOOST_DB, this.TARGET_LUFS - song.loudness));
    return 10 ** (db / 20);
  },

  _setNorm(el, songId, smooth = false) {
    const ch = Equalizer.channel(el);
    if (!ch) return;
    const g = this._normGain(songId);
    const t = Equalizer.ctx.currentTime;
    if (Math.abs(ch.norm.gain.value - g) < 0.001) return;
    ch.norm.gain.cancelScheduledValues(t);
    if (smooth) ch.norm.gain.setTargetAtTime(g, t, 0.3);
    else ch.norm.gain.setValueAtTime(g, t);
  },

  // ---- listening statistics ----

  _startSession(songId, listened = 0) {
    this.session = { songId, listened: Math.max(0, listened || 0), lastT: null };
  },

  /** Adds the time played since the last update, while actually playing. */
  _countListening() {
    const s = this.session;
    if (!s || s.songId !== this.currentId) return;
    const t = this.audio.currentTime || 0;
    if (!this.audio.paused && s.lastT !== null) {
      const step = t - s.lastT;
      // Updates come about four times a second; anything bigger is a jump.
      if (step > 0 && step < 1.5) s.listened += step;
    }
    s.lastT = t;
  },

  /** Counts the listen in progress (the song is changing) and forgets it. */
  _endSession() {
    const s = this.session;
    this.session = null;
    if (!s || s.listened < 1) return;
    const song = Store.song(s.songId);
    const duration = (song && song.duration) || 0;
    window.yplayer.recordListen(s.songId, s.listened, duration).catch(() => {});
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
      if (this.contextId) Nav.openPlaylist(this.contextId);
    };

    const vol = $('volSlider');
    vol.addEventListener('input', () => this.setVolume(Number(vol.value) / 100));
    $('volBtn').onclick = () => this.setVolume(this.volume > 0 ? 0 : (this._muteRestore || 0.8));
    // Scrolling over the volume nudges it, as in most players.
    $('volWrap').addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setVolume(this.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });

    const track = $('playerTrack');
    const timeAt = (clientX) => {
      const r = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
      return frac * (this.audio.duration || 0);
    };
    track.addEventListener('pointerdown', (e) => {
      if (!this.currentId || !this.audio.duration) return;
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

  _drawBar() {
    const song = this.currentId ? Store.song(this.currentId) : null;
    const bar = $('player');
    bar.classList.toggle('player--empty', !song);
    $('playerTitle').textContent = song ? Util.songLine(song) : 'Nothing playing';
    $('playerTitle').title = song ? Util.songLine(song) : '';
    const from = song && this.contextId ? Store.playlist(this.contextId) : null;
    $('playerFrom').hidden = !from;
    $('playerFromName').textContent = from ? from.name : '';
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
    const d = this.currentId ? (this.audio.duration || (Store.song(this.currentId) || {}).duration || 0) : 0;
    let t = this.currentId ? this.audio.currentTime || 0 : 0;
    if (this._pendingSeek !== null) t = this._pendingSeek;
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
    const v = this.volume;
    $('volSlider').value = String(Math.round(v * 100));
    $('volSlider').style.setProperty('--fill', (v * 100) + '%');
    $('volValue').textContent = Math.round(v * 100) + '%';
    $('volBtn').innerHTML = v === 0 ? Icons.mute : (v < 0.5 ? Icons.volumeLow : Icons.volume);
    $('volBtn').title = v === 0 ? 'Unmute' : 'Mute';
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
    if (!('mediaSession' in navigator)) return;
    const song = this.currentId ? Store.song(this.currentId) : null;
    if (!song) {
      navigator.mediaSession.metadata = null;
      return;
    }
    const list = Store.playlist(this.contextId);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.mix ? `${song.title} (${song.mix})` : song.title,
      artist: song.artist || '',
      album: list ? list.name : 'Flow',
      artwork: Store.iconDataUrl ? [{ src: Store.iconDataUrl, sizes: '256x256', type: 'image/png' }] : [],
    });
  },
};
