'use strict';

// Opening local files and folders on Add Songs: which files a folder is
// looked through for, and that Cancel import stops the whole task.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-local-'));
process.env.FLOW_HOME = path.join(scratch, 'home');
process.env.FLOW_MUSIC = path.join(scratch, 'music');

const { scanFolder } = require('../src/localScan');
const importer = require('../src/importer');
const library = require('../src/library');
const { runProcess } = require('@flow/core/processRunner');

library.load();
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function touch(rel) {
  const file = path.join(scratch, 'pick', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return file;
}

const pick = path.join(scratch, 'pick');
touch('b.mp3');
touch('a.flac');
touch('index.d.ts');
touch('player.ts');
touch('notes.txt');
touch('Album/01 Song.opus');
touch('Album/clip.mp4');
touch('node_modules/pkg/sound.mp3');
touch('.git/objects/x.wav');
touch('$Recycle.Bin/S-1-5/$IABC.mp3');
touch('AppData/Local/thing.ogg');

test('a folder lists sound and video files only, its own first, and leaves out code and system folders', async () => {
  const { files, truncated } = await scanFolder(pick);
  assert.deepEqual(files.map((f) => path.relative(pick, f)),
    ['a.flac', 'b.mp3', path.join('Album', '01 Song.opus'), path.join('Album', 'clip.mp4')]);
  assert.equal(truncated, false);
});

test('a folder stops at the limit and says so', async () => {
  const { files, truncated } = await scanFolder(pick, { limit: 2 });
  assert.equal(files.length, 2);
  assert.equal(truncated, true);
});

test('looking through a folder can be cancelled', async () => {
  const token = { cancelled: false };
  const seen = [];
  const scan = scanFolder(pick, { token, onProgress: (n, dir) => seen.push(dir) });
  token.cancelled = true;
  await assert.rejects(scan, (err) => err.cancelled === true);
});

test('listLocal: folders by extension, a file picked by name whatever it is', async () => {
  const group = importer.groupToken();
  const events = [];
  const fromFolder = await importer.listLocal([pick], group, (p) => events.push(p));
  assert.equal(fromFolder.items.length, 4);
  assert.ok(!fromFolder.items.some((it) => it.title.endsWith('.ts')));
  assert.equal(fromFolder.name, 'pick');
  assert.ok(events.every((e) => e.phase === 'scanning'));

  const picked = await importer.listLocal([path.join(pick, 'player.ts')], importer.groupToken(), () => {});
  assert.deepEqual(picked.items.map((it) => it.title), ['player.ts']);

  const cancelled = importer.groupToken();
  cancelled.cancel();
  await assert.rejects(importer.listLocal([pick], cancelled, () => {}), (err) => err.cancelled === true);
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('Cancel import kills what runs, starts nothing queued, and says nothing more', async () => {
  const group = importer.groupToken();
  const items = Array.from({ length: 5 }, (_, i) => ({ index: i, title: `Song ${i + 1}` }));
  const started = [];
  const running = [];
  const events = [];
  const task = importer.eachItem(items, group, (p) => events.push(p), async (it, report) => {
    started.push(it.index);
    if (it.index === 0) return { media: { path: path.join(scratch, 'none') }, song: {} };
    // A tool that would run for a long time, like ffmpeg on a long video.
    const token = { cancelled: false };
    const run = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], null, token);
    report(0.1, 'working');
    const t = group.sub();
    t.cancel = () => token.cancel();
    running.push(token);
    try {
      return await run;
    } finally {
      group.done(t);
    }
  });

  // Cancel while the second song's tool runs.
  while (started.length < 2) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  group.cancel();
  const summary = await task;
  assert.ok(Date.now() - t0 < 3000, 'the task ends at once');
  assert.equal(summary.cancelled, true);
  assert.deepEqual(started, [0, 1], 'nothing queued was started');
  const afterCancel = events.filter((e) => e.phase === 'item' && e.index > 1);
  assert.deepEqual(afterCancel, []);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(running.length, 1);
  assert.ok(running[0].cancelled);
});

test('a song that is ready just as the import is cancelled is thrown away', async () => {
  const group = importer.groupToken();
  const file = path.join(scratch, 'ready.opus');
  fs.writeFileSync(file, 'x');
  const events = [];
  const summary = await importer.eachItem([{ index: 0, title: 'A' }, { index: 1, title: 'B' }], group,
    (p) => events.push(p), async () => {
      group.cancel();
      return { media: { path: file }, song: {} };
    });
  assert.equal(summary.cancelled, true);
  assert.equal(fs.existsSync(file), false);
  assert.ok(!events.some((e) => e.status === 'ready'));
});

test('the tool itself is killed on cancel', async () => {
  const token = { cancelled: false };
  let pid = 0;
  const run = runProcess(process.execPath, ['-e', 'console.log(process.pid); setTimeout(() => {}, 20000)'],
    (line) => { pid = Number(line); }, token);
  while (!pid) await new Promise((r) => setTimeout(r, 20));
  token.cancel();
  await assert.rejects(run);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pid), false);
});
