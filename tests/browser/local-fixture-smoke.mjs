// ramjet r11 local-fixture browse smoke (spec: ramjet-r11-local-fixture-browse-smoke-spec).
// Loopback only: browser -> ramjet (local) -> fixture origin (127.0.0.1). No external network.
// Four-part capture per pageerror: stack + sourceURL + raw body bytes + content-type.
//   RJ_PLAYWRIGHT=/path/to/playwright/index.mjs RJ_CHROME=/path/to/chrome node tests/browser/local-fixture-smoke.mjs
process.env.RJ_TEST_HOOKS = '1';
const { chromium } = await import(process.env.RJ_PLAYWRIGHT || '/tmp/jet-regression/node_modules/playwright/index.mjs');
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../../core/auth.js';
import { startServer } from '../fixtures/start-server.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const artifacts = mkdtempSync(join(tmpdir(), 'rj-r11-smoke-'));
mkdirSync(join(artifacts, 'bodies'));

// deterministic >=1MB minified-looking js (mulberry32)
function genLarge() {
  let s = 0x9e3779b9; const rnd = () => (s = (s + 0x6D2B79F5) | 0, ((Math.imul(s ^ (s >>> 15), 1 | s) ^ (s + Math.imul(s ^ (s >>> 7), 61 | s))) ^ 14) >>> 0);
  let out = 'var _=[';
  while (out.length < 1024 * 1024) out += rnd().toString() + ',';
  return out + '0];';
}
const LARGE = genLarge();
const BOM = '﻿';
const files = {
  '/js/classic-throw.js': { type: 'application/javascript', body: `throw new Error('classic boom');\n//# sourceURL=classic.js\n` },
  '/js/classic.js': { type: 'application/javascript', body: `(function(){window.__classic=1})();\n//# sourceURL=classic.js\n` },
  '/js/module.js': { type: 'application/javascript', body: `import './dep.js';window.__module=window.__dep;\n` },
  '/js/dep.js': { type: 'application/javascript', body: `window.__dep=7;\n` },
  '/js/edge-bom.js': { type: 'application/javascript', body: BOM + `window.__bom=1;\n` },
  '/js/edge-scriptclose.js': { type: 'application/javascript', body: `window.__sc="</script>";\n` },
  '/js/edge-unicode.js': { type: 'application/javascript', body: 'const caf\u00e9=1;\u2028window.__uni=caf\u00e9;\n' },
  '/js/large.min.js': { type: 'application/javascript', body: LARGE },
  '/js/wrong-type.js': { type: 'text/html', body: `window.__wrongtype=1;\n` },
  '/js/nosniff.js': { type: 'text/plain', headers: { 'x-content-type-options': 'nosniff' }, body: `window.__nosniff=1;\n` },
  '/api/data.json': { type: 'application/json', body: `{"ok":true}\n` },
  '/style.css': { type: 'text/css', body: `body{margin:0}\n` },
  '/sw/v1/sw.js': { type: 'application/javascript', body: `const C='ramjet-fixture-v1';self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.add('./app.js')).then(()=>self.skipWaiting()))});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))});\n` },
  '/sw/v1/app.js': { type: 'application/javascript', body: `window.__appVersion='v1';\n` },
  '/sw/v2/sw.js': { type: 'application/javascript', body: `const C='ramjet-fixture-v2';self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.add('./app.js')).then(()=>self.skipWaiting()))});self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});self.addEventListener('fetch',e=>{e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)))});\n` },
  '/sw/v2/app.js': { type: 'application/javascript', body: `window.__appVersion='v2';\n` },
};
const manifest = {};
for (const [p, f] of Object.entries(files)) manifest[p] = { sha256: sha256(Buffer.from(f.body, 'utf8')), type: f.type, size: Buffer.byteLength(f.body) };

