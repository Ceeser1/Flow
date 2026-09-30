#!/usr/bin/env node
'use strict';

// flow-server from the command line. See ../README.md.

const os = require('os');
const readline = require('readline');
const configMod = require('./config');
const { startServer } = require('./server');
const tools = require('./tools');

const HELP = `Flow Server: hosts a Flow library and streams it to the Flow apps.

Usage:
  flow-server [options]                 start the server
  flow-server set-password [PIN]        require a PIN or password (asked for when left out);
                                        every signed-in device has to enter it again
  flow-server clear-password            let anyone on the network in again
  flow-server devices                   the devices signed in, and to which profile

Options:
  --port <n>      port to listen on (default ${configMod.DEFAULT_PORT}; remembered)
  --music <dir>   the music folder (default ~/flow-music; remembered)
  --name <text>   the name the apps show for this server (remembered)
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
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}. See flow-server --help.`);
    else if (out.command === 'start' && !out.rest.length && ['set-password', 'clear-password', 'devices'].includes(a)) out.command = a;
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

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help') {
    process.stdout.write(HELP);
    return;
  }
  const config = configMod.open({ home: args.home, music: args.music });
  const patch = {};
  if (args.port) patch.port = args.port;
  if (args.music) patch.musicDir = config.musicDir;
  if (args.name) patch.name = args.name;
  if (Object.keys(patch).length) config.set(patch);

  if (args.command === 'set-password') {
    let pw = args.rest[0];
    if (!pw) {
      pw = await askHidden('New PIN or password: ');
      const again = await askHidden('Once more: ');
      if (pw !== again) throw new Error('The two did not match. Nothing was changed.');
    }
    if (!String(pw).trim()) throw new Error('The PIN or password cannot be empty.');
    config.set({ password: configMod.hashPassword(pw), tokens: [] });
    console.log('PIN / password set. Every device has to enter it once.');
    return;
  }
  if (args.command === 'clear-password') {
    config.set({ password: null, tokens: [] });
    console.log('No PIN or password any more: anyone who can reach the server can use it.');
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
  console.log(`  Password: ${cfg.password ? 'yes' : 'none (flow-server set-password to add one)'}`);
  console.log(`  ffmpeg:   ${tools.ffmpeg() ? 'found' : 'not found (optional: song lengths, tags and loudness for songs added by hand)'}`);
  const addrs = lanAddresses();
  console.log(`  Enter in Flow's settings: ${(addrs.length ? addrs : ['localhost']).map((a) => `${a}:${server.port}`).join('  or  ')}`);
  console.log(`  Discovery: ${server.discovery() ? `apps on this network find the server by themselves (UDP ${server.discovery().port})` : 'off (UDP port taken); the address has to be typed in'}`);
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
