'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withFlowBlock, withoutFlowBlock, content } = require('../src/setup');

// What the caddy package puts in /etc/caddy/Caddyfile (shortened).
const STOCK = `# The Caddyfile is an easy way to configure your Caddy web server.
#
# Unless the file starts with a global options block, the first
# uncommented line is always the address of your site.

:80 {
\t# Set this path to your site's directory.
\troot * /usr/share/caddy

\t# Enable the static file server.
\tfile_server
}

# Refer to the Caddy docs for more information:
# https://caddyserver.com/docs/caddyfile
`;

const OWN = `{
\temail me@example.com
}

blog.example.com {
\troot * /srv/blog
\tfile_server
}
`;

test('a new or stock Caddyfile becomes just the Flow block', () => {
  const fresh = withFlowBlock('', 'music.example.com', 7878);
  assert.equal(fresh.how, 'created');
  assert.equal(content(fresh.text), 'music.example.com {\nreverse_proxy 127.0.0.1:7878\n}');
  const stock = withFlowBlock(STOCK, 'music.example.com', 7878);
  assert.equal(stock.how, 'replaced-stock');
  assert.equal(stock.text, fresh.text);
});

test('someone\'s own Caddyfile keeps its sites, and the block is replaced, not added twice', () => {
  const added = withFlowBlock(OWN, 'music.example.com', 7878);
  assert.equal(added.how, 'added');
  assert.ok(added.text.startsWith(OWN));
  const moved = withFlowBlock(added.text, 'tunes.example.com', 8000);
  assert.equal(moved.how, 'updated');
  assert.equal((moved.text.match(/Flow Server:/g) || []).length, 1);
  assert.match(moved.text, /tunes\.example\.com \{\n\treverse_proxy 127\.0\.0\.1:8000/);
  assert.doesNotMatch(moved.text, /music\.example\.com/);
  assert.equal(content(withoutFlowBlock(moved.text)), content(OWN));
});

test('taking the block out says whether Caddy still serves something', () => {
  assert.equal(content(withoutFlowBlock(withFlowBlock('', 'music.example.com', 7878).text)), '');
  assert.notEqual(content(withoutFlowBlock(withFlowBlock(OWN, 'music.example.com', 7878).text)), '');
  assert.equal(withoutFlowBlock(OWN), OWN, 'no block: nothing changes');
});
