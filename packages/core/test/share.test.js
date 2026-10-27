'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeLink, parseLink } = require('../src/client/share');

test('a shared server\'s link: made and read back, localhost and junk left out', () => {
  const link = makeLink({
    id: 'a1b2c3d4e5f6a7b8c9d0e1f2', name: 'Küche & Wohnzimmer', home: '192.168.0.61:7878', remote: 'https://music.example.com', code: 'ABCD2345XY',
  });
  assert.match(link, /^flow:\/\/connect\?v=1&/);
  assert.deepEqual(parseLink(`  ${link}\n`), {
    id: 'a1b2c3d4e5f6a7b8c9d0e1f2', name: 'Küche & Wohnzimmer', home: '192.168.0.61:7878', remote: 'https://music.example.com', code: 'ABCD2345XY',
  });
  assert.equal(parseLink(makeLink({ home: 'localhost:7878', remote: '100.64.1.2:7878' })).home, '');
  assert.equal(parseLink(makeLink({ home: 'localhost:7878' })), null, 'nowhere to go');
  assert.equal(parseLink('https://example.com'), null);
});

test('an address with spaces is no address', () => {
  assert.equal(parseLink('flow://connect?home=bad%20address'), null);
});