let swVersion = 1; // fixture-side toggle, no proxy restart
const accessLog = [];
const fixture = http.createServer((req, res) => {
  const ip = req.socket.remoteAddress;
  accessLog.push({ url: req.url, ip, t: Date.now() });
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') { console.error('STOP: non-loopback fixture hit from', ip); process.exit(2); }
  const u = new URL(req.url, 'http://fixture');
  const path = u.pathname;
  if (path === '/') {
    const b = `<!doctype html><meta charset=utf-8><link rel=stylesheet href=/style.css><script src=/js/classic.js><\/script><script type=module src=/js/module.js><\/script><script>window.__inline=1<\/script><script>fetch('/api/data.json')<\/script>fixture index`;
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(b);
  }
  if (path === '/t/') {
    const src = u.searchParams.get('src'), type = u.searchParams.get('type') || 'classic';
    const tag = type === 'module' ? `<script type="module" src="${src}"><\/script>` : `<script src="${src}"><\/script>`;
    const rec = `<script>window.__errs=[];addEventListener('error',e=>window.__errs.push({m:String(e.message),f:String(e.filename),l:e.lineno,c:e.colno}))<\/script>`;
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<!doctype html><meta charset=utf-8>${rec}${tag}`);
  }
  if (path === '/sw/') {
    const b = `<!doctype html><meta charset=utf-8><script>
window.__swlog=[];const slog=(k,d)=>window.__swlog.push(Object.assign({k,t:Date.now()},d));
navigator.serviceWorker.addEventListener('controllerchange',()=>slog('controllerchange'));
navigator.serviceWorker.register('./v${swVersion}/sw.js').then(r=>{
  slog('registering',{scope:r.scope});
  r.addEventListener('updatefound',()=>{const w=r.installing;slog('updatefound');w.addEventListener('statechange',()=>slog('state',{state:w.state}))});
  if(r.installing)r.installing.addEventListener('statechange',e=>slog('state',{state:e.target.state}));
  if(r.active)slog('active-already',{scriptURL:r.active.scriptURL});
}).catch(e=>slog('register-error',{msg:String(e)}));
<\/script><script src="./v${swVersion}/app.js"><\/script>sw page v${swVersion}`;
    res.writeHead(200, { 'content-type': 'text/html' }); return res.end(b);
  }
  const f = files[path];
  if (f) { res.writeHead(200, { 'content-type': f.type, ...(f.headers || {}) }); return res.end(f.body); }
  res.writeHead(404); res.end('nf');
});
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const fPort = fixture.address().port;
const fBase = `http://127.0.0.1:${fPort}`;
writeFileSync(join(artifacts, 'fixture-manifest.json'), JSON.stringify(manifest, null, 2));

const root = mkdtempSync(join(tmpdir(), 'rj-smoke-'));
new Auth(root).createUser('reviewer', 'fixture-password');
const s = await startServer(root);
s.child.stdout.on('data', (b) => { const t = String(b); if (/wisp|pws|error/i.test(t)) console.error('[srv]', t.trim().slice(0, 200)); });
s.child.stderr.on('data', (b) => console.error('[srv err]', String(b).trim().slice(0, 200)));
const browser = await chromium.launch({ executablePath: process.env.RJ_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });

const pageerrors = [], consoleMsgs = [], responses = [], pending = [];
let settledCaptures = 0;
let currentStep = 'init';
let KEY = null; // hex key from /api/apps/browse/urlkey, fetched after login
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function ks(K, nc, n) { let s = 2166136261, i, x; for (i = 0; i < K.length; i++) { s ^= K[i]; s = Math.imul(s, 16777619) >>> 0; } for (i = 0; i < nc.length; i++) { s ^= nc[i]; s = Math.imul(s, 16777619) >>> 0; } x = s || 88675123; const o = new Uint8Array(n); for (i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; o[i] = (x ^ K[i % K.length]) & 255; } return o; }
function codecDecode(e) {
  if (!KEY || !e) return null;
  const K = []; for (let i = 0; i < KEY.length; i += 2) K.push(parseInt(KEY.slice(i, i + 2), 16));
  const v = []; for (const ch of e) { const d = B64.indexOf(ch); if (d < 0) return null; v.push(d); }
  const b = []; for (let i = 0; i < v.length; i += 4) { const n = (v[i] << 18) | ((v[i + 1] || 0) << 12) | ((v[i + 2] || 0) << 6) | (v[i + 3] || 0); b.push((n >> 16) & 255); if (i + 2 < v.length) b.push((n >> 8) & 255); if (i + 3 < v.length) b.push(n & 255); }
  if (b.length < 4) return null;
  const st = ks(K, b.slice(0, 4), b.length - 4), raw = new Uint8Array(b.length - 4);
  for (let i = 0; i < raw.length; i++) raw[i] = b[i + 4] ^ st[i];
  try { return new TextDecoder().decode(raw); } catch { return null; }
}
const decodeProxyUrl = (u) => { const i = u.indexOf('/~/sj/'); if (i < 0) return null; const rest = u.slice(i + 6).split('?')[0].split('#')[0]; for (const cand of [rest, rest.replaceAll('/', '')]) { const d = codecDecode(cand); if (d && d.startsWith('http')) { try { return new URL(d).pathname; } catch { return null; } } } return null; };

const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('pageerror', (e) => {
  const step = currentStep;
  const stack = String(e.stack || e);
  const m = /(?:@|at\s+)(https?:\/\/[^\s:]+):(\d+):(\d+)/.exec(stack) || /(https?:\/\/[^\s)]+):(\d+):(\d+)/.exec(stack);
  pageerrors.push({ step, message: String(e.message || e), stack, frameUrl: m && m[1], line: m && +m[2], col: m && +m[3], framePath: m && (decodeProxyUrl(m[1]) || m[1]) });
});
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 300), loc: m.location() }); });
page.on('response', (r) => {
  pending.push((async () => {
    let body = null, err = null;
    try { body = await Promise.race([r.body(), new Promise((_, rej) => setTimeout(() => rej(new Error('body timeout')), 10000))]); } catch (e) { err = String(e).slice(0, 120); }
    const rec = { url: r.url(), status: r.status(), type: r.headers()['content-type'] || '', nosniff: r.headers()['x-content-type-options'] || null, fromSw: r.fromServiceWorker(), dest: r.request().resourceType(), path: decodeProxyUrl(r.url()) };
    if (body) {
      rec.sha256 = sha256(body); rec.size = body.length;
      if (body.length < 4 * 1024 * 1024) writeFileSync(join(artifacts, 'bodies', rec.sha256), body);
      const fp = rec.path && manifest[rec.path];
      if (fp) {
        rec.attribution = rec.sha256 === fp.sha256 ? 'IDENTICAL' : (rec.size < fp.size ? 'TRUNCATED' : 'REWRITTEN');
        if (rec.type.split(';')[0] !== fp.type) rec.attribution += '+TYPE-CHANGED(from ' + fp.type + ')';
        if (rec.attribution.startsWith('REWRITTEN') || rec.attribution.startsWith('TRUNCATED')) {
          const orig = Buffer.from(files[rec.path].body, 'utf8');
          let i = 0; while (i < Math.min(orig.length, body.length) && orig[i] === body[i]) i++;
          rec.firstDiff = i; rec.origCtx = orig.slice(Math.max(0, i - 64), i + 64).toString('latin1'); rec.gotCtx = body.slice(Math.max(0, i - 64), i + 64).toString('latin1');
        }
      }
    } else rec.bodyError = err;
    responses.push(rec);
  })().then(() => settledCaptures++, () => settledCaptures++));
});

