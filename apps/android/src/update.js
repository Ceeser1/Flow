'use strict';

// Updates for the phone: Flow has no store. Its newest release on GitHub
// (Ceeser1/Flow, a release whose tag is the version, v3.0.1, with the APK
// attached) is looked at; a newer one is downloaded into the app's cache and
// handed to Android's installer, which asks before installing it. While the
// repository is private GitHub answers "not found": no release, nothing to do.

const REPO = 'Ceeser1/Flow';
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

/** "v3.0.1" or "3.0.1" -> [3, 0, 1], else null. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** Whether version `a` is newer than `b` ("3.0.1" > "3.0.0"). */
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

/**
 * The release GitHub answered, as Flow needs it: { version, url (the APK),
 * size, page }, or null when it has no APK or no version for a tag.
 */
function fromRelease(r) {
  if (!r || typeof r !== 'object' || r.draft || r.prerelease) return null;
  const v = parseVersion(r.tag_name);
  const apk = (Array.isArray(r.assets) ? r.assets : [])
    .find((a) => a && /\.apk$/i.test(String(a.name || '')) && /^https:\/\//.test(String(a.browser_download_url || '')));
  if (!v || !apk) return null;
  return {
    version: v.join('.'),
    url: apk.browser_download_url,
    size: Number(apk.size) || 0,
    page: /^https:\/\//.test(String(r.html_url || '')) ? r.html_url : '',
  };
}

/**
 * The newest release ({ version, url, size, page }) or null (none yet, or
 * the repository not public). Rejects when GitHub could not be reached.
 */
async function latestRelease(fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(LATEST, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  } catch {
    throw new Error('GitHub could not be reached. Is the phone online?');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`);
  return fromRelease(await res.json());
}

module.exports = { parseVersion, isNewer, fromRelease, latestRelease, LATEST };
