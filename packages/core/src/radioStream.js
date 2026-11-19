'use strict';

// Internet Radio's streams read on their way to the player (5.3.1): what
// the station plays now ("Artist - Title", its ICY StreamTitle) comes from
// the stream itself, mixed into the sound every few kilobytes for the
// players that ask for it (Icy-MetaData: 1). The relay here asks, takes it out
// again and hands the player the sound alone, so one connection to the
// station does both. The desktop runs it in its main process (the window's
// <audio> plays from 127.0.0.1), a Flow Server for the web player (GET
// /api/radio/stream), which also lets a page on https play a station on plain
// http, and lets the page's Web Audio hear it (the answer allows any origin).
//
// Node's own HTTP client turns away Shoutcast's "ICY 200 OK" status line
// (HPE_INVALID_CONSTANT), so the request is made here on a plain socket:
// HTTP/1.1 with Connection: close, redirects followed (http and https may
// send on to each other), a chunked answer undone. A playlist file (.pls,
// .m3u) is followed to its first stream; HLS is not played.
//
// Plain Node (net, tls, stream).

const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { Transform } = require('stream');
const { agentName } = require('./agent');
const { tr } = require('./lang');
const {
  httpUrl, parsePls, parseM3u, isHls,
} = require('./radio');

const MAX_HOPS = 5;
const HEAD_MAX = 32 * 1024;
const PLAYLIST_MAX = 64 * 1024;
// No sound for this long: the station is gone.
const QUIET_MS = 30000;
const TITLE_MAX = 300;

const SOUND_TYPES = /^(audio\/|application\/ogg|video\/(ogg|mp2t|mp4|webm)|application\/octet-stream)/i;
const PLS_TYPES = /(scpls|x-pls|\/pls)/i;
const M3U_TYPES = /(mpegurl|x-m3u|\/m3u)/i;

// Why a stream cannot be played, by code (core.radio.<code>, as radio.js checkStream says it).
const WHY = {
  notAnAddress: [400, 'That is not a web address (it should start with http:// or https://).'],
  noAnswer: [504, 'The address did not answer in time.'],
  unreachable: [502, 'The address cannot be reached.'],
  httpError: [502, 'The address answered with an error ({status}).'],
  noStream: [415, 'No radio stream was found at that address.'],
  hls: [415, 'This station streams as HLS (.m3u8), which Flow cannot play.'],
  webPage: [415, 'That is a web page, not a radio stream. The stream\'s own address is needed (often on the station\'s page as "Listen" or a .m3u / .pls link).'],
  refused: [403, 'That address may not be asked.'],
  quiet: [504, 'The station went quiet.'],
};

/** An error with a code (WHY) and the HTTP status the relay answers it with. */
function streamError(code, vars = {}) {
  const [status, english] = WHY[code] || WHY.unreachable;
  const e = new Error(tr(`core.radio.${code}`, english, vars));
  e.code = code in WHY ? code : 'unreachable';
  e.status = code === 'httpError' && vars.status === 404 ? 404 : status;
  return e;
}

/** Addresses a Flow Server's relay never asks (itself, the machine's own services, link-local). */
function isOwnAddress(ip) {
  const a = String(ip || '').toLowerCase().replace(/^::ffff:/, '');
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 127 || x === 0 || (x === 169 && y === 254);
  }
  return a === '::1' || a === '::' || /^fe[89ab]/.test(a);
}

/** A DNS lookup that fails for the addresses `refuse(ip)` turns down. */
function guardedLookup(refuse) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (Array.isArray(address)) {
        const ok = address.filter((x) => !refuse(x.address));
        if (!ok.length) return callback(streamError('refused'));
        return callback(null, ok);
      }
      if (refuse(address)) return callback(streamError('refused'));
      return callback(null, address, family);
    });
  };
}

/** Undoes Transfer-Encoding: chunked. */
class Dechunk extends Transform {
  constructor() {
    super();
    this.buf = Buffer.alloc(0);
    this.left = -1; // bytes of the chunk still to come; -1: its size line next
    this.done = false;
  }

