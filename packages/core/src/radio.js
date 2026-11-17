'use strict';

// Internet Radio (5.1): the stations Flow suggests come from radio-browser.info,
// a free directory of about 50,000 stations that anyone may ask (no key). It
// asks apps to name themselves (User-Agent) and to say when a station is
// played (click), which ranks the popular ones higher for everyone.
//
// The whole directory is fetched (about 60 MB, LIST_PAGE stations a request)
// and kept as a copy (`copy`: { read, write }, the app's; a gzip file of about
// 4 MB on the desktop), fetched again behind
// it once a day old. The search, the filters and how many stations each
// picker's entries have under the other filters are all worked out here from
// it, so the pickers only offer what is there.
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
// The Quality filter's steps: at least this many kbit/s (a station whose bitrate is not known is left out then),
// and RADIO_NO_INFO: only the stations whose bitrate is not known.
const RADIO_NO_INFO = -1;
const RADIO_QUALITIES = [320, 256, 192, 128, 64, RADIO_NO_INFO];
// The whole list: this many stations a request, this many requests at once, at most this many requests.
const LIST_PAGE = 10000;
const LIST_AT_ONCE = 3;
const MAX_LIST_PAGES = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Unused this long, the list is let go of in memory (read from its copy again when wanted).
const IDLE_MS = 15 * 60 * 1000;

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
// Names compared without case and accents.
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
/** Whether a station has a quality: at least q kbit/s, or (RADIO_NO_INFO) none known. */
const atQuality = (st, q) => (q === RADIO_NO_INFO ? !st.bitrate : st.bitrate >= q);

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

