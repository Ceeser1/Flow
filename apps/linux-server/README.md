# Flow Server

Hosts a Flow library on another machine (a Raspberry Pi, a Linux box, a
Windows PC) and streams it to the Flow apps. It uses `@flow/core` for the
library, so it and the apps agree on every rule. It needs Node 18 or newer and
has no other dependencies.

This folder holds the server itself and its Linux installer (`install.sh`). On
Windows, the Flow Server installer in `apps/windows-server` sets up the same
server with the Node.js it runs on; see its README.

The apps have full control: they send each change (a song renamed or deleted, a
playlist made) to the server as a command, and a change made while the server
could not be reached is sent once it can. When two changes clash, the later one
wins, and a delete always wins over an edit.

## Running it

```sh
npm run server            # from the repo root
# or
node apps/linux-server/src/main.js --music ~/flow-music
```

On start it prints the addresses to enter in Flow (Settings → Streaming,
Download and Synchronization). `--port`, `--music` and `--name` are remembered
for the next start. `flow-server --help` lists everything.

Songs can be dropped into the music folder by hand (a network share, a USB
stick): the server looks through the folder every five minutes, and at once when
an app asks it to synchronize. A song renamed or moved there by hand stays the
same song (its playlists, cover and statistics): found by the `flowid` tag in
its file (see Covers), else by its format and length. A copy of a song is a
song of its own. The server looks through sub-folders up to 16 deep.

Where new songs go is chosen when installing (`install.sh` asks; also
`--separate-folders` and `--keep-folders`, remembered). Songs there already
stay where they are.

- **Separate folders for uploads and downloads:** songs the apps upload go
  into `Uploads/`, songs the server downloads into `Downloads/`. Without,
  both go straight into the music folder.
- **Keep uploaded folder structures:** an upload keeps its folders and file
  name from the app's music folder. A song the PC has in
  `Music/FlowPlayer/Linkin Park/Hybrid Theory/In the End.mp3` is saved as
  `Linkin Park/Hybrid Theory/In the End.mp3` (inside `Uploads/` with separate
  folders). A phone sends the folders of a folder it picked in Add Songs;
  single files have none. Without, an upload is saved as
  `Linkin Park - In the End.mp3`. A song renamed in an app later is renamed
  in its folder.

A song deleted from an app is not gone at once. Its file moves to
`.flow-trash` in the music folder and is removed after 30 days.

**Another music folder:** the server keeps each song's full path, so songs
in the folder used before keep playing from there, while new ones go into
the new folder. `install.sh` (and Flow Server Settings on Windows) asks
when the folder is changed whether everything in the old one should move
into the new one. By hand, with the server stopped:

```sh
flow-server move-music ~/old-music --dry-run   # songs=N and files=N, moves nothing
flow-server --music ~/new-music move-music ~/old-music
```

It backs up the library first, merges folders of the same name (a file whose
name is taken there gets " (2)"), and the songs keep their playlists, covers
and statistics. The old folder goes once it is empty. Deleting the old folder
instead takes its songs out of the library at the next scan.

### Installing it as a service (Linux)

