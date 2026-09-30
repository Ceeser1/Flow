'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../src/discovery');

test('only the apps question is taken for a question', () => {
  assert.equal(d.isRequest(d.REQUEST), true);
  assert.equal(d.isRequest(Buffer.from('hello')), false);
  assert.equal(d.isRequest(Buffer.from('{"app":"other","v":1}')), false);
  assert.equal(d.isRequest(Buffer.alloc(5000, 1)), false);
  assert.equal(d.isRequest(null), false);
});

test('an answer carries the port, and the sender is the address', () => {
  const reply = d.makeReply({ id: 'abc123', name: 'Pi', port: 7878, protocol: 1 });
  assert.deepEqual(d.parseReply(reply, '192.168.0.61'), { ip: '192.168.0.61', port: 7878, name: 'Pi', id: 'abc123', protocol: 1 });
  assert.equal(d.parseReply(Buffer.from('{"app":"x","port":7878}'), '192.168.0.61'), null);
  assert.equal(d.parseReply(Buffer.from('{"app":"flow-server","port":0}'), '192.168.0.61'), null);
  assert.equal(d.parseReply(Buffer.from('nonsense'), '192.168.0.61'), null);
  assert.equal(d.parseReply(reply, ''), null);
});

test('each network gets its own broadcast address, and one-host networks none', () => {
  const list = d.broadcastAddresses({
    lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    eth0: [{ family: 'IPv4', address: '192.168.0.61', netmask: '255.255.255.0', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    wifi: [{ family: 'IPv4', address: '10.1.130.9', netmask: '255.255.192.0', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.90.1.2', netmask: '255.255.255.255', internal: false }],
  });
  assert.deepEqual(list.sort(), ['10.1.191.255', '192.168.0.255', '255.255.255.255']);
});
