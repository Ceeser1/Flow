# Flow Server

Hosts a Flow library on another machine (a Raspberry Pi, a Linux box, a
Windows PC) and streams it to the Flow apps. It uses `@flow/core` for the
library, so it and the apps agree on every rule. It needs Node 18 or newer and
has no other dependencies.

The apps have full control: they send each change (a song renamed or deleted, a
playlist made) to the server as a command, and a change made while the server
could not be reached is sent once it can. When two changes clash, the later one
wins, and a delete always wins over an edit.

## Running it

```sh
npm run server            # from the repo root
# or
node apps/server/src/main.js --music ~/flow-music
```

On start it prints the addresses to enter in Flow (Settings → Streaming,
Download and Synchronization). `--port`, `--music` and `--name` are remembered
for the next start. `flow-server --help` lists everything.

Songs can be dropped into the music folder by hand (a network share, a USB
stick): the server looks through the folder every five minutes, and at once when
an app asks it to synchronize.

A song deleted from an app is not gone at once. Its file moves to
`.flow-trash` in the music folder and is removed after 30 days.

### Installing it as a service (Linux)

```sh
git clone <the repo> ~/Flow && cd ~/Flow
sh apps/server/install.sh           # --level N, --domain NAME, --music DIR, --port N, --yes, --no-tailscale, --no-discovery, --uninstall
```

Works on any Linux with systemd and Node 18 or newer (a Raspberry Pi, a home
server, a VPS). It first asks how far the server should be reachable; each
level includes the ones above it:

| Level | Reachable from | You do | Risk |
|---|---|---|---|
| 1 | the home network | nothing | very low |
| 2 | and anywhere, through Tailscale | sign in to Tailscale once (a link it prints), and install Tailscale on each device | low |
| 3 | and the internet, with Caddy | get a domain name (a free DuckDNS one works) and forward ports 80 and 443 on the router | low to medium |
| 4 | and the internet, through your own web server or tunnel (nginx, Apache, Cloudflare Tunnel...) | set up the web server, its certificate and the router; `doctor` checks it | high if not set up properly |

Levels 3 and 4 need a strong password (see below).

Then it links `@flow/core` (there is no npm needed), offers ffmpeg, asks
whether the apps may find the server on the network by themselves (see
below), offers a PIN, installs Tailscale at level 2, writes and starts the
`flow-server` service (also at boot), and opens the port in ufw or firewalld
for the home network, and at level 2 for Tailscale. Run it again any time; it
only updates, and Enter keeps the level chosen before. A lower level closes
what a higher one opened. Later: `git pull && sudo systemctl restart flow-server`.

### Level 3: the internet, with Caddy

[Caddy](https://caddyserver.com) is a web server that gets its https
certificate from Let's Encrypt by itself and renews it. The installer sets
it up in front of the Flow Server:

1. It checks that ports 80 and 443 are free (with nginx or another web server
   on them, it says to use level 4) and asks for the strong password.
2. It asks for the name: one you own (its DNS A record at your public
   address), or a free `something.duckdns.org`. For a DuckDNS name it asks for
   the token and keeps the name at your address, every five minutes
   (`flow-duckdns.timer`; the token is in `/etc/flow-server`, readable by root
   only).
3. It checks that the name leads to this connection's public address (asked
   of api.ipify.org).
4. It tells you what to forward on the router, TCP 80 and 443 to this
   machine, and waits. This is the one step it can't do.
5. It installs Caddy and puts a marked Flow block into `/etc/caddy/Caddyfile`:
   the example file the package comes with is replaced, one of your own keeps
   the rest (the old one is kept as `Caddyfile.before-flow`), and a Caddyfile
   that would not be valid is not used.
6. It opens 80 and 443 in the firewall and starts the server with
   `--level 3 --public-url https://<name>`.
