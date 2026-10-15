'use strict';

// Administration (3.5): what an admin's app can see and do on the server,
// under /api/admin. Only a request signed in to an admin profile gets here;
// the master admin's own things say so (master below).
//
//   GET  /api/admin/profiles                 { profiles: [row], me }: every profile with
//                                            { id, name, createdAt, lastSeen ('now' or ms, 0: never),
//                                              addedSongs, listens (30 s or more), seconds,
//                                              admin, master, disabled, pin, devices }
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
// An admin cannot delete, disable or sign out its own profile here, nor
// anything of the master's but its IPs; the master is changed on the command
// line only (flow-server admin).

/**
 * deps: { config, library, downloads, live, activity, log, HttpError,
 * sendJson, readJsonBody, allProfiles }. Returns route(req, res, p, me),
 * which answers (404 for a path it does not know); `me` is the admin asking.
 */
function createAdminRoutes({
  config, library, downloads, live, activity, log, HttpError, sendJson, readJsonBody, allProfiles,
}) {
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
  function removeProfile(profile, { songs = false } = {}) {
    let deleted = 0;
    if (songs) deleted = library.deleteSongsOf(profile.id);
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

  async function route(req, res, p, me) {
    if (p === '/api/admin/profiles' && req.method === 'GET') {
      const online = onlineIds();
      const { tokens } = config.get();
      return sendJson(res, 200, { profiles: allProfiles().map((x) => row(x, online, tokens)), me: me.id });
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
      const deletedSongs = removeProfile(target, { songs: !!body.songs });
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
