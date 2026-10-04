'use strict';

// A share's link (src/share.js), as apps share them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sharedLink } = require('../src/share');

test('a link alone', () => {
  assert.deepEqual(sharedLink({ text: 'https://youtu.be/abc123?si=xyz' }), { url: 'https://youtu.be/abc123?si=xyz', text: 'https://youtu.be/abc123?si=xyz' });
});

test('the first link in a sentence, without its full stop or brackets', () => {
  assert.equal(sharedLink({ text: 'Listen to Air on Flow: https://open.spotify.com/track/1a2b. Also https://example.com' }).url, 'https://open.spotify.com/track/1a2b');
  assert.equal(sharedLink({ text: 'Natural Blues (https://www.youtube.com/watch?v=zz)' }).url, 'https://www.youtube.com/watch?v=zz');
});

test('a link only in the subject', () => {
  assert.equal(sharedLink({ text: 'Have a listen', subject: 'http://music.example/s/1' }).url, 'http://music.example/s/1');
});

test('nothing with a link', () => {
  assert.deepEqual(sharedLink({ text: 'Moby - Porcelain' }), { url: '', text: 'Moby - Porcelain' });
  assert.deepEqual(sharedLink(null), { url: '', text: '' });
  assert.equal(sharedLink({ text: 'ftp://files.example/a.mp3' }).url, '');
});