async function login() {
  await page.goto(s.base + '/login');
  await page.locator('input').nth(0).fill('reviewer');
  await page.locator('input[type=password]').fill('fixture-password');
  await page.locator('button[type=submit]').click();
  await page.waitForURL(s.base + '/');
  await page.goto(s.base + '/browse');
  await page.waitForTimeout(2500);
}
async function nav(target) {
  currentStep = target;
  console.error('[step] nav', target);
  const omni = page.locator('input').first();
  await omni.fill(target); await omni.press('Enter');
  await page.waitForTimeout(3500);
}
const proxied = (p) => responses.filter((r) => r.path === p);
// probe: for the current /t/ page, pull the proxied script URL from the frame DOM,
// then fetch it (a) via APIRequestContext (server-delivered bytes, no SW) and
// (b) via in-frame fetch (SW-served bytes). Both hashed + type-recorded.
async function probeAsset(path) {
  const frs = page.frames().filter((f) => f.url().includes('/~/sj/'));
  const fr = frs[frs.length - 1];
  if (!fr) return { error: 'no proxied frame' };
  const srcUrl = await fr.evaluate(() => {
    const all = [...document.scripts].map((x) => ({ src: x.src || null, inj: x.hasAttribute('scramjet-injected') }));
    const s = all.find((x) => x.src && !x.inj && x.src.includes('/~/sj/')) || all.find((x) => x.src && !x.inj);
    return s ? s.src : JSON.stringify(all);
  }).catch((e) => 'EVALFAIL:' + String(e).slice(0, 60));
  if (!srcUrl || srcUrl.startsWith('EVALFAIL') || srcUrl.startsWith('[')) return { error: 'no script in frame', detail: String(srcUrl).slice(0, 300), frameUrl: fr.url().slice(0, 120) };
  const out = { srcUrl };
  try { const r = await ctx.request.get(srcUrl); const b = await r.body(); out.server = { status: r.status(), type: r.headers()['content-type'] || '', sha256: sha256(b), size: b.length }; writeFileSync(join(artifacts, 'bodies', 'server-' + out.server.sha256), b); } catch (e) { out.server = { error: String(e).slice(0, 100) }; }
  try { const r = await fr.evaluate(async (u) => { const resp = await fetch(u); return { type: resp.headers.get('content-type') || '', text: await resp.text() }; }, srcUrl); const b = Buffer.from(r.text, 'utf8'); out.sw = { type: r.type, sha256: sha256(b), size: b.length, parseCheck: await fr.evaluate((t) => { try { new Function(t); return 'ok'; } catch (e) { return String(e).slice(0, 120); } }, r.text) }; writeFileSync(join(artifacts, 'bodies', 'sw-' + out.sw.sha256), b); } catch (e) { out.sw = { error: String(e).slice(0, 100) }; }
  const fp = manifest[path];
  for (const k of ['server', 'sw']) if (out[k] && out[k].sha256) out[k].vsOrigin = out[k].sha256 === fp.sha256 ? 'IDENTICAL' : (out[k].size < fp.size ? 'TRUNCATED' : 'DIFFERENT');
  if (out.server && out.sw && out.server.sha256 && out.sw.sha256) out.swVsServer = out.sw.sha256 === out.server.sha256 ? 'IDENTICAL' : 'DIFFERENT';
  return out;
}
const errs = () => pageerrors.splice(0);

