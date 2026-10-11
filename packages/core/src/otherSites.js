'use strict';

// Searching the sites a Spotify (Deezer, Amazon Music) song is looked for on
// when YouTube has no upload of it, where yt-dlp cannot search (SoundCloud it
// can: scsearch). Both give names only; a hit's length comes from reading it
// with yt-dlp, which is also what tells whether it can be downloaded at all.
//
//   Bandcamp:         the search box's own service, songs only.
//   Internet Archive: its public search, audio uploads by the song's title and
//                     first artist.
//
// Neither is an official interface for this; a search that fails finds
// nothing, and the song stays not found.

const { searchTitle } = require('./spotify');

const RESULTS = 5;

function firstArtist(track) {
  return String(track.artists || '').split(',')[0].trim();
}

/** Bandcamp songs for a song: [{ id, title, channel, duration: 0, url }]. */
async function searchBandcamp(track) {
  const res = await fetch('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      search_text: `${firstArtist(track)} ${searchTitle(track.title)}`.trim(),
      search_filter: 't',
      full_page: false,
      fan_id: null,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  const results = (data && data.auto && Array.isArray(data.auto.results)) ? data.auto.results : [];
  return results.filter((r) => r && r.type === 't' && r.item_url_path).slice(0, RESULTS).map((r) => ({
    id: String(r.id),
    title: String(r.name || ''),
    channel: String(r.band_name || ''),
    duration: 0,
    url: String(r.item_url_path),
  }));
}

/** A phrase for the Archive's search, quotes and backslashes taken out. */
function phrase(text) {
  return `"${String(text || '').replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

/** Internet Archive uploads for a song: [{ id, title, channel, duration: 0, url }]. */
async function searchArchive(track) {
  const title = searchTitle(track.title);
  const artist = firstArtist(track);
  if (!title) return [];
  const q = [`title:(${phrase(title)})`, artist ? `creator:(${phrase(artist)})` : '', 'mediatype:(audio)']
    .filter(Boolean).join(' AND ');
  const params = new URLSearchParams({ q, rows: String(RESULTS), output: 'json' });
  for (const f of ['identifier', 'title', 'creator']) params.append('fl[]', f);
  const res = await fetch(`https://archive.org/advancedsearch.php?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const docs = (data && data.response && Array.isArray(data.response.docs)) ? data.response.docs : [];
  return docs.filter((d) => d && d.identifier).map((d) => ({
    id: String(d.identifier),
    title: String(d.title || ''),
    channel: String(Array.isArray(d.creator) ? d.creator[0] : (d.creator || '')),
    duration: 0,
    url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
  }));
}

module.exports = { searchBandcamp, searchArchive };
