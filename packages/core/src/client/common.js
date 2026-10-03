'use strict';

// What the shared client and each app's env both use: the two ways a request
// to a Flow Server fails, and random ids. No Node: this runs in the Android
// app's WebView too.

/** The server cannot be reached, did not answer in time, or its answer was cut off. */
class OfflineError extends Error {}

/** The server wants its password (again), or the sign-in has ended. */
class AuthError extends Error {}

function randomBytes(count) {
  const buf = new Uint8Array(count);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/** `bytes` random bytes as hex. */
function randomHex(bytes) {
  return Array.from(randomBytes(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes as base64url, without padding (as Node's Buffer writes it). */
function base64Url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    const chars = Math.ceil((Math.min(3, bytes.length - i) * 8) / 6);
    for (let k = 0; k < chars; k += 1) out += B64URL[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

/** `bytes` random bytes as base64url. */
function randomBase64Url(bytes) {
  return base64Url(randomBytes(bytes));
}

module.exports = {
  OfflineError, AuthError, randomHex, base64Url, randomBase64Url,
};
