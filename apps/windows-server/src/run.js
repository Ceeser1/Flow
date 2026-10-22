'use strict';

// What the Flow Server task runs (setup.js registers it): the server
// (apps/linux-server's main.js) in a child process, its output in
// flow-server.log in the server's folder, started again 5 s after it fails, as
// systemd does on Linux. setup.js stops it by leaving flow-server.stop in the
// server's folder: the server then closes as on Ctrl+C, and this ends with it.
// Ending the task ends the server too, at once (Windows ends a child with its
// parent). Once a day, a yt-dlp in the server's tools folder updates itself
// (YouTube changes often enough that a few weeks old one stops working).
//
//   node run.js [--home DIR]

const fs = require('fs');
const path = require('path');
const { fork, execFile } = require('child_process');
const win = require('./windows');

const RESTART_AFTER = 5000;
const DAY = 24 * 60 * 60 * 1000;

if (process.argv[2] === '--child') {
  // The server itself, stopped as on Ctrl+C when asked, or when its parent is gone.
  const stop = () => {
    process.emit('SIGTERM');
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('message', (m) => {
    if (m === 'stop') stop();
  });
  process.on('disconnect', stop);
  process.argv.splice(2, 1);
  require(win.MAIN);
} else {
  const at = process.argv.indexOf('--home');
  const home = at > 0 && process.argv[at + 1] ? process.argv[at + 1] : win.serverModule('config').defaultHome();
  fs.mkdirSync(home, { recursive: true });
  const log = win.logFile(home);
  win.rotateLog(log);
  const fd = fs.openSync(log, 'a');
  const say = (text) => fs.writeSync(fd, `${new Date().toTimeString().slice(0, 8)}  ${text}\n`);
  const env = { ...win.withTools(process.env, home), FLOW_SERVER_HOME: home };
  const stopFile = win.stopFile(home);
  fs.rmSync(stopFile, { force: true });
  let child = null;
  let stopping = false;
  const pids = () => {
    try {
      fs.writeFileSync(win.pidFile(home), JSON.stringify({ runner: process.pid, server: child ? child.pid : 0 }));
    } catch {
      // Only setup.js's stop needs it, and it has schtasks besides.
    }
  };

  const start = () => {
    child = fork(__filename, ['--child'], { stdio: ['ignore', fd, fd, 'ipc'], env, windowsHide: true });
    pids();
    child.on('exit', (code, signal) => {
      child = null;
      pids();
      if (code === 0 || stopping) {
        say('The server stopped.');
        process.exit(0);
      }
      say(`The server stopped (${signal || `exit code ${code}`}); starting it again in ${RESTART_AFTER / 1000} s.`);
      setTimeout(start, RESTART_AFTER);
    });
  };

  const updateYtdlp = () => {
    const exe = path.join(win.userTools(home), 'yt-dlp.exe');
    if (!fs.existsSync(exe)) return;
    execFile(exe, ['-U'], { timeout: 10 * 60 * 1000, windowsHide: true, env }, (err, stdout, stderr) => {
      const text = `${stdout || ''}${stderr || ''}`.trim().split(/\r?\n/).pop();
      say(`yt-dlp update: ${text || (err ? err.message : 'done')}`);
    });
  };

  say(`Starting the Flow Server (${process.execPath}).`);
  start();
  setInterval(() => {
    if (stopping || !fs.existsSync(stopFile)) return;
    stopping = true;
    fs.rmSync(stopFile, { force: true });
    if (child) child.send('stop');
    else process.exit(0);
  }, 500);
  setTimeout(updateYtdlp, 2 * 60 * 1000);
  setInterval(updateYtdlp, DAY);
}
