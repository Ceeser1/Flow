'use strict';

// A trace of what makes the window draw its pages again, for finding out
// why a page redraws while nothing seems to change. Off unless Flow is
// started with FLOW_TRACE_REDRAWS set to a file path; then every library
// change that reaches the window (with which songs and which of their
// fields changed), every server state and settings change, and every page
// drawn again (with the page open) are written to that file, a line each
// with the seconds since the start. Nothing of it is sent anywhere.

const fs = require('fs');

// Runs in the window: wraps the store's and the pages' functions, each line
// sent as a console message the main process writes down.
function tracer() {
  const t0 = Date.now();
  const out = (line) => console.log(`[flow-trace] ${((Date.now() - t0) / 1000).toFixed(2)} ${line}`);
  const fields = (a, b) => {
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    const changed = [];
    for (const k of keys) {
      const x = a ? a[k] : undefined;
      const y = b ? b[k] : undefined;
      if (JSON.stringify(x) === JSON.stringify(y)) continue;
      if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) {
        for (const sub of fields(x, y)) changed.push(`${k}.${sub}`);
      } else changed.push(k);
    }
    return changed;
  };
  const at = (path) => path.reduce((v, k) => (v == null ? v : v[k]), { library: Store.library });
  const describe = (step) => {
    const [op, path, value] = step;
    const where = path.join('.');
    if (op === 'list' && value) {
      const old = new Map(((path[0] === 'library' ? at(path) : at(['library', ...path])) || []).map((x) => [x.id, x]));
      const puts = (value.put || []).map((item) => {
        const before = old.get(item.id);
        return before ? `${item.id}{${fields(before, item).join(',') || 'nothing'}}` : `${item.id}{new}`;
      });
      const parts = [];
      if (puts.length) parts.push(`put ${puts.length}: ${puts.slice(0, 8).join(' ')}${puts.length > 8 ? ' ...' : ''}`);
      if (value.gone && value.gone.length) parts.push(`gone ${value.gone.length}`);
      if (value.order) parts.push('order');
      return `${where} ${parts.join('; ')}`;
    }
    if (op === 'map' && value) {
      const keys = Object.keys(value.put || {});
      return `${where} map put ${keys.length}: ${keys.slice(0, 8).join(' ')}${value.gone && value.gone.length ? `; gone ${value.gone.length}` : ''}`;
    }
    if (op === 'set') {
      const before = at(path[0] === 'library' ? path.slice(1) : path);
      const changed = before && value && typeof value === 'object' ? fields(before, value) : [];
      return `${where} set${changed.length ? ` {${changed.slice(0, 12).join(',')}}` : ''}`;
    }
    return `${where} ${op}`;
  };
  const takeLibrary = Store.takeLibrary.bind(Store);
  Store.takeLibrary = (msg) => {
    if (msg && msg.patch) out(`LIBRARY patch: ${msg.patch.map(describe).join(' | ') || '(empty)'}`);
    else if (msg) out(`LIBRARY whole (${(msg.library && msg.library.songs || []).length} songs)`);
    return takeLibrary(msg);
  };
  let lastServer = null;
  Store.onServer((s) => {
    const now = JSON.parse(JSON.stringify(s));
    out(`SERVER {${lastServer ? fields(lastServer, now).join(',') || 'nothing' : 'first'}}`);
    lastServer = now;
  });
  Store.onSettings((patch) => out(`SETTINGS {${Object.keys(patch).join(',')}}`));
  const wrap = (obj, name, label) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const fn = obj[name].bind(obj);
    obj[name] = (...args) => {
      out(`DRAW ${label} (page ${Nav.page})`);
      return fn(...args);
    };
  };
  // The pages are the window's own consts, reached by name (not window.*).
  /* global SearchPage, PlaylistPage, PlaylistsPage, GroupPage, FollowedPage, TrendPage, SessionsPage */
  const page = (get) => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  for (const [obj, name, label] of [
    [page(() => SearchPage), 'render', 'Search'], [page(() => PlaylistPage), 'render', 'Playlist'], [page(() => PlaylistPage), 'renderTable', 'Playlist table'],
    [page(() => PlaylistsPage), 'render', 'Playlists'], [page(() => GroupPage), 'render', 'Group'], [page(() => FollowedPage), 'render', 'Followed'],
    [page(() => TrendPage), 'render', 'Trend'], [page(() => SessionsPage), 'render', 'Sessions'], [Nav, 'drawMenu', 'menu'],
  ]) wrap(obj, name, label);
  out(`TRACE started, ${Store.library.songs.length} songs, page ${Nav.page}`);
}

/** Starts the trace in `win` when FLOW_TRACE_REDRAWS names a file. */
function attach(win) {
  const file = process.env.FLOW_TRACE_REDRAWS;
  if (!file) return;
  const write = (line) => {
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // A trace that cannot be written leaves Flow as it is.
    }
  };
  write(`---- Flow started ${new Date().toISOString()}`);
  win.webContents.on('console-message', (...args) => {
    // Electron 35+ passes one details object, older ones (event, level, message).
    const message = typeof args[0] === 'object' && args[0] && 'message' in args[0] ? args[0].message : args[2];
    if (typeof message === 'string' && message.startsWith('[flow-trace] ')) write(message.slice(13));
  });
  win.webContents.on('did-finish-load', () => {
    // Once the page has set itself up (its scripts run before this).
    setTimeout(() => {
      win.webContents.executeJavaScript(`(${tracer.toString()})(); true`).catch((err) => write(`trace failed: ${err && err.message}`));
    }, 1500);
  });
}

module.exports = { attach };
