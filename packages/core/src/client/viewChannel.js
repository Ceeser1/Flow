'use strict';

// The library on its way to the window (4.3.3): whole once, then only what
// changed (libraryPatch.js), so a star or a rename in a library of 100 000
// songs sends one song and not 64 MB.
//
// The window gets { library, seq } or { patch, base, seq }: a patch fits
// the library numbered `base`; one that does not fit (missed, or from before
// the window started) makes the window ask for it whole (whole()).

const LibraryPatch = require('../libraryPatch');

// The parts compared item by item. A song's file getting its tags written
// (song.tagged) shows nowhere: alone, it is no change.
const SPEC = {
  songs: 'list', playlists: 'list', sharedPlaylists: 'list', deviceSongs: 'list',
};
const IGNORE = ['tagged'];

/** send(message): to the window ('library:changed'). */
function createViewChannel(send) {
  const differ = LibraryPatch.createDiffer(SPEC, { ignore: IGNORE });
  let seq = 0;
  return {
    /** The window took `lib` another way (its start): its number, which the next change fits. */
    start(lib) {
      differ.reset(lib);
      seq += 1;
      return seq;
    },
    /** `lib` sent whole. */
    whole(lib) {
      differ.reset(lib);
      seq += 1;
      send({ library: lib, seq });
    },
    /** What changed since the last sent (nothing when nothing did). */
    update(lib) {
      if (!differ.started()) {
        this.whole(lib);
        return;
      }
      const steps = differ.next(lib);
      if (!steps || !steps.length) return;
      const base = seq;
      seq += 1;
      send({ patch: steps, base, seq });
    },
  };
}

module.exports = { createViewChannel, SPEC, IGNORE };
