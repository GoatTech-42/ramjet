// technical details layer: stats, timings and build info. off by default, switched on in Settings. device-local.
export const techOn = () => { try { return localStorage.getItem('rj-tech') === '1'; } catch { return false; } };
export function setTech(on) { try { localStorage.setItem('rj-tech', on ? '1' : '0'); } catch {} }
