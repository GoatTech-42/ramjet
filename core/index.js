import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { Auth } from './auth.js';
import { Guard } from './guard.js';
import { readJson as rjRead, writeJson as rjWrite } from './util.js';
import { readBody, sendJson, redirect, parseCookies, clientIp } from './util.js';
import { server as wisp } from '@mercuryworkshop/wisp-js';
import { readerPage } from './reader.js';
import { handlePFetch, pwsUpgrade, safeLookup } from './pfetch.js';
import { makeBlockingSocket, stats as adStats, listSize as adListSize } from './adblock.js';
const { NodeTCPSocket } = await import(new URL('../node_modules/@mercuryworkshop/wisp-js/src/server/net.mjs', import.meta.url).href);
wisp.options.dns_result_order = 'ipv4first'; // the box has no ipv6 route
import { randomBytes } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants as zc } from 'node:zlib';

// short-lived, user-bound tickets so the wisp websocket upgrade authenticates
// even when a browser (looking at you, iOS Safari) withholds cookies on the
// upgrade request. minted by /api/wisp-ticket, expire after 90s.
const wispTickets = new Map();

const HOST = process.env.RJ_HOST || '127.0.0.1';
const PORT = Number(process.env.RJ_PORT || 14224);
let sysCache = null;
const SYS_VERSION = (() => { try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '2'; } })();
const DATA = process.env.RJ_DATA || new URL('../data', import.meta.url).pathname;
const DIST = new URL('../web/dist', import.meta.url).pathname;
const ADDONS = new URL('./addons', import.meta.url).pathname;

const auth = new Auth(DATA);
const guard = new Guard(DATA);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.json': 'application/json', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8',
};

function page(name) {
  const p = join(DIST, 'pages', name, `${name}.html`);
  return existsSync(p) ? readFileSync(p) : null;
}
function servePage(res, name, status = 200) {
  const html = page(name);
  if (!html) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('building... check back in a minute'); return; }
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(html);
}
// static files are compressed once (brotli, else gzip) and kept in memory:
// the engine wasm and js are several MB and every byte crosses the tunnel.
const zCache = new Map();
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.wasm', '.map']);
function serveStatic(res, urlPath) {
  const safe = resolve(DIST, '.' + urlPath);
  if (!safe.startsWith(DIST) || !existsSync(safe) || !statSync(safe).isFile()) return false;
  const ext = extname(safe);
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': urlPath.startsWith('/cloak/') || /^\/(browse-sw\.js|scramjet\/|controller\/|epoxy\/|libcurl\/)/.test(urlPath) ? 'no-cache' : 'public, max-age=31536000, immutable',
  };
  let body = readFileSync(safe);
  if (COMPRESSIBLE.has(ext) && body.length > 1024) {
    headers.vary = 'Accept-Encoding';
    const ae = String(res.req?.headers?.['accept-encoding'] || '');
    const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : '';
    if (enc) {
      const k = enc + ':' + safe + ':' + body.length;
      let z = zCache.get(k);
      if (!z) {
        z = enc === 'br'
          ? brotliCompressSync(body, { params: { [zc.BROTLI_PARAM_QUALITY]: 6, [zc.BROTLI_PARAM_SIZE_HINT]: body.length } })
          : gzipSync(body, { level: 9 });
        zCache.set(k, z);
      }
      body = z; headers['content-encoding'] = enc;
    }
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(body);
  return true;
}

// addon apps: core/addons/<name>/index.js exports register(ctx)
const addons = new Map();
if (existsSync(ADDONS)) {
  for (const name of readdirSync(ADDONS)) {
    const entry = join(ADDONS, name, 'index.js');
    if (!existsSync(entry)) continue;
    try {
      const mod = await import(entry);
      if (typeof mod.register === 'function') addons.set(name, mod.register);
    } catch (e) { console.error(`addon ${name} failed to load:`, e.message); }
  }
}


// -- /searx/* : ramjet's own search page (Luke 9:17 PM - rebrand: reads as
// ramjet's, no stock search chrome). The dockerized engine on loopback does
// the fetching; this route renders ramjet-styled results from its JSON API.
// Same-origin with browse, so result clicks message up and re-enter the proxy.
const SEARX_UPSTREAM = 'http://127.0.0.1:8888';

