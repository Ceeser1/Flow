'use strict';

// The player bar's Mini Player button (5.0), on the computer only: a small
// window of its own (a widget: the song, its timeline, the five buttons, the
// volume) that stays there while Flow's window is in the tray. The window is
// the main process's (src/miniPlayer.js, its page mini/); this is Flow's side
// of it: the button, what plays told there whenever it changes (and once a
// second while it plays, for the time), and its buttons done here.
//
// The song shown is also kept by the main process for "Open on PC Start",
// so it is told even while the Mini Player is closed (then every few seconds).
//
// Its Show Equalizer draws the equalizer there (mini/eq.js): the levels come
// from here, asked for with each of its frames (Equalizer.levelsFor), so they
// are worked out also while this window is in the tray and draws nothing.
//
// While the Mini Player is open, Flow's window can be in the tray: hidden,
// only playing for it (Store.away; main.js says when, 'window:away'). Nothing
// is drawn here then: an open visualizer is closed and what was made ready
// for the next one let go, the clouds and the equalizer rest. All of it
// starts again when the window is opened.

const MiniPlayer = {
  open: false,
  _ready: false,
  _queued: false,
  _beat: 0,
  // The playing song's big cover as last looked up: { key, src }.
  _big: null,

  /** Whether this app has a Mini Player (the computer's; not its phone layout, a phone or the web player). */
  get can() {
    return Store.can('miniPlayer') && !!window.flow.toggleMini;
  },

  init(open = false) {
    const btn = $('btnMini');
    if (!this.can) {
      btn.hidden = true;
      return;
    }
    this.open = !!open;
    btn.innerHTML = Icons.miniPlayer;
    btn.onclick = () => window.flow.toggleMini();
    window.flow.onMiniOpen((isOpen) => {
      this.open = !!isOpen;
      this._draw();
      if (this.open) this.send();
    });
    window.flow.onMiniCommand((cmd) => this._do(cmd || {}));
    window.flow.onAway((info) => this._away(info || {}));
    // Its equalizer (Show Equalizer): the levels it asks for with each of its frames.
    window.flow.onMiniLevelsWanted((bars) => window.flow.miniLevels(Equalizer.levelsFor(bars)));
    Player.onChange(() => this.send());
    Player.onSeek(() => this.send());
    Player.onVolume(() => this.send());
    Covers.onArrived((ids) => {
      if (!Player.currentId || (ids && !ids.includes(Player.currentId))) return;
      this._big = null;
      this.send();
    });
    // The time moves on by the clock over there; told again so it stays right.
    setInterval(() => {
      if (!Player.isPlaying) return;
      this._beat += 1;
      if (this.open || this._beat % 5 === 0) this.send();
    }, 1000);
    this._draw();
  },

  /** The player has put the last session's song back: from now on the Mini Player hears what plays. */
  ready() {
    if (!this.can) return;
    this._ready = true;
    this.send();
  },

  /** What plays, to the Mini Player; several changes in one turn go as one. */
  send() {
    if (!this._ready || this._queued) return;
    this._queued = true;
    queueMicrotask(() => {
      this._queued = false;
      window.flow.miniState(this._state());
    });
  },

  _state() {
    const id = Player.currentId;
    const known = id ? Store.song(id) : null;
    // In remote mode, a song newer than this library shows as the host names it.
    const song = known || (Player.remote && id ? { ...Player.remote.state, id } : null);
    return {
      hasSong: !!song,
      songId: song ? String(song.id) : '',
      title: song ? song.title || T('common.untitled') : '',
      artist: song ? [song.artist, song.mix ? `(${song.mix})` : ''].filter(Boolean).join(' - ') : '',
      cover: known ? Covers.src(known) : '',
      coverBig: this._bigCover(known),
      list: song ? Player.listName() : '',
      playing: Player.isPlaying,
      position: id ? Player.position : 0,
      duration: Player.duration || 0,
      at: Date.now(),
      volume: Player._shownVolume(),
      // As the bar's slider: this device's volume, or in a session the host's when it allows that.
      canVolume: Player._hostVolume() || ((!Player.remote || !!Player.remote.here) && Store.can('volume')),
    };
  },

  /**
   * The song's big cover, for the Mini Player's "Cover as background" (the
   * small one until the big one is here). Looked up once per song and cover,
   * and again when a cover of it arrives: asking starts fetching it.
   */
  _bigCover(song) {
    if (!song) return '';
    const key = `${song.id}:${song.cover || ''}`;
    if (!this._big || this._big.key !== key) this._big = { key, src: Covers.bestBig(song) };
    return this._big.src;
  },

  /** A button of the Mini Player's. */
  _do({ action, value }) {
    if (action === 'toggle') Player.toggle();
    else if (action === 'prev') Player.prev();
    else if (action === 'next') Player.next();
    else if (action === 'back10') Player.skip(-10);
    else if (action === 'fwd10') Player.skip(10);
    else if (action === 'seek') Player.seek(Number(value) || 0);
    else if (action === 'volume') Player._barVolume(Number(value) || 0);
    else if (action === 'openFlow') this._openFlow();
    this.send();
  },

  /**
   * Flow's window goes into the tray (away) or comes back from it. `pause`:
   * it went by its X, so the music stops; the Mini Player can start it again.
   */
  _away({ away, pause }) {
    if (pause) this._quiet();
    if (!!away === Store.away) return;
    Store.away = !!away;
    if (away) Visualizer.rest();
    Ambient.rest(Store.away);
    Equalizer.rest(Store.away);
    if (!away) Visualizer.back();
  },

  /**
   * This device's music stops. In someone else's session that is only the
   * playing along here: the host's music is not this window's to stop.
   */
  _quiet() {
    if (Player.remote) Player.setHere(false);
    else Player.pause();
    this.send();
  },

  /** Open Flow: the window is in front by now; the page of the list playing (its playlist or its group). */
  _openFlow() {
    const context = Player.currentId ? Player.contextId : null;
    if (context && Store.playlist(context)) Nav.openPlaylist(context);
  },

  _draw() {
    const btn = $('btnMini');
    btn.classList.toggle('sleep-btn--mini-on', this.open);
    btn.setAttribute('aria-pressed', String(this.open));
    btn.title = T(this.open ? 'mini.button.close.tooltip' : 'mini.button.tooltip');
    btn.setAttribute('aria-label', btn.title);
  },
};
