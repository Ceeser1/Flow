'use strict';

// What the server notes about its profiles for the admins (3.5): where each
// one was made, the addresses and devices it signed in or connected from,
// when it was last seen, and the sign-ins that failed.
//
// The first three are in server.json with the profile (config.js). A profile
// is seen when it is made, signed in to, signed out of, and when an app of it
// opens or closes its live channel; those writes are spaced out (SEEN_EVERY)
// for apps that reconnect often. Its devices' own last-seen times count too
// (their tokens, written by the requests themselves), and an app connected
// right now makes it "now".
//
// Wrong PINs and wrong server passwords go into failed-signins.json in the
// server's home, the newest MAX_FAILED: not into server.json, which would
// otherwise be written on every guess.

const path = require('path');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { cleanIp } = require('./config');

const SEEN_EVERY = 60 * 1000;
const MAX_FAILED = 500;

function cleanFailures(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((f) => f && (f.kind === 'pin' || f.kind === 'password'))
    .map((f) => ({
      at: Number(f.at) || 0,
      kind: f.kind,
      profileId: f.kind === 'pin' ? String(f.profileId || '') : '',
      profileName: f.kind === 'pin' ? String(f.profileName || '').slice(0, 40) : '',
      ip: cleanIp(f.ip),
      device: String(f.device || '').slice(0, 80),
    }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_FAILED);
}

/** opts: { config, now }. */
function createActivity({ config, now = Date.now }) {
  const failedFile = path.join(config.home, 'failed-signins.json');
  let failures = cleanFailures(readJson(failedFile));

  function update(profileId, fn) {
    const cfg = config.get();
    const p = cfg.profiles.find((x) => x.id === profileId);
    if (!p) return;
    const changed = fn(p);
    if (changed) config.set({ profiles: cfg.profiles.map((x) => (x.id === profileId ? { ...x, ...changed } : x)) });
  }

  /** `ips` with this address and device first. */
  const withIp = (p, ip, device, at) => {
    const clean = cleanIp(ip);
    return clean ? [{ ip: clean, device: String(device || '').slice(0, 80), at }, ...p.ips] : p.ips;
  };

  return {
    /** A profile just made, at `ip` from `device`. */
    created(profileId, { ip, device }) {
      const at = now();
      update(profileId, (p) => ({ createdIp: cleanIp(ip), ips: withIp(p, ip, device, at), lastSeenAt: at }));
    },

    /**
     * A profile signed in to, or one of its apps connected (`quiet`: only
     * written when it was not noted a moment ago from the same place). The
     * moment is the place's own time, not lastSeenAt: an app closing sets
     * that, so an app started again within a minute was never written.
     */
    seen(profileId, { ip, device }, quiet = false) {
      const at = now();
      update(profileId, (p) => {
        const clean = cleanIp(ip);
        const top = p.ips[0];
        const same = !clean || (top && top.ip === clean && top.device === String(device || '').slice(0, 80));
        if (quiet && same && at - (top ? top.at : p.lastSeenAt) < SEEN_EVERY) return null;
        return { ips: same && top ? [{ ...top, at }, ...p.ips.slice(1)] : withIp(p, ip, device, at), lastSeenAt: at };
      });
    },

    /** A profile signed out of, or an app of it gone from its live channel. */
    left(profileId, quiet = false) {
      const at = now();
      update(profileId, (p) => (quiet && at - p.lastSeenAt < SEEN_EVERY ? null : { lastSeenAt: at }));
    },

    /**
     * When a profile was last seen: 'now' while `online` (an app of it is
     * connected), else the newest of its own time and its devices' (ms, 0:
     * never).
     */
    lastSeen(profile, { tokens = [], online = false } = {}) {
      if (online) return 'now';
      let at = profile.lastSeenAt || 0;
      for (const t of tokens) if (t.profileId === profile.id && t.lastSeenAt > at) at = t.lastSeenAt;
      return at;
    },

    /** A wrong PIN (kind 'pin', for `profile`) or wrong server password ('password'). */
    failed(kind, { profile = null, ip, device }) {
      failures = cleanFailures([{
        at: now(), kind, profileId: profile ? profile.id : '', profileName: profile ? profile.name : '', ip, device,
      }, ...failures]);
      writeJsonAtomic(failedFile, failures);
    },

    /** The failed sign-ins, newest first. */
    failures() {
      return failures.map((f) => ({ ...f }));
    },

    clearFailures() {
      failures = [];
      writeJsonAtomic(failedFile, failures);
    },
  };
}

module.exports = { createActivity, SEEN_EVERY, MAX_FAILED };
