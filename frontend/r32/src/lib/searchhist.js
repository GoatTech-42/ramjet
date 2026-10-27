// recent searches per app. OFF by default (Luke 1:43 PM): nothing is saved or shown until he turns on
// "save my searches" in settings > privacy. per device.
export const savingOn = () => { try { return localStorage.getItem('rj-save-searches') === 'on'; } catch { return false; } };
export function readSearches(key) { if (!savingOn()) return []; try { const a = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(a) ? a.slice(0, 12) : []; } catch { return []; } }
export function addSearch(key, q) {
  if (!savingOn()) return [];
  q = String(q || '').trim().slice(0, 120); if (!q) return readSearches(key);
  const next = [q, ...readSearches(key).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 12);
  try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
  return next;
}
export function clearSearches(key) { try { localStorage.removeItem(key); } catch {} return []; }
export function setSaving(on) { try { if (on) localStorage.setItem('rj-save-searches', 'on'); else { localStorage.removeItem('rj-save-searches'); for (const k of ['rj-browse-searches', 'js-searches', 'amp-searches']) localStorage.removeItem(k); } } catch {} }
