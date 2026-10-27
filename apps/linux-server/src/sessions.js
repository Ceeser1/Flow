'use strict';

// Active Sessions: devices on this server listening together. Kept in memory
// only; a restart of the server ends them all.
//
// Every app that plays something is a session, with itself as the host: the
// device that plays (its speakers), and that the others control. Another app
// joins it with the host's OK and then follows it: its own player shows what
// the host plays, and its buttons (pause, next, a song started, the queue)
// are carried out by the host. Members are kept in the order they joined;
// the first is the host. When the host leaves (on purpose at once, a dropped
// live channel after GRACE_MS), the next in line takes over and plays on
// from where it was. The last one leaving ends the session. A host still
// telling what it plays without its live channel (a phone whose page sleeps
// while its player plays on) stays, until GRACE_MS after the last time.
//
// The apps talk to it with POST /api/sessions { type, ... } and hear back on
// their live channel (live.js):
//
//   state   { state }                 the host's playback, on every change and
//                                     every few seconds while playing; without
//                                     ids or queue, the ones sent before stay
//   join    { sessionId, mode }        ask the host; mode 'remote' (silent) or
//                                     'here' (plays along on this device)
//   cancelJoin                        take the request back
//   answer  { requestId, accept }      the host's Accept / Decline
//   control { action, ...args }        a member's button, carried out by the host
//   mode    { mode }                  a member switches between remote and here
//   leave                             out of the session (the host hands over)
//
// Events: sessions { sessions } (the list, to everyone, when it changes);
// joinRequest / joinCancelled (to the host); joinResult (to who asked);
// session { session } (members, to every member when they change); state
// { sessionId, state } (to the members); control (to the host); hostChanged
// (to the new host); left { sessionId, reason } (to a member that is out).
//
// Guests (4.0, guests.js): apps of another Flow Server on the home network
// join as members do (the host says yes or no), marked as guests with their
// server's name. A guest is never the host: when the host leaves, the next
// member of this server takes over, and with none left the session ends
// ('hostLeft'). A guest cannot start a playlist of this server's.
//
// A guest's own songs (4.0): its app sends a song it plays or queues here as
// a session song (PUT /api/guest/songs/:gid, guests.js), kept for this
// session only in <home>/session-songs/<session id> (gone when the session
// ends, and at every start). Members see them in the session's `songs`; the
// controls take their ids like the library's, and members stream them
// (GET /api/sessions/songs/:gid/audio, a guest through its own route).
//
// For other controllers (a smart home, later): controlSession() and
// controlPlayer() take the same actions without being a member, players()
// lists every app connected (playing or not), and playPlaylist is worked
// out here from the library, so a controller needs no library of its own.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_MEMBERS = 8;
const REQUEST_MS = 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const GRACE_MS = 15 * 1000;
// A session of one, paused, stays listed this long, then is dropped.
const PAUSED_LISTED_MS = 2 * 60 * 1000;
// Buttons per member, at most CONTROL_LIMIT within CONTROL_WINDOW.
const CONTROL_LIMIT = 30;
const CONTROL_WINDOW = 10 * 1000;
const MAX_IDS = 20000;
const ID = /^[\w-]{1,64}$/;
const CLIENT = /^[\w-]{8,64}$/;
// Session songs: at most this many, this large each, this much together.
const MAX_SESSION_SONGS = 60;
const MAX_SONG_BYTES = 300 * 1024 * 1024;
const MAX_SESSION_BYTES = 3 * 1024 * 1024 * 1024;
const SONG_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'wav', 'webm']);

class SessionError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

// ---- cleaning what the apps send ----

const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
const bool = (v) => v === true;
const num = (v, min, max, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const idOrNull = (v) => (typeof v === 'string' && ID.test(v) ? v : null);
const idList = (v, max = MAX_IDS) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && ID.test(x)).slice(0, max) : []);

/** The host's PlayQueue as it sends it (queue.js snapshot()). */
function cleanQueue(q) {
  if (!q || typeof q !== 'object') return null;
  return {
    contextId: idOrNull(q.contextId),
    currentId: idOrNull(q.currentId),
    shuffle: bool(q.shuffle),
    manual: idList(q.manual, 1000),
    auto: idList(q.auto, 200),
    used: idList(q.used),
    cursor: idOrNull(q.cursor),
    history: idList(q.history, 500),
  };
}

