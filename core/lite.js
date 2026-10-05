// lite api: /api/lite/*  - bearer-token, read-only text/media view for a phone
// shortcut (no cookies, no JS). search -> jetstream's own backend, video ->
// finished H.264+AAC mp4 (see liteApi in jetstream), page/media -> SSRF-safe
// fetch. every outbound hop resolves once, pins the ip, and is checked against
// a full deny list. token lives in data/lite-token.secret (mode 600).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { statSync, appendFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { renderSheet } from './sheet.mjs';
import { parseDocument } from 'htmlparser2';
import * as DU from 'domutils';
import { clientIp } from './util.js';

const MAX_HTML = 2 * 1024 * 1024, MAX_IMG = 15 * 1024 * 1024, MAX_VID = 80 * 1024 * 1024;
let jet = null, acct = null;
// ---- contact sheet: one numbered JPEG of the top results (thumbnail + number + short title) ----
function getThumb(src) {
  return new Promise((resolve, reject) => {
    let host = 'i.ytimg.com', pth = '/vi/' + src + '/mqdefault.jpg';
    if (/^https:\/\//.test(src)) { const u = new URL(src); if (!/^ts\d?\.mm\.bing\.net$/.test(u.hostname)) return reject(new Error('thumb host')); host = u.hostname; pth = u.pathname + u.search; }
    const rq = https.get({ host, path: pth, timeout: 8000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('thumb ' + r.statusCode)); }
      const ch = []; let n = 0;
      r.on('data', (d) => { n += d.length; if (n > 400000) { rq.destroy(); reject(new Error('thumb too big')); } else ch.push(d); });
      r.on('end', () => resolve(Buffer.concat(ch)));
    });
    rq.on('error', reject); rq.on('timeout', () => rq.destroy(new Error('thumb timeout')));
  });
}
async function makeSheet(items) {
  const dir = await mkdtemp(nodePath.join(tmpdir(), 'sheet-'));
  try {
    const ok = [];
    await Promise.all(items.map(async (it, i) => { try { await writeFile(nodePath.join(dir, 't' + i + '.jpg'), await getThumb(it.thumbSrc || it.id)); ok[i] = true; } catch { ok[i] = false; } }));
    const idx = items.map((_, i) => i).filter((i) => ok[i]);
    if (!idx.length) throw Object.assign(new Error('no thumbnails'), { code: 502 });
    return { buf: await renderSheet(dir, items, idx), shown: idx.map((i) => i + 1) };
  } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

export function setJetstream(api) { jet = api; }
export function setAuth(a) { acct = a; }
// auth = the ramjet account login (username + password), checked by ramjet's own
// auth.verify. header is Basic base64(user:pass) or Bearer user:pass. plaintext is
// never stored or logged; a short in-memory cache keyed by sha256 skips repeat scrypt.
const okCache = new Map();
function credOk(h) {
  const m = /^(Basic|Bearer) (\S{3,400})$/.exec(String(h || ''));
  if (!m || !acct) return false;
  let cred = m[2];
  if (m[1] === 'Basic') { try { cred = Buffer.from(cred, 'base64').toString('utf8'); } catch { return false; } }
  const i = cred.indexOf(':');
  if (i < 1) return false;
  const k = createHash('sha256').update(cred).digest('hex');
  const hit = okCache.get(k);
  if (hit && hit > Date.now()) return true;
  let u = null;
  try { u = acct.verify(cred.slice(0, i), cred.slice(i + 1)); } catch { return false; }
  if (!u || (u.status && u.status !== 'approved' && u.status !== 'active')) return false;
  okCache.set(k, Date.now() + 5 * 60 * 1000);
  if (okCache.size > 50) okCache.delete(okCache.keys().next().value);
  return true;
}

// ---- auth + limits ----
const bad = new Map();   // ip -> {n, until}
const hits = new Map();  // key -> [timestamps]
const live = new Map();  // key -> concurrent
let videoBusy = 0;
setInterval(() => { const now = Date.now(); for (const [k, v] of bad) if (v.until < now && now - (v.last || 0) > 900000) bad.delete(k); for (const [k, a] of hits) { while (a.length && now - a[0] > 60000) a.shift(); if (!a.length) hits.delete(k); } }, 60000).unref();

const json = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': b.length }); res.end(b); };

// ---- ssrf ----
function v4(ip) { return ip.split('.').map(Number); }
function blockedIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); if (m) return blockedIp(m[1]);
    if (l.startsWith('::ffff:') || l.startsWith('64:ff9b') || l.startsWith('2002:')) return true; // mapped / nat64 / 6to4: refuse outright
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff')) return true;
    return false;
  }
  if (!net.isIPv4(ip)) return true;
  const [a, b, c] = v4(ip);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}
