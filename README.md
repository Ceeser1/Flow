# Flow

A dark music player for Windows, built on Electron, for songs downloaded from
YouTube, SoundCloud, Vimeo, Bandcamp and every other site yt-dlp can read.
Paste a link, trim off the intro and outro, name it, put it in playlists.

## Using it

- **Search**: one box, three columns: Playlists (All Songs included), Songs and
  Artists whose name contains what you type. Clicking a song plays it, an artist
  opens All Songs filtered to them. Ctrl+F jumps here from anywhere.
- **Add Songs**: paste a link and press Enter or Download. The frame under the
  box shows reading, downloading and converting. Once it is done:
  - Artist, Title and Mix are filled in from the video's title and can be
    corrected.
  - The waveform spans the page. Drag the green and red handles to cut (Shift
    for 10x finer, Ctrl for 100x), or type the times. Click the waveform to move
    the playhead. Play stops at the red handle so you hear the cut as it will
    be saved.
  - **Add to Playlist** picks playlists, **Finish** saves to `Music\FlowPlayer` as
    `Artist - Title (Mix).ext`, with the names written into the file's tags.
- **Whole playlists**: paste a YouTube playlist, a SoundCloud set, a Bandcamp
  album, or a Spotify playlist or album into Add Songs. The songs are listed
  first, all ticked: untick what you do not want, then Download Selected or
  Download All (or Cancel). Songs already in your library and a playlist name
  that is taken are listed as warnings on top, each with a box to untick. The
  songs are then downloaded one at a time, each shown as a frame; the menu
  shows "Add Songs 7/38" meanwhile. Click a downloaded song's frame to open its
  waveform, cut and names, and Apply (one frame at a time). **Finish all** at
  the bottom right saves every song with its cut into All Songs and a playlist
  named after the source (or the existing one, if ticked), in the source's
  order. Until then nothing is saved, and closing Flow asks first. A link to
  a video inside a playlist asks whether you mean the song or the playlist; a
  YouTube Mix lists its first 50 songs. Pasting the same list again picks up
  only what is missing.
  - **Spotify** cannot be downloaded from (its audio is copy protected), so
    only the list comes from Spotify's public embed page (no login, public
    lists only), and each song is looked up on YouTube: YouTube Music's song
    search first, which finds the album audio, then the ordinary search, with
    uploads scored by length, channel and title. Matches more than 5 seconds
    off are marked "check"; each links to YouTube. Artist, title and mix come
    from Spotify. Spotify's page shows at most 100 songs of a longer list.
