'use strict';

// Drives Flow on the Android emulator, the way the desktop harness drives the
// Electron window: installs the debug APK, starts the app, then runs a steps
// file against the WebView over the DevTools protocol and saves screenshots.
//
//   node apps/android/testing/harness.js [--build] [--no-install] [--keep] <steps.js> <outDir>
//
// --keep leaves Flow running as it is (its music, its player) and only opens
// its window again; otherwise it is stopped and started afresh.
//
// steps.js exports [{ name, key, tap, shell, run, js, wait, shot, screen }]: `key` is
// pressed on the emulator (BACK, HOME, SLEEP), `tap` taps what shows that text
// on the screen (Android's own screens too, such as its file picker; a
// regular expression, matched against each element's text and description;
// `long` holds it), `shell` is run there (adb shell,
// e.g. dumpsys; its output is logged, only the lines matching the regular
// expression `grep` when given), `run` is called here (an async function,
// e.g. another device on the test server; what it returns is logged), `js` is
// evaluated in the page (a promise is
// awaited, the value logged), then after `wait` ms (400)
// `shot` saves the page as <shot>.png and `screen` the whole device screen
// (status bar, notifications) as <screen>.png. Errors and console warnings go
// to <outDir>/log.txt.
//
// Only an emulator is ever driven (FLOW_ADB_SERIAL, emulator-5554 by default):
// a phone is not started, tapped or played on from here.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP = 'io.github.ceeser1.flow';
const ANDROID = path.join(__dirname, '..');
const APK = path.join(ANDROID, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const SERIAL = process.env.FLOW_ADB_SERIAL || 'emulator-5554';
const PORT = Number(process.env.FLOW_CDP_PORT) || 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adb = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { encoding: 'utf8' }).trim();
const adbRaw = (...args) => execFileSync('adb', ['-s', SERIAL, ...args], { maxBuffer: 64 * 1024 * 1024 });

/**
 * Taps (or with `long` holds) the middle of the first element on the screen
 * whose text or description matches `pattern`, as uiautomator sees the screen.
 * Looks again for up to 6 s (a screen sliding in), and waits until it has
 * stopped moving. Returns what it tapped.
 */
async function tap(pattern, long = false) {
  let last = '';
  for (let i = 0; i < 12; i += 1) {
    const at = findOnScreen(pattern);
    // The same place twice in a row: it is where it stays.
    if (at && at.where === last) {
      if (long) adb('shell', 'input', 'swipe', String(at.x), String(at.y), String(at.x), String(at.y), '800');
      else adb('shell', 'input', 'tap', String(at.x), String(at.y));
      return `${at.label} at ${at.where}`;
    }
    last = at ? at.where : '';
    await sleep(500);
  }
  throw new Error(`Nothing on the screen says ${pattern}`);
}

/** { label, x, y, where } of the first element matching `pattern`, or null. */
function findOnScreen(pattern) {
  adb('shell', 'uiautomator', 'dump', '/sdcard/flow-ui.xml');
  const xml = adb('shell', 'cat', '/sdcard/flow-ui.xml');
  const re = new RegExp(pattern);
  const attr = (node, name) => {
    const m = node.match(new RegExp(` ${name}="([^"]*)"`));
    return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : '';
  };
  for (const node of xml.match(/<node [^>]*>/g) || []) {
    const label = attr(node, 'text') || attr(node, 'content-desc');
    if (!label || !re.test(label)) continue;
    const b = attr(node, 'bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const x = Math.round((Number(b[1]) + Number(b[3])) / 2);
    const y = Math.round((Number(b[2]) + Number(b[4])) / 2);
    return { label, x, y, where: `${x},${y}` };
  }
  return null;
}

function build() {
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  run('npm', ['run', 'sync'], ANDROID);
  // By its full path: a shell may not look in the current folder for programs.
  const project = path.join(ANDROID, 'android');
  run(path.join(project, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'), ['assembleDebug', '-q'], project);
}

// The app's WebView, found by the DevTools socket its process opens.
async function pageSocket() {
  let pid = '';
  for (let i = 0; i < 50 && !pid; i += 1) {
    try { pid = adb('shell', 'pidof', APP); } catch { pid = ''; }
    if (!pid) await sleep(200);
  }
  if (!pid) throw new Error(`${APP} is not running`);
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  for (let i = 0; i < 50; i += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not open yet */ }
    await sleep(200);
  }
  throw new Error('The WebView has no DevTools page');
}

function connect(url, log) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const waiting = new Map();
    ws.onerror = () => reject(new Error('DevTools connection failed'));
    ws.onmessage = (msg) => {
      const m = JSON.parse(msg.data);
      if (m.id && waiting.has(m.id)) {
        const { ok, fail } = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) fail(new Error(m.error.message));
        else ok(m.result);
      } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        log('console', m.params.type, m.params.args.map((a) => a.value ?? a.description).join(' '));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        log('exception', (d.exception && d.exception.description) || d.text);
      }
    };
    const send = (method, params = {}) => new Promise((ok, fail) => {
      seq += 1;
      waiting.set(seq, { ok, fail });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });
    ws.onopen = () => resolve({ send, close: () => ws.close() });
  });
}

