// Tab cloak: while rj-cloak is on in this browser, the tab reads "Google Docs"
// with the Google Docs favicon, and later title/icon changes are put back.
// On by default (storage failure reads as on, matching the html bootstrap).
const TITLE = 'Google Docs';
const ICONS = [['image/png', '/skin/docs2026-32.png', '32x32'], ['image/x-icon', '/skin/docs2026.ico', null]];
let guard = false;
const isOn = () => { try { return localStorage.getItem('rj-cloak') !== '0'; } catch { return true; } };
let saved = null;
export function applyCloak() {
  if (guard) return;
  guard = true;
  try {
    if (isOn()) {
      if (!saved) saved = (window.__rjCloakBase && typeof window.__rjCloakBase.title === 'string') ? window.__rjCloakBase : { title: document.title, icons: [...document.querySelectorAll("link[rel~='icon']")].map((l) => l.getAttribute('href')) };
      if (document.title !== TITLE) document.title = TITLE;
      const cur = [...document.querySelectorAll("link[rel~='icon']")];
      const ok = cur.length === ICONS.length && cur.every((l, i) => l.getAttribute('href') === ICONS[i][1]);
      if (!ok) {
        cur.forEach((l) => l.remove());
        for (const [type, href, sizes] of ICONS) {
          const l = document.createElement('link');
          l.rel = 'icon'; l.type = type; l.href = href;
          if (sizes) l.sizes = sizes;
          document.head.appendChild(l);
        }
      }
    } else if (saved) {
      document.querySelectorAll("link[rel~='icon']").forEach((l) => l.remove());
      for (const h of saved.icons) { const l = document.createElement('link'); l.rel = 'icon'; l.href = h; document.head.appendChild(l); }
      if (document.title === TITLE) document.title = saved.title;
      saved = null;
    }
  } finally { guard = false; }
}
export function isCloaked() { return isOn(); }
applyCloak();
new MutationObserver(applyCloak).observe(document.head, { childList: true, subtree: true, characterData: true, attributes: true });
window.addEventListener('storage', (e) => { if (e.key === 'rj-cloak') applyCloak(); });
