#!/usr/bin/env node
'use strict';

// flow-server from the command line. See ../README.md.

const os = require('os');
const readline = require('readline');
const configMod = require('./config');
const { startServer } = require('./server');
const { runDoctor } = require('./doctor');
const tools = require('./tools');
const { LEVEL_NAMES, PUBLIC_LEVEL, parseLevel, passwordProblem } = require('@flow/core/password');

const HELP = `Flow Server: hosts a Flow library and streams it to the Flow apps.

Usage:
  flow-server [options]                 start the server
  flow-server set-password [PASSWORD]      require a password (asked for when left out);
                                        every signed-in device has to enter it again
  flow-server clear-password            let anyone on the network in again (levels 1 and 2 only)
  flow-server devices                   the devices signed in, and to which profile
  flow-server info                      the server's settings, one key=value a line (for install.sh)
  flow-server doctor <address>          check a server from where the apps use it, through
                                        its proxy: https, certificate, uploads, seeking...
                                        Run it from outside your home network too. Asks for
                                        the password (Enter skips; FLOW_SERVER_PASSWORD gives it).
                                        --connect-to <ip> connects there instead, keeping the name
                                        (install.sh: 127.0.0.1, past the router)

Options:
  --port <n>      port to listen on (default ${configMod.DEFAULT_PORT}; remembered)
  --music <dir>   the music folder (default ~/flow-music; remembered)
  --name <text>   the name the apps show for this server (remembered)
  --discovery     answer the apps' search on the local network (UDP ${configMod.DEFAULT_PORT}), so they
                  fill in the address by themselves (remembered)
  --no-discovery  stop answering it (the default)
  --downloads     let the apps have the server download songs (needs yt-dlp and ffmpeg;
                  remembered; install.sh asks)
  --no-downloads  never download songs, even with yt-dlp on the machine
  --level <n>     how far the server can be reached (remembered; install.sh sets it):
                    1 ${LEVEL_NAMES[1]}, 2 ${LEVEL_NAMES[2]},
                    3 ${LEVEL_NAMES[3]}, 4 ${LEVEL_NAMES[4]}
                  From 3 on a password is required: at least 8 characters with a
                  lower-case letter, an upper-case letter and a number.
  --public-url <https://...>   the address the apps use from the internet (levels 3 and 4;
                  remembered); the apps are told it and fill it in
  --trusted-proxy <ip,...>     proxies on other machines whose X-Forwarded-For is believed
                  (remembered; "" for none). One on this machine always is.
  --home <dir>    where the server keeps its library and settings
                  (default ${configMod.defaultHome()})
`;

