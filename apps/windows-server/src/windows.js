'use strict';

// What setup.js and run.js share, and the parts of them that can be tested on
// any machine: where things are, the scheduled task's XML, the firewall's
// rules and the setup's options.
//
// Installed, the folder looks like this (the installer, installer.nsi):
//
//   <install>\node.exe             the Node.js the server runs on
//   <install>\flow-server.cmd      the server's command line
//   <install>\Flow Server Tray.exe the icon in the notification area (tray\tray.cs)
//   <install>\tools\               ffmpeg.exe and ffprobe.exe
//   <install>\app\server\          apps/linux-server's package.json and src
//   <install>\app\windows\         this folder (src)
//   <install>\app\node_modules\@flow\core\
//
// In a clone of the repo, the server is ../../linux-server instead.

const fs = require('fs');
const path = require('path');
const { DEFAULT_PORT, isPrivateIp } = require('@flow/core/address');

// The scheduled task and the firewall's rules, by name.
const TASK = 'Flow Server';
const RULE_TCP = 'Flow Server';
const RULE_UDP = 'Flow Server (discovery)';
// Tailscale's addresses (100.64.0.0/10).
const TAILNET = '100.64.0.0/10';
// The log is started again past this size (the last one kept as .old).
const LOG_MAX = 5 * 1024 * 1024;

const INSTALLED = fs.existsSync(path.join(__dirname, '..', 'server', 'src', 'main.js'));
const SERVER_SRC = INSTALLED ? path.join(__dirname, '..', 'server', 'src') : path.join(__dirname, '..', '..', 'linux-server', 'src');
const MAIN = path.join(SERVER_SRC, 'main.js');
// Where node.exe and tools\ are; in a clone, the Node.js this runs on.
const INSTALL_DIR = INSTALLED ? path.join(__dirname, '..', '..') : path.dirname(process.execPath);

/** The server's own module, like serverModule('config'). */
function serverModule(name) {
  return require(path.join(SERVER_SRC, name));
}

/** Where yt-dlp.exe goes: the server's folder, so it can update itself without an administrator. */
const userTools = (home) => path.join(home, 'tools');
const logFile = (home) => path.join(home, 'flow-server.log');
const pidFile = (home) => path.join(home, 'flow-server.pid');
// Asks run.js to stop the server the way Ctrl+C does (setup.js stop).
const stopFile = (home) => path.join(home, 'flow-server.stop');

/** An environment whose PATH finds node.exe, ffmpeg (install\tools) and yt-dlp (the server's tools) first. */
function withTools(env, home) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
  const dirs = [INSTALL_DIR, path.join(INSTALL_DIR, 'tools'), userTools(home)];
  return { ...env, [key]: [...dirs, env[key] || ''].filter(Boolean).join(path.delimiter) };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The task: run.js started with Windows (before anyone signs in) as this user
 * (S4U: no password kept, no window), restarted when it fails, never stopped
 * for running long or on battery. The user may start and end it without an
 * administrator.
 */
