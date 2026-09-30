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
//   offline   the server playlists marked for download
//   fetched   local songs that are copies downloaded from the server (the
//             rest came from here); only those go when no longer needed
//   remoteFilled  the Remote address was filled in from the server's Tailscale
//             address once; a field cleared since stays empty
//   homeFilled    the same for the Home address, found on the network
//
// Songs the window plays come from a local copy when there is one, else
// straight from the server (renderer: Store.audioSrc).
//
// Profiles: people sharing the server's songs, each with their own
// playlists, favourites and stats (@flow/core/profiles). Signing in to one
// gives a token that says which; the server answers with that profile's
// library. Each waiting command remembers the profile it was made in and only
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
const model = require('@flow/core/libraryModel');
const { applyCommand } = require('@flow/core/commands');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { songFileStem } = require('@flow/core/text');
const { serverBaseUrl: baseUrl, isTailscaleAddress } = require('@flow/core/address');
const discovery = require('@flow/core/discovery');

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
    serverId, token: '', profile: null, queue: [], sent: [], songMap: {}, listMap: {}, snapshot: null, offline: [], offlineKeep: {}, fetched: {}, remoteFilled: false, homeFilled: false,
  };
}

function cleanProfile(p) {
  return p && typeof p === 'object' && p.id ? { id: String(p.id), name: String(p.name || ''), pin: !!p.pin } : null;
}

function loadSync() {
  const raw = readJson(syncFile());
  const s = { ...emptySync(), ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const key of ['queue', 'sent', 'offline']) if (!Array.isArray(s[key])) s[key] = [];
  for (const key of ['songMap', 'listMap', 'fetched', 'offlineKeep']) if (!s[key] || typeof s[key] !== 'object') s[key] = {};
  s.profile = cleanProfile(s.profile);
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

// ---- the PIN, kept encrypted ----

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
  if (r.status === 401) throw new AuthError((r.json && r.json.error) || 'This server needs its PIN or password.');
  if (r.status < 200 || r.status >= 300) throw new Error((r.json && r.json.error) || `The server answered ${r.status}.`);
  return r.json;
}

// ---- state for the window ----

