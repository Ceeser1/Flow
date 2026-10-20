#!/usr/bin/env node
'use strict';

// Helpers install.sh runs (as root where it has to) for level 3, where shell
// would be fragile:
//
//   node setup.js caddyfile-set <file> <domain> <port>
//       puts Flow's block into the Caddyfile (a new one, the stock one from
//       the package replaced, or someone's own with the block added), and
//       prints what it did: created, replaced-stock, added, updated
//   node setup.js caddyfile-remove <file>
//       takes Flow's block out; prints "empty" when nothing else is left
//       for Caddy to serve, else "others"
//   node setup.js cert-ok <domain> [port]
//       exits 0 when this machine's https port shows a certificate for
//       <domain> that the apps accept (asked at 127.0.0.1, so a router that
//       can't reach its own public address doesn't matter)
//   node setup.js reach <domain>
//       the same, but where the name leads: through the router

const fs = require('fs');
const tls = require('tls');

const BEGIN = '# >>> Flow Server: install.sh keeps this block up to date; changes inside it are replaced.';
const END = '# <<< Flow Server';

function flowBlock(domain, port) {
  return `${BEGIN}\n${domain} {\n\treverse_proxy 127.0.0.1:${port}\n}\n${END}\n`;
}

/** The text without Flow's block. */
function withoutFlowBlock(text) {
  const start = text.indexOf(BEGIN);
  if (start < 0) return text;
  const endAt = text.indexOf(END, start);
  const stop = endAt < 0 ? text.length : endAt + END.length;
  return (text.slice(0, start).replace(/\n+$/, '\n') + text.slice(stop).replace(/^\n+/, '\n')).replace(/^\n+/, '');
}

/** What is left once comments and blank lines are gone. */
function content(text) {
  return text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').trim()).filter(Boolean).join('\n');
}

/** The Caddyfile the package comes with: one :80 site showing Caddy's welcome page. */
function isStock(text) {
  const c = content(text);
  return /^:80\s*\{[\s\S]*\}$/.test(c) && c.includes('/usr/share/caddy') && (c.match(/\{/g) || []).length === 1;
}

/** { text, how } with Flow's block for `domain` in it. */
function withFlowBlock(text, domain, port) {
  const block = flowBlock(domain, port);
  if (!content(text)) return { text: block, how: 'created' };
  if (isStock(text)) return { text: block, how: 'replaced-stock' };
  const had = text.includes(BEGIN);
  const rest = withoutFlowBlock(text).replace(/\n*$/, '\n');
  return { text: `${rest}\n${block}`, how: had ? 'updated' : 'added' };
}

function certOk(domain, port = 443, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: domain, timeout: 5000 }, () => {
      resolve(socket.authorized);
      socket.end();
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function main([command, ...args]) {
  if (command === 'caddyfile-set') {
    const [file, domain, port] = args;
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
    const { text: next, how } = withFlowBlock(text, domain, Number(port));
    if (content(text) && next !== text) fs.writeFileSync(`${file}.before-flow`, text);
    fs.writeFileSync(file, next);
    console.log(how);
    return 0;
  }
  if (command === 'caddyfile-remove') {
    const [file] = args;
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      console.log('empty');
      return 0;
    }
    const next = withoutFlowBlock(text);
    if (next !== text) fs.writeFileSync(file, next);
    console.log(content(next) ? 'others' : 'empty');
    return 0;
  }
  if (command === 'cert-ok') return (await certOk(args[0], Number(args[1]) || 443)) ? 0 : 1;
  if (command === 'reach') return (await certOk(args[0], 443, args[0])) ? 0 : 1;
  console.error('Unknown command. See the top of setup.js.');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { withFlowBlock, withoutFlowBlock, isStock, content, flowBlock };
