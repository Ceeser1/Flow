'use strict';

// Flow in the iOS Simulator, as GitHub's Macs run it (.github/workflows/ios.yml),
// and as any Mac with Xcode could: a Flow Server with test songs on this Mac,
// the app built by xcodebuild (--app) installed on a fresh Simulator, and a
// steps file run against its page. The app (Debug builds only, Harness.swift)
// asks this script for each step's script and sends back what it returned.
// Screenshots, a video (--video), Flow's log, the app's output, the system
// log and crash reports go into --out.
//
//   node apps/ios/testing/run.js --app <Flow.app> --steps <steps.js> --out <dir> [--device "iPhone 17"] [--video]
//
// A steps file exports [{ name, js, until, native, background, foreground,
// simctl, run, timeout, wait, shot, expect }], each step doing what it has,
// in this order:
//   background  Flow out of sight (iOS's Settings app opened); foreground: back
//   simctl      arguments for `xcrun simctl` ("{udid}" is the Simulator's id)
//   run         async (ctx) => value, run here on the Mac (ctx: { udid, out, server, sh })
//   native      what the app answers itself, also while its page sleeps
//               ('player': FlowPlayer's state)
//   js          the body of an async function run in the page (a string, or a
//               function whose source is taken); what it returns is the value.
//               jsWith: (ctx) => that string, made when the step runs
//   until       as js, asked again every half second until it returns
//               something truthy, for at most `timeout` ms (30 s)
//   wait        ms to wait afterwards (300)
//   shot        the whole screen as <shot>.png
//   expect      (value) => true when the step went as it should; a step that
//               throws or fails this counts as failed (the run fails at the end)

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawn } = require('child_process');

const BUNDLE = 'io.github.ceeser1.flow';
const ROOT = path.join(__dirname, '..', '..', '..');
const HARNESS_PORT = 7999;
const SERVER_PORT = 7878;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, list, opts = {}) => execFileSync(cmd, list, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts,
}).trim();
const simctl = (...a) => sh('xcrun', ['simctl', ...a]);

function options() {
  const o = { device: 'iPhone 17', video: false };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === '--video') o.video = true;
    else if (a[i].startsWith('--')) o[a[i].slice(2)] = a[(i += 1)];
  }
  for (const k of ['app', 'steps', 'out']) {
    if (!o[k]) throw new Error(`--${k} is missing. Usage: node run.js --app <Flow.app> --steps <steps.js> --out <dir>`);
  }
  return o;
}

let logFile = null;
function log(text) {
  const line = `${new Date().toISOString().slice(11, 23)} ${text}`;
  console.log(line);
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
}

// ---- a Flow Server with test songs ----

// One song of each kind Flow keeps, each its own tone, 45 s long.
const SONGS = [
  ['Flow Test - Sine A.mp3', 440, ['-c:a', 'libmp3lame', '-b:a', '192k']],
  ['Flow Test - Sine B.opus', 494, ['-c:a', 'libopus', '-b:a', '96k']],
  ['Flow Test - Sine C.ogg', 523, ['-c:a', 'libvorbis', '-q:a', '4']],
  ['Flow Test - Sine D.m4a', 587, ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']],
  ['Flow Test - Sine E.flac', 659, ['-c:a', 'flac']],
  ['Flow Test - Sine F.wav', 698, ['-c:a', 'pcm_s16le']],
];

function makeSongs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, hz, codec] of SONGS) {
    const [artist, title] = name.replace(/\.\w+$/, '').split(' - ');
    sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=45`,
      '-ac', '2', '-ar', '48000', ...codec, '-metadata', `title=${title}`, '-metadata', `artist=${artist}`, path.join(dir, name)]);
  }
}

async function startServer(out) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-ci-'));
  const music = path.join(base, 'music');
  makeSongs(music);
  // The server takes files that have not changed for a moment.
  await sleep(2500);
  const logFd = fs.openSync(path.join(out, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'apps', 'server', 'src', 'main.js'),
    '--discovery', '--name', 'Flow CI', '--music', music, '--home', path.join(base, 'home'), '--port', String(SERVER_PORT)], {
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, FLOW_SERVER_YTDLP: 'off' },
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/hello`);
      if (r.ok) {
        const hello = await r.json();
        log(`Flow Server "${hello.name}" running (${SONGS.length} test songs)`);
        return { child, base, hello };
      }
    } catch {
      // Not up yet.
    }
    await sleep(500);
  }
  throw new Error('The Flow Server did not start (see server.log).');
}

// ---- the Simulator ----

