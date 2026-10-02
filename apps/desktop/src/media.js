'use strict';

// The desktop app's media tools (@flow/core/media): the bundled yt-dlp,
// ffmpeg and ffprobe, and the cache folder downloads are prepared in.

const paths = require('./paths');
const tools = require('./tools');
const { createMedia } = require('@flow/core/media');

module.exports = createMedia({
  ffmpeg: tools.findFfmpeg,
  ffprobe: tools.findFfprobe,
  ytdlp: tools.findYtDlp,
  cacheDir: paths.cacheDir,
  missing: (name) => `${name}.exe was not found. Please reinstall Flow.`,
});
