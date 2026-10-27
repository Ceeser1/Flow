'use strict';

// setup.js from start to end, with Windows' own commands stood in for
// (FLOW_SERVER_SETUP_FAKE): the server really runs, through run.js, on a free
// port, from a home and music folder of its own.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const SETUP = path.join(__dirname, '..', 'src', 'setup.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function hello(port) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout: 2000, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', () => resolve(null));
  });
}

test('setup, stop, start, another level and uninstall', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-winsetup-'));
  const home = path.join(dir, 'home');
  const fake = path.join(dir, 'fake');
  const music = path.join(dir, 'music');
  const port = await freePort();
  const env = { ...process.env, FLOW_SERVER_HOME: home, FLOW_SERVER_SETUP_FAKE: fake, FLOW_SERVER_FFMPEG: 'off', FLOW_SERVER_YTDLP: 'off' };
  delete env.FLOW_SERVER_PASSWORD;
  const setup = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [SETUP, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input: '' });
    assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const commands = () => fs.readFileSync(path.join(fake, 'commands.txt'), 'utf8');
  const log = () => { try { return fs.readFileSync(path.join(home, 'flow-server.log'), 'utf8'); } catch { return '(no log)'; } };
  const up = async () => {
    const h = await hello(port);
    assert.ok(h, `the server does not answer:
${log()}`);
    return h;
  };
  const config = () => JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
  try {
    let out = setup(['--yes', '--level', '2', '--port', String(port), '--music', music, '--no-discovery', '--separate-folders']);
    assert.match(out, /Running at level 2/);
    assert.ok((await up()).id);
    assert.match(fs.readFileSync(path.join(fake, 'task.xml')).toString('utf16le'), /<LogonType>S4U<\/LogonType>/);
    assert.match(commands(), /add rule name=Flow Server .*localport=\d+ remoteip=LocalSubnet,100\.64\.0\.0\/10 /);
    assert.doesNotMatch(commands(), /add rule name=Flow Server \(discovery\)/);
    assert.strictEqual(config().level, 2);
    assert.strictEqual(config().separateFolders, true);
    assert.strictEqual(config().musicDir, music);

    out = setup(['stop']);
    assert.match(out, /stopped/);
    assert.strictEqual(await hello(port), null);
    assert.match(fs.readFileSync(path.join(home, 'flow-server.log'), 'utf8'), /Stopping\.\s+\S+\s+The server stopped\./);
    setup(['start']);
    await up();

    // Level 4 behind a proxy on the internet: a strong password, the address, the proxy let in.
    fs.writeFileSync(path.join(fake, 'commands.txt'), '');
    out = setup(['--yes', '--level', '4', '--url', 'https://music.example.com', '--proxy', 'caddy', '--proxy-at', '203.0.113.9', '--discovery'],
      { FLOW_SERVER_PASSWORD: 'Strong-Pass1' });
    assert.match(out, /music\.example\.com \{/);
    assert.strictEqual(config().level, 4);
    assert.strictEqual(config().publicUrl, 'https://music.example.com');
    assert.deepStrictEqual(config().trustedProxies, ['203.0.113.9']);
    assert.strictEqual(config().password.strong, true);
    assert.strictEqual(config().separateFolders, true, 'kept from before');
    // (and the tailnet, on a PC with Tailscale)
    assert.match(commands(), /remoteip=LocalSubnet,(100\.64\.0\.0\/10,)?203\.0\.113\.9 /);
    assert.match(commands(), /add rule name=Flow Server \(discovery\) .*protocol=UDP localport=7878 remoteip=LocalSubnet /);
    assert.strictEqual((await up()).password, true);

    // The installer's Only update: everything as it was, the proxy elsewhere too.
    out = setup(['--from-installer', '--only-update']);
    assert.match(out, /Only update: everything stays/);
    assert.strictEqual(config().level, 4);
    assert.strictEqual(config().publicUrl, 'https://music.example.com');
    assert.deepStrictEqual(config().trustedProxies, ['203.0.113.9']);
    assert.strictEqual(config().discovery, true);
    await up();

    // Back to 1: no internet address, no proxy.
    setup(['--yes', '--level', '1']);
    assert.strictEqual(config().publicUrl, '');
    assert.deepStrictEqual(config().trustedProxies, []);
    assert.strictEqual(config().discovery, true, 'kept from before');

    // Another music folder: --yes alone leaves the old one's songs where they are, --move-music brings them along.
    const put = (file) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'audio');
    };
    put(path.join(music, 'Uploads', 'Portishead - Roads.mp3'));
    const music2 = path.join(dir, 'music 2');
    out = setup(['--yes', '--music', music2]);
    assert.match(out, /stay there and still play from there/);
    assert.match(out, /flow-server move-music "/);
    assert.ok(fs.existsSync(path.join(music, 'Uploads', 'Portishead - Roads.mp3')));
    assert.strictEqual(config().musicDir, music2);
    put(path.join(music2, 'Downloads', 'Moby - Porcelain.mp3'));
    const music3 = path.join(dir, 'music 3');
    out = setup(['--yes', '--music', music3, '--move-music']);
    assert.match(out, /== Moving the music/);
    assert.match(out, /Moved 1 file/);
    assert.ok(fs.existsSync(path.join(music3, 'Downloads', 'Moby - Porcelain.mp3')));
    assert.ok(!fs.existsSync(music2), 'the old folder, empty, is gone');
    assert.strictEqual(config().musicDir, music3);
    await up();

    out = setup(['--uninstall']);
    assert.match(out, /removed/);
    assert.strictEqual(await hello(port), null);
    assert.ok(!fs.existsSync(path.join(fake, 'task.xml')));
    assert.match(commands(), /delete rule name=Flow Server\n/);
    assert.ok(fs.existsSync(path.join(home, 'server.json')), 'the library stays');
  } finally {
    spawnSync(process.execPath, [SETUP, 'stop'], { env, input: '' });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
