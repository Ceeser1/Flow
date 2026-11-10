# Flow in the browser

The web player: Flow's window in a browser, playing the songs of a Flow
Server. It is a folder of plain files (HTML, CSS, JavaScript, images) for any
web server, and has no service of its own: the browser talks straight to the
Flow Server whose address is typed in, and every song, cover and playlist comes
from there. The page itself holds no music and no library.

- **Looks:** the desktop app's layout, or the phone app's on a phone-sized
  screen (drawer, mini player, Now Playing). `?ui=mobile` or `?ui=desktop` on
  the address picks one.
- **Works as in the apps:** browsing, Search, playlists (smart ones too),
  favourites, profiles and their PINs, Statistics, the Queue, Song
  Transition, Equalize volume, lyrics, the sound Equalizer, the background
  clouds and equalizer, the visualizers, Active Sessions, Administration,
  and Add Songs through the server ("Download (Server)", when the server
  downloads songs).
- **Not in the browser:** songs of the device's own (Local Files, Open local
  File(s) / Folder), downloads for offline, downloading with yt-dlp in the
  browser, finding servers on the network (the address is typed in), guests
  in other servers' sessions, backups, the lyrics editor.
- **What the browser keeps:** the settings and which server and profile it
  uses, in localStorage, so a reload finds them. The server's password,
  profile PINs and the sign-in token only in the browser's session: once
  the browser is closed, the next visit asks for the password again. The
  library is fetched again on every visit.

## Which addresses work

A page opened over **https** may only reach servers over **https** (or a
server on the same computer, `localhost:7878`). Browsers block plain http
addresses from it, so a server at `http://192.168.0.20:7878` is out of reach
from an https page. A server reachable over https (level 3 with Caddy, or
level 4 behind your own web server, see `apps/linux-server/README.md`) works
from anywhere. A page opened over plain http (on the home network) reaches
plain http servers too.

The Flow Server allows requests from any page (CORS), so the web player may
be on another website than the server. Put on the same website as the server
(the page at `/flow-web/`, the server at `/flow/`), it needs nothing more.

## Building

```
npm run build -w apps/web     # into apps/web/dist/
npm test -w apps/web
```

`dist/` is the whole web player: copy it to the web server, into any folder.
Every address in it is relative. Every script and style is loaded with
`?v=<build>`, so a web server that keeps them cached for long still hands out
the new ones after an update.

To try it on this computer:

```
npm run build -w apps/web
npm run serve -w apps/web -- --flow http://127.0.0.1:7878
```

That serves the page at `http://127.0.0.1:8090/link/` and passes `/flow/` on
to the Flow Server given, so the page can use either the server's own address
or `http://127.0.0.1:8090/flow`.

## How it works

The page is the desktop app's window (`apps/desktop/renderer`), as on the
phone. `src/main.js` gives it the same `window.flow` the desktop's
`preload.js` does, answered in the page by the shared client
(`@flow/core/client`), as the Android app's `src/main.js` does:

- `src/env.js`: what the shared client gets from the page. Local Files is
  always empty, covers are shown straight from the server (`streamCovers`,
  `fileUrl`), the device's name is the browser and its system ("Firefox -
  Windows").
- `src/storage.js`: what is kept where (localStorage, sessionStorage, memory).
- `src/memfs.js`: files in the page's memory, for the parts of the shared
  client that write some (the Lyrics folder, a download's cover).
- `src/http.js`: requests through the page's `fetch`, the live channel read
  as a stream.

The window hides what a browser cannot do by its caps
(`@flow/core/client/caps` WEB) and reads `Store.web` where the words differ.
