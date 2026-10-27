'use strict';

// LRCLIB's proof of work (4.0.1): the first nonce whose sha256 is no bigger than the target.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { solveChallenge } = require('../src/lrclibChallenge');

const hash = (s) => crypto.createHash('sha256').update(s).digest();

test('the nonce answers the challenge, and is the first that does', async () => {
  // A target with two zero bytes in front: some tens of thousands of tries.
  const target = `0000${'f'.repeat(60)}`;
  const nonce = await solveChallenge('flow-test-', target);
  assert.ok(Buffer.compare(hash(`flow-test-${nonce}`), Buffer.from(target, 'hex')) <= 0);
  for (let n = 0; n < Number(nonce); n++) assert.ok(Buffer.compare(hash(`flow-test-${n}`), Buffer.from(target, 'hex')) > 0);
  assert.equal(await solveChallenge('x', 'ff'.repeat(32)), '0', 'anything goes: the first');
  await assert.rejects(() => solveChallenge('x', 'nothex'), /cannot read/);
  await assert.rejects(() => solveChallenge('x', '00'.repeat(32), { limitMs: 50 }), /too long/);
});
