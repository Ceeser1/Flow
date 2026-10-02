'use strict';

// "Download (Server)": the server reads a link, downloads its songs itself
// and keeps them aside until an app has looked at them, so apps without
// yt-dlp (a browser, a phone) can add songs too.
//
// Each profile has at most one batch (no profile: one shared batch). It lives
// in <home>/staging/<profile>/, not in the music folder, so the folder scan
// never sees it: batch.json (written atomically) and the prepared files, each
// with its waveform's peaks beside it. Nothing of it is in the library until
// an app finishes a song: then the trim is cut out straight into the music
// folder, with its names in the tags, and the song added like an upload.
//
//   listing      the link is read in the background (a Spotify list is looked
//                up on YouTube, which takes a while); an app polls.
//   ready        the list is known. Its songs download one after another:
//                queued -> downloading -> converting -> ready (or failed).
//                Songs the library has already are 'library', not downloaded.
//                Finished songs are 'saved', thrown away ones 'discarded'.
//   failed       the link could not be read (batch.error); cancel it.
//
// The playlist (if the app wants one) is made by the first song finished,
// and every song goes in at its place in the source: base - index seconds,
// as the apps do it (importer.finish). A batch nobody opens or finishes
// anything of for downloadKeepDays (30) is thrown away, and so is a deleted
// profile's.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { createMedia, ProcessCancelledError } = require('@flow/core/media');
const { createLister, groupToken, existingInfo } = require('@flow/core/listing');
const { writeJsonAtomic, readJson } = require('@flow/core/jsonFile');
const { MP3_QUALITIES } = require('@flow/core/formats');
const { isPrivateIp } = require('@flow/core/address');

