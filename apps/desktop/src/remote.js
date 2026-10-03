'use strict';

// "Streaming, Download and Synchronization": a Flow Server as the library.
//
// The server holds the one true library. The app keeps the last copy it saw
// (server-library.json) so it opens, and plays what it has, without the
// server. Every change made here (a song renamed, a playlist made) goes to the
// server as a command (@flow/core/commands); a change made while the server
// cannot be reached waits in the queue (server-sync.json) and goes once it
// can. What the window shows is the server's library with the waiting
// commands applied on top, so a change shows at once either way.
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
//             removed by hand, a playlist made while the server was off.
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
// Covers: every song's comes down in the background into Covers\<server id>
// (covers.js), and stays there across restarts and server switches; one
// goes when its song is gone from that server.
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

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { safeStorage } = require('electron');
const paths = require('./paths');
const settings = require('./settings');
const library = require('./library');
const exporter = require('./exporter');
const network = require('./network');
const covers = require('./covers');
const { coverVersion } = require('@flow/core/cover');
const model = require('@flow/core/libraryModel');
const { applyCommand } = require('@flow/core/commands');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { songFileStem } = require('@flow/core/text');
const { serverBaseUrl: baseUrl, isTailscaleAddress } = require('@flow/core/address');
const discovery = require('@flow/core/discovery');

const ALL = model.ALL_SONGS_ID;
const PROTOCOL = 1;
const POLL_MS = 10000;
// While on the remote address, how often home is tried again.
const HOME_RETRY_MS = 2 * 60 * 1000;
const RETRY_MS = [3000, 5000, 10000, 20000, 30000, 60000];
const AUTO_SYNC_DELAY = 2500;

// ---- where it is kept ----

const cacheFile = () => path.join(paths.ensure(paths.rootDir()), 'server-library.json');
const syncFile = () => path.join(paths.ensure(paths.rootDir()), 'server-sync.json');

function emptySync(serverId = '') {
  return {
    serverId, token: '', profile: null, queue: [], sent: [], songMap: {}, listMap: {}, snapshot: null, held: null, offline: [], offlineKeep: {}, fetched: {}, kept: {}, profilePin: '', remoteFilled: false, homeFilled: false,
  };
}

function cleanProfile(p) {
  return p && typeof p === 'object' && p.id ? { id: String(p.id), name: String(p.name || ''), pin: !!p.pin } : null;
}

function loadSync() {
  const raw = readJson(syncFile());
  const s = { ...emptySync(), ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const key of ['queue', 'sent', 'offline']) if (!Array.isArray(s[key])) s[key] = [];
  for (const key of ['songMap', 'listMap', 'fetched', 'kept', 'offlineKeep']) if (!s[key] || typeof s[key] !== 'object') s[key] = {};
  s.profile = cleanProfile(s.profile);
  s.held = Array.isArray(s.held) ? s.held.map(String) : null;
  if (s.snapshot && (typeof s.snapshot !== 'object' || !s.snapshot.songs || !s.snapshot.lists)) s.snapshot = null;
  return s;
}

function loadCache() {
  const raw = readJson(cacheFile());
  if (!raw || typeof raw !== 'object' || !raw.library) return { serverId: '', rev: -1, library: null, profile: '' };
  return { serverId: String(raw.serverId || ''), rev: Number(raw.rev), library: model.sanitize(raw.library), profile: String(raw.profile || '') };
}

let cache = { serverId: '', rev: -1, library: null, profile: '' };
let sync = emptySync();
let loaded = false;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  cache = loadCache();
  sync = loadSync();
}

function saveSync() {
  try {
    writeJsonAtomic(syncFile(), sync);
  } catch {
    // Kept in memory; the next save tries again.
  }
}

function saveCache() {
  try {
    writeJsonAtomic(cacheFile(), cache);
  } catch {
    // Only the copy for starting offline; the server still has it all.
  }
}

// ---- the passwords and PINs, kept encrypted ----

function encrypt(text) {
  if (!text) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return 'e:' + safeStorage.encryptString(String(text)).toString('base64');
  } catch {
    // Fall through.
  }
  return 'p:' + Buffer.from(String(text)).toString('base64');
}

function decrypt(stored) {
  const s = String(stored || '');
  try {
    if (s.startsWith('e:')) return safeStorage.decryptString(Buffer.from(s.slice(2), 'base64'));
    if (s.startsWith('p:')) return Buffer.from(s.slice(2), 'base64').toString('utf8');
  } catch {
    // Encrypted by another Windows user or machine: as good as none.
  }
  return '';
}

// ---- talking to the server ----

// The token this run of Flow signed in with (never read back from disk).
let runToken = '';

/** This install's id, made once: the server tells devices apart by it. */
function clientId() {
  let id = settings.get('clientId');
  if (!id) {
    id = crypto.randomBytes(12).toString('base64url');
    settings.set({ clientId: id });
  }
  return id;
}

class OfflineError extends Error {}
class AuthError extends Error {}

/**
 * One request. `body` may be JSON (`json`) or a file (`file`, streamed up);
 * `saveTo` streams the answer into a file. Resolves { status, json }.
 * Unreachable, timed out or cut off: OfflineError.
 */
function request(base, pathname, { method = 'GET', json, file, saveTo, token, timeout = 15000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(base + pathname);
    } catch {
      reject(new Error('That is not an address.'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload = null;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    } else if (file) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = fs.statSync(file).size;
    }
    const req = lib.request(url, { method, headers }, (res) => {
      if (saveTo && res.statusCode === 200) {
        const out = fs.createWriteStream(saveTo);
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (onProgress && total) onProgress(got / total);
        });
        res.pipe(out);
        out.on('finish', () => {
          if (total && got !== total) reject(new OfflineError('The download was cut off.'));
          else resolve({ status: 200, json: null });
        });
        out.on('error', (err) => reject(err));
        res.on('aborted', () => {
          out.destroy();
          reject(new OfflineError('The download was cut off.'));
        });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode, json: body });
      });
      res.on('aborted', () => reject(new OfflineError('The connection was cut off.')));
    });
    req.setTimeout(timeout, () => req.destroy(new OfflineError('The server did not answer in time.')));
    req.on('error', (err) => reject(err instanceof OfflineError ? err : new OfflineError(err.message)));
    if (payload) req.end(payload);
    else if (file) {
      const stream = fs.createReadStream(file);
      const total = headers['Content-Length'] || 0;
      let sent = 0;
      stream.on('data', (c) => {
        sent += c.length;
        if (onProgress && total) onProgress(sent / total);
      });
      stream.on('error', (err) => req.destroy(err));
      stream.pipe(req);
    } else req.end();
  });
}

