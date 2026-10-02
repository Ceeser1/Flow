'use strict';

// The desktop app's media tools (@flow/core/media): the bundled yt-dlp,
// ffmpeg and ffprobe, the cache folder downloads are prepared in, and the
// browser cookies chosen in Settings.

const paths = require('./paths');
const tools = require('./tools');
const settings = require('./settings');
const cookieJar = require('./cookieJar');
const { createMedia } = require('@flow/core/media');

module.exports = createMedia({
  ffmpeg: tools.findFfmpeg,
  ffprobe: tools.findFfprobe,
  ytdlp: tools.findYtDlp,
  cacheDir: paths.cacheDir,
  missing: (name) => `${name}.exe was not found. Please reinstall Flow.`,
  // Settings, Website Downloads: the browser's cookies for every yt-dlp run.
  ytdlpArgs: () => cookieJar.ytdlpArgs(settings.get('useCookies') ? settings.get('cookiesBrowser') : ''),
});
