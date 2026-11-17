'use strict';

// The Internet Radio page (5.1; the player side is radio.js). From the top:
// the address box with Add Radio (the address is checked first, the station
// becomes a favourite at once), this profile's Favourite Radios (10 rows at
// most, then the box scrolls), then "Other Internet Radios": the stations of
// radio-browser.info, the most played first, 100 at a time, narrowed by the
// search (names), Country, Genre and Quality (the pickers can be typed into to
// narrow their list; the last ones picked are kept). A favourite is not repeated in
// the second list.
//
// Each row: Play / Pause before its picture and name, its country, genres and
// quality, and the star at its right.

// The Quality filter's steps in kbit/s, then "No Info" (-1): only stations without one (core radio.js RADIO_QUALITIES).
const RADIO_QUALITIES = [320, 256, 192, 128, 64, -1];

const RadioPage = {
  others: [],
  page: 0,
  more: false,
  loading: false,
  error: '',
  // Each list's sort (a column's name clicked); none: favourites newest first, the others most played first.
  sort: { key: null, dir: null },
  othersSort: { key: null, dir: null },
  _seq: 0,
  _started: false,
  _countries: [],
  _genres: [],
  _playButtons: new Map(),
  _searchTimer: null,

  init() {
    if (!Store.can('radio')) return;
    $('radioAddBtn').onclick = () => this.add();
    $('radioUrl').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.add();
    });
    $('radioUrl').addEventListener('input', () => {
      $('radioAddError').textContent = '';
    });
    $('radioSearch').addEventListener('input', () => {
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => this.search(), 400);
    });
    $('radioMore').onclick = () => this.search({ next: true });
    $('radioSearch').previousElementSibling.innerHTML = Icons.search;
    this.country = combo($('radioCountry'), {
      label: T('radio.filter.country'),
      all: T('radio.filter.country.all'),
      options: () => this._countries,
      value: () => Store.settings.radioCountry || '',
      onPick: (v) => {
        Store.saveSettings({ radioCountry: v });
        this.search();
      },
    });
    this.genre = combo($('radioGenre'), {
      label: T('common.genre'),
      all: T('radio.filter.genre.all'),
      options: () => this._genres,
      value: () => Store.settings.radioGenre || '',
      onPick: (v) => {
        Store.saveSettings({ radioGenre: v });
        this.search();
      },
    });
    // At least this many kbit/s (the directory's bitrateMin), the best first.
    this.quality = combo($('radioQuality'), {
      label: T('radio.column.quality'),
      all: T('radio.filter.quality.all'),
      options: () => RADIO_QUALITIES.map((q) => ({ value: String(q), label: q < 0 ? T('radio.filter.quality.noInfo') : T('radio.filter.quality.atLeast', { rate: q }) })),
      value: () => (Store.settings.radioQuality ? String(Store.settings.radioQuality) : ''),
      onPick: (v) => {
        Store.saveSettings({ radioQuality: Number(v) || 0 });
        this.search();
      },
    });
    Radio.onChange(() => {
      if (Nav.page === 'radio') this._drawPlaying();
    });
    Store.onSettings((patch) => {
      if ('radioFavs' in patch && Nav.page === 'radio') this.render();
    });
    // Another profile: its own favourites.
    Store.onServer(() => {
      if (Nav.page === 'radio') this.render();
    });
  },

  show() {
    if (!this._started) {
      this._started = true;
      this._loadFilters();
      this.search();
    }
    this.render();
  },

  // ---- Add Radio ----

  async add() {
    const raw = $('radioUrl').value.trim();
    const error = $('radioAddError');
    error.textContent = '';
    if (!raw) {
      error.textContent = T('radio.add.empty');
      return;
    }
    const btn = $('radioAddBtn');
    btn.disabled = true;
    btn.textContent = T('radio.add.checking');
    try {
      const found = await window.flow.radio.check(raw);
      let host = '';
      try {
        host = new URL(found.url).hostname;
      } catch {
        host = found.url;
      }
      const known = Radio.favourites().find((f) => f.url === found.url);
      if (known) {
        toast(T('radio.add.exists', { station: known.name }), 'info');
      } else {
        const station = { id: `url:${found.url}`, name: found.name || host, url: found.url, own: true, favicon: '', country: '', countryCode: '', tags: '', codec: '', bitrate: 0 };
        Radio.setFavourite(station, true);
        toast(T(found.checked ? 'radio.add.done' : 'radio.add.unchecked', { station: station.name }), found.checked ? 'success' : 'info');
      }
      $('radioUrl').value = '';
    } catch (err) {
      error.textContent = (err && err.message) || String(err);
    } finally {
      btn.disabled = false;
      btn.textContent = T('radio.add.button');
    }
  },

  // ---- the directory ----

  async _loadFilters() {
    const names = this._regionNames();
    try {
      const list = await window.flow.radio.countries();
      this._countries = list
        .map((c) => ({ value: c.code, label: names(c.code) || c.name, hint: I18n.num(c.stations) }))
        .sort((a, b) => a.label.localeCompare(b.label, I18n.lang));
    } catch {
      this._countries = [];
    }
    try {
      const list = await window.flow.radio.genres();
      this._genres = list
        .map((g) => ({ value: g.name, label: g.name.replace(/(^|[\s/-])\p{L}/gu, (m) => m.toUpperCase()), hint: I18n.num(g.stations) }))
        .sort((a, b) => a.label.localeCompare(b.label, I18n.lang));
    } catch {
      this._genres = [];
    }
    this.country.draw();
    this.genre.draw();
  },

  /** A country's name in Flow's language, from its code ('' when the browser has none). */
  _regionNames() {
    let names = null;
    try {
      names = new Intl.DisplayNames([I18n.lang], { type: 'region' });
    } catch {
      return () => '';
    }
    return (code) => {
      try {
        return names.of(code) || '';
      } catch {
        return '';
      }
    };
  },

  countryName(st) {
    if (!this._names) this._names = this._regionNames();
    return (st.countryCode && this._names(st.countryCode)) || st.country || '';
  },

  /** The stations for the search and filters: from the first page, or (`next`) the page after. */
  async search({ next = false } = {}) {
    const seq = ++this._seq;
    const page = next ? this.page + 1 : 0;
    this.loading = true;
    this.error = '';
    if (!next) {
      this.others = [];
      this.more = false;
    }
    this._drawOthers();
    try {
      const r = await window.flow.radio.search({
        name: $('radioSearch').value.trim(),
        country: Store.settings.radioCountry || '',
        genre: Store.settings.radioGenre || '',
        quality: Store.settings.radioQuality || 0,
        page,
      });
      if (seq !== this._seq) return;
      const seen = new Set(this.others.map((s) => s.id));
      this.others = [...this.others, ...r.stations.filter((s) => !seen.has(s.id))];
      this.page = page;
      this.more = r.more;
    } catch (err) {
      if (seq !== this._seq) return;
      this.error = (err && err.message) || String(err);
    }
    this.loading = false;
    this._drawOthers();
  },

  // ---- drawing ----

  render() {
    this._drawFavourites();
    this._drawOthers();
  },

  _value(st, key) {
    if (key === 'name') return st.name;
    if (key === 'country') return st.own ? '' : this.countryName(st);
    if (key === 'genre') return this._genreText(st);
    // No bitrate known: last either way.
    if (key === 'quality') return st.bitrate || '';
    return '';
  },

  /** A click on a column's name: A-Z, Z-A, the list's own order; the quality high-low first. */
  _nextSort(sort, key) {
    return Util.cycleSort(sort, key, key === 'quality' ? 'desc' : 'asc');
  },

  _genreText(st) {
    return String(st.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3).join(', ');
  },

  _quality(st) {
    return [st.codec, st.bitrate ? T('radio.kbits', { rate: st.bitrate }) : ''].filter(Boolean).join(' · ');
  },

  _drawFavourites() {
    const favs = Radio.favourites();
    $('radioFavCount').textContent = T('radio.count', { count: favs.length });
    $('radioFavEmpty').hidden = favs.length > 0;
    $('radioFavBox').hidden = !favs.length;
    const rows = Util.sortRows(favs, this.sort, (st, k) => this._value(st, k));
    this._playButtons.forEach((btn, key) => {
      if (key.startsWith('f:')) this._playButtons.delete(key);
    });
    renderTable($('radioFavTable'), {
      rows,
      sort: this.sort,
      onSort: (key) => {
        this.sort = this._nextSort(this.sort, key);
        this._drawFavourites();
      },
      rowKey: (st) => st.id,
      rowClass: (st) => (Radio.isCurrent(st) ? 'row--current' : ''),
      onRowDblClick: (st) => Radio.toggleStation(st, rows),
      columns: this._columns('f', () => rows),
    });
    limitRows($('radioFavBox'), 'tbody tr', 10);
  },

  _drawOthers() {
    const favs = Radio.favourites();
    const favIds = new Set(favs.map((f) => f.id));
    const favUrls = new Set(favs.map((f) => f.url));
    const shown = this.others.filter((s) => !favIds.has(s.id) && !favUrls.has(s.url));
    // The stations loaded so far (the most played first), sorted here; more loaded go in sorted too.
    const rows = Util.sortRows(shown, this.othersSort, (st, k) => this._value(st, k));
    this._playButtons.forEach((btn, key) => {
      if (key.startsWith('o:')) this._playButtons.delete(key);
    });
    renderTable($('radioOtherTable'), {
      rows,
      sort: this.othersSort,
      onSort: (key) => {
        this.othersSort = this._nextSort(this.othersSort, key);
        this._drawOthers();
      },
      rowKey: (st) => st.id,
      rowClass: (st) => (Radio.isCurrent(st) ? 'row--current' : ''),
      onRowDblClick: (st) => Radio.toggleStation(st, rows),
      columns: this._columns('o', () => rows),
    });
    $('radioOtherTable').hidden = !rows.length;
    const note = $('radioOtherNote');
    clear(note);
    if (this.error) {
      note.append(h('p', this.error), h('button.btn.btn--small', { type: 'button', onclick: () => this.search() }, T('radio.others.retry')));
    } else if (this.loading) {
      note.append(h('p', T('radio.others.loading')));
    } else if (!rows.length) {
      note.append(h('p', T('radio.others.none')));
    }
    note.hidden = !note.firstChild;
    $('radioMore').hidden = this.loading || !!this.error || !this.more;
  },

  /** The columns of both lists; `tag` keeps their Play buttons apart. */
  _columns(tag, rows) {
    const sortable = true;
    return [
      {
        key: 'play',
        label: '',
        cls: 'col-radio-play',
        sortable: false,
        render: (st) => {
          const playing = Radio.isCurrent(st) && Radio.playing;
          const btn = iconButton('act.act--green', playing ? Icons.pause : Icons.play, playing ? T('common.pause') : T('common.play'),
            () => Radio.toggleStation(st, rows()));
          btn._playing = playing;
          this._playButtons.set(`${tag}:${st.id}`, btn);
          return btn;
        },
      },
      {
        key: 'name',
        label: T('radio.column.station'),
        cls: 'col-name',
        sortable,
        render: (st) => h('button.link-cell.radio-name', {
          type: 'button',
          title: st.homepage ? `${st.name}\n${st.homepage}` : `${st.name}\n${st.url}`,
          onclick: () => Radio.toggleStation(st, rows()),
        }, Radio.picture(st), h('span.link-cell__name', st.name)),
      },
      {
        key: 'country',
        label: T('radio.filter.country'),
        cls: 'col-radio-country',
        sortable,
        render: (st) => h('span.muted-text', st.own ? T('radio.own') : this.countryName(st)),
      },
      { key: 'genre', label: T('common.genre'), cls: 'col-radio-genre', sortable, render: (st) => h('span.muted-text', this._genreText(st)) },
      { key: 'quality', label: T('radio.column.quality'), cls: 'col-radio-quality', sortable, render: (st) => h('span.muted-text', this._quality(st)) },
      {
        key: 'star',
        label: '',
        cls: 'col-radio-star',
        sortable: false,
        render: (st) => {
          const on = Radio.isFavourite(st);
          return iconButton(on ? 'act.act--fav.act--fav-on' : 'act.act--fav', on ? Icons.starFilled : Icons.star,
            on ? T('radio.favourite.remove') : T('radio.favourite.add'), () => Radio.toggleFavourite(st));
        },
      },
    ];
  },

  /** Only what changes when a station starts or stops: the Play buttons and the row lit. */
  _drawPlaying() {
    for (const tr of document.querySelectorAll('#radioFavTable tbody tr, #radioOtherTable tbody tr')) {
      tr.classList.toggle('row--current', !!Radio.station && tr.dataset.id === Radio.station.id);
    }
    for (const [key, btn] of this._playButtons) {
      const id = key.slice(2);
      const playing = !!Radio.station && Radio.station.id === id && Radio.playing;
      if (btn._playing === playing) continue;
      btn._playing = playing;
      btn.innerHTML = playing ? Icons.pause : Icons.play;
      btn.title = playing ? T('common.pause') : T('common.play');
      btn.setAttribute('aria-label', btn.title);
    }
  },
};

