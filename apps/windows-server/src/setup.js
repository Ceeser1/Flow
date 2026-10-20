'use strict';

// Sets up the Flow Server on Windows, as install.sh does on Linux: how far it
// can be reached (levels 1, 2 and 4; level 3's Caddy set-up is Linux only),
// the music folder, downloads and where new songs go, the password and the
// master admin. Then it registers the "Flow Server" task, which starts the
// server with Windows, before anyone signs in, as this user and without a
// window, and opens the firewall for it. The installer runs it, and so does
// Flow Server Settings in the Start menu. Safe to run again: what was chosen
// before is the default, and the task and the rules are made anew.
//
//   node setup.js [options]          set up (needs an administrator; asks for one)
//   node setup.js start|stop|restart the task
//   node setup.js log                the server's log, in Notepad
//   node setup.js --uninstall        removes the task and the firewall rules
//                                    (the library and the music stay)
//
//   --level N        1, 2 or 4 (default: the one chosen before; asked)
//   --music DIR      the music folder (default: what the server remembers, else ~\flow-music)
//   --port N         the port (default: what the server remembers, else 7878)
//   --url URL        level 4: the https address the apps use
//   --proxy NAME     level 4: nginx, apache, caddy, cloudflared or other
//   --proxy-at IP    level 4: where the web server or tunnel runs, when not on this PC
//   --yes            no questions: what was chosen before, else the defaults
//   --discovery, --no-discovery, --downloads, --no-downloads,
//   --separate-folders, --no-separate-folders, --keep-folders, --no-keep-folders
//                    as install.sh's (asked when left out)
//   --from-installer an update keeps everything without asking; the window waits for Enter
//   --pause          the window waits for Enter at the end
//
// Without a terminal, FLOW_SERVER_PASSWORD gives the password level 4 needs.
// FLOW_SERVER_SETUP_FAKE=<folder> stands in for Windows' own commands (the
// tests): schtasks, netsh, net, whoami and taskkill are written to
// <folder>\commands.txt and answered as an administrator's would be, and the
// task "runs" run.js directly.

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const http = require('http');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const win = require('./windows');

const configMod = win.serverModule('config');
const tools = win.serverModule('tools');
const HOME = configMod.defaultHome();
const NODE = process.execPath;
const RUN = path.join(__dirname, 'run.js');
const ME = __filename;

const say = (text = '') => console.log(text);
const step = (text) => console.log(`\n== ${text}`);
class Stop extends Error {}
const die = (text) => {
  throw new Stop(text);
};

let opts;
const tty = () => !!process.stdin.isTTY;
const asking = () => !opts.yes && tty();