function createDirectory({ fetch: get = globalThis.fetch, timeoutMs = 10000, pageTimeoutMs = 60000, copy = null, maxAgeMs = DAY_MS, idleMs = IDLE_MS, minGenre = MIN_GENRE_STATIONS } = {}) {
  let host = null;
  // The whole list as loaded: { at, entries, genres }, or null until it is asked for (and after a while unused).
  let all = null;
  let loading = null;
  let refreshing = null;
  let idleTimer = null;

  async function ask(path, ms = timeoutMs) {
    const order = host ? [host, ...HOSTS.filter((h) => h !== host)] : HOSTS;
    let last = null;
    for (const h of order) {
      try {
        const res = await get(`https://${h}${path}`, {
          headers: { 'User-Agent': agentName(), Accept: 'application/json' },
          signal: AbortSignal.timeout(ms),
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

  /** Every station of the directory, LIST_PAGE at a time (a few at once), HLS left out. */
  async function download() {
    const stations = [];
    const seen = new Set();
    for (let first = 0; ; first += LIST_AT_ONCE) {
      const pages = await Promise.all(Array.from({ length: LIST_AT_ONCE }, (_, i) => {
        const q = new URLSearchParams({ order: 'name', hidebroken: 'true', limit: String(LIST_PAGE), offset: String((first + i) * LIST_PAGE) });
        return ask(`/json/stations/search?${q}`, pageTimeoutMs);
      }));
      let short = false;
      for (const raw of pages) {
        const list = Array.isArray(raw) ? raw : [];
        if (list.length < LIST_PAGE) short = true;
        for (const s of list) {
          if (Number(s.hls) || seen.has(s.stationuuid)) continue;
          const st = fromDirectory(s);
          if (!st) continue;
          seen.add(st.id);
          stations.push({ ...st, clicks: Math.max(0, Number(s.clickcount) || 0) });
        }
      }
      if (short || first + LIST_AT_ONCE >= MAX_LIST_PAGES) break;
    }
    return { at: Date.now(), stations };
  }

  /** The kept copy ({ at, stations }), or null. */
  function readCache() {
    if (!copy) return null;
    try {
      const data = copy.read();
      return data && Array.isArray(data.stations) && Number(data.at) ? data : null;
    } catch {
      return null;
    }
  }

  function writeCache(data) {
    if (!copy) return;
    try {
      copy.write(data);
    } catch {
      // Only a copy: downloaded again next time.
    }
  }

  /** The list made ready for filtering: each station's name and genres folded once, the most played first. */
  function prepare({ at, stations }) {
    const entries = [];
    const tagCount = new Map();
    for (const raw of stations) {
      const st = cleanStation(raw);
      if (!st || st.own) continue;
      const tags = [...new Set(st.tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
      for (const t of tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
      entries.push({ st, clicks: Math.max(0, Number(raw.clicks) || 0), name: fold(st.name), tags });
    }
    entries.sort((a, b) => b.clicks - a.clicks || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const genres = new Set([...tagCount].filter(([, n]) => n >= minGenre).map(([t]) => t));
    return { at: Number(at) || 0, entries, genres };
  }

  /** A new copy from the directory, kept; the one in use stays until it is here. */
  function refresh() {
    if (!refreshing) {
      refreshing = download()
        .then((data) => {
          writeCache(data);
          all = prepare(data);
          return all;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  }

  /** The whole list: the kept copy (a new one fetched behind it once a day old), else downloaded. */
  async function list() {
    clearTimeout(idleTimer);
    // Not used for a while: let go of (the copy on disk is quick to read again).
    idleTimer = setTimeout(() => {
      if (!refreshing) all = null;
    }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
    if (!all && !loading) {
      loading = (async () => {
        const kept = readCache();
        if (kept) {
          all = prepare(kept);
          return all;
        }
        return refresh();
      })().finally(() => {
        loading = null;
      });
    }
    if (loading) await loading;
    if (Date.now() - all.at > maxAgeMs) refresh().catch(() => {});
    return all;
  }

  /** Whether an entry passes the filters, all but `skip` ('country', 'genre' or 'quality': its own count). */
  function passes(e, f, skip) {
    if (f.name && !e.name.includes(f.name)) return false;
    if (skip !== 'country' && f.country && e.st.countryCode !== f.country) return false;
    if (skip !== 'genre' && f.genre && !e.tags.includes(f.genre)) return false;
    if (skip !== 'quality' && f.quality && !atQuality(e.st, f.quality)) return false;
    return true;
  }

  /** What each picker offers under the other filters (and the name searched): { countries, genres, qualities }. */
  function facets(data, f) {
    const countries = new Map();
    const genres = new Map();
    const qualities = Object.fromEntries(RADIO_QUALITIES.map((q) => [q, 0]));
    for (const e of data.entries) {
      if (f.name && !e.name.includes(f.name)) continue;
      if (e.st.countryCode && passes(e, f, 'country')) {
        let c = countries.get(e.st.countryCode);
        if (!c) {
          c = { code: e.st.countryCode, names: new Map(), stations: 0 };
          countries.set(c.code, c);
        }
        c.stations += 1;
        if (e.st.country) c.names.set(e.st.country, (c.names.get(e.st.country) || 0) + 1);
      }
      if (passes(e, f, 'genre')) {
        for (const t of e.tags) if (data.genres.has(t)) genres.set(t, (genres.get(t) || 0) + 1);
      }
      if (passes(e, f, 'quality')) {
        for (const q of RADIO_QUALITIES) if (atQuality(e.st, q)) qualities[q] += 1;
      }
    }
    const mostNamed = (names) => [...names].sort((a, b) => b[1] - a[1]).map(([n]) => n)[0] || '';
    return {
      countries: [...countries.values()]
        .map((c) => ({ code: c.code, name: mostNamed(c.names) || c.code, stations: c.stations }))
        .sort((a, b) => b.stations - a.stations),
      genres: [...genres].map(([name, stations]) => ({ name, stations })).sort((a, b) => b.stations - a.stations),
      qualities,
    };
  }

  return {
    /**
     * Stations matching a name (part of it), a country (its code), a genre and
     * a lowest bitrate (`quality`, kbit/s; 0 any, RADIO_NO_INFO only those
     * without one), the most played first; `page` from 0. Worked out here from
     * the whole directory (HLS streams left out: the player cannot play them).
     * { stations, more, total, facets }: facets = what each picker offers under
     * the other filters, with how many stations.
     */
    async search({ name = '', country = '', genre = '', quality = 0, page = 0 } = {}) {
      const data = await list();
      const f = {
        name: fold(text(name, 100)),
        country: /^[A-Z]{2}$/i.test(country) ? country.toUpperCase() : '',
        genre: text(genre, 60).toLowerCase(),
        quality: RADIO_QUALITIES.includes(Number(quality)) ? Number(quality) : 0,
      };
      const found = data.entries.filter((e) => passes(e, f, null));
      const from = Math.max(0, page | 0) * PAGE;
      return {
        stations: found.slice(from, from + PAGE).map((e) => ({ ...e.st })),
        more: found.length > from + PAGE,
        total: found.length,
        facets: facets(data, f),
      };
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
  createDirectory, checkStream, cleanStation, fromDirectory, httpUrl, parsePls, parseM3u, isHls, MIN_GENRE_STATIONS, RADIO_QUALITIES, RADIO_NO_INFO,
};
