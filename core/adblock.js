// proxy-level ad + tracker blocking (Luke 7:59 PM). the browser engine opens
// every site through the wisp pipe, so refusing the connection to a known ad
// host fails the request in one step - no extra TLS handshake, no bytes,
// nothing to rewrite. hostlist = Peter Lowe's list (free, ads + trackers only,
// no cdn/functional hosts) plus a few extras, refreshed weekly in the
// background. matches the host or any parent domain of it.

import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';

const FILE = fileURLToPath(new URL('../data/adblock-hosts.txt', import.meta.url));
const SRC = 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext';
const EXTRA = ['ads.pubmatic.com', 'securepubads.g.doubleclick.net', 'doubleclick.net', 'adsystem.com', 'amazon-adsystem.com', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'adnxs.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'scorecardresearch.com', 'quantserve.com', 'moatads.com', 'adsrvr.org', 'adform.net', 'smartadserver.com', 'media.net', 'pubmatic.com', 'zedo.com', 'advertising.com', 'yieldmo.com', 'sharethrough.com', 'teads.tv', 'connatix.com', 'hotjar.com', 'fullstory.com', 'mixpanel.com', 'segment.io', 'branch.io', 'app-measurement.com', 'ads-twitter.com', 'analytics.tiktok.com', 'ads.linkedin.com'];
// never block these even if a list ever grows to include them
const SAFE = new Set(['google.com', 'gstatic.com', 'googleapis.com', 'youtube.com', 'ytimg.com', 'cloudflare.com', 'cloudfront.net', 'jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com', 'github.com', 'githubusercontent.com', 'wikipedia.org', 'wikimedia.org', 'reddit.com', 'redd.it', 'redditstatic.com', 'redditmedia.com']);

const UBO_FILE = fileURLToPath(new URL('../data/ubo-hosts.txt', import.meta.url));
// uBlock Origin's own default lists (Luke 6:01 PM): pure domain rules only
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
async function refreshUbo() {
  try {
    if (existsSync(UBO_FILE) && Date.now() - statSync(UBO_FILE).mtimeMs < 2 * 86400e3) return;
    const all = new Set();
    for (const u of UBO) { try { const r = await fetch(u, { signal: AbortSignal.timeout(30000) }); if (r.ok) for (const h of parseUbo(await r.text())) all.add(h); } catch {} }
    if (all.size < 5000) return;
    writeFileSync(UBO_FILE, [...all].join('\n'));
    for (const h of all) hosts.add(h);
    console.log(`[adblock] uBlock Origin lists loaded: ${all.size} hosts, ${hosts.size} total`);
  } catch {}
}
refreshUbo();
setInterval(refreshUbo, 12 * 3600e3).unref();

async function refresh() {
  try {
    if (existsSync(FILE) && Date.now() - statSync(FILE).mtimeMs < 7 * 86400e3) return;
    const r = await fetch(SRC, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return;
    const t = await r.text();
    const next = parse(t);
    if (next.size < 1000) return;
    writeFileSync(FILE, t);
    hosts = next;
    console.log(`[adblock] list refreshed: ${hosts.size} hosts`);
  } catch {}
}
refresh();
setInterval(refresh, 12 * 3600e3).unref();

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
