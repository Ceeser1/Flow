'use strict';

const tools = require('./tools');
const { runProcess } = require('./processRunner');

/**
 * Runs ffmpeg with -progress, reporting 0..1 of `duration` to onFrac. Throws
 * with the tail of ffmpeg's own output when it fails.
 */
async function runFfmpeg(args, duration, onFrac, cancelToken) {
  const ffmpeg = tools.findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg.exe was not found. Please reinstall Flow.');
  const result = await runProcess(ffmpeg,
    ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args],
    (line) => {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && duration > 0 && onFrac) onFrac(Math.min(1, Number(m[1]) / 1e6 / duration));
    }, cancelToken);
  if (result.exitCode !== 0) {
    throw new Error('ffmpeg failed:\n' + result.stderrTail.slice(-4).join('\n'));
  }
}

module.exports = { runFfmpeg };
