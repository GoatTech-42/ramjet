// server-side fetch for browse (Luke 8:13 PM "9 seconds for a news page is
// crazy"). the stock engine opens a TLS connection from inside the browser
// for every host and every parallel request, and each handshake crosses the
// tunnel. here the box does the TLS with pooled keep-alive connections and
// sends the body back down the one multiplexed tunnel connection the page
// already has: one round trip per request, no handshakes. same pattern the
// bare-server proxies use. private/loopback targets are refused at connect
// time, and the ad blocker applies here too.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';
import { isAdHost, stats as adStats } from './adblock.js';

const agentOpts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 24, maxFreeSockets: 8, timeout: 30000 };
const agents = { 'http:': new http.Agent(agentOpts), 'https:': new https.Agent(agentOpts) };

function privateIp(ip) {
  if (net.isIPv6(ip)) return /^(::1?|fe80|fc|fd)/i.test(ip) || ip.startsWith('::ffff:');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export function safeLookup(host, opts, cb) {
  dns.lookup(host, { family: 4, all: false }, (err, addr, fam) => {
    if (err) return cb(err);
    if (privateIp(addr)) return cb(new Error('blocked address'));
    if (opts && opts.all) cb(null, [{ address: addr, family: fam }]);
    else cb(null, addr, fam);
  });
}

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer', 'content-encoding', 'content-length']);
const DROP_REQ = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'via']);

