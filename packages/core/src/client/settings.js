'use strict';

// The app's settings: what each one may be (clean) and its default, and the
// settings held in memory, saved whole whenever one changes. Where they are
// saved is the app's (read, write). Shared by the Flow apps; no Node.

const { DEFAULT_MP3_QUALITY, clampQuality } = require('../formats');
const { BROWSERS } = require('../cookies');
const { randomBase64Url } = require('./common');

// The visualizers' own settings (their cogwheels, apps/desktop/renderer/app/
// viz/), by what they may be: ['color', default] a '#rrggbb'; ['bool',
// default]; ['range', default, min, max, step]; ['choice', default, values].
// Each visualizer's start with its own letters.
const VIZ_OPTIONS = {
  // Opened as Random, another one with each song.
  vizRandomEach: ['bool', false],
  // Synthwave: how fast it flies (percent; its other settings are below with
  // the rest of the window's).
  synSpeed: ['range', 100, 50, 150, 5],
  // Bars: how many, their colours ('classic' and 'equalizer' are gone: a value
  // saved as one of them is left behind), solid or in LED steps, the peak
  // caps, the floor mirroring them.
  brCount: ['range', 40, 16, 128, 4],
  brColors: ['choice', 'lime', ['fire', 'ice', 'lime', 'rainbow']],
  brStyle: ['choice', 'solid', ['solid', 'led']],
  brPeaks: ['bool', true],
  brMirror: ['bool', false],
  // Waveform: its colours (the equalizer's, without black), and distinct
  // bars or one smooth wave.
  wfColors: ['choice', 'rainbow', ['rainbow', 'spectrum', 'greyscale', 'white', 'red', 'green', 'yellow', 'blue', 'purple']],
  wfStyle: ['choice', 'bars', ['bars', 'wave']],
  // Lightning: the bolts' colour, the sky lighting up with them (and how
  // much), how readily it strikes (percent), rain (and how heavy; 50% is
  // the rain it always had).
  ltColor: ['color', '#a9c4ff'],
  ltFlash: ['bool', true],
  ltFlashAmount: ['range', 100, 0, 200, 5],
  ltRain: ['bool', true],
  ltRainAmount: ['range', 50, 0, 100, 5],
  ltStrikes: ['range', 100, 25, 200, 5],
  // Kaleidoscope: its look ('auto' moves on by itself), how often Auto moves
  // on (seconds), and how long the trails last (percent). It was Nebula,
  // with nbLook, nbEvery and nbTrails (Auto by default), left behind.
  ksLook: ['choice', 'kaleido', ['auto', 'kaleido', 'vortex', 'tunnel', 'starburst']],
  ksEvery: ['range', 30, 10, 120, 5],
  ksTrails: ['range', 100, 25, 200, 5],
  // Liquid and Mandala (Kaleidoscope's looks once): how long the trails last
  // (percent).
  lqTrails: ['range', 100, 25, 200, 5],
  mdTrails: ['range', 100, 25, 200, 5],
  // Halo: the cover round or square, turning (round only), the spectrum as
  // bars, a line or dots, the sparks, the cover blurred behind, the title.
  hlShape: ['choice', 'round', ['round', 'square']],
  hlSpin: ['bool', true],
  hlStyle: ['choice', 'bars', ['bars', 'line', 'dots']],
  hlParticles: ['bool', true],
  hlBackground: ['bool', true],
  hlTitle: ['bool', true],
  // Scope: XY, goniometer, wave or polar; the phosphor's colour; how long
  // it glows on (percent); the grid.
  scMode: ['choice', 'xy', ['xy', 'gonio', 'wave', 'polar']],
  scColor: ['color', '#5dff7a'],
  scPersist: ['range', 50, 0, 100, 5],
  scGrid: ['bool', true],
  // Warp: how fast and how many stars (percent), their colours, and the
  // hyperspace jumps on big drops.
  wpSpeed: ['range', 100, 25, 300, 5],
  wpCount: ['range', 100, 25, 200, 5],
  wpColor: ['choice', 'spectrum', ['white', 'spectrum', 'nebula']],
  wpJumps: ['bool', true],
  // Inferno: the flames' colours, their height (percent; ifFlameHeight's 100%
  // is twice the old ifHeight's, so a value saved on that scale is left
  // behind), the bass in the middle or on the left, the embers, the burning
  // forest on the hill behind.
  ifColor: ['choice', 'fire', ['fire', 'blue', 'green', 'purple', 'rainbow']],
  ifFlameHeight: ['range', 100, 25, 150, 5],
  ifLayout: ['choice', 'centre', ['centre', 'across']],
  ifEmbers: ['bool', true],
  ifForest: ['bool', true],
  // Ridges: white, neon or heat; how many lines; how fast they flow
  // (percent); the spectrum or the waveform.
  rdColor: ['choice', 'white', ['white', 'neon', 'heat']],
  rdRows: ['range', 60, 20, 120, 5],
  rdSpeed: ['range', 100, 25, 200, 5],
  rdSource: ['choice', 'spectrum', ['spectrum', 'wave']],
  // Fireworks: festive, gold and silver or the music's colours; how large
  // the bursts are and how long the trails hang (percent); the city.
  fwColors: ['choice', 'festive', ['festive', 'gold', 'music']],
  fwSize: ['range', 100, 50, 200, 5],
  fwTrails: ['range', 50, 0, 100, 5],
  fwCity: ['bool', true],
  // Prism: a kaleidoscope or tiles, how many slices, how fast it turns
  // (percent), the colours shifting.
  psMode: ['choice', 'kaleido', ['kaleido', 'tiles']],
  psSlices: ['choice', '6', ['4', '6', '8', '12']],
  psSpin: ['range', 100, 0, 200, 5],
  psShift: ['bool', true],
  // Orb: dots or a wireframe, its colours, how fast it turns (percent), the
  // ring of sparks.
  obStyle: ['choice', 'dots', ['dots', 'wire']],
  obColors: ['choice', 'aurora', ['aurora', 'ember', 'ice', 'rainbow', 'white']],
  obSpin: ['range', 100, 0, 200, 5],
  obRing: ['bool', true],
  // Lava: its colours, how many blobs, how fast they drift (percent), the gloss.
  lvColors: ['choice', 'lava', ['lava', 'neon', 'ocean', 'candy', 'chrome']],
  lvBlobs: ['range', 10, 4, 16, 1],
  lvSpeed: ['range', 100, 25, 300, 5],
  lvGloss: ['bool', true],
  // Tunnel: round, square or hexagonal; its walls; its colours; how fast it
  // flies (percent).
  tnShape: ['choice', 'round', ['round', 'square', 'hex']],
  tnWalls: ['choice', 'grid', ['grid', 'hex', 'rings']],
  tnColors: ['choice', 'neon', ['neon', 'sunset', 'matrix', 'ice', 'gold']],
  tnSpeed: ['range', 100, 25, 300, 5],
  // Code Rain: its colour, how dense and how fast (percent), the glyphs.
  rnColor: ['color', '#4dff7a'],
  rnDensity: ['range', 100, 50, 200, 5],
  rnSpeed: ['range', 100, 25, 300, 5],
  rnGlyphs: ['choice', 'katakana', ['katakana', 'binary', 'latin']],
  // Spectrogram: its colour map, how fast it flows (percent), the octaves.
  sgColors: ['choice', 'inferno', ['inferno', 'magma', 'viridis', 'ice', 'grey']],
  sgSpeed: ['range', 100, 25, 300, 5],
  sgGrid: ['bool', true],
  // Aurora: its colours, how restless and how high the curtains shine
  // (percent), the lake, the stars.
  auColors: ['choice', 'green', ['green', 'red', 'violet', 'rainbow']],
  auActivity: ['range', 100, 25, 300, 5],
  auGlare: ['range', 100, 50, 150, 5],
  auLake: ['bool', true],
  auStars: ['bool', true],
  // Skyline: its colours, the camera, how far back the rows reach (percent).
  skColors: ['choice', 'classic', ['classic', 'neon', 'ice', 'fire']],
  skCamera: ['choice', 'orbit', ['orbit', 'front', 'above']],
  skHistory: ['range', 70, 25, 100, 5],
  // Galaxy: how many arms, its colours, how fast it turns (percent), the view.
  gxArms: ['choice', '2', ['2', '3', '4', '6']],
  gxColors: ['choice', 'classic', ['classic', 'neon', 'fire', 'ice']],
  gxSpin: ['range', 100, 0, 300, 5],
  gxView: ['choice', 'slant', ['face', 'slant', 'edge']],
  // Demo: plasma or stars behind, the plasma's palette, the copper bars, the
  // scroller, CRT lines.
  dmBack: ['choice', 'plasma', ['plasma', 'stars']],
  dmPalette: ['choice', 'amiga', ['amiga', 'c64', 'neon']],
  dmCopper: ['bool', true],
  dmScroller: ['bool', true],
  dmCrt: ['bool', true],
  // Reactor: its colour, how many rings, how fast they turn (percent).
  rxColor: ['color', '#38e8ff'],
  rxRings: ['range', 10, 4, 16, 1],
  rxSpin: ['range', 100, 0, 300, 5],
  // Hi-Fi: the faceplates' finish, the display's colour, the meters' light,
  // the analyser's peaks.
  hfFinish: ['choice', 'silver', ['silver', 'black']],
  hfDisplay: ['choice', 'teal', ['teal', 'amber', 'blue', 'green']],
  hfMeters: ['choice', 'amber', ['amber', 'white', 'blue']],
  hfPeaks: ['bool', true],
  // Chladni: the plate (square, round, the whole screen), the sand's colour
  // ('notes': the harmony's), how hard it shakes (percent).
  chPlate: ['choice', 'square', ['square', 'round', 'full']],
  chColors: ['choice', 'sand', ['sand', 'gold', 'ice', 'notes']],
  chShake: ['range', 100, 25, 200, 5],
  // Piano Roll: the colours (left and right hand, per note, neon), how fast
  // the roll rises (percent), the sparks.
  prColors: ['choice', 'hands', ['hands', 'rainbow', 'neon']],
  prSpeed: ['range', 100, 25, 300, 5],
  prSparks: ['bool', true],
  // Arcade: which game ('auto': another each song), the colours (the
  // arcade's own, green or amber phosphor), the screen's lines.
  arGame: ['choice', 'auto', ['auto', 'pong', 'breakout', 'invaders']],
  arColors: ['choice', 'arcade', ['arcade', 'green', 'amber']],
  arCrt: ['bool', true],
  // Disco: the colours, the beams, how fast the ball turns (percent).
  dcColors: ['choice', 'disco', ['disco', 'warm', 'cool']],
  dcBeams: ['bool', true],
  dcSpin: ['range', 100, 0, 300, 5],
  // Stained Glass: the window (a pointed arch, a rose, the whole screen),
  // how many panes across, the shafts of light.
  sgWindow: ['choice', 'arch', ['arch', 'rose', 'full']],
  sgPanes: ['range', 11, 6, 24, 1],
  sgRays: ['bool', true],
  // Black Hole: the colours, the view (edge on, slanted, from above), how
  // fast the gas swirls (percent).
  bhColors: ['choice', 'warm', ['warm', 'blue', 'neon']],
  bhView: ['choice', 'edge', ['edge', 'slant', 'above']],
  bhSpin: ['range', 100, 0, 300, 5],
};

