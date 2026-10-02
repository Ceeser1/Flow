'use strict';

// A stand-in for yt-dlp in the download tests (FLOW_SERVER_YTDLP points
// here). It answers for made-up links on fake.test only:
//
//   https://fake.test/list/<n>[?slow=<i>][&fail=<j>]
//                                          a playlist of n songs, v1 ... vn
//                                          (song i downloads forever, song j fails)
//   https://fake.test/v/<id>               one song
//   https://fake.test/slow/<id>            one song whose download never ends
//   https://fake.test/fail/<id>            a song that is not available
//
// A download copies FAKE_YTDLP_AUDIO (a real WAV) to where -o says. Every
// download writes its process id to FAKE_YTDLP_PIDS, one per line, so a test
// can check it was stopped.

const fs = require('fs');

const args = process.argv.slice(2);
const url = new URL(args[args.length - 1]);
const parts = url.pathname.split('/').filter(Boolean);

function video(id, kind = 'v') {
  return {
    id,
    title: `Daft Punk - Song ${id}`,
    duration: 3,
    channel: 'Daft Punk',
    extractor_key: 'Youtube',
    webpage_url: `https://fake.test/${kind}/${id}`,
  };
}

if (parts[0] === 'fail') {
  process.stderr.write('ERROR: [youtube] x: Video unavailable\n');
  process.exit(1);
}

if (args.includes('-J') || args.includes('-j')) {
  if (parts[0] === 'list' && !args.includes('--no-playlist')) {
    const n = Number(parts[1]) || 1;
    const slow = Number(url.searchParams.get('slow')) || 0;
    const fail = Number(url.searchParams.get('fail')) || 0;
    const entries = Array.from({ length: n }, (_, k) => {
      const v = video(`v${k + 1}`, k + 1 === slow ? 'slow' : (k + 1 === fail ? 'fail' : 'v'));
      return { ...v, url: v.webpage_url, ie_key: 'Youtube' };
    });
    process.stdout.write(JSON.stringify({ _type: 'playlist', title: 'Fake List', extractor_key: 'YoutubeTab', webpage_url: url.href, entries }) + '\n');
  } else {
    process.stdout.write(JSON.stringify(video(parts[1] || 'x', parts[0])) + '\n');
  }
  process.exit(0);
}

// A download.
if (process.env.FAKE_YTDLP_PIDS) fs.appendFileSync(process.env.FAKE_YTDLP_PIDS, `${process.pid}\n`);
const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'wav');
const line = (got) => process.stdout.write(`FLOW_DL\t${got}\t1000\t500\t1\n`);
if (parts[0] === 'slow') {
  fs.writeFileSync(`${out}.part`, 'partial');
  line(100);
  setInterval(() => line(200), 200);
} else {
  line(500);
  fs.copyFileSync(process.env.FAKE_YTDLP_AUDIO, out);
  line(1000);
}
