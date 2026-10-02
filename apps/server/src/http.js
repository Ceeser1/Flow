'use strict';

// The server's HTTP side. Everything is JSON under /api except a song's audio,
// which is sent as it is, in pieces when asked (Range), so the apps can seek.
//
//   GET  /api/hello                    who this is; open to anyone (and, to askers on
//                                      a private network, its Tailscale address)
//   GET  /api/check                    what the server saw of this request (through
//                                      a proxy?), for flow-server doctor; open to anyone
//   POST /api/login   { password, device } -> { token }
//   GET  /api/library [?since=rev&as=profileId]
//                                      { rev, library, profile }, or 204 when
//                                      nothing changed for that profile
//   POST /api/commands { commands }    { rev, results }  (see @flow/core/commands)
//   PUT  /api/songs/:id?meta=...       upload a song; the body is the file
//   GET  /api/songs/:id/audio          the song's file
//   POST /api/rescan                   look through the music folder again
//   GET  /api/live?client=<id>&device=<name>
//                                      the app's live channel: events as they
//                                      happen (live.js), while the app is connected
//   GET  /api/sessions                 { sessions, mine, request }: Active Sessions
//   POST /api/sessions { type, ... }   taking part in them (sessions.js)
//
// Downloads by the server (downloads.js; only when /api/hello lists the
// "download" feature), one batch per profile:
//   GET    /api/downloads              { batch } (null: none)
//   POST   /api/downloads { url, kind, options }   a new batch: { batch }, 409 with one already
//   DELETE /api/downloads              cancel the whole batch
//   GET    /api/downloads/items/:i/peaks           the song's waveform
//   GET    /api/downloads/items/:i/audio           the prepared song (Range, ?t=)
//   POST   /api/downloads/items/:i/finish { meta, start, end, playlistIds, playlist, existing }
//                                      saved into the library: { song, batch }
//   POST   /api/downloads/items/:i/retry           a song that failed, again
//   DELETE /api/downloads/items/:i     one song thrown away
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
//
// From the internet (level 3 or 4, see @flow/core/password) the server is
// behind a proxy that does the https. Then:
//   - A proxy on this machine, or one in trustedProxies, says who the caller
//     is (X-Forwarded-For); the wrong-password waits go by that address, not
//     the proxy's. Anyone else's X-Forwarded-For is not believed.
//   - Plain http straight from a public address (this port forwarded on the
//     router) gets no answer at all: the password would cross the internet
//     unencrypted. Nor does plain http through the proxy from outside.
//   - Without a strong password nobody gets past /api/hello: at level 3 or
//     4, and whenever a request came through a proxy from outside. Except
//     the home network (atHome below): it needs no password at any level,
//     as long as the server can tell the caller is on it.
//   - A token there is a session, not a key to keep: it ends after
//     SESSION_IDLE without a request, or SESSION_MAX in all, or when the
//     server is restarted, and then only the password (POST /api/login)
//     opens a new one. A token from before (kept by an app, or from a lower
//     level) does not let anyone in. Signing in to a profile does not renew a
//     session; only the password does. /api/hello says "session: true" there,
//     so an app signs in with its password each time it starts, not with the
//     token it kept.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { AUDIO_EXTS } = require('@flow/core/formats');
const { isPrivateIp, isTailscaleAddress } = require('@flow/core/address');
const { PUBLIC_LEVEL } = require('@flow/core/password');
const { checkPassword, hashPassword, hashToken, CLIENT_ID } = require('./config');
const { DownloadError } = require('./downloads');
const { SessionError } = require('./sessions');

