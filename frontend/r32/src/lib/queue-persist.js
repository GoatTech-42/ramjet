// amp queue persistence: survive a reload mid-song. Pure (storage is passed in), so it is testable without a DOM.
// Stored data is treated as untrusted on the way back in: every track is re-validated with the same rules the
// server's cleanTrack uses, and `stream` / `key` / `dur` are rebuilt from (src, id), never read from storage.

export const QKEY = 'amp-queue';
export const QVERSION = 1;
export const MAX_TRACKS = 200;          // stored window; a 500+ queue keeps the 200 around the current song
export const MAX_CHARS = 150000;        // well under typical 5 MB localStorage quotas
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const FUTURE_SLACK_MS = 5 * 60 * 1000;  // a clock that was briefly ahead is fine; a stamp from next week is not
const READ_CAP = 500;                    // never walk more than this many stored rows on restore
const ID_OK = { yt: /^[A-Za-z0-9_-]{11}$/, sc: /^\d{5,15}$/, au: /^[A-Za-z0-9]{1,24}$/ };
const ART_PREFIX = '/api/apps/amp/art?';

export function fmtDur(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

// Mirror of the server's cleanTrack (r32 amp addon). Returns null for anything that would be refused.
export function cleanTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const src = String(t.src || '');
  if (!(src in ID_OK)) return null;
  const id = String(t.id || '');
  if (!ID_OK[src].test(id)) return null;
  const title = String(t.title || '').slice(0, 200).trim();
  if (!title) return null;
  const art = String(t.art || '');
  const dn = Number(t.durSec);
  const durSec = Number.isFinite(dn) && dn > 0 ? Math.min(Math.round(dn), 86400) : 0;   // finite and at most 24h
  return {
    key: src + ':' + id, src, id, title,
    artist: String(t.artist || '').slice(0, 200),
    album: String(t.album || '').slice(0, 200),
    dur: fmtDur(durSec), durSec,
    art: art.startsWith(ART_PREFIX) ? art.slice(0, 400) : '',
    stream: '/api/apps/amp/stream?src=' + src + '&id=' + encodeURIComponent(id),
  };
}

// state = { queue:[item], qi, pos, shuffleOn, repeatMode }. Returns a string, or null when there is nothing worth saving.
export function serializeQueue(state, nowMs) {
  const q = Array.isArray(state && state.queue) ? state.queue : [];
  let qi = Number.isInteger(state && state.qi) ? state.qi : -1;
  if (!q.length || qi < 0 || qi >= q.length) return null;
  let start = 0, list = q;
  const fit = (n) => { // window of n tracks around qi
    start = Math.max(0, Math.min(qi - Math.floor(n / 4), q.length - n));
    list = q.slice(start, start + n);
  };
  if (q.length > MAX_TRACKS) fit(MAX_TRACKS);
  const build = (withArt) => JSON.stringify({
    v: QVERSION, t: nowMs, qi: qi - start,
    pos: Number.isFinite(state.pos) && state.pos > 0 ? Math.round(state.pos * 10) / 10 : 0,
    sh: !!state.shuffleOn, rp: ['off', 'all', 'one'].includes(state.repeatMode) ? state.repeatMode : 'off',
    q: list.map((x) => [x.src, x.id, x.title, x.artist || '', x.album || '', x.durSec || 0, withArt ? (x.art || '') : '']),
  });
  let s = build(true);
  if (s.length > MAX_CHARS) s = build(false);
  let n = list.length;
  while (s.length > MAX_CHARS && n > 1) { n = Math.max(1, Math.floor(n / 2)); fit(n); s = build(false); }
  return s.length > MAX_CHARS ? null : s;
}

// Returns null (nothing usable) or { queue, qi, pos, shuffleOn, repeatMode, dropped }.
export function restoreQueue(raw, nowMs) {
  if (typeof raw !== 'string' || !raw) return null;
  let d;
  try { d = JSON.parse(raw); } catch { return null; }
  if (!d || typeof d !== 'object' || d.v !== QVERSION || !Array.isArray(d.q)) return null;
  if (typeof d.t !== 'number' || !Number.isFinite(d.t) || nowMs - d.t > MAX_AGE_MS || d.t > nowMs + FUTURE_SLACK_MS) return null;
  const rows = d.q.slice(0, READ_CAP);
  const out = []; const origIdx = [];
  rows.forEach((r, i) => {
    if (!Array.isArray(r)) return;
    const c = cleanTrack({ src: r[0], id: r[1], title: r[2], artist: r[3], album: r[4], durSec: r[5], art: r[6] });
    if (c) { out.push(c); origIdx.push(i); }
  });
  if (!out.length) return null;
  const want = Number.isInteger(d.qi) && d.qi >= 0 && d.qi < rows.length ? d.qi : 0;
  let k = origIdx.indexOf(want);
  let pos = Number.isFinite(d.pos) && d.pos > 0 ? d.pos : 0;
  if (k < 0) {                                   // the saved current song did not survive validation
    k = origIdx.findIndex((o) => o > want);
    if (k < 0) k = out.length - 1;
    pos = 0;
  }
  const dur = out[k].durSec;
  if (dur > 0 && pos >= dur - 3) pos = 0;        // was at the very end: start the song over rather than seek past it
  return {
    queue: out, qi: k, pos,
    shuffleOn: d.sh === true,
    repeatMode: ['off', 'all', 'one'].includes(d.rp) ? d.rp : 'off',
    dropped: rows.length - out.length + Math.max(0, d.q.length - READ_CAP),
  };
}

// storage access never throws: private mode, disabled storage and quota errors all just mean "not saved"
export function saveQueue(storage, state, nowMs) {
  try {
    const s = serializeQueue(state, nowMs);
    if (s === null) { storage.removeItem(QKEY); return false; }
    storage.setItem(QKEY, s);
    return true;
  } catch { return false; }
}
export function loadQueue(storage, nowMs) {
  try {
    const raw = storage.getItem(QKEY);
    const r = restoreQueue(raw, nowMs);
    if (!r && raw != null) { try { storage.removeItem(QKEY); } catch {} }   // unusable, expired or future-dated: do not keep re-parsing it
    return r;
  } catch { return null; }
}
