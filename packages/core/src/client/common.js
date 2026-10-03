'use strict';

// What the shared client and each app's env both use: the two ways a request
// to a Flow Server fails, and random ids. No Node: this runs in the Android
// app's WebView too.

/** The server cannot be reached, did not answer in time, or its answer was cut off. */
class OfflineError extends Error {}

/** The server wants its password (again), or the sign-in has ended. */
class AuthError extends Error {}

/** `bytes` random bytes as hex. */
function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

module.exports = { OfflineError, AuthError, randomHex };
