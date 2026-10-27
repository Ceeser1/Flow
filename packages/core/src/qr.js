'use strict';

// QR codes (4.0): the "Share" of a Flow Server (a flow://connect link) as a
// picture another phone scans. Text in byte mode (UTF-8), error correction
// level M, the smallest version it fits, the mask with the least penalty, as
// the standard (ISO/IEC 18004) says. Plain JS: the desktop's main process,
// the phone's page and flow-server share draw the same squares.
//
//   encode(text) -> { size, modules }   modules[y][x]: true for dark

// Error correction codewords per block, and blocks, for level M by version (1-40).
const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
// Level M in the format bits.
const LEVEL_M = 0;

/** How many modules a version has for data and error correction (all but the patterns). */
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}

const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

// ---- Reed-Solomon over GF(256), x^8 + x^4 + x^3 + x^2 + 1 ----

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMultiply(coef, factor);
    });
  }
  return result;
}

// ---- the codewords ----

/** The data bits (byte mode) padded to the version's codewords, as bytes. */
function dataBytes(bytes, ver) {
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(ver) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  return out;
}

/** The data split into blocks, each with its error correction, interleaved. */
function withErrorCorrection(data, ver) {
  const blocks = BLOCKS[ver];
  const eccLen = ECC_PER_BLOCK[ver];
  const raw = Math.floor(rawModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const parts = [];
  for (let i = 0, k = 0; i < blocks; i += 1) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    parts.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < parts[0].length; i += 1) {
    parts.forEach((block, j) => {
      // The short blocks' placeholder is no codeword.
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(block[i]);
    });
  }
  return out;
}

// ---- the picture ----

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(ver, codewords, mask) {
  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };
  // Timing patterns.
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // Finder patterns with their separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  // Alignment patterns, not over the finders.
  const align = alignmentPositions(ver, size);
  for (let i = 0; i < align.length; i += 1) {
    for (let j = 0; j < align.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Format bits (level M, this mask), twice.
  const data = (LEVEL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const format = ((data << 10) | rem) ^ 0x5412;
  const bit = (v, i) => ((v >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(format, i));
  set(8, 7, bit(format, 6));
  set(8, 8, bit(format, 7));
  set(7, 8, bit(format, 8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(format, i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(format, i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(format, i));
  set(8, size - 8, true);
  // Version bits (7 and up).
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i += 1) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (ver << 12) | r;
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(bits, i));
      set(b, a, bit(bits, i));
    }
  }
  // The codewords, in two-module columns zigzagging up and down from the right.
  let n = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (fixed[y][x] || n >= codewords.length * 8) continue;
        modules[y][x] = bit(codewords[n >>> 3], 7 - (n & 7));
        n += 1;
      }
    }
  }
  // The mask, over the codewords only.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) if (!fixed[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  }
  return modules;
}

/** How hard the picture is to read (the standard's four penalty rules). */
function penalty(m) {
  const size = m.length;
  let score = 0;
  const line = (get) => {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && get(i) === get(i - 1)) run += 1;
      else {
        if (run >= 5) score += 3 + run - 5;
        run = 1;
      }
    }
    // Finder-like stretches: dark light dark dark dark light dark, with four light on a side.
    for (let i = 0; i + 11 <= size; i += 1) {
      const s = Array.from({ length: 11 }, (_, k) => (get(i + k) ? 1 : 0)).join('');
      if (s === '10111010000' || s === '00001011101') score += 40;
    }
  };
  for (let y = 0; y < size; y += 1) line((x) => m[y][x]);
  for (let x = 0; x < size; x += 1) line((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (m[y][x]) dark += 1;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** The QR code of `text`: { size, modules } (modules[y][x], true for dark). */
function encode(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = 1;
  // The count is 8 bits up to version 9, 16 from 10 on.
  while (ver <= 40 && 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(ver) * 8) ver += 1;
  if (ver > 40) throw new Error('That is too long for a QR code.');
  const codewords = withErrorCorrection(dataBytes(bytes, ver), ver);
  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    const m = build(ver, codewords, mask);
    const score = penalty(m);
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return { size: best.length, version: ver, modules: best };
}

/** The code as text for a terminal: two rows of modules per line, with the quiet zone around it. */
function toTerminal({ size, modules }) {
  const quiet = 2;
  const at = (x, y) => x >= 0 && y >= 0 && x < size && y < size && modules[y][x];
  const lines = [];
  for (let y = -quiet; y < size + quiet; y += 2) {
    let line = '';
    for (let x = -quiet; x < size + quiet; x += 1) {
      const top = at(x, y);
      const bottom = at(x, y + 1);
      // Light on a dark terminal: the dark modules are drawn as spaces.
      line += top && bottom ? ' ' : top ? '▄' : bottom ? '▀' : '█';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

module.exports = { encode, toTerminal };
