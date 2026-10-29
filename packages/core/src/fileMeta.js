'use strict';

// What a song file says about itself, for songs added from files (a folder
// scan, Add Songs' local files): its names, and which song it is when a song's
// file went missing. No Node: the Android app uses it too.

const { parseTitle, cleanTitleTag, withFeat } = require('./titleParser');
const { sourceKeyFromUrl } = require('./text');
const { parseFlowId } = require('./tags');

/** A file's name without its folder and extension ("C:\Music\A - B.mp3" -> "A - B"). */
function fileStem(file) {
  const name = String(file || '').split(/[\\/]/).pop();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Artist, title, mix, album, genre, sub-genre and source link of a file,
 * from its tags or else its name (album, genre and sub-genre, the grouping
 * tag, only from tags). The source link is the one Flow writes into the
 * comment tag. A title tag Flow did not write (no flowid) is cleaned as a
 * name is: "Song (Extended Mix) [asdf]" is Song, its mix Extended Mix.
 */
function metaFromFile(file, tags = {}) {
  const fromName = parseTitle(fileStem(file));
  const comment = tags.comment || tags.purl || '';
  const sourceUrl = /^https?:\/\//i.test(comment) ? comment : '';
  const tag = tags.title && !parseFlowId(tags) ? cleanTitleTag(tags.title) : null;
  const artist = tags.artist || tags.album_artist || '';
  // A mix tag and the mix in the title's brackets, each once.
  const mixes = [tags.mix, tag && tag.mix].map((m) => String(m || '').trim()).filter(Boolean);
  const mix = mixes.filter((m, i) => !mixes.slice(0, i).some((o) => o.toLowerCase() === m.toLowerCase())).join(', ');
  return {
    title: tag ? tag.title : tags.title || fromName.title,
    artist: artist ? withFeat(artist, tag ? tag.feat : '') : fromName.artist,
    mix: mix || (tags.title ? '' : fromName.mix),
    album: String(tags.album || '').trim(),
    genre: String(tags.genre || '').trim(),
    subGenre: String(tags.grouping || '').trim(),
    sourceUrl,
    sourceKey: sourceKeyFromUrl(sourceUrl) || '',
  };
}

/**
 * A song whose file is gone and a new file that is the same recording: the
 * song its flowid names (this app's own: `ownId`), else the one of the same
 * format and length to a twentieth of a second; with several such songs the
 * one with the same title and artist, without that none. A flowid naming a
 * song whose file is still there (`has`) makes the file a copy: no song's.
 */
function findMoved(fresh, gone, ownId = null, has = () => false) {
  const fid = fresh.flowId;
  if (fid && ownId && fid.library === ownId) {
    const named = gone.find((g) => g.id === fid.songId);
    if (named) return named;
    if (has(fid.songId)) return null;
  }
  const same = gone.filter((g) => g.format === fresh.format && Math.abs((g.duration || 0) - fresh.duration) < 0.05);
  if (same.length === 1) return same[0];
  const fold = (t) => String(t || '').toLowerCase();
  return same.find((g) => fold(g.title) === fold(fresh.title) && fold(g.artist) === fold(fresh.artist)) || null;
}

module.exports = { fileStem, metaFromFile, findMoved };
