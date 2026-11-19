'use strict';

// Internet Radio (5.1): a station played live, beside the player's songs
// (player.js), through an <audio> of its own (#radioAudio) that goes into the
// same sound as the songs (Equalizer.addElement): the volume, the sound
// equalizer, the output device, the clouds, the background equalizer and the
// visualizers all hear it.
//
// A station started takes the player bar (its name, its picture, Live and how
// long it has played, Play/Pause, Previous/Next through the list it was
// started from, the star) and keeps it while paused, until a song is started
// again. While it has the bar, the bar's buttons, the keys, the media keys and
// the Mini Player's buttons work the station (Player.toggle and the others ask
// Radio.owns first).
//
// The time heard counts in the Statistics' Internet Radio (5.1), its own
// category: in pieces, a minute at a time while it plays and the rest when it
// stops (paused, another station, a song, the stream lost, the window
// closed), so hours heard are not lost with the app (at most the last
// minute). Each piece goes to this device's Private Statistics and, queued
// with the profile in use, to its Flow Server, also when it is sent later.
//
// Paused, the stream is let go of (no listening on in the background); Play
// connects again, so it plays live rather than from where it was paused.
//
// On the phone a station plays through the phone's own player instead of the
// <audio> (Player.engine.stationElement, the same calls), for the
// notification, the lock screen and the background. Paused there it stays
// loaded, so the notification can start it again.
//
// What the station plays now (5.3.1) is told by the stream itself (its ICY
// StreamTitle): on the computer and in the web player the stream plays
// through a relay (window.flow.radio.open: the main process's, or the Flow
// Server's) that reads it on the way (onInfo); on the phones the phone's own
// player reads it (the station element's 'songinfo'). A station that tells
// nothing shows "No Song Info". The bar, Now Playing, the Mini Player, the
// taskbar and the system's media overlay show the station's name and that.
//
// Each profile has its own Favourite Radios. A Flow Server that keeps them
// (5.3.1, its feature radioFavs) has them in the profile's library, synced to
// every device of the profile (window.flow.setRadioFavourite, renameRadio);
// without a server, or with one from before, they are this device's
// (Settings' radioFavs, under "<server id>/<profile id>", or "private"
// without a server), as before. A device's own for a profile go up to its
// server once that keeps them (_moveUp). A station added by hand (the page's
// Add Radio) is one at once; a favourite can be given a name of its own.

const RADIO_PRIVATE = 'private';
// What a favourite keeps of a station (core radio.js cleanStation).
const RADIO_FIELDS = ['id', 'name', 'url', 'favicon', 'homepage', 'country', 'countryCode', 'tags', 'codec', 'bitrate', 'own', 'listedName'];

