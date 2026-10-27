import { errCopy } from '../../lib/api.js';
// Paged search state: query-generation guard, dedupe by id (YouTube repeats
// ~7% of items across pages), one request in flight, retryable error, and a
// hard stop when the server sends no `next` token.
export function createSearchPager(fetchPage, { maxPages = 8 } = {}) {
  let gen = 0, st = null;
  const fresh = (q) => ({ q, items: [], seen: new Set(), next: null, done: false, busy: false, err: '', pages: 0 });
  const view = () => st ? { items: st.items, done: st.done, capped: !!st.next && st.pages >= maxPages, busy: st.busy, err: st.err, noRetry: !!st.noRetry, q: st.q } : { items: [], done: true, capped: false, busy: false, err: '', q: '' };
  async function run(myGen, s, token) {
    s.busy = true; s.err = ''; s.noRetry = false;
    let r;
    try { r = await fetchPage(s.q, token); } catch { r = { ok: false }; }
    if (myGen !== gen) return null;                 // a newer query replaced this one: drop it
    s.busy = false;
    if (!r || !r.ok) { s.noRetry = !!r && (r.status === 429 || r.status === 403); s.err = r ? errCopy(r, "search couldn't load.") : "search couldn't load."; return view(); }
    const add = [];
    for (const v of r.data.results || []) if (v && v.id && !s.seen.has(v.id)) { s.seen.add(v.id); add.push(v); }
    s.items = s.items.concat(add); s.pages++;
    s.next = r.data.next || null;
    s.done = !s.next;
    return view();
  }
  return {
    start(q) { gen++; st = fresh(q); return run(gen, st, null); },
    // auto = scroll-driven: never while an error is showing (wait for Retry) and
    // never past the page cap (a visible Load more takes over). manual bypasses both.
    more({ manual = false } = {}) {
      if (!st || st.busy || st.done) return null;   // single flight; stops at the end
      if (!manual && (st.err || st.pages >= maxPages)) return null;
      return run(gen, st, st.next);
    },
    retry() { return this.more({ manual: true }); },
    reset() { gen++; st = null; },
    view,
  };
}

// The token is delivered pre-encoded by the server: append it VERBATIM. Encoding
// it again turns %3D into %253D and the continuation silently restarts at page 1.
export function searchUrl(q, token) {
  return `/api/apps/jetstream/search?q=${encodeURIComponent(q)}${token ? `&token=${token}` : ''}`;
}