// The connection in use: base address, token, which address it is, whether
// the server knows profiles.
const conn = { base: '', token: '', via: '', name: '', address: '', profiles: false };
const status = {
  state: 'off', // off | connecting | online | offline | password | error
  message: '',
  transfer: '', // "Uploading 3 of 12: ..." while songs go up or down
  note: '', // why songs wait (a metered connection), or '' 
  syncing: false,
  searching: false, // looking for a server on the network
  lastSync: 0,
  profiles: null, // the server's profiles [{ id, name, pin }]; null: it has none to offer
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

let hooks = { onView: () => {}, onStatus: () => {}, onNotice: () => {}, onSettings: () => {} };
let view = null;

function active() {
  const s = settings.all();
  return !!(s.serverOn && (s.serverHome || s.serverRemote));
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
    // Connected through the Tailscale address (away from home).
    tailscale: conn.via === 'remote' && isTailscaleAddress(conn.address),
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
  const pw = s.serverAuth ? decrypt(s.serverSecret) : '';
  if (!pw) throw new AuthError('This server needs a PIN or password. Tick "Pin or Password" and enter it.');
  const r = await request(base, '/api/login', { method: 'POST', json: { password: pw, device: os.hostname() }, timeout: 20000 });
  if (r.status === 401) throw new AuthError('Wrong PIN or password.');
  if (r.status !== 200 || !r.json || !r.json.token) throw new Error((r.json && r.json.error) || 'The server did not let Flow sign in.');
  sync.token = encrypt(r.json.token);
  saveSync();
  return r.json.token;
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
    const candidates = [['home', s.serverHome], ['remote', s.serverRemote]].filter(([, a]) => a);
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
      // Without a password the token only says which profile this is.
      let token = decrypt(sync.token);
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
      Object.assign(conn, { base, token, via, name: String(hello.name || 'Flow Server'), address, profiles });
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
      afterConnect();
      return true;
    }
    if (gen !== generation) return false;
    conn.base = '';
    conn.token = '';
    let [state, message] = problem || ['offline', 'The server cannot be reached.'];
    if (state === 'offline' && isTailscaleAddress(s.serverRemote)) {
      message = 'The server cannot be reached. Away from home, Tailscale has to be on at this PC.';
    }
    setState(state, message);
    // A wrong PIN is not tried over and over; a changed setting tries again.
    if (state !== 'password') scheduleRetry();
    return false;
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/**
 * Connected at home to a server on a tailnet: its Tailscale address becomes
 * the Remote address, once, and only into an empty field (a typed one stays,
 * and so does one cleared since). The IP, not the .ts.net name, which needs
 * MagicDNS.
 */
function fillRemote(hello) {
  const ts = hello && hello.tailscale;
  if (!ts || sync.remoteFilled || settings.get('serverRemote')) return;
  const port = Math.round(Number(ts.port));
  if (typeof ts.ip !== 'string' || !isTailscaleAddress(ts.ip) || !(port > 0 && port < 65536)) return;
  const address = `${ts.ip}:${port}`;
  settings.set({ serverRemote: address });
  sync.remoteFilled = true;
  saveSync();
  hooks.onSettings({ serverRemote: address });
  hooks.onNotice(`Remote Server set to ${address}, the server's Tailscale address, for when you are away from home. Tailscale has to be on at this PC then too.`, 'info');
}

/**
 * Turned on with no Home address: ask the local network for a Flow Server
 * (@flow/core/discovery). Exactly one answering becomes the Home address, once
 * (the box cleared since stays empty); several are told about, none is
 * silent (away from home, or the server is off).
 */
async function discoverHome() {
  if (status.searching || !settings.get('serverOn') || settings.get('serverHome') || sync.homeFilled) return;
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
  if (conn.via === 'remote' && s.serverHome && Date.now() - lastHomeTry > HOME_RETRY_MS) {
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
  if (err instanceof AuthError) {
    sync.token = '';
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
        else problems.push(`The server did not take a change: ${r.error}`);
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
  if (!settings.get('serverKeepFiles') && !neededOffline(serverId)) {
    await forgetLocal(cmd.localId, { deleteFile: true });
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
function queueLocalChanges({ onlyNew = false, playlistsFor = {} } = {}) {
  const local = library.get();
  const firstTime = !sync.snapshot;
  const snap = sync.snapshot || { songs: {}, lists: {} };
  const v = getView();
  const at = Date.now();
  const q = (type, args) => sync.queue.push(newCommand(type, { at, ...args }));
  const localIds = new Set(local.songs.map((s) => s.id));
  let count = 0;

  for (const s of local.songs) {
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
  const localLists = new Set(local.playlists.map((p) => p.id));
  for (const p of local.playlists) {
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
      const songs = mapSongs(p.entries.map((e) => e.songId));
      if (songs.length) q('addSongsToPlaylist', { playlistId: target, songIds: songs });
      snap.lists[p.id] = snapOfList(p);
      count += 1;
      continue;
    }
    if (onlyNew || !target) continue;
    const now = snapOfList(p);
    if (now.name !== was.name) {
      q('renamePlaylist', { playlistId: target, name: p.name });
      count += 1;
    }
    const before = new Set(was.entries);
    const after = new Set(now.entries);
    const added = mapSongs(now.entries.filter((id) => !before.has(id)));
    if (added.length) q('addSongsToPlaylist', { playlistId: target, songIds: added });
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
 * The songs of a playlist marked for download: as the library has them when
 * it is the signed-in profile's, else as last seen (another profile's).
 */
function markedSongs(pid, v) {
  const p = model.playlistById(v, pid);
  if (p) return p.entries.map((e) => e.songId);
  const keep = sync.offlineKeep[pid];
  return keep && keep.profile !== currentProfile() ? keep.songs : [];
}

/** Server playlists marked for download that hold a song. */
function neededOffline(sid) {
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
    const p = model.playlistById(v, pid);
    const keep = sync.offlineKeep[pid];
    if (p) sync.offlineKeep[pid] = { profile: currentProfile(), songs: p.entries.map((e) => e.songId) };
    else if (!keep || keep.profile === currentProfile()) {
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
    const p = model.playlistById(v, pid);
    if (!p) continue;
    for (const e of p.entries) {
      if (seen.has(e.songId) || copies.has(e.songId)) continue;
      seen.add(e.songId);
      const s = model.songById(v, e.songId);
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

// ---- synchronizing ----

/** After connecting: what changed here goes up, then the server's changes come down. */
function afterConnect() {
  const s = settings.all();
  if (s.serverAutoSync || !sync.snapshot) {
    // The first time with a server, Local Files always go up: that is what
    // turning the server on is for.
    if (!sync.snapshot && library.get().songs.length) {
      hooks.onNotice(`Uploading your ${library.get().songs.length} Local Files songs to "${conn.name}"...`, 'info');
    }
    queueLocalChanges();
  }
  flushSoon();
  afterServerChange();
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
  const needsReconnect = keys.some((k) => ['serverOn', 'serverHome', 'serverRemote', 'serverAuth', 'serverSecret'].includes(k));
  // A new PIN does not throw the token away: it may still be good (and says
  // which profile this is). Refused, the PIN signs in afresh.
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
  Object.assign(conn, { base: '', token: '', via: '', name: '', address: '' });
  status.message = '';
  if (active()) {
    status.state = 'connecting';
    hooks.onView(buildView());
    connect();
  } else {
    status.state = 'off';
  }
  emitStatus();
  if (keys.includes('serverOn') || keys.includes('serverHome')) discoverHome();
}

/** The PIN typed in Settings; kept encrypted. */
function setSecret(text) {
  settings.set({ serverSecret: encrypt(String(text || '')) });
  reconfigure({ serverSecret: true });
}

/** Marks a server playlist for download, or no longer. */
async function setOffline(pid, on) {
  if (on && !sync.offline.includes(pid)) sync.offline.push(pid);
  if (!on) sync.offline = sync.offline.filter((x) => x !== pid);
  if (on) sync.offlineKeep[pid] = { profile: currentProfile(), songs: markedSongs(pid, getView()) };
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

/** An imported playlist: goes up, into an existing server playlist when that was picked. */
function pushImport({ localPlaylistId, mergeInto, existingIds }) {
  if (localPlaylistId && mergeInto) sync.listMap[localPlaylistId] = mergeInto;
  queueLocalChanges({ onlyNew: true });
  const target = localPlaylistId && sync.listMap[localPlaylistId];
  const known = (existingIds || []).filter((id) => model.songById(getView(), id));
  if (target && known.length) {
    sync.queue.push(newCommand('addSongsToPlaylist', { playlistId: target, songIds: known }));
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

/** The local copy of a server song, if there is one. */
function localFileOf(songId) {
  const copy = localCopies().get(songId);
  return copy && fs.existsSync(copy.file) ? copy.file : null;
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
async function switchProfile(token, profile) {
  if (token !== undefined) {
    conn.token = token;
    sync.token = encrypt(token);
  }
  sync.profile = cleanProfile(profile);
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
  const r = await call('/api/profiles/login', { method: 'POST', json: { profileId, pin: String(pin || ''), device: os.hostname() }, timeout: 20000 });
  return switchProfile(r.token, r.profile);
}

async function createProfile(name, pin) {
  requireProfiles();
  // Also so the first profile takes over everything made before it.
  await sendWaiting();
  const r = await call('/api/profiles', { method: 'POST', json: { name, pin: String(pin || ''), device: os.hostname() }, timeout: 20000 });
  return switchProfile(r.token, r.profile);
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
  clearTimeout(pollTimer);
  clearTimeout(retryTimer);
  clearTimeout(flushTimer);
  clearTimeout(autoSyncTimer);
}

module.exports = {
  init, active, reconfigure, setSecret, stop,
  status: publicStatus, view: getView, command, syncNow, setOffline, pushNew, pushImport, deleteSong, localFileOf,
  loadProfiles, loginProfile, createProfile, logoutProfile, renameProfile, deleteProfile,
};
