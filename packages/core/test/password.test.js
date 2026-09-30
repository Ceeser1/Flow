'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLevel, isStrongPassword, passwordProblem } = require('../src/password');

test('levels 1 and 2 take a PIN of 4 or more', () => {
  assert.equal(passwordProblem('4711', 1), '');
  assert.equal(passwordProblem('secret', 2), '');
  assert.match(passwordProblem('471', 1), /at least 4/);
  assert.match(passwordProblem('   ', 2), /empty/);
  assert.equal(passwordProblem('4711'), '', 'no level is level 1');
});

test('from level 3 on the password needs 8 characters, both cases and a number', () => {
  assert.equal(passwordProblem('Portis8head', 3), '');
  assert.equal(passwordProblem('aB3defgh', 4), '');
  assert.equal(passwordProblem('4711', 3), 'A server reachable from the internet needs a password with at least 8 characters, a lower-case letter and an upper-case letter.');
  assert.match(passwordProblem('portishead1', 3), /with an upper-case letter\.$/);
  assert.match(passwordProblem('Portishead', 3), /with a number\.$/);
  assert.equal(isStrongPassword('Portis8head'), true);
  assert.equal(isStrongPassword('portis8head'), false);
  assert.equal(isStrongPassword(''), false);
});

test('a level is 1 to 4', () => {
  assert.equal(parseLevel('3'), 3);
  assert.equal(parseLevel(4), 4);
  assert.equal(parseLevel(0), null);
  assert.equal(parseLevel('five'), null);
});
