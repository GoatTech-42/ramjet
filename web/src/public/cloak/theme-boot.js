(function () {
  var BASES = {
    black: ['#000000', '#212121', '#2f2f2f', '#171717'],
    graphite: ['#121316', '#1c1e23', '#272a31', '#181a1e'],
    midnight: ['#0b0f1a', '#151b2b', '#1f2740', '#101626'],
    warm: ['#14110f', '#211c18', '#2d2621', '#1a1613']
  };
  var RADII = { sharp: 10, soft: 16, round: 22 };
  var FONTS = {
    mono: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace',
    serif: 'ui-serif, "New York", Georgia, "Times New Roman", serif',
    round: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, -apple-system, sans-serif'
  };
  var SYNC = ['rj-theme', 'rj-layout', 'rj-wall', 'rj-tech', 'rj-desk', 'sage-style', 'rj-note', 'rj-todo', 'amp-recent', 'rj-browse-recent', 'rj-browse-history', 'js-later', 'js-pos', 'js-audio-only', 'sage-conv-id', 'sage-conversation', 'rj-cloak', 'rj-adblock', 'rj-datasaver', 'rj-autoclear', 'js-searches', 'amp-searches', 'rj-browse-searches'];
  function ink(hex) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? '#14170a' : '#ffffff';
  }
  var GLASS_PROPS = ['--rj-g-blur', '--rj-border', '--rj-text', '--rj-text-dim', '--rj-text-faint'];
  function apply(c) {
    var root = document.documentElement, s = root.style;
    var glass = !!(c && c.skin === 'glass');
    if (glass) {
      root.setAttribute('data-skin', 'glass');
      if (!document.getElementById('rj-glass-css')) {
        if (document.readyState === 'loading') document.write('<link id="rj-glass-css" rel="stylesheet" href="/cloak/glass.css?v=5">');
        else { var l = document.createElement('link'); l.id = 'rj-glass-css'; l.rel = 'stylesheet'; l.href = "/cloak/glass.css?v=5"; document.head.appendChild(l); }
      }
    } else root.removeAttribute('data-skin');
    var b = glass ? null : (BASES[c && c.base] || null);
    var props = ['--rj-bg', '--rj-surface', '--rj-surface-2', '--rj-hover'];
    if (glass) {
      // glass clarity 0 (clear) .. 100 (opaque): blend a white wash into a dark tint, more blur as it gets clearer
      var g = Math.max(0, Math.min(100, c.glass == null ? 55 : +c.glass)) / 100;
      var mix = function (a, z) { return Math.round(a + (z - a) * g); };
      var rgb = mix(255, 34) + ',' + mix(255, 38) + ',' + mix(255, 52);
      s.setProperty('--rj-bg', '#070a12');
      s.setProperty('--rj-surface', 'rgba(' + rgb + ',' + (0.08 + 0.78 * g).toFixed(2) + ')');
      s.setProperty('--rj-surface-2', 'rgba(' + rgb + ',' + (0.14 + 0.74 * g).toFixed(2) + ')');
      s.setProperty('--rj-hover', 'rgba(255,255,255,0.07)');
      s.setProperty('--rj-border', 'rgba(255,255,255,0.17)');
      s.setProperty('--rj-text', '#f4f6fb'); s.setProperty('--rj-text-dim', '#d3d8e4'); s.setProperty('--rj-text-faint', '#aab1c2');
      s.setProperty('--rj-g-blur', Math.round(32 - 12 * g) + 'px');
    } else {
      for (var i = 0; i < 4; i++) { if (b) s.setProperty(props[i], b[i]); else s.removeProperty(props[i]); }
      for (var j = 0; j < GLASS_PROPS.length; j++) s.removeProperty(GLASS_PROPS[j]);
    }
    if (c && /^#[0-9a-f]{6}$/i.test(c.accent || '')) { s.setProperty('--rj-accent', c.accent); s.setProperty('--rj-accent-ink', ink(c.accent)); }
    else { s.removeProperty('--rj-accent'); s.removeProperty('--rj-accent-ink'); }
    var r = RADII[c && c.round];
    if (glass && !r) r = 14;
    if (r) s.setProperty('--rj-radius', r + 'px'); else s.removeProperty('--rj-radius');
    var f = FONTS[c && c.font];
    if (f) s.setProperty('--rj-font', f); else s.removeProperty('--rj-font');
    var m = document.querySelector('meta[name=theme-color]');
    if (m) m.setAttribute('content', glass ? '#070a12' : (b ? b[0] : '#000000'));
  }
  window.__rjTheme = apply;
  try { apply(JSON.parse(localStorage.getItem('rj-theme') || 'null')); } catch (e) {}

  // wallpaper: one fixed layer behind every page
  function wall(v) {
    var old = document.getElementById('rj-wall'); if (old) old.remove();
    if (!v || v === 'none' || !document.body) return;
    var d = document.createElement('div'); d.id = 'rj-wall'; d.className = 'wall wall-' + v;
    document.body.insertBefore(d, document.body.firstChild);
  }
  window.__rjWall = wall;
  function mount() { try { wall(localStorage.getItem('rj-wall')); } catch (e) {} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

  // account sync: every write to a synced key is mirrored to the account; a newer copy on the
  // account wins on the next page load. local copy applies instantly, so there is no flash.
  var raw = { set: Storage.prototype.setItem, del: Storage.prototype.removeItem, get: Storage.prototype.getItem };
  var timer = 0, syncing = false;
  function collect() { var o = {}; SYNC.forEach(function (k) { var v = raw.get.call(localStorage, k); if (v != null) o[k] = v; }); return o; }
  function push() {
    var ts = Date.now();
    raw.set.call(localStorage, 'rj-prefs-ts', String(ts));
    fetch('/api/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: collect(), ts: ts }), credentials: 'same-origin' }).catch(function () {});
  }
  function queue() { if (syncing) return; clearTimeout(timer); timer = setTimeout(push, 700); }
  Storage.prototype.setItem = function (k, v) { raw.set.call(this, k, v); if (this === window.localStorage && SYNC.indexOf(k) >= 0) queue(); };
  Storage.prototype.removeItem = function (k) { raw.del.call(this, k); if (this === window.localStorage && SYNC.indexOf(k) >= 0) queue(); };
  function pull(live) {
      fetch('/api/prefs', { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j || !j.ok) return;
        var lts = +(raw.get.call(localStorage, 'rj-prefs-ts') || 0);
        var has = Object.keys(j.prefs || {}).length > 0;
        if (has && j.ts > lts) {
          syncing = true;
          SYNC.forEach(function (k) { if (j.prefs[k] != null) raw.set.call(localStorage, k, j.prefs[k]); else raw.del.call(localStorage, k); });
          raw.set.call(localStorage, 'rj-prefs-ts', String(j.ts));
          syncing = false;
          if (sessionStorage.getItem('rj-synced') !== String(j.ts)) { sessionStorage.setItem('rj-synced', String(j.ts)); if (live) { var busy = false; document.querySelectorAll('audio,video').forEach(function (m) { if (!m.paused) busy = true; }); var a = document.activeElement; if (a && /INPUT|TEXTAREA/.test(a.tagName)) busy = true; if (busy) return; } location.reload(); }
        } else if (j.ts < lts || (!has && Object.keys(collect()).length)) { push(); }
      }).catch(function () {});
  }
  try {
    if (!/^\/(login|password|claim)/.test(location.pathname)) {
      pull(false);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) pull(true); });
      window.addEventListener('focus', function () { pull(true); });
    }
  } catch (e) {}

})();
