'use strict';

// Lyrics written or edited by hand (4.0.1), for a song of the library (Song
// Details) or one just downloaded (Add Songs). Three popups:
//  - show: the song's lines, each with its times "from - to";
//  - edit: each line's From and To boxes (mm:ss:ms) and its words, lines
//    added and taken out;
//  - add: the words pasted in, split into lines, then the same as edit.
// A line's To left empty: until the next line starts. Saved as lines
// [{ t, end, text }] (@flow/core/lyrics ownLyrics): every line with words
// has its From, or none has (then the words are kept without times).
//
// In Add Songs the lyrics belong to the downloaded file (its whole length,
// as the preview plays it): cut() moves them to the song as trimmed.
//
// The editor plays the song under the lines (_player): its waveform with each
// line's stretch in the line's colour, a click or drag to move, the place to
// the millisecond. Every song starts with a line of music (no words, a note)
// until the first line is sung.

const LyricsEdit = {
  /** Whether lyrics can be written here (the desktop for now; the phone's layout comes later). */
  get available() {
    return !!(window.flow && window.flow.setLyrics) && !Mobile.on;
  },

  /** '01:23:450' (minutes, seconds, milliseconds) for 83.45 s; '' for none. */
  fmt(t) {
    if (t === null || t === undefined || !Number.isFinite(Number(t))) return '';
    const ms = Math.round(Math.max(0, Number(t)) * 1000);
    const p = (n, w) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 60000), 2)}:${p(Math.floor(ms / 1000) % 60, 2)}:${p(ms % 1000, 3)}`;
  },

  /**
   * Seconds from "mm:ss:ms" ("1:05:250", "01:05.25", "1:05", "65"): null for
   * an empty box, NaN for one that cannot be read. The part after the
   * seconds is a fraction of a second, as many digits as given ("5" 500 ms).
   */
  parse(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const m = /^(?:(\d{1,4}):)?(\d{1,2})(?:[:.,](\d{1,3}))?$/.exec(s);
    if (!m) return NaN;
    const sec = Number(m[2]);
    if (m[1] !== undefined && sec > 59) return NaN;
    return Number(m[1] || 0) * 60 + sec + (m[3] ? Number(`0.${m[3]}`) : 0);
  },

  /**
   * The lines of `data` ({ found, synced, plain }) as rows [{ t, end, text }]:
   * a line's end its own, else the next line's start (the last: `duration`).
   * Words without times: rows without.
   */
  rows(data, duration = 0) {
    if (!data || !data.found) return [];
    if (data.synced) {
      return data.synced.map((l, i, all) => ({
        t: l.t,
        end: Number.isFinite(l.end) ? l.end : (all[i + 1] ? all[i + 1].t : (duration > l.t ? duration : null)),
        text: l.text,
      }));
    }
    return String(data.plain || '').split(/\r?\n/).map((text) => ({ t: null, end: null, text }));
  },

  /** Lines as shown and played (as @flow/core/lyrics ownLyrics keeps them), or null for none. */
  toData(lines) {
    const rows = (lines || []).map((r) => ({ ...r, text: String(r.text || '').trim() }));
    const worded = rows.filter((r) => r.text);
    if (!worded.length) return null;
    if (!worded.some((r) => r.t !== null)) {
      return {
        found: true, synced: null, plain: rows.map((r) => r.text).join('\n').replace(/\n{3,}/g, '\n\n').trim(), source: 'own', own: true,
      };
    }
    const synced = rows.filter((r) => r.t !== null).sort((a, b) => a.t - b.t)
      .map((r) => (r.end !== null && r.end > r.t ? { t: r.t, end: r.end, text: r.text } : { t: r.t, text: r.text }));
    return {
      found: true, synced, plain: synced.map((l) => l.text).join('\n'), source: 'own', own: true,
    };
  },

  /**
   * Lines written for a downloaded file, for the song cut from `start` to
   * `end` of it: moved back by `start`, those outside it left out (one that
   * began before it starts at 0).
   */
  cut(lines, start, end) {
    if (!lines) return null;
    if (!lines.some((r) => r.t !== null)) return lines;
    const len = end - start;
    const out = [];
    for (const r of lines) {
      if (r.t === null) continue;
      const t = r.t - start;
      const stop = r.end === null ? null : r.end - start;
      if (t >= len || (stop !== null && stop <= 0)) continue;
      out.push({ t: Math.max(0, t), end: stop === null ? null : Math.min(len, stop), text: r.text });
    }
    return out;
  },

  /** "Artist - Title (Mix)", the popups' first line. */
  heading(song) {
    const line = [song.artist, song.title || 'Untitled'].filter(Boolean).join(' - ');
    return song.mix ? `${line} (${song.mix})` : line;
  },

  /**
   * The loading circle before "Looking for lyrics..." (a busy LRCLIB is
   * tried up to nine times over 51 s, @flow/core/lyrics RETRY).
   */
  spinner() {
    return h('span.lyrics-spinner');
  },

  /** "Lyrics" with a green circled tick (found) or a red circled cross (none), for after a song's title. */
  badge(found) {
    return h(`span.lyrics-badge.lyrics-badge--${found ? 'yes' : 'no'}`, {
      title: found ? 'Lyrics found' : 'No lyrics found',
      html: `${found ? Icons.circleCheck : Icons.circleX}<span>Lyrics</span>`,
    });
  },

  /** The song's lyrics with each line's times. `title`: "Artist - Title". */
  show({ title, data, duration = 0 }) {
    const rows = this.rows(data, duration);
    const timed = !!(data && data.synced);
    const list = h('div.lyrics-show__lines');
    for (const r of rows) {
      list.appendChild(h('div.lyrics-show__row',
        h('span.lyrics-show__time', timed ? `${this.fmt(r.t)} - ${r.end === null ? '...' : this.fmt(r.end)}` : ''),
        h('span.lyrics-show__text' + (r.text.trim() ? '' : '.lyrics-show__text--pause'), r.text.trim() ? r.text : (timed ? '♪' : ''))));
    }
    Modal.open({
      title: 'Lyrics',
      className: 'modal--lyrics-show',
      body: [
        h('div.lyrics-show__song', title),
        timed ? null : h('div.lyrics-show__note', 'These lyrics have no times.'),
        list,
        h('div.lyrics-show__source', this.sourceLine(data)),
      ],
      buttons: [{ label: 'Close', kind: 'primary' }],
    });
  },

  /** Where the lyrics came from, in a few words. */
  sourceLine(data) {
    if (!data || !data.found) return '';
    if (data.own) return data.synced ? 'Lyrics written in Flow' : 'Lyrics written in Flow, without times';
    const from = data.source || 'LRCLIB';
    return data.synced ? `Lyrics from ${from}` : `Lyrics from ${from}, without their times for this song`;
  },

  /**
   * Edit Lyrics: the lines of `data` in the editor. `player` ({ src,
   * duration, peaks }): the song to play under the lines, see _player.
   */
  edit({
    title, data, duration = 0, onSave, player = null,
  }) {
    return this._editor({
      title, rows: this.rows(data, duration), own: !!(data && data.own), onSave, heading: 'Edit Lyrics', player,
    });
  },

  /** Add Lyrics: the words pasted in first, then the editor. */
  add({ title, onSave, player = null }) {
    return this._editor({
      title, rows: [], own: false, onSave, heading: 'Add Lyrics', player,
    });
  },

  // Each line's colour, on its row and on its stretch of the waveform: these
  // eight in turn, from the first again after an empty line (music).
  // The least of the song the waveform shows zoomed in, in seconds.
  MIN_VIEW: 1,

  COLOURS: [[90, 140, 220], [224, 144, 74], [108, 196, 126], [192, 112, 208], [224, 200, 74], [74, 192, 200], [224, 106, 122], [168, 208, 96]],

  /**
   * The editor: a row per line, From - To and the words. `onSave(lines)`
   * (lines [{ t, end, text }], or null to take the own lyrics away) may
   * throw: the message is shown and the popup stays.
   */
  _editor({
    title, rows, own, onSave, heading, player,
  }) {
    const grid = h('div.lyrics-edit__rows');
    const error = h('div.form-error.lyrics-edit__error');
    const deck = player ? this._player(player) : null;
    // Lines coloured again (and the waveform with them) whenever one changes.
    const ed = {
      grid,
      error,
      changed: () => {
        const marks = this._paint(grid);
        if (deck) deck.mark(marks);
      },
    };
    grid.addEventListener('input', ed.changed);
    const paste = h('textarea.input.lyrics-edit__paste', {
      placeholder: 'Paste the lyrics here, one line per row.', spellcheck: 'false', rows: '10',
    });
    const split = h('button.btn.btn--light-green', { type: 'button', onclick: () => fromPaste() }, 'Split into lines');
    const pasteBox = h('div.lyrics-edit__paste-box', paste, h('div.lyrics-edit__paste-foot', split));
    const head = h('div.lyrics-edit__head',
      h('span', 'From'), h('span'), h('span', 'To'), h('span', 'Lyrics'), h('span'), h('span'));
    const addLine = h('button.btn.btn--small', {
      type: 'button',
      html: `${Icons.plus}<span>Add line</span>`,
      onclick: () => {
        const row = this._row({ t: null, end: null, text: '' }, ed);
        grid.appendChild(row);
        ed.changed();
        row.querySelector('.lyrics-edit__text').focus();
      },
    });
    const table = h('div.lyrics-edit__table', head, grid, h('div.lyrics-edit__foot', addLine));

    const showRows = (list) => {
      clear(grid);
      for (const r of this._withIntro(list)) grid.appendChild(this._row(r, ed));
      pasteBox.hidden = list.length > 0;
      table.hidden = list.length === 0;
      ed.changed();
    };
    // The pasted words, a row a line: empty lines at either end left out, a
    // run of them kept as one (between verses).
    const fromPaste = () => {
      const lines = paste.value.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
      while (lines.length && !lines[0]) lines.shift();
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      const kept = lines.filter((l, i) => l || lines[i - 1]);
      if (!kept.length) {
        error.textContent = 'Paste or type the lyrics into the box first.';
        return;
      }
      error.textContent = '';
      showRows(kept.map((text) => ({ t: null, end: null, text })));
      const first = grid.querySelector('.lyrics-edit__time');
      if (first) first.focus();
    };
    paste.addEventListener('paste', () => setTimeout(fromPaste, 0));
    showRows(rows);

    const hint = h('div.hint-label.lyrics-edit__hint',
      'Times as mm:ss:ms (minutes, seconds, milliseconds). An empty "To": until the next line. '
      + 'Leave every time empty to keep the words without times. + or Enter adds a line after one, '
      + 'a line without words is music (♪).');
    const buttons = [];
    if (own) {
      buttons.push({
        label: 'Remove my lyrics',
        kind: 'light-red',
        align: 'left',
        onClick: async () => {
          const ok = await confirmDialog({
            title: 'Remove your lyrics?',
            message: 'The lyrics written for this song go, and Flow looks for its lyrics again.',
            confirmLabel: 'Remove',
            danger: true,
          });
          if (!ok) return false;
          return save(null);
        },
      });
    }
    buttons.push({ label: 'Cancel' }, {
      label: 'Save',
      kind: 'primary',
      onClick: () => {
        // Still at the pasting: the words split into lines first.
        if (table.hidden) {
          fromPaste();
          return false;
        }
        return save(this._read(grid, error));
      },
    });
    const save = async (lines) => {
      if (lines === undefined) return false;
      if (deck) deck.stop();
      try {
        await onSave(lines);
      } catch (err) {
        error.textContent = (err && err.message) || 'The lyrics could not be saved.';
        return false;
      }
      return true;
    };
    return Modal.open({
      title: heading,
      className: 'modal--lyrics-edit',
      body: [h('div.lyrics-show__song', title), hint, pasteBox, table, error, deck && deck.el],
      buttons,
      focus: rows.length ? '.lyrics-edit__time' : '.lyrics-edit__paste',
      onClose: () => {
        if (deck) deck.destroy();
      },
    });
  },

  /**
   * `list` with a line of music (♪, no words) first, from 0:00:000 until the
   * first line with words: the song's start before anyone sings. One already
   * there starts at 0; none for words from the very start.
   */
  _withIntro(list) {
    if (!list.length) return list;
    const first = list.find((r) => String(r.text || '').trim() && r.t !== null);
    const until = first ? first.t : null;
    if (!String(list[0].text || '').trim()) {
      return [{ ...list[0], t: 0, end: list[0].end !== null && list[0].end !== undefined ? list[0].end : until }, ...list.slice(1)];
    }
    if (list[0].t === 0) return list;
    return [{ t: 0, end: until, text: '' }, ...list];
  },

  /**
   * One line's row: From - To, its words (a note in an empty one: music), +
   * to add a line after it and x to take it out.
   */
  _row(r, ed) {
    const box = (t, label) => h('input.input.lyrics-edit__time', {
      type: 'text', value: this.fmt(t), placeholder: 'mm:ss:ms', spellcheck: 'false', 'aria-label': label,
    });
    const from = box(r.t, 'From');
    const to = box(r.end, 'To');
    const text = h('input.input.lyrics-edit__text', {
      type: 'text', value: r.text, spellcheck: 'false', maxlength: '500', 'aria-label': 'Lyrics',
    });
    const words = h('div.lyrics-edit__words', h('span.lyrics-edit__note', { html: Icons.library, title: 'Music, no words' }), text);
    const row = h('div.lyrics-edit__row', from, h('span.lyrics-edit__dash', '-'), to, words);
    // An empty line after this one, filling the time between them when both are known.
    const addAfter = () => {
      const t = this.parse(to.value);
      const nextFrom = row.nextElementSibling && this.parse(row.nextElementSibling.querySelector('.lyrics-edit__time').value);
      const start = Number.isFinite(t) ? t : null;
      const added = this._row({
        t: start, end: start !== null && Number.isFinite(nextFrom) && nextFrom > start ? nextFrom : null, text: '',
      }, ed);
      row.after(added);
      ed.changed();
      return added;
    };
    row.append(
      iconButton('icon-btn.lyrics-edit__add', Icons.plus, 'Add a line after this one', () => {
        addAfter().querySelector('.lyrics-edit__text').focus();
      }),
      iconButton('icon-btn.lyrics-edit__remove', Icons.x, 'Take this line out', () => {
        const next = row.nextElementSibling || row.previousElementSibling;
        row.remove();
        ed.changed();
        if (next) next.querySelector('.lyrics-edit__text').focus();
      }),
    );
    // A time typed in is shown as mm:ss:ms once left; one that cannot be read is marked.
    for (const b of [from, to]) {
      b.addEventListener('change', () => {
        const v = this.parse(b.value);
        b.classList.toggle('input--bad', Number.isNaN(v));
        if (!Number.isNaN(v)) b.value = this.fmt(v);
        ed.error.textContent = '';
      });
    }
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addAfter().querySelector('.lyrics-edit__time').focus();
    });
    return row;
  },

  /**
   * Colours the rows (see COLOURS) and gives the timed ones as marks for the
   * waveform, by time: [{ t, end, rgb (null: music), row }], a line without a
   * To lasting until the next one (the last: to the end).
   */
  _paint(grid) {
    const marks = [];
    let n = 0;
    for (const row of grid.querySelectorAll('.lyrics-edit__row')) {
      const [from, to] = row.querySelectorAll('.lyrics-edit__time');
      const music = !row.querySelector('.lyrics-edit__text').value.trim();
      const rgb = music ? null : this.COLOURS[n % this.COLOURS.length];
      n = music ? 0 : n + 1;
      row.classList.toggle('lyrics-edit__row--music', music);
      // Its colour as the waveform has it (style.css .lyrics-edit__row--lit).
      row.classList.toggle('lyrics-edit__row--lit', !!rgb);
      if (rgb) row.style.setProperty('--line-rgb', String(rgb));
      else row.style.removeProperty('--line-rgb');
      const t = this.parse(from.value);
      const end = this.parse(to.value);
      if (Number.isFinite(t)) marks.push({
        t, end: Number.isFinite(end) && end > t ? end : null, rgb, row,
      });
    }
    marks.sort((a, b) => a.t - b.t);
    marks.forEach((m, i) => {
      if (m.end === null) m.end = marks[i + 1] ? marks[i + 1].t : Infinity;
    });
    return marks;
  },

  /**
   * The player under the lines: the song's waveform (the lines' colours on
   * it, a click or drag moves there), back 5 s, play / pause, on 5 s and
   * the place to the millisecond. The mouse wheel zooms the waveform in and
   * out at the pointer (the phone: pinching, later), Shift + wheel (or a
   * sideways scroll) or the scroll bar under it moves along, a double-click
   * shows the whole song again; playing past the part shown or skipping out
   * of it moves it along.
   * `src`: what an <audio> plays (null: the
   * song cannot be reached); `duration`: its length, else the audio's own;
   * `peaks()`: the waveform's peaks (or a promise of them, null for none).
   * Returns { el, mark(marks), stop(), destroy() }.
   */
  _player({ src, duration: known = 0, peaks: loadPeaks = null }) {
    const canvas = h('canvas.lyrics-edit__wave');
    const playhead = h('div.playhead.playhead--audio');
    const status = h('div.audio-status.lyrics-edit__wave-status');
    const playBtn = h('button.round-btn.round-btn--main', { type: 'button', title: 'Play' });
    const skip = (by) => h('button.round-btn', {
      type: 'button',
      title: by < 0 ? '5 seconds back' : '5 seconds on',
      html: `<span class="skip-label">${by < 0 ? '-5' : '+5'}</span>`,
      onclick: () => seek(audio.currentTime + by, true),
    });
    const clock = h('span.lyrics-edit__clock');
    const zoomNote = h('span.lyrics-edit__zoom');
    // Zoomed in: a scroll bar under the waveform, its thumb the part shown.
    const thumb = h('div.lyrics-edit__scroll-thumb');
    const scrollbar = h('div.lyrics-edit__scroll', { hidden: true }, thumb);
    const el = h('div.lyrics-edit__player',
      h('div.lyrics-edit__wave-wrap', canvas, playhead, status),
      scrollbar,
      h('div.lyrics-edit__transport', skip(-5), playBtn, skip(5), clock, zoomNote));

    let duration = known;
    // The part of the song the waveform shows, in seconds: all of it, or less zoomed in.
    let view = { a: 0, b: known };
    let peaks = null;
    let marks = [];
    let lit = null;
    let lastT = 0;
    let raf = 0;
    let gone = false;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.volume = Player.volume;
    if (src) audio.src = src;
    for (const b of el.querySelectorAll('button')) b.disabled = !src;
    const setStatus = (text) => {
      status.textContent = text;
      status.hidden = !text;
    };
    if (!src) setStatus(`Not on ${Store.here}, and the server cannot be reached: the song cannot be played.`);

    const draw = () => {
      if (gone) return;
      this._drawWave(canvas, peaks, duration, marks, view);
      place();
    };
    const shown = () => Math.max(0.001, view.b - view.a);
    const xToT = (x) => view.a + (x / (canvas.clientWidth || 1)) * shown();
    const fitLen = (len) => Math.min(duration, Math.max(Math.min(this.MIN_VIEW, duration), len));
    // Shows `len` seconds from `a` on (kept inside the song).
    const showView = (a, len) => {
      const at = Math.max(0, Math.min(duration - len, a));
      view = { a: at, b: at + len };
      const zoomed = len < duration - 0.001;
      zoomNote.textContent = zoomed
        ? `Zoom ${(duration / len).toFixed(1)}x, Shift + wheel or the bar below moves, double-click: whole song`
        : 'Mouse wheel on the waveform: zoom in';
      scrollbar.hidden = !zoomed;
      if (zoomed) {
        thumb.style.left = `${(at / duration) * 100}%`;
        thumb.style.width = `${(len / duration) * 100}%`;
      }
      draw();
    };
    // Zoomed in, the part shown starting a little before `t` when `t` is outside it.
    const follow = (t) => {
      if (!duration || view.b - view.a >= duration - 0.001 || (t >= view.a && t <= view.b)) return false;
      showView(t - shown() * 0.1, shown());
      return true;
    };
    // The playhead, the clock and the line sung now (outlined).
    const place = () => {
      const t = audio.currentTime || 0;
      // Played past the part shown: it moves along (not when moved away from the playhead by hand).
      const crossed = lastT >= view.a && lastT <= view.b && t > view.b;
      lastT = t;
      if (crossed && follow(t)) return;
      const inView = !!duration && t >= view.a && t <= view.b;
      playhead.hidden = !inView;
      if (inView) playhead.style.left = `${((t - view.a) / shown()) * canvas.clientWidth}px`;
      clock.textContent = `${this.fmt(t)} / ${this.fmt(duration)}`;
      let now = null;
      for (const m of marks) {
        if (m.t > t) break;
        if (t < m.end) now = m.row;
      }
      if (now !== lit) {
        if (lit) lit.classList.remove('lyrics-edit__row--now');
        if (now) now.classList.add('lyrics-edit__row--now');
        lit = now;
      }
    };
    const drawPlay = () => {
      playBtn.innerHTML = audio.paused ? Icons.play : Icons.pause;
      playBtn.title = audio.paused ? 'Play' : 'Pause';
    };
    // `show`: the part shown moves to the new place if it is outside it (-5 / +5).
    const seek = (t, show = false) => {
      if (!src) return;
      audio.currentTime = Math.max(0, Math.min(duration || audio.duration || 0, t));
      lastT = audio.currentTime;
      if (!(show && follow(lastT))) place();
    };
    const tick = () => {
      raf = 0;
      if (gone) return;
      place();
      if (!audio.paused) raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (!audio.paused) audio.pause();
    };

    AudioFocus.register('lyricsEdit', stop);
    playBtn.onclick = () => {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      audio.play().catch(() => {});
    };
    audio.addEventListener('play', () => {
      AudioFocus.claim('lyricsEdit');
      drawPlay();
      if (!raf) raf = requestAnimationFrame(tick);
    });
    audio.addEventListener('pause', drawPlay);
    audio.addEventListener('ended', drawPlay);
    audio.addEventListener('seeked', place);
    const onVolume = (v) => {
      audio.volume = v;
    };
    Player.onVolume(onVolume);

    // A click or drag on the waveform moves the song there.
    canvas.addEventListener('pointerdown', (e) => {
      if (!src || !duration) return;
      // Within the part shown (a drag past its edge stops there).
      const at = (ev) => seek(Math.max(view.a, Math.min(view.b, xToT(ev.clientX - canvas.getBoundingClientRect().left))));
      at(e);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // Not a pointer that can be held (gone already): the click is enough.
      }
      const up = () => {
        canvas.removeEventListener('pointermove', at);
        canvas.removeEventListener('pointerup', up);
        canvas.removeEventListener('pointercancel', up);
      };
      canvas.addEventListener('pointermove', at);
      canvas.addEventListener('pointerup', up);
      canvas.addEventListener('pointercancel', up);
    });
    // The wheel zooms at the pointer: the second under it stays under it.
    canvas.addEventListener('wheel', (e) => {
      if (!duration) return;
      e.preventDefault();
      const len = shown();
      const w = canvas.clientWidth || 1;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const by = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        showView(view.a + (by / w) * len, len);
        return;
      }
      const x = e.clientX - canvas.getBoundingClientRect().left;
      const t = xToT(x);
      const next = fitLen(len * Math.exp(e.deltaY * 0.0025));
      showView(t - (x / w) * next, next);
    }, { passive: false });
    canvas.addEventListener('dblclick', () => {
      if (duration) showView(0, duration);
    });
    // The scroll bar: the thumb dragged, or a click beside it centres the part shown there (and drags on).
    scrollbar.addEventListener('pointerdown', (e) => {
      if (!duration) return;
      e.preventDefault();
      const w = scrollbar.clientWidth || 1;
      const left = scrollbar.getBoundingClientRect().left;
      const len = shown();
      if (e.target !== thumb) showView(((e.clientX - left) / w) * duration - len / 2, len);
      const fromX = e.clientX;
      const fromA = view.a;
      try {
        scrollbar.setPointerCapture(e.pointerId);
      } catch {
        // A pointer that cannot be held: the click is enough.
      }
      const move = (ev) => showView(fromA + ((ev.clientX - fromX) / w) * duration, len);
      const up = () => {
        scrollbar.removeEventListener('pointermove', move);
        scrollbar.removeEventListener('pointerup', up);
        scrollbar.removeEventListener('pointercancel', up);
      };
      scrollbar.addEventListener('pointermove', move);
      scrollbar.addEventListener('pointerup', up);
      scrollbar.addEventListener('pointercancel', up);
    });
    const sized = new ResizeObserver(() => draw());
    sized.observe(canvas);

    const getPeaks = () => {
      if (!loadPeaks || !duration) {
        if (src) setStatus('');
        return;
      }
      setStatus('Drawing waveform...');
      Promise.resolve().then(loadPeaks).then((got) => {
        if (gone) return;
        peaks = got || null;
        setStatus(peaks ? '' : 'No waveform for this song, but it can still be played.');
        draw();
      }, () => {
        if (!gone) setStatus('Could not draw the waveform, but the song can still be played.');
      });
    };
    // The song's length: as given, else the audio's own.
    if (duration || !src) getPeaks();
    else {
      setStatus('Reading the song...');
      audio.addEventListener('loadedmetadata', () => {
        if (gone || duration || !Number.isFinite(audio.duration)) return;
        duration = audio.duration;
        getPeaks();
        showView(0, duration);
      }, { once: true });
    }
    drawPlay();
    showView(0, duration);

    return {
      el,
      mark(list) {
        marks = list;
        draw();
      },
      stop,
      destroy() {
        gone = true;
        stop();
        cancelAnimationFrame(raf);
        sized.disconnect();
        audio.removeAttribute('src');
        audio.load();
        Player._volumeListeners = (Player._volumeListeners || []).filter((fn) => fn !== onVolume);
        AudioFocus.register('lyricsEdit', () => {});
      },
    };
  },

  /**
   * The waveform (`peaks`: flat min,max pairs) across the canvas, each line's
   * stretch (marks, see _paint) in its colour over a faint band of it, music
   * and the time without lines grey. Without peaks: the bands and a line.
   * `view` ({ a, b } seconds): the part shown, its times in the corners when
   * that is not all of it.
   */
  _drawWave(canvas, peaks, duration, marks, view = { a: 0, b: duration }) {
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = window.devicePixelRatio || 1;
    const wantW = Math.round(cssW * dpr);
    const wantH = Math.round(cssH * dpr);
    if (canvas.width !== wantW || canvas.height !== wantH) {
      canvas.width = wantW;
      canvas.height = wantH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!duration) return;
    const GREY = '#8a8a94';
    const len = Math.max(0.001, view.b - view.a);
    const x = (t) => ((Math.min(Math.max(t, view.a), view.b) - view.a) / len) * cssW;
    for (const m of marks) {
      if (!m.rgb || m.end <= view.a || m.t >= view.b) continue;
      ctx.fillStyle = `rgba(${m.rgb}, 0.18)`;
      ctx.fillRect(x(m.t), 0, Math.max(1, x(m.end) - x(m.t)), cssH);
    }
    // The colour at second `t`: the last line begun by then, if it still lasts.
    const colourAt = (t) => {
      let rgb = null;
      for (const m of marks) {
        if (m.t > t) break;
        if (t < m.end) rgb = m.rgb;
      }
      return rgb ? `rgb(${rgb})` : GREY;
    };
    const mid = cssH / 2;
    const half = mid - 3;
    const buckets = peaks && peaks.length ? peaks.length / 2 : 0;
    const tAt = (px) => view.a + (px / cssW) * len;
    for (let px = 0; px < cssW; px += 1) {
      ctx.fillStyle = colourAt(tAt(px + 0.5));
      if (!buckets) {
        ctx.fillRect(px, mid - 0.5, 1, 1);
        continue;
      }
      // Every bucket this column covers, so no peak falls between two (zoomed
      // far in, one bucket spans several columns).
      const b0 = Math.min(buckets - 1, Math.floor((tAt(px) / duration) * buckets));
      const b1 = Math.min(buckets - 1, Math.max(b0, Math.ceil((tAt(px + 1) / duration) * buckets) - 1));
      let lo = 0;
      let hi = 0;
      for (let b = b0; b <= b1; b += 1) {
        if (peaks[b * 2] < lo) lo = peaks[b * 2];
        if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1];
      }
      const top = mid - Math.min(1, hi) * half;
      ctx.fillRect(px, top, 1, Math.max(1, (mid - Math.max(-1, lo) * half) - top));
    }
    if (len < duration - 0.001) {
      ctx.font = '11px sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.fillText(this.fmt(view.a), 5, 4);
      ctx.textAlign = 'right';
      ctx.fillText(this.fmt(view.b), cssW - 5, 4);
    }
  },

  /** The editor's rows as lines, or undefined (with the reason shown) when a time is wrong. */
  _read(grid, error) {
    const lines = [];
    let bad = '';
    for (const row of grid.querySelectorAll('.lyrics-edit__row')) {
      const [from, to] = row.querySelectorAll('.lyrics-edit__time');
      const text = row.querySelector('.lyrics-edit__text').value.trim();
      const t = this.parse(from.value);
      const end = this.parse(to.value);
      from.classList.toggle('input--bad', Number.isNaN(t));
      to.classList.toggle('input--bad', Number.isNaN(end) || (end !== null && t !== null && end <= t));
      if (Number.isNaN(t) || Number.isNaN(end)) bad = bad || 'A time cannot be read: write it as mm:ss:ms, e.g. 01:23:450.';
      else if (end !== null && t !== null && end <= t) bad = bad || 'A line ends before it starts: its "To" must come after its "From".';
      else if (end !== null && t === null && text) bad = bad || 'A line has a "To" but no "From".';
      lines.push({ t: Number.isNaN(t) ? null : t, end: Number.isNaN(end) ? null : end, text });
    }
    const worded = lines.filter((r) => r.text);
    if (!bad && worded.some((r) => r.t !== null) && worded.some((r) => r.t === null)) {
      bad = 'Give every line with words its "From" time, or leave every time empty.';
      for (const row of grid.querySelectorAll('.lyrics-edit__row')) {
        const [from] = row.querySelectorAll('.lyrics-edit__time');
        if (!from.value.trim() && row.querySelector('.lyrics-edit__text').value.trim()) from.classList.add('input--bad');
      }
    }
    if (bad) {
      error.textContent = bad;
      return undefined;
    }
    error.textContent = '';
    return lines;
  },
};
