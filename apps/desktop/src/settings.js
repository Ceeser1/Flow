'use strict';

const fs = require('fs');
const paths = require('./paths');
const { writeJsonAtomic } = require('@flow/core/jsonFile');
const { DEFAULT_MP3_QUALITY, clampQuality } = require('@flow/core/formats');
const { BROWSERS } = require('@flow/core/cookies');

// What the app remembers between sessions. Small and flat, read once at start
// and written whenever the window changes something.
const DEFAULTS = {
  volume: 0.8,
  shuffle: false,
  lastPlaylistId: 'all',
  lastSongId: null,
  lastContextId: 'all',
  lastPosition: 0,
  alwaysMp3: false,
  mp3Quality: DEFAULT_MP3_QUALITY,
  windowBounds: null,
  windowMaximized: false,
  ytDlpCheckedAt: 0,
  // The listen in progress when the app closed, carried on at the next start
  // if the same song is still loaded: { songId, listened }.
  listenSession: null,
  // Whether the menu's "Listen behaviour" group is open, and the lists under
  // its Playlists and Followed Playlists entries.
  listenGroupOpen: true,
  playlistsMenuOpen: true,
  followedMenuOpen: true,
  // Whether the Shared Playlists section of the Playlists page is open, and
  // the Listen behaviour row there (closed until opened).
  sharedGroupOpen: true,
  listenPageOpen: false,
  // The sleep timer running, kept so a restart still shows (and can cancel)
  // the shutdown Windows has been told about: { endsAt, shutdownAt, ended },
  // times in ms, shutdownAt null without a shutdown.
  sleepTimer: null,

  // ---- the Settings window ----
  // Where songs are saved; '' is Music\FlowPlayer.
  musicDir: '',
  // With alwaysMp3: leave MP3s as they are instead of encoding them again.
  keepMp3: true,
  // yt-dlp reads this browser's cookies (signed-in sites, age restrictions);
  // with shareCookies a Flow Server's download gets the link's site's ones.
  useCookies: false,
  cookiesBrowser: '',
  shareCookies: false,
  // The next song starts this long before the current one ends, faded over.
  crossfade: true,
  crossfadeSeconds: 3,
  // Every song brought to the same loudness, measured once per song.
  normalize: true,
  // The clouds behind the pages, and how they swell with the bass (percent).
  cloudsOn: true,
  cloudsIntensity: 50,
  cloudsBass: true,
  cloudsBassAmount: 50,
  // The equalizer: height and shine in percent, and its colours.
  eqOn: true,
  eqHeight: 50,
  // How solid it shows, 100% fully opaque.
  eqVisibility: 50,
  eqShine: true,
  eqShineSpread: 50,
  eqColors: 'rainbow',
  // The window's edges flashing white on bass peaks: off unless chosen, how
  // readily it triggers, and how strong and far in the flash reaches (percent).
  flashOn: false,
  flashTriggers: 33,
  flashRange: 10,

  // The fullscreen Music Visualizer the player bar's button opens (VISUALIZERS).
  visualizer: 'bars',

  // ---- Streaming, Download and Synchronization: a Flow Server ----
  // The library lives on the server; see remote.js.
  serverOn: false,
  // Addresses, tried in this order: the one at home first, then the one from
  // outside. "192.168.0.63:7878", "flow.example.com" or a full https:// link.
  serverHome: '',
  serverRemote: '',
  // Each address can be switched off, to force the other one (home only, or
  // remote only). Both on: home first, then remote.
  serverHomeOn: true,
  serverRemoteOn: true,
  // The server's password, encrypted with Windows' key for this user
  // (Electron safeStorage).
  serverSecret: '',
  // Downloads and uploads on a metered connection too (a phone's hotspot).
  serverMetered: false,
  // Songs downloaded here stay here after going up to the server.
  serverKeepFiles: true,
  // Songs added to or removed from the Local Files folder by hand go to the
  // server by themselves; otherwise only with "Synchronize now".
  serverAutoSync: true,
};

const EQ_COLORS = ['spectrum', 'rainbow', 'white', 'red', 'green', 'yellow', 'blue', 'purple', 'black'];
// The ones that can be chosen; 'random' picks one of the others each time.
const VISUALIZERS = ['random', 'bars', 'waveform', 'flow'];