const PROTOCOL = 1;
// What this server can do beyond protocol 1, for apps that know to ask.
const FEATURES = ['profiles'];
const MAX_PROFILE_NAME = 40;
const MAX_JSON = 8 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
// Level 3 and 4 sessions: an app polls every few seconds while it is open, so
// the idle time only ends the session of an app that was closed or asleep.
const SESSION_IDLE = 30 * 60 * 1000;
const SESSION_MAX = 24 * 60 * 60 * 1000;

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
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
// one before (1 s, 2 s, 4 s... up to 5 minutes), which makes guessing a password
// hopeless without ever locking out the right one for long. Many addresses
// at once (from the internet, a botnet) are held back together: after
// GLOBAL_TRIES wrong ones within GLOBAL_WINDOW, nobody may try until the
// oldest is out of it. Devices already signed in are not held back.
const GLOBAL_TRIES = 30;
const GLOBAL_WINDOW = 10 * 60 * 1000;

function createThrottle() {
  const failures = new Map(); // ip -> { count, until }
  let recent = []; // when the last wrong tries were, from anywhere
  return {
    check(ip) {
      const now = Date.now();
      const f = failures.get(ip);
      if (f && f.until > now) {
        throw new HttpError(429, `Too many wrong tries. Wait ${Math.ceil((f.until - now) / 1000)} seconds.`);
      }
      recent = recent.filter((t) => t > now - GLOBAL_WINDOW);
      if (recent.length >= GLOBAL_TRIES) {
        throw new HttpError(429, `Too many wrong tries on this server lately. Wait ${Math.ceil((recent[0] + GLOBAL_WINDOW - now) / 60000)} minutes.`);
      }
    },
    fail(ip) {
      const now = Date.now();
      const f = failures.get(ip) || { count: 0, until: 0 };
      f.count += 1;
      f.until = now + Math.min(300000, 1000 * 2 ** (f.count - 1));
      failures.set(ip, f);
      recent.push(now);
      // Many addresses: the ones quiet for an hour are forgotten.
      if (failures.size > 10000) {
        for (const [key, v] of failures) if (v.until < now - 3600000) failures.delete(key);
      }
    },
    ok(ip) {
      failures.delete(ip);
    },
  };
}

// Headers a proxy adds. Any of them on a request means a proxy passed it on,
// whether or not what they say is believed.
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded'];

/** An address without the IPv4-in-IPv6 prefix, brackets or (IPv4) port. */
function bareIp(value) {
  const a = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a) ? a.replace(/:\d+$/, '') : a;
}

const isLoopback = (ip) => ip === '::1' || /^127\./.test(ip);