function taskXml({ sid, node, script, home, workDir }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>Flow Server</Author>
    <Description>Flow Server: hosts a Flow library and streams it to the Flow apps. Set up with Flow Server Settings.</Description>
    <SecurityDescriptor>D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FA;;;${xml(sid)})</SecurityDescriptor>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(sid)}</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(node)}</Command>
      <Arguments>${xml(`"${script}" --home "${home}"`)}</Arguments>
      <WorkingDirectory>${xml(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** Task Scheduler reads its XML as UTF-16 with a byte order mark. */
const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf16le')]);

/**
 * netsh's arguments for the rules the level needs: the port for node.exe from
 * the home network (and the tailnet at level 2, or above when Tailscale is
 * here; and a proxy of level 4 on a machine on the internet), and UDP 7878
 * from the home network when the apps may find the server.
 */
function firewallRules({ level, port, discovery, proxyAt = '', tailscale = false, program }) {
  const remote = ['LocalSubnet'];
  if (level === 2 || (level >= 3 && tailscale)) remote.push(TAILNET);
  if (level === 4 && proxyAt && !isPrivateIp(proxyAt)) remote.push(proxyAt);
  const rule = (name, protocol, localport, ips, description) => ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow',
    `program=${program}`, `protocol=${protocol}`, `localport=${localport}`, `remoteip=${ips.join(',')}`, 'profile=any', 'enable=yes',
    `description=${description}`];
  const rules = [rule(RULE_TCP, 'TCP', port, remote, 'Flow Server: the apps reach it here. Set by Flow Server Settings.')];
  if (discovery) rules.push(rule(RULE_UDP, 'UDP', DEFAULT_PORT, ['LocalSubnet'], 'Flow Server: apps on the home network find it. Set by Flow Server Settings.'));
  return rules;
}

const deleteRule = (name) => ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`];

/** A text for PowerShell, in single quotes. */
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** One argument for a Windows command line (as CommandLineToArgvW reads it). */
function winArg(s) {
  const text = String(s);
  if (text && !/[\s"]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** key=value lines (flow-server info) as an object. */
function parseInfo(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  return out;
}

const PROXIES = ['nginx', 'apache', 'caddy', 'cloudflared', 'other'];

/** The setup's command and options (as install.sh's, plus start, stop, restart and log). */
function parseArgs(argv) {
  const out = {
    command: 'setup', level: 0, music: '', port: 0, url: '', proxy: '', proxyAt: '', yes: false,
    discovery: 'ask', downloads: 'ask', separate: 'ask', keep: 'ask', fromInstaller: false, onlyUpdate: false, pause: false, quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value.`);
      i += 1;
      return argv[i];
    };
    if (a === '--level') {
      const n = Number(value());
      if (n === 3) throw new Error('Level 3 (Caddy set up by the installer) is for Linux. On Windows, put a web server or tunnel of your own in front: --level 4.');
      if (![1, 2, 4].includes(n)) throw new Error('--level is 1, 2 or 4.');
      out.level = n;
    } else if (a === '--music') out.music = value();
    else if (a === '--port') {
      out.port = Number(value());
      if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) throw new Error('--port needs a number from 1 to 65535.');
    } else if (a === '--url') out.url = value();
    else if (a === '--proxy') {
      out.proxy = value();
      if (!PROXIES.includes(out.proxy)) throw new Error('--proxy is nginx, apache, caddy, cloudflared or other.');
    } else if (a === '--proxy-at') out.proxyAt = value();
    else if (a === '--yes' || a === '-y') out.yes = true;
    else if (a === '--discovery') out.discovery = true;
    else if (a === '--no-discovery') out.discovery = false;
    else if (a === '--downloads') out.downloads = true;
    else if (a === '--no-downloads') out.downloads = false;
    else if (a === '--separate-folders') out.separate = true;
    else if (a === '--no-separate-folders') out.separate = false;
    else if (a === '--keep-folders') out.keep = true;
    else if (a === '--no-keep-folders') out.keep = false;
    else if (a === '--uninstall') out.command = 'uninstall';
    else if (a === '--from-installer') out.fromInstaller = true;
    else if (a === '--only-update') out.onlyUpdate = true;
    else if (a === '--pause') out.pause = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') out.command = 'help';
    else if (!a.startsWith('-') && ['start', 'stop', 'restart', 'log'].includes(a) && out.command === 'setup') out.command = a;
    else throw new Error(`Unknown option ${a}. See --help.`);
  }
  if (out.proxyAt && !/^\d{1,3}(\.\d{1,3}){3}$/.test(out.proxyAt)) throw new Error(`"${out.proxyAt}" is not an IPv4 address.`);
  return out;
}

