# Flow Server API

Everything a Flow Server answers, and how to call it. The Flow apps use
exactly these routes; a script, a test tool or another client can use them
the same way. The code is in `apps/server/src/http.js` (routes),
`sessions.js`, `downloads.js`, `live.js` and `packages/core/src/commands.js`.

Contents: [Basics](#basics) · [Signing in](#signing-in) ·
[Server info](#server-info) · [Library](#library) · [Commands](#commands) ·
[Songs](#songs) · [Profiles](#profiles) · [Live channel](#live-channel) ·
[Active Sessions](#active-sessions) · [Downloads by the server](#downloads-by-the-server) ·
[Finding the server (UDP)](#finding-the-server-udp)

## Basics

- **Address:** `http://<server>:7878` on the home network or Tailscale (7878
  is the default port, `--port` changes it). At level 3 or 4 also the https
  address in front of it, which may have a path (`https://example.com/flow`);
  the routes below go after it.
- **Format:** requests and answers are JSON (`Content-Type: application/json`),
  except song files, covers and the live channel. A JSON body may be at most
  8 MB. A trailing `/` on a path is ignored.
- **HEAD** works wherever GET does.
- **CORS:** every answer allows any origin, the methods GET, HEAD, POST, PUT,
  DELETE, OPTIONS and the headers `Authorization`, `Content-Type`, `Range`.
  An OPTIONS request gets 204.
- **Errors:** a status code and `{ "error": "<message fit to show the user>" }`,
  sometimes with more fields (`retryIn` for a declined session join). Common
  codes: 400 bad request, 401 password needed or session ended, 403 not
  allowed (or the server refuses this kind of connection at all, see
  [Signing in](#signing-in)), 404 not found, 409 conflict with the current
  state, 413 too large, 415 wrong file type, 429 too many tries, 501 feature
  off, 503 too many apps connected.
- **Ids:** song, playlist and profile ids are 1-64 characters of
  `A-Z a-z 0-9 _ -`. An app's install id (`client`) is 8-64 of the same; each
  Flow install makes one for itself and keeps it.
- **`rev`:** the library's revision, a number that goes up with every change.
  Many answers carry it so an app knows whether to fetch the library again.

### Example

```sh
S=http://192.168.1.50:7878
curl $S/api/hello
TOKEN=$(curl -s -X POST $S/api/login -H 'Content-Type: application/json' \
  -d '{"password":"secret","device":"My script","client":"my-script-0001"}' | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" $S/api/library | jq '.library.songs | length'
```

## Signing in

**Without a server password** every route is open; no token is needed (one
is only used to say which profile a request is for).

**With a password**, every route except `/api/hello`, `/api/check` and
`/api/login` needs a token:

- the header `Authorization: Bearer <token>`, or
- `?t=<token>` in the address (for audio and covers in an `<audio>` or
  `<img>` element, which cannot send headers).

### POST /api/login

```json
{ "password": "secret", "device": "Living room PC", "client": "a1b2c3d4e5f6" }
```

→ `{ "token": "..." }`

- `device`: a name for the device, shown by `flow-server devices` (at most
  80 characters; the caller's address when left out).
- `client`: the app's install id, optional. With it, signing in again
  replaces only this app's old token, so two PCs of the same name don't sign
  each other out.
- 401 `Wrong password.` / `This server needs its password.`
- 429 after wrong tries: each wrong one from the same address waits twice as
  long as the one before (1 s, 2 s, 4 s ... up to 5 minutes); after 30 wrong
  ones within 10 minutes from anywhere, everyone waits.

`flow-server set-password` signs every device out: their tokens stop working
at once.

### Levels 3 and 4 (reachable from the internet)

- A token is a **session**: it ends after 30 minutes without a request, after
  24 hours in all, or when the server restarts. Then every request gets 401
  until the client sends the password to `/api/login` again. `/api/hello`
  says `"session": true`, so a client should sign in with the password each
  time it starts rather than reuse a saved token.
- The **home network needs no password** there (a private address, connected
  directly or through a proxy that passes on `X-Forwarded-For`).
  `/api/hello` then says `"password": false`.
- Without a strong password, nobody from outside gets past `/api/hello`
  (403).

### Requests that get no answer (403)

At any level: plain http straight from a public address, and plain http
through a proxy from outside. At level 1 and 2: anything a proxy passes on
from outside.

## Server info

### GET /api/hello

Open to anyone (only the refusals above apply).

```json
{
  "app": "flow-server",
  "protocol": 1,
  "features": ["profiles", "admin", "pin", "download", "search", "sessions", "trim"],
  "version": "3.3.3",
  "id": "<server id>",
  "name": "Flow Server",
  "password": true,
  "tailscale": { "ip": "100.64.0.5", "dns": "pi.tailnet.ts.net", "port": 7878 },
  "publicUrl": "https://music.example.com",
  "session": true
}
```

- `features`: `profiles` always; `admin` from 3.5 (the
  [Administration](#administration) routes); `pin` from 3.5.1 (a profile
  changes its own PIN, `POST /api/profiles/pin`); `download` when the server can download
  songs itself (yt-dlp and ffmpeg there, not turned off), and with it
  `search` (searching by a song's name; older servers lack it); `sessions` for
  Active Sessions; `trim` when ffmpeg is there.
- `password`: whether this caller has to sign in.
- `tailscale`: only at level 2 and up, only to callers on a private network
  that did not come through a proxy.
- `publicUrl`: only at level 3 and 4.
- `session`: only at level 3 and 4, away from home.

### GET /api/check

Open to anyone. What the server made of this request, for `flow-server
doctor`:

```json
{ "proxied": true, "trusted": true, "ip": "203.0.113.7", "proto": "https", "level": 3, "locked": null }
```

`locked`: why nobody from outside is let in (no strong password), else null.

### GET /api/time

→ `{ "time": 1760270000000 }`: the server's clock in ms, for playing in step
with other devices.

## Library

### GET /api/library

Query: `since=<rev>` and `as=<profile id>` (both optional).

- 204 with no body when `since` is the current `rev` and `as` is the profile
  this token is signed in to (empty for none): nothing changed.
- Otherwise 200:

```json
{
  "rev": 412,
  "library": { ... },
  "profile": { "id": "9f3a1c0b7e2d", "name": "Sam", "pin": false, "createdAt": 1760270000000, "admin": false, "master": false },
  "rules": { "createProfiles": true, "songDelete": "anyone" }
}
```

`profile` is null without one. `rules` (3.5): the admins' rules as they touch
this caller: whether it may make profiles, and `songDelete` `"owner"` when
only who added a song (and the admins) may delete it for everyone.
`library`, as the signed-in profile sees it:

| Field | |
|---|---|
| `songs` | `[{ id, file, title, artist, mix, duration, format, sourceUrl, sourceKey, sourcePlaylistUrl, addedAt, addedBy, stats, favouriteAt, loudness, cover, cut, ... }]`. `file` is relative to the music folder. `stats` and `favouriteAt` are this profile's. |
| `playlists` | `[{ id, name, createdAt, entries: [{ songId, addedAt }], source, shared }]`, this profile's own |
| `sharedPlaylists` | other profiles' shared playlists, read-only: `{ id, name, createdAt, entries, ownerId, ownerName }` |
| `follows` | ids of the shared playlists this profile follows |
| `playlistListened` | seconds listened per list: `{ [playlistId \| "all" \| "favourites" \| "smart:..."]: seconds }` |
| `listening` | when and what this profile listened to (3.5, for the Statistics): `{ days: { "YYYY-MM-DD": seconds }, grid: [168 seconds, Monday 0-1 o'clock first], songMonths: { "YYYY-MM": { songId: seconds } }, run, longest }`; `run` / `longest`: the current and the longest listening session `{ start, end, seconds }` (songs with gaps of at most 10 minutes) |
| `profileNames` | `{ [profileId]: name }`, for the songs' `addedBy` (`"default"`: Default / Shared) |

- `stats`: `{ plays, stops, skips, sessions, listened, lastPlayedAt }`.
- `cover`: the cover's version (see [covers](#get-apisongsidcover)), `"-"`
  when none was found, null when not looked for yet.
- "All Songs" and "Favourites" are not stored: all songs, and the songs with
  a `favouriteAt`.

### POST /api/rescan

Looks through the music folder now (it also does every five minutes).
→ `{ "added": 2, "removed": 0, "moved": 1, "rev": 413 }`

## Commands

### POST /api/commands

Every change to the library (except uploads, trims and covers) is a command.
Send up to 5000 at once:

```json
{
  "commands": [
    { "cid": "c-001", "at": 1760270000000, "type": "createPlaylist", "playlistId": "p-roadtrip", "name": "Road trip" },
    { "cid": "c-002", "at": 1760270000500, "type": "addSongsToPlaylist", "playlistId": "p-roadtrip", "songIds": ["s1", "s2"] }
  ]
}
```

→ `{ "rev": 414, "results": [{ "cid": "c-001", "ok": true, "value": "p-roadtrip" }, { "cid": "c-002", "ok": true }] }`

- `cid`: unique per command. A command sent twice (its answer got lost)
  counts once; the second gets `skipped: "repeat"`.
- `at`: when the change was made (ms; now when left out). The last change
  wins: a command older than the last change to the same thing is skipped
  (`"stale"`). A delete always wins.
- Commands act on the signed-in profile: its playlists, favourites and stats.
  A song's names (`editSong`) and deleting a song are for everyone.
- Each result is `{ cid, ok: true }`, maybe with `value` (a new id),
  `skipped` (`repeat`, `stale`, `gone`: the song or playlist no longer exists,
  `exists`, `known`) or `deletedSongs`; or `{ cid, ok: false, error }`. One
  command failing does not stop the others.

| `type` | Arguments | Does |
|---|---|---|
| `createPlaylist` | `playlistId`, `name`, `source?` | a new playlist with the id the client chose; a name taken already gets " (2)". `value`: its id |
| `renamePlaylist` | `playlistId`, `name` | |
| `deletePlaylist` | `playlistId`, `deleteSongs?` | with `deleteSongs: true` also the songs no other playlist or favourite of any profile has (`deletedSongs` lists them) |
| `setPlaylistSource` | `playlistId`, `source: { url, kind }` | the link a playlist was imported from |
| `setPlaylistShared` | `playlistId`, `shared` | other profiles may see and follow it |
| `followPlaylist` / `unfollowPlaylist` | `playlistId` | another profile's shared playlist |
| `addSongToPlaylists` | `songId`, `playlistIds` | one song into several playlists |
| `addSongsToPlaylist` | `playlistId`, `songIds` | several songs into one playlist |
| `removeFromPlaylist` | `playlistId`, `songId` | |
| `deleteSong` | `songId` | for everyone; the file goes to `.flow-trash` for 30 days, the song with it (an admin can restore it). With the rule `songDelete: "owner"` only the profile that added it and the admins may (`ok: false` with the reason otherwise; `deletePlaylist` then keeps those songs) |
| `editSong` | `songId`, `artist`, `title`, `mix` | new names (title required); the file is renamed and its tags rewritten |
| `setFavourite` | `songId`, `on` | |
| `setLoudness` | `songId`, `loudness` | the measured loudness, for Equalize volume |
| `setDuration` | `songId`, `duration` | only when the server doesn't know the length (`skipped: "known"` otherwise) |
| `recordListen` | `songId`, `listened`, `duration`, `contextId?`, `tz?` | a listen: `listened` seconds heard of `duration`; counted into the profile's stats and `listening`. `tz`: the app's `Date.getTimezoneOffset()`, for the day and hour it was heard (the server's own without it) |

## Songs

`<id>` is a song's id from the library.

### PUT /api/songs/\<id\>?meta=\<json\>

Uploads a song. The body is the audio file itself (at most 2 GB), `meta` the
song's details as URL-encoded JSON:

| `meta` field | |
|---|---|
| `format` | required: `mp3`, `m4a`, `aac`, `opus`, `ogg`, `oga`, `flac` or `wav` (else 415) |
| `artist`, `title`, `mix` | the names (`title` defaults to "Untitled") |
| `duration` | seconds |
| `sourceUrl`, `sourceKey`, `sourcePlaylistUrl` | where it was downloaded from |
| `addedAt`, `favouriteAt`, `stats`, `loudness`, `cut` | carried over from the app |
| `playlistIds` | the profile's playlists to put it into |
| `onExisting` | `"new"`: take it even if the server has it already |
| `convert` | `{ "alwaysMp3", "quality", "keepMp3" }`: the app's "Upload songs to the server as MP3" choice (the phones send it). With `alwaysMp3` the server converts the song into MP3 at `quality` kbit/s (64 to 320, else 192), an MP3 too when `keepMp3` is `false` |
| `path` | where the file is in the app's music folder, like `Linkin Park/Hybrid Theory/In the End.mp3`. A server set to keep uploaded folder structures (`--keep-folders`) saves it there, inside its music folder (and inside `Uploads/` with `--separate-folders`); otherwise it is saved as "Artist - Title". `..`, leading dots and characters file systems refuse are taken out, and at most 12 folders are kept |

The `<id>` is kept when it is free, so the app's playlists keep pointing at
the song.

- → `{ "existing": false, "id": "<id>", "rev": 415 }`: taken.
- → `{ "existing": true, "id": "<id there>", "rev": 415, "names": { "artist", "title", "mix" } }`:
  the server has it already (the same id, the same source, or the same names
  and length); the file was not stored. Send again with `onExisting: "new"`
  to keep it as a song of its own.

An upload is stored as it comes and converted afterwards, in the background,
once no upload has come in for 15 seconds (so a batch goes up first): into
MP3 by `convert`, and an Ogg Vorbis file into MP3 at 192 kbit/s (or the
`convert` quality) always, as the server's own downloads. The song keeps its
id; its `format` and file change, which the library shows with a new `rev`.
The old file goes to the trash. A server without ffmpeg keeps every upload as
it is.

```sh
curl -X PUT -H "Authorization: Bearer $TOKEN" --data-binary @song.mp3 \
  "$S/api/songs/my-song-1?meta=$(jq -rn '{format:"mp3",artist:"Daft Punk",title:"Veridis Quo"}|@uri')"
```

### GET /api/songs/\<id\>/audio

The song's file as it is, with `Range` for seeking (206, or 416 out of range).
`?vorbis=0`: an Ogg Vorbis song as Ogg Opus instead (for iOS; converted once
with ffmpeg, then kept).

### GET /api/songs/\<id\>/peaks

→ `{ "peaks": [ ... ] }`: the song's waveform, for a trim editor. Needs ffmpeg.

### POST /api/songs/\<id\>/trim

Only when `/api/hello` lists `trim`. Cuts the song's file to `start`..`end`
seconds; the uncut file goes to the trash.

```json
{ "start": 3.2, "end": 241.5, "base": "", "cut": "t-8c1e2a" }
```

- `cut`: an id for this trim, chosen by the client; `base`: the song's
  current `cut` (empty for an untrimmed song).
- → `{ "song": { ... }, "rev": 416 }`, or `{ "skipped": "repeat" | "changed" | "gone", "rev" }`:
  done already, trimmed by another app since (not applied), deleted.
- 403 for a song another profile uploaded: only the uploader trims it.

### GET /api/songs/\<id\>/cover

The cover, a 512 x 512 JPEG; 404 when it has none. With `?v=<version>` (the
song's `cover` field) it may be cached for good. `ETag` / `If-None-Match`
work (304).

### PUT /api/songs/\<id\>/cover

The body is a JPEG (at most 4 MB; made 512 x 512 with ffmpeg if it is not).
Kept only when the song has no cover yet. → `{ "cover": "<version>", "rev": 417 }`

## Profiles

People sharing a server can each have a profile: the songs are everyone's,
playlists, favourites and stats each profile's own. Without a profile a
request is for "Default / Shared". With a server password, these routes need
the token from `/api/login` first.

| Route | Body | Answer |
|---|---|---|
| `GET /api/profiles` | | `{ profiles: [{ id, name, pin, createdAt, admin, master }], current, createProfiles }` (`pin`: whether it has one; `current`: this token's profile id or null; `createProfiles`: whether this caller may make one) |
| `POST /api/profiles` | `{ name, pin?, device?, client? }` | a new profile, signed in: `{ token, profile }`. 409 for a name taken, 403 when only admins may make profiles (the first one on a server always may) |
| `POST /api/profiles/login` | `{ profileId, pin?, device?, client? }` | `{ token, profile }`. 403 wrong PIN (waits as for the password) or a disabled profile, 404 gone |
| `POST /api/profiles/logout` | | `{}`: this token is for no profile again |
| `POST /api/profiles/rename` | `{ name, pin? }` | `{ profile }`. From 3.5.1 `pin` is the profile's current PIN: 403 when it has one and that is wrong or missing (waits as for the password) |
| `POST /api/profiles/pin` | `{ pin?, newPin }` | from 3.5.1 (`pin` in the features): `{ profile }`. `pin`: the current one, checked as for rename; `newPin`: the new one, `""` for none. The master admin's needs at least 4 characters (400). Other devices signed in to it stay signed in |
| `POST /api/profiles/delete` | | `{}`: deletes the signed-in profile with its playlists, favourites and stats (the songs stay) |

The `token` from signing in to a profile replaces the old one: use it from
then on. Profile names are at most 40 characters; rename, pin and delete answer
409 without a profile signed in.

The first profile a server ever has is an admin (on a server from before
3.5, its oldest profile, once), so from 3.5.1 it needs a PIN: `POST
/api/profiles` answers 400 without one. Only a profile with a PIN is an admin:
an admin cannot remove its own (400), and one whose PIN is reset loses admin. `master`: the one master admin, made on the
server only (`flow-server admin master <name>`, or the installer).

## Administration

From 3.5 (`admin` in `/api/hello`'s features), for a token signed in to an
admin profile; 403 for anyone else. Routes marked *master* only for the
master admin. Nobody changes their own profile or the master's here.

| Route | Body | Answer |
|---|---|---|
| `GET /api/admin/server` | | `{ name, version, startedAt, songs, profiles, musicBytes, trashBytes, disk: { free, size }, ytdlp, ffmpeg, downloads, level, password, master }` |
| `GET /api/admin/profiles` | | `{ profiles: [{ id, name, createdAt, lastSeen, addedSongs, listens, seconds, admin, master, disabled, pin, devices }], me }`. `lastSeen`: `"now"` while an app of it is connected, else ms (0: never). `listens`: listens of 30 seconds or more; `seconds`: time listened |
| `POST /api/admin/profiles` | `{ name, pin? }` | a profile for someone else; the admin stays signed in to its own: `{ profile }` |
| `GET /api/admin/profiles/<id>/ips` | | `{ createdIp, ips: [{ ip, device, at }] }`: where it was made (`""` before 3.5) and the newest 100 addresses and devices it signed in or connected from |
| `POST /api/admin/profiles/<id>/delete` | `{ songs }` | deletes it; `songs: true` also every song it added, for everyone (to the trash): `{ deletedSongs }` |
| `POST /api/admin/profiles/<id>/pin` | | its PIN taken away, and admin with it: `{ revokedAdmin }` |
| `POST /api/admin/profiles/<id>/signout` | | its devices are signed out of it (they stay on the server): `{ devices }` |
| `POST /api/admin/profiles/<id>/disable` | `{ disabled }` | signing in to it refused (its devices signed out of it), or allowed again |
| `POST /api/admin/profiles/<id>/admin` | `{ admin }` | *master*: an admin made or taken back; 409 to make one of a profile without a PIN |
| `GET /api/admin/signins` | | `{ failures: [{ at, kind: "pin" \| "password", profileId, profileName, ip, device }] }`, the newest 500 |
| `POST /api/admin/signins/clear` | | |
| `GET /api/admin/downloads` | | every profile's server download: `{ batches: [{ key, profileId, profileName, state, name, url, createdAt, songs, saved, open, failed }] }` |
| `POST /api/admin/downloads/cancel` | `{ key }` | that download cancelled |
| `GET /api/admin/sessions` | | every Active Session: `{ sessions: [...] }` as `/api/sessions` lists them, with `shared` |
| `POST /api/admin/sessions/end` | `{ id }` | its members are out (told `left`); a host still playing has a session of its own again |
| `GET /api/admin/trash` | | `{ items: [{ name, at, size, title, artist, by, addedBy, restorable }], bytes }` (`by`: who deleted it, `addedBy`: who added it; names, empty when not known) |
| `POST /api/admin/trash/restore` | `{ name }` | back as it was (`restorable`: its id, names, stats, favourites and playlist places): `{ songId, rev }`; else as a new song: `{ scanned, rev }` |
| `POST /api/admin/trash/empty` | | every file in it gone for good: `{ deleted }` |
| `GET` / `POST /api/admin/rules` | `{ profileCreation?: "anyone" \| "admins", songDelete?: "anyone" \| "owner" }` | the rules: `{ profileCreation, songDelete }` |
| `POST /api/admin/password` | `{ current, password }` or `{ current, remove: true }` | *master*: the server password changed (or taken away, levels 1 and 2 only). Every device is signed out; the master's own gets `{ token }`. 403 for a wrong `current` |

## Live channel

### GET /api/live?client=\<install id\>&device=\<name\>

A Server-Sent Events stream (`text/event-stream`), kept open while the app
is connected; the server pushes events on it as they happen. One per app: a
second one of the same `client` replaces the first. `device` is the name
shown to other devices. With a token from an app that sent its `client` when
signing in, only that app may open its channel (403).

```
event: hello
data: {"client":"a1b2c3d4e5f6","serverTime":1760270000000,"pingMs":10000}

: ping 1760270010000

event: sessions
data: {"sessions":[...]}
```

- `hello` first, then a `: ping` comment every 10 seconds.
- The token is checked again at each ping: a changed password or an ended
  session closes the stream with `end { reason: "auth" }`. Other reasons:
  `replaced`, `shutdown`.
- 503 when 200 apps are connected already.
- Through a proxy it has to be passed on unbuffered (`proxy_buffering off`
  in nginx; the server also sends `X-Accel-Buffering: no`).

```sh
curl -N -H "Authorization: Bearer $TOKEN" "$S/api/live?client=my-script-0001&device=Terminal"
```

## Active Sessions

Devices on the server listening together. Every app that plays something is
a session with itself as host; others ask to join, and their buttons are
carried out by the host. Kept in memory only: a restart ends them all. A
client needs its live channel open to take part; it hears back there.

### GET /api/sessions?client=\<install id\>

```json
{
  "sessions": [{
    "id": "4e1f0a9c2b7d6e83", "name": "Sam - Living room speakers",
    "host": { "client": "...", "profileName": "Sam", "device": "Living room PC" },
    "song": { "id": "s1", "title": "Veridis Quo", "artist": "Daft Punk", "mix": "" },
    "playing": true, "listeners": 1,
    "members": [{ "client": "...", "profileName": "Sam", "device": "Living room PC", "mode": "host", "joinedAt": 1760270000000 }]
  }],
  "mine": { "session": { "id", "name", "hostClient", "members", "allowVolume" }, "state": { ... }, "host": false },
  "request": { "requestId": "...", "sessionId": "...", "expiresIn": 42000 }
}
```

`mine` is null outside a session, `request` null without an open request to
join.

### POST /api/sessions

`{ "client": "<install id>", "type": "<type>", ... }` (`client` may be left
out when the token names the app). → `{ "ok": true, ... }`

| `type` | Fields | Answer / effect |
|---|---|---|
| `state` | `state` (below) | the host's playback, on every change and every few seconds while playing. → `{ sessionId }` |
| `join` | `sessionId`, `mode`: `"remote"` (control only) or `"here"` (plays along) | asks the host. → `{ requestId, expiresIn }`. 429 with `retryIn` for a minute after a decline; 409 full (8 devices) |
| `cancelJoin` | | takes the request back |
| `answer` | `requestId`, `accept` | the host's Accept / Decline. → `{ accepted }` |
| `control` | `action` and its fields, at the top level | a member's button, sent to the host. → `{ sent: true }`. At most 30 per 10 seconds (429) |
| `mode` | `mode`: `"remote"` or `"here"` | a member switches |
| `leave` | | out of the session; a host hands over to the next member |

**`state`** (the host's playback; all optional):
`songId`, `title`, `artist`, `mix`, `duration`, `playing`, `position`,
`repeat`, `shuffle`, `contextId`, `contextName`, `ids` (the songs of what
plays, in order; leave out when unchanged), `queue` (`{ contextId, currentId,
shuffle, manual, auto, used, cursor, history }`), `at` (when `position` was
read, in server time), `name` ("Profile - Output device"), `shared` (false:
not listed for others), `allowVolume`, `volume` (0-1), `crossfade`
(seconds), `outputDelay` (ms).

**`control` actions:**

| `action` | Fields |
|---|---|
| `toggle`, `play`, `pause`, `next`, `prev`, `queueClear` | |
| `seek` | `position` (seconds) |
| `shuffle`, `repeat` | `on` |
| `queueAdd` | `songId` |
| `queueRemove`, `queuePlay` | `part` (`"manual"` or `"auto"`), `index` |
| `queueMove` | `part`, `from`, `to` |
| `playSong` | `songId`, `ids?`, `contextName?`, `contextId?` |
| `playPlaylist` | `playlistId` or `name` (`"all"` / "All Songs" works too); worked out from the library |
| `volume` | `value` (0-1); only when the host allows it (403) |

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"client":"my-script-0001","type":"control","action":"seek","position":60}' $S/api/sessions
```

**Events on the live channel:**

| Event | To | Data |
|---|---|---|
| `sessions` | everyone, when the list changes | `{ sessions }` |
| `joinRequest` | the host | `{ requestId, sessionId, client, profileName, device, ip, expiresIn }` |
| `joinCancelled` | the host | `{ requestId, sessionId }`: taken back or run out |
| `joinResult` | who asked | `{ requestId, sessionId, ok: true, session, state }`, or `ok: false` with `reason`: `declined` (+ `retryIn`), `expired`, `full`, `ended`, `unshared` |
| `session` | every member, when members change | `{ session }` |
| `state` | the members | `{ sessionId, state }` |
| `control` | the host | `{ sessionId, action, args, from: { client, profileName, device } }` |
| `hostChanged` | the new host | `{ sessionId, previous: { client, profileName, device }, reason, state, session }` |
| `left` | a member that is out | `{ sessionId, reason }`: `left`, `dropped`, `joinedOther`, `ended`, `idle` |

A request to join runs out after a minute. A host whose live channel drops
hands over after 15 seconds unless it is back. The last member out ends the
session.

## Downloads by the server

Only when `/api/hello` lists `download` (else 501). The server reads a link,
downloads its songs in the background and keeps them aside until a client
finishes (trims and names) each one. One batch per profile (without
profiles, one for everybody).

| Route | Body | Answer |
|---|---|---|
| `GET /api/downloads` | | `{ batch }`, null when there is none |
| `POST /api/downloads` | `{ url, kind, options, cookies? }` or `{ items, name, options }` | a new batch: `{ batch }`. 409 with one open already |
| `DELETE /api/downloads` | | cancels the whole batch: `{ batch: null }` |
| `POST /api/downloads/search` | `{ query, page? }` | uploads for a song's name, below; downloads nothing |
| `GET /api/downloads/items/<i>/peaks` | | `{ peaks }` of a `ready` song |
| `GET /api/downloads/items/<i>/audio` | | the prepared file, with `Range` (and `?t=`) |
| `GET /api/downloads/items/<i>/cover` | | the cover found (`?v=` the item's `cover`); 404 without one |
| `POST /api/downloads/items/<i>/finish` | below | saved into the library: `{ song, batch, playlistId, rev }` |
| `POST /api/downloads/items/<i>/retry` | | a `failed` song again: `{ batch }` |
| `DELETE /api/downloads/items/<i>` | | one song thrown away: `{ batch }` |

**Starting:** `url` is an http(s) link on the internet or a `spotify:` link
(never this machine or the home network: 400). `kind`: `"song"` (just that
one, even from a link into a playlist) or `"list"`. `options`: `{ alwaysMp3,
quality (64-320, default 192), keepMp3 }`. `cookies`: a Netscape cookie
file's text, for sites that need a signed-in visitor; only the link's site's
lines are kept. Or, for uploads picked from a search: `items`, up to 50
`{ url, title, duration }` (each such a link), and `name` (the search's words):
the batch is `ready` at once, its `source` `{ url: "", name, kind: "search" }`,
and no playlist is made unless a finish asks for one.

**Searching by name** (only with `search` in `/api/hello`): `query` is a
song's name as typed (`"Linkin Park - Numb"`, "Artist - Title" split at the
dash; at most 200 characters, else 400). `page` (default 0) is how many
times more was asked for: 0 searches YouTube and YouTube Music, 1
SoundCloud, Bandcamp and the Internet Archive, 2 and on YouTube's results
further down (11-20, 21-30 ...; nothing past page 10). A page can repeat
uploads of an earlier one. It takes a few seconds (up to 90; 504 then); a newer search of the
same profile stops this one (409). Nothing is downloaded: send the `url` of
the upload picked as a new batch with `kind: "song"`, or several as `items`.

```json
{
  "query": "Linkin Park - Numb", "artist": "Linkin Park", "title": "Numb", "page": 0,
  "results": [{
    "id": "...", "title": "Numb", "channel": "Linkin Park", "duration": 187, "album": "Meteora",
    "site": "YouTube", "url": "https://www.youtube.com/watch?v=...", "key": "youtube:...",
    "quality": "good", "versions": [], "existing": null
  }]
}
```

- `results`: best first, at most 8 (10 on YouTube's further pages). `quality`: `good` (the song itself, from
  the artist or YouTube Music), `shaky` or `none`. `versions`: words in the
  title that make it another version and were not typed (`live`, `lyrics`,
  `remix` ...). `existing`: the library song of that very upload, or null.
  `album` only for YouTube Music's songs.

**The batch:**

```json
{
  "id": "...", "state": "ready", "error": "",
  "source": { "url": "...", "name": "Road trip", "kind": "spotify" },
  "single": false, "truncated": false,
  "options": { "alwaysMp3": false, "quality": 192, "keepMp3": true },
  "cookies": false, "playlistId": null, "createdAt": 0, "expiresAt": 0,
  "progress": null,
  "items": [{
    "index": 0, "title": "...", "duration": 245, "url": "...", "state": "ready", "error": "",
    "meta": { "artist": "...", "title": "...", "mix": "" }, "artistFromChannel": false,
    "existing": null, "summary": "...", "cover": "<version>", "progress": null
  }]
}
```

- Batch `state`: `listing` (reading the link; poll, `progress` is
  `{ frac, text }` meanwhile), `ready`, `failed` (`error`; cancel it).
  `source.kind` is the link's site (`youtube`, `spotify`, ...), `name` the
  list's name.
- Item `state`: `queued`, `downloading` (with `progress: { frac, text }`),
  `converting`, `ready`, `failed` (`error`), `library` (the library has it
  already; `existing` says which), `saving`, `saved`, `added`, `discarded`.
- At most 500 songs a batch. A batch nobody looks at for 30 days is thrown
  away.

**Finishing a song** (`ready` only):

```json
{
  "meta": { "artist": "Daft Punk", "title": "Veridis Quo", "mix": "" },
  "start": 0, "end": 245,
  "playlistIds": [],
  "playlist": { "name": "Road trip", "mergeInto": null },
  "existing": [3, 7]
}
```

- `start`/`end`: the trim in seconds. `title` is required.
- `playlist`: the batch's own playlist, made by the first song finished
  (`mergeInto`: an existing playlist's id to use instead); null for none.
- `existing`: indexes of `library` items to put into the same playlists.
- `batch` in the answer is null once every song is dealt with.

## Finding the server (UDP)

Off unless the server was started with `--discovery`. A client broadcasts
this datagram to UDP port 7878 (always 7878, whatever the server's port):

```json
{"app":"flow-discover","v":1}
```

Each server that hears it answers the sender directly:

```json
{"app":"flow-server","id":"<server id>","name":"Flow Server","port":7878,"protocol":1}
```

Only askers on a private address are answered, at most 30 times a minute
each. Send the question a few times (datagrams get lost) and collect answers
for a couple of seconds.
