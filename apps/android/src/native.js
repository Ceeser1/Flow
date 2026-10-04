'use strict';

// The phone as the page reaches it: window.FlowSync (FlowSync.java) for what
// must answer at once, as Node's files do on the desktop, and the FlowNative
// plugin (FlowNative.java) for what takes a while.

const { registerPlugin, Capacitor } = require('@capacitor/core');

const plugin = registerPlugin('FlowNative');

function sync() {
  if (!globalThis.FlowSync) throw new Error('This only works in Flow\'s Android app.');
  return globalThis.FlowSync;
}

/** A change FlowSync made answers "" when done, else what went wrong. */
function done(result) {
  if (result) throw new Error(result);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

// Paths on the phone are plain POSIX ones.
const path = {
  join: (...parts) => parts.filter((p) => p !== '').join('/').replace(/\/{2,}/g, '/'),
  dirname: (p) => {
    const i = String(p).lastIndexOf('/');
    return i <= 0 ? (i === 0 ? '/' : '.') : String(p).slice(0, i);
  },
  extname: (p) => {
    const name = String(p).slice(String(p).lastIndexOf('/') + 1);
    const i = name.lastIndexOf('.');
    return i <= 0 ? '' : name.slice(i);
  },
};

const fs = {
  /** The file's text, or null when it is not there. */
  readText: (p) => sync().readText(p),
  writeText: (p, text) => done(sync().writeText(p, text)),
  /** The file's bytes (Uint8Array), or null. */
  readBytes: (p) => {
    const b64 = sync().readBase64(p);
    return b64 == null ? null : fromBase64(b64);
  },
  writeBytes: (p, bytes) => done(sync().writeBase64(p, toBase64(bytes))),
  exists: (p) => !!sync().exists(p),
  /** Bytes, -1 when it is not there. */
  size: (p) => Number(sync().size(p)),
  mkdir: (p) => done(sync().mkdir(p)),
  remove: (p, { recursive = false } = {}) => done(sync().remove(p, !!recursive)),
  rename: (from, to) => done(sync().rename(from, to)),
  copy: (from, to) => done(sync().copy(from, to)),
  /** [{ name, size, dir }] */
  list: (p) => JSON.parse(sync().list(p) || '[]'),
  sha1: (p) => sync().sha1(p) || '',
};

/** { files, cache, device, sdk } */
function info() {
  return JSON.parse(sync().info() || '{}');
}

const secrets = {
  encrypt: (text) => (text ? sync().encrypt(String(text)) : ''),
  decrypt: (stored) => (stored ? sync().decrypt(String(stored)) : ''),
};

const isMetered = () => !!sync().isMetered();

/** A file in the app's storage as an address the page can load (an <img>, an <audio>). */
const fileUrl = (p) => Capacitor.convertFileSrc(p);

module.exports = {
  plugin, fs, path, info, secrets, isMetered, fileUrl, toBase64, fromBase64,
};
