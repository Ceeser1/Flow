'use strict';

// The server's HTTP side. Everything is JSON under /api except a song's audio,
// which is sent as it is, in pieces when asked (Range), so the apps can seek.
//
//   GET  /api/hello                    who this is; open to anyone (and, to askers on
//                                      a private network, its Tailscale address)
//   POST /api/login   { password, device } -> { token }
//   GET  /api/library [?since=rev&as=profileId]
//                                      { rev, library, profile }, or 204 when
//                                      nothing changed for that profile
//   POST /api/commands { commands }    { rev, results }  (see @flow/core/commands)
//   PUT  /api/songs/:id?meta=...       upload a song; the body is the file
//   GET  /api/songs/:id/audio          the song's file
//   POST /api/rescan                   look through the music folder again
//
//   GET  /api/profiles                 { profiles: [{ id, name, pin }], current }
//   POST /api/profiles { name, pin, device }        a new profile, signed in: { token, profile }
//   POST /api/profiles/login { profileId, pin, device }                  { token, profile }
//   POST /api/profiles/logout                       back to no profile
//   POST /api/profiles/rename { name }              the signed-in profile
//   POST /api/profiles/delete                       the signed-in profile, with its playlists
//
// With a password set, every other route needs the token from /api/login:
// "Authorization: Bearer <token>", or ?t=<token> on the audio (an <audio>
// element cannot send headers). Signing in to a profile gives a new token
// that says which profile it is; without a password that token is only needed
// for the profile. Profiles are behind the password, names included. Answers carry CORS headers, since the apps'
// windows are pages of their own and the equalizer can only read audio that
// says it may be read.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { AUDIO_EXTS } = require('@flow/core/formats');
const { isPrivateIp } = require('@flow/core/address');
const { checkPassword, hashPassword, hashToken } = require('./config');

const PROTOCOL = 1;
// What this server can do beyond protocol 1, for apps that know to ask.
const FEATURES = ['profiles'];
const MAX_PROFILE_NAME = 40;
const MAX_JSON = 8 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