/** The newest iOS's device of this name: { udid, name, runtime }. */
function pickDevice(name) {
  const all = JSON.parse(simctl('list', 'devices', 'available', '--json')).devices;
  let best = null;
  for (const [runtime, devices] of Object.entries(all)) {
    const m = /iOS-(\d+)-(\d+)/.exec(runtime);
    if (!m) continue;
    const version = Number(m[1]) * 100 + Number(m[2]);
    for (const d of devices) {
      if (d.name === name && (!best || version > best.version)) best = { udid: d.udid, name: d.name, runtime, version };
    }
  }
  if (!best) throw new Error(`No Simulator called "${name}" (xcrun simctl list devices).`);
  return best;
}

function screenshot(udid, file) {
  simctl('io', udid, 'screenshot', '--type=png', file);
}

// ---- talking to the app (Harness.swift) ----

function harness() {
  const jobs = [];
  const waiting = new Map();
  let held = null;
  let heldTimer = null;
  let polls = 0;
  let onFirst = null;
  const first = new Promise((r) => { onFirst = r; });
  let seq = 0;

  const give = (res, job) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(job));
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/next')) {
      polls += 1;
      if (polls === 1) onFirst();
      if (jobs.length) return give(res, jobs.shift());
      if (held) held.end();
      held = res;
      clearTimeout(heldTimer);
      heldTimer = setTimeout(() => {
        if (held === res) {
          held = null;
          res.writeHead(204);
          res.end();
        }
      }, 25000);
      return undefined;
    }
    if (req.method === 'POST' && req.url.startsWith('/result')) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(204);
        res.end();
        try {
          const r = JSON.parse(body);
          const w = waiting.get(r.id);
          if (w) {
            waiting.delete(r.id);
            clearTimeout(w.timer);
            if (r.ok) w.resolve(JSON.parse(r.value || 'null'));
            else w.reject(new Error(r.error || 'The script failed.'));
          }
        } catch (err) {
          log(`harness: a result could not be read: ${err.message}`);
        }
      });
      return undefined;
    }
    res.writeHead(404);
    res.end();
    return undefined;
  });

  /** Sends a job ({ js } or { native }) to the app: what it answered. */
  function ask(job, timeout = 30000) {
    seq += 1;
    const id = `j${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        const i = jobs.findIndex((j) => j.id === id);
        if (i >= 0) jobs.splice(i, 1);
        reject(new Error(`No answer from the app in ${Math.round(timeout / 1000)} s.`));
      }, timeout);
      waiting.set(id, { resolve, reject, timer });
      const full = { id, ...job };
      if (held) {
        const res = held;
        held = null;
        clearTimeout(heldTimer);
        give(res, full);
      } else {
        jobs.push(full);
      }
    });
  }

  return {
    listen: () => new Promise((r) => server.listen(HARNESS_PORT, '127.0.0.1', r)),
    close: () => {
      if (held) held.end();
      clearTimeout(heldTimer);
      server.close();
    },
    first,
    ask,
  };
}

/** A step's script as the body of an async function. */
function body(js) {
  return typeof js === 'function' ? `return await (${js.toString()})();` : String(js);
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : (s.length > 1500 ? `${s.slice(0, 1500)}...` : s);
};

async function runStep(step, ctx) {
  const started = Date.now();
  let value;
  let error = null;
  try {
    if (step.background) simctl('launch', ctx.udid, 'com.apple.Preferences');
    if (step.foreground) simctl('launch', ctx.udid, BUNDLE);
    if (step.simctl) simctl(...step.simctl.map((a) => (a === '{udid}' ? ctx.udid : a)));
    if (step.run) value = await step.run(ctx);
    if (step.native) value = (await ctx.ask({ native: step.native }, step.timeout || 30000)).v;
    if (step.js) value = await ctx.ask({ js: body(step.js) }, step.timeout || 30000);
    if (step.jsWith) value = await ctx.ask({ js: body(step.jsWith(ctx)) }, step.timeout || 30000);
    if (step.until) {
      const end = Date.now() + (step.timeout || 30000);
      for (;;) {
        try {
          value = await ctx.ask({ js: body(step.until) }, Math.max(1000, end - Date.now()));
        } catch (err) {
          if (Date.now() >= end) throw err;
          value = null;
        }
        if (value) break;
        if (Date.now() >= end) throw new Error(`Not so within ${Math.round((step.timeout || 30000) / 1000)} s (last: ${short(value)})`);
        await sleep(500);
      }
    }
  } catch (err) {
    error = err.message;
  }
  await sleep(step.wait === undefined ? 300 : step.wait);
  if (step.shot) {
    try {
      screenshot(ctx.udid, path.join(ctx.out, `${step.shot}.png`));
    } catch (err) {
      log(`  screenshot ${step.shot} failed: ${err.message}`);
    }
  }
  let ok = !error;
  if (ok && step.expect) {
    try {
      ok = !!step.expect(value);
    } catch (err) {
      ok = false;
      error = `expect threw: ${err.message}`;
    }
  }
  const took = ((Date.now() - started) / 1000).toFixed(1);
  log(`${ok ? 'ok  ' : 'FAIL'} ${step.name} (${took} s)${error ? `: ${error}` : ''}${value !== undefined ? ` -> ${short(value)}` : ''}`);
  return ok;
}

// ---- afterwards ----

function collect(ctx) {
  const out = ctx.out;
  try {
    const data = simctl('get_app_container', ctx.udid, BUNDLE, 'data');
    const flow = path.join(data, 'Library', 'Flow');
    const files = path.join(out, 'app-files');
    fs.mkdirSync(files, { recursive: true });
    for (const name of fs.existsSync(path.join(flow, 'logs')) ? fs.readdirSync(path.join(flow, 'logs')) : []) {
      fs.copyFileSync(path.join(flow, 'logs', name), path.join(out, name));
    }
    for (const name of fs.existsSync(flow) ? fs.readdirSync(flow) : []) {
      if (name.endsWith('.json')) fs.copyFileSync(path.join(flow, name), path.join(files, name));
    }
  } catch (err) {
    log(`Flow's files could not be fetched: ${err.message}`);
  }
  try {
    const text = sh('xcrun', ['simctl', 'spawn', ctx.udid, 'log', 'show', '--last', '30m', '--style', 'compact',
      '--predicate', 'process == "Flow" OR subsystem == "io.github.ceeser1.flow"']);
    fs.writeFileSync(path.join(out, 'system-log.txt'), text);
  } catch (err) {
    log(`The system log could not be read: ${err.message}`);
  }
  const reports = path.join(os.homedir(), 'Library', 'Logs', 'DiagnosticReports');
  for (const name of fs.existsSync(reports) ? fs.readdirSync(reports) : []) {
    if (/^Flow/i.test(name)) fs.copyFileSync(path.join(reports, name), path.join(out, name));
  }
}

