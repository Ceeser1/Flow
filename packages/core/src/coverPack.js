'use strict';

// Several covers in one body (4.3.1, POST /api/covers): a 4-byte length (big
// endian), that many bytes of JSON, [{ id, v, n }] (the song, its cover's
// version, the picture's length), then the pictures one after another in
// that order. One request for every cover a list shows, instead of one each.
// Pure, no Node modules: the apps unpack it in their WebView too.

/** items [{ id, v, bytes }] packed into one Buffer (the server's side). */
function packCovers(items) {
  const index = Buffer.from(JSON.stringify(items.map((x) => ({ id: x.id, v: x.v, n: x.bytes.length }))), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(index.length, 0);
  return Buffer.concat([head, index, ...items.map((x) => x.bytes)]);
}

/** A packed body (Uint8Array or Buffer) back into [{ id, v, bytes }]; [] for anything broken. */
function unpackCovers(body) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body || []);
  if (bytes.length < 4) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = view.getUint32(0, false);
  if (4 + len > bytes.length) return [];
  let index;
  try {
    index = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + len)));
  } catch {
    return [];
  }
  if (!Array.isArray(index)) return [];
  const out = [];
  let at = 4 + len;
  for (const e of index) {
    const n = Math.max(0, Math.floor(Number(e && e.n) || 0));
    if (at + n > bytes.length) break;
    out.push({ id: String(e.id || ''), v: String(e.v || ''), bytes: bytes.subarray(at, at + n) });
    at += n;
  }
  return out;
}

module.exports = { packCovers, unpackCovers };
