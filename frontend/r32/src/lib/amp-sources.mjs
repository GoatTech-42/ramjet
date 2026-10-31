// amp first-page source outcomes. the search envelope names attempted-but-failed catalogs in
// failed[] (stable order, only attempted sources): those "couldn't load" and are never
// presented as a successful empty page. a source with no rows that did NOT fail truly had
// no results. older backends without the field answer failed=[] - behavior unchanged there.
export const AMP_SOURCES = ['youtube', 'soundcloud', 'audius'];
export function sourceSplit(results, failed) {
  const bad = new Set(Array.isArray(failed) ? failed.filter((k) => AMP_SOURCES.includes(k)) : []);
  return {
    failed: AMP_SOURCES.filter((k) => bad.has(k)),
    empty: AMP_SOURCES.filter((k) => !bad.has(k) && !(((results || {})[k]) || []).length),
  };
}
