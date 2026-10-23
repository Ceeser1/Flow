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

  /** Edit Lyrics: the lines of `data` in the editor. */
  edit({ title, data, duration = 0, onSave }) {
    return this._editor({
      title, rows: this.rows(data, duration), own: !!(data && data.own), onSave, heading: 'Edit Lyrics',
    });
  },

  /** Add Lyrics: the words pasted in first, then the editor. */
  add({ title, onSave }) {
    return this._editor({
      title, rows: [], own: false, onSave, heading: 'Add Lyrics',
    });
  },

  /**
   * The editor: a row per line, From - To and the words. `onSave(lines)`
   * (lines [{ t, end, text }], or null to take the own lyrics away) may
   * throw: the message is shown and the popup stays.
   */
  _editor({
    title, rows, own, onSave, heading,
  }) {
    const grid = h('div.lyrics-edit__rows');
    const error = h('div.form-error.lyrics-edit__error');
    const paste = h('textarea.input.lyrics-edit__paste', {
      placeholder: 'Paste the lyrics here, one line per row.', spellcheck: 'false', rows: '10',
    });
    const split = h('button.btn.btn--light-green', { type: 'button', onclick: () => fromPaste() }, 'Split into lines');
    const pasteBox = h('div.lyrics-edit__paste-box', paste, h('div.lyrics-edit__paste-foot', split));
    const head = h('div.lyrics-edit__head',
      h('span', 'From'), h('span'), h('span', 'To'), h('span', 'Lyrics'), h('span'));
    const addLine = h('button.btn.btn--small', {
      type: 'button',
      html: `${Icons.plus}<span>Add line</span>`,
      onclick: () => {
        const row = this._row({ t: null, end: null, text: '' }, grid, error);
        grid.appendChild(row);
        row.querySelector('.lyrics-edit__text').focus();
      },
    });
    const table = h('div.lyrics-edit__table', head, grid, h('div.lyrics-edit__foot', addLine));

    const showRows = (list) => {
      clear(grid);
      for (const r of list) grid.appendChild(this._row(r, grid, error));
      pasteBox.hidden = list.length > 0;
      table.hidden = list.length === 0;
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
      + 'Leave every time empty to keep the words without times. Enter in a line adds one below it.');
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
      body: [h('div.lyrics-show__song', title), hint, pasteBox, table, error],
      buttons,
      focus: rows.length ? '.lyrics-edit__time' : '.lyrics-edit__paste',
    });
  },

  /** One line's row: From - To, its words, and x to take it out. */
  _row(r, grid, error) {
    const box = (t, label) => h('input.input.lyrics-edit__time', {
      type: 'text', value: this.fmt(t), placeholder: 'mm:ss:ms', spellcheck: 'false', 'aria-label': label,
    });
    const from = box(r.t, 'From');
    const to = box(r.end, 'To');
    const text = h('input.input.lyrics-edit__text', {
      type: 'text', value: r.text, spellcheck: 'false', maxlength: '500', 'aria-label': 'Lyrics',
    });
    const row = h('div.lyrics-edit__row', from, h('span.lyrics-edit__dash', '-'), to, text);
    row.appendChild(iconButton('icon-btn.lyrics-edit__remove', Icons.x, 'Take this line out', () => {
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      if (next) next.querySelector('.lyrics-edit__text').focus();
    }));
    // A time typed in is shown as mm:ss:ms once left; one that cannot be read is marked.
    for (const b of [from, to]) {
      b.addEventListener('change', () => {
        const v = this.parse(b.value);
        b.classList.toggle('input--bad', Number.isNaN(v));
        if (!Number.isNaN(v)) b.value = this.fmt(v);
        error.textContent = '';
      });
    }
    text.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const added = this._row({ t: null, end: null, text: '' }, grid, error);
      row.after(added);
      added.querySelector('.lyrics-edit__time').focus();
    });
    return row;
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
