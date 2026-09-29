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
  - **Add to Playlist** picks playlists, **Finish** saves to `Music\YPlayer` as
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
  to" mode, where one click on a song's `+` adds it.
- **A playlist**: Shuffle, Play, a search box, and the songs. Clicking a
  song's title plays it (the song already playing keeps playing). Every column
  header sorts: ascending, descending, and a third click back to newest first.
  "Added" is when the song was downloaded (All Songs) or put in that playlist.
  The star on every song's row makes it a favourite (filled gold) or no longer
  one (an empty green star), from whichever list it is in.

- **Details** (the magnifier on an All Songs row): the song's names and length,
  the playlists it is in as buttons (click one to take it out, click again to
  put it back), "Add to Playlists", and its statistics: added, last listened,
  times listened, average listen duration, times stopped, times skipped early.
  Under "Downloaded from": the Direct Url of the song's page, and for a song
  that came with a playlist import also that playlist's Url. Both open in the
  browser.
- **Favourites** (under All Songs in the menu): every starred song, newest
  star first; "Added" is when it was starred. Read-only apart from the stars.
- **Listen behaviour** (under Favourites in the menu, opens and closes): Most
  listened, Least listened and Long time no see, each a fifth of the library,
  made from the statistics and read-only.

How a listen is counted: only time actually played counts (not seeking or
pausing), and it is counted when the song changes. At least 75% heard is a
listen, under 30 seconds an early skip, anything between a stop. A song
unfinished when the app closes carries on at the next start. Long time no see
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
  - **Saved Songs**: how many songs and how much room they take. Open shows
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
- **Downloads**
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

In this order: the artist and track fields yt-dlp reads from the site; the
"Title · Artist" line of YouTube's auto-generated descriptions; the title
itself; the channel name. The title rules cover "Artist - Title (Mix)",
quoted titles (`BLACKPINK - ‘Shut Down’ M/V`, `NewJeans 'Ditto' Official MV`),
pipes (`“Golden” Official Lyric Video | KPop Demon Hunters | Sony Animation`
gives Golden by KPop Demon Hunters, the part naming the channel is skipped),
"Title by Artist", and "Title - Artist" when the right side is an artist
already in the library or the channel. Clutter such as Official Video, M/V,
(1 Hour), (prod. X) and [4K Remaster] is dropped, mixes in brackets keep their
text without the brackets. When only the channel name was left for the artist,
the Add Songs page says so next to the Artist box.

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

### Where things are

- Songs: `Music\YPlayer`, or the folder chosen in Settings. The app
  watches the folder: files copied in by hand, subfolders included, appear a
  few seconds after the copy finishes, deleted files leave the library, and a
  file renamed or moved in Explorer stays the same song, playlists included.
- Library, settings, the download cache and an updatable yt-dlp:
  `%LOCALAPPDATA%\YPlayer`. The library is `library.json`, with the previous
  version kept as `library.json.bak`.

Both folders keep the app's old name, YPlayer, so a library from before the
rename is found where it always was.

yt-dlp updates itself once a day in the background, since YouTube changes often
enough to break an old copy.

## Development

`tools/` is not in the repository (`ffmpeg.exe` and `ffprobe.exe` are over
GitHub's 100MB file limit). Put the Windows builds of all three there:

```
tools/
  ffmpeg.exe
  ffprobe.exe
  yt-dlp.exe
```

LWClipper's `tools/` folder has the same three.

```
npm install
npm start       # run it
npm test        # tests: no network, no ffmpeg
npm run icon    # build/icon.ico and renderer/assets/icon.png from build/flow.png
npm run dist    # build the installer into dist/
```

If `npm run dist` fails with "Cannot create symbolic link : A required
privilege is not held by the client", electron-builder could not unpack its
signing tools (they contain macOS symlinks, which Windows only allows with
Developer Mode on). Either turn on Developer Mode, or unpack the downloaded
archive by hand: in `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`, copy
one of the numbered folders it left behind to `winCodeSign-2.6.0`. Without that
step the build still works if `signAndEditExecutable` is set to false, but
`Flow.exe` then shows Electron's icon instead of Flow's.

To try it out without touching the real library, set `YPLAYER_HOME` (instead of
`%LOCALAPPDATA%\YPlayer`) and `YPLAYER_MUSIC` (instead of `Music\YPlayer`).

When running from a VS Code terminal, clear `ELECTRON_RUN_AS_NODE` first: VS Code
sets it, and with it set Electron starts as plain Node.

## Layout

- `main.js` holds the window and every IPC route; `preload.js` exposes
  `window.yplayer`. The window runs sandboxed with no Node.
- `src/` is the work, none of it touching the DOM:
  - `downloader.js`: yt-dlp probe and download, then keep / lift out / convert
  - `importer.js`: whole playlists, listed as a checklist, then imported;
    `spotify.js` reads Spotify lists and picks the YouTube upload per song
  - `formats.js`: which format a download is kept in
  - `exporter.js`: the trim cut and the tags, into `Music\YPlayer`
  - `titleParser.js`: Artist / Title / Mix from yt-dlp's info
  - `libraryModel.js`: songs, playlists and their rules; `library.js` saves it,
    scans the music folder and moves it (`relocate.js` plans where each file goes)
  - `loudness.js`: measures each song's loudness for Equalize volume
  - `settings.js`: what the app remembers, Settings' choices included
  - `waveform.js`: the peaks the trim editor draws
- `renderer/app/` is the window, one plain script per part, loaded in the order
  `index.html` lists them. `util.js`, `queue.js` and `spectrum.js` are also
  required by the tests. `trim.js` is LWClipper's trim slider and waveform
  drawing. `equalizer.js` draws the equalizer and owns the player's Web Audio
  route (two elements, each with a loudness and a fade gain, then limiter,
  analyser, volume, speakers). `ambient.js` draws the clouds, and
  `settingsPanel.js` is the Settings window.