// resolve once, return the pinned address (throws on anything private)
async function pin(host) {
  host = host.replace(/^\[|\]$/g, '');
  if (!host || host.length > 253) throw new Error('bad host');
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|host\.docker\.internal)$/i.test(host)) throw new Error('blocked address');
  if (net.isIP(host)) { if (blockedIp(host)) throw new Error('blocked address'); return { address: host, family: net.isIPv6(host) ? 6 : 4 }; }
  // odd encodings (decimal 2130706433, hex 0x7f.1, octal 0177.1) are numeric-looking hosts: refuse
  if (/^[0-9a-fx.]+$/i.test(host) && !/[g-z]/i.test(host)) throw new Error('blocked address');
  const list = await dns.promises.lookup(host, { all: true });
  if (!list.length) throw new Error('no address');
  for (const r of list) if (blockedIp(r.address)) throw new Error('blocked address'); // any private answer taints the name
  const r = list.find((x) => x.family === 4) || list[0];
  return { address: r.address, family: r.family };
}
function checkUrl(u) {
  let t; try { t = new URL(u); } catch { throw new Error('bad url'); }
  if (!/^https?:$/.test(t.protocol) || t.username || t.password) throw new Error('bad url');
  const port = t.port ? Number(t.port) : (t.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) throw new Error('port not allowed');
  return t;
}
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// one request, no auto-redirect, pinned ip, no cookies/auth upstream
function hop(t, accept, ip) {
  return new Promise((resolve, reject) => {
    const mod = t.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: t.protocol, hostname: t.hostname.replace(/^\[|\]$/g, ''), port: t.port || undefined, path: t.pathname + t.search, method: 'GET',
      headers: { accept, 'accept-encoding': 'gzip, br', 'user-agent': UA, host: t.host },
      lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: ip.address, family: ip.family }]) : cb(null, ip.address, ip.family)),
      servername: net.isIP(t.hostname.replace(/^\[|\]$/g, '')) ? undefined : t.hostname,
      timeout: 10000, agent: false,
    }, resolve);
    const kill = setTimeout(() => req.destroy(new Error('timed out')), 30000);
    req.on('close', () => clearTimeout(kill));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject); req.end();
  });
}
async function safeGet(url, accept) {
  let t = checkUrl(url);
  for (let i = 0; i <= 5; i++) {
    const ip = await pin(t.hostname);
    const r = await hop(t, accept, ip);
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
      r.resume();
      if (i === 5) throw new Error('too many redirects');
      t = checkUrl(new URL(r.headers.location, t).href);
      continue;
    }
    return { res: r, url: t.href };
  }
  throw new Error('too many redirects');
}
function body(r) { const e = String(r.headers['content-encoding'] || ''); return e === 'gzip' ? r.pipe(zlib.createGunzip()) : e === 'br' ? r.pipe(zlib.createBrotliDecompress()) : r; }
function collect(src, cap, onOver) {
  return new Promise((resolve, reject) => {
    const ch = []; let n = 0;
    src.on('data', (c) => { n += c.length; if (n > cap) { src.destroy(); reject(new Error(onOver)); } else ch.push(c); });
    src.on('end', () => resolve(Buffer.concat(ch))); src.on('error', reject);
  });
}

