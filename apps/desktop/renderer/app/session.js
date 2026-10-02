'use strict';

// Active Sessions in the window (the server's side: apps/server/src/sessions.js).
//
// While this app plays something on a server with Active Sessions, it is a
// session's host: what it plays (song, place, list, queue, Repeat, Shuffle)
// goes to the server on every change and every HEARTBEAT_MS while playing,
// and the buttons of devices that joined arrive as `control` events, carried
// out here through the Player as if pressed here. A song or playlist started
// on another device plays from that device's list of songs (Player.playList),
// not from a playlist of this one.
//
// When the host before this one leaves, this app carries on: the song at its
// place, with its list and queue (Player.takeOver).

const Session = {
  HEARTBEAT_MS: 5000,
  // The server's list of sessions (everyone's, this app's own included).
  list: [],
  // This app's session: { session (members), host: true/false } or null.
  mine: null,
  // The id of the session this app hosts (alone or with others), or null.
  sessionId: null,
  // Whether this app has told the server about its playback (a session
  // exists, or did until it stopped).
  _published: false,
  _publishTimer: null,
  _heartbeat: null,
  _sentIds: '',
  _sentQueue: '',
  _listeners: [],
  // The output device's name, for the session's name ("Ceeser - Sony GTK").
  outputLabel: '',

  /** The server has Active Sessions and the live channel is open. */
  get available() {
    return !!(Store.server.on && Store.server.sessions && Store.server.live);
  },

  get isHost() {
    return !!this.mine && this.mine.host;
  },

  onChange(fn) {
    this._listeners.push(fn);
  },

  _emit() {
    for (const fn of this._listeners) fn();
  },

  init() {
    window.flow.onServerLive((ev) => this._onLive(ev));
    Player.onChange(() => this._changed());
    Player.onSeek(() => this._changed(true));
    Store.onServer(() => {
      if (!this.available && (this.mine || this.list.length)) {
        // Reconnecting: what the server knows comes again with the stream.
        this.list = [];
        this._emit();
      }
    });
    this._readOutput();
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => this._readOutput());
    }
  },

  /** The default output's name, as Windows calls it ("Default - Speakers (...)" without "Default - "). */
  async _readOutput() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const out = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')
        || devices.find((d) => d.kind === 'audiooutput');
      const label = out ? out.label.replace(/^Default\s*-\s*/i, '').trim() : '';
      if (label !== this.outputLabel) {
        this.outputLabel = label;
        this._changed();
      }
    } catch {
      // No name: the session goes by the profile and the PC's name.
    }
  },

  /** "[Profile] - [Output device]": what the others see this app as. */
  name() {
    const profile = (Store.server.profile && Store.server.profile.name) || 'Default';
    return `${profile} - ${this.outputLabel || 'Flow'}`;
  },

  // ---- the live channel ----

  _onLive({ type, data }) {
    if (type === 'hello') {
      // A new stream (a reconnect, or a restarted server): everything again.
      this._sentIds = '';
      this._sentQueue = '';
      if (this._published || Player.isPlaying) this._changed(true);
      return;
    }
    if (type === 'down') return;
    if (type === 'sessions') {
      this.list = Array.isArray(data.sessions) ? data.sessions : [];
      this._emit();
      return;
    }
    if (type === 'session') {
      const host = data.session && data.session.hostClient === Store.server.clientId;
      this.mine = data.session ? { session: data.session, host } : null;
      this._emit();
      return;
    }
    if (type === 'joinResult') {
      if (data.ok) {
        this.mine = { session: data.session, host: false };
        this._emit();
      }
      return;
    }
    if (type === 'left') {
      this.mine = null;
      this._emit();
      return;
    }
    if (type === 'control') {
      this._execute(data);
      return;
    }
    if (type === 'hostChanged') {
      this.mine = { session: data.session, host: true };
      this.sessionId = data.sessionId;
      Player.takeOver(this._stateAtNow(data.state));
      this._changed(true);
      this._emit();
    }
  },

  /** A state from the server, its position moved on to now (it was read at sampledAt, server time). */
  _stateAtNow(state) {
    if (!state) return null;
    const serverNow = Date.now() + (Store.server.timeOffset || 0);
    const late = state.playing && state.sampledAt ? Math.max(0, (serverNow - state.sampledAt) / 1000) : 0;
    return { ...state, position: (state.position || 0) + late };
  },

  // ---- the host's playback ----

  /** Player changed: tell the server soon (several changes go as one). */
  _changed(now = false) {
    if (!this.available) return;
    // Nothing told yet and nothing playing: no session to start.
    if (!this._published && !Player.isPlaying) return;
    clearTimeout(this._publishTimer);
    this._publishTimer = setTimeout(() => this._publish(), now ? 0 : 120);
  },

  _state() {
    const song = Player.currentId ? Store.song(Player.currentId) : null;
    if (!song) return { songId: null };
    const ids = Player.contextId ? Player.idsOf(Player.contextId) : [];
    const queue = Player.queue.snapshot();
    const state = {
      songId: song.id,
      title: song.title || '',
      artist: song.artist || '',
      mix: song.mix || '',
      duration: Player.audio.duration || song.duration || 0,
      playing: Player.isPlaying,
      position: Player.position,
      at: Date.now() + (Store.server.timeOffset || 0),
      repeat: !!Player.repeat,
      shuffle: !!Player.queue.shuffle,
      contextId: Player.contextId,
      contextName: Player.listName(),
      name: this.name(),
      allowVolume: !!Store.settings.sessionAllowVolume,
      volume: Player.volume,
      crossfade: Store.settings.crossfade ? Store.settings.crossfadeSeconds : 0,
    };
    // The long parts only when they changed.
    const idsKey = ids.join(',');
    if (idsKey !== this._sentIds) {
      state.ids = ids;
      this._sentIds = idsKey;
    }
    const queueKey = JSON.stringify(queue);
    if (queueKey !== this._sentQueue) {
      state.queue = queue;
      this._sentQueue = queueKey;
    }
    return state;
  },

  async _publish() {
    clearTimeout(this._heartbeat);
    if (!this.available) return;
    const state = this._state();
    try {
      const r = await window.flow.sessions({ type: 'state', state });
      this._published = !!r.sessionId;
      if (r.sessionId !== this.sessionId) {
        this.sessionId = r.sessionId || null;
        if (!r.sessionId && this.mine && this.mine.host) this.mine = null;
        this._emit();
      }
    } catch {
      // Sent again with the next change or heartbeat, everything included.
      this._sentIds = '';
      this._sentQueue = '';
    }
    if (Player.isPlaying) this._heartbeat = setTimeout(() => this._publish(), this.HEARTBEAT_MS);
  },

  // ---- buttons pressed on other devices ----

  _who(from) {
    return `${(from && from.profileName) || 'Default'} - ${(from && from.device) || 'another device'}`;
  },

  _execute({ action, args = {}, from }) {
    const songTitle = (id) => {
      const s = Store.song(id);
      return s ? s.title : 'a song';
    };
    switch (action) {
      case 'toggle': Player.toggle(); break;
      case 'play': if (!Player.isPlaying) Player.toggle(); break;
      case 'pause': Player.pause(); break;
      case 'next': Player.next(); break;
      case 'prev': Player.prev(); break;
      case 'seek': Player.seek(Number(args.position) || 0); break;
      case 'shuffle': if (Player.queue.shuffle !== !!args.on) Player.setShuffle(!!args.on); break;
      case 'repeat': if (Player.repeat !== !!args.on) Player.toggleRepeat(); break;
      case 'queueAdd':
        if (!Store.song(args.songId)) return;
        Player.queue.add(args.songId);
        Player._emit();
        toast(`${this._who(from)} added "${songTitle(args.songId)}" to the queue`, 'info');
        break;
      case 'queueRemove': Player.removeFromQueue(args.part, args.index); break;
      case 'queueMove': Player.moveInQueue(args.part, args.from, args.to); break;
      case 'queueClear': Player.clearQueue(); break;
      case 'playSong':
        if (!Store.song(args.songId)) return;
        Player.playList(args.ids, args.contextName, args.songId);
        break;
      case 'playPlaylist':
        // One of this app's own playlists plays as such; anything else as the list given.
        if (args.contextId && Store.playlist(args.contextId)) {
          if (Player.contextId === args.contextId && Player.currentId) {
            if (!Player.isPlaying) Player.toggle();
          } else Player.togglePlaylist(args.contextId);
        } else Player.playList(args.ids, args.contextName, null);
        break;
      case 'volume':
        if (Store.settings.sessionAllowVolume) Player.setVolume(Number(args.value));
        break;
      default:
    }
  },
};