// A page frozen in the background answers nothing: the step fails after this long.
const EVALUATE_TIMEOUT_MS = 20000;

async function evaluate(cdp, expression) {
  let timer;
  const r = await Promise.race([
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('the page did not answer (frozen?)')), EVALUATE_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text);
  }
  return r.result.value;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const [stepsFile, outDir] = args.filter((a) => !a.startsWith('--'));
  if (!stepsFile || !outDir) throw new Error('usage: harness.js [--build] [--no-install] [--keep] <steps.js> <outDir>');
  if (!SERIAL.startsWith('emulator-')) throw new Error(`${SERIAL} is not an emulator; the harness drives emulators only`);
  const steps = require(path.resolve(stepsFile));
  fs.mkdirSync(outDir, { recursive: true });
  const log = (...a) => {
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    fs.appendFileSync(path.join(outDir, 'log.txt'), line + '\n');
    console.log(line);
  };

  if (flags.has('--build')) build();
  if (!flags.has('--no-install')) adb('install', '-r', APK);
  if (!flags.has('--keep')) adb('shell', 'am', 'force-stop', APP);
  adb('shell', 'am', 'start', '-W', '-n', `${APP}/.MainActivity`);

  const cdp = await connect(await pageSocket(), log);
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    for (let i = 0; i < 100; i += 1) {
      const ready = await evaluate(cdp, "document.readyState === 'complete' && document.body.classList.contains('ready')").catch(() => false);
      if (ready) break;
      if (i === 99) log('note', 'the page never became ready');
      await sleep(100);
    }
    await sleep(800);
    for (const step of steps) {
      // A key pressed on the emulator first (KEYCODE_ name without the prefix: BACK, HOME).
      if (step.key) {
        adb('shell', 'input', 'keyevent', `KEYCODE_${step.key}`);
        await sleep(300);
      }
      if (step.tap) {
        try {
          log('tap', step.name || '', await tap(step.tap, step.long));
        } catch (err) {
          log('tap error', step.name || '', err.message);
        }
        await sleep(300);
      }
      if (step.shell) {
        try {
          let out = adb('shell', step.shell);
          if (step.grep) out = out.split('\n').filter((l) => new RegExp(step.grep).test(l)).join('\n');
          log('shell', step.name || '', out);
        } catch (err) {
          log('shell error', step.name || '', err.message);
        }
      }
      if (step.run) {
        try {
          const r = await step.run();
          if (r !== undefined) log('run', step.name || '', r);
        } catch (err) {
          log('run error', step.name || '', err.message);
        }
      }
      if (step.js) {
        try {
          const r = await evaluate(cdp, step.js);
          if (r !== undefined) log('result', step.name || '', r);
        } catch (err) {
          log('step error', step.name || '', err.message);
        }
      }
      await sleep(step.wait || 400);
      if (step.shot) {
        // The page draws nothing while another app is over it (Android's picker): no shot then.
        const shot = cdp.send('Page.captureScreenshot', { format: 'png' });
        const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 10000));
        const got = await Promise.race([shot, timeout]);
        if (got) fs.writeFileSync(path.join(outDir, step.shot + '.png'), Buffer.from(got.data, 'base64'));
        else log('shot error', step.name || '', 'the page did not draw (another app in front?)');
      }
      if (step.screen) fs.writeFileSync(path.join(outDir, step.screen + '.png'), adbRaw('exec-out', 'screencap', '-p'));
    }
  } finally {
    cdp.close();
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* already gone */ }
  }
}

// Done: what a `run` step left open (another device's stream) does not keep it going.
main().then(() => process.exit(0), (err) => {
  console.error(err.message);
  process.exit(1);
});
