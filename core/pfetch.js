// server-side fetch for browse (a news page took 9 seconds). the stock engine opens a TLS connection from inside the browser
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

const TEST_HOOKS = process.env.RJ_TEST_HOOKS === '1'; // loopback fixture upstreams in tests, never in production
// the upstream trust boundary is the shared net-safe classifier (the same one
// safeGet and the lite downloader use): every dns answer AND every literal ip,
// v4 and v6, default-deny special ranges. ports pin to 80/443 like safeGet.
import { blockedIp, pin } from './net-safe.js';
function portOf(u) { return u.port ? Number(u.port) : (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80); }
function badTarget(u) {
  // URL keeps the brackets on ipv6 literals - strip them before classifying,
  // or [::1] and [::ffff:127.0.0.1] sail past net.isIP unexamined
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && blockedIp(host) && !(TEST_HOOKS && (host === '127.0.0.1' || host === '::1'))) return 'blocked address';
  if (!TEST_HOOKS && portOf(u) !== 80 && portOf(u) !== 443) return 'port not allowed';
  return null;
}
export function safeLookup(host, opts, cb) {
  pin(host, { allowPrivate: TEST_HOOKS }).then(({ address, family }) => {
    if (opts && opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  }, (e) => cb(e));
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
  const bt = badTarget(u);
  if (bt) return fail(403, bt);
  if (spec.ab !== false && isAdHost(u.hostname)) { adStats.blocked++; adStats.byUser[session.user] = (adStats.byUser[session.user] || 0) + 1; return fail(502, 'adblock'); }
  const headers = {};
  for (const h of Array.isArray(spec.headers) ? spec.headers : []) {
    if (!Array.isArray(h) || h.length < 2) continue;
    const lk = String(h[0]).toLowerCase();
    if (DROP_REQ.has(lk)) continue;
    headers[lk] = headers[lk] ? headers[lk] + (lk === 'cookie' ? '; ' : ', ') + String(h[1]) : String(h[1]);
  }
  headers['accept-encoding'] = 'gzip, br';
  const body = spec.body ? Buffer.from(String(spec.body), 'base64') : null;
  if (body) headers['content-length'] = body.length;
  const method = String(spec.method || 'GET').toUpperCase();
  if (!/^[A-Z][A-Z0-9_-]*$/.test(method)) return fail(400, 'method');
  // the fallback endpoint shares the tunnel's guardrails: a global
  // concurrency slot, a wall clock, and a wire-byte cap
  if (upstreamActive >= AC_MAX_GLOBAL_STREAMS) return fail(503, 'busy');
  upstreamActive++;
  let done = false;
  const wall = setTimeout(() => { try { up.destroy(new Error('timed out')); } catch {} }, AC_WALL_MS);
  const finish = () => { if (!done) { done = true; upstreamActive--; clearTimeout(wall); } };
  const lib = u.protocol === 'https:' ? https : http;
  let up;
  try {
    up = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      method, headers, agent: agents[u.protocol], lookup: safeLookup, timeout: 30000,
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
      let wire = 0;
      ur.on('data', (c) => { track(c.length); wire += c.length; if (wire > AC_MAX_DECODE) up.destroy(new Error('too big')); });
      ur.pipe(res);
      ur.on('error', () => res.destroy());
      ur.on('end', finish);
    });
  } catch (e) { finish(); return fail(400, 'request'); }
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', (e) => { finish(); fail(502, String(e.message || 'upstream').slice(0, 80)); });
  res.on('close', () => { try { up.destroy(); } catch {} finish(); });
  if (body) up.end(body); else up.end();
}

// ---- websocket multiplexed variant: many requests over one connection, so the
// tunnel's http/1.1-only front (6 connections per host) is no longer a cap ----
import { WebSocketServer, WebSocket as WSClient } from 'ws';
// tunnel payloads carry plain (decoded) bytes, so let the websocket compress
// them: html/js/css through the proxy deflate well and every byte here
// crosses the tunnel once.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024 * 1024,
  // no retained zlib context across messages (a peer cannot grow server
  // memory via takeover) and a hard cap on concurrent compress jobs
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, concurrencyLimit: 10 },
});

