'use strict';

// flow-server doctor <address>: checks a Flow Server from where the apps will
// use it, through whatever is in front of it (Caddy, nginx, a tunnel...). It
// tests what the server and the proxy do, not how they are set up, so it
// works for any of them. Run it on the server for a first look, and from
// outside the home network (a laptop on a phone's hotspot) for the real one:
// from inside, some routers can't reach their own public address.
//
// Each check gives ok, warn (works, but not as it should) or fail (the apps
// won't work, or it isn't safe), with what to do about it.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { serverBaseUrl, isPrivateIp, isTailscaleAddress, DEFAULT_PORT } = require('@flow/core/address');

const TIMEOUT = 10000;
// An upload the size of a long live recording: what a proxy has to let through.
const BIG_UPLOAD = 1900 * 1024 * 1024;

/**
 * One request, answered as { status, headers, text } (the first maxBytes of
 * the body). holdBody: send the headers only and never the body, to see what
 * the other side makes of a large upload before any of it arrives.
 */
function request(url, {
  method = 'GET', headers = {}, body, holdBody = false, timeout = TIMEOUT, ca, maxBytes = 65536, lookup,
} = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers, timeout, ca, lookup, agent: false }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < maxBytes) chunks.push(c);
        size += c.length;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') });
        if (holdBody) req.destroy();
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('No answer in time.'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    if (holdBody) req.flushHeaders();
    else req.end(body);
  });
}

function json(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

/** A connection error as words. */
function why(err) {
  const code = err && (err.code || (err.cause && err.cause.code));
  const known = {
    ENOTFOUND: 'the name is not known (DNS)',
    ECONNREFUSED: 'nothing answers on that port',
    ECONNRESET: 'the connection was cut',
    EHOSTUNREACH: 'the machine can\'t be reached',
    ENETUNREACH: 'the network can\'t be reached',
    TIMEOUT: 'no answer in time',
    ETIMEDOUT: 'no answer in time',
    CERT_HAS_EXPIRED: 'its certificate has expired',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate is self-signed, which the apps don\'t accept',
    SELF_SIGNED_CERT_IN_CHAIN: 'its certificate is self-signed, which the apps don\'t accept',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its certificate can\'t be verified (a missing intermediate certificate?)',
    ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is for another name',
    EPROTO: 'it doesn\'t speak https on that port',
  };
  return known[code] || (err && err.message) || String(err);
}

/** The certificate the server shows: { authorized, error, validTo, daysLeft, issuer }. */
function certificateOf(host, port, ca, lookup) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ca, lookup, timeout: TIMEOUT }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert && cert.valid_to ? new Date(cert.valid_to) : null;
      resolve({
        authorized: socket.authorized,
        error: socket.authorizationError,
        validTo,
        daysLeft: validTo ? Math.floor((validTo - Date.now()) / 86400000) : null,
        issuer: cert && cert.issuer ? cert.issuer.O || cert.issuer.CN || '' : '',
      });
      socket.end();
    });
    socket.on('timeout', () => socket.destroy(Object.assign(new Error('No answer in time.'), { code: 'TIMEOUT' })));
    socket.on('error', reject);
  });
}

/** A dns.lookup that always answers `ip`: the name kept, the machine chosen. */
function lookupAs(ip) {
  const family = net.isIP(ip);
  return (host, options, cb) => {
    const done = typeof options === 'function' ? options : cb;
    if (options && options.all) done(null, [{ address: ip, family }]);
    else done(null, ip, family);
  };
}

/**
 * Checks the server at `address`. opts: { password, directPort (the Flow
 * port that should be closed; null: not tried), connectTo (an IP to connect
 * to instead of what the name says, keeping the name for the certificate:
 * install.sh checks the machine it runs on, past a router that can't reach
 * its own public address), ca, report, timeout, and for the tests plainPort
 * (where plain http is tried; 80) }. report(result) is called as each check
 * ends; resolves
 * { results, ok } with each result { status: 'ok'|'warn'|'fail'|'skip', text }.
 */
