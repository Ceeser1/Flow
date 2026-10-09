'use strict';

// Flow.ipa, the app that installs on an iPhone, sealed with a key of the
// owner's: the repository is public, and so are its workflow runs' files to
// anyone signed in to GitHub, so the CI uploads only the sealed file
// (AES-256-GCM). The key is the repository's secret FLOW_IPA_KEY (32 random
// bytes, base64), and the owner keeps a copy.
//
//   node apps/ios/scripts/sealed.js seal Flow.ipa Flow.ipa.sealed           (key: FLOW_IPA_KEY)
//   node apps/ios/scripts/sealed.js open Flow.ipa.sealed Flow.ipa --key-file <file with the key>
//
// A sealed file: "FLOWIPA1", the 12-byte IV, the 16-byte tag, the sealed bytes.

const crypto = require('crypto');
const fs = require('fs');

const MAGIC = Buffer.from('FLOWIPA1');

function key(args) {
  const at = args.indexOf('--key-file');
  const text = at >= 0 ? fs.readFileSync(args[at + 1], 'utf8') : process.env.FLOW_IPA_KEY || '';
  // The file may hold notes too: the key is its line of base64 alone.
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Za-z0-9+/]{43}=$/.test(l));
  const k = line ? Buffer.from(line, 'base64') : null;
  if (!k || k.length !== 32) throw new Error('No key: FLOW_IPA_KEY, or --key-file with the key (44 characters of base64) on a line of its own.');
  return k;
}

function seal(input, output, k) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const body = Buffer.concat([c.update(fs.readFileSync(input)), c.final()]);
  fs.writeFileSync(output, Buffer.concat([MAGIC, iv, c.getAuthTag(), body]));
}

function open(input, output, k) {
  const data = fs.readFileSync(input);
  if (!data.subarray(0, 8).equals(MAGIC)) throw new Error(`${input} is not a sealed Flow.ipa.`);
  const d = crypto.createDecipheriv('aes-256-gcm', k, data.subarray(8, 20));
  d.setAuthTag(data.subarray(20, 36));
  let body;
  try {
    body = Buffer.concat([d.update(data.subarray(36)), d.final()]);
  } catch {
    throw new Error('Not opened: another key, or the file is damaged.');
  }
  fs.writeFileSync(output, body);
}

function main() {
  const [what, input, output, ...rest] = process.argv.slice(2);
  if (!['seal', 'open'].includes(what) || !input || !output) {
    console.error('node sealed.js seal <Flow.ipa> <Flow.ipa.sealed> | open <Flow.ipa.sealed> <Flow.ipa> [--key-file <file>]');
    process.exit(2);
  }
  try {
    (what === 'seal' ? seal : open)(input, output, key(rest));
    console.log(`${what === 'seal' ? 'Sealed' : 'Opened'}: ${output}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