/** A line typed at the terminal; '' without one. */
function line(question) {
  if (!tty()) return Promise.resolve('');
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    rl.on('close', () => {
      if (!done) resolve('');
    });
    rl.question(question, (answer) => {
      done = true;
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** A yes/no question; Enter (and --yes) means yes. */
async function ask(question) {
  if (opts.yes) return true;
  if (!tty()) return false;
  return !/^n(o)?$/i.test(await line(`${question} [Y/n] `));
}

/** The same, where Enter (and --yes) means no. */
async function askNo(question) {
  if (opts.yes || !tty()) return false;
  return /^y(es)?$/i.test(await line(`${question} [y/N] `));
}

const FAKE = process.env.FLOW_SERVER_SETUP_FAKE || '';

function fakeRun(cmd, args) {
  fs.mkdirSync(FAKE, { recursive: true });
  fs.appendFileSync(path.join(FAKE, 'commands.txt'), `${[cmd, ...args].join(' ')}\n`);
  const task = path.join(FAKE, 'task.xml');
  const ok = { status: 0, stdout: '', stderr: '' };
  const kill = (pid) => {
    try {
      process.kill(pid);
    } catch {
      // Gone already.
    }
  };
  if (cmd === 'whoami') return { ...ok, stdout: '"pc\\someone","S-1-5-21-1-2-3-1001"\r\n' };
  if (cmd === 'taskkill') kill(Number(args[args.indexOf('/pid') + 1]));
  if (cmd !== 'schtasks') return ok;
  const what = args[0];
  if (what === '/query') return fs.existsSync(task) ? ok : { ...ok, status: 1 };
  if (what === '/create') fs.copyFileSync(args[args.indexOf('/xml') + 1], task);
  if (what === '/delete') fs.rmSync(task, { force: true });
  if (what === '/run') spawn(NODE, [RUN, '--home', HOME], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  if (what === '/end') kill(readPids().runner);
  return ok;
}

// Windows' own, from System32: a PATH with Git's tools on it has a whoami of its own.
const SYSTEM = ['schtasks', 'netsh', 'net', 'whoami', 'taskkill', 'powershell'];
const system32 = (name) => (name === 'powershell'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', `${name}.exe`));

/** A Windows program; { status, stdout, stderr }. */
function run(cmd, args, options = {}) {
  if (FAKE && SYSTEM.includes(cmd) && cmd !== 'powershell') return fakeRun(cmd, args);
  const exe = SYSTEM.includes(cmd) && fs.existsSync(system32(cmd)) ? system32(cmd) : cmd;
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, ...options });
  return { status: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

const env = () => ({ ...win.withTools(process.env, HOME), FLOW_SERVER_HOME: HOME });

/** The server's command line: shown in this window, or its output given back (`quiet`). */
function flow(args, { quiet = false, extraEnv = {} } = {}) {
  const r = spawnSync(NODE, [win.MAIN, ...args], { stdio: quiet ? 'pipe' : 'inherit', encoding: 'utf8', env: { ...env(), ...extraEnv } });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function info() {
  const r = flow(['info'], { quiet: true });
  if (!r.ok) die(`The server's settings could not be read: ${r.stderr.trim() || r.stdout.trim()}`);
  return win.parseInfo(r.stdout);
}

const isAdmin = () => run('net', ['session']).status === 0;
const taskExists = () => run('schtasks', ['/query', '/tn', win.TASK]).status === 0;

/** This user's SID, for the task. */
function userSid() {
  const r = run('whoami', ['/user', '/fo', 'csv', '/nh']);
  const m = r.stdout.match(/"(S-1-[\d-]+)"/);
  if (!m) die(`Could not tell who you are (whoami): ${r.stderr.trim() || r.stdout.trim()}`);
  return m[1];
}

/** This setup again as an administrator, in a window of its own; resolves its exit code. */
function elevated(args) {
  say('This needs an administrator: Windows asks next.');
  const list = [ME, ...args, '--pause'].map(win.winArg).join(' ');
  const ps = `try { $p = Start-Process -FilePath ${win.psQuote(NODE)} -ArgumentList ${win.psQuote(list)} -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`;
  const r = run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { stdio: 'inherit' });
  if (r.status === 1223) say('Not allowed, so nothing was changed.');
  return r.status;
}

/** Resolves the server's hello at this port, or null. */
function hello(port, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/hello', timeout, agent: false }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const h = JSON.parse(body);
          resolve(h && h.app === 'flow-server' ? h : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

async function waitFor(check, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** Whether something else listens on the port. */
function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });
}

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

function readPids() {
  try {
    return JSON.parse(fs.readFileSync(win.pidFile(HOME), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Stops the server as Ctrl+C does (run.js sees the stop file), and waits for
 * it; one that does not stop is ended with the task.
 */
async function stopServer() {
  const { runner, server } = readPids();
  const gone = () => !alive(server) && !alive(runner);
  const stopFile = win.stopFile(HOME);
  if (!gone()) {
    fs.writeFileSync(stopFile, '');
    await waitFor(gone, 10000);
  }
  fs.rmSync(stopFile, { force: true });
  run('schtasks', ['/end', '/tn', win.TASK]);
  if (!(await waitFor(gone, 5000))) {
    for (const pid of [server, runner]) if (alive(pid)) run('taskkill', ['/f', '/pid', String(pid)]);
    await waitFor(gone, 5000);
  }
  return gone();
}

/** Starts the task; resolves whether the server answers. */
async function startServer(port) {
  const r = run('schtasks', ['/run', '/tn', win.TASK]);
  if (r.status !== 0) return false;
  return waitFor(() => hello(port), 20000);
}

/** What the server wrote to its log from `from` on. */
function logSince(from) {
  try {
    const text = fs.readFileSync(win.logFile(HOME), 'utf8');
    return text.slice(from).trim().split(/\r?\n/);
  } catch {
    return [];
  }
}

const logSize = () => {
  try {
    return fs.statSync(win.logFile(HOME)).size;
  } catch {
    return 0;
  }
};

/** yt-dlp where the server finds it, or ''. */
function findYtdlp() {
  const own = path.join(win.userTools(HOME), 'yt-dlp.exe');
  if (fs.existsSync(own)) return own;
  return tools.onPath('yt-dlp') || '';
}

function tailscaleCli() {
  const own = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  return fs.existsSync(own) ? own : tools.onPath('tailscale');
}

function tailscaleIp() {
  const cli = tailscaleCli();
  if (!cli) return '';
  const r = run(cli, ['ip', '-4']);
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : '';
}

function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('100.') && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

const openFolder = (dir) => spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
const openLink = (url) => spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

// ---- set up ----

async function setup() {
  if (!isAdmin()) {
    const code = elevated(process.argv.slice(2).filter((a) => a !== '--pause'));
    process.exitCode = code === 0 ? 0 : 1;
    opts.pause = false;
    return;
  }
  fs.mkdirSync(HOME, { recursive: true });
  let cur = info();
  const curLevel = Number(cur.level) || 0;
  // An update from the installer, of a server set up before: as it was,
  // unless asked to change it (n); the questions then start from what it is.
  if (opts.fromInstaller && curLevel && taskExists() && !opts.yes) {
    step('Updating the Flow Server');
    say(`  Level:      ${curLevel}${curLevel === 2 ? ', home network and Tailscale' : curLevel === 4 ? `, the internet at ${cur.public_url}` : ', home network only'}`);
    say(`  Music:      ${cur.music}`);
    say(`  Downloads:  ${cur.downloads === '1' ? 'on' : 'off'}`);
    say(`  Discovery:  ${cur.discovery === '1' ? 'on' : 'off'}`);
    say(`  Password:   ${cur.password === 'none' ? 'none' : 'set'}`);
    say(`  Master admin: ${cur.master || 'none'}`);
    if (await ask('Keep this setup?')) {
      opts.yes = true;
      say('Kept. Flow Server Settings in the Start menu changes it later.');
    }
  }
  const port = opts.port || Number(cur.port) || 7878;

  step('Where should the server be reachable from?');
  const tsIpNow = tailscaleIp();
  const defaultLevel = [1, 2, 4].includes(curLevel) ? curLevel : (tsIpNow ? 2 : 1);
  say('  1  Home network only');
  say('       No internet exposure. Risk: very low.');
  say('  2  Home network and Tailscale');
  say('       Also from anywhere, through Tailscale: a free account, and its app on each');
  say('       device. No router settings. Risk: low.');
  say('  4  Home network and the internet, through your own web server or tunnel');
  say('       (nginx, Caddy, Cloudflare Tunnel...). You set it up, its certificate and the');
  say('       router; this checks it. Risk: high if not set up properly.');
  say('  (Level 3, Caddy set up for you, is for the Linux server.)');
  say('  Level 4 needs a strong password (8+ characters, upper and lower case, a number).');
  let level = opts.level;
  if (!level) {
    if (!asking()) level = defaultLevel;
    while (!level) {
      const answer = await line(`Level [${defaultLevel}]: `);
      if (!answer) level = defaultLevel;
      else if (['1', '2', '4'].includes(answer)) level = Number(answer);
      else say(answer === '3' ? 'Level 3 is for Linux. With a web server or tunnel of your own, choose 4.' : '1, 2 or 4, please.');
    }
  }
  say(`Level ${level}.${curLevel ? ` (It was ${curLevel}.)` : ''}`);

  step('The music folder');
  say('The server plays the songs in this folder and its subfolders, and puts new ones there.');
  let music = opts.music ? path.resolve(opts.music) : cur.music;
  if (!opts.music && asking()) {
    const answer = (await line(`Folder [${music}]: `)).replace(/^"|"$/g, '');
    if (answer) music = path.resolve(answer);
  }
  fs.mkdirSync(music, { recursive: true });
  say(music);

  step('Should the server download songs itself?');
  say('With this, the Flow apps get "Download (Server)" on Add Songs: the server fetches the');
  say('songs, so a phone needs no downloader of its own. It needs ffmpeg, which comes with the');
  say('Flow Server, and yt-dlp, which you install yourself: Flow does not come with it.');
  let downloads = opts.downloads;
  if (downloads === 'ask') {
    if (!asking()) downloads = cur.downloads === '1';
    else downloads = await ask('Let the server download songs?');
  }
  // As on Linux: whoever wants it reads the legal note and installs yt-dlp
  // themselves; declining the note leaves downloads off. One already there needs no note.
  if (downloads && !findYtdlp() && asking()) {
    say('');
    say('Legal note: using Flow to play your own local music files is completely fine.');
    say('Downloading requires yt-dlp. Using yt-dlp or downloading from URLs may break copyright');
    say('law in your country or the terms of the site you download from. Use at your own risk.');
    if (!(await askNo('I understand and want to proceed'))) downloads = false;
  }
  say(downloads ? 'Yes.' : 'No (Flow Server Settings turns it on later).');

  step('Where should new songs go in the music folder?');
  say('Songs the apps upload and songs the server downloads can each get a folder of their');
  say('own (Uploads and Downloads), or all go straight into the music folder. Songs there');
  say('already stay where they are.');
  let separate = opts.separate;
  if (separate === 'ask') separate = asking() ? await ask('Use separate folders for uploads and downloads?') : cur.separate_folders === '1';
  say(separate ? 'Yes: Uploads and Downloads.' : 'No: straight into the music folder.');
  say('');
  say('An upload can keep the folders it is in on the PC or phone: a song in');
  say('Music\\FlowPlayer\\Linkin Park\\Hybrid Theory\\In the End.mp3 is saved as');
  say(`Linkin Park\\Hybrid Theory\\In the End.mp3 here${separate ? ' (inside Uploads)' : ''}. Without, it is saved as`);
  say('"Linkin Park - In the End.mp3".');
  let keep = opts.keep;
  if (keep === 'ask') keep = asking() ? await ask('Keep uploaded folder structures?') : cur.keep_folders === '1';
  say(keep ? 'Yes.' : 'No.');

  step('ffmpeg');
  say(tools.onPath('ffmpeg') || fs.existsSync(path.join(win.INSTALL_DIR, 'tools', 'ffmpeg.exe'))
    ? 'Comes with the Flow Server: songs put into the music folder by hand get their length, tags and loudness.'
    : 'Not found. Songs put into the music folder by hand get no length, tags or loudness, and the server cannot download.');

  if (downloads) {
    step('yt-dlp (downloads songs)');
    const toolsDir = win.userTools(HOME);
    fs.mkdirSync(toolsDir, { recursive: true });
    const hint = () => {
      say('Download yt-dlp.exe yourself from yt-dlp\'s latest release at GitHub and put it into');
      say(`  ${toolsDir}`);
      say('There it keeps itself up to date (once a day, while the server runs).');
    };
    if (findYtdlp()) say(`Found: ${findYtdlp()}.`);
    else if (!asking()) {
      say('Not installed (Flow does not install it). To let the server download:');
      hint();
      say('Then restart the server (Restart Flow Server in the Start menu).');
    } else {
      hint();
      openFolder(toolsDir);
      for (;;) {
        const answer = await line('Do it now (the folder is open), then press Enter here (s = skip): ');
        if (/^s$/i.test(answer)) {
          say('Skipped. The server cannot download songs until it is there. Later:');
          hint();
          say('Then restart the server (Restart Flow Server in the Start menu).');
          break;
        }
        if (findYtdlp()) {
          say(`Found: ${findYtdlp()}.`);
          break;
        }
        say('Not found.');
      }
    }
    // YouTube's pages need JavaScript solved: the Node.js that comes with the
    // server does that, once yt-dlp's config next to it says so.
    if (Number(process.versions.node.split('.')[0]) >= 22) {
      const conf = path.join(toolsDir, 'yt-dlp.conf');
      let text = '';
      try {
        text = fs.readFileSync(conf, 'utf8');
      } catch {
        // None yet.
      }
      if (!text.includes('--js-runtimes')) {
        fs.writeFileSync(conf, `${text}# Written by Flow Server Settings: YouTube's JavaScript is solved with the Flow Server's Node.js.\n--js-runtimes node\n`);
      }
      say(`YouTube: yt-dlp uses the Flow Server's Node.js ${process.version} (set in ${conf}).`);
    }
  }

  step('Finding the server on the network (optional)');
  say('With this on, the Flow apps find the server by themselves on your home network: an app with');
  say('no Home address sends a small UDP question and the server answers with its name and port.');
  say('It tells them what /api/hello already tells anyone on the network, never the password or the library,');
  say('and only devices on private addresses get an answer. It opens UDP 7878 for your home network.');
  let discovery = opts.discovery;
  if (discovery === 'ask') discovery = opts.yes ? cur.discovery === '1' || !curLevel : await ask('Turn it on?');
  say(discovery ? 'On.' : 'Off. The address is typed into Flow.');

  if (level === 4) {
    step('Password (required at level 4)');
    let fresh = true;
    if (cur.password === 'strong' && !process.env.FLOW_SERVER_PASSWORD && !(await askNo('A strong password is set already. Choose a new one?'))) fresh = false;
    if (!fresh) say('Kept. Change it later with: flow-server set-password');
    else {
      say('The server will be reachable from the internet, so it needs a strong password: at least');
      say('8 characters, with a lower-case letter, an upper-case letter and a number.');
      if (cur.password === 'pin') say('The password it has now is not enough. Every signed-in device enters the new one once.');
      if (process.env.FLOW_SERVER_PASSWORD) {
        if (!flow(['set-password', '--level', '4', process.env.FLOW_SERVER_PASSWORD]).ok) die('FLOW_SERVER_PASSWORD is not strong enough (see above).');
      } else if (tty()) {
        let tries = 1;
        while (!flow(['set-password', '--level', '4']).ok) {
          if (tries >= 3) die('No password set, so level 4 can\'t be set up. Run Flow Server Settings again when you have one.');
          tries += 1;
          say('Try again:');
        }
      } else die('Level 4 needs a password: run this in a window, or give it as FLOW_SERVER_PASSWORD.');
    }
  } else {
    step(`Password (optional at level ${level})`);
    if (cur.password !== 'none') say('Set already. Change it later with: flow-server set-password');
    else {
      say(level === 2 ? 'Without one, anyone on your home network or your tailnet can use the server.'
        : 'Without one, anyone on your home network can use the server, which is often fine.');
      if (await askNo('Set a password now (4 or more characters)?')) {
        let tries = 1;
        while (!flow(['set-password', '--level', String(level)]).ok) {
          if (tries >= 3) {
            say('Not set; later: flow-server set-password');
            break;
          }
          tries += 1;
          say('Try again:');
        }
      } else say('None. Later: flow-server set-password');
    }
  }

  step('Master admin');
  if (cur.master) say(`${cur.master} is the master admin. Another one later: flow-server admin master <name>`);
  else {
    say('The master admin is the one profile that can change the server password and make other');
    say('profiles admins from inside the apps (Settings, Administration). Its PIN needs at least');
    say('4 characters; a strong password is recommended. Admins see the profiles, their IPs, the');
    say('trash and the server\'s rules.');
    if (asking() && await ask('Create a master-admin profile now?')) {
      const name = await line('Its name (a profile\'s name that exists already makes that one the master): ');
      if (name) {
        let tries = 1;
        while (!flow(['admin', 'master', name, '--create', '--level', String(level)]).ok) {
          if (tries >= 3) {
            say('Not made; later: flow-server admin master <name> --create');
            break;
          }
          tries += 1;
          say('Try again:');
        }
      } else say('None. Later: flow-server admin master <name> --create');
    } else say('None for now. Later: flow-server admin master <name> --create');
  }

  let tsIp = '';
  if (level === 2) {
    step('Tailscale (reach the server away from home)');
    for (;;) {
      tsIp = tailscaleIp();
      if (tsIp) {
        say(`This PC's Tailscale address: ${tsIp}`);
        break;
      }
      if (!tailscaleCli()) {
        say('Not installed. Tailscale makes a private network between your devices, so the apps');
        say('reach the server from anywhere, with no port opened on your router. Install Tailscale');
        say('for Windows from https://tailscale.com/download and sign in.');
      } else say('Installed, but not signed in: sign in with the Tailscale icon in the taskbar.');
      if (!asking()) {
        say('Level 2 works once Tailscale is up on this PC; nothing else to change then.');
        break;
      }
      if (!tailscaleCli() && await ask('Open the download page?')) openLink('https://tailscale.com/download/windows');
      const answer = await line('Press Enter once it is done (s = skip): ');
      if (/^s$/i.test(answer)) {
        say('Skipped: level 2 works once Tailscale is up on this PC.');
        break;
      }
    }
  }

  let url = '';
  let proxyAt = '';
  let proxyHere = true;
  if (level === 4) {
    step('Your web server or tunnel');
    say('Level 4 puts the Flow Server behind a web server or tunnel you run yourself. This doesn\'t');
    say('change its setup; it tells you what to add, then checks the result.');
    let proxy = opts.proxy;
    if (!proxy && asking()) {
      say('  1  nginx');
      say('  2  Apache');
      say('  3  Caddy (your own)');
      say('  4  Cloudflare Tunnel (cloudflared)');
      say('  5  something else');
      proxy = { 2: 'apache', 3: 'caddy', 4: 'cloudflared', 5: 'other' }[await line('Which one [1]: ')] || 'nginx';
    }
    proxy = proxy || 'other';
    const proxyName = { nginx: 'nginx', apache: 'Apache', caddy: 'Caddy', cloudflared: 'Cloudflare Tunnel', other: 'your web server or tunnel' }[proxy];
    proxyAt = opts.proxyAt;
    if (!proxyAt && asking() && !(await ask('Does it run on this PC?'))) {
      proxyAt = await line('Its IP address (as this PC sees it): ');
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(proxyAt)) die(`"${proxyAt}" is not an IPv4 address.`);
    }
    proxyHere = !proxyAt;
    const upstream = proxyAt ? (lanIps()[0] || 'this-pc') : '127.0.0.1';
    if (proxyAt) say(`It reaches the Flow Server at ${upstream}:${port}, and the server believes what it says about who is calling.`);
    url = opts.url || cur.public_url || '';
    for (;;) {
      if (asking()) {
        say('The https address the apps will use, like https://music.example.com or https://example.com/flow');
        const answer = await line(`Address${url ? ` [${url}]` : ''}: `);
        if (answer) url = answer;
      }
      url = url.replace(/\/+$/, '');
      if (win.URL_OK.test(url)) break;
      if (!asking()) die('Level 4 needs the https address the apps use: --url https://music.example.com');
      say(`"${url}" is not an https:// address like https://music.example.com.`);
      url = '';
    }
    step(`What to add to ${proxyName}`);
    for (const l of win.proxySnippet({ proxy, url, upstream, port })) say(l);
    say('');
    say(`Don't forward port ${port} on the router: everything goes through ${proxyName}.`);
    if (asking()) await line('Press Enter once it is set up (the check comes after the server has started)... ');
  }

  // Down from level 4 (or a level 3 from elsewhere): no internet address any more.
  if (curLevel >= 3 && level < 3 && cur.public_url) {
    step(`Closing level ${curLevel}`);
    if (curLevel === 4) say('Take Flow out of your web server\'s or tunnel\'s setup: this never changed it.');
    say('The server no longer tells the apps an internet address.');
  }

  step('The server');
  const settings = ['--level', String(level), '--public-url', level === 4 ? url : '', '--trusted-proxy', level === 4 && proxyAt ? proxyAt : '',
    discovery ? '--discovery' : '--no-discovery', downloads ? '--downloads' : '--no-downloads',
    separate ? '--separate-folders' : '--no-separate-folders', keep ? '--keep-folders' : '--no-keep-folders', '--music', music];
  if (opts.port) settings.push('--port', String(opts.port));
  // Stopped first: the settings are written while it is not running.
  if (taskExists()) await stopServer();
  const applied = flow([...settings, 'info'], { quiet: true });
  if (!applied.ok) die(applied.stderr.trim() || applied.stdout.trim());
  cur = win.parseInfo(applied.stdout);
  if (!(await portFree(port))) die(`Port ${port} is in use by another program. Choose another: Flow Server Settings with --port N, or stop that program.`);
  const xmlFile = path.join(os.tmpdir(), `flow-server-task-${process.pid}.xml`);
  fs.writeFileSync(xmlFile, win.utf16(win.taskXml({ sid: userSid(), node: NODE, script: RUN, home: HOME, workDir: path.dirname(RUN) })));
  const made = run('schtasks', ['/create', '/tn', win.TASK, '/xml', xmlFile, '/f']);
  fs.rmSync(xmlFile, { force: true });
  if (made.status !== 0) die(`The task could not be made: ${(made.stderr || made.stdout).trim()}`);
  const from = logSize();
  if (await startServer(port)) say(`Running at level ${level}, and started with Windows (before anyone signs in).`);
  else {
    say('It did not start. Its log says why:');
    for (const l of logSince(from).slice(-15)) say(`  ${l}`);
    die('Fix that, then run Flow Server Settings again.');
  }

  step('Firewall');
  for (const name of [win.RULE_TCP, win.RULE_UDP]) run('netsh', win.deleteRule(name));
  const rules = win.firewallRules({ level, port, discovery, proxyAt, tailscale: !!tailscaleCli(), program: NODE });
  for (const args of rules) {
    const r = run('netsh', args);
    if (r.status !== 0) say(`Could not add a rule: ${(r.stdout || r.stderr).trim()}`);
  }
  say(`Windows Firewall: port ${port} open to the home network${rules[0].some((a) => a.includes(win.TAILNET)) ? ' and Tailscale' : ''}`
    + `${level === 4 && proxyAt && rules[0].some((a) => a.includes(proxyAt)) ? ` and ${proxyAt} (your proxy)` : ''}`
    + `${discovery ? ', and UDP 7878 (finding the server) to the home network' : ''}, for the Flow Server only.`);

  if (level === 4 && asking()) {
    step('Checking it the way the apps will');
    flow(['doctor', ...(proxyHere ? ['--connect-to', '127.0.0.1'] : []), url]);
    if (proxyHere) {
      say('');
      say('That was checked from here. From outside your home network (a phone on mobile data), run');
      say(`  flow-server doctor ${url}`);
      say('on any PC with the Flow Server, or just connect a Flow app.');
    }
  }

  step('Done');
  for (const l of logSince(from).filter((l) => !/Starting the Flow Server/.test(l)).slice(0, 16)) say(l);
  say('');
  say('In Flow: Settings, Streaming, Download and Synchronization, then the Home address above.');
  if (level === 4) {
    say(`Remote Server: ${url} (Flow fills it in by itself once it has connected at home).`);
    say('The password is the one set above.');
  }
  if (level === 2 && tsIp) {
    say(`Flow fills in the Remote address (${tsIp}:${port}) by itself once it has connected at home.`);
    say('Install Tailscale on the PC and phone too (same account), or the Remote address does not work.');
  }
  if (level < 3 && curLevel >= 3) say('The server is no longer reachable from the internet. If Flow\'s Remote address is its https address, clear it.');
  else if (level === 1 && curLevel > 1) say('Away from home the server is no longer reachable; clear Flow\'s Remote address.');
  if (downloads) say('Downloads: on. In Flow, Add Songs offers "Download (Server)" while connected to this server.');
  say('');
  say('Settings again:  Flow Server Settings in the Start menu');
  say('Command line:    Flow Server Command Line in the Start menu (flow-server --help)');
  say(`Log:             ${win.logFile(HOME)}`);
}

// ---- the other commands ----

async function startStop(command) {
  if (!taskExists()) die('The Flow Server is not set up yet: run Flow Server Settings first.');
  const port = Number(info().port) || 7878;
  if (command !== 'start') {
    const stopped = await stopServer();
    if (!stopped && !isAdmin()) {
      process.exitCode = elevated([command]);
      opts.pause = false;
      return;
    }
    if (command === 'stop') {
      say(stopped ? 'Flow Server is stopped (until Start Flow Server, or the next start of Windows).' : 'Flow Server is still running.');
      return;
    }
  }
  if (await hello(port)) {
    say('Flow Server is running.');
    return;
  }
  const r = run('schtasks', ['/run', '/tn', win.TASK]);
  if (r.status !== 0 && !isAdmin()) {
    process.exitCode = elevated([command]);
    opts.pause = false;
    return;
  }
  if (await waitFor(() => hello(port), 20000)) say('Flow Server is running.');
  else say(`Flow Server did not start. See its log: ${win.logFile(HOME)}`);
}

async function uninstall() {
  if (!isAdmin()) {
    process.exitCode = elevated(['--uninstall']);
    opts.pause = false;
    return;
  }
  if (taskExists()) {
    await stopServer();
    run('schtasks', ['/delete', '/tn', win.TASK, '/f']);
  }
  for (const name of [win.RULE_TCP, win.RULE_UDP]) run('netsh', win.deleteRule(name));
  say('The Flow Server task and its firewall rules are removed.');
  say(`The library (${HOME}) and the music are still there.`);
}

/** The comment at the top of this file. */
function help() {
  const lines = fs.readFileSync(__filename, 'utf8').split(/\r?\n/).slice(2);
  const end = lines.findIndex((l) => !l.startsWith('//'));
  return lines.slice(0, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');
}

async function main() {
  opts = win.parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32' && opts.command !== 'help') die('This sets up the Flow Server on Windows. On Linux: sh apps/linux-server/install.sh');
  if (opts.fromInstaller) opts.pause = true;
  if (opts.command === 'help') say(help());
  else if (opts.command === 'setup') await setup();
  else if (opts.command === 'uninstall') await uninstall();
  else if (opts.command === 'log') {
    const file = win.logFile(HOME);
    if (!fs.existsSync(file)) die(`No log yet (${file}): the server has not run.`);
    spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref();
    opts.pause = false;
  } else await startStop(opts.command);
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Stop ? err.message : (err && err.stack) || err}`);
  process.exitCode = 1;
}).then(async () => {
  if (opts && opts.pause && tty()) await line('\nPress Enter to close. ');
});
