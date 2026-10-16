// a deploy swaps the hashed bundles: an open tab still running the old page
// can no longer fetch its lazy chunks (vite reports this as vite:preloadError
// on window). reload once to converge on the new deploy.
const KEY = 'rj-preload-reload';
const MIN_GAP_MS = 60 * 1000;

// the whole decision in one try: the guard must be WRITTEN before any reload
// happens. a storage that reads fine but denies writes (or vice versa) makes
// this return false every time, so the error is left alone and the page can
// never be pulled into a reload loop with nothing persisted.
export function planPreloadReload(store, now = Date.now()) {
  try {
    if (now - Number(store.getItem(KEY) || 0) <= MIN_GAP_MS) return false;
    store.setItem(KEY, String(now)); // persisted guard first, reload after
    return true;
  } catch { return false; }
}

export function installPreloadRecovery({ store, reload, target } = {}) {
  try {
    const t = target || window;
    const r = reload || (() => location.reload());
    t.addEventListener('vite:preloadError', (e) => {
      // storage is acquired HERE, not at install: the sessionStorage getter
      // itself throws (SecurityError) on storage-denied browsers, and at
      // install time that would take down every page entry - even login.
      let s = store;
      if (!s) { try { s = t.sessionStorage; } catch { return; } }
      if (!planPreloadReload(s)) return; // not recovering: let the error through untouched
      // only now, recovery scheduled, swallow the error the reload replaces
      try { e.preventDefault(); } catch {}
      r();
    });
  } catch { /* crash recovery must never stop a page from mounting */ }
}
