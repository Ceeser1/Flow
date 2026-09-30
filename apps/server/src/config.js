'use strict';

// Where the server keeps its things, and server.json: the port, the name the
// apps show, the music folder, the password, the profiles (their names and
// PINs; what is in them is in library.json), whether the apps may find it on
// the network by themselves, and the devices signed in.
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
  const pw = secret(r.password);
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

module.exports = { open, defaultHome, hashPassword, checkPassword, hashToken, DEFAULT_PORT };
