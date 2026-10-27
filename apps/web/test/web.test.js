'use strict';

// The web player: what the browser keeps (and does not), the page's memory
// files, the device name, the built folder, and that window.flow answers the
// desktop's calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStorage, PREFIX } = require('../src/storage');
const { createMemFs } = require('../src/memfs');
const { deviceName } = require('../src/env');
const { build } = require('../scripts/build');

/** A stand-in for localStorage / sessionStorage. */
function fakeStore() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
  };
}

test('settings and sign-in survive a reload, the library only lives in memory', () => {
  const local = fakeStore();
  const session = fakeStore();
  const a = createStorage({ local, session });
  a.writeJson('settings.json', { serverHome: 'https://music.example.com' });
  a.writeJson('server-sync.json', { serverId: 'abc' });
  a.writeJson('server-library.json', { songs: [{ id: 's1' }] });
  assert.deepEqual([...local.m.keys()].sort(), [`${PREFIX}server-sync.json`, `${PREFIX}settings.json`]);

  // A reload: a new page with the same browser storage.
  const b = createStorage({ local, session });
  assert.equal(b.readJson('settings.json').serverHome, 'https://music.example.com');
  assert.equal(b.readJson('server-sync.json').serverId, 'abc');
  assert.equal(b.readJson('server-library.json'), null);
});

test('passwords and tokens stay in the browser session, never in localStorage', () => {
  const local = fakeStore();
  const session = fakeStore();
  const a = createStorage({ local, session });
  const kept = a.secrets.encrypt('Webtest123');
  assert.match(kept, /^w:[0-9a-f]{18}$/);
  a.writeJson('settings.json', { serverSecret: kept });
  assert.ok(![...local.m.values()].some((v) => v.includes('Webtest123')));
  assert.equal(a.secrets.decrypt(kept), 'Webtest123');

  // A reload in the same browser session finds it again.
  assert.equal(createStorage({ local, session }).secrets.decrypt(kept), 'Webtest123');
  // A new browser session does not: the server asks again.
  const later = createStorage({ local, session: fakeStore() });
  assert.equal(later.secrets.decrypt(kept), '');
  assert.equal(later.hasSecret(kept), false);
  assert.equal(a.secrets.encrypt(''), '');
  assert.equal(a.secrets.decrypt('e:something-else'), '');
});

test('Logout: the server\'s files and every secret go, and nothing is written after', () => {
  const local = fakeStore();
  const session = fakeStore();
  session.setItem('other-site-key', 'x');
  const a = createStorage({ local, session });
  const kept = a.secrets.encrypt('Webtest123');
  a.writeJson('settings.json', { volume: 0.4 });
  a.writeJson('server-sync.json', { serverId: 'abc', token: kept });
  a.forget(['server-sync.json']);
  assert.equal(a.readJson('server-sync.json'), null);
  assert.equal(a.secrets.decrypt(kept), '');
  assert.deepEqual([...session.m.keys()], ['other-site-key']);
  // What the page still saves on its way out does not bring it back.
  a.writeJson('server-sync.json', { serverId: 'abc' });
  assert.equal(createStorage({ local, session }).readJson('server-sync.json'), null);
  assert.equal(createStorage({ local, session }).readJson('settings.json').volume, 0.4);
});

test('a browser that refuses storage still works, from memory', () => {
  const s = createStorage({ local: null, session: null });
  s.writeJson('settings.json', { volume: 0.5 });
  assert.equal(s.readJson('settings.json').volume, 0.5);
  const kept = s.secrets.encrypt('pw');
  assert.equal(s.secrets.decrypt(kept), 'pw');
});

test('memory files: write, list, rename, remove', () => {
  const m = createMemFs();
  m.writeText('/flow/Lyrics/abc/s1.json', '{"a":1}');
  m.writeBytes('/flow/Lyrics/abc/s2.none.json', new Uint8Array([1, 2]));
  assert.deepEqual(m.list('/flow/Lyrics').map((e) => e.name), ['abc']);
  assert.deepEqual(m.list('/flow/Lyrics/abc').map((e) => [e.name, e.size]).sort(), [['s1.json', 7], ['s2.none.json', 2]]);
  assert.equal(m.readText('/flow/Lyrics/abc/s1.json'), '{"a":1}');
  m.rename('/flow/Lyrics/abc/s1.json', '/flow/Lyrics/abc/s3.json');
  assert.equal(m.exists('/flow/Lyrics/abc/s1.json'), false);
  assert.throws(() => m.remove('/flow/Lyrics/abc'), /Not empty/);
  m.remove('/flow/Lyrics', { recursive: true });
  assert.deepEqual(m.list('/flow'), []);
  assert.equal(m.readBytes('/flow/Lyrics/abc/s3.json'), null);
});

test('a session names the browser and its system', () => {
  const win = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
  assert.equal(deviceName(win), 'Chrome - Windows');
  assert.equal(deviceName(`${win} Edg/140.0.0.0`), 'Edge - Windows');
  assert.equal(deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:131.0) Gecko/20100101 Firefox/131.0'), 'Firefox - macOS');
  assert.equal(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari - iOS');
  assert.equal(deviceName('Mozilla/5.0 (Linux; Android 15; SM-A566B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'), 'Chrome - Android');
  assert.equal(deviceName(''), 'Browser');
});

test('the built folder: the window.flow first, every script and style versioned, images beside the page', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-web-'));
  try {
    const { version } = build({ out });
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, new RegExp(`<script src="flow-web\\.js\\?v=${version}"></script>\\s*<script src="app/util\\.js\\?v=${version}"`));
    assert.doesNotMatch(html, /<script src="[^"?]+"/);
    assert.doesNotMatch(html, /<link rel="stylesheet" href="[^"?]+"/);
    assert.match(html, /connect-src 'self' http: https:/);
    assert.match(html, /<meta name="robots" content="noindex" \/>/);
    assert.ok(fs.existsSync(path.join(out, 'images', 'settings.png')));
    assert.ok(fs.existsSync(path.join(out, 'assets', 'icon.png')));
    for (const f of ['index.html', 'app/nav.js', 'app/visualizer.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(out, f), 'utf8'), /\.\.\/images\//, f);
    }
    assert.match(fs.readFileSync(path.join(out, 'app', 'seekCheck.js'), 'utf8'), new RegExp(`seekTap\\.js\\?v=${version}`));
    // The bundle is for a page: no Node module slipped in.
    assert.doesNotMatch(fs.readFileSync(path.join(out, 'flow-web.js'), 'utf8'), /require\("(fs|path|os|crypto|child_process)"\)/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('window.flow answers every call of the desktop\'s, but those a browser cannot have', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'desktop', 'preload.js'), 'utf8');
  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const desktopCalls = new Set([...preload.matchAll(/^ {2}([a-zA-Z]+)\s*:/gm)].map((m) => m[1]));
  const webCalls = new Set([...web.matchAll(/^ {4}([a-zA-Z]+)\s*:/gm)].map((m) => m[1]));
  // Left out on purpose: the window checks for each before using it (yt-dlp's
  // folder, the lyrics editor and lookups, backups, guests of other servers).
  const notInBrowser = new Set(['openToolsFolder', 'toolStatus', 'checkImport', 'lookupInfo', 'setLyrics', 'lookupLyrics', 'searchLyrics', 'publishLyrics', 'backups', 'makeBackup', 'restoreBackup', 'guestLook']);
  const missing = [...desktopCalls].filter((c) => !webCalls.has(c) && !notInBrowser.has(c));
  assert.deepEqual(missing, []);
});
