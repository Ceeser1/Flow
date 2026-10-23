'use strict';

// Being a guest (4.0): joining an Active Session on ANOTHER Flow Server on
// the same home network (the server's side: apps/linux-server/src/guests.js).
// The network is asked who is there (as for finding the Home server); the
// servers that take guests, other than this app's own, are asked for their
// shared sessions, each with a guest pass of its own. Joined, this app reads
// that server's live channel as a member reads its own server's, plays along
// from its stream addresses, and keeps its clock in step with it. Nothing is
// counted on that server; this app's listening counts at home.
//
// Shared by the Flow apps: env.http, env.device, env.discovery; ownServerId():
// the server this app uses (never a guest there); who(): { profileName,
// serverName } as the host is told; onLive({ type, data }) for the window.

const { serverBaseUrl } = require('../address');

const LIVE_RETRY_MS = [1000, 2000, 5000, 10000];
const CLOCK_SAMPLES = 5;

function createGuestLink({
  http, device, clientId, discovery, ownServerId = () => '', who = () => ({}), onLive = () => {}, onChange = () => {},
}) {
  const { request } = http;
  // Server id -> { id, name, base, token, sessions, seenAt }
  const servers = new Map();
  let looking = null;
  // The server this app is a guest of (joined or asking): its id, else null.
  let current = null;
  const live = {
    req: null, step: 0, retryTimer: null, offset: 0, up: false,
  };

  async function ask(server, pathname, opts = {}) {
    const r = await request(server.base, pathname, { token: server.token, timeout: 8000, ...opts });
    if (r.status < 200 || r.status >= 300) {
      const err = new Error((r.json && r.json.error) || `"${server.name}" answered ${r.status}.`);
      err.status = r.status;
      throw err;
    }
    return r.json;
  }

  /** A guest pass from `server` (asked again when it ran out). */
  async function pass(server) {
    const me = who();
    const r = await request(server.base, '/api/guest/hello', {
      method: 'POST',
      json: {
        client: clientId(), device: device.name(), profileName: me.profileName || '', serverName: me.serverName || '',
      },
      timeout: 5000,
    });
    if (r.status !== 200 || !r.json || !r.json.token) throw new Error((r.json && r.json.error) || `"${server.name}" lets no guests in.`);
    server.token = r.json.token;
    server.name = r.json.name || server.name;
  }

  /** `fn` with a pass, and once more with a new one when it ran out. */
  async function withPass(server, fn) {
    if (!server.token) await pass(server);
    try {
      return await fn();
    } catch (err) {
      if (err.status !== 401) throw err;
      await pass(server);
      return fn();
    }
  }

  /**
   * Looks for other servers that take guests, and their shared sessions.
   * Resolves the list: [{ id, name, sessions }].
   */
  function look() {
    if (looking) return looking;
    looking = (async () => {
      let found = [];
      try {
        found = await discovery.find();
      } catch {
        found = [];
      }
      const own = ownServerId();
      const seen = new Set();
      for (const f of found) {
        if (!f.guests || !f.id || f.id === own) continue;
        seen.add(f.id);
        const base = serverBaseUrl(`${f.ip}:${f.port}`);
        const server = servers.get(f.id) || { id: f.id, token: '', sessions: [] };
        if (server.base !== base) server.token = '';
        Object.assign(server, { name: f.name, base, seenAt: Date.now() });
        servers.set(f.id, server);
        try {
          server.sessions = (await withPass(server, () => ask(server, '/api/guest/sessions'))).sessions || [];
        } catch {
          server.sessions = [];
        }
      }
      // Gone from the network (the one this app is a guest of stays).
      for (const id of [...servers.keys()]) if (!seen.has(id) && id !== current) servers.delete(id);
      onChange();
      return list();
    })().finally(() => {
      looking = null;
    });
    return looking;
  }

  function list() {
    return [...servers.values()].map((s) => ({ id: s.id, name: s.name, sessions: s.sessions }));
  }

  // ---- the live channel of the server this app is a guest of ----

  function stopLive() {
    clearTimeout(live.retryTimer);
    live.retryTimer = null;
    const req = live.req;
    live.req = null;
    if (req) req.close();
    if (live.up) {
      live.up = false;
      onLive({ type: 'down', data: {} });
    }
  }

  function startLive() {
    stopLive();
    const server = servers.get(current);
    if (!server || !server.token) return;
    const url = `${server.base}/api/guest/live?client=${encodeURIComponent(clientId())}&gt=${encodeURIComponent(server.token)}`;
    let buffer = '';
    const req = http.stream(url, { headers: { Accept: 'text/event-stream' } }, {
      response(statusCode) {
        if (live.req !== req) return false;
        if (statusCode !== 200) {
          live.req = null;
          // The pass ran out: a new one, then the channel again.
          if (statusCode === 401) pass(server).then(() => current === server.id && startLive(), () => onLive({ type: 'end', data: { reason: 'refused' } }));
          else onLive({ type: 'end', data: { reason: 'refused' } });
          return false;
        }
        return true;
      },
      data(chunk) {
        if (live.req !== req) return;
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const type = (/^event: (.+)$/m.exec(block) || [])[1];
          if (!type) continue;
          let data = {};
          try {
            data = JSON.parse((/^data: (.*)$/m.exec(block) || [])[1] || '{}');
          } catch {
            continue;
          }
          event(type, data);
        }
      },
      lost() {
        if (live.req !== req) return;
        live.req = null;
        if (live.up) {
          live.up = false;
          onLive({ type: 'down', data: {} });
        }
        if (!current) return;
        const wait = LIVE_RETRY_MS[Math.min(live.step, LIVE_RETRY_MS.length - 1)];
        live.step += 1;
        live.retryTimer = setTimeout(startLive, wait);
      },
    });
    live.req = req;
  }

  function event(type, data) {
    if (type === 'hello') {
      live.step = 0;
      live.up = true;
      if (Number.isFinite(Number(data.serverTime))) live.offset = Number(data.serverTime) - Date.now();
      syncClock();
    }
    if (type === 'sessions') {
      const server = servers.get(current);
      if (server) server.sessions = Array.isArray(data.sessions) ? data.sessions : [];
      onChange();
    }
    onLive({ type, data });
  }

  /** That server's time minus this machine's: the quickest of a few answers. */
  async function syncClock() {
    const server = servers.get(current);
    if (!server) return;
    let best = null;
    for (let i = 0; i < CLOCK_SAMPLES; i += 1) {
      const t0 = Date.now();
      let r;
      try {
        r = await ask(server, '/api/guest/time', { timeout: 3000 });
      } catch {
        break;
      }
      const t1 = Date.now();
      if (!r || !Number.isFinite(Number(r.time))) break;
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: Number(r.time) - (t0 + t1) / 2 };
    }
    if (best) live.offset = best.offset;
  }

  // ---- taking part ----

  function serverOf(id) {
    const server = servers.get(id);
    if (!server) throw new Error('That server is no longer on this network.');
    return server;
  }

  /** Asks to join `sessionId` on server `serverId` (mode 'here' or 'remote'). */
  async function join(serverId, sessionId, mode) {
    const server = serverOf(serverId);
    // A guest of one server at a time.
    if (current && current !== serverId) await leave();
    await withPass(server, async () => {});
    if (current !== serverId || !live.req) {
      current = serverId;
      startLive();
    }
    return withPass(server, () => ask(server, '/api/guest/session', { method: 'POST', json: { type: 'join', sessionId, mode } }));
  }

  /** A request for the session this app is a guest in: control, mode, cancelJoin, leave. */
  async function session(body) {
    const server = serverOf(current);
    return withPass(server, () => ask(server, '/api/guest/session', { method: 'POST', json: body }));
  }

  /** Out of that server's session, and its live channel closed. */
  async function leave() {
    if (!current) return;
    const server = servers.get(current);
    try {
      if (server) await ask(server, '/api/guest/session', { method: 'POST', json: { type: 'leave' }, timeout: 3000 });
    } catch {
      // Its channel closing tells it as well.
    }
    current = null;
    stopLive();
    onChange();
  }

  /**
   * That server's songs, with where each plays from and its cover:
   * [{ ...song, src, coverUrl }].
   */
  async function songs() {
    const server = serverOf(current);
    const r = await withPass(server, () => ask(server, '/api/guest/library', { timeout: 20000 }));
    const gt = encodeURIComponent(server.token);
    return (r.songs || []).map((s) => ({
      ...s,
      src: `${server.base}/api/guest/songs/${encodeURIComponent(s.id)}/audio?gt=${gt}`,
      coverUrl: s.cover ? `${server.base}/api/guest/songs/${encodeURIComponent(s.id)}/cover?v=${encodeURIComponent(s.cover)}&gt=${gt}` : '',
    }));
  }

  /**
   * One of this app's songs into the session there (4.0): the file `file`
   * sent as the session song `gid` (meta { title, artist, mix, duration,
   * format }). Resolves once it plays there.
   */
  async function upload(gid, meta, file) {
    const server = serverOf(current);
    const q = encodeURIComponent(JSON.stringify(meta));
    return withPass(server, () => ask(server, `/api/guest/songs/${encodeURIComponent(gid)}?meta=${q}`, { method: 'PUT', file, timeout: 10 * 60 * 1000 }));
  }

  /**
   * Where this app stands: { serverId, name, offset, live, stream } or null;
   * stream: where that server's songs (and the session's) play from, as
   * `${stream}${id}/audio?gt=...` (streamQuery).
   */
  function status() {
    const server = current && servers.get(current);
    return server ? {
      serverId: server.id, name: server.name, offset: live.offset, live: live.up, stream: `${server.base}/api/guest/songs/`, streamQuery: `gt=${encodeURIComponent(server.token)}`,
    } : null;
  }

  function stop() {
    current = null;
    stopLive();
  }

  return {
    look, list, join, session, leave, songs, status, stop, upload,
  };
}

module.exports = { createGuestLink };