// What the app remembers between sessions. Small and flat, read once at start
// and written whenever the window changes something. Some only mean something
// on one of the apps (the window's size on the desktop).
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
  // Whether the lists under the menu's Playlists, Followed Playlists and Your
  // listening trend entries show (the trend lists closed until opened).
  playlistsMenuOpen: true,
  followedMenuOpen: true,
  trendMenuOpen: false,
  // Whether the Shared Playlists section of the Playlists page is open.
  sharedGroupOpen: true,
  // Settings' categories folded shut (their titles), on the computer; and on
  // the phone the category whose screen was open when Settings closed ('' the
  // list), opened again with it.
  settingsCollapsed: [],
  settingsCategory: '',
  // The Music Visualizer's categories folded shut in Settings (their ids).
  vizCollapsed: [],
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
  // The trim editor colours what SponsorBlock's viewers marked in a YouTube
  // video: sponsors yellow, and with sponsorBlockIntros intros, outros and a
  // music video's non-music parts red.
  sponsorBlock: false,
  sponsorBlockIntros: false,
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
  // Their colours: 'rainbow' (each cloud its own) or one of the solid ones
  // (CLOUD_COLORS), and how many there are (percent, 0-100 in steps of 10).
  cloudsColors: 'rainbow',
  cloudsAmount: 50,
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
  // Synthwave's own (its cogwheel): the wireframe's colour (#rrggbb), the
  // floor's bumps, and with them the camera bobbing up and down, the camera
  // tilting and the car tilting, each as strong as its amount (percent,
  // 0-200 in steps of 5).
  synColor: '#9f38fa',
  synBumps: true,
  synBobbing: true,
  synBobbingAmount: 100,
  synCameraTilt: true,
  synCameraTiltAmount: 100,
  synCarTilt: true,
  synCarTiltAmount: 100,
  ...Object.fromEntries(Object.entries(VIZ_OPTIONS).map(([key, [, def]]) => [key, def])),

  // ---- Use a Flow Server ----
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
  // This install of Flow, as the server tells devices apart (made at the
  // first connection; remote.js). Two PCs of the same name are two devices.
  clientId: '',
  // Active Sessions: this one's session is listed for the others on the server
  // to ask to join; requests are accepted without asking; the devices that
  // joined may change this one's volume.
  sessionShare: true,
  sessionAutoAccept: false,
  sessionAllowVolume: false,
  // The output the music plays on ('' for Windows' default), and its name to
  // find it again should its id change (output.js).
  outputDevice: '',
  outputDeviceLabel: '',
  // How long each output's sound is held back, by its name (ms, set by ear;
  // output.js).
  outputDelays: {},
  // Whether those delays apply ("Output delay" in the output menu).
  outputDelayOn: false,
  // Active Sessions: play the host's music on this device too (else remote only).
  sessionPlayHere: false,

  // ---- the phone's own ----
  // Updates (updates.js): a newer Flow found on GitHub ({ version, url, size,
  // page }, or null), and the start not asking about one ("Don't ask again";
  // Settings' Check for Updates still does).
  updateFound: null,
  updateNoPrompt: false,
  // The help about playing with the screen off has shown by itself once.
  batteryHelpShown: false,
};