async function runDoctor(address, opts = {}) {
  const lookup = opts.connectTo ? lookupAs(opts.connectTo) : undefined;
  const results = [];
  const add = (status, text) => {
    const r = { status, text };
    results.push(r);
    if (opts.report) opts.report(r);
    return r;
  };
  const done = () => ({ results, ok: !results.some((r) => r.status === 'fail') });
  const ask = (url, more = {}) => request(url, { ca: opts.ca, timeout: opts.timeout, lookup, ...more });

  let base;
  try {
    base = serverBaseUrl(address);
  } catch {
    base = '';
  }
  if (!base) {
    add('fail', `"${address}" is not an address. Give the one the apps use, like https://music.example.com`);
    return done();
  }
  const u = new URL(base);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  const isHttps = u.protocol === 'https:';

  // ---- the address ----
  if (isHttps) add('ok', `${base} is https.`);
  else if (isPrivateIp(host) || isTailscaleAddress(host)) add('warn', `${base} is a home or Tailscale address, where plain http is fine; this checks addresses on the internet.`);
  else add('fail', `${base} is plain http: the password would cross the internet unencrypted. The apps need an https:// address.`);

  let ips = [];
  try {
    ips = (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
    add('ok', `${host} is ${ips.join(', ')}.`);
  } catch (err) {
    add(opts.connectTo ? 'warn' : 'fail', `${host} can't be found: ${why(err)}. Check the name, and that its DNS record points at your public address.`);
    if (!opts.connectTo) return done();
  }
  if (ips.length && ips.every((ip) => isPrivateIp(ip)) && !isTailscaleAddress(host)) {
    add('warn', `${host} points at a home-network address, so it works at home only. For the internet, its DNS record needs your public address.`);
  }

  // ---- the certificate ----
  if (isHttps) {
    try {
      const cert = await certificateOf(host, port, opts.ca, lookup);
      if (!cert.authorized) {
        add('fail', `The certificate is not accepted: ${why({ code: cert.error })}. Caddy gets a valid one by itself once ports 80 and 443 reach it from the internet; with another proxy, get one from Let's Encrypt (certbot).`);
      } else if (cert.daysLeft !== null && cert.daysLeft < 7) {
        add('warn', `The certificate runs out in ${cert.daysLeft} days (${cert.validTo.toDateString()}) and has not been renewed. Is renewal working?`);
      } else {
        add('ok', `The certificate is valid${cert.issuer ? ` (${cert.issuer})` : ''}, until ${cert.validTo ? cert.validTo.toDateString() : '?'}.`);
      }
    } catch (err) {
      const hint = opts.connectTo
        ? ` Does the web server on ${opts.connectTo} serve https for ${host} on port ${port}?`
        : port === 443 ? ' Is port 443 forwarded on the router to the server?' : '';
      add('fail', `No https connection to ${host}:${port}${opts.connectTo ? ` at ${opts.connectTo}` : ''}: ${why(err)}.${hint}`);
      return done();
    }
  }

  // ---- the server behind it ----
  let hello;
  try {
    const res = await ask(`${base}/api/hello`);
    hello = json(res);
    if (res.status === 403 && hello && hello.error) {
      add('fail', `The Flow Server refuses: ${hello.error}`);
      return done();
    }
    if (res.status !== 200 || !hello || hello.app !== 'flow-server') {
      add('fail', `Something answers at ${base}, but not a Flow Server (${res.status}). Does the proxy pass ${u.pathname === '/' ? 'everything' : u.pathname} on to the Flow Server's port (${DEFAULT_PORT} by default)?`);
      return done();
    }
    add('ok', `The Flow Server "${hello.name}" answers (version ${hello.version}).`);
  } catch (err) {
    add('fail', `No answer from ${base}/api/hello: ${why(err)}.`);
    return done();
  }
  if (!hello.password) add('fail', 'The server has no password. From the internet it lets no one in without one: flow-server set-password --level 3');

  let check = null;
  try {
    const res = await ask(`${base}/api/check`);
    check = res.status === 200 ? json(res) : null;
  } catch {
    check = null;
  }
  if (!check) {
    add('warn', 'The server is too old to say what it sees of the proxy: update it (git pull, then restart).');
  } else {
    if (!check.proxied) {
      add(isHttps ? 'fail' : 'warn', 'The server can\'t tell who is calling: nothing in front passes on the caller\'s address. So everyone shares the waits after wrong passwords, and the server doesn\'t know it is reachable from outside. The proxy has to add X-Forwarded-For (Caddy does by itself; nginx: proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;).');
    } else if (!check.trusted) {
      add('fail', 'A proxy passes the requests on, but the server doesn\'t trust it, so it doesn\'t believe who it says is calling. Its address is in the server\'s log; trust it with flow-server --trusted-proxy <address>.');
    } else {
      const inside = isPrivateIp(check.ip);
      add('ok', `The proxy passes on who is calling: the server sees this machine as ${check.ip}${inside ? ', on your home network. Run this again from outside (a phone\'s hotspot) for the outside view' : ''}.`);
    }
    if (check.proxied && isHttps) {
      if (check.proto === 'https') add('ok', 'The proxy tells the server the caller used https.');
      else if (!check.proto) add('warn', 'The proxy doesn\'t say whether the caller used https, so the server can\'t refuse plain http coming through it. It should add X-Forwarded-Proto (Caddy does by itself; nginx: proxy_set_header X-Forwarded-Proto $scheme;).');
    }
    if (check.locked) add('fail', check.locked);
  }

  // ---- plain http next to it ----
  if (isHttps) {
    const plainHost = u.host.replace(/:\d+$/, '');
    const plain = `http://${plainHost}${opts.plainPort ? `:${opts.plainPort}` : ''}${u.pathname.replace(/\/+$/, '')}/api/hello`;
    try {
      const res = await ask(plain, { timeout: 5000 });
      const location = String(res.headers.location || '');
      const body = json(res);
      if (res.status >= 300 && res.status < 400 && /^https:/i.test(location)) add('ok', 'Plain http is sent on to https.');
      else if (body && body.app === 'flow-server') add('fail', `The Flow Server answers over plain http too (${plain}), where the password travels unencrypted. Have the proxy send http on to https.`);
      else add('ok', `Plain http doesn't reach the Flow Server (${res.status}).`);
    } catch {
      add('ok', 'Plain http is closed.');
    }
  }
  const directPort = opts.directPort === undefined ? DEFAULT_PORT : opts.directPort;
  // Not from the machine itself (connectTo), where the port is open to the home network anyway.
  if (directPort && directPort !== port && !isPrivateIp(host) && !opts.connectTo) {
    try {
      const res = await ask(`http://${host}:${directPort}/api/hello`, { timeout: 5000 });
      add('warn', `Port ${directPort} answers from here (${res.status}). The Flow Server won't serve the internet on it, but it shouldn't be open: if this machine is outside your home network, remove that port forwarding from the router.`);
    } catch {
      add('ok', `Port ${directPort} is closed from here, as it should be: everything goes through https.`);
    }
  }

  // ---- uploads: big, and passed on as they come ----
  const meta = encodeURIComponent(JSON.stringify({ format: 'doctor-check' }));
  try {
    const res = await ask(`${base}/api/songs/doctor-check?meta=${meta}`, {
      method: 'PUT', holdBody: true, timeout: 15000, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(BIG_UPLOAD) },
    });
    const body = json(res);
    if (body && body.error && [401, 403, 415].includes(res.status)) add('ok', 'Large uploads get through to the server (new songs from the apps).');
    else if (res.status === 413) add('fail', 'The proxy refuses large uploads, so songs downloaded in the apps can\'t be moved to the server. Allow 2 GB (nginx: client_max_body_size 2g;).');
    else add('warn', `An upload got an odd answer (${res.status}).`);
  } catch (err) {
    if (err.code === 'TIMEOUT') add('warn', 'The proxy seems to hold uploads until they have fully arrived before passing them on. They still work, but take longer and fill its disk for a while (nginx: proxy_request_buffering off;).');
    else add('warn', `An upload could not be tried: ${why(err)}.`);
  }

  // ---- signed in: the library and seeking in a song ----
  if (!opts.password) {
    add('skip', 'Not signed in, so the library and seeking weren\'t tried. Give the password for those.');
    return done();
  }
  let token;
  try {
    const res = await ask(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: opts.password, device: 'flow-server doctor' }),
    });
    const body = json(res) || {};
    if (res.status !== 200 || !body.token) {
      add('fail', `Signing in did not work: ${body.error || res.status}`);
      return done();
    }
    token = body.token;
    add('ok', 'Signing in works.');
  } catch (err) {
    add('fail', `Signing in did not work: ${why(err)}.`);
    return done();
  }
  let song;
  try {
    const res = await ask(`${base}/api/library`, { headers: { Authorization: `Bearer ${token}` }, timeout: 60000, maxBytes: 256 * 1024 * 1024 });
    const songs = ((json(res) || {}).library || {}).songs || [];
    song = songs[0] || null;
    if (res.status !== 200) add('fail', `The library did not come (${res.status}).`);
    else add('ok', `The library comes through (${songs.length} ${songs.length === 1 ? 'song' : 'songs'}).`);
  } catch (err) {
    add('fail', `The library did not come: ${why(err)}.`);
    return done();
  }
  if (!song) {
    add('skip', 'The library has no songs, so seeking wasn\'t tried.');
    return done();
  }
  try {
    const res = await ask(`${base}/api/songs/${encodeURIComponent(song.id)}/audio?t=${encodeURIComponent(token)}`, { headers: { Range: 'bytes=0-1' } });
    if (res.status === 206 && /^bytes 0-1\//.test(String(res.headers['content-range'] || ''))) add('ok', 'Songs stream, and seeking in them works.');
    else if (res.status === 200) add('fail', 'Songs stream, but the proxy drops the Range header, so seeking doesn\'t work.');
    else add('fail', `A song did not stream (${res.status}).`);
  } catch (err) {
    add('fail', `A song did not stream: ${why(err)}.`);
  }
  return done();
}

module.exports = { runDoctor };
