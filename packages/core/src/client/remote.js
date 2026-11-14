'use strict';

// "Use a Flow Server": a Flow Server as the library, for every Flow app.
// createRemote(env) gets what differs between the apps from `env` (files,
// requests, secrets, the device's name, the local library; the desktop's
// is apps/desktop/src/env.js), so this file needs no Node or Electron.
//
//
// The server holds the one true library. The app keeps the last copy it saw
// (server-library.json) so it opens, and plays what it has, without the
// server. Every change made here (a song renamed, a playlist made) goes to the
// server as a command (@flow/core/commands); a change made while the server
// cannot be reached waits in the queue (server-sync.json) and goes once it
// can. What the window shows is the server's library with the waiting
// commands applied on top, so a change shows at once either way.
//
// Only what changed travels (4.3, protocol 2): the copy keeps the library's
// revision, and the server sends what changed since (GET /api/library?since=,
// the answer to the app's own commands, and pushed on the live channel the
// moment it happens). The profile's songs' stats are a copy of their own with
// a revision of their own (GET /api/stats), so a listen never sends the
// library again; its Statistics totals are fetched when Settings shows them,
// the playlists other profiles share by their details when Shared Playlists
// shows (one opened: its songs then). The live channel is also what tells the
// app the server is there: lost, the server is asked once, and without an
// answer the app is offline. Only while the channel cannot open does the app
// ask for changes itself, once a minute.
//
// Favourites (4.3) are a playlist of the profile's own on the server
// (fav-<owner>); the window knows it as 'favourites' (FAV), and the commands
// naming it go with its real id.
//
// The Local Files folder (Music\FlowPlayer) keeps its own library.json, as
// without a server. It is where songs downloaded here wait to go up to the
// server, and where the songs of playlists marked for download are kept. The
// two are tied together by:
//
//   songMap   local song id -> server song id (the same id, mostly)
//   listMap   local playlist id -> server playlist id
//   snapshot  the Local Files library as it was at the last synchronization,
//             so the next one knows what changed there since: songs added or
//             removed by hand (removed ones stay on the server), a playlist
//             made while the server was off.
//   offline   the playlists marked for download (one's own, or followed ones
//             another profile shares); 'all' stands for All Songs: every song
//             of the server, kept in step with it
//   fetched   local songs that are copies downloaded from the server (the
//             rest came from here); only those go when no longer needed
//   kept      server songs downloaded by hand (a song's Download button): needed,
//             like the songs of a playlist marked for download, until
//             the button is clicked again
//   remoteFilled  the Remote address was filled in from the server's Tailscale
//             address once; emptying the field by hand lets it be filled again
//   homeFilled    the same for the Home address, found on the network
//
// Songs the window plays come from a local copy when there is one, else
// straight from the server (renderer: Store.audioSrc).
//
// Trims (Edit): the server cuts its file (POST /api/songs/:id/trim, sent from
// the queue like an upload); a copy here is cut at once, so it is the same
// trim (song.cut). A copy whose cut is not the server's (trimmed on another
// device, or a trim the server did not take) is replaced by the server's
// file.
//
// Several servers (3.6): switching to another server parks all of the above
// for the one left (server-others.json, by server id): its marks for
// download, its ties to the songs here, the changes still waiting for it, the
// profile signed in to. Back with it, they are as they were. Songs that came
// here meanwhile (downloaded from the other one, or added) are held back like
// the songs here before a new server, until the user says they may go up;
// songs gone meanwhile are only forgotten, never deleted on it. A file that
// another server's songs are tied to is never deleted for this one.
//
// Covers (4.3.1): each song's in two sizes into Covers\<server id> (the
// app's covers.js), fetched when the window shows them (thumbnails for the
// lists, several in one request; the 512 x 512 one with the high-res
// setting), the offline songs' in advance; they stay across restarts and
// server switches, one goes when its song is gone from that server.
//
// Statistics (3.6): each profile signed in to here keeps a row in
// tracked-profiles.json (trackedProfiles.js) with its Statistics as the
// window last saw them, listens still waiting to go up included. Removing
// one also drops what of it still waits to go up.
//
// Profiles: people sharing the server's songs, each with their own
// playlists, favourites and stats (@flow/core/profiles). Signing in to one
// gives a token that says which; the server answers with that profile's
// library. The profile (and its PIN, kept encrypted like the server's) is
// signed in to again at every start whenever the token does not say it
// (restoreProfile), which a server reachable from the internet makes the rule
// (its tokens are sessions that end). Each waiting command remembers the profile it was made in and only
// goes (and shows) while signed in to it; the shared ones (a song's names, its
// deletion) go whoever is signed in. A playlist marked for download keeps its
// songs here while another profile is signed in (offlineKeep).

const model = require('../libraryModel');
const { tr } = require('../lang');
// The Default / Shared's id as a song's addedBy (profiles.js DEFAULT_OWNER,
// which loads Node's crypto).
const DEFAULT_OWNER = 'default';
const { applyCommand } = require('../commands');
const { songFileStem } = require('../text');
const { serverBaseUrl: baseUrl, isTailscaleAddress } = require('../address');
const { OfflineError, AuthError, randomHex } = require('./common');
const { unpackCovers } = require('../coverPack');
const { makeLink, parseLink } = require('./share');
const { createTrackedProfiles } = require('./trackedProfiles');
const LibraryPatch = require('../libraryPatch');
const {
  createJournal, within, LIBRARY_SPEC, STATISTICS_SPEC,
} = require('../journalFile');
const { mergeChanges: mergeLibrary, lockRows } = require('./libraryMerge');

/**
 * The client of one app. `env`: settings, library (Local Files), covers,
 * jsonFiles (the client's own JSON files, by name), files, paths, exporter, http,
 * secrets, device, discovery, network; audioQuery: what this app adds when
 * it fetches a song's audio ('vorbis=0': an iPhone, which cannot play Ogg
 * Vorbis, gets such a song as Opus); convertUploads: uploads carry the
 * "Always convert" choice (alwaysMp3, mp3Quality, keepMp3) for the server to
 * convert them by (a phone, which has no ffmpeg; the PC converts its own);
 * streamCovers: the window shows covers straight from the server (the web
 * player, which keeps no files), so none come down here.
 */
