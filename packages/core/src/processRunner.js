'use strict';

// Taken from LWClipper's src/processRunner.js. Shared by the desktop app and
// the Flow Server (media.js).

const os = require('os');
const { spawn } = require('child_process');
const readline = require('readline');

class ProcessCancelledError extends Error {
  constructor() {
    super('Cancelled.');
    this.cancelled = true;
  }
}

const TAIL_CAP = 60;
const WINDOWS = process.platform === 'win32';

function appendCapped(tail, line) {
  if (!line || !line.trim()) return;
  tail.push(line);
  if (tail.length > TAIL_CAP) tail.shift();
}

/**
 * Runs an external tool (yt-dlp, ffmpeg) and streams its stdout line by line.
 * `cancelToken` is a plain { cancelled: false } object; cancel() on it (added
 * here) kills the whole process tree, since yt-dlp starts ffmpeg itself. On
 * Windows taskkill /T does that; elsewhere the tool gets its own process
 * group, which is killed as one. `options.lowPriority` runs it niced (the
 * server, so a download does not slow down streaming).
 */
function runProcess(exePath, args, onStdoutLine, cancelToken, onStderrLine, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true, detached: !WINDOWS });
    if (options.lowPriority && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW);
      } catch {
        // Normal priority then.
      }
    }
    const stdoutTail = [];
    const stderrTail = [];

    const killTree = () => {
      try {
        if (WINDOWS && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else if (child.pid) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill();
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; the close handler still rejects as cancelled.
        }
      }
    };
    if (cancelToken) {
      cancelToken.cancel = () => {
        cancelToken.cancelled = true;
        killTree();
      };
      if (cancelToken.cancelled) killTree();
    }

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      appendCapped(stdoutTail, line);
      if (onStdoutLine) onStdoutLine(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      appendCapped(stderrTail, line);
      if (onStderrLine) onStderrLine(line);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (cancelToken && cancelToken.cancelled) {
        reject(new ProcessCancelledError());
        return;
      }
      resolve({ exitCode: code, stdoutTail, stderrTail });
    });
  });
}

module.exports = { runProcess, ProcessCancelledError };
