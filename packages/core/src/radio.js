'use strict';

// Internet Radio (5.1): the stations Flow suggests come from radio-browser.info,
// a free directory of about 50,000 stations that anyone may ask (no key). It
// asks apps to name themselves (User-Agent) and to say when a station is
// played (click), which ranks the popular ones higher for everyone.
//
// A station added by hand is checked first (checkStream): a real web address,
// and where the answer tells, a sound stream behind it. Many stations hand
// out a small playlist file (.pls / .m3u) instead of the stream itself: its
// first stream is taken. Plain Node; `fetch` can be given for the tests.

const { agentName } = require('./agent');
const { tr } = require('./lang');

// The directory's servers, tried in this order; the one that answered is kept.
const HOSTS = ['all.api.radio-browser.info', 'de1.api.radio-browser.info', 'de2.api.radio-browser.info'];
// A genre is offered once this many stations name it (the directory's tags
// are free text: the rare ones are mostly places, names and typos).
const MIN_GENRE_STATIONS = 200;
const PAGE = 100;

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function httpUrl(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 2000) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `http://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || !/[a-z0-9]/i.test(u.hostname)) return null;
  return u.href;
}

/** One station as Flow keeps it (a favourite) or shows it; null when it has no stream. */
function cleanStation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const url = httpUrl(raw.url);
  if (!url) return null;
  const id = text(raw.id, 100) || `url:${url}`;
  return {
    id,
    name: text(raw.name, 200) || new URL(url).hostname,
    url,
    favicon: httpUrl(raw.favicon) || '',
    homepage: httpUrl(raw.homepage) || '',
    country: text(raw.country, 100),
    countryCode: /^[A-Z]{2}$/.test(String(raw.countryCode || '')) ? raw.countryCode : '',
    tags: text(raw.tags, 300),
    codec: text(raw.codec, 20),
    bitrate: Math.max(0, Math.min(10000, Math.round(Number(raw.bitrate) || 0))),
    // Added by hand (Add Radio), not from the directory.
    own: raw.own === true,
  };
}

/** A directory entry as a station (cleanStation's shape). */
function fromDirectory(s) {
  return cleanStation({
    id: s.stationuuid,
    name: s.name,
    url: s.url_resolved || s.url,
    favicon: s.favicon,
    homepage: s.homepage,
    country: s.country,
    countryCode: String(s.countrycode || '').toUpperCase(),
    tags: s.tags,
    codec: s.codec,
    bitrate: s.bitrate,
  });
}

function createDirectory({ fetch: get = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let host = null;
  let countries = null;
  let genres = null;

  async function ask(path) {
    const order = host ? [host, ...HOSTS.filter((h) => h !== host)] : HOSTS;
    let last = null;
    for (const h of order) {
      try {
        const res = await get(`https://${h}${path}`, {
          headers: { 'User-Agent': agentName(), Accept: 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        host = h;
        return data;
      } catch (err) {
        last = err;
      }
    }
    const e = new Error(tr('core.radio.directoryUnreachable', 'The radio directory (radio-browser.info) cannot be reached right now.'));
    e.cause = last;
    throw e;
  }

  return {
    /** [{ code, name, stations }], the most stations first. */
    async countries() {
      if (!countries) {
        const list = await ask('/json/countries?order=stationcount&reverse=true&hidebroken=true');
        countries = (Array.isArray(list) ? list : [])
          .map((c) => ({ code: String(c.iso_3166_1 || '').toUpperCase(), name: text(c.name, 100), stations: Number(c.stationcount) || 0 }))
          .filter((c) => /^[A-Z]{2}$/.test(c.code) && c.stations > 0);
      }
      return countries;
    },

    /** [{ name, stations }]: the genres many stations name, the most first. */
    async genres() {
      if (!genres) {
        const list = await ask('/json/tags?order=stationcount&reverse=true&hidebroken=true&limit=400');
        genres = (Array.isArray(list) ? list : [])
          .map((t) => ({ name: text(t.name, 60), stations: Number(t.stationcount) || 0 }))
          .filter((t) => t.name && t.stations >= MIN_GENRE_STATIONS);
      }
      return genres;
    },

    /**
     * Stations matching a name, a country (its code) and a genre, the most
     * played first; `page` from 0. HLS streams are left out: the player
     * cannot play them. { stations, more } (more: another page may follow).
     */
    async search({ name = '', country = '', genre = '', page = 0 } = {}) {
      const q = new URLSearchParams({ order: 'clickcount', reverse: 'true', hidebroken: 'true', limit: String(PAGE), offset: String(Math.max(0, page | 0) * PAGE) });
      if (text(name, 100)) q.set('name', text(name, 100));
      if (/^[A-Z]{2}$/i.test(country)) q.set('countrycode', country.toUpperCase());
      if (text(genre, 60)) {
        q.set('tag', text(genre, 60));
        q.set('tagExact', 'true');
      }
      const list = await ask(`/json/stations/search?${q}`);
      const raw = Array.isArray(list) ? list : [];
      const stations = raw.filter((s) => !Number(s.hls)).map(fromDirectory).filter(Boolean);
      return { stations, more: raw.length >= PAGE };
    },

    /** A directory station is played: counted there (best effort). */
    async click(id) {
      if (!/^[\w-]{8,64}$/.test(String(id || ''))) return;
      try {
        await ask(`/json/url/${encodeURIComponent(id)}`);
      } catch {
        // Only a courtesy to the directory.
      }
    },
  };
}