export async function handlePFetch(req, res, session, readBody, track) {
  const fail = (code, msg) => { if (!res.headersSent) { res.writeHead(code, { 'x-rj-error': msg, 'cache-control': 'no-store' }); } res.end(); };
  if (!session) return fail(401, 'signin');
  let spec;
  try { spec = JSON.parse((await readBody(req)).toString('utf8')); } catch { return fail(400, 'bad'); }
  let u;
  try { u = new URL(String(spec.url)); } catch { return fail(400, 'url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail(400, 'proto');
  if (u.username || u.password) return fail(400, 'url');
  if (net.isIP(u.hostname) && privateIp(u.hostname)) return fail(403, 'blocked address');
  if (spec.ab !== false && isAdHost(u.hostname)) { adStats.blocked++; adStats.byUser[session.user] = (adStats.byUser[session.user] || 0) + 1; return fail(502, 'adblock'); }
  const headers = {};
  for (const [k, v] of spec.headers || []) {
    const lk = String(k).toLowerCase();
    if (DROP_REQ.has(lk)) continue;
    headers[lk] = headers[lk] ? headers[lk] + (lk === 'cookie' ? '; ' : ', ') + v : v;
  }
  headers['accept-encoding'] = 'gzip, br';
  const body = spec.body ? Buffer.from(spec.body, 'base64') : null;
  if (body) headers['content-length'] = body.length;
  const lib = u.protocol === 'https:' ? https : http;
  const up = lib.request({
    protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
    method: String(spec.method || 'GET').toUpperCase(), headers, agent: agents[u.protocol], lookup: safeLookup, timeout: 30000,
  }, (ur) => {
    const raw = [];
    for (let i = 0; i < ur.rawHeaders.length; i += 2) {
      if (!HOP.has(ur.rawHeaders[i].toLowerCase())) raw.push([ur.rawHeaders[i], ur.rawHeaders[i + 1]]);
    }
    const out = {
      'x-rj-status': String(ur.statusCode), 'x-rj-text': encodeURIComponent(ur.statusMessage || ''),
      'x-rj-headers': Buffer.from(JSON.stringify(raw)).toString('base64'), 'cache-control': 'no-store',
      'content-type': 'application/octet-stream',
    };
    if (ur.headers['content-encoding']) out['content-encoding'] = ur.headers['content-encoding'];
    res.writeHead(200, out);
    ur.on('data', (c) => track(c.length));
    ur.pipe(res);
    ur.on('error', () => res.destroy());
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => fail(502, String(e.message || 'upstream').slice(0, 80)));
  res.on('close', () => up.destroy());
  if (body) up.end(body); else up.end();
}

// ---- box-side GET cache: the page never sees cache headers through the proxy
// (every fetch re-crosses the box), so static assets - fonts, scripts, css,
// images with a max-age - are kept here and answered from memory next time.
// keyed by url + accept + a hash of any cookie, never shared across logins.
import { createHash } from 'node:crypto';
const PCACHE = new Map();
let pcBytes = 0;
const PC_MAX = 160e6, PC_ITEM = 2.5e6;
const pcKey = (u, h) => u.href + '|' + (h.accept || '') + '|' + (h.cookie ? createHash('md5').update(h.cookie).digest('hex') : '');
function pcGet(k) {
  const e = PCACHE.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { PCACHE.delete(k); pcBytes -= e.size; return null; }
  PCACHE.delete(k); PCACHE.set(k, e);
  return e;
}
function pcTtl(ur, u) {
  const h = ur.headers;
  if (ur.statusCode !== 200 || h['set-cookie'] || /\b(cookie|\*)\b/i.test(String(h.vary || ''))) return 0;
  const cc = String(h['cache-control'] || '').toLowerCase();
  if (/no-store|private|no-cache/.test(cc)) return 0;
  const m = /s-maxage=(\d+)/.exec(cc) || /max-age=(\d+)/.exec(cc);
  const age = parseInt(h.age || '0', 10) || 0;
  if (m) return Math.min(86400, Math.max(0, +m[1] - age));
  const ct = String(h['content-type'] || '');
  if (/^(image|font)\/|javascript|text\/css/i.test(ct) && (h.etag || h['last-modified'])) return 600;
  return 0;
}
function pcPut(k, e) {
  if (e.size > PC_ITEM) return;
  const old = PCACHE.get(k); if (old) pcBytes -= old.size;
  PCACHE.set(k, e); pcBytes += e.size;
  while (pcBytes > PC_MAX) { const [kk, ee] = PCACHE.entries().next().value; PCACHE.delete(kk); pcBytes -= ee.size; }
}
export const pcacheStats = () => ({ entries: PCACHE.size, mb: Math.round(pcBytes / 1e5) / 10 });

// ---- websocket multiplexed variant: many requests over one connection, so the
// tunnel's http/1.1-only front (6 connections per host) is no longer a cap ----
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });

function frame(id, type, payload) {
  const h = Buffer.alloc(5); h.writeUInt32BE(id, 0); h[4] = type;
  return payload ? Buffer.concat([h, payload]) : h;
}

export function pwsUpgrade(req, socket, head, user, track) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const active = new Map();
    const out = (id, type, payload) => { if (ws.readyState === 1) ws.send(frame(id, type, payload)); };
    ws.on('message', (m) => {
      let spec;
      try { spec = JSON.parse(m.toString('utf8')); } catch { return; }
      const id = Number(spec.id) >>> 0;
      if (spec.cancel) { active.get(id)?.destroy(); active.delete(id); return; }
      let u;
      try { u = new URL(String(spec.url)); } catch { return out(id, 3, Buffer.from('url')); }
      if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return out(id, 3, Buffer.from('url'));
      if (net.isIP(u.hostname) && privateIp(u.hostname)) return out(id, 3, Buffer.from('blocked address'));
      if (spec.ab !== false && isAdHost(u.hostname)) { adStats.blocked++; adStats.byUser[user] = (adStats.byUser[user] || 0) + 1; return out(id, 3, Buffer.from('adblock')); }
      const headers = {};
      for (const [k, v] of spec.headers || []) {
        const lk = String(k).toLowerCase();
        if (DROP_REQ.has(lk)) continue;
        headers[lk] = headers[lk] ? headers[lk] + (lk === 'cookie' ? '; ' : ', ') + v : v;
      }
      headers['accept-encoding'] = 'gzip, br, identity;q=0';
      const body = spec.body ? Buffer.from(spec.body, 'base64') : null;
      if (body) headers['content-length'] = body.length;
      const method = String(spec.method || 'GET').toUpperCase();
      const cacheable = method === 'GET' && !body && !headers.range && !headers.authorization;
      const ck = cacheable ? pcKey(u, headers) : null;
      if (ck) {
        const hit = pcGet(ck);
        if (hit) { track(hit.size); out(id, 0, hit.meta); for (let o = 0; o < hit.body.length; o += 65536) out(id, 1, hit.body.subarray(o, o + 65536)); out(id, 2); return; }
      }
      const lib = u.protocol === 'https:' ? https : http;
      const up = lib.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
        method, headers, agent: agents[u.protocol], lookup: safeLookup, timeout: 30000,
      }, (ur) => {
        const ttl = ck ? pcTtl(ur, u) : 0;
        const keepChunks = ttl > 0 ? [] : null; let keepSize = 0, metaStr = '';
        const raw = [];
        for (let i = 0; i < ur.rawHeaders.length; i += 2) raw.push([ur.rawHeaders[i], ur.rawHeaders[i + 1]]);
        const enc = String(ur.headers['content-encoding'] || '').toLowerCase();
        // decode here: the websocket frames carry plain bytes the page can use directly
        let src = ur;
        if (enc === 'gzip' || enc === 'br') {
          src = ur.pipe(enc === 'br' ? zlib.createBrotliDecompress() : zlib.createGunzip());
          ur.on('error', () => src.destroy());
        }
        const keep = raw.filter(([k]) => !HOP.has(k.toLowerCase()));
        const metaBuf = Buffer.from(JSON.stringify({ status: ur.statusCode, text: ur.statusMessage || '', headers: keep }));
        out(id, 0, metaBuf);
        src.on('data', (c) => {
          track(c.length); out(id, 1, c);
          if (keepChunks) { keepSize += c.length; if (keepSize > PC_ITEM) keepChunks.length = 0, keepSize = PC_ITEM + 1; else keepChunks.push(c); }
          if (ws.bufferedAmount > 4e6) {
            src.pause();
            const t = setInterval(() => { if (ws.bufferedAmount < 1e6 || ws.readyState !== 1) { clearInterval(t); src.resume(); } }, 20);
          }
        });
        src.on('end', () => {
          active.delete(id); out(id, 2);
          if (keepChunks && keepSize > 0 && keepSize <= PC_ITEM) pcPut(ck, { meta: metaBuf, body: Buffer.concat(keepChunks), size: keepSize, exp: Date.now() + ttl * 1000 });
        });
        src.on('error', () => { active.delete(id); out(id, 3, Buffer.from('stream')); });
      });
      active.set(id, up);
      up.on('timeout', () => up.destroy(new Error('timeout')));
      up.on('error', (e) => { active.delete(id); out(id, 3, Buffer.from(String(e.message || 'upstream').slice(0, 80))); });
      if (body) up.end(body); else up.end();
    });
    ws.on('close', () => { for (const up of active.values()) up.destroy(); active.clear(); });
    ws.on('error', () => {});
  });
}