const URL_OK = /^https:\/\/([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z][a-zA-Z0-9-]*(:[0-9]+)?(\/[A-Za-z0-9._~-]+)*$/;

/** What to add to the web server or tunnel in front at level 4 (install.sh says the same). */
function proxySnippet({ proxy, url, upstream, port }) {
  const host = url.replace(/^https:\/\//, '').replace(/\/.*$/, '');
  const sub = url.replace(/^https:\/\/[^/]*/, '');
  const up = `http://${upstream}:${port}`;
  switch (proxy) {
    case 'nginx':
      return [
        `In the server { } block for ${host} that has your certificate (listen 443 ssl):`,
        '',
        sub ? `    location ${sub}/ {` : '    location / {',
        sub ? `        proxy_pass ${up}/;` : `        proxy_pass ${up};`,
        '        proxy_set_header Host $host;',
        '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
        '        proxy_set_header X-Forwarded-Proto $scheme;',
        '        proxy_buffering off;              # songs stream as they are read',
        '        proxy_request_buffering off;      # uploads go straight through',
        '        client_max_body_size 2g;          # long songs',
        '        proxy_read_timeout 1h;',
        '        proxy_send_timeout 1h;',
        '        access_log off;                   # audio links carry the sign-in token',
        '    }',
        '',
        'and http sent on to https (in the listen 80 block: return 301 https://$host$request_uri;).',
        'Then check it and reload nginx (nginx -t, then nginx -s reload).',
      ];
    case 'apache':
      return [
        `In the <VirtualHost *:443> for ${host} that has your certificate`,
        '(with mod_proxy, mod_proxy_http and mod_headers loaded):',
        '',
        '    ProxyPreserveHost On',
        `    ProxyPass        ${sub}/ ${up}/ flushpackets=on timeout=3600`,
        `    ProxyPassReverse ${sub}/ ${up}/`,
        '    RequestHeader set X-Forwarded-Proto "https"',
        '    LimitRequestBody 0',
        '',
        'Apache adds X-Forwarded-For by itself. Leave audio out of its access log if you keep one:',
        'the links carry the sign-in token. Then check it and restart Apache.',
      ];
    case 'caddy':
      return [
        'In your Caddyfile:',
        '',
        `    ${host} {`,
        ...(sub ? [`        handle_path ${sub}/* {`, `            reverse_proxy ${upstream}:${port}`, '        }'] : [`        reverse_proxy ${upstream}:${port}`]),
        '    }',
        '',
        'Caddy passes on who is calling and streams by itself. Then reload Caddy.',
      ];
    case 'cloudflared':
      return [
        'In the tunnel\'s config.yml, before the catch-all rule:',
        '',
        '    ingress:',
        `      - hostname: ${host}`,
        `        service: ${up}`,
        '      - service: http_status:404',
        '',
        'Then restart cloudflared. Cloudflare passes on who is calling and that it was https.',
        'Two things to know: its free plan takes uploads of at most 100 MB (larger songs can\'t be',
        'moved to the server), and its terms limit serving mostly audio or video through it; read',
        'them before you rely on it.',
      ];
    default:
      return [
        'What the web server or tunnel in front has to do:',
        `- https at ${url}, with a certificate the apps accept, and plain http sent on to https`,
        `- pass ${sub ? `${sub}/` : 'everything'} on to ${up}${sub ? ` (without ${sub})` : ''}`,
        '- add X-Forwarded-For (the caller\'s address) and X-Forwarded-Proto: https',
        '- stream, not buffer: answers (songs, the live channel\'s events) and request bodies (uploads)',
        '- allow uploads of 2 GB, pass the Range header on, and allow requests of an hour',
        '- keep audio links out of its access log: they carry the sign-in token',
      ];
  }
}

/** The log moved to .old once it has grown past `max`. */
function rotateLog(file, max = LOG_MAX) {
  try {
    if (fs.statSync(file).size > max) fs.renameSync(file, file.replace(/\.log$/, '.old.log'));
  } catch {
    // None yet.
  }
}

module.exports = {
  TASK, RULE_TCP, RULE_UDP, TAILNET, INSTALLED, INSTALL_DIR, MAIN, SERVER_SRC, PROXIES, URL_OK,
  serverModule, userTools, logFile, pidFile, stopFile, withTools, taskXml, utf16, firewallRules, deleteRule,
  psQuote, winArg, parseInfo, parseArgs, proxySnippet, rotateLog,
};