function cleanState(s) {
  if (!s || typeof s !== 'object') throw new SessionError(400, 'That is not a playback state.');
  return {
    songId: idOrNull(s.songId),
    title: text(s.title, 300),
    artist: text(s.artist, 300),
    mix: text(s.mix, 300),
    duration: num(s.duration, 0, 24 * 3600),
    playing: bool(s.playing),
    position: num(s.position, 0, 24 * 3600),
    repeat: bool(s.repeat),
    shuffle: bool(s.shuffle),
    contextId: idOrNull(s.contextId),
    contextName: text(s.contextName, 200),
    // Left out: unchanged since the last state (they can be long).
    ids: s.ids === undefined ? undefined : idList(s.ids),
    queue: s.queue === undefined ? undefined : cleanQueue(s.queue),
    // When the position was read, in the server's time as the host reckons it.
    at: Number.isFinite(Number(s.at)) ? Number(s.at) : null,
    // "Profile - Output device", as the host calls itself.
    name: text(s.name, 160),
    // Listed for the others to see and ask to join (left out by apps before 2.8.1: yes).
    shared: s.shared !== false,
    // The host lets the others (and controllers) change its volume.
    allowVolume: bool(s.allowVolume),
    volume: num(s.volume, 0, 1, 1),
    // The song transition: the next song starting this long before the end (0: off).
    crossfade: num(s.crossfade, 0, 20),
    // How late the host's speakers sound (ms, set by ear), for devices playing along.
    outputDelay: num(s.outputDelay, -1000, 3000),
  };
}

/**
 * opts: { live (live.js hub), library ({ songExists(id), playlist(profileId,
 * ref) -> { id, name, ids } | null }), clock, log, songDir (where session
 * songs are kept; none: guests bring none) }.
 */
