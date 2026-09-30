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
sh apps/server/install.sh           # --music DIR, --port N, --yes, --no-tailscale, --no-discovery, --uninstall
```

Works on any Linux with systemd and Node 18 or newer (a Raspberry Pi, a home
server, a VPS). It links `@flow/core` (there is no npm needed), offers ffmpeg,
writes and starts the `flow-server` service (also at boot), opens the port in
ufw or firewalld for the home network and for Tailscale, and offers to
install Tailscale. It asks whether the apps may find the server on the network
by themselves (see below). Run it again any time; it only updates. Later:
`git pull && sudo systemctl restart flow-server`.

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
   empty, and only once: clear it and it stays empty).

The server prints the address when it starts, and looks again every five
minutes, so Tailscale may come up after it. A PIN is still worth setting: it
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
PIN signs every device out. Wrong tries wait longer each time (1 s, 2 s, 4 s ...),
so guessing a PIN takes years.

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
| `GET /api/hello` | name, protocol, whether a password is needed (open to anyone); `tailscale: { ip, dns, port }` when the server is on a tailnet, to private callers only |
| `POST /api/login` | `{ password, device }` → `{ token }` |
| `GET /api/library?since=<rev>&as=<profile>` | `{ rev, library, profile }`, or 204 when nothing changed for that profile |
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
