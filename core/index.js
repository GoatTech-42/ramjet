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
    'cache-control': urlPath.startsWith('/cloak/') ? 'no-cache' : 'public, max-age=31536000, immutable',
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
function sxPage(query, page, result, cat, safe) {
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
			cards.push('<li class="tile"><a href="' + sxEsc(href) + '" title="' + sxEsc(r.title || '') + '"><img loading="lazy" referrerpolicy="no-referrer" alt="' + sxEsc(r.title || '') + '" src="' + sxEsc(sxImg(th || full)) + '" /></a><div class="tile-cap">' + sxEsc(String(r.title || '').slice(0, 60)) + '</div></li>');
			continue;
		}
		const thumbHtml = (th && (cat === 'videos' || cat === 'news')) ? '<img class="hit-th ' + cat + '" loading="lazy" referrerpolicy="no-referrer" alt="" src="' + sxEsc(sxImg(th)) + '" />' : '';
		const extra = cat === 'map' && r.latitude ? ' &middot; ' + sxEsc(Number(r.latitude).toFixed(3) + ', ' + Number(r.longitude).toFixed(3)) : '';
		const dur = cat === 'videos' && r.length ? ' &middot; ' + sxEsc(r.length) : '';
		cards.push(
			'<li class="hit' + (thumbHtml ? ' has-th' : '') + '">' + thumbHtml + '<div class="hit-body">' +
				'<a class="hit-title" href="' + sxEsc(href) + '">' + sxEsc(r.title || href) + '</a>' +
				'<div class="hit-crumb">' + sxCrumb(href) + '</div>' +
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
		body += '<ol class="' + (cat === 'images' ? 'grid' : 'hits') + '">' + cards.join('') + '</ol>';
		body += '<div class="pager">';
		if (page > 1) body += '<a class="pill" href="' + qs({ p: page - 1 }) + '">&larr; back</a>';
		body += '<a class="pill" href="' + qs({ p: page + 1 }) + '">more &rarr;</a>';
		body += '</div>';
	}

	const formHtml =
		'<form class="box' + (home ? ' hero' : '') + '" action="/searx/search" method="get">' +
			'<input type="text" name="q" value="' + qAttr + '" placeholder="search the web" autocomplete="off" autofocus />' +
			'<input type="hidden" name="c" value="' + cat + '" /><input type="hidden" name="s" value="' + safe + '" />' +
			'<button type="submit">search</button>' +
		'</form>';
	const tabsHtml = '<nav class="tabs"><span class="tabset">' + SX_CATS.map((c) => '<a class="tab' + (c[0] === cat ? ' on' : '') + '" href="' + qs({ c: c[0], p: '' }) + '">' + c[1] + '</a>').join('') + '</span>' +
		'<span class="safe" role="group" aria-label="safe search">' + SX_SAFE.map((n, i) => '<a class="sf' + (i === safe ? ' on' : '') + '" href="' + qs({ s: i, p: '' }) + '">' + n + '</a>').join('') + '</span></nav>';

	return '<!doctype html>' +
