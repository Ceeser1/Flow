'use strict';

// Talking to a Flow Server from the browser (env.http of the shared client):
// every request through the page's fetch, straight to the server (it allows
// any origin), and the live channel read as a stream (EventSource cannot send
// the token). Files go to and come from the page's memory (memfs.js).

const { OfflineError } = require('@flow/core/client/common');

function parse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The body of `res` as bytes, telling onProgress(frac) as it comes when the size is known. */
async function readAll(res, onProgress) {
  const total = Number(res.headers.get('content-length')) || 0;
  if (!onProgress || !total || !res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * request(base, pathname, opts) as the desktop's (apps/desktop/src/env.js):
 * JSON (`json`) or a file (`file`, a path in memfs) up, or the answer saved
 * into a file (`saveTo`). Resolves { status, json }. Unreachable, timed out
 * or cut off: OfflineError.
 */
function createHttp(memfs) {
  async function request(base, pathname, { method = 'GET', json, file, saveTo, token, timeout = 15000, onProgress } = {}) {
    let url;
    try {
      url = new URL(base + pathname);
    } catch {
      throw new Error('That is not an address.');
    }
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), file || saveTo ? Math.max(timeout, 30000) : timeout);
    try {
      const init = {
        method, headers, signal: ctl.signal, cache: 'no-store',
      };
      if (file) {
        const bytes = memfs.readBytes(file);
        if (!bytes) throw new Error(`Not there: ${file}`);
        headers['Content-Type'] = 'application/octet-stream';
        init.body = bytes;
      } else if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      let res;
      try {
        res = await fetch(url.href, init);
      } catch (err) {
        throw new OfflineError(ctl.signal.aborted ? 'The server did not answer in time.' : (err && err.message) || 'The server cannot be reached.');
      }
      if (saveTo && res.status === 200) {
        memfs.writeBytes(saveTo, await readAll(res, onProgress));
        return { status: res.status, json: null };
      }
      return { status: res.status, json: parse(await res.text()) };
    } catch (err) {
      if (err instanceof OfflineError || !ctl.signal.aborted) throw err;
      throw new OfflineError('The server did not answer in time.');
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

  return { request, stream };
}

module.exports = { createHttp };