console.error('[step] login');
await login();
console.error('[step] logged in');
KEY = await page.evaluate(async () => { try { return (await (await fetch('/api/apps/browse/urlkey')).json()).key || null; } catch { return null; } });
console.error('[step] urlkey', KEY && KEY.length, 'chars');
const results = { A: {}, B: {} };

// ---------- Scenario A ----------
await nav(fBase + '/');
await nav(fBase + '/t/?src=/js/classic-throw.js&type=classic');
const frsT = page.frames().filter((f) => f.url().includes('/~/sj/'));
const frameErrs = frsT.length ? await frsT[frsT.length-1].evaluate(() => window.__errs || null).catch(() => null) : null;
results.A.sourceURLframeErrs = frameErrs;
const frameThrow = (frameErrs || []).find((e) => /classic boom/.test(e.m));
const throwErr = (frameThrow && { message: frameThrow.m, frameUrl: frameThrow.f, line: frameThrow.l, col: frameThrow.c }) || errs().find((e) => e.message.includes('classic boom'));  // prefer the frame-level recorder: it carries the sourceURL-attributed filename
results.A.sourceURL = throwErr ? { framePath: throwErr.framePath, frameUrl: throwErr.frameUrl, pass: !!throwErr.frameUrl && /(^|\/)classic\.js$/.test(throwErr.frameUrl.replace(/^https?:\/\/[^/]+/, '')) || throwErr.frameUrl === 'classic.js' || (throwErr.frameUrl||'').endsWith('/classic.js') } : { pass: false, note: 'no classic boom error captured' };

