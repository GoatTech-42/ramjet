// Playlist share/import. No server route: the share code is the playlist's songs, carried as text.
// Server limits this has to respect (mounted playlist routes): 100 songs per playlist, 20 playlists, add is
// idempotent ({already:true}), and the server rebuilds stream/key from (src,id) so nothing here is trusted.
import { cleanTrack } from './queue-persist.js';

export const SHARE_PREFIX = 'amp1:';
export const MAX_SONGS = 100;
export const MAX_CODE_CHARS = 60000;
const READ_CAP = 1000;                      // rows read from a foreign code before dedupe/truncation
const NAME_DEFAULT = 'imported playlist';

function b64uEncode(str) {
  const bytes = new TextEncoder().encode(str); let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  const bin = atob(s); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const cleanName = (n) => Array.from(String(n ?? '').replace(/\s+/g, ' ').trim()).slice(0, 40).join('').trim();   // 40 code points, matches the server

export function encodeShare(name, tracks) {
  const t = (Array.isArray(tracks) ? tracks : []).map((x) => cleanTrack(x)).filter(Boolean).slice(0, MAX_SONGS);
  return SHARE_PREFIX + b64uEncode(JSON.stringify({ v: 1, n: cleanName(name), t: t.map((x) => [x.src, x.id, x.title, x.artist, x.album, x.durSec]) }));
}

export function decodeShare(text) {
  const s = String(text ?? '');
  const at = s.indexOf(SHARE_PREFIX);
  if (at < 0) return { ok: false, error: 'that is not an amp playlist code' };
  // chat apps wrap long codes and people add words after them: try the first unbroken token, then the
  // whitespace-joined text, and use whichever decodes.
  const after = s.slice(at + SHARE_PREFIX.length);
  const cands = [/^[A-Za-z0-9_-]+/.exec(after), /^[A-Za-z0-9_-]+/.exec(after.replace(/\s+/g, ''))].filter(Boolean).map((m) => m[0]);
  if (!cands.length) return { ok: false, error: 'that is not an amp playlist code' };
  if (cands.some((c) => c.length > MAX_CODE_CHARS)) return { ok: false, error: 'that code is too long' };
  let d;
  for (const c of cands) { try { d = JSON.parse(b64uDecode(c)); break; } catch { d = undefined; } }
  if (d === undefined) return { ok: false, error: 'that code is damaged' };
  if (!d || typeof d !== 'object' || !Array.isArray(d.t)) return { ok: false, error: 'that code is damaged' };
  if (d.v !== 1) return { ok: false, error: 'that code came from a newer amp' };
  const rows = d.t.slice(0, READ_CAP);
  const seen = new Set(); const tracks = []; let dropped = 0, duplicates = 0;
  for (const r of rows) {
    const c = Array.isArray(r) ? cleanTrack({ src: r[0], id: r[1], title: r[2], artist: r[3], album: r[4], durSec: r[5] }) : null;
    if (!c) { dropped++; continue; }
    if (seen.has(c.key)) { duplicates++; continue; }
    seen.add(c.key); tracks.push(c);
  }
  const truncated = Math.max(0, tracks.length - MAX_SONGS) + Math.max(0, d.t.length - READ_CAP);
  const kept = tracks.slice(0, MAX_SONGS);
  if (!kept.length) return { ok: false, error: 'no playable songs in that code' };
  return { ok: true, name: cleanName(d.n) || NAME_DEFAULT, tracks: kept, total: d.t.length, dropped, duplicates, truncated };
}

// Create the playlist, then add songs one at a time (there is no bulk route). `api` is the client's api()
// wrapper: api(path, {method, body}) -> {ok, status, data}. Never throws; reports how far it got.
export async function importPlaylist(api, decoded, { signal, onProgress } = {}) {
  const res = { ok: false, id: '', name: decoded.name, added: 0, already: 0, failed: 0, total: decoded.tracks.length, stopped: '', error: '' };
  if (signal && signal.aborted) { res.stopped = 'aborted'; return res; }   // cancelled before anything was created: no mutation at all
  let r;
  try { r = await api('/api/apps/amp/playlists', { method: 'POST', body: { name: decoded.name } }); } catch { r = null; }
  if (!r || !r.ok || !r.data || !r.data.playlist) { res.stopped = 'create'; res.error = (r && r.data && r.data.error) || 'could not create the playlist'; return res; }
  res.ok = true; res.id = r.data.playlist.id;
  let streak = 0, done = 0;
  for (const t of decoded.tracks) {
    if (signal && signal.aborted) { res.stopped = 'aborted'; break; }
    let a;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { a = await api('/api/apps/amp/playlists/add', { method: 'POST', body: { id: res.id, track: t } }); } catch { a = null; }
      if (a && a.status) break;                  // got a real HTTP answer; only network failures get the one retry
    }
    done++;
    if (a && a.ok) { if (a.data && a.data.already) res.already++; else res.added++; streak = 0; }
    else {
      const st = a && a.status; const msg = String((a && a.data && a.data.error) || '');
      if (st === 404) { res.stopped = 'gone'; res.error = msg; break; }
      if (st === 413) { res.stopped = 'too-large'; res.error = msg; break; }
      if (st === 429) { res.stopped = 'rate'; res.error = msg; break; }
      if (st === 400 && /this playlist is full/.test(msg)) { res.stopped = 'full'; res.error = msg; break; }
      res.failed++; streak++;
      if (streak >= 3) { res.stopped = 'errors'; res.error = msg; break; }
    }
    if (onProgress) onProgress(done, res.total);
  }
  return res;
}