  _transform(chunk, enc, cb) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.done && this.buf.length) {
      if (this.left < 0) {
        const nl = this.buf.indexOf('\n');
        if (nl < 0) {
          if (this.buf.length > 1024) return cb(streamError('noStream'));
          break;
        }
        const size = parseInt(this.buf.slice(0, nl).toString('latin1').split(';')[0].trim(), 16);
        this.buf = this.buf.slice(nl + 1);
        if (!Number.isFinite(size)) return cb(streamError('noStream'));
        if (size === 0) {
          this.done = true;
          break;
        }
        this.left = size;
      } else if (this.left > 0) {
        const take = Math.min(this.left, this.buf.length);
        this.push(this.buf.slice(0, take));
        this.buf = this.buf.slice(take);
        this.left -= take;
      } else {
        // The line end after a chunk.
        const nl = this.buf.indexOf('\n');
        if (nl < 0) break;
        this.buf = this.buf.slice(nl + 1);
        this.left = -1;
      }
    }
    cb();
  }
}

/** Text the station sent: UTF-8 when it is, else Windows-1252 (Latin-1), as most older stations send. */
function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return Buffer.from(bytes).toString('latin1');
    }
  }
}

/** A StreamTitle as shown: '' for none (empty, only dashes or dots). */
function cleanTitle(raw) {
  const t = String(raw || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /^[-–—|.:\s]*$/.test(t)) return '';
  return t.slice(0, TITLE_MAX);
}

/**
 * The StreamTitle of an ICY metadata block ("StreamTitle='...';StreamUrl='...';"),
 * null when the block has none. A title may hold a ' itself ("Guns N' Roses").
 */
function parseIcyMeta(bytes) {
  const text = decodeText(bytes).replace(/\0+$/, '');
  const m = /StreamTitle='([\s\S]*?)';(?=\s*(?:[A-Za-z]+=|$))/.exec(text) || /StreamTitle='([\s\S]*)'?;?\s*$/.exec(text);
  return m ? cleanTitle(m[1]) : null;
}

/**
 * The sound of a stream with ICY metadata (every `metaint` bytes a length
 * byte, then that many times 16 bytes of text): the text taken out, each new
 * StreamTitle told to onTitle(title).
 */
class IcyReader extends Transform {
  constructor(metaint, onTitle) {
    super();
    this.metaint = metaint;
    this.onTitle = onTitle;
    this.audioLeft = metaint;
    this.metaLeft = -1; // -1: in the sound; 0: the length byte next; > 0: text still to come
    this.meta = [];
    this.last = null;
  }

  _transform(chunk, enc, cb) {
    let at = 0;
    while (at < chunk.length) {
      if (this.metaLeft < 0) {
        const take = Math.min(this.audioLeft, chunk.length - at);
        this.push(chunk.slice(at, at + take));
        at += take;
        this.audioLeft -= take;
        if (this.audioLeft === 0) this.metaLeft = 0;
      } else if (this.metaLeft === 0 && !this.meta.length) {
        const len = chunk[at] * 16;
        at += 1;
        if (len === 0) {
          this.metaLeft = -1;
          this.audioLeft = this.metaint;
        } else {
          this.metaLeft = len;
          this.meta = [];
          this.metaWant = len;
        }
      } else {
        const take = Math.min(this.metaLeft, chunk.length - at);
        this.meta.push(chunk.slice(at, at + take));
        at += take;
        this.metaLeft -= take;
        if (this.metaLeft === 0) {
          const title = parseIcyMeta(Buffer.concat(this.meta));
          this.meta = [];
          this.metaLeft = -1;
          this.audioLeft = this.metaint;
          if (title !== null && title !== this.last) {
            this.last = title;
            try {
              this.onTitle(title);
            } catch {
              // The listener's own trouble.
            }
          }
        }
      }
    }
    cb();
  }
}

