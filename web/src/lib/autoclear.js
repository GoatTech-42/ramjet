





const CFG = 'rj-autoclear', SEEN = 'rj-last-seen';
export const AUTOCLEAR_KEYS = ['rj-browse-recent', 'rj-browse-history', 'amp-recent', 'js-pos', 'js-searches', 'amp-searches', 'rj-browse-searches'];
export function readCfg() { try { return { on: false, mins: 30, ...JSON.parse(localStorage.getItem(CFG) || '{}') }; } catch { return { on: false, mins: 30 }; } }
export function writeCfg(c) { try { localStorage.setItem(CFG, JSON.stringify({ on: !!c.on, mins: Number(c.mins) || 30 })); } catch {} }
const stamp = () => { try { localStorage.setItem(SEEN, String(Date.now())); } catch {} };
export function clearNow() {
  for (const k of AUTOCLEAR_KEYS) { try { localStorage.removeItem(k); } catch {} }
  try { fetch('/api/apps/jetstream/history/clear-watch', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {}); } catch {}
}
function check() {
  const c = readCfg();
  if (!c.on) { stamp(); return; }
  const seen = Number(localStorage.getItem(SEEN) || 0);
  if (seen && Date.now() - seen >= c.mins * 60000) clearNow();
  stamp();
}
try {
  check();
  setInterval(() => { if (document.visibilityState === 'visible') stamp(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); else stamp(); });
  addEventListener('pagehide', stamp);
} catch {}
