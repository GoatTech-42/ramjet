// keep-alive fetch for googlevideo (and anything else the byte proxy talks
// to). global fetch opened a fresh TLS connection for most range requests;
// a seek-heavy player makes dozens of them. this pools sockets per host and
// returns just enough of the fetch Response shape for gvProxy / the cache
// downloaders: status, headers.get, body (async iterable + cancel),
// arrayBuffer. redirects followed on the same pool. no dependencies.
import https from 'node:https';
import http from 'node:http';

const mk = (M) => new M.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 32, maxFreeSockets: 16, maxTotalSockets: 96, timeout: 60000 });
const agents = { 'https:': mk(https), 'http:': mk(http) };
export const gvStats = { requests: 0, reused: 0, sockets: 0 };
const DRAIN_MAX = 65536; // small leftover bodies are drained so the socket goes back to the pool

function once(u, headers, signal, redirects) {
  return new Promise((resolve, reject) => {
    const url = new URL(u);
    const M = url.protocol === 'https:' ? https : http;
    const req = M.request(url, { method: 'GET', headers, agent: agents[url.protocol], signal }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects > 0) {
        res.resume();
        return resolve(once(new URL(loc, url).toString(), headers, signal, redirects - 1));
      }
      let started = false;
      const len = parseInt(res.headers['content-length'] || '-1', 10);
      const body = {
        [Symbol.asyncIterator]() { started = true; return res[Symbol.asyncIterator](); },
        cancel() {
          if (res.readableEnded || res.destroyed) return Promise.resolve();
          // untouched small body: drain it so the socket returns to the pool.
          // anything big or already mid-stream (client hung up): kill it so
          // the box stops pulling bytes nobody will read.
          if (!started && (res.complete || (len >= 0 && len <= DRAIN_MAX))) res.resume(); else res.destroy();
          return Promise.resolve();
        },
      };
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } },
        body,
        async arrayBuffer() { started = true; const parts = []; for await (const c of res) parts.push(c); const b = Buffer.concat(parts); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); },
      });
    });
    req.once('socket', (s) => { gvStats.requests++; if (s.__gvUsed) gvStats.reused++; else { s.__gvUsed = true; gvStats.sockets++; } });
    req.once('error', reject);
    req.end();
  });
}

export function gvFetch(u, { headers = {}, signal, redirect = 'follow' } = {}) {
  return once(u, { 'accept-encoding': 'identity', ...headers }, signal, redirect === 'follow' ? 5 : 0);
}
