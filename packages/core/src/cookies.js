'use strict';

// Browser cookies for a download: the app has yt-dlp read them from a browser
// (--cookies-from-browser), so sites that want a signed-in visitor (age
// restricted videos, members only) can be downloaded too. To let a Flow
// Server do such a download, the app sends it only the cookies of the link's
// own site, out of the Netscape cookie file yt-dlp writes; the server keeps
// them with that download alone and deletes them with it.

// The browsers yt-dlp reads cookies from (Safari is macOS only).
const BROWSERS = [
  { id: 'firefox', name: 'Firefox' },
  { id: 'chrome', name: 'Chrome' },
  { id: 'edge', name: 'Edge' },
  { id: 'brave', name: 'Brave' },
  { id: 'opera', name: 'Opera' },
  { id: 'vivaldi', name: 'Vivaldi' },
  { id: 'chromium', name: 'Chromium' },
  { id: 'whale', name: 'Whale' },
  { id: 'safari', name: 'Safari' },
];

const MAX_COOKIES = 256 * 1024;

/**
 * The site whose cookies a download of `rawUrl` needs, as a domain
 * (youtube.com for youtu.be and music.youtube.com). A Spotify list's songs
 * come from YouTube, so that is YouTube too. '' when it is no web link.
 */
function cookieSite(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (/^spotify:/i.test(raw) || /^(https?:\/\/)?([a-z0-9-]+\.)*spotify\.com(\/|$)/i.test(raw)) return 'youtube.com';
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host.includes('.')) return '';
  if (host === 'youtu.be' || /(^|\.)youtube-nocookie\.com$/.test(host)) return 'youtube.com';
  const labels = host.split('.');
  // example.co.uk and the like: three labels are the site.
  const short = labels.length > 2 && labels[labels.length - 1].length === 2
    && /^(co|com|org|net|ac|gov|edu|or|ne|go)$/.test(labels[labels.length - 2]);
  return labels.slice(short ? -3 : -2).join('.');
}

/**
 * The lines of a Netscape cookie file that belong to `site` (itself or a
 * subdomain), with the file's header; '' when none do. Anything that is not a
 * cookie line is left out.
 */
function cookiesFor(text, site) {
  if (!site) return '';
  const keep = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = line.split('\t');
    if (fields.length !== 7) continue;
    const domain = fields[0].replace(/^#HttpOnly_/, '').replace(/^\./, '').toLowerCase();
    if (!domain || (line.startsWith('#') && !line.startsWith('#HttpOnly_'))) continue;
    if (domain === site || domain.endsWith(`.${site}`)) keep.push(line);
  }
  return keep.length ? `# Netscape HTTP Cookie File\n${keep.join('\n')}\n` : '';
}

module.exports = { BROWSERS, MAX_COOKIES, cookieSite, cookiesFor };
