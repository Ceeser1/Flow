'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  serverBaseUrl, meansHttps, completeAddress, isTailscaleAddress, isPrivateIp,
} = require('../src/address');

test('a server address as typed becomes the base for its requests', () => {
  assert.equal(serverBaseUrl('192.168.0.63:7878'), 'http://192.168.0.63:7878');
  assert.equal(serverBaseUrl(' 192.168.0.63 '), 'http://192.168.0.63:7878');
  assert.equal(serverBaseUrl('flow.example.com'), 'https://flow.example.com');
  assert.equal(serverBaseUrl('ceeser.de/flow'), 'https://ceeser.de/flow');
  assert.equal(serverBaseUrl('flow.example.com:7878'), 'http://flow.example.com:7878');
  assert.equal(serverBaseUrl('raspberrypi'), 'http://raspberrypi:7878');
  assert.equal(serverBaseUrl('http://flow.example.com'), 'http://flow.example.com:7878');
  assert.equal(serverBaseUrl('https://flow.example.com'), 'https://flow.example.com');
  assert.equal(serverBaseUrl('https://example.com/flow/'), 'https://example.com/flow');
  assert.equal(serverBaseUrl('http://pi.local:8000'), 'http://pi.local:8000');
  assert.equal(serverBaseUrl(''), '');
  assert.throws(() => serverBaseUrl('http://'));
});

test('without http:// or https://, a website\'s name means https, a server at home plain http', () => {
  for (const a of ['ceeser.de', 'ceeser.de/flow', 'flow-test.duckdns.org', 'music.example.com:443', 'Music.Example.com/flow/', 'flow.example.com?x=1']) {
    assert.equal(meansHttps(a), true, a);
  }
  for (const a of ['192.168.0.61:7878', '192.168.0.61', '[fd7a::1]:7878', 'fe80::1', 'localhost', 'localhost:7878', 'raspberrypi',
    'pi.local', 'pi.lan', 'pi.home.arpa', 'pi.tail1234.ts.net', 'flow.example.com:7878', 'flow.example.com:80', '100.101.102.103',
    'http://ceeser.de', 'https://ceeser.de', '', '   ']) {
    assert.equal(meansHttps(a), false, a);
  }
  assert.equal(completeAddress(' ceeser.de/flow '), 'https://ceeser.de/flow');
  assert.equal(completeAddress('192.168.0.61:7878'), '192.168.0.61:7878');
  assert.equal(completeAddress('http://ceeser.de/flow'), 'http://ceeser.de/flow');
  assert.equal(completeAddress(''), '');
});

test('Tailscale addresses are told apart from the rest', () => {
  assert.equal(isTailscaleAddress('100.101.102.103:7878'), true);
  assert.equal(isTailscaleAddress('http://100.64.0.1'), true);
  assert.equal(isTailscaleAddress('100.127.255.254'), true);
  assert.equal(isTailscaleAddress('pi.tail1234.ts.net'), true);
  assert.equal(isTailscaleAddress('https://pi.tail1234.ts.net/flow'), true);
  assert.equal(isTailscaleAddress('100.63.0.1'), false);
  assert.equal(isTailscaleAddress('100.128.0.1'), false);
  assert.equal(isTailscaleAddress('192.168.0.61:7878'), false);
  assert.equal(isTailscaleAddress('flow.example.com'), false);
  assert.equal(isTailscaleAddress(''), false);
});

test('private addresses: the network at home, the loopback and the tailnet', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '10.1.2.3', '192.168.0.4', '172.16.0.1', '172.31.9.9', '100.100.1.1', 'fd7a:115c::1', 'fe80::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.63.0.1', '203.0.113.7', '2001:db8::1', '', undefined]) {
    assert.equal(isPrivateIp(ip), false, String(ip));
  }
});
