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
// Joining another app's session asks its host (a prompt there, Accept or
// Decline); a declined app waits a minute before asking that one again. Once
// in, this app's player mirrors the host's and its buttons go there
// (Player.mirror, remote mode); leaving keeps the host's song here, paused. When
// the host before this one leaves, this app carries on: the song at its
// place, with its list and queue (Player.takeOver), and says so.

const Session = {
  HEARTBEAT_MS: 5000,
  // The live channel gone this long: out of the session (the server's grace is 15 s).
  LOST_MS: 20000,
  // The server's list of sessions (everyone's, this app's own included).
  list: [],
  // This app's session: { session (members), host: true/false } or null.
  mine: null,
  // The id of the session this app hosts (alone or with others), or null.
  sessionId: null,
  // The request to join this app waits on: { requestId, sessionId, name, expiresAt } or null.
  request: null,
  // Sessions whose host declined: session id -> when this app may ask again (Date.now()).
  cooldowns: new Map(),
  // Whether this app has told the server about its playback (a session
  // exists, or did until it stopped).
  _published: false,
  _publishTimer: null,
  _heartbeat: null,
  _sentIds: '',
  _sentQueue: '',
  _listeners: [],
  // The host's open join prompts: request id -> { modal, timer }.
  _prompts: new Map(),
  /** The output device's name, for the session's name ("Ceeser - Sony GTK"). */
  get outputLabel() {
    return Output.label();
  },

  /** The server has Active Sessions and the live channel is open. */
  get available() {
    return !!(Store.server.on && Store.server.sessions && Store.server.live);
  },

  get isHost() {
    return !!this.mine && this.mine.host;
  },

  /** In another app's session (not its host). */
  get isMember() {
    return !!this.mine && !this.mine.host;
  },

  /** The listed sessions of other apps. */
  others() {
    return this.list.filter((s) => s.host.client !== Store.server.clientId);
  },

  /** The menu shows Active Sessions while another app plays, or this one has company. */
  get visible() {
    return this.available && (this.others().length > 0 || (!!this.mine && this.mine.session.members.length > 1));
  },

  /** Seconds until this app may ask the host of `sessionId` again (0: now). */
  cooldownLeft(sessionId) {
    const until = this.cooldowns.get(sessionId) || 0;
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) this.cooldowns.delete(sessionId);
    return Math.max(0, left);
  },

  sessionName(id) {
    const s = this.list.find((x) => x.id === id) || (this.mine && this.mine.session.id === id ? this.mine.session : null);
    return s ? s.name : 'the session';
  },

  onChange(fn) {
    this._listeners.push(fn);
  },

  _emit() {
    for (const fn of this._listeners) fn();
  },

  init() {
    window.flow.onServerLive((ev) => this._onLive(ev));
    $('playerSession').onclick = () => Nav.show('sessions');
    $('playerLeave').onclick = () => attempt(() => this.leave());
    $('playerHere').onclick = () => this.setHere(!Store.settings.sessionPlayHere);
    this.onChange(() => this._drawBar());
    Player.onChange(() => this._drawBar());
    Player.onChange(() => this._changed());
    Player.onSeek(() => this._changed(true));
    // The profile signed in to, as long as connected (Flow may be connected before the window opens).
    if (this.available) this._profileId = Store.server.profile ? Store.server.profile.id : null;
    Store.onServer(() => {
      if (!this.available && (this.mine || this.list.length || this.request)) {
        // Reconnecting: what the server knows comes again with the stream.
        this.list = [];
        this._emit();
      }
      // Another profile signed in to (someone else at this device now): out of the
      // session, as when logging out. (A rename only renames it.)
      if (this.available) {
        const pid = Store.server.profile ? Store.server.profile.id : null;
        if (this._profileId !== undefined && pid !== this._profileId && this.mine) attempt(() => this.leave());
        this._profileId = pid;
      }
      // This profile renamed (or another one): the session's name follows.
      const name = this.name();
      if (name !== this._lastName) {
        this._lastName = name;
        this._changed();
      }
    });
    Store.onSettings((patch) => {
      // No longer shared: the server turns open requests away.
      if (patch.sessionShare === false) this._closePrompts();
      if ('sessionAllowVolume' in patch || 'sessionShare' in patch) this._changed(true);
    });
    Store.onLibrary(() => this._songArrived());
    // Another output (chosen, or Windows' default changed): the session's name changes with it.
    Output.onChange(() => {
      this._changed();
      this._drawBar();
    });
  },

  /**
   * "[Profile] - [Output device]": what the others see this app as. Without
   * an output name, '' lets the server name it after the PC ("Ceeser - DESKTOP-1").
   */
  name() {
    if (!this.outputLabel) return '';
    const profile = (Store.server.profile && Store.server.profile.name) || 'Default';
    return `${profile} - ${this.outputLabel}`;
  },

  // ---- joining, leaving, answering ----

  /** Asks the host of `sessionId` to let this app join. */
  async join(sessionId) {
    try {
      const r = await window.flow.sessions({ type: 'join', sessionId, mode: Store.settings.sessionPlayHere ? 'here' : 'remote' });
      this.request = {
        requestId: r.requestId, sessionId, name: this.sessionName(sessionId), expiresAt: Date.now() + (r.expiresIn || 60000),
      };
    } catch (err) {
      // Declined a moment ago: the server says how long to wait.
      const wait = /again in (\d+) seconds/.exec(err.message);
      if (wait) this.cooldowns.set(sessionId, Date.now() + Number(wait[1]) * 1000);
      this._emit();
      throw err;
    }
    this._emit();
  },

  /** Play the host's music on this device too (remembered for the next session). */
  setHere(on) {
    Store.saveSettings({ sessionPlayHere: !!on });
    Player.setHere(!!on);
    if (this.isMember) window.flow.sessions({ type: 'mode', mode: on ? 'here' : 'remote' }).catch(() => {});
    this._emit();
  },

  /** A button pressed here in remote mode, for the host to carry out. */
  control(action, args = {}) {
    window.flow.sessions({ type: 'control', action, ...args }).catch((err) => toast(err.message, 'error'));
  },

  async cancelJoin() {
    this.request = null;
    this._emit();
    await window.flow.sessions({ type: 'cancelJoin' });
  },

  /** Out of this app's session. A host hands it over to the next in line and stops playing. */
  async leave() {
    const wasHost = this.isHost;
    await window.flow.sessions({ type: 'leave' });
    this._out();
    if (wasHost) Player.pause();
  },

  _out() {
    if (Player.remote) Player.endRemote();
    this.mine = null;
    this.sessionId = null;
    this._published = false;
    clearTimeout(this._heartbeat);
    clearTimeout(this._publishTimer);
    this._closePrompts();
    this._emit();
  },

  /** Joined: this app's own session (if any) is handed on by the server; its playback stops here. */
  _becomeMember(session, state) {
    this.mine = { session, host: false };
    this.sessionId = null;
    this._published = false;
    clearTimeout(this._heartbeat);
    clearTimeout(this._publishTimer);
    this._closePrompts();
    if (state) {
      Player.mirror(state);
      Player.setHere(!!Store.settings.sessionPlayHere);
    } else Player.pauseHere();
  },

  _who(from) {
    return `${(from && from.profileName) || 'Default'} - ${(from && (from.device || from.ip)) || 'another device'}`;
  },

  /** A Windows notification (and the taskbar button flashing) while the window is not in front. */
  _notify(text) {
    if (document.hasFocus()) return;
    window.flow.notifySession(text).catch(() => {});
  },

  /** The host's prompt: someone asks to join. */
  _prompt(r) {
    if (this._prompts.has(r.requestId)) return;
    const who = this._who(r);
    const answer = async (accept) => {
      try {
        await window.flow.sessions({ type: 'answer', requestId: r.requestId, accept });
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    // Accepted without asking ("joined your session" follows from the server).
    if (Store.settings.sessionAutoAccept) {
      answer(true);
      return;
    }
    const modal = Modal.open({
      title: 'Join request',
      className: 'modal--small',
      body: [
        h('p.modal__text', `${who} wants to join your session.`),
        h('p.muted-text', 'Once in, they can pause, skip and queue songs that play here.'
          + (r.ip && r.device ? ` Connecting from ${r.ip}.` : '')),
      ],
      buttons: [
        { label: 'Decline', onClick: () => answer(false) },
        { label: 'Accept', kind: 'primary', onClick: () => answer(true) },
      ],
      onClose: () => {
        const p = this._prompts.get(r.requestId);
        if (p) clearTimeout(p.timer);
        this._prompts.delete(r.requestId);
      },
    });
    // The server says when it runs out (joinCancelled); this is in case that is missed.
    const timer = setTimeout(() => modal.close(), (r.expiresIn || 60000) + 2000);
    this._prompts.set(r.requestId, { modal, timer, who });
    this._notify(`${who} wants to join your session.`);
  },

  _closePrompts() {
    for (const p of [...this._prompts.values()]) p.modal.close();
  },

  /** "[Profile] - [Device] left, you are the new host", until dismissed. */
  _newHost(previous, reason) {
    const who = this._who(previous);
    const text = reason === 'dropped'
      ? `${who} lost its connection, you are the new host.`
      : `${who} left, you are the new host.`;
    Modal.open({
      title: 'You are the new host',
      className: 'modal--small',
      body: [h('p.modal__text', text), h('p.muted-text', 'The music plays on here, on this device.')],
      buttons: [{ label: 'Dismiss', kind: 'primary' }],
    });
    this._notify(text);
  },

  /** The player bar: "In [name]" with Leave in someone's session, "Your session: 2 listening" as a host with company. */
  _drawBar() {
    const m = this.available ? this.mine : null;
    const company = m ? m.session.members.length - 1 : 0;
    const pill = $('playerSession');
    pill.hidden = !m || (m.host && !company);
    $('playerLeave').hidden = !m || m.host;
    const here = !!Player.remote && !!Player.remote.here;
    $('playerHere').hidden = !m || m.host;
    $('playerHere').classList.toggle('player__here--on', here);
    $('playerHere').setAttribute('aria-pressed', String(here));
    const drift = here && Player.remote.drift !== null && Player.remote.drift !== undefined
      ? ` (now ${Math.round(Math.abs(Player.remote.drift) * 1000)} ms apart)` : '';
    $('playerHere').title = here
      ? `Playing here too, in step with the host${drift}. Click for remote control only`
      : 'Remote control only. Click to play the music on this device too, in step with the host';
    if (pill.hidden) return;
    const text = m.host ? `Your session: ${company} listening` : `In ${m.session.name}`;
    pill.innerHTML = Icons.sessions;
    pill.append(h('span', text));
    pill.title = m.host
      ? m.session.members.slice(1).map((x) => this._who(x)).join('\n')
      : 'What plays here plays on that device. Open Active Sessions';
  },

  /** Asks the server where this app stands (after a new stream). */
  async _refresh() {
    let view;
    try {
      view = await window.flow.sessions(null);
    } catch {
      return;
    }
    const wasMember = this.isMember ? this.mine.session : null;
    this.list = Array.isArray(view.sessions) ? view.sessions : [];
    if (view.mine) {
      this.mine = { session: view.mine.session, host: !!view.mine.host };
      if (view.mine.host) this.sessionId = view.mine.session.id;
      else if (view.mine.state) {
        Player.mirror(view.mine.state);
        Player.setHere(!!Store.settings.sessionPlayHere);
      }
    } else if (this.mine) {
      if (wasMember) toast(`You are no longer in ${wasMember.name}: the connection to the server was lost.`, 'info');
      else if (this.mine.session.members.length > 1) {
        toast('Your session went on without this device (the server restarted or lost the connection).', 'info');
      }
      if (Player.remote) Player.endRemote();
      this.mine = null;
      this.sessionId = null;
    }
    this.request = view.request ? {
      requestId: view.request.requestId,
      sessionId: view.request.sessionId,
      name: this.sessionName(view.request.sessionId),
      expiresAt: Date.now() + view.request.expiresIn,
    } : null;
    this._emit();
  },

  // ---- the live channel ----

  _onLive({ type, data }) {
    switch (type) {
      case 'hello':
        clearTimeout(this._downTimer);
        // A new stream (a reconnect, or a restarted server): everything again.
        this._sentIds = '';
        this._sentQueue = '';
        // Requests still open come again from the server.
        this._closePrompts();
        this._refresh();
        if (this._published || Player.isPlaying) this._changed(true);
        return;
      case 'down':
        // Back within the server's grace (15 s), nothing changes; after that, out.
        clearTimeout(this._downTimer);
        if (this.mine) this._downTimer = setTimeout(() => this._lost(), this.LOST_MS);
        return;
      case 'sessions':
        this.list = Array.isArray(data.sessions) ? data.sessions : [];
        this._emit();
        return;
      case 'session':
        this._onSession(data);
        return;
      case 'joinRequest':
        this._prompt(data);
        return;
      case 'state':
        if (this.isMember && data.sessionId === this.mine.session.id) Player.mirror(data.state);
        return;
      case 'joinCancelled': {
        const p = this._prompts.get(data.requestId);
        if (p) {
          p.modal.close();
          toast(`${p.who} no longer asks to join.`, 'info');
        }
        return;
      }
      case 'joinResult':
        this._onJoinResult(data);
        return;
      case 'left':
        this._onLeft(data);
        return;
      case 'control':
        this._execute(data);
        return;
      case 'hostChanged': {
        this.mine = { session: data.session, host: true };
        this.sessionId = data.sessionId;
        this._published = true;
        const state = this._stateAtNow(data.state);
        // A song newer than this library: played once the library has it.
        this._pendingSong = null;
        if (!Player.takeOver(state) && state && state.songId) this._pendingSong = { state, since: Date.now() };
        this._changed(true);
        this._newHost(data.previous, data.reason);
        this._emit();
        return;
      }
      default:
    }
  },

  _onSession(data) {
    if (!data.session) return;
    const me = Store.server.clientId;
    const host = data.session.hostClient === me;
    this.mine = { session: data.session, host };
    if (host) this.sessionId = data.session.id;
    if (data.joined && data.joined.client !== me) {
      toast(`${this._who(data.joined)} joined ${host ? 'your session' : 'the session'}.`, 'info');
    } else if (data.left && data.left.client !== me) {
      toast(`${this._who(data.left)} left ${host ? 'your session' : 'the session'}.`, 'info');
    } else if (data.hostChanged && !host) {
      const hostNow = data.session.members[0];
      toast(`${this._who(data.hostChanged.previous)} left. ${this._who(hostNow)} hosts the session now.`, 'info');
    }
    this._emit();
  },

  _onJoinResult(data) {
    const name = (this.request && this.request.sessionId === data.sessionId && this.request.name)
      || this.sessionName(data.sessionId);
    if (!this.request || this.request.requestId === data.requestId) this.request = null;
    if (data.ok) {
      this._becomeMember(data.session, data.state);
      toast(`You joined ${data.session.name}.`, 'success');
    } else if (data.reason === 'declined') {
      const wait = data.retryIn || 60;
      this.cooldowns.set(data.sessionId, Date.now() + wait * 1000);
      toast(`${name} declined. You can ask again in ${wait} seconds.`, 'info');
    } else if (data.reason === 'expired') {
      toast(`${name} did not answer in time. Ask again if you like.`, 'info');
    } else if (data.reason === 'full') {
      toast(`${name} is full.`, 'info');
    } else if (data.reason === 'unshared') {
      toast(`${name} is no longer shared.`, 'info');
    } else {
      toast('That session has ended.', 'info');
    }
    this._emit();
  },

  _onLeft({ reason, sessionId }) {
    const wasMember = this.isMember && this.mine.session.id === sessionId ? this.mine.session : null;
    if (this.mine && this.mine.session.id !== sessionId) return;
    this._out();
    if (!wasMember) return;
    if (reason === 'dropped') toast(`You are no longer in ${wasMember.name}: the connection to the server was lost.`, 'info');
    else if (reason === 'ended') toast(`${wasMember.name} has ended.`, 'info');
  },

  /** The library now has the song a handover left this app to play (for a minute). */
  _songArrived() {
    const p = this._pendingSong;
    if (!p) return;
    const waited = (Date.now() - p.since) / 1000;
    if (!this.isHost || waited > 60) {
      this._pendingSong = null;
      return;
    }
    if (!Store.song(p.state.songId)) return;
    this._pendingSong = null;
    Player.takeOver({ ...p.state, position: (p.state.position || 0) + (p.state.playing ? waited : 0) });
    this._changed(true);
  },

  /**
   * The live channel has been gone too long: the server has let this app go
   * by now. A member plays on by itself if it played along, else stops; a
   * host plays on, and the others went on without it.
   */
  _lost() {
    if (!this.mine) return;
    if (this.isMember) {
      const name = this.mine.session.name;
      const keep = !!Player.remote && Player.remote.here && Player.remote.state.playing;
      if (Player.remote) Player.endRemote({ keepPlaying: keep });
      toast(`The connection to the server was lost, and with it ${name}.${keep ? ' The music plays on here.' : ''}`, 'info');
    } else if (this.mine.session.members.length > 1) {
      toast('The connection to the server was lost. The others in your session go on without this device.', 'info');
    }
    this.mine = null;
    this.sessionId = null;
    this._closePrompts();
    this._emit();
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
    // In someone else's session: that host tells the server what plays.
    if (this.isMember) return;
    // Taken over a song this library does not have yet: the server keeps the
    // last state meanwhile (nothing loaded would end a session of one).
    if (this._pendingSong) return;
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
      duration: Player.engine.duration || song.duration || 0,
      playing: Player.isPlaying,
      position: Player.position,
      at: Date.now() + (Store.server.timeOffset || 0),
      repeat: !!Player.repeat,
      shuffle: !!Player.queue.shuffle,
      contextId: Player.contextId,
      contextName: Player.listName(),
      name: this.name(),
      shared: Store.settings.sessionShare !== false,
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
    if (!this.available || this.isMember) return;
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
      case 'queuePlay': Player.playFromQueue(args.part, args.index); break;
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