// ---- checking a station added by hand ----

/** The first stream in a .pls file. */
function parsePls(body) {
  const m = String(body).match(/^\s*File\d+\s*=\s*(\S+)\s*$/im);
  return m ? httpUrl(m[1]) : null;
}

/** The first stream in an .m3u file (not an HLS playlist: see isHls). */
function parseM3u(body) {
  for (const line of String(body).split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const url = httpUrl(s);
    if (url && /^https?:/i.test(s)) return url;
  }
  return null;
}

function isHls(body) {
  return /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/i.test(String(body));
}

const SOUND_TYPES = /^(audio\/|application\/ogg|video\/(ogg|mp2t|mp4|webm)|application\/octet-stream)/i;
const PLS_TYPES = /(scpls|x-pls|\/pls)/i;
const M3U_TYPES = /(mpegurl|x-m3u|\/m3u)/i;

/**
 * Whether `raw` is a radio stream: { url (the stream to play: the address
 * itself, not where it sends to, which may carry a key that runs out), name (the
 * station's own, '' when it sends none), checked (false: the answer did not
 * tell, so it is taken as it is) }. Throws an Error saying why not.
 */
async function checkStream(raw, { fetch: get = globalThis.fetch, timeoutMs = 10000, depth = 0 } = {}) {
  const url = httpUrl(raw);
  if (!url) throw new Error(tr('core.radio.notAnAddress', 'That is not a web address (it should start with http:// or https://).'));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let res;
  try {
    res = await get(url, { headers: { 'User-Agent': agentName(), 'Icy-MetaData': '0' }, redirect: 'follow', signal: abort.signal });
  } catch (err) {
    clearTimeout(timer);
    // A Shoutcast server that answers "ICY 200 OK" instead of HTTP: fetch
    // gives up on it, the player does not. Taken unchecked.
    if (/ICY|parse|invalid.*(status|response)|HPE_/i.test(String((err && err.cause && err.cause.message) || (err && err.message) || ''))) {
      return { url, name: '', checked: false };
    }
    throw new Error(abort.signal.aborted
      ? tr('core.radio.noAnswer', 'The address did not answer in time.')
      : tr('core.radio.unreachable', 'The address cannot be reached.'));
  }
  try {
    if (!res.ok) throw new Error(tr('core.radio.httpError', 'The address answered with an error ({status}).', { status: res.status }));
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
    const name = text(res.headers.get('icy-name') || '', 200);
    const path = new URL(res.url || url).pathname.toLowerCase();
    const playlist = PLS_TYPES.test(type) || M3U_TYPES.test(type) || /\.(pls|m3u8?)$/.test(path);
    if (SOUND_TYPES.test(type) && !playlist) return { url, name, checked: !/octet-stream/i.test(type) };
    if (playlist) {
      if (depth > 1) throw new Error(tr('core.radio.noStream', 'No radio stream was found at that address.'));
      const body = await readSome(res, 64 * 1024);
      if (isHls(body)) throw new Error(tr('core.radio.hls', 'This station streams as HLS (.m3u8), which Flow cannot play.'));
      const inner = PLS_TYPES.test(type) || /\.pls$/.test(path) || /^\s*\[playlist\]/i.test(body) ? parsePls(body) : parseM3u(body);
      if (!inner) throw new Error(tr('core.radio.noStream', 'No radio stream was found at that address.'));
      const found = await checkStream(inner, { fetch: get, timeoutMs, depth: depth + 1 });
      return { ...found, name: found.name || name };
    }
    if (/^text\/html/i.test(type)) throw new Error(tr('core.radio.webPage', 'That is a web page, not a radio stream. The stream\'s own address is needed (often on the station\'s page as "Listen" or a .m3u / .pls link).'));
    if (/^(text\/|application\/(json|xml))/i.test(type)) throw new Error(tr('core.radio.noStream', 'No radio stream was found at that address.'));
    // No type or one unknown: the player may still play it.
    return { url, name, checked: false };
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
}

async function readSome(res, max) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8').slice(0, max);
}

module.exports = {
  createDirectory, checkStream, cleanStation, fromDirectory, httpUrl, parsePls, parseM3u, isHls, MIN_GENRE_STATIONS,
};
