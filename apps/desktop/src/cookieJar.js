'use strict';

// Browser cookies for downloads (Settings, Website Downloads): which browsers
// this computer has, and, to share with a Flow Server, the cookies of one
// link's site. yt-dlp reads the browser itself (--cookies-from-browser) and
// writes what it read to a file in the cache; only the site's lines are kept
// and the file is deleted straight away.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');
const tools = require('./tools');
const { runProcess } = require('@flow/core/processRunner');
const { ytDlpError } = require('@flow/core/media');
const { BROWSERS, cookieSite, cookiesFor } = require('@flow/core/cookies');

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

// Where each browser keeps its profiles on Windows.
const WHERE = {
  firefox: path.join(ROAMING, 'Mozilla', 'Firefox', 'Profiles'),
  chrome: path.join(LOCAL, 'Google', 'Chrome', 'User Data'),
  edge: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'),
  brave: path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data'),
  opera: path.join(ROAMING, 'Opera Software', 'Opera Stable'),
  vivaldi: path.join(LOCAL, 'Vivaldi', 'User Data'),
  chromium: path.join(LOCAL, 'Chromium', 'User Data'),
  whale: path.join(LOCAL, 'Naver', 'Naver Whale', 'User Data'),
};

/** The browsers yt-dlp can read on Windows: [{ id, name, found }]. */
function browsers() {
  return BROWSERS.filter((b) => WHERE[b.id]).map((b) => ({ ...b, found: fs.existsSync(WHERE[b.id]) }));
}

/** The arguments every yt-dlp run here gets for the browser chosen ('' off). */
function ytdlpArgs(browser) {
  return browser && WHERE[browser] ? ['--cookies-from-browser', browser] : [];
}

/**
 * The cookies of `url`'s site in `browser`, as a Netscape cookie file's text;
 * '' when the browser has none for it. Rejects with yt-dlp's reason in plain
 * words (browser not there, open, or its cookies locked).
 */
async function siteCookies(url, browser) {
  const site = cookieSite(url);
  if (!site || !WHERE[browser]) return '';
  const exe = tools.findYtDlp();
  if (!exe) throw new Error('yt-dlp.exe was not found. Please reinstall Flow.');
  fs.mkdirSync(paths.cacheDir(), { recursive: true });
  const file = path.join(paths.cacheDir(), `cookies-${crypto.randomBytes(6).toString('hex')}.txt`);
  try {
    // about:blank: yt-dlp reads the browser, writes the file and stops, with
    // no page fetched (it then says it cannot open about:, which is fine).
    const r = await runProcess(exe, [
      '--ignore-config', '--no-warnings', '--cookies-from-browser', browser, '--cookies', file, '--simulate', 'about:blank',
    ], null, null);
    if (!fs.existsSync(file)) throw new Error(ytDlpError(r.stderrTail || []));
    return cookiesFor(fs.readFileSync(file, 'utf8'), site);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

module.exports = { browsers, ytdlpArgs, siteCookies, WHERE };