```sh
git clone <the repo> ~/Flow && cd ~/Flow
sh apps/linux-server/install.sh           # --level N, --domain NAME, --music DIR, --port N, --yes, --no-tailscale, --no-discovery, --downloads, --no-downloads, --separate-folders, --keep-folders, --move-music (and --no-...), --uninstall
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

Then it links `@flow/core` (there is no npm needed), asks whether the server
should download songs itself (and if so shows the legal note, installs ffmpeg
and Deno for it and waits while you install yt-dlp; see [Downloads by the server](#downloads-by-the-server-optional)),
asks where new songs go (separate folders for uploads and downloads, and
whether uploads keep their folders; see above), offers
ffmpeg otherwise, asks whether the apps may find the server on the network by
themselves (see below), offers a password, installs Tailscale at level 2, writes and starts the
`flow-server` service (also at boot), and opens the port in ufw or firewalld
for the home network, and at level 2 for Tailscale. Run it again any time: once installed, it first offers 1 Only update
(everything stays as it is set up; the service is renewed and restarted), 2
Reinstall (the questions again; Enter keeps each answer as it is) and 3
Uninstall. A lower level closes what a higher one opened. To update: `git
pull`, then `sh apps/linux-server/install.sh` and 1.

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
  through, and the live channel's events (Active Sessions) arrive as they
  happen (the server also says `X-Accel-Buffering: no`, which nginx follows);
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
renamed song's tags, measures each song's loudness for "Equalize volume", and
makes the songs' covers (below), and cuts songs trimmed in an app (Edit). It
also gives iPhones Ogg Vorbis songs as Opus (iOS cannot play Vorbis),
converted once and kept in the server's folder (`converted/`). Without it, those songs show no length until
an app plays them, and only covers sent by an app are there. Songs uploaded
from an app bring all of that with them either way. The server also needs it
to download songs itself (below).

## Downloads by the server (optional)

The server can download songs itself: connected to it, Flow's Add Songs page
has **Download (Server)** next to its own Download. The server reads the
link (a song, a playlist, a SoundCloud set, a Spotify, Deezer or Amazon Music
list by way of YouTube, else SoundCloud, Bandcamp or the Internet Archive),
downloads the songs one after another in the background, at low priority so
streaming does not suffer, and keeps them aside until an app has trimmed,
named and finished them. A phone or a browser then needs no downloader of its
own, and a long playlist keeps downloading when the app is closed.

- **What it needs:** yt-dlp and ffmpeg on the server, and for YouTube a
  JavaScript runtime for yt-dlp: Deno, or Node.js 22 or newer with
  `--js-runtimes node` in `/etc/yt-dlp.conf`. `install.sh` asks early on
  whether the server should download songs; with yes it shows the legal note
  (declined: downloads stay off), installs ffmpeg and Deno when Node.js is
  older than 22 (there is no Deno for 32-bit ARM: there, YouTube fails and
  other sites work). Flow does not come with yt-dlp: the script names the
  standalone yt-dlp file for the machine and waits while you install it
  yourself as `/usr/local/bin/yt-dlp` (`s` skips; then `sudo systemctl
  restart flow-server` once it is there). A timer updates that copy once a
  day, since YouTube changes often enough that a yt-dlp a few weeks old stops
  working.
  `flow-server --downloads` / `--no-downloads` turns it on or off later; never
  set, it is on whenever the tools are there. The server's start says what it
  found, `/api/hello` lists `download` in `features` only when it can, and
  `doctor` says whether it does.
- **One batch per profile** (without profiles, one for everybody), in
  `staging/` in the server's own folder, not the music folder, so nothing
  shows in the library until a song is finished. While one is open the apps
  start no other download; it is shown on Add Songs on every device of that
  profile, until each song is finished or thrown away, or the whole batch is
  cancelled. A batch nobody opens or finishes anything of for 30 days is
  thrown away (`downloadKeepDays` in `server.json`), and so is a deleted
  profile's. A restart carries on where it was.
- **Finishing a song** cuts the trim out with ffmpeg straight into the music
  folder, with the names in its tags, and adds it like an upload: into the
  playlist (made by the first song finished) at its place in the source,
  whatever order the songs are finished in, and into the playlists picked.
  Two devices finishing songs of the same batch at once make the playlist
  only once.
- **Limits:** only links to pages on the internet are downloaded (http or
  https, or `spotify:`), never addresses of this machine or the home network
  (localhost, 192.168..., names ending in `.local` and the like): yt-dlp reads
  whatever page it is given, so a link to the router would have the server
  fetch it. A name on the internet that leads home is not caught. At most 500
  songs a batch, one download at a time (`downloadJobs` in `server.json`, up
  to 3), 20 minutes a song, and none when the disk has less than 500 MB free.
  Age-restricted videos and sites that want a signed-in visitor need cookies:
  with "Share session cookies with the server" in Flow's
  settings the app sends the cookies of the link's site (only those) with the
  download; they are kept in its folder in `staging/`, readable only by the
  server, used for that download alone and deleted with it. Without them
  such songs fail with that reason. At level 3 and 4 the home network needs
  no password, so anyone on it can start downloads; so can anyone with the
  password from outside.

## Covers

Every song gets an album cover, a 512 x 512 JPEG in `covers/` of the
server's home, named after the song's id: a rename or a move never loses it,
and it goes with its song. Songs without one (those already there when the
server first starts with covers, songs dropped into the folder, uploads that
came without one) are looked at in the background, one song at a time with a
pause between, at low priority:

1. the song's YouTube thumbnail, when it is an album cover (YouTube Music and
   "Topic" uploads show it in the middle between plain side bars);
2. the picture in the song's file;
3. YouTube Music's song search for artist and title, taken only when the hit
   is as long as the song (within 3 seconds);
4. the middle of the video's thumbnail.

A song for which none of that gives a picture is not looked at again; one
that could not be looked at (no internet) is tried again at the next start.
Steps 1, 3 and 4 need yt-dlp and the internet, all of them ffmpeg. A song the
server downloads itself has its cover looked for right after its download
(it is ready without waiting for it), shown in the apps while it waits to be
finished, and the song's once it is.

New songs (downloaded by the server, or uploaded by an app) also carry their
cover in their file, and a `flowid` tag (`<server id>:<song id>`), written in
the background once the cover is settled: MP3, FLAC, Opus and Ogg get the
picture, M4A only the tag (its tags hold the Mix instead), WAV neither. A
song renamed in an app gets both written into its file, its other tags
(album, year) kept. Songs that were there before are not rewritten by
themselves; `flow-server tag-songs` does it:

```sh
flow-server tag-songs --dry-run   # lists the files it would write, changes nothing
flow-server tag-songs             # the running server writes them, one at a time
```

The running server takes it within a few seconds (a stopped one when it
starts) and writes the files in the background, its log saying when it is
done; a restart carries on where it was. The apps keep a
copy of every cover, so a server that is off still leaves them with theirs.

## Lyrics

From 4.0 the apps show the playing song's lyrics (see Flow's README). For the
server's songs the server looks them up on [LRCLIB](https://lrclib.net)
(its search only; no account or key, but the internet), a song LRCLIB does
not have on [lyrics.ovh](https://lyrics.ovh) (the words without their
times, no key either), and keeps them in
`lyrics/` of its home, one file per song. It does so in the background for
every song, one every 5 seconds (new songs as they come, the whole library
after the update to 4.0), and at once for a song an app asks for first
(`GET /api/songs/<id>/lyrics`). The background lookup asks once a song,
found or not (songs kept as not found before lyrics.ovh was added: once
more); with LRCLIB out of reach it tries again after 10 minutes. A
song nothing was found for is asked about again after a week when an app
asks; a song renamed or trimmed at once; a deleted song's lyrics go at the
next start.

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

Discovery is also how apps of other Flow Servers find this server's Active
Sessions to join as guests (from 4.0, see Active Sessions below): the answer
then says `guests: true`, once an admin allows them.

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
apps its Tailscale address. A password is still worth setting: it
keeps other devices on your tailnet out. The address is only told to callers
on a private network, never to one that came through a proxy.

## Password

```sh
node apps/linux-server/src/main.js set-password        # asks for it
node apps/linux-server/src/main.js clear-password
node apps/linux-server/src/main.js devices             # who has signed in (two of one name: their app's id too)
```

Without one, anyone who can reach the server can use it, which is fine on a
home network. Each app enters the password once and gets a token back. Setting a new
password signs every device out. Wrong tries from one address wait longer each time
(1 s, 2 s, 4 s ...), so guessing a password takes years; after 30 wrong tries within
10 minutes from anywhere, everyone waits, so many addresses at once don't help
either. Devices already signed in carry on (at level 3 and 4 not for ever, see
below).

What the password has to be depends on the server's level (`--level`, set by
`install.sh`):

| Level | Reachable from | Password |
|---|---|---|
| 1 | the home network | optional; at least 4 characters |
| 2 | and Tailscale | optional; at least 4 characters |
| 3 | and the internet, through Caddy | required: at least 8 characters with a lower-case letter, an upper-case letter and a number |
| 4 | and the internet, through your own proxy or tunnel | the same as 3 |

At level 3 or 4 `clear-password` is refused, and without a strong password the
server lets nobody from outside past `/api/hello`. Going up sets both at once:
`flow-server set-password --level 3`. Profile PINs have no rules; they only
pick a profile once a device is past the server password. The master
admin's (see Administration below) needs at least 4 characters; since it can
change the password from an app, a strong password as its PIN is recommended.

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

## Sharing the server by QR code

From 4.0 an app connected to the server has **Share** in its Settings (Flow
Server), and the phones **Scan**: the code is a `flow://connect` link with
the server's id, name and Home and Remote address. With a password, the link
holds a one-time pairing code instead: the sharing app hands the password it
keeps to the server (`POST /api/pair`, checked), which keeps it in memory for
10 minutes and trades it once for the code (`POST /api/pair/redeem`, open to
anyone; wrong codes wait as wrong passwords do). No password, profile or PIN
is ever in the code. On a server without a screen:

