// Album page data: built from the same /api/apps/amp/search rows as the artist page. No new server route.
// Only youtube music rows carry `album`; sc/au rows never match, so an album page is yt-only by construction.
import { norm, credit, primaryArtist } from './artist.js';

// Rows on this album, credited to the artist (lead or featured). Server order is kept: rows carry no track
// number, so this is relevance order, NOT track order. The UI must not label it "track list".
export function buildAlbumPage(rows, artist, album) {
  const a = primaryArtist(artist), want = norm(album);
  const all = Array.isArray(rows) ? rows : [];
  const tracks = want ? all.filter((r) => norm(r && r.album) === want && credit(r, a) > 0) : [];
  const first = tracks[0] || {};
  const durSec = tracks.reduce((n, r) => n + (Number.isFinite(r.durSec) ? r.durSec : 0), 0);
  return {
    name: String(first.album || album || '').trim(),
    artist: primaryArtist(first.artist) || a,
    art: (tracks.find((r) => r.art) || {}).art || '',
    tracks, total: tracks.length, durSec,
  };
}

export function albumQuery(artist, album) { return (primaryArtist(artist) + ' ' + String(album ?? '').trim()).trim(); }

export function runtime(sec) {
  const m = Math.round((sec || 0) / 60);
  return m >= 60 ? Math.floor(m / 60) + ' hr ' + (m % 60) + ' min' : m + ' min';
}