/** A JSON route that must answer 2xx: its body, or an Error saying why not. */
async function call(pathname, opts = {}) {
  const r = await request(conn.base, pathname, { token: conn.token, ...opts });
  if (r.status === 401) throw new AuthError((r.json && r.json.error) || 'This server needs its password.');
  if (r.status < 200 || r.status >= 300) throw new Error((r.json && r.json.error) || `The server answered ${r.status}.`);
  return r.json;
}

// ---- state for the window ----

// The connection in use: base address, token, which address it is, whether
// the server knows profiles, whether it downloads songs itself and whether it
// has Active Sessions (a live channel).
const conn = { base: '', token: '', via: '', name: '', address: '', profiles: false, downloads: false, sessions: false };
const status = {
  state: 'off', // off | connecting | online | offline | password | error
  message: '',
  transfer: '', // "Uploading 3 of 12: ..." while songs go up or down
  note: '', // why songs wait (a metered connection), or '' 
  syncing: false,
  searching: false, // looking for a server on the network
  lastSync: 0,
  profiles: null, // the server's profiles [{ id, name, pin }]; null: it has none to offer
  live: false, // the live channel is open
};

// ---- profiles ----

// Commands that do the same whoever sends them: the songs are shared.
const SHARED_TYPES = new Set(['editSong', 'deleteSong', 'setLoudness', 'setDuration']);

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
};
let view = null;

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
    // Connected through the Tailscale address (away from home).
    tailscale: conn.via === 'remote' && isTailscaleAddress(conn.address),
    // Active Sessions: the server has them, and the live channel is open.
    sessions: status.state === 'online' && conn.sessions,
    live: status.state === 'online' && status.live,
    // Server time minus this machine's, roughly (from the live channel's greeting).
    timeOffset: live.offset,
    clientId: clientId(),
  };
}

let statusTimer = null;
function emitStatus() {
  // Several changes in a row reach the window as one.
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    hooks.onStatus(publicStatus());
  }, 30);
}

function setState(state, message = '') {
  status.state = state;
  status.message = message;
  emitStatus();
}

// ---- the library the window sees ----

/** The server id of a local song, and the local copy of a server song. */
function localCopies() {
  const local = library.get();
  const byServer = new Map();
  for (const s of local.songs) {
    const sid = sync.songMap[s.id];
    if (sid && !byServer.has(sid)) byServer.set(sid, s);
  }
  return byServer;
}

/** A queued upload as the song it will become, for the window. */
function uploadAsAddSong(cmd) {
  const local = model.songById(library.get(), cmd.localId);
  if (!local) return null;
  return { type: 'addSong', at: cmd.at, playlistIds: cmd.playlistIds, song: { ...local, id: cmd.songId } };
}

function buildView() {
  const d = JSON.parse(JSON.stringify(cache.library || model.emptyLibrary()));
  // Sent but not in the copy yet (its answer came before the library did),
  // then everything still waiting.
  const pending = [...sync.sent.filter((x) => x.rev > cache.rev).map((x) => x.cmd), ...sync.queue.filter(mine)];
  for (const c of pending) {
    const cmd = c.type === 'upload' ? uploadAsAddSong(c) : c;
    if (!cmd) continue;
    try {
      applyCommand(d, cmd);
    } catch {
      // The server will say what was wrong with it.
    }
  }
  const copies = localCopies();
  for (const s of d.songs) {
    const copy = copies.get(s.id);
    s.file = copy ? copy.file : '';
  }
  d.ignoredFiles = [];
  view = d;
  return d;
}

let viewTimer = null;
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

// ---- connecting ----

let pollTimer = null;
let retryTimer = null;
let retryStep = 0;
let connecting = null;
let connectingGen = -1;
let lastHomeTry = 0;
let generation = 0; // bumped on every reconfigure: late answers of an old connection are ignored

/** A different server than the one the copy and the queue belong to: start over. */
function adoptServer(id) {
  if (sync.serverId === id) return;
  const hadOther = !!sync.serverId;
  // The Home address was found (or not) before there was a server to belong to.
  sync = { ...emptySync(id), homeFilled: sync.homeFilled };
  cache = { serverId: id, rev: -1, library: null, profile: '' };
  saveSync();
  saveCache();
  if (hadOther) hooks.onNotice('This is a different Flow Server than before. Your Local Files will be synchronized with it.', 'info');
}

