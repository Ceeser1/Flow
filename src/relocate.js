'use strict';

// Moving the songs to another save folder (Settings > Saved Songs > Change):
// which folders are allowed and where each file goes. Pure, pinned by
// test/relocate.test.js; library.js does the moving.

const path = require('path');

const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (child, parent) => path.resolve(child).toLowerCase().startsWith(path.resolve(parent).toLowerCase() + path.sep);

/** Throws, saying why, when the songs cannot move from `oldDir` to `newDir`. */
function checkTarget(oldDir, newDir) {
  if (!newDir || !path.isAbsolute(newDir)) throw new Error('Please choose a folder.');
  if (same(oldDir, newDir)) throw new Error('That is already the folder the songs are saved in.');
  if (inside(newDir, oldDir)) throw new Error('The new folder cannot be inside the current one.');
  if (inside(oldDir, newDir)) throw new Error('The new folder cannot contain the current one.');
}

/**
 * Where each file goes: the same place relative to the new folder, subfolders
 * and all. A name already taken there (on disk, `taken(lowerCasePath)`, or by
 * an earlier file of this move) becomes "Name (2).ext", "Name (3).ext"...
 * Returns [{ from, to }].
 */
function planMoves(files, oldDir, newDir, taken = () => false) {
  const planned = new Set();
  const plan = [];
  for (const from of files) {
    const rel = path.relative(oldDir, from);
    let to = path.join(newDir, rel);
    const ext = path.extname(to);
    const stem = to.slice(0, to.length - ext.length);
    for (let n = 2; taken(to.toLowerCase()) || planned.has(to.toLowerCase()); n += 1) {
      to = `${stem} (${n})${ext}`;
    }
    planned.add(to.toLowerCase());
    plan.push({ from, to });
  }
  return plan;
}

module.exports = { checkTarget, planMoves, inside, same };
