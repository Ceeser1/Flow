'use strict';

// The shared media tools (media.js, listing.js): plain Node, so the Flow
// Server can use them. The ffmpeg part runs with the desktop app's bundled
// tools when they are there (or ffmpeg on the PATH), and is skipped otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createMedia, parseProgress, ytDlpError } = require('../src/media');
const { createLister, groupToken } = require('../src/listing');

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = path.join(__dirname, '..', '..', '..', 'apps', 'desktop', 'tools', exe);
  if (fs.existsSync(bundled)) return bundled;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, exe))) return path.join(dir, exe);
  }
  return null;
}

const ffmpeg = findTool('ffmpeg');
const ffprobe = findTool('ffprobe');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-media-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('yt-dlp progress lines and errors are read', () => {
  const p = parseProgress('FLOW_DL\t524288\t1048576\t262144\t2');
  assert.equal(p.frac, 0.5);
  assert.match(p.text, /50\.0%/);
  assert.equal(parseProgress('[download] something else'), null);
  assert.equal(ytDlpError(['ERROR: [youtube] x: Private video']), 'This video is private.');
});

test('a missing tool says so, in the words the app chose', async () => {
  const media = createMedia({ ffmpeg: () => null, ffprobe: () => null, ytdlp: () => null, cacheDir: () => scratch, missing: (n) => `no ${n} here` });
  await assert.rejects(media.probe('https://example.com/x', {}), /no yt-dlp here/);
  await assert.rejects(media.probeAudio(path.join(scratch, 'x.mp3')), /no ffprobe here/);
});

test('the lister needs nothing but media and a library', () => {
  const lister = createLister({ media: {}, library: () => ({ songs: [], playlists: [] }) });
  assert.equal(typeof lister.list, 'function');
  assert.equal(typeof groupToken().sub, 'function');
});

/**
 * A lister over a stand-in yt-dlp and stand-in Bandcamp and Archive searches.
 * sites: { youtube: [results], soundcloud: [results], bandcamp: [hits],
 * archive: [docs] }; reads: url -> info, or an Error (DRM). Resolves what
 * fn(lister, asked) gives; asked lists every search and read made.
 */
async function withSites(sites, reads, fn) {
  const asked = [];
  const media = {
    async readJson(args) {
      const what = args[args.length - 1];
      if (/music\.youtube\.com/.test(what)) {
        asked.push('youtube music');
        return { entries: [] };
      }
      if (/^ytsearch/.test(what)) {
        asked.push('youtube');
        return { entries: sites.youtube || [] };
      }
      if (/^scsearch/.test(what)) {
        asked.push('soundcloud');
        return { entries: sites.soundcloud || [] };
      }
      asked.push(`read ${what}`);
      const info = reads[what];
      if (!info || info instanceof Error) throw info || new Error('Could not read this link.');
      return info;
    },
  };
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const bandcamp = /bandcamp\.com/.test(url);
    asked.push(bandcamp ? 'bandcamp' : 'archive');
    const body = bandcamp ? { auto: { results: sites.bandcamp || [] } } : { response: { docs: sites.archive || [] } };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    return await fn(createLister({ media, library: () => ({ songs: [], playlists: [] }) }), asked);
  } finally {
    globalThis.fetch = real;
  }
}

const SONG = { title: 'Hear Me Now', artists: 'Hollywood Undead', duration: 214 };

test('a song YouTube has is taken from YouTube, and nothing else is searched', async () => {
  await withSites({ youtube: [{ id: 'yt1', title: 'Hear Me Now', channel: 'Hollywood Undead - Topic', duration: 214 }] }, {},
    async (lister, asked) => {
      const pick = await lister.findSong(SONG, groupToken());
      assert.equal(pick.site, 'YouTube');
      assert.equal(pick.quality, 'good');
      assert.equal(pick.cand.url, 'https://www.youtube.com/watch?v=yt1');
      assert.equal(pick.cand.key, 'youtube:yt1');
      assert.deepEqual(asked, ['youtube music', 'youtube']);
    });
});