```sh
flow-server share    # the running server's QR code and link, in the terminal
```

It asks for the password to get a code (`FLOW_SERVER_PASSWORD` gives it).

## Checking a server from outside: doctor

```sh
node apps/linux-server/src/main.js doctor https://music.example.com
```

Checks the server the way the apps reach it, through whatever is in front of
it (Caddy, nginx, a tunnel): the address is https and its name is known, the
certificate is accepted and not about to run out, the Flow Server answers and
has a password, the proxy passes on who is calling and that it was https,
plain http is sent on to https or closed, port 7878 isn't open to the
internet, large uploads get through without being held back, and, with the
password, signing in, the library, seeking in a song and whether the live
channel's events come through as they happen (a proxy holding them back
breaks Active Sessions). Each line says ok,
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
- With a server password, a device signs in to the server first, then
  to a profile. The profiles' names are only shown to devices past the first.

## Statistics

From 3.6 each profile, and the Default / Shared, keeps totals for the apps'
Statistics: time listened, listens of 30 seconds or more, and the time by
month. They only grow (deleting songs does not lower them) and start at 0
the first time the server runs 3.6; the songs' play counts (Most Played and
the other smart lists) stay as they were. A profile's listen counts for the
Default / Shared too, so it holds the whole server's listening; in a Jam
only the host's listen counts there, the members' only for their own
profiles. Apps older than 3.6 still count, but say nothing of Jams.