const MAX_ITEMS = 500;
const ITEM_TIMEOUT = 20 * 60 * 1000;
const MIN_FREE_BYTES = 500 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
// Items still to be dealt with: a batch with none of these left is over.
const OPEN = new Set(['queued', 'downloading', 'converting', 'ready', 'saving']);

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
  const lister = createLister({ media, library: () => library.data });

  const batches = new Map();    // profile key -> batch (as batch.json holds it)
  const progress = new Map();   // `${key}/${index}` -> { frac, text } of the song downloading
  const running = new Map();    // `${key}/${index}` -> cancel token
  const listing = new Map();    // profile key -> the listing's cancel group
  let active = 0;
  let stopped = false;

  const dirOf = (key) => path.join(root, key);
  const fileOf = (batch, item) => (item.file ? path.join(dirOf(batch.key), item.file) : null);
  const peaksOf = (batch, item) => path.join(dirOf(batch.key), `i${item.index}.peaks.json`);

  function save(batch) {
    if (batches.get(batch.key) !== batch) return;
    fs.mkdirSync(dirOf(batch.key), { recursive: true });
    writeJsonAtomic(path.join(dirOf(batch.key), 'batch.json'), batch);
  }

  function drop(key, why = 'thrown away') {
    const batch = batches.get(key);
    batches.delete(key);
    const group = listing.get(key);
    if (group) group.cancel();
    listing.delete(key);
    for (const [k, token] of running) {
      if (k.startsWith(`${key}/`)) token.cancel ? token.cancel() : (token.cancelled = true);
    }
    removeQuietly(dirOf(key));
    if (batch) log(`Download batch ${batch.source.name ? `"${batch.source.name}" ` : ''}${why}`);
  }

  /** Whatever a download that was cut off left behind: partial files of items not ready. */
  function cleanPartial(batch, item) {
    for (const f of fs.readdirSync(dirOf(batch.key), { withFileTypes: true })) {
      if (f.isFile() && f.name.startsWith(`i${item.index}_`) && f.name !== item.file) removeQuietly(path.join(dirOf(batch.key), f.name));
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
      const batch = readJson(path.join(root, key, 'batch.json'));
      const ok = batch && batch.key === key && Array.isArray(batch.items) && (key === '_shared' || profileIds.has(key));
      if (!ok) {
        removeQuietly(path.join(root, key));
        continue;
      }
      // A link that was still being read is read again; songs that were
      // downloading start over.
      if (batch.state === 'listing') {
        batches.set(key, batch);
        startListing(batch);
        continue;
      }
      for (const item of batch.items) {
        if (item.state === 'downloading' || item.state === 'converting') item.state = 'queued';
        if (item.state === 'saving') item.state = 'ready';
        if (item.state === 'queued') cleanPartial(batch, item);
      }
      batches.set(key, batch);
      save(batch);
    }
  }

  // ---- reading the link ----

  /** A song of the listing as a batch item. */
  function itemOf(it, i) {
    let state = 'queued';
    let error = '';
    if (it.existing) state = 'library';
    else if (it.status !== 'ok') {
      state = 'failed';
      error = it.note || (it.status === 'notfound' ? 'not found on YouTube' : 'not available');
    }
    return {
      index: i,
      title: String(it.title || `Song ${i + 1}`),
      duration: Number(it.duration) || 0,
      url: String(it.url || ''),
      key: String(it.key || ''),
      meta: it.meta && it.meta.title ? { artist: it.meta.artist || '', title: it.meta.title, mix: it.meta.mix || '' } : null,
      artistFromChannel: false,
      existing: it.existing || null,
      state,
      error,
      file: '',
      summary: '',
    };
  }

  async function startListing(batch) {
    const group = groupToken();
    listing.set(batch.key, group);
    const knownArtists = [...new Set(library.data.songs.map((s) => s.artist).filter(Boolean))];
    const onProgress = (p) => {
      const text = p.text || (p.phase === 'matching' ? `Looking up the songs on YouTube: ${p.done} of ${p.total}` : '');
      progress.set(`${batch.key}/list`, { frac: p.total ? p.done / p.total : null, text });
    };
    try {
      let items;
      let name = batch.source.name;
      let kind = batch.source.kind;
      let truncated = false;
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
          truncated = result.truncated || (result.items.length > MAX_ITEMS ? 'server' : false);
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
      if (batches.get(batch.key) !== batch) return;
      Object.assign(batch, { state: 'ready', items, truncated, error: '' });
      batch.source.name = cleanText(name, 200) || 'Download';
      batch.source.kind = kind;
      log(`Download batch "${batch.source.name}": ${items.length} ${items.length === 1 ? 'song' : 'songs'}`);
    } catch (err) {
      if (batches.get(batch.key) !== batch || group.cancelled) return;
      batch.state = 'failed';
      batch.error = (err && err.message) || 'The link could not be read.';
    } finally {
      if (listing.get(batch.key) === group) listing.delete(batch.key);
      progress.delete(`${batch.key}/list`);
    }
    batch.lastActivity = Date.now();
    save(batch);
    pump();
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
      if (!next) return;
      active += 1;
      next.item.state = 'downloading';
      runItem(next.batch, next.item).finally(() => {
        active -= 1;
        pump();
      });
    }
  }

  async function runItem(batch, item) {
    const id = `${batch.key}/${item.index}`;
    const token = { cancelled: false };
    running.set(id, token);
    progress.set(id, { frac: null, text: 'Reading...' });
    const timer = setTimeout(() => {
      token.timedOut = true;
      if (token.cancel) token.cancel();
      else token.cancelled = true;
    }, ITEM_TIMEOUT);
    const alive = () => batches.get(batch.key) === batch && item.state !== 'discarded';
    try {
      const dir = dirOf(batch.key);
      fs.mkdirSync(dir, { recursive: true });
      if (freeBytes(dir) < MIN_FREE_BYTES) throw new Error('The server is running out of disk space.');
      let probed = item.probed;
      if (!probed) {
        probed = await media.probe(item.url, token, { knownArtists: [] });
        item.probed = probed;
      }
      const same = library.existingFor(null, { sourceKey: probed.key, sourceUrl: probed.url });
      if (same) {
        item.state = 'library';
        item.existing = existingInfo(same);
        return;
      }
      const stemKey = `i${item.index}_${probed.key || 'song'}`;
      const file = await media.download({ ...probed, key: stemKey }, batch.options, (stage, frac, text) => {
        if (stage === 'prepare' && item.state === 'downloading') item.state = 'converting';
        progress.set(id, { frac, text });
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

  function publicBatch(batch) {
    if (!batch) return null;
    const list = progress.get(`${batch.key}/list`);
    return {
      id: batch.id,
      state: batch.state,
      error: batch.error || '',
      source: batch.source,
      single: !!batch.single,
      truncated: batch.truncated || false,
      options: batch.options,
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
        summary: it.summary || '',
        progress: progress.get(`${batch.key}/${it.index}`) || null,
      })),
    };
  }

  function get(profileId) {
    const batch = batches.get(keyOf(profileId)) || null;
    // Looked at by its owner: kept for another downloadKeepDays (written at
    // most once an hour, not at every poll).
    if (batch && Date.now() - batch.lastActivity > 60 * 60 * 1000) {
      batch.lastActivity = Date.now();
      save(batch);
    }
    return publicBatch(batch);
  }

  function requireBatch(profileId) {
    const batch = batches.get(keyOf(profileId));
    if (!batch) throw new DownloadError(404, 'There is no download on the server for this profile.');
    return batch;
  }

  function requireItem(batch, index) {
    const item = batch.items.find((it) => it.index === Number(index));
    if (!item) throw new DownloadError(404, 'That song is not in the download.');
    return item;
  }

  /**
   * A new batch for `url`: { url, kind: 'song' | 'list', options }. kind
   * 'song' reads only the one song even from a link into a playlist.
   */
  function create(profileId, { url, kind, options } = {}) {
    if (config.get().downloads === false) throw new DownloadError(501, 'Downloads are turned off on this server (flow-server --downloads turns them on).');
    if (!tools.canDownload()) throw new DownloadError(501, 'This server cannot download songs: it needs yt-dlp and ffmpeg.');
    const key = keyOf(profileId);
    if (batches.has(key)) throw new DownloadError(409, 'There is a download on the server already. Finish or cancel it first.');
    const link = checkLink(url);
    const now = Date.now();
    const batch = {
      id: crypto.randomBytes(6).toString('hex'),
      key,
      profileId: profileId || null,
      state: 'listing',
      error: '',
      single: kind === 'song',
      source: { url: link, name: '', kind: '' },
      options: cleanOptions(options),
      truncated: false,
      base: 0,
      playlistId: null,
      createdAt: now,
      lastActivity: now,
      items: [],
    };
    batches.set(key, batch);
    save(batch);
    startListing(batch);
    return publicBatch(batch);
  }

  /** Cancel import: the whole batch, whatever it is doing. */
  function cancel(profileId) {
    requireBatch(profileId);
    drop(keyOf(profileId));
  }

  function audioFile(profileId, index) {
    const batch = requireBatch(profileId);
    const item = requireItem(batch, index);
    if (item.state !== 'ready' || !item.file) throw new DownloadError(409, 'That song is not ready yet.');
    return fileOf(batch, item);
  }

  function peaks(profileId, index) {
    const batch = requireBatch(profileId);
    const item = requireItem(batch, index);
    if (item.state !== 'ready') throw new DownloadError(409, 'That song is not ready yet.');
    const found = readJson(peaksOf(batch, item));
    if (!Array.isArray(found)) throw new DownloadError(404, 'The server could not draw this song\'s waveform.');
    return found;
  }

  function retry(profileId, index) {
    const batch = requireBatch(profileId);
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
    drop(batch.key, 'done');
    return true;
  }

  /** One song thrown away (it is not wanted). */
  function discard(profileId, index) {
    const batch = requireBatch(profileId);
    const item = requireItem(batch, index);
    if (item.state === 'saving' || item.state === 'saved') throw new DownloadError(409, 'That song is saved already.');
    const token = running.get(`${batch.key}/${item.index}`);
    item.state = 'discarded';
    if (token) token.cancel ? token.cancel() : (token.cancelled = true);
    if (item.file) removeQuietly(fileOf(batch, item));
    removeQuietly(peaksOf(batch, item));
    item.file = '';
    batch.lastActivity = Date.now();
    save(batch);
    if (endIfDone(batch)) return null;
    return publicBatch(batch);
  }

  /**
   * "Finish this song": cut [start, end] out into the music folder with the
   * names in `meta`, add it to the library and into the playlists, at its
   * place in the source. body: { meta: { artist, title, mix }, start, end,
   * playlistIds, playlist: { name, mergeInto } | null, existing: [index] }.
   * `playlist` asks for the batch's own playlist (made by the first song
   * finished, then reused); `existing` adds library songs of the list to the
   * same playlists at their places. Resolves { song, batch }; batch is null
   * once the batch is over.
   */
  async function finish(profileId, index, body = {}) {
    const batch = requireBatch(profileId);
    const item = requireItem(batch, index);
    if (item.state === 'saving' || item.state === 'saved') throw new DownloadError(409, 'That song is being saved already.');
    if (item.state !== 'ready') throw new DownloadError(409, 'That song is not ready yet.');
    const meta = {
      artist: cleanText(body.meta && body.meta.artist),
      title: cleanText(body.meta && body.meta.title),
      mix: cleanText(body.meta && body.meta.mix),
    };
    if (!meta.title) throw new DownloadError(400, 'Please enter a title.');
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
        ...meta, format: ext, duration: saved.duration, sourceUrl: item.sourceUrl || item.url, sourceKey: item.sourceKey || item.key,
        sourcePlaylistUrl: batch.single ? '' : batch.source.url,
      };
      // Saved meanwhile by another app (an upload of the same source): that one is used.
      const same = library.existingFor(null, { sourceKey: songMeta.sourceKey, sourceUrl: songMeta.sourceUrl });
      if (same) {
        removeQuietly(tmp);
        library.addToPlaylists(profileId, same.id, lists, at(item.index));
        song = same;
      } else {
        song = library.addUploaded(tmp, null, songMeta, lists, profileId, { playlistAt: at(item.index) });
      }
    } catch (err) {
      removeQuietly(tmp);
      if (batches.get(batch.key) === batch) {
        item.state = 'ready';
        save(batch);
      }
      throw new DownloadError(500, `The song could not be saved: ${(err && err.message) || err}`);
    }
    library.queueLoudness();
    for (const i of Array.isArray(body.existing) ? body.existing : []) {
      const other = batch.items.find((it) => it.index === Number(i));
      if (!other || other.state !== 'library' || !other.existing) continue;
      library.addToPlaylists(profileId, other.existing.id, lists, at(other.index));
      other.state = 'added';
    }
    log(`Downloaded and saved: ${[song.artist, song.title].filter(Boolean).join(' - ')}`);
    if (batches.get(batch.key) !== batch) return { song: { id: song.id }, batch: null };
    item.state = 'saved';
    removeQuietly(src);
    removeQuietly(peaksOf(batch, item));
    item.file = '';
    batch.lastActivity = Date.now();
    save(batch);
    const over = endIfDone(batch);
    return { song: { id: song.id, artist: song.artist, title: song.title, mix: song.mix }, batch: over ? null : publicBatch(batch) };
  }

  /** Batches nobody has looked at for downloadKeepDays, gone. */
  function expire(now = Date.now()) {
    const keep = config.get().downloadKeepDays * DAY;
    for (const [key, batch] of [...batches]) {
      if (now - batch.lastActivity > keep) drop(key, 'expired');
    }
  }

  /** A profile deleted: its batch goes with it. */
  function dropProfile(profileId) {
    if (batches.has(keyOf(profileId))) drop(keyOf(profileId));
  }

  load();
  expire();
  pump();

  return {
    // Turned on (or never turned off) and the tools are there.
    available: () => config.get().downloads !== false && tools.canDownload(),
    get,
    create,
    cancel,
    audioFile,
    peaks,
    retry,
    discard,
    finish,
    expire,
    dropProfile,
    stop() {
      stopped = true;
      for (const group of listing.values()) group.cancel();
      for (const token of running.values()) token.cancel ? token.cancel() : (token.cancelled = true);
    },
  };
}

module.exports = { createDownloads, DownloadError, checkLink };