const edgeAssets = ['edge-bom', 'edge-scriptclose', 'edge-unicode', 'large.min'];
results.A.probes = {};
for (const a of edgeAssets) for (const type of ['classic', 'module']) { await nav(`${fBase}/t/?src=/js/${a}.js&type=${type}`); results.A.probes[`${a}:${type}`] = await probeAsset(`/js/${a}.js`); }
await nav(`${fBase}/t/?src=/js/wrong-type.js&type=classic`);
results.A.probes['wrong-type:classic'] = await probeAsset('/js/wrong-type.js');
{ const frs = page.frames().filter((f) => f.url().includes('/~/sj/')); if (frs.length) results.A.wrongTypeExecuted = await frs[frs.length - 1].evaluate(() => String(window.__wrongtype)).catch(() => null); }
// nosniff: the strict case - text/plain + X-Content-Type-Options: nosniff.
// r13: the proxy preserves x-content-type-options for script destinations, so
// chrome must REFUSE this script. Pinned exactly: executed 'undefined' + refusal logged.
// The listener below captures the ACTUAL script-destination response the SW
// delivered (headers included) - the pinning is about those bytes on the wire,
// not about a fetch-destination probe.
// the codec prefix makes per-url decode unreliable here, but exactly one
// response in this run carries x-content-type-options: nosniff - the one we
// want: the actual script-destination response the SW delivered
const swNosniffRespP = new Promise((res) => {
  const h = (r) => {
    if (r.request().resourceType() === 'script' && r.headers()['x-content-type-options'] === 'nosniff') {
      page.off('response', h);
      res({ url: r.url().slice(0, 120), type: r.headers()['content-type'] || '', nosniff: r.headers()['x-content-type-options'] || null, fromSw: r.fromServiceWorker() });
    }
  };
  page.on('response', h);
  setTimeout(() => { page.off('response', h); res(null); }, 15000);
});
const consoleMark = consoleMsgs.length;
await nav(`${fBase}/t/?src=/js/nosniff.js&type=classic`);
results.A.nosniffSwScriptResponse = await swNosniffRespP;
results.A.probes['nosniff:classic'] = await probeAsset('/js/nosniff.js');
{
  const p = results.A.probes['nosniff:classic'] || {};
  const frs = page.frames().filter((f) => f.url().includes('/~/sj/'));
  const executed = frs.length ? await frs[frs.length - 1].evaluate(() => String(window.__nosniff)).catch(() => null) : null;
  // the proxied url is codec-encoded, so match chrome's refusal text within
  // this nav's console window instead of the url (only nosniff.js can refuse)
  const refused = consoleMsgs.slice(consoleMark).some((m) => /Refused to execute/i.test(m.text) && /MIME/i.test(m.text));
  results.A.nosniff = {
    server: p.server && { vsOrigin: p.server.vsOrigin, type: p.server.type },
    sw: p.sw && { vsOrigin: p.sw.vsOrigin, type: p.sw.type },
    executed, chromeRefused: refused,
    note: executed === '1'
      ? 'FAIL: text/plain+nosniff script EXECUTED through the proxy - the proxy must preserve x-content-type-options for script destinations so chrome refuses'
      : 'chrome refused the nosniff script through the proxy (nosniff preserved by the proxy - r13 behavior)',
  };
}
// direct-origin negative control: the SAME fixture page straight from the
// fixture server (no proxy) must be refused by chrome - proves the refusal we
// pin through the proxy is chrome enforcing nosniff, not a fixture artifact
{
  const dp = await ctx.newPage();
  const dc = [];
  dp.on('console', (m) => dc.push(m.text()));
  await dp.goto(`${fBase}/t/?src=/js/nosniff.js&type=classic`);
  await dp.waitForTimeout(1500);
  const dExec = await dp.evaluate(() => String(window.__nosniff));
  results.A.directOriginNosniffControl = { executed: dExec, chromeRefused: dc.some((t) => /Refused to execute|MIME/i.test(t)), pass: dExec === 'undefined' && dc.some((t) => /Refused to execute|MIME/i.test(t)) };
  await dp.close();
}
const allErrs = pageerrors.slice();
results.A.pageerrors = allErrs.map((e) => ({ message: e.message.slice(0, 120), framePath: e.framePath }));
results.A.unexpectedErrors = allErrs.filter((e) => !e.message.includes('classic boom') && !(e.framePath || '').includes('wrong-type'));
const wtProbe = results.A.probes['wrong-type:classic'] || {};
const wtConsole = consoleMsgs.find((m) => /wrong-type/.test(m.text) && /Refused to execute|MIME|text\/html/i.test(m.text));
const wtExecuted = results.A.wrongTypeExecuted ?? null;
results.A.wrongType = { server: wtProbe.server && { vsOrigin: wtProbe.server.vsOrigin, type: wtProbe.server.type }, sw: wtProbe.sw && { vsOrigin: wtProbe.sw.vsOrigin, type: wtProbe.sw.type }, chromeRefused: !!wtConsole, consoleMsg: wtConsole && wtConsole.text.slice(0, 160), executed: wtExecuted, note: 'no-nosniff wrong types execute by design (classic scripts have no MIME gate without nosniff); pinned executed=1' };
results.A.attributions = {};
for (const p of Object.keys(manifest)) { const r = proxied(p)[0]; if (r) results.A.attributions[p] = { a: r.attribution || 'no-fixture-match', status: r.status, type: r.type.split(';')[0] }; }
results.A.pass = results.A.unexpectedErrors.length === 0 && results.A.sourceURL.pass !== false && results.A.wrongType.executed === '1' && results.A.wrongType.server && results.A.wrongType.server.vsOrigin === 'IDENTICAL' && results.A.nosniff && results.A.nosniff.server && results.A.nosniff.server.vsOrigin === 'IDENTICAL' && results.A.nosniff.executed === 'undefined' && results.A.nosniff.chromeRefused === true && !!(results.A.nosniffSwScriptResponse && results.A.nosniffSwScriptResponse.fromSw === true && results.A.nosniffSwScriptResponse.nosniff === 'nosniff' && results.A.nosniffSwScriptResponse.type.split(';')[0] === 'text/plain') && !!(results.A.directOriginNosniffControl && results.A.directOriginNosniffControl.pass === true);

