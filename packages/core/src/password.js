'use strict';

// How far a Flow Server can be reached, and what its password has to be for
// that. The server checks it when one is set, and the apps can say what is
// missing before sending it.
//
//   1  the home network only
//   2  and away from home through Tailscale
//   3  and from the internet, through Caddy set up by the installer
//   4  and from the internet, through a proxy or tunnel set up by hand
//
// Up to level 2 a password is optional; one that is set has at least 4
// characters (a 4-digit PIN). From level 3 on, anyone on the internet can try
// it, so it is required and has at least 8 characters with a lower-case
// letter, an upper-case letter and a digit. Profile PINs are not this: they
// only pick a profile on a server already signed in to.

const LEVELS = [1, 2, 3, 4];
const PUBLIC_LEVEL = 3;
const MIN_PIN = 4;
const MIN_PUBLIC = 8;

const LEVEL_NAMES = {
  1: 'home network only',
  2: 'home network and Tailscale',
  3: 'the internet, through Caddy',
  4: 'the internet, through your own proxy',
};

/** A level as given (a number or text), or null for nonsense. */
function parseLevel(value) {
  const n = Number(value);
  return LEVELS.includes(n) ? n : null;
}

/** Good enough for a server reachable from the internet. */
function isStrongPassword(password) {
  const p = String(password || '');
  return p.length >= MIN_PUBLIC && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p);
}

/** Why `password` can't be the server's password at `level`, or '' when it can. */
function passwordProblem(password, level = 1) {
  const p = String(password || '');
  if (!p.trim()) return 'The PIN or password cannot be empty.';
  if ((parseLevel(level) || 1) < PUBLIC_LEVEL) {
    return p.length >= MIN_PIN ? '' : `A PIN or password needs at least ${MIN_PIN} characters.`;
  }
  const missing = [];
  if (p.length < MIN_PUBLIC) missing.push(`at least ${MIN_PUBLIC} characters`);
  if (!/[a-z]/.test(p)) missing.push('a lower-case letter');
  if (!/[A-Z]/.test(p)) missing.push('an upper-case letter');
  if (!/[0-9]/.test(p)) missing.push('a number');
  if (!missing.length) return '';
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0];
  return `A server reachable from the internet needs a password with ${list}.`;
}

module.exports = { LEVELS, PUBLIC_LEVEL, LEVEL_NAMES, parseLevel, isStrongPassword, passwordProblem };
