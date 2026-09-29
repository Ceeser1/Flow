'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { serverBaseUrl } = require('../src/address');

test('a server address as typed becomes the base for its requests', () => {
  assert.equal(serverBaseUrl('192.168.0.63:7878'), 'http://192.168.0.63:7878');
  assert.equal(serverBaseUrl(' 192.168.0.63 '), 'http://192.168.0.63:7878');
  assert.equal(serverBaseUrl('flow.example.com'), 'http://flow.example.com:7878');
  assert.equal(serverBaseUrl('https://flow.example.com'), 'https://flow.example.com');
  assert.equal(serverBaseUrl('https://example.com/flow/'), 'https://example.com/flow');
  assert.equal(serverBaseUrl('http://pi.local:8000'), 'http://pi.local:8000');
  assert.equal(serverBaseUrl(''), '');
  assert.throws(() => serverBaseUrl('http://'));
});
