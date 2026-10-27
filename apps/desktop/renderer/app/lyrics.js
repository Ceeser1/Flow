'use strict';

// Lyrics (4.0): the playing song's, from its Flow Server or from LRCLIB
// (window.flow.lyrics); with Settings' "Fetch/Sync Lyrics" off only those
// kept in the Lyrics folder (4.0.1). Three places:
//  - the player bar's Lyrics, shown while the song has lyrics ("(No Lyrics)"
//    in its place otherwise): a drawer beside the page with every line, the
//    one playing lit and kept in sight (unless the list was just scrolled by
//    hand), a click on a line plays from there;
//  - a full-screen visualizer: the line playing and the next at the bottom
//    (Settings' "In full-screen visualizers too"), moving up a row as the
//    next is sung; a song starting there without lines with times says so
//    for a moment instead;
//  - the phone's Now Playing: below its buttons (scrolled down to), four
//    lines with the one playing second, and Expand for all of them.
// Lines are only lit when LRCLIB has their times for this song's length;
// else the words are shown without.

const Lyrics = {
  songId: null,
  key: null,          // what the lyrics shown are of (song, names, length)
  state: 'idle',       // idle (nothing playing), loading, ready, error
  data: null,          // { found, synced: [{ t, text }] | null, plain, instrumental }
  error: '',
  index: -1,           // the line playing (lines with times only)
  expanded: false,     // the phone's frame showing every line
  _cache: new Map(),   // song key -> data, the last few songs
  _seq: 0,
  _drawer: null,       // the drawer while open: { modal, body }
  _vizEl: null,        // the lines over a full-screen visualizer
  _viz: null,          // what they show: { data, hint, at, now, next } (now, next: their nodes)
  _vizFrame: 0,
  _hintFor: null,      // the song started over a full-screen visualizer, its lyrics not known yet
  _hint: null,         // what it says instead of lines ({ songId, lines }), fading out
  _handScrolled: 0,    // when the drawer's list was last scrolled by hand
  LEAD: 0.2,           // a line is lit this much before its time
  VIZ_LEAD: 0.2,       // over a visualizer the lines move up this much before (the move's length, style.css)
  VIZ_SMALL: 0.6,      // the next line's size there, of the line playing
  VIZ_GAP: 0.15,       // between the two rows there, in em
  PAUSE: 6,            // seconds without words that show as a note
  KEEP: 30,

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
      // Fetch/Sync Lyrics turned on: looked up now; off: only those kept. Asked
      // after the setting has reached the app (Store sends it after this).
      if ('lyricsOn' in patch) setTimeout(() => this.forgetAll());
      if ('vizLyrics' in patch) this._placeViz();
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

  /**
   * Lyrics while the song playing has some (or they could not be fetched:
   * Try again is in the drawer), "(No Lyrics)" when it has none; nothing
   * while nothing plays. Looking them up leaves it as it was.
   */
  _drawButton() {
    const btn = $('btnLyrics');
    const none = $('noLyrics');
    if (!btn || this.state === 'loading') return;
    const has = this.state === 'error' || (this.state === 'ready' && this.lines.some((l) => l.trim()));
    btn.hidden = !has;
    if (none) none.hidden = has || this.state === 'idle';
  },

  /** The song playing changed (or was renamed, or Settings): its lyrics fetched. */
  _follow(force = false) {
    const song = Player.currentId ? Store.song(Player.currentId) : null;
    const key = song ? `${song.id}|${song.artist}|${song.title}|${Math.round(song.duration || 0)}` : '';
    if (key === this.key && !force) return;
    const newSong = !song || song.id !== this.songId;
    this.key = key;
    this.songId = song ? song.id : null;
    this.index = -1;
    if (newSong) {
      this.expanded = false;
      // Skipped: the hint of the song before goes at once.
      this._hint = null;
      this._hintFor = song && Visualizer.el ? song.id : null;
    }
    if (!song) this.state = 'idle';
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
      // A song of another server's session: looked up by its names.
      const which = song.foreign ? {
        id: song.id, title: song.title, artist: song.artist, duration: song.duration,
      } : song.id;
      const data = this._tidy(await window.flow.lyrics(which));
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

  /**
   * A pause between two lines is only shown (as a note) when it is a long
   * one. A line written with its end (4.0.1) is over then: a pause follows
   * when the next one starts later.
   */
  _tidy(data) {
    if (!data || !Array.isArray(data.synced)) return data;
    const lines = [];
    data.synced.forEach((l, i, all) => {
      lines.push(l);
      const next = all[i + 1];
      if (Number.isFinite(l.end) && l.text.trim() && (!next || next.t > l.end)) lines.push({ t: l.end, text: '' });
    });
    const synced = lines.filter((l, i) => l.text.trim() || !lines[i + 1] || lines[i + 1].t - l.t >= this.PAUSE);
    return { ...data, synced: synced.length ? synced : null };
  },

  retry() {
    this._cache.delete(this.key);
    this._follow(true);
  },

  /** A song's lyrics were written or edited (4.0.1): asked for anew, at once when it is playing. */
  forget(songId) {
    for (const key of [...this._cache.keys()]) if (key.startsWith(`${songId}|`)) this._cache.delete(key);
    if (songId === this.songId) this._follow(true);
  },

  /** Every song's asked for anew (Fetch/Sync Lyrics, Clear lyrics cache), the playing one's at once. */
  forgetAll() {
    this._cache.clear();
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
    this._drawButton();
    this._drawDrawer();
    this._drawPhone();
    this._takeHint();
    this._placeViz();
    this._drawViz();
  },

  _drawLine() {
    this._litDrawer();
    this._drawPhone(true);
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
      box.appendChild(h('div.lyrics__note', this.state === 'loading' ? LyricsEdit.spinner() : null, note));
      if (this.state === 'error') box.appendChild(h('button.btn.btn--small', { type: 'button', onclick: () => this.retry() }, 'Try again'));
      return;
    }
    const list = h('div.lyrics__lines');
    this.lines.forEach((text, i) => list.appendChild(this._line(text, i, 'lyrics__line')));
    box.appendChild(list);
    box.appendChild(h('div.lyrics__source', LyricsEdit.sourceLine(this.data)));
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

  /** The song started over the visualizer has its lyrics: without lines with times, a hint says so. */
  _takeHint() {
    if (!this._hintFor || this._hintFor !== this.songId || this.state === 'loading') return;
    this._hintFor = null;
    if (this.state !== 'ready') return;
    if (!this.lines.some((l) => l.trim())) this._hint = { songId: this.songId, lines: ['(No lyrics for this song)'] };
    else if (!this.synced) this._hint = { songId: this.songId, lines: ['(No timed lyrics for this song)', '(Open lyrics window for plain text)'] };
  },

  _placeViz() {
    if (!Visualizer.el) this._hint = null;
    const want = !!(Visualizer.el && Store.settings.vizLyrics !== false && (this.synced || this._hint));
    if (want && (!this._vizEl || this._vizEl.parentNode !== Visualizer.el)) {
      if (this._vizEl) this._vizEl.remove();
      this._vizEl = h('div.viz-lyrics');
      this._viz = null;
      Visualizer.el.appendChild(this._vizEl);
      this._drawViz();
      cancelAnimationFrame(this._vizFrame);
      this._vizFrame = requestAnimationFrame(() => this._followViz());
    } else if (!want && this._vizEl) {
      this._vizEl.remove();
      this._vizEl = null;
      this._viz = null;
      cancelAnimationFrame(this._vizFrame);
    }
  },

  /** Every frame while shown: the next line moves up the moment it is due (VIZ_LEAD before it is sung). */
  _followViz() {
    if (!this._vizEl) return;
    this._vizFrame = requestAnimationFrame(() => this._followViz());
    const v = this._viz;
    const synced = this.synced;
    if (!v || v.hint || !synced || v.data !== this.data) return;
    const at = this.lineAt(synced, Player.position + this.VIZ_LEAD);
    if (at === v.at) return;
    if (at === v.at + 1) this._moveViz(at);
    else this._drawViz();
  },

  /** A line's node over the visualizer: the line playing, or the next (smaller, dimmer). */
  _vizLine(text, now) {
    return h(`div.viz-lyrics__line${now ? '.viz-lyrics__line--now' : ''}`, text);
  },

  /** Places a line `y` px below the row of the line playing (its centre), at `scale`. */
  _vizPut(node, y, scale) {
    node.style.transform = `translateY(${y}px) translateY(-50%) scale(${scale})`;
  },

  /** Where the next line sits below the line playing: half of each, the gap between. */
  _vizBelow(now, next) {
    const em = parseFloat(getComputedStyle(this._vizEl).fontSize) || 30;
    return now.offsetHeight / 2 + this.VIZ_GAP * em + (next.offsetHeight * this.VIZ_SMALL) / 2;
  },

  /** The two rows drawn anew, as they are now (no move): a new song, a jump, the hint. */
  _drawViz() {
    if (!this._vizEl) return;
    const synced = this.synced || [];
    const at = this._hint ? -1 : this.lineAt(synced, Player.position + this.VIZ_LEAD);
    const v = this._viz;
    if (v && v.data === this.data && v.hint === this._hint && v.at === at) return;
    const now = this._vizLine(synced[at] && !this._hint ? synced[at].text : '', true);
    let next;
    if (this._hint) {
      // In the second row, fading out over 8 s.
      next = h('div.viz-lyrics__line.viz-lyrics__hint', ...this._hint.lines.map((text) => h('div', text)));
      next.addEventListener('animationend', () => {
        if (this._hint && this._hint.songId === this.songId) this._hint = null;
        this._placeViz();
        this._drawViz();
      });
    } else next = this._vizLine(synced[at + 1] ? synced[at + 1].text : '', false);
    clear(this._vizEl).append(now, next);
    // Put in place, not moved there.
    now.style.transition = 'none';
    next.style.transition = 'none';
    this._vizPut(now, 0, 1);
    this._vizPut(next, this._vizBelow(now, next), this.VIZ_SMALL);
    next.getBoundingClientRect();
    now.style.transition = '';
    next.style.transition = '';
    this._viz = {
      data: this.data, hint: this._hint, at, now, next,
    };
  },

  /**
   * On to line `at`: the line sung moves a row up, shrinking and fading out;
   * the next moves up into its place, growing and turning white; the one
   * after comes up into the second row.
   */
  _moveViz(at) {
    const v = this._viz;
    const synced = this.synced;
    const rise = this._vizBelow(v.now, v.next);
    const after = this._vizLine(synced[at + 1] ? synced[at + 1].text : '', false);
    after.style.opacity = '0';
    this._vizEl.appendChild(after);
    // Where it comes from, before it moves (the browser takes this as the start).
    this._vizPut(after, this._vizBelow(v.next, after) + rise, this.VIZ_SMALL);
    after.getBoundingClientRect();
    const gone = v.now;
    gone.classList.remove('viz-lyrics__line--now');
    gone.style.opacity = '0';
    this._vizPut(gone, -rise, this.VIZ_SMALL);
    gone.addEventListener('transitionend', (e) => {
      if (e.propertyName === 'opacity') gone.remove();
    });
    v.next.classList.add('viz-lyrics__line--now');
    this._vizPut(v.next, 0, 1);
    after.style.opacity = '';
    this._vizPut(after, this._vizBelow(v.next, after), this.VIZ_SMALL);
    Object.assign(v, { at, now: v.next, next: after });
  },

  // ---- the phone's Now Playing ----

  /** Four lines (the one playing second), or every line once expanded. `lineOnly`: only the line playing moved on. */
  _drawPhone(lineOnly = false) {
    const frame = $('npLyrics');
    if (!frame) return;
    const lines = this.lines;
    const show = !this._note() && lines.length > 0;
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
