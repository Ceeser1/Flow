// Tries the built web player (dist/) on this computer, the way a website
// serves it: the page at http://127.0.0.1:8090/link/, and /flow/ passed on to
// a Flow Server (as a proxy in front of the server would), so the page can be
// tried against a server at its own address or at /flow.
//
//   node scripts/serve.js [--port 8090] [--flow http://127.0.0.1:7878]
//
// Only for trying: it listens on this computer alone.
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const port = Number(opt('port', 8090));
const flow = new URL(opt('flow', 'http://127.0.0.1:7878'));
const dist = path.join(__dirname, '..', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function proxy(req, res, rest) {
  const up = http.request({
    host: flow.hostname,
    port: flow.port || 80,
    method: req.method,
    path: rest,
    headers: { ...req.headers, host: flow.host, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'http' },
  }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    // Cut off mid-answer (a song, the live channel): the page sees it end.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`No Flow Server at ${flow.href}`);
  });
  // The page gone (a song skipped, the tab closed): the server's answer is not waited for.
  res.on('close', () => up.destroy());
  req.pipe(up);
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/flow' || url.pathname === '/link') {
    res.writeHead(301, { Location: `${url.pathname}/` });
    res.end();
    return;
  }
  if (url.pathname.startsWith('/flow/')) {
    proxy(req, res, req.url.slice('/flow'.length));
    return;
  }
  if (!url.pathname.startsWith('/link/')) {
    res.writeHead(404);
    res.end();
    return;
  }
  let rel = decodeURIComponent(url.pathname.slice('/link/'.length)) || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(dist, rel);
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`Flow web player: http://127.0.0.1:${port}/link/  (/flow/ -> ${flow.href})`);
});
