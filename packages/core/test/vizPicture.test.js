'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { typeOf, isVideo, check, keptBefore } = require('../src/client/vizPicture');

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46];
const MP4 = [0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d];
const WEBM = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81];
const bytes = (head, size = head.length) => {
  const b = new Uint8Array(size);
  b.set(head);
  return b;
};

test('a picture or a video by its first bytes', () => {
  assert.equal(typeOf(bytes(PNG)), 'png');
  assert.equal(typeOf(bytes(JPEG)), 'jpg');
  assert.equal(typeOf(bytes(MP4)), 'mp4');
  assert.equal(typeOf(bytes(WEBM)), 'webm');
  assert.equal(typeOf(bytes([1, 2])), 'jpg');
  assert.equal(typeOf(null), 'jpg');
  assert.deepEqual(['png', 'jpg', 'mp4', 'webm'].map(isVideo), [false, false, true, true]);
});

test('a picture up to 30 MB, a video up to the most given', () => {
  assert.equal(check('halo-background', bytes(MP4, 50e6), 60), 'mp4');
  assert.throws(() => check('halo-background', bytes(MP4, 61e6), 60), /Too big/);
  assert.equal(check('halo-background', bytes(WEBM, 61e6), 300), 'webm');
  assert.equal(check('halo-cover', bytes(PNG, 30e6), 60), 'png');
  assert.throws(() => check('halo-cover', bytes(JPEG, 30e6 + 1), 300), /Too big/);
});

test('a name of letters, digits and dashes, and some bytes', () => {
  assert.throws(() => check('../halo', bytes(PNG), 60), /name/);
  assert.throws(() => check('', bytes(PNG), 60), /name/);
  assert.throws(() => check('halo', new Uint8Array(0), 60), /Not a picture/);
  assert.throws(() => check('halo', [1, 2, 3], 60), /Not a picture/);
});

test('a new one takes the place of what was kept under its name, of any type', () => {
  assert.ok(keptBefore('halo-background-mvq7p4uk.jpg', 'halo-background'));
  assert.ok(keptBefore('halo-background-mvq7p4uk.mp4', 'halo-background'));
  assert.ok(keptBefore('halo-background-mvq7p4uk.webm', 'halo-background'));
  assert.ok(!keptBefore('halo-cover-mvq7p4uk.png', 'halo-background'));
  assert.ok(!keptBefore('halo-background-notes.txt', 'halo-background'));
});
