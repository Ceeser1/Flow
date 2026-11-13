'use strict';

// A song's Details: its cover, its names, the playlists it is in, how it has been
// listened to, and where it was downloaded from. Playlist membership changes straight away: a lit button is a
// list the song is in, and clicking it takes the song out (clicking again puts
// it back, until the popup is closed). "Add to Playlists" opens the usual
// picker for the lists it is not in yet.

const SongDetails = {
  open(songId) {
    if (!Store.song(songId)) return;
    // Every list the song was in when the popup opened keeps its button, lit
    // or not, so a mistaken click can be undone.
    const shown = new Set(Store.library.playlists
      .filter((p) => p.entries.some((e) => e.songId === songId))
      .map((p) => p.id));

    const body = h('div.details');
    let modal = null;
    // Its lyrics (4.0), fetched once: { state: 'loading' | 'ready' | 'error', data, error }.
    const lyrics = { state: 'loading', data: null, error: '' };

    const draw = () => {
      const song = Store.song(songId);
      if (!song) {
        if (modal) modal.close();
        return;
      }
      clear(body);
      body.appendChild(this._head(song));
      body.appendChild(this._playlists(song, shown));
      body.appendChild(this._stats(song));
      body.appendChild(this._source(song));
      if (window.flow.lyrics) body.appendChild(this._lyrics(song, lyrics, load));
    };
    const load = async () => {
      lyrics.state = 'loading';
      draw();
      try {
        const data = await window.flow.lyrics(songId);
        Object.assign(lyrics, { state: 'ready', data, error: '' });
      } catch (err) {
        Object.assign(lyrics, { state: 'error', data: null, error: (err && err.message) || T('common.lyricsNotFetched') });
      }
      draw();
    };

    // Drawn again only for what it shows (4.6; it was for every change of the
    // library): this song changed or is gone, or something else than songs
    // did (the playlists it is in).
    const redraw = (lib, change) => {
      if (change && !change.whole && !change.ids.has(songId) && !change.went && !change.rest()) return;
      draw();
    };
    Store.onLibrary(redraw);
    draw();
    if (window.flow.lyrics) load();
    // On the phone a full-screen panel from the right, like the Queue, swiped away to either side.
    modal = Modal.open({
      title: T('common.songDetails'),
      className: 'modal--details',
      drawer: Mobile.on,
      body,
      buttons: Mobile.on ? [] : [{ label: T('common.close'), kind: 'primary' }],
      onClose: () => {
        Store._listeners = Store._listeners.filter((fn) => fn !== redraw);
      },
    });
    if (Mobile.on) Mobile.swipeToClose(modal, ['left', 'right']);
  },

  _head(song) {
    const meta = [song.artist, Util.fmtClock(song.duration)].filter(Boolean).join('  ·  ');
    // Under them its Album, Mix, Genre and Info, each named, "-" for one it has not.
    const tag = (label, value) => h('span.details__tag', h('span.details__tag-label', label), value || '-');
    return h('section.details__section.details__head',
      Covers.el(song, 'big'),
      h('h3.details__title', { title: song.title }, song.title),
      h('div.details__meta', meta),
      h('div.details__tags',
        tag(T('common.album'), song.album), tag(T('common.mix'), song.mix), tag(T('common.genre'), song.genre), tag(T('common.info'), song.subGenre)));
  },

  _playlists(song, shown) {
    const inList = new Set(Store.library.playlists
      .filter((p) => p.entries.some((e) => e.songId === song.id))
      .map((p) => p.id));
    for (const id of inList) shown.add(id);

    const chips = h('div.details__chips');
    const lists = Store.sortedPlaylists().filter((p) => shown.has(p.id));
    if (!lists.length) chips.appendChild(h('span.muted-text', T('details.playlists.none')));
    for (const p of lists) {
      const on = inList.has(p.id);
      chips.appendChild(h('button.chip' + (on ? '.chip--on' : ''), {
        type: 'button',
        title: on ? T('details.playlists.in.tooltip', { playlist: p.name }) : T('details.playlists.out.tooltip', { playlist: p.name }),
        html: `<span class="chip__box">${on ? Icons.check : ''}</span>`,
        onclick: () => attempt(async () => {
          if (on) {
            await window.flow.removeFromPlaylist(p.id, song.id);
            toast(T('common.removedFrom', { playlist: p.name }), 'success');
          } else {
            await window.flow.addSongToPlaylists(song.id, [p.id]);
            toast(T('common.addedTo', { playlist: p.name }), 'success');
          }
        }),
      }, h('span', p.name)));
    }

    const add = h('button.btn.btn--green', {
      type: 'button',
      html: Icons.plus + `<span>${T('common.addToPlaylists')}</span>`,
      onclick: async () => {
        const chosen = await pickPlaylists({ subtitle: Util.songLine(song), lockedIds: [...inList] });
        if (!chosen || !chosen.length) return;
        await attempt(async () => {
          const n = await window.flow.addSongToPlaylists(song.id, chosen);
          toast(T('details.playlists.addedMany', { playlists: Util.plural(n, 'playlist') }), 'success');
        });
      },
    });

    return h('section.details__section',
      h('h4.details__heading', T('common.playlists')),
      chips,
      h('div.details__row', add));
  },

  /** The page the song was downloaded from, and the playlist it came in with if any. */
  _source(song) {
    const link = (url) => h('button.link-btn.details__url', {
      type: 'button', title: T('details.source.openInBrowser.tooltip'), onclick: () => window.flow.openUrl(url),
    }, url);
    const row = (label, value) => [h('div.details__label', label), h('div.details__value', value)];
    return h('section.details__section',
      h('h4.details__heading', T('details.source.heading')),
      h('div.details__grid.details__grid--source',
        ...row(T('details.source.directUrl'), song.sourceUrl ? link(song.sourceUrl) : h('span.muted-text', T('details.source.unknown'))),
        ...(song.sourcePlaylistUrl ? row(T('details.source.playlistUrl'), link(song.sourcePlaylistUrl)) : [])));
  },

  /**
   * Its lyrics, the words without times (4.0), with Edit Lyrics (or Add
   * Lyrics without any) at the heading's right: written ones are kept for
   * good, on the server for a server's song. `reload` fetches them again.
   */
  _lyrics(song, lyrics, reload) {
    // The heading says where the words came from; Edit (or Add) at its right.
    const name = h('span', T('common.lyrics'));
    const heading = h('h4.details__heading.details__heading--split', name);
    const section = h('section.details__section', heading);
    if (lyrics.state === 'loading') {
      section.appendChild(h('div.details__lyrics.details__lyrics--none', LyricsEdit.spinner(), T('common.lookingForLyrics')));
      return section;
    }
    if (lyrics.state === 'error') {
      section.append(h('div.details__lyrics.details__lyrics--none', lyrics.error),
        h('div.details__row', h('button.btn.btn--small', { type: 'button', onclick: reload }, T('common.tryAgain'))));
      return section;
    }
    const data = lyrics.data;
    const words = data && data.found ? String(data.plain || '').trim() : '';
    if (words) {
      const from = data.own ? T('details.lyrics.from.own') : T('details.lyrics.from.source', { source: data.source || 'LRCLIB' });
      name.appendChild(h('span.details__heading-note', ` ${T(data.synced ? 'details.lyrics.note.timed' : 'details.lyrics.note.untimed', { from })}`));
    }
    section.appendChild(words
      ? h('div.details__lyrics', words)
      : h('div.details__lyrics.details__lyrics--none', data && data.instrumental ? T('common.instrumental') : T('common.noLyricsForSong')));
    if (!LyricsEdit.available) return section;
    heading.appendChild(h('button.btn.btn--small.btn--light-green', {
      type: 'button', onclick: () => LyricsEdit.openFor(song, data, reload),
    }, words ? T('common.editLyrics') : T('common.addLyrics')));
    return section;
  },

  _stats(song) {
    const st = song.stats || {};
    const plays = st.plays || 0;
    const sessions = st.sessions || 0;
    const last = st.lastPlayedAt;
    const avg = sessions ? (st.listened || 0) / sessions : 0;
    const share = avg && song.duration ? Math.round((avg / song.duration) * 100) : null;

    const row = (label, value) => [h('div.details__label', label), h('div.details__value', value)];
    // With a Flow Server that has profiles: the one that uploaded the song or had the server download it.
    const by = Store.canShare() ? (song.addedBy && Store.profileName(song.addedBy)) || T('common.unknown') : null;
    return h('section.details__section',
      h('h4.details__heading', T('common.statistics')),
      h('div.details__grid',
        ...row(T('common.added'), Util.fmtDate(song.addedAt)),
        ...(by ? row(T('details.stats.addedBy'), by) : []),
        ...row(T('details.stats.lastListened'), last ? `${Util.fmtDate(last)}  (${Util.fmtAgo(last)})` : T('details.stats.never')),
        ...row(T('details.stats.timesPlayed'), String(sessions)),
        ...row(T('details.stats.averageListen'), sessions ? (share !== null ? T('details.stats.averageListen.share', { duration: Util.fmtClock(avg), percent: share }) : Util.fmtClock(avg)) : '-'),
        // Short enough for one line each on the phone.
        ...row(T('details.stats.over80'), `${plays}x`),
        ...row(T('details.stats.under80'), `${st.stops || 0}x`),
        ...row(T('details.stats.skippedEarly'), `${st.skips || 0}x`)));
  },
};