const MIME = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) {
        reject(new HttpError(413, 'That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'That request is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** Sends a file, or the part of it the Range header asks for. */
function sendFile(req, res, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new HttpError(404, 'The song\'s file is missing on the server.');
  }
  const size = st.size;
  const headers = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
  };
  let start = 0;
  let end = size - 1;
  let status = 200;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(range[2]));
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = size ? end - start + 1 : 0;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !size) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Wrong passwords: each one from the same address waits twice as long as the
// one before (1 s, 2 s, 4 s... up to 5 minutes), which makes guessing a PIN
// hopeless without ever locking out the right one for long.
function createThrottle() {
  const failures = new Map(); // ip -> { count, until }
  return {
    check(ip) {
      const f = failures.get(ip);
      if (f && f.until > Date.now()) {
        throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil((f.until - Date.now()) / 1000)} seconds.`);
      }
    },
    fail(ip) {
      const f = failures.get(ip) || { count: 0, until: 0 };
      f.count += 1;
      f.until = Date.now() + Math.min(300000, 1000 * 2 ** (f.count - 1));
      failures.set(ip, f);
    },
    ok(ip) {
      failures.delete(ip);
    },
  };
}

function createHttpServer({ config, library, version, log = () => {}, tailscale = () => null }) {
  const throttle = createThrottle();

  function tokenOf(req, url) {
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    return m ? m[1] : url.searchParams.get('t') || '';
  }

  /**
   * The request's token entry (null: none). Throws 401 unless the request may
   * in; without a password everyone may.
   */
  function requireAuth(req, url) {
    const cfg = config.get();
    const token = tokenOf(req, url);
    const hash = token ? hashToken(token) : '';
    const entry = (hash && cfg.tokens.find((t) => t.hash === hash)) || null;
    if (cfg.password && !entry) throw new HttpError(401, 'This server needs its PIN or password.');
    // Remembered once an hour at most: no write to disk for every request.
    if (entry && Date.now() - entry.lastSeenAt > 3600000) {
      config.set({ tokens: cfg.tokens.map((t) => (t.hash === hash ? { ...t, lastSeenAt: Date.now() } : t)) });
    }
    return entry;
  }

  /** The profile a request is signed in to, or null. */
  function profileOf(entry) {
    if (!entry || !entry.profileId) return null;
    const p = config.get().profiles.find((x) => x.id === entry.profileId);
    return p && library.profileIds().includes(p.id) ? p : null;
  }

  const publicProfile = (p) => (p ? { id: p.id, name: p.name, pin: !!p.pin } : null);

  /** A new token for `device`, replacing its old one. */
  function issueToken(device, profileId) {
    const token = crypto.randomBytes(24).toString('base64url');
    const tokens = config.get().tokens.filter((t) => t.device !== device);
    tokens.push({ hash: hashToken(token), device, createdAt: Date.now(), lastSeenAt: Date.now(), profileId });
    config.set({ tokens: tokens.slice(-50) });
    return token;
  }

  function checkProfileName(name, exceptId = null) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new HttpError(400, 'Please enter a name for the profile.');
    if (clean.length > MAX_PROFILE_NAME) throw new HttpError(400, `Profile names can be at most ${MAX_PROFILE_NAME} characters.`);
    if (['none', '+ new'].includes(clean.toLowerCase())) throw new HttpError(400, `"${clean}" cannot be a profile's name.`);
    const clash = config.get().profiles.find((p) => p.id !== exceptId && p.name.toLowerCase() === clean.toLowerCase());
    if (clash) throw new HttpError(409, `A profile called "${clash.name}" already exists.`);
    return clean;
  }

  function setToken(entry, patch) {
    const cfg = config.get();
    config.set({ tokens: cfg.tokens.map((t) => (t.hash === entry.hash ? { ...t, ...patch } : t)) });
  }

  async function profiles(req, res, entry, action) {
    const ip = req.socket.remoteAddress || '';
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const device = String(body.device || (entry && entry.device) || ip).slice(0, 80);
    const current = profileOf(entry);
    if (action === 'list') {
      return sendJson(res, 200, {
        profiles: config.get().profiles.filter((p) => library.profileIds().includes(p.id)).map(publicProfile),
        current: current ? current.id : null,
      });
    }
    if (action === 'create') {
      const name = checkProfileName(body.name);
      const pin = String(body.pin || '');
      const id = crypto.randomBytes(6).toString('hex');
      const profile = { id, name, createdAt: Date.now(), pin: pin ? hashPassword(pin) : null };
      config.set({ profiles: [...config.get().profiles, profile] });
      library.createProfile(id);
      log(`Profile made: ${name} (${device})`);
      return sendJson(res, 200, { token: issueToken(device, id), profile: publicProfile(profile) });
    }
    if (action === 'login') {
      throttle.check(ip);
      const profile = config.get().profiles.find((p) => p.id === String(body.profileId || ''));
      if (!profile || !library.profileIds().includes(profile.id)) throw new HttpError(404, 'That profile no longer exists.');
      if (profile.pin && !checkPassword(profile.pin, String(body.pin || ''))) {
        throttle.fail(ip);
        log(`Wrong PIN for profile ${profile.name} from ${ip}`);
        throw new HttpError(403, 'Wrong PIN or password for this profile.');
      }
      throttle.ok(ip);
      log(`Signed in: ${device} as ${profile.name}`);
      return sendJson(res, 200, { token: issueToken(device, profile.id), profile: publicProfile(profile) });
    }
    if (action === 'logout') {
      if (entry) setToken(entry, { profileId: null });
      return sendJson(res, 200, {});
    }
    if (!current) throw new HttpError(409, 'Log in to a profile first.');
    if (action === 'rename') {
      const name = checkProfileName(body.name, current.id);
      config.set({ profiles: config.get().profiles.map((p) => (p.id === current.id ? { ...p, name } : p)) });
      log(`Profile renamed: ${current.name} -> ${name}`);
      return sendJson(res, 200, { profile: publicProfile({ ...current, name }) });
    }
    if (action === 'delete') {
      library.deleteProfile(current.id);
      const cfg = config.get();
      config.set({
        profiles: cfg.profiles.filter((p) => p.id !== current.id),
        tokens: cfg.tokens.map((t) => (t.profileId === current.id ? { ...t, profileId: null } : t)),
      });
      log(`Profile deleted: ${current.name}`);
      return sendJson(res, 200, {});
    }
    throw new HttpError(404, 'Nothing here.');
  }

  async function login(req, res) {
    const ip = req.socket.remoteAddress || '';
    throttle.check(ip);
    const body = await readJsonBody(req);
    const cfg = config.get();
    if (!checkPassword(cfg.password, String(body.password || ''))) {
      throttle.fail(ip);
      log(`Wrong password from ${ip}`);
      throw new HttpError(401, 'Wrong PIN or password.');
    }
    throttle.ok(ip);
    const device = String(body.device || ip).slice(0, 80);
    // A device signing in again replaces its old token rather than piling up.
    const token = issueToken(device, null);
    log(`Signed in: ${device}`);
    sendJson(res, 200, { token });
  }

  /** The body of a PUT written to a hidden file in the music folder. */
  function receiveFile(req, ext) {
    return new Promise((resolve, reject) => {
      const tmp = path.join(library.musicDir, `.flow-upload-${crypto.randomBytes(6).toString('hex')}${ext}`);
      const out = fs.createWriteStream(tmp);
      let size = 0;
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        reject(err);
      };
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_UPLOAD) {
          fail(new HttpError(413, 'That file is too large.'));
          req.destroy();
        }
      });
      req.on('aborted', () => fail(new HttpError(400, 'The upload was interrupted.')));
      req.on('error', fail);
      out.on('error', (err) => fail(new HttpError(507, `The server could not save the file: ${err.message}`)));
      out.on('finish', () => {
        if (failed) return;
        const expected = Number(req.headers['content-length']);
        if (Number.isFinite(expected) && expected !== size) {
          fail(new HttpError(400, 'The upload was interrupted.'));
          return;
        }
        resolve(tmp);
      });
      req.pipe(out);
    });
  }

  async function upload(req, res, url, id, profileId) {
    let meta;
    try {
      meta = JSON.parse(url.searchParams.get('meta') || '{}');
    } catch {
      throw new HttpError(400, 'The song\'s details could not be read.');
    }
    const ext = '.' + String(meta.format || '').toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) throw new HttpError(415, `${ext} is not a format Flow plays.`);
    const existing = library.existingFor(id, meta);
    if (existing) {
      // Already here (sent twice, or the same source uploaded by another
      // app): the file is not needed.
      req.resume();
      req.on('end', () => sendJson(res, 200, { existing: true, id: existing.id, rev: library.rev }));
      return;
    }
    const tmp = await receiveFile(req, ext);
    const again = library.existingFor(id, meta);
    if (again) {
      fs.rmSync(tmp, { force: true });
      sendJson(res, 200, { existing: true, id: again.id, rev: library.rev });
      return;
    }
    const song = library.addUploaded(tmp, id, meta, meta.playlistIds, profileId);
    log(`Uploaded: ${[song.artist, song.title].filter(Boolean).join(' - ')}`);
    sendJson(res, 200, { existing: false, id: song.id, rev: library.rev });
  }

  async function route(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, 'http://flow');
    const p = url.pathname.replace(/\/+$/, '');
    const is = (method, pattern) => (method === req.method || (method === 'GET' && req.method === 'HEAD')) && pattern.test(p);

    if (is('GET', /^\/api\/hello$/)) {
      const cfg = config.get();
      const answer = {
        app: 'flow-server', protocol: PROTOCOL, features: FEATURES, version, id: cfg.id, name: cfg.name, password: !!cfg.password,
      };
      // Where the server is on the tailnet, for the apps' Remote address. Only
      // to askers on our own networks: not to whoever a proxy on this machine
      // passes through (it adds X-Forwarded-For).
      const ts = tailscale();
      if (ts && !req.headers['x-forwarded-for'] && isPrivateIp(req.socket.remoteAddress)) answer.tailscale = { ip: ts.ip, dns: ts.dns, port: req.socket.localPort };
      return sendJson(res, 200, answer);
    }
    if (is('POST', /^\/api\/login$/)) return login(req, res);

    if (!p.startsWith('/api/')) throw new HttpError(404, 'Nothing here. This is a Flow Server; open it in the Flow app.');
    const entry = requireAuth(req, url);
    const profile = profileOf(entry);
    const profileId = profile ? profile.id : null;

    if (is('GET', /^\/api\/library$/)) {
      const since = url.searchParams.get('since');
      // An app asking about another profile than it is signed in to (it
      // switched, or its profile was deleted) gets the whole library, even
      // at the same revision.
      const as = url.searchParams.get('as') || '';
      if (since !== null && Number(since) === library.rev && as === (profileId || '')) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, { rev: library.rev, library: library.snapshot(profileId), profile: publicProfile(profile) });
    }
    if (is('POST', /^\/api\/commands$/)) {
      const body = await readJsonBody(req);
      return sendJson(res, 200, library.runCommands(body.commands, profileId));
    }
    const pm = /^\/api\/profiles(?:\/(login|logout|rename|delete))?$/.exec(p);
    if (pm && (req.method === 'POST' || (req.method === 'GET' && !pm[1]))) {
      return profiles(req, res, entry, pm[1] || (req.method === 'GET' ? 'list' : 'create'));
    }
    if (is('POST', /^\/api\/rescan$/)) {
      const result = await library.scan();
      return sendJson(res, 200, { ...result, rev: library.rev });
    }
    let m = /^\/api\/songs\/([\w-]{1,64})\/audio$/.exec(p);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = library.songFile(m[1]);
      if (!file) throw new HttpError(404, 'That song is not on the server.');
      return sendFile(req, res, file);
    }
    m = /^\/api\/songs\/([\w-]{1,64})$/.exec(p);
    if (m && req.method === 'PUT') return upload(req, res, url, m[1], profileId);
    throw new HttpError(404, 'Nothing here.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`Error on ${req.method} ${req.url.split('?')[0]}: ${err.stack || err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // An upload refused before its body was read: let the rest arrive and
      // be thrown away, or the app sees a broken connection, not the reason.
      if (!req.complete) req.resume();
      sendJson(res, status, { error: err.message || 'Something went wrong on the server.' });
    });
  });
  // Uploads over a slow connection can take a while.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  return server;
}

module.exports = { createHttpServer, PROTOCOL };