## Administration

An admin profile gets Administration as the last category of the apps'
Settings: the server at a glance, every profile (when made, last seen, the
songs it added, time listened, the IP addresses and devices it came from),
the failed logins (wrong PINs and passwords), every profile's server
downloads and the Active Sessions, the trash (deleted songs come back as
they were, playlists and stats included), and the rules: who may make
profiles, and who may delete songs for everyone. An admin can take a PIN
away (forgotten), log a profile out everywhere, disable it, or delete it,
with or without every song it added.

The first profile a server ever has is an admin by itself, so it needs a
PIN; on a server from before 3.5 its oldest profile with a PIN, once. Only a
profile with a PIN can be an admin: resetting an admin's PIN takes admin
away too. One profile can be the master admin,
who can also change the server password and make admins in the apps. The
master is made on the server only, by the installer or:

```sh
node apps/linux-server/src/main.js profiles                     # the profiles: admins, PINs, made, last seen
node apps/linux-server/src/main.js admin master "Anna"          # Anna the master admin (asks a new PIN for her)
node apps/linux-server/src/main.js admin master "Anna" --create # the same, making the profile when there is none
node apps/linux-server/src/main.js admin grant "Ben"            # Ben an admin (he needs a PIN)
node apps/linux-server/src/main.js admin revoke "Ben"           # no longer
node apps/linux-server/src/main.js profiles add "Carla"         # a new profile (asks its PIN)
```