pageerrors.length = 0; // stray late-arriving pageerrors belong to scenario A
console.error('[step] scenario B');
// ---------- Scenario B (ramjet site-SW upgrade) ----------
// The spec's fixture-SW-through-proxy path is not applicable: scramjet deletes
// Navigator.prototype.serviceWorker in proxied windows by design (fixture-site
// SWs cannot register through the proxy; observed: navigator.serviceWorker
// undefined, register throws TypeError). What Sage actually asked to prove: a
// client carrying a pre-r11 browse-sw.js lands cleanly on the r11 SW. Simulated
// by serving contract stand-in SW bytes (pre-handshake contract, NOT the
// literal r8 bytes) for the first registration, then lifting the
// interception (new bytes available) and reloading.
results.B.designNote = 'fixture-site SW through proxy: N/A by scramjet design (Reflect.deleteProperty Navigator.prototype.serviceWorker); tested ramjet site-SW upgrade instead';
// a pre-handshake worker contract stand-in (not literal r8 bytes), inlined so the harness is
// self-contained: skipWaiting + claim + fetch passthrough, and NO version
// RPC - verifyWorkerVersion times out against it, which is exactly what the
// old-bytes upgrade path needs to prove. (The literal r8 bytes live in git
// history, which a tarball extract does not carry - this stand-in models the contract, not the bytes.)
const oldSwBytes = `// browse-sw contract stand-in (not literal r8 bytes): no $rjVersionCheck handler
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
`;
const realStamp = await page.evaluate(() => globalThis.__RJ_ENGINE__ || null) || (await (await ctx.request.get(s.base + '/pages/browse/browse.html')).text()).match(/v=([0-9a-f]{12})/)?.[1];
// phase 1: old client. HTML rewritten to the OLD stamp; old SW bytes for the
// OLD-stamp sw url; every other OLD-stamp asset rewritten to the real stamp.
await ctx.route('**/browse', async (route) => {
  const resp = await route.fetch();
  let html = await resp.text();
  html = html.replaceAll('v=' + realStamp, 'v=OLDSTAMP0000').replaceAll("'" + realStamp + "'", "'OLDSTAMP0000'");
  return route.fulfill({ response: resp, body: html });
});
await ctx.route('**/*v=OLDSTAMP0000*', (route) => route.continue({ url: route.request().url().replaceAll('v=OLDSTAMP0000', 'v=' + realStamp) }));
await ctx.route('**/browse-sw.js?v=OLDSTAMP0000', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'cache-control': 'no-store' }, body: oldSwBytes }));
await page.goto(s.base + '/browse');
await page.waitForTimeout(6000);
const swReg1 = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && { active: !!r.active, scriptURL: r.active && r.active.scriptURL, state: r.active && r.active.state }; });
const frame1 = page.frames().find((f) => f.url().includes('/~/sj/'));
results.B.oldSwPhase = { swReg: swReg1, bootedWithOldSw: !!frame1, pageerrors: pageerrors.splice(0).map((e) => e.message.slice(0, 120)) };
// phase 2: r11 deployed. New HTML references the real stamp; the old worker is
// still active. register(?v=real) must install+activate the new worker while
// waitForWorker holds the boot until the NEW scriptURL is active + handshakes.
await ctx.unrouteAll();
await page.reload();
let frame2 = null;
for (let i = 0; i < 40 && !frame2; i++) { await page.waitForTimeout(500); frame2 = page.frames().find((f) => f.url().includes('/~/sj/')) || null; }
const swReg2 = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && { scriptURL: r.active && r.active.scriptURL, state: r.active && r.active.state }; });
const bootText2 = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
results.B.newSwPhase = { swReg: swReg2, booted: !!frame2, bootText: bootText2, pageerrors: pageerrors.splice(0).map((e) => e.message.slice(0, 120)) };
const booted2 = !!frame2 || /new tab/.test(bootText2);
const failedCopy2 = /out of date|could not start|did not wake/.test(bootText2);
// phase 3: a running tab at the next deploy. Phases 1-2 proved the real
// lifecycle (old worker active -> register(new stamp) -> install -> activate).
// Here the running page's own listener wiring is exercised directly: dispatch
// controllerchange after boot and expect the takeover copy. (A real mid-boot
// takeover ends in a loud boot failure, never mixed operation.)
let phase3 = null;
if (booted2 && !failedCopy2) {
  const before = await page.evaluate(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL);
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')));
  let txt = '';
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300);
    txt = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
    if (/ramjet updated - reload/.test(txt)) break;
  }
  phase3 = { takeoverCopy: /ramjet updated - reload/.test(txt), controller: before, text: txt, pageerrors: pageerrors.splice(0).map((e) => e.message.slice(0, 120)) };
}
results.B.phase3 = phase3;
results.B.pass = !!(swReg1 && swReg1.active && /v=OLDSTAMP0000/.test(swReg1.scriptURL || '') && swReg2 && swReg2.state === 'activated' && /v=/.test(swReg2.scriptURL || '') && !/OLDSTAMP/.test(swReg2.scriptURL) && booted2 && !failedCopy2 && results.B.newSwPhase.pageerrors.length === 0 && phase3 && phase3.takeoverCopy && phase3.pageerrors.length === 0);