// ---- page ----
const DROP = new Set(['script', 'style', 'nav', 'header', 'footer', 'aside', 'form', 'iframe', 'noscript', 'svg', 'button', 'select', 'input', 'textarea', 'dialog', 'template', 'canvas']);
const tx = (n) => DU.textContent(n).replace(/\s+/g, ' ').trim();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mediaUrl = (u, kind) => '/api/lite/media?kind=' + kind + '&u=' + encodeURIComponent(u);
async function pageData(u) {
  const { res: r, url } = await safeGet(u, 'text/html,application/xhtml+xml');
  if (r.statusCode !== 200) { r.resume(); throw new Error('the site answered ' + r.statusCode); }
  if (!/html/i.test(String(r.headers['content-type'] || ''))) { r.resume(); throw new Error('not a web page'); }
  const html = (await collect(body(r), MAX_HTML, 'page too large')).toString('utf8');
  const root = parseDocument(html);
  const title = (() => { const h = DU.findOne((e) => e.name === 'title', root.children); return h ? tx(h).slice(0, 300) : ''; })();
  const vids = new Set(); const imgs = []; const seenImg = new Set();
  const abs = (s) => { try { const a = new URL(s, url).href; return /^https?:/.test(a) ? a : ''; } catch { return ''; } };
  for (const e of DU.findAll((e) => e.name === 'video' || (e.name === 'source' && e.parent?.name === 'video') || (e.name === 'meta' && /og:video/.test(e.attribs.property || '')), root.children)) {
    const s = abs(e.attribs.src || e.attribs.content || ''); if (s) vids.add(s);
  }
  for (const e of DU.findAll((e) => e.name === 'iframe', root.children)) { const m = /youtube(?:-nocookie)?\.com\/embed\/([\w-]{11})/.exec(e.attribs.src || ''); if (m) vids.add('https://www.youtube.com/watch?v=' + m[1]); }
  const ogimg = DU.findOne((e) => e.name === 'meta' && e.attribs.property === 'og:image', root.children);
  const lead = ogimg ? abs(ogimg.attribs.content) : '';
  if (lead) { seenImg.add(lead); imgs.push({ url: lead, alt: '' }); }
  for (const x of DROP) for (const e of DU.findAll((e) => e.name === x, root.children)) DU.removeElement(e);
  const out = []; const links = []; let pcount = 0;
  const walk = (n) => {
    if (n.type === 'text') return;
    if (n.type !== 'tag') return;
    if (n.name === 'img') {
      const s = abs(n.attribs.src || n.attribs['data-src'] || (n.attribs.srcset || '').split(',')[0].trim().split(/\s+/)[0]);
      const w = parseInt(n.attribs.width || '0', 10), h = parseInt(n.attribs.height || '0', 10);
      if (s && !seenImg.has(s) && !(w && w < 80) && !(h && h < 60) && imgs.length < 40) { seenImg.add(s); imgs.push({ url: s, alt: (n.attribs.alt || '').slice(0, 200) }); out.push({ t: 'img', i: imgs.length - 1 }); }
      return;
    }
    if (n.name === 'a') { const h = abs(n.attribs.href || ''); const t = tx(n).slice(0, 160); if (h && t && links.length < 100) links.push({ text: t, url: h }); }
    if (/^(p|h[1-6]|li|blockquote|pre|figcaption)$/.test(n.name)) {
      const kids = (n.children || []).filter((c) => c.type === 'tag' && c.name === 'img');
      const t = tx(n); if (t && pcount < 30000) { pcount += t.length; out.push({ t: /^h[1-6]$/.test(n.name) ? 'h' : n.name === 'li' ? 'li' : 'p', x: t.slice(0, 2000) }); }
      for (const k of kids) walk(k);
      for (const c of n.children || []) if (c.type === 'tag' && c.name === 'a') walk(c);
      return;
    }
    for (const c of n.children || []) walk(c);
  };
  walk({ type: 'tag', name: 'div', children: root.children });
  const text = out.filter((x) => x.t !== 'img').map((x) => (x.t === 'h' ? '\n' + x.x + '\n' : x.t === 'li' ? '- ' + x.x : x.x)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 60000);
  return { title, url, text, links, images: imgs.map((x) => x.url), imgAlts: imgs.map((x) => x.alt), videos: [...vids].slice(0, 10), blocks: out, imgs };
}
function pageHtml(d) {
  const b = d.blocks.map((x) => {
    if (x.t === 'img') { const im = d.imgs[x.i]; return '<p><img src="' + esc(mediaUrl(im.url, 'image')) + '" alt="' + esc(im.alt) + '" style="max-width:100%"></p>'; }
    if (x.t === 'h') return '<h2>' + esc(x.x) + '</h2>';
    if (x.t === 'li') return '<li>' + esc(x.x) + '</li>';
    return '<p>' + esc(x.x) + '</p>';
  }).join('\n');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(d.title) + '</title><style>body{font:17px/1.6 -apple-system,system-ui,sans-serif;margin:16px;max-width:680px}</style></head><body><h1>' + esc(d.title) + '</h1>' + b + '<hr><p><small>' + esc(d.url) + '</small></p></body></html>';
}