7. It waits until Caddy has its certificate, which proves the internet
   reaches the machine, then runs `doctor` on this machine, and says whether
   the name also works through the router from inside (many routers can't).

If no certificate comes, it names the likely reasons: the ports aren't
forwarded, the name doesn't point here, or the provider gives no public IPv4
of your own (CGNAT or DS-Lite, common with cable and fibre), where only
level 2 works. Flow fills in the Remote address by itself once it has
connected at home. Going down from level 3 takes the block out (and stops
Caddy when it served nothing else), stops the DuckDNS updates and closes
80 and 443.

Without a terminal: `--domain`, and `FLOW_SERVER_PASSWORD` and
`DUCKDNS_TOKEN` in the environment.

### Level 4: your own web server or tunnel

For a machine that already runs a web server (nginx, Apache, your own Caddy)
or a tunnel (Cloudflare Tunnel): the installer never changes its setup. It
asks which one it is, whether it runs on this machine (else its address,
which the server then trusts to say who is calling), and the https address
the apps will use, which may have a path (`https://example.com/flow`). It
prints what to add to it, with the settings audio needs that a stock setup
gets wrong:

- the caller's address and https passed on (`X-Forwarded-For`,
  `X-Forwarded-Proto`), so wrong-password waits go by the caller and plain
  http is refused;
- no buffering, both ways: songs stream as they are read, uploads go straight
  through;
- uploads up to 2 GB (nginx allows 1 MB unless told), Range passed on for
  seeking, requests of up to an hour;
- audio links (they carry the sign-in token) kept out of the access log.

For nginx, in the `server` block that has the certificate:

```nginx
location /flow/ {                       # or location / { proxy_pass http://127.0.0.1:7878; ...
    proxy_pass http://127.0.0.1:7878/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_request_buffering off;
    client_max_body_size 2g;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    access_log off;
}
```

Then it starts the server with `--level 4 --public-url <address>` and runs
`doctor` (a web server on this machine is checked past the router). Going
down from level 4 forgets the address and the trusted proxy; take Flow out of
the web server yourself.

Cloudflare Tunnel needs no open port at all, but its free plan takes uploads
of at most 100 MB, and its terms limit serving mostly audio or video through
it: read them before relying on it.

### ffmpeg (recommended)

With ffmpeg installed (`sudo apt install ffmpeg`), the server reads the length
and tags of songs dropped into the folder by hand, writes new names into a
renamed song's tags, and measures each song's loudness for "Equalize volume".
Without it, those songs show no length until an app plays them. Songs uploaded
from an app bring all of that with them either way.

## Finding the server on the network (optional, off by default)

