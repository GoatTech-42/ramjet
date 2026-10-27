// class C fallback client: third-party assets requested by apps (thumbs, art, posters, embed hosts).
// class A (browse engine, media-bridge) never goes through here. class B (own domains, archive.org) is
// direct and exempt unless the session is in filtered-network mode.
// only network-level failure counts (reject, dns/tls/timeout 2.5s, status 0). a host's own 4xx/5xx is a real answer.
const KEY_HOSTS = 'rj-blocked-hosts';
const KEY_MODE = 'rj-filtered-net';
const KEY_ALWAYS = 'rj-proxy-always';
const TIMEOUT = 2500, WINDOW = 60000, REPROBE = 15 * 60000;
const EXEMPT = [/\.archive\.org$/i, /^archive\.org$/i];
const listeners = new Set();
const blocked = new Set();
const triedDirect = new Set(); // hosts that already spent their one visible direct attempt
const fails = new Map(); // host -> ts of last network failure
let filtered = false, probeTimer = null, probeOk = 0;
const SIGNAL_URL = 'https://www.youtube.com/favicon.ico'; // filter signal: blocked on school networks
const BASE_URL = 'https://archive.org/favicon.ico'; // baseline: benign, always allowed
let probeUrlOverride = null; // setProbe({signal, base}) for tests

try { JSON.parse(sessionStorage.getItem(KEY_HOSTS) || '[]').forEach((h) => { blocked.add(h); triedDirect.add(h); }); } catch {}
const always = () => { try { return localStorage.getItem(KEY_ALWAYS) === '1'; } catch { return false; } };
try { filtered = sessionStorage.getItem(KEY_MODE) === '1' || always(); } catch {}

const mirror = () => { try { sessionStorage.setItem(KEY_HOSTS, JSON.stringify([...blocked])); sessionStorage.setItem(KEY_MODE, filtered ? '1' : '0'); } catch {} };
const emit = () => listeners.forEach((f) => f(status()));
export const status = () => ({ filtered, always: always() });
export const subscribe = (f) => { listeners.add(f); f(status()); return () => listeners.delete(f); };
export const hostOf = (u) => { try { return new URL(u, location.href).host; } catch { return ''; } };
const own = (h) => h === location.host || EXEMPT.some((r) => r.test(h));
export const b64 = (u) => btoa(unescape(encodeURIComponent(u))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const proxied = (u) => '/api/apps/browse/proxy?u=' + b64(u);

export function setAlways(on) {
  const was = always();
  if (!on && !was) return; // nothing to undo; do not clear an auto-detected flip
  try { on ? localStorage.setItem(KEY_ALWAYS, '1') : localStorage.removeItem(KEY_ALWAYS); } catch {}
  if (on) { setFiltered(true); return; }
  // turning "always" off keeps the current state: if the network really is filtered the proxy stays on, and the re-probe
  // flips it back only after sustained success
  if (filtered) scheduleProbe();
}
function setFiltered(on) {
  if (filtered === on) return;
  filtered = on; mirror(); emit();
  if (on && !always()) scheduleProbe(); else clearTimeout(probeTimer);
}
function noteFail(host) {
  const now = Date.now();
  fails.set(host, now); blocked.add(host); mirror();
  const recent = [...fails].filter(([, t]) => now - t <= WINDOW).map(([h]) => h);
  if (new Set(recent).size >= 2 && !filtered && !confirming) {
    confirming = true;
    netState().then((st) => { if (st === 'filtered') setFiltered(true); }).finally(() => { confirming = false; }); // offline: no flip, no line
  }
}
let confirming = false;
function scheduleProbe() {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(async () => {
    if (!filtered || always()) return;
    const st = await netState();
    if (!filtered || always()) return;   // the user may have forced the proxy on while the probe was in flight
    // flip back only on sustained success: two probes in a row where both hosts answer. filtered or offline resets it.
    probeOk = st === 'open' ? probeOk + 1 : 0;
    if (probeOk >= 2) { probeOk = 0; fails.clear(); blocked.clear(); triedDirect.clear(); setFiltered(false); return; }
    scheduleProbe();
  }, REPROBE);
}
export function setProbe(o) { probeUrlOverride = o || null; }
async function reach(u) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try { await fetch(u, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal }); return true; }
  catch { return false; } finally { clearTimeout(t); }
}
// two tiny no-cors fetches: 'filtered' = signal fails but baseline works; 'open' = both work; 'offline' = both fail.
async function netState() {
  const sig = probeUrlOverride?.signal || SIGNAL_URL, base = probeUrlOverride?.base || BASE_URL;
  const [s, b] = await Promise.all([reach(sig), reach(base)]);
  return !b ? (s ? 'open' : 'offline') : s ? 'open' : 'filtered';
}
// where should this url load from right now? class C gets proxied once its host is known blocked
// (after its one visible direct attempt); filtered mode proxies class B + C.
export function route(u) {
  if (!u || !/^https:/i.test(u)) return u;
  const h = hostOf(u);
  if (!h || h === location.host) return u;
  if (filtered) return proxied(u);
  if (own(h)) return u;
  if (blocked.has(h) && triedDirect.has(h)) return proxied(u);
  triedDirect.add(h);
  return u;
}
// svelte action for <img>: use:cimg={url}. one proxied retry, then the honest empty state (img hidden).
export function cimg(node, url) {
  let retried = false, cur = url;
  const apply = (u) => { cur = u; retried = false; node.style.visibility = ''; node.src = route(u) || ''; };
  const fail = () => {
    const failed = cur;
    const h = hostOf(cur);
    if (!cur || !/^https:/i.test(cur) || !h || h === location.host) { node.style.visibility = 'hidden'; return; }
    // an <img> error carries no status, so confirm it is network-level with a no-cors probe: a host that answered (even 4xx) resolves
    if (retried || node.src.includes('/api/apps/browse/proxy')) { node.style.visibility = 'hidden'; return; }
    reach(failed).then((up) => {
      if (cur !== failed) return;   // the url changed while we probed: this answer belongs to the old one
      if (up) { node.style.visibility = 'hidden'; return; } // host answered: a real answer, no retry
      if (!own(h)) noteFail(h);
      retried = true; node.src = proxied(failed);
    });
  };
  node.addEventListener('error', fail);
  apply(url);
  return { update(u) { apply(u); }, destroy() { node.removeEventListener('error', fail); } };
}
// fetch wrapper for json/blob class C requests. exactly one proxied retry on network failure only.
export async function cfetch(u, opts = {}) {
  const h = hostOf(u), first = route(u);
  // one signal per attempt: the caller's abort and our timeout both cancel it
  const sig = () => {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT);
    const ext = opts.signal;
    const onAbort = () => ctl.abort();
    if (ext) { if (ext.aborted) ctl.abort(); else ext.addEventListener('abort', onAbort, { once: true }); }
    return { signal: ctl.signal, done: () => { clearTimeout(t); if (ext) ext.removeEventListener('abort', onAbort); } };
  };
  const a = sig();
  try { return await fetch(first, { ...opts, signal: a.signal }); }
  catch (e) {
    if (opts.signal && opts.signal.aborted) throw e;   // the caller gave up: no retry
    if (first !== u || own(h)) throw e; // already proxied, or exempt: honest failure
    noteFail(h);
    const b = sig();
    try { return await fetch(proxied(u), { ...opts, signal: b.signal }); } finally { b.done(); }
  } finally { a.done(); }
}
if (filtered && !always()) scheduleProbe();
