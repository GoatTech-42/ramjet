import { dataPath } from '../../data.js';
// browse bookmarks: the proxy itself is client-side scramjet, so there was
// never a browse addon - this one exists only to keep per-account bookmarks.
// a bookmark is just a name + a public http(s) url; the client stars the
// page it is on, the home screen lists them next to the quick links.

import { randomBytes, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { readJson, writeJson, readBody } from '../../util.js';

const BM_FILE = dataPath('browse-bookmarks.json');
const MAX_BOOKMARKS = 30;

function loadBm() { return readJson(BM_FILE, {}); }
function userBm(user) {
  const all = loadBm();
  return Array.isArray(all[user]) ? all[user] : [];
}
function saveUserBm(user, list) {
  const all = loadBm();
  all[user] = list;
  writeJson(BM_FILE, all);
}

function cleanUrl(u) {
  try {
    const p = new URL(String(u || ''));
    if (p.protocol !== 'https:' && p.protocol !== 'http:') return '';
    if (!p.hostname || p.username || p.password) return '';
    return p.href.slice(0, 500);
  } catch { return ''; }
}

// url encryption key: the proxy scrambles destination urls
// so a filter or a glance at the address bar sees gibberish, not where you
// went. one key per login session, derived statelessly - logging out kills
// every url it ever made. the secret never leaves the box.
const KEY_FILE = dataPath('.urlkey-secret');

// cross-device cookie + localStorage sync: the admin account ONLY - every
// other account gets a flat 403. cookies are the scramjet jar dump; storage
// is the proxied sites' localStorage (host@key entries). last writer wins -
// it is a personal sync, not a merge.
const SYNC_FILE = dataPath('browse-sync.json');
const SYNC_ADMIN = process.env.RJ_SYNC_ADMIN || "admin";
// raw upstream cookies and origin storage live here: repair the mode before
// every read - a looser era or a manual copy must not leave them
// group/other-readable, and a store whose mode cannot be repaired must not
// be served at all.
function loadSync() {
  if (existsSync(SYNC_FILE)) chmodSync(SYNC_FILE, 0o600);
  return readJson(SYNC_FILE, {});
}
function urlSecret() {
  if (existsSync(KEY_FILE)) {
    // the existing secret is the HMAC root for every outstanding url: fail
    // closed on a corrupt/weak one rather than regenerate over state clients
    // already hold, and repair its mode before trusting it
    const sec = readFileSync(KEY_FILE, "utf8").trim();
    if (!/^[a-f0-9]{64}$/i.test(sec)) throw new Error("url key secret is invalid");
    chmodSync(KEY_FILE, 0o600); // a key we cannot lock down must not be used
    return sec;
  }
  const sec = randomBytes(32).toString("hex");
  writeFileSync(KEY_FILE, sec, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  return sec;
}

export async function register(req, res, ctx) {
  const { sendJson, readBody: rb, session } = ctx;
  const sub = req.url.split('?')[0].replace(/^\/api\/apps\/browse/, '') || '/';

if (sub === "/urlkey" && req.method === "GET") {
    if (!session) return sendJson(res, 401, { ok: false, error: "not signed in" });
    const key = createHmac("sha256", urlSecret()).update("urlkey:" + session.token).digest("hex");
    return sendJson(res, 200, { ok: true, key });
  }


  
  if (sub === "/sync" && req.method === "GET") {
    if (!session) return sendJson(res, 401, { ok: false, error: "not signed in" });
    if (session.user !== SYNC_ADMIN) return sendJson(res, 403, { ok: false, error: "not for this account" });
    const all = loadSync();
    return sendJson(res, 200, { ok: true, sync: all[session.user] || null });
  }

  if (sub === "/sync" && (req.method === "PUT" || req.method === "POST")) {
    if (!session) return sendJson(res, 401, { ok: false, error: "not signed in" });
    if (session.user !== SYNC_ADMIN) return sendJson(res, 403, { ok: false, error: "not for this account" });
    let body = {};
    try { body = JSON.parse((await rb(req)).toString("utf8") || "{}"); } catch {}
    const sync = {};
    if (typeof body.cookies === "string" && body.cookies.length <= 262144) sync.cookies = body.cookies;
    if (body.storage && typeof body.storage === "object" && !Array.isArray(body.storage)) {
      const st = {};
      for (const [k, v] of Object.entries(body.storage)) {
        if (typeof k !== "string" || typeof v !== "string") continue;
        if (!k.includes("@") || k.length > 200 || v.length > 65536) continue;
        st[k] = v;
        if (Object.keys(st).length >= 500) break;
      }
      sync.storage = st;
    }
    sync.at = Date.now();
    const all = loadSync();
    all[session.user] = sync;
    // holds raw upstream cookies and origin storage: owner-only on disk
    writeJson(SYNC_FILE, all, 0o600);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/bookmarks' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, bookmarks: userBm(session.user) });
  }

  if (sub === '/bookmarks' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await rb(req)).toString('utf8') || '{}'); } catch {}
    const url = cleanUrl(body.url);
    if (!url) return sendJson(res, 400, { ok: false, error: 'that address does not look right' });
    let name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!name) { try { name = new URL(url).hostname.replace(/^www\./, ''); } catch { name = url; } }
    const list = userBm(session.user);
    if (list.some((b) => b.url === url)) return sendJson(res, 200, { ok: true, already: true });
    if (list.length >= MAX_BOOKMARKS) return sendJson(res, 400, { ok: false, error: 'thirty bookmarks is plenty - clear one first' });
    list.unshift({ id: randomBytes(4).toString('hex'), name, url, at: Date.now() });
    saveUserBm(session.user, list);
    return sendJson(res, 200, { ok: true, already: false });
  }

  if (sub === '/bookmarks/delete' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await rb(req)).toString('utf8') || '{}'); } catch {}
    const list = userBm(session.user);
    const kept = list.filter((b) => b.id !== String(body.id || ''));
    if (kept.length === list.length) return sendJson(res, 404, { ok: false, error: 'that bookmark is gone' });
    saveUserBm(session.user, kept);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/bookmarks/clear' && req.method === 'POST') {
    saveUserBm(session.user, []);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'unknown browse call' });
}