Turned on with `flow-server --discovery` (remembered; `--no-discovery` turns it
off) or by saying yes in `install.sh`. An app with no Home address broadcasts a small UDP question on the local
network; the server answers the asker with its name and port, and the app
fills its Home address in. It needs UDP port 7878 (Flow's default port, fixed
because the apps can't know a custom one) reachable from the home network:
`install.sh` opens it in ufw or firewalld when you say yes, and a rule like
`sudo ufw allow from 192.168.0.0/24 to any port 7878` (no protocol) covers
TCP and UDP. Only askers on a private address are answered, and the answer
holds what `/api/hello` tells anyone. Each asker gets at most 30 answers a
minute, so the port can't be used to bounce traffic at someone else. It doesn't cross routers or guest WiFi
with client isolation, and if the port is taken the server says so on start
and the address has to be typed in.

## Away from home: Tailscale

[Tailscale](https://tailscale.com) (free for personal use) puts your devices
on one private network, encrypted end to end. The server is then reachable
from anywhere at its `100.x.y.z` address with no port opened on the router,
and plain http is fine inside it.

1. On the server: `install.sh` offers to install it and prints a link to add
   the machine to your account (or `curl -fsSL https://tailscale.com/install.sh | sh`,
   then `sudo tailscale up`).
2. On the PC (and phone): install Tailscale, sign in to the same account.
3. In Flow, connect once at home. The server tells the app its Tailscale
   address and Flow fills it into **Remote Server** (only if that box is
   empty; empty it by hand and it is filled in again).

The server prints the address when it starts, and looks again every five
minutes, so Tailscale may come up after it. At level 1 it doesn't tell the
apps its Tailscale address. A PIN is still worth setting: it
keeps other devices on your tailnet out. The address is only told to callers
on a private network, never to one that came through a proxy.

## PIN or password

```sh
node apps/server/src/main.js set-password        # asks for it
node apps/server/src/main.js clear-password
node apps/server/src/main.js devices             # who has signed in
```

Without one, anyone who can reach the server can use it, which is fine on a
home network. Each app enters the PIN once and gets a token back. Setting a new
PIN signs every device out. Wrong tries from one address wait longer each time
(1 s, 2 s, 4 s ...), so guessing a PIN takes years; after 30 wrong tries within
10 minutes from anywhere, everyone waits, so many addresses at once don't help
either. Devices already signed in carry on (at level 3 and 4 not for ever, see
below).

What the password has to be depends on the server's level (`--level`, set by
`install.sh`):

| Level | Reachable from | Password |
|---|---|---|
| 1 | the home network | optional; at least 4 characters (a PIN) |
| 2 | and Tailscale | optional; at least 4 characters |
| 3 | and the internet, through Caddy | required: at least 8 characters with a lower-case letter, an upper-case letter and a number |
| 4 | and the internet, through your own proxy or tunnel | the same as 3 |

At level 3 or 4 `clear-password` is refused, and without a strong password the
server lets nobody from outside past `/api/hello`. Going up sets both at once:
`flow-server set-password --level 3`. Profile PINs have no rules; they only
pick a profile once a device is past the server password.

**The home network needs no password at level 3 and 4**, only the internet
does. The server counts a caller as home when it has a private address
(`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`) and either connected directly, or
came through a proxy that names the caller (`X-Forwarded-For`). It does not
when it cannot know: Tailscale addresses (away from home), the loopback (the
server's own machine), and a proxy that passed on nothing about who called
(a hand-made one that forgets `X-Forwarded-For` would otherwise make the whole
internet look like home; `doctor` checks for it). At home `hello` says
`password: false`, so the app doesn't sign in; away it says `session: true`.
Levels 1 and 2 are unchanged: a password that is set is asked of home too.
Changing the password with `set-password` takes effect at once on a running
server and signs every device out; no restart needed.

The server also guards against a proxy set up by hand, at any level:

- Plain http straight from a public address (the port forwarded on the router)
  gets no answer: the password would cross the internet unencrypted.
- A request a proxy passes on from outside gets no answer at level 1 or 2 (a
  proxy left over, or set up by hand), and needs the strong password on a
  server whose level was never chosen. One the proxy says came over plain
  http gets no answer.
- The caller's address is taken from `X-Forwarded-For` only when the proxy is
  on the same machine, or listed with `--trusted-proxy`; the wrong-password
  waits go by it.

## Checking a server from outside: doctor

```sh
node apps/server/src/main.js doctor https://music.example.com
```

Checks the server the way the apps reach it, through whatever is in front of
it (Caddy, nginx, a tunnel): the address is https and its name is known, the
certificate is accepted and not about to run out, the Flow Server answers and
has a password, the proxy passes on who is calling and that it was https,
plain http is sent on to https or closed, port 7878 isn't open to the
internet, large uploads get through without being held back, and, with the
password, signing in, the library and seeking in a song. Each line says ok,
WARN or FAIL, with what to do; it ends with 1 when something fails.

It asks for the password (Enter skips the signed-in checks;
`FLOW_SERVER_PASSWORD` gives it without asking) and signs in as the device
"flow-server doctor". Run it on the server first, then from a machine outside
the home network (a laptop on a phone's hotspot) for the real view: many
routers can't reach their own public address from inside. `--connect-to
127.0.0.1` checks the machine it runs on under the same name, past the
router (the installer does that).

## Profiles

People sharing the server can each have a profile: the songs (All Songs, and
when each was added) are everyone's, but each profile has its own playlists,
favourites and listen stats. A profile is made, signed in to, renamed and
deleted from an app's Settings; each can have a PIN of its own.

- No profile signed in ("Default / Shared"): the playlists, favourites and
  stats made there, as before profiles existed.
- A new profile starts with a copy of the Default / Shared playlists (the same
  songs, its own to change). Favourites and stats start empty and stay with
  the Default. What is made while no profile is signed in stays with the
  Default.
- A profile can share a playlist (the box at the top right of the playlist).
  The other profiles, and the Default, then see it read-only under Shared
  Playlists, with the owner's name, and can follow it (their own list, shown
  under Followed Playlists in the menu). Only the owner changes it. `setPlaylistShared`,
  `followPlaylist` and `unfollowPlaylist` are commands like the rest.
- Renaming or deleting a song does it for everyone. Deleting a profile takes
  its playlists, favourites and stats; the songs stay.
- With a server PIN or password, a device signs in to the server first, then
  to a profile. The profiles' names are only shown to devices past the first.

## Where things are

| | Linux | Windows |
|---|---|---|
| library, settings | `~/.local/share/flow-server` | `%LOCALAPPDATA%\Flow\server` |
| music | `~/flow-music` | `~/flow-music` |

`FLOW_SERVER_HOME` and `FLOW_SERVER_MUSIC` point them elsewhere.

## Testing in WSL

WSL 2 runs a real Linux, so the server behaves there as it will on a Pi.
Windows reaches it on `localhost:7878`. Other devices (a phone) can't, because
WSL 2 sits behind its own network; for those, run the server on Windows itself
or forward the port with `netsh interface portproxy`. Keep the music on the
Linux side (`~/flow-music`), not under `/mnt/c`, which is slow and doesn't
report changes.

## The HTTP side

| | |
|---|---|
| `GET /api/hello` | name, protocol, whether a password is needed (open to anyone); `tailscale: { ip, dns, port }` when the server is on a tailnet, to private callers only; `publicUrl` at level 3 or 4 |
| `GET /api/check` | what the server made of this request: `{ proxied, trusted, ip, proto, level, locked }` (open to anyone; for `doctor`) |
| `POST /api/login` | `{ password, device }` → `{ token }` |
| `GET /api/library?since=<rev>&as=<profile>` | `{ rev, library, profile }`, or 204 when nothing changed for that profile; the library has the profile's `follows` and the others' `sharedPlaylists` |
| `POST /api/commands` | `{ commands }` → `{ rev, results }` (see `@flow/core/commands`) |
| `PUT /api/songs/<id>?meta=<json>` | upload a song; the body is the file |
| `GET /api/songs/<id>/audio` | the song's file, with Range for seeking |
| `POST /api/rescan` | look through the music folder now |
| `GET /api/profiles` | `{ profiles: [{ id, name, pin }], current }` |
| `POST /api/profiles` | `{ name, pin, device }`: a new profile, signed in → `{ token, profile }` |
| `POST /api/profiles/login` | `{ profileId, pin, device }` → `{ token, profile }` |
| `POST /api/profiles/logout`, `/rename` `{ name }`, `/delete` | the signed-in profile |

With a password, requests carry `Authorization: Bearer <token>`, or `?t=<token>`
for audio (an `<audio>` element can't send headers). The token from signing
in to a profile says which profile a request is for; commands and uploads
act on it, and the library comes as it sees it.

At level 3 and 4 a token is a session: it ends after 30 minutes without a
request, or 24 hours in all, however busy, or when the server restarts (and
`hello` says `session: true`, so an app signs in with its password each time
it starts instead of using the token it kept). After that every request gets 401
until the app sends the password to `POST /api/login` again; a token an app
kept from before (or from a lower level) gets nowhere, and a login without a
password is refused (401, and no wrong try counted). Signing in to a profile
carries the session on but doesn't renew it. An app that is open polls every
few seconds, so only one that was closed or asleep notices; Flow signs in again
by itself with the password it has saved, and says "needs a PIN or password"
when it has none. Levels 1 and 2 keep their tokens.
