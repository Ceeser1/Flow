'use strict';

// flow-server doctor against a real server behind a small https proxy of
// the test's own, once set up right and once with the usual mistakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { startServer } = require('../src/server');
const configMod = require('../src/config');
const { runDoctor } = require('../src/doctor');

process.env.FLOW_SERVER_FFMPEG = 'off';

// A self-signed certificate for 127.0.0.1, for these tests only.
const KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-only.key'));
const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-only.crt'));
const PASSWORD = 'Portis8head';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * A Flow Server at level 3 with one song, behind an https proxy. The proxy
 * can make the usual mistakes: noForwarding (no X-Forwarded-For or -Proto),
 * noRange (drops Range), bodyLimit (refuses larger uploads, like nginx's
 * default), buffered (holds every answer back until it is complete, like
 * nginx without proxy_buffering off). plain: 'redirect' (http sent on to https) or 'open' (the Flow
 * Server itself answers plain http).
 */
async function withProxied(fn, {
  noForwarding = false, noRange = false, bodyLimit = 0, plain = 'redirect', buffered = false,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-doctor-test-'));
  const dirs = { home: path.join(root, 'home'), music: path.join(root, 'music') };
  configMod.open(dirs).set({ password: configMod.passwordEntry(PASSWORD), level: 3 });
  const flow = await startServer({ ...dirs, port: 0, host: '127.0.0.1', detectTailscale: async () => null, discoveryPort: null });
  const flowBase = `http://127.0.0.1:${flow.port}`;
  const { token } = await (await fetch(`${flowBase}/api/login`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) })).json();
  const song = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(997, 7)]);
  await fetch(`${flowBase}/api/songs/s1?meta=${encodeURIComponent(JSON.stringify({ title: 'Roads', artist: 'Portishead', format: 'mp3' }))}`, {
    method: 'PUT', body: song, headers: { Authorization: `Bearer ${token}` },
  });

  const proxy = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    if (bodyLimit && Number(req.headers['content-length']) > bodyLimit) {
      res.writeHead(413, { 'Content-Type': 'text/html' });
      res.end('<html><body>413 Request Entity Too Large</body></html>');
      return;
    }
    const headers = { ...req.headers };
    if (!noForwarding) {
      headers['x-forwarded-for'] = req.socket.remoteAddress;
      headers['x-forwarded-proto'] = 'https';
    }
    if (noRange) delete headers.range;
    const up = http.request({ host: '127.0.0.1', port: flow.port, path: req.url, method: req.method, headers }, (r) => {
      if (buffered) {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          res.writeHead(r.statusCode, r.headers);
          res.end(Buffer.concat(chunks));
        });
        return;
      }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    res.on('close', () => up.destroy());
    // Passed on at once, as a proxy streaming uploads does.
    up.flushHeaders();
    req.pipe(up);
  });
  const proxyPort = await listen(proxy);
  const redirect = http.createServer((req, res) => {
    res.writeHead(308, { Location: `https://127.0.0.1:${proxyPort}${req.url}` });
    res.end();
  });
  const plainPort = plain === 'open' ? flow.port : await listen(redirect);

  try {
    await fn({ url: `https://127.0.0.1:${proxyPort}`, plainPort });
  } finally {
    proxy.closeAllConnections();
    await new Promise((r) => proxy.close(r));
    if (redirect.listening) await new Promise((r) => redirect.close(r));
    await flow.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const texts = (results, status) => results.filter((r) => r.status === status).map((r) => r.text);

test('a proxy set up right: all good', async () => {
  await withProxied(async ({ url, plainPort }) => {
    const { results, ok } = await runDoctor(url, { ca: CERT, password: PASSWORD, plainPort, directPort: null });
    assert.deepEqual(texts(results, 'fail'), []);
    assert.equal(ok, true);
    const good = texts(results, 'ok').join('\n');
    for (const want of [/certificate is valid/, /Flow Server ".*" answers/, /passes on who is calling/, /caller used https/,
      /sent on to https/, /Large uploads get through/, /Signing in works/, /live channel passes events on/, /\(1 song\)/, /seeking in them works/]) {
      assert.match(good, want);
    }
    // 127.0.0.1 is no address on the internet, which it says, but that's all.
    assert.deepEqual(texts(results, 'warn').length, 1);
  });
});

test('connecting to this machine instead of where the name leads (install.sh, past the router)', async () => {
  await withProxied(async ({ url, plainPort }) => {
    // A name no DNS knows, for which the certificate is made out.
    const named = url.replace('127.0.0.1', 'music.flow-test.invalid');
    const { results, ok } = await runDoctor(named, { ca: CERT, password: PASSWORD, plainPort, connectTo: '127.0.0.1' });
    assert.deepEqual(texts(results, 'fail'), []);
    assert.equal(ok, true);
    assert.match(texts(results, 'warn').join('\n'), /can't be found/);
    assert.match(texts(results, 'ok').join('\n'), /seeking in them works/);
    assert.doesNotMatch(results.map((r) => r.text).join('\n'), /Port 7878/, 'the Flow port is not tried from the machine itself');
  });
});

test('the usual proxy mistakes are each named', async () => {
  await withProxied(async ({ url, plainPort }) => {
    const { results, ok } = await runDoctor(url, { ca: CERT, password: PASSWORD, plainPort, directPort: null });
    assert.equal(ok, false);
    const fails = texts(results, 'fail').join('\n');
    assert.match(fails, /can't tell who is calling/);
    assert.match(fails, /answers over plain http too/);
    assert.match(fails, /refuses large uploads/);
    assert.match(fails, /drops the Range header/);
  }, { noForwarding: true, noRange: true, bodyLimit: 1024 * 1024, plain: 'open' });
});

test('a proxy that holds answers back: the live channel is named', async () => {
  await withProxied(async ({ url, plainPort }) => {
    const { results } = await runDoctor(url, { ca: CERT, password: PASSWORD, plainPort, directPort: null });
    assert.match(texts(results, 'warn').join('\n'), /holds back the live channel/);
  }, { buffered: true });
});

test('a certificate the apps would not accept, and no password given', async () => {
  await withProxied(async ({ url }) => {
    const { results, ok } = await runDoctor(url, { directPort: null });
    assert.equal(ok, false);
    assert.match(texts(results, 'fail')[0], /self-signed/);
  });
  await withProxied(async ({ url, plainPort }) => {
    const { results } = await runDoctor(url, { ca: CERT, plainPort, directPort: null });
    assert.match(texts(results, 'skip')[0], /Not signed in/);
  });
});

test('an address that is no address, or plain http to the internet', async () => {
  assert.match((await runDoctor('http://')).results[0].text, /not an address/);
  const r = await runDoctor('http://music.invalid', { directPort: null });
  assert.match(r.results[0].text, /plain http: the password would cross the internet unencrypted/);
  assert.match(r.results[1].text, /can't be found/);
});
