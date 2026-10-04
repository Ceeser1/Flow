'use strict';

// Drives Flow on the Android emulator, the way the desktop harness drives the
// Electron window: installs the debug APK, starts the app, then runs a steps
// file against the WebView over the DevTools protocol and saves screenshots.
//
//   node apps/android/testing/harness.js [--build] [--no-install] <steps.js> <outDir>
//
// steps.js exports [{ name, key, shell, js, wait, shot, screen }]: `key` is
// pressed on the emulator (BACK, HOME, SLEEP), `shell` is run there (adb shell,
// e.g. dumpsys; its output is logged, only the lines matching the regular
// expression `grep` when given), `js` is evaluated in the page (a promise is
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

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  if (!stepsFile || !outDir) throw new Error('usage: harness.js [--build] [--no-install] <steps.js> <outDir>');
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
  adb('shell', 'am', 'force-stop', APP);
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
      if (step.shell) {
        try {
          let out = adb('shell', step.shell);
          if (step.grep) out = out.split('\n').filter((l) => new RegExp(step.grep).test(l)).join('\n');
          log('shell', step.name || '', out);
        } catch (err) {
          log('shell error', step.name || '', err.message);
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
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, step.shot + '.png'), Buffer.from(data, 'base64'));
      }
      if (step.screen) fs.writeFileSync(path.join(outDir, step.screen + '.png'), adbRaw('exec-out', 'screencap', '-p'));
    }
  } finally {
    cdp.close();
    try { adb('forward', '--remove', `tcp:${PORT}`); } catch { /* already gone */ }
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