// ---------- Scenario C: mid-boot worker swaps restart the boot ----------
// r14: a REAL controller replacement between the version handshake and
// ready=true must restart the boot against the new controller, never publish
// ready against the captured worker. The replacement is real: the in-page
// poller re-registers the worker at the held phase, the route serves modified
// bytes on the update check, and skipWaiting+clients.claim produce a genuine
// controllerchange from a DIFFERENT worker object (controller identity is
// captured before and after). Two deterministic windows: transport warm
// (held by a delayed websocket upgrade) and controller.wait (held by a
// delayed wasm fetch, which controller.wait awaits via loadScramjetWasm).
console.error('[step] scenario C');
results.C = {};
const runSwapControl = async (label, targetPhase, holdSetup) => {
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 160)));
  await p.addInitScript((tp) => {
    window.__cSeq = []; window.__cSwap = null; let last = undefined;
    setInterval(() => {
      const ph = window.__rjBootPhase || null;
      if (ph !== last) { last = ph; window.__cSeq.push(ph); }
      if (ph === tp && !window.__cSwap) {
        window.__cSwap = { phase: tp, ctrlBefore: navigator.serviceWorker.controller || null };
        // real replacement: a DIFFERENT scriptURL on the same scope installs
        // a genuinely different worker (register() within 24h does not
        // re-fetch an unchanged URL, so same-URL + modified bytes is not a
        // reliable trigger)
        navigator.serviceWorker.register('/browse-sw.js?v=' + (window.__RJ_ENGINE__ || '0') + '&r14swap=1').catch((e) => { window.__cSwap.error = String(e); });
      }
    }, 5);
  }, targetPhase);
  // only the SWAP url gets modified bytes: the wanted url must always serve
  // the real bytes, or every boot's register() would install a fresh worker
  // forever (unique bytes per fetch -> endless controllerchange restarts).
  // service worker script fetches are only visible to CONTEXT routes, never
  // page routes
  let swFetches = 0;
  const swRoute = async (route) => {
    swFetches += 1;
    if (!route.request().url().includes('r14swap')) return route.continue();
    const resp = await route.fetch();
    const body = (await resp.text()) + '\n// r14 swap marker\n';
    return route.fulfill({ response: resp, body });
  };
  await ctx.route('**/browse-sw.js*', swRoute);
  await holdSetup(p);
  await p.goto(s.base + '/browse');
  let phase = null;
  for (let i = 0; i < 80; i++) {
    await p.waitForTimeout(500);
    phase = await p.evaluate(() => window.__rjBootPhase || null).catch(() => null);
    if (phase === 'ready') break;
  }
  const seq = await p.evaluate(() => window.__cSeq);
  const swap = await p.evaluate(() => ({ phase: window.__cSwap && window.__cSwap.phase, error: window.__cSwap && window.__cSwap.error || null }));
  const replaced = await p.evaluate(() => !!(window.__cSwap && window.__cSwap.ctrlBefore && navigator.serviceWorker.controller && navigator.serviceWorker.controller !== window.__cSwap.ctrlBefore));
  const activeUrl = await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return r && r.active && r.active.scriptURL; });
  const dIdx = seq.indexOf(targetPhase);
  // after the swap the phase must REGRESS to an early stage (proof the boot
  // restarted) and then reach ready again
  const restartSeen = dIdx >= 0 && seq.slice(dIdx + 1).some((x) => x === 'engine' || x === 'worker');
  const readyAfter = dIdx >= 0 && seq.lastIndexOf('ready') > dIdx;
  // no stale commit: exactly one ready publish across every cycle
  const readyCount = seq.filter((x) => x === 'ready').length;
  // and the final commit must bind the WANTED revision, not the swap worker
  const wantedActive = !!activeUrl && !activeUrl.includes('r14swap') && activeUrl.includes('browse-sw.js');
  results.C[label] = { targetPhase, swap, controllerReplaced: replaced, activeUrl, swFetches, seq, restartSeen, readyAfter, readyCount, wantedActive, pageerrors: errs, pass: swap.phase === targetPhase && !swap.error && replaced && restartSeen && readyAfter && readyCount === 1 && wantedActive && phase === 'ready' && errs.length === 0 };
  await ctx.unroute('**/browse-sw.js*', swRoute);
  await p.close();
};

