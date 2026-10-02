// recent searches per app; synced to the account through theme-boot's key list
export function readSearches(key) { try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a.slice(0, 12) : []; } catch { return []; } }
export function addSearch(key, q) {
  q = String(q || '').trim().slice(0, 120); if (!q) return readSearches(key);
  const next = [q, ...readSearches(key).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 12);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  return next;
}
export function clearSearches(key) { try { localStorage.removeItem(key); } catch {} return []; }