/**
 * A station's address asked: resolves { status, headers (names in lower
 * case), url (after redirects), body (a Readable of what follows the head),
 * socket } once the head is in. `refuse(ip)`: addresses not to connect to.
 */
function openStream(raw, {
  timeoutMs = 15000, hops = 0, refuse = null, icy = true,
} = {}) {
  const href = httpUrl(raw);
  if (!href) return Promise.reject(streamError('notAnAddress'));
  const u = new URL(href);
  const secure = u.protocol === 'https:';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || (secure ? 443 : 80);
  if (refuse && net.isIP(host) && refuse(host)) return Promise.reject(streamError('refused'));
  return new Promise((resolve, reject) => {
    const opts = { host, port };
    if (refuse) opts.lookup = guardedLookup(refuse);
    const socket = secure
      ? tls.connect({ ...opts, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] })
      : net.connect(opts);
    let head = Buffer.alloc(0);
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err && err.code in WHY ? err : streamError('unreachable'));
    };
    socket.setTimeout(timeoutMs, () => fail(streamError('noAnswer')));
    socket.once('error', fail);
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      const hostHeader = u.port ? `${u.hostname}:${u.port}` : u.hostname;
      socket.write([
        `GET ${u.pathname || '/'}${u.search} HTTP/1.1`,
        `Host: ${hostHeader}`,
        `User-Agent: ${agentName()}`,
        'Accept: */*',
        `Icy-MetaData: ${icy ? 1 : 0}`,
        'Connection: close',
        '', '',
      ].join('\r\n'));
    });
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = /\r?\n\r?\n/.exec(head.toString('latin1'));
      if (!end) {
        if (head.length > HEAD_MAX) fail(streamError('noStream'));
        return;
      }
      socket.removeListener('data', onData);
      socket.pause();
      const text = head.slice(0, end.index).toString('latin1');
      const rest = head.slice(end.index + end[0].length);
      const lines = text.split(/\r?\n/);
      const sm = /^(?:HTTP\/\d(?:\.\d)?|ICY)\s+(\d{3})/i.exec(lines[0] || '');
      if (!sm) {
        fail(streamError('noStream'));
        return;
      }
      const status = Number(sm[1]);
      const headers = {};
      for (const line of lines.slice(1)) {
        const c = line.indexOf(':');
        if (c <= 0) continue;
        const name = line.slice(0, c).trim().toLowerCase();
        const value = line.slice(c + 1).trim();
        headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
      }
      if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
        settled = true;
        socket.destroy();
        if (hops >= MAX_HOPS) {
          reject(streamError('unreachable'));
          return;
        }
        let next;
        try {
          next = new URL(headers.location, href).href;
        } catch {
          reject(streamError('unreachable'));
          return;
        }
        openStream(next, {
          timeoutMs, hops: hops + 1, refuse, icy,
        }).then(resolve, reject);
        return;
      }
      settled = true;
      socket.removeListener('error', fail);
      // Listening on: the stream's own trouble is the reader's (the body's 'error').
      socket.on('error', () => {});
      if (rest.length) socket.unshift(rest);
      const chunked = /chunked/i.test(headers['transfer-encoding'] || '');
      const body = chunked ? socket.pipe(new Dechunk()) : socket;
      if (chunked) socket.on('error', (err) => body.destroy(err));
      socket.setTimeout(QUIET_MS, () => socket.destroy(streamError('quiet')));
      resolve({
        status, headers, url: href, body, socket,
      });
    };
    socket.on('data', onData);
  });
}

/** Up to `max` bytes of a body, as text; the connection let go of after. */
function readSome(opened, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = () => {
      opened.socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8').slice(0, max));
    };
    opened.body.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size >= max) done();
    });
    opened.body.once('end', done);
    opened.body.once('error', done);
    opened.body.resume();
  });
}

/**
 * A station's stream ready to be played through: a playlist file followed to
 * its stream, anything that is no sound refused. Resolves openStream's
 * answer, with `type` (the sound's), `metaint` (0: no song info in it) and
 * `source` (the stream's own address: the one asked, or the playlist's, not
 * where it sent on to, which may carry a key that runs out).
 */
