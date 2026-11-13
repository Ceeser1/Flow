'use strict';

// "Download (Server)": the server reads a link, downloads its songs itself
// and keeps them aside until an app has looked at them, so apps without
// yt-dlp (a browser, a phone) can add songs too.
//
// A profile may have several batches (4.4, the download queue; no profile:
// the shared ones). Each lives in <home>/staging/<profile>/<batch id>/, not in
// the music folder, so the folder scan never sees it: batch.json (written
// atomically) and the prepared files, each with its waveform's peaks beside
// it. Nothing of it is in the library until an app finishes a song: then the
// trim is cut out straight into the music folder, with its names in the tags,
// and the song added like an upload.
//
// The batches of all profiles take turns, oldest first: one is read and its
// songs downloaded while the next ones wait ('queued'); the next one's turn
// comes once the one before has no song left waiting to download. A batch
// whose songs are all downloaded waits for its app's Finish All without
// holding up the others. A link's name and song count are read at once
// (listing.peek) for the apps' queue lines and its panel while the whole
// read (its turn) goes on.
//
// A list read for an app that asked to choose its songs (review: the app's
// "Auto-accept songs lookup" unticked, 4.4.1) waits as 'review' with its
// checklist until the app sends the songs ticked (choose); the ones not
// ticked go. Like a batch waiting for Finish All it holds no one up: its
// owner may be away. Its songs download once chosen, in the order of age.
// A batch asked to finish by itself (auto.finish: the app's "Automate
// 'Finish All'") saves every song as it came once all are downloaded, into a
// playlist named after the list (merged into one of the profile's of that
// name), a single song into All Songs only; what that did stays in `done`
// for a while for the apps' message. Apps from before the queue see only a
// profile's oldest batch and cannot start a second (409), as before.
//
//   queued       waiting for its turn (4.4).
//   listing      the link is read in the background (a Spotify, Deezer or
//                Amazon Music list is looked up on YouTube, which takes a
//                while); an app polls.
//   review       read, waiting for the app's choice of songs (4.4.1).
//   ready        the list is known. Its songs download one after another:
//                queued -> downloading -> converting -> ready (or failed).
//                Songs the library has already are 'library', not downloaded.
//                Finished songs are 'saved', thrown away ones 'discarded'.
//   failed       the link could not be read (batch.error); cancel it.
//
// The playlist (if the app wants one) is made by the first song finished,
// and every song goes in at its place in the source: base - index seconds,
// as the apps do it (importer.finish). Words typed instead of a link are
// searched for (search) without a batch: the app lists what was found, and
// the uploads picked come back as a batch of their own (one: a one-song
// batch of its link; several: createPicked). A playlist's Update reads its
// link without a batch (check), and the songs ticked in the app come back as
// a batch of their own that keeps the link (createPicked with source). A batch nobody opens or finishes
// anything of for downloadKeepDays (30) is thrown away, and so is a deleted
// profile's.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createMedia, ProcessCancelledError } = require('@flow/core/media');
const { createLister, groupToken, existingInfo } = require('@flow/core/listing');
const { MAX_COOKIES, cookieSites, cookiesFor } = require('@flow/core/cookies');
const { splitLinks, joinLinks } = require('@flow/core/text');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { MP3_QUALITIES } = require('@flow/core/formats');
const { isPrivateIp } = require('@flow/core/address');
const { coverVersion } = require('@flow/core/cover');
const { MAX_QUERY } = require('@flow/core/songSearch');
const { albumFor } = require('@flow/core/libraryModel');

const MAX_ITEMS = 500;
const ITEM_TIMEOUT = 20 * 60 * 1000;
// A search reads a few uploads at once; on a Pi that can take a while.
const SEARCH_TIMEOUT = 90 * 1000;
// Uploads picked from a search's results at once (a few pages of "Search for more").
const MAX_PICKED = 50;
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
// Items still to be dealt with: a batch with none of these left is over.
const OPEN = new Set(['queued', 'downloading', 'converting', 'ready', 'saving']);
// Items still coming: a batch with none of these left waits for its Finish All.
const COMING = new Set(['queued', 'downloading', 'converting']);
// Batches one profile may have at once (queued, downloading, waiting).
const QUEUE_MAX = 20;
// How long what a batch that finished by itself did is told to the apps.
const DONE_KEEP = 10 * 60 * 1000;
// The apps are told that the downloads changed this long after a change
// (several go together), a song's progress alone once in this long (4.6).
const CHANGE_DELAY_MS = 100;
const PROGRESS_EVERY_MS = 1000;
const isBatchId =(id) => /^[0-9a-f]{12}$/.test(String(id || ''));

class DownloadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const keyOf = (profileId) => profileId || '_shared';

/**
 * A link the server may hand to yt-dlp: a web page (http or https) on the
 * internet, or a Spotify link. Never this machine or the home network: yt-dlp
 * reads any page it is given, so a link to the router or another device at
 * home would have the server fetch it for whoever sent it. (A name on the
 * internet that leads home is not caught; only addresses and home names are.)
 * The link is passed on as the one argument it is, after fixed options.
 */
function checkLink(text) {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 2000) throw new DownloadError(400, 'Paste a link first.');
  if (/^spotify:[a-z]+:[A-Za-z0-9]+$/i.test(raw)) return raw;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new DownloadError(400, 'That does not look like a link.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new DownloadError(400, 'Only web links (http or https) can be downloaded.');
  if (u.username || u.password) throw new DownloadError(400, 'Links with a user name or password in them are not downloaded.');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = /^(localhost|.*\.localhost|.*\.local|.*\.lan|.*\.home\.arpa|.*\.internal)$/.test(host) || !host.includes('.') && !net.isIP(host);
  const v4 = net.isIPv4(host) ? host.split('.').map(Number) : null;
  const special = v4 ? (v4[0] === 0 || (v4[0] === 169 && v4[1] === 254) || v4[0] >= 224) : (net.isIPv6(host) && (host === '::' || /^fe[89ab]/.test(host)));
  if (local || (net.isIP(host) && (isPrivateIp(host) || special))) {
    throw new DownloadError(400, 'The server does not download from itself or the home network. Paste a link to a page on the internet.');
  }
  return u.href;
}

/**
 * A box with several links pasted at once (text.splitLinks): each checked as
 * checkLink does, then all of them as one source again. As many as are sent.
 */
function checkLinks(text) {
  const links = splitLinks(text);
  if (links.length < 2) return checkLink(text);
  return joinLinks(links.map(checkLink));
}

/** The conversion choice an app sends, as formats.planFor takes it. */
function cleanOptions(o) {
  const r = o && typeof o === 'object' ? o : {};
  const q = Number(r.quality);
  return { alwaysMp3: !!r.alwaysMp3, quality: MP3_QUALITIES.includes(q) ? q : 192, keepMp3: r.keepMp3 !== false };
}