// C1: replacement while the tunnel socket is still opening (transport warm).
// routeWebSocket + a delayed connectToServer holds the warm phase open.
await runSwapControl('takeoverDuringWarm', 'warm', async (p) => {
  await p.routeWebSocket(/\/pws-t\//, async (ws) => {
    await new Promise((r) => setTimeout(r, 900));
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => ws.send(m));
  });
});

// C2: replacement while the controller handshake is in flight. controller.wait()
// awaits loadScramjetWasm(), so a delayed wasm fetch holds the phase open.
await runSwapControl('takeoverDuringControllerWait', 'controllerwait', async (p) => {
  await p.route('**/scramjet.wasm**', async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
});
results.C.pass = results.C.takeoverDuringWarm.pass && results.C.takeoverDuringControllerWait.pass;

console.error('[step] draining', pending.length, 'response captures');
// overall drain bound: response captures are best-effort artifact logging and
// must never stretch the harness past its budget - give the drain 30s, then
// record how many captures were left undrained and move on
const drainDone = await Promise.race([Promise.allSettled(pending).then(() => true), new Promise((r) => setTimeout(() => r(false), 30000))]);
results.drain = { captures: pending.length, settled: settledCaptures, bounded: !drainDone };
if (!drainDone) console.error('[warn] drain exceeded 30s:', pending.length - settledCaptures, 'captures undrained (artifact log may be partial; A/B/C unaffected)');
writeFileSync(join(artifacts, 'event-log.json'), JSON.stringify({ pageerrors, consoleMsgs, responses, results }, null, 2));
console.log('artifacts:', artifacts);
console.log(JSON.stringify(results, null, 2));
console.log('A:', results.A.pass ? 'PASS' : 'FAIL', ' B:', results.B.pass ? 'PASS' : 'FAIL', ' C:', results.C.pass ? 'PASS' : 'FAIL');
await browser.close(); s.child.kill(); fixture.close();
process.exit(results.A.pass && results.B.pass && results.C.pass ? 0 : 1);