- **Playlists**: create, rename, delete. `+` opens All Songs in "adding songs
  to" mode, where one click on a song's `+` adds it. **Shared Playlists**
  (it opens and closes; All Songs stays) lists All Songs and, with a Flow
  Server, the playlists the server's other profiles share, each with a
  **Follow** / **Unfollow** button in Actions. **Your Playlists** are yours,
  with Favourites and **Listen behaviour** first (a row that opens to its
  lists, closed until you open it). Both tables also show your **Listen
  Duration**, the time you have listened to it as the list playing (after its
  Play button, or a song picked in it), and when each playlist was **Created**.
  Their columns are shares of the width, so a full-screen window spreads them
  like a small one. A song queued from another list does not count for it. It is yours
  alone, also for a shared playlist (the owner's is not shared), and unfollowing
  a shared playlist deletes it.
- **Sharing** (with a Flow Server that has profiles): the **Share with others**
  box, top right of a playlist of your own, lets the other profiles see it
  and follow it. Only its owner can change it; followers can play it, and a
  playlist you follow has a **Following** box in the same spot to unfollow.
  Once you follow one, **Followed Playlists** appears in the menu below
  Playlists as a main entry of its own (with the followed lists under it, and
  a page where each can be unfollowed, with its **Owner**, songs, duration and
  your **Listen Duration**); it goes again when you follow none. On both that
  page and Playlists, Name is a share of the width and Actions is fixed, and
  the columns between share the rest evenly, windowed or maximized.
  The arrow before the name of Playlists and of Followed Playlists in the menu
  hides or shows the lists under it (remembered). You never
  see your own playlists among the shared ones. Unshared, a follow waits and
  comes back when it is shared again; deleted, the follow is gone.
- **A playlist**: Shuffle, Play, a search box, and the songs. Clicking a
  song's title plays it (the song already playing keeps playing). Every column
  header sorts: ascending, descending, and a third click back to newest first.
  "Added" is when the song was downloaded (All Songs) or put in that playlist.
  The star on every song's row makes it a favourite (filled gold) or no longer
  one (an empty green star), from whichever list it is in. In All Songs, the
  leftmost button under a song's **More** (three dots), also in the Listen
  behaviour lists, opens **Add to Playlists**: your playlists
  with a box each (ticked: the song is in it); **Apply** puts the song into the
  newly ticked ones and takes it out of the newly unticked ones, and closes
  the popup and More (so does a click anywhere else). Ten playlists show, more
  scroll.

- **Details** (the magnifier on an All Songs row): the song's names and length,
  the playlists it is in as buttons (click one to take it out, click again to
  put it back), "Add to Playlists", and its statistics: added, last listened,
  times played, times fully listened, average listen duration, times stopped,
  times skipped early.
  Under "Downloaded from": the Direct Url of the song's page, and for a song
  that came with a playlist import also that playlist's Url. Both open in the
  browser.
- **Favourites** (under All Songs in the menu): every starred song, newest
  star first; "Added" is when it was starred. Read-only apart from the stars.
- **Listen behaviour** (under Favourites in the menu, opens and closes): Most
  listened, Least skipped, Long time no see, Most skipped and Least listened,
  each a fifth of the songs in your own playlists (All Songs does not count),
  made from the statistics. Skipped means an early skip, 5 to 30 seconds;
  Least skipped and Most skipped only look at songs you have heard and
  skipped. The lists cannot be edited, but a **From Playlist** column after Mix
  says which of your playlists each song is in, and More has the same buttons
  as in All Songs, except the red cross is **Remove from Playlist(s)**: it
  takes the song out of every playlist of yours that holds it (asking first
  when that is more than one) and leaves it in All Songs.

How a listen is counted: only time actually played counts, and it is counted
when the song changes. Skipping ahead adds nothing (jump 10 seconds forward
and those 10 are not counted), going back and playing on adds the time played
again (a minute, back 10 seconds and 10 more played is 70 seconds). Under 5
seconds counts as nothing at all. From 5 seconds it is a **time played**, and
also: 80% or more of the song heard a **full listen**, under 30 seconds an
**early skip**, anything between a stop. A song unfinished when the app closes carries on at the next start. Long time no see
counts a song that was never played from when it was downloaded.

The player bar stays at the bottom on every page. Space plays and pauses, Left
and Right skip 10 seconds (not while typing in a box), and the keyboard's
media keys and the Windows media overlay work too. The last playlist, song,
position, shuffle and volume come back on the next start, paused.

While a song plays, an equalizer glows behind the pages: 20 Hz to 4 kHz on a
log scale, mirrored about the top of the player bar, coloured from blue for
quiet bands through green, yellow, orange and red to dark red for the loudest.
Behind it, a few clouds of deep colour, each an uneven cluster of puffs with a
wide shine around it, drift slowly at all times, each coming and going on its
own cycle, so some of the background is tinted and
some plain, never the same twice; while a song plays they swell and brighten
a little on each kick or bass note that stands out
(`renderer/app/ambient.js`). What counts as bass for them is weighted towards
where a kick punches: fully at 70 Hz, falling in a straight line to nothing at
20 Hz and at 120 Hz. With Windows' "Show animations" off they stand
still.
Every band reacts within 100 ms; bass notes are placed sharply by reading
each frequency bin's phase (see `renderer/app/spectrum.js`). The volume sits
after the analysis, so turning it down does not shrink the picture.

A link that is already in the library, or a song with the same artist, title
and mix, asks before downloading or saving it again.

### Settings

The cog at the bottom left of the menu. Every change counts at once.

- **General**
  - **Local Files**: how many songs and how much room they take. Open shows
    the folder in Explorer. Change picks another folder and moves every song
    file there, subfolders and all (a name already taken there gets a number);
    playlists and statistics stay. Not while a download or import runs.
  - **Song Transition** (on, 3 s; 0.1 to 10 s): the next song starts that long
    before the current one ends and the two fade over each other. The bar
    moves on only when the current song has really ended. A transition is at
    most a third of either song. Pause, Previous, seeking or picking another
    song call it off; Next goes straight into the song coming in.
  - **Equalize volume** (on): every song is brought to the same loudness
    (-14 LUFS, turned up by at most 8 dB), with a limiter catching the peaks
    of songs turned up. Each song is measured once in the background (EBU R128,
    well under a second a song) and the result kept in the library.
- **Flow Server**: **Streaming, Download and Synchronization** (off). See
  [A Flow Server](#a-flow-server) below.
  - **Profile**: which of the server's profiles this is. Not logged in, pick
    one (or **+ New** to make one, with a PIN if wanted) and **Login** or
    **Create**; logged in, **Rename**, **Delete** (its playlists, favourites
    and stats, on every device) and **Logout**. Only while connected.
  - **Home Server in WiFi/LAN** and **Remote Server**: addresses, tried in
    that order (`192.168.0.63:7878`, a domain, or a full `https://` link).
    Each has a tick box before it (on by default): untick Home to connect
    through Remote only, or Remote to connect at home only (an unticked address
    is kept but not used, and with both unticked Flow does not connect).
    With Home empty, Flow asks the local network for a Flow Server (if the
    server has discovery turned on) and fills Home in when exactly one answers (once, and only into an empty box).
    When the server is on [Tailscale](https://tailscale.com), or on the
    internet (level 3 or 4), connecting at home fills the Remote box with its
    Tailscale or `https://` address the same way.
  - **Server Password (if the server is password protected)**: entered once, kept
    encrypted for the Windows account; empty the box to forget it.
  - **Always Download & Synchronize on mobile internet/metered connections**
    (off; only shown with a Remote address): away from home, songs only go
    up and come down on connections Windows does not call metered, unless
    ticked. Streaming and changes go either way, and at home nothing waits.
  - **Keep downloaded files after sync with the server** (on): songs
    downloaded here stay in Local Files once uploaded. Unticked, each is
    removed here after its upload (unless a playlist marked for download
    holds it); songs uploaded before are left alone.
  - **Synchronize local changes** (on) and **Synchronize now**: songs added
    to or removed from Local Files by hand, and changes made while the
    server was off, go to the server by themselves; unticked, only with
    Synchronize now. Songs downloaded in Flow always go up.
- **Website Downloads**
  - **Always convert all downloads into MP3** (off) at 64 to 320 kbit/s
    (192), and under it **Ignore files that are already in .mp3 format** (on):
    unticked, MP3s are encoded again at the chosen quality too.
- **Visuals**
  - **Background Clouds** (on), Intensity 1 to 100% (50), and **React to
    Bass** (on), Reaction 1 to 100% (33; 25 is the look as designed, 100
    four times that).
  - **Equalizer** (on), Height 1 to 100% (50: the loudest bars reach a third
    of the page), **Visibility** 1 to 100% (50: 100 is fully opaque; above 50
    the shine also starts brighter at the bars and fades out faster),
    **Outer Shine** (on), Spread 1 to 100% (50), and the colour scheme:
    Spectrum (by height), Rainbow (the whole colour wheel from blue to blue,
    drifting to the right one screen width every 15 seconds), or White, Red,
    Green, Yellow, Blue, Purple or Black.
  - **Screen Flash** (off): on each punch of the bass felt more than heard
    (20 to 80 Hz: a sudden jump of that level above the dip before it) the
    window glows white from its edges inwards, at once, fading over a few
    tenths of a second. **Triggers** 1 to 100% (80): how small a punch still
    counts (a share of the biggest of the last two seconds) and how soon
    another flash may follow (5 s / Triggers%: 50 ms at 100%, 100 ms at 50%).
    On 150 BPM hardstyle about 50% flashes on every kick, 80% on the
    off-beat bass too (4 to 5 a second). **Flash range** 1 to 100%
    (33): the flash starts that bright at the edges and fades to nothing that
    share of the window's width in, from every edge alike. Flashing more than
    three times a second can set off photosensitive epilepsy; on dense music
    high Triggers can do that. At 1% only a few pixels at the edges, at 50% white edges and a
    centre hardly touched, at 100% about a quarter white in the middle.

### How Artist, Title and Mix are guessed

Flow looks in four places and uses the first one that has an answer:

1. **The site's own song info.** Some sites, YouTube Music among them, state
   the artist and song name directly.
2. **YouTube's auto-generated description.** Songs uploaded by labels often
   have a "Title · Artist" line in the description.
3. **The video title.** See the examples below.
4. **The channel name**, as a last resort for the artist.

Titles Flow understands:

| Video title | Artist | Title | Mix |
|---|---|---|---|
| `Daft Punk - One More Time (Official Video)` | Daft Punk | One More Time | |
| `Avicii "Wake Me Up" Official Video` | Avicii | Wake Me Up | |
| `“Numb” Official Music Video \| Linkin Park \| Warner Records` | Linkin Park | Numb | |
| `Strobe by deadmau5` | deadmau5 | Strobe | |
| `Wonderwall - Oasis` | Oasis | Wonderwall | |
| `Avicii - Levels (Skrillex Remix) (1 Hour)` | Avicii | Levels | Skrillex Remix |

- **Clutter is dropped**: Official Video, M/V, (1 Hour), (prod. X),
  [4K Remaster] and similar.
- **Mixes and versions** in brackets go into Mix, without the brackets.
- **Titles split by `|`**: the part that names the uploading channel (here
  Warner Records) is skipped.
- **"Title - Artist"** (the reverse order) is only recognised when the right
  side is an artist already in your library or the channel's name. Otherwise
  Flow can't tell which side is which.

If only the channel name was left to use as the artist, the Add Songs page
says so next to the Artist box, so you know to check it.

### Which format a song is saved in

No song is converted from one lossy format to another unless you ask:

| Source                        | Saved as                                    |
|-------------------------------|---------------------------------------------|
| Opus (YouTube, SoundCloud)    | `.opus`, untouched                          |
| AAC (SoundCloud, Vimeo)       | `.m4a`, untouched                           |
| MP3, Vorbis, FLAC, WAV        | as they are                                 |
| AIFF, ALAC, other lossless    | `.flac`, still lossless                     |
| anything else                 | `.mp3` at the quality chosen in Settings    |

**Always convert all downloads into MP3** (Settings) converts everything except
MP3 itself to MP3 at the chosen 64 to 320 kbit/s, default 192; with "Ignore
files that are already in .mp3 format" unticked, MP3s as well.

### A Flow Server

With **Streaming, Download and Synchronization** on, the library lives on a
Flow Server (`apps/server`, e.g. on a Raspberry Pi) and Flow is its remote
control with a cache:

- Songs play straight from the server, seeking included. The name under
  "Flow" in the menu says which server, whether it can be reached, and what
  is going up or down.
- Every change (renaming, deleting, playlists, favourites, listens) goes to
  the server as a command. Without the server the changes wait and go once it
  is back, even after Flow was closed. When two devices change the same thing,
  the later change wins; a delete always wins. A deleted song's file stays in
  the server's trash for 30 days.
- **Download** on a playlist's page keeps its songs in Local Files, to play
  without the server; unticked, those copies go again. **All Songs** has it
  too, after a "Are you sure you want to download all N songs?" question, and
  then follows the server: songs added there come down by themselves, songs
  deleted there go from here. A playlist another profile shares has it too
  once you follow it; unfollowing removes its downloaded songs, except those
  another downloaded playlist or All Songs still holds.
- Songs downloaded or imported in Flow are saved into Local Files as always,
  then uploaded. Turning the server on the first time uploads all of Local
  Files; songs the server already has (same source, or same artist, title,
  mix and length) are not sent twice.
- `apps/server/install.sh` sets the server up as a service on any Linux
  with systemd, and asks how far it should be reachable (see the server's
  README):
  1. the home network only;
  2. and away from home through Tailscale: installed on the server and on
     the PC (same account), the server's `100.x.y.z` address becomes the
     Remote address, with no port opened on the router, and the name under
     "Flow" says "(Tailscale)";
  3. and the internet, with Caddy set up by the installer: a domain name (a
     free DuckDNS one works) and ports 80 and 443 forwarded on the router;
  4. and the internet, through a web server or tunnel of your own (nginx,
     Apache, Cloudflare Tunnel): the installer says what to add and checks it.

  Levels 3 and 4 need a strong password, and connecting at home fills the
  Remote box with the server's `https://` address. `flow-server doctor
  <address>` checks a server the way the apps reach it.
- Profiles: everyone shares the songs, and each profile has its own
  playlists, favourites and listening stats. A new profile starts
  with a copy of the Default / Shared playlists (what is used while no profile
  is logged in). The name
  under "Flow" says who is logged in ("Server: Pi as Anna (Home)", or Tailscale or Remote away from home). A change
  waits for the profile it was made in, and a playlist marked for download
  keeps its songs while another profile is logged in.
- Last seen library and waiting changes: `server-library.json` and
  `server-sync.json` in `%LOCALAPPDATA%\Flow`. A different server at the same
  address starts both afresh.

### Where things are

- Songs: `Music\FlowPlayer`, or the folder chosen in Settings. The app
  watches the folder: files copied in by hand, subfolders included, appear a
  few seconds after the copy finishes, deleted files leave the library, and a
  file renamed or moved in Explorer stays the same song, playlists included.
- Library, settings, the download cache and an updatable yt-dlp:
  `%LOCALAPPDATA%\Flow`. The library is `library.json`, with the previous
  version kept as `library.json.bak`.

yt-dlp updates itself once a day in the background, since YouTube changes often
enough to break an old copy.

## Development

`apps/desktop/tools/` is not in the repository (`ffmpeg.exe` and `ffprobe.exe`
are over GitHub's 100MB file limit). Put the Windows builds of all three there:

```
apps/desktop/tools/
  ffmpeg.exe
  ffprobe.exe
  yt-dlp.exe
```

```
npm install     # once, in the Flow folder: installs every app and package
npm start       # run the desktop app
npm test        # every package's tests: no network, no ffmpeg
npm run icon    # build/icon.ico and renderer/assets/icon.png from build/flow.png
npm run dist    # build the installer into apps/desktop/dist/
```

The root folder is an npm workspace, so the commands work from there. The
desktop app pins an exact Electron version (electron-builder cannot find a
hoisted Electron otherwise) and sets `npmRebuild` to false (Flow has no native
modules, and the rebuild would prune the shared `node_modules`).

If `npm run dist` fails with "Cannot create symbolic link : A required
privilege is not held by the client", electron-builder could not unpack its
signing tools (they contain macOS symlinks, which Windows only allows with
Developer Mode on). Either turn on Developer Mode, or unpack the downloaded
archive by hand: in `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`, copy
one of the numbered folders it left behind to `winCodeSign-2.6.0`. Without that
step the build still works if `signAndEditExecutable` is set to false, but
`Flow.exe` then shows Electron's icon instead of Flow's.

To try it out without touching the real library, set `FLOW_HOME` (instead of
`%LOCALAPPDATA%\Flow`) and `FLOW_MUSIC` (instead of `Music\FlowPlayer`).

When running from a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first: VS Code
sets it, and with it set Electron starts as plain Node.

## Layout

```
packages/core/   shared by every Flow app: plain Node, no Electron
apps/desktop/    the Electron app (Windows now, Linux from the same code)
apps/server/     Flow Server: hosts a library for the apps (see its README)
apps/android/    the Android app, planned
```

`packages/core/src/` holds `formats.js`, `text.js`, `titleParser.js`,
`libraryModel.js`, `commands.js`, `profiles.js`, `address.js`, `tags.js`,
`spotify.js`,
`relocate.js` and `jsonFile.js`, each required as `@flow/core/<name>`. Everything below is under `apps/desktop/`.

- `main.js` holds the window and every IPC route; `preload.js` exposes
  `window.flow`. The window runs sandboxed with no Node.
- `src/` (plus `@flow/core`) is the work, none of it touching the DOM:
  - `downloader.js`: yt-dlp probe and download, then keep / lift out / convert
  - `importer.js`: whole playlists, listed as a checklist, then imported;
    `spotify.js` reads Spotify lists and picks the YouTube upload per song
  - `formats.js`: which format a download is kept in
  - `exporter.js`: the trim cut and the tags, into `Music\FlowPlayer`
  - `titleParser.js`: Artist / Title / Mix from yt-dlp's info
  - `libraryModel.js`: songs, playlists and their rules; `library.js` saves it,
    scans the music folder and moves it (`relocate.js` plans where each file goes)
  - `loudness.js`: measures each song's loudness for Equalize volume
  - `remote.js`: a Flow Server as the library: connecting, the waiting
    changes, uploads, downloads for offline and Local Files synchronization
    (`commands.js` is what each change does); `network.js` asks Windows
    whether the connection is metered
  - `settings.js`: what the app remembers, Settings' choices included
  - `waveform.js`: the peaks the trim editor draws
- `renderer/app/` is the window, one plain script per part, loaded in the order
  `index.html` lists them. `util.js`, `queue.js` and `spectrum.js` are also
  required by the tests. `trim.js` is LWClipper's trim slider and waveform
  drawing. `equalizer.js` draws the equalizer and owns the player's Web Audio
  route (two elements, each with a loudness and a fade gain, then limiter,
  analyser, volume, speakers). `ambient.js` draws the clouds, and
  `settingsPanel.js` is the Settings window.