/**
 * A picker that can be typed into (Internet Radio's Country and Genre): the
 * box shows what is picked ("All ..." when nothing is); typing narrows the
 * list under it (names starting with it first), the arrows and Enter pick, Escape
 * leaves it as it was, X goes back to all. `options()`: [{ value, label, hint }].
 */
function combo(box, { label, all, options, value, onPick }) {
  const input = h('input.input.combo__input', { type: 'text', autocomplete: 'off', 'aria-label': label, placeholder: all });
  input.spellcheck = false;
  const clearBtn = h('button.combo__clear', { type: 'button', title: T('radio.filter.clear'), 'aria-label': T('radio.filter.clear'), html: Icons.x });
  const list = h('div.combo__list', { role: 'listbox', hidden: true });
  box.replaceChildren(h('span.combo__label', label), h('span.combo__field', input, clearBtn), list);
  let shown = [];
  let active = -1;

  const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const labelOf = (v) => {
    const o = options().find((x) => x.value === v);
    return o ? o.label : v;
  };
  const draw = () => {
    const v = value();
    input.value = v ? labelOf(v) : '';
    clearBtn.hidden = !v;
    box.classList.toggle('combo--set', !!v);
  };
  const fill = (typed) => {
    const q = fold(typed.trim());
    const opts = options();
    shown = q
      ? [...opts.filter((o) => fold(o.label).startsWith(q)), ...opts.filter((o) => !fold(o.label).startsWith(q) && fold(o.label).includes(q))]
      : [{ value: '', label: all, hint: '' }, ...opts];
    active = q && shown.length ? 0 : -1;
    clear(list);
    if (!shown.length) list.appendChild(h('div.combo__none', T('radio.filter.none')));
    shown.forEach((o, i) => {
      list.appendChild(h('div.combo__opt' + (i === active ? '.combo__opt--active' : '') + (o.value === value() ? '.combo__opt--on' : ''), {
        role: 'option',
        dataset: { i: String(i) },
        onmousedown: (e) => {
          e.preventDefault();
          pick(o.value);
        },
      }, h('span.combo__opt-name', o.label), o.hint ? h('span.combo__opt-hint', o.hint) : null));
    });
    list.hidden = false;
  };
  const close = () => {
    list.hidden = true;
    draw();
  };
  const pick = (v) => {
    const changed = v !== value();
    list.hidden = true;
    input.blur();
    if (changed) onPick(v);
    draw();
  };
  const move = (d) => {
    if (!shown.length) return;
    active = (active + d + shown.length) % shown.length;
    list.querySelectorAll('.combo__opt').forEach((el, i) => el.classList.toggle('combo__opt--active', i === active));
    const el = list.children[active];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('focus', () => {
    input.select();
    fill('');
  });
  input.addEventListener('input', () => fill(input.value));
  input.addEventListener('blur', () => setTimeout(close, 0));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (list.hidden) fill('');
      else move(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && shown[active]) pick(shown[active].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      input.blur();
    }
  });
  clearBtn.onclick = () => pick('');
  draw();
  return { draw };
}
