'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const http = require('http');
const {
  openStream, relay, IcyReader, Dechunk, parseIcyMeta, cleanTitle, decodeText, isOwnAddress,
} = require('../src/radioStream');

/** A station on a plain socket: `answer(request text, socket)` writes what it sends. */
async function station(answer) {
  const server = net.createServer((s) => {
    let got = '';
    s.on('data', (c) => {
      got += c.toString('latin1');
      if (got.includes('\r\n\r\n')) answer(got, s);
    });
    s.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: (p = '/live') => `http://127.0.0.1:${server.address().port}${p}` };
}

/** ICY metadata block for a title, padded to 16 bytes as stations send it. */
function metaBlock(text) {
  const body = Buffer.from(text, 'utf8');
  const len = Math.ceil(body.length / 16);
  return Buffer.concat([Buffer.from([len]), body, Buffer.alloc(len * 16 - body.length)]);
}

/** Sound with metadata every `every` bytes: `parts` of [sound bytes, title or null]. */
function icyStream(every, parts) {
  const out = [];
  for (const [sound, title] of parts) {
    assert.equal(sound.length, every);
    out.push(sound, title === null ? Buffer.from([0]) : metaBlock(`StreamTitle='${title}';StreamUrl='';`));
  }
  return Buffer.concat(out);
}

/** Runs relay() behind a local http server and reads what a player would get. */
async function playThrough(url, { ms = 300, refuse = null } = {}) {
  const infos = [];
  const server = http.createServer((req, res) => {
    relay(url, res, { onInfo: (i) => infos.push(i), refuse }).catch((err) => {
      res.writeHead(err.status || 502, { 'Content-Type': 'text/plain' });
      res.end(err.message);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const got = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      res.on('end', done);
      setTimeout(() => {
        res.destroy();
        done();
      }, ms);
    }).on('error', reject);
  });
  server.close();
  return { ...got, infos };
}

test('ICY metadata: the title, also with a quote inside, UTF-8 or Latin-1', () => {
  assert.equal(parseIcyMeta(Buffer.from("StreamTitle='Guns N' Roses - Patience';StreamUrl='http://x';")), "Guns N' Roses - Patience");
  assert.equal(parseIcyMeta(Buffer.from("StreamTitle='Beyoncé - Halo';\0\0\0")), 'Beyoncé - Halo');
  assert.equal(parseIcyMeta(Buffer.from("StreamTitle='Motörhead - Ace';", 'latin1')), 'Motörhead - Ace');
  assert.equal(parseIcyMeta(Buffer.from("StreamUrl='x';")), null);
  assert.equal(parseIcyMeta(Buffer.from("StreamTitle='';")), '');
  assert.equal(cleanTitle(' - '), '');
  assert.equal(cleanTitle('  A   -  B '), 'A - B');
  assert.equal(decodeText(Buffer.from([0x80])), '€');
});

test('the reader takes the metadata out of the sound, in pieces of any size', async () => {
  const every = 8;
  const sound = [Buffer.from('AAAAAAAA'), Buffer.from('BBBBBBBB'), Buffer.from('CCCCCCCC'), Buffer.from('DDDDDDDD')];
  const raw = icyStream(every, [[sound[0], 'One - First'], [sound[1], null], [sound[2], 'One - First'], [sound[3], 'Two - Second']]);
  for (const size of [1, 3, 7, raw.length]) {
    const titles = [];
    const reader = new IcyReader(every, (t) => titles.push(t));
    const out = [];
    reader.on('data', (c) => out.push(c));
    for (let i = 0; i < raw.length; i += size) reader.write(raw.slice(i, i + size));
    reader.end();
    await new Promise((r) => reader.on('end', r));
    assert.equal(Buffer.concat(out).toString(), 'AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDD', `pieces of ${size}`);
    assert.deepEqual(titles, ['One - First', 'Two - Second'], `pieces of ${size}`);
  }
});

test('chunked answers are undone', async () => {
  const d = new Dechunk();
  const out = [];
  d.on('data', (c) => out.push(c));
  const raw = Buffer.from('5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n');
  for (let i = 0; i < raw.length; i += 4) d.write(raw.slice(i, i + 4));
  d.end();
  await new Promise((r) => d.on('end', r));
  assert.equal(Buffer.concat(out).toString(), 'hello world');
});

test('a Shoutcast "ICY 200 OK" station: the sound without its metadata, the titles told', async () => {
  const every = 16;
  const parts = [[Buffer.alloc(16, 1), 'Artist - Song'], [Buffer.alloc(16, 2), null], [Buffer.alloc(16, 3), 'Next - One']];
  let asked = '';
  const st = await station((req, s) => {
    asked = req;
    s.write(`ICY 200 OK\r\nicy-name: Test FM\r\nicy-metaint: ${every}\r\ncontent-type: audio/mpeg\r\n\r\n`);
    s.write(icyStream(every, parts));
    setTimeout(() => s.end(), 50);
  });
  const got = await playThrough(st.url());
  st.server.close();
  assert.match(asked, /^GET \/live HTTP\/1\.1\r\n/);
  assert.match(asked, /Icy-MetaData: 1/);
  assert.equal(got.status, 200);
  assert.equal(got.headers['content-type'], 'audio/mpeg');
  assert.equal(got.headers['access-control-allow-origin'], '*');
  assert.deepEqual([...got.body], [...Buffer.alloc(16, 1), ...Buffer.alloc(16, 2), ...Buffer.alloc(16, 3)]);
  assert.deepEqual(got.infos.map((i) => [i.meta, i.title]), [[true, ''], [true, 'Artist - Song'], [true, 'Next - One']]);
  assert.equal(got.infos[0].name, 'Test FM');
});

test('a station without metadata: the sound as it is, no song info', async () => {
  const st = await station((req, s) => {
    s.write('HTTP/1.0 200 OK\r\nContent-Type: audio/aacp\r\n\r\nsound-bytes');
    setTimeout(() => s.end(), 30);
  });
  const got = await playThrough(st.url());
  st.server.close();
  assert.equal(got.body.toString(), 'sound-bytes');
  assert.equal(got.headers['content-type'], 'audio/aacp');
  assert.deepEqual(got.infos.map((i) => i.meta), [false]);
});

test('redirects (to another path), a chunked answer and a .pls file are followed', async () => {
  const st = await station((req, s) => {
    const path = /^GET (\S+)/.exec(req)[1];
    if (path === '/old') s.end('HTTP/1.1 302 Found\r\nLocation: /list.pls\r\nContent-Length: 0\r\n\r\n');
    else if (path === '/list.pls') s.end(`HTTP/1.1 200 OK\r\nContent-Type: audio/x-scpls\r\n\r\n[playlist]\nFile1=${st.url('/stream')}\n`);
    else {
      s.write('HTTP/1.1 200 OK\r\nContent-Type: audio/mpeg\r\nTransfer-Encoding: chunked\r\n\r\n');
      s.write('4\r\nabcd\r\n3\r\nefg\r\n');
      setTimeout(() => s.end('0\r\n\r\n'), 30);
    }
  });
  const got = await playThrough(st.url('/old'));
  st.server.close();
  assert.equal(got.status, 200);
  assert.equal(got.body.toString(), 'abcdefg');
});

test('no stream there: a web page, an error, HLS, or an address not to be asked', async () => {
  const st = await station((req, s) => {
    const path = /^GET (\S+)/.exec(req)[1];
    if (path === '/page') s.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<html></html>');
    else if (path === '/hls.m3u8') s.end('HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\n\r\n#EXTM3U\n#EXT-X-TARGETDURATION:6\n');
    else s.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
  });
  assert.equal((await playThrough(st.url('/page'))).status, 415);
  assert.equal((await playThrough(st.url('/hls.m3u8'))).status, 415);
  assert.equal((await playThrough(st.url('/gone'))).status, 404);
  // A server's relay never asks the machine it runs on.
  assert.equal((await playThrough(st.url('/page'), { refuse: isOwnAddress })).status, 403);
  st.server.close();
  await assert.rejects(openStream('ftp://x'), (e) => e.status === 400);
});

test('own addresses: loopback and link-local only', () => {
  for (const ip of ['127.0.0.1', '127.8.9.1', '::1', '::ffff:127.0.0.1', '169.254.1.1', 'fe80::1', '0.0.0.0']) assert.ok(isOwnAddress(ip), ip);
  for (const ip of ['192.168.0.61', '10.0.0.2', '8.8.8.8', '2a00:1450::1']) assert.ok(!isOwnAddress(ip), ip);
});
