'use strict';

// The app's Private Statistics (3.6): everything heard on THIS device,
// whatever it played (Local Files, any Flow Server, signed in to a profile or
// not, in a Jam). Kept in private-statistics.json beside the app's other
// files; never sent anywhere. Shared by the Flow apps; no Node.
//
//   { device, since, seconds, listens, months, added, songs }
//
//   device   this install's id (settings.clientId), fixed once written
//   since    when Private started (ms): its "Created at"
//   seconds, listens, months   as a library owner's statistics (listening.js)
//   added    songs this device put into Flow: downloaded, imported, saved
//            (a song's Finish), approved from a Download (Server); not songs
//            found by scanning a folder
//   songs    { "artist\ntitle": { artist, title, seconds, listens } }: what was
//            heard of each song, by its names when it was heard (a song's id
//            differs between the servers and Local Files)

const { cleanStatistics, recordStatistics, LISTEN_SECONDS } = require('../listening');

const FILE = 'private-statistics.json';
// The same limit as libraryModel.recordListen: shorter counts as nothing.
const MIN_LISTEN_SECONDS = 5;
const MAX_SONGS = 20000;

const songKey = (artist, title) => `${String(artist || '').trim().toLowerCase()}\n${String(title || '').trim().toLowerCase()}`;

function cleanSongs(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, s] of Object.entries(raw)) {
    if (!s || typeof s !== 'object' || !key.includes('\n')) continue;
    const seconds = Math.max(0, Number(s.seconds) || 0);
    if (!seconds) continue;
    out[key] = {
      artist: String(s.artist || ''),
      title: String(s.title || ''),
      seconds,
      listens: Math.max(0, Math.floor(Number(s.listens) || 0)),
    };
  }
  return out;
}

function cleanPrivate(raw, now = Date.now()) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const st = cleanStatistics(r);
  return {
    device: typeof r.device === 'string' ? r.device.slice(0, 64) : '',
    since: st.since || now,
    seconds: st.seconds,
    listens: st.listens,
    months: st.months,
    added: Math.max(0, Math.floor(Number(r.added) || 0)),
    songs: cleanSongs(r.songs),
  };
}

/**
 * jsonFiles: the app's { read(name), write(name, value) }; deviceId(): this
 * install's id. `onChange(data)`: after every change.
 */
function createPrivateStats({ jsonFiles, deviceId = () => '', onChange = () => {} }) {
  let data = null;

  function load() {
    if (data) return data;
    const raw = jsonFiles.read(FILE);
    data = cleanPrivate(raw);
    if (!data.device) data.device = String(deviceId() || '');
    // Private starts the first time this app runs 3.6.
    if (!raw) save();
    return data;
  }

  function save() {
    try {
      jsonFiles.write(FILE, data);
    } catch {
      // Not written now: the next change tries again.
    }
    onChange(get());
  }

  /** A copy, for the window. */
  function get() {
    const d = load();
    return { ...d, months: { ...d.months }, songs: { ...d.songs } };
  }

  /**
   * A listen heard here: `song` { artist, title, duration }, `listened`
   * seconds of `duration`, ending at `at`; `tz` the app's time zone offset.
   */
  function recordListen({
    song, listened, duration, at = Date.now(), tz = null,
  }) {
    const d = load();
    const total = Number(duration) || (song && song.duration) || 0;
    const heard = Math.min(Math.max(0, Number(listened) || 0), total || Infinity);
    if (!(heard >= MIN_LISTEN_SECONDS)) return false;
    recordStatistics({ statistics: d }, heard, at, tz);
    if (song && String(song.title || '').trim()) {
      const key = songKey(song.artist, song.title);
      if (d.songs[key] || Object.keys(d.songs).length < MAX_SONGS) {
        const s = d.songs[key] || { artist: '', title: '', seconds: 0, listens: 0 };
        s.artist = String(song.artist || '');
        s.title = String(song.title || '');
        s.seconds = Math.round((s.seconds + heard) * 10) / 10;
        if (heard >= LISTEN_SECONDS) s.listens += 1;
        d.songs[key] = s;
      }
    }
    save();
    return true;
  }

  /** `count` songs this device put into Flow. */
  function added(count = 1) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    if (!n) return;
    load().added += n;
    save();
  }

  return {
    load, get, recordListen, added,
  };
}

module.exports = {
  createPrivateStats, cleanPrivate, songKey, FILE,
};
