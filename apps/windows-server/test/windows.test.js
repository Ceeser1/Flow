'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const win = require('../src/windows');

test('the server is found in the repo next door', () => {
  assert.ok(fs.existsSync(win.MAIN), win.MAIN);
  assert.match(win.MAIN, /linux-server[\\/]src[\\/]main\.js$/);
  assert.strictEqual(typeof win.serverModule('config').defaultHome, 'function');
});

test('the task runs run.js at boot as the user, without a password, with no time limit', () => {
  const text = win.taskXml({
    sid: 'S-1-5-21-1-2-3-1001', node: 'C:\\Program Files\\Flow Server\\node.exe', script: 'C:\\Program Files\\Flow Server\\app\\windows\\run.js',
    home: 'C:\\Users\\A & B\\AppData\\Local\\Flow\\server', workDir: 'C:\\Program Files\\Flow Server\\app\\windows',
  });
  assert.match(text, /<UserId>S-1-5-21-1-2-3-1001<\/UserId>/);
  assert.match(text, /<LogonType>S4U<\/LogonType>/);
  assert.match(text, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(text, /<BootTrigger>/);
  assert.match(text, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(text, /<DisallowStartIfOnBatteries>false</);
  assert.match(text, /\(A;;FA;;;S-1-5-21-1-2-3-1001\)/);
  assert.match(text, /<Command>C:\\Program Files\\Flow Server\\node.exe<\/Command>/);
  // Quoted paths, escaped for XML.
  assert.match(text, /<Arguments>&quot;C:\\Program Files\\Flow Server\\app\\windows\\run.js&quot; --home &quot;C:\\Users\\A &amp; B\\AppData\\Local\\Flow\\server&quot;<\/Arguments>/);
  const bytes = win.utf16(text);
  assert.deepStrictEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
  assert.ok(bytes.subarray(2).toString('utf16le').includes('\r\n<Task '));
});

test('firewall: the home network always, Tailscale at level 2, a proxy on the internet at level 4', () => {
  const program = 'C:\\Program Files\\Flow Server\\node.exe';
  const remote = (rule) => rule.find((a) => a.startsWith('remoteip=')).slice(9);
  let rules = win.firewallRules({ level: 1, port: 7878, discovery: false, program, tailscale: true });
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(remote(rules[0]), 'LocalSubnet');
  assert.ok(rules[0].includes(`program=${program}`));
  assert.ok(rules[0].includes('protocol=TCP') && rules[0].includes('localport=7878') && rules[0].includes('name=Flow Server'));

  rules = win.firewallRules({ level: 2, port: 8000, discovery: true, program });
  assert.strictEqual(remote(rules[0]), `LocalSubnet,${win.TAILNET}`);
  assert.ok(rules[1].includes('protocol=UDP') && rules[1].includes('localport=7878') && rules[1].includes(`name=${win.RULE_UDP}`));
  assert.strictEqual(remote(rules[1]), 'LocalSubnet');

  assert.strictEqual(remote(win.firewallRules({ level: 4, port: 7878, program, proxyAt: '203.0.113.9' })[0]), 'LocalSubnet,203.0.113.9');
  assert.strictEqual(remote(win.firewallRules({ level: 4, port: 7878, program, proxyAt: '192.168.1.20' })[0]), 'LocalSubnet');
  assert.strictEqual(remote(win.firewallRules({ level: 4, port: 7878, program, tailscale: true })[0]), `LocalSubnet,${win.TAILNET}`);
});

test('the options, as install.sh has them; level 3 is for Linux', () => {
  const o = win.parseArgs(['--level', '4', '--url', 'https://music.example.com', '--proxy', 'caddy', '--proxy-at', '10.0.0.5', '--yes', '--no-discovery', '--downloads', '--keep-folders', '--port', '8080']);
  assert.strictEqual(o.command, 'setup');
  assert.strictEqual(o.level, 4);
  assert.strictEqual(o.proxy, 'caddy');
  assert.strictEqual(o.proxyAt, '10.0.0.5');
  assert.strictEqual(o.port, 8080);
  assert.strictEqual(o.yes, true);
  assert.strictEqual(o.discovery, false);
  assert.strictEqual(o.downloads, true);
  assert.strictEqual(o.separate, 'ask');
  assert.strictEqual(o.keep, true);
  assert.strictEqual(win.parseArgs(['stop', '--pause']).command, 'stop');
  assert.strictEqual(win.parseArgs(['--uninstall']).command, 'uninstall');
  assert.strictEqual(win.parseArgs(['--from-installer', '--only-update']).onlyUpdate, true);
  assert.strictEqual(win.parseArgs([]).onlyUpdate, false);
  assert.throws(() => win.parseArgs(['--level', '3']), /Linux/);
  assert.throws(() => win.parseArgs(['--level', '5']), /1, 2 or 4/);
  assert.throws(() => win.parseArgs(['--proxy', 'iis']), /nginx/);
  assert.throws(() => win.parseArgs(['--proxy-at', 'proxy.lan']), /IPv4/);
  assert.throws(() => win.parseArgs(['--port', '0']), /port/);
  assert.throws(() => win.parseArgs(['--colour']), /Unknown option/);
});

test('flow-server info and command lines', () => {
  assert.deepStrictEqual(win.parseInfo('level=2\r\npassword=none\npublic_url=\nmusic=C:\\a=b\n'), {
    level: '2', password: 'none', public_url: '', music: 'C:\\a=b',
  });
  assert.strictEqual(win.winArg('plain'), 'plain');
  assert.strictEqual(win.winArg('C:\\Program Files\\x.js'), '"C:\\Program Files\\x.js"');
  assert.strictEqual(win.winArg('C:\\with space\\'), '"C:\\with space\\\\"');
  assert.strictEqual(win.winArg('say "hi"'), '"say \\"hi\\""');
  assert.strictEqual(win.winArg(''), '""');
  assert.strictEqual(win.psQuote("it's"), "'it''s'");
});

test('level 4 snippets point at the server, with a path when the address has one', () => {
  const nginx = win.proxySnippet({ proxy: 'nginx', url: 'https://example.com/flow', upstream: '127.0.0.1', port: 7878 }).join('\n');
  assert.match(nginx, /location \/flow\/ \{/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:7878\/;/);
  const caddy = win.proxySnippet({ proxy: 'caddy', url: 'https://music.example.com', upstream: '192.168.1.5', port: 8000 }).join('\n');
  assert.match(caddy, /music\.example\.com \{\n {8}reverse_proxy 192\.168\.1\.5:8000/);
  const tunnel = win.proxySnippet({ proxy: 'cloudflared', url: 'https://music.example.com', upstream: '127.0.0.1', port: 7878 }).join('\n');
  assert.match(tunnel, /hostname: music\.example\.com\n {8}service: http:\/\/127\.0\.0\.1:7878/);
  assert.match(win.proxySnippet({ proxy: 'other', url: 'https://e.com/f', upstream: '127.0.0.1', port: 1 }).join('\n'), /pass \/f\/ on to http:\/\/127\.0\.0\.1:1 \(without \/f\)/);
  for (const url of ['https://music.example.com', 'https://example.com/flow', 'https://a.duckdns.org:8443']) assert.ok(win.URL_OK.test(url), url);
  for (const url of ['http://music.example.com', 'https://localhost', 'music.example.com']) assert.ok(!win.URL_OK.test(url), url);
});

test('PATH finds node.exe, ffmpeg and yt-dlp first; the log starts again past its size', () => {
  const home = path.join(os.tmpdir(), `flow-win-${process.pid}`);
  const env = win.withTools({ Path: 'C:\\Windows' }, home);
  const dirs = env.Path.split(path.delimiter);
  assert.deepStrictEqual(dirs.slice(-1), ['C:\\Windows']);
  assert.ok(dirs.includes(path.join(home, 'tools')));
  assert.ok(dirs.includes(path.join(win.INSTALL_DIR, 'tools')));
  assert.strictEqual(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').length, 1);

  fs.mkdirSync(home, { recursive: true });
  const log = win.logFile(home);
  fs.writeFileSync(log, 'x'.repeat(50));
  win.rotateLog(log, 100);
  assert.ok(fs.existsSync(log));
  win.rotateLog(log, 10);
  assert.ok(!fs.existsSync(log));
  assert.strictEqual(fs.readFileSync(path.join(home, 'flow-server.old.log'), 'utf8').length, 50);
  fs.rmSync(home, { recursive: true, force: true });
});