// ---- box-side asset cache: anonymous, explicitly cacheable GET responses are
// kept for their max-age so repeat page loads skip the upstream round trip.
// never credentialed requests, never set-cookie/no-store/private/no-cache
// responses, never varying content; size, count and ttl are all capped. the
// stored body is the DECODED byte stream the tunnel sends.
const AC_MAX_BYTES = 64 * 1024 * 1024, AC_MAX_ITEM = 2 * 1024 * 1024, AC_MAX_ENTRIES = 512, AC_MAX_TTL_MS = 3600e3, AC_FRAME = 1 << 20;
const assetCache = new Map(); // url -> { exp, status, text, headers, body }
let acBytes = 0;
let acCollectingBytes = 0; // bodies tee-ing into the cache right now
const acGet = (url) => {
  const e = assetCache.get(url);
  if (!e) return null;
  if (e.exp <= Date.now()) { acBytes -= e.body.length; assetCache.delete(url); return null; }
  assetCache.delete(url); assetCache.set(url, e); // lru touch
  return e;
};
const acPut = (url, status, text, headers, body, expAt, bornAt, maxAgeSec) => {
  if (body.length > AC_MAX_ITEM) return;
  // a caller that cannot state the parsed max-age gets the entry's own
  // remaining TTL: the stored directive is always a real number
  if (!Number.isFinite(maxAgeSec)) maxAgeSec = Math.max(0, Math.floor((expAt - Date.now()) / 1000));
  // age/date describe the UPSTREAM response at capture time; they are
  // stripped here and re-derived on every hit, never served stale. the
  // freshness directive is canonicalized to the parsed value, so quoted,
  // spaced or uppercase max-age grammar can never advertise more than the
  // entry actually holds
  const keep = [];
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (lk === 'age' || lk === 'date') continue;
    if (lk === 'cache-control') {
      const directives = String(v).split(',').map((d) => d.trim()).filter((d) => d && !/^(?:s-maxage|max-age)\s*=/i.test(d));
      keep.push([k, [...directives, 'max-age=' + maxAgeSec].join(', ')]);
      continue;
    }
    keep.push([k, v]);
  }
  const old = assetCache.get(url); if (old) acBytes -= old.body.length;
  assetCache.delete(url);
  while (assetCache.size >= AC_MAX_ENTRIES || acBytes + body.length > AC_MAX_BYTES) {
    const k = assetCache.keys().next().value; if (k == null) break;
    acBytes -= assetCache.get(k).body.length; assetCache.delete(k);
  }
  const storedAt = Date.now();
  assetCache.set(url, { exp: expAt, status, text, headers: keep, body, bornAt, storedAt, age0: (storedAt - bornAt) / 1000 });
  acBytes += body.length;
};
// a request is cache-eligible only as a plain anonymous GET: bodyless, and
// every header inside a strict allowlist (range/conditional/cookie/auth and
// any x-*/sec-* surprise all disqualify). the key partitions on the
// allowlisted header VALUES, so a warmed response can never be served to a
// request context it was not generated for - anything ambiguous skips the
// cache entirely. evaluated identically on read and on write.
const AC_REQ_ALLOW = new Set(['accept', 'accept-language', 'user-agent', 'origin', 'referer']);
const acReqKey = (method, url, reqHeaders, hasBody, clientAE) => {
  if (method !== 'GET' || hasBody) return null;
  // the tunnel always delivers identity bytes: a client that explicitly
  // refused identity (identity;q=0, or *;q=0 without an identity allow) can
  // never take the cached stream
  if (clientAE) {
    const ae = String(clientAE).toLowerCase();
    if (/(?:^|,)\s*identity\s*;\s*q\s*=\s*0(?:\.0+)?(?=\s*(?:,|$))/.test(ae)) return null;
    if (/(?:^|,)\s*\*\s*;\s*q\s*=\s*0(?:\.0+)?(?=\s*(?:,|$))/.test(ae) && !/(?:^|,)\s*identity\b/.test(ae)) return null;
  }
  const parts = [];
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (!AC_REQ_ALLOW.has(k)) return null;
    parts.push(k + '=' + v);
  }
  parts.sort();
  return url + '\n' + parts.join('\n');
};
// response eligibility: 200, explicit max-age, and no store/cookie/vary
// surprises - duplicate header values are joined before any test, so a
// doubled cache-control or set-cookie can never slip past a first-value read.
const acFresh = (status, respHeaders) => {
  if (status !== 200) return null;
  const get = (name) => respHeaders.filter(([k]) => k.toLowerCase() === name).map((h) => String(h[1]).toLowerCase()).join(',');
  const cc = get('cache-control');
  if (!cc || /no-store|no-cache|private/.test(cc)) return null;
  // every freshness claim must be present, well-formed and in agreement:
  // conflicting or malformed max-age/age/date values are refused outright,
  // never first-value-wins
  const ages = [];
  for (const d of cc.split(',')) {
    const t = d.trim();
    if (/^(?:s-maxage|max-age)\s*=/.test(t)) {
      const m = /^(?:s-maxage|max-age)\s*=\s*"?(\d+)"?$/.exec(t);
      if (!m) return null;
      ages.push(Number(m[1]));
    }
  }
  if (!ages.length || new Set(ages).size > 1) return null;
  if (get('set-cookie')) return null;
  const vary = get('vary');
  if (vary && vary.split(',').map((v) => v.trim()).some((v) => v !== 'accept-encoding')) return null;
  // corrected initial age: Age is strict delta-seconds only (the join above
  // makes duplicate Age headers fail this parse - ambiguity is refused),
  // plus apparent age from Date, whichever is larger
  let ageMs = 0;
  const ageRaw = get('age');
  if (ageRaw) {
    const t = ageRaw.trim();
    if (!/^\d+$/.test(t)) return null;
    ageMs = Number(t) * 1000;
  }
  const dateRaw = get('date');
  if (dateRaw) {
    const date = Date.parse(dateRaw);
    if (!Number.isFinite(date)) return null;
    ageMs = Math.max(ageMs, Date.now() - date);
  }
  const left = ages[0] * 1000 - ageMs;
  if (left <= 0) return null;
  return { ttlMs: Math.min(left, AC_MAX_TTL_MS), ageMs, maxAgeSec: ages[0] };
};
// ttl-only view of acFresh (review tooling reads this shape)
const acTtlMs = (status, respHeaders) => acFresh(status, respHeaders)?.ttlMs || 0;
// decoded AND wire bytes per response are capped: a gzip/brotli bomb must not
// inflate without bound through the box. 256MB is far past any page asset.
const AC_MAX_DECODE = 256 * 1024 * 1024;
// wall clock per proxied request, and concurrency: a pile of slow upstreams
// (or zlib jobs) from one page can never exhaust the box
const AC_WALL_MS = 300000, AC_MAX_CONN_STREAMS = 64, AC_MAX_GLOBAL_STREAMS = 256;
let upstreamActive = 0;
// relayed websockets are long-lived but never unbounded: an idle wall that
// any traffic resets, a hard lifetime, per-stream byte and rate budgets,
// and a per-user stream count on top of the shared global budget
let WS_IDLE_MS = 30 * 60 * 1000, WS_MAX_MS = 2 * 3600 * 1000, WS_MAX_BYTES = 256 * 1024 * 1024, WS_RATE_PER_SEC = 240, WS_MAX_PER_USER = 32, WS_QUEUE_CAP = 4e6, TUNNEL_HARD_CAP = 24e6;
const userWsActive = new Map();
let lastTunnel = null; // TEST_HOOKS only: lets a test observe real queue pressure
export const testHooks = TEST_HOOKS ? {
  collectingBytes: () => acCollectingBytes, upstreams: () => upstreamActive, cacheBytes: () => acBytes, wsActive: () => [...userWsActive.values()].reduce((a, b) => a + b, 0),
  tunnelBuffered: () => (lastTunnel ? lastTunnel.ws.bufferedAmount : -1), tunnelClosed: () => (lastTunnel ? !!lastTunnel.closed : false), tunnelPending: () => (lastTunnel ? lastTunnel.pending.size : -1), tunnelPendingBytes: () => (lastTunnel ? lastTunnel.bytes() : -1),
  // tests shrink the budgets so the idle/rate/queue/flood paths are reachable
  setTunables(o) { if (o.wsIdleMs !== undefined) WS_IDLE_MS = o.wsIdleMs; if (o.wsQueueCap !== undefined) WS_QUEUE_CAP = o.wsQueueCap; if (o.tunnelHardCap !== undefined) TUNNEL_HARD_CAP = o.tunnelHardCap; if (o.wsRatePerSec !== undefined) WS_RATE_PER_SEC = o.wsRatePerSec; },
} : undefined;

