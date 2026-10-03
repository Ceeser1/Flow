'use strict';

// What the shared Flow Server client (@flow/core/client/remote) gets from the
// desktop app: files and requests through Node, secrets through Electron's
// safeStorage, the PC's name, and the app's own settings, library and covers.

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { safeStorage } = require('electron');
const paths = require('./paths');
const settings = require('./settings');
const library = require('./library');
const exporter = require('./exporter');
const network = require('./network');
const covers = require('./covers');
const { coverVersion } = require('@flow/core/cover');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const discovery = require('@flow/core/discovery');
const { OfflineError } = require('@flow/core/client/common');

// ---- the passwords and PINs, kept encrypted ----

function encrypt(text) {
  if (!text) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return 'e:' + safeStorage.encryptString(String(text)).toString('base64');
  } catch {
    // Fall through.
  }
  return 'p:' + Buffer.from(String(text)).toString('base64');
}

function decrypt(stored) {
  const s = String(stored || '');
  try {
    if (s.startsWith('e:')) return safeStorage.decryptString(Buffer.from(s.slice(2), 'base64'));
    if (s.startsWith('p:')) return Buffer.from(s.slice(2), 'base64').toString('utf8');
  } catch {
    // Encrypted by another Windows user or machine: as good as none.
  }
  return '';
}

// ---- talking to the server ----

/**
 * One request. `body` may be JSON (`json`) or a file (`file`, streamed up);
 * `saveTo` streams the answer into a file. Resolves { status, json }.
 * Unreachable, timed out or cut off: OfflineError.
 */
function request(base, pathname, { method = 'GET', json, file, saveTo, token, timeout = 15000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(base + pathname);
    } catch {
      reject(new Error('That is not an address.'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload = null;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    } else if (file) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = fs.statSync(file).size;
    }
    const req = lib.request(url, { method, headers }, (res) => {
      if (saveTo && res.statusCode === 200) {
        const out = fs.createWriteStream(saveTo);
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (onProgress && total) onProgress(got / total);
        });
        res.pipe(out);
        out.on('finish', () => {
          if (total && got !== total) reject(new OfflineError('The download was cut off.'));
          else resolve({ status: 200, json: null });
        });
        out.on('error', (err) => reject(err));
        res.on('aborted', () => {
          out.destroy();
          reject(new OfflineError('The download was cut off.'));
        });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }
        resolve({ status: res.statusCode, json: body });
      });
      res.on('aborted', () => reject(new OfflineError('The connection was cut off.')));
    });
    req.setTimeout(timeout, () => req.destroy(new OfflineError('The server did not answer in time.')));
    req.on('error', (err) => reject(err instanceof OfflineError ? err : new OfflineError(err.message)));
    if (payload) req.end(payload);
    else if (file) {
      const stream = fs.createReadStream(file);
      const total = headers['Content-Length'] || 0;
      let sent = 0;
      stream.on('data', (c) => {
        sent += c.length;
        if (onProgress && total) onProgress(sent / total);
      });
      stream.on('error', (err) => req.destroy(err));
      stream.pipe(req);
    } else req.end();
  });
}

/**
 * A stream that stays open (the live channel, Server-Sent Events).
 * on.response(status) says whether to read the answer; on.data(text) as it
 * comes; on.lost() once it ends or fails. close(reason): with a reason it
 * counts as lost, without one it is quiet.
 */
function stream(url, { headers }, on) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const req = lib.request(u, { headers });
  req.on('response', (res) => {
    if (!on.response(res.statusCode)) {
      res.resume();
      return;
    }
    res.setEncoding('utf8');
    res.on('data', (chunk) => on.data(chunk));
    res.on('end', () => on.lost());
    res.on('aborted', () => on.lost());
    res.on('error', () => on.lost());
  });
  req.on('error', () => on.lost());
  req.end();
  return { close: (reason) => req.destroy(reason) };
}

// ---- files ----

const rootFile = (name) => path.join(paths.ensure(paths.rootDir()), name);

/** Each Flow Server's covers, by server id: the folders under Covers but Local Files' own. */
function coverServerIds() {
  let names = [];
  try {
    names = fs.readdirSync(paths.coversDir(), { withFileTypes: true });
  } catch {
    names = [];
  }
  return names.filter((e) => e.isDirectory() && e.name !== covers.LOCAL).map((e) => e.name);
}

module.exports = {
  settings,
  library,
  covers: {
    dirOf: covers.dirOf,
    storeOf: covers.storeOf,
    localStore: covers.localStore,
    copyToLocal: covers.copyToLocal,
    copyToServer: covers.copyToServer,
    tell: covers.tell,
    versionOf: coverVersion,
    serverIds: coverServerIds,
    removeServer: (id) => fs.rmSync(path.join(paths.coversDir(), id), { recursive: true, force: true }),
  },
  // The client's own files (server-library.json, server-sync.json, server-trims.json).
  jsonFiles: {
    read: (name) => readJson(rootFile(name)),
    write: (name, value) => writeJsonAtomic(rootFile(name), value),
  },
  files: {
    exists: (file) => fs.existsSync(file),
    rm: (file, opts) => fs.rmSync(file, opts),
    rename: (from, to) => fs.renameSync(from, to),
    read: (file) => fs.readFileSync(file),
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    join: path.join,
    dirname: path.dirname,
    extname: path.extname,
  },
  paths: { musicDir: paths.musicDir, cacheDir: paths.cacheDir },
  exporter: { uniquePath: exporter.uniquePath, trimSong: exporter.trimSong },
  http: { request, stream },
  secrets: { encrypt, decrypt },
  device: { name: () => os.hostname() },
  discovery: {
    find: () => discovery.find(),
    addressOf: (found) => discovery.addressOf(found, os.networkInterfaces()),
  },
  network: { isMetered: () => network.isMetered() },
};