test('not on YouTube: SoundCloud next, past an upload that cannot be downloaded', async () => {
  const sc = (id, channel) => ({ id, title: 'Hear Me Now', uploader: channel, duration: 214.3, webpage_url: `https://soundcloud.com/${channel}/${id}` });
  await withSites({ soundcloud: [sc('1', 'hollywoodundead'), sc('2', 'someone')] }, {
    'https://soundcloud.com/hollywoodundead/1': new Error('This video is DRM protected'),
    'https://soundcloud.com/someone/2': { id: '2', extractor_key: 'Soundcloud', title: 'Hear Me Now', duration: 214.3, webpage_url: 'https://soundcloud.com/someone/2' },
  }, async (lister, asked) => {
    const pick = await lister.findSong(SONG, groupToken());
    assert.equal(pick.site, 'SoundCloud');
    assert.equal(pick.quality, 'good');
    assert.equal(pick.cand.url, 'https://soundcloud.com/someone/2');
    assert.equal(pick.cand.key, 'soundcloud:2');
    // Found there: Bandcamp and the Archive are not asked.
    assert.ok(!asked.includes('bandcamp') && !asked.includes('archive'));
  });
});

test('then Bandcamp, then the Internet Archive, whose album uploads do not count', async () => {
  const bandcampHit = { type: 't', id: 47, name: 'Hear Me Now', band_name: 'Hollywood Undead', item_url_path: 'https://hu.bandcamp.com/track/hear-me-now' };
  // A Bandcamp song too long is passed on to the Archive.
  await withSites({
    bandcamp: [bandcampHit],
    archive: [{ identifier: 'hu-demos', title: 'Hear Me Now', creator: 'Hollywood Undead' }, { identifier: 'hear-me-now_2025', title: 'Hear Me Now', creator: 'Hollywood Undead' }],
  }, {
    'https://hu.bandcamp.com/track/hear-me-now': { id: '47', extractor_key: 'Bandcamp', title: 'Hear Me Now', duration: 260 },
    'https://archive.org/details/hu-demos': { _type: 'playlist', entries: [] },
    'https://archive.org/details/hear-me-now_2025': { id: 'hear-me-now_2025', extractor_key: 'ArchiveOrg', title: 'Hear Me Now', duration: 214.3, webpage_url: 'https://archive.org/details/hear-me-now_2025' },
  }, async (lister, asked) => {
    const pick = await lister.findSong(SONG, groupToken());
    assert.equal(pick.site, 'Internet Archive');
    assert.equal(pick.cand.key, 'archiveorg:hear-me-now_2025');
    assert.equal(pick.cand.channel, 'Hollywood Undead');
    assert.deepEqual(asked.filter((a) => !a.startsWith('read')), ['youtube music', 'youtube', 'soundcloud', 'bandcamp', 'archive']);
  });
  // The same Bandcamp song at the right length is taken there.
  await withSites({ bandcamp: [bandcampHit] }, {
    'https://hu.bandcamp.com/track/hear-me-now': { id: '47', extractor_key: 'Bandcamp', title: 'Hear Me Now', duration: 214 },
  }, async (lister, asked) => {
    const pick = await lister.findSong(SONG, groupToken());
    assert.equal(pick.site, 'Bandcamp');
    assert.equal(pick.cand.key, 'bandcamp:47');
    assert.ok(!asked.includes('archive'));
  });
});

test('a shaky YouTube upload stays unless another site has a good one; nowhere at all is not found', async () => {
  const shaky = [{ id: 'yt2', title: 'Hear Me Now', channel: 'Someone', duration: 226 }];
  await withSites({ youtube: shaky }, {}, async (lister) => {
    const pick = await lister.findSong(SONG, groupToken());
    assert.equal(pick.site, 'YouTube');
    assert.equal(pick.quality, 'shaky');
  });
  await withSites({}, {}, async (lister) => {
    const pick = await lister.findSong(SONG, groupToken());
    assert.equal(pick.quality, 'none');
    assert.equal(pick.cand, null);
  });
});