async function main() {
  const o = options();
  const out = path.resolve(o.out);
  fs.mkdirSync(out, { recursive: true });
  logFile = path.join(out, 'log.txt');
  const steps = require(path.resolve(o.steps));

  const server = await startServer(out);
  const device = pickDevice(o.device);
  log(`Simulator: ${device.name}, ${device.runtime.replace(/.*SimRuntime\./, '')} (${device.udid})`);
  try {
    simctl('shutdown', device.udid);
  } catch {
    // Not running.
  }
  simctl('erase', device.udid);
  simctl('boot', device.udid);
  simctl('bootstatus', device.udid, '-b');
  // For the screenshots only: dark, and a tidy status bar.
  for (const extra of [['ui', device.udid, 'appearance', 'dark'],
    ['status_bar', device.udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100']]) {
    try {
      simctl(...extra);
    } catch (err) {
      log(`simctl ${extra[0]} failed: ${err.message.split(/\r?\n/)[0]}`);
    }
  }
  simctl('install', device.udid, path.resolve(o.app));

  const video = o.video
    ? spawn('xcrun', ['simctl', 'io', device.udid, 'recordVideo', '--codec=h264', '--force', path.join(out, 'run.mp4')], { stdio: 'ignore' })
    : null;

  const h = harness();
  await h.listen();
  simctl('launch', '--terminate-running-process', `--stdout=${path.join(out, 'app-stdout.txt')}`,
    `--stderr=${path.join(out, 'app-stderr.txt')}`, device.udid, BUNDLE, '-FlowHarness', `http://127.0.0.1:${HARNESS_PORT}`);
  const up = await Promise.race([h.first.then(() => true), sleep(60000).then(() => false)]);
  log(up ? 'Flow is up and asking for steps' : 'Flow never asked for a step in 60 s');

  const ctx = {
    udid: device.udid, out, server, sh, ask: h.ask, log,
  };
  let failed = up ? 0 : 1;
  if (up) {
    for (const step of steps) {
      if (!(await runStep(step, ctx))) failed += 1;
    }
  }
  try {
    screenshot(device.udid, path.join(out, 'zz-last.png'));
  } catch {
    // Taken with the steps' own.
  }
  if (video) {
    video.kill('SIGINT');
    await sleep(3000);
  }
  h.close();
  collect(ctx);
  server.child.kill();
  log(`${steps.length} steps, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  log(`run failed: ${err.stack || err.message}`);
  process.exitCode = 2;
});
