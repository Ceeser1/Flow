'use strict';

// Talking to a Flow Server from the phone (env.http of the shared client):
// requests through the page's fetch (the server allows any origin), a file
// saved straight to storage by FlowNative.download, and the live channel read
// as a stream (EventSource cannot send the token).

const { OfflineError } = require('@flow/core/client/common');
const { plugin } = require('./native');

let downloads = 0;
const progress = new Map(); // download id -> onProgress
plugin.addListener('downloadProgress', ({ id, frac }) => {
  const fn = progress.get(id);
  if (fn) fn(frac);
});

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * One request, as the desktop's (apps/desktop/src/env.js): JSON (`json`) up,
 * or the answer saved into a file (`saveTo`). Resolves { status, json }.
 * Unreachable, timed out or cut off: OfflineError.
 */
async function request(base, pathname, { method = 'GET', json, file, saveTo, token, timeout = 15000, onProgress } = {}) {
  let url;
  try {
    url = new URL(base + pathname);
  } catch {
    throw new Error('That is not an address.');
  }
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Songs go up from the phone once it keeps songs of its own (Local Files on Android).
  if (file) throw new Error('Uploading from the phone is not possible yet.');

  if (saveTo) {
    const id = onProgress ? `d${(downloads += 1)}` : '';
    if (id) progress.set(id, onProgress);
    try {
      const r = await plugin.download({ url: url.href, headers, path: saveTo, timeout: Math.max(timeout, 30000), id });
      return { status: r.status, json: r.status === 200 ? null : parse(r.text) };
    } catch (err) {
      throw err && err.code === 'OFFLINE' ? new OfflineError(err.message) : err;
    } finally {
      if (id) progress.delete(id);
    }
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const init = { method, headers, signal: ctl.signal, cache: 'no-store' };
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(url.href, init);
    const text = await res.text();
    return { status: res.status, json: parse(text) };
  } catch (err) {
    throw new OfflineError(ctl.signal.aborted ? 'The server did not answer in time.' : (err && err.message) || 'The server cannot be reached.');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stream that stays open (the live channel, Server-Sent Events).
 * on.response(status) says whether to read the answer; on.data(text) as it
 * comes; on.lost() once it ends or fails. close(reason): with a reason it
 * counts as lost, without one it is quiet.
 */
function stream(url, { headers }, on) {
  const ctl = new AbortController();
  let quiet = false;
  let ended = false;
  const lost = () => {
    if (ended || quiet) return;
    ended = true;
    on.lost();
  };
  (async () => {
    try {
      const res = await fetch(url, { headers, signal: ctl.signal, cache: 'no-store' });
      if (!on.response(res.status)) {
        ended = true;
        ctl.abort();
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        on.data(decoder.decode(value, { stream: true }));
      }
      lost();
    } catch {
      lost();
    }
  })();
  return {
    close: (reason) => {
      if (!reason) quiet = true;
      ctl.abort();
      if (reason) lost();
    },
  };
}

module.exports = { request, stream };
