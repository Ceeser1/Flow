'use strict';

// Updates (src/update.js): versions compared, GitHub's release read.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVersion, isNewer, fromRelease, latestRelease, LATEST } = require('../src/update');

test('versions: a tag with or without v, newer by its first differing part', () => {
  assert.deepEqual(parseVersion('v3.0.1'), [3, 0, 1]);
  assert.deepEqual(parseVersion('3.10.0'), [3, 10, 0]);
  assert.equal(parseVersion('3.0'), null);
  assert.equal(parseVersion('v3.0.1-beta'), null);
  assert.equal(isNewer('3.0.1', '3.0.0'), true);
  assert.equal(isNewer('v3.10.0', '3.9.9'), true);
  assert.equal(isNewer('3.0.0', '3.0.0'), false);
  assert.equal(isNewer('2.10.1', '3.0.0'), false);
  assert.equal(isNewer('nonsense', '3.0.0'), false);
});

const release = (o = {}) => ({
  tag_name: 'v3.0.1',
  html_url: 'https://github.com/Ceeser1/Flow/releases/tag/v3.0.1',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'Flow Setup 3.0.1.exe', browser_download_url: 'https://github.com/x/Flow.Setup.3.0.1.exe', size: 90 },
    { name: 'Flow-3.0.1.apk', browser_download_url: 'https://github.com/x/Flow-3.0.1.apk', size: 12345 },
  ],
  ...o,
});

test('a release: its version and its APK; none without an APK, a version, or as a draft', () => {
  assert.deepEqual(fromRelease(release()), {
    version: '3.0.1', url: 'https://github.com/x/Flow-3.0.1.apk', size: 12345, page: 'https://github.com/Ceeser1/Flow/releases/tag/v3.0.1',
  });
  assert.equal(fromRelease(release({ assets: [] })), null);
  assert.equal(fromRelease(release({ tag_name: 'latest' })), null);
  assert.equal(fromRelease(release({ draft: true })), null);
  assert.equal(fromRelease(release({ prerelease: true })), null);
});

test('GitHub asked: the newest release; not found (private, none yet) is none; unreachable rejects', async () => {
  let asked = '';
  const answer = (status, body) => async (url) => {
    asked = url;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  assert.equal((await latestRelease(answer(200, release()))).version, '3.0.1');
  assert.equal(asked, LATEST);
  assert.equal(await latestRelease(answer(404, { message: 'Not Found' })), null);
  await assert.rejects(latestRelease(answer(403, {})), /answered 403/);
  await assert.rejects(latestRelease(async () => { throw new TypeError('Failed to fetch'); }), /could not be reached/);
});
