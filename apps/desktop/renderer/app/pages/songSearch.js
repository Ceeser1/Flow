'use strict';

// A song's name typed into the Add Songs box instead of a link ("Linkin Park -
// Numb"): the uploads a search found, best first (@flow/core/songSearch), each
// with a box to tick (the best match ticked), and Cancel, Download Selected,
// Download All. One upload downloads like a pasted link, straight into the trim
// editor: AddPage.startDownload, or ServerImport.start for "Download
// (Server)". Several are downloaded as an import's frames, saved into All
// Songs (or a new playlist named after the search): AddPage.startPicked or
// ServerImport.startPicked. The search runs where the button downloads: here with
// yt-dlp ("Download"/"Download (Client)"), or on the Flow Server (its "search"
// feature; the phone only has that one).
//
//   idle -> searching -> results
//
// The results list YouTube's uploads; every "Search for more" adds the next
// page below them, under its own heading: first SoundCloud's, Bandcamp's and
// the Internet Archive's, then YouTube's further down (lister.search's
// pages). An upload already listed is not listed again. Searching takes a few
// seconds (the progress frame, with Cancel); a new search, a link, or Cancel
// drops the results, and an answer that comes after that is ignored (`run`).

const SongSearch = {
  state: 'idle',
  where: 'client',    // 'client' (this app's yt-dlp) or 'server'
  found: null,        // { query, artist, title, results }: the first page
  pages: [],          // what each "Search for more" added: [{ page, results }]
  moreState: 'idle',  // 'idle', 'searching' or 'failed'
  note: '',           // next to "Search for more": nothing new found, or what went wrong
  checked: new Set(), // the links of the uploads ticked
  run: 0,

  init() {
    $('searchClose').onclick = () => this.close();
    $('searchMore').onclick = () => this.searchMore();
    $('searchSelected').onclick = () => this.download(false);
    $('searchAll').onclick = () => this.download(true);
  },

  get busy() {
    return this.state === 'searching';
  },

  /** Where the search runs: this app's yt-dlp, or the server. */
  _search(query, page) {
    return this.where === 'server'
      ? window.flow.serverDownloads('search', { query, page })
      : window.flow.searchSongs(query, page);
  },

  /** Searches for `query` ('client' or 'server', as the button pressed) and lists what it found. */
  async open(query, where) {
    // A checklist that was never started goes, as for a new link.
    if (ImportPanel.state === 'review') ImportPanel.close();
    const run = this._drop();
    this.where = where;
    this.state = 'searching';
    AddPage._progress({
      title: `Searching for "${query}"`,
      frac: null,
      status: where === 'server' ? 'Searching YouTube on the server...' : 'Searching YouTube...',
      busy: true,
    });
    let found;
    try {
      found = await this._search(query, 0);
    } catch (err) {
      if (run !== this.run) return;
      this.state = 'idle';
      this._failed(err);
      return;
    }
    if (run !== this.run) return;
    this.found = found;
    // The best match ticked, so one click downloads it.
    const best = found.results[0];
    this.checked = new Set(best && best.quality === 'good' ? [best.url] : []);
    this.state = 'results';
    $('progressPanel').hidden = true;
    $('progTitle').classList.remove('prog-title--busy');
    this.render();
  },

  /** Cancel in the progress frame while searching. */
  cancel() {
    if (!this.busy) return;
    if (this.where === 'client') window.flow.cancelSearch().catch(() => {});
    this._drop();
    this._failed({ cancelled: true });
  },

  /** Cancel, or something else taking the page's place: the results go. */
  close() {
    if (this.state === 'idle') return;
    const searching = this.busy;
    if ((searching || this.moreState === 'searching') && this.where === 'client') window.flow.cancelSearch().catch(() => {});
    this._drop();
    if (searching) $('progressPanel').hidden = true;
  },

  /** Back to nothing; the number of the search now running is retired. */
  _drop() {
    this.run += 1;
    this.state = 'idle';
    this.found = null;
    this.pages = [];
    this.moreState = 'idle';
    this.note = '';
    this.checked = new Set();
    $('searchPanel').hidden = true;
    clear($('searchList'));
    return this.run;
  },

  _failed(err) {
    $('progressPanel').hidden = false;
    $('progTitle').classList.remove('prog-title--busy');
    $('progBar').hidden = true;
    $('progCancel').hidden = true;
    if (err && err.cancelled) {
      $('progStatus').textContent = 'Search cancelled.';
      $('progError').hidden = true;
    } else {
      $('progStatus').textContent = 'The search failed.';
      AddPage._showError((err && err.message) || 'Something went wrong.');
    }
  },

  /** The page the next "Search for more" asks for (lister.search). */
  _nextPage() {
    return this.pages.length ? this.pages[this.pages.length - 1].page + 1 : 1;
  },

  /**
   * "Search for more": the next page below the list, without the uploads
   * listed already. One that finds nothing new is passed by: the click after
   * asks for the page after it.
   */
  async searchMore() {
    if (this.state !== 'results' || this.moreState === 'searching') return;
    const run = this.run;
    const page = this._nextPage();
    this.moreState = 'searching';
    this.note = '';
    this._drawButtons();
    let found;
    try {
      found = await this._search(this.found.query, page);
    } catch (err) {
      if (run !== this.run) return;
      this.moreState = 'failed';
      this.note = `Nothing more could be searched: ${err.message}`;
      this._drawButtons();
      return;
    }
    if (run !== this.run) return;
    const listed = new Set(this._all().map((r) => r.url));
    const fresh = found.results.filter((r) => !listed.has(r.url));
    this.pages.push({ page, results: fresh });
    this.moreState = 'idle';
    if (fresh.length) {
      // The list scrolls to the new page's heading, its songs below it.
      const section = this._appendPage(fresh, page);
      const list = $('searchList');
      list.scrollTo({ top: list.scrollTop + section.getBoundingClientRect().top - list.getBoundingClientRect().top, behavior: 'smooth' });
    } else {
      this.note = page === 1 ? 'Nothing new on SoundCloud, Bandcamp or the Internet Archive.' : 'Nothing new found this time.';
    }
    this._drawButtons();
  },

  render() {
    const f = this.found;
    if (!f) return;
    $('searchPanel').hidden = false;
    const head = clear($('searchHead'));
    head.append(
      h('span.import__badge', 'Search'),
      h('span.import__heading', `"${f.query}"`),
      h('span.muted-text', f.results.length ? 'Pick one or more to download. They can be trimmed and named after.' : ''));
    const list = clear($('searchList'));
    if (!f.results.length) {
      list.appendChild(h('div.import__empty', 'Nothing found on YouTube for these words. Try other words, or search for more.'));
    }
    f.results.forEach((r, i) => list.appendChild(this._row(r, i === 0)));
    for (const p of this.pages) if (p.results.length) this._appendPage(p.results, p.page);
    this._drawButtons();
  },

  /** A page of "Search for more" at the end of the list, under its heading; resolves the heading. */
  _appendPage(results, page) {
    const list = $('searchList');
    const section = h('div.song-search__section', page === 1 ? 'SoundCloud, Bandcamp and the Internet Archive'
      : `More from YouTube (its results ${(page - 1) * 10 + 1} to ${page * 10})`);
    list.appendChild(section);
    for (const r of results) list.appendChild(this._row(r, false));
    return section;
  },

  _drawButtons() {
    const btn = $('searchMore');
    const searching = this.moreState === 'searching';
    btn.disabled = searching;
    btn.textContent = searching ? 'Searching...' : 'Search for more';
    const others = this._nextPage() === 1;
    btn.title = others ? 'Look on SoundCloud, Bandcamp and the Internet Archive too' : 'Look further down YouTube\'s results';
    // The turning circle while it searches, and where.
    $('searchSpinner').hidden = !searching;
    const note = $('searchNote');
    note.textContent = searching
      ? (others ? 'Searching SoundCloud, Bandcamp and the Internet Archive...' : 'Searching further down YouTube...')
      : this.note;
    note.hidden = !note.textContent;
    note.classList.toggle('song-search__note--bad', this.moreState === 'failed');
    this._drawCount();
  },

  /** Every upload listed, in the list's order: the first page's, then each page added. */
  _all() {
    return this.found ? [...this.found.results, ...this.pages.flatMap((p) => p.results)] : [];
  },

  _drawCount() {
    const all = this._all();
    const chosen = all.filter((r) => this.checked.has(r.url)).length;
    $('searchCount').textContent = all.length ? `${chosen} of ${all.length} selected` : '';
    $('searchSelected').disabled = !chosen;
    $('searchAll').disabled = !all.length;
  },

  /** One upload: a box to tick, its title (opens it to check), where it is and who uploaded it. */
  _row(r, first) {
    const flags = [];
    if (first && r.quality === 'good') flags.push(h('span.import__flag.import__flag--best', 'best match'));
    for (const v of r.versions || []) flags.push(h('span.import__flag', v));
    if (r.existing) {
      flags.push(h('span.import__flag.import__flag--trim', { title: `In your library as "${Util.songLine(r.existing)}"` }, 'in your library'));
    }
    const title = h('button.link-btn.song-search__title', {
      type: 'button',
      title: `${r.title}\nOpen on ${r.site} to check`,
      onclick: (e) => {
        // A click on the title opens it; only the rest of the row ticks the box.
        e.preventDefault();
        e.stopPropagation();
        window.flow.openUrl(r.url);
      },
    }, r.title);
    const tick = h('input', { type: 'checkbox', checked: this.checked.has(r.url) });
    tick.addEventListener('change', () => {
      if (tick.checked) this.checked.add(r.url);
      else this.checked.delete(r.url);
      this._drawCount();
    });
    return h('label.import__row', tick,
      h('div.import__text',
        h('div.import__title', ...flags, title),
        h('div.import__sub', [r.site, r.channel, r.album].filter(Boolean).join(' · '))),
      h('span.import__dur', r.duration ? Util.fmtClock(r.duration) : ''));
  },

  /**
   * Download Selected, Download All: one upload as a pasted link to it (into
   * the trim editor), several as an import's frames, by the same button's
   * way as the search (here or on the server).
   */
  download(everything) {
    const picks = this._all().filter((r) => everything || this.checked.has(r.url));
    if (!picks.length) return;
    const server = this.where === 'server';
    if (picks.length === 1) {
      const pick = { url: picks[0].url, title: picks[0].title };
      if (server) ServerImport.start(pick);
      else AddPage.startDownload(pick);
      return;
    }
    const name = this.found.query;
    if (server) ServerImport.startPicked(picks, name);
    else AddPage.startPicked(picks, name);
  },
};