test('prepare, cut with tags, and peaks, with real ffmpeg', { skip: !(ffmpeg && ffprobe) && 'no ffmpeg' }, async () => {
  const media = createMedia({ ffmpeg: () => ffmpeg, ffprobe: () => ffprobe, ytdlp: () => null, cacheDir: () => scratch });
  const wav = path.join(scratch, 'tone.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', wav]);

  const { media: prepared } = await media.prepareLocal(wav, { alwaysMp3: true, quality: 128 }, null, {});
  assert.equal(prepared.ext, 'mp3');
  assert.ok(Math.abs(prepared.duration - 5) < 0.2);

  const dest = path.join(scratch, 'Daft Punk - Tone.mp3');
  const saved = await media.cutSong({
    cachePath: prepared.path, start: 1, end: 3, duration: prepared.duration, artist: 'Daft Punk', title: 'Tone', mix: '', sourceUrl: '',
  }, dest);
  assert.ok(Math.abs(saved.duration - 2) < 0.2, `cut to 2 s, got ${saved.duration}`);
  const info = await media.probeAudio(dest);
  assert.equal(info.tags.artist, 'Daft Punk');

  const peaks = await media.peaksFor(dest, saved.duration);
  assert.ok(peaks.length > 100 && peaks.length % 2 === 0);
  // lavfi's sine is at 1/8 of full scale.
  assert.ok(Math.max(...peaks) > 0.1 && Math.max(...peaks) < 0.2, 'the tone is there, at its level');
});

// A yt-dlp that turns down browser cookies the way YouTube does when the
// browser's signed-in session has gone stale, and logs each run's arguments.
const STALE_YTDLP = String.raw`
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FLOW_TEST_RUNS, JSON.stringify(args) + '\n');
const url = args[args.length - 1];
if (url.includes('gone')) { process.stderr.write('ERROR: [youtube] x: Video unavailable\n'); process.exit(1); }
if (args.includes('--cookies-from-browser')) { process.stderr.write('ERROR: [youtube] x: The page needs to be reloaded.\n'); process.exit(1); }
if (args.includes('-j')) {
  process.stdout.write(JSON.stringify({ id: 'x', title: 'Daft Punk - One More Time', duration: 5, extractor_key: 'Youtube', webpage_url: url }) + '\n');
} else {
  fs.copyFileSync(process.env.FLOW_TEST_WAV, args[args.indexOf('-o') + 1].replace('%(ext)s', 'wav'));
}
`;

test('a stale browser session: the run is made again without the cookies', { skip: !(ffmpeg && ffprobe) && 'no ffmpeg' }, async () => {
  const fake = path.join(scratch, 'stale-yt-dlp.js');
  fs.writeFileSync(fake, STALE_YTDLP);
  process.env.FLOW_TEST_RUNS = path.join(scratch, 'runs.txt');
  process.env.FLOW_TEST_WAV = path.join(scratch, 'stale.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', process.env.FLOW_TEST_WAV]);
  const runs = () => fs.readFileSync(process.env.FLOW_TEST_RUNS, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const withCookies = (args) => args.includes('--cookies-from-browser');
  const media = createMedia({
    ffmpeg: () => ffmpeg, ffprobe: () => ffprobe, ytdlp: () => fake, cacheDir: () => scratch,
    ytdlpArgs: () => ['--cookies-from-browser', 'firefox'],
  });
  try {
    fs.writeFileSync(process.env.FLOW_TEST_RUNS, '');
    const probed = await media.probe('https://www.youtube.com/watch?v=x');
    assert.equal(probed.title, 'Daft Punk - One More Time');
    const got = await media.download(probed, {}, null);
    assert.ok(fs.existsSync(got.path));
    assert.deepEqual(runs().map(withCookies), [true, false, true, false], 'probe and download each tried with, then without');

    // Any other failure is not tried again.
    fs.writeFileSync(process.env.FLOW_TEST_RUNS, '');
    await assert.rejects(media.probe('https://www.youtube.com/watch?v=gone'), /not available/);
    assert.equal(runs().length, 1);
  } finally {
    delete process.env.FLOW_TEST_RUNS;
    delete process.env.FLOW_TEST_WAV;
  }
});