function cleanText(v, max = 150) {
  return String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function removeQuietly(file) {
  try {
    fs.rmSync(file, { force: true, recursive: true });
  } catch {
    // Still open somewhere; the next start's cleanup gets it.
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** What an app asks of a batch's end (4.4): { complete, finish }; finish only with complete. */
function cleanAuto(a) {
  const r = a && typeof a === 'object' ? a : {};
  const complete = !!r.complete;
  return { complete, finish: complete && !!r.finish };
}

function freeBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return Infinity;
  }
}

/**
 * config, library: the server's. tools: tools.js (ffmpeg, ffprobe, ytdlp).
 */
function createDownloads({ config, library, tools, log = () => {} }) {
  const root = path.join(config.home, 'staging');
  fs.mkdirSync(root, { recursive: true });
  const media = createMedia({
    ffmpeg: tools.ffmpeg,
    ffprobe: tools.ffprobe,
    ytdlp: tools.ytdlp,
    cacheDir: () => root,
    missing: (name) => `This server has no ${name}, so it cannot download.`,
    lowPriority: true,
  });
  const lister = createLister({ media, library: () => library.data, lookupInfo: library.lookupInfo || null });

  const batches = new Map();    // batch id -> batch (as batch.json holds it)
  const progress = new Map();   // `${batch id}/${index}` -> { frac, text } of the song downloading
  const running = new Map();    // `${batch id}/${index}` -> cancel token
  const listing = new Map();    // batch id -> the listing's cancel group
  const peeking = new Map();    // batch id -> the quick read's cancel group (peek)
  const finishing = new Set();  // batch ids finishing by themselves (autoFinish)
  const done = new Map();       // profile key -> [what a batch that finished by itself did]
  const searching = new Map();  // profile key -> the search's cancel group (search)
  const checking = new Map();   // `${profile key}|${link}` -> the check's cancel group (check)
  let active = 0;
  let stopped = false;
  // Batches made in the same millisecond still take turns in the order sent.
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
  };

  const dirOf = (batch) => path.join(root, batch.key, batch.id);
  const fileOf = (batch, item) => (item.file ? path.join(dirOf(batch), item.file) : null);
  const peaksOf = (batch, item) => path.join(dirOf(batch), `i${item.index}.peaks.json`);
  // The song's cover, looked for as soon as it is downloaded (item.cover: its
  // version), so the apps show it while the song is trimmed and named; it
  // becomes the song's when finished.
  const coverOf = (batch, item) => path.join(dirOf(batch), `i${item.index}.cover.jpg`);
  // One lookup at a time, apart from the downloads: a song is ready without
  // waiting for its cover.
  let coverChain = Promise.resolve();
  // The browser cookies an app sent with the batch (only the link's site's):
  // its yt-dlp runs read them, and they go with the batch's folder.
  const cookiesOf = (batch) => path.join(dirOf(batch), 'cookies.txt');
  const ytdlpArgs = (batch) => (batch.cookies ? ['--cookies', cookiesOf(batch)] : null);
  const isAlive = (batch) => batches.get(batch.id) === batch;
  /** A profile's batches, oldest first. */
  const batchesOf = (key) => [...batches.values()].filter((b) => b.key === key).sort((a, b) => a.createdAt - b.createdAt);
  const profileName = (key) => {
    if (key === keyOf(null)) return 'Default / Shared';
    const p = config.get().profiles.find((x) => x.id === key);
    return p ? p.name : '';
  };

  function save(batch) {
    if (!isAlive(batch)) return;
    fs.mkdirSync(dirOf(batch), { recursive: true });
    writeJsonAtomic(path.join(dirOf(batch), 'batch.json'), batch);
    changed();
  }

  // ---- telling the apps (4.6) ----
  //
  // Whenever something the apps show of the downloads changes (a batch made,
  // read, a song downloaded, saved or failed, a batch gone), onChange's
  // listeners hear of it a moment later, several changes together; the
  // server tells the apps on their live channels (server.js), and they ask
  // for the batches then instead of every few seconds. A song's progress
  // alone is told once a second at most.
  const changeListeners = [];
  let changeTimer = null;
  let changeDue = 0;
  let changeTold = 0;
  function changed(progressOnly = false) {
    if (stopped || !changeListeners.length) return;
    const now = Date.now();
    const due = progressOnly ? Math.max(now + CHANGE_DELAY_MS, changeTold + PROGRESS_EVERY_MS) : now + CHANGE_DELAY_MS;
    // One on its way already that comes soon enough.
    if (changeTimer && changeDue <= due) return;
    clearTimeout(changeTimer);
    changeDue = due;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      changeTold = Date.now();
      for (const fn of changeListeners) {
        try {
          fn();
        } catch (err) {
          log(`Downloads: ${err.message}`);
        }
      }
    }, Math.max(0, due - now));
    if (changeTimer.unref) changeTimer.unref();
  }

  function drop(batch, why = 'thrown away') {
    if (!isAlive(batch)) return;
    batches.delete(batch.id);
    for (const map of [listing, peeking]) {
      const group = map.get(batch.id);
      if (group) group.cancel();
      map.delete(batch.id);
    }
    for (const [k, token] of running) {
      if (k.startsWith(`${batch.id}/`)) token.cancel ? token.cancel() : (token.cancelled = true);
    }
    removeQuietly(dirOf(batch));
    // The profile's folder goes with its last batch.
    try {
      if (!fs.readdirSync(path.join(root, batch.key)).length) fs.rmdirSync(path.join(root, batch.key));
    } catch {
      // Gone already, or something else in it.
    }
    log(`Download batch ${batch.source.name ? `"${batch.source.name}" ` : ''}${why}`);
    turn();
    changed();
  }

  /** Whatever a download that was cut off left behind: partial files of items not ready. */
  function cleanPartial(batch, item) {
    for (const f of fs.readdirSync(dirOf(batch), { withFileTypes: true })) {
      if (f.isFile() && f.name.startsWith(`i${item.index}_`) && f.name !== item.file) removeQuietly(path.join(dirOf(batch), f.name));
    }
  }

  // ---- taking turns (4.4) ----

  /** The batch that has the turn: being read, or with songs still waiting to download. */
  const hasTurn = (b) => b.state === 'listing' || (b.state === 'ready' && b.items.some((it) => it.state === 'queued'));

  /** The next queued batch starts once no batch has the turn. */
  function turn() {
    if (stopped) return;
    const all = [...batches.values()];
    if (all.some(hasTurn)) return;
    const next = all.filter((b) => b.state === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) return;
    next.lastActivity = Date.now();
    if (next.prepared) {
      // Picked from a search or an Update: its songs are known already.
      next.state = 'ready';
      delete next.prepared;
      save(next);
      log(`Download batch "${next.source.name}": ${next.items.length} ${next.items.length === 1 ? 'song' : 'songs'}`);
      pump();
      settle(next);
      return;
    }
    next.state = 'listing';
    save(next);
    startListing(next);
  }

  /** Where a queued batch stands in the queue of all profiles (1: next), else 0. */
  function placeOf(batch) {
    if (batch.state !== 'queued') return 0;
    return [...batches.values()].filter((b) => b.state === 'queued' && b.createdAt <= batch.createdAt).length;
  }

  /**
   * A queued link's name and song count for the apps' queue lines, read at
   * once (listing.peek) while it waits; the whole read is its turn.
   */
  async function startPeek(batch) {
    const group = groupToken(ytdlpArgs(batch));
    peeking.set(batch.id, group);
    try {
      const got = await lister.peek(batch.source.url, group, { song: batch.single });
      if (!isAlive(batch)) return;
      batch.peek = { name: cleanText(got.name, 200), count: got.count, single: got.single, sourceTotal: got.sourceTotal || 0 };
    } catch (err) {
      if (!isAlive(batch) || group.cancelled) return;
      batch.peek = { error: cleanText((err && err.message) || 'The link could not be read.', 300) };
    } finally {
      if (peeking.get(batch.id) === group) peeking.delete(batch.id);
    }
    save(batch);
  }

  // ---- finishing by itself (4.4) ----

  /** What a batch that finished by itself did, told to the apps for DONE_KEEP. */
  function remember(batch, result) {
    const now = Date.now();
    const list = (done.get(batch.key) || []).filter((d) => now - d.at < DONE_KEEP);
    list.push({
      id: batch.id, name: batch.source.name || '', url: batch.source.url || '', single: !!batch.single, at: now, ...result,
    });
    done.set(batch.key, list.slice(-20));
  }

  /**
   * A batch whose songs have all come: with auto.complete a single song the
   * library has already is skipped; with auto.finish every song is saved as
   * it came (autoFinish). Otherwise it waits for its app.
   */
  function settle(batch) {
    if (!isAlive(batch) || batch.state !== 'ready' || batch.items.some((it) => COMING.has(it.state))) return;
    const auto = batch.auto || {};
    if (!auto.complete && !auto.finish) return;
    const item = batch.items[0];
    if (batch.single && item && item.state === 'library') {
      remember(batch, { skipped: true, existing: item.existing || null, saved: 0, added: 0, failed: [] });
      drop(batch, 'skipped: the song is in the library already');
      return;
    }
    if (auto.finish) autoFinish(batch);
  }

  async function autoFinish(batch) {
    if (finishing.has(batch.id)) return;
    finishing.add(batch.id);
    const profileId = batch.profileId || null;
    const playlist = batch.single ? null : { name: batch.source.name, byName: true };
    const failed = batch.items.filter((it) => it.state === 'failed').map((it) => ({ title: it.title, reason: it.error || '' }));
    let saved = 0;
    try {
      for (const item of batch.items) {
        if (!isAlive(batch)) return;
        if (item.state !== 'ready') continue;
        const known = batch.items.filter((it) => it.state === 'library').map((it) => it.index);
        try {
          await finishItem(batch, item, {
            meta: { ...(item.meta || {}), title: (item.meta && item.meta.title) || item.title },
            start: 0,
            end: item.duration,
            playlist,
            existing: known,
          }, { endBatch: false });
          saved += 1;
        } catch (err) {
          failed.push({ title: item.title, reason: (err && err.message) || 'It could not be saved.' });
        }
      }
      if (!isAlive(batch)) return;
      // Only songs the library has: the playlist is made of them.
      const known = batch.items.filter((it) => it.state === 'library' && it.existing);
      if (known.length && playlist) {
        if (!batch.base) batch.base = Date.now();
        if (!batch.playlistId) {
          batch.playlistId = library.importPlaylist(profileId, {
            name: cleanText(playlist.name, 75) || 'Imported playlist', byName: true, source: { url: batch.source.url, kind: batch.source.kind },
          });
        }
        for (const it of known) {
          library.addToPlaylists(profileId, it.existing.id, [batch.playlistId], batch.base - it.index * 1000);
          it.state = 'added';
        }
      }
      const added = batch.items.filter((it) => it.state === 'added').length;
      remember(batch, { saved, added, failed, playlistId: batch.playlistId || null });
      drop(batch, `finished by itself (${saved} saved)`);
    } finally {
      finishing.delete(batch.id);
    }
  }

  // ---- loading what was there before a restart ----

  function load() {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const profileIds = new Set(library.profileIds());
    for (const key of names) {
      const dir = path.join(root, key);
      if (!(key === '_shared' || profileIds.has(key)) || !isDir(dir)) {
        removeQuietly(dir);
        continue;
      }
      // A server from before the queue kept the profile's one batch right in
      // its folder: moved into a folder of its own.
      const old = readJson(path.join(dir, 'batch.json'));
      if (old && old.key === key && isBatchId(old.id)) {
        const into = path.join(dir, old.id);
        fs.mkdirSync(into, { recursive: true });
        for (const f of fs.readdirSync(dir)) {
          if (f !== old.id) fs.renameSync(path.join(dir, f), path.join(into, f));
        }
      } else if (fs.existsSync(path.join(dir, 'batch.json'))) {
        removeQuietly(path.join(dir, 'batch.json'));
      }
      for (const id of fs.readdirSync(dir)) {
        const batch = isBatchId(id) ? readJson(path.join(dir, id, 'batch.json')) : null;
        if (!(batch && batch.key === key && batch.id === id && Array.isArray(batch.items))) {
          removeQuietly(path.join(dir, id));
          continue;
        }
        if (!batch.createdAt) batch.createdAt = Date.now();
        // A link that was still being read waits for its turn again; songs
        // that were downloading start over.
        if (batch.state === 'listing') batch.state = 'queued';
        for (const item of batch.items) {
          if (item.state === 'downloading' || item.state === 'converting') item.state = 'queued';
          if (item.state === 'saving') item.state = 'ready';
          if (item.state === 'queued') cleanPartial(batch, item);
        }
        batches.set(id, batch);
        save(batch);
        if (batch.state === 'queued' && !batch.peek && !batch.prepared) startPeek(batch);
      }
      try {
        if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
      } catch {
        // As drop.
      }
    }
  }

  // ---- reading the link ----

  /** A song of the listing as a batch item. */
  /**
   * Why a list read is not whole: the list's own reason (Spotify's first 100
   * ...), else 'server' past MAX_ITEMS. Of several links, whose notes say
   * what each lacks, the server's limit comes first.
   */
  function cutAt(result) {
    const over = result.items.length > MAX_ITEMS ? 'server' : false;
    return (result.links ? over || result.truncated : result.truncated || over) || false;
  }

  /** The playlist link a saved song keeps: its own link of several (listUrl), else the batch's. */
  function playlistUrlOf(batch, item) {
    if (batch.single) return '';
    return typeof item.listUrl === 'string' ? item.listUrl : batch.source.url;
  }

  /** The upload a list's song was matched to, as the apps' checklist shows it. */
  function matchOf(m) {
    if (!m || typeof m !== 'object') return null;
    return {
      id: cleanText(m.id, 100),
      url: cleanText(m.url, 2000),
      site: cleanText(m.site, 40),
      title: cleanText(m.title, 200),
      channel: cleanText(m.channel, 200),
      duration: Number(m.duration) || 0,
      quality: cleanText(m.quality, 20),
    };
  }

  function itemOf(it, i) {
    let state = 'queued';
    let error = '';
    if (it.existing) state = 'library';
    else if (it.status !== 'ok') {
      state = 'failed';
      error = it.note || (it.status === 'notfound' ? 'not found' : 'not available');
    }
    return {
      index: i,
      title: String(it.title || `Song ${i + 1}`),
      duration: Number(it.duration) || 0,
      url: String(it.url || ''),
      key: String(it.key || ''),
      meta: it.meta && it.meta.title ? {
        artist: it.meta.artist || '',
        title: it.meta.title,
        mix: it.meta.mix || '',
        album: it.meta.album || '',
        genre: it.meta.genre || '',
        subGenre: it.meta.subGenre || '',
      } : null,
      artistFromChannel: false,
      existing: it.existing || null,
      // Of several links read as one (listing.listMany): the link it was found
      // in, the playlist it came from once saved. Without it, the batch's link.
      ...(typeof it.listUrl === 'string' ? { listUrl: it.listUrl } : {}),
      // For the checklist of a batch in review: the list's word on the song
      // and the upload it was matched to (dropped once the songs are chosen).
      status: ['ok', 'notfound', 'unavailable'].includes(it.status) ? it.status : 'ok',
      match: matchOf(it.match),
      state,
      error,
      file: '',
      summary: '',
    };
  }

  async function startListing(batch) {
    const group = groupToken(ytdlpArgs(batch));
    listing.set(batch.id, group);
    const knownArtists = [...new Set(library.data.songs.map((s) => s.artist).filter(Boolean))];
    const onProgress = (p) => {
      const text = p.text || (p.phase === 'matching'
        ? `Looking up the songs on YouTube: ${p.done} of ${p.total}${p.known ? ` · ${p.known} already in the library` : ''}`
        : '');
      progress.set(`${batch.id}/list`, { frac: p.total ? p.done / p.total : null, text });
      changed(true);
    };
    try {
      let items;
      let name = batch.source.name;
      let kind = batch.source.kind;
      let truncated = false;
      let sourceTotal = 0;
      let links = null;
      if (batch.single) {
        const probed = await media.probe(batch.source.url, group.sub(), { knownArtists });
        items = [itemOf({ title: probed.title, duration: probed.duration, url: probed.url, key: probed.key, status: 'ok' }, 0)];
        items[0].probed = probed;
        name = probed.title;
        kind = String(probed.site || '').toLowerCase();
      } else {
        const result = await lister.list(batch.source.url, group, onProgress, { knownArtists });
        if (result.single) {
          const probed = result.probed;
          items = [itemOf({ title: probed.title, duration: probed.duration, url: probed.url, key: probed.key, status: 'ok' }, 0)];
          items[0].probed = probed;
          batch.single = true;
          name = probed.title;
          kind = String(probed.site || '').toLowerCase();
        } else {
          items = result.items.slice(0, MAX_ITEMS).map(itemOf);
          truncated = cutAt(result);
          sourceTotal = Number(result.sourceTotal) || 0;
          links = result.links || null;
          name = result.name;
          kind = String(result.source || '').toLowerCase();
          batch.source.url = result.sourceUrl || batch.source.url;
        }
      }
      // A song the library has already is not downloaded again.
      for (const item of items) {
        if (item.state !== 'queued' || !item.key) continue;
        const same = library.existingFor(null, { sourceKey: item.key, sourceUrl: item.url });
        if (same) {
          item.state = 'library';
          item.existing = existingInfo(same);
        }
      }
      if (!isAlive(batch)) return;
      // A list for an app that chooses its songs waits for its choice (choose).
      const state = batch.review && !batch.single ? 'review' : 'ready';
      if (state === 'ready') for (const item of items) delete item.match;
      Object.assign(batch, { state, items, truncated, sourceTotal, error: '' });
      if (links) batch.links = links;
      batch.source.name = cleanText(name, 200) || 'Download';
      batch.source.kind = kind;
      log(`Download batch "${batch.source.name}": ${items.length} ${items.length === 1 ? 'song' : 'songs'}${state === 'review' ? ', waiting for its songs to be chosen' : ''}`);
    } catch (err) {
      if (!isAlive(batch) || group.cancelled) return;
      batch.state = 'failed';
      batch.error = (err && err.message) || 'The link could not be read.';
    } finally {
      if (listing.get(batch.id) === group) listing.delete(batch.id);
      progress.delete(`${batch.id}/list`);
    }
    batch.lastActivity = Date.now();
    save(batch);
    pump();
    settle(batch);
    turn();
  }

  // ---- downloading, one song after another ----

  function nextQueued() {
    const all = [...batches.values()].filter((b) => b.state === 'ready').sort((a, b) => a.createdAt - b.createdAt);
    for (const batch of all) {
      const item = batch.items.find((it) => it.state === 'queued');
      if (item) return { batch, item };
    }
    return null;
  }

  function pump() {
    while (!stopped && active < config.get().downloadJobs) {
      const next = nextQueued();
      if (!next) break;
      active += 1;
      next.item.state = 'downloading';
      runItem(next.batch, next.item).finally(() => {
        active -= 1;
        settle(next.batch);
        pump();
      });
    }
    // The last song of the batch with the turn has started: the next one's
    // link is read meanwhile.
    turn();
  }

  /**
   * The cover of a song just downloaded, after the downloads' own work. Found
   * while the song waits: kept beside it for the apps (item.cover). Found
   * after it was finished: the song's, unless it has one by then.
   */
  function findCover(batch, item, song) {
    const alive = () => isAlive(batch) && item.state !== 'discarded' && !stopped;
    coverChain = coverChain.then(async () => {
      if (!alive()) return;
      const found = await library.lookForCover(song, () => !alive());
      if (!found.jpeg || !alive()) return;
      if (item.state === 'saved') {
        if (item.songId) library.setCover(item.songId, found.jpeg, { onlyIfNone: true }).catch(() => {});
        return;
      }
      fs.writeFileSync(coverOf(batch, item), found.jpeg);
      item.cover = coverVersion(found.jpeg);
      save(batch);
    }).catch(() => {
      // The library looks for one itself once the song is finished.
    });
  }

  async function runItem(batch, item) {
    const id = `${batch.id}/${item.index}`;
    const token = { cancelled: false, ytdlpArgs: ytdlpArgs(batch) };
    running.set(id, token);
    progress.set(id, { frac: null, text: 'Reading...' });
    // Its turn has come (downloading now): told at once.
    changed();
    const timer = setTimeout(() => {
      token.timedOut = true;
      if (token.cancel) token.cancel();
      else token.cancelled = true;
    }, ITEM_TIMEOUT);
    const alive = () => isAlive(batch) && item.state !== 'discarded';
    try {
      const dir = dirOf(batch);
      fs.mkdirSync(dir, { recursive: true });
      if (freeBytes(dir) < MIN_FREE_BYTES) throw new Error('The server is running out of disk space.');
      let probed = item.probed;
      if (!probed) {
        probed = await media.probe(item.url, token, { knownArtists: [] });
        item.probed = probed;
      }
      // The same upload, or the same song (its names at the same length) from another.
      const names = item.meta && item.meta.title ? item.meta : probed.guess || {};
      const same = library.existingFor(null, {
        sourceKey: probed.key, sourceUrl: probed.url, artist: names.artist, title: names.title, mix: names.mix, duration: probed.duration,
      });
      if (same) {
        item.state = 'library';
        item.existing = existingInfo(same);
        return;
      }
      const stemKey = `i${item.index}_${probed.key || 'song'}`;
      const file = await media.download({ ...probed, key: stemKey }, batch.options, (stage, frac, text) => {
        if (stage === 'prepare' && item.state === 'downloading') item.state = 'converting';
        progress.set(id, { frac, text });
        changed(true);
      }, token, { dir });
      if (!alive()) {
        removeQuietly(file.path);
        return;
      }
      item.file = path.basename(file.path);
      item.duration = file.duration || item.duration;
      item.summary = file.summary;
      if (!item.meta) {
        item.meta = { artist: probed.guess.artist || '', title: probed.guess.title || probed.title, mix: probed.guess.mix || '' };
        item.artistFromChannel = !!probed.guess.artistFromChannel;
      }
      // Its album, genre and Info: the list's, the page's, else Apple's, then Discogs' (listing.withInfo).
      item.meta = await lister.withInfo(item.meta, probed);
      if (!alive()) {
        removeQuietly(file.path);
        return;
      }
      item.sourceUrl = probed.url;
      item.sourceKey = probed.key;
      // The waveform, small enough to fetch on its own (GET .../peaks).
      try {
        const peaks = await media.peaksFor(file.path, item.duration, token);
        fs.writeFileSync(peaksOf(batch, item), JSON.stringify(peaks));
      } catch {
        // The song can be trimmed without it.
      }
      if (!alive()) return;
      item.state = 'ready';
      item.error = '';
      findCover(batch, item, {
        sourceKey: probed.key,
        sourceUrl: probed.url,
        sourcePlaylistUrl: playlistUrlOf(batch, item),
        artist: item.meta.artist,
        title: item.meta.title,
        duration: item.duration,
        thumbnails: probed.thumbnails,
      });
    } catch (err) {
      // The server stopping: the song starts over at the next start.
      if (!alive() || stopped) return;
      cleanPartial(batch, item);
      item.state = 'failed';
      item.error = token.timedOut ? 'The download took too long.'
        : (err instanceof ProcessCancelledError ? 'Cancelled.' : (err && err.message) || 'The download failed.');
    } finally {
      clearTimeout(timer);
      running.delete(id);
      progress.delete(id);
      delete item.probed;
      if (alive() && !stopped) save(batch);
    }
  }

  // ---- what the apps see ----

  /**
   * A batch as the apps see it. legacy: for an app from before the queue,
   * which knows no 'queued' batch: it reads as one still being read.
   */
  function publicBatch(batch, { legacy = false } = {}) {
    if (!batch) return null;
    const place = placeOf(batch);
    let list = progress.get(`${batch.id}/list`);
    let { state } = batch;
    if (legacy && state === 'queued') {
      state = 'listing';
      list = { frac: null, text: `Waiting for its turn on the server (number ${place} in the queue)...` };
    }
    return {
      id: batch.id,
      state,
      // 4.4: what the queue lines show while it waits (listing.peek), its place, how it ends.
      peek: batch.peek || null,
      place,
      auto: batch.auto || null,
      profileId: batch.profileId || null,
      error: batch.error || '',
      source: batch.source,
      single: !!batch.single,
      truncated: batch.truncated || false,
      // How many songs the list has where it came from (Spotify), when more than are listed.
      sourceTotal: batch.sourceTotal || 0,
      // Several links read as one: what each gave ([{ url, name, songs, listed, truncated, sourceTotal, error? }]).
      links: batch.links || null,
      options: batch.options,
      // Downloaded with browser cookies from the app that started it.
      cookies: !!batch.cookies,
      playlistId: batch.playlistId || null,
      createdAt: batch.createdAt,
      expiresAt: batch.lastActivity + config.get().downloadKeepDays * DAY,
      progress: list || null,
      items: batch.items.map((it) => ({
        index: it.index,
        title: it.title,
        duration: it.duration,
        url: it.url,
        state: it.state,
        error: it.error || '',
        meta: it.meta,
        artistFromChannel: !!it.artistFromChannel,
        existing: it.existing || null,
        // The checklist's (4.4.1, review only).
        ...(batch.state === 'review' ? { status: it.status || 'ok', match: it.match || null } : {}),
        summary: it.summary || '',
        cover: it.cover || '',
        progress: progress.get(`${batch.id}/${it.index}`) || null,
      })),
    };
  }

  /** Looked at by its owner: kept for another downloadKeepDays (written at most once an hour, not at every poll). */
  function touch(batch) {
    if (Date.now() - batch.lastActivity > 60 * 60 * 1000) {
      batch.lastActivity = Date.now();
      save(batch);
    }
  }

  /**
   * The queue's lines, every profile's (4.4): each batch still waiting or
   * downloading, in its order. { id, own, profileName, name, count, url,
   * state ('queued' | 'listing' | 'downloading'), place }. The batches whose
   * songs have all come are not in it; their owners see them as theirs.
   */
  function queueRows(profileId) {
    const mine = keyOf(profileId);
    const order = { listing: 0, downloading: 0, queued: 1 };
    return [...batches.values()]
      .map((b) => {
        let state = null;
        if (b.state === 'queued' || b.state === 'listing') state = b.state;
        else if (b.state === 'ready' && b.items.some((it) => COMING.has(it.state))) state = 'downloading';
        if (!state) return null;
        const peek = b.peek || {};
        const count = b.state === 'ready' || b.prepared ? b.items.filter((it) => it.state !== 'discarded').length : (Number(peek.count) || 0);
        return {
          id: b.id,
          own: b.key === mine,
          profileName: profileName(b.key),
          name: b.source.name || peek.name || '',
          count,
          url: b.source.url || '',
          single: !!(b.single || peek.single),
          state,
          place: placeOf(b),
          createdAt: b.createdAt,
        };
      })
      .filter(Boolean)
      .sort((a, b) => order[a.state] - order[b.state] || a.createdAt - b.createdAt);
  }

  /**
   * GET /api/downloads: { batch } for an app from before the queue (the
   * profile's oldest, legacy); with the queue (4.4) also { batches (the
   * profile's, oldest first), queue (queueRows), done (what its batches that
   * finished by themselves did, the last DONE_KEEP) }.
   */
  function get(profileId, { queue = false } = {}) {
    const mine = batchesOf(keyOf(profileId));
    for (const b of mine) touch(b);
    const out = { batch: publicBatch(mine[0] || null, { legacy: !queue }) };
    if (!queue) return out;
    const now = Date.now();
    out.batches = mine.map((b) => publicBatch(b));
    out.queue = queueRows(profileId);
    out.done = (done.get(keyOf(profileId)) || []).filter((d) => now - d.at < DONE_KEEP);
    return out;
  }

  /** The profile's batch `id`, or without one (an app from before the queue) its oldest. */
  function requireBatch(profileId, id = null) {
    const key = keyOf(profileId);
    const batch = id ? batches.get(String(id)) : batchesOf(key)[0];
    if (!batch || batch.key !== key) throw new DownloadError(404, 'There is no such download on the server for this profile.');
    return batch;
  }

  function requireItem(batch, index) {
    const item = batch.items.find((it) => it.index === Number(index));
    if (!item) throw new DownloadError(404, 'That song is not in the download.');
    return item;
  }

  /**
   * A new batch for `url`: { url, kind: 'song' | 'list', options, cookies }.
   * kind 'song' reads only the one song even from a link into a playlist.
   * cookies: a Netscape cookie file's text from the app's browser, of which
   * only the link's site's cookies are kept. Or, for uploads picked from a
   * search (search), { items: [{ url, title, duration }], name, options }:
   * those songs, with nothing to read first, and no playlist unless asked.
   * queue: true (an app with the queue, 4.4): one more batch in the queue
   * even with others of the profile; without it, as before, 409 with one.
   * auto: { complete, finish } (the app's "Auto-accept songs lookup" and
   * "Automate 'Finish All'"), see settle. review: true (an app with the
   * checklist, 4.4.1, "Auto-accept songs lookup" unticked): a list waits for
   * its songs to be chosen (choose) once read.
   */
  function create(profileId, {
    url, kind, options, cookies, items, name, source, queue = false, auto = null, review = false,
  } = {}) {
    if (config.get().downloads === false) throw new DownloadError(501, 'Downloads are turned off on this server (flow-server --downloads turns them on).');
    if (!tools.canDownload()) throw new DownloadError(501, 'This server cannot download songs: it needs yt-dlp and ffmpeg.');
    const key = keyOf(profileId);
    const mine = batchesOf(key);
    if (mine.length && !queue) throw new DownloadError(409, 'There is a download on the server already. Finish or cancel it first.');
    if (mine.length >= QUEUE_MAX) throw new DownloadError(409, `At most ${QUEUE_MAX} downloads can wait on the server for one profile. Finish or cancel one first.`);
    const how = cleanAuto(auto);
    if (items !== undefined) return createPicked(key, profileId, { items, name, options, source: source && source.url ? source : null, auto: how });
    const link = checkLinks(url);
    // Several links are always read as lists (a song among them is one of its songs).
    const many = splitLinks(link).length > 1;
    if (cookies !== undefined && cookies !== null && (typeof cookies !== 'string' || cookies.length > MAX_COOKIES)) {
      throw new DownloadError(400, 'The browser cookies sent along are not usable.');
    }
    const siteCookies = cookies ? cookiesFor(cookies, cookieSites(link)) : '';
    const now = stamp();
    const batch = {
      id: crypto.randomBytes(6).toString('hex'),
      key,
      profileId: profileId || null,
      state: 'queued',
      error: '',
      auto: how,
      review: !!review && !how.complete,
      peek: null,
      single: kind === 'song' && !many,
      source: { url: link, name: '', kind: '' },
      options: cleanOptions(options),
      truncated: false,
      base: 0,
      playlistId: null,
      createdAt: now,
      lastActivity: now,
      items: [],
      cookies: !!siteCookies,
    };
    batches.set(batch.id, batch);
    save(batch);
    if (siteCookies) fs.writeFileSync(cookiesOf(batch), siteCookies, { mode: 0o600 });
    turn();
    // Its name and song count at once, for its line in the queue or, read now,
    // its panel while the whole read (a Spotify list's look-up) goes on.
    startPeek(batch);
    return publicBatch(batch, { legacy: !queue });
  }

  /**
   * The songs ticked in the checklist of a batch in review (4.4.1): { indexes }
   * of its songs to download and of the library's to add to its playlist;
   * the others go. Its songs then download at their turn.
   */
  function choose(profileId, id, { indexes } = {}) {
    const batch = requireBatch(profileId, id);
    if (batch.state !== 'review') throw new DownloadError(409, 'The songs of this download are chosen already.');
    const want = new Set((Array.isArray(indexes) ? indexes : []).map(Number).filter(Number.isInteger));
    const items = batch.items.filter((it) => want.has(it.index) && (it.state === 'queued' || it.state === 'library'));
    if (!items.length) throw new DownloadError(400, 'Pick at least one song to download.');
    for (const it of items) delete it.match;
    batch.items = items;
    batch.state = 'ready';
    batch.lastActivity = Date.now();
    save(batch);
    log(`Download batch "${batch.source.name}": ${items.length} ${items.length === 1 ? 'song' : 'songs'} chosen`);
    pump();
    settle(batch);
    turn();
    return publicBatch(batch);
  }

  /**
   * The uploads picked from a search, as a batch that is ready at once (see
   * create). With `source` ({ url, kind }) they are the songs ticked in a
   * playlist's Update (check): its link stays the batch's, so they go into
   * the playlist, and a song with `existing` (a library song's id) is one of
   * the library's, added to it rather than downloaded.
   */
  function createPicked(key, profileId, {
    items, name, options, source, auto,
  }) {
    if (!Array.isArray(items) || !items.length) throw new DownloadError(400, 'Pick at least one song to download.');
    const max = source ? MAX_ITEMS : MAX_PICKED;
    if (items.length > max) throw new DownloadError(400, `At most ${max} songs can be picked at once.`);
    const link = source ? checkLinks(source.url) : '';
    const songs = new Map(library.data.songs.map((s) => [s.id, s]));
    const picked = items.map((it, i) => {
      const meta = source && it && it.meta && it.meta.title ? it.meta : null;
      // A library song is not downloaded: its link (a Spotify list's may have none) is only kept.
      const existing = source && it && it.existing ? existingInfo(songs.get(String(it.existing))) : null;
      return itemOf({
        title: cleanText(it && it.title, 200) || `Song ${i + 1}`,
        duration: Number(it && it.duration) || 0,
        url: existing ? cleanText(it.url, 2000) : checkLink(it && it.url),
        key: source ? cleanText(it && it.key, 200) : '',
        meta: meta && Object.fromEntries(['artist', 'title', 'mix', 'album', 'genre', 'subGenre'].map((k) => [k, cleanText(meta[k])])),
        existing,
        // Of several links: the one the song was found in (see itemOf).
        listUrl: source && it && typeof it.listUrl === 'string' ? cleanText(it.listUrl, 2000) : undefined,
        status: 'ok',
      }, i);
    });
    const now = stamp();
    const batch = {
      id: crypto.randomBytes(6).toString('hex'),
      key,
      profileId: profileId || null,
      // Its songs are known: ready at its turn (see turn).
      state: 'queued',
      prepared: true,
      error: '',
      auto,
      peek: null,
      single: false,
      source: source
        ? { url: link, name: cleanText(name, 200) || 'Download', kind: cleanText(source.kind, 40) }
        : { url: '', name: cleanText(name, 200) || 'Search', kind: 'search' },
      options: cleanOptions(options),
      truncated: false,
      base: 0,
      playlistId: null,
      createdAt: now,
      lastActivity: now,
      items: picked,
      cookies: false,
    };
    batches.set(batch.id, batch);
    save(batch);
    log(`Download batch "${batch.source.name}": ${picked.length} ${picked.length === 1 ? 'song' : 'songs'} picked ${source ? 'from its link' : 'from a search'}`);
    turn();
    return publicBatch(batch);
  }

  /**
   * A playlist's Update: its link read without a batch, nothing downloaded.
   * { url, cookies } -> { single: true } for a link that is one song now, or
   * { name, source, sourceUrl, truncated, items }, the items as the apps' own
   * listing gives them (existing: the library's song of the same source).
   * The app shows what changed and sends the songs ticked as a batch of their
   * own (create with items and source). The same link checked again for the
   * same profile stops the check before.
   */
  async function check(profileId, { url, cookies } = {}) {
    if (config.get().downloads === false) throw new DownloadError(501, 'Downloads are turned off on this server (flow-server --downloads turns them on).');
    if (!tools.canDownload()) throw new DownloadError(501, 'This server cannot download songs: it needs yt-dlp and ffmpeg.');
    const link = checkLinks(url);
    if (cookies !== undefined && cookies !== null && (typeof cookies !== 'string' || cookies.length > MAX_COOKIES)) {
      throw new DownloadError(400, 'The browser cookies sent along are not usable.');
    }
    const siteCookies = cookies ? cookiesFor(cookies, cookieSites(link)) : '';
    const id = `${keyOf(profileId)}|${link}`;
    const before = checking.get(id);
    if (before) before.cancel();
    let cookieFile = '';
    if (siteCookies) {
      cookieFile = path.join(root, `check-${crypto.randomBytes(6).toString('hex')}.cookies.txt`);
      fs.writeFileSync(cookieFile, siteCookies, { mode: 0o600 });
    }
    const group = groupToken(cookieFile ? ['--cookies', cookieFile] : null);
    checking.set(id, group);
    const knownArtists = [...new Set(library.data.songs.map((s) => s.artist).filter(Boolean))];
    try {
      const result = await lister.list(link, group, () => {}, { knownArtists });
      if (result.single) return { single: true };
      const items = result.items.slice(0, MAX_ITEMS);
      // As the batches do: a song the library has under the same source.
      for (const it of items) {
        if (it.existing || !it.key) continue;
        const same = library.existingFor(null, { sourceKey: it.key, sourceUrl: it.url });
        if (same) it.existing = existingInfo(same);
      }
      return {
        name: cleanText(result.name, 200),
        source: String(result.source || '').toLowerCase(),
        sourceUrl: result.sourceUrl || link,
        truncated: cutAt(result),
        sourceTotal: Number(result.sourceTotal) || 0,
        ...(result.links ? { links: result.links } : {}),
        items,
      };
    } catch (err) {
      if (group.cancelled) throw new DownloadError(409, 'A newer check of this link took the place of this one.');
      throw new DownloadError(502, (err && err.message) || 'The link could not be read.');
    } finally {
      if (checking.get(id) === group) checking.delete(id);
      if (cookieFile) removeQuietly(cookieFile);
    }
  }

  /**
   * Songs for words typed instead of a link ("Linkin Park - Numb"): body
   * { query, page } -> lister.search's answer for that page (0 YouTube's, 1
   * the other sites', 2 and on YouTube's further down; more: true is page
   * 1). Nothing is downloaded: the app sends the one
   * picked as a new batch (create, kind 'song'). One search per profile at a
   * time; a new one stops the one before.
   */
  async function search(profileId, { query, page, more } = {}) {
    if (config.get().downloads === false) throw new DownloadError(501, 'Downloads are turned off on this server (flow-server --downloads turns them on).');
    if (!tools.canDownload()) throw new DownloadError(501, 'This server cannot download songs: it needs yt-dlp and ffmpeg.');
    const text = typeof query === 'string' ? query.replace(/\s+/g, ' ').trim() : '';
    if (!text) throw new DownloadError(400, 'Type the name of a song first.');
    if (text.length > MAX_QUERY) throw new DownloadError(400, 'That is too long for the name of a song.');
    const key = keyOf(profileId);
    const before = searching.get(key);
    if (before) before.cancel();
    const group = groupToken();
    searching.set(key, group);
    const timer = setTimeout(() => {
      group.timedOut = true;
      group.cancel();
    }, SEARCH_TIMEOUT);
    try {
      return await lister.search(text, group, { page, more: !!more });
    } catch (err) {
      if (group.timedOut) throw new DownloadError(504, 'The search took too long.');
      if (group.cancelled) throw new DownloadError(409, 'A newer search took the place of this one.');
      throw new DownloadError(502, `The search failed: ${(err && err.message) || err}`);
    } finally {
      clearTimeout(timer);
      if (searching.get(key) === group) searching.delete(key);
    }
  }

  /** Cancel import: the whole batch, whatever it is doing. id: which of the profile's (none: its oldest). */
  function cancel(profileId, id = null) {
    drop(requireBatch(profileId, id));
  }

  function audioFile(profileId, index, id = null) {
    const batch = requireBatch(profileId, id);
    const item = requireItem(batch, index);
    if (item.state !== 'ready' || !item.file) throw new DownloadError(409, 'That song is not ready yet.');
    return fileOf(batch, item);
  }

  function peaks(profileId, index, id = null) {
    const batch = requireBatch(profileId, id);
    const item = requireItem(batch, index);
    if (item.state !== 'ready') throw new DownloadError(409, 'That song is not ready yet.');
    const found = readJson(peaksOf(batch, item));
    if (!Array.isArray(found)) throw new DownloadError(404, 'The server could not draw this song\'s waveform.');
    return found;
  }

  /** The cover found for a song waiting in the batch: its file, or null. */
  function coverFile(profileId, index, id = null) {
    const batch = requireBatch(profileId, id);
    const item = requireItem(batch, index);
    const file = coverOf(batch, item);
    return item.cover && item.state === 'ready' && fs.existsSync(file) ? { file, version: item.cover } : null;
  }

  function retry(profileId, index, id = null) {
    const batch = requireBatch(profileId, id);
    const item = requireItem(batch, index);
    if (item.state !== 'failed') throw new DownloadError(409, 'Only a song that failed can be tried again.');
    if (!item.url) throw new DownloadError(409, 'This song has no link to try again.');
    item.state = 'queued';
    item.error = '';
    batch.lastActivity = Date.now();
    save(batch);
    pump();
    return publicBatch(batch);
  }

  /** The batch is over once no song is left to deal with. */
  function endIfDone(batch) {
    if (batch.state !== 'ready' || batch.items.some((it) => OPEN.has(it.state))) return false;
    drop(batch, 'done');
    return true;
  }

  /** One song thrown away (it is not wanted). */
  function discard(profileId, index, id = null) {
    const batch = requireBatch(profileId, id);
    const item = requireItem(batch, index);
    if (item.state === 'saving' || item.state === 'saved') throw new DownloadError(409, 'That song is saved already.');
    const token = running.get(`${batch.id}/${item.index}`);
    item.state = 'discarded';
    if (token) token.cancel ? token.cancel() : (token.cancelled = true);
    if (item.file) removeQuietly(fileOf(batch, item));
    removeQuietly(peaksOf(batch, item));
    removeQuietly(coverOf(batch, item));
    item.file = '';
    batch.lastActivity = Date.now();
    save(batch);
    if (endIfDone(batch)) return null;
    // The last song still coming thrown away: the batch may end by itself now.
    settle(batch);
    return isAlive(batch) ? publicBatch(batch) : null;
  }

  /**
   * "Finish this song": cut [start, end] out into the music folder with the
   * names in `meta`, add it to the library and into the playlists, at its
   * place in the source. body: { meta: { artist, title, mix, album, genre, subGenre }, start, end,
   * playlistIds, playlist: { name, mergeInto } | null, existing: [index] }.
   * `playlist` asks for the batch's own playlist (made by the first song
   * finished, then reused); `existing` adds library songs of the list to the
   * same playlists at their places. Resolves { song, batch, playlistId };
   * batch is null once the batch is over.
   */
  async function finish(profileId, index, body = {}, id = null) {
    const batch = requireBatch(profileId, id);
    if (finishing.has(batch.id)) throw new DownloadError(409, 'This download is being finished by itself already.');
    const item = requireItem(batch, index);
    return finishItem(batch, item, body, { endBatch: true });
  }

  /**
   * finish's work for `item` of `batch` (also autoFinish's, which ends the
   * batch itself: endBatch false). body.playlist.byName (autoFinish): into the
   * profile's playlist of that name, if it has one.
   */
  async function finishItem(batch, item, body, { endBatch }) {
    const profileId = batch.profileId || null;
    if (item.state === 'saving' || item.state === 'saved') throw new DownloadError(409, 'That song is being saved already.');
    if (item.state !== 'ready') throw new DownloadError(409, 'That song is not ready yet.');
    const meta = {
      artist: cleanText(body.meta && body.meta.artist),
      title: cleanText(body.meta && body.meta.title),
      mix: cleanText(body.meta && body.meta.mix),
    };
    if (!meta.title) throw new DownloadError(400, 'Please enter a title.');
    // An app from before albums sends neither: the ones found here. Left
    // empty, the album is the title.
    const sent = (key) => (body.meta && body.meta[key] !== undefined ? body.meta[key] : (item.meta || {})[key]);
    meta.album = albumFor(sent('album'), meta.title);
    meta.genre = cleanText(sent('genre'));
    meta.subGenre = cleanText(sent('subGenre'));
    const start = Math.max(0, Number(body.start) || 0);
    const end = Math.min(item.duration || Infinity, Number(body.end) || item.duration || 0);
    if (!(end > start)) throw new DownloadError(400, 'The cut is empty.');

    // Everything up to here happens at once, before anything is awaited: two
    // songs finished at the same moment (two devices) see the same playlist.
    item.state = 'saving';
    if (!batch.base) batch.base = Date.now();
    const at = (i) => batch.base - i * 1000;
    if (body.playlist && !batch.playlistId) {
      batch.playlistId = library.importPlaylist(profileId, {
        name: cleanText(body.playlist.name, 75) || batch.source.name || 'Imported playlist',
        mergeInto: body.playlist.mergeInto ? String(body.playlist.mergeInto) : null,
        byName: !!body.playlist.byName,
        source: batch.single ? null : { url: batch.source.url, kind: batch.source.kind },
      });
    }
    const lists = [...new Set([...(body.playlist ? [batch.playlistId] : []), ...(Array.isArray(body.playlistIds) ? body.playlistIds.map(String) : [])])]
      .filter(Boolean);
    save(batch);

    const src = fileOf(batch, item);
    const ext = path.extname(src).slice(1).toLowerCase();
    const tmp = path.join(library.musicDir, `.flow-download-${crypto.randomBytes(6).toString('hex')}.${ext}`);
    let song;
    try {
      const saved = await media.cutSong({
        cachePath: src, start, end, duration: item.duration, ...meta, sourceUrl: item.sourceUrl || item.url,
      }, tmp);
      const songMeta = {
        ...meta, infoLooked: true, format: ext, duration: saved.duration, sourceUrl: item.sourceUrl || item.url, sourceKey: item.sourceKey || item.key,
        sourcePlaylistUrl: playlistUrlOf(batch, item),
      };
      // Saved meanwhile by another app (an upload of the same source): that one is used.
      const same = library.existingFor(null, { sourceKey: songMeta.sourceKey, sourceUrl: songMeta.sourceUrl });
      if (same) {
        removeQuietly(tmp);
        library.addToPlaylists(profileId, same.id, lists, at(item.index));
        song = same;
      } else {
        song = library.addUploaded(tmp, null, songMeta, lists, profileId, { playlistAt: at(item.index), from: 'download' });
      }
    } catch (err) {
      removeQuietly(tmp);
      if (isAlive(batch)) {
        item.state = 'ready';
        save(batch);
      }
      throw new DownloadError(500, `The song could not be saved: ${(err && err.message) || err}`);
    }
    library.queueLoudness();
    try {
      if (fs.existsSync(coverOf(batch, item))) library.setCover(song.id, fs.readFileSync(coverOf(batch, item)), { onlyIfNone: true }).catch(() => {});
    } catch {
      // The library looks for one itself.
    }
    for (const i of Array.isArray(body.existing) ? body.existing : []) {
      const other = batch.items.find((it) => it.index === Number(i));
      if (!other || other.state !== 'library' || !other.existing) continue;
      library.addToPlaylists(profileId, other.existing.id, lists, at(other.index));
      other.state = 'added';
    }
    log(`Downloaded and saved: ${[song.artist, song.title].filter(Boolean).join(' - ')}`);
    if (!isAlive(batch)) return { song: { id: song.id }, batch: null, playlistId: batch.playlistId || null };
    item.state = 'saved';
    item.songId = song.id;
    item.cover = '';
    removeQuietly(src);
    removeQuietly(peaksOf(batch, item));
    removeQuietly(coverOf(batch, item));
    item.file = '';
    batch.lastActivity = Date.now();
    save(batch);
    const over = endBatch && endIfDone(batch);
    return {
      song: { id: song.id, artist: song.artist, title: song.title, mix: song.mix },
      batch: over ? null : publicBatch(batch),
      playlistId: batch.playlistId || null,
    };
  }

  /** Batches nobody has looked at for downloadKeepDays, gone. */
  function expire(now = Date.now()) {
    const keep = config.get().downloadKeepDays * DAY;
    for (const batch of [...batches.values()]) {
      if (now - batch.lastActivity > keep) drop(batch, 'expired');
    }
  }

  /**
   * Every profile's batches, for the admins: { key (the batch's id, which
   * cancelKey takes), profileId (null: no profile's), state, name, url,
   * createdAt, songs, saved, open, failed }.
   */
  function all() {
    return [...batches.values()].sort((a, b) => a.createdAt - b.createdAt).map((b) => ({
      key: b.id,
      profileId: b.key === keyOf(null) ? null : b.key,
      state: b.state,
      name: (b.source && b.source.name) || (b.peek && b.peek.name) || '',
      url: (b.source && b.source.url) || '',
      createdAt: b.createdAt,
      songs: b.items.length || (b.peek && Number(b.peek.count)) || 0,
      saved: b.items.filter((it) => it.state === 'saved').length,
      open: b.items.filter((it) => OPEN.has(it.state)).length,
      failed: b.items.filter((it) => it.state === 'failed').length,
    }));
  }

  /**
   * An admin's cancel of any profile's batch: by its id (all's key), or a
   * profile's key for all of its batches (as an admin page from before the
   * queue sends it). False: there was none.
   */
  function cancelKey(key) {
    const one = batches.get(key);
    const which = one ? [one] : batchesOf(key);
    if (!which.length) return false;
    for (const b of which) drop(b, 'cancelled by an admin');
    return true;
  }

  /** A profile deleted: its batches go with it. */
  function dropProfile(profileId) {
    for (const b of batchesOf(keyOf(profileId))) drop(b);
    done.delete(keyOf(profileId));
  }

  load();
  expire();
  pump();
  turn();

  return {
    // Turned on (or never turned off) and the tools are there.
    available: () => config.get().downloads !== false && tools.canDownload(),
    get,
    create,
    choose,
    check,
    search,
    cancel,
    audioFile,
    peaks,
    coverFile,
    retry,
    discard,
    finish,
    expire,
    dropProfile,
    all,
    cancelKey,
    /** fn() a moment after something the apps show of the downloads changed (4.6). */
    onChange(fn) {
      changeListeners.push(fn);
    },
    stop() {
      stopped = true;
      clearTimeout(changeTimer);
      for (const group of listing.values()) group.cancel();
      for (const group of peeking.values()) group.cancel();
      for (const group of searching.values()) group.cancel();
      for (const group of checking.values()) group.cancel();
      for (const token of running.values()) token.cancel ? token.cancel() : (token.cancelled = true);
    },
  };
}

module.exports = { createDownloads, DownloadError, checkLink };
