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
    };

    const redraw = () => draw();
    Store.onLibrary(redraw);
    draw();
    modal = Modal.open({
      title: 'Song Details',
      className: 'modal--details',
      body,
      buttons: [{ label: 'Close', kind: 'primary' }],
      onClose: () => {
        Store._listeners = Store._listeners.filter((fn) => fn !== redraw);
      },
    });
  },

  _head(song) {
    const meta = [song.artist, song.mix, Util.fmtClock(song.duration)].filter(Boolean).join('  ·  ');
    return h('section.details__section.details__head',
      Covers.el(song, 'big'),
      h('h3.details__title', { title: song.title }, song.title),
      h('div.details__meta', meta));
  },

  _playlists(song, shown) {
    const inList = new Set(Store.library.playlists
      .filter((p) => p.entries.some((e) => e.songId === song.id))
      .map((p) => p.id));
    for (const id of inList) shown.add(id);

    const chips = h('div.details__chips');
    const lists = Store.sortedPlaylists().filter((p) => shown.has(p.id));
    if (!lists.length) chips.appendChild(h('span.muted-text', 'Not in any playlist yet.'));
    for (const p of lists) {
      const on = inList.has(p.id);
      chips.appendChild(h('button.chip' + (on ? '.chip--on' : ''), {
        type: 'button',
        title: on ? `In ${p.name}: click to take it out` : `Click to put it back into ${p.name}`,
        html: `<span class="chip__box">${on ? Icons.check : ''}</span>`,
        onclick: () => attempt(async () => {
          if (on) {
            await window.flow.removeFromPlaylist(p.id, song.id);
            toast(`Removed from ${p.name}`, 'success');
          } else {
            await window.flow.addSongToPlaylists(song.id, [p.id]);
            toast(`Added to ${p.name}`, 'success');
          }
        }),
      }, h('span', p.name)));
    }

    const add = h('button.btn.btn--green', {
      type: 'button',
      html: Icons.plus + '<span>Add to Playlists</span>',
      onclick: async () => {
        const chosen = await pickPlaylists({ subtitle: Util.songLine(song), lockedIds: [...inList] });
        if (!chosen || !chosen.length) return;
        await attempt(async () => {
          const n = await window.flow.addSongToPlaylists(song.id, chosen);
          toast(`Added to ${Util.plural(n, 'playlist')}`, 'success');
        });
      },
    });

    return h('section.details__section',
      h('h4.details__heading', 'Playlists'),
      chips,
      h('div.details__row', add));
  },

  /** The page the song was downloaded from, and the playlist it came in with if any. */
  _source(song) {
    const link = (url) => h('button.link-btn.details__url', {
      type: 'button', title: 'Open in the browser', onclick: () => window.flow.openUrl(url),
    }, url);
    const row = (label, value) => [h('div.details__label', label), h('div.details__value', value)];
    return h('section.details__section',
      h('h4.details__heading', 'Downloaded from'),
      h('div.details__grid',
        ...row('Direct Url', song.sourceUrl ? link(song.sourceUrl) : h('span.muted-text', 'Not known (the file was added to Local Files by hand)')),
        ...(song.sourcePlaylistUrl ? row('Playlist Url', link(song.sourcePlaylistUrl)) : [])));
  },

  _stats(song) {
    const st = song.stats || {};
    const plays = st.plays || 0;
    const sessions = st.sessions || 0;
    const last = st.lastPlayedAt;
    const avg = sessions ? (st.listened || 0) / sessions : 0;
    const share = avg && song.duration ? ` (${Math.round((avg / song.duration) * 100)}% of the song)` : '';

    const row = (label, value) => [h('div.details__label', label), h('div.details__value', value)];
    return h('section.details__section',
      h('h4.details__heading', 'Statistics'),
      h('div.details__grid',
        ...row('Added', Util.fmtDate(song.addedAt)),
        ...row('Last listened', last ? `${Util.fmtDate(last)}  (${Util.fmtAgo(last)})` : 'Never'),
        ...row('Times played (>5 seconds)', String(sessions)),
        ...row('Average listen duration', sessions ? Util.fmtClock(avg) + share : '-'),
        ...row('Times fully listened (>80% duration)', String(plays)),
        ...row('Times stopped listening (>30s but <80% duration)', String(st.stops || 0)),
        ...row('Times skipped early (<30 seconds)', String(st.skips || 0))));
  },
};
