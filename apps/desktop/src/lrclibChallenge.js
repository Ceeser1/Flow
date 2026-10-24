'use strict';

// LRCLIB's proof of work before it takes lyrics (@flow/core/lyrics
// publishLyrics): the first nonce counting up from 0 whose
// sha256(prefix + nonce), read as a number, is no bigger than the target.
// Millions of hashes: in a worker thread, so the app keeps going meanwhile.

const { Worker } = require('worker_threads');

const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const target = Buffer.from(workerData.target, 'hex');
for (let n = 0; ; n++) {
  const hash = crypto.createHash('sha256').update(workerData.prefix + n).digest();
  if (Buffer.compare(hash, target) <= 0) {
    parentPort.postMessage(String(n));
    break;
  }
}
`;

// Given up on after this long (LRCLIB's challenges take seconds to a minute).
const LIMIT_MS = 10 * 60 * 1000;

/** The nonce for LRCLIB's challenge ({ prefix, target }, target in hex). */
function solveChallenge(prefix, target, { limitMs = LIMIT_MS } = {}) {
  if (!/^[0-9a-f]{2,128}$/i.test(String(target)) || String(target).length % 2) {
    return Promise.reject(new Error('LRCLIB sent a challenge Flow cannot read.'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { prefix: String(prefix), target: String(target) } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('LRCLIB\'s challenge took too long. Try again later.'));
    }, limitMs);
    worker.once('message', (nonce) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(nonce);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { solveChallenge };
