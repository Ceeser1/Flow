'use strict';

// Administration (3.5): what an admin's app can see and do on the server,
// under /api/admin. Only a request signed in to an admin profile gets here;
// the master admin's own things say so (master below).
//
//   GET  /api/admin/profiles                 { profiles: [row], me }: every profile with
//                                            { id, name, createdAt, lastSeen ('now' or ms, 0: never),
//                                              addedSongs, listens (30 s or more), seconds,
//                                              admin, master, disabled, pin, devices }
//   POST /api/admin/profiles { name, pin }   a new profile for someone else (the admin stays
//                                            signed in to its own): { profile }
//   GET  /api/admin/profiles/:id/ips         { createdIp, ips: [{ ip, device, at }] }
//   POST /api/admin/profiles/:id/delete { songs }   the profile, with its playlists; songs:
//                                            also every song it added, for everyone (to the
//                                            trash): { deletedSongs }
//   POST /api/admin/profiles/:id/pin         its PIN taken away (forgotten): {}
//   POST /api/admin/profiles/:id/signout     its devices signed out of it: { devices }
//   POST /api/admin/profiles/:id/disable { disabled }   signing in to it refused (its devices
//                                            signed out of it), or allowed again
//   POST /api/admin/profiles/:id/admin { admin }        master only: an admin made or taken back
//
//   GET  /api/admin/server                   the overview: { name, version, startedAt, songs,
//                                            profiles, musicBytes, trashBytes, disk { free, size },
//                                            ytdlp (its version, '' none), ffmpeg, downloads, level,
//                                            password, master }
//   GET  /api/admin/trash                    { items: [{ name, at, size, title, artist, by,
//                                            restorable }], bytes }
//   POST /api/admin/trash/restore { name }   back as it was (restorable), else as a new song
//   POST /api/admin/trash/empty              every file in it gone for good: { deleted }
//   GET  /api/admin/downloads                every profile's server download: { batches }
//   POST /api/admin/downloads/cancel { key } one cancelled, whatever it is doing
//   GET  /api/admin/sessions                 every Active Session: { sessions }
//   POST /api/admin/sessions/end { id }      its members are out
//   GET  /api/admin/signins                  the failed sign-ins, newest first: { failures }
//   POST /api/admin/signins/clear
//   GET  /api/admin/rules                    { profileCreation: 'anyone' | 'admins',
//   POST /api/admin/rules { ... }              songDelete: 'anyone' | 'owner' }
//   POST /api/admin/password { current, password } or { current, remove }
//                                            master only: the server password changed (or taken
//                                            away, levels 1 and 2). Every device is signed out;
//                                            the master's own gets a new token: { token }
//
// An admin cannot delete, disable or sign out its own profile here, nor
// anything of the master's but its IPs; the master is changed on the command
// line only (flow-server admin).

const { execFile } = require('child_process');
const fs = require('fs');
const { PUBLIC_LEVEL, passwordProblem } = require('@flow/core/password');
const { checkPassword, passwordEntry } = require('./config');

// The overview's slow parts (the music folder's size, yt-dlp's version) are
// worked out at most this often.
const OVERVIEW_EVERY = 10 * 60 * 1000;

/**
 * deps: { config, library, downloads, live, sessions, activity, tools,
 * version, startedAt, throttle, issueToken, createProfile(name, pin, { ip,
 * device }), log, HttpError, sendJson, readJsonBody, allProfiles }. Returns route(req, res, p, me),
 * which answers (404 for a path it does not know); `me` is the admin asking.
 */