const EQ_COLORS = ['spectrum', 'rainbow', 'greyscale', 'white', 'red', 'green', 'yellow', 'blue', 'purple', 'black'];
const CLOUD_COLORS = ['rainbow', 'white', 'red', 'green', 'yellow', 'blue', 'purple', 'black'];
// The ones that can be chosen; 'random' picks one of the others each time,
// 'random-<category>' one of a category's (VIZ_CATEGORIES in the desktop's
// visualizer.js).
const VIZ_CATEGORY_IDS = ['equalizers', 'worlds', 'trippy'];
const VISUALIZERS = ['random', ...VIZ_CATEGORY_IDS.map((c) => `random-${c}`), 'bars', 'waveform', 'flow', 'synthwave', 'lightning', 'kaleidoscope', 'liquid', 'mandala', 'halo', 'scope', 'warp', 'inferno', 'ridges', 'fireworks', 'prism', 'orb', 'lava', 'tunnel', 'rain', 'spectrogram', 'aurora', 'skyline', 'galaxy', 'demo', 'reactor', 'hifi', 'chladni', 'pianoroll', 'arcade', 'disco', 'stainedglass', 'blackhole'];

function percent(v, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : fallback;
}

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
  s.playlistsMenuOpen = s.playlistsMenuOpen !== false;
  s.followedMenuOpen = s.followedMenuOpen !== false;
  s.trendMenuOpen = s.trendMenuOpen === true;
  s.sharedGroupOpen = s.sharedGroupOpen !== false;
  s.settingsCollapsed = Array.isArray(s.settingsCollapsed)
    ? [...new Set(s.settingsCollapsed.filter((t) => typeof t === 'string' && t && t.length <= 60))].slice(0, 30)
    : [];
  s.settingsCategory = typeof s.settingsCategory === 'string' ? s.settingsCategory.slice(0, 60) : '';
  s.vizCollapsed = Array.isArray(s.vizCollapsed) ? [...new Set(s.vizCollapsed.filter((c) => VIZ_CATEGORY_IDS.includes(c)))] : [];
  const st = s.sleepTimer;
  const endsAt = st && typeof st === 'object' ? Number(st.endsAt) : NaN;
  const shutdownAt = st && Number.isFinite(Number(st.shutdownAt)) && st.shutdownAt !== null ? Number(st.shutdownAt) : null;
  s.sleepTimer = Number.isFinite(endsAt) ? { endsAt, shutdownAt, ended: st.ended === true } : null;

  s.musicDir = typeof s.musicDir === 'string' ? s.musicDir : '';
  for (const key of ['serverHome', 'serverRemote']) s[key] = typeof s[key] === 'string' ? s[key].trim().slice(0, 300) : '';
  s.serverSecret = typeof s.serverSecret === 'string' ? s.serverSecret : '';
  s.clientId = /^[\w-]{8,64}$/.test(String(s.clientId || '')) ? String(s.clientId) : '';
  for (const key of ['outputDevice', 'outputDeviceLabel']) s[key] = typeof s[key] === 'string' ? s[key].slice(0, 300) : '';
  const delays = s.outputDelays && typeof s.outputDelays === 'object' ? s.outputDelays : {};
  s.outputDelays = Object.fromEntries(Object.entries(delays)
    .filter(([k, v]) => k && k.length <= 300 && Number.isFinite(Number(v)))
    .slice(0, 50)
    .map(([k, v]) => [k, Math.round(Math.max(0, Math.min(1000, Number(v))))]));
  for (const key of ['flashOn', 'serverOn', 'serverMetered', 'useCookies', 'shareCookies', 'sessionAutoAccept', 'sessionAllowVolume', 'sessionPlayHere', 'outputDelayOn',
    'sponsorBlock', 'sponsorBlockIntros', 'updateNoPrompt', 'batteryHelpShown']) s[key] = s[key] === true;
  const found = s.updateFound;
  s.updateFound = found && typeof found === 'object' && /^\d+\.\d+\.\d+$/.test(String(found.version)) && /^https:\/\//.test(String(found.url))
    ? {
      version: String(found.version),
      url: String(found.url).slice(0, 1000),
      size: Math.max(0, Number(found.size) || 0),
      page: /^https:\/\//.test(String(found.page || '')) ? String(found.page).slice(0, 1000) : '',
    }
    : null;
  s.cookiesBrowser = BROWSERS.some((b) => b.id === s.cookiesBrowser) ? s.cookiesBrowser : '';
  for (const key of ['keepMp3', 'crossfade', 'normalize', 'cloudsOn', 'cloudsBass', 'eqOn', 'eqShine',
    'serverKeepFiles', 'serverAutoSync', 'serverHomeOn', 'serverRemoteOn', 'sessionShare',
    'synBumps', 'synBobbing', 'synCameraTilt', 'synCarTilt']) {
    s[key] = s[key] !== false;
  }
  const fade = Math.round(Number(s.crossfadeSeconds) * 10) / 10;
  s.crossfadeSeconds = Number.isFinite(fade) ? Math.min(10, Math.max(0.1, fade)) : DEFAULTS.crossfadeSeconds;
  for (const key of ['cloudsIntensity', 'cloudsBassAmount', 'eqHeight', 'eqVisibility', 'eqShineSpread', 'flashTriggers', 'flashRange']) {
    s[key] = percent(s[key], DEFAULTS[key]);
  }
  if (!EQ_COLORS.includes(s.eqColors)) s.eqColors = DEFAULTS.eqColors;
  if (!CLOUD_COLORS.includes(s.cloudsColors)) s.cloudsColors = DEFAULTS.cloudsColors;
  const amount = Math.round(Number(s.cloudsAmount) / 10) * 10;
  s.cloudsAmount = Number.isFinite(amount) ? Math.min(100, Math.max(0, amount)) : DEFAULTS.cloudsAmount;
  // Nebula is Kaleidoscope now; Aurora Waves gave way to Aurora.
  if (s.visualizer === 'nebula') s.visualizer = 'kaleidoscope';
  if (s.visualizer === 'aurorawaves') s.visualizer = 'aurora';
  if (!VISUALIZERS.includes(s.visualizer)) s.visualizer = DEFAULTS.visualizer;
  s.synColor = /^#[0-9a-f]{6}$/i.test(String(s.synColor)) ? String(s.synColor).toLowerCase() : DEFAULTS.synColor;
  for (const key of ['synBobbingAmount', 'synCameraTiltAmount', 'synCarTiltAmount']) {
    const v = Math.round(Number(s[key]) / 5) * 5;
    s[key] = Number.isFinite(v) ? Math.min(200, Math.max(0, v)) : DEFAULTS[key];
  }
  for (const [key, [kind, def, a, b, step]] of Object.entries(VIZ_OPTIONS)) {
    const v = s[key];
    if (kind === 'color') s[key] = /^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : def;
    else if (kind === 'bool') s[key] = typeof v === 'boolean' ? v : def;
    else if (kind === 'choice') s[key] = a.includes(v) ? v : def;
    else {
      const n = Math.round(Number(v) / step) * step;
      s[key] = v !== null && v !== '' && Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : def;
    }
  }
  return s;
}

/** read(): the saved settings, or null. write(settings): saves them. */
function createSettings({ read, write }) {
  let current = null;

  function load() {
    current = clean(read());
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
      write(next);
    } catch {
      // Losing a remembered volume is not worth interrupting anything for.
    }
    return next;
  }

  /**
   * This install's id, made once: a Flow Server tells devices apart by it, and
   * Local Files songs carry it in their flowid (tags.js).
   */
  function clientId() {
    let id = get('clientId');
    if (!id) {
      id = randomBase64Url(12);
      set({ clientId: id });
    }
    return id;
  }

  return { load, all, get, set, clientId };
}

module.exports = { createSettings, clean, DEFAULTS, EQ_COLORS, CLOUD_COLORS, VISUALIZERS, VIZ_OPTIONS };