function createHttpServer({
  config, library, version, log = () => {}, tailscale = () => null, downloads = null, live = null, sessions = null,
}) {
  const throttle = createThrottle();
  // Sessions of levels 3 and 4 do not outlive the server's run.
  const startedAt = Date.now();

  const trustedProxy = (ip) => isLoopback(ip) || config.get().trustedProxies.includes(ip);

  /**
   * Who a request is from. socket: the machine that connected. ip: the
   * caller, as a trusted proxy says (the last address in X-Forwarded-For it
   * did not add itself), else the socket. proxied: a proxy passed it on.
   * outside: it came through a proxy from outside the home network and the
   * tailnet, or from a proxy that is not trusted (so from who knows where).
   * https: false when the proxy says the caller used plain http.
   */
  function clientOf(req) {
    const socket = bareIp(req.socket.remoteAddress);
    const proxied = PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
    const trusted = proxied && trustedProxy(socket);
    let ip = socket;
    if (trusted) {
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(bareIp).filter(Boolean);
      while (hops.length > 1 && trustedProxy(hops[hops.length - 1])) hops.pop();
      ip = hops.pop() || bareIp(req.headers['x-real-ip']) || socket;
    }
    const proto = String(req.headers['x-forwarded-proto'] || (/proto=([a-z]+)/i.exec(String(req.headers.forwarded || '')) || [])[1] || '')
      .split(',')[0].trim().toLowerCase();
    // A proxy that is not trusted is told about once, in the log: its callers
    // all look like it, so the wrong-password waits are shared by them.
    if (proxied && !trusted && !untrustedSeen.has(socket) && untrustedSeen.size < 100) {
      untrustedSeen.add(socket);
      log(`Requests come through a proxy at ${socket} that is not trusted. If it is yours: flow-server --trusted-proxy ${socket}`);
    }
    return {
      socket, ip, proxied, trusted, outside: proxied && (!trusted || !isPrivateIp(ip)), proto, https: proto !== 'http',
    };
  }
  const untrustedSeen = new Set();

  /** Why a request gets no answer at all (see the top), or ''. */
  function refusal(client) {
    if (!isPrivateIp(client.socket) && !config.get().trustedProxies.includes(client.socket)) {
      return 'This Flow Server does not answer the internet over plain http. Use its https address, or Tailscale.';
    }
    if (client.outside && !client.https) return 'This Flow Server is not used over plain http from the internet. Use its https address.';
    // Chosen to be reached from the home network (and Tailscale) only: a
    // proxy still passing the internet on to it (left over from level 3 or
    // 4, or set up by hand) gets nothing.
    const { level } = config.get();
    if (client.outside && level && level < PUBLIC_LEVEL) {
      return `This Flow Server is set to level ${level}, not reachable from the internet. On the server, choose level 3 or 4 (sh apps/server/install.sh) to use it from outside.`;
    }
    return '';
  }

  /**
   * A caller on the home network, as far as can be told: a private address
   * (not Tailscale's, which is away from home), arrived directly or through a
   * proxy that names the caller. Not trusted when it cannot be known: a proxy
   * (on this machine, or one that is trusted) that passed on nothing about
   * who called looks like a caller from home but may be anyone, and so does
   * the loopback.
   */
  function atHome(client) {
    if (client.outside || !isPrivateIp(client.ip) || isLoopback(client.ip) || isTailscaleAddress(client.ip)) return false;
    return client.proxied || !trustedProxy(client.socket);
  }

  /** At level 3 and 4 the home network is let in without the password the internet needs. */
  const openAtHome = (client) => config.get().level >= PUBLIC_LEVEL && atHome(client);

  /** Why a request only gets /api/hello (the server is open to the internet without a strong password), or ''. */
  function lockReason(client) {
    const cfg = config.get();
    if ((cfg.level < PUBLIC_LEVEL && !client.outside) || (cfg.password && cfg.password.strong) || atHome(client)) return '';
    return cfg.password
      ? 'This Flow Server can be reached from the internet, and its password is too weak for that, so it lets no one in. On the server, set a stronger one: flow-server set-password'
      : 'This Flow Server can be reached from the internet but has no password, so it lets no one in. On the server, set one: flow-server set-password';
  }

  function checkExposure(client, isHello) {
    const refused = refusal(client);
    if (refused) throw new HttpError(403, refused);
    const locked = isHello ? '' : lockReason(client);
    if (locked) throw new HttpError(403, locked);
  }

  function tokenOf(req, url) {
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    return m ? m[1] : url.searchParams.get('t') || '';
  }

  /** Whether a token's session is over (levels 3 and 4 only; below, a token lasts). */
  function sessionEnded(entry, cfg, now = Date.now()) {
    if (!(cfg.level >= PUBLIC_LEVEL)) return false;
    return entry.createdAt < startedAt
      || now - Math.max(entry.lastSeenAt, entry.createdAt) > SESSION_IDLE || now - entry.createdAt > SESSION_MAX;
  }

  /**
   * The request's token entry (null: none). Throws 401 unless the request may
   * in; without a password everyone may, and so may the home network at
   * level 3 and 4 (there a token only says which profile this is, whatever
   * its age; a session that ended counts for nothing away from home).
   */
  function requireAuth(req, url, client) {
    return authorize(tokenOf(req, url), client);
  }

  /** requireAuth for a token in hand (an open live stream checks its own again and again). */
  function authorize(token, client) {
    const cfg = config.get();
    const hash = token ? hashToken(token) : '';
    const found = (hash && cfg.tokens.find((t) => t.hash === hash)) || null;
    const open = !cfg.password || openAtHome(client);
    const ended = !!found && !open && sessionEnded(found, cfg);
    const entry = ended || (!found && !open) ? null : found;
    if (!entry && !open) {
      throw new HttpError(401, ended ? 'This session has ended. This server needs its password again.' : 'This server needs its password.');
    }
    // Remembered once an hour at most (a session, once a minute, for its idle
    // time): no write to disk for every request.
    const every = cfg.level >= PUBLIC_LEVEL ? 60000 : 3600000;
    if (entry && Date.now() - entry.lastSeenAt > every) {
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

  /** The app's install id from a request body (or the token it carries on from), or ''. */
  function clientIdOf(body, entry) {
    const id = String((body && body.client) || (entry && entry.client) || '');
    return CLIENT_ID.test(id) ? id : '';
  }

  /**
   * A new token for `device`, replacing its old one. `client`: the app's
   * install id; with one, only that app's old token is replaced (two PCs of
   * the same name are two devices), along with one its machine had from
   * before apps sent it. `session`: the token entry it carries on from (a
   * profile signed in to), which keeps the session's start: only the
   * password makes a session a new one.
   */
  function issueToken(device, profileId, session = null, client = '') {
    const cfg = config.get();
    const now = Date.now();
    const token = crypto.randomBytes(24).toString('base64url');
    const tokens = cfg.tokens.filter((t) => (client ? t.client !== client && !(t.device === device && !t.client) : t.device !== device));
    tokens.push({ hash: hashToken(token), device, client, createdAt: session ? session.createdAt : now, lastSeenAt: now, profileId });
    config.set({ tokens: tokens.slice(-50) });
    return token;
  }

  function checkProfileName(name, exceptId = null) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new HttpError(400, 'Please enter a name for the profile.');
    if (clean.length > MAX_PROFILE_NAME) throw new HttpError(400, `Profile names can be at most ${MAX_PROFILE_NAME} characters.`);
    if (['none', 'default', 'default / shared', '+ new'].includes(clean.toLowerCase())) throw new HttpError(400, `"${clean}" cannot be a profile's name.`);
    const clash = config.get().profiles.find((p) => p.id !== exceptId && p.name.toLowerCase() === clean.toLowerCase());
    if (clash) throw new HttpError(409, `A profile called "${clash.name}" already exists.`);
    return clean;
  }

  function setToken(entry, patch) {
    const cfg = config.get();
    config.set({ tokens: cfg.tokens.map((t) => (t.hash === entry.hash ? { ...t, ...patch } : t)) });
  }

  async function profiles(req, res, entry, action, { ip }) {
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
      return sendJson(res, 200, { token: issueToken(device, id, entry, clientIdOf(body, entry)), profile: publicProfile(profile) });
    }
    if (action === 'login') {
      throttle.check(ip);
      const profile = config.get().profiles.find((p) => p.id === String(body.profileId || ''));
      if (!profile || !library.profileIds().includes(profile.id)) throw new HttpError(404, 'That profile no longer exists.');
      if (profile.pin && !checkPassword(profile.pin, String(body.pin || ''))) {
        throttle.fail(ip);
        log(`Wrong PIN for profile ${profile.name} from ${ip}`);
        throw new HttpError(403, 'Wrong PIN for this profile.');
      }
      throttle.ok(ip);
      log(`Signed in: ${device} as ${profile.name}`);
      return sendJson(res, 200, { token: issueToken(device, profile.id, entry, clientIdOf(body, entry)), profile: publicProfile(profile) });
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
      // Others see the name under the playlists it shares.
      library.touch();
      return sendJson(res, 200, { profile: publicProfile({ ...current, name }) });
    }
    if (action === 'delete') {
      if (downloads) downloads.dropProfile(current.id);
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

  async function login(req, res, { ip }) {
    throttle.check(ip);
    const body = await readJsonBody(req);
    const cfg = config.get();
    // An app that sends no password (it relied on an old token) is turned
    // away at once; that is no guess, so it costs no wait.
    if (cfg.password && !(typeof body.password === 'string' && body.password)) {
      throw new HttpError(401, 'This server needs its password.');
    }
    if (!checkPassword(cfg.password, String(body.password || ''))) {
      throttle.fail(ip);
      log(`Wrong password from ${ip}`);
      throw new HttpError(401, 'Wrong password.');
    }
    throttle.ok(ip);
    const device = String(body.device || ip).slice(0, 80);
    // A device signing in again replaces its old token rather than piling up.
    const token = issueToken(device, null, null, clientIdOf(body));
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
    const client = clientOf(req);

    if (is('GET', /^\/api\/hello$/)) {
      checkExposure(client, true);
      const cfg = config.get();
      // From home at level 3 and 4 no password is asked for, so none is announced.
      const home = openAtHome(client);
      // Downloading only with yt-dlp and ffmpeg on the machine.
      const features = [...FEATURES, ...(downloads && downloads.available() ? ['download'] : []), ...(live ? ['sessions'] : [])];
      const answer = {
        app: 'flow-server', protocol: PROTOCOL, features, version, id: cfg.id, name: cfg.name, password: !!cfg.password && !home,
      };
      // Where the server is on the tailnet, for the apps' Remote address. Only
      // to askers on our own networks: not to whoever a proxy passes through.
      // Not at level 1, the home network only.
      const ts = cfg.level === 1 ? null : tailscale();
      if (ts && !client.proxied && isPrivateIp(client.socket)) answer.tailscale = { ip: ts.ip, dns: ts.dns, port: req.socket.localPort };
      // Its https address on the internet, for the same: no secret, anyone
      // who got here through it knows it already.
      if (cfg.level >= PUBLIC_LEVEL && cfg.publicUrl) answer.publicUrl = cfg.publicUrl;
      // Tokens are sessions here: apps sign in with the password each time they start.
      if (cfg.level >= PUBLIC_LEVEL && !home) answer.session = true;
      return sendJson(res, 200, answer);
    }
    if (is('GET', /^\/api\/check$/)) {
      // What the server made of this request, for flow-server doctor: whether
      // a proxy in front passes on who is calling and how. Nothing the
      // caller doesn't know already, except whether the server lets anyone in.
      checkExposure(client, true);
      const locked = lockReason(client);
      return sendJson(res, 200, {
        proxied: client.proxied, trusted: client.trusted, ip: client.ip, proto: client.proto || null, level: config.get().level, locked: locked || null,
      });
    }
    checkExposure(client, false);
    if (is('POST', /^\/api\/login$/)) return login(req, res, client);

    if (!p.startsWith('/api/')) throw new HttpError(404, 'Nothing here. This is a Flow Server; open it in the Flow app.');
    const entry = requireAuth(req, url, client);
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
    if (is('GET', /^\/api\/live$/)) return openLive(req, res, url, client, entry);
    if (p === '/api/sessions' && (req.method === 'GET' || req.method === 'POST')) return sessionRoute(req, res, url, entry);
    if (is('POST', /^\/api\/commands$/)) {
      const body = await readJsonBody(req);
      return sendJson(res, 200, library.runCommands(body.commands, profileId));
    }
    const pm = /^\/api\/profiles(?:\/(login|logout|rename|delete))?$/.exec(p);
    if (pm && (req.method === 'POST' || (req.method === 'GET' && !pm[1]))) {
      return profiles(req, res, entry, pm[1] || (req.method === 'GET' ? 'list' : 'create'), client);
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
    if (p.startsWith('/api/downloads')) return downloadRoute(req, res, p, profileId);
    throw new HttpError(404, 'Nothing here.');
  }

  /**
   * The live channel (live.js) of the app whose install id is ?client=. With
   * a token that names an app, only that app may open it. ?device= is the
   * name the app goes by; ?probe=1 is flow-server doctor's test.
   */
  function openLive(req, res, url, client, entry) {
    if (!live) throw new HttpError(404, 'Nothing here.');
    const id = String(url.searchParams.get('client') || '');
    if (!CLIENT_ID.test(id)) throw new HttpError(400, 'The live channel needs the app\'s id.');
    if (entry && entry.client && entry.client !== id) throw new HttpError(403, 'That is another app\'s live channel.');
    if (!live.hasRoom(id)) throw new HttpError(503, 'Too many apps are connected to this server right now.');
    const token = tokenOf(req, url);
    const device = String(url.searchParams.get('device') || (entry && entry.device) || client.ip).replace(/\s+/g, ' ').trim().slice(0, 80);
    const describe = (e) => {
      const p = profileOf(e);
      return { profileId: p ? p.id : null, profileName: p ? p.name : '', device, ip: client.ip };
    };
    live.open(req, res, {
      client: id, ...describe(entry), probe: url.searchParams.get('probe') === '1', check: () => describe(authorize(token, client)),
    });
  }

  /**
   * Active Sessions (sessions.js): GET the list and this app's place in it,
   * POST { type, ... } to take part. The app is the one its token names, or
   * (no token naming one) ?client= / the body's client.
   */
  async function sessionRoute(req, res, url, entry) {
    if (!sessions) throw new HttpError(404, 'Nothing here.');
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const id = (entry && entry.client) || String(body.client || url.searchParams.get('client') || '');
    if (!CLIENT_ID.test(id)) throw new HttpError(400, 'Sessions need the app\'s id.');
    if (req.method === 'GET') return sendJson(res, 200, sessions.view(id));
    return sendJson(res, 200, { ok: true, ...sessions.handle(id, body) });
  }

  /** The server's own downloads, those of the profile signed in to (see the top). */
  async function downloadRoute(req, res, p, profileId) {
    if (!downloads) throw new HttpError(404, 'This server does not download songs.');
    const is = (method, pattern) => (method === req.method || (method === 'GET' && req.method === 'HEAD')) && pattern.test(p);
    if (is('GET', /^\/api\/downloads$/)) return sendJson(res, 200, { batch: downloads.get(profileId) });
    if (is('POST', /^\/api\/downloads$/)) {
      const body = await readJsonBody(req);
      return sendJson(res, 200, { batch: downloads.create(profileId, body) });
    }
    if (is('DELETE', /^\/api\/downloads$/)) {
      downloads.cancel(profileId);
      return sendJson(res, 200, { batch: null });
    }
    const m = /^\/api\/downloads\/items\/(\d{1,4})(?:\/(peaks|audio|finish|retry))?$/.exec(p);
    if (!m) throw new HttpError(404, 'Nothing here.');
    const [, index, what] = m;
    if (what === 'peaks' && is('GET', /./)) return sendJson(res, 200, { peaks: downloads.peaks(profileId, index) });
    if (what === 'audio' && is('GET', /./)) return sendFile(req, res, downloads.audioFile(profileId, index));
    if (what === 'finish' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await downloads.finish(profileId, index, body);
      return sendJson(res, 200, { ...result, rev: library.rev });
    }
    if (what === 'retry' && req.method === 'POST') return sendJson(res, 200, { batch: downloads.retry(profileId, index) });
    if (!what && req.method === 'DELETE') return sendJson(res, 200, { batch: downloads.discard(profileId, index) });
    throw new HttpError(404, 'Nothing here.');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      const status = err instanceof HttpError || err instanceof DownloadError || err instanceof SessionError ? err.status : 500;
      if (status === 500) log(`Error on ${req.method} ${req.url.split('?')[0]}: ${err.stack || err}`);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // An upload refused before its body was read: let the rest arrive and
      // be thrown away, or the app sees a broken connection, not the reason.
      if (!req.complete) req.resume();
      sendJson(res, status, { error: err.message || 'Something went wrong on the server.', ...(err.extra || {}) });
    });
  });
  // Uploads over a slow connection can take a while.
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  return server;
}

module.exports = { createHttpServer, PROTOCOL };
