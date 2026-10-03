'use strict';

// SponsorBlock: which video a song is, and the API's segments as the trim
// editor draws them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { videoId, parseSegments } = require('../src/sponsorblock');

test('the video id comes from a YouTube source key, else from the link', () => {
  assert.equal(videoId('youtube:kJQP7kiw5Fk'), 'kJQP7kiw5Fk');
  assert.equal(videoId('', 'https://youtu.be/kJQP7kiw5Fk?si=abc'), 'kJQP7kiw5Fk');
  assert.equal(videoId('', 'https://www.youtube.com/watch?v=kJQP7kiw5Fk&list=x'), 'kJQP7kiw5Fk');
  assert.equal(videoId('soundcloud:123', 'https://soundcloud.com/a/b'), '');
  assert.equal(videoId('', ''), '');
});

test('segments: sponsors and intros sorted by start, anything else or broken left out', () => {
  const list = parseSegments([
    { category: 'music_offtopic', segment: [249.38, 281.5] },
    { category: 'sponsor', segment: [30, 45] },
    { category: 'intro', segment: [-0.2, 5] },
    { category: 'filler', segment: [60, 70] },
    { category: 'outro', segment: [90, 80] },
    { category: 'selfpromo', segment: ['x', 10] },
    null,
  ]);
  assert.deepEqual(list, [
    { start: 0, end: 5, category: 'intro', kind: 'intro' },
    { start: 30, end: 45, category: 'sponsor', kind: 'sponsor' },
    { start: 249.38, end: 281.5, category: 'music_offtopic', kind: 'intro' },
  ]);
  assert.deepEqual(parseSegments(undefined), []);
});
