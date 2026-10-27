'use strict';

// Sharing a server by QR code (4.0): an app that knows the server's password
// asks for a pairing code (POST /api/pair, with the password it has); the code
// goes into the QR code instead of the password. The app that scans it trades
// the code once for the password (POST /api/pair/redeem), within 10 minutes.
// The server keeps the password only as a hash, so the sharing app hands it
// over for that while; nothing of it is written anywhere.

const crypto = require('crypto');

const LIFE_MS = 10 * 60 * 1000;
const MAX_OPEN = 20;
// No 0/O, 1/I/L: read out loud or typed, they are not mixed up.
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LENGTH = 10;

function createPairing({ now = Date.now } = {}) {
  const open = new Map(); // code -> { password, until }

  function sweep() {
    const t = now();
    for (const [code, p] of open) if (p.until <= t) open.delete(code);
  }

  /** A new code that gives `password` once. */
  function create(password) {
    sweep();
    while (open.size >= MAX_OPEN) open.delete(open.keys().next().value);
    let code = '';
    const bytes = crypto.randomBytes(LENGTH);
    for (const b of bytes) code += LETTERS[b % LETTERS.length];
    open.set(code, { password: String(password || ''), until: now() + LIFE_MS });
    return code;
  }

  /** The password for a code, once; null for a code used, too old or never made. */
  function redeem(code) {
    sweep();
    const key = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const p = open.get(key);
    if (!p) return null;
    open.delete(key);
    return p.password;
  }

  return { create, redeem, LIFE_MS };
}

module.exports = { createPairing, LIFE_MS };