function percent(v, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : fallback;
}

let current = null;

function clean(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.volume = Math.min(1, Math.max(0, Number(s.volume)));
  if (!Number.isFinite(s.volume)) s.volume = DEFAULTS.volume;
  s.shuffle = !!s.shuffle;
  s.alwaysMp3 = !!s.alwaysMp3;
  s.mp3Quality = clampQuality(s.mp3Quality);
  s.lastPosition = Math.max(0, Number(s.lastPosition) || 0);
  s.lastPlaylistId = s.lastPlaylistId ? String(s.lastPlaylistId) : 'all';
  s.lastSongId = s.lastSongId ? String(s.lastSongId) : null;
  s.lastContextId = s.lastContextId ? String(s.lastContextId) : 'all';
  const ls = s.listenSession;
  s.listenSession = ls && typeof ls === 'object' && ls.songId
    ? { songId: String(ls.songId), listened: Math.max(0, Number(ls.listened) || 0) }
    : null;
  s.listenGroupOpen = s.listenGroupOpen !== false;
  s.playlistsMenuOpen = s.playlistsMenuOpen !== false;
  s.followedMenuOpen = s.followedMenuOpen !== false;
  s.sharedGroupOpen = s.sharedGroupOpen !== false;
  s.listenPageOpen = s.listenPageOpen === true;
  const st = s.sleepTimer;
  const endsAt = st && typeof st === 'object' ? Number(st.endsAt) : NaN;
  const shutdownAt = st && Number.isFinite(Number(st.shutdownAt)) && st.shutdownAt !== null ? Number(st.shutdownAt) : null;
  s.sleepTimer = Number.isFinite(endsAt) ? { endsAt, shutdownAt, ended: st.ended === true } : null;

  s.musicDir = typeof s.musicDir === 'string' ? s.musicDir : '';
  for (const key of ['serverHome', 'serverRemote']) s[key] = typeof s[key] === 'string' ? s[key].trim().slice(0, 300) : '';
  s.serverSecret = typeof s.serverSecret === 'string' ? s.serverSecret : '';
  for (const key of ['flashOn', 'serverOn', 'serverMetered', 'useCookies', 'shareCookies']) s[key] = s[key] === true;
  s.cookiesBrowser = BROWSERS.some((b) => b.id === s.cookiesBrowser) ? s.cookiesBrowser : '';
  for (const key of ['keepMp3', 'crossfade', 'normalize', 'cloudsOn', 'cloudsBass', 'eqOn', 'eqShine',
    'serverKeepFiles', 'serverAutoSync', 'serverHomeOn', 'serverRemoteOn']) {
    s[key] = s[key] !== false;
  }
  const fade = Math.round(Number(s.crossfadeSeconds) * 10) / 10;
  s.crossfadeSeconds = Number.isFinite(fade) ? Math.min(10, Math.max(0.1, fade)) : DEFAULTS.crossfadeSeconds;
  for (const key of ['cloudsIntensity', 'cloudsBassAmount', 'eqHeight', 'eqVisibility', 'eqShineSpread', 'flashTriggers', 'flashRange']) {
    s[key] = percent(s[key], DEFAULTS[key]);
  }
  if (!EQ_COLORS.includes(s.eqColors)) s.eqColors = DEFAULTS.eqColors;
  if (!VISUALIZERS.includes(s.visualizer)) s.visualizer = DEFAULTS.visualizer;
  return s;
}

function load() {
  try {
    current = clean(JSON.parse(fs.readFileSync(paths.settingsFile(), 'utf8')));
  } catch {
    current = clean(null);
  }
  return current;
}

function all() {
  return current || load();
}

function get(key) {
  return all()[key];
}

function set(patch) {
  const next = clean({ ...all(), ...(patch || {}) });
  current = next;
  try {
    writeJsonAtomic(paths.settingsFile(), next);
  } catch {
    // Losing a remembered volume is not worth interrupting anything for.
  }
  return next;
}

module.exports = { load, all, get, set, clean, DEFAULTS, EQ_COLORS, VISUALIZERS };
