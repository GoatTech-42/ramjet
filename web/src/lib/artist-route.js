// amp artist pages live in the location hash: #/amp/artist/<src>:<opaque-id>
// (or name~<name> for a youtube name lookup). keeping it in the hash means
// refresh and direct links work and no full reload ever touches the audio
// element. the id is opaque - never parse or build one from a name.
export function hashForArtist(src, idOrKey) {
  return '#/amp/artist/' + encodeURIComponent(src + ':' + idOrKey);
}

export function parseArtistHash(hash) {
  const m = /^#\/amp\/artist\/(.+)$/.exec(hash || '');
  if (!m) return null;
  let key;
  try { key = decodeURIComponent(m[1]); } catch { return null; }
  const ci = key.indexOf(':');
  if (ci < 1) return null;
  const src = key.slice(0, ci);
  if (src !== 'yt' && src !== 'sc' && src !== 'au') return null;
  const rest = key.slice(ci + 1);
  if (!rest) return null;
  if (rest.startsWith('name~')) {
    const name = rest.slice(5).trim();
    return name ? { src, name } : null;
  }
  return { src, id: rest };
}
