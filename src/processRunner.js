'use strict';

// Taken from LWClipper's src/processRunner.js.

const { spawn } = require('child_process');
const readline = require('readline');

class ProcessCancelledError extends Error {
  constructor() {
    super('Cancelled.');
  }
}

const TAIL_CAP = 60;

function appendCapped(tail, line) {
  if (!line || !line.trim()) return;
  tail.push(line);
  if (tail.length > TAIL_CAP) tail.shift();
}

/**
 * Runs an external tool (yt-dlp, ffmpeg) and streams its stdout line by line.
 * `cancelToken` is a plain { cancelled: false } object; cancel() on it (added
 * here) kills the whole process tree, since yt-dlp starts ffmpeg itself.
 */
function runProcess(exePath, args, onStdoutLine, cancelToken, onStderrLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true });
    const stdoutTail = [];
    const stderrTail = [];

    const killTree = () => {
      try {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          child.kill();
        }
      } catch {
        // Already gone; the close handler still rejects as cancelled.
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