`FLOW_PROFILE_PIN` gives the PIN without asking. The failed logins are kept
in `failed-signins.json`, the songs the apps uploaded (who, when, from which
address) in `uploads.json`, deleted songs in `trash.json` (all in the
server's home), next to `server.json`. Administration's **Recent uploads**
lists the uploaded songs still on the server, newest first, each with a
Delete button (to the trash, for everyone).

From 4.0 the rules also have **Allow guests in home network
sessions/jams** (off until ticked; see Active Sessions below). Unticking it ends
every guest's place at once.

## Backups

From 4.0 the server backs up the library's data once a week, at the start
(after the folder scan) when the newest backup is a week old, and looks every
6 hours; the last 6 are kept in `backups/` of its home, one gzipped JSON file
each. A backup holds `library.json` (the songs' names, album, genre, Info,
trims and who added them, the playlists, favourites, follows and listening
stats, Statistics included) and the profiles part of `server.json` (names,
PIN hashes, admin flags): never the songs' files, the covers, the trash, the
password, the level or a device's token.

A restore puts the backup's song names, playlists, favourites, follows and
stats back, each song keeping its file as it is now (trimmed, renamed);
songs deleted since come back when their file is still in the trash, songs
added since stay, a profile made since keeps its part, and the master admin
stays who it is. What is there is backed up first, and that backup is never
pruned away with the one being restored. Administration has a Backups block:
every admin can **Back up now**, the master admin **Restore**. Or:

```sh
flow-server backup                 # one now
flow-server backups                # the backups, newest first
flow-server restore <name | file>  # the running server takes it within a few seconds
```

A stopped server takes a restore when it starts.

## Active Sessions

Devices connected to the server can listen together (see Flow's README).
The server keeps the sessions in memory only, so a restart ends them:

- Every app that is connected keeps a live channel open (`GET /api/live`,
  Server-Sent Events, one per app, told apart by the id each Flow install
  makes for itself): the server pushes what happens there, with a ping every
  10 seconds. An app that plays something tells the server what it plays,
  and is then a session that others can ask to join, unless it does not
  share it (`shared: false` in its state): then only its members know it,
  and requests still open are turned away.
- The host answers each request; a declined app waits a minute before asking
  again, and a request runs out after a minute. At most 8 apps per session.
- The others' buttons are checked against a fixed list (play, pause, next,
  previous, seek, shuffle, repeat, the queue, a song or a playlist of the
  library) and sent to the host, at most 30 per 10 seconds per app. Volume
  only when the host allows it.
- A host that leaves hands over to the next app in joining order at once; a
  live channel that drops hands over after 15 seconds (back in time, nothing
  changes). The last app out ends the session.

A web server or tunnel in front has to pass the live channel on unbuffered
(level 4 above); `doctor` checks it. Without that, Flow still works, but
pauses and skips from other devices arrive late or not at all.

**Guests from other servers** (from 4.0; on for a new server until an admin
unticks Allow guests in home network sessions/jams): an app of another Flow Server on the
same home network, or one with no server, finds this server by discovery
(which has to be on) and may ask to join a session here. The host is asked
about every guest. A guest is never a profile here: it gets a pass of its own
(in memory only, gone with a restart or after 12 hours unused) that opens only
`/api/guest/*` and only from a private address: the sessions, its live
channel, joining, the controls, leaving, the time, and while in a session the
server's songs with their audio and covers. A guest is never the host: the
next member of this server takes over, and with none left the session ends.
It cannot start this server's playlists, and nothing it hears is counted
here.

A guest may also bring its own songs: its app sends each one it plays or
queues (`PUT /api/guest/songs/<id>`), kept in `session-songs/<session id>` of
the server's home for that session only, never in the library, and deleted
when the session ends and at every start. At most 60 a session, 300 MB each
and 3 GB together, only files that play (mp3, m4a, aac, ogg, opus, flac, wav,
webm). The members stream them from `GET /api/sessions/songs/<id>/audio`.

## Where things are

| | Linux | Windows |
|---|---|---|
| library, settings | `~/.local/share/flow-server` | `%LOCALAPPDATA%\Flow\server` |
| downloads not finished yet | `staging/` in there, a folder per profile | the same |
| covers | `covers/` in there, `<song id>.jpg` | the same |
| lyrics | `lyrics/` in there | the same |
| backups | `backups/` in there, the last 6 | the same |
| songs guests brought | `session-songs/` in there, while their session lasts | the same |
| music | `~/flow-music` | `~/flow-music` |
| log | `journalctl -u flow-server` | `flow-server.log` in the library folder |

`FLOW_SERVER_HOME` and `FLOW_SERVER_MUSIC` point them elsewhere.

## Testing in WSL

WSL 2 runs a real Linux, so the server behaves there as it will on a Pi.
Windows reaches it on `localhost:7878`. Other devices (a phone) can't, because
WSL 2 sits behind its own network; for those, run the server on Windows itself
(the installer in `apps/windows-server`) or forward the port with `netsh interface portproxy`. Keep the music on the
Linux side (`~/flow-music`), not under `/mnt/c`, which is slow and doesn't
report changes.

## The HTTP side

| | |
|---|---|
| `GET /api/hello` | name, protocol, whether a password is needed (open to anyone); `tailscale: { ip, dns, port }` when the server is on a tailnet, to private callers only; `publicUrl` at level 3 or 4 |
| `GET /api/check` | what the server made of this request: `{ proxied, trusted, ip, proto, level, locked }` (open to anyone; for `doctor`) |
| `POST /api/login` | `{ password, device, client }` → `{ token }` (`client`: the app's install id; one token per app, so two PCs of the same name don't sign each other out) |
| `GET /api/library?since=<rev>&as=<profile>` | `{ rev, library, profile }`, or 204 when nothing changed for that profile; the library has the profile's `follows` and the others' `sharedPlaylists` |
| `POST /api/commands` | `{ commands }` → `{ rev, results }` (see `@flow/core/commands`); `deletePlaylist` with `deleteSongs: true` also deletes the songs no playlist or favourite of any profile has, listed in its result's `deletedSongs` |
| `PUT /api/songs/<id>?meta=<json>` | upload a song; the body is the file → `{ existing, id, rev }`. A song the server has already (same source, or same names and length) is not taken: `existing` with its `names` (`{ artist, title, mix }`), and the app asks when they differ from its own; `meta.onExisting: "new"` takes it as a song of its own; `meta.convert` (`{ alwaysMp3, quality, keepMp3 }`) has it converted into MP3 in the background once the batch is in, Ogg Vorbis always |
| `GET /api/songs/<id>/audio` | the song's file, with Range for seeking; `?vorbis=0` (an app that cannot play Ogg Vorbis): such a song as Ogg Opus (with ffmpeg) |
| `GET /api/songs/<id>/peaks` | `{ peaks }`: the song's waveform, for an app's Edit trim (needs ffmpeg) |
| `POST /api/songs/<id>/trim` | `{ start, end, base, cut }` (only when `/api/hello` lists `trim`, i.e. with ffmpeg): the song's file cut to `start`..`end` seconds, the uncut file to the trash → `{ song, rev }`; `cut` is the trim's id (`song.cut`), `base` the cut it was made from. `{ skipped: 'repeat' }` when it is in already, `'changed'` when the song was trimmed by another app since (not applied), `'gone'` when deleted |
| `GET /api/songs/<id>/cover?v=<version>` | the song's cover (JPEG), 404 when it has none; `song.cover` in the library is its version (`-`: none found, `null`: not looked at yet), and with the current one in `?v=` it may be cached for good; `ETag` / `If-None-Match` too |
| `PUT /api/songs/<id>/cover` | an app's cover for a song (a JPEG body, at most 4 MB; made 512 x 512 when it is not) → `{ cover }`; kept only when the song has none yet |
| `GET /api/songs/<id>/lyrics` | the song's lyrics (4.0, `lyrics` in the features): `{ lyrics: { found, synced, plain, instrumental, source } }`, `synced` the lines with their times, `source` `LRCLIB`, `lyrics.ovh` or `own`; 502 when LRCLIB cannot be reached |
| `PUT /api/songs/<id>/lyrics` | lyrics written or edited in an app (4.0.1, `ownLyrics` in the features), body `{ lines: [{ t, end, text }] }`: kept for good (`own`), never looked up again; `{ lines: null }` takes them away (looked up again); 400 when only some lines have times |
| `POST /api/pair` | `{ password }` (4.0, `pair`): a one-time pairing code for a QR code → `{ code, expiresIn }` (`''` without a server password); 403 for a wrong password |
| `POST /api/pair/redeem` | `{ code }` → `{ password }`, once, within 10 minutes (open to anyone); 404 for a code used or too old |
| `GET /api/sessions/songs/<id>/audio` | a song a guest brought into this app's session (4.0), with Range |
| `/api/guest/...` | guests from other servers (4.0, `guests`; see Active Sessions above and [Flow_server_API.md](../../Flow_server_API.md#guests-from-other-servers)) |
| `POST /api/rescan` | look through the music folder now |
| `GET /api/live?client=<id>&device=<name>` | the app's live channel (Server-Sent Events): `hello { client, serverTime, pingMs }` first, then the Active Sessions events below; a second channel of the same app replaces the first; ends with `end { reason }` (`replaced`, `auth`, `shutdown`) |
| `GET /api/time` | `{ time }`: the server's clock, for playing in step |
| `GET /api/sessions?client=<id>` | `{ sessions, mine, request }`: the sessions listed, this app's own place, its open request to join |
| `POST /api/sessions` | `{ client, type, ... }` with `type`: `state { state }` (the host's playback), `join { sessionId, mode: 'remote' or 'here' }`, `cancelJoin`, `answer { requestId, accept }`, `control { action, ... }`, `mode { mode }`, `leave` |
| `GET /api/profiles` | `{ profiles: [{ id, name, pin, createdAt, admin, master }], current, createProfiles }` |
| `POST /api/profiles` | `{ name, pin, device }`: a new profile, signed in → `{ token, profile }`; 403 when only admins may make profiles |
| `POST /api/profiles/login` | `{ profileId, pin, device }` → `{ token, profile }` |
| `POST /api/profiles/logout`, `/rename` `{ name }`, `/delete` | the signed-in profile |
| `/api/admin/...` | Administration, for an admin profile (see [Flow_server_API.md](../../Flow_server_API.md#administration)) |
| `GET /api/downloads` | the profile's download batch: `{ batch }`, `null` when there is none |
| `POST /api/downloads` | `{ url, kind: 'song' or 'list', options: { alwaysMp3, quality, keepMp3 }, cookies }` (`cookies`: a Netscape cookie file's text, optional; only the link's site's lines are kept, and the batch says `cookies: true`): a new batch, read in the background (`state: 'listing'`, then `'ready'` or `'failed'` with `error`); 409 with one open already |
| `DELETE /api/downloads` | cancel the whole batch: downloads stopped, files gone |
| `GET /api/downloads/items/<i>/peaks` | `{ peaks }`: the song's waveform, for the trim editor |
| `GET /api/downloads/items/<i>/audio` | the prepared song, with Range (and `?t=`), to preview the trim |
| `GET /api/downloads/items/<i>/cover?v=<version>` | the cover found for a song that is `ready` (the item's `cover` is its version, `''` while there is none); 404 without one |
| `POST /api/downloads/items/<i>/finish` | `{ meta: { artist, title, mix }, start, end, playlistIds, playlist: { name, mergeInto } or null, existing: [i] }`: saved into the library → `{ song, batch, playlistId, rev }`; `batch` is `null` once every song is dealt with |
| `POST /api/downloads/items/<i>/retry` | a song that failed, again |
| `DELETE /api/downloads/items/<i>` | one song thrown away |

Active Sessions events on the live channel: `sessions` (the list, to every
app, when it changes), `joinRequest` and `joinCancelled` (to the host),
`joinResult` (to who asked: `ok`, or `reason` `declined` with `retryIn`,
`expired`, `full`, `ended`, `unshared`), `session` (the members, to each of them),
`state` (the host's playback, to the others), `control` (to the host),
`hostChanged` (to a new host) and `left` (to an app that is out). A
`control`'s `action` is one of `toggle`, `play`, `pause`, `next`, `prev`,
`seek { position }`, `shuffle { on }`, `repeat { on }`, `queueAdd { songId }`,
`queueRemove` / `queuePlay { part, index }`, `queueMove { part, from, to }`,
`queueClear`, `playSong { songId, ids, contextName }`, `playPlaylist
{ playlistId or name }` (worked out from the library) and `volume { value }`.

A batch's songs (`items`) are `queued`, `downloading`, `converting`, `ready`
(with `meta`, the names guessed, and `summary`, what was done to the file),
`failed` (with `error`), `library` (the library has it: not downloaded;
`existing` says which), `saving`, `saved`, `added` (a library song put into the
playlist) or `discarded`. One that is downloading has `progress: { frac, text }`.

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
by itself with the password it has saved, and says "needs its password"
when it has none. Levels 1 and 2 keep their tokens.