function createAdminRoutes({
  config, library, downloads, live, sessions = null, activity, tools = null, version = '', startedAt = Date.now(),
  throttle = null, issueToken = null, createProfile = null, log, HttpError, sendJson, readJsonBody, allProfiles,
}) {
  let slow = { at: 0, musicBytes: 0, ytdlp: '' };
  let slowRun = null;

  /** The music folder's size (its songs' files) and yt-dlp's version, kept a while. */
  function slowParts() {
    if (Date.now() - slow.at < OVERVIEW_EVERY) return Promise.resolve(slow);
    if (slowRun) return slowRun;
    slowRun = (async () => {
      let musicBytes = 0;
      for (const song of library.data.songs) {
        try {
          musicBytes += (await fs.promises.stat(song.file)).size;
        } catch {
          // Gone meanwhile.
        }
      }
      const bin = tools && tools.ytdlp();
      const ytdlp = !bin ? '' : await new Promise((resolve) => {
        execFile(bin, ['--version'], { timeout: 15000 }, (err, out) => resolve(err ? '?' : String(out).trim().slice(0, 40)));
      });
      slow = { at: Date.now(), musicBytes, ytdlp };
      slowRun = null;
      return slow;
    })();
    return slowRun;
  }

  function diskOf(dir) {
    try {
      const st = fs.statfsSync(dir);
      return { free: st.bavail * st.bsize, size: st.blocks * st.bsize };
    } catch {
      return null;
    }
  }

  const nameOf = (id) => {
    const p = config.get().profiles.find((x) => x.id === id);
    return p ? p.name : '';
  };

  /** Profile ids with an app connected right now. */
  function onlineIds() {
    return new Set((live ? live.clients() : []).map((c) => c.profileId).filter(Boolean));
  }

  function row(p, online, tokens) {
    return {
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      lastSeen: activity.lastSeen(p, { tokens, online: online.has(p.id) }),
      ...library.summary(p.id),
      admin: !!p.admin,
      master: !!p.master,
      disabled: !!p.disabled,
      pin: !!p.pin,
      devices: tokens.filter((t) => t.profileId === p.id).length,
    };
  }

  /** The devices signed in to a profile no longer are (they stay signed in to the server). */
  function signOut(profileId) {
    const cfg = config.get();
    const n = cfg.tokens.filter((t) => t.profileId === profileId).length;
    if (n) config.set({ tokens: cfg.tokens.map((t) => (t.profileId === profileId ? { ...t, profileId: null } : t)) });
    return n;
  }

  /**
   * Deletes a profile: its playlists, favourites, stats and server downloads;
   * `songs`: and every song it added, for everyone. Its devices are signed
   * out of it. Also what a profile deleting itself does. Resolves the number
   * of songs deleted.
   */
  function removeProfile(profile, { songs = false, by = null } = {}) {
    let deleted = 0;
    if (songs) deleted = library.deleteSongsOf(profile.id, by);
    if (downloads) downloads.dropProfile(profile.id);
    library.deleteProfile(profile.id);
    const cfg = config.get();
    config.set({
      profiles: cfg.profiles.filter((p) => p.id !== profile.id),
      tokens: cfg.tokens.map((t) => (t.profileId === profile.id ? { ...t, profileId: null } : t)),
    });
    return deleted;
  }

  function setProfile(id, patch) {
    config.set({ profiles: config.get().profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  async function serverRoute(req, res, p, me, { entry, ip }) {
    const isGet = req.method === 'GET';
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    if (p === '/api/admin/server' && isGet) {
      const cfg = config.get();
      const { musicBytes, ytdlp } = await slowParts();
      const trash = library.trashList();
      return sendJson(res, 200, {
        name: cfg.name,
        version,
        startedAt,
        songs: library.data.songs.length,
        profiles: cfg.profiles.length,
        musicBytes,
        trashBytes: trash.reduce((n, t) => n + t.size, 0),
        disk: diskOf(library.musicDir),
        ytdlp,
        ffmpeg: !!(tools && tools.ffmpeg()),
        downloads: !!(downloads && downloads.available()),
        level: cfg.level,
        password: !!cfg.password,
        master: (cfg.profiles.find((x) => x.master) || {}).name || '',
      });
    }
    if (p === '/api/admin/trash' && isGet) {
      const items = library.trashList().map((t) => ({
        name: t.name,
        at: t.at,
        size: t.size,
        title: t.song ? t.song.title : t.originalName,
        artist: t.song ? t.song.artist : '',
        by: t.by === 'default' ? 'Default / Shared' : nameOf(t.by),
        restorable: t.restorable,
      }));
      return sendJson(res, 200, { items, bytes: items.reduce((n, t) => n + t.size, 0) });
    }
    if (p === '/api/admin/trash/restore' && req.method === 'POST') {
      let r;
      try {
        r = await library.restoreFromTrash(String(body.name || ''));
      } catch (err) {
        throw new HttpError(404, err.message);
      }
      log(`${me.name} put back from the trash: ${body.name}`);
      return sendJson(res, 200, { ...r, rev: library.rev });
    }
    if (p === '/api/admin/trash/empty' && req.method === 'POST') {
      const deleted = library.emptyTrash(true);
      log(`${me.name} emptied the trash (${deleted} files)`);
      return sendJson(res, 200, { deleted });
    }
    if (p === '/api/admin/downloads' && isGet) {
      const batches = downloads ? downloads.all().map((b) => ({ ...b, profileName: b.profileId ? nameOf(b.profileId) : 'Default / Shared' })) : [];
      return sendJson(res, 200, { batches });
    }
    if (p === '/api/admin/downloads/cancel' && req.method === 'POST') {
      if (!downloads || !downloads.cancelKey(String(body.key || ''))) throw new HttpError(404, 'That download is over already.');
      log(`${me.name} cancelled a server download (${body.key})`);
      return sendJson(res, 200, {});
    }
    if (p === '/api/admin/sessions' && isGet) {
      return sendJson(res, 200, { sessions: sessions ? sessions.all() : [] });
    }
    if (p === '/api/admin/sessions/end' && req.method === 'POST') {
      if (!sessions || !sessions.endById(body.id)) throw new HttpError(404, 'That session is over already.');
      log(`${me.name} ended an Active Session`);
      return sendJson(res, 200, {});
    }
    if (p === '/api/admin/signins' && isGet) return sendJson(res, 200, { failures: activity.failures() });
    if (p === '/api/admin/signins/clear' && req.method === 'POST') {
      activity.clearFailures();
      return sendJson(res, 200, {});
    }
    if (p === '/api/admin/rules') {
      if (req.method === 'POST') {
        const patch = {};
        if (body.profileCreation !== undefined) patch.profileCreation = body.profileCreation === 'admins' ? 'admins' : 'anyone';
        if (body.songDelete !== undefined) patch.songDelete = body.songDelete === 'owner' ? 'owner' : 'anyone';
        config.set(patch);
        log(`${me.name} set the server's rules: ${JSON.stringify(patch)}`);
      } else if (!isGet) throw new HttpError(404, 'Nothing here.');
      const cfg = config.get();
      return sendJson(res, 200, { profileCreation: cfg.profileCreation, songDelete: cfg.songDelete });
    }
    if (p === '/api/admin/password' && req.method === 'POST') return changePassword(res, body, me, { entry, ip });
    throw new HttpError(404, 'Nothing here.');
  }

  /** The master admin changes the server password, or takes it away (levels 1 and 2). */
  function changePassword(res, body, me, { entry, ip }) {
    if (!me.master) throw new HttpError(403, 'Only the master admin can change the server password.');
    const cfg = config.get();
    const level = cfg.level || 1;
    if (throttle) throttle.check(ip);
    if (cfg.password && !checkPassword(cfg.password, String(body.current || ''))) {
      if (throttle) throttle.fail(ip);
      activity.failed('password', { ip, device: entry ? entry.device : '' });
      throw new HttpError(403, 'The current password is wrong.');
    }
    if (throttle) throttle.ok(ip);
    let password = null;
    if (body.remove) {
      if (level >= PUBLIC_LEVEL) throw new HttpError(409, `This server is at level ${level}, reachable from the internet, so it keeps a password.`);
    } else {
      const problem = passwordProblem(body.password, level);
      if (problem) throw new HttpError(400, problem);
      password = passwordEntry(String(body.password));
    }
    config.set({ password, tokens: [] });
    log(`${me.name} ${password ? 'changed' : 'took away'} the server password; every device was signed out`);
    const token = entry && issueToken ? issueToken(entry.device, me.id, null, entry.client) : '';
    return sendJson(res, 200, { token });
  }

  async function route(req, res, p, me, ctx = {}) {
    if (!p.startsWith('/api/admin/profiles')) return serverRoute(req, res, p, me, ctx);
    if (p === '/api/admin/profiles' && req.method === 'GET') {
      const online = onlineIds();
      const { tokens } = config.get();
      return sendJson(res, 200, { profiles: allProfiles().map((x) => row(x, online, tokens)), me: me.id });
    }
    if (p === '/api/admin/profiles' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const made = createProfile(body.name, body.pin, ctx);
      log(`${me.name} made profile ${made.name}`);
      return sendJson(res, 200, { profile: { id: made.id, name: made.name } });
    }
    const m = /^\/api\/admin\/profiles\/([\w-]{1,64})\/(ips|delete|pin|signout|disable|admin)$/.exec(p);
    if (!m) throw new HttpError(404, 'Nothing here.');
    const [, id, what] = m;
    const target = allProfiles().find((x) => x.id === id);
    if (!target) throw new HttpError(404, 'That profile no longer exists.');
    if (what === 'ips') {
      if (req.method !== 'GET') throw new HttpError(404, 'Nothing here.');
      return sendJson(res, 200, { createdIp: target.createdIp, ips: target.ips });
    }
    if (req.method !== 'POST') throw new HttpError(404, 'Nothing here.');
    const body = await readJsonBody(req);
    if (what === 'admin') {
      if (!me.master) throw new HttpError(403, 'Only the master admin can make admins.');
      if (target.master) throw new HttpError(409, 'The master admin is always an admin.');
      setProfile(id, { admin: !!body.admin });
      log(`${me.name} ${body.admin ? 'made' : 'took back'} admin: ${target.name}`);
      return sendJson(res, 200, {});
    }
    if (target.id === me.id) throw new HttpError(409, 'Not your own profile: that is in Settings, under Flow Server.');
    if (target.master) throw new HttpError(403, 'The master admin can only be changed on the server itself (flow-server admin).');
    if (what === 'delete') {
      const deletedSongs = removeProfile(target, { songs: !!body.songs, by: me.id });
      log(`${me.name} deleted profile ${target.name}${body.songs ? ` and its ${deletedSongs} songs` : ''}`);
      return sendJson(res, 200, { deletedSongs });
    }
    if (what === 'pin') {
      setProfile(id, { pin: null });
      log(`${me.name} took away the PIN of ${target.name}`);
      return sendJson(res, 200, {});
    }
    if (what === 'signout') {
      const devices = signOut(id);
      log(`${me.name} signed ${target.name} out on ${devices} devices`);
      return sendJson(res, 200, { devices });
    }
    const disabled = !!body.disabled;
    setProfile(id, { disabled });
    if (disabled) signOut(id);
    log(`${me.name} ${disabled ? 'disabled' : 'enabled'} profile ${target.name}`);
    return sendJson(res, 200, {});
  }

  return { route, removeProfile };
}

module.exports = { createAdminRoutes };
