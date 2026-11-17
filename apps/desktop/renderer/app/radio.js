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
// Radio.owns first). Nothing is counted into the statistics.
//
// Paused, the stream is let go of (no listening on in the background); Play
// connects again, so it plays live rather than from where it was paused.
//
// Each profile has its own Favourite Radios (Settings' radioFavs, kept on this
// device under "<server id>/<profile id>", or "private" without a server); a
// station added by hand (the page's Add Radio) is one at once.

const RADIO_PRIVATE = 'private';

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
  _listeners: [],
  _timer: null,

  init() {
    this.el = $('radioAudio');
    if (!this.el || !Store.can('radio')) return;
    Equalizer.addElement(this.el);
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
    el.addEventListener('pause', () => this._emit());
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
    // A song started (or the player resumed by anything) takes the bar back,
    // as does joining another device's session.
    Player.onChange(() => {
      if (this.station && (Player.isPlaying || Player.remote)) this.release();
    });
    // Another profile or server: its own favourites.
    Store.onServer(() => this._emit());
    Store.onSettings((patch) => {
      if ('radioFavs' in patch) this._emit();
      // Turned off in Settings: what plays stops and the bar goes back.
      if ('showRadio' in patch && patch.showRadio === false && this.station) this.release();
    });
    this._timer = setInterval(() => {
      if (this.playing) this._drawTime();
    }, 1000);
  },

  onChange(fn) {
    this._listeners.push(fn);
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

  /** The profile the favourites are kept for (Statistics' keys). */
  key() {
    const s = Store.server;
    return s && s.on && s.profile && s.serverId ? `${s.serverId}/${s.profile.id}` : RADIO_PRIVATE;
  },

  favourites() {
    return (Store.settings.radioFavs || {})[this.key()] || [];
  },

  isFavourite(station) {
    return !!station && this.favourites().some((f) => f.id === station.id);
  },

  /** In or out of this profile's Favourite Radios; the newest first. */
  setFavourite(station, on) {
    const key = this.key();
    const all = { ...(Store.settings.radioFavs || {}) };
    const now = all[key] || [];
    const rest = now.filter((f) => f.id !== station.id);
    all[key] = on ? [{ ...station }, ...rest] : rest;
    Store.saveSettings({ radioFavs: all });
  },

  /** The star of a station: out again with Undo when it was one added by hand (it is gone then). */
  toggleFavourite(station) {
    if (!this.isFavourite(station)) {
      this.setFavourite(station, true);
      return;
    }
    const at = this.favourites().findIndex((f) => f.id === station.id);
    this.setFavourite(station, false);
    toast(T('radio.removed', { station: station.name }), 'info', {
      label: T('common.undo'),
      onClick: () => {
        const key = this.key();
        const all = { ...(Store.settings.radioFavs || {}) };
        const list = (all[key] || []).filter((f) => f.id !== station.id);
        list.splice(Math.max(0, Math.min(at, list.length)), 0, station);
        all[key] = list;
        Store.saveSettings({ radioFavs: all });
      },
    });
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
    this.station = { ...station };
    if (other) {
      this.heard = 0;
      this.heardSince = 0;
      // A directory station counts as played there (radio-browser.info asks apps to).
      if (!station.own && window.flow.radio) window.flow.radio.click(station.id).catch(() => {});
    }
    AudioFocus.claim('radio');
    this.connecting = true;
    this._emit();
    try {
      if (window.flow.radio) await window.flow.radio.allow(station.url);
    } catch {
      // Without it the sound may stay silent through Web Audio, but it is tried.
    }
    // Another station picked meanwhile.
    if (!this.isCurrent(station)) return;
    this.el.crossOrigin = 'anonymous';
    this.el.src = station.url;
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

  /** Paused: the stream is let go of; the station stays in the bar. */
  pause() {
    if (!this.station || !this.el) return;
    this._letGo();
    this._emit();
  },

  _letGo() {
    if (this.heardSince) this.heard += (Date.now() - this.heardSince) / 1000;
    this.heardSince = 0;
    this.connecting = false;
    if (!this.el.paused) this.el.pause();
    if (this.el.getAttribute('src')) {
      this.el.removeAttribute('src');
      this.el.load();
    }
  },

  /** The bar back to the songs: the station stops. */
  release() {
    if (!this.station) return;
    this._letGo();
    this.station = null;
    this.heard = 0;
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
    $('playerTitle').textContent = st.name;
    $('playerTitle').title = st.name;
    if ($('playerSub')) $('playerSub').textContent = T('common.internetRadio');
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
    const fav = this.isFavourite(st);
    $('btnFavourite').disabled = false;
    $('btnFavourite').classList.toggle('sq-btn--fav-on', fav);
    $('btnFavourite').setAttribute('aria-pressed', String(fav));
    $('btnFavourite').title = fav ? T('radio.favourite.remove') : T('radio.favourite.add');
    if ($('btnFavourite').dataset.icon !== String(fav)) {
      $('btnFavourite').dataset.icon = String(fav);
      $('btnFavourite').innerHTML = fav ? Icons.starFilled : Icons.star;
    }
    $('btnLyrics').hidden = true;
    $('noLyrics').hidden = true;
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
        artist: T('common.internetRadio'),
        album: 'Flow',
        artwork: this.station.favicon ? [{ src: this.station.favicon }] : (Store.iconDataUrl ? [{ src: Store.iconDataUrl, sizes: '256x256', type: 'image/png' }] : []),
      });
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    } catch {
      // Only a nicety for the Windows overlay.
    }
  },
};