// ---- media ----
function ffJpeg(buf, full) {
  return new Promise((resolve, reject) => {
    const ff = spawn('nice', ['-n', '10', 'ffmpeg', '-v', 'error', '-i', 'pipe:0', '-frames:v', '1', ...(full ? ['-q:v', '2'] : ['-vf', "scale='min(1600,iw)':-2", '-q:v', '4']), '-f', 'mjpeg', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const ch = []; ff.stdout.on('data', (c) => ch.push(c));
    const to = setTimeout(() => ff.kill('SIGKILL'), 20000);
    ff.on('close', (c) => { clearTimeout(to); const o = Buffer.concat(ch); c === 0 && o.length ? resolve(o) : reject(new Error('could not read that image')); });
    ff.stdin.on('error', () => {}); ff.on('error', reject); ff.stdin.end(buf);
  });
}
async function mediaImage(res, u, full) {
  const { res: r } = await safeGet(u, 'image/*');
  const ct = String(r.headers['content-type'] || '');
  if (r.statusCode !== 200 || !/^image\/(jpeg|png|webp|gif|avif|bmp)/i.test(ct)) { r.resume(); throw new Error('not an image'); }
  const raw = await collect(body(r), MAX_IMG, 'image too large');
  let out = raw, type = ct.split(';')[0];
  if (full ? !/^image\/(jpeg|png)/.test(type) : (raw.length > 400 * 1024 || !/jpeg/.test(type))) { try { out = await ffJpeg(raw, full); type = 'image/jpeg'; } catch { if (!/^image\/(jpeg|png|gif)/.test(type)) throw new Error('could not read that image'); } }
  const ext = type === 'image/png' ? 'png' : type === 'image/gif' ? 'gif' : 'jpg';
  res.writeHead(200, { 'content-type': type, 'content-length': out.length, 'content-disposition': 'inline; filename="image.' + ext + '"', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
  res.end(out);
}
async function mediaVideo(res, u) {
  if (videoBusy >= 1) throw Object.assign(new Error('one video at a time, try again in a moment'), { code: 429 });
  videoBusy++;
  try {
    const { res: r } = await safeGet(u, 'video/mp4,video/*');
    const ct = String(r.headers['content-type'] || '').split(';')[0];
    if (r.statusCode !== 200 || !/^video\/(mp4|quicktime|x-m4v)$/i.test(ct)) { r.resume(); throw new Error('not an mp4 (use /api/lite/video for YouTube ids)'); }
    const len = Number(r.headers['content-length'] || 0);
    if (len > MAX_VID) { r.resume(); throw new Error('video too large'); }
    const hd = { 'content-type': 'video/mp4', 'content-disposition': 'inline; filename="video.mp4"', 'cache-control': 'private, no-store' };
    if (len && !r.headers['content-encoding']) hd['content-length'] = len;
    res.writeHead(200, hd);
    let n = 0;
    await new Promise((ok) => {
      r.on('data', (c) => { n += c.length; if (n > MAX_VID) { r.destroy(); res.destroy(); ok(); } else if (!res.write(c)) { r.pause(); res.once('drain', () => r.resume()); } });
      r.on('end', () => { res.end(); ok(); }); r.on('error', () => { res.destroy(); ok(); }); res.on('close', () => { r.destroy(); ok(); });
    });
  } finally { videoBusy--; }
}

// ---- handler ----
async function searchRetry(q) {
  let r = await jet.search(q);
  if (!r || !r.length) { await new Promise((x) => setTimeout(x, 700)); r = await jet.search(q); }
  return r || [];
}
function messageImage(text) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x0d0e12:s=632x220', '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${text.replace(/[^A-Za-z0-9 .,]/g, '')}':fontsize=30:fontcolor=0xffa028:x=(w-text_w)/2:y=(h-text_h)/2`, '-frames:v', '1', '-q:v', '4', '-f', 'mjpeg', 'pipe:1'];
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] }); const ch = [];
    ff.stdout.on('data', (c) => ch.push(c)); ff.on('close', (c) => { const o = Buffer.concat(ch); c === 0 && o.length ? resolve(o) : reject(new Error('msg image')); }); ff.on('error', reject);
  });
}
const SXI_CACHE = new Map();
async function searxImages(q, pg, safe) {
  const lvl = safe === 'off' ? 0 : safe === 'strict' ? 2 : 1;
  const per = 1000, start = (pg - 1) * 8, pn = Math.floor(start / per) + 1;
  const key = [q.toLowerCase(), pn, lvl].join('|');
  let list = SXI_CACHE.get(key);
  if (!list || Date.now() - list.at > 300000) {
    const r = await fetch('http://127.0.0.1:8888/search?q=' + encodeURIComponent(q) + '&categories=images&format=json&pageno=' + pn + '&safesearch=' + lvl, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('searxng ' + r.status);
    const d = await r.json(); const seen = new Set(), arr = [];
    for (const x of d.results || []) {
      const full = x.img_src; if (!full || !/^https?:\/\//.test(full) || seen.has(full)) continue; seen.add(full);
      let host = ''; try { host = new URL(x.url || full).hostname.replace(/^www\./, ''); } catch {}
      const th = String(x.thumbnail_src || x.thumbnail || full).replace(/^http:/, 'https:');
      arr.push({ title: String(x.title || host || 'image').replace(/<[^>]*>/g, '').replace(/[\ue000-\ue00f]/g, ''), site: host, full, thumbSrc: th });
    }
    list = { at: Date.now(), arr }; SXI_CACHE.set(key, list); if (SXI_CACHE.size > 60) SXI_CACHE.delete(SXI_CACHE.keys().next().value);
  }
  return list.arr.slice(start % per, start % per + 8);
}
async function imageSearch(q, pg, safe) { return searxImages(q, pg, safe); }

export async function handleLite(req, res, url) {
  try { const t0 = Date.now(); res.on('finish', () => { try { appendFileSync('/app/data/lite-access.log', new Date().toISOString() + ' ' + req.method + ' ' + url.pathname + ' q=' + String(url.searchParams.get('q') || '').slice(0, 40) + ' page=' + (url.searchParams.get('page') || '') + ' ' + res.statusCode + ' ' + (Date.now() - t0) + 'ms\n'); } catch {} }); } catch {}
  const path = url.pathname.replace(/^\/api\/lite/, '') || '/';
  const ip = clientIp(req);
  const now = Date.now();
  const b = bad.get(ip);
  if (b && b.until > now) return json(res, 429, { ok: false, error: 'locked out, try later' });
  const okTok = !!credOk(req.headers.authorization);
  if (!okTok) {
    const e = b || { n: 0, until: 0 }; e.n++; e.last = now;
    if (e.n >= 10) { e.until = now + 15 * 60 * 1000; e.n = 0; }
    bad.set(ip, e);
    res.setHeader('www-authenticate', 'Bearer');
    return json(res, 401, { ok: false, error: 'unauthorized' });
  }
  if (bad.has(ip)) bad.delete(ip);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, error: 'GET only' });
  const key = 'lite';
  const a = hits.get(key) || []; while (a.length && now - a[0] > 60000) a.shift();
  if (a.length >= 60) return json(res, 429, { ok: false, error: 'rate limit: 60 per minute' });
  a.push(now); hits.set(key, a);
  if ((live.get(key) || 0) >= 5) return json(res, 429, { ok: false, error: 'too many at once (max 5)' });
  live.set(key, (live.get(key) || 0) + 1);
  const done = () => live.set(key, Math.max(0, (live.get(key) || 1) - 1));
  res.on('close', done);
  try {
    const sp = url.searchParams;
    if (path === '/health') return json(res, 200, { ok: true, service: 'ramjet-lite', time: new Date().toISOString() });
    if (path === '/search') {
      const q = (sp.get('q') || '').trim();
      if (!q || q.length > 120) return json(res, 400, { ok: false, error: 'q required, under 120 chars' });
      const pg = Math.max(1, Math.min(20, Number(sp.get('page')) || 1));
      const all = await searchRetry(q); const rs = all.slice((pg - 1) * 8, pg * 8);
      const clip = (x, n) => { x = String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + '\u2026' : x; };
      const fmtViews = (x) => { if (x == null || x === '') return ''; const n = Number(String(x).replace(/[,\s]|views?/gi, '')); if (!isNaN(n)) return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M views' : n >= 1e3 ? Math.round(n / 1e3) + 'K views' : n + ' views'; return clip(x, 18); };
      const out = rs.map((v) => { const label = [clip(v.title, 52), clip(v.channel, 20), v.duration ? clip(v.duration, 9) : '', fmtViews(v.views)].filter(Boolean).join(' - '); return { id: v.id, title: v.title, channel: v.channel, duration: v.duration, views: v.views, label, line: label + '||' + v.id, thumb: mediaUrl('https://i.ytimg.com/vi/' + v.id + '/mqdefault.jpg', 'image'), video: '/api/lite/video?id=' + v.id }; });
      return json(res, 200, { ok: true, q, results: out, lines: out.map((x) => x.line), page: pg, per_page: 8, has_more: all.length > pg * 8, next_page: all.length > pg * 8 ? pg + 1 : null });
    }
    if (path === '/sheet') {
      const q = (sp.get('q') || '').trim();
      if (!q || q.length > 120) return json(res, 400, { ok: false, error: 'q required, under 120 chars' });
      const n = Math.min(8, Math.max(1, Number(sp.get('n')) || 8));
      const pg = Math.max(1, Math.min(20, Number(sp.get('page')) || 1));
      const rs = (await searchRetry(q)).slice((pg - 1) * 8, (pg - 1) * 8 + n);
      if (!rs.length) { const m = await messageImage(pg > 1 ? 'No more results' : 'No results found'); res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': m.length, 'cache-control': 'no-store' }); return res.end(m); }
      const { buf } = await makeSheet(rs);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(buf);
    }
    if (path === '/imgsearch' || path === '/imgsheet') {
      const q = (sp.get('q') || '').trim();
      if (!q || q.length > 120) return json(res, 400, { ok: false, error: 'q required, under 120 chars' });
      const pg = Math.max(1, Math.min(20, Number(sp.get('page')) || 1));
      let items; try { items = await imageSearch(q, pg, sp.get('safe') || ''); } catch (e) { return json(res, 502, { ok: false, error: 'image search failed: ' + String(e.message).slice(0, 80) }); }
      if (!items.length) return json(res, 404, { ok: false, error: 'no results on this page', page: pg });
      if (path === '/imgsheet') {
        const { buf } = await makeSheet(items.map((x) => ({ thumbSrc: x.thumbSrc, title: x.title })));
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length, 'cache-control': 'no-store' });
        return res.end(buf);
      }
      const clip2 = (x, n) => { x = String(x).replace(/\s+/g, ' ').trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + '\u2026' : x; };
      const results = items.map((x, i) => { const label = (i + 1) + '. ' + clip2(x.title, 48) + (x.site ? ' - ' + clip2(x.site, 22) : ''); return { n: i + 1, title: x.title, site: x.site, label, line: label + '||' + (i + 1), image: mediaUrl(x.full, 'image') + '&orig=1&fb=' + encodeURIComponent(x.thumbSrc), image_small: mediaUrl(x.full, 'image') + '&fb=' + encodeURIComponent(x.thumbSrc), thumb: mediaUrl(x.thumbSrc, 'image') }; });
      return json(res, 200, { ok: true, q, page: pg, per_page: 8, results, lines: results.map((x) => x.line), has_more: true, next_page: pg + 1 });
    }
    if (path === '/page') {
      const d = await pageData(sp.get('u') || '');
      if (sp.get('format') === 'html') { const h = Buffer.from(pageHtml(d)); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': h.length, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }); return res.end(h); }
      return json(res, 200, { ok: true, title: d.title, url: d.url, text: d.text, links: d.links, images: d.images.map((x) => mediaUrl(x, 'image')), videos: d.videos });
    }
    if (path === '/media') {
      const kind = sp.get('kind');
      try {
        if (kind === 'image') try { return await mediaImage(res, sp.get('u') || '', sp.get('orig') === '1'); }
          catch (e0) { const fb = sp.get('fb') || ''; let ok = false; try { ok = /^ts\d?\.mm\.bing\.net$/.test(new URL(fb).hostname); } catch {} if (!ok || res.headersSent) throw e0; return await mediaImage(res, fb, false); }
        if (kind === 'video') return await mediaVideo(res, sp.get('u') || '');
      } catch (e) { if (res.headersSent) return res.destroy(); return json(res, e.code || 502, { ok: false, error: String(e.message).slice(0, 160) }); }
      return json(res, 400, { ok: false, error: 'kind=image|video' });
    }
    if (path === '/video') {
      const id = sp.get('id') || '';
      if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return json(res, 400, { ok: false, error: 'id must be an 11-char video id' });
      const q = [360, 480, 720].includes(Number(sp.get('q'))) ? Number(sp.get('q')) : 480;
      const entry = await jet.resolveStream(id);
      const plan = jet.litePlan(entry, q);
      if (plan.secs && plan.secs > jet.LITE_MAX_SECS) return json(res, 413, { ok: false, error: 'longer than 15 minutes; try q=360', seconds: plan.secs });
      if (plan.est > jet.LITE_MAX_BYTES) return json(res, 413, { ok: false, error: 'about ' + Math.round(plan.est / 1048576) + ' MB, over the 150 MB cap; try q=360', est_mb: Math.round(plan.est / 1048576) });
      if (sp.get('info') === '1') return json(res, 200, { ok: true, id, q, height: plan.height, mode: plan.mode, seconds: plan.secs, est_bytes: plan.est });
      let file;
      try { file = await jet.makeVideo(id, q, entry); } catch (e) { return json(res, e.message === 'too big' ? 413 : 502, { ok: false, error: e.message === 'too big' ? 'over the 150 MB cap; try q=360' : 'could not build that video, try another or q=360' }); }
      const size = statSync(file).size;
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': size, 'content-disposition': 'inline; filename="' + id + '.mp4"', 'cache-control': 'private, no-store', 'accept-ranges': 'none' });
      const { createReadStream } = await import('node:fs');
      return createReadStream(file).pipe(res);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    if (res.headersSent) return res.destroy();
    return json(res, e.code || 502, { ok: false, error: String(e.message || 'failed').slice(0, 160) });
  }
}