const Radio = {
  el: null,
  // The station in the bar (playing or paused), or null: the bar is the songs'.
  station: null,
  // The stations Previous and Next go through: the list it was started from.
  list: [],
  // Connecting to it (Play pressed, no sound yet).
  connecting: false,
  // How long it has played this time: seconds before the last start, and since when.
  heard: 0,
  heardSince: 0,
  // Of that, how much is counted in the Statistics already.
  counted: 0,
  // The relay's number of the stream playing (0: none, or the phone's player), and what it said
  // it plays: { meta (it tells), title } (null: not heard yet).
  stream: 0,
  info: null,
  // Favourite lists of this device moved up to their server already (keys), this run.
  _movedUp: new Set(),
  PIECE_S: 60,
  LISTEN_S: 30,
  _listeners: [],
  _favListeners: [],
  _timer: null,

  init() {
    if (!Store.can('radio')) return;
    this.el = Player.engine.stationElement ? Player.engine.stationElement() : $('radioAudio');
    if (!this.el) return;
    // The phone's player shapes its sound itself.
    if (!this.el.keepsLoaded) Equalizer.addElement(this.el);
    // Without Web Audio the element has the volume itself.
    Player.onVolume((v) => {
      if (!Equalizer.active) this.el.volume = v;
    });
    if (!Equalizer.active) this.el.volume = Player.volume;
    AudioFocus.register('radio', () => this.pause());
    const el = this.el;
    el.addEventListener('playing', () => {
      this.connecting = false;
      if (!this.heardSince) this.heardSince = Date.now();
      this._emit();
    });
    el.addEventListener('waiting', () => {
      if (!el.paused) {
        this.connecting = true;
        this._emit();
      }
    });
    el.addEventListener('pause', () => {
      // Paused outside the page too on the phone (the notification, headphones pulled out, a call).
      if (el.keepsLoaded) this._stopClock();
      this._emit();
    });
    el.addEventListener('error', () => {
      if (!this.station || !el.getAttribute('src')) return;
      const lost = this.heardSince || this.heard;
      toast(T(lost ? 'radio.toast.lost' : 'radio.toast.cannotPlay', { station: this.station.name }), 'error');
      this._letGo();
      this._emit();
    });
    // A live stream has no end; one that ends anyway was cut off.
    el.addEventListener('ended', () => {
      if (!this.station) return;
      toast(T('radio.toast.lost', { station: this.station.name }), 'error');
      this._letGo();
      this._emit();
    });
    // What the station plays: the phone's player reads it itself.
    el.addEventListener('songinfo', () => this._takeInfo(el.songInfo || {}));
    if (window.flow.radio && window.flow.radio.onInfo) {
      window.flow.radio.onInfo((info) => {
        if (info && this.stream && info.stream === this.stream) this._takeInfo(info);
      });
    }
    // A song started (or the player resumed by anything) takes the bar back,
    // as does joining another device's session.
    Player.onChange(() => {
      if (this.station && (Player.isPlaying || Player.remote)) this.release();
    });
    // Another profile or server: its own favourites (and a device's go up to a server that keeps them).
    Store.onServer(() => {
      this._moveUp();
      this._favsChanged();
      this._emit();
    });
    // The server's favourites changed (here or on another device of the profile).
    Store.onLibrary(() => {
      this._moveUp();
      if (this._favsChanged()) this._favsEmit();
    });
    Store.onSettings((patch) => {
      if ('radioFavs' in patch && this._favsChanged()) this._favsEmit();
      // Turned off in Settings: what plays stops and the bar goes back.
      if ('showRadio' in patch && patch.showRadio === false && this.station) this.release();
    });
    this._timer = setInterval(() => {
      if (!this.playing) return;
      this._drawTime();
      if (this.seconds - this.counted >= this.PIECE_S) this._count();
    }, 1000);
    // The window closing: what it heard since the last piece.
    window.addEventListener('beforeunload', () => {
      if (!this.station) return;
      if (this.heardSince) {
        this.heard += (Date.now() - this.heardSince) / 1000;
        this.heardSince = Date.now();
      }
      this._count();
    });
  },

  onChange(fn) {
    this._listeners.push(fn);
  },

  /** The profile's Favourite Radios changed (one in or out, renamed; here or on another device). */
  onFavourites(fn) {
    this._favListeners.push(fn);
  },

  _favsEmit() {
    for (const fn of this._favListeners) fn();
    this._emit();
  },

  _emit() {
    for (const fn of this._listeners) fn();
    if (this.station) this.drawBar();
    this._updateMediaSession();
  },

  /** Whether a station has the player bar (playing or paused). */
  owns() {
    return !!this.station;
  },

  get playing() {
    return !!this.station && !!this.el && !this.el.paused;
  },

  isCurrent(station) {
    return !!this.station && !!station && this.station.id === station.id;
  },

  // ---- favourites ----

  /** The profile the favourites are kept for on this device (Statistics' keys). */
  key() {
    const s = Store.server;
    return s && s.on && s.profile && s.serverId ? `${s.serverId}/${s.profile.id}` : RADIO_PRIVATE;
  },

  /** Whether the profile's favourites are its server's (5.3.1), not this device's. */
  onServer() {
    const s = Store.server;
    return !!(s && s.on && s.radioFavs && window.flow.setRadioFavourite);
  },

  favourites() {
    if (this.onServer()) return (Store.library && Store.library.radioFavs) || [];
    return (Store.settings.radioFavs || {})[this.key()] || [];
  },

  /** Whether the favourites differ from the ones last drawn (the server's library changes for much else). */
  _favsChanged() {
    const now = this.favourites();
    if (now === this._favsSeen) return false;
    const text = JSON.stringify(now);
    this._favsSeen = now;
    if (text === this._favsText) return false;
    this._favsText = text;
    return true;
  },

  isFavourite(station) {
    return !!station && this.favourites().some((f) => f.id === station.id);
  },

  /** The favourite of that station (its own name, if it was given one), or null. */
  favouriteOf(station) {
    return (station && this.favourites().find((f) => f.id === station.id)) || null;
  },

  /** What a favourite keeps of a station. */
  _keep(station) {
    const out = {};
    for (const k of RADIO_FIELDS) if (station[k] !== undefined && station[k] !== '') out[k] = station[k];
    return out;
  },

  /** In or out of this profile's Favourite Radios; the newest first (`index`: where an Undo puts it back). */
  setFavourite(station, on, index = null) {
    const st = this._keep(station);
    if (this.onServer()) {
      window.flow.setRadioFavourite(st, !!on, index).catch((err) => toast((err && err.message) || String(err), 'error'));
      return;
    }
    const key = this.key();
    const all = { ...(Store.settings.radioFavs || {}) };
    const now = all[key] || [];
    if (on && now.some((f) => f.id === st.id)) return;
    const rest = now.filter((f) => f.id !== st.id);
    if (on) rest.splice(Number.isInteger(index) ? Math.max(0, Math.min(index, rest.length)) : 0, 0, st);
    all[key] = rest;
    Store.saveSettings({ radioFavs: all });
  },

  /** The star of a station: out again with Undo (a station added by hand is gone then). */
  toggleFavourite(station) {
    const kept = this.favouriteOf(station);
    if (!kept) {
      this.setFavourite(station, true);
      return;
    }
    const at = this.favourites().findIndex((f) => f.id === station.id);
    this.setFavourite(kept, false);
    toast(T('radio.removed', { station: kept.name }), 'info', {
      label: T('common.undo'),
      onClick: () => this.setFavourite(kept, true, at),
    });
  },

  /**
   * A favourite's own name; empty gives it back the one it came with (its
   * directory's, or what an added stream named itself). Asked for in a popup.
   */
  async rename(station) {
    const kept = this.favouriteOf(station);
    if (!kept) return;
    const typed = await promptDialog({
      title: T('radio.rename.title'), value: kept.name, confirmLabel: T('radio.rename.button'), maxLength: 200,
    });
    if (typed === null) return;
    const name = typed.replace(/\s+/g, ' ').trim();
    if (name === kept.name) return;
    const listed = kept.listedName || kept.name;
    if (this.onServer()) {
      window.flow.renameRadio(kept.id, name).catch((err) => toast((err && err.message) || String(err), 'error'));
    } else {
      const key = this.key();
      const all = { ...(Store.settings.radioFavs || {}) };
      all[key] = (all[key] || []).map((f) => {
        if (f.id !== kept.id) return f;
        const next = { ...f, name: name || listed };
        if (next.name === listed) delete next.listedName;
        else next.listedName = listed;
        return next;
      });
      Store.saveSettings({ radioFavs: all });
    }
    // The station in the bar is that one: its new name there too (and in the phone's notification).
    if (this.isCurrent(kept)) {
      this.station = { ...this.station, name: name || listed };
      if (this.el.retitle) this.el.retitle(this._phoneMeta(this.station));
      this._emit();
    }
  },

  /**
   * This device's favourites of the profile in use go up to its server once
   * it keeps them (5.3.1), the oldest first so they keep their order there,
   * those it has already left out; then they are the server's only.
   */
  _moveUp() {
    if (!this.onServer()) return;
    const key = this.key();
    if (key === RADIO_PRIVATE || this._movedUp.has(key)) return;
    // The server's library of this profile not here yet: later.
    if (!Store.library || !Array.isArray(Store.library.radioFavs)) return;
    this._movedUp.add(key);
    const mine = (Store.settings.radioFavs || {})[key];
    if (!Array.isArray(mine) || !mine.length) return;
    const there = new Set(Store.library.radioFavs.map((f) => f.id));
    for (const st of mine.slice().reverse()) {
      if (!there.has(st.id)) window.flow.setRadioFavourite(this._keep(st), true, null).catch(() => {});
    }
    const all = { ...(Store.settings.radioFavs || {}) };
    delete all[key];
    Store.saveSettings({ radioFavs: all });
  },

  // ---- what the station plays (5.3.1) ----

  /** What the relay or the phone's player says the stream plays now. */
  _takeInfo({ meta = false, title = '' } = {}) {
    const next = { meta: !!meta, title: String(title || '') };
    if (this.info && this.info.meta === next.meta && this.info.title === next.title) return;
    this.info = next;
    this._emit();
  },

  /** The song the station plays ("Artist - Title" as it sends it), or "No Song Info"; '' until the stream has said. */
  songLine() {
    if (!this.station || !this.info) return '';
    return this.info.title || T('radio.noSongInfo');
  },

  // ---- playing ----

  /**
   * A station's own Play button: plays it, or pauses / resumes it when it is
   * the one in the bar. `list`: the stations of the list it is in (Previous / Next).
   */
  toggleStation(station, list = null) {
    if (this.isCurrent(station)) {
      if (list) this.list = list.slice();
      this.toggle();
      return;
    }
    this.play(station, list);
  },

  async play(station, list = null) {
    if (!station || !this.el) return;
    if (list) this.list = list.slice();
    const other = !this.isCurrent(station);
    if (other && this.station) {
      // The station before: what it played since its last piece.
      if (this.heardSince) this.heard += (Date.now() - this.heardSince) / 1000;
      this.heardSince = 0;
      this._count();
    }
    this.station = { ...station };
    if (other) {
      this.heard = 0;
      this.heardSince = 0;
      this.counted = 0;
      // A directory station counts as played there (radio-browser.info asks apps to).
      if (!station.own && window.flow.radio) window.flow.radio.click(station.id).catch(() => {});
    }
    AudioFocus.claim('radio');
    this.connecting = true;
    // A new connection: what it plays is told anew (the phone's pause keeps the station loaded, and what it last told).
    if (other || !this.el.keepsLoaded) this.info = null;
    this._emit();
    // On the computer and in the web player through the relay (the sound for Web Audio, and what plays).
    let src = station.url;
    let stream = 0;
    if (window.flow.radio && window.flow.radio.open) {
      try {
        const opened = await window.flow.radio.open(station.url);
        src = opened.src;
        stream = opened.stream;
      } catch {
        if (!this.isCurrent(station)) return;
        toast(T('radio.toast.cannotPlay', { station: station.name }), 'error');
        this._letGo();
        this._emit();
        return;
      }
    }
    // Another station picked meanwhile.
    if (!this.isCurrent(station)) return;
    if (this.stream && this.stream !== stream && window.flow.radio && window.flow.radio.close) window.flow.radio.close(this.stream);
    this.stream = stream;
    this.el.crossOrigin = 'anonymous';
    // The phone's notification and lock screen: the station, and what it plays (its player fills that in).
    if (this.el.setMeta) this.el.setMeta(this._phoneMeta(station));
    this.el.src = src;
    try {
      await this.el.play();
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      // The element's own error event says why (and lets go).
      if (this.isCurrent(station) && !this.el.error) {
        toast(T('radio.toast.cannotPlay', { station: station.name }), 'error');
        this._letGo();
        this._emit();
      }
    }
  },

  toggle() {
    if (!this.station) return;
    if (this.playing) this.pause();
    else this.play(this.station);
  },

  /** What the phone's player shows for a station (it puts what the station plays in place of `artist`). */
  _phoneMeta(station) {
    return {
      title: station.name, artist: T('radio.noSongInfo'), album: T('common.internetRadio'), artwork: station.favicon || '', noInfo: T('radio.noSongInfo'),
    };
  },

  /** Paused: the stream is let go of; the station stays in the bar. */
  pause() {
    if (!this.station || !this.el) return;
    this._letGo(!!this.el.keepsLoaded);
    this._emit();
  },

  /** What it played until now counted; the clock stands until it plays again. */
  _stopClock() {
    if (this.heardSince) this.heard += (Date.now() - this.heardSince) / 1000;
    this.heardSince = 0;
    this._count();
    this.connecting = false;
  },

  /** `keep`: the station stays loaded (the phone's pause). */
  _letGo(keep = false) {
    this._stopClock();
    if (!this.el.paused) this.el.pause();
    if (!keep && this.el.getAttribute('src')) {
      this.el.removeAttribute('src');
      this.el.load();
    }
    if (!keep && this.stream) {
      if (window.flow.radio && window.flow.radio.close) window.flow.radio.close(this.stream);
      this.stream = 0;
    }
  },

  /** The bar back to the songs: the station stops. */
  release() {
    if (!this.station) return;
    this._letGo();
    this.station = null;
    this.info = null;
    this.heard = 0;
    this.counted = 0;
    for (const fn of this._listeners) fn();
    $('player').classList.remove('player--radio');
    $('playerFrom').title = T('window.player.from.tooltip');
    $('btnPrev').title = T('common.previousSong');
    $('btnNext').title = T('common.nextSong');
    Player._emit();
    Player._updateMediaSession();
  },

  /** Next / Previous: the next station of the list it was started from. */
  step(delta) {
    if (!this.station) return;
    const list = this.list.length ? this.list : this.favourites();
    if (!list.length) return;
    const at = list.findIndex((s) => s.id === this.station.id);
    const to = list[((at < 0 ? (delta > 0 ? -1 : 0) : at) + delta + list.length) % list.length];
    if (to) this.play(to);
  },

  /**
   * What the station played since its last piece, into the Statistics
   * (window.flow.recordRadioListen): this device's and the profile's. Less
   * than a second waits for the next. The piece in which this time reaches
   * LISTEN_S seconds counts as a listen of it.
   */
  _count() {
    const st = this.station;
    if (!st || !window.flow.recordRadioListen) return;
    const now = this.seconds;
    const piece = Math.round((now - this.counted) * 10) / 10;
    if (!(piece >= 1)) return;
    const listen = this.counted < this.LISTEN_S && now >= this.LISTEN_S;
    this.counted = now;
    window.flow.recordRadioListen({ id: st.id, name: st.name }, piece, listen).catch(() => {});
  },

  /** Seconds it has played this time. */
  get seconds() {
    return this.heard + (this.heardSince ? (Date.now() - this.heardSince) / 1000 : 0);
  },

  // ---- the player bar ----

  drawBar() {
    const st = this.station;
    if (!st) return;
    const bar = $('player');
    bar.classList.remove('player--empty', 'player--remote');
    bar.classList.add('player--radio');
    const line = this.songLine();
    if ($('playerSub')) {
      // The phone's player: the station, what it plays below it.
      $('playerTitle').textContent = st.name;
      $('playerSub').textContent = line;
    } else {
      // The computer's: one line, the station and (fainter) what it plays.
      $('playerTitle').replaceChildren(h('span', st.name), line ? h('span.player__radio-song', ` · ${line}`) : '');
    }
    $('playerTitle').title = line ? `${st.name}\n${line}` : st.name;
    // The station's picture, or the radio; only when the station changes.
    const cover = $('playerCover');
    const key = `radio:${st.id}`;
    if (cover.dataset.key !== key) {
      cover.dataset.key = key;
      Covers.fill(cover, null);
      clear(cover);
      cover.appendChild(this.picture(st));
    }
    $('playerFrom').hidden = false;
    $('playerFromName').textContent = T('common.internetRadio');
    $('playerFrom').title = T('radio.bar.open.tooltip');
    const playing = this.playing;
    $('btnPlay').innerHTML = playing ? Icons.pause : Icons.play;
    const action = playing ? T('common.pause') : T('common.play');
    $('btnPlay').title = Store.can('keyboard') ? T('common.spaceKeyHint', { action }) : action;
    const many = (this.list.length ? this.list : this.favourites()).length > 1;
    $('btnPrev').disabled = !many;
    $('btnNext').disabled = !many;
    $('btnPrev').title = T('radio.bar.previous');
    $('btnNext').title = T('radio.bar.next');
    $('btnBack10').disabled = true;
    $('btnFwd10').disabled = true;
    $('btnAddToPlaylist').disabled = true;
    // The Radios popup (5.2) makes a list from a song of the library: a station is none.
    $('btnRadios').disabled = true;
    const fav = this.isFavourite(st);
    $('btnFavourite').disabled = false;
    $('btnFavourite').classList.toggle('sq-btn--fav-on', fav);
    $('btnFavourite').setAttribute('aria-pressed', String(fav));
    $('btnFavourite').title = fav ? T('radio.favourite.remove') : T('radio.favourite.add');
    if ($('btnFavourite').dataset.icon !== String(fav)) {
      $('btnFavourite').dataset.icon = String(fav);
      $('btnFavourite').innerHTML = fav ? Icons.starFilled : Icons.star;
    }
    // The phone's bar has neither (its lyrics are in Now Playing).
    if ($('btnLyrics')) $('btnLyrics').hidden = true;
    if ($('noLyrics')) $('noLyrics').hidden = true;
    this._drawTime();
  },

  _drawTime() {
    if (!this.station) return;
    const live = this.connecting ? T('radio.bar.connecting') : T('radio.bar.live');
    $('playerTime').textContent = this.playing || this.heard ? `${live} · ${Util.fmtClock(this.seconds)}` : live;
    $('playerFill').style.width = this.playing && !this.connecting ? '100%' : '0%';
    $('playerKnob').style.left = '0%';
  },

  /** A station's picture (its favicon), the radio icon until it loads or when it has none. */
  picture(st, cls = 'radio-pic') {
    const box = h(`span.${cls}`, { html: Icons.radio });
    if (st.favicon) {
      // Not lazy: it is only put in once loaded, and a lazy picture outside the page never loads.
      const img = h('img', { alt: '', referrerPolicy: 'no-referrer' });
      img.onload = () => {
        if (img.naturalWidth > 1) {
          box.innerHTML = '';
          box.classList.add('radio-pic--img');
          box.appendChild(img);
        }
      };
      img.src = st.favicon;
    }
    return box;
  },

  _updateMediaSession() {
    if (!this.station || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.station.name,
        artist: this.songLine() || T('common.internetRadio'),
        album: T('common.internetRadio'),
        artwork: this.station.favicon ? [{ src: this.station.favicon }] : (Store.iconDataUrl ? [{ src: Store.iconDataUrl, sizes: '256x256', type: 'image/png' }] : []),
      });
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    } catch {
      // Only a nicety for the Windows overlay.
    }
  },
};