function createRemote(env) {
  const {
    settings, library, covers, jsonFiles, files, paths, exporter, http, secrets, device, discovery, network,
  } = env;

  const ALL = model.ALL_SONGS_ID;
  const audioPath = (id) => `/api/songs/${encodeURIComponent(id)}/audio${env.audioQuery ? `?${env.audioQuery}` : ''}`;
  // "All Songs from <profile>": the songs one profile added (song.addedBy).
  const FROM = 'from:';
  // A song here that is not this server's (Downloaded Songs): 'device:' + its Local Files id.
  const DEVICE = 'device:';
  // 2 (4.3): what changed, the stats apart, Favourites as a playlist, pushed changes.
  const PROTOCOL = 2;
  // Only while the live channel is down: the changes asked for this often.
  const POLL_MS = 60000;
  // The window's id of the profile's Favourites playlist (the server's is fav-<owner>).
  const FAV = 'favourites';
  // While on the remote address, how often home is tried again.
  const HOME_RETRY_MS = 2 * 60 * 1000;
  const RETRY_MS = [3000, 5000, 10000, 20000, 30000, 60000];
  const AUTO_SYNC_DELAY = 2500;

  // ---- where it is kept ----

  const CACHE_FILE = 'server-library.json';
  const SYNC_FILE = 'server-sync.json';
  const OTHERS_FILE = 'server-others.json';
  // Before 3.6 only the trims waiting for a server were parked, here.
  const OLD_TRIMS_FILE = 'server-trims.json';

  // The shape of the library copy kept in server-library.json. A copy saved by
  // an older Flow may lack what this one reads (2.7 dropped song.cover), and
  // the server answers "nothing new" while its revision is the same: a copy of
  // another format is shown at start but fetched whole again. Raise it whenever
  // the songs or playlists gain a field the server sends (3: addedBy, profileNames;
  // 4: listening, 3.5; 5: statistics, 3.6; 6: album, genre, subGenre, infoLooked, 3.6.3;
  // 7: a playlist's rules, 4.0; 8: songs without stats, the stats, Statistics
  // and shared playlists' details kept apart, Favourites as a playlist, 4.3;
  // 9: playlist groups, 4.5; 10: shared groups and the groups followed, 4.5.3;
  // 11: a playlist's groups, several, 4.5.3).
  const CACHE_FORMAT = 11;

  function emptySync(serverId = '') {
    return {
      // addresses: where this server answered ({ home, remote }) and its password (encrypted), for Switch server.
      serverId, serverName: '', addresses: { home: '', remote: '', secret: '' }, token: '', profile: null, queue: [], sent: [], songMap: {}, listMap: {}, snapshot: null, held: null, offline: [], offlineKeep: {}, fetched: {}, kept: {}, profilePin: '', remoteFilled: false, homeFilled: false,
      // Logged out while the server could not be reached: it is told at the next connection.
      logoutPending: false,
    };
  }

  function cleanProfile(p) {
    if (!p || typeof p !== 'object' || !p.id) return null;
    // admin, master (3.5): Administration in Settings; createdAt: for the Statistics.
    return {
      id: String(p.id), name: String(p.name || ''), pin: !!p.pin, createdAt: Number(p.createdAt) || 0, admin: !!p.admin, master: !!p.master,
    };
  }

  /** server-sync.json's shape, or a parked server's (server-others.json). */
  function cleanSync(raw) {
    const s = { ...emptySync(), ...(raw && typeof raw === 'object' ? raw : {}) };
    for (const key of ['queue', 'sent', 'offline']) if (!Array.isArray(s[key])) s[key] = [];
    for (const key of ['songMap', 'listMap', 'fetched', 'kept', 'offlineKeep']) if (!s[key] || typeof s[key] !== 'object') s[key] = {};
    s.profile = cleanProfile(s.profile);
    s.held = Array.isArray(s.held) ? s.held.map(String) : null;
    if (s.snapshot && (typeof s.snapshot !== 'object' || !s.snapshot.songs || !s.snapshot.lists)) s.snapshot = null;
    s.serverId = String(s.serverId || '');
    s.serverName = String(s.serverName || '');
    const a = s.addresses && typeof s.addresses === 'object' ? s.addresses : {};
    s.addresses = { home: String(a.home || ''), remote: String(a.remote || ''), secret: String(a.secret || '') };
    return s;
  }

  function loadSync() {
    return cleanSync(jsonFiles.read(SYNC_FILE));
  }

  // The servers parked (server-others.json): { [server id]: { sync, at } }.
  let others = null;

  function loadOthers() {
    if (others) return others;
    const raw = jsonFiles.read(OTHERS_FILE);
    others = {};
    if (raw && typeof raw === 'object') {
      for (const [id, entry] of Object.entries(raw)) {
        if (entry && typeof entry === 'object' && entry.sync) others[id] = { sync: cleanSync({ ...entry.sync, serverId: id }), at: Number(entry.at) || 0 };
      }
    }
    return others;
  }

  function saveOthers() {
    try {
      jsonFiles.write(OTHERS_FILE, loadOthers());
    } catch {
      // Kept in memory; the next save tries again.
    }
  }

  /** A song here that another server's songs are tied to (its copy, or uploaded from here): its file stays. */
  function usedElsewhere(lid) {
    return Object.entries(loadOthers()).some(([id, o]) => id !== sync.serverId && o.sync.songMap[lid]);
  }

  /** A song here downloaded from another server. */
  function copyFromElsewhere(lid) {
    return Object.entries(loadOthers()).some(([id, o]) => id !== sync.serverId && o.sync.fetched[lid]);
  }

  /**
   * The copy kept: { serverId, rev, library, profile, stats, statistics, shared }.
   * stats { rev, owner, songs: { id: stats }, playlistListened }: the profile's
   * (owner: its id, '' the Default); statistics { srev, data } once fetched;
   * shared [details] of the playlists others share, as last fetched.
   */
  function emptyCache(serverId = '') {
    return {
      serverId, rev: -1, library: null, profile: '', stats: emptyStatsCopy(), statistics: null, shared: null,
    };
  }

  function emptyStatsCopy(owner = '') {
    return {
      rev: -1, owner, songs: {}, playlistListened: {},
    };
  }

  function cleanStatsCopy(raw) {
    if (!raw || typeof raw !== 'object') return emptyStatsCopy();
    const songs = {};
    // Locked (4.6): a song's stats are replaced whole, and the row the window is shown holds them as they are.
    for (const [id, st] of Object.entries(raw.songs && typeof raw.songs === 'object' ? raw.songs : {})) songs[id] = LibraryPatch.lock(model.cleanStats(st));
    return {
      rev: Number.isFinite(Number(raw.rev)) ? Number(raw.rev) : -1,
      owner: String(raw.owner || ''),
      songs,
      playlistListened: model.sanitize({ playlistListened: raw.playlistListened }).playlistListened,
    };
  }

  // The copy is saved as its changes (4.3.4, journalFile.js): a star adds a
  // line to server-library.json.log instead of writing the whole copy again.
  // Its songs, playlists and stats are locked rows (4.6): never written to,
  // only replaced (libraryMerge.js, applyStats), so the journal holds the rows
  // themselves to tell what changed, not a copy of the whole.
  const cacheJournal = createJournal(jsonFiles, CACHE_FILE, {
    ...within('library', LIBRARY_SPEC), 'stats.songs': 'map', ...within('statistics.data', STATISTICS_SPEC),
  }, { rows: ['library.songs', 'library.playlists', 'library.sharedPlaylists', 'stats.songs'] });

  /** The details of the playlists others share, locked rows like the copy's. */
  const sharedDetails = (list) => model.sanitize({ sharedPlaylists: list.map((p) => ({ ...p, entries: [], partial: true })) }).sharedPlaylists.map(LibraryPatch.lock);

  function loadCache() {
    const raw = cacheJournal.load();
    if (!raw || typeof raw !== 'object' || !raw.library) return emptyCache();
    // A copy of another format is shown at start but fetched whole again.
    const same = raw.format === CACHE_FORMAT;
    const st = raw.statistics && typeof raw.statistics === 'object' ? raw.statistics : null;
    return {
      serverId: String(raw.serverId || ''),
      rev: same ? Number(raw.rev) : -1,
      library: lockRows(model.sanitize(raw.library)),
      profile: String(raw.profile || ''),
      stats: same ? cleanStatsCopy(raw.stats) : emptyStatsCopy(),
      statistics: same && st ? { srev: Number(st.srev) || 0, owner: String(st.owner || ''), data: model.sanitize({ statistics: st.data }).statistics } : null,
      shared: same && Array.isArray(raw.shared) ? sharedDetails(raw.shared) : null,
    };
  }

  let cache = emptyCache();
  // Shared playlists opened but not followed (4.3): their songs as fetched
  // when opened, for this run only (fetched again at the next open).
  const sharedOpen = new Map();
  let sync = emptySync();
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    cache = loadCache();
    sync = loadSync();
  }

  let syncSaveTimer = null;
  function saveSync() {
    clearTimeout(syncSaveTimer);
    syncSaveTimer = null;
    try {
      jsonFiles.write(SYNC_FILE, sync);
    } catch {
      // Kept in memory; the next save tries again.
    }
  }

  /**
   * Saved within a second, for what changes song after song (the queue while
   * its songs go up): the whole file written after each one held the app up
   * for most of a long upload. Lost in between (the app ended hard), a song
   * that went up is only sent again, and the server answers that it has it.
   */
  function saveSyncSoon() {
    if (syncSaveTimer) return;
    syncSaveTimer = setTimeout(saveSync, 1000);
  }

  function saveCache() {
    try {
      cacheJournal.save({ ...cache, format: CACHE_FORMAT });
    } catch {
      // Only the copy for starting offline; the server still has it all.
    }
  }

  // ---- the passwords and PINs, kept encrypted ----

  const { encrypt, decrypt } = secrets;
  // The server's token. An app whose secrets can keep it (the web player:
  // until Logout or the browser clears it) signs in with it again later,
  // without the password; the others keep it only encrypted.
  const keepToken = secrets.keep || encrypt;

  // ---- talking to the server ----

  // The token this run of Flow signed in with (never read back from disk).
  let runToken = '';

  /** This install's id (settings.clientId): the server tells devices apart by it. */
  const clientId = () => settings.clientId();

  /**
   * One request (env.http.request). `body` may be JSON (`json`) or a file
   * (`file`, streamed up); `saveTo` streams the answer into a file. Resolves
   * { status, json }. Unreachable, timed out or cut off: OfflineError.
   */
  const { request } = http;

  /** A JSON route that must answer 2xx: its body, or an Error saying why not. */
  async function call(pathname, opts = {}) {
    const r = await request(conn.base, pathname, { token: conn.token, ...opts });
    if (r.status === 401) throw new AuthError((r.json && r.json.error) || tr('connection.needsPassword', 'This server needs its password.'));
    if (r.status < 200 || r.status >= 300) throw new Error((r.json && r.json.error) || tr('common.serverAnswered', 'The server answered {status}.', { status: r.status }));
    return r.json;
  }

  // ---- state for the window ----

  // The connection in use: base address, token, which address it is, whether
  // the server knows profiles, whether it downloads songs itself and whether it
  // has Active Sessions (a live channel).
  const conn = {
    base: '', token: '', via: '', name: '', address: '', profiles: false, downloads: false, downloadCheck: false, downloadQueue: false, downloadReview: false, downloadsLive: false, search: false, sessions: false, trim: false, admin: false, pin: false, statistics: false, lyrics: false, ownLyrics: false, lyricsSync: false, smartPlaylists: false, playlistGroups: false, followedInGroups: false, sharedGroups: false, multiGroups: false, pair: false,
  };
  const status = {
    state: 'off', // off | connecting | online | offline | password | error
    message: '',
    transfer: '', // "Uploading 3 of 12: ..." while songs go up or down
    transferUp: false, // the transfer is an upload
    note: '', // why songs wait (a metered connection), or '' 
    syncing: false,
    searching: false, // looking for a server on the network
    lastSync: 0,
    profiles: null, // the server's profiles [{ id, name, pin }]; null: it has none to offer
    live: false, // the live channel is open
    // The admins' rules as they touch this app (3.5): may it make profiles,
    // and are songs others added theirs to delete ('owner': no).
    rules: { createProfiles: true, songDelete: 'anyone' },
  };

  // ---- profiles ----

  // Commands that do the same whoever sends them: the songs are shared.
  const SHARED_TYPES = new Set(['editSong', 'deleteSong', 'setLoudness', 'setDuration', 'trimSong']);

  /** The profile signed in to ('' for none). */
  function currentProfile() {
    return sync.profile ? sync.profile.id : '';
  }

  /**
   * A waiting command goes (and shows) while signed in to the profile it was
   * made in. An upload goes either way (the song is everyone's), but only
   * brings its favourite, stats and playlists into its own profile.
   */
  function mine(c) {
    return SHARED_TYPES.has(c.type) || c.type === 'upload' || (c.profile || '') === currentProfile();
  }

  function newCommand(type, args) {
    return { cid: newCid(), at: Date.now(), type, ...args, profile: currentProfile() };
  }

  let hooks = {
    onView: () => {}, onStatus: () => {}, onNotice: () => {}, onSettings: () => {}, onLive: () => {}, confirmUpload: async () => true,
    askExisting: async () => ({ choice: 'keep', all: false }),
  };
  let view = null;
  // The Statistics' tracked profiles (track(), removeTracked()).
  const tracked = createTrackedProfiles({ jsonFiles });

  /** The addresses to try: an empty one, or one switched off in Settings, is none. */
  function addresses(s = settings.all()) {
    return {
      home: s.serverHomeOn !== false ? s.serverHome : '',
      remote: s.serverRemoteOn !== false ? s.serverRemote : '',
    };
  }

  function active() {
    const s = settings.all();
    const a = addresses(s);
    return !!(s.serverOn && (a.home || a.remote));
  }

  function publicStatus() {
    const s = settings.all();
    return {
      on: active(),
      state: active() ? status.state : 'off',
      message: status.message,
      transfer: status.transfer,
      transferUp: status.transferUp,
      note: status.note,
      syncing: status.syncing,
      searching: status.searching,
      lastSync: status.lastSync,
      via: conn.via,
      name: conn.name,
      address: conn.address,
      base: status.state === 'online' ? conn.base : '',
      token: status.state === 'online' ? conn.token : '',
      queued: sync.queue.filter(mine).length,
      offline: sync.offline.slice(),
      hasSecret: !!s.serverSecret,
      profile: sync.profile,
      profiles: status.profiles,
      profilesSupported: conn.profiles,
      // The server downloads songs itself ("Download (Server)" on Add Songs).
      downloads: status.state === 'online' && conn.downloads,
      // It also searches by a song's name typed instead of a link.
      search: status.state === 'online' && conn.downloads && conn.search,
      // It reads a playlist's link for its Update without downloading anything.
      downloadCheck: status.state === 'online' && conn.downloads && conn.downloadCheck,
      // It keeps several batches per profile, taking turns (4.4, the Server queue).
      downloadQueue: status.state === 'online' && conn.downloads && conn.downloadQueue,
      // A list read waits for its songs to be chosen (4.4.1, the server's checklist).
      downloadReview: status.state === 'online' && conn.downloads && conn.downloadReview,
      // It says on the live channel when its downloads change (4.6): asked for then, not every few seconds.
      downloadsLive: status.state === 'online' && conn.downloads && conn.downloadsLive && status.live,
      // The server cuts its songs' files (Edit's trim).
      trim: status.state === 'online' && conn.trim,
      // Connected through the Tailscale address (away from home).
      tailscale: conn.via === 'remote' && isTailscaleAddress(conn.address),
      // Active Sessions: the server has them, and the live channel is open.
      sessions: status.state === 'online' && conn.sessions,
      // Administration: the server has it and this profile is an admin (or the master).
      admin: status.state === 'online' && conn.admin && !!(sync.profile && sync.profile.admin),
      master: status.state === 'online' && conn.admin && !!(sync.profile && sync.profile.master),
      rules: { ...status.rules },
      live: status.state === 'online' && status.live,
      // Server time minus this machine's, roughly (from the live channel's greeting).
      timeOffset: live.offset,
      clientId: clientId(),
      // Settings' Switch server: the servers used on this device (knownServers).
      servers: knownServers(),
      // The Statistics: the server in use (also while away from it), whether
      // it keeps them (3.6), and every profile tracked here.
      serverId: sync.serverId,
      serverName: sync.serverName,
      statistics: status.state === 'online' && conn.statistics,
      // Smart playlists (4.0): a server from before keeps no rules. Known while
      // it was reached once (the setting is kept while away from it).
      smartPlaylists: !!conn.smartPlaylists,
      // Playlist groups (4.5): the same, for a server from before.
      playlistGroups: !!conn.playlistGroups,
      // Followed playlists in groups too (4.5.1).
      followedInGroups: !!conn.followedInGroups,
      // Groups shared and followed (4.5.3).
      sharedGroups: !!conn.sharedGroups,
      // A playlist in several groups (4.5.3).
      multiGroups: !!conn.multiGroups,
      tracked: tracked.list(),
    };
  }

  let statusTimer = null;
  // The status the window was told last, as text: one that says the same is
  // not told again (every look at the library asks for one, and the window
  // draws its menu and pages again at each).
  let statusTold = '';
  function emitStatus() {
    // Several changes in a row reach the window as one.
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = null;
      const st = publicStatus();
      let text = '';
      try {
        // But for when the server in use was last used: that is always now.
        text = JSON.stringify({ ...st, servers: (st.servers || []).map((s) => (s.current ? { ...s, at: 0 } : s)) });
      } catch {
        // Told anyway.
      }
      if (text && text === statusTold) return;
      statusTold = text;
      hooks.onStatus(st);
    }, 30);
  }

  function setState(state, message = '') {
    status.state = state;
    status.message = message;
    emitStatus();
  }

  // ---- the library the window sees ----

  /**
   * The local copy of each server song in `data` (by its id): the song here
   * tied to it, else one tied to none of this server's songs that the server
   * takes for the same song (as on upload: the same source, or the same names
   * at the same length) and that is cut alike. Such a one (held back while
   * the server has it already, a copy of another server's) only counts, plays
   * and is deleted here as its copy: nothing goes up or comes down for it.
   */
  function localCopies(data = getView()) {
    const local = library.get();
    const byServer = new Map();
    const loose = [];
    for (const s of local.songs) {
      const sid = sync.songMap[s.id];
      if (!sid) loose.push(s);
      else if (!byServer.has(sid)) byServer.set(sid, s);
    }
    if (!loose.length) return byServer;
    const same = model.sameSongIn(data.songs.filter((x) => !byServer.has(x.id)));
    for (const s of loose) {
      const hit = same(s);
      if (hit && !byServer.has(hit.id) && (hit.cut || '') === (s.cut || '')) byServer.set(hit.id, s);
    }
    return byServer;
  }

  /**
   * A queued upload as the song it will become, for the window: added by the
   * profile signed in, as the server will have it.
   */
  function uploadAsAddSong(cmd, localById = null) {
    const local = localById ? localById.get(cmd.localId) : model.songById(library.get(), cmd.localId);
    if (!local) return null;
    return { type: 'addSong', at: cmd.at, playlistIds: cmd.playlistIds, song: { ...local, id: cmd.songId, addedBy: currentProfile() || DEFAULT_OWNER } };
  }

  // Commands counted in the stats (and the Statistics totals), not the library.
  const LISTENS = new Set(['recordListen', 'recordAwayListen']);

  /** The stats copy is the signed-in profile's. */
  const statsOurs = () => cache.stats.owner === currentProfile() && cache.stats.rev >= 0;
  /** The Statistics totals kept are the signed-in profile's. */
  const statisticsOurs = () => !!cache.statistics && cache.statistics.owner === currentProfile();

  /**
   * A listen the copy has not heard yet, shown at once: in its song's stats
   * and the time listened to its list (`song`), and in the Statistics
   * totals (`totals`), each only where the copy lacks it.
   */
  function previewListen(d, c, { song, totals }) {
    if (!song && !totals) return;
    const at = c.type === 'recordListen' ? d.songs.findIndex((x) => x.id === String(c.songId)) : -1;
    const s = at >= 0 ? d.songs[at] : null;
    if (c.type === 'recordListen' && !s) return;
    const target = {
      ...model.emptyLibrary(),
      songs: s ? [song ? s : { ...s, stats: { ...s.stats } }] : [],
      playlists: song ? d.playlists : [],
      sharedPlaylists: song ? d.sharedPlaylists : [],
      follows: d.follows,
      groupFollows: d.groupFollows,
      groupSkips: d.groupSkips,
      sharedGroups: d.sharedGroups,
      playlistListened: song ? d.playlistListened : {},
      statistics: totals ? d.statistics : model.emptyLibrary().statistics,
    };
    try {
      applyCommand(target, c);
    } catch {
      // The server will say.
    }
    // The song as counted: a locked row was counted on a copy put in its place there (4.6).
    if (s && song && target.songs[0] && target.songs[0] !== s) d.songs[at] = target.songs[0];
  }

  /**
   * The playlists others share, for the window: those followed (with their
   * songs; also those in a followed group, 4.5.3), then the rest by their details.
   */
  function sharedForView(d, lib) {
    const names = d.profileNames || {};
    const followed = model.followedIds(d);
    // A profile renamed: its name as the library has it now. The rows are the
    // copy's own, locked (4.6): another one only where the name differs.
    const named = (p) => (names[p.ownerId] && names[p.ownerId] !== p.ownerName ? { ...p, ownerName: names[p.ownerId] } : p);
    const out = [];
    const have = new Set();
    for (const p of lib.sharedPlaylists || []) {
      if (!followed.has(p.id)) continue;
      have.add(p.id);
      out.push(named(LibraryPatch.lock(p)));
    }
    for (const p of cache.shared || []) {
      if (have.has(p.id)) continue;
      have.add(p.id);
      // Opened: with its songs; else by its details (no entries).
      out.push(named(LibraryPatch.lock(sharedOpen.get(p.id) || p)));
    }
    for (const g of d.sharedGroups || []) if (names[g.ownerId]) g.ownerName = names[g.ownerId];
    return out;
  }

  // The rows the window is shown, kept between looks (4.6). A song there is
  // the copy's song with the profile's stats of it, its star and the file of
  // its copy here; while those are the same, so is the row made of them
  // (locked). So a change makes the rows it touches anew and no others, and
  // the window's channel tells a row that stayed by its being the same one,
  // without a copy of the view to compare with (viewChannel.js). A change
  // tried on the view (a waiting command, one made in the window) is made to
  // a copy put in a locked row's place (libraryModel.js), so the rows kept
  // here stay as the copy has them.
  //   shownOf   the copy's row -> { st, star, row }: what its shown row was made of
  //   madeOf    a shown row -> the copy's row it was made of
  //   deviceOf  a Local Files row (locked) -> { servers, row }: its Downloaded Songs row
  const shownOf = new WeakMap();
  const madeOf = new WeakMap();
  const deviceOf = new WeakMap();
  const VIEW_ROWS = new Set(['songs', 'playlists', 'sharedPlaylists']);

  function buildView() {
    const lib = cache.library || model.emptyLibrary();
    // Everything but the rows: a copy of the window's own, to change freely (commands tried on it).
    const d = {};
    for (const [k, v] of Object.entries(lib)) d[k] = VIEW_ROWS.has(k) ? null : LibraryPatch.clone(v);
    // The profile's own stats and time listened to each list (kept apart, 4.3).
    const st = statsOurs() ? cache.stats : null;
    // Favourites: the window's 'favourites', and each song's star from it.
    let fav = null;
    d.playlists = lib.playlists.map((p) => {
      if (!p.favourites || fav) return LibraryPatch.lock(p);
      const made = shownOf.get(p);
      fav = made ? made.row : LibraryPatch.lock({ ...p, id: FAV, name: 'Favourites' });
      if (!made) shownOf.set(p, { row: fav });
      return fav;
    });
    const starred = new Map((fav ? fav.entries : []).map((e) => [e.songId, e.addedAt]));
    const own = st ? st.songs : null;
    d.songs = lib.songs.map((c) => {
      const mine = own ? own[c.id] : undefined;
      const star = starred.get(c.id) || null;
      const made = shownOf.get(c);
      if (made && made.st === mine && made.star === star) return made.row;
      // The file of its copy here is set below (it goes by every song shown): until then the one it had.
      const row = LibraryPatch.lock({
        ...c, stats: mine || model.emptyStats(), favouriteAt: star, file: made ? made.row.file : '',
      });
      shownOf.set(c, { st: mine, star, row });
      madeOf.set(row, c);
      return row;
    });
    d.playlistListened = st ? { ...st.playlistListened } : {};
    d.statistics = statisticsOurs() ? JSON.parse(JSON.stringify(cache.statistics.data)) : model.emptyLibrary().statistics;
    d.sharedPlaylists = sharedForView(d, lib);
    // Sent but not in the copy yet (its answer came before the library did),
    // then everything still waiting.
    // The songs here by id, made when the first upload waiting asks for one.
    let localById = null;
    const apply = (c) => {
      if (c.type === 'upload' && !localById) localById = new Map(library.get().songs.map((s) => [s.id, s]));
      const cmd = c.type === 'upload' ? uploadAsAddSong(c, localById) : c;
      if (!cmd) return;
      try {
        applyCommand(d, cmd);
      } catch {
        // The server will say what was wrong with it.
      }
    };
    const newer = (x, rev) => !(Number(x.srev) <= rev);
    for (const x of sync.sent) {
      if (LISTENS.has(x.cmd.type)) {
        previewListen(d, x.cmd, { song: !st || newer(x, cache.stats.rev), totals: statisticsOurs() && newer(x, cache.statistics.srev) });
      } else if (x.rev > cache.rev) apply(x.cmd);
    }
    for (const c of sync.queue.filter(mine)) {
      if (LISTENS.has(c.type)) previewListen(d, c, { song: true, totals: statisticsOurs() });
      else apply(c);
    }
    const copies = localCopies(d);
    const shown = new Set();
    for (let i = 0; i < d.songs.length; i += 1) {
      const s = d.songs[i];
      const copy = copies.get(s.id);
      const file = copy ? copy.file : '';
      if (copy) shown.add(copy.id);
      if (s.file === file) continue;
      // A row a waiting change made is the view's own to write to.
      if (!Object.isFrozen(s)) {
        s.file = file;
        continue;
      }
      // A kept row whose copy here came, went or moved: another in its place, kept for its song from now.
      const row = LibraryPatch.lock({ ...s, file });
      d.songs[i] = row;
      const c = madeOf.get(s);
      const made = c ? shownOf.get(c) : null;
      if (made && made.row === s) {
        made.row = row;
        madeOf.set(row, c);
      }
    }
    d.deviceSongs = deviceSongs(shown);
    d.ignoredFiles = [];
    view = d;
    track(d);
    return d;
  }

  // ---- the Statistics' tracked profiles ----

  /** The profile signed in to gets its row brought up to date from the window's library `d`. */
  function track(d) {
    const p = sync.profile;
    if (!p || !sync.serverId || !cache.library || cache.serverId !== sync.serverId || cache.profile !== p.id) return;
    const online = status.state === 'online';
    const row = {
      serverId: sync.serverId,
      serverName: sync.serverName || conn.name,
      profileId: p.id,
      profileName: p.name,
      createdAt: p.createdAt,
      addedSongs: d.songs.filter((s) => s.addedBy === p.id).length,
    };
    // Its totals once fetched (4.3: when Settings shows them); until then the row keeps its own.
    if (statisticsOurs()) row.statistics = d.statistics;
    // Whether it keeps Statistics is only known while connected.
    if (online) row.supported = !!conn.statistics;
    if (tracked.update(row, { online })) emitStatus();
  }

  /**
   * Removes a tracked profile, with what of it still waits to go up to its
   * server (listens, playlist changes; not uploads or a song's shared
   * changes). Not the one signed in to.
   */
  function removeTracked(serverId, profileId) {
    if (serverId === sync.serverId && profileId === currentProfile()) throw new Error(tr('connection.profiles.inUse', 'The profile in use cannot be removed. Log out of it first.'));
    const ours = (c) => (c.profile || '') === profileId && c.type !== 'upload' && !SHARED_TYPES.has(c.type);
    if (serverId === sync.serverId) {
      sync.queue = sync.queue.filter((c) => !ours(c));
      saveSync();
    } else {
      const o = loadOthers()[serverId];
      if (o) {
        o.sync.queue = o.sync.queue.filter((c) => !ours(c));
        saveOthers();
      }
    }
    tracked.remove(serverId, profileId);
    emitStatus();
  }

  /**
   * Downloaded Songs (3.6): the songs here that are not this server's (copies
   * of another server's, songs not uploaded), as songs of their own with ids
   * of their own (DEVICE + the Local Files id). servers: the other servers
   * they are on, by name (none: the file here is the only copy).
   */
  function deviceSongs(shown) {
    const on = new Map();
    for (const [id, o] of Object.entries(loadOthers())) {
      if (id === sync.serverId) continue;
      for (const lid of Object.keys(o.sync.songMap)) {
        if (!on.has(lid)) on.set(lid, []);
        on.get(lid).push(o.sync.serverName || 'Flow Server');
      }
    }
    return library.get().songs.filter((s) => !shown.has(s.id)).map((s) => {
      const servers = on.get(s.id) || [];
      // A Local Files row that is locked stays as it is until another takes
      // its place (4.6): so does the row made of it, while its servers do.
      if (!Object.isFrozen(s)) {
        return {
          ...LibraryPatch.clone(s), id: DEVICE + s.id, localId: s.id, isDevice: true, servers,
        };
      }
      const key = servers.join('\n');
      const made = deviceOf.get(s);
      if (made && made.servers === key) return made.row;
      const row = LibraryPatch.lock({
        ...s, id: DEVICE + s.id, localId: s.id, isDevice: true, servers,
      });
      deviceOf.set(s, { servers: key, row });
      return row;
    });
  }

  let viewTimer = null;
  // The window is sent only what changed (main.js, client/viewChannel.js):
  // a change it does not show (a cover written into a song's file) sends nothing.
  function refreshView() {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(() => {
      viewTimer = null;
      if (!active()) return;
      hooks.onView(buildView());
      emitStatus();
    }, 20);
  }

  function getView() {
    return view || buildView();
  }

  /**
   * A view's songs by their id, as they are now: for a pass over the songs
   * here that asks for the server's song of each (searched one by one, a few
   * thousand songs cost millions of looks each time).
   */
  function songsById(v) {
    return new Map(v.songs.map((s) => [s.id, s]));
  }

  // ---- connecting ----

  let pollTimer = null;
  let retryTimer = null;
  let retryStep = 0;
  let connecting = null;
  let connectingGen = -1;
  let lastHomeTry = 0;
  let generation = 0; // bumped on every reconfigure: late answers of an old connection are ignored

  /**
   * A different server than the one the copy and the queue belong to: the one
   * left is parked, and this one's own comes back (or starts afresh).
   */
  function adoptServer(id) {
    if (sync.serverId === id) return;
    const hadOther = !!sync.serverId;
    const parked = loadOthers();
    if (sync.serverId) parked[sync.serverId] = { sync, at: Date.now() };
    const back = parked[id];
    delete parked[id];
    // A look at Local Files asked for while with the old server would treat
    // every song here as new to this one, and send them all without asking.
    clearTimeout(autoSyncTimer);
    // The addresses were filled in (or not) for the settings, whichever server.
    const filled = { homeFilled: sync.homeFilled, remoteFilled: sync.remoteFilled };
    sync = { ...(back ? back.sync : emptySync(id)), ...filled, serverId: id };
    // Trims parked by a Flow from before 3.6.
    const oldTrims = jsonFiles.read(OLD_TRIMS_FILE);
    if (oldTrims && Array.isArray(oldTrims[id])) {
      sync.queue.push(...oldTrims[id]);
      delete oldTrims[id];
      try {
        jsonFiles.write(OLD_TRIMS_FILE, oldTrims);
      } catch {
        // Taken again next time; a trim sent twice is skipped by the server.
      }
    }
    if (back) heldSinceAway = holdAwayChanges();
    cache = emptyCache(id);
    saveOthers();
    saveSync();
    saveCache();
    if (back) {
      hooks.onNotice(back.sync.serverName
        ? tr('connection.notice.backWith', 'Back with "{server}": its playlists marked for download and its waiting changes are as you left them.', { server: back.sync.serverName })
        : tr('connection.notice.backWith.unnamed', 'Back with this Flow Server: its playlists marked for download and its waiting changes are as you left them.'), 'info');
    }
    else if (hadOther) hooks.onNotice(tr('connection.notice.differentServer', 'This is a different Flow Server than before. Your Local Files will be synchronized with it.'), 'info');
  }

  // Songs held back on coming back to a server (holdAwayChanges): asked about once connected.
  let heldSinceAway = 0;

  /**
   * Back with a parked server: what happened in Local Files while another one
   * was in use is not taken as changes for this one. Songs that came meanwhile
   * are held back (asked about, like the songs here before a new server);
   * songs and playlists gone meanwhile are only forgotten. Resolves how many
   * songs it held back.
   */
  function holdAwayChanges() {
    if (!sync.snapshot) return 0;
    const local = library.get();
    const localIds = new Set(local.songs.map((s) => s.id));
    const listIds = new Set(local.playlists.map((p) => p.id));
    for (const lid of Object.keys(sync.snapshot.songs)) {
      if (localIds.has(lid)) continue;
      delete sync.snapshot.songs[lid];
      delete sync.songMap[lid];
      delete sync.fetched[lid];
      sync.queue = sync.queue.filter((c) => !(c.type === 'upload' && c.localId === lid));
    }
    for (const lpid of Object.keys(sync.snapshot.lists)) {
      if (listIds.has(lpid)) continue;
      delete sync.snapshot.lists[lpid];
      delete sync.listMap[lpid];
    }
    const held = new Set(sync.held || []);
    const came = local.songs.filter((s) => !sync.snapshot.songs[s.id] && !held.has(s.id) && !sync.songMap[s.id]).map((s) => s.id);
    if (came.length) sync.held = [...held, ...came];
    return came.length;
  }

  async function login(base) {
    const s = settings.all();
    const pw = decrypt(s.serverSecret);
    if (!pw) throw new AuthError(tr('connection.needsPassword.enterIt', 'This server needs its password. Enter it under "Server Password".'));
    const r = await request(base, '/api/login', { method: 'POST', json: { password: pw, device: device.name(), client: clientId() }, timeout: 20000 });
    if (r.status === 401) throw new AuthError(tr('connection.wrongPassword', 'Wrong password.'));
    if (r.status !== 200 || !r.json || !r.json.token) throw new Error((r.json && r.json.error) || tr('connection.signInRefused', 'The server did not let Flow sign in.'));
    sync.token = keepToken(r.json.token);
    runToken = r.json.token;
    saveSync();
    return r.json.token;
  }

  /**
   * The profile this device was signed in to, signed in to again when the token
   * in use is not (the password gave a new token, the server forgot the old one,
   * or it is a server that keeps no tokens). With its PIN, as kept encrypted
   * from the last time it was typed. A PIN the server refuses is forgotten, not
   * tried at every connection. Resolves the token to use.
   */
  async function restoreProfile(base, token) {
    const was = sync.profile;
    if (!was && sync.logoutPending) {
      try {
        const r = await request(base, '/api/profiles/logout', { method: 'POST', json: {}, token, timeout: 15000 });
        if (r.status < 500) {
          sync.logoutPending = false;
          saveSync();
        }
      } catch {
        // Told at the next connection.
      }
    }
    if (!was) return token;
    try {
      const list = await request(base, '/api/profiles', { token, timeout: 15000 });
      if (list.status !== 200 || !list.json || list.json.current === was.id) return token;
      const pin = was.pin ? decrypt(sync.profilePin) : '';
      if (was.pin && !pin) return token;
      const r = await request(base, '/api/profiles/login', {
        method: 'POST', json: { profileId: was.id, pin, device: device.name(), client: clientId() }, token, timeout: 20000,
      });
      if (r.status === 200 && r.json && r.json.token) {
        sync.token = keepToken(r.json.token);
        runToken = r.json.token;
        saveSync();
        return r.json.token;
      }
      if (r.status === 403 && was.pin) {
        sync.profilePin = '';
        saveSync();
      }
    } catch {
      // Connected without it; the profile can be picked again.
    }
    return token;
  }

  /**
   * A token this app got by signing in without this client: the phone's
   * player signs in again by itself (password, then the same profile) when
   * the server ended the session while the page slept. The server has
   * replaced this app's old token with it, so it is taken over rather than
   * signing in again here (which would end the player's in turn).
   */
  function adoptToken(token) {
    if (!token || token === runToken) return;
    runToken = token;
    sync.token = keepToken(token);
    saveSync();
    if (status.state !== 'online') return;
    conn.token = token;
    // The live channel opened with the old token, which the server no longer knows.
    startLive();
    emitStatus();
  }

  /** Tries home, then remote. Resolves true once online. */
  function connect() {
    // A setting changed while an attempt was under way: that one is void (its
    // answers are ignored), and a new one follows it.
    if (connecting && connectingGen !== generation) return connecting.then(() => connect());
    if (connecting) return connecting;
    const gen = generation;
    connectingGen = gen;
    connecting = (async () => {
      const s = settings.all();
      const own = addresses(s);
      const candidates = [['home', own.home], ['remote', own.remote]].filter(([, a]) => a);
      if (status.state !== 'online') setState('connecting');
      let problem = null;
      for (const [via, address] of candidates) {
        if (gen !== generation) return false;
        let base;
        try {
          base = baseUrl(address);
        } catch {
          problem = problem || ['error', tr('connection.notAnAddress', '"{address}" is not an address Flow understands.', { address })];
          continue;
        }
        let hello;
        try {
          const r = await request(base, '/api/hello', { timeout: via === 'home' ? 2500 : 8000 });
          hello = r.json;
        } catch {
          if (!problem || problem[0] === 'offline') problem = ['offline', tr('common.unreachable', 'The server cannot be reached.')];
          continue;
        }
        if (gen !== generation) return false;
        if (!hello || hello.app !== 'flow-server') {
          problem = ['error', tr('connection.notAFlowServer', '{address} answers, but it is not a Flow Server.', { address })];
          continue;
        }
        if (hello.protocol !== PROTOCOL) {
          problem = ['error', hello.protocol > PROTOCOL
            ? tr('connection.serverNewer', 'The server is newer than this Flow. Update Flow to use it.')
            : tr('connection.serverOlder', 'The server is older than this Flow. Update the Flow Server.')];
          continue;
        }
        adoptServer(String(hello.id || base));
        if (sync.serverName !== String(hello.name || 'Flow Server')) {
          sync.serverName = String(hello.name || 'Flow Server');
          saveSync();
        }
        // Without a password the token only says which profile this is. Where
        // there is one, Flow signs in with it at every start: only a token got
        // in this run counts, never the one kept from the last. Except where
        // the token is kept (keepToken): the server's no to it (the probe)
        // asks for the password.
        let token = hello.password && !secrets.keep ? runToken : decrypt(sync.token);
        try {
          if (hello.password) {
            if (token) {
              // The smallest answer that needs the sign-in.
              const probe = await request(base, '/api/time', { token, timeout: 15000 });
              if (probe.status === 401) token = '';
            }
            if (!token) token = await login(base);
          }
        } catch (err) {
          if (err instanceof AuthError) {
            problem = ['password', err.message];
            break;
          }
          problem = ['offline', err.message];
          continue;
        }
        if (gen !== generation) return false;
        const profiles = Array.isArray(hello.features) && hello.features.includes('profiles');
        const downloads = Array.isArray(hello.features) && hello.features.includes('download');
        const search = Array.isArray(hello.features) && hello.features.includes('search');
        const downloadCheck = Array.isArray(hello.features) && hello.features.includes('downloadCheck');
        const downloadQueue = Array.isArray(hello.features) && hello.features.includes('downloadQueue');
        const downloadReview = Array.isArray(hello.features) && hello.features.includes('downloadReview');
        const downloadsLive = Array.isArray(hello.features) && hello.features.includes('downloadsLive');
        const sessions = Array.isArray(hello.features) && hello.features.includes('sessions');
        const trim = Array.isArray(hello.features) && hello.features.includes('trim');
        const admin = Array.isArray(hello.features) && hello.features.includes('admin');
        const pin = Array.isArray(hello.features) && hello.features.includes('pin');
        const statistics = Array.isArray(hello.features) && hello.features.includes('statistics');
        const lyrics = Array.isArray(hello.features) && hello.features.includes('lyrics');
        const ownLyrics = Array.isArray(hello.features) && hello.features.includes('ownLyrics');
        const lyricsSync = Array.isArray(hello.features) && hello.features.includes('lyricsSync');
        const smartPlaylists = Array.isArray(hello.features) && hello.features.includes('smartPlaylists');
        const pair = Array.isArray(hello.features) && hello.features.includes('pair');
        const playlistGroups = Array.isArray(hello.features) && hello.features.includes('playlistGroups');
        const followedInGroups = Array.isArray(hello.features) && hello.features.includes('followedInGroups');
        const sharedGroups = Array.isArray(hello.features) && hello.features.includes('sharedGroups');
        const multiGroups = Array.isArray(hello.features) && hello.features.includes('multiGroups');
        if (profiles) token = await restoreProfile(base, token);
        if (gen !== generation) return false;
        Object.assign(conn, {
          base, token, via, name: String(hello.name || 'Flow Server'), address, profiles, downloads, downloadCheck, downloadQueue, downloadReview, downloadsLive, search, sessions, trim, admin, pin, statistics, lyrics, ownLyrics, lyricsSync, smartPlaylists, playlistGroups, followedInGroups, sharedGroups, multiGroups, pair,
        });
        if (via === 'remote') lastHomeTry = Date.now();
        rememberAddress(via, address, hello.password);
        if (via === 'home') fillRemote(hello);
        retryStep = 0;
        setState('online');
        try {
          await refresh();
        } catch (err) {
          wentWrong(err);
          return false;
        }
        loadProfiles().catch(() => {});
        schedulePoll();
        startLive();
        afterConnect();
        return true;
      }
      if (gen !== generation) return false;
      conn.base = '';
      conn.token = '';
      let [state, message] = problem || ['offline', tr('common.unreachable', 'The server cannot be reached.')];
      if (state === 'offline' && isTailscaleAddress(own.remote)) {
        message = tr('connection.unreachable.tailscale', 'The server cannot be reached. Away from home, Tailscale has to be on at this PC.');
      }
      setState(state, message);
      // A wrong password is not tried over and over; a changed setting tries again.
      if (state !== 'password') scheduleRetry();
      return false;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  /**
   * Connected: the address that answered is this server's (Home or Remote),
   * and so is the password in use when it asks for one. Switch server goes
   * back to it with these.
   */
  function rememberAddress(via, address, needsPassword) {
    const a = sync.addresses;
    const secret = needsPassword ? String(settings.get('serverSecret') || '') : '';
    if (a[via] === address && a.secret === secret) return;
    a[via] = address;
    a.secret = secret;
    saveSync();
  }

  /** The https address a server says it has on the internet, or ''. */
  function publicUrlOf(hello) {
    const url = hello && typeof hello.publicUrl === 'string' ? hello.publicUrl : '';
    if (!/^https:\/\//i.test(url)) return '';
    try {
      return baseUrl(url);
    } catch {
      return '';
    }
  }

  /**
   * Connected at home to a server reachable from away: its address becomes the
   * Remote address, once, and only into an empty field (a typed one stays; one
   * emptied by hand is filled again at the next connection). Its https address on the internet when it has
   * one, which needs nothing on this PC; else its Tailscale IP (not the .ts.net
   * name, which needs MagicDNS).
   */
  function fillRemote(hello) {
    if (!hello || sync.remoteFilled || settings.get('serverRemote')) return;
    let address = publicUrlOf(hello);
    let notice = tr('connection.notice.remoteSet.internet', 'Remote Server set to {address}, the server\'s address on the internet, for when you are away from home.', { address });
    const ts = hello.tailscale;
    if (!address && ts) {
      const port = Math.round(Number(ts.port));
      if (typeof ts.ip !== 'string' || !isTailscaleAddress(ts.ip) || !(port > 0 && port < 65536)) return;
      address = `${ts.ip}:${port}`;
      notice = tr('connection.notice.remoteSet.tailscale', 'Remote Server set to {address}, the server\'s Tailscale address, for when you are away from home. Tailscale has to be on at this PC then too.', { address });
    }
    if (!address) return;
    settings.set({ serverRemote: address });
    sync.remoteFilled = true;
    sync.addresses.remote = address;
    saveSync();
    hooks.onSettings({ serverRemote: address });
    hooks.onNotice(notice, 'info');
  }

  /**
   * Turned on with no Home address: ask the local network for a Flow Server
   * (@flow/core/discovery). Exactly one answering becomes the Home address, once
   * (a box emptied by hand is searched for again); several are told about, none is
   * silent (away from home, or the server is off).
   */
  async function discoverHome() {
    if (status.searching || !settings.get('serverOn') || settings.get('serverHomeOn') === false || settings.get('serverHome') || sync.homeFilled) return;
    status.searching = true;
    emitStatus();
    let found = [];
    try {
      found = await discovery.find();
    } catch {
      found = [];
    } finally {
      status.searching = false;
    }
    // Typed by hand, or turned off, while it looked.
    if (!settings.get('serverOn') || settings.get('serverHome')) {
      emitStatus();
      return;
    }
    if (found.length === 1) {
      const address = discovery.addressOf(found[0]);
      settings.set({ serverHome: address });
      sync.homeFilled = true;
      saveSync();
      hooks.onSettings({ serverHome: address });
      hooks.onNotice(tr('connection.notice.foundOne', 'Found the Flow Server "{server}" on this network. Home Server set to {address}.', { server: found[0].name, address }), 'info');
      reconfigure({ serverHome: address });
      return;
    }
    if (found.length > 1) {
      hooks.onNotice(tr('connection.notice.foundMany', 'Found {count} Flow Servers on this network ({servers}). Enter the one you want as the Home Server.', { count: found.length, servers: found.map((f) => tr('connection.notice.foundMany.entry', '"{server}" at {address}', { server: f.name, address: `${f.ip}:${f.port}` })).join(', ') }), 'info');
    }
    emitStatus();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    const wait = RETRY_MS[Math.min(retryStep, RETRY_MS.length - 1)];
    retryStep += 1;
    retryTimer = setTimeout(() => {
      if (active()) connect();
    }, wait);
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, POLL_MS);
  }

  async function poll() {
    if (!active() || status.state !== 'online') return;
    // On the remote address: back home once it answers again (faster, and it
    // spares the internet connection).
    const s = settings.all();
    if (conn.via === 'remote' && addresses(s).home && Date.now() - lastHomeTry > HOME_RETRY_MS) {
      lastHomeTry = Date.now();
      try {
        const r = await request(baseUrl(s.serverHome), '/api/hello', { timeout: 2500 });
        if (r.json && r.json.app === 'flow-server' && String(r.json.id) === sync.serverId) {
          status.state = 'connecting';
          connect();
          return;
        }
      } catch {
        // Still away from home.
      }
    }
    // The live channel brings the changes; only without it are they asked for (4.3).
    if (!status.live) {
      try {
        const changed = await refresh();
        if (sync.queue.length) flushSoon();
        if (changed) afterServerChange();
      } catch (err) {
        wentWrong(err);
        return;
      }
    }
    // With the live channel open at home there is nothing to look for: it
    // brings the changes, and its loss starts this again (4.6).
    if (!status.live || conn.via === 'remote') schedulePoll();
  }

  /** A request failed: offline (try again soon), or signed out. */
  function wentWrong(err) {
    if (err instanceof AuthError || err instanceof OfflineError) stopLive();
    if (err instanceof AuthError) {
      sync.token = '';
      runToken = '';
      saveSync();
      conn.token = '';
      setState('connecting');
      connect();
      return;
    }
    if (err instanceof OfflineError) {
      clearTimeout(pollTimer);
      conn.base = '';
      setState('offline', tr('common.unreachable', 'The server cannot be reached.'));
      scheduleRetry();
      return;
    }
    hooks.onNotice(err.message, 'error');
  }

  /** The copy is this server's and the signed-in profile's: what changed since its revision can be asked for. */
  const copyOurs = () => !!cache.library && cache.serverId === sync.serverId && cache.profile === currentProfile() && cache.rev >= 0;

  /**
   * What changed on the server since the copy (4.3: GET /api/library?since=,
   * the whole library when there is no copy or it is too old), and the
   * profile's stats since theirs. Resolves true when the library changed.
   */
  async function refresh() {
    // `as`: the profile the copy is of. Signed in to another since, the server
    // sends the whole library even when nothing changed.
    const since = cache.library && cache.serverId === sync.serverId ? `?since=${cache.rev}&as=${encodeURIComponent(cache.profile)}` : '';
    const r = await request(conn.base, `/api/library${since}`, { token: conn.token, timeout: 60000 });
    if (r.status === 401) throw new AuthError(tr('connection.signedOut', 'Signed out.'));
    if (r.status === 204) {
      await refreshStats();
      return false;
    }
    if (r.status !== 200 || !r.json || (r.json.full && !r.json.library)) throw new Error((r.json && r.json.error) || tr('common.serverAnswered', 'The server answered {status}.', { status: r.status }));
    const profile = cleanProfile(r.json.profile);
    const before = sync.profile;
    if (before && (!profile || profile.id !== before.id)) {
      // Deleted or signed out on the server, by another device.
      hooks.onNotice(tr('connection.notice.profileGone', 'You are no longer logged in as "{profile}": the profile was deleted or signed out on the server.', { profile: before.name }), 'info');
      loadProfiles().catch(() => {});
    }
    sync.profile = profile;
    if (r.json.rules && typeof r.json.rules === 'object') {
      status.rules = { ...status.rules, songDelete: r.json.rules.songDelete === 'owner' ? 'owner' : 'anyone' };
    }
    if (r.json.full) {
      const owner = currentProfile();
      cache = {
        ...cache,
        serverId: sync.serverId,
        rev: Number(r.json.rev),
        library: lockRows(model.sanitize(r.json.library)),
        profile: owner,
        // Another profile's (or another server's) are of no use now.
        stats: cache.stats.owner === owner && cache.serverId === sync.serverId ? cache.stats : emptyStatsCopy(owner),
        statistics: statisticsOurs() && cache.serverId === sync.serverId ? cache.statistics : null,
        shared: cache.profile === owner && cache.serverId === sync.serverId ? cache.shared : null,
      };
    } else {
      mergeChanges(r.json);
    }
    await refreshStats();
    pruneSent();
    saveCache();
    saveSync();
    refreshView();
    return true;
  }

  /**
   * What changed since the copy's revision, merged into it: songs and
   * playlists (its own, Favourites too) new or changed, those gone, the
   * follows, the groups (4.5), the playlists followed (with their songs; also
   * those of a followed group), the groups the others share and those
   * followed (4.5.3), the profiles' names.
   */
  function mergeChanges(c) {
    // Only the rows that came are made anew; the rest stay the rows they were (4.6, libraryMerge.js).
    cache.library = mergeLibrary(cache.library || model.emptyLibrary(), c);
    // A song gone takes the stats kept of it along (they stayed in the copy and its file for good):
    // another map without them (4.6: the one kept is locked once saved).
    const gone = (c.deletedSongs || []).map(String).filter((id) => cache.stats.songs[id] !== undefined);
    if (gone.length) {
      const songs = { ...cache.stats.songs };
      for (const id of gone) delete songs[id];
      cache.stats = { ...cache.stats, songs };
    }
    cache.rev = Number(c.rev);
  }

  /**
   * Changes the server sent on its own (the live channel) or with an answer:
   * merged when they start where the copy is (or before it, overlapping),
   * skipped when the copy has them already, and the copy asked for afresh
   * when some are missing in between (or the server says too many are).
   */
  function takeChanges(c) {
    if (!c || !copyOurs()) return false;
    if (c.stale || Number(c.from) > cache.rev) {
      refresh().catch(wentWrong);
      return false;
    }
    if (Number(c.rev) <= cache.rev) return false;
    mergeChanges(c);
    pruneSent();
    saveCache();
    saveSync();
    refreshView();
    return true;
  }

  // ---- the profile's stats (4.3) ----

  /** The profile's stats since the copy's (all of them for a copy of another profile's, or none). */
  async function refreshStats() {
    const owner = currentProfile();
    const since = cache.stats.owner === owner && cache.stats.rev >= 0 ? `?since=${cache.stats.rev}` : '';
    const s = await call(`/api/stats${since}`, { timeout: 60000 });
    applyStats(s, owner);
  }

  function applyStats(s, owner = currentProfile()) {
    if (!s) return;
    if (s.full) cache.stats = cleanStatsCopy({ rev: s.rev, owner, songs: s.songs, playlistListened: s.playlistListened });
    else {
      const clean = cleanStatsCopy({ songs: s.songs, playlistListened: s.playlistListened });
      // Another map with them in (4.6: the one kept is locked once saved).
      cache.stats.songs = { ...cache.stats.songs, ...clean.songs };
      if (s.playlistListened) cache.stats.playlistListened = clean.playlistListened;
      cache.stats.rev = Number(s.rev);
    }
  }

  /** Stats pushed or answered: taken as the library's changes are (takeChanges). */
  function takeStats(s) {
    if (!s || !statsOurs()) return false;
    if (s.stale || Number(s.from) > cache.stats.rev) {
      refreshStats().then(() => {
        pruneSent();
        saveCache();
        refreshView();
      }).catch(() => {});
      return false;
    }
    if (Number(s.rev) <= cache.stats.rev) return false;
    applyStats(s);
    pruneSent();
    saveCache();
    refreshView();
    return true;
  }

  /**
   * The sent commands the copy has now go: a change once the library's
   * revision reaches its answer's, a listen once the stats (and the
   * Statistics totals, when kept) have it.
   */
  function pruneSent() {
    const before = sync.sent.length;
    sync.sent = sync.sent.filter((x) => {
      if (!LISTENS.has(x.cmd.type)) return x.rev > cache.rev;
      const srev = Number(x.srev);
      if (!Number.isFinite(srev)) return false;
      return srev > cache.stats.rev || (statisticsOurs() && srev > cache.statistics.srev);
    });
    if (sync.sent.length !== before) saveSync();
  }

  /** The profile's Statistics totals (4.3: fetched when Settings shows them), kept for when the server is away. */
  async function loadStatistics() {
    if (!active() || status.state !== 'online' || !conn.statistics) return null;
    const r = await call('/api/statistics', { timeout: 30000 });
    cache.statistics = { srev: Number(r.srev) || 0, owner: currentProfile(), data: model.sanitize({ statistics: r.statistics }).statistics };
    pruneSent();
    saveCache();
    buildView();
    hooks.onView(view);
    emitStatus();
    return cache.statistics.data;
  }

  // ---- the playlists others share (4.3) ----

  /** Their details (name, owner, number of songs, length), fetched when Shared Playlists shows them. */
  async function loadShared() {
    if (!active() || status.state !== 'online' || !conn.profiles) return null;
    const r = await call('/api/shared', { timeout: 30000 });
    cache.shared = sharedDetails(r.playlists || []);
    saveCache();
    refreshView();
    return cache.shared;
  }

  /** One of them with its songs, opened (fetched at every open; one followed is kept in step instead). */
  async function openShared(id) {
    if (!active() || status.state !== 'online' || !conn.profiles) return null;
    let r;
    try {
      r = await call(`/api/shared/${encodeURIComponent(id)}`, { timeout: 30000 });
    } catch (err) {
      sharedOpen.delete(id);
      if (cache.shared) cache.shared = cache.shared.filter((p) => p.id !== id);
      refreshView();
      throw err;
    }
    // Cleaned on its own against the copy's songs (4.6: not the whole library made anew for it), a locked row.
    const have = new Set((cache.library || model.emptyLibrary()).songs.map((s) => s.id));
    const p = r.playlist && r.playlist.id ? LibraryPatch.lock(model.cleanSharedPlaylist(r.playlist, (sid) => have.has(sid))) : null;
    if (p) sharedOpen.set(id, p);
    refreshView();
    return p || null;
  }

  // ---- commands ----

  function newCid() {
    return randomHex(8);
  }

  /**
   * A change made in the window: tried on the window's copy first (a wrong one,
   * a taken name, fails here with its reason and is never sent), then queued
   * and sent. Resolves what the change resolves to (a new playlist, a count).
   */
  function command(type, args) {
    const cmd = newCommand(type, args);
    const result = applyCommand(getView(), cmd);
    sync.queue.push(cmd);
    saveSync();
    refreshView();
    flushSoon();
    return result.value;
  }

  /** The server's id of the profile's Favourites playlist ('' without one). */
  function favouritesId() {
    const p = cache.library && cache.library.playlists.find((x) => x.favourites);
    return p ? p.id : '';
  }

  /** A command as the server takes it: the window's 'favourites' as the server's id of that playlist. */
  function outgoing(c) {
    const real = favouritesId();
    if (!real) return c;
    const fix = (id) => (id === FAV ? real : id);
    const out = { ...c };
    if (out.playlistId !== undefined) out.playlistId = fix(out.playlistId);
    if (Array.isArray(out.playlistIds)) out.playlistIds = out.playlistIds.map(fix);
    return out;
  }

  /**
   * Every id a command refers to, renamed (an upload the server gave another
   * id); many at once as a Map (from -> to), in one go through the queue.
   */
  function renameSongId(from, to) {
    const map = from instanceof Map ? from : new Map([[from, to]]);
    if (!map.size) return;
    const now = (id) => (map.has(id) ? map.get(id) : id);
    const fix = (c) => {
      if (!c) return;
      if (map.has(c.songId)) c.songId = map.get(c.songId);
      if (Array.isArray(c.songIds) && c.songIds.some((x) => map.has(x))) c.songIds = c.songIds.map(now);
    };
    for (const c of sync.queue) fix(c);
    for (const x of sync.sent) fix(x.cmd);
    for (const lid of Object.keys(sync.songMap)) {
      const sid = sync.songMap[lid];
      if (map.has(sid)) sync.songMap[lid] = map.get(sid);
    }
  }

  // ---- songs the server has already ----
  //
  // A song here that the server has (found in the copy of its library as the
  // server itself would find it for an upload) is not sent to be told so:
  // with a few thousand songs here and there (Flow installed again, its music
  // folder still full) every file went up, to be thrown away by the server.

  /**
   * The server's song for a song here, as the server finds it on upload (its
   * existingFor: the song of that id, of the same source, or of the same
   * names at the same length): a function (song here, the id it goes up
   * under) -> the server's song or null. Null itself while the copy of its
   * library is not the server's as it is now (offline, another profile's):
   * then only the server can say.
   */
  function serverSongFinder() {
    if (status.state !== 'online' || !copyOurs()) return null;
    const songs = cache.library.songs;
    const byId = new Map(songs.map((s) => [s.id, s]));
    const same = model.sameSongIn(songs);
    return (local, id = '') => byId.get(id) || same(local) || null;
  }

  /**
   * The uploads waiting for songs the server has under the same names: taken
   * off the queue, each song here tied to the server's as an upload answered
   * "already here" ties it. Not saved (the caller does). Returns what was
   * tied: [{ local, serverId }], for afterTied. One the server has under
   * other names stays queued: it is asked about when its turn comes
   * (uploadOne), without its file being sent either.
   */
  function tieKnownUploads() {
    if (!sync.queue.some((c) => c.type === 'upload' && mine(c) && !c.onExisting)) return [];
    const find = serverSongFinder();
    if (!find) return [];
    const localById = new Map(library.get().songs.map((s) => [s.id, s]));
    const tied = [];
    const done = new Set();
    const renamed = new Map();
    for (const c of sync.queue) {
      if (c.type !== 'upload' || !mine(c) || c.onExisting) continue;
      const local = localById.get(c.localId);
      const there = local ? find(local, c.songId) : null;
      if (!there || !model.sameNames(there, local)) continue;
      done.add(c.cid);
      if (there.id !== c.songId) renamed.set(c.songId, there.id);
      sync.songMap[c.localId] = there.id;
      tied.push({ local, serverId: there.id });
    }
    if (!tied.length) return tied;
    sync.queue = sync.queue.filter((c) => !done.has(c.cid));
    renameSongId(renamed);
    return tied;
  }

  /**
   * What follows an upload the server had already, for the songs tied
   * without one: lyrics written here go to the server's song, and the file
   * here goes when "Keep local files after server upload" is off (and no
   * marked playlist needs it). A few at a time, so the app is not held up.
   */
  async function afterTied(tied) {
    const keep = !!settings.get('serverKeepFiles');
    let n = 0;
    for (const { local, serverId } of tied) {
      if (status.state !== 'online' || !active()) return;
      await uploadLyrics(local, serverId);
      if (!keep && !neededOffline(serverId)) await forgetLocal(local.id, { deleteFile: true });
      n += 1;
      if (n % 50 === 0) await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
  }

  let flushTimer = null;
  let flushing = null;
  // While the queue is sent: the server's song for a song here (serverSongFinder), or null.
  let knownSong = null;
  // Songs tied to the server's without an upload (tieKnownUploads) whose follow-up (afterTied) the next flush does.
  const tiedWaiting = [];
  const problems = [];

  /** Changes the server refused and songs that could not go up or down, told once. */
  function reportProblems() {
    if (!problems.length) return;
    const first = problems[0];
    const more = problems.length - 1;
    problems.length = 0;
    hooks.onNotice(more ? tr('connection.notice.andMore', '{notice} (and {count} more)', { notice: first, count: more }) : first, 'error');
  }

  function flushSoon(delay = 50) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flush().catch(() => {});
    }, delay);
  }

  /**
   * Songs may go up and come down now: at home always, away not on a metered
   * connection unless allowed.
   */
  async function transfersAllowed() {
    if (conn.via !== 'remote' || settings.get('serverMetered')) return true;
    return !(await network.isMetered());
  }

  /**
   * Sends the queue, in order. Uploads go one by one; the commands between
   * them in batches. A command that needs a song still waiting to go up (the
   * connection is metered) waits with it; the rest goes.
   */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      if (status.state !== 'online' || (!sync.queue.some(mine) && !tiedWaiting.length)) return;
      existingChoice = null;
      let uploads = 0;
      let canTransfer = true;
      const blocked = new Set();
      let uploadNo = 0;
      let trimsWaiting = 0;
      let batch = [];
      // Songs the server deleted with a playlist: their copies here go too.
      const deleted = [];
      const sendBatch = async () => {
        if (!batch.length) return;
        const sending = batch;
        batch = [];
        // With the copy's revisions: the answer brings what changed since (4.3).
        const json = { commands: sending.map(outgoing), client: clientId() };
        if (copyOurs()) json.rev = cache.rev;
        if (statsOurs()) json.srev = cache.stats.rev;
        const res = await call('/api/commands', { method: 'POST', json, timeout: 60000 });
        if (res.stats) takeStats(res.stats);
        if (res.changes) takeChanges(res.changes);
        const byCid = new Map((res.results || []).map((r) => [r.cid, r]));
        const done = new Set();
        for (const c of sending) {
          const r = byCid.get(c.cid);
          if (!r) continue;
          done.add(c.cid);
          if (r.ok) sync.sent.push({ cmd: c, rev: res.rev, srev: res.srev });
          if (r.ok && Array.isArray(r.deletedSongs)) deleted.push(...r.deletedSongs.map(String));
          if (!r.ok) problems.push(tr('sync.problem.changeRefused', 'The server did not take a change: {reason}', { reason: r.error }));
        }
        sync.queue = sync.queue.filter((c) => !done.has(c.cid));
        saveSync();
      };
      try {
        // Songs the server has already are tied to its songs, not sent (the
        // copy of its library asked for first where no live channel keeps it).
        if (sync.queue.some((c) => c.type === 'upload' && mine(c))) {
          if (!status.live) await refresh();
          const tied = tieKnownUploads();
          if (tied.length) {
            saveSync();
            refreshView();
            tiedWaiting.push(...tied);
          }
          knownSong = serverSongFinder();
        }
        if (tiedWaiting.length) await afterTied(tiedWaiting.splice(0));
        uploads = sync.queue.filter((c) => c.type === 'upload' && mine(c)).length;
        canTransfer = uploads ? await transfersAllowed() : true;
        const pass = sync.queue.slice();
        const inPass = new Set(pass.map((c) => c.cid));
        for (let i = 0; i < pass.length; i += 1) {
          const c = pass[i];
          if (status.state !== 'online') break;
          if (!mine(c)) continue;
          if (c.type === 'upload') {
            // Asked again before each song: the setting or the network may change midway.
            if (canTransfer && uploadNo) canTransfer = await transfersAllowed();
            if (!canTransfer) {
              blocked.add(c.songId);
              continue;
            }
            await sendBatch();
            uploadNo += 1;
            await uploadOne(c, uploadNo, uploads);
            // An upload may queue a change of its own (the names from here, askExisting): sent in this pass too.
            for (const x of sync.queue) {
              if (!inPass.has(x.cid)) {
                inPass.add(x.cid);
                pass.push(x);
              }
            }
            continue;
          }
          const refs = [c.songId, ...(Array.isArray(c.songIds) ? c.songIds : [])];
          if (refs.some((id) => blocked.has(id))) continue;
          if (c.type === 'trimSong') {
            // A server too old to trim (or without ffmpeg): the trim waits for it.
            if (!conn.trim) {
              trimsWaiting += 1;
              continue;
            }
            await sendBatch();
            await trimOne(c);
            continue;
          }
          batch.push(c);
          if (batch.length >= 200) await sendBatch();
        }
        await sendBatch();
        if (deleted.length) {
          const ids = new Set(deleted);
          for (const [lid, sid] of Object.entries(sync.songMap)) {
            if (ids.has(sid)) await forgetLocal(lid, { deleteFile: true });
          }
        }
        status.transfer = '';
        status.note = blocked.size
          ? tr('sync.uploadsWaitMetered', blocked.size === 1 ? '{count} song waits to be uploaded until the connection is not metered.'
            : '{count} songs wait to be uploaded until the connection is not metered.', { count: blocked.size })
          : '';
        if (trimsWaiting) {
          status.note = `${status.note ? `${status.note} ` : ''}${tr('sync.trimsWait', trimsWaiting === 1 ? '{count} trim waits for the server: update it (and give it ffmpeg) to trim songs.'
            : '{count} trims wait for the server: update it (and give it ffmpeg) to trim songs.', { count: trimsWaiting })}`;
        }
        if (!sync.queue.some(mine)) status.lastSync = Date.now();
        // The answers brought what changed, and the live channel brings the
        // rest (an upload's song); without the channel it is asked for.
        if (!status.live) await refresh();
        pruneSent();
        afterServerChange();
      } catch (err) {
        status.transfer = '';
        wentWrong(err);
      } finally {
        knownSong = null;
        // What the songs going up left to save (saveSyncSoon).
        if (syncSaveTimer) saveSync();
        refreshView();
        reportProblems();
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  // ---- trims ----

  /** A new trim's id (song.cut). */
  function newCutId() {
    return randomHex(6);
  }

  /**
   * One trim to the server: it cuts its file. Taken (or in already): sent.
   * Not applied (trimmed on another device since, or the server could not):
   * dropped and told; the copy here then follows the server's file.
   */
  async function trimOne(cmd) {
    const s = model.songById(getView(), cmd.songId);
    const label = s ? [s.artist, s.title].filter(Boolean).join(' - ') : tr('sync.aSong', 'A song');
    status.transfer = tr('sync.transfer.trimming', 'Trimming on the server: {song}', { song: label });
    status.transferUp = false;
    emitStatus();
    const r = await request(conn.base, `/api/songs/${encodeURIComponent(cmd.songId)}/trim`, {
      method: 'POST', json: { start: cmd.start, end: cmd.end, base: cmd.base || '', cut: cmd.cut }, token: conn.token, timeout: 5 * 60 * 1000,
    });
    if (r.status === 401) throw new AuthError(tr('connection.signedOut', 'Signed out.'));
    sync.queue = sync.queue.filter((c) => c.cid !== cmd.cid);
    if (r.status === 200 && r.json) {
      if (!r.json.skipped) sync.sent.push({ cmd, rev: Number(r.json.rev) });
      if (r.json.skipped === 'changed') problems.push(tr('sync.trimmedElsewhere', '"{song}" was trimmed on another device meanwhile, so this trim was not applied.', { song: label }));
    } else {
      problems.push(tr('sync.trimFailed', 'The server could not trim "{song}": {reason}', { song: label, reason: (r.json && r.json.error) || tr('sync.trimFailed.answered', 'it answered {status}', { status: r.status }) }));
    }
    saveSync();
  }

  /** The Local Files copy of a server song, when there is one (its local id). */
  function copyOf(sid) {
    const local = library.get();
    return local.songs.find((x) => sync.songMap[x.id] === sid && x.file && files.exists(x.file)) || null;
  }

  /**
   * Edit's trim of a server song: a copy here is cut at once (the server keeps
   * the uncut file in its trash), then the server is told, now or once it can
   * be reached.
   */
  async function trimSong(songId, { start, end }) {
    const s = model.songById(getView(), songId);
    if (!s) throw new Error(tr('common.songGone', 'That song no longer exists.'));
    if (status.state === 'online' && !conn.trim) {
      throw new Error(tr('common.serverCannotTrim', 'This Flow Server cannot trim songs. Update it, and install ffmpeg on it (sudo apt install ffmpeg).'));
    }
    const base = s.cut || '';
    const cut = newCutId();
    const copy = copyOf(songId);
    // Queued first: a copy that cannot be cut (playing elsewhere) is then
    // simply replaced by the server's cut file later.
    command('trimSong', { songId, start, end, base, cut });
    if (!copy) return;
    try {
      await library.quietly(async () => {
        const { duration } = await exporter.trimSong(copy, start, end, { keep: false });
        library.mutate((d) => {
          if (model.songById(d, copy.id)) model.updateSong(d, copy.id, { duration, cut, loudness: null });
        });
      });
    } catch {
      // Follows the server's file.
    }
  }

  /**
   * A Local Files song trimmed while the server is off: when it is one of a
   * server's songs (a copy, or one uploaded), the trim waits for that server.
   * One still waiting to go up goes up trimmed.
   */
  function trimmedHere(lid, { start, end, base, cut }) {
    ensureLoaded();
    const sid = sync.songMap[lid];
    if (!sid || !sync.serverId) return;
    if (sync.queue.some((c) => c.type === 'upload' && c.localId === lid)) return;
    sync.queue.push(newCommand('trimSong', { songId: sid, start, end, base: base || '', cut }));
    saveSync();
  }

  /** A server song's waveform (the server draws it). */
  /**
   * A server song's lyrics, as the server keeps them (4.0): { found, synced,
   * plain, instrumental }. Null when the server cannot say (out of reach, or
   * from before lyrics): the app then looks them up itself.
   */
  async function songLyrics(songId) {
    if (!active() || status.state !== 'online' || !conn.lyrics) return null;
    try {
      // The server tries a busy LRCLIB for 51 s (@flow/core/lyrics RETRY).
      return (await call(`/api/songs/${encodeURIComponent(songId)}/lyrics`, { timeout: 120000 })).lyrics || null;
    } catch (err) {
      if (err instanceof OfflineError) return null;
      throw err;
    }
  }

  /**
   * A server song's own lyrics (4.0): `lines` [{ t, end, text }], or null
   * to give it looked-up ones again. Resolves them as the server keeps them.
   */
  async function setSongLyrics(songId, lines) {
    if (!active() || status.state !== 'online') throw new Error(tr('connection.unreachableNow', 'The server cannot be reached right now.'));
    if (!conn.ownLyrics) throw new Error(tr('connection.tooOld.lyrics', 'This Flow Server is too old to keep lyrics written here: it needs an update.'));
    return (await call(`/api/songs/${encodeURIComponent(songId)}/lyrics`, { method: 'PUT', json: { lines }, timeout: 30000 })).lyrics;
  }

  // The own lyrics of a Local Files song, sent after it when it goes up (the app's lyrics client).
  let ownLinesOf = () => null;
  function useOwnLyrics(fn) {
    ownLinesOf = fn;
  }

  /** A Local Files song's own lyrics after it, when it has some. */
  async function uploadLyrics(local, serverId) {
    const lines = ownLinesOf(local.id);
    if (!lines || !conn.ownLyrics) return;
    try {
      await call(`/api/songs/${encodeURIComponent(serverId)}/lyrics`, { method: 'PUT', json: { lines }, timeout: 30000 });
    } catch (err) {
      if (err instanceof AuthError) throw err;
      problems.push(tr('sync.lyricsNotSent', 'The lyrics of "{song}" could not be sent: {reason}', { song: [local.artist, local.title].filter(Boolean).join(' - '), reason: err.message }));
    }
  }

  // The app's lyrics client keeps copies of the server's (4.0): told when its library changed.
  let lyricsSyncHook = () => {};
  function useLyricsSync(fn) {
    lyricsSyncHook = fn;
  }

  // ...and when a Local Files song's file went (its lyrics there go too).
  let forgotHook = () => {};
  function useForgotLocal(fn) {
    forgotHook = fn;
  }

  /** The lyrics of up to 200 of the server's songs: { id: { ...lyrics, v } }, those it keeps. */
  async function lyricsOf(ids) {
    if (!active() || status.state !== 'online' || !conn.lyricsSync) return {};
    return (await call('/api/lyrics', { method: 'POST', json: { ids }, timeout: 60000 })).lyrics || {};
  }

  /** This server's id, '' without one. */
  function serverId() {
    return active() && sync.serverId ? sync.serverId : '';
  }

  async function songPeaks(songId) {
    if (!active() || status.state !== 'online') throw new Error(tr('common.unreachable', 'The server cannot be reached.'));
    return (await call(`/api/songs/${encodeURIComponent(songId)}/peaks`, { timeout: 120000 })).peaks;
  }

  /**
   * Copies whose audio is not the server's (song.cut differs: trimmed on
   * another device, or a trim here the server did not take): the server's
   * file comes down in their place.
   */
  async function replaceStaleCopies(v) {
    const local = library.get();
    const stale = [];
    const byId = songsById(v);
    for (const s of local.songs) {
      const sid = sync.songMap[s.id];
      const there = sid && byId.get(sid);
      if (there && (there.cut || '') !== (s.cut || '') && s.file && files.exists(s.file)) stale.push({ lid: s.id, there });
    }
    if (!stale.length) return;
    for (const { lid, there } of stale) {
      if (status.state !== 'online' || !active() || !(await transfersAllowed())) break;
      const label = [there.artist, there.title].filter(Boolean).join(' - ');
      status.transfer = tr('sync.transfer.downloadingTrimmed', 'Downloading the trimmed song: {song}', { song: label });
      status.transferUp = false;
      emitStatus();
      // Trimmed here since the look began: nothing to replace.
      const now = model.songById(library.get(), lid);
      const cur = model.songById(getView(), there.id);
      if (!now || !cur || (cur.cut || '') === (now.cut || '')) continue;
      const tmp = files.join(files.dirname(now.file), `.flow-download-${randomHex(5)}${files.extname(now.file)}`);
      try {
        const r = await request(conn.base, audioPath(there.id), { token: conn.token, saveTo: tmp, timeout: 60000 });
        if (r.status === 401) throw new AuthError(tr('connection.signedOut', 'Signed out.'));
        if (r.status !== 200) throw new Error((r.json && r.json.error) || tr('connection.serverAnswered.lower', 'the server answered {status}', { status: r.status }));
        await library.quietly(async () => {
          const s = model.songById(library.get(), lid);
          if (!s) return;
          try {
            files.rm(s.file);
          } catch {
            // Playing: replaced at the next look.
            return;
          }
          files.rename(tmp, s.file);
          library.mutate((d) => {
            if (model.songById(d, lid)) model.updateSong(d, lid, { duration: cur.duration, cut: cur.cut || '', loudness: cur.loudness });
          });
        });
      } catch (err) {
        if (err instanceof OfflineError || err instanceof AuthError) {
          status.transfer = '';
          throw err;
        }
        problems.push(tr('sync.trimmedNotDownloaded', 'The trimmed "{song}" could not be downloaded: {reason}', { song: label, reason: err.message }));
      } finally {
        files.rm(tmp, { force: true });
      }
    }
    status.transfer = '';
    emitStatus();
  }

  // ---- uploads ----

  // The answer for all songs of this upload that the server has under other
  // names ("Do the same for the others"), until the next flush.
  let existingChoice = null;

  /**
   * A song the server has already (the same source), under other names:
   * 'apply' (the names from here go to the server), 'keep' (the server's
   * stay) or 'new' (uploaded as a song of its own). Asked, unless answered for
   * all songs of this upload.
   */
  async function askExisting(local, names) {
    if (existingChoice) return existingChoice;
    let answer = { choice: 'keep', all: false };
    try {
      answer = (await hooks.askExisting({ local: { artist: local.artist, title: local.title, mix: local.mix }, server: names, name: conn.name })) || answer;
    } catch {
      // Keep the server's.
    }
    const choice = ['apply', 'keep', 'new'].includes(answer.choice) ? answer.choice : 'keep';
    if (answer.all) existingChoice = choice;
    return choice;
  }

  /**
   * Where a song's file is in this app's music folder ("Artist/Album/Song.mp3"),
   * for a server that keeps uploads' folders; a file elsewhere: its name only.
   */
  function placeInMusic(file) {
    const slashes = (p) => String(p || '').replace(/\\/g, '/');
    const root = slashes(paths.musicDir()).replace(/\/+$/, '');
    const f = slashes(file);
    if (root && f.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return f.slice(root.length + 1);
    return f.slice(f.lastIndexOf('/') + 1);
  }

  /** One song up to the server. Its local file stays or goes by "Keep local files after server upload". */
  async function uploadOne(cmd, number, total) {
    const local = model.songById(library.get(), cmd.localId);
    const drop = () => {
      sync.queue = sync.queue.filter((c) => c.cid !== cmd.cid);
      saveSyncSoon();
    };
    if (!local || !files.exists(local.file)) {
      // Gone before it could go up: nothing to send.
      drop();
      delete sync.songMap[cmd.localId];
      return;
    }
    const label = [local.artist, local.title].filter(Boolean).join(' - ');
    // The server has it already (its library here says so): its file is not sent to be told that.
    const there = knownSong && !cmd.onExisting ? knownSong(local, cmd.songId) : null;
    if (there) {
      await uploaded(cmd, local, number, total, {
        existing: true, id: there.id, rev: cache.rev, names: { artist: there.artist, title: there.title, mix: there.mix },
      });
      return;
    }
    status.transfer = tr('sync.transfer.uploading', 'Uploading {number} of {total}: {song}', { number, total, song: label });
    status.transferUp = true;
    emitStatus();
    const meta = {
      title: local.title,
      artist: local.artist,
      mix: local.mix,
      album: local.album,
      genre: local.genre,
      subGenre: local.subGenre,
      infoLooked: local.infoLooked,
      duration: local.duration,
      format: local.format || files.extname(local.file).slice(1).toLowerCase(),
      sourceUrl: local.sourceUrl,
      sourceKey: local.sourceKey,
      sourcePlaylistUrl: local.sourcePlaylistUrl,
      addedAt: local.addedAt,
      loudness: local.loudness,
      cut: local.cut || undefined,
      onExisting: cmd.onExisting || undefined,
      path: placeInMusic(local.file),
      convert: env.convertUploads ? {
        alwaysMp3: !!settings.get('alwaysMp3'),
        quality: Number(settings.get('mp3Quality')),
        keepMp3: settings.get('keepMp3') !== false,
      } : undefined,
    };
    if ((cmd.profile || '') === currentProfile()) {
      Object.assign(meta, {
        favouriteAt: local.favouriteAt,
        stats: local.stats,
        playlistIds: (cmd.playlistIds || []).filter((pid) => model.playlistById(getView(), pid)).map((pid) => (pid === FAV ? favouritesId() || pid : pid)),
      });
    }
    const r = await request(conn.base, `/api/songs/${encodeURIComponent(cmd.songId)}?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
      method: 'PUT',
      file: local.file,
      token: conn.token,
      timeout: 120000,
      onProgress: (f) => {
        status.transfer = tr('sync.transfer.uploading.percent', 'Uploading {number} of {total} ({percent}%): {song}', {
          number, total, percent: Math.round(f * 100), song: label,
        });
        emitStatus();
      },
    });
    if (r.status === 401) throw new AuthError(tr('connection.signedOut', 'Signed out.'));
    if (r.status !== 200 || !r.json) {
      // Refused for good (a format the server does not take, no room): the song
      // stays here only, and the reason is told.
      drop();
      delete sync.songMap[cmd.localId];
      problems.push(tr('sync.uploadFailed', '"{song}" could not be uploaded: {reason}', { song: label, reason: (r.json && r.json.error) || tr('connection.serverAnswered.lower', 'the server answered {status}', { status: r.status }) }));
      return;
    }
    await uploaded(cmd, local, number, total, r.json);
  }

  /**
   * A song's upload answered ({ existing, id, rev, names? }: by the server,
   * or from its library here for a song it has already): the song here is
   * tied to the server's, and what follows an upload follows.
   */
  async function uploaded(cmd, local, number, total, answer) {
    const serverId = String(answer.id);
    // The same song is there under other names (renamed here or there): asked
    // what to do. An older server says no names: it keeps its own.
    let apply = false;
    if (answer.existing && serverId !== cmd.songId && answer.names && !cmd.onExisting && !model.sameNames(answer.names, local)) {
      const choice = await askExisting(local, answer.names);
      if (choice === 'new') {
        cmd.onExisting = 'new';
        saveSync();
        await uploadOne(cmd, number, total);
        return;
      }
      apply = choice === 'apply';
    }
    if (serverId !== cmd.songId) renameSongId(cmd.songId, serverId);
    sync.songMap[cmd.localId] = serverId;
    sync.queue = sync.queue.filter((c) => c.cid !== cmd.cid);
    sync.sent.push({ cmd: { ...cmd, songId: serverId }, rev: Number(answer.rev) });
    // An upload shows as addSong until the library catches up; one the server
    // already had (existing) shows as that song straight away.
    if (answer.existing) sync.sent.pop();
    if (apply) {
      sync.queue.push(newCommand('editSong', {
        songId: serverId, title: local.title, artist: local.artist, mix: local.mix, album: local.album, genre: local.genre, subGenre: local.subGenre,
      }));
    }
    saveSyncSoon();
    if (!answer.existing) await uploadCover(local, serverId);
    await uploadLyrics(local, serverId);
    if (!settings.get('serverKeepFiles') && !neededOffline(serverId)) {
      await forgetLocal(cmd.localId, { deleteFile: true });
    }
  }

  /**
   * A Local Files song's cover after it, when it has one (the server keeps its
   * own if it found one first): the 512 x 512 one, then its thumbnail.
   */
  async function uploadCover(local, serverId) {
    const store = covers.localStore();
    if (!local.cover || local.cover === '-' || !store.has(local.id, 'big')) return;
    try {
      const at = `/api/songs/${encodeURIComponent(serverId)}/cover`;
      const r = await request(conn.base, at, { method: 'PUT', file: store.file(local.id, 'big'), token: conn.token, timeout: 30000 });
      if (!(r.status === 200 && r.json && r.json.cover === local.cover)) return;
      if (store.has(local.id, 'small')) {
        await request(conn.base, `${at}?size=small`, { method: 'PUT', file: store.file(local.id, 'small'), token: conn.token, timeout: 30000 }).catch(() => null);
      }
      covers.copyToServer(local.id, sync.serverId, serverId);
    } catch {
      // The server looks for one itself.
    }
  }

  // ---- Local Files and the server ----

  function snapOfSong(s) {
    return {
      title: s.title,
      artist: s.artist,
      mix: s.mix,
      album: s.album || '',
      genre: s.genre || '',
      subGenre: s.subGenre || '',
      fav: !!s.favouriteAt,
      loudness: s.loudness,
    };
  }

  /**
   * A song's album, genre and sub-genre as they were at the last
   * synchronization. A snapshot from before albums (3.6.2 and older) knows
   * none: they count as unchanged, so nothing empty goes up over the server's.
   */
  function sameInfo(was, s) {
    return was.album === undefined || ((s.album || '') === was.album && (s.genre || '') === (was.genre || '')
      && (s.subGenre || '') === (was.subGenre || ''));
  }

  function snapOfList(p) {
    return { name: p.name, entries: p.entries.map((e) => e.songId) };
  }

  /**
   * Takes a song out of Local Files because Flow itself decided so (it is on
   * the server now, the server deleted it, its playlist is no longer marked
   * for download): taken out of the snapshot too, so the next synchronization
   * does not mistake it for a song removed by hand.
   */
  async function forgetLocal(lid, { deleteFile }) {
    const song = model.songById(library.get(), lid);
    const before = { sid: sync.songMap[lid], fetched: sync.fetched[lid], snap: sync.snapshot && sync.snapshot.songs[lid] };
    delete sync.songMap[lid];
    delete sync.fetched[lid];
    if (sync.snapshot) {
      delete sync.snapshot.songs[lid];
      for (const l of Object.values(sync.snapshot.lists)) l.entries = l.entries.filter((id) => id !== lid);
    }
    // Another server's songs are tied to it: this one lets go, the song stays
    // here (still in the snapshot, so it is not taken for a new song to send).
    if (song && usedElsewhere(lid)) {
      if (sync.held) sync.held = sync.held.filter((id) => id !== lid);
      if (sync.snapshot) sync.snapshot.songs[lid] = before.snap || snapOfSong(song);
      saveSync();
      return true;
    }
    saveSync();
    if (!song) return true;
    let removed = false;
    await library.quietly(async () => {
      if (deleteFile) {
        try {
          files.rm(song.file, { force: true });
        } catch {
          // In use (playing): it stays, and is tried again later.
          return;
        }
      }
      library.mutate((d) => model.removeSong(d, lid, !deleteFile));
      removed = true;
    });
    // Its file gone (uploaded with "Keep local files" off, or a copy no longer
    // needed): its cover and lyrics here go along (4.3.1).
    if (removed && deleteFile) {
      try {
        covers.localStore().remove(lid);
      } catch {
        // Swept later.
      }
      try {
        forgotHook(lid);
      } catch {
        // Swept later.
      }
    }
    if (!removed) {
      // Not gone after all: still tied to the server as before.
      if (before.sid) sync.songMap[lid] = before.sid;
      if (before.fetched) sync.fetched[lid] = true;
      if (sync.snapshot && before.snap) sync.snapshot.songs[lid] = before.snap;
      saveSync();
    }
    return removed;
  }

  /**
   * Queues what changed in Local Files since the last synchronization: songs
   * added go up, songs removed only let go of their copy here (they stay on
   * the server), names, favourites and
   * playlists follow. `onlyNew`: only additions (a song just downloaded goes
   * up even while "Synchronize local changes" is off). `playlistsFor`: server
   * playlists a new song goes into (the ones picked when downloading it).
   */
  function queueLocalChanges({ onlyNew = false, playlistsFor = {}, lists = null } = {}) {
    const local = library.get();
    const firstTime = !sync.snapshot;
    const snap = sync.snapshot || { songs: {}, lists: {} };
    const v = getView();
    const at = Date.now();
    const q = (type, args) => sync.queue.push(newCommand(type, { at, ...args }));
    const localIds = new Set(local.songs.map((s) => s.id));
    const inView = new Set(v.songs.map((s) => s.id));
    // Songs that were here before this server and have not been OK'd to go up (askHeld).
    if (sync.held) sync.held = sync.held.filter((id) => localIds.has(id));
    const held = new Set(sync.held || []);
    let count = 0;

    for (const s of local.songs) {
      if (held.has(s.id)) continue;
      const was = snap.songs[s.id];
      if (!was) {
        if (!sync.songMap[s.id]) {
          // The song's own id on the server too, unless the server says otherwise.
          sync.songMap[s.id] = s.id;
          q('upload', { localId: s.id, songId: s.id, playlistIds: playlistsFor[s.id] || [] });
          count += 1;
        }
        snap.songs[s.id] = snapOfSong(s);
        continue;
      }
      if (onlyNew) continue;
      const sid = sync.songMap[s.id];
      if (!sid || !inView.has(sid)) continue;
      const now = snapOfSong(s);
      if (now.title !== was.title || now.artist !== was.artist || now.mix !== was.mix || !sameInfo(was, s)) {
        q('editSong', {
          songId: sid,
          title: s.title,
          artist: s.artist,
          mix: s.mix,
          // An old snapshot's song sends its names only (see sameInfo).
          ...(was.album === undefined ? {} : { album: s.album, genre: s.genre, subGenre: s.subGenre }),
        });
        count += 1;
      }
      if (now.fav !== was.fav) {
        q('setFavourite', { songId: sid, on: now.fav });
        count += 1;
      }
      if (now.loudness !== null && now.loudness !== undefined && now.loudness !== was.loudness) {
        q('setLoudness', { songId: sid, loudness: now.loudness });
      }
      snap.songs[s.id] = now;
    }

    if (!onlyNew) {
      for (const lid of Object.keys(snap.songs)) {
        if (localIds.has(lid)) continue;
        // Removed from the folder by hand (or deleted while the server was
        // off): only the copy here is gone, as with "Delete from this
        // computer". The song stays on the server, in its playlists; only
        // the song's X deletes it there (deleteSong). An upload still
        // waiting for it has nothing left to send.
        delete snap.songs[lid];
        delete sync.songMap[lid];
        delete sync.fetched[lid];
        sync.queue = sync.queue.filter((c) => !(c.type === 'upload' && c.localId === lid));
      }
    }

    const mapSongs = (lids) => lids.map((lid) => sync.songMap[lid]).filter(Boolean);
    // Songs go into a playlist with the time they were added here, so the
    // server lists them in the same order (an import's songs are a second
    // apart in the source's order, whatever order they were saved in).
    const addTimed = (target, entries) => {
      let group = null;
      const send = () => {
        if (group && group.songIds.length) q('addSongsToPlaylist', { playlistId: target, songIds: group.songIds, at: group.at });
      };
      for (const e of entries) {
        const sid = sync.songMap[e.songId];
        if (!sid) continue;
        const time = Number(e.addedAt) || at;
        if (!group || group.at !== time) {
          send();
          group = { at: time, songIds: [] };
        }
        group.songIds.push(sid);
      }
      send();
    };
    const localLists = new Set(local.playlists.map((p) => p.id));
    for (const p of local.playlists) {
      // While songs are held back, no playlist is made on the server, except the ones asked for (an import).
      if (held.size && !(lists && lists.includes(p.id))) continue;
      const was = snap.lists[p.id];
      let target = sync.listMap[p.id];
      if (!was) {
        if (!target) {
          // A server playlist of the same name takes the songs in.
          const same = v.playlists.find((x) => x.name.toLowerCase() === p.name.toLowerCase());
          target = same ? same.id : p.id;
          if (!same) q('createPlaylist', { playlistId: p.id, name: p.name, source: p.source });
          sync.listMap[p.id] = target;
        }
        addTimed(target, p.entries);
        snap.lists[p.id] = snapOfList(p);
        count += 1;
        continue;
      }
      // Only new songs go up, except into the lists asked for (an import's,
      // which gets its songs a few at a time).
      if ((onlyNew && !(lists && lists.includes(p.id))) || !target) continue;
      const now = snapOfList(p);
      if (now.name !== was.name) {
        q('renamePlaylist', { playlistId: target, name: p.name });
        count += 1;
      }
      const before = new Set(was.entries);
      const after = new Set(now.entries);
      const addedEntries = p.entries.filter((e) => !before.has(e.songId));
      const added = mapSongs(addedEntries.map((e) => e.songId));
      addTimed(target, addedEntries);
      for (const sid of mapSongs(was.entries.filter((id) => !after.has(id)))) q('removeFromPlaylist', { playlistId: target, songId: sid });
      if (added.length || was.entries.some((id) => !after.has(id))) count += 1;
      snap.lists[p.id] = now;
    }
    if (!onlyNew) {
      for (const lpid of Object.keys(snap.lists)) {
        if (localLists.has(lpid)) continue;
        const target = sync.listMap[lpid];
        delete snap.lists[lpid];
        delete sync.listMap[lpid];
        if (target && model.playlistById(v, target)) {
          q('deletePlaylist', { playlistId: target });
          count += 1;
        }
      }
    }

    sync.snapshot = snap;
    // Songs the server has already are tied to its songs at once, so they
    // never show as waiting to go up (the live channel keeps its library here
    // as it is; without it the flush asks for it first, and ties them then).
    const tied = status.live ? tieKnownUploads() : [];
    tiedWaiting.push(...tied);
    saveSync();
    refreshView();
    flushSoon();
    return { count: count - tied.length, firstTime };
  }

  /**
   * A playlist that can be marked for download, as the signed-in profile sees
   * it: one of its own, or one another profile shares that it follows.
   */
  function markedList(v, pid) {
    return model.playlistById(v, pid)
      || (model.isFollowed(v, pid) ? model.sharedPlaylistById(v, pid) : null);
  }

  /**
   * All Songs or the songs one profile added: everyone's, whichever profile
   * is signed in, and always as the library has them now (new ones come too).
   */
  function isAllList(pid) {
    return pid === ALL || pid.startsWith(FROM);
  }

  function allListSongs(pid, v) {
    if (pid === ALL) return v.songs.map((s) => s.id);
    const by = pid.slice(FROM.length);
    return v.songs.filter((s) => s.addedBy === by).map((s) => s.id);
  }

  /**
   * The songs of a playlist marked for download: as the library has them when
   * it is the signed-in profile's (or one it follows), else as last seen
   * (another profile's, or a followed one that is not shared for the moment).
   */
  function markedSongs(pid, v) {
    if (isAllList(pid)) return allListSongs(pid, v);
    const p = markedList(v, pid);
    if (p) return p.entries.map((e) => e.songId);
    const keep = sync.offlineKeep[pid];
    if (keep && model.isFollowed(v, pid)) return keep.songs;
    return keep && keep.profile !== currentProfile() ? keep.songs : [];
  }

  /** A song downloaded by hand, or in a server playlist marked for download. */
  function neededOffline(sid) {
    if (sync.kept[sid]) return true;
    const v = getView();
    return sync.offline.some((pid) => markedSongs(pid, v).includes(sid));
  }

  /**
   * Remembers the songs of the signed-in profile's marked playlists, for when
   * another profile is signed in; a marked playlist of this profile that is no
   * longer there (deleted) is no longer marked.
   */
  function rememberMarked(v) {
    if (!cache.library || cache.profile !== currentProfile()) return;
    for (const pid of sync.offline.slice()) {
      if (isAllList(pid)) continue;
      const p = markedList(v, pid);
      const keep = sync.offlineKeep[pid];
      if (p) sync.offlineKeep[pid] = { profile: currentProfile(), songs: p.entries.map((e) => e.songId) };
      // Gone (deleted, or no longer followed): no longer marked. A followed one
      // that is only not shared for the moment stays as it was.
      else if ((!keep || keep.profile === currentProfile()) && !model.isFollowed(v, pid)) {
        sync.offline = sync.offline.filter((x) => x !== pid);
        delete sync.offlineKeep[pid];
      }
    }
    saveSync();
  }

  /**
   * After the server's library changed: local copies follow renames and
   * favourites made elsewhere, copies of songs deleted on the server go, and
   * the songs of playlists marked for download come down.
   */
  function afterServerChange() {
    if (status.state !== 'online' || !cache.library) return;
    followServer().catch(() => {});
    coverSync().catch(() => {});
    lyricsSyncHook();
  }

  let following = null;
  const lengthsTold = new Set();
  function followServer() {
    if (following) return following;
    following = (async () => {
      const v = buildView();
      const local = library.get();
      const snap = sync.snapshot;
      const byId = songsById(v);
      rememberMarked(v);

      // Names, favourites and loudness changed on the server, for copies not
      // changed here since (those go up at the next synchronization instead).
      const updates = [];
      for (const s of local.songs) {
        const sid = sync.songMap[s.id];
        const was = snap && snap.songs[s.id];
        const there = sid && byId.get(sid);
        if (!there || !was) continue;
        const unchangedHere = s.title === was.title && s.artist === was.artist && s.mix === was.mix && !!s.favouriteAt === was.fav
          && sameInfo(was, s);
        if (!unchangedHere) continue;
        const patch = {};
        if (there.title !== s.title || there.artist !== s.artist || there.mix !== s.mix) {
          Object.assign(patch, { title: there.title, artist: there.artist, mix: there.mix });
        }
        if ((there.album || '') !== (s.album || '') || (there.genre || '') !== (s.genre || '')
          || (there.subGenre || '') !== (s.subGenre || '') || !!there.infoLooked !== !!s.infoLooked) {
          Object.assign(patch, {
            album: there.album || '', genre: there.genre || '', subGenre: there.subGenre || '', infoLooked: !!there.infoLooked,
          });
        }
        if (!!there.favouriteAt !== !!s.favouriteAt) patch.favouriteAt = there.favouriteAt;
        if (there.loudness !== null && s.loudness === null) patch.loudness = there.loudness;
        if (Object.keys(patch).length) updates.push({ lid: s.id, patch });
      }
      // A length the server lacks (a song it found in its folder without
      // ffprobe) and the copy here knows.
      let told = 0;
      for (const s of local.songs) {
        const sid = sync.songMap[s.id];
        const there = sid && byId.get(sid);
        if (there && !(there.duration > 0) && s.duration > 0 && !lengthsTold.has(sid)) {
          // Once per session: a server too old to take it would be asked forever.
          lengthsTold.add(sid);
          sync.queue.push(newCommand('setDuration', { songId: sid, duration: s.duration }));
          told += 1;
        }
      }
      if (told) {
        saveSync();
        flushSoon();
      }
      if (updates.length) {
        library.mutate((d) => {
          for (const { lid, patch } of updates) {
            if (!model.songById(d, lid)) continue;
            // The song to change (4.6: a saved row is locked, a copy takes its place).
            const s = Object.assign(model.songToChange(d, lid), patch);
            if (snap) snap.songs[lid] = snapOfSong(s);
          }
        });
        saveSync();
      }

      // Deleted on the server: the local copy goes too. A server that suddenly
      // lacks most of the songs (its library lost, not deleted song by song)
      // takes nothing with it.
      const waiting = new Set(sync.queue.filter((c) => c.type === 'upload').map((c) => c.localId));
      const gone = Object.entries(sync.songMap).filter(([lid, sid]) => !waiting.has(lid) && !byId.has(sid));
      const mapped = Object.keys(sync.songMap).length;
      if (gone.length && (gone.length <= 20 || gone.length < mapped / 2)) {
        for (const [lid] of gone) await forgetLocal(lid, { deleteFile: true });
      } else if (gone.length) {
        status.note = tr('sync.missingOnServer', gone.length === 1 ? '{count} song is missing on the server. Its file was kept here.'
          : '{count} songs are missing on the server. Their files were kept here.', { count: gone.length });
        emitStatus();
      }

      try {
        await replaceStaleCopies(v);
      } catch (err) {
        wentWrong(err);
        return;
      }
      await downloadOffline();
      await dropUnneededCopies();
      refreshView();
      reportProblems();
    })().finally(() => {
      following = null;
    });
    return following;
  }

  // ---- playlists marked for download ----

  // The note telling that downloads wait for a connection that is not metered, while it shows.
  let downloadsWaitNote = '';

  /** Every song of the marked playlists without a copy here comes down. */
  async function downloadOffline() {
    if (status.state !== 'online' || !sync.offline.length) return;
    const v = getView();
    const copies = localCopies(v);
    const want = [];
    const seen = new Set();
    const byId = songsById(v);
    const goingUp = new Set(sync.queue.filter((c) => c.type === 'upload').map((c) => c.songId));
    for (const pid of sync.offline) {
      const all = isAllList(pid);
      const p = all ? null : markedList(v, pid);
      if (!p && !all) continue;
      // All Songs (or a profile's part of it): new songs as they turn up on the server.
      const songIds = all ? allListSongs(pid, v) : p.entries.map((e) => e.songId);
      for (const songId of songIds) {
        if (seen.has(songId) || copies.has(songId)) continue;
        seen.add(songId);
        const s = byId.get(songId);
        if (s && !goingUp.has(s.id)) want.push(s);
      }
    }
    if (downloadsWaitNote && status.note === downloadsWaitNote) status.note = '';
    downloadsWaitNote = '';
    if (!want.length) {
      emitStatus();
      return;
    }
    // Their covers first, in batches (each song's copy takes them).
    if (await transfersAllowed()) await ensureCovers(want.map((s) => s.id));
    let number = 0;
    for (const s of want) {
      if (status.state !== 'online' || !active()) break;
      // Asked again before each song: the setting or the network may change midway.
      if (!(await transfersAllowed())) {
        const left = want.length - number;
        status.transfer = '';
        status.note = tr('sync.downloadsWaitMetered', left === 1 ? '{count} song waits to be downloaded until the connection is not metered.'
          : '{count} songs wait to be downloaded until the connection is not metered.', { count: left });
        downloadsWaitNote = status.note;
        emitStatus();
        return;
      }
      number += 1;
      const label = [s.artist, s.title].filter(Boolean).join(' - ');
      status.transfer = tr('sync.transfer.downloading', 'Downloading {number} of {total}: {song}', { number, total: want.length, song: label });
      status.transferUp = false;
      emitStatus();
      try {
        await fetchSong(s, (f) => {
          status.transfer = tr('sync.transfer.downloading.percent', 'Downloading {number} of {total} ({percent}%): {song}', {
            number, total: want.length, percent: Math.round(f * 100), song: label,
          });
          emitStatus();
        });
      } catch (err) {
        if (err instanceof OfflineError || err instanceof AuthError) {
          status.transfer = '';
          wentWrong(err);
          return;
        }
        problems.push(tr('sync.downloadFailed', '"{song}" could not be downloaded: {reason}', { song: label, reason: err.message }));
      }
      // The window hears of each song as it arrives.
      refreshView();
    }
    status.transfer = '';
    emitStatus();
  }

  /** One server song into Local Files, as a copy (its covers with it). */
  async function fetchSong(s, onProgress) {
    await ensureCovers([s.id]);
    const ext = String(s.format || 'mp3').toLowerCase();
    const tmp = files.join(paths.musicDir(), `.flow-download-${randomHex(5)}.${ext}`);
    try {
      const r = await request(conn.base, audioPath(s.id), {
        token: conn.token, saveTo: tmp, timeout: 60000, onProgress,
      });
      if (r.status === 401) throw new AuthError(tr('connection.signedOut', 'Signed out.'));
      if (r.status !== 200) throw new Error((r.json && r.json.error) || tr('connection.serverAnswered.lower', 'the server answered {status}', { status: r.status }));
      await library.quietly(async () => {
        const dest = exporter.uniquePath(songFileStem(s.artist, s.title, s.mix), ext);
        files.rename(tmp, dest);
        const taken = model.songById(library.get(), s.id);
        const lid = taken ? library.newId() : s.id;
        const song = {
          id: lid,
          file: dest,
          title: s.title,
          artist: s.artist,
          mix: s.mix,
          album: s.album,
          genre: s.genre,
          subGenre: s.subGenre,
          infoLooked: s.infoLooked,
          duration: s.duration,
          format: ext,
          sourceUrl: s.sourceUrl,
          sourceKey: s.sourceKey,
          sourcePlaylistUrl: s.sourcePlaylistUrl,
          addedAt: s.addedAt,
          loudness: s.loudness,
          favouriteAt: s.favouriteAt,
          stats: s.stats,
          cut: s.cut || '',
          // The server's cover, when it is here already.
          cover: s.cover && s.cover !== '-' ? covers.copyToLocal(sync.serverId, s.id, lid) : s.cover,
        };
        sync.songMap[lid] = s.id;
        sync.fetched[lid] = true;
        if (!sync.snapshot) sync.snapshot = { songs: {}, lists: {} };
        sync.snapshot.songs[lid] = snapOfSong(song);
        saveSync();
        library.mutate((d) => model.addSong(d, song));
      });
    } finally {
      files.rm(tmp, { force: true });
    }
  }

  /** Copies downloaded for a playlist no longer marked (and in no other marked one) go. */
  async function dropUnneededCopies() {
    const inView = new Set(getView().songs.map((s) => s.id));
    for (const lid of Object.keys(sync.fetched)) {
      const sid = sync.songMap[lid];
      if (!sid || !inView.has(sid)) continue;
      if (!neededOffline(sid)) await forgetLocal(lid, { deleteFile: true });
    }
  }

  // ---- covers ----
  //
  // 4.3.1: a server's covers come when the window shows them, never all at
  // once. The rows on screen once the list stops (or almost: the window's
  // covers.js) ask for their 128 x 128 thumbnails, COVER_BATCH in one request
  // (POST /api/covers); Details, the visualizers, the lock screen and the
  // next song ask for the 512 x 512 one, fetched only with the setting
  // "Download high resolution covers" (one kept already is shown anyway).
  // The songs kept here for offline (playlists marked for download, songs
  // downloaded by hand) get their thumbnails in advance, so they show without
  // the server. A cover here whose version (recorded in the store's index)
  // is not the song's is fetched again when shown.

  const COVER_BATCH = 100;
  const COVER_JOBS = 2;
  const coverFailed = new Set(); // `${size}/${songId}` that could not be had this run
  const coverWanted = { small: [], big: [] };
  let coverRunning = 0;
  let coverSingles = false; // a server without POST /api/covers (one at a time there)
  let coverArrived = { small: [], big: [] };
  let coverTellTimer = null;

  /** Where the window finds this server's covers: '' without a server. */
  function coverDir() {
    return active() && sync.serverId ? covers.dirOf(sync.serverId) : '';
  }

  const wantsCover = (s) => !!(s && s.cover && s.cover !== '-');
  const coverSize = (size) => (size === 'big' ? 'big' : 'small');
  const highRes = () => settings.get('highResCovers') !== false;
  // "Cover thumbnails cache" unticked: no thumbnails asked for (those kept still show).
  const thumbs = () => settings.get('thumbCovers') !== false;
  const fetchesSize = (size) => (size === 'big' ? highRes() : thumbs());

  /** The server's songs kept for offline (their covers and lyrics in advance): the copies here, and the marked playlists'. */
  function offlineIds() {
    const ids = new Set();
    for (const lid of Object.keys(sync.fetched || {})) if (sync.songMap[lid]) ids.add(sync.songMap[lid]);
    for (const sid of Object.keys(sync.kept || {})) ids.add(sid);
    if (sync.offline.length) {
      const v = getView();
      for (const pid of sync.offline) for (const sid of markedSongs(pid, v)) ids.add(sid);
    }
    return ids;
  }

  /**
   * After every look at the server's library: the covers of songs gone go,
   * and the songs kept for offline get the thumbnails they lack (and their
   * big covers with the high-res setting), when transfers are allowed.
   */
  async function coverSync() {
    if (env.streamCovers || status.state !== 'online' || !cache.library || cache.serverId !== sync.serverId || !sync.serverId) return;
    const store = covers.storeOf(sync.serverId);
    const songs = cache.library.songs;
    store.sweep(new Set(songs.map((x) => x.id)));
    const offline = offlineIds();
    if (!offline.size || !(await transfersAllowed())) return;
    const lacking = (size) => songs.filter((x) => offline.has(x.id) && wantsCover(x) && !coverFailed.has(`${size}/${x.id}`)
      && store.version(x.id, size) !== x.cover).map((x) => x.id);
    if (thumbs()) queueCovers(lacking('small'), 'small', { first: false });
    if (highRes()) queueCovers(lacking('big'), 'big', { first: false });
  }

  function queueCovers(ids, size, { first = true } = {}) {
    const list = coverWanted[size];
    const fresh = ids.filter((id) => !list.includes(id));
    coverWanted[size] = first ? [...fresh, ...list] : [...list, ...fresh];
    pumpCovers();
  }

  /**
   * The window shows these songs and has no fitting cover file for them:
   * 'small' (a list's rows) or 'big' (Details, a visualizer, the song playing
   * or next). A big one is fetched only with the high-res setting, a small
   * one only with the thumbnails' (both ticked at first); one here
   * already (the right version) is told to the window at once.
   */
  function wantCovers(ids, size = 'small') {
    const sz = coverSize(size);
    const list = (Array.isArray(ids) ? ids : []).map(String).filter((id) => /^[\w-]{1,64}$/.test(id));
    if (!list.length || env.streamCovers || !sync.serverId || !cache.library) return;
    const store = covers.storeOf(sync.serverId);
    const here = [];
    const fetch = [];
    for (const id of list) {
      const song = model.songById(cache.library, id);
      if (!wantsCover(song)) continue;
      if (store.version(id, sz) === song.cover) here.push(id);
      else if (fetchesSize(sz)) fetch.push(id);
    }
    if (here.length) covers.tell(sync.serverId, here, sz);
    if (fetch.length) queueCovers(fetch.slice(0, 300), sz);
  }

  /** The next songs to fetch covers for: { size, songs }, or null. Thumbnails first. */
  function nextCovers() {
    const lib = cache.library;
    if (!lib || !sync.serverId) return null;
    const store = covers.storeOf(sync.serverId);
    for (const size of ['small', 'big']) {
      const songs = [];
      const max = coverSingles ? 1 : COVER_BATCH;
      while (coverWanted[size].length && songs.length < max) {
        const id = coverWanted[size].shift();
        const song = model.songById(lib, id);
        if (wantsCover(song) && !coverFailed.has(`${size}/${id}`) && store.version(id, size) !== song.cover && !songs.includes(song)) songs.push(song);
      }
      if (songs.length) return { size, songs };
    }
    return null;
  }

  function pumpCovers() {
    while (coverRunning < COVER_JOBS && status.state === 'online') {
      const next = nextCovers();
      if (!next) return;
      coverRunning += 1;
      fetchCovers(next).catch(() => {
        for (const s of next.songs) coverFailed.add(`${next.size}/${s.id}`);
      }).finally(() => {
        coverRunning -= 1;
        pumpCovers();
      });
    }
  }

  /** Covers that arrived reach the window together (many at once as one message). */
  function coversArrived(size, ids) {
    coverArrived[size].push(...ids);
    if (coverTellTimer) return;
    coverTellTimer = setTimeout(() => {
      coverTellTimer = null;
      const arrived = coverArrived;
      coverArrived = { small: [], big: [] };
      for (const sz of ['small', 'big']) if (arrived[sz].length) covers.tell(sync.serverId, arrived[sz], sz);
    }, 150);
  }

  /** A JPEG or a WebP. */
  const isPicture = (b) => !!b && b.length > 12 && ((b[0] === 0xff && b[1] === 0xd8)
    || (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50));

  /** One batch of one size: the server's answer (packCovers) into the store. */
  async function fetchCovers({ size, songs }) {
    const serverId = sync.serverId;
    const store = covers.storeOf(serverId);
    if (coverSingles) {
      const song = songs[0];
      const r = await request(conn.base, `/api/songs/${encodeURIComponent(song.id)}/cover?v=${encodeURIComponent(song.cover)}&size=${size}`, {
        token: conn.token, binary: true, timeout: 30000,
      });
      if (serverId !== sync.serverId) return;
      if (r.status !== 200 || !isPicture(r.bytes)) {
        coverFailed.add(`${size}/${song.id}`);
        return;
      }
      store.write(song.id, size, r.bytes, song.cover);
      coversArrived(size, [song.id]);
      return;
    }
    const r = await request(conn.base, '/api/covers', {
      method: 'POST', json: { ids: songs.map((s) => s.id), size }, token: conn.token, binary: true, timeout: 60000,
    });
    if (serverId !== sync.serverId) return;
    if (r.status === 404 || r.status === 405) {
      // No batches there: one at a time.
      coverSingles = true;
      coverWanted[size].unshift(...songs.map((s) => s.id));
      return;
    }
    if (r.status !== 200 || !r.bytes) throw new Error(`HTTP ${r.status}`);
    const got = new Set();
    for (const item of unpackCovers(r.bytes)) {
      const song = songs.find((s) => s.id === item.id);
      if (!song || !isPicture(item.bytes)) continue;
      store.write(item.id, size, item.bytes, item.v || song.cover);
      got.add(item.id);
    }
    for (const s of songs) if (!got.has(s.id)) coverFailed.add(`${size}/${s.id}`);
    if (got.size) coversArrived(size, [...got]);
  }

  /** The covers of these server songs here before they are needed (a song downloaded: its copy takes them). */
  async function ensureCovers(ids) {
    if (env.streamCovers || !sync.serverId || !cache.library || status.state !== 'online') return;
    const store = covers.storeOf(sync.serverId);
    for (const size of ['small', 'big'].filter(fetchesSize)) {
      const songs = ids.map((id) => model.songById(cache.library, id)).filter((s) => wantsCover(s) && store.version(s.id, size) !== s.cover);
      for (let i = 0; i < songs.length; i += COVER_BATCH) {
        await fetchCovers({ size, songs: songs.slice(i, i + COVER_BATCH) }).catch(() => {});
      }
    }
  }

  /**
   * The servers' covers kept here, by size: { small, big: { count, bytes,
   * current } } (current: this server's count); count and bytes for both.
   */
  function coverStats() {
    const out = { small: { count: 0, bytes: 0, current: 0 }, big: { count: 0, bytes: 0, current: 0 } };
    for (const id of covers.serverIds()) {
      for (const size of ['small', 'big']) {
        const n = covers.storeOf(id).size(size);
        out[size].count += n.count;
        out[size].bytes += n.bytes;
        if (id === sync.serverId) out[size].current = n.count;
      }
    }
    return { ...out, count: out.small.count, bytes: out.small.bytes + out.big.bytes, current: out.small.current };
  }

  /**
   * Settings' Clear: every server's covers of one size go ('small': the
   * thumbnails, 'big': the high-res ones, null: both). Shown again, they are
   * fetched again; the offline songs' at once.
   */
  function clearCoverCache(size = null) {
    for (const id of covers.serverIds()) {
      if (size === 'small' || size === 'big') covers.storeOf(id).clear(size);
      else covers.removeServer(id);
    }
    coverFailed.clear();
    coverSync().catch(() => {});
    return coverStats();
  }

  /** A Local Files song that is a copy of one of the server's (its cover comes from there). */
  function isServerCopy(lid) {
    return !!sync.fetched[lid];
  }

  /** The server's song a Local Files song went to or came from (uploaded, or downloaded here), or ''. */
  function serverSongOf(lid) {
    return active() ? String((sync.songMap || {})[lid] || '') : '';
  }

  /** The Local Files song a server's song came from or went to (uploaded, or downloaded here), or ''. */
  function localOf(serverSongId) {
    for (const [lid, sid] of Object.entries(sync.songMap || {})) if (sid === serverSongId) return lid;
    return '';
  }

  // ---- synchronizing ----

  let asking = null;
  /**
   * The songs in Local Files from before this server are only sent with the
   * user's OK. Declined, they stay here (only "Synchronize now" asks again);
   * songs added or downloaded afterwards go up as usual.
   */
  function askHeld({ returning = false } = {}) {
    if (asking) return asking;
    asking = (async () => {
      queueLocalChanges(); // drops the held songs that are gone
      if (!(sync.held || []).length) return;
      // Those the server has already need no upload: they are not asked
      // about (and stay as they are, playing here as its songs' copies,
      // unless the others may go up: then they are tied to its songs).
      const find = serverSongFinder();
      const localById = new Map(library.get().songs.map((x) => [x.id, x]));
      const lacking = find ? sync.held.filter((lid) => {
        const s = localById.get(lid);
        return !s || !find(s, lid);
      }) : sync.held.slice();
      const count = lacking.length;
      if (!count) return;
      // How many of them are copies downloaded from other servers.
      const fromOthers = lacking.filter(copyFromElsewhere).length;
      let yes = false;
      try {
        yes = !!(await hooks.confirmUpload({
          count, name: conn.name, fromOthers, returning, known: sync.held.length - count,
        }));
      } catch {
        yes = false;
      }
      if (yes) {
        sync.held = [];
        saveSync();
        queueLocalChanges();
      } else {
        hooks.onNotice(tr('connection.notice.localFilesStay', count === 1 ? 'Your Local Files song stays here. Synchronize now in Settings uploads it to "{server}".'
          : 'Your {count} Local Files songs stay here. Synchronize now in Settings uploads them to "{server}".', { count, server: conn.name }), 'info');
      }
    })().finally(() => { asking = null; });
    return asking;
  }

  // The first time with a server, while the music folder is still looked through: asked once that has ended.
  let awaitingScan = false;

  /**
   * After connecting: what changed here goes up, then the server's changes
   * come down. `scanned`: called again once the music folder's first look
   * has ended (see below).
   */
  function afterConnect(scanned = false) {
    // The first time with a server while the app still looks through its
    // music folder (a first start: Flow installed again, the folder still
    // full): the songs it finds were here before the server too. Taken up
    // only once all are found, they are held back and asked about like the
    // rest; taken up now, with none or some of them found, the others
    // counted as added afterwards and went up without the question.
    const scanning = !sync.snapshot && sync.held === null && typeof library.firstScan === 'function' ? library.firstScan() : null;
    if (scanning) {
      if (!awaitingScan) {
        awaitingScan = true;
        const gen = generation;
        const go = () => {
          awaitingScan = false;
          if (gen === generation && active() && status.state === 'online') afterConnect(true);
        };
        scanning.then(go, go);
      }
      flushSoon();
      afterServerChange();
      return;
    }
    const s = settings.all();
    // The first time with a server (none of the songs here has been through it),
    // they are held back until the user says they may go up.
    // After the wait for the folder's first look also when something went up
    // meanwhile (a song downloaded during it): all the others are held back.
    const before = library.get().songs.filter((x) => !(sync.snapshot && sync.snapshot.songs[x.id]) && !sync.songMap[x.id]);
    const first = (scanned || !sync.snapshot) && sync.held === null && before.length > 0;
    if (first) {
      sync.held = before.map((x) => x.id);
      saveSync();
    }
    if (s.serverAutoSync || !sync.snapshot) queueLocalChanges();
    flushSoon();
    afterServerChange();
    if (first) askHeld();
    else if (heldSinceAway) {
      heldSinceAway = 0;
      askHeld({ returning: true });
    }
  }

  let autoSyncTimer = null;
  /** Local Files changed (a scan, a download, a copy arriving). */
  function localChanged() {
    if (!active()) return;
    refreshView();
    if (!settings.get('serverAutoSync') || !sync.snapshot) return;
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => {
      if (active() && settings.get('serverAutoSync') && sync.snapshot) queueLocalChanges();
    }, AUTO_SYNC_DELAY);
  }

  /**
   * "Synchronize now": Local Files looked through, their changes sent, the
   * server's music folder looked through, and the marked playlists downloaded.
   */
  async function syncNow() {
    if (!active()) throw new Error(tr('connection.tickUseServerAndAddress', 'Tick "Use a Flow Server" and enter an address first.'));
    if (status.state !== 'online') {
      await connect();
      if (status.state !== 'online') throw new Error(status.message || tr('common.unreachable', 'The server cannot be reached.'));
    }
    status.syncing = true;
    emitStatus();
    try {
      await library.scan().catch(() => {});
      if (sync.held && sync.held.length) await askHeld();
      const { count } = queueLocalChanges();
      await flush();
      await call('/api/rescan', { method: 'POST', timeout: 120000 }).catch(() => {});
      await refresh().catch(() => {});
      await loadProfiles().catch(() => {});
      await followServer();
      status.lastSync = Date.now();
      return { sent: count, queued: sync.queue.length };
    } finally {
      status.syncing = false;
      emitStatus();
    }
  }

  // ---- the live channel ----
  //
  // While connected, one stream stays open (GET /api/live, Server-Sent Events)
  // on which the server tells this app what happens at once: the library's
  // and the stats' changes (4.3: `library`, `stats`, taken here), a session
  // paused, a join asked for (those go to the window, hooks.onLive). It opens
  // with the copy's revisions, so the server sends what is missing at once.
  // One silent for a ping and five seconds more is taken for dead (4.3: it is
  // what tells the server is there): lost, the server is asked once; no
  // answer, and the app is offline; an answer, and the stream is opened again
  // after a moment (the changes are asked for once a minute meanwhile).

  const LIVE_RETRY_MS = [1000, 2000, 5000, 10000, 20000];
  const live = {
    req: null,
    step: 0,
    retryTimer: null,
    watchdog: null,
    pingMs: 15000,
    // Server time minus this machine's: from the stream's greeting at first,
    // then measured (syncClock) once a minute, for devices playing in step.
    offset: 0,
    clockTimer: null,
  };

  const CLOCK_SAMPLES = 5;
  const CLOCK_EVERY_MS = 60 * 1000;

  /**
   * Server time minus this machine's: a few asks for the server's time, and
   * the quickest answer counts (its time was read about halfway).
   */
  async function syncClock() {
    live.clockAt = Date.now();
    let best = null;
    for (let i = 0; i < CLOCK_SAMPLES; i += 1) {
      const t0 = Date.now();
      let r;
      try {
        r = await call('/api/time', { timeout: 3000 });
      } catch {
        break;
      }
      const t1 = Date.now();
      if (!r || !Number.isFinite(Number(r.time))) break;
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: Number(r.time) - (t0 + t1) / 2 };
    }
    if (!best || !status.live) return;
    // The same within 2 ms: left as it is (told to the window, every part
    // that shows the server would draw again, once a minute, for nothing).
    if (Math.abs(best.offset - live.offset) < 2) return;
    live.offset = best.offset;
    emitStatus();
  }

  function liveWanted() {
    return active() && status.state === 'online' && !!conn.base;
  }

  function stopLive() {
    clearTimeout(live.retryTimer);
    clearTimeout(live.watchdog);
    clearInterval(live.clockTimer);
    live.clockTimer = null;
    live.retryTimer = null;
    const req = live.req;
    live.req = null;
    if (req) req.close();
    if (status.live) {
      status.live = false;
      emitStatus();
      hooks.onLive({ type: 'down', data: {} });
      // Without it the server is asked again now and then.
      if (liveWanted()) schedulePoll();
    }
  }

  function retryLive() {
    clearTimeout(live.retryTimer);
    if (!liveWanted()) return;
    const wait = LIVE_RETRY_MS[Math.min(live.step, LIVE_RETRY_MS.length - 1)];
    live.step += 1;
    live.retryTimer = setTimeout(startLive, wait);
  }

  /** Opens the stream (again), closing one already open. */
  function startLive() {
    stopLive();
    if (!liveWanted()) return;
    let url;
    try {
      // The copy's revisions (4.3): the server sends what changed since.
      const rev = copyOurs() ? cache.rev : -1;
      const srev = statsOurs() ? cache.stats.rev : -1;
      url = new URL(`${conn.base}/api/live?client=${encodeURIComponent(clientId())}&device=${encodeURIComponent(device.name())}&rev=${rev}&srev=${srev}`);
    } catch {
      return;
    }
    const headers = { Accept: 'text/event-stream' };
    if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
    let buffer = '';
    // env.http.stream: response(status) says whether to read the answer,
    // data(text) as it comes, lost() once it ends, fails or is closed with a
    // reason (closed without one, it is quiet).
    const req = http.stream(url.href, { headers }, {
      response(statusCode) {
        if (!mineNow()) {
          req.close();
          return false;
        }
        if (statusCode === 401) {
          live.req = null;
          wentWrong(new AuthError(tr('connection.signedOut', 'Signed out.')));
          return false;
        }
        if (statusCode !== 200) {
          // Refused (too many apps, an id the token does not allow): not tried
          // over and over; the next connection tries again.
          live.req = null;
          return false;
        }
        alive();
        return true;
      },
      data(chunk) {
        if (!mineNow()) return;
        alive();
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const type = (/^event: (.+)$/m.exec(block) || [])[1];
          if (!type) continue;
          let data = {};
          try {
            data = JSON.parse((/^data: (.*)$/m.exec(block) || [])[1] || '{}');
          } catch {
            continue;
          }
          liveEvent(type, data);
        }
      },
      lost: () => lost(),
    });
    live.req = req;
    live.token = conn.token;
    function mineNow() {
      return live.req === req;
    }
    function alive() {
      clearTimeout(live.watchdog);
      live.watchdog = setTimeout(() => {
        if (mineNow()) req.close(new Error('silent'));
      }, live.pingMs + 5000);
    }
    function lost() {
      if (!mineNow()) return;
      live.req = null;
      clearTimeout(live.watchdog);
      if (status.live) {
        status.live = false;
        emitStatus();
        hooks.onLive({ type: 'down', data: {} });
      }
      // Is the server still there? Asked once: no answer, and it is offline.
      checkAfterLost();
    }
  }

  let checking = null;
  /** The live channel was lost: the server asked for what changed; reached, the channel opens again soon. */
  function checkAfterLost() {
    if (checking || !liveWanted()) return;
    checking = refresh().then(() => {
      retryLive();
      schedulePoll();
    }).catch((err) => wentWrong(err)).finally(() => {
      checking = null;
    });
  }

  function liveEvent(type, data) {
    // The library's and the stats' changes (4.3) are this client's.
    if (type === 'library') {
      if (takeChanges(data)) afterServerChange();
      return;
    }
    if (type === 'stats') {
      takeStats(data);
      return;
    }
    if (type === 'hello') {
      live.step = 0;
      live.pingMs = Math.max(1000, Number(data.pingMs) || 15000);
      if (Number.isFinite(Number(data.serverTime))) live.offset = Number(data.serverTime) - Date.now();
      status.live = true;
      emitStatus();
      // Measured now; again when this device plays or is in a session (sessions()), not while it rests.
      syncClock();
    }
    if (type === 'end') {
      // The sign-in no longer holds: connecting again signs in afresh. Unless
      // this app has a new token already (a profile signed in to): then only
      // the stream opens again with it.
      if (data.reason === 'auth' && live.token !== conn.token) {
        startLive();
        return;
      }
      if (data.reason === 'auth') {
        stopLive();
        wentWrong(new AuthError(tr('connection.signedOut', 'Signed out.')));
        return;
      }
      if (data.reason === 'replaced') return;
    }
    hooks.onLive({ type, data });
  }

  // ---- Active Sessions ----

  /**
   * One request about Active Sessions: a body for POST /api/sessions ({ type,
   * ... }), or null for the list and this app's place in it (GET). Refused
   * with the server's reason.
   */
  async function sessions(body) {
    if (!active() || status.state !== 'online') throw new Error(tr('connection.unreachableNow', 'The server cannot be reached right now.'));
    if (!conn.sessions) throw new Error(tr('connection.tooOld.sessions', 'This Flow Server is too old for Active Sessions. Update it first.'));
    // The clock is measured once a minute while this device tells what it
    // plays or takes part in a session (4.6: not while it rests; it asked
    // the server five times a minute, all day).
    if (body && status.live && Date.now() - (live.clockAt || 0) >= CLOCK_EVERY_MS) syncClock();
    try {
      if (!body) return await call(`/api/sessions?client=${encodeURIComponent(clientId())}`, { timeout: 10000 });
      return await call('/api/sessions', { method: 'POST', json: { ...body, client: clientId() }, timeout: 10000 });
    } catch (err) {
      if (err instanceof OfflineError || err instanceof AuthError) wentWrong(err);
      throw err;
    }
  }

  /**
   * Out of any Active Session, for quitting: a host hands over at once instead
   * of after the server's grace for a dropped connection. Waits at most
   * `timeout` ms, and never fails.
   */
  async function leaveSession(timeout = 1500) {
    if (!active() || status.state !== 'online' || !conn.sessions || !status.live) return;
    try {
      await call('/api/sessions', { method: 'POST', json: { type: 'leave', client: clientId() }, timeout });
    } catch {
      // Quitting anyway; the server notices the dropped channel.
    }
  }

  // ---- for main.js ----

  function init(h) {
    hooks = { ...hooks, ...h };
    ensureLoaded();
    library.onChange(() => localChanged());
    if (active()) {
      buildView();
      connect();
    }
    discoverHome();
  }

  /** A setting of the server section changed: connect again, or let go. */
  function reconfigure(patch) {
    const keys = Object.keys(patch || {});
    if (!keys.some((k) => k.startsWith('server'))) return;
    const needsReconnect = keys.some((k) => ['serverOn', 'serverHome', 'serverRemote', 'serverHomeOn', 'serverRemoteOn', 'serverSecret'].includes(k));
    // An address emptied by hand is up for filling in again: the next search
    // (Home) or the next connection to the server (Remote) puts one there.
    const emptied = (key, flag) => {
      if (!keys.includes(key) || String(settings.get(key) || '').trim() || !sync[flag]) return;
      sync[flag] = false;
      saveSync();
    };
    emptied('serverHome', 'homeFilled');
    emptied('serverRemote', 'remoteFilled');
    // A changed or removed password ends the sign-in made with the old one.
    if (keys.includes('serverSecret')) runToken = '';
    if (keys.includes('serverAutoSync') && settings.get('serverAutoSync') && status.state === 'online') queueLocalChanges();
    if (keys.includes('serverMetered')) {
      // Uploads, and the marked playlists' songs and covers, go or wait by the new setting
      // (after a look already running, which stops at its next song when no longer allowed).
      flushSoon();
      Promise.resolve(following).catch(() => {}).then(() => afterServerChange());
    }
    if (!needsReconnect) {
      emitStatus();
      return;
    }
    generation += 1;
    clearTimeout(pollTimer);
    clearTimeout(retryTimer);
    retryStep = 0;
    stopLive();
    Object.assign(conn, {
      base: '', token: '', via: '', name: '', address: '', sessions: false,
    });
    status.message = '';
    if (active()) {
      status.state = 'connecting';
      hooks.onView(buildView());
      connect();
    } else {
      status.state = 'off';
    }
    emitStatus();
    if (keys.includes('serverOn') || keys.includes('serverHome') || keys.includes('serverHomeOn')) discoverHome();
  }

  /** The server password typed in Settings; kept encrypted. */
  // ---- Switch server (3.5.2) ----

  /**
   * The servers used on this device, for Settings' Switch server: the one in
   * use first, then the others, the last used first. address: its Remote
   * address, else its Home one.
   */
  function knownServers() {
    const row = (s, current, at) => ({
      id: s.serverId,
      name: s.serverName || 'Flow Server',
      address: s.addresses.remote || s.addresses.home,
      profile: s.profile ? s.profile.name : '',
      current,
      at,
    });
    const list = Object.values(loadOthers())
      .filter((o) => o.sync.serverId && o.sync.serverId !== sync.serverId && (o.sync.addresses.home || o.sync.addresses.remote))
      .sort((a, b) => b.at - a.at)
      .map((o) => row(o.sync, false, o.at));
    return sync.serverId ? [row(sync, true, Date.now()), ...list] : list;
  }

  /**
   * Switch server: to a server used before, with the addresses it answered at
   * and its password; signed in to its profile again as when it was left.
   * Asked first whether it answers: one that does not leaves this one in use.
   */
  async function switchServer(id) {
    const entry = loadOthers()[id];
    if (!entry || id === sync.serverId) throw new Error(tr('connection.switch.notUsedHere', 'Flow has not used that server on this device.'));
    const a = entry.sync.addresses;
    const name = entry.sync.serverName || 'Flow Server';
    let found = false;
    for (const address of [a.home, a.remote].filter(Boolean)) {
      try {
        const r = await request(baseUrl(address), '/api/hello', { timeout: address === a.home ? 2500 : 8000 });
        if (r.json && r.json.app === 'flow-server' && String(r.json.id) === id) {
          found = true;
          break;
        }
      } catch {
        // Tried the next.
      }
    }
    if (!found) {
      throw new Error(status.state === 'online'
        ? tr('connection.switch.unreachable.staying', '"{server}" cannot be reached right now, so Flow stays with "{current}".', { server: name, current: conn.name })
        : tr('connection.switch.unreachable', '"{server}" cannot be reached right now.', { server: name }));
    }
    await sendWaiting();
    // No Home address of its own: the search for one would find this home's server instead.
    if (!a.home) sync.homeFilled = true;
    const patch = {
      serverOn: true, serverHome: a.home, serverRemote: a.remote, serverHomeOn: !!a.home || settings.get('serverHomeOn') !== false, serverRemoteOn: !!a.remote || settings.get('serverRemoteOn') !== false,
    };
    settings.set({ ...patch, serverSecret: a.secret });
    hooks.onSettings(patch);
    reconfigure({ ...patch, serverSecret: true });
    return { name };
  }

  /** Switch server's ✕: a server no longer offered (what it left here stays, as songs on this device). */
  function forgetServer(id) {
    const parked = loadOthers();
    if (!parked[id]) return;
    delete parked[id];
    saveOthers();
    emitStatus();
    refreshView();
  }

  // ---- sharing by QR code (4.0, share.js) ----

  /**
   * The link to this server for another app's QR code scan: its addresses and,
   * when it has a password, a one-time pairing code for it (the password this
   * app keeps, handed to the server for 10 minutes). A server from before 4.0,
   * or a password this app does not know (at home from level 3 on): no code,
   * the other app is asked for the password.
   */
  async function shareLink() {
    if (!active() || status.state !== 'online') throw new Error(tr('connection.notConnected', 'Flow is not connected to its server right now.'));
    const s = settings.all();
    let code = '';
    const pw = decrypt(s.serverSecret);
    if (conn.pair && pw) code = (await call('/api/pair', { method: 'POST', json: { password: pw } })).code || '';
    let home = s.serverHomeOn !== false && s.serverHome ? s.serverHome : (conn.via === 'home' ? conn.address : '');
    // The server runs here: the other device reaches it at this machine's address.
    if (/^(localhost|127\.)/i.test(home)) {
      const ip = network.lanAddress ? network.lanAddress() : '';
      home = ip ? home.replace(/^[^:/]+/, ip) : '';
    }
    const remote = s.serverRemoteOn !== false ? String(s.serverRemote || '') : '';
    if (!home && !remote) throw new Error(tr('connection.share.noAddress', 'This server has no address another device could use. Enter its Home address (as the other device reaches it) first.'));
    return {
      link: makeLink({
        id: sync.serverId, name: conn.name, home, remote, code,
      }),
      code: !!code,
      name: conn.name,
    };
  }

  /**
   * A link scanned or pasted: its server becomes the one in use, its pairing
   * code traded for the password first (at its Home address, else Remote).
   * Resolves { name }.
   */
  async function connectLink(text) {
    const l = parseLink(text);
    if (!l) throw new Error(tr('connection.link.notFlow', 'That is not a link to a Flow Server.'));
    let password = null;
    if (l.code) {
      for (const address of [l.home, l.remote].filter(Boolean)) {
        let r;
        try {
          r = await request(baseUrl(address), '/api/pair/redeem', { method: 'POST', json: { code: l.code }, timeout: address === l.home ? 3000 : 10000 });
        } catch (err) {
          if (err instanceof OfflineError) continue;
          throw err;
        }
        if (r.status === 200 && r.json) {
          password = String(r.json.password || '');
          break;
        }
        throw new Error((r.json && r.json.error) || tr('connection.link.answered', '"{server}" answered {status}.', { server: l.name, status: r.status }));
      }
      if (password === null) throw new Error(tr('connection.link.unreachable', '"{server}" cannot be reached from here right now. Try on its home network, or ask for a new QR code.', { server: l.name }));
    }
    if (sync.serverId && sync.serverId !== l.id) await sendWaiting();
    // No Home address of its own: the search for one would find this home's server instead.
    if (!l.home) sync.homeFilled = true;
    const patch = {
      serverOn: true, serverHome: l.home, serverRemote: l.remote, serverHomeOn: true, serverRemoteOn: true,
    };
    settings.set(password === null ? patch : { ...patch, serverSecret: encrypt(password) });
    hooks.onSettings(patch);
    reconfigure({ ...patch, serverSecret: true });
    return { name: l.name };
  }

  function setSecret(text) {
    settings.set({ serverSecret: encrypt(String(text || '')) });
    reconfigure({ serverSecret: true });
  }

  /** Marks a server playlist for download, or no longer. */
  async function setOffline(pid, on) {
    const all = isAllList(pid);
    if (on && !all && !markedList(getView(), pid)) throw new Error(tr('songs.error.onlyOwnDownloads', 'Only All Songs, your own playlists and the ones you follow can be downloaded.'));
    if (on && !sync.offline.includes(pid)) sync.offline.push(pid);
    if (!on) sync.offline = sync.offline.filter((x) => x !== pid);
    if (on && !all) sync.offlineKeep[pid] = { profile: currentProfile(), songs: markedSongs(pid, getView()) };
    else delete sync.offlineKeep[pid];
    saveSync();
    emitStatus();
    if (on) afterServerChange();
    else await dropUnneededCopies();
    refreshView();
  }

  /**
   * A song downloaded (or imported) here while the server is on: it goes up
   * now, into the server playlists picked for it.
   */
  function pushNew(playlistsFor = {}) {
    queueLocalChanges({ onlyNew: true, playlistsFor });
  }

  /**
   * An import: its songs (songIds, in Local Files) go up, into the imported
   * playlist (an existing server playlist when that was picked) and the server
   * playlists picked with "Add to Playlist" (playlistIds). The songs it took
   * from the library (existingIds) join the same playlists.
   */
  function pushImport({ localPlaylistId, mergeInto, existingIds, playlistIds = [], songIds = [], times = {} }) {
    if (localPlaylistId && mergeInto && !sync.listMap[localPlaylistId]) sync.listMap[localPlaylistId] = mergeInto;
    const extra = playlistIds.filter((id) => model.playlistById(getView(), id));
    queueLocalChanges({ onlyNew: true, lists: localPlaylistId ? [localPlaylistId] : null });
    const target = localPlaylistId && sync.listMap[localPlaylistId];
    const known = (existingIds || []).filter((id) => model.songById(getView(), id));
    const into = [...new Set([target, ...extra].filter(Boolean))];
    // Each song at its own time, so the playlists read as the source.
    const add = (songId, playlistIds, at) => sync.queue.push(newCommand('addSongToPlaylists', {
      songId, playlistIds, at: Number(at) || Date.now(),
    }));
    if (extra.length) for (const lid of songIds) add(sync.songMap[lid] || lid, extra, times[lid]);
    if (into.length) for (const id of known) add(id, into, times[id]);
    if ((extra.length && songIds.length) || (into.length && known.length)) {
      saveSync();
      refreshView();
      flushSoon();
    }
  }

  /** Deleting a song: from the server, and its copy here. */
  async function deleteSong(songId, deleteFile) {
    // A copy here only taken for it (not tied to it): its file goes when asked.
    const loose = deleteFile && !Object.values(sync.songMap).includes(songId) && localCopies().get(songId);
    let onlyWaiting = false;
    for (const [lid, sid] of Object.entries(sync.songMap)) {
      if (sid !== songId) continue;
      const waiting = sync.queue.find((c) => c.type === 'upload' && c.localId === lid);
      if (waiting) {
        sync.queue = sync.queue.filter((c) => c !== waiting);
        onlyWaiting = true;
      }
      await forgetLocal(lid, { deleteFile: deleteFile || !!sync.fetched[lid] });
    }
    // In use (playing): it stays.
    if (loose) await deleteHere(loose).catch(() => {});
    if (onlyWaiting) {
      // It never reached the server; what was queued for it has nothing to act on.
      sync.queue = sync.queue.filter((c) => c.songId !== songId);
      saveSync();
      refreshView();
      return null;
    }
    return command('deleteSong', { songId });
  }

  /**
   * A song's Download button: one server song into Local Files, kept there
   * until the button is clicked again (a copy nothing asks for is otherwise
   * dropped, see dropUnneededCopies).
   */
  async function downloadSong(songId) {
    if (!active()) throw new Error(tr('connection.tickUseServer', 'Tick "Use a Flow Server" first.'));
    if (status.state !== 'online') throw new Error(tr('songs.error.downloadUnreachable', 'The server cannot be reached right now. A song can only be downloaded while it can.'));
    const song = model.songById(getView(), songId);
    if (!song) throw new Error(tr('songs.error.notOnServer', 'That song is not on the server.'));
    if (localCopies().has(songId)) {
      sync.kept[songId] = true;
      saveSync();
      return;
    }
    const label = [song.artist, song.title].filter(Boolean).join(' - ');
    // Marked before the copy exists: a synchronization in between must not drop it as unneeded.
    sync.kept[songId] = true;
    saveSync();
    status.transfer = tr('sync.transfer.downloadingOne', 'Downloading: {song}', { song: label });
    status.transferUp = false;
    emitStatus();
    try {
      await fetchSong(song, (f) => {
        status.transfer = tr('sync.transfer.downloadingOne.percent', 'Downloading ({percent}%): {song}', { percent: Math.round(f * 100), song: label });
        emitStatus();
      });
    } catch (err) {
      delete sync.kept[songId];
      saveSync();
      if (err instanceof OfflineError || err instanceof AuthError) wentWrong(err);
      throw new Error(tr('sync.downloadFailed', '"{song}" could not be downloaded: {reason}', { song: label, reason: err.message }));
    } finally {
      status.transfer = '';
      emitStatus();
    }
    refreshView();
  }

  /**
   * The Download button clicked again: the local copy is deleted (the song stays
   * on the server). Not while it would be undone at once (a playlist marked for
   * download holds the song), or lost for good (it has not gone up yet).
   */
  async function removeDownload(songId) {
    if (!active()) throw new Error(tr('connection.tickUseServer', 'Tick "Use a Flow Server" first.'));
    const lids = Object.entries(sync.songMap).filter(([, sid]) => sid === songId).map(([lid]) => lid);
    // A copy here only taken for it (not tied to it): its file goes, as from Downloaded Songs.
    const loose = !lids.length && localCopies().get(songId);
    if (!lids.length && !loose) {
      delete sync.kept[songId];
      saveSync();
      return;
    }
    if (sync.queue.some((c) => c.type === 'upload' && c.songId === songId)) {
      throw new Error(tr('songs.error.notUploadedYet', 'This song has not been uploaded to the server yet. Its file here is the only copy.'));
    }
    if (sync.offline.some((pid) => markedSongs(pid, getView()).includes(songId))) {
      throw new Error(tr('songs.error.markedForDownload', 'This song is in a playlist marked for download (or All Songs is), so it would come straight back. Unmark that in Settings first.'));
    }
    delete sync.kept[songId];
    saveSync();
    if (loose) {
      try {
        await deleteHere(loose);
      } catch (err) {
        sync.kept[songId] = true;
        saveSync();
        throw err;
      }
    }
    for (const lid of lids) {
      if (!(await forgetLocal(lid, { deleteFile: true }))) {
        sync.kept[songId] = true;
        saveSync();
        throw new Error(tr('songs.error.fileInUse', 'The song\'s file is in use (playing?). Try again once it has stopped.'));
      }
    }
    refreshView();
  }

  /**
   * Every download goes: no playlist is marked for download any more, no song
   * kept by hand, and the copies fetched from the server are deleted (songs
   * that began here stay, and so does one still to go up). Resolves how many
   * were deleted, and how many are in use (playing) and stay for now.
   */
  async function removeAllDownloads() {
    if (!active()) throw new Error(tr('connection.tickUseServer', 'Tick "Use a Flow Server" first.'));
    sync.offline = [];
    sync.offlineKeep = {};
    sync.kept = {};
    saveSync();
    emitStatus();
    let removed = 0;
    let inUse = 0;
    for (const lid of Object.keys(sync.fetched)) {
      const sid = sync.songMap[lid];
      if (sync.queue.some((c) => c.type === 'upload' && (c.localId === lid || c.songId === sid))) continue;
      if (await forgetLocal(lid, { deleteFile: true })) removed += 1;
      else inUse += 1;
    }
    refreshView();
    return { removed, inUse };
  }

  /** The local copy of a server song (or a song of Downloaded Songs' own), if there is one. */
  function localFileOf(songId) {
    const id = String(songId || '');
    const copy = id.startsWith(DEVICE) ? model.songById(library.get(), id.slice(DEVICE.length)) : localCopies().get(id);
    return copy && files.exists(copy.file) ? copy.file : null;
  }

  /**
   * Downloaded Songs' Delete from this device, for a song that is not this
   * server's (DEVICE + its Local Files id): its file goes, and so do the
   * other servers' ties to it (on them it stays).
   */
  async function removeDeviceSong(songId) {
    const id = String(songId || '');
    if (!id.startsWith(DEVICE)) throw new Error(tr('songs.error.notOwn', 'That song is not one of this device\'s own.'));
    const lid = id.slice(DEVICE.length);
    const song = model.songById(library.get(), lid);
    if (!song) return;
    if (sync.songMap[lid]) throw new Error(tr('songs.error.isOnServer', 'That song is on this server: delete it from here with its Download button.'));
    await deleteHere(song);
    refreshView();
  }

  /** A Local Files song not tied to this server: its file goes, and so do the other servers' ties to it. */
  async function deleteHere(song) {
    const lid = song.id;
    let gone = false;
    await library.quietly(async () => {
      try {
        files.rm(song.file, { force: true });
      } catch {
        return;
      }
      library.mutate((d) => model.removeSong(d, lid, false));
      gone = true;
    });
    if (!gone) throw new Error(tr('songs.error.fileInUse', 'The song\'s file is in use (playing?). Try again once it has stopped.'));
    for (const o of Object.values(loadOthers())) {
      delete o.sync.songMap[lid];
      delete o.sync.fetched[lid];
      if (o.sync.held) o.sync.held = o.sync.held.filter((x) => x !== lid);
    }
    saveOthers();
    if (sync.held) sync.held = sync.held.filter((x) => x !== lid);
    if (sync.snapshot) delete sync.snapshot.songs[lid];
    saveSync();
  }

  /**
   * A song's whole file, as the player plays it: the copy here when there is
   * one, else the server's, fetched into the cache. Resolves { file, temp }
   * (temp: the caller removes it). For the desktop's check of where a seek in
   * an MP3 really landed, which decodes the song from its start.
   */
  async function songAudio(songId) {
    const here = localFileOf(songId);
    if (here) return { file: here, temp: false };
    if (!active() || status.state !== 'online') throw new Error(tr('common.unreachable', 'The server cannot be reached.'));
    files.mkdir(paths.cacheDir());
    const tmp = files.join(paths.cacheDir(), `.flow-audio-${randomHex(5)}`);
    try {
      const r = await request(conn.base, audioPath(songId), { token: conn.token, saveTo: tmp, timeout: 60000 });
      if (r.status !== 200) throw new Error(tr('connection.serverAnswered.lower', 'the server answered {status}', { status: r.status }));
    } catch (err) {
      files.rm(tmp, { force: true });
      throw err;
    }
    return { file: tmp, temp: true };
  }

  // ---- downloads by the server ("Download (Server)" on Add Songs) ----
  //
  // The server keeps one batch per profile (apps/linux-server/src/downloads.js),
  // or with downloadQueue (4.4) several taking turns with every profile's, and
  // the window polls it while Add Songs is open. None of it goes through Local
  // Files: a song finished there is the server's at once, like any other.

  function requireDownloads() {
    if (!active() || status.state !== 'online') throw new Error(tr('connection.unreachableNow', 'The server cannot be reached right now.'));
    if (!conn.downloads) throw new Error(tr('connection.noDownloads', 'This Flow Server does not download songs.'));
  }

  /**
   * One request about the server's download batch. action: get, create
   * ({ url, kind, options }), cancel, peaks ({ index }), finish ({ index, body }),
   * retry ({ index }), discard ({ index }). Resolves the batch (null: none), or
   * for peaks the peaks, for finish { song, batch }. With the server's queue
   * (4.4): queue resolves { batches, queue, done } (null where there is none
   * to ask); args.batchId names the batch the others are about (none: the
   * profile's oldest); create takes queue: true and auto ({ complete,
   * finish }), and review: true (4.4.1, downloadReview) for a list that
   * waits for its songs to be chosen: choose ({ batchId, indexes }).
   */
  async function serverDownloads(action, args = {}) {
    if ((action === 'get' || action === 'queue') && (!active() || status.state !== 'online' || !conn.downloads)) return null;
    if (action === 'queue' && !conn.downloadQueue) return null;
    requireDownloads();
    const batchId = conn.downloadQueue && /^[0-9a-f]{12}$/.test(String(args.batchId || '')) ? String(args.batchId) : '';
    const item = `/api/downloads${batchId ? `/${batchId}` : ''}/items/${Math.max(0, Math.floor(Number(args.index) || 0))}`;
    try {
      if (action === 'get') return (await call('/api/downloads')).batch;
      if (action === 'queue') {
        const r = await call('/api/downloads?queue=1');
        return { batches: r.batches || [], queue: r.queue || [], done: r.done || [] };
      }
      // create: cookies, the link's site's browser cookies (or none). Or items
      // and name: uploads picked from a search, several at once; with source
      // ({ url, kind }), the songs ticked in a playlist's Update.
      if (action === 'create') {
        const { url, kind, options, cookies, items, name, source } = args;
        const json = items ? { items, name, options, source: source || undefined } : { url, kind, options, cookies: cookies || undefined };
        // Queued behind what the server is doing, finishing by itself as asked.
        if (conn.downloadQueue && args.queue) Object.assign(json, { queue: true, auto: args.auto || undefined });
        // Read, it waits for the songs ticked in the checklist (choose).
        if (conn.downloadReview && args.review && !items) json.review = true;
        return (await call('/api/downloads', { method: 'POST', json })).batch;
      }
      // A playlist's Update: its link read on the server, nothing downloaded ({ url, cookies }).
      if (action === 'check') {
        if (!conn.downloadCheck) throw new Error(tr('connection.tooOld.playlistUpdates', 'This Flow Server cannot check a playlist for updates yet: update it.'));
        const json = { url: args.url, cookies: args.cookies || undefined };
        return (await call('/api/downloads/check', { method: 'POST', json, timeout: 15 * 60 * 1000 })).listing;
      }
      if (action === 'cancel') return (await call(`/api/downloads${batchId ? `/${batchId}` : ''}`, { method: 'DELETE' })).batch;
      // The songs ticked in the checklist of a batch in review (4.4.1).
      if (action === 'choose') {
        if (!batchId || !conn.downloadReview) throw new Error(tr('connection.unknownDownloadAction', 'Unknown download action {action}.', { action }));
        const indexes = (Array.isArray(args.indexes) ? args.indexes : []).map(Number).filter(Number.isInteger);
        return (await call(`/api/downloads/${batchId}/choose`, { method: 'POST', json: { indexes } })).batch;
      }
      // A song's name typed instead of a link: { query, artist, title, page, results }.
      if (action === 'search') {
        if (!conn.search) throw new Error(tr('connection.tooOld.songSearch', 'This Flow Server cannot search for songs by name yet: update it, or paste a link.'));
        return await call('/api/downloads/search', { method: 'POST', json: { query: args.query, page: Number(args.page) || 0 }, timeout: 120000 });
      }
      if (action === 'peaks') return (await call(`${item}/peaks`, { timeout: 30000 })).peaks;
      if (action === 'cover') return await stagedServerCover(item, args);
      if (action === 'retry') return (await call(`${item}/retry`, { method: 'POST' })).batch;
      if (action === 'discard') return (await call(item, { method: 'DELETE' })).batch;
      if (action === 'finish') {
        const r = await call(`${item}/finish`, { method: 'POST', json: args.body || {}, timeout: 5 * 60 * 1000 });
        // The song (and its playlist) is in the server's library now: fetched
        // at once, so the window has it before it says "Open playlist".
        try {
          if (await refresh()) afterServerChange();
        } catch {
          // The next poll brings it.
        }
        return { song: r.song, batch: r.batch, playlistId: r.playlistId || null };
      }
    } catch (err) {
      if (err instanceof OfflineError || err instanceof AuthError) wentWrong(err);
      throw err;
    }
    throw new Error(tr('connection.unknownDownloadAction', 'Unknown download action {action}.', { action }));
  }

  /**
   * The cover the server found for a song of its download batch, fetched into
   * the cache (emptied at every start): the file, or '' without one.
   */
  async function stagedServerCover(item, { index, version }) {
    const v = String(version || '');
    if (!/^[0-9a-f]{4,40}$/.test(v)) return '';
    const file = files.join(paths.cacheDir(), `server-cover-${Math.floor(Number(index) || 0)}-${v}.jpg`);
    if (files.exists(file)) return file;
    files.mkdir(paths.cacheDir());
    const tmp = `${file}.${randomHex(4)}.tmp`;
    try {
      const r = await request(conn.base, `${item}/cover?v=${v}`, { token: conn.token, saveTo: tmp, timeout: 30000 });
      if (r.status !== 200) return '';
      if (!isPicture(files.read(tmp).subarray(0, 16))) return '';
      files.rename(tmp, file);
      return file;
    } finally {
      files.rm(tmp, { force: true });
    }
  }

  // ---- profiles: signing in and out ----

  /** The server's profiles, fresh. Forgets what was waiting for profiles gone. */
  async function loadProfiles() {
    if (status.state !== 'online' || !conn.profiles) {
      status.profiles = null;
      emitStatus();
      return null;
    }
    const r = await call('/api/profiles');
    const list = (Array.isArray(r.profiles) ? r.profiles : []).map(cleanProfile).filter(Boolean);
    status.profiles = list;
    status.rules = { ...status.rules, createProfiles: r.createProfiles !== false };
    const known = new Set(list.map((p) => p.id));
    const gone = (id) => id && !known.has(id);
    const before = sync.queue.length;
    sync.queue = sync.queue.filter((c) => SHARED_TYPES.has(c.type) || !gone(c.profile));
    let changed = sync.queue.length !== before;
    for (const pid of sync.offline.slice()) {
      const keep = sync.offlineKeep[pid];
      // A profile deleted: its songs' list is no longer in the menu to unmark.
      if ((keep && gone(keep.profile)) || (pid.startsWith(FROM) && gone(pid.slice(FROM.length)))) {
        sync.offline = sync.offline.filter((x) => x !== pid);
        delete sync.offlineKeep[pid];
        changed = true;
      }
    }
    if (changed) {
      saveSync();
      afterServerChange();
    }
    // The signed-in profile as the list has it: made admin or master on the
    // server (flow-server admin) changes no library, so refresh() can answer
    // 204 and keep the copy from before.
    const mineNow = sync.profile && list.find((p) => p.id === sync.profile.id);
    if (mineNow && ['name', 'pin', 'admin', 'master'].some((k) => mineNow[k] !== sync.profile[k])) {
      sync.profile = { ...mineNow, createdAt: mineNow.createdAt || sync.profile.createdAt };
      saveSync();
    }
    emitStatus();
    return list;
  }

  function requireProfiles() {
    if (!active()) throw new Error(tr('connection.tickUseServer', 'Tick "Use a Flow Server" first.'));
    if (status.state !== 'online') throw new Error(tr('connection.profiles.unreachable', 'The server cannot be reached right now. Profiles can only be changed while it can.'));
    if (!conn.profiles) throw new Error(tr('connection.tooOld.profiles', 'This Flow Server is too old for profiles. Update it first.'));
  }

  /**
   * What is waiting for the signed-in profile goes before signing in to
   * another: sent afterwards, it would land in the wrong one. A flush already
   * under way may have started before the latest change, hence a second try.
   */
  async function sendWaiting() {
    for (let i = 0; i < 2 && status.state === 'online' && sync.queue.some(mine); i += 1) {
      await flush().catch(() => {});
    }
  }

  /**
   * Signed in to another profile (null: none): the library is fetched afresh
   * and the local copies follow. Call sendWaiting() before the server switches.
   */
  async function switchProfile(token, profile, pin = '') {
    if (token !== undefined) {
      conn.token = token;
      sync.token = keepToken(token);
      runToken = token;
    }
    // The old token is gone on the server, and the copy's revisions are
    // another profile's: the live channel opens again once the copy is this one's.
    stopLive();
    sharedOpen.clear();
    sync.profile = cleanProfile(profile);
    sync.logoutPending = false;
    // Kept encrypted, so the next start can sign in to it again (restoreProfile).
    sync.profilePin = sync.profile && sync.profile.pin ? encrypt(pin) : '';
    sync.sent = [];
    // rev -1: the next fetch brings the whole library, whatever the revision.
    cache = { ...cache, rev: -1, profile: currentProfile() };
    saveSync();
    saveCache();
    try {
      await refresh();
    } finally {
      startLive();
    }
    await loadProfiles().catch(() => {});
    afterServerChange();
    emitStatus();
    return sync.profile;
  }

  async function loginProfile(profileId, pin) {
    requireProfiles();
    await sendWaiting();
    const r = await call('/api/profiles/login', { method: 'POST', json: { profileId, pin: String(pin || ''), device: device.name(), client: clientId() }, timeout: 20000 });
    return switchProfile(r.token, r.profile, String(pin || ''));
  }

  async function createProfile(name, pin) {
    requireProfiles();
    // So the new profile's copy of the Default / Shared playlists has everything made before it.
    await sendWaiting();
    const r = await call('/api/profiles', { method: 'POST', json: { name, pin: String(pin || ''), device: device.name(), client: clientId() }, timeout: 20000 });
    return switchProfile(r.token, r.profile, String(pin || ''));
  }

  async function logoutProfile() {
    // Away from the server: from now on without the profile here, and the
    // server hears it at the next connection (restoreProfile). What of the
    // profile still waits to go up waits for its next login.
    if (active() && status.state !== 'online' && sync.profile) {
      sync.profile = null;
      sync.profilePin = '';
      sync.logoutPending = true;
      cache = { ...cache, rev: -1, profile: '' };
      saveSync();
      saveCache();
      refreshView();
      emitStatus();
      return null;
    }
    requireProfiles();
    await sendWaiting();
    await call('/api/profiles/logout', { method: 'POST', json: {} });
    return switchProfile(undefined, null);
  }

  /** `pin`: the profile's current one (servers from before 3.5.1 do not ask for it). */
  async function renameProfile(name, pin = '') {
    requireProfiles();
    const r = await call('/api/profiles/rename', { method: 'POST', json: { name, pin: String(pin || '') } });
    sync.profile = cleanProfile(r.profile);
    saveSync();
    await loadProfiles().catch(() => {});
    emitStatus();
    return sync.profile;
  }

  /** The signed-in profile's PIN changed from `pin` to `newPin` ('': none). */
  async function changePin(pin, newPin) {
    requireProfiles();
    if (!conn.pin) throw new Error(tr('connection.tooOld.changePin', 'This Flow Server is too old to change a PIN. Update it first.'));
    if (!currentProfile()) throw new Error(tr('connection.profiles.loginFirst', 'Log in to a profile first.'));
    const r = await call('/api/profiles/pin', { method: 'POST', json: { pin: String(pin || ''), newPin: String(newPin || '') } });
    sync.profile = cleanProfile({ ...sync.profile, ...r.profile });
    // The next start signs in with the new one (restoreProfile).
    sync.profilePin = sync.profile.pin ? encrypt(String(newPin)) : '';
    saveSync();
    await loadProfiles().catch(() => {});
    emitStatus();
    return sync.profile;
  }

  /** Deletes the signed-in profile: its playlists, favourites and stats. */
  async function deleteProfile() {
    requireProfiles();
    const gone = currentProfile();
    if (!gone) throw new Error(tr('connection.profiles.loginFirst', 'Log in to a profile first.'));
    // A song renamed or deleted in it still counts.
    await sendWaiting();
    await call('/api/profiles/delete', { method: 'POST', json: {} });
    sync.queue = sync.queue.filter((c) => SHARED_TYPES.has(c.type) || c.profile !== gone);
    for (const [pid, keep] of Object.entries(sync.offlineKeep)) {
      if (keep.profile !== gone) continue;
      sync.offline = sync.offline.filter((x) => x !== pid);
      delete sync.offlineKeep[pid];
    }
    return switchProfile(undefined, null);
  }

  // ---- Administration (3.5) ----

  /**
   * One of the admins' routes (/api/admin/<route>, see the server's admin.js):
   * fetched (no body) or posted (`body`). Only for an admin profile.
   */
  async function admin(route, body) {
    requireProfiles();
    if (!conn.admin) throw new Error(tr('connection.tooOld.admin', 'This Flow Server is too old for Administration. Update it first.'));
    if (!/^[\w/-]{1,120}$/.test(String(route || ''))) throw new Error(tr('connection.admin.noSuchPage', 'No such page in Administration.'));
    const r = await call(`/api/admin/${route}`, body === undefined ? { timeout: 30000 } : { method: 'POST', json: body, timeout: 60000 });
    // What the admins change can change what this app sees (a song back
    // from the trash, a rule): fetched now rather than at the next poll.
    if (body !== undefined) refresh().catch(() => {});
    return r;
  }

  /**
   * The master admin changes the server password (or takes it away:
   * `remove`). Every other device signs in again; this one keeps going with
   * the token it gets back, and keeps the new password for its next start.
   */
  async function changeServerPassword({ current, password, remove }) {
    requireProfiles();
    const r = await call('/api/admin/password', {
      method: 'POST', json: { current: String(current || ''), password: String(password || ''), remove: !!remove }, timeout: 30000,
    });
    settings.set({ serverSecret: encrypt(remove ? '' : String(password || '')) });
    if (r.token) {
      conn.token = r.token;
      runToken = r.token;
      sync.token = keepToken(r.token);
      saveSync();
      // The live channel opened with the old token, which the server no longer knows.
      startLive();
    }
    emitStatus();
    return {};
  }

  function stop() {
    generation += 1;
    // What waited to be saved (saveSyncSoon).
    if (syncSaveTimer) saveSync();
    stopLive();
    clearTimeout(pollTimer);
    clearTimeout(retryTimer);
    clearTimeout(flushTimer);
    clearTimeout(autoSyncTimer);
  }

  return {
    init, active, reconfigure, setSecret, stop, adoptToken,
    coverDir, wantCovers, coverStats, clearCoverCache, isServerCopy, localOf,
    trimSong, trimmedHere, songPeaks, songLyrics, setSongLyrics, useOwnLyrics, useLyricsSync, useForgotLocal, lyricsOf, offlineIds, serverSongOf, serverId, newCutId,
    status: publicStatus, view: getView, command, syncNow, serverDownloads, setOffline, downloadSong, removeDownload, removeAllDownloads, removeDeviceSong, switchServer, forgetServer, pushNew, pushImport, deleteSong, localFileOf, songAudio, sessions, leaveSession,
    loadProfiles, loginProfile, createProfile, logoutProfile, renameProfile, changePin, deleteProfile,
    admin, changeServerPassword, removeTracked, shareLink, connectLink,
    loadStatistics, loadShared, openShared,
  };
}

module.exports = { createRemote };
