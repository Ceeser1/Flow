'use strict';

// The server's HTTP side. Everything is JSON under /api except a song's audio,
// which is sent as it is, in pieces when asked (Range), so the apps can seek.
//
//   GET  /api/hello                    who this is; open to anyone
//   POST /api/login   { password, device } -> { token }
//   GET  /api/library [?since=rev]     { rev, library }, or 204 when nothing changed
//   POST /api/commands { commands }    { rev, results }  (see @flow/core/commands)
//   PUT  /api/songs/:id?meta=...       upload a song; the body is the file
//   GET  /api/songs/:id/audio          the song's file
//   POST /api/rescan                   look through the music folder again
//
// With a password set, every other route needs the token from /api/login:
// "Authorization: Bearer <token>", or ?t=<token> on the audio (an <audio>
// element cannot send headers). Answers carry CORS headers, since the apps'
// windows are pages of their own and the equalizer can only read audio that
// says it may be read.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { AUDIO_EXTS } = require('@flow/core/formats');
const { checkPassword, hashToken } = require('./config');

const PROTOCOL = 1;
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

function createHttpServer({ config, library, version, log = () => {} }) {
  const throttle = createThrottle();

  function tokenOf(req, url) {
    const auth = String(req.headers.authorization || '');
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    return m ? m[1] : url.searchParams.get('t') || '';
  }

  /** Throws 401 unless the request may in; without a password everyone may. */
  function requireAuth(req, url) {
    const cfg = config.get();
    if (!cfg.password) return;
    const token = tokenOf(req, url);
    const hash = token ? hashToken(token) : '';
    const entry = hash && cfg.tokens.find((t) => t.hash === hash);
    if (!entry) throw new HttpError(401, 'This server needs its PIN or password.');
    // Remembered once an hour at most: no write to disk for every request.
    if (Date.now() - entry.lastSeenAt > 3600000) {
      config.set({ tokens: cfg.tokens.map((t) => (t.hash === hash ? { ...t, lastSeenAt: Date.now() } : t)) });
    }
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
    const token = crypto.randomBytes(24).toString('base64url');
    const device = String(body.device || ip).slice(0, 80);
    // A device signing in again replaces its old token rather than piling up.
    const tokens = cfg.tokens.filter((t) => t.device !== device);
    tokens.push({ hash: hashToken(token), device, createdAt: Date.now(), lastSeenAt: Date.now() });
    config.set({ tokens: tokens.slice(-50) });
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

  async function upload(req, res, url, id) {
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
    const song = library.addUploaded(tmp, id, meta, meta.playlistIds);
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
      return sendJson(res, 200, { app: 'flow-server', protocol: PROTOCOL, version, name: cfg.name, password: !!cfg.password });
    }
    if (is('POST', /^\/api\/login$/)) return login(req, res);

    if (!p.startsWith('/api/')) throw new HttpError(404, 'Nothing here. This is a Flow Server; open it in the Flow app.');
    requireAuth(req, url);

    if (is('GET', /^\/api\/library$/)) {
      const since = url.searchParams.get('since');
      if (since !== null && Number(since) === library.rev) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, { rev: library.rev, library: library.snapshot() });
    }
    if (is('POST', /^\/api\/commands$/)) {
      const body = await readJsonBody(req);
      return sendJson(res, 200, library.runCommands(body.commands));
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
    if (m && req.method === 'PUT') return upload(req, res, url, m[1]);
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