function sxEsc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function sxHref(u) {
	u = String(u || '');
	return /^https?:\/\//i.test(u) ? u : '';
}
function sxCrumb(u) {
	try {
		const p = new URL(u);
		const bits = p.pathname.split('/').filter(Boolean).slice(0, 3).map((b) => { try { return decodeURIComponent(b); } catch { return b; } });
		return sxEsc(p.host) + (bits.length ? ' &rsaquo; ' + bits.map(sxEsc).join(' &rsaquo; ') : '');
	} catch { return sxEsc(u); }
}
// search speed: a 5-minute result cache (repeat searches, back button, page
// reloads answer from memory) and general searches pinned to the two engines
// that actually return results - searxng's default fan-out spends ~0.3s more
// waiting on engines that are suspended or slow.
const SX_CACHE = new Map();
const SX_TTL = 5 * 60 * 1000;
async function sxFetch(query, page, cat, safe) {
	const key = [query.toLowerCase(), page, cat, safe].join('|');
	const hit = SX_CACHE.get(key);
	if (hit && Date.now() - hit.at < SX_TTL) return hit.v;
	const general = !cat || cat === 'general';
	let v = await sxFetchRaw(query, page, cat, safe, general);
	if (general && !v.down && !(v.data && v.data.results && v.data.results.length)) v = await sxFetchRaw(query, page, cat, safe, false);
	if (!v.down && v.data && v.data.results && v.data.results.length) {
		SX_CACHE.set(key, { at: Date.now(), v });
		if (SX_CACHE.size > 200) SX_CACHE.delete(SX_CACHE.keys().next().value);
	}
	return v;
}
function sxFetchRaw(query, page, cat, safe, pin) {
	return new Promise((resolve) => {
		const qs = (pin ? '?engines=bing,google+cse&q=' : '?q=') + encodeURIComponent(query) + '&format=json' + (page > 1 ? '&pageno=' + page : '') + (cat && cat !== 'general' ? '&categories=' + encodeURIComponent(cat) : '') + '&safesearch=' + (safe | 0);
		const up = httpRequest(SEARX_UPSTREAM + '/search' + qs, {
			headers: { accept: 'application/json', 'accept-encoding': 'identity' },
			timeout: 15000,
		}, (ur) => {
			const chunks = [];
			ur.on('data', (c) => { if (Buffer.concat(chunks).length < 4 * 1024 * 1024) chunks.push(c); });
			ur.on('end', () => {
				try { resolve({ down: false, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
				catch { resolve({ down: true }); }
			});
			ur.on('error', () => resolve({ down: true }));
		});
		up.on('timeout', () => { up.destroy(); resolve({ down: true }); });
		up.on('error', () => resolve({ down: true }));
		up.end();
	});
}

const SX_CATS = [['general', 'all'], ['images', 'images'], ['videos', 'videos'], ['news', 'news'], ['map', 'maps']];
const SX_SAFE = ['off', 'moderate', 'strict'];
function sxImg(u) { return u ? '/searx/img?u=' + encodeURIComponent(u) : ''; }
const SX_BANGS = {
	w: 'https://en.wikipedia.org/w/index.php?search=%s', yt: 'https://www.youtube.com/results?search_query=%s',
	g: 'https://www.google.com/search?q=%s', ddg: 'https://duckduckgo.com/?q=%s', r: 'https://www.reddit.com/search/?q=%s',
	gh: 'https://github.com/search?q=%s', a: 'https://www.amazon.com/s?k=%s', maps: 'https://www.google.com/maps/search/%s',
	imdb: 'https://www.imdb.com/find/?q=%s', mdn: 'https://developer.mozilla.org/en-US/search?q=%s', so: 'https://stackoverflow.com/search?q=%s',
	tw: 'https://x.com/search?q=%s', gi: 'https://www.google.com/search?tbm=isch&q=%s', wa: 'https://www.wolframalpha.com/input?i=%s',
	npm: 'https://www.npmjs.com/search?q=%s', tr: 'https://translate.google.com/?sl=auto&text=%s', ebay: 'https://www.ebay.com/sch/i.html?_nkw=%s',
};
// "!w cats" or "cats !w": jump straight to that site (opens inside the proxy frame)
function sxBang(q) {
	const m = /^!([a-z]{1,5})\s+(.+)$/i.exec(q) || /^(.+?)\s+!([a-z]{1,5})$/i.exec(q);
	if (!m) return null;
	const k = (/^!/.test(q) ? m[1] : m[2]).toLowerCase(), t = (/^!/.test(q) ? m[2] : m[1]).trim();
	return SX_BANGS[k] ? SX_BANGS[k].replace('%s', encodeURIComponent(t)) : null;
}
const SX_CSS = `
:root { --rj-bg: #000000; --rj-surface: #212121; --rj-surface-2: #2f2f2f; --rj-hover: #171717; --rj-border: rgba(255,255,255,0.08); --rj-text: #ececec; --rj-text-dim: #b4b4b4; --rj-text-faint: #8e8e8e; --rj-accent: #d9f24b; --rj-accent-ink: #1e230a; --rj-radius: 16px; --rj-pill: 999px; --rj-font: system-ui, -apple-system, "Segoe UI", sans-serif; }
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--rj-bg); color: var(--rj-text); font-family: var(--rj-font); -webkit-font-smoothing: antialiased; min-height: 100dvh; animation: sxin .28s ease-out both; }
@keyframes sxin { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@view-transition { navigation: auto; }
a { color: inherit; text-decoration: none; }
.bar { position: sticky; top: 0; z-index: 20; display: flex; align-items: center; gap: 12px; padding: 12px max(16px, env(safe-area-inset-right)) 10px max(16px, env(safe-area-inset-left)); padding-top: calc(12px + env(safe-area-inset-top)); background: color-mix(in srgb, var(--rj-bg) 80%, transparent); -webkit-backdrop-filter: blur(var(--rj-g-blur, 18px)) saturate(1.4); backdrop-filter: blur(var(--rj-g-blur, 18px)) saturate(1.4); border-bottom: 1px solid var(--rj-border); }
.bar-in { width: 100%; max-width: 1180px; margin: 0 auto; display: flex; align-items: center; gap: 14px; }
.back { flex: none; width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%; color: var(--rj-text-dim); }
.back:hover { background: var(--rj-hover); color: var(--rj-text); }
.back svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.mark { flex: none; font-weight: 700; font-size: 19px; letter-spacing: -0.02em; }
.mark b { color: var(--rj-accent); font-weight: 700; }
.box { position: relative; display: flex; gap: 8px; flex: 1; min-width: 0; max-width: 760px; }
.box .ic { position: absolute; left: 16px; top: 50%; transform: translateY(-50%); width: 17px; height: 17px; fill: none; stroke: var(--rj-text-dim); stroke-width: 2; stroke-linecap: round; pointer-events: none; }
.box input[type=text] { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: var(--rj-pill); padding: 0 18px 0 42px; height: 44px; color: var(--rj-text); font: inherit; font-size: 16px; outline: none; transition: border-color .15s, box-shadow .15s; }
.box input[type=text]:focus { border-color: var(--rj-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rj-accent) 22%, transparent); }
.box input::placeholder { color: var(--rj-text-dim); opacity: .85; }
.box button { flex: none; width: 44px; height: 44px; display: grid; place-items: center; background: var(--rj-accent); color: var(--rj-accent-ink); border: 0; border-radius: 50%; cursor: pointer; }
.box button svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.tabsrow { border-bottom: 1px solid var(--rj-border); }
.tabs { width: 100%; max-width: 1180px; margin: 0 auto; padding: 0 16px; display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
.tabs::-webkit-scrollbar { display: none; }
.tabset { display: flex; gap: 2px; }
.tab { padding: 12px 14px 11px; font-size: 14.5px; color: var(--rj-text-dim); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tab:hover { color: var(--rj-text); }
.tab.on { color: var(--rj-text); border-bottom-color: var(--rj-accent); font-weight: 600; }
.safe { margin-left: auto; display: inline-flex; flex: none; padding: 2px; border: 1px solid var(--rj-border); border-radius: var(--rj-pill); background: var(--rj-surface); }
.sf { padding: 5px 11px; border-radius: var(--rj-pill); font-size: 12.5px; color: var(--rj-text-faint); }
.sf.on { background: var(--rj-surface-2); color: var(--rj-text); }
.wrap { width: 100%; max-width: 1180px; margin: 0 auto; padding: 20px 16px 56px; }
.col { max-width: 820px; }
.count { color: var(--rj-text-faint); font-size: 12.5px; margin: 0 2px 16px; }
.hits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.hit { padding: 12px 14px; margin: 0 -14px; border-radius: calc(var(--rj-radius) - 2px); animation: sxin .3s ease-out both; transition: background .15s; }
.hit:hover { background: var(--rj-hover); }
.hit-site { display: flex; align-items: center; gap: 9px; min-width: 0; margin-bottom: 4px; }
.fav { flex: none; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--rj-accent-ink); background: var(--rj-accent); }
.hit-crumb { color: var(--rj-text-dim); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.hit-title { display: block; font-size: 19px; color: var(--rj-accent); line-height: 1.3; overflow-wrap: anywhere; font-weight: 500; }
.hit-title:hover { text-decoration: underline; text-underline-offset: 3px; }
.hit-snip { color: var(--rj-text-dim); font-size: 14.5px; line-height: 1.55; margin: 6px 0 0; overflow-wrap: anywhere; }
.hit-meta { color: var(--rj-text-faint); font-size: 12px; margin-top: 6px; }
.hit.has-th { display: flex; gap: 16px; align-items: flex-start; }
.hit-body { min-width: 0; flex: 1; }
.hit-th { width: 168px; flex: none; border-radius: calc(var(--rj-radius) - 4px); background: var(--rj-surface); object-fit: cover; aspect-ratio: 16/9; order: 2; }
.hit-th.news { width: 96px; aspect-ratio: 1; }
.answer { background: var(--rj-surface); border: 1px solid var(--rj-border); border-left: 3px solid var(--rj-accent); border-radius: var(--rj-radius); padding: 16px 18px; font-size: 16px; line-height: 1.5; margin-bottom: 20px; }
.correction { color: var(--rj-text-dim); font-size: 14.5px; margin-bottom: 16px; }
.correction a { color: var(--rj-accent); }
.notice { background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: var(--rj-radius); padding: 18px; color: var(--rj-text-dim); font-size: 14.5px; margin-bottom: 20px; }
.pager { display: flex; gap: 10px; margin-top: 28px; }
.pill { background: var(--rj-surface); border: 1px solid var(--rj-border); border-radius: var(--rj-pill); padding: 10px 20px; font-size: 14px; color: var(--rj-text); }
.pill:hover { background: var(--rj-surface-2); }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.tile a { display: block; aspect-ratio: 1; border-radius: calc(var(--rj-radius) - 2px); overflow: hidden; background: var(--rj-surface); }
.tile img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .25s; }
.tile a:hover img { transform: scale(1.05); }
.tile-cap { color: var(--rj-text-faint); font-size: 11.5px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wrap.wide .col { max-width: none; }
.home-hero { min-height: calc(100dvh - 120px); display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 0 16px 6vh; }
.home-hero .mark { font-size: clamp(34px, 6vw, 52px); margin-bottom: 22px; }
.home-hero .box { width: 100%; max-width: 640px; }
.home-hero .box input[type=text] { height: 54px; font-size: 17px; }
.home-hero .box button { width: 54px; height: 54px; }
.recent { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 18px; max-width: 640px; }
.recent a, .recent button { background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: var(--rj-pill); padding: 7px 14px; font: inherit; font-size: 13.5px; cursor: pointer; }
.recent a:hover { color: var(--rj-text); }
.framed .back, .framed .mark { display: none; }
.framed .bar { display: none; }
.lb { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh; height: 100dvh; max-height: 100dvh; overflow: hidden; z-index: 100; display: none; flex-direction: column; background: rgba(0,0,0,.92); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
.lb.on { display: flex; animation: lbin .16s ease; }
@keyframes lbin { from { opacity: 0; } to { opacity: 1; } }
.lb-top { display: flex; align-items: center; gap: 12px; padding: 12px 16px; color: var(--rj-text-dim); font-size: 13px; }
.lb-top .lb-n { flex: none; }
.lb-top .lb-t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--rj-text); }
.lb-btn { flex: none; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; cursor: pointer; padding: 0; font: inherit; }
.lb-btn:hover { background: var(--rj-hover); }
.lb-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.lb-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 0 56px; touch-action: pan-y; }
.lb-img { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px; transition: opacity .15s; }
.lb-img.ld { opacity: .55; }
.lb-nav { position: absolute; top: 50%; transform: translateY(-50%); }
.lb-prev { left: 10px; } .lb-next { right: 10px; }
.lb-bot { display: flex; align-items: center; justify-content: center; gap: 10px; padding: 12px 16px calc(14px + env(safe-area-inset-bottom)); flex-wrap: wrap; }
.lb-pill { background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: var(--rj-pill); padding: 8px 16px; font: inherit; font-size: 13.5px; text-decoration: none; cursor: pointer; }
.lb-pill:hover { background: var(--rj-hover); }
.lb-pill.go { background: var(--rj-accent); color: var(--rj-accent-ink, #111); border-color: transparent; font-weight: 600; }
@media (max-width: 700px) { .lb-stage { padding: 0 8px; } .lb-nav { display: none; } }
@media (prefers-reduced-motion: reduce) { .lb.on { animation: none; } }

.strip { list-style: none; margin: 4px 0 22px; padding: 0; }
.strip-row { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none; padding-bottom: 2px; }
.strip-row::-webkit-scrollbar { display: none; }
.strip-row a { flex: 0 0 auto; width: 118px; height: 118px; border-radius: calc(var(--rj-radius) - 2px); overflow: hidden; background: var(--rj-surface); }
.strip-row img { width: 100%; height: 100%; object-fit: cover; display: block; }
.strip-more { display: inline-block; margin-top: 8px; color: var(--rj-text-dim); font-size: 13px; text-decoration: none; }
.strip-more:hover { color: var(--rj-text); }
.foot { margin-top: 44px; color: var(--rj-text-faint); font-size: 11.5px; }
html[data-skin=glass] .hit { background: var(--rj-surface); border: 1px solid var(--rj-border); margin: 0; padding: 14px 16px; -webkit-backdrop-filter: blur(var(--rj-g-blur, 18px)); backdrop-filter: blur(var(--rj-g-blur, 18px)); }
html[data-skin=glass] .hits { gap: 10px; }
html[data-skin=glass] .tabsrow, html[data-skin=glass] .bar { border-color: var(--rj-border); }
html[data-skin=glass] .tab.on { color: var(--rj-text); }
@media (max-width: 700px) {
  .mark { display: none; }
  .back { width: 32px; }
  .hit-title { font-size: 17.5px; }
  .hit-th { width: 104px; }
  .hit-th.news { width: 72px; }
  .hit.has-th { gap: 12px; }
  .safe .sf { padding: 5px 9px; }
  .tabs { padding: 0 8px; }
}
@media (min-width: 1100px) {
  .bar-in, .tabs, .wrap { padding-left: 24px; padding-right: 24px; }
  .bar-in { padding: 0; }
  .col { max-width: 880px; }
}
`;
const SX_JS = `
(function () {
  /*rjimgfb*/ document.addEventListener('error', function (e) { var t = e.target; if (!t || t.tagName !== 'IMG') return; var a = t.getAttribute('data-alt'); if (a) { t.removeAttribute('data-alt'); t.src = a; } else { var li = t.closest('li.tile'); if (li) li.style.display = 'none'; else t.style.visibility = 'hidden'; } }, true);
  var K = 'rj-browse-searches', de = document.documentElement;
  try { if (window.parent !== window) de.classList.add('framed'); } catch (e) { de.classList.add('framed'); }
  function lite() { try { var ds = localStorage.getItem('rj-datasaver'); if (ds === 'on') return true; if (ds === 'off') return false; var c = navigator.connection; if (c) { if (c.saveData || c.type === 'cellular') return true; if (c.type === 'wifi' || c.type === 'ethernet') return false; return /^(slow-2g|2g|3g)$/.test(c.effectiveType || ''); } return /iPhone|Android.*Mobile/.test(navigator.userAgent); } catch (e) { return false; } }
  if (!lite()) document.querySelectorAll('img[data-full]').forEach(function (im) { var f = im.getAttribute('data-full'); var t = new Image(); t.onload = function () { im.src = f; im.removeAttribute('data-alt'); }; t.referrerPolicy = 'no-referrer'; t.src = f; });

  /* image preview: click a tile in the images tab to open it big, with next/prev, swipe, and a link to the page it came from */
  (function () {
    var tiles = [].slice.call(document.querySelectorAll('li.tile > a'));
    if (!tiles.length) return;
    var I = function (d) { return '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>'; };
    var lb = document.createElement('div'); lb.className = 'lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true');
    lb.innerHTML = '<div class="lb-top"><span class="lb-n"></span><span class="lb-t"></span><button class="lb-btn lb-x" type="button" aria-label="close">' + I('M6 6l12 12M18 6L6 18') + '</button></div>' +
      '<div class="lb-stage"><button class="lb-btn lb-nav lb-prev" type="button" aria-label="previous">' + I('M15 5l-7 7 7 7') + '</button><img class="lb-img" alt="" referrerpolicy="no-referrer"><button class="lb-btn lb-nav lb-next" type="button" aria-label="next">' + I('M9 5l7 7-7 7') + '</button></div>' +
      '<div class="lb-bot"><a class="lb-pill go lb-visit" href="#">visit page</a><a class="lb-pill lb-open" href="#" target="_blank" rel="noopener noreferrer">open image</a><button class="lb-pill lb-full" type="button" style="display:none">load full quality</button></div>';
    document.body.appendChild(lb);
    var q = function (c) { return lb.querySelector(c); };
    var img = q('.lb-img'), cur = -1, startX = 0, startY = 0;
    function info(i) { var a = tiles[i], im = a.querySelector('img'); return { thumb: im.getAttribute('src'), full: im.getAttribute('data-full') || im.getAttribute('data-alt') || im.getAttribute('src'), page: a.getAttribute('href'), title: a.getAttribute('title') || '' }; }
    function show(i, forceFull) {
      if (i < 0 || i >= tiles.length) return;
      cur = i; var d = info(i), small = lite() && !forceFull && d.full !== d.thumb;
      q('.lb-n').textContent = (i + 1) + ' / ' + tiles.length; q('.lb-t').textContent = d.title;
      q('.lb-visit').setAttribute('href', d.page);
      var raw = d.full; try { var m = new URL(d.full, location.href).searchParams.get('u'); if (m) raw = m; } catch (e) {}
      q('.lb-open').setAttribute('href', raw);
      var fb = q('.lb-full'); fb.style.display = small ? '' : 'none';
      img.classList.add('ld'); img.src = d.thumb;
      if (!small && d.full !== d.thumb) { var t = new Image(), at = i; t.referrerPolicy = 'no-referrer'; t.onload = function () { if (cur === at) { img.src = d.full; img.classList.remove('ld'); } }; t.onerror = function () { if (cur === at) img.classList.remove('ld'); }; t.src = d.full; } else img.classList.remove('ld');
      img.onload = function () { if (small || d.full === d.thumb) img.classList.remove('ld'); };
      [i - 1, i + 1].forEach(function (n) { if (tiles[n]) { var p = new Image(); p.src = info(n).thumb; } });
    }
    function open(i) { lb.classList.add('on'); document.documentElement.style.overflow = 'hidden'; show(i); }
    function close() { lb.classList.remove('on'); document.documentElement.style.overflow = ''; cur = -1; img.removeAttribute('src'); }
    tiles.forEach(function (a, i) { a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(i); }, true); });
    q('.lb-x').onclick = close; q('.lb-prev').onclick = function () { show(cur - 1); }; q('.lb-next').onclick = function () { show(cur + 1); };
    q('.lb-full').onclick = function () { show(cur, true); };
    q('.lb-stage').addEventListener('click', function (e) { if (e.target === q('.lb-stage')) close(); });
    document.addEventListener('keydown', function (e) { if (cur < 0) return; if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') show(cur - 1); else if (e.key === 'ArrowRight') show(cur + 1); });
    var st = q('.lb-stage');
    st.addEventListener('touchstart', function (e) { var t = e.touches[0]; startX = t.clientX; startY = t.clientY; }, { passive: true });
    st.addEventListener('touchend', function (e) { var t = e.changedTouches[0], dx = t.clientX - startX, dy = t.clientY - startY; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) show(cur + (dx < 0 ? 1 : -1)); else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.4) close(); }, { passive: true });
  })();
  (function () { var el = document.getElementById('sxlite'); if (!el || !lite()) return; var ds = ''; try { ds = localStorage.getItem('rj-datasaver') || ''; } catch (e) {} if (ds === 'on') return; el.innerHTML = '<br>smaller thumbnails to save data. for full quality on wifi: settings, data saver, off.'; })();
  function on() { try { return localStorage.getItem('rj-save-searches') === 'on'; } catch (e) { return false; } }
  function read() { if (!on()) return []; try { var a = JSON.parse(localStorage.getItem(K) || '[]'); return Array.isArray(a) ? a.slice(0, 12) : []; } catch (e) { return []; } }
  function add(q) { q = String(q || '').trim().slice(0, 120); if (!q || !on()) return; var n = [q].concat(read().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); })).slice(0, 12); try { localStorage.setItem(K, JSON.stringify(n)); } catch (e) {} }
  var f = document.querySelector('form.box'); var i = f && f.querySelector('input[name=q]');
  if (i && i.value) add(i.value);
  if (f) f.addEventListener('submit', function () { if (i) add(i.value); });
  var dl = document.getElementById('sxdl'); var list = read();
  if (dl) dl.innerHTML = list.map(function (x) { return '<option value="' + x.replace(/"/g, '&quot;') + '">'; }).join('');
  var r = document.getElementById('sxrecent');
  if (r && list.length) {
    r.innerHTML = list.slice(0, 8).map(function (x) { return '<a href="/searx/search?q=' + encodeURIComponent(x) + '"></a>'; }).join('') + '<button type="button" id="sxclr">clear</button>';
    r.querySelectorAll('a').forEach(function (a, n) { a.textContent = list[n]; });
    var c = document.getElementById('sxclr'); if (c) c.onclick = function () { try { localStorage.removeItem(K); localStorage.setItem(K, '[]'); } catch (e) {} r.innerHTML = ''; };
  }
  document.addEventListener('click', function (e) { var a = e.target && e.target.closest ? e.target.closest('a[href]') : null; if (!a) return; var h = a.getAttribute('href') || ''; if (/^https?:\\/\\//i.test(h) && window.parent !== window) { e.preventDefault(); e.stopPropagation(); parent.postMessage({ rjBrowseGo: h }, '*'); } }, true);
})();
`;
function sxHost(u) { try { return new URL(u).hostname; } catch { return ''; } }
function sxPage(query, page, result, cat, safe, imgRes) {
	cat = SX_CATS.some((c) => c[0] === cat) ? cat : 'general';
	safe = [0, 1, 2].includes(safe) ? safe : 0;
	const qs = (o) => { const m = Object.assign({ q: query, c: cat, s: safe }, o || {}); return '/searx/search?' + Object.entries(m).filter(([k, v]) => v !== '' && v != null && !(k === 'c' && v === 'general')).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); };
	const down = !!(result && result.down);
	const data = (result && result.data) || {};
	const results = Array.isArray(data.results) ? data.results : [];
	const answers = (Array.isArray(data.answers) ? data.answers : [])
		.map((a) => (typeof a === 'string' ? a : (a && a.answer) || '')).filter(Boolean).slice(0, 2);
	const corrections = (Array.isArray(data.corrections) ? data.corrections : []).filter(Boolean).slice(0, 1);
	const total = Number(data.number_of_results) || 0;

	let strip = '';
	if (cat === 'general' && page === 1 && imgRes && imgRes.data && Array.isArray(imgRes.data.results)) {
		const ims = imgRes.data.results.map((r) => ({ t: sxHref(r.thumbnail_src || r.thumbnail || '') || sxHref(r.img_src || ''), f: sxHref(r.img_src || ''), a: String(r.title || '') })).filter((x) => x.t).slice(0, 9);
		if (ims.length >= 4) strip = '<li class="strip"><div class="strip-row">' + ims.map((x) => '<a href="' + sxEsc('/searx/search?q=' + encodeURIComponent(query) + '&c=images') + '"><img loading="lazy" referrerpolicy="no-referrer" alt="' + sxEsc(x.a.slice(0, 80)) + '" src="' + sxEsc(sxImg(x.t)) + '"' + (x.f && x.f !== x.t ? ' data-full="' + sxEsc(sxImg(x.f)) + '"' : '') + ' /></a>').join('') + '</div><a class="strip-more" href="' + sxEsc('/searx/search?q=' + encodeURIComponent(query) + '&c=images') + '">more images &rarr;</a></li>';
	}
	const cards = [];
	for (const r of results) {
		const href = sxHref(r.url);
		if (!href) continue;
		const engines = Array.isArray(r.engines) ? [...new Set(r.engines)].slice(0, 3).join(' · ') : (r.engine || '');
		const date = r.publishedDate ? String(r.publishedDate).slice(0, 10) : '';
		const meta = [engines, date].filter(Boolean).join(' · ');
		const th = sxHref(r.thumbnail_src || r.thumbnail || '');
		if (cat === 'images') {
			const full = sxHref(r.img_src);
			cards.push('<li class="tile"><a href="' + sxEsc(href) + '" title="' + sxEsc(r.title || '') + '"><img loading="lazy" referrerpolicy="no-referrer" alt="' + sxEsc(r.title || '') + '" src="' + sxEsc(sxImg(th || full)) + '"' + (th && full ? ' data-alt="' + sxEsc(sxImg(full)) + '"' : '') + (th && full ? ' data-full="' + sxEsc(sxImg(full)) + '"' : '') + ' /></a><div class="tile-cap">' + sxEsc(String(r.title || '').slice(0, 60)) + '</div></li>');
			continue;
		}
		const thumbHtml = (th && (cat === 'videos' || cat === 'news')) ? '<img class="hit-th ' + cat + '" loading="lazy" referrerpolicy="no-referrer" alt="" src="' + sxEsc(sxImg(th)) + '" />' : '';
		const extra = cat === 'map' && r.latitude ? ' &middot; ' + sxEsc(Number(r.latitude).toFixed(3) + ', ' + Number(r.longitude).toFixed(3)) : '';
		const dur = cat === 'videos' && r.length ? ' &middot; ' + sxEsc(r.length) : '';
		cards.push(
			'<li class="hit' + (thumbHtml ? ' has-th' : '') + '">' + thumbHtml + '<div class="hit-body">' +
				'<div class="hit-site"><span class="fav" aria-hidden="true">' + sxEsc(sxHost(href).replace(/^www\./, '').slice(0, 1) || '?') + '</span><div class="hit-crumb">' + sxCrumb(href) + '</div></div>' +
				'<a class="hit-title" href="' + sxEsc(href) + '">' + sxEsc(r.title || href) + '</a>' +
				(r.content ? '<p class="hit-snip">' + sxEsc(String(r.content).slice(0, 320)) + '</p>' : '') +
				(meta ? '<div class="hit-meta">' + sxEsc(meta) + extra + dur + '</div>' : '') +
			'</div></li>'
		);
	}

	const qAttr = sxEsc(query);
	const home = !query;
	let body = '';
	if (down) {
		body += '<div class="notice">search is down right now - the backend on the box needs a kick. it will be back shortly.</div>';
	} else if (query && !cards.length) {
		body += '<div class="notice">no results for &ldquo;' + qAttr + '&rdquo;. try different words.</div>';
	}
	if (answers.length) {
		body += answers.map((a) => '<div class="answer">' + sxEsc(a) + '</div>').join('');
	}
	if (corrections.length) {
		body += '<div class="correction">did you mean <a href="/searx/search?q=' + encodeURIComponent(corrections[0]) + '">' + sxEsc(corrections[0]) + '</a>?</div>';
	}
	if (cards.length) {
		body += '<div class="count">' + (total ? 'about ' + total.toLocaleString('en-US') + ' results' : cards.length + ' results') + '</div>';
		if (strip) cards.splice(Math.min(2, cards.length), 0, strip);
		body += '<ol class="' + (cat === 'images' ? 'grid' : 'hits') + '">' + cards.join('') + '</ol>';
		body += '<div class="pager">';
		if (page > 1) body += '<a class="pill" href="' + qs({ p: page - 1 }) + '">&larr; back</a>';
		body += '<a class="pill" href="' + qs({ p: page + 1 }) + '">more &rarr;</a>';
		body += '</div>';
	}

	const SVG_S = '<svg class="ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
	const formHtml =
		'<form class="box" action="/searx/search" method="get">' + SVG_S +
			'<input type="text" name="q" value="' + qAttr + '" placeholder="search the web" autocomplete="off" enterkeyhint="search" list="sxdl"' + (home ? ' autofocus' : '') + ' />' +
			'<datalist id="sxdl"></datalist>' +
			'<input type="hidden" name="c" value="' + cat + '" /><input type="hidden" name="s" value="' + safe + '" />' +
			'<button type="submit" aria-label="search"><svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>' +
		'</form>';
	const tabsHtml = '<div class="tabsrow"><nav class="tabs"><span class="tabset">' + SX_CATS.map((c) => '<a class="tab' + (c[0] === cat ? ' on' : '') + '" href="' + qs({ c: c[0], p: '' }) + '">' + c[1] + '</a>').join('') + '</span>' +
		'<span class="safe" role="group" aria-label="safe search">' + SX_SAFE.map((n, i) => '<a class="sf' + (i === safe ? ' on' : '') + '" href="' + qs({ s: i, p: '' }) + '">' + n + '</a>').join('') + '</span></nav></div>';
	const BACK = '<a class="back" href="/" aria-label="back to ramjet"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></a>';
	const headBar = '<header class="bar"><div class="bar-in">' + BACK + '<a class="mark" href="/searx/search">ramjet<b>search</b></a>' + formHtml + '</div></header>';

	return '<!doctype html>' +
'<html lang="en"><head><meta charset="utf-8" />' +
'<meta name="viewport" content="width=device-width, initial-scale=1" />' +
'<title>' + (query ? qAttr + ' - ' : '') + 'ramjet search</title>' +
'<meta name="theme-color" content="#000000" /><link rel="stylesheet" href="/cloak/walls.css?v=1" /><script src="/cloak/theme-boot.js?v=8"></script>' +
'<style>' + SX_CSS + '</style></head>' +
'<body>' +
(home
	? '<header class="bar"><div class="bar-in">' + BACK + '</div></header>' +
	  '<main class="home-hero"><div class="mark">ramjet<b>search</b></div>' + formHtml + '<div class="recent" id="sxrecent"></div></main>'
	: headBar + (query ? tabsHtml : '') + '<main class="wrap' + (cat === 'images' ? ' wide' : '') + '"><div class="col">' + body + '<div class="foot">served from your own box &middot; queries go straight from the box to the engines<span id="sxlite"></span></div></div></main>') +
'<script>' + SX_JS + '<' + '/script>' +
'</body></html>';
}

async function proxySearx(req, res, session, restUrl) {
	if (!session) return redirect(res, '/login');
	if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
	const u = new URL(restUrl, 'http://x');
	if (u.pathname === '/img') {
		let t; try { t = new URL(u.searchParams.get('u') || ''); } catch { res.writeHead(400); return res.end(); }
		if (!/^https?:$/.test(t.protocol)) { res.writeHead(400); return res.end(); }
		const imgGuard = await new Promise((ok) => safeLookup(t.hostname.replace(/^\[|\]$/g, ''), {}, (e) => ok(!e)));
		if (!imgGuard) { res.writeHead(400); return res.end(); }
		const mod = t.protocol === 'https:' ? httpsRequest : httpRequest;
		const ur = mod(t, { headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0' }, lookup: safeLookup, timeout: 10000 }, (ir) => {
			if (ir.statusCode >= 300 && ir.statusCode < 400 && ir.headers.location && (parseInt(u.searchParams.get('h') || '0', 10) < 3)) { ir.resume(); let nx; try { nx = new URL(ir.headers.location, t); } catch { res.writeHead(404); return res.end(); } res.writeHead(302, { location: '/searx/img?h=' + (parseInt(u.searchParams.get('h') || '0', 10) + 1) + '&u=' + encodeURIComponent(nx.href) }); return res.end(); }
			const ct = String(ir.headers['content-type'] || '');
			if (ir.statusCode !== 200 || !/^image\/(jpeg|png|webp|gif|avif)/.test(ct)) { ir.resume(); res.writeHead(404); return res.end(); }
			res.writeHead(200, { 'content-type': ct, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
			let n = 0; ir.on('data', (c) => { n += c.length; if (n > 3e6) { ir.destroy(); res.end(); } else res.write(c); });
			ir.on('end', () => res.end()); ir.on('error', () => res.end());
		});
		ur.on('timeout', () => ur.destroy()); ur.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
		return ur.end();
	}
	if (u.pathname === '/reader') {
		const tu = u.searchParams.get('u') || '';
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
		return res.end(await readerPage(tu));
	}
	if (u.pathname !== '/search' && u.pathname !== '/' && u.pathname !== '') {
		res.writeHead(302, { location: '/searx/search' });
		return res.end();
	}
	const q = (u.searchParams.get('q') || '').trim();
	const bang = sxBang(q);
	if (bang) {
		const j = JSON.stringify(bang).replace(/</g, '\\u003c');
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
		return res.end('<!doctype html><meta charset=utf-8><title>Opening</title><body style="background:#0b0b0c;color:#aaa;font:15px system-ui;padding:24px">Opening...<script>var u=' + j + ';if(window.parent!==window)parent.postMessage({rjBrowseGo:u},"*");else location.replace(u)</script>');
	}
	const page = Math.max(1, parseInt(u.searchParams.get('p') || '1', 10) || 1);
	const cat = u.searchParams.get('c') || 'general';
	const ck = parseCookies(req).rjss;
	let safe = u.searchParams.has('s') ? parseInt(u.searchParams.get('s'), 10) : (ck != null ? parseInt(ck, 10) : 0);
	if (![0, 1, 2].includes(safe)) safe = 0;
	const wantImgs = q && cat === 'general' && page === 1;
	const imgP = wantImgs ? Promise.race([sxFetch(q, 1, 'images', safe), new Promise((r) => setTimeout(() => r(null), 4000))]).catch(() => null) : null;
	const result = q ? await sxFetch(q, page, cat, safe) : null;
	const imgRes = imgP ? await imgP : null;
	const hd = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
	if (u.searchParams.has('s')) hd['set-cookie'] = 'rjss=' + safe + '; Path=/searx; Max-Age=31536000; SameSite=Lax; HttpOnly';
	res.writeHead(200, hd);
	res.end(sxPage(q, page, result, cat, safe, imgRes));
}

// accounts (Luke 1:51 PM "add multiple accounts and the approval system"):
// anyone can request an account on /login; with approval on (the default,
// his earlier call: "approving should be optional but on by default") a new
// account sits pending until the admin approves it in settings.
const ADMIN = process.env.RJ_ADMIN || 'luke';
const CONFIG_PATH = new URL('../data/config.json', import.meta.url).pathname;
const getConfig = () => ({ requireApproval: true, ...rjRead(CONFIG_PATH, {}) });
const RESERVED = new Set(['admin', 'administrator', 'root', 'ramjet', 'support', 'system']);
const MAX_PENDING = 25;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  const cookies = parseCookies(req);
  const session = auth.sessionFromCookies(cookies);

  try {
    if (path.startsWith('/api/')) {
      const user = session?.user || `anon:${clientIp(req)}`;
      if (!guard.allowRequest(user)) return sendJson(res, 429, { ok: false, error: 'slow down a bit' });

      if (path === '/api/auth/login' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const name = String(body.username || '').trim().toLowerCase();
        // every visitor arrives through the same on-box proxy, so an ip-only
        // throttle would lock out ALL users at once. throttle the account,
        // keep a wide per-ip ceiling against password spraying.
        if (!guard.allowLogin(`acct:${name}`) || !guard.allowLogin(`ip:${clientIp(req)}`, 120)) {
          return sendJson(res, 429, { ok: false, error: 'too many tries - wait a few minutes' });
        }
        const acct = auth.verify(name, body.password);
        if (!acct) return sendJson(res, 401, { ok: false, error: 'wrong username or password' });
        if (acct.status === 'pending') return sendJson(res, 403, { ok: false, error: 'your account is waiting for approval - try again later' });
        if (acct.status === 'banned') return sendJson(res, 403, { ok: false, error: 'this account is turned off' });
        const token = auth.createSession(name);
        return sendJson(res, 200, { ok: true, user: name }, { 'set-cookie': auth.cookieHeader(token) });
      }
      if (path === '/api/auth/signup' && req.method === 'POST') {
        if (!guard.allowLogin(`signup:${clientIp(req)}`, 40)) return sendJson(res, 429, { ok: false, error: 'too many tries - wait a few minutes' });
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const name = String(body.username || '').trim().toLowerCase();
        if (RESERVED.has(name) || name === ADMIN) return sendJson(res, 400, { ok: false, error: 'that name is taken' });
        const cfg = getConfig();
        if (cfg.requireApproval && auth.listUsers().filter((u) => u.status === 'pending').length >= MAX_PENDING) {
          return sendJson(res, 429, { ok: false, error: 'too many requests waiting right now - try again later' });
        }
        try { auth.createUser(name, body.password, cfg.requireApproval ? { status: 'pending' } : {}); }
        catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
        if (cfg.requireApproval) return sendJson(res, 200, { ok: true, pending: true });
        const token = auth.createSession(name);
        return sendJson(res, 200, { ok: true, user: name }, { 'set-cookie': auth.cookieHeader(token) });
      }
      if (path === '/api/auth/logout' && req.method === 'POST') {
        if (session) auth.destroySession(session.token);
        return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookieHeader() });
      }
      if (!session) return sendJson(res, 401, { ok: false, error: 'not signed in' });

      if (path === '/api/sys' && req.method === 'GET') {
        if (!sysCache || Date.now() - sysCache.at > 60000) {
          let cacheBytes = 0;
          try { const d = DATA + '/stream-cache'; for (const f of readdirSync(d)) { try { cacheBytes += statSync(d + '/' + f).size; } catch {} } } catch {}
          sysCache = { at: Date.now(), cacheBytes };
        }
        const os = await import('node:os');
        return sendJson(res, 200, { ok: true, version: SYS_VERSION, node: process.version, uptime: Math.round(process.uptime()), load: +os.loadavg()[0].toFixed(2), cpus: os.cpus().length, memFreeMB: Math.round(os.freemem() / 1048576), cacheMB: Math.round(sysCache.cacheBytes / 1048576), apps: ['browse', 'jetstream', 'amp', 'sage', 'banter'] });
      }
      if (path === '/api/prefs') {
        const PF = join(DATA, 'user-prefs.json');
        const KEYS = ['rj-theme', 'rj-layout', 'rj-wall', 'rj-tech', 'rj-desk', 'sage-style', 'rj-note', 'rj-todo', 'amp-recent', 'rj-browse-recent', 'rj-browse-history', 'js-later', 'js-pos', 'js-audio-only', 'sage-conv-id', 'sage-conversation', 'rj-cloak', 'rj-adblock', 'rj-datasaver', 'rj-autoclear', 'js-searches', 'amp-searches', 'rj-browse-searches'];
        const all = rjRead(PF, {});
        if (req.method === 'GET') { const m = all[session.user] || { prefs: {}, ts: 0 }; return sendJson(res, 200, { ok: true, prefs: m.prefs, ts: m.ts }); }
        if (req.method === 'POST') {
          let b = {}; try { b = JSON.parse((await readBody(req)).toString() || '{}'); } catch {}
          const prefs = {};
          for (const k of KEYS) { const v = b.prefs && b.prefs[k]; if (typeof v === 'string' && v.length <= 60000) prefs[k] = v; }
          const ts = Number.isFinite(b.ts) ? Math.min(b.ts, Date.now() + 60000) : Date.now();
          all[session.user] = { prefs, ts };
          rjWrite(PF, all);
          return sendJson(res, 200, { ok: true, ts });
        }
      }
      if (path === '/api/auth/me' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, user: session.user, admin: session.user === ADMIN });
      }
      if (path.startsWith('/api/admin/')) {
        if (session.user !== ADMIN) return sendJson(res, 403, { ok: false, error: 'admin only' });
        if (path === '/api/admin/users' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, users: auth.listUsers().sort((a, b) => b.created - a.created), requireApproval: getConfig().requireApproval });
        }
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'bad method' });
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const target = String(body.name || '').trim().toLowerCase();
        if (path === '/api/admin/config') {
          rjWrite(CONFIG_PATH, { ...getConfig(), requireApproval: !!body.requireApproval });
          return sendJson(res, 200, { ok: true, requireApproval: getConfig().requireApproval });
        }
        if (target === ADMIN) return sendJson(res, 400, { ok: false, error: "that's you" });
        const tu = auth.users[target];
        if (!tu) return sendJson(res, 404, { ok: false, error: 'no such user' });
        try {
          if (path === '/api/admin/approve') auth.setStatus(target, 'active');
          else if (path === '/api/admin/ban') auth.setStatus(target, 'banned');
          else if (path === '/api/admin/unban') auth.setStatus(target, 'active');
          else if (path === '/api/admin/logout') auth.killSessions(target);
          else if (path === '/api/admin/remove') auth.removeUser(target);
          else return sendJson(res, 404, { ok: false, error: 'not found' });
        } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/api/pfetch' && req.method === 'POST') {
        return handlePFetch(req, res, session, readBody, (n) => { try { guard.trackBytes(session.user, n); } catch {} });
      }
      if (path === '/api/adblock-stats' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, hosts: adListSize(), blocked: adStats.byUser[session.user] || 0 });
      }
      if (path === '/api/wisp-ticket' && req.method === 'GET') {
        const t = randomBytes(24).toString('hex');
        const adblock = !/[?&]ab=0\b/.test(req.url);
        wispTickets.set(t, { user: session.user, exp: Date.now() + 90000, adblock });
        if (wispTickets.size > 500) {
          const now = Date.now();
          for (const [k, v] of wispTickets) if (v.exp < now) wispTickets.delete(k);
          while (wispTickets.size > 500) wispTickets.delete(wispTickets.keys().next().value);
        }
        return sendJson(res, 200, { ok: true, ticket: t });
      }
      if (path === '/api/auth/export' && req.method === 'GET') {
        const out = { exported: new Date().toISOString(), user: session.user, note: 'banter messages are encrypted at rest and are not included' };
        const files = { jetstream_history: 'jetstream-history', jetstream_likes: 'jetstream-likes', jetstream_dislikes: 'jetstream-dislikes', jetstream_subs: 'jetstream-subs', jetstream_settings: 'jetstream-settings', amp_playlists: 'amp-playlists', browse_bookmarks: 'browse-bookmarks', sage_conversations: 'sage-conversations' };
        for (const [k, f] of Object.entries(files)) {
          const d = rjRead(join(DATA, f + '.json'), {});
          if (d && d[session.user] !== undefined) out[k] = d[session.user];
        }
        return sendJson(res, 200, out, { 'content-disposition': 'attachment; filename="ramjet-' + session.user + '-export.json"' });
      }
      if (path === '/api/auth/change-password' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (!auth.verify(session.user, body.current)) return sendJson(res, 401, { ok: false, error: 'current password is wrong' });
        try { auth.setPassword(session.user, body.next); }
        catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/api/auth/claim-username' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        try { var name = auth.renameUser(session.user, body.name); }
        catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
        return sendJson(res, 200, { ok: true, user: name });
      }
      if (path.startsWith('/api/apps/') || path.startsWith('/api/banter/')) {
        const addonName = path.startsWith('/api/banter/') ? 'banter' : path.split('/')[3];
        const register = addons.get(addonName);
        if (!register) return sendJson(res, 404, { ok: false, error: 'unknown app' });
        const ctx = { auth, guard, session, url, readBody, sendJson };
        return await register(req, res, ctx);
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

    if (path === '/' || path === '/index.html') {
      if (!session) return redirect(res, '/login');
      return servePage(res, 'index');
    }
    if (path === '/login' || path === '/login.html') {
      if (session) return redirect(res, '/');
      return servePage(res, 'login');
    }
    if (path === '/password') {
      if (!session) return redirect(res, '/login');
      return servePage(res, 'password');
    }
    if (path === '/claim') {
      if (!session) return redirect(res, '/login');
      return servePage(res, 'claim');
    }
    if (path === '/auth/ai-key') return sendJson(res, 200, { has: false });
    if (path.startsWith('/searx/')) {
      return proxySearx(req, res, session, path.slice(6) + (url.search || ''));
    }
    if (path.startsWith('/assets/') || path === '/favicon.svg' || path.startsWith('/cloak/') || path.startsWith('/scramjet/') || path.startsWith('/controller/') || path.startsWith('/epoxy/') || path.startsWith('/libcurl/') || path === '/browse-sw.js') {
      if (serveStatic(res, path)) return;
    }
    if (!session && (/^\/(browse|jetstream|amp|sage|banter|settings)\/?$/.test(path))) return redirect(res, "/login");
    // shipped app pages; the rest land on the hub shell until they ship
    const appPages = { jetstream: 'jetstream', browse: 'browse', amp: 'amp', sage: 'sage', banter: 'banter', settings: 'settings' };
    if (session && appPages[path.slice(1)]) return servePage(res, appPages[path.slice(1)]);
    if (session && /^\/(browse|amp|sage|settings)\/?$/.test(path)) {
      return servePage(res, 'index');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nothing here');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'something broke on our side' });
    else res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url) { socket.destroy(); return; }
  // ticket rides in the path (/wisp-t/<ticket>/) because the browser
  // WebSocket API cannot set headers, and a query string breaks wisp's
  // request parsing. the url is rewritten to /wisp/ before wisp sees it.
  const pm = req.url.match(/^\/pws-t\/([a-f0-9]{48})/);
  if (pm) {
    const tk = wispTickets.get(pm[1]);
    let puser = (tk && tk.exp >= Date.now()) ? tk.user : null;
    if (!puser) { const ps = auth.sessionFromCookies(parseCookies(req)); if (ps) puser = ps.user; }
    if (!puser) { socket.destroy(); return; }
    return pwsUpgrade(req, socket, head, puser, (n) => { try { guard.trackBytes(puser, n); } catch {} });
  }
  const tm = req.url.match(/^\/wisp-t\/([a-f0-9]{48})/);
  if (!tm && !req.url.startsWith('/wisp/')) { socket.destroy(); return; }
  const ua = String(req.headers['user-agent'] || '?').slice(0, 90);
  let session = auth.sessionFromCookies(parseCookies(req));
  let gate = session ? 'cookie-ok' : null;
  let adOn = true;
  if (tm) {
    const tk = wispTickets.get(tm[1]);
    if (tk && tk.exp > Date.now()) { if (!session) { session = { user: tk.user }; gate = 'ticket-ok'; } adOn = tk.adblock !== false; }
  }
  if (tm) req.url = '/wisp/';
  console.log(`[wisp] upgrade ${gate || 'REJECTED'} ua="${ua}"`);
  if (!session) { socket.destroy(); return; }
  // browse was the last unmetered pipe. count both directions against the
  // same hourly byte budget the media endpoints enforce; over budget, the
  // socket dies (this is the sanity guardrail, not a user-facing message).
  const meterUser = session.user;
  const meter = (n) => {
    try {
      guard.trackBytes(meterUser, n);
      if (guard.bytesLeft(meterUser) <= 0) { console.log(`[wisp] ${meterUser} over hourly budget - closing`); socket.destroy(); }
    } catch {}
  };
  socket.on('data', (b) => meter(b.length));
  const origWrite = socket.write;
  socket.write = function (chunk, enc, cb) {
    meter(chunk?.length || 0);
    if (socket.destroyed) return false;
    return origWrite.call(socket, chunk, enc, cb);
  };
  wisp.routeRequest(req, socket, head, adOn ? { TCPSocket: makeBlockingSocket(NodeTCPSocket, meterUser) } : {});
});

server.listen(PORT, HOST, () => console.log(`ramjet2 on ${HOST}:${PORT}, data ${DATA}, addons: ${[...addons.keys()].join(', ') || 'none'}`));
process.on('SIGTERM', () => { guard.flush(); process.exit(0); });
process.on('SIGINT', () => { guard.flush(); process.exit(0); });
