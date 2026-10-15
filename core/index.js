import { dataPath, DATA_ROOT } from './data.js';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync, readdirSync, statSync, openSync, fstatSync, closeSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { Auth } from './auth.js';
import { Guard } from './guard.js';
import { readJson as rjRead, writeJson as rjWrite } from './util.js';
import { readBody, sendJson, redirect, parseCookies, clientIp } from './util.js';
import { createHash } from 'node:crypto';
import { server as wisp } from '@mercuryworkshop/wisp-js';
import { readerPage } from './reader.js';
import { handleLite, setJetstream, setAuth } from './lite.js';
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
const DATA = DATA_ROOT;
const DIST = new URL('../web/dist', import.meta.url).pathname;
const ADDONS = new URL('./addons', import.meta.url).pathname;

const auth = new Auth(DATA);
const guard = new Guard(DATA);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.json': 'application/json', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
  '.wasm': 'application/wasm', '.mjs': 'text/javascript; charset=utf-8',
};

function page(name) {
  return PAGES.get(name) || null;
}
// build stamp for the engine/boot urls: pages reference them as
// ?v=__RJ_ENGINE__ and the stamp is swapped in at serve time, so every
// deploy serves them under urls no edge or browser cache has ever seen -
// a stale front cache can never mix last deploy's page with this deploy's
// engine (or this deploy's page with last deploy's engine).
const STAMPED_PATHS = new Set(['/scramjet/scramjet.js', '/scramjet/scramjet.wasm', '/controller/controller.api.js', '/controller/controller.sw.js', '/controller/controller.inject.js', '/epoxy/index.mjs', '/libcurl/index.mjs', '/browse-sw.js', '/cloak/theme-boot.js', '/cloak/palette.js']);
// stamped engine/boot files, every page, and the hashed bundles the pages
// reference are captured into memory ONCE at boot; everything downstream
// (the stamp, serving) uses these captured buffers and never re-reads the
// same file from disk, so a rebuild mid-boot or post-boot can never pair
// the boot stamp with later bytes. deploys must restart the process (docs
// in README.md): the stamp, the pinned bytes and the pages move together.
const PINNED = new Map();
for (const p of STAMPED_PATHS) PINNED.set(p, readFileSync(join(DIST, '.' + p))); // throws on a missing file, like the stamp
const PAGES = new Map();
{
  const pp = join(DIST, 'pages');
  if (existsSync(pp)) for (const name of readdirSync(pp)) {
    const f = join(pp, name, `${name}.html`);
    if (existsSync(f)) PAGES.set(name, readFileSync(f));
  }
}
// the pages are frozen at boot, so the content-hashed bundles they point
// at are part of the same snapshot: pin them too and serve the whole boot
// graph without a disk-existence gate
for (const html of PAGES.values()) {
  for (const m of html.toString('utf8').matchAll(/\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)/g)) {
    if (!PINNED.has(m[0])) PINNED.set(m[0], readFileSync(join(DIST, '.' + m[0])));
  }
}
const ENGINE_STAMP = (() => {
  // fail closed: a missing engine file or unreadable hash must stop the
  // server from booting, never let it serve a degenerate '0' stamp that
  // any cache could then pair with any revision
  const h = createHash('sha256');
  for (const p of STAMPED_PATHS) h.update(PINNED.get(p));
  // the browse entry rides the stamp too: page-bundle/protocol changes
  // must roll the stamp even when the vendor bytes are untouched
  const browseHtml = PAGES.get('browse');
  if (!browseHtml) throw new Error('browse page missing from build');
  h.update(browseHtml);
  const m = /\/assets\/(browse-[A-Za-z0-9_-]+\.js)/.exec(browseHtml.toString('utf8'));
  if (!m) throw new Error('browse bundle reference not found in built html');
  h.update(PINNED.get('/assets/' + m[1]));
  return h.digest('hex').slice(0, 12);
})();
function servePage(res, name, status = 200) {
  const html = page(name);
  if (!html) { res.writeHead(503, { 'content-type': 'text/plain' }); res.end('building... check back in a minute'); return; }
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  // swap only the quoted placeholder and the ?v= marker: a bare replaceAll
  // would rewrite the `self.__RJ_ENGINE__` identifier into invalid js
  res.end(html.toString('utf8').replaceAll('v=__RJ_ENGINE__', 'v=' + ENGINE_STAMP).replaceAll("'__RJ_ENGINE__'", "'" + ENGINE_STAMP + "'"));
}
// static files are read, compressed (brotli, else gzip) and kept in memory:
// the engine wasm and js are several MB and every byte crosses the tunnel.
// entries revalidate on mtime+size (a same-length rebuild never serves stale
// bytes) and carry etags, so a `no-cache` engine file revalidates with a
// cheap 304 instead of a full re-download on every browse page open.
const sCache = new Map();
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.html', '.json', '.svg', '.wasm', '.map']);
// read a static file race-safe: one fd, fstat before and after the read, so
// a concurrent rebuild can never pair old metadata with new bytes
function readStatic(safe) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd = null;
    try {
      fd = openSync(safe, 'r');
      const st1 = fstatSync(fd);
      if (!st1.isFile()) return null;
      const raw = readFileSync(fd);
      const st2 = fstatSync(fd);
      // the fd pins its own inode, so compare the PATH afterwards too: an
      // atomic replacement mid-read shows up as a path/fd inode mismatch
      let stPath;
      try { stPath = statSync(safe); } catch { return null; }
      if (st1.mtimeMs === st2.mtimeMs && st1.size === st2.size && st1.ctimeMs === st2.ctimeMs && st1.ino === st2.ino && stPath.ino === st2.ino && st2.size === raw.length) return { raw, st: st2 };
    } catch { return null; }
    finally { if (fd !== null) try { closeSync(fd); } catch {} }
  }
  return null; // raced a rebuild twice: decline rather than serve mixed bytes
}
function serveStatic(req, res, urlPath) {
  const safe = resolve(DIST, '.' + urlPath);
  if (!safe.startsWith(DIST)) return false;
  // pinned (stamped) entries are served from the boot snapshot with no
  // disk-existence gate: a rebuild or cleanup that removes them from disk
  // must not 404 the revision this process still serves. everything else
  // revalidates on mtime+size+ctime so a same-length rebuild with a
  // PRESERVED mtime still bumps ctime and its new bytes are re-read and
  // re-hashed
  const pinned = PINNED.get(urlPath);
  if (!pinned && (!existsSync(safe) || !statSync(safe).isFile())) return false;
  let e = sCache.get(safe);
  if (pinned && !e) {
    const hash = createHash('sha256').update(pinned).digest('hex').slice(0, 20);
    e = { mtimeMs: 0, ctimeMs: 0, size: pinned.length, raw: pinned, br: null, gz: null, etag: 'W/"' + pinned.length + '-' + hash + '"' };
    sCache.set(safe, e);
  }
  const st = pinned ? null : statSync(safe);
  if (!pinned && (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size || e.ctimeMs !== st.ctimeMs)) {
    const got = readStatic(safe);
    if (!got) return false;
    // etag is a content hash: size+rounded-mtime etags collide on a same-length
    // rebuild inside one millisecond, which is exactly the stale-engine case
    const hash = createHash('sha256').update(got.raw).digest('hex').slice(0, 20);
    e = { mtimeMs: got.st.mtimeMs, ctimeMs: got.st.ctimeMs, size: got.st.size, raw: got.raw, br: null, gz: null, etag: 'W/"' + got.st.size + '-' + hash + '"' };
    if (sCache.size >= 256) sCache.delete(sCache.keys().next().value);
    sCache.set(safe, e);
  }
  const cc = urlPath.startsWith('/cloak/') || /^\/(browse-sw\.js|scramjet\/|controller\/|epoxy\/|libcurl\/)/.test(urlPath) ? 'no-cache' : 'public, max-age=31536000, immutable';
  if (req.headers['if-none-match'] === e.etag) { res.writeHead(304, { etag: e.etag, 'cache-control': cc, vary: 'Accept-Encoding' }); res.end(); return true; }
  const ext = extname(safe);
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': cc, etag: e.etag };
  let body = e.raw;
  if (COMPRESSIBLE.has(ext) && body.length > 1024) {
    headers.vary = 'Accept-Encoding';
    // q=0 means NOT acceptable: br;q=0 must fall through to gzip or identity
    const ae = String(req.headers['accept-encoding'] || '');
    const q = (name) => { const m = new RegExp('(?:^|,)\\s*' + name + '\\s*(?:;\\s*q\\s*=\\s*([01](?:\\.\\d+)?))?').exec(ae); return m ? (m[1] === undefined ? 1 : Number(m[1])) : -1; };
    const enc = q('br') > 0 ? 'br' : q('gzip') > 0 ? 'gzip' : '';
    if (enc) {
      if (enc === 'br' && !e.br) e.br = brotliCompressSync(e.raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 6, [zc.BROTLI_PARAM_SIZE_HINT]: e.raw.length } });
      if (enc === 'gzip' && !e.gz) e.gz = gzipSync(e.raw, { level: 9 });
      body = enc === 'br' ? e.br : e.gz;
      headers['content-encoding'] = enc;
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


// Reader rendering and image proxy remain independent of search.
async function browseReader(req,res,session,restUrl){
 if(!session)return redirect(res,'/login');
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
 const u=new URL(restUrl,'http://x');
	if (u.pathname === '/img') {
		let t; try { t = new URL(u.searchParams.get('u') || ''); } catch { res.writeHead(400); return res.end(); }
		if (!/^https?:$/.test(t.protocol)) { res.writeHead(400); return res.end(); }
		const imgGuard = await new Promise((ok) => safeLookup(t.hostname.replace(/^\[|\]$/g, ''), {}, (e) => ok(!e)));
		if (!imgGuard) { res.writeHead(400); return res.end(); }
		const mod = t.protocol === 'https:' ? httpsRequest : httpRequest;
		const ur = mod(t, { headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0' }, lookup: safeLookup, timeout: 10000 }, (ir) => {
			if (ir.statusCode >= 300 && ir.statusCode < 400 && ir.headers.location && (parseInt(u.searchParams.get('h') || '0', 10) < 3)) { ir.resume(); let nx; try { nx = new URL(ir.headers.location, t); } catch { res.writeHead(404); return res.end(); } res.writeHead(302, { location: '/browse-reader/img?h=' + (parseInt(u.searchParams.get('h') || '0', 10) + 1) + '&u=' + encodeURIComponent(nx.href) }); return res.end(); }
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
 res.writeHead(404);res.end();
}

// accounts:
// anyone can request an account on /login; with approval on (the default,
// the earlier call: "approving should be optional but on by default") a new
// account sits pending until the admin approves it in settings.
const ADMIN = process.env.RJ_ADMIN || 'admin';
const CONFIG_PATH = dataPath('config.json');
const getConfig = () => ({ requireApproval: true, ...rjRead(CONFIG_PATH, {}) });
const RESERVED = new Set(['admin', 'administrator', 'root', 'ramjet', 'support', 'system']);
// names that carry authority or imply it. signup AND rename must enforce the
// same boundary, or an ordinary account claims the name-based admin /
// sync-admin authority (the sync addon gates on its own configured name).
const PROTECTED_NAMES = new Set([...RESERVED, ADMIN, process.env.RJ_SYNC_ADMIN || 'admin']);
const MAX_PENDING = 25;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  // the engine's virtual scramjet.wasm.js is normally answered by the page's service worker.
  // workers and some nested frames (captcha / bot-check scripts on login pages) are not
  // controlled by it, so their request fell through to a 404 and the engine died with
  // "WASM not found in global scope". answer it here too, same payload the worker builds.
  if (/^\/~\/sj\/[^/]+\/[^/]+\/scramjet\.wasm\.js$/.test(path) && (req.method === 'GET' || req.method === 'HEAD')) {
    try {
      if (!global.__rjWasmJs) {
        const wp = resolve(DIST, './scramjet/scramjet.wasm');
        const st = statSync(wp);
        const js = Buffer.from("self.WASM = '" + readFileSync(wp).toString('base64') + "';");
        global.__rjWasmJs = { js, gz: gzipSync(js, { level: 6 }), etag: 'W/"' + st.size + '-' + createHash('sha256').update(js).digest('hex').slice(0, 20) + '"' };
      }
      const w = global.__rjWasmJs;
      if (req.headers['if-none-match'] === w.etag) { res.writeHead(304, { etag: w.etag, vary: 'Accept-Encoding' }); return res.end(); }
      const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      const body = gz ? w.gz : w.js;
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag: w.etag, vary: 'Accept-Encoding', 'content-length': body.length, ...(gz ? { 'content-encoding': 'gzip' } : {}) });
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch { /* fall through */ }
  }
  if (path.startsWith('/api/lite/')) {
    // bearer-token api for the phone shortcut: outside cookie login, own auth + limits (core/lite.js)
    try {
      if (!global.__liteJet) { const j = await import('./addons/jetstream/index.js'); global.__liteJet = true; setJetstream(j.liteApi); }
      setAuth(auth);
      return await handleLite(req, res, url);
    } catch { if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); } return res.end('{"ok":false,"error":"failed"}'); }
  }
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
        return sendJson(res, 200, { ok: true, user: name }, { 'set-cookie': auth.cookieHeader(token, req) });
      }
      if (path === '/api/auth/signup' && req.method === 'POST') {
        if (!guard.allowLogin(`signup:${clientIp(req)}`, 40)) return sendJson(res, 429, { ok: false, error: 'too many tries - wait a few minutes' });
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const name = String(body.username || '').trim().toLowerCase();
        if (PROTECTED_NAMES.has(name)) return sendJson(res, 400, { ok: false, error: 'that name is taken' });
        const cfg = getConfig();
        if (cfg.requireApproval && auth.listUsers().filter((u) => u.status === 'pending').length >= MAX_PENDING) {
          return sendJson(res, 429, { ok: false, error: 'too many requests waiting right now - try again later' });
        }
        try { auth.createUser(name, body.password, cfg.requireApproval ? { status: 'pending' } : {}); }
        catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
        if (cfg.requireApproval) return sendJson(res, 200, { ok: true, pending: true });
        const token = auth.createSession(name);
        return sendJson(res, 200, { ok: true, user: name }, { 'set-cookie': auth.cookieHeader(token, req) });
      }
      if (path === '/api/auth/logout' && req.method === 'POST') {
        if (session) auth.destroySession(session.token);
        return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookieHeader(req) });
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
        // bind the ticket to the account's revocation generation: ban, logout,
        // removal or a password change after minting must invalidate it
        wispTickets.set(t, { user: session.user, exp: Date.now() + 90000, adblock, gen: auth.revGeneration(session.user) });
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
        // a password change revokes everything the old credential could have
        // minted: all 30-day sessions (incl. a stolen one), live proxy pipes,
        // outstanding tickets and the lite credential cache. the changing
        // browser gets a fresh session so it is not logged out of itself.
        auth.killSessions(session.user);
        const token = auth.createSession(session.user);
        return sendJson(res, 200, { ok: true }, { 'set-cookie': auth.cookieHeader(token, req) });
      }
      if (path === '/api/auth/claim-username' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        if (PROTECTED_NAMES.has(String(body.name || '').trim().toLowerCase())) return sendJson(res, 400, { ok: false, error: 'that name is taken' });
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
    if(path.startsWith('/browse-reader/'))return browseReader(req,res,session,path.slice(14)+(url.search||''));
    if (path.startsWith('/searx/')) {
      if (!session) return redirect(res, '/login');
      const query = url.searchParams.get('q') || '';
      return redirect(res, '/browse?q=' + encodeURIComponent(query));
    }
    // stamped engine urls are immutable content addresses: an old stamp
    // must never serve the new bytes, or a stale page silently mixes
    // revisions. unknown stamp -> 404 (loud, never mixed); no stamp ->
    // current bytes for backward-compatible/unversioned callers.
    const stampV = url.searchParams.get('v');
    if (stampV && stampV !== ENGINE_STAMP && STAMPED_PATHS.has(path)) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('superseded build - reload'); return; }
    if (path.startsWith('/assets/') || /^\/(favicon\.svg|favicon-32\.png|icon-192\.png|apple-touch-icon\.png|logo-512\.png|manifest\.webmanifest)$/.test(path) || path.startsWith('/cloak/') || path.startsWith('/scramjet/') || path.startsWith('/controller/') || path.startsWith('/epoxy/') || path.startsWith('/libcurl/') || path === '/browse-sw.js') {
      if (serveStatic(req, res, path)) return;
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

// live proxy pipes per user, so revocation (ban, admin logout, removal,
// password change, self logout) can cut the connections that authority
// already opened - killing sessions alone leaves them running
const liveProxy = new Map();
const trackProxy = (user, socket) => {
  let set = liveProxy.get(user);
  if (!set) liveProxy.set(user, (set = new Set()));
  set.add(socket);
  socket.on('close', () => { set.delete(socket); if (!set.size) liveProxy.delete(user); });
};
auth.onRevoked = (user) => { const set = liveProxy.get(user); if (set) for (const sock of [...set]) { try { sock.destroy(); } catch {} } };
auth.onRenamed = (oldName, newName) => { const set = liveProxy.get(oldName); if (set) { liveProxy.delete(oldName); liveProxy.set(newName, set); } };
// a ticket is valid only while the account behind it is: live, active, and
// on the same revocation generation it was minted under
const ticketOk = (tk) => {
  if (!tk || tk.exp < Date.now()) return false;
  const acct = auth.users[tk.user];
  if (!acct || (acct.status && acct.status !== 'active')) return false;
  return auth.revGeneration(tk.user) === tk.gen;
};

server.on('upgrade', (req, socket, head) => {
  if (!req.url) { socket.destroy(); return; }
  // cross-site websocket hijack guard: when a browser sends Origin it must
  // be this very host. non-browser clients send no Origin (deliberate
  // exception; they authenticate with a ticket or cookie like always).
  const origin = req.headers.origin;
  if (origin) {
    let ohost = null;
    try { ohost = new URL(origin).host; } catch {}
    if (!ohost || ohost !== req.headers.host) { socket.destroy(); return; }
  }
  // ticket rides in the path (/wisp-t/<ticket>/) because the browser
  // WebSocket API cannot set headers, and a query string breaks wisp's
  // request parsing. the url is rewritten to /wisp/ before wisp sees it.
  const pm = req.url.match(/^\/pws-t\/([a-f0-9]{48})/);
  if (pm) {
    const tk = wispTickets.get(pm[1]);
    // tickets are single-use: a valid one is consumed here so a leaked
    // ticket (they ride in the url path and can land in logs) cannot be
    // replayed within its 90s life. same-session reconnects fetch a fresh
    // ticket; the cookie fallback below still covers anything else.
    const tok = ticketOk(tk);
    if (tok) wispTickets.delete(pm[1]);
    let puser = tok ? tk.user : null;
    if (!puser) { const ps = auth.sessionFromCookies(parseCookies(req)); if (ps) puser = ps.user; }
    if (!puser) { socket.destroy(); return; }
    trackProxy(puser, socket);
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
    if (ticketOk(tk)) { wispTickets.delete(tm[1]); if (!session) { session = { user: tk.user }; gate = 'ticket-ok'; } adOn = tk.adblock !== false; }
  }
  if (tm) req.url = '/wisp/';
  console.log(`[wisp] upgrade ${gate || 'REJECTED'} ua="${ua}"`);
  if (!session) { socket.destroy(); return; }
  trackProxy(session.user, socket);
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
process.on("SIGTERM", () => { guard.flush(); process.exit(0); });
process.on("SIGINT", () => { guard.flush(); process.exit(0); });
