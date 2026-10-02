'use strict';

// For the tests: an app's live channel (src/live.js) read the way the app
// reads it. connect() resolves once the answer's head is in:
// { status, events, next(type, timeout), close() }. next() resolves the next
// event of that type not taken yet (from those already in, else the coming
// ones), or rejects after `timeout`.

const http = require('http');

function connect(base, client, { token, device, probe } = {}) {
  return new Promise((resolve, reject) => {
    const q = new URLSearchParams();
    if (client !== null) q.set('client', client);
    if (device) q.set('device', device);
    if (probe) q.set('probe', '1');
    const headers = { Accept: 'text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const events = [];
    const taken = new Set();
    const waiting = [];
    let ended = false;
    const deliver = () => {
      for (const w of waiting.slice()) {
        const i = events.findIndex((e, n) => !taken.has(n) && e.type === w.type);
        if (i < 0) continue;
        taken.add(i);
        waiting.splice(waiting.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(events[i].data);
      }
    };
    const req = http.request(`${base}/api/live?${q}`, { headers, agent: false }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const type = (/^event: (.+)$/m.exec(block) || [])[1];
          const data = (/^data: (.*)$/m.exec(block) || [])[1];
          if (!type) continue;
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          events.push({ type, data: parsed });
        }
        deliver();
      });
      res.on('end', () => {
        ended = true;
      });
      res.on('error', () => {});
      resolve({
        status: res.statusCode,
        events,
        get ended() {
          return ended;
        },
        next(type, timeout = 3000) {
          return new Promise((ok, fail) => {
            const w = { type, resolve: ok, timer: null };
            w.timer = setTimeout(() => {
              waiting.splice(waiting.indexOf(w), 1);
              fail(new Error(`No "${type}" event within ${timeout} ms (got: ${events.map((e) => e.type).join(', ') || 'none'})`));
            }, timeout);
            waiting.push(w);
            deliver();
          });
        },
        close() {
          req.destroy();
        },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

module.exports = { connect };