async function login(base) {
  const s = settings.all();
  const pw = decrypt(s.serverSecret);
  if (!pw) throw new AuthError('This server needs its password. Enter it under "Server Password".');
  const r = await request(base, '/api/login', { method: 'POST', json: { password: pw, device: os.hostname(), client: clientId() }, timeout: 20000 });
  if (r.status === 401) throw new AuthError('Wrong password.');
  if (r.status !== 200 || !r.json || !r.json.token) throw new Error((r.json && r.json.error) || 'The server did not let Flow sign in.');
  sync.token = encrypt(r.json.token);
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
  if (!was) return token;
  try {
    const list = await request(base, '/api/profiles', { token, timeout: 15000 });
    if (list.status !== 200 || !list.json || list.json.current === was.id) return token;
    const pin = was.pin ? decrypt(sync.profilePin) : '';
    if (was.pin && !pin) return token;
    const r = await request(base, '/api/profiles/login', {
      method: 'POST', json: { profileId: was.id, pin, device: os.hostname(), client: clientId() }, token, timeout: 20000,
    });
    if (r.status === 200 && r.json && r.json.token) {
      sync.token = encrypt(r.json.token);
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
        problem = problem || ['error', `"${address}" is not an address Flow understands.`];
        continue;
      }
      let hello;
      try {
        const r = await request(base, '/api/hello', { timeout: via === 'home' ? 2500 : 8000 });
        hello = r.json;
      } catch {
        if (!problem || problem[0] === 'offline') problem = ['offline', 'The server cannot be reached.'];
        continue;
      }
      if (gen !== generation) return false;
      if (!hello || hello.app !== 'flow-server') {
        problem = ['error', `${address} answers, but it is not a Flow Server.`];
        continue;
      }
      if (hello.protocol !== PROTOCOL) {
        problem = ['error', hello.protocol > PROTOCOL
          ? 'The server is newer than this Flow. Update Flow to use it.'
          : 'The server is older than this Flow. Update the Flow Server.'];
        continue;
      }
      adoptServer(String(hello.id || base));
      // Without a password the token only says which profile this is. Where
      // there is one, Flow signs in with it at every start: only a token got
      // in this run counts, never the one kept from the last.
      let token = hello.password ? runToken : decrypt(sync.token);
      try {
        if (hello.password) {
          if (token) {
            const probe = await request(base, `/api/library?since=${cache.rev}`, { token, timeout: 15000 });
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
      const sessions = Array.isArray(hello.features) && hello.features.includes('sessions');
      if (profiles) token = await restoreProfile(base, token);
      if (gen !== generation) return false;
      Object.assign(conn, {
        base, token, via, name: String(hello.name || 'Flow Server'), address, profiles, downloads, sessions,
      });
      if (via === 'remote') lastHomeTry = Date.now();
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
    let [state, message] = problem || ['offline', 'The server cannot be reached.'];
    if (state === 'offline' && isTailscaleAddress(own.remote)) {
      message = 'The server cannot be reached. Away from home, Tailscale has to be on at this PC.';
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
  let notice = `Remote Server set to ${address}, the server's address on the internet, for when you are away from home.`;
  const ts = hello.tailscale;
  if (!address && ts) {
    const port = Math.round(Number(ts.port));
    if (typeof ts.ip !== 'string' || !isTailscaleAddress(ts.ip) || !(port > 0 && port < 65536)) return;
    address = `${ts.ip}:${port}`;
    notice = `Remote Server set to ${address}, the server's Tailscale address, for when you are away from home. Tailscale has to be on at this PC then too.`;
  }
  if (!address) return;
  settings.set({ serverRemote: address });
  sync.remoteFilled = true;
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
    const address = discovery.addressOf(found[0], os.networkInterfaces());
    settings.set({ serverHome: address });
    sync.homeFilled = true;
    saveSync();
    hooks.onSettings({ serverHome: address });
    hooks.onNotice(`Found the Flow Server "${found[0].name}" on this network. Home Server set to ${address}.`, 'info');
    reconfigure({ serverHome: address });
    return;
  }
  if (found.length > 1) {
    hooks.onNotice(`Found ${found.length} Flow Servers on this network (${found.map((f) => `"${f.name}" at ${f.ip}:${f.port}`).join(', ')}). Enter the one you want as the Home Server.`, 'info');
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
  try {
    const changed = await refresh();
    if (sync.queue.length) flushSoon();
    if (changed) afterServerChange();
  } catch (err) {
    wentWrong(err);
    return;
  }
  schedulePoll();
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
    setState('offline', 'The server cannot be reached.');
    scheduleRetry();
    return;
  }
  hooks.onNotice(err.message, 'error');
}

/** Fetches the server's library when it changed. Resolves true when it did. */
async function refresh() {
  // `as`: the profile the copy is of. Signed in to another since, the server
  // sends the whole library even when nothing changed.
  const since = cache.library ? `?since=${cache.rev}&as=${encodeURIComponent(cache.profile)}` : '';
  const r = await request(conn.base, `/api/library${since}`, { token: conn.token, timeout: 30000 });
  if (r.status === 401) throw new AuthError('Signed out.');
  if (r.status === 204) return false;
  if (r.status !== 200 || !r.json || !r.json.library) throw new Error((r.json && r.json.error) || `The server answered ${r.status}.`);
  const profile = cleanProfile(r.json.profile);
  const before = sync.profile;
  if (before && (!profile || profile.id !== before.id)) {
    // Deleted or signed out on the server, by another device.
    hooks.onNotice(`You are no longer logged in as "${before.name}": the profile was deleted or signed out on the server.`, 'info');
    loadProfiles().catch(() => {});
  }
  sync.profile = profile;
  cache = { serverId: sync.serverId, rev: Number(r.json.rev), library: model.sanitize(r.json.library), profile: currentProfile() };
  sync.sent = sync.sent.filter((x) => x.rev > cache.rev);
  saveCache();
  saveSync();
  refreshView();
  return true;
}

// ---- commands ----

function newCid() {
  return crypto.randomBytes(8).toString('hex');
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

/** Every id a command refers to, renamed (an upload the server gave another id). */
function renameSongId(from, to) {
  const fix = (c) => {
    if (!c) return;
    if (c.songId === from) c.songId = to;
    if (Array.isArray(c.songIds)) c.songIds = c.songIds.map((x) => (x === from ? to : x));
  };
  for (const c of sync.queue) fix(c);
  for (const x of sync.sent) fix(x.cmd);
  for (const [lid, sid] of Object.entries(sync.songMap)) if (sid === from) sync.songMap[lid] = to;
}

let flushTimer = null;
let flushing = null;
const problems = [];

/** Changes the server refused and songs that could not go up or down, told once. */
function reportProblems() {
  if (!problems.length) return;
  const first = problems[0];
  const more = problems.length - 1;
  problems.length = 0;
  hooks.onNotice(`${first}${more ? ` (and ${more} more)` : ''}`, 'error');
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
    if (status.state !== 'online' || !sync.queue.some(mine)) return;
    const uploads = sync.queue.filter((c) => c.type === 'upload' && mine(c)).length;
    const canTransfer = uploads ? await transfersAllowed() : true;
    const blocked = new Set();
    let uploadNo = 0;
    let batch = [];
    // Songs the server deleted with a playlist: their copies here go too.
    const deleted = [];
    const sendBatch = async () => {
      if (!batch.length) return;
      const sending = batch;
      batch = [];
      const res = await call('/api/commands', { method: 'POST', json: { commands: sending }, timeout: 60000 });
      const byCid = new Map((res.results || []).map((r) => [r.cid, r]));
      const done = new Set();
      for (const c of sending) {
        const r = byCid.get(c.cid);
        if (!r) continue;
        done.add(c.cid);
        if (r.ok) sync.sent.push({ cmd: c, rev: res.rev });
        if (r.ok && Array.isArray(r.deletedSongs)) deleted.push(...r.deletedSongs.map(String));
        if (!r.ok) problems.push(`The server did not take a change: ${r.error}`);
      }
      sync.queue = sync.queue.filter((c) => !done.has(c.cid));
      saveSync();
    };
    try {
      for (const c of sync.queue.slice()) {
        if (status.state !== 'online') break;
        if (!mine(c)) continue;
        if (c.type === 'upload') {
          if (!canTransfer) {
            blocked.add(c.songId);
            continue;
          }
          await sendBatch();
          uploadNo += 1;
          await uploadOne(c, uploadNo, uploads);
          continue;
        }
        const refs = [c.songId, ...(Array.isArray(c.songIds) ? c.songIds : [])];
        if (refs.some((id) => blocked.has(id))) continue;
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
        ? `${blocked.size} ${blocked.size === 1 ? 'song waits' : 'songs wait'} to be uploaded until the connection is not metered.`
        : '';
      if (!sync.queue.some(mine)) status.lastSync = Date.now();
      await refresh();
      afterServerChange();
    } catch (err) {
      status.transfer = '';
      wentWrong(err);
    } finally {
      refreshView();
      reportProblems();
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

// ---- uploads ----

/** One song up to the server. Its local file stays or goes by "Keep downloaded files". */
async function uploadOne(cmd, number, total) {
  const local = model.songById(library.get(), cmd.localId);
  const drop = () => {
    sync.queue = sync.queue.filter((c) => c.cid !== cmd.cid);
    saveSync();
  };
  if (!local || !fs.existsSync(local.file)) {
    // Gone before it could go up: nothing to send.
    drop();
    delete sync.songMap[cmd.localId];
    return;
  }
  const label = [local.artist, local.title].filter(Boolean).join(' - ');
  status.transfer = `Uploading ${number} of ${total}: ${label}`;
  emitStatus();
  const meta = {
    title: local.title,
    artist: local.artist,
    mix: local.mix,
    duration: local.duration,
    format: local.format || path.extname(local.file).slice(1).toLowerCase(),
    sourceUrl: local.sourceUrl,
    sourceKey: local.sourceKey,
    sourcePlaylistUrl: local.sourcePlaylistUrl,
    addedAt: local.addedAt,
    loudness: local.loudness,
  };
  if ((cmd.profile || '') === currentProfile()) {
    Object.assign(meta, {
      favouriteAt: local.favouriteAt,
      stats: local.stats,
      playlistIds: (cmd.playlistIds || []).filter((pid) => model.playlistById(getView(), pid)),
    });
  }
  const r = await request(conn.base, `/api/songs/${encodeURIComponent(cmd.songId)}?meta=${encodeURIComponent(JSON.stringify(meta))}`, {
    method: 'PUT',
    file: local.file,
    token: conn.token,
    timeout: 120000,
    onProgress: (f) => {
      status.transfer = `Uploading ${number} of ${total} (${Math.round(f * 100)}%): ${label}`;
      emitStatus();
    },
  });
  if (r.status === 401) throw new AuthError('Signed out.');
  if (r.status !== 200 || !r.json) {
    // Refused for good (a format the server does not take, no room): the song
    // stays here only, and the reason is told.
    drop();
    delete sync.songMap[cmd.localId];
    problems.push(`"${label}" could not be uploaded: ${(r.json && r.json.error) || `the server answered ${r.status}`}`);
    return;
  }
  const serverId = String(r.json.id);
  if (serverId !== cmd.songId) renameSongId(cmd.songId, serverId);
  sync.songMap[cmd.localId] = serverId;
  drop();
  sync.sent.push({ cmd: { ...cmd, songId: serverId }, rev: Number(r.json.rev) });
  // An upload shows as addSong until the library catches up; one the server
  // already had (existing) shows as that song straight away.
  if (r.json.existing) sync.sent.pop();
  saveSync();
  if (!r.json.existing) await uploadCover(local, serverId);
  if (!settings.get('serverKeepFiles') && !neededOffline(serverId)) {
    await forgetLocal(cmd.localId, { deleteFile: true });
  }
}

/** A Local Files song's cover after it, when it has one (the server keeps its own if it found one first). */
async function uploadCover(local, serverId) {
  if (!local.cover || local.cover === '-' || !covers.localStore().has(local.id)) return;
  try {
    const r = await request(conn.base, `/api/songs/${encodeURIComponent(serverId)}/cover`, {
      method: 'PUT', file: covers.localStore().file(local.id), token: conn.token, timeout: 30000,
    });
    if (r.status === 200 && r.json && r.json.cover === local.cover) covers.copyToServer(local.id, sync.serverId, serverId);
  } catch {
    // The server looks for one itself.
  }
}

// ---- Local Files and the server ----

function snapOfSong(s) {
  return { title: s.title, artist: s.artist, mix: s.mix, fav: !!s.favouriteAt, loudness: s.loudness };
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
  saveSync();
  if (!song) return true;
  let removed = false;
  await library.quietly(async () => {
    if (deleteFile) {
      try {
        fs.rmSync(song.file, { force: true });
      } catch {
        // In use (playing): it stays, and is tried again later.
        return;
      }
    }
    library.mutate((d) => model.removeSong(d, lid, !deleteFile));
    removed = true;
  });
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
 * added go up, songs removed are deleted on the server, names, favourites and
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
    if (!sid || !model.songById(v, sid)) continue;
    const now = snapOfSong(s);
    if (now.title !== was.title || now.artist !== was.artist || now.mix !== was.mix) {
      q('editSong', { songId: sid, title: s.title, artist: s.artist, mix: s.mix });
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
      // Removed from the folder by hand (or deleted while the server was off).
      const sid = sync.songMap[lid];
      delete snap.songs[lid];
      delete sync.songMap[lid];
      delete sync.fetched[lid];
      if (!sid) continue;
      const waiting = sync.queue.find((c) => c.type === 'upload' && c.localId === lid);
      if (waiting) sync.queue = sync.queue.filter((c) => c !== waiting);
      else if (!Object.values(sync.songMap).includes(sid)) {
        q('deleteSong', { songId: sid });
        count += 1;
      }
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
  saveSync();
  refreshView();
  flushSoon();
  return { count, firstTime };
}

/**
 * A playlist that can be marked for download, as the signed-in profile sees
 * it: one of its own, or one another profile shares that it follows.
 */
function markedList(v, pid) {
  return model.playlistById(v, pid)
    || ((v.follows || []).includes(pid) ? model.sharedPlaylistById(v, pid) : null);
}

/**
 * The songs of a playlist marked for download: as the library has them when
 * it is the signed-in profile's (or one it follows), else as last seen
 * (another profile's, or a followed one that is not shared for the moment).
 */
function markedSongs(pid, v) {
  // All Songs is everyone's, whichever profile is signed in.
  if (pid === ALL) return v.songs.map((s) => s.id);
  const p = markedList(v, pid);
  if (p) return p.entries.map((e) => e.songId);
  const keep = sync.offlineKeep[pid];
  if (keep && (v.follows || []).includes(pid)) return keep.songs;
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
    if (pid === ALL) continue;
    const p = markedList(v, pid);
    const keep = sync.offlineKeep[pid];
    if (p) sync.offlineKeep[pid] = { profile: currentProfile(), songs: p.entries.map((e) => e.songId) };
    // Gone (deleted, or no longer followed): no longer marked. A followed one
    // that is only not shared for the moment stays as it was.
    else if ((!keep || keep.profile === currentProfile()) && !(v.follows || []).includes(pid)) {
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
}

let following = null;
const lengthsTold = new Set();
function followServer() {
  if (following) return following;
  following = (async () => {
    const v = buildView();
    const local = library.get();
    const snap = sync.snapshot;
    rememberMarked(v);

    // Names, favourites and loudness changed on the server, for copies not
    // changed here since (those go up at the next synchronization instead).
    const updates = [];
    for (const s of local.songs) {
      const sid = sync.songMap[s.id];
      const was = snap && snap.songs[s.id];
      const there = sid && model.songById(v, sid);
      if (!there || !was) continue;
      const unchangedHere = s.title === was.title && s.artist === was.artist && s.mix === was.mix && !!s.favouriteAt === was.fav;
      if (!unchangedHere) continue;
      const patch = {};
      if (there.title !== s.title || there.artist !== s.artist || there.mix !== s.mix) {
        Object.assign(patch, { title: there.title, artist: there.artist, mix: there.mix });
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
      const there = sid && model.songById(v, sid);
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
          const s = model.songById(d, lid);
          if (!s) continue;
          Object.assign(s, patch);
          if (snap) snap.songs[lid] = snapOfSong(s);
        }
      });
      saveSync();
    }

    // Deleted on the server: the local copy goes too. A server that suddenly
    // lacks most of the songs (its library lost, not deleted song by song)
    // takes nothing with it.
    const waiting = new Set(sync.queue.filter((c) => c.type === 'upload').map((c) => c.localId));
    const gone = Object.entries(sync.songMap).filter(([lid, sid]) => !waiting.has(lid) && !model.songById(v, sid));
    const mapped = Object.keys(sync.songMap).length;
    if (gone.length && (gone.length <= 20 || gone.length < mapped / 2)) {
      for (const [lid] of gone) await forgetLocal(lid, { deleteFile: true });
    } else if (gone.length) {
      status.note = `${gone.length} songs are missing on the server. Their files were kept here.`;
      emitStatus();
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

/** Every song of the marked playlists without a copy here comes down. */
async function downloadOffline() {
  if (status.state !== 'online' || !sync.offline.length) return;
  const v = getView();
  const copies = localCopies();
  const want = [];
  const seen = new Set();
  for (const pid of sync.offline) {
    const p = markedList(v, pid);
    if (!p && pid !== ALL) continue;
    // All Songs: every song, new ones as they turn up on the server.
    const songIds = pid === ALL ? v.songs.map((x) => x.id) : p.entries.map((e) => e.songId);
    for (const songId of songIds) {
      if (seen.has(songId) || copies.has(songId)) continue;
      seen.add(songId);
      const s = model.songById(v, songId);
      if (s && !sync.queue.some((c) => c.type === 'upload' && c.songId === s.id)) want.push(s);
    }
  }
  if (!want.length) return;
  if (!(await transfersAllowed())) {
    status.note = `${want.length} ${want.length === 1 ? 'song waits' : 'songs wait'} to be downloaded until the connection is not metered.`;
    emitStatus();
    return;
  }
  let number = 0;
  for (const s of want) {
    if (status.state !== 'online' || !active()) break;
    number += 1;
    const label = [s.artist, s.title].filter(Boolean).join(' - ');
    status.transfer = `Downloading ${number} of ${want.length}: ${label}`;
    emitStatus();
    try {
      await fetchSong(s, (f) => {
        status.transfer = `Downloading ${number} of ${want.length} (${Math.round(f * 100)}%): ${label}`;
        emitStatus();
      });
    } catch (err) {
      if (err instanceof OfflineError || err instanceof AuthError) {
        status.transfer = '';
        wentWrong(err);
        return;
      }
      problems.push(`"${label}" could not be downloaded: ${err.message}`);
    }
    // The window hears of each song as it arrives.
    refreshView();
  }
  status.transfer = '';
  emitStatus();
}

/** One server song into Local Files, as a copy. */
async function fetchSong(s, onProgress) {
  const ext = String(s.format || 'mp3').toLowerCase();
  const tmp = path.join(paths.musicDir(), `.flow-download-${crypto.randomBytes(5).toString('hex')}.${ext}`);
  try {
    const r = await request(conn.base, `/api/songs/${encodeURIComponent(s.id)}/audio`, {
      token: conn.token, saveTo: tmp, timeout: 60000, onProgress,
    });
    if (r.status === 401) throw new AuthError('Signed out.');
    if (r.status !== 200) throw new Error((r.json && r.json.error) || `the server answered ${r.status}`);
    await library.quietly(async () => {
      const dest = exporter.uniquePath(songFileStem(s.artist, s.title, s.mix), ext);
      fs.renameSync(tmp, dest);
      const taken = model.songById(library.get(), s.id);
      const lid = taken ? library.newId() : s.id;
      const song = {
        id: lid,
        file: dest,
        title: s.title,
        artist: s.artist,
        mix: s.mix,
        duration: s.duration,
        format: ext,
        sourceUrl: s.sourceUrl,
        sourceKey: s.sourceKey,
        sourcePlaylistUrl: s.sourcePlaylistUrl,
        addedAt: s.addedAt,
        loudness: s.loudness,
        favouriteAt: s.favouriteAt,
        stats: s.stats,
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
    fs.rmSync(tmp, { force: true });
  }
}

/** Copies downloaded for a playlist no longer marked (and in no other marked one) go. */
async function dropUnneededCopies() {
  const v = getView();
  for (const lid of Object.keys(sync.fetched)) {
    const sid = sync.songMap[lid];
    if (!sid || !model.songById(v, sid)) continue;
    if (!neededOffline(sid)) await forgetLocal(lid, { deleteFile: true });
  }
}

// ---- covers ----
//
// Every cover comes down, COVER_JOBS at a time, those the window asks for
// first (rows on screen whose cover is not here yet: wantCovers). Away from
// home on a metered connection only those, unless transfers are allowed.

const COVER_JOBS = 3;
const coverHave = new Map(); // `${serverId}/${songId}` -> version of the file here
const coverFailed = new Set(); // could not be had this run
let coverTodo = [];
let coverWanted = [];
let coverBulk = false;
let coverRunning = 0;
let coverArrived = [];
let coverTellTimer = null;

/** Where the window finds this server's covers: '' without a server. */
function coverDir() {
  return active() && sync.serverId ? covers.dirOf(sync.serverId) : '';
}

/** The version of the cover file here, hashed once and then remembered. */
function versionHere(store, id) {
  const key = `${sync.serverId}/${id}`;
  if (coverHave.has(key)) return coverHave.get(key);
  const jpeg = store.read(id);
  const v = jpeg ? coverVersion(jpeg) : '';
  coverHave.set(key, v);
  return v;
}

const wantsCover = (s) => !!(s && s.cover && s.cover !== '-');

/** After every look at the server's library: which covers to fetch, which to drop. */
async function coverSync() {
  if (status.state !== 'online' || !cache.library || cache.serverId !== sync.serverId || !sync.serverId) return;
  const store = covers.storeOf(sync.serverId);
  const songs = cache.library.songs;
  const known = new Set(songs.map((x) => x.id));
  for (const id of store.ids()) {
    if (known.has(id)) continue;
    store.remove(id);
    coverHave.delete(`${sync.serverId}/${id}`);
  }
  coverTodo = songs.filter((x) => wantsCover(x) && !coverFailed.has(x.id) && versionHere(store, x.id) !== x.cover).map((x) => x.id);
  coverBulk = await transfersAllowed();
  pumpCovers();
}

/** The window shows these songs and has no cover file for them yet. */
function wantCovers(ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).filter((id) => /^[\w-]{1,64}$/.test(id));
  if (!list.length) return;
  coverWanted = [...new Set([...list, ...coverWanted])].slice(0, 300);
  pumpCovers();
}

function nextCover() {
  const lib = cache.library;
  if (!lib || !sync.serverId) return null;
  const store = covers.storeOf(sync.serverId);
  const ok = (id) => {
    const song = model.songById(lib, id);
    return wantsCover(song) && !coverFailed.has(id) && versionHere(store, id) !== song.cover ? song : null;
  };
  while (coverWanted.length) {
    const song = ok(coverWanted.shift());
    if (song) return song;
  }
  while (coverBulk && coverTodo.length) {
    const song = ok(coverTodo.shift());
    if (song) return song;
  }
  return null;
}

function pumpCovers() {
  while (coverRunning < COVER_JOBS && status.state === 'online') {
    const song = nextCover();
    if (!song) return;
    coverRunning += 1;
    fetchCover(song).catch(() => {
      coverFailed.add(song.id);
    }).finally(() => {
      coverRunning -= 1;
      pumpCovers();
    });
  }
}

async function fetchCover(song) {
  const serverId = sync.serverId;
  const store = covers.storeOf(serverId);
  fs.mkdirSync(store.dir, { recursive: true });
  const tmp = path.join(store.dir, `.${song.id}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const r = await request(conn.base, `/api/songs/${encodeURIComponent(song.id)}/cover?v=${encodeURIComponent(song.cover)}`, {
      token: conn.token, saveTo: tmp, timeout: 30000,
    });
    if (r.status !== 200 || serverId !== sync.serverId) {
      coverFailed.add(song.id);
      return;
    }
    const jpeg = fs.readFileSync(tmp);
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      coverFailed.add(song.id);
      return;
    }
    const version = store.write(song.id, jpeg);
    coverHave.set(`${serverId}/${song.id}`, version);
    coverArrived.push(song.id);
    if (!coverTellTimer) {
      // Many at once reach the window as one message.
      coverTellTimer = setTimeout(() => {
        coverTellTimer = null;
        const ids = coverArrived;
        coverArrived = [];
        covers.tell(sync.serverId, ids);
      }, 250);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** How many of this server's covers are here, and the room all servers' take. */
function coverStats() {
  let count = 0;
  let bytes = 0;
  let names = [];
  try {
    names = fs.readdirSync(paths.coversDir(), { withFileTypes: true });
  } catch {
    names = [];
  }
  for (const e of names) {
    if (!e.isDirectory() || e.name === covers.LOCAL) continue;
    const size = covers.storeOf(e.name).size();
    bytes += size.bytes;
    if (e.name === sync.serverId) count = size.count;
  }
  return { count, bytes, waiting: coverTodo.length + coverWanted.length };
}

/** "Clear cover cache": every server's covers go; this server's come down again. */
function clearCoverCache() {
  let names = [];
  try {
    names = fs.readdirSync(paths.coversDir(), { withFileTypes: true });
  } catch {
    names = [];
  }
  for (const e of names) {
    if (e.isDirectory() && e.name !== covers.LOCAL) fs.rmSync(path.join(paths.coversDir(), e.name), { recursive: true, force: true });
  }
  coverHave.clear();
  coverFailed.clear();
  coverSync().catch(() => {});
  return coverStats();
}

/** A Local Files song that is a copy of one of the server's (its cover comes from there). */
function isServerCopy(lid) {
  return !!sync.fetched[lid];
}

// ---- synchronizing ----

let asking = null;
/**
 * The songs in Local Files from before this server are only sent with the
 * user's OK. Declined, they stay here (only "Synchronize now" asks again);
 * songs added or downloaded afterwards go up as usual.
 */
function askHeld() {
  if (asking) return asking;
  asking = (async () => {
    queueLocalChanges(); // drops the held songs that are gone
    const count = (sync.held || []).length;
    if (!count) return;
    let yes = false;
    try {
      yes = !!(await hooks.confirmUpload({ count, name: conn.name }));
    } catch {
      yes = false;
    }
    if (yes) {
      sync.held = [];
      saveSync();
      queueLocalChanges();
    } else {
      hooks.onNotice(`Your ${count} Local Files songs stay on this computer. Synchronize now in Settings uploads them to "${conn.name}".`, 'info');
    }
  })().finally(() => { asking = null; });
  return asking;
}

/** After connecting: what changed here goes up, then the server's changes come down. */
function afterConnect() {
  const s = settings.all();
  // The first time with a server (none of the songs here has been through it),
  // they are held back until the user says they may go up.
  const first = !sync.snapshot && sync.held === null && library.get().songs.length > 0;
  if (first) {
    sync.held = library.get().songs.map((x) => x.id);
    saveSync();
  }
  if (s.serverAutoSync || !sync.snapshot) queueLocalChanges();
  flushSoon();
  afterServerChange();
  if (first) askHeld();
}

let autoSyncTimer = null;
/** Local Files changed (a scan, a download, a copy arriving). */
function localChanged() {
  if (!active()) return;
  refreshView();
  if (!settings.get('serverAutoSync') || !sync.snapshot) return;
  clearTimeout(autoSyncTimer);
  autoSyncTimer = setTimeout(() => {
    if (active() && settings.get('serverAutoSync')) queueLocalChanges();
  }, AUTO_SYNC_DELAY);
}

/**
 * "Synchronize now": Local Files looked through, their changes sent, the
 * server's music folder looked through, and the marked playlists downloaded.
 */
async function syncNow() {
  if (!active()) throw new Error('Tick "Streaming, Download and Synchronization" and enter an address first.');
  if (status.state !== 'online') {
    await connect();
    if (status.state !== 'online') throw new Error(status.message || 'The server cannot be reached.');
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
// While connected to a server that has Active Sessions, one stream stays open
// (GET /api/live, Server-Sent Events) on which the server tells this app
// what happens at once: a session paused, a join asked for. Every event goes
// to the window (hooks.onLive). A dropped stream is opened again after a
// moment; one silent for longer than three pings is taken for dead.

const LIVE_RETRY_MS = [1000, 2000, 5000, 10000, 20000];
const live = {
  req: null,
  step: 0,
  retryTimer: null,
  watchdog: null,
  pingMs: 10000,
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
  live.offset = best.offset;
  emitStatus();
}

function liveWanted() {
  return active() && status.state === 'online' && conn.sessions && !!conn.base;
}

function stopLive() {
  clearTimeout(live.retryTimer);
  clearTimeout(live.watchdog);
  clearInterval(live.clockTimer);
  live.clockTimer = null;
  live.retryTimer = null;
  const req = live.req;
  live.req = null;
  if (req) req.destroy();
  if (status.live) {
    status.live = false;
    emitStatus();
    hooks.onLive({ type: 'down', data: {} });
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
    url = new URL(`${conn.base}/api/live?client=${encodeURIComponent(clientId())}&device=${encodeURIComponent(os.hostname())}`);
  } catch {
    return;
  }
  const lib = url.protocol === 'https:' ? https : http;
  const headers = { Accept: 'text/event-stream' };
  if (conn.token) headers.Authorization = `Bearer ${conn.token}`;
  const req = lib.request(url, { headers });
  live.req = req;
  live.token = conn.token;
  const mineNow = () => live.req === req;
  const alive = () => {
    clearTimeout(live.watchdog);
    live.watchdog = setTimeout(() => {
      if (mineNow()) req.destroy(new Error('silent'));
    }, live.pingMs * 3 + 5000);
  };
  const lost = () => {
    if (!mineNow()) return;
    live.req = null;
    clearTimeout(live.watchdog);
    if (status.live) {
      status.live = false;
      emitStatus();
      hooks.onLive({ type: 'down', data: {} });
    }
    retryLive();
  };
  req.on('response', (res) => {
    if (!mineNow()) {
      res.destroy();
      return;
    }
    if (res.statusCode === 401) {
      res.resume();
      live.req = null;
      wentWrong(new AuthError('Signed out.'));
      return;
    }
    if (res.statusCode !== 200) {
      // Refused (too many apps, an id the token does not allow): not tried
      // over and over; the next connection tries again.
      res.resume();
      live.req = null;
      return;
    }
    res.setEncoding('utf8');
    let buffer = '';
    alive();
    res.on('data', (chunk) => {
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
    });
    res.on('end', lost);
    res.on('aborted', lost);
    res.on('error', lost);
  });
  req.on('error', lost);
  req.end();
}

function liveEvent(type, data) {
  if (type === 'hello') {
    live.step = 0;
    live.pingMs = Math.max(1000, Number(data.pingMs) || 10000);
    if (Number.isFinite(Number(data.serverTime))) live.offset = Number(data.serverTime) - Date.now();
    status.live = true;
    emitStatus();
    syncClock();
    clearInterval(live.clockTimer);
    live.clockTimer = setInterval(syncClock, CLOCK_EVERY_MS);
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
      wentWrong(new AuthError('Signed out.'));
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
  if (!active() || status.state !== 'online') throw new Error('The server cannot be reached right now.');
  if (!conn.sessions) throw new Error('This Flow Server is too old for Active Sessions. Update it first.');
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
  if (keys.includes('serverMetered')) flushSoon();
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
function setSecret(text) {
  settings.set({ serverSecret: encrypt(String(text || '')) });
  reconfigure({ serverSecret: true });
}

/** Marks a server playlist for download, or no longer. */
async function setOffline(pid, on) {
  if (on && pid !== ALL && !markedList(getView(), pid)) throw new Error('Only All Songs, your own playlists and the ones you follow can be downloaded.');
  if (on && !sync.offline.includes(pid)) sync.offline.push(pid);
  if (!on) sync.offline = sync.offline.filter((x) => x !== pid);
  if (on && pid !== ALL) sync.offlineKeep[pid] = { profile: currentProfile(), songs: markedSongs(pid, getView()) };
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
  if (!active()) throw new Error('Tick "Streaming, Download and Synchronization" first.');
  if (status.state !== 'online') throw new Error('The server cannot be reached right now. A song can only be downloaded while it can.');
  const song = model.songById(getView(), songId);
  if (!song) throw new Error('That song is not on the server.');
  if (localCopies().has(songId)) {
    sync.kept[songId] = true;
    saveSync();
    return;
  }
  const label = [song.artist, song.title].filter(Boolean).join(' - ');
  // Marked before the copy exists: a synchronization in between must not drop it as unneeded.
  sync.kept[songId] = true;
  saveSync();
  status.transfer = `Downloading: ${label}`;
  emitStatus();
  try {
    await fetchSong(song, (f) => {
      status.transfer = `Downloading (${Math.round(f * 100)}%): ${label}`;
      emitStatus();
    });
  } catch (err) {
    delete sync.kept[songId];
    saveSync();
    if (err instanceof OfflineError || err instanceof AuthError) wentWrong(err);
    throw new Error(`"${label}" could not be downloaded: ${err.message}`);
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
  if (!active()) throw new Error('Tick "Streaming, Download and Synchronization" first.');
  const lids = Object.entries(sync.songMap).filter(([, sid]) => sid === songId).map(([lid]) => lid);
  if (!lids.length) {
    delete sync.kept[songId];
    saveSync();
    return;
  }
  if (sync.queue.some((c) => c.type === 'upload' && c.songId === songId)) {
    throw new Error('This song has not been uploaded to the server yet. Its file here is the only copy.');
  }
  if (sync.offline.some((pid) => markedSongs(pid, getView()).includes(songId))) {
    throw new Error('This song is in a playlist marked for download (or All Songs is), so it would come straight back. Unmark that in Settings first.');
  }
  delete sync.kept[songId];
  saveSync();
  for (const lid of lids) {
    if (!(await forgetLocal(lid, { deleteFile: true }))) {
      sync.kept[songId] = true;
      saveSync();
      throw new Error('The song\'s file is in use (playing?). Try again once it has stopped.');
    }
  }
  refreshView();
}

/** The local copy of a server song, if there is one. */
function localFileOf(songId) {
  const copy = localCopies().get(songId);
  return copy && fs.existsSync(copy.file) ? copy.file : null;
}

// ---- downloads by the server ("Download (Server)" on Add Songs) ----
//
// The server keeps one batch per profile (apps/server/src/downloads.js) and
// the window polls it while Add Songs is open. None of it goes through Local
// Files: a song finished there is the server's at once, like any other.

function requireDownloads() {
  if (!active() || status.state !== 'online') throw new Error('The server cannot be reached right now.');
  if (!conn.downloads) throw new Error('This Flow Server does not download songs.');
}

/**
 * One request about the server's download batch. action: get, create
 * ({ url, kind, options }), cancel, peaks ({ index }), finish ({ index, body }),
 * retry ({ index }), discard ({ index }). Resolves the batch (null: none), or
 * for peaks the peaks, for finish { song, batch }.
 */
async function serverDownloads(action, args = {}) {
  if (action === 'get' && (!active() || status.state !== 'online' || !conn.downloads)) return null;
  requireDownloads();
  const item = `/api/downloads/items/${Math.max(0, Math.floor(Number(args.index) || 0))}`;
  try {
    if (action === 'get') return (await call('/api/downloads')).batch;
    // create: cookies, the link's site's browser cookies (or none).
    if (action === 'create') {
      const { url, kind, options, cookies } = args;
      return (await call('/api/downloads', { method: 'POST', json: { url, kind, options, cookies: cookies || undefined } })).batch;
    }
    if (action === 'cancel') return (await call('/api/downloads', { method: 'DELETE' })).batch;
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
  throw new Error(`Unknown download action ${action}.`);
}

/**
 * The cover the server found for a song of its download batch, fetched into
 * the cache (emptied at every start): the file, or '' without one.
 */
async function stagedServerCover(item, { index, version }) {
  const v = String(version || '');
  if (!/^[0-9a-f]{4,40}$/.test(v)) return '';
  const file = path.join(paths.cacheDir(), `server-cover-${Math.floor(Number(index) || 0)}-${v}.jpg`);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(paths.cacheDir(), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    const r = await request(conn.base, `${item}/cover?v=${v}`, { token: conn.token, saveTo: tmp, timeout: 30000 });
    if (r.status !== 200) return '';
    const head = fs.readFileSync(tmp).subarray(0, 2);
    if (head[0] !== 0xff || head[1] !== 0xd8) return '';
    fs.renameSync(tmp, file);
    return file;
  } finally {
    fs.rmSync(tmp, { force: true });
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
  const known = new Set(list.map((p) => p.id));
  const gone = (id) => id && !known.has(id);
  const before = sync.queue.length;
  sync.queue = sync.queue.filter((c) => SHARED_TYPES.has(c.type) || !gone(c.profile));
  let changed = sync.queue.length !== before;
  for (const pid of sync.offline.slice()) {
    const keep = sync.offlineKeep[pid];
    if (keep && gone(keep.profile)) {
      sync.offline = sync.offline.filter((x) => x !== pid);
      delete sync.offlineKeep[pid];
      changed = true;
    }
  }
  if (changed) {
    saveSync();
    afterServerChange();
  }
  emitStatus();
  return list;
}

function requireProfiles() {
  if (!active()) throw new Error('Tick "Streaming, Download and Synchronization" first.');
  if (status.state !== 'online') throw new Error('The server cannot be reached right now. Profiles can only be changed while it can.');
  if (!conn.profiles) throw new Error('This Flow Server is too old for profiles. Update it first.');
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
    sync.token = encrypt(token);
    runToken = token;
    // The old token is gone on the server: the live channel opens with the new one.
    startLive();
  }
  sync.profile = cleanProfile(profile);
  // Kept encrypted, so the next start can sign in to it again (restoreProfile).
  sync.profilePin = sync.profile && sync.profile.pin ? encrypt(pin) : '';
  sync.sent = [];
  // rev -1: the next fetch brings the whole library, whatever the revision.
  cache = { ...cache, rev: -1, profile: currentProfile() };
  saveSync();
  saveCache();
  await refresh();
  await loadProfiles().catch(() => {});
  afterServerChange();
  emitStatus();
  return sync.profile;
}

async function loginProfile(profileId, pin) {
  requireProfiles();
  await sendWaiting();
  const r = await call('/api/profiles/login', { method: 'POST', json: { profileId, pin: String(pin || ''), device: os.hostname(), client: clientId() }, timeout: 20000 });
  return switchProfile(r.token, r.profile, String(pin || ''));
}

async function createProfile(name, pin) {
  requireProfiles();
  // So the new profile's copy of the Default / Shared playlists has everything made before it.
  await sendWaiting();
  const r = await call('/api/profiles', { method: 'POST', json: { name, pin: String(pin || ''), device: os.hostname(), client: clientId() }, timeout: 20000 });
  return switchProfile(r.token, r.profile, String(pin || ''));
}

async function logoutProfile() {
  requireProfiles();
  await sendWaiting();
  await call('/api/profiles/logout', { method: 'POST', json: {} });
  return switchProfile(undefined, null);
}

async function renameProfile(name) {
  requireProfiles();
  const r = await call('/api/profiles/rename', { method: 'POST', json: { name } });
  sync.profile = cleanProfile(r.profile);
  saveSync();
  await loadProfiles().catch(() => {});
  emitStatus();
  return sync.profile;
}

/** Deletes the signed-in profile: its playlists, favourites and stats. */
async function deleteProfile() {
  requireProfiles();
  const gone = currentProfile();
  if (!gone) throw new Error('Log in to a profile first.');
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

function stop() {
  generation += 1;
  stopLive();
  clearTimeout(pollTimer);
  clearTimeout(retryTimer);
  clearTimeout(flushTimer);
  clearTimeout(autoSyncTimer);
}

module.exports = {
  init, active, reconfigure, setSecret, stop,
  coverDir, wantCovers, coverStats, clearCoverCache, isServerCopy,
  status: publicStatus, view: getView, command, syncNow, serverDownloads, setOffline, downloadSong, removeDownload, pushNew, pushImport, deleteSong, localFileOf, sessions, leaveSession,
  loadProfiles, loginProfile, createProfile, logoutProfile, renameProfile, deleteProfile,
};
