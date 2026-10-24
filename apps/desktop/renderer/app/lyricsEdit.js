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
//
// LRCLIB (4.0.1): Search LRCLIB picks lyrics from its search into the editor
// (_search), Publish to LRCLIB gives the lines there to everyone (_publish).

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
   * `song()`: its { title, artist, album, duration } now, for LRCLIB.
   */
  edit({
    title, data, duration = 0, onSave, player = null, song = null,
  }) {
    return this._editor({
      title, rows: this.rows(data, duration), own: !!(data && data.own), onSave, heading: 'Edit Lyrics', player, duration, song,
    });
  },

  /** Whether `data` has words (Edit Lyrics), else Add Lyrics. */
  hasWords(data) {
    return !!(data && data.found && String(data.plain || '').trim());
  },

  /**
   * In a few words: "Timed Lyrics from LRCLIB", "No Timed Lyrics written in
   * Flow", "No Lyrics" (Song Edit's Lyrics row).
   */
  summary(data) {
    if (!this.hasWords(data)) return 'No Lyrics';
    const kind = data.synced ? 'Timed Lyrics' : 'No Timed Lyrics';
    return `${kind} ${data.own ? 'written in Flow' : `from ${data.source || 'LRCLIB'}`}`;
  },

  /**
   * Edit Lyrics (Add Lyrics without words) for a song of the library, from
   * Song Details or Edit Song: the editor plays the song as the player would,
   * its waveform as Edit Song draws it. `saved()` once written (to fetch them
   * again).
   */
  openFor(song, data, saved) {
    const title = this.heading(song);
    const onSave = async (lines) => {
      await window.flow.setLyrics(song.id, lines);
      Lyrics.forget(song.id);
      toast(lines ? `Lyrics of "${title}" saved` : `Your lyrics of "${title}" removed`, 'success');
      saved();
    };
    const player = {
      src: Store.audioSrc(song),
      duration: song.duration,
      peaks: async () => {
        for (const job of songPeakJobs(song, song.duration)) {
          try {
            return await job();
          } catch {
            // The next way, if there is one.
          }
        }
        return null;
      },
    };
    const meta = () => ({
      title: song.title, artist: song.artist, album: song.album || '', duration: song.duration,
    });
    if (this.hasWords(data)) {
      return this.edit({
        title, data, duration: song.duration, onSave, player, song: meta,
      });
    }
    return this.add({
      title, onSave, player, song: meta,
    });
  },

  /** Add Lyrics: the words pasted in first, then the editor. */
  add({
    title, onSave, player = null, song = null,
  }) {
    return this._editor({
      title, rows: [], own: false, onSave, heading: 'Add Lyrics', player, song,
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
    title, rows, own, onSave, heading, player, duration = 0, song = null,
  }) {
    const grid = h('div.lyrics-edit__rows');
    const error = h('div.form-error.lyrics-edit__error');
    // Insert Time: the place played into the first empty To (and so the next line's From).
    const insertTime = (t) => {
      const to = [...grid.querySelectorAll('.lyrics-edit__row')]
        .map((row) => row.querySelectorAll('.lyrics-edit__time')[1])
        .find((b) => !b.value.trim());
      if (!to) {
        error.textContent = grid.firstElementChild ? 'Every line has its To already.' : 'Split the lyrics into lines first.';
        return;
      }
      error.textContent = '';
      to.value = this.fmt(t);
      to.classList.remove('input--bad');
      to.dispatchEvent(new Event('input', { bubbles: true }));
      to.closest('.lyrics-edit__row').scrollIntoView({ block: 'nearest' });
    };
    const deck = player ? this._player({ ...player, insertTime }) : null;
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
        // Starting where the last line ends.
        const last = grid.lastElementChild;
        const t = last ? this.parse(last.querySelectorAll('.lyrics-edit__time')[1].value) : null;
        const row = this._row({ t: Number.isFinite(t) ? t : null, end: null, text: '' }, ed);
        grid.appendChild(row);
        ed.changed();
        row.querySelector('.lyrics-edit__text').focus();
      },
    });
    // Every line earlier or later by the time given (lyrics that start too soon or too late).
    const by = h('input.input.lyrics-edit__shift-by', {
      type: 'text', placeholder: '00:000', spellcheck: 'false', 'aria-label': 'Time to add or subtract (ss:ms)',
    });
    const shiftBtn = (label, sign) => h('button.btn.btn--small', {
      type: 'button',
      onclick: () => {
        const err = this._shift(grid, sign * this.parse(by.value), (deck && deck.duration()) || duration);
        error.textContent = err;
        by.classList.toggle('input--bad', !!err && !(this.parse(by.value) > 0));
        if (!err) ed.changed();
      },
    }, label);
    const shift = h('div.lyrics-edit__shift',
      h('span', 'Add/Subtract time to all lines:'), by, shiftBtn('Add', 1), shiftBtn('Sub', -1));
    const table = h('div.lyrics-edit__table', head, grid, h('div.lyrics-edit__foot', addLine, shift));

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
    const length = () => (deck && deck.duration()) || duration || (song ? Number(song().duration) || 0 : 0);

    // Lyrics picked from LRCLIB's search take the place of the lines here.
    const search = window.flow.searchLyrics ? h('button.btn.btn--small', {
      type: 'button',
      html: `${Icons.search}<span>Search LRCLIB</span>`,
      onclick: () => this._search({
        song: song ? song() : null,
        length: length(),
        onPick: async (data) => {
          const worded = [...grid.querySelectorAll('.lyrics-edit__text')].some((b) => b.value.trim());
          if (!table.hidden && worded) {
            const ok = await confirmDialog({
              title: 'Replace the lines?',
              message: 'The lines in the editor make way for the lyrics picked. They are kept once you save.',
              confirmLabel: 'Replace',
            });
            if (!ok) return false;
          }
          error.textContent = '';
          showRows(this.rows(data, length()));
          return true;
        },
      }),
    }) : null;

    const hint = h('div.hint-label.lyrics-edit__hint',
      'Times as mm:ss:ms (minutes, seconds, milliseconds); drag one left or right to change it. '
      + 'A line\'s To is the next line\'s From. Insert Time puts the place played into the first empty To. '
      + 'Saving fills an empty time from the line beside it, and the last To with the song\'s end. '
      + 'Leave every time empty to keep the words without times. + or Enter adds a line after one, '
      + 'a line without words is music (♪).');
    const buttons = [];
    if (window.flow.publishLyrics && song) {
      buttons.push({
        label: 'Publish to LRCLIB',
        align: 'left',
        onClick: () => {
          if (table.hidden) {
            error.textContent = 'Split the lyrics into lines first.';
            return false;
          }
          this._fill(grid, length());
          ed.changed();
          const lines = this._read(grid, error);
          if (lines === undefined) return false;
          if (!lines.some((r) => r.text)) {
            error.textContent = 'Write the lyrics first.';
            return false;
          }
          this._publish({ song: song(), length: length(), lines });
          return false;
        },
      });
    }
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
        this._fill(grid, (deck && deck.duration()) || duration);
        ed.changed();
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
      body: [h('div.lyrics-edit__top', h('div.lyrics-show__song', title), search), hint, pasteBox, table, error, deck && deck.el],
      buttons,
      focus: rows.length ? '.lyrics-edit__time' : '.lyrics-edit__paste',
      onClose: () => {
        if (deck) deck.destroy();
      },
    });
  },

  /** "3:59" for 239 s. */
  _length(sec) {
    const s = Math.round(Number(sec) || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },

  /**
   * Search LRCLIB: its records for the song (by its names, then by the words
   * in the box), each with its album, length and whether it has times; one
   * picked shows its lines, and "Use these lyrics" hands it to `onPick(data)`
   * ({ found, synced, plain }), which resolves false to stay.
   */
  _search({ song, length, onPick }) {
    const words = song ? [song.artist, song.title].filter(Boolean).join(' ') : '';
    const box = h('input.input.lyrics-search__q', {
      type: 'text', value: words, placeholder: 'Artist and title', spellcheck: 'false', 'aria-label': 'Search LRCLIB',
    });
    const go = h('button.btn.btn--small', { type: 'button' }, 'Search');
    const list = h('div.lyrics-search__list');
    const empty = () => h('div.lyrics-search__empty', 'Pick one of the results to see its lyrics.');
    const preview = h('div.lyrics-search__preview', empty());
    const note = h('div.lyrics-search__note');
    let picked = null;
    let use = null;
    let seq = 0;
    const show = (r, row) => {
      picked = r;
      for (const n of list.children) n.classList.toggle('lyrics-search__item--on', n === row);
      const lines = r.synced
        ? r.synced.map((l) => h('div.lyrics-show__row', h('span.lyrics-show__time', this.fmt(l.t)),
          h('span.lyrics-show__text' + (l.text ? '' : '.lyrics-show__text--pause'), l.text || '♪')))
        : String(r.plain).split(/\r?\n/).map((text) => h('div.lyrics-show__row', h('span.lyrics-show__text', text)));
      clear(preview).append(
        r.synced ? '' : h('div.lyrics-show__note', 'These lyrics have no times.'),
        h('div.lyrics-show__lines', ...lines),
      );
      if (use) use.disabled = false;
    };
    const run = async (params) => {
      const mine = ++seq;
      picked = null;
      if (use) use.disabled = true;
      note.textContent = '';
      clear(list).append(h('div.lyrics-search__empty', this.spinner(), 'Searching LRCLIB...'));
      clear(preview).append(empty());
      let found;
      try {
        found = await window.flow.searchLyrics(params);
      } catch (err) {
        if (mine === seq) clear(list).append(h('div.lyrics-search__empty.form-error', (err && err.message) || 'LRCLIB could not be asked.'));
        return;
      }
      if (mine !== seq) return;
      clear(list);
      if (!found.length) {
        list.append(h('div.lyrics-search__empty', 'Nothing found. Try other words.'));
        return;
      }
      note.textContent = `${found.length} found${length ? `; this song is ${this._length(length)} long` : ''}`;
      for (const r of found) {
        const gap = length && r.duration ? Math.round(r.duration - length) : 0;
        const row = h('button.lyrics-search__item', { type: 'button' },
          h('div.lyrics-search__name', [r.artist, r.title].filter(Boolean).join(' - ')),
          h('div.lyrics-search__meta',
            h('span', [r.album, r.duration ? `${this._length(r.duration)}${gap ? ` (${gap > 0 ? '+' : ''}${gap} s)` : ''}` : '']
              .filter(Boolean).join(' · ')),
            h(`span.lyrics-search__kind${r.synced ? '.lyrics-search__kind--timed' : ''}`, r.synced ? 'Timed' : 'Words only')));
        row.addEventListener('click', () => show(r, row));
        row.addEventListener('dblclick', () => use && use.click());
        list.appendChild(row);
      }
    };
    go.addEventListener('click', () => run({ q: box.value, duration: length }));
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run({ q: box.value, duration: length });
    });
    const modal = Modal.open({
      title: 'Search LRCLIB',
      className: 'modal--lyrics-search',
      body: [
        h('div.lyrics-search__bar', box, go),
        note,
        h('div.lyrics-search__panes', list, preview),
      ],
      buttons: [{ label: 'Cancel' }, {
        label: 'Use these lyrics',
        kind: 'primary',
        onClick: async () => {
          if (!picked) return false;
          return (await onPick({ found: true, synced: picked.synced, plain: picked.plain })) !== false;
        },
      }],
      focus: '.lyrics-search__q',
    });
    use = [...modal.el.querySelectorAll('.modal__footer .btn')].pop();
    use.disabled = true;
    run(song && song.title ? {
      title: song.title, artist: song.artist, duration: length,
    } : { q: words, duration: length });
  },

  /**
   * Publish to LRCLIB: the lines (as Save takes them) for everyone, under
   * the names given here (the song's to start with) and its length.
   */
  _publish({ song, length, lines }) {
    const field = (label, value) => {
      const input = h('input.input', { type: 'text', value: value || '', spellcheck: 'false' });
      return { input, row: h('label.lyrics-publish__field', h('span', label), input) };
    };
    const title = field('Title', song.title);
    const artist = field('Artist', song.artist);
    const album = field('Album', song.album);
    const timed = lines.some((r) => r.t !== null);
    const sung = lines.filter((r) => r.text).length;
    const status = h('div.lyrics-publish__status');
    const error = h('div.form-error');
    const modal = Modal.open({
      title: 'Publish to LRCLIB',
      className: 'modal--lyrics-publish',
      body: [
        h('p.lyrics-publish__text', 'Your lyrics go to LRCLIB (lrclib.net) for everyone: Flow, other music players and their users find '
          + 'them by the song\'s names and length. LRCLIB keeps them for good; they cannot be taken back from here.'),
        title.row, artist.row, album.row,
        h('div.lyrics-publish__field', h('span', 'Length'), h('span.lyrics-publish__value', this._length(length))),
        h('div.lyrics-publish__field', h('span', 'Lyrics'),
          h('span.lyrics-publish__value', `${Util.plural(sung, 'line')} ${timed ? 'with times' : 'without times'}`)),
        status,
        error,
      ],
      buttons: [{ label: 'Cancel' }, {
        label: 'Publish',
        kind: 'primary',
        onClick: async () => {
          error.textContent = '';
          clear(status).append(this.spinner(), 'Solving LRCLIB\'s challenge and sending the lyrics. This can take a minute...');
          try {
            await window.flow.publishLyrics({
              title: title.input.value, artist: artist.input.value, album: album.input.value, duration: length, lines,
            });
          } catch (err) {
            clear(status);
            error.textContent = (err && err.message) || 'The lyrics could not be published.';
            return false;
          }
          toast(`Lyrics of "${[artist.input.value.trim(), title.input.value.trim()].filter(Boolean).join(' - ')}" published to LRCLIB`, 'success');
          return true;
        },
      }],
    });
    // No album yet: LRCLIB needs one, the box for it first.
    if (!String(song.album || '').trim()) setTimeout(() => album.input.focus(), 0);
    return modal;
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
        // A From without a To goes on to the next line when that has no From.
        const after = row.nextElementSibling && row.nextElementSibling.querySelector('.lyrics-edit__time');
        if (after && !after.value.trim() && !to.value.trim() && Number.isFinite(this.parse(from.value))) {
          after.value = this.fmt(this.parse(from.value));
          after.classList.remove('input--bad');
        }
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
    // A line's To is the next line's From and the other way round: one typed
    // (or inserted) is copied over as it is read.
    const link = (b, other) => b.addEventListener('input', () => {
      const v = this.parse(b.value);
      const box = other();
      if (!box || !Number.isFinite(v)) return;
      box.value = this.fmt(v);
      box.classList.remove('input--bad');
    });
    const prevTo = () => row.previousElementSibling && row.previousElementSibling.querySelectorAll('.lyrics-edit__time')[1];
    link(from, prevTo);
    link(to, () => row.nextElementSibling && row.nextElementSibling.querySelector('.lyrics-edit__time'));
    // Dragged while empty: a From from the line above's To, a To from its own From.
    const known = (b) => (b && Number.isFinite(this.parse(b.value)) ? this.parse(b.value) : 0);
    this._scrub(from, () => known(prevTo()));
    this._scrub(to, () => known(from));
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addAfter().querySelector('.lyrics-edit__time').focus();
    });
    return row;
  },

  /**
   * A time box dragged left or right: its time less or more (10 ms a pixel,
   * Shift 1 ms), the box linked to it (see _row) moving with it. A click
   * without a drag edits it, all of it selected; while it is being edited the
   * mouse selects its text as usual. `start()`: the time to drag from when
   * it is empty.
   */
  _scrub(b, start) {
    b.title = 'Click to type, drag left or right to change (Shift: finer)';
    // Its selected text is not dragged away (a drag while typing selects).
    b.addEventListener('dragstart', (e) => e.preventDefault());
    b.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || document.activeElement === b) return;
      e.preventDefault();
      const v = this.parse(b.value);
      let t = Number.isFinite(v) ? v : start();
      let x = e.clientX;
      let dragged = false;
      const move = (ev) => {
        if (!dragged && Math.abs(ev.clientX - e.clientX) < 4) return;
        dragged = true;
        document.body.classList.add('lyrics-edit--scrubbing');
        t = Math.max(0, t + (ev.clientX - x) * (ev.shiftKey ? 0.001 : 0.01));
        x = ev.clientX;
        b.value = this.fmt(t);
        b.classList.remove('input--bad');
        b.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        document.body.classList.remove('lyrics-edit--scrubbing');
        if (dragged) return;
        b.focus();
        b.select();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  },

  /**
   * Every line's From and To moved by `by` seconds (less than 0: earlier).
   * The opening line of music keeps starting at 0, and a To past the song's
   * end (`duration`, when known) stops there. Returns the reason nothing was
   * moved ('' when they were): no time given, the last line would start
   * after the song's end, or the first line would end before 0.
   */
  _shift(grid, by, duration) {
    if (!Number.isFinite(by) || by === 0) return 'Write the time to add or subtract as ss:ms, e.g. 01:500.';
    const rows = [...grid.querySelectorAll('.lyrics-edit__row')];
    const times = rows.flatMap((row) => [...row.querySelectorAll('.lyrics-edit__time')].map((b, k) => ({
      b, k, t: this.parse(b.value), row,
    }))).filter((x) => Number.isFinite(x.t));
    const froms = times.filter((x) => x.k === 0).map((x) => x.t);
    const tos = times.filter((x) => x.k === 1).map((x) => x.t);
    if (!froms.length && !tos.length) return 'The lines have no times to move.';
    // ss:ms as typed (mm:ss:ms from a minute on).
    const amount = Math.abs(by) < 60 ? this.fmt(Math.abs(by)).slice(3) : this.fmt(Math.abs(by));
    if (by > 0 && duration && froms.length && Math.max(...froms) + by > duration) {
      return `Adding ${amount} would start the last line after the end of the song (${this.fmt(duration)}).`;
    }
    if (by < 0 && tos.length && Math.min(...tos) + by < 0) {
      return `Subtracting ${amount} would end the first line before the start of the song.`;
    }
    const intro = rows[0] && !rows[0].querySelector('.lyrics-edit__text').value.trim() ? rows[0] : null;
    for (const x of times) {
      if (x.k === 0 && x.row === intro && x.t === 0) continue;
      // A To at the song's end stays there (the closing music).
      if (x.k === 1 && duration && Math.abs(x.t - duration) < 0.001) continue;
      let t = Math.max(0, x.t + by);
      if (x.k === 1 && duration) t = Math.min(duration, t);
      x.b.value = this.fmt(t);
      x.b.classList.remove('input--bad');
    }
    // Words from the very start now: no opening music (see _withIntro).
    if (intro && rows.length > 1 && this.parse(intro.querySelectorAll('.lyrics-edit__time')[1].value) === 0) intro.remove();
    return '';
  },

  /**
   * Before saving: an empty From takes the To of the line above, an empty To
   * the From of the line below, and the last line's To the song's end
   * (`duration`, when known and after its From).
   */
  _fill(grid, duration) {
    const boxes = [...grid.querySelectorAll('.lyrics-edit__row')].map((row) => row.querySelectorAll('.lyrics-edit__time'));
    const time = (b) => this.parse(b.value);
    const set = (b, t) => {
      b.value = this.fmt(t);
      b.classList.remove('input--bad');
    };
    boxes.forEach(([from], i) => {
      if (i && !from.value.trim() && Number.isFinite(time(boxes[i - 1][1]))) set(from, time(boxes[i - 1][1]));
    });
    boxes.forEach(([, to], i) => {
      if (boxes[i + 1] && !to.value.trim() && Number.isFinite(time(boxes[i + 1][0]))) set(to, time(boxes[i + 1][0]));
    });
    const last = boxes[boxes.length - 1];
    if (last && !last[1].value.trim() && Number.isFinite(time(last[0])) && duration > time(last[0])) set(last[1], duration);
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
   * `peaks()`: the waveform's peaks (or a promise of them, null for none);
   * `insertTime(t)`: Insert Time before the place, given the place played.
   * Playback Speed after it: 20% to 120% (pitch kept).
   * Returns { el, mark(marks), stop(), destroy() }.
   */
  _player({
    src, duration: known = 0, peaks: loadPeaks = null, insertTime = null,
  }) {
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
    const insert = insertTime && h('button.btn.btn--small.lyrics-edit__insert', {
      type: 'button',
      title: 'The place played into the first empty To',
      onclick: () => insertTime(audio.currentTime || 0),
    }, 'Insert Time');
    const clock = h('span.lyrics-edit__clock');
    const speed = h('input.volume-slider.lyrics-edit__speed', {
      type: 'range', min: 20, max: 120, step: 20, value: 100, 'aria-label': 'Playback speed',
    });
    const speedValue = h('span.lyrics-edit__speed-value');
    const zoomNote = h('span.lyrics-edit__zoom');
    // Zoomed in: a scroll bar under the waveform, its thumb the part shown.
    const thumb = h('div.lyrics-edit__scroll-thumb');
    const scrollbar = h('div.lyrics-edit__scroll', { hidden: true }, thumb);
    const el = h('div.lyrics-edit__player',
      h('div.lyrics-edit__wave-wrap', canvas, playhead, status),
      scrollbar,
      h('div.lyrics-edit__transport', skip(-5), playBtn, skip(5), insert, clock,
        h('label.lyrics-edit__speed-box', h('span', 'Playback Speed:'), speed, speedValue), zoomNote));

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
    speed.disabled = !src;
    const drawSpeed = () => {
      const v = Number(speed.value);
      speedValue.textContent = `${v}%`;
      speed.style.setProperty('--fill', `${((v - 20) / 100) * 100}%`);
      audio.defaultPlaybackRate = v / 100;
      audio.playbackRate = v / 100;
    };
    speed.addEventListener('input', drawSpeed);
    drawSpeed();
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
      // Short (the transport row is full); how to move and go back in its tooltip.
      zoomNote.textContent = zoomed ? `Zoom ${(duration / len).toFixed(1)}x` : 'Use mouse wheel to zoom';
      zoomNote.title = zoomed ? 'Shift + wheel or the bar below moves along, a double-click shows the whole song' : '';
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
      /** The song's length as known now (the audio's own once read). */
      duration: () => duration,
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
