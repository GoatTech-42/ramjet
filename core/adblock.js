import { dataPath } from './data.js';
// proxy-level ad + tracker blocking. the browser engine opens
// every site through the wisp pipe, so refusing the connection to a known ad
// host fails the request in one step - no extra TLS handshake, no bytes,
// nothing to rewrite. hostlist = Peter Lowe's list (free, ads + trackers only,
// no cdn/functional hosts) plus a few extras, refreshed weekly in the
// background. matches the host or any parent domain of it.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const FILE = dataPath('adblock-hosts.txt');

// raw GET with redirect follow under ONE monotonic absolute deadline shared
// by every redirect hop and the body. node:http's own timeout is socket
// inactivity, not a wall clock - a 1-byte-per-20ms trickle defeats it (r15
// review repro: a claimed 40ms budget completed in 313ms), and a per-hop
// budget resets on every redirect. on expiry the in-flight request and
// response are destroyed. deliberately not global fetch: an abort timer
// landing mid-body can crash the process inside undici's paused-parser
// assertion (observed as a post-test uncaughtException); a destroyed
// node:http request is plain cleanup.
// settle must leave nothing behind: the deadline timer is cleared and every
// non-final response is DESTROYED, not resumed. res.resume() on a redirect or
// an error status lets a slow body trickle after settle, pinning its socket
// open with the shared deadline already gone (r16 review: a slow redirect
// body and a trickled 404 each leaked one upstream socket+timer).
let liveTimers = 0;
function getText(srcUrl, ms, state) {
  return new Promise((resolve, reject) => {
    if (!state) {
      state = { hops: 0, req: null, res: null, settled: false, timer: null };
      const wrap = (fn) => (v) => { if (state.settled) return; state.settled = true; clearTimeout(state.timer); liveTimers--; fn(v); };
      resolve = wrap(resolve); reject = wrap(reject);
      liveTimers++;
      state.timer = setTimeout(() => {
        try { state.res?.destroy(); } catch {}
        try { state.req?.destroy(new Error('deadline')); } catch {}
        reject(new Error('deadline'));
      }, ms);
      state.timer.unref?.();
    }
    if (state.settled) return;
    let mod;
    try {
      const proto = new URL(srcUrl).protocol;
      // anything but http(s) (ftp:, file:, ...) must reject here: a sync
      // throw from mod.get inside the executor would bypass the wrapped
      // reject and leave the deadline timer hanging (Sage r17 probe)
      if (proto !== 'https:' && proto !== 'http:') throw new Error('bad url');
      mod = proto === 'https:' ? https : http;
    } catch { return reject(new Error('bad url')); }
    // agent: false - node 22's globalAgent pools keep-alive sockets for 5s,
    // which would pin a connection open past settle on EVERY path. one-off
    // list downloads do not need reuse; close at completion instead.
    let req;
    try {
      req = mod.get(srcUrl, { agent: false, headers: { 'user-agent': 'ramjet-adblock-refresh' } }, (res) => {
      state.res = res;
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && state.hops < 3) {
        res.destroy(); // the body is never read; do not let it hold the socket
        state.hops++;
        // a hostile/garbled Location (http://[ ...) throws synchronously here -
        // inside the response callback an uncaught throw takes the process
        // down. reject like any other upstream failure.
        let next;
        try { next = new URL(res.headers.location, srcUrl).href; }
        catch { return reject(new Error('bad redirect location')); }
        getText(next, ms, state).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.destroy(); return reject(new Error('status ' + res.statusCode)); }
      const chunks = [];
      let n = 0;
      res.on('data', (c) => {
        n += c.length;
        if (n > 16 * 1024 * 1024) {
          // reject explicitly: once the response headers arrived the request
          // is complete and destroying it emits no 'error' - without this the
          // promise hung to the deadline and reported the wrong cause (Sage
          // r16b oversize repro)
          try { res.destroy(); } catch {}
          try { req.destroy(); } catch {}
          reject(new Error('too big'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    } catch (e) { return reject(e); }
    state.req = req;
    req.on('error', reject);
  });
}

const SRC = 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext';
const EXTRA = ['ads.pubmatic.com', 'securepubads.g.doubleclick.net', 'doubleclick.net', 'adsystem.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'adnxs.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'scorecardresearch.com', 'quantserve.com', 'moatads.com', 'adsrvr.org', 'adform.net', 'smartadserver.com', 'media.net', 'pubmatic.com', 'zedo.com', 'advertising.com', 'yieldmo.com', 'sharethrough.com', 'teads.tv', 'connatix.com', 'hotjar.com', 'fullstory.com', 'mixpanel.com', 'segment.io', 'branch.io', 'app-measurement.com', 'ads-twitter.com', 'analytics.tiktok.com', 'ads.linkedin.com'];
// never block these even if a list ever grows to include them
const SAFE = new Set(['google.com', 'gstatic.com', 'googleapis.com', 'youtube.com', 'ytimg.com', 'cloudflare.com', 'cloudfront.net', 'jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'github.com', 'githubusercontent.com', 'wikipedia.org', 'wikimedia.org', 'reddit.com', 'redd.it', 'redditstatic.com', 'redditmedia.com']);

const UBO_FILE = dataPath('ubo-hosts.txt');
// uBlock Origin's own default lists: pure domain rules only
// (||host^ with no path or context options), so it is safe at the socket layer.
const UBO = ['https://ublockorigin.github.io/uAssets/filters/filters.min.txt', 'https://ublockorigin.github.io/uAssets/filters/badware.min.txt', 'https://ublockorigin.github.io/uAssets/filters/privacy.min.txt', 'https://easylist.to/easylist/easylist.txt', 'https://easylist.to/easylist/easyprivacy.txt'];
function parseUbo(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    const m = line.trim().toLowerCase().match(/^\|\|([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\^(?:\$(?:third-party|3p|all|important)(?:,(?:third-party|3p|all|important))*)?$/);
    if (m && !SAFE.has(m[1])) out.add(m[1]);
  }
  return out;
}
let hosts = new Set();
function parse(text) {
  const s = new Set(EXTRA);
  for (const line of text.split('\n')) {
    const h = line.trim().toLowerCase();
    if (!h || h.startsWith('#') || !/^[a-z0-9.-]+$/.test(h) || SAFE.has(h)) continue;
    s.add(h);
  }
  return s;
}
try { hosts = parse(existsSync(FILE) ? readFileSync(FILE, 'utf8') : ''); } catch { hosts = parse(''); }
try { if (existsSync(UBO_FILE)) for (const h of readFileSync(UBO_FILE, 'utf8').split('\n')) if (h && !SAFE.has(h)) hosts.add(h); } catch {}
// single-flight: a refresh already in flight owns the pass; concurrent
// callers (boot + 12h tick + any overlapping trigger) share its promise
// instead of piling on duplicate upstream requests and deadline timers
// (r16 review: 14 concurrent refreshes = 14 in-flight upstreams, timers 18->30)
let uboFlight = null;
function refreshUbo(urls = UBO) {
  if (!uboFlight) uboFlight = refreshUboOnce(urls).finally(() => { uboFlight = null; });
  return uboFlight;
}
async function refreshUboOnce(urls) {
  try {
    if (existsSync(UBO_FILE) && Date.now() - statSync(UBO_FILE).mtimeMs < 2 * 86400e3) return;
    const all = new Set();
    for (const u of urls) { try { for (const h of parseUbo(await getText(u, 30000))) all.add(h); } catch {} }
    if (all.size < 5000) return;
    writeFileSync(UBO_FILE, [...all].join('\n'));
    for (const h of all) hosts.add(h);
    console.log(`[adblock] uBlock Origin lists loaded: ${all.size} hosts, ${hosts.size} total`);
  } catch {}
}
// unit tests must be hermetic: no live blocklist downloads under node --test
// (the runner sets NODE_TEST_CONTEXT in every test-file process). the static
// EXTRA/SAFE sets keep isAdHost deterministic offline.
const IN_TESTS = !!process.env.NODE_TEST_CONTEXT;
if (!IN_TESTS) refreshUbo();
if (!IN_TESTS) setInterval(refreshUbo, 12 * 3600e3).unref();

let refreshFlight = null;
function refresh(srcUrl = SRC) {
  if (!refreshFlight) refreshFlight = refreshOnce(srcUrl).finally(() => { refreshFlight = null; });
  return refreshFlight;
}
async function refreshOnce(srcUrl) {
  try {
    if (existsSync(FILE) && Date.now() - statSync(FILE).mtimeMs < 7 * 86400e3) return;
    const t = await getText(srcUrl, 20000);
    const next = parse(t);
    if (next.size < 1000) return;
    writeFileSync(FILE, t);
    hosts = next;
    console.log(`[adblock] list refreshed: ${hosts.size} hosts`);
  } catch {}
}
if (!IN_TESTS) refresh();
if (!IN_TESTS) setInterval(refresh, 12 * 3600e3).unref();

const TEST_HOOKS = process.env.RJ_TEST_HOOKS === '1'; // loopback list servers in tests, never in production
export const testHooks = TEST_HOOKS ? { getText, refresh, refreshUbo, files: () => ({ FILE, UBO_FILE }), timers: () => liveTimers } : null;

export function isAdHost(host) {
  let h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || /^[\d.:]+$/.test(h)) return false;
  for (;;) {
    if (SAFE.has(h)) return false;
    if (hosts.has(h)) return true;
    const i = h.indexOf('.');
    if (i < 0) return false;
    h = h.slice(i + 1);
    if (!h.includes('.')) return false;
  }
}

export const stats = { blocked: 0, byUser: {}, recent: [] };
export function listSize() { return hosts.size; }

// socket class handed to wisp for connections that have blocking on
export function makeBlockingSocket(NodeTCPSocket, user) {
  return class BlockingTCPSocket extends NodeTCPSocket {
    async connect() {
      if (isAdHost(this.hostname)) {
        stats.blocked++;
        stats.byUser[user] = (stats.byUser[user] || 0) + 1;
        stats.recent.push(this.hostname); if (stats.recent.length > 200) stats.recent.shift();
        throw new Error('adblock');
      }
      return super.connect();
    }
  };
}