function parseArgs(argv) {
  const out = { command: 'start', rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      i += 1;
      return argv[i];
    };
    if (a === '--help' || a === '-h') out.command = 'help';
    else if (a === '--port') out.port = Number(value());
    else if (a === '--music') out.music = value();
    else if (a === '--home') out.home = value();
    else if (a === '--name') out.name = value();
    else if (a === '--discovery') out.discovery = true;
    else if (a === '--no-discovery') out.discovery = false;
    else if (a === '--downloads') out.downloads = true;
    else if (a === '--no-downloads') out.downloads = false;
    else if (a === '--level') {
      out.level = parseLevel(value());
      if (!out.level) throw new Error('--level is 1, 2, 3 or 4.');
    } else if (a === '--public-url') {
      out.publicUrl = String(value()).trim().replace(/\/+$/, '');
      if (out.publicUrl && !/^https:\/\/[^\s/?#]+[^\s?#]*$/i.test(out.publicUrl)) throw new Error('--public-url is an https:// address, like https://music.example.com');
    } else if (a === '--trusted-proxy') out.trustedProxies = String(value()).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--connect-to') out.connectTo = value();
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}. See flow-server --help.`);
    else if (out.command === 'start' && !out.rest.length && ['set-password', 'clear-password', 'devices', 'doctor', 'info'].includes(a)) out.command = a;
    else out.rest.push(a);
  }
  return out;
}

/** A line typed at the terminal, not shown while typed. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = rl._writeToOutput.bind(rl);
    let asked = false;
    rl._writeToOutput = (s) => {
      if (!asked) write(s);
      else if (s.includes('\n')) write('\n');
    };
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
    asked = true;
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

async function doctor(address, connectTo) {
  if (!address) throw new Error('Which server? flow-server doctor https://music.example.com');
  if (connectTo && !require('net').isIP(connectTo)) throw new Error('--connect-to takes an IP address, like 127.0.0.1');
  let password = process.env.FLOW_SERVER_PASSWORD || '';
  if (!password && process.stdin.isTTY) password = await askHidden('The server\'s password (Enter skips the signed-in checks): ');
  const marks = { ok: '  ok    ', warn: '  WARN  ', fail: '  FAIL  ', skip: '  --    ' };
  console.log(`Checking ${address}\n`);
  if (connectTo) console.log(`(connecting to ${connectTo} rather than where the name leads)`);
  const { results, ok } = await runDoctor(address, { password, connectTo, report: (r) => console.log(`${marks[r.status]}${r.text}`) });
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  console.log('');
  if (ok) console.log(warns ? `Works, with ${warns} ${warns === 1 ? 'thing' : 'things'} to look at.` : 'All good: the apps can use this address.');
  else console.log(`${fails} ${fails === 1 ? 'problem' : 'problems'} to fix before the apps can use this address safely.`);
  process.exitCode = ok ? 0 : 1;
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  // Before the config: the doctor may run on a machine that is no server.
  if (args.command === 'doctor') {
    await doctor(args.rest[0], args.connectTo);
    return;
  }
  const config = configMod.open({ home: args.home, music: args.music });
  const patch = {};
  if (args.port) patch.port = args.port;
  if (args.music) patch.musicDir = config.musicDir;
  if (args.name) patch.name = args.name;
  if (args.discovery !== undefined) patch.discovery = args.discovery;
  if (args.downloads !== undefined) patch.downloads = args.downloads;
  if (args.level) patch.level = args.level;
  if (args.publicUrl !== undefined) patch.publicUrl = args.publicUrl;
  if (args.trustedProxies) patch.trustedProxies = args.trustedProxies;
  const level = args.level || config.get().level;

  if (args.command === 'set-password') {
    let pw = args.rest[0];
    if (!pw) {
      if (level >= PUBLIC_LEVEL) console.log('At least 8 characters, with a lower-case letter, an upper-case letter and a number.');
      pw = await askHidden(level >= PUBLIC_LEVEL ? 'New password: ' : 'New password: ');
      const again = await askHidden('Once more: ');
      if (pw !== again) throw new Error('The two did not match. Nothing was changed.');
    }
    const problem = passwordProblem(pw, level);
    if (problem) throw new Error(`${problem} Nothing was changed.`);
    config.set({ ...patch, password: configMod.passwordEntry(pw), tokens: [] });
    console.log('Password set. Every device has to enter it once.');
    return;
  }
  // The internet: not without a strong password, which set-password (above)
  // can set along with the level.
  if (level >= PUBLIC_LEVEL && args.level && !(config.get().password && config.get().password.strong)) {
    throw new Error(`Level ${level} makes the server reachable from the internet, so it needs a strong password first `
      + '(at least 8 characters with a lower-case letter, an upper-case letter and a number): '
      + `flow-server set-password --level ${level}`);
  }
  if (Object.keys(patch).length) config.set(patch);

  if (args.command === 'clear-password') {
    if (level >= PUBLIC_LEVEL) {
      throw new Error(`This server is at level ${level}, reachable from the internet, so it keeps a password. `
        + 'Set a new one with flow-server set-password, or lower the level first (sh apps/server/install.sh).');
    }
    config.set({ password: null, tokens: [] });
    console.log('No password any more: anyone who can reach the server can use it.');
    return;
  }
  if (args.command === 'info') {
    // For install.sh: one key=value a line.
    const cfg = config.get();
    const password = !cfg.password ? 'none' : cfg.password.strong ? 'strong' : 'pin';
    console.log([`level=${cfg.level || ''}`, `password=${password}`, `port=${cfg.port}`, `public_url=${cfg.publicUrl}`,
      `trusted_proxies=${cfg.trustedProxies.join(',')}`, `discovery=${cfg.discovery ? 1 : 0}`, `music=${config.musicDir}`, `home=${config.home}`,
      `downloads=${cfg.downloads === null ? '' : (cfg.downloads ? 1 : 0)}`, `ytdlp=${tools.ytdlp() || ''}`].join('\n'));
    return;
  }
  if (args.command === 'devices') {
    const { tokens, profiles } = config.get();
    if (!tokens.length) console.log('No devices signed in.');
    for (const t of tokens) {
      const p = profiles.find((x) => x.id === t.profileId);
      console.log(`${t.device}${p ? ` as ${p.name}` : ''}  (signed in ${new Date(t.createdAt).toLocaleString()}, last seen ${t.lastSeenAt ? new Date(t.lastSeenAt).toLocaleString() : 'never'})`);
    }
    return;
  }

  const log = (text) => console.log(`${stamp()}  ${text}`);
  const server = await startServer({ home: args.home, music: args.music, log });
  const cfg = server.config.get();
  console.log(`Flow Server "${cfg.name}" is running.`);
  console.log(`  Music:    ${server.library.musicDir} (${server.library.data.songs.length} songs)`);
  console.log(`  Library:  ${server.config.home}`);
  console.log(cfg.level
    ? `  Level:    ${cfg.level}, ${LEVEL_NAMES[cfg.level]}${cfg.level >= PUBLIC_LEVEL && cfg.publicUrl ? ` at ${cfg.publicUrl}` : ''}`
    : '  Level:    not chosen (install.sh asks, or --level)');
  console.log(`  Password: ${cfg.password ? 'yes' : 'none (flow-server set-password to add one)'}`);
  if (cfg.level >= PUBLIC_LEVEL && !(cfg.password && cfg.password.strong)) {
    console.log(`  WARNING:  reachable from the internet without a strong password, so it lets no one in. Set one: flow-server set-password`);
  }
  console.log(`  ffmpeg:   ${tools.ffmpeg() ? 'found' : 'not found (optional: song lengths, tags and loudness for songs added by hand; needed for downloads)'}`);
  if (cfg.downloads === false) console.log('  Downloads: off (flow-server --downloads, or install.sh, turns them on)');
  else if (!tools.ytdlp()) console.log('  yt-dlp:   not found (optional: the server downloads songs itself; install.sh offers it)');
  else if (!tools.canDownload()) console.log('  yt-dlp:   found, but downloads also need ffmpeg');
  else {
    console.log('  yt-dlp:   found, the apps can let the server download songs (Download (Server))');
    if (!tools.jsRuntime()) {
      console.log(`  WARNING:  YouTube downloads need Deno, or Node.js 22 or newer (this is ${process.version}). install.sh offers Deno.`);
    }
  }
  const addrs = lanAddresses();
  console.log(`  Enter in Flow's settings: ${(addrs.length ? addrs : ['localhost']).map((a) => `${a}:${server.port}`).join('  or  ')}`);
  if (server.discovery()) console.log(`  Discovery: on, apps on this network find the server by themselves (UDP ${server.discovery().port})`);
  else console.log(`  Discovery: off${cfg.discovery ? ' (the UDP port is taken)' : ' (flow-server --discovery lets apps on the network find it)'}; the address is typed into Flow`);
  const ts = server.tailscale();
  if (ts) {
    console.log(`  Away from home (Tailscale): ${ts.ip}:${server.port}${ts.dns ? ` (${ts.dns})` : ''}, which Flow fills into its Remote field by itself`);
  } else {
    console.log('  Tailscale: not running (to reach the server away from home; see the README)');
  }

  const stop = async () => {
    log('Stopping.');
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => {
  if (err && err.code === 'EADDRINUSE') console.error(`Port ${err.port} is in use. Is the Flow Server already running? (--port picks another)`);
  else console.error(err && err.message ? err.message : err);
  process.exit(1);
});
