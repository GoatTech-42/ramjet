// tiny ttl map with fifo cap, for read-path response caching (search,
// artist pages). stores resolved VALUES only: a rejected promise is never
// cached, so a source that fails keeps failing honestly instead of
// poisoning the cache. stored values are DEEP-FROZEN: every request shares
// the cached object, so a caller that mutates it (a fallback fill, a url
// rewrite) would leak request-specific data to the next caller. callers
// that need to adapt a value clone it first.
const freeze = (v, seen = new WeakSet()) => {
  if (v && typeof v === 'object' && !seen.has(v)) {
    seen.add(v);
    for (const x of Object.values(v)) freeze(x, seen);
    Object.freeze(v);
  }
  return v;
};
export class TtlCache {
  constructor(ttlMs, max = 100) { this.ttl = ttlMs; this.max = max; this.m = new Map(); }
  get(k) {
    const h = this.m.get(k);
    if (h && Date.now() - h.at < this.ttl) return h.v;
    if (h) this.m.delete(k);
    return undefined;
  }
  set(k, v) {
    // an overwrite refreshes in place: it must never evict a THIRD key
    if (this.m.has(k)) this.m.delete(k);
    else if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { at: Date.now(), v: freeze(v) });
    return v;
  }
  async through(k, fn) {
    const h = this.get(k);
    if (h !== undefined) return h;
    return this.set(k, await fn()); // a throw propagates and caches nothing
  }
}
