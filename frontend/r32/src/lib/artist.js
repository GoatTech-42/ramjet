// Artist page data: built ONLY from the existing /api/apps/amp/search rows. No new server route.
// Row shape (r32): { key, src:'yt'|'sc'|'au', id, title, artist, album?, plays?, dur, durSec, art, stream }.

// Same splitter the player bar and quick-search chips already use, so "artist" means one thing everywhere.
export const ARTIST_SPLIT = /,|&| feat\.? /i;

const FOLD = { '\u00f8': 'o', '\u00e6': 'ae', '\u0153': 'oe', '\u0142': 'l', '\u00df': 'ss', '\u0111': 'd', '\u00f0': 'd', '\u00fe': 'th' };   // letters NFKD does not decompose
// Letters and digits of ANY script are kept: the old [a-z0-9] filter turned every CJK, Cyrillic, Greek or Hangul name
// into "" and the artist page could never match it. Marks stay except the Latin accent block, so kana voicing marks are
// not lost. A name with no letters or digits at all ("!!!") falls back to its trimmed lowercase text instead of "".
export function norm(s) {
  const t = String(s ?? '');
  const n = t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[\u00f8\u00e6\u0153\u0142\u00df\u0111\u00f0\u00fe]/g, (c) => FOLD[c])
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
  return n || (/\S/.test(t) && !/[\p{L}\p{N}]/u.test(t) ? t.trim().toLowerCase() : '');
}

// "Daft Punk, Pharrell Williams" -> "Daft Punk". Display casing is kept.
export function primaryArtist(s) {
  return String(s ?? '').split(ARTIST_SPLIT)[0].trim();
}
function parts(s) { return String(s ?? '').split(ARTIST_SPLIT).map(norm).filter(Boolean); }

// 0 = not by this artist, 2 = lead artist, 1 = credited as a featured/second artist.
export function credit(row, name) {
  const n = norm(primaryArtist(name));
  if (!n || !row) return 0;
  const p = parts(row.artist);
  if (!p.length) return 0;
  if (p[0] === n) return 2;
  return p.includes(n) ? 1 : 0;
}

// Exact name match only (no fuzzy), so a search for "Prince" never fills the page with "Prince Royce".
// Rows are NOT deduped across sources: the player's fallback needs the other-source copy in the list.
// Lead credits first, then featured; order inside each group is the server's order (relevance).
export function buildArtistPage(rows, name) {
  const want = primaryArtist(name);
  const all = Array.isArray(rows) ? rows : [];
  const lead = [], feat = [];
  for (const r of all) { const c = credit(r, want); if (c === 2) lead.push(r); else if (c === 1) feat.push(r); }
  const tracks = lead.concat(feat);
  const counts = { yt: 0, sc: 0, au: 0 };
  for (const r of tracks) if (r.src in counts) counts[r.src]++;
  const art = (tracks.find((r) => r.art) || {}).art || '';
  const seen = new Map();
  for (const r of tracks) {
    const k = norm(r.album);
    if (!k) continue;
    const e = seen.get(k) || { name: String(r.album).trim(), art: '', count: 0 };
    e.count++; if (!e.art && r.art) e.art = r.art;
    seen.set(k, e);
  }
  const albums = [...seen.values()].sort((a, b) => b.count - a.count);
  // header name: the casing the catalog uses, falling back to what was asked for
  const display = primaryArtist((lead[0] || {}).artist) || want;
  return { name: display, query: want, art, tracks, total: tracks.length, leadCount: lead.length, counts, albums };
}

export function summary(page) {
  const L = { yt: 'youtube music', sc: 'soundcloud', au: 'audius' };
  const bits = Object.keys(L).filter((k) => page.counts[k]).map((k) => page.counts[k] + ' on ' + L[k]);
  return bits.join(' · ');
}
