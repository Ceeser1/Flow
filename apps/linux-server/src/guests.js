'use strict';

// Guests from other Flow Servers (4.0): an app of another server, on the same
// home network, may ask to join an Active Session here, when an admin allows
// it (Administration, server.json guests). The host still says yes or no to
// each. A guest is never a profile of this server and never a session's host:
// it gets a token of its own (in memory only, gone with the server or 12
// hours unused) that opens only these routes, and only from the home network:
//
//   POST /api/guest/hello { client, device, profileName, serverName }
//                                         { token, id, name }: this server, and the guest's token
//   GET  /api/guest/sessions              { sessions }: the shared ones, as the apps see them
//   GET  /api/guest/live?client=          the guest's live channel (live.js), its events as a member's
//   POST /api/guest/session { type, ... } join, cancelJoin, control, mode, leave (sessions.js)
//   GET  /api/guest/time                  { time }, for playing in step
//   GET  /api/guest/library               { songs }: this server's songs, to see and queue
//                                         (while in a session here)
//   GET  /api/guest/songs/:id/audio       a song's file (Range), while in a session here
//   GET  /api/guest/songs/:id/cover       its cover
//
// The token comes as "Authorization: Bearer" or ?gt= (an <audio> element
// cannot send headers). Nothing a guest does is counted here: its listening
// counts on its own server.

const crypto = require('crypto');

const IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_GUESTS = 50;
const CLIENT = /^[\w-]{8,64}$/;

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * deps: { config, library, live, sessions, log, helpers: { HttpError,
 * sendJson, sendFile, sendCover, readJsonBody } }. route(req, res, p, url,
 * client, home) answers /api/guest/* (home: the caller is on the home network).
 */
function createGuests({
  config, library, live, sessions, log = () => {}, helpers,
}) {
  const {
    HttpError, sendJson, sendFile, sendCover, readJsonBody,
  } = helpers;
  const tokens = new Map(); // token -> { client, device, profileName, serverName, ip, usedAt }

  function sweep() {
    const t = Date.now();
    for (const [token, g] of tokens) if (t - g.usedAt > IDLE_MS && !live.has(g.client)) tokens.delete(token);
  }

  function tokenOf(req, url) {
    const auth = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    return auth ? auth[1] : String(url.searchParams.get('gt') || '');
  }

  /** The guest a request comes from, or an HttpError. */
  function guestOf(req, url) {
    const g = tokens.get(tokenOf(req, url));
    if (!g) throw new HttpError(401, 'Ask this server again: the guest pass ran out.');
    g.usedAt = Date.now();
    return g;
  }

  function requireMember(g) {
    if (!sessions.isMember(g.client)) throw new HttpError(403, 'Only while in one of this server\'s Active Sessions.');
  }

  /** What a guest may see of a song: names and length, never its file or who added it. */
  const songOut = (s) => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    mix: s.mix,
    album: s.album,
    genre: s.genre,
    subGenre: s.subGenre,
    duration: s.duration,
    cover: s.cover && s.cover !== '-' ? s.cover : null,
    loudness: s.loudness,
  });

  async function route(req, res, p, url, client, home) {
    if (!config.get().guests) throw new HttpError(403, 'This Flow Server does not take guests from other servers.');
    if (!home) throw new HttpError(403, 'Guests from other servers are only let in from the home network.');
    const is = (method, re) => req.method === method && re.test(p);
    if (is('POST', /^\/api\/guest\/hello$/)) {
      const body = await readJsonBody(req);
      const id = String(body.client || '');
      if (!CLIENT.test(id)) throw new HttpError(400, 'A guest needs its app\'s id.');
      sweep();
      for (const [t, g] of tokens) if (g.client === id) tokens.delete(t);
      if (tokens.size >= MAX_GUESTS) throw new HttpError(503, 'This server has too many guests right now.');
      const token = crypto.randomBytes(24).toString('hex');
      tokens.set(token, {
        client: id,
        device: clean(body.device, 80) || client.ip,
        profileName: clean(body.profileName, 40),
        serverName: clean(body.serverName, 60) || 'another Flow Server',
        ip: client.ip,
        usedAt: Date.now(),
      });
      const cfg = config.get();
      return sendJson(res, 200, { token, id: cfg.id, name: cfg.name });
    }
    const g = guestOf(req, url);
    if (is('GET', /^\/api\/guest\/sessions$/)) return sendJson(res, 200, { sessions: sessions.list() });
    if (is('GET', /^\/api\/guest\/time$/)) return sendJson(res, 200, { time: Date.now() });
    if (is('GET', /^\/api\/guest\/live$/)) {
      if (String(url.searchParams.get('client') || '') !== g.client) throw new HttpError(403, 'That is another app\'s live channel.');
      if (!live.hasRoom(g.client)) throw new HttpError(503, 'Too many apps are connected to this server right now.');
      const info = {
        client: g.client, profileId: null, profileName: g.profileName, device: g.device, ip: client.ip, guest: true, serverName: g.serverName,
        // Still let in? The admins may have closed the door meanwhile.
        check: () => (config.get().guests && [...tokens.values()].includes(g) ? {} : null),
      };
      live.open(req, res, info);
      log(`Guest from ${g.serverName}: ${g.profileName || 'Default'} - ${g.device} connected`);
      return undefined;
    }
    if (is('POST', /^\/api\/guest\/session$/)) {
      const body = await readJsonBody(req);
      if (!['join', 'cancelJoin', 'control', 'mode', 'leave'].includes(body.type)) throw new HttpError(403, 'A guest cannot do that.');
      return sendJson(res, 200, sessions.handle(g.client, body));
    }
    if (is('GET', /^\/api\/guest\/library$/)) {
      requireMember(g);
      return sendJson(res, 200, { songs: library.data.songs.map(songOut) });
    }
    const m = /^\/api\/guest\/songs\/([\w-]{1,64})\/(audio|cover)$/.exec(p);
    if (m && (req.method === 'GET' || req.method === 'HEAD')) {
      requireMember(g);
      if (m[2] === 'cover') return sendCover(req, res, url, library.coverOf(m[1]));
      const file = library.songFile(m[1]);
      if (!file) throw new HttpError(404, 'That song is not on this server.');
      return sendFile(req, res, file);
    }
    throw new HttpError(404, 'Nothing here.');
  }

  /** The admins closed the door: every guest out. */
  function closeAll() {
    for (const g of tokens.values()) if (live.has(g.client)) live.kick(g.client, 'end', { reason: 'guestsOff' });
    tokens.clear();
  }

  return { route, closeAll };
}

module.exports = { createGuests };