function createSessions({
  live, library, clock = realClock, log = () => {}, songDir = null,
}) {
  // What a stop left behind goes at the start.
  if (songDir) fs.rmSync(songDir, { recursive: true, force: true });
  const sessions = new Map(); // id -> session
  const memberOf = new Map(); // client -> session id
  const requests = new Map(); // request id -> { id, sessionId, client, mode, timer, who }
  const requestOf = new Map(); // client -> request id
  const cooldowns = new Map(); // "sessionId|client" -> until
  const grace = new Map(); // client -> timer
  const controlTimes = new Map(); // client -> recent control times
  let listTimer = null;
  let lastList = '';

  const now = () => clock.now();
  const newId = () => crypto.randomBytes(8).toString('hex');
  const hostOf = (s) => s.members[0];
  const send = (client, type, data) => live.send(client, type, data);

  /** Who an app is, from its live channel; it needs one to take part. */
  function who(client) {
    const info = live.info(client);
    if (!info) throw new SessionError(409, 'This app is not connected to the server\'s live channel right now. Try again in a moment.');
    return {
      client, profileId: info.profileId || null, profileName: info.profileName || '', device: info.device || '', ip: info.ip || '',
      guest: !!info.guest, serverName: info.guest ? String(info.serverName || '') : '',
    };
  }

  // ---- what the others see ----

  function nameOf(s) {
    const st = s.state;
    const h = hostOf(s);
    return (st && st.name) || `${h.profileName || 'Default'} - ${h.device || 'Flow'}`;
  }

  /** The state with its position moved on to now (it was sampled at sampledAt). */
  function stateNow(s) {
    if (!s.state) return null;
    const t = now();
    const position = s.state.playing ? s.state.position + (t - s.sampledAt) / 1000 : s.state.position;
    return {
      ...s.state, position: s.state.duration ? Math.min(position, s.state.duration) : position, sampledAt: t,
    };
  }

  function listed(s) {
    const st = s.state;
    // Not shared: its members know it, nobody else sees it.
    if (st && !st.shared) return false;
    if (s.members.length > 1) return true;
    return !!(st && st.songId && (st.playing || now() - s.pausedAt < PAUSED_LISTED_MS));
  }

  const member = (m) => ({
    client: m.client, profileName: m.profileName, device: m.device, mode: m.mode, joinedAt: m.joinedAt,
    ...(m.guest ? { guest: true, serverName: m.serverName } : {}),
  });

  /** A session song as members see it. */
  const songOut = (x) => ({
    id: x.gid, title: x.title, artist: x.artist, mix: x.mix, duration: x.duration, format: x.format, by: x.byName,
  });

  function detail(s) {
    return {
      id: s.id,
      name: nameOf(s),
      hostClient: hostOf(s).client,
      members: s.members.map(member),
      allowVolume: !!(s.state && s.state.allowVolume),
      // The songs guests brought, ready to play.
      songs: [...s.songs.values()].filter((x) => x.ready).map(songOut),
    };
  }

  function summary(s) {
    const st = s.state;
    const h = hostOf(s);
    return {
      id: s.id,
      name: nameOf(s),
      host: { client: h.client, profileName: h.profileName, device: h.device },
      song: st && st.songId ? {
        id: st.songId, title: st.title, artist: st.artist, mix: st.mix,
      } : null,
      playing: !!(st && st.playing),
      listeners: s.members.length - 1,
      members: s.members.map(member),
    };
  }

  function list() {
    return [...sessions.values()].filter(listed).map(summary);
  }

  /** The list to everyone connected, soon (several changes go as one), if it changed. */
  function pushList(force = false) {
    if (listTimer) return;
    listTimer = clock.setTimeout(() => {
      listTimer = null;
      const sessionsNow = list();
      const json = JSON.stringify(sessionsNow);
      if (json === lastList && !force) return;
      lastList = json;
      for (const c of live.clients()) send(c.client, 'sessions', { sessions: sessionsNow });
    }, 150);
  }

  function toMembers(s, type, data, except = null) {
    for (const m of s.members) if (m.client !== except) send(m.client, type, data);
  }

  // ---- the host's playback ----

  function dropWhenIdle(s) {
    clock.clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (s.members.length > 1 || !s.state || s.state.playing) return;
    s.idleTimer = clock.setTimeout(() => {
      s.idleTimer = null;
      if (sessions.get(s.id) === s && s.members.length === 1 && s.state && !s.state.playing) end(s, 'idle');
    }, Math.max(0, PAUSED_LISTED_MS - (now() - s.pausedAt)) + 10);
  }

  /**
   * Who a host telling what it plays is: from its live channel, else (gone a
   * while, a phone whose page sleeps) as its session knows it, else as its
   * sign-in names it (`signedIn`, from the HTTP side).
   */
  function hostWho(client, signedIn) {
    if (live.info(client)) return who(client);
    const s = sessions.get(memberOf.get(client));
    const m = s && s.members.find((x) => x.client === client);
    if (m) return { client, profileId: m.profileId, profileName: m.profileName, device: m.device, ip: m.ip || '' };
    if (signedIn) return { ...signedIn, client };
    return who(client);
  }

  function setState(client, raw, signedIn = null) {
    const me = hostWho(client, signedIn);
    if (me.guest) throw new SessionError(403, 'A guest from another server cannot host a session here.');
    const st = cleanState(raw);
    let s = sessions.get(memberOf.get(client));
    if (s && hostOf(s).client !== client) throw new SessionError(409, 'Only the session\'s host sends what it plays.');
    if (!s) {
      // Nothing loaded and no session: nothing to tell anyone.
      if (!st.songId) return { sessionId: null };
      s = {
        id: newId(), members: [{ ...me, joinedAt: now(), mode: 'host' }], state: null, sampledAt: 0, pausedAt: now(), createdAt: now(), idleTimer: null, songs: new Map(),
      };
      sessions.set(s.id, s);
      memberOf.set(client, s.id);
    }
    // Without its live channel, it stays as long as it keeps telling.
    if (!live.has(client)) dropLater(client);
    Object.assign(hostOf(s), { profileId: me.profileId, profileName: me.profileName, device: me.device });
    const was = s.state;
    if (st.ids === undefined) st.ids = was ? was.ids : [];
    if (st.queue === undefined) st.queue = was ? was.queue : null;
    // The host's own time of reading, unless its clock is far out.
    s.sampledAt = st.at !== null && Math.abs(st.at - now()) < 5000 ? st.at : now();
    delete st.at;
    s.state = st;
    // No longer shared: open requests are turned away (the host closed its prompts itself).
    if (!st.shared) {
      for (const r of [...requests.values()]) if (r.sessionId === s.id) cancelRequest(r.id, { toJoiner: { reason: 'unshared' }, toHost: false });
    }
    if (st.playing) s.pausedAt = 0;
    else if (!was || was.playing || !s.pausedAt) s.pausedAt = now();
    if (s.members.length === 1 && !st.songId) {
      end(s, 'stopped');
      return { sessionId: null };
    }
    const out = stateNow(s);
    for (const m of s.members.slice(1)) send(m.client, 'state', { sessionId: s.id, state: out });
    dropWhenIdle(s);
    pushList();
    return { sessionId: s.id };
  }

  // ---- joining ----

  function cancelRequest(requestId, { toJoiner = null, toHost = true } = {}) {
    const r = requests.get(requestId);
    if (!r) return;
    requests.delete(requestId);
    if (requestOf.get(r.client) === requestId) requestOf.delete(r.client);
    clock.clearTimeout(r.timer);
    const s = sessions.get(r.sessionId);
    if (toHost && s) send(hostOf(s).client, 'joinCancelled', { requestId, sessionId: r.sessionId });
    if (toJoiner) send(r.client, 'joinResult', { requestId, sessionId: r.sessionId, ok: false, ...toJoiner });
  }

  function requestEvent(r) {
    return {
      requestId: r.id, sessionId: r.sessionId, client: r.client, profileName: r.who.profileName, device: r.who.device, ip: r.who.ip, expiresIn: Math.max(0, r.expiresAt - now()),
      ...(r.who.guest ? { guest: true, serverName: r.who.serverName } : {}),
    };
  }

  function join(client, { sessionId, mode }) {
    const me = who(client);
    const s = sessions.get(String(sessionId || ''));
    if (s && s.state && !s.state.shared) throw new SessionError(403, 'That session is no longer shared.');
    if (!s || !listed(s)) throw new SessionError(404, 'That session has ended.');
    if (memberOf.get(client) === s.id) throw new SessionError(409, 'You are in this session already.');
    const until = cooldowns.get(`${s.id}|${client}`) || 0;
    if (until > now()) {
      const retryIn = Math.ceil((until - now()) / 1000);
      throw new SessionError(429, `The host declined. You can ask again in ${retryIn} seconds.`, { retryIn });
    }
    if (s.members.length >= MAX_MEMBERS) throw new SessionError(409, `That session is full (${MAX_MEMBERS} devices).`);
    // One request at a time: an earlier one (here or elsewhere) is taken back.
    if (requestOf.has(client)) cancelRequest(requestOf.get(client));
    const r = {
      id: newId(), sessionId: s.id, client, mode: mode === 'here' ? 'here' : 'remote', who: me, expiresAt: now() + REQUEST_MS, timer: null,
    };
    r.timer = clock.setTimeout(() => cancelRequest(r.id, { toJoiner: { reason: 'expired' } }), REQUEST_MS);
    requests.set(r.id, r);
    requestOf.set(client, r.id);
    send(hostOf(s).client, 'joinRequest', requestEvent(r));
    return { requestId: r.id, expiresIn: REQUEST_MS };
  }

  function cancelJoin(client) {
    if (requestOf.has(client)) cancelRequest(requestOf.get(client));
    return {};
  }

  function answer(client, { requestId, accept }) {
    const r = requests.get(String(requestId || ''));
    if (!r) throw new SessionError(404, 'That request is no longer open (it expired or was taken back).');
    const s = sessions.get(r.sessionId);
    if (!s) {
      cancelRequest(r.id, { toJoiner: { reason: 'ended' }, toHost: false });
      throw new SessionError(404, 'That session has ended.');
    }
    if (hostOf(s).client !== client) throw new SessionError(403, 'Only the session\'s host answers requests to join.');
    cancelRequest(r.id, { toHost: false });
    if (!accept) {
      cooldowns.set(`${s.id}|${r.client}`, now() + COOLDOWN_MS);
      send(r.client, 'joinResult', {
        requestId: r.id, sessionId: s.id, ok: false, reason: 'declined', retryIn: COOLDOWN_MS / 1000,
      });
      return { accepted: false };
    }
    if (s.members.length >= MAX_MEMBERS) {
      send(r.client, 'joinResult', { requestId: r.id, sessionId: s.id, ok: false, reason: 'full' });
      throw new SessionError(409, `The session is full (${MAX_MEMBERS} devices).`);
    }
    if (!live.has(r.client)) throw new SessionError(409, 'That device is no longer connected.');
    // In another session (its own, or someone else's): out of that one first.
    if (memberOf.has(r.client)) leave(r.client, 'joinedOther');
    const info = live.info(r.client) || {};
    const m = {
      client: r.client, profileId: info.profileId || null, profileName: info.profileName || r.who.profileName, device: info.device || r.who.device, ip: info.ip || r.who.ip, joinedAt: now(), mode: r.mode,
      guest: !!r.who.guest, serverName: r.who.serverName || '',
    };
    s.members.push(m);
    memberOf.set(r.client, s.id);
    clock.clearTimeout(s.idleTimer);
    s.idleTimer = null;
    const session = detail(s);
    send(r.client, 'joinResult', {
      requestId: r.id, sessionId: s.id, ok: true, session, state: stateNow(s),
    });
    toMembers(s, 'session', { session, joined: member(m) }, r.client);
    pushList();
    return { accepted: true };
  }

  // ---- controls ----

  function resolvePlaylist(profileId, args) {
    const ref = args.playlistId !== undefined ? { id: String(args.playlistId || '') } : { name: text(args.name, 200) };
    const p = library.playlist(profileId, ref);
    if (!p) throw new SessionError(404, 'There is no such playlist.');
    return { ids: idList(p.ids), contextName: p.name, contextId: p.id, songId: null };
  }

  /** A control as the host gets it, checked; throws for anything else. */
  function cleanControl(action, args, from, s) {
    const a = args || {};
    // The library's songs, and the session's songs once they are all there.
    const songOk = (id) => typeof id === 'string' && ID.test(id) && (library.songExists(id) || !!(s && s.songs.get(id) && s.songs.get(id).ready));
    switch (action) {
      case 'toggle': case 'play': case 'pause': case 'next': case 'prev': case 'queueClear':
        return {};
      case 'seek':
        if (!Number.isFinite(Number(a.position))) throw new SessionError(400, 'Seek where?');
        return { position: num(a.position, 0, 24 * 3600) };
      case 'shuffle': case 'repeat':
        return { on: bool(a.on) };
      case 'queueAdd':
        if (!songOk(a.songId)) throw new SessionError(404, 'That song is not on the server.');
        return { songId: a.songId };
      case 'queueRemove': case 'queuePlay':
        return { part: a.part === 'auto' ? 'auto' : 'manual', index: Math.max(0, Math.floor(num(a.index, 0, 1e6))) };
      case 'queueMove':
        return {
          part: a.part === 'auto' ? 'auto' : 'manual', from: Math.max(0, Math.floor(num(a.from, 0, 1e6))), to: Math.max(0, Math.floor(num(a.to, 0, 1e6))),
        };
      case 'playSong': {
        if (!songOk(a.songId)) throw new SessionError(404, 'That song is not on the server.');
        let ids = idList(a.ids).filter((id) => songOk(id));
        if (!ids.includes(a.songId)) ids = [a.songId, ...ids];
        return {
          songId: a.songId, ids, contextName: text(a.contextName, 200), contextId: idOrNull(a.contextId),
        };
      }
      case 'playPlaylist':
        if (from.guest) throw new SessionError(403, `A guest plays songs, not this server's playlists.`);
        return resolvePlaylist(from.profileId, a);
      case 'volume':
        if (!s || !s.state || !s.state.allowVolume) throw new SessionError(403, 'The host does not let others change its volume.');
        return { value: num(a.value, 0, 1) };
      default:
        throw new SessionError(400, `"${text(action, 40)}" is not something a session can do.`);
    }
  }

  function rateLimit(client) {
    const t = now();
    const times = (controlTimes.get(client) || []).filter((x) => x > t - CONTROL_WINDOW);
    if (times.length >= CONTROL_LIMIT) throw new SessionError(429, 'Slow down a little.');
    times.push(t);
    controlTimes.set(client, times);
  }

  function forward(s, action, args, from) {
    const host = hostOf(s);
    const sent = send(host.client, 'control', {
      sessionId: s.id, action, args, from: { client: from.client || null, profileName: from.profileName || '', device: from.device || '' },
    });
    if (!sent) throw new SessionError(409, 'The host is reconnecting. Try again in a moment.');
    return { sent: true };
  }

  function control(client, body) {
    const me = who(client);
    const s = sessions.get(memberOf.get(client));
    if (!s) throw new SessionError(403, 'Join the session first.');
    if (hostOf(s).client === client) throw new SessionError(409, 'The host plays on its own.');
    rateLimit(client);
    const { type, action, ...args } = body;
    return forward(s, action, cleanControl(action, args, me, s), me);
  }

  /** A controller that is no member (a smart home, later): `from` { profileId, profileName, device }. */
  function controlSession(sessionId, action, args, from = {}) {
    const s = sessions.get(String(sessionId || ''));
    if (!s) throw new SessionError(404, 'That session has ended.');
    return forward(s, action, cleanControl(action, args, from, s), from);
  }

  /** The same for an app that plays nothing yet (start a playlist on that PC). */
  function controlPlayer(client, action, args, from = {}) {
    const sid = memberOf.get(client);
    if (sid) return controlSession(sid, action, args, from);
    if (!live.has(client)) throw new SessionError(404, 'That device is not connected.');
    const clean = cleanControl(action, args, from, null);
    send(client, 'control', {
      sessionId: null, action, args: clean, from: { client: null, profileName: from.profileName || '', device: from.device || '' },
    });
    return { sent: true };
  }

  function setMode(client, { mode }) {
    const s = sessions.get(memberOf.get(client));
    if (!s) throw new SessionError(403, 'Join the session first.');
    const m = s.members.find((x) => x.client === client);
    if (m.mode !== 'host') m.mode = mode === 'here' ? 'here' : 'remote';
    toMembers(s, 'session', { session: detail(s) });
    return {};
  }

  // ---- leaving ----

  function end(s, reason) {
    if (sessions.get(s.id) !== s) return;
    sessions.delete(s.id);
    if (songDir && s.songs.size) fs.rmSync(path.join(songDir, s.id), { recursive: true, force: true });
    clock.clearTimeout(s.idleTimer);
    for (const m of s.members) {
      memberOf.delete(m.client);
      // Stopped by the host itself: it knows. Paused too long alone: it is told, to start afresh.
      if (reason === 'idle') send(m.client, 'left', { sessionId: s.id, reason: 'idle' });
      else if (reason === 'hostLeft') send(m.client, 'left', { sessionId: s.id, reason: 'hostLeft' });
      else if (reason !== 'stopped') send(m.client, 'left', { sessionId: s.id, reason: 'ended' });
    }
    for (const r of [...requests.values()]) if (r.sessionId === s.id) cancelRequest(r.id, { toJoiner: { reason: 'ended' }, toHost: false });
    for (const key of [...cooldowns.keys()]) if (key.startsWith(`${s.id}|`)) cooldowns.delete(key);
    pushList();
  }

  /**
   * An app out of its session. reason: 'left' (on purpose), 'dropped' (its
   * live channel gone for GRACE_MS), 'joinedOther'. The host hands over to
   * the next in line, which plays on from where it was.
   */
  function leave(client, reason = 'left') {
    if (requestOf.has(client)) cancelRequest(requestOf.get(client));
    clock.clearTimeout(grace.get(client));
    grace.delete(client);
    const s = sessions.get(memberOf.get(client));
    if (!s) return {};
    const i = s.members.findIndex((m) => m.client === client);
    const [gone] = s.members.splice(i, 1);
    memberOf.delete(client);
    send(client, 'left', { sessionId: s.id, reason });
    if (!s.members.length) {
      end(s, reason);
      return {};
    }
    // Only guests left: a guest never hosts, so the session is over.
    if (i === 0 && !s.members.some((m) => !m.guest)) {
      end(s, 'hostLeft');
      return {};
    }
    if (i === 0) {
      // The next in line that is connected (one reconnecting comes after), never a guest.
      let next = s.members.findIndex((m) => !m.guest && live.has(m.client) && !grace.has(m.client));
      if (next < 0) next = s.members.findIndex((m) => !m.guest);
      if (next > 0) s.members.unshift(s.members.splice(next, 1)[0]);
      const host = hostOf(s);
      host.mode = 'host';
      const state = stateNow(s);
      if (s.state) {
        s.state = { ...s.state, position: state.position };
        s.sampledAt = now();
        // The new host names the session after itself with its next state.
        s.state.name = '';
      }
      const previous = { client: gone.client, profileName: gone.profileName, device: gone.device };
      send(host.client, 'hostChanged', {
        sessionId: s.id, previous, reason, state: stateNow(s), session: detail(s),
      });
      toMembers(s, 'session', { session: detail(s), hostChanged: { previous, reason } }, host.client);
      // Requests the old host had not answered go to the new one.
      for (const r of requests.values()) if (r.sessionId === s.id) send(host.client, 'joinRequest', requestEvent(r));
      log(`Session ${s.id}: ${previous.profileName || 'Default'} - ${previous.device} left, ${host.profileName || 'Default'} - ${host.device} hosts now`);
    } else {
      toMembers(s, 'session', { session: detail(s), left: member(gone) });
    }
    dropWhenIdle(s);
    pushList();
    return {};
  }

  // ---- the live channels coming and going ----

  live.onOpen((client) => {
    clock.clearTimeout(grace.get(client));
    grace.delete(client);
    const s = sessions.get(memberOf.get(client));
    if (s) {
      const m = s.members.find((x) => x.client === client);
      const info = live.info(client) || {};
      Object.assign(m, { profileId: info.profileId || null, profileName: info.profileName || '', device: info.device || m.device });
      send(client, 'session', { session: detail(s), resumed: true });
      if (hostOf(s).client === client) {
        for (const r of requests.values()) if (r.sessionId === s.id) send(client, 'joinRequest', requestEvent(r));
      } else if (s.state) {
        send(client, 'state', { sessionId: s.id, state: stateNow(s) });
      }
    }
    send(client, 'sessions', { sessions: list() });
  });

  live.onClose((client, _info, reason) => {
    if (reason === 'replaced') return;
    // Gone for good unless it is back within GRACE_MS.
    if (!memberOf.has(client) && !requestOf.has(client)) return;
    dropLater(client);
  });

  /** Gone for good unless its live channel is back (or, a host, it tells what it plays) within GRACE_MS. */
  function dropLater(client) {
    clock.clearTimeout(grace.get(client));
    grace.set(client, clock.setTimeout(() => {
      grace.delete(client);
      if (!live.has(client)) leave(client, 'dropped');
    }, GRACE_MS));
  }

  // ---- for the HTTP side ----

  /**
   * POST /api/sessions from the app `client`. Resolves what to answer.
   * `signedIn` ({ profileId, profileName, device, ip }): who its sign-in names,
   * for a host telling what it plays without its live channel.
   */
  function handle(client, body, signedIn = null) {
    if (!CLIENT.test(String(client || ''))) throw new SessionError(400, 'Sessions need the app\'s id.');
    const b = body && typeof body === 'object' ? body : {};
    switch (b.type) {
      case 'state': return setState(client, b.state, signedIn);
      case 'join': return join(client, b);
      case 'cancelJoin': return cancelJoin(client);
      case 'answer': return answer(client, b);
      case 'control': return control(client, b);
      case 'mode': return setMode(client, b);
      case 'leave': return leave(client, 'left');
      default: throw new SessionError(400, 'Unknown session request.');
    }
  }

  /** What GET /api/sessions answers the app `client`: the list, and its own place. */
  function view(client) {
    const s = sessions.get(memberOf.get(client));
    const r = requests.get(requestOf.get(client));
    return {
      sessions: list(),
      mine: s ? { session: detail(s), state: stateNow(s), host: hostOf(s).client === client } : null,
      request: r ? { requestId: r.id, sessionId: r.sessionId, expiresIn: Math.max(0, r.expiresAt - now()) } : null,
    };
  }

  /** Every app connected, playing or not, for controllers. */
  function players() {
    return live.clients().map((c) => {
      const s = sessions.get(memberOf.get(c.client));
      return {
        client: c.client, profileName: c.profileName || '', device: c.device || '', sessionId: s ? s.id : null, host: !!s && hostOf(s).client === c.client,
      };
    });
  }

  /** Every session, shared or not, for the admins (as list() has them, with whether it is shared). */
  function all() {
    return [...sessions.values()].map((s) => ({ ...summary(s), shared: !(s.state && !s.state.shared) }));
  }

  /**
   * An admin ends a session: its members are out (told it ended). A host
   * still playing has a session of its own again as it goes on.
   */
  function endById(id) {
    const s = sessions.get(String(id || ''));
    if (!s) return false;
    end(s, 'admin');
    return true;
  }

  function stop() {
    if (songDir) fs.rmSync(songDir, { recursive: true, force: true });
    clock.clearTimeout(listTimer);
    for (const s of sessions.values()) clock.clearTimeout(s.idleTimer);
    for (const r of requests.values()) clock.clearTimeout(r.timer);
    for (const t of grace.values()) clock.clearTimeout(t);
    sessions.clear();
  }

  /** Whether an app is in a session here (a guest may then stream its songs). */
  const isMember = (client) => sessions.has(memberOf.get(client));

  // ---- songs guests bring ----

  /**
   * A guest sends one of its songs (`gid`, meta { title, artist, mix,
   * duration, format }): where to write it, or a SessionError. Its app sends
   * the bytes; songArrived() makes it playable.
   */
  function prepareSong(client, gid, meta) {
    if (!songDir) throw new SessionError(404, 'This server takes no songs from guests.');
    const s = sessions.get(memberOf.get(client));
    if (!s) throw new SessionError(403, 'Join the session first.');
    const me = s.members.find((m) => m.client === client);
    if (!ID.test(String(gid || '')) || library.songExists(gid)) throw new SessionError(400, 'That is no id for a song brought along.');
    const had = s.songs.get(gid);
    if (had && had.ready) return null;
    if (s.songs.size >= MAX_SESSION_SONGS) throw new SessionError(409, `This session has its ${MAX_SESSION_SONGS} songs from guests already.`);
    const format = String((meta && meta.format) || '').toLowerCase();
    if (!SONG_EXTS.has(format)) throw new SessionError(415, 'That kind of file cannot be played here.');
    const entry = {
      gid,
      title: text(meta.title, 300) || 'Song',
      artist: text(meta.artist, 300),
      mix: text(meta.mix, 300),
      duration: num(meta.duration, 0, 24 * 3600),
      format,
      by: client,
      byName: `${me.profileName ? `${me.profileName} - ` : ''}${me.device || 'a guest'}`,
      file: path.join(songDir, s.id, `${gid}.${format}`),
      ready: false,
      bytes: 0,
    };
    s.songs.set(gid, entry);
    fs.mkdirSync(path.dirname(entry.file), { recursive: true });
    return { file: entry.file, maxBytes: Math.min(MAX_SONG_BYTES, MAX_SESSION_BYTES - [...s.songs.values()].reduce((n, x) => n + x.bytes, 0)) };
  }

  /** The bytes are in (`bytes`, or null: they never came): the song plays for every member, or goes. */
  function songArrived(client, gid, bytes) {
    const s = sessions.get(memberOf.get(client));
    const entry = s && s.songs.get(gid);
    if (!entry || entry.by !== client) return;
    if (!bytes) {
      s.songs.delete(gid);
      fs.rmSync(entry.file, { force: true });
      return;
    }
    entry.bytes = bytes;
    entry.ready = true;
    toMembers(s, 'session', { session: detail(s) });
    log(`Session ${s.id}: ${entry.byName} brought "${entry.title}"`);
  }

  /** A session song's file for a member of its session, or null. */
  function songFileFor(client, gid) {
    const s = sessions.get(memberOf.get(client));
    const entry = s && s.songs.get(String(gid || ''));
    return entry && entry.ready ? entry.file : null;
  }

  return {
    handle, view, list, all, endById, players, controlSession, controlPlayer, stop, isMember, prepareSong, songArrived, songFileFor,
  };
}

module.exports = {
  createSessions, SessionError, MAX_MEMBERS, REQUEST_MS, COOLDOWN_MS, GRACE_MS, PAUSED_LISTED_MS,
};
