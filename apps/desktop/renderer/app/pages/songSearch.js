'use strict';

// A song's name typed into the Add Songs box instead of a link ("Linkin Park -
// Numb"): the uploads a search found, best first (@flow/core/songSearch), each
// with Download. The one picked downloads like a pasted link, so it is trimmed
// and named as any song: AddPage.startDownload, or ServerImport.start for
// "Download (Server)". The search runs where the button downloads: here with
// yt-dlp ("Download"/"Download (Client)"), or on the Flow Server (its "search"
// feature; the phone only has that one).
//
//   idle -> searching -> results
//
// The results list YouTube's uploads; "Search more sites" adds SoundCloud's,
// Bandcamp's and the Internet Archive's below them. Searching takes a few
// seconds (the progress frame, with Cancel); a new search, a link, or Close
// drops the results, and an answer that comes after that is ignored (`run`).

const SongSearch = {
  state: 'idle',
  where: 'client',    // 'client' (this app's yt-dlp) or 'server'
  found: null,        // { query, artist, title, results }
  more: null,         // the other sites' results, once searched
  moreState: 'idle',  // 'idle', 'searching', 'done' or 'failed'
  moreError: '',
  run: 0,

  init() {
    $('searchClose').onclick = () => this.close();
    $('searchMore').onclick = () => this.searchMore();
  },

  get busy() {
    return this.state === 'searching';
  },

  /** Where the search runs: this app's yt-dlp, or the server. */
  _search(query, more) {
    return this.where === 'server'
      ? window.flow.serverDownloads('search', { query, more })
      : window.flow.searchSongs(query, more);
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
      found = await this._search(query, false);
    } catch (err) {
      if (run !== this.run) return;
      this.state = 'idle';
      this._failed(err);
      return;
    }
    if (run !== this.run) return;
    this.found = found;
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

  /** Close, or something else taking the page's place: the results go. */
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
    this.more = null;
    this.moreState = 'idle';
    this.moreError = '';
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

  /** "Search more sites": SoundCloud's, Bandcamp's and the Internet Archive's, below YouTube's. */
  async searchMore() {
    if (this.state !== 'results' || this.moreState === 'searching' || this.moreState === 'done') return;
    const run = this.run;
    this.moreState = 'searching';
    this.moreError = '';
    this._drawButtons();
    let found;
    try {
      found = await this._search(this.found.query, true);
    } catch (err) {
      if (run !== this.run) return;
      this.moreState = 'failed';
      this.moreError = err.message;
      this._drawButtons();
      return;
    }
    if (run !== this.run) return;
    this.more = found.results;
    this.moreState = 'done';
    this.render();
  },

  render() {
    const f = this.found;
    if (!f) return;
    $('searchPanel').hidden = false;
    const head = clear($('searchHead'));
    head.append(
      h('span.import__badge', 'Search'),
      h('span.import__heading', `"${f.query}"`),
      h('span.muted-text', f.results.length ? 'Pick the upload to download; it can be trimmed and named next.' : ''));
    const list = clear($('searchList'));
    if (!f.results.length) {
      list.appendChild(h('div.import__empty', 'Nothing found on YouTube for these words. Try other words, or search more sites.'));
    }
    f.results.forEach((r, i) => list.appendChild(this._row(r, i === 0)));
    if (this.more) {
      list.appendChild(h('div.song-search__section', 'SoundCloud, Bandcamp and the Internet Archive'));
      if (!this.more.length) list.appendChild(h('div.import__empty', 'Nothing found there either.'));
      this.more.forEach((r, i) => list.appendChild(this._row(r, i === 0 && !f.results.length)));
    }
    this._drawButtons();
  },

  _drawButtons() {
    const btn = $('searchMore');
    btn.hidden = this.moreState === 'done';
    btn.disabled = this.moreState === 'searching';
    btn.textContent = this.moreState === 'searching' ? 'Searching more sites...' : 'Search more sites';
    btn.title = 'Look on SoundCloud, Bandcamp and the Internet Archive too';
    const note = $('searchNote');
    note.textContent = this.moreState === 'failed' ? `The other sites could not be searched: ${this.moreError}` : '';
    note.hidden = !note.textContent;
  },

  /** One upload: its title (opens it to check), where it is and who uploaded it, Download. */
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
      onclick: () => window.flow.openUrl(r.url),
    }, r.title);
    return h('div.import__row.song-search__row',
      h('div.import__text',
        h('div.import__title', ...flags, title),
        h('div.import__sub', [r.site, r.channel, r.album].filter(Boolean).join(' · '))),
      h('span.import__dur', r.duration ? Util.fmtClock(r.duration) : ''),
      h('button.btn.btn--small.btn--light-green', {
        type: 'button',
        title: 'Download this upload',
        onclick: () => this.pick(r),
      }, 'Download'));
  },

  /** Download on a result: as a pasted link to it, by the same button's way. */
  pick(r) {
    const pick = { url: r.url, title: r.title };
    if (this.where === 'server') ServerImport.start(pick);
    else AddPage.startDownload(pick);
  },
};
