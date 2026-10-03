// lite = "this connection is probably metered, send smaller thumbnails".
// settings > data saver overrides: on = lite, off = full. in auto we use the
// Network Information API where it exists (Chrome/Android: saveData, cellular,
// slow effective type -> lite; wifi/ethernet -> full). Safari/iPhone has no
// such API, so on a phone auto stays lite until you set data saver to off.
export function netLite() {
  try {
    const ds = localStorage.getItem('rj-datasaver');
    if (ds === 'on') return true;
    if (ds === 'off') return false;
    const c = navigator.connection;
    if (c) {
      if (c.saveData) return true;
      if (c.type === 'cellular') return true;
      if (c.type === 'wifi' || c.type === 'ethernet') return false;
      if (/^(slow-2g|2g|3g)$/.test(c.effectiveType || '')) return true;
      return false;
    }
    return /iPhone|Android.*Mobile/.test(navigator.userAgent) || (matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 500);
  } catch { return false; }
}
