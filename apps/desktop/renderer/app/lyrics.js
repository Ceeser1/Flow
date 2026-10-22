'use strict';

// Lyrics (4.0): the playing song's, from its Flow Server or from LRCLIB
// (window.flow.lyrics), while Settings' "Show lyrics" is on. Three places:
//  - the player bar's Lyrics: a drawer beside the page with every line, the
//    one playing lit and kept in sight (unless the list was just scrolled by
//    hand), a click on a line plays from there;
//  - a full-screen visualizer: the line playing and the next at the bottom
//    (Settings' "In full-screen visualizers too");
//  - the phone's Now Playing: below its buttons (scrolled down to), four
//    lines with the one playing second, and Expand for all of them.
// Lines are only lit when LRCLIB has their times for this song's length;
// else the words are shown without.

const Lyrics = {
  songId: null,
  key: null,          // what the lyrics shown are of (song, names, length)
  state: 'off',        // off (Settings), idle (nothing playing), loading, ready, error
  data: null,          // { found, synced: [{ t, text }] | null, plain, instrumental }
  error: '',
  index: -1,           // the line playing (lines with times only)
  expanded: false,     // the phone's frame showing every line
  _cache: new Map(),   // song key -> data, the last few songs
  _seq: 0,
  _drawer: null,       // the drawer while open: { modal, body }
  _vizEl: null,        // the lines over a full-screen visualizer
  _handScrolled: 0,    // when the drawer's list was last scrolled by hand
  LEAD: 0.2,           // a line is lit this much before its time
  PAUSE: 6,            // seconds without words that show as a note
  KEEP: 30,

  get on() {
    return Store.settings.lyricsOn !== false;
  },

  /** Lines with times, or null. */
  get synced() {
    return this.state === 'ready' && this.data && this.data.found ? this.data.synced : null;
  },

  /** Every line to show: the timed ones' texts, else the plain text's. */
  get lines() {
    if (this.state !== 'ready' || !this.data || !this.data.found) return [];
    if (this.data.synced) return this.data.synced.map((l) => l.text);
    return String(this.data.plain || '').split(/\r?\n/);
  },

  init() {
    Player.onChange(() => this._follow());
    Store.onLibrary(() => this._follow());
    Store.onSettings((patch) => {
      if ('lyricsOn' in patch || 'vizLyrics' in patch) {
        this._follow(true);
        this._drawButton();
      }
    });
    // The phone has its lyrics below Now Playing instead (Mobile leaves the button out).
    const btn = $('btnLyrics');
    if (btn) {
      btn.innerHTML = `${Icons.lyrics}<span>Lyrics</span>`;
      btn.onclick = () => this.toggleDrawer();
    }
    this._drawButton();
    setInterval(() => this._tick(), 200);
    this._follow();
  },

  _drawButton() {
    if ($('btnLyrics')) $('btnLyrics').hidden = !this.on;
    if (!this.on && this._drawer) this._drawer.modal.close();
  },

  /** The song playing changed (or was renamed, or Settings): its lyrics fetched. */
  _follow(force = false) {
    const song = this.on && Player.currentId ? Store.song(Player.currentId) : null;
    const key = song ? `${song.id}|${song.artist}|${song.title}|${Math.round(song.duration || 0)}` : '';
    if (key === this.key && !force) return;
    const newSong = !song || song.id !== this.songId;
    this.key = key;
    this.songId = song ? song.id : null;
    this.index = -1;
    if (newSong) this.expanded = false;
    if (!this.on) this.state = 'off';
    else if (!song) this.state = 'idle';
    else if (this._cache.has(key)) {
      this.state = 'ready';
      this.data = this._cache.get(key);
    } else {
      this._load(song, key);
      return;
    }
    this._drawAll();
  },

  async _load(song, key) {
    const seq = ++this._seq;
    this.state = 'loading';
    this.data = null;
    this._drawAll();
    try {
      const data = this._tidy(await window.flow.lyrics(song.id));
      if (seq !== this._seq) return;
      this._cache.set(key, data);
      if (this._cache.size > this.KEEP) this._cache.delete(this._cache.keys().next().value);
      this.state = 'ready';
      this.data = data;
      this.error = '';
    } catch (err) {
      if (seq !== this._seq) return;
      this.state = 'error';
      this.error = (err && err.message) || 'The lyrics could not be fetched.';
    }
    this._drawAll();
  },

  /** A pause between two lines is only shown (as a note) when it is a long one. */
  _tidy(data) {
    if (!data || !Array.isArray(data.synced)) return data;
    const lines = data.synced;
    const synced = lines.filter((l, i) => l.text.trim() || !lines[i + 1] || lines[i + 1].t - l.t >= this.PAUSE);
    return { ...data, synced: synced.length ? synced : null };
  },

  retry() {
    this._cache.delete(this.key);
    this._follow(true);
  },

  /** The line playing at second `t`, or -1 (as @flow/core/lyrics lineAt). */
  lineAt(lines, t) {
    if (!lines || !lines.length || !(t >= lines[0].t)) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lines[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  },

  _tick() {
    this._placeViz();
    const synced = this.synced;
    if (!synced) return;
    const i = this.lineAt(synced, Player.position + this.LEAD);
    if (i === this.index) return;
    this.index = i;
    this._drawLine();
  },

  /** Plays the song from line `i` (lines with times only). */
  seekTo(i) {
    const synced = this.synced;
    if (!synced || !synced[i]) return;
    Player.seek(Math.max(0, synced[i].t - 0.05));
    this.index = i;
    this._drawLine();
  },

  _drawAll() {
    this._drawDrawer();
    this._drawPhone();
    this._drawViz();
  },

  _drawLine() {
    this._litDrawer();
    this._drawPhone(true);
    this._drawViz();
  },

  /** What to say instead of lines, or '' when there are lines. */
  _note() {
    if (this.state === 'idle') return 'Nothing is playing.';
    if (this.state === 'loading') return 'Looking for the lyrics...';
    if (this.state === 'error') return this.error;
    if (this.state !== 'ready') return '';
    if (!this.data || !this.data.found) return 'No lyrics found for this song.';
    if (!this.lines.some((l) => l.trim())) return this.data.instrumental ? 'Instrumental' : 'No lyrics found for this song.';
    return '';
  },

  /** One line's node: a pause in the words is a note. `i`: its place, for a click to play from. */
  _line(text, i, cls) {
    const timed = !!this.synced;
    const node = h(`div.${cls}`, text.trim() ? text : '♪');
    if (!text.trim()) node.classList.add(`${cls}--pause`);
    if (timed) {
      node.classList.add(`${cls}--timed`);
      node.addEventListener('click', () => this.seekTo(i));
    }
    return node;
  },

  // ---- the drawer (player bar) ----

  toggleDrawer() {
    if (this._drawer) {
      this._drawer.modal.close();
      return;
    }
    const body = h('div.lyrics');
    const modal = Modal.open({
      title: 'Lyrics',
      className: 'modal--lyrics',
      drawer: true,
      body: [body],
      onClose: () => {
        this._drawer = null;
      },
    });
    const byHand = () => {
      this._handScrolled = performance.now();
    };
    body.addEventListener('wheel', byHand, { passive: true });
    body.addEventListener('touchmove', byHand, { passive: true });
    if (Mobile.on) Mobile.swipeToClose(modal, ['left', 'right'], () => false);
    this._drawer = { modal, body };
    this._drawDrawer();
  },

  _drawDrawer() {
    if (!this._drawer) return;
    const box = clear(this._drawer.body);
    const song = this.songId ? Store.song(this.songId) : null;
    if (song) box.appendChild(h('div.lyrics__song', Util.songLine(song)));
    const note = this._note();
    if (note) {
      box.appendChild(h('div.lyrics__note', note));
      if (this.state === 'error') box.appendChild(h('button.btn.btn--small', { type: 'button', onclick: () => this.retry() }, 'Try again'));
      return;
    }
    const list = h('div.lyrics__lines');
    this.lines.forEach((text, i) => list.appendChild(this._line(text, i, 'lyrics__line')));
    box.appendChild(list);
    box.appendChild(h('div.lyrics__source', this.synced ? 'Lyrics from LRCLIB' : 'Lyrics from LRCLIB, without their times for this song'));
    this._litDrawer(true);
  },

  _litDrawer(jump = false) {
    if (!this._drawer || !this.synced) return;
    const lines = this._drawer.body.querySelectorAll('.lyrics__line');
    lines.forEach((n, i) => n.classList.toggle('lyrics__line--now', i === this.index));
    const now = lines[this.index];
    // Scrolled by hand a moment ago: left where the user put it.
    if (now && performance.now() - this._handScrolled > 4000) now.scrollIntoView({ block: 'center', behavior: jump ? 'auto' : 'smooth' });
  },

  // ---- over a full-screen visualizer ----

  _placeViz() {
    const want = !!(Visualizer.el && this.on && Store.settings.vizLyrics !== false && this.synced);
    if (want && (!this._vizEl || this._vizEl.parentNode !== Visualizer.el)) {
      this._vizEl = h('div.viz-lyrics', h('div.viz-lyrics__now'), h('div.viz-lyrics__next'));
      Visualizer.el.appendChild(this._vizEl);
      this._drawViz();
    } else if (!want && this._vizEl) {
      this._vizEl.remove();
      this._vizEl = null;
    }
  },

  _drawViz() {
    if (!this._vizEl) return;
    const synced = this.synced || [];
    const now = synced[this.index];
    const next = synced[this.index + 1];
    this._vizEl.children[0].textContent = now ? now.text : '';
    this._vizEl.children[1].textContent = next ? next.text : '';
  },

  // ---- the phone's Now Playing ----

  /** Four lines (the one playing second), or every line once expanded. `lineOnly`: only the line playing moved on. */
  _drawPhone(lineOnly = false) {
    const frame = $('npLyrics');
    if (!frame) return;
    const lines = this.lines;
    const show = this.on && !this._note() && lines.length > 0;
    if (frame.hidden === show) {
      frame.hidden = !show;
      Mobile.fitLyrics();
    }
    if (!show) return;
    const timed = !!this.synced;
    if (lineOnly && this.expanded) {
      frame.querySelectorAll('.np-lyrics__line').forEach((n, i) => n.classList.toggle('np-lyrics__line--now', i === this.index));
      return;
    }
    let shown;
    if (this.expanded) shown = lines.map((text, i) => [text, i]);
    else if (timed) {
      const from = Math.max(0, Math.min(this.index - 1, lines.length - 4));
      shown = lines.slice(from, from + 4).map((text, i) => [text, from + i]);
    } else shown = lines.map((text, i) => [text, i]).filter(([text]) => text.trim()).slice(0, 4);
    const list = h('div.np-lyrics__lines');
    for (const [text, i] of shown) {
      const node = this._line(text, i, 'np-lyrics__line');
      if (timed && i === this.index) node.classList.add('np-lyrics__line--now');
      list.appendChild(node);
    }
    const more = lines.length > 4 || this.expanded;
    clear(frame).append(
      h('div.np-lyrics__head', h('span', 'Lyrics'), more ? h('button.link-btn.np-lyrics__expand', {
        type: 'button',
        onclick: () => {
          this.expanded = !this.expanded;
          this._drawPhone();
        },
      }, this.expanded ? 'Collapse' : 'Expand') : null),
      list,
    );
  },
};