async function openSound(raw, opts = {}, depth = 0) {
  const opened = await openStream(raw, opts);
  const { status, headers } = opened;
  if (status < 200 || status >= 300) {
    opened.socket.destroy();
    throw streamError('httpError', { status });
  }
  const type = String(headers['content-type'] || '').split(';')[0].trim();
  const path = new URL(opened.url).pathname.toLowerCase();
  const playlist = PLS_TYPES.test(type) || M3U_TYPES.test(type) || /\.(pls|m3u8?)$/.test(path);
  if (playlist) {
    const body = await readSome(opened, PLAYLIST_MAX);
    if (isHls(body)) throw streamError('hls');
    const inner = PLS_TYPES.test(type) || /\.pls$/.test(path) || /^\s*\[playlist\]/i.test(body) ? parsePls(body) : parseM3u(body);
    if (!inner || depth >= 2) throw streamError('noStream');
    return openSound(inner, opts, depth + 1);
  }
  // A sound, or a Shoutcast answer that names none (its icy- headers say what it is).
  const icyAnswer = Object.keys(headers).some((k) => k.startsWith('icy-'));
  if (!SOUND_TYPES.test(type) && !(icyAnswer && !/^(text\/|application\/(json|xml))/i.test(type))) {
    opened.socket.destroy();
    throw streamError(/^text\/html/i.test(type) ? 'webPage' : 'noStream');
  }
  const metaint = Math.max(0, parseInt(headers['icy-metaint'], 10) || 0);
  return {
    ...opened, type: type || 'audio/mpeg', metaint, source: httpUrl(raw),
  };
}

/**
 * Add Radio's check where the stream is played through this relay (a Flow
 * Server's, for the web player): { url (the stream's own address), name (its
 * icy-name, '' for none), checked (false: no sound type was named, so it is
 * taken as it is) }, else throws streamError's Error (with its code).
 */
async function checkSound(raw, opts = {}) {
  const s = await openSound(raw, { ...opts, icy: false });
  s.socket.destroy();
  const named = String(s.headers['content-type'] || '').split(';')[0].trim();
  return {
    url: s.source,
    name: String(s.headers['icy-name'] || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    checked: SOUND_TYPES.test(named) && !/octet-stream/i.test(named),
  };
}

/**
 * Plays the station at `url` through to `res` (an http.ServerResponse),
 * the sound only. onInfo({ meta, title, name }) is told once the stream is
 * there (meta: whether it says what plays; name: its icy-name) and with each
 * new title (meta true). Resolves once the sound flows; rejects (nothing sent
 * yet) with an Error whose `status` is the answer to give.
 */
async function relay(url, res, {
  onInfo = () => {}, refuse = null, cors = true, timeoutMs = 15000,
} = {}) {
  const s = await openSound(url, { refuse, timeoutMs });
  if (res.destroyed || res.writableEnded) {
    s.socket.destroy();
    return;
  }
  const headers = {
    'Content-Type': s.type,
    'Cache-Control': 'no-store',
  };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  res.writeHead(200, headers);
  const name = String(s.headers['icy-name'] || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const tell = (info) => {
    try {
      onInfo({ name, ...info });
    } catch {
      // The listener's own trouble.
    }
  };
  tell({ meta: s.metaint > 0, title: '' });
  const sound = s.metaint > 0 ? s.body.pipe(new IcyReader(s.metaint, (title) => tell({ meta: true, title }))) : s.body;
  if (sound !== s.body) s.body.on('error', (err) => sound.destroy(err));
  sound.pipe(res);
  sound.on('error', () => res.destroy());
  res.on('close', () => s.socket.destroy());
  s.body.resume();
}

module.exports = {
  openStream, openSound, checkSound, relay, IcyReader, Dechunk, parseIcyMeta, cleanTitle, decodeText, isOwnAddress,
};
