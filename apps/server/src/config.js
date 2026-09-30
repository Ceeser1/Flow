'use strict';

// Where the server keeps its things, and server.json: the port, the name the
// apps show, the music folder, the password, the profiles (their names and
// PINs; what is in them is in library.json), whether the apps may find it on
// the network by themselves, how far it can be reached (its level, public
// address and trusted proxies), and the devices signed in.
//
//   home   FLOW_SERVER_HOME, else ~/.local/share/flow-server on Linux
//          (XDG_DATA_HOME when set) and %LOCALAPPDATA%\Flow\server on Windows.
//   music  FLOW_SERVER_MUSIC, else the musicDir in server.json, else ~/flow-music.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { DEFAULT_PORT } = require('@flow/core/address');
const { parseLevel, isStrongPassword } = require('@flow/core/password');

function defaultHome() {
  if (process.env.FLOW_SERVER_HOME) return process.env.FLOW_SERVER_HOME;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Flow', 'server');
  }
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'flow-server');
}

function clean(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const port = Math.round(Number(r.port));
  const secret = (v) => (v && typeof v === 'object' && v.salt && v.hash ? { salt: String(v.salt), hash: String(v.hash) } : null);
  // The hash can't say how good the password was, so that is kept with it:
  // from level 3 on only a strong one lets anyone in.
  const pw = secret(r.password) && { ...secret(r.password), strong: r.password.strong === true };
  const publicUrl = /^https:\/\/[^\s/?#]+[^\s?#]*$/i.test(String(r.publicUrl || '')) ? String(r.publicUrl).replace(/\/+$/, '') : '';
  const profiles = [];
  for (const p of Array.isArray(r.profiles) ? r.profiles : []) {
    if (!p || !/^[\w-]{1,64}$/.test(String(p.id || '')) || !String(p.name || '').trim()) continue;
    if (profiles.some((x) => x.id === p.id)) continue;
    profiles.push({ id: String(p.id), name: String(p.name).trim().slice(0, 40), createdAt: Number(p.createdAt) || Date.now(), pin: secret(p.pin) });
  }
  const profileIds = new Set(profiles.map((p) => p.id));
  return {
    // Tells the apps it is still the same server when its address changes,
    // and a different one when the same address now leads elsewhere.
    id: /^[0-9a-f]{16,64}$/.test(String(r.id || '')) ? String(r.id) : crypto.randomBytes(12).toString('hex'),
    port: port > 0 && port < 65536 ? port : DEFAULT_PORT,
    name: String(r.name || os.hostname() || 'Flow Server').slice(0, 60),
    musicDir: typeof r.musicDir === 'string' ? r.musicDir : '',
    // Answering the apps' search on the local network (discovery.js): off
    // until asked for.
    discovery: r.discovery === true,
    // How far the server can be reached (@flow/core/password): the installer
    // says, from 1 (home network) to 4 (the internet through your own proxy).
    // null: never said (a server from before levels), which counts as 1 for
    // the password and still tells the apps its Tailscale address.
    level: parseLevel(r.level),
    // Levels 3 and 4: the https address the apps use from outside, which
    // they are told so they can fill it in.
    publicUrl,
    // Proxies on other machines whose X-Forwarded-For is believed; one on
    // this machine always is.
    trustedProxies: (Array.isArray(r.trustedProxies) ? r.trustedProxies : [])
      .map((a) => String(a || '').trim().toLowerCase().replace(/^::ffff:/, ''))
      .filter((a) => /^[0-9a-f.:]{2,45}$/.test(a))
      .slice(0, 16),
    password: pw,
    profiles,
    tokens: (Array.isArray(r.tokens) ? r.tokens : [])
      .filter((t) => t && t.hash)
      .map((t) => ({
        hash: String(t.hash),
        device: String(t.device || '').slice(0, 80),
        createdAt: Number(t.createdAt) || Date.now(),
        lastSeenAt: Number(t.lastSeenAt) || 0,
        // The profile this device is signed in to; null: none.
        profileId: profileIds.has(t.profileId) ? String(t.profileId) : null,
      })),
  };
}

/** The server's config and folders. `opts` overrides (tests, command line). */
function open(opts = {}) {
  const home = path.resolve(opts.home || defaultHome());
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, 'server.json');
  let config = clean(readJson(file));
  const musicDir = path.resolve(opts.music || process.env.FLOW_SERVER_MUSIC || config.musicDir
    || path.join(os.homedir(), 'flow-music'));
  fs.mkdirSync(musicDir, { recursive: true });

  const save = () => writeJsonAtomic(file, config);
  save();

  return {
    home,
    musicDir,
    libraryFile: path.join(home, 'library.json'),
    stateFile: path.join(home, 'state.json'),
    get: () => config,
    set(patch) {
      config = clean({ ...config, ...patch });
      save();
      return config;
    },
  };
}

// ---- the password ----
//
// Kept as a scrypt hash. Signing in with it gives a device a token, which is
// what every later request carries; the token is kept as a hash too, so
// server.json never holds anything that gets in by itself.

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

/** The server password as server.json keeps it: its hash, and whether it was strong. */
function passwordEntry(password) {
  return { ...hashPassword(password), strong: isStrongPassword(password) };
}

function checkPassword(stored, password) {
  if (!stored) return true;
  const { hash } = hashPassword(password, stored.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(stored.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { open, defaultHome, hashPassword, passwordEntry, checkPassword, hashToken, DEFAULT_PORT };