function frame(id, type, payload) {
  const h = Buffer.alloc(5); h.writeUInt32BE(id, 0); h[4] = type;
  return payload ? Buffer.concat([h, payload]) : h;
}

export function pwsUpgrade(req, socket, head, user, track) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    const active = new Map(); // id -> entry
    // every frame - data, headers, errors - counts against one shared hard
    // queue bound, checked PROSPECTIVELY: a flooded tunnel sheds the stream,
    // never the socket
    const out = (id, type, payload, entry) => {
      if (tunnelDead || ws.readyState !== 1) return false;
      // terminal frames (end/error) get a small bounded budget PAST the hard
      // cap: a shed stream still tells the client why instead of orphaning it
      const cap = (type === 2 || type === 3) ? TUNNEL_HARD_CAP + 65536 : TUNNEL_HARD_CAP;
      if (ws.bufferedAmount + (payload ? payload.length : 0) + 5 > cap) {
        if (entry && type !== 2 && type !== 3) { destroyEntry(id, entry, 'busy'); return false; }
        // a terminal even the saturated reserve cannot take is NOT dropped:
        // it joins the ONE bounded pending-terminal queue below, never an
        // unbounded off-buffer retry chain
        if (type === 2 || type === 3) { queueTerminal(id, type, payload); return true; }
        return false;
      }
      try { ws.send(frame(id, type, payload)); } catch {
        // a send that fails outright: terminals stay bounded-pending, streams shed
        if (type === 2 || type === 3) { queueTerminal(id, type, payload); return true; }
        if (entry) destroyEntry(id, entry, 'busy');
        return false;
      }
      return true;
    };
    // pending terminals: ONE bounded, deduped queue per tunnel with a single
    // drain timer. one outstanding outcome per stream id, count- and
    // byte-capped overall; each entry carries the ~10s delivery deadline. a
    // tunnel that overflows even this bounded queue - or cannot deliver an
    // outcome within its deadline, or fails a send after queue-fit - is
    // closed outright: the client's socket-close path settles every pend, so
    // no stream hangs on a lost end/error and no arbitrary timers/bytes
    // accumulate off-buffer
    const PENDING_MAX = 64, PENDING_MAX_BYTES = 256 * 1024, TERMINAL_TRIES = 100;
    const pendingTerminal = new Map(); // id -> { type, payload, bytes, left }
    let pendingBytes = 0, drainTimer = null, tunnelDead = false;
    const clearPending = () => { pendingTerminal.clear(); pendingBytes = 0; if (drainTimer) { if (typeof clearTimeout === 'function') clearTimeout(drainTimer); drainTimer = null; } };
    const closeTunnel = () => { tunnelDead = true; clearPending(); try { ws.terminate(); } catch {} };
    const drainPending = () => {
      drainTimer = null;
      if (ws.readyState !== 1) { clearPending(); return; }
      for (const [id, t] of pendingTerminal) {
        if (ws.bufferedAmount + t.bytes > TUNNEL_HARD_CAP + 65536) { if (--t.left <= 0) { closeTunnel(); return; } continue; }
        try { ws.send(frame(id, t.type, t.payload)); } catch { closeTunnel(); return; }
        pendingTerminal.delete(id); pendingBytes -= t.bytes;
      }
      if (pendingTerminal.size && typeof setTimeout === 'function') drainTimer = setTimeout(drainPending, 100);
    };
    const queueTerminal = (id, type, payload) => {
      if (pendingTerminal.has(id)) return; // one outstanding outcome per stream
      const bytes = (payload ? payload.length : 0) + 5;
      if (pendingTerminal.size >= PENDING_MAX || pendingBytes + bytes > PENDING_MAX_BYTES || typeof setTimeout !== 'function') { closeTunnel(); return; }
      pendingTerminal.set(id, { type, payload, bytes, left: TERMINAL_TRIES });
      pendingBytes += bytes;
      if (!drainTimer) drainTimer = setTimeout(drainPending, 100);
    };
    // an id with an undelivered terminal is still taken: reject the reuse,
    // and the rejection supersedes the stale queued outcome for that id
    const rejectIdReuse = (id) => {
      const t = pendingTerminal.get(id);
      if (t) { pendingTerminal.delete(id); pendingBytes -= t.bytes; }
      return out(id, 3, Buffer.from('id in use'));
    };
    // after the queue declarations: no TDZ. typeof-guarded so sliced review extracts run bare
    if (typeof TEST_HOOKS !== 'undefined' && TEST_HOOKS) {
      lastTunnel = { ws, pending: pendingTerminal, bytes: () => pendingBytes, closed: false };
      ws.on('close', () => { if (lastTunnel && lastTunnel.ws === ws) lastTunnel.closed = true; });
    }
    // full teardown, idempotent and entry-checked: decompressor + upstream +
    // every timer + the capture budget all die together, exactly once
    const destroyEntry = (id, entry, msg, code, reason) => {
      if (active.get(id) !== entry) return;
      clearTimeout(entry.wall);
      clearTimeout(entry.life);
      if (entry.bp) { clearInterval(entry.bp); entry.bp = null; }
      if (entry.collecting) { acCollectingBytes -= entry.collected; entry.collecting = false; entry.collected = 0; }
      if (entry.ws) userWsActive.set(user, (userWsActive.get(user) || 1) - 1);
      try { entry.src?.destroy(); } catch {}
      try { if (entry.up) entry.up.destroy ? entry.up.destroy() : entry.up.terminate(); } catch {}
      active.delete(id); upstreamActive--;
      if (msg) out(id, 3, Buffer.from(msg));
      else if (entry.ws) out(id, 2, Buffer.from(JSON.stringify({ code: code ?? 1006, reason: String(reason ?? '') })));
    };
    const busy = (id) => out(id, 3, Buffer.from('busy'));
    // pause a source while the tunnel is backed up; cleared by destroyEntry
    const backpressure = (entry, pause, resume) => {
      if (ws.bufferedAmount <= 4e6 || entry.bp) return;
      try { pause(); } catch {}
      entry.bp = setInterval(() => {
        if (ws.bufferedAmount < 1e6 || ws.readyState !== 1) { clearInterval(entry.bp); entry.bp = null; try { resume(); } catch {} }
      }, 20);
    };
    const rateOk = (entry) => {
      const now = Date.now();
      if (now >= entry.msgReset) { entry.msgN = 0; entry.msgReset = now + 1000; }
      return ++entry.msgN <= WS_RATE_PER_SEC;
    };
    ws.on('message', (m) => {
      let id = 0;
      try {
        let spec;
        try { spec = JSON.parse(m.toString('utf8')); } catch { return; }
        // only a real JSON number is a stream id: '1', true and [1] are junk
        if (typeof spec.id !== 'number' || !Number.isInteger(spec.id) || spec.id <= 0 || spec.id > 0xffffffff) return;
        id = spec.id;
        if (spec.cancel) { const entry = active.get(id); if (entry) destroyEntry(id, entry, null); return; }
        if (spec.ws !== undefined) {
          // proxied websocket: relayed over this same multiplexed socket so the
          // page needs no second connection. same net-safe guardrails, shared
          // stream budget, both directions metered and budgeted.
          if (active.has(id) || pendingTerminal.has(id)) return rejectIdReuse(id);
          let u;
          try { u = new URL(String(spec.ws)); } catch { return out(id, 3, Buffer.from('url')); }
          if ((u.protocol !== 'ws:' && u.protocol !== 'wss:') || u.username || u.password) return out(id, 3, Buffer.from('url'));
          const bt = badTarget(u);
          if (bt) return out(id, 3, Buffer.from(bt));
          if (active.size >= AC_MAX_CONN_STREAMS || upstreamActive >= AC_MAX_GLOBAL_STREAMS) return busy(id);
          if ((userWsActive.get(user) || 0) >= WS_MAX_PER_USER) return busy(id);
          const headers = {};
          for (const h of Array.isArray(spec.headers) ? spec.headers : []) {
            if (!Array.isArray(h) || h.length < 2) continue;
            const lk = String(h[0]).toLowerCase();
            if (DROP_REQ.has(lk) || lk.startsWith('sec-websocket-')) continue;
            headers[lk] = headers[lk] ? headers[lk] + (lk === 'cookie' ? '; ' : ', ') + String(h[1]) : String(h[1]);
          }
          upstreamActive++;
          const entry = { up: null, src: null, wall: null, life: null, bp: null, ws: true, collecting: false, collected: 0, chunks: [], bytes: 0, msgN: 0, msgReset: 0 };
          active.set(id, entry);
          userWsActive.set(user, (userWsActive.get(user) || 0) + 1);
          let upWs;
          try {
            upWs = new WSClient(u.href, Array.isArray(spec.protocols) && spec.protocols.length ? spec.protocols.map(String) : undefined, {
              headers, lookup: safeLookup, handshakeTimeout: 30000, maxPayload: 16 * 1024 * 1024,
            });
          } catch { destroyEntry(id, entry, 'url'); return; }
          entry.up = upWs;
          // the idle wall watches BOTH directions: any relayed traffic,
          // including upstream keepalive ping/pong, proves liveness
          entry.touch = () => { if (active.get(id) !== entry) return; clearTimeout(entry.wall); entry.wall = setTimeout(() => destroyEntry(id, entry, 'idle'), WS_IDLE_MS); };
          entry.touch();
          entry.life = setTimeout(() => destroyEntry(id, entry, 'lifetime'), WS_MAX_MS);
          // control frames are traffic too: they spend the same rate/byte
          // budget as messages, or a ping flood is a free bypass
          const ctl = (d) => {
            entry.touch();
            if (active.get(id) !== entry) return;
            entry.bytes += d.length;
            if (entry.bytes > WS_MAX_BYTES || !rateOk(entry)) destroyEntry(id, entry, entry.bytes > WS_MAX_BYTES ? 'too big' : 'rate');
          };
          upWs.on('open', () => {
            if (active.get(id) !== entry) return;
            if (!out(id, 0, Buffer.from(JSON.stringify({ status: 101, text: 'Switching Protocols', protocol: upWs.protocol || '', headers: [] })), entry)) return;
          });
          upWs.on('message', (data, isBinary) => {
            if (active.get(id) !== entry) return;
            entry.touch();
            if (!rateOk(entry)) return destroyEntry(id, entry, 'rate');
            entry.bytes += data.length;
            if (entry.bytes > WS_MAX_BYTES) return destroyEntry(id, entry, 'too big');
            track(data.length);
            out(id, 1, Buffer.concat([Buffer.from([isBinary ? 1 : 0]), Buffer.from(data)]), entry);
            backpressure(entry, () => upWs.pause(), () => upWs.resume());
          });
          upWs.on('ping', ctl);
          upWs.on('pong', ctl);
          upWs.on('close', (code, reason) => destroyEntry(id, entry, null, code, reason));
          upWs.on('error', () => {}); // close always follows an error; teardown happens there
          return;
        }
        if (spec.wssend !== undefined) {
          const entry = active.get(id);
          if (!entry || !entry.ws || !entry.up || entry.up.readyState !== 1) return;
          entry.touch(); // outbound traffic proves liveness too
          if (!rateOk(entry)) return destroyEntry(id, entry, 'rate');
          const buf = Buffer.from(String(spec.wssend), 'base64');
          entry.bytes += buf.length;
          if (entry.bytes > WS_MAX_BYTES) return destroyEntry(id, entry, 'too big');
          // prospective: queued PLUS this message must stay under the cap, so
          // one 24MB decoded message can never land on an already-full queue
          if (entry.up.bufferedAmount + buf.length > WS_QUEUE_CAP) return destroyEntry(id, entry, 'busy');
          track(buf.length);
          entry.up.send(spec.text ? buf.toString('utf8') : buf);
          return;
        }
        if (spec.wsclose !== undefined) {
          const entry = active.get(id);
          if (entry && entry.ws && entry.up) {
            try { entry.up.close(Number(spec.wsclose.code) || 1000, String(spec.wsclose.reason || '').slice(0, 120)); }
            catch { try { entry.up.terminate(); } catch {} }
          }
          return;
        }
        if (active.has(id) || pendingTerminal.has(id)) return rejectIdReuse(id);
        let u;
        try { u = new URL(String(spec.url)); } catch { return out(id, 3, Buffer.from('url')); }
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return out(id, 3, Buffer.from('url'));
        const bt = badTarget(u);
        if (bt) return out(id, 3, Buffer.from(bt));
        if (spec.ab !== false && isAdHost(u.hostname)) { adStats.blocked++; adStats.byUser[user] = (adStats.byUser[user] || 0) + 1; return out(id, 3, Buffer.from('adblock')); }
        const headers = {};
        let clientAE = null;
        for (const h of Array.isArray(spec.headers) ? spec.headers : []) {
          if (!Array.isArray(h) || h.length < 2) continue;
          const lk = String(h[0]).toLowerCase();
          if (lk === 'accept-encoding') clientAE = (clientAE ? clientAE + ',' : '') + String(h[1]);
          if (DROP_REQ.has(lk)) continue;
          headers[lk] = headers[lk] ? headers[lk] + (lk === 'cookie' ? '; ' : ', ') + String(h[1]) : String(h[1]);
        }
        const method = String(spec.method || 'GET').toUpperCase();
        if (!/^[A-Z][A-Z0-9_-]*$/.test(method)) return out(id, 3, Buffer.from('method'));
        // eligibility is judged on the CLIENT's header set, before we add our own
        const cacheKey = acReqKey(method, u.href, headers, !!spec.body, clientAE);
        headers['accept-encoding'] = 'gzip, br, identity;q=0';
        const body = spec.body ? Buffer.from(String(spec.body), 'base64') : null;
        if (body) headers['content-length'] = body.length;
        if (active.size >= AC_MAX_CONN_STREAMS || upstreamActive >= AC_MAX_GLOBAL_STREAMS) return busy(id);
        if (cacheKey) {
          const hit = acGet(cacheKey);
          if (hit) {
            // a cache hit occupies the tunnel like any stream: it takes a
            // concurrency slot, a wall clock, and the same backpressure gate
            upstreamActive++;
            const entry = { up: null, src: null, wall: setTimeout(() => destroyEntry(id, entry, 'timed out'), AC_WALL_MS), life: null, bp: null, ws: false, collecting: false, collected: 0, chunks: [], bytes: 0, msgN: 0, msgReset: 0 };
            active.set(id, entry);
            // a hit's Age is measured from the response's estimated birth:
            // upstream Age + apparent age + OUR OWN download time all count,
            // and the served max-age shrinks to what the entry has left
            const ageSec = Math.max(0, Math.floor((Date.now() - hit.bornAt) / 1000));
            const remainSec = Math.max(0, Math.floor((hit.exp - Date.now()) / 1000));
            const hHeaders = hit.headers.map(([k, v]) => k.toLowerCase() === 'cache-control' ? [k, String(v).replace(/((?:s-maxage|max-age)=)\d+/g, '$1' + remainSec)] : [k, v]);
            hHeaders.push(['age', String(ageSec)]);
            if (!out(id, 0, Buffer.from(JSON.stringify({ status: hit.status, text: hit.text, headers: hHeaders })), entry)) return;
            let off = 0;
            const pump = () => {
              if (active.get(id) !== entry) return;
              if (ws.bufferedAmount > 4e6) {
                entry.bp = setInterval(() => { if (active.get(id) !== entry || ws.bufferedAmount < 1e6 || ws.readyState !== 1) { if (entry.bp) { clearInterval(entry.bp); entry.bp = null; } pump(); } }, 20);
                return;
              }
              const c = hit.body.subarray(off, off + AC_FRAME); off += c.length;
              track(c.length); if (!out(id, 1, c, entry)) return;
              if (off < hit.body.length) setImmediate(pump);
              else { out(id, 2, undefined, entry); destroyEntry(id, entry, null); }
            };
            pump();
            return;
          }
        }
        const lib = u.protocol === 'https:' ? https : http;
        upstreamActive++;
        const entry = { up: null, src: null, wall: null, life: null, bp: null, ws: false, collecting: false, collected: 0, chunks: [], bytes: 0, msgN: 0, msgReset: 0, cacheExp: 0 };
        active.set(id, entry);
        // one wall-clock abort per proxied request: a stalled or trickling
        // upstream (or a slow-motion decompressor) can never outlive it
        entry.wall = setTimeout(() => { destroyEntry(id, entry, 'timed out'); }, AC_WALL_MS);
        let up;
        try {
          up = lib.request({
            protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
            method, headers, agent: agents[u.protocol], lookup: safeLookup, timeout: 30000,
          }, (ur) => {
            if (active.get(id) !== entry) return;
            const raw = [];
            for (let i = 0; i < ur.rawHeaders.length; i += 2) raw.push([ur.rawHeaders[i], ur.rawHeaders[i + 1]]);
            const enc = String(ur.headers['content-encoding'] || '').toLowerCase();
            // the tunnel carries plain bytes: an encoding we cannot decode is
            // refused outright, never forwarded silently stripped
            if (enc && enc !== 'gzip' && enc !== 'br' && enc !== 'deflate' && enc !== 'identity') { destroyEntry(id, entry, 'encoding'); return; }
            let src = ur;
            if (enc === 'gzip' || enc === 'br' || enc === 'deflate') {
              src = ur.pipe(enc === 'br' ? zlib.createBrotliDecompress() : enc === 'gzip' ? zlib.createGunzip() : zlib.createInflate());
              ur.on('error', () => src.destroy());
            }
            entry.src = src;
            const keep = raw.filter(([k]) => !HOP.has(k.toLowerCase()));
            if (!out(id, 0, Buffer.from(JSON.stringify({ status: ur.statusCode, text: ur.statusMessage || '', headers: keep })), entry)) return; // shed at the head: never wire up listeners on a destroyed entry
            const fresh = cacheKey ? acFresh(ur.statusCode, keep) : null;
            // freshness starts at headers time: the download's own duration
            // counts against it, and the corrected initial age (upstream Age
            // plus apparent age) is preserved so hits report a true Age
            entry.cacheExp = fresh ? Date.now() + fresh.ttlMs : 0;
            // estimated response birth at HEADERS time: the download's own
            // duration then counts toward the age automatically
            entry.bornAt = fresh ? Date.now() - fresh.ageMs : 0;
            entry.maxAgeSec = fresh ? fresh.maxAgeSec : 0;
            entry.collecting = !!fresh;
            const expected = Number(ur.headers['content-length']) || 0;
            let wire = 0;
            ur.on('data', (c) => { wire += c.length; }); // wire bytes: capped, and checked against content-length at end
            let decoded = 0;
            src.on('data', (c) => {
              if (active.get(id) !== entry) return;
              decoded += c.length;
              if (decoded > AC_MAX_DECODE || wire > AC_MAX_DECODE) { // decompression bomb / flood: refuse, never stream unbounded
                destroyEntry(id, entry, 'too big');
                return;
              }
              track(c.length); if (!out(id, 1, c, entry)) return;
              if (entry.collecting) {
                // a capped per-item buffer, and in-flight captures share the
                // same global budget as stored items; released exactly once,
                // on every exit path, by destroyEntry
                const n = entry.collected + c.length;
                if (n > AC_MAX_ITEM || acBytes + acCollectingBytes + c.length > AC_MAX_BYTES) { entry.collecting = false; acCollectingBytes -= entry.collected; entry.collected = 0; entry.chunks.length = 0; }
                else { entry.chunks.push(c); entry.collected = n; acCollectingBytes += c.length; }
              }
              backpressure(entry, () => src.pause(), () => src.resume());
            });
            src.on('end', () => {
              if (active.get(id) !== entry) return;
              // completeness: a truncated upstream (declared content-length never
              // arrived) is an error for the page and must never enter the cache
              if (method !== 'HEAD' && ur.statusCode !== 204 && ur.statusCode !== 304 && expected && wire !== expected) { destroyEntry(id, entry, 'truncated'); return; }
              if (entry.collecting && entry.cacheExp > Date.now()) acPut(cacheKey, ur.statusCode, ur.statusMessage || '', keep, Buffer.concat(entry.chunks), entry.cacheExp, entry.bornAt, entry.maxAgeSec);
              out(id, 2, undefined, entry);
              destroyEntry(id, entry, null);
            });
            src.on('error', () => { if (active.get(id) !== entry) return; destroyEntry(id, entry, 'stream'); });
          });
        } catch (e) { destroyEntry(id, entry, 'request'); return; }
        entry.up = up;
        up.on('timeout', () => up.destroy(new Error('timeout')));
        up.on('error', (e) => { if (active.get(id) === entry) destroyEntry(id, entry, String(e.message || 'upstream').slice(0, 80)); });
        if (body) up.end(body); else up.end();
      } catch (e) {
        try { if (id) out(id, 3, Buffer.from('bad')); } catch {}
      }
    });
    // error and close get the SAME full teardown: dead flag, pending queue,
    // every active entry - an error is never a lesser event than a close.
    // close always follows an error on ws; both passes are idempotent
    const teardownAll = () => { tunnelDead = true; clearPending(); for (const [id, entry] of active) destroyEntry(id, entry, null); };
    ws.on('close', teardownAll);
    ws.on('error', teardownAll);
  });
}