'<html lang="en"><head><meta charset="utf-8" />' +
'<meta name="viewport" content="width=device-width, initial-scale=1" />' +
'<title>' + (query ? qAttr + ' - ' : '') + 'ramjet search</title>' +
'<style>' +
'* { box-sizing: border-box; }' +
'html, body { margin: 0; padding: 0; }' +
'body { background: #000; color: #ececec; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing: antialiased; min-height: 100dvh; }' +
'a { color: inherit; text-decoration: none; }' +
'.wrap { max-width: 720px; margin: 0 auto; padding: 22px 18px 48px; }' +
'.wrap.home { display: flex; flex-direction: column; justify-content: center; min-height: 82dvh; }' +
'.mark { font-weight: 700; font-size: ' + (home ? '34px' : '19px') + '; letter-spacing: -0.02em; display: inline-block; margin-bottom: ' + (home ? '18px' : '0') + '; }' +
'.mark b { color: #d9f24b; font-weight: 700; }' +
'.top { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; flex-wrap: wrap; }' +
'.top .box { flex: 1; min-width: 0; }' +
'.box { display: flex; gap: 8px; width: 100%; }' +
'.box input { flex: 1; min-width: 0; background: #212121; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px; padding: 12px 18px; color: #ececec; font: inherit; font-size: 15px; outline: none; }' +
'.box input:focus { border-color: #d9f24b; }' +
'.box input::placeholder { color: #8e8e8e; }' +
'.box button { background: #d9f24b; color: #1e230a; border: 0; border-radius: 999px; padding: 12px 20px; font: inherit; font-weight: 600; font-size: 15px; cursor: pointer; }' +
'.count { color: #8e8e8e; font-size: 12.5px; margin: 2px 2px 16px; }' +
'.hits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 22px; }' +
'.hit-title { font-size: 17px; color: #d9f24b; line-height: 1.35; overflow-wrap: anywhere; }' +
'.hit-title:hover { text-decoration: underline; }' +
'.hit-crumb { color: #b4b4b4; font-size: 12.5px; margin-top: 3px; word-break: break-all; }' +
'.hit-snip { color: #b4b4b4; font-size: 14px; line-height: 1.5; margin: 6px 0 0; overflow-wrap: anywhere; }' +
'.hit-meta { color: #8e8e8e; font-size: 11.5px; margin-top: 5px; }' +
'.answer { background: #212121; border-left: 3px solid #d9f24b; border-radius: 12px; padding: 14px 16px; font-size: 15px; line-height: 1.5; margin-bottom: 20px; }' +
'.correction { color: #b4b4b4; font-size: 14px; margin-bottom: 18px; }' +
'.correction a { color: #d9f24b; }' +
'.notice { background: #212121; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 18px; color: #b4b4b4; font-size: 14.5px; margin-bottom: 20px; }' +
'.pager { display: flex; gap: 10px; margin-top: 26px; }' +
'.pill { background: #212121; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px; padding: 9px 18px; font-size: 13.5px; color: #ececec; }' +
'.pill:hover { background: #2f2f2f; }' +
'.tabs { display: flex; align-items: center; gap: 6px; margin: -8px 0 20px; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }' +
'.tabset { display: flex; gap: 6px; }' +
'.tabs::-webkit-scrollbar { display: none; }' +
'.tab { padding: 8px 14px; border-radius: 999px; font-size: 14px; color: #b4b4b4; border: 1px solid transparent; }' +
'.tab:hover { color: #ececec; }' +
'.tab.on { color: #1e230a; background: #d9f24b; font-weight: 600; }' +
'.safe { margin-left: auto; display: inline-flex; background: #212121; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px; padding: 2px; flex: none; }' +
'.sf { padding: 6px 11px; border-radius: 999px; font-size: 12.5px; color: #8e8e8e; }' +
'.sf.on { background: #2f2f2f; color: #ececec; }' +
'.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; }' +
'.tile a { display: block; aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: #212121; }' +
'.tile img { width: 100%; height: 100%; object-fit: cover; display: block; }' +
'.tile-cap { color: #8e8e8e; font-size: 11.5px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
'.hit.has-th { display: flex; gap: 14px; align-items: flex-start; }' +
'.hit-body { min-width: 0; flex: 1; }' +
'.hit-th { width: 120px; flex: none; border-radius: 10px; background: #212121; object-fit: cover; aspect-ratio: 16/9; }' +
'.hit-th.news { width: 84px; aspect-ratio: 1; }' +
'.wrap.wide { max-width: 980px; }' +
'@media (max-width: 560px) { .tabs { flex-direction: column; align-items: flex-start; row-gap: 10px; } .tabset { max-width: 100%; overflow-x: auto; scrollbar-width: none; } .safe { margin-left: 2px; } .safe::before { content: "safe search"; color: #8e8e8e; font-size: 11.5px; padding: 8px 8px 0 10px; } }' +
'.foot { margin-top: 40px; color: #8e8e8e; font-size: 11.5px; text-align: center; }' +
'</style></head>' +
'<body><div class="wrap' + (home ? ' home' : '') + (cat === 'images' ? ' wide' : '') + '">' +
(home
	? '<div class="mark">ramjet<b>search</b></div>' + formHtml + tabsHtml
	: '<div class="top"><a class="mark" href="/searx/search">ramjet<b>search</b></a>' + formHtml + '</div>' + (query ? tabsHtml : '') + body) +
'<div class="foot">served from your own box &middot; results merge brave, bing and google &middot; queries go straight from the box to the engines</div>' +
'</div>' +
'<script>document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(/^https?:\\/\\//i.test(h)&&window.parent!==window){e.preventDefault();e.stopPropagation();parent.postMessage({rjBrowseGo:h},"*")}},true);</' + 'script>' +
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
	const result = q ? await sxFetch(q, page, cat, safe) : null;
	const hd = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
	if (u.searchParams.has('s')) hd['set-cookie'] = 'rjss=' + safe + '; Path=/searx; Max-Age=31536000; SameSite=Lax; HttpOnly';
	res.writeHead(200, hd);
	res.end(sxPage(q, page, result, cat, safe));
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
    if (!tk || tk.exp < Date.now()) { socket.destroy(); return; }
    return pwsUpgrade(req, socket, head, tk.user, (n) => { try { guard.trackBytes(tk.user, n); } catch {} });
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
