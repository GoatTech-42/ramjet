// command palette: ctrl/cmd-K anywhere in ramjet, plus a small
// button on the home page for phones. plain js, themed with the --rj-* tokens
// so every theme and mode gets it for free.
(function () {
  if (window.__rjPalette) return; window.__rjPalette = 1;
  var PAGES = [['home', '/', 'the ramjet home page'], ['browse', '/browse', 'the whole web'], ['jetstream', '/jetstream', 'search and watch videos'], ['amp', '/amp', 'your music'], ['sage', '/sage', 'ask anything'], ['banter', '/banter', 'chat with friends'], ['settings', '/settings', 'look, account, privacy']];
  var LAYOUTS = ['list', 'grid', 'dock'];
  var css = '#rjp-b{position:fixed;z-index:2147483000;right:14px;bottom:calc(14px + env(safe-area-inset-bottom));height:40px;min-width:40px;padding:0 13px;border-radius:20px;border:1px solid var(--rj-border,rgba(255,255,255,.12));background:var(--rj-surface,#212121);color:var(--rj-text-dim,#b4b4b4);font:500 13px/1 var(--rj-font,system-ui,sans-serif);display:flex;align-items:center;gap:8px;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.35);-webkit-tap-highlight-color:transparent}' +
    '#rjp-b svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}#rjp-b kbd{font:inherit;font-size:11px;opacity:.7;border:1px solid var(--rj-border,rgba(255,255,255,.14));border-radius:5px;padding:2px 5px}#rjp-b:hover{color:var(--rj-text,#ececec)}' +
    '@media (pointer:coarse){#rjp-b{width:44px;height:44px;padding:0;justify-content:center;border-radius:22px}#rjp-b span,#rjp-b kbd{display:none}}' +
    '#rjp{position:fixed;inset:0;z-index:2147483001;display:none;align-items:flex-start;justify-content:center;padding:min(14vh,110px) 14px 14px;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}#rjp.on{display:flex}' +
    '#rjp .c{width:min(560px,100%);max-height:min(70vh,520px);display:flex;flex-direction:column;background:var(--rj-surface,#212121);color:var(--rj-text,#ececec);border:1px solid var(--rj-border,rgba(255,255,255,.1));border-radius:var(--rj-radius,16px);box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden;font-family:var(--rj-font,system-ui,sans-serif)}' +
    '#rjp .q{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--rj-border,rgba(255,255,255,.08))}#rjp .q svg{width:18px;height:18px;stroke:var(--rj-text-faint,#8e8e8e);fill:none;stroke-width:2;stroke-linecap:round;flex:none}' +
    '#rjp input{flex:1;min-width:0;background:none!important;border:0!important;outline:0!important;box-shadow:none!important;border-radius:0!important;padding:0!important;height:auto!important;color:inherit;font:inherit;font-size:16px}#rjp input::placeholder{color:var(--rj-text-faint,#8e8e8e)}' +
    '#rjp .l{overflow:auto;padding:6px;overscroll-behavior:contain}#rjp .h{padding:10px 12px 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--rj-text-faint,#8e8e8e)}' +
    '#rjp .i{display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;padding:10px 12px;border:0;border-radius:calc(var(--rj-radius,16px) - 6px);background:none;color:inherit;font:inherit;font-size:15px;cursor:pointer}#rjp .i small{color:var(--rj-text-faint,#8e8e8e);font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}#rjp .i.s{background:var(--rj-surface-2,#2f2f2f)}#rjp .i b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}' +
    '#rjp .e{padding:20px;text-align:center;color:var(--rj-text-faint,#8e8e8e);font-size:14px}#rjp .f{display:flex;gap:14px;padding:8px 14px;border-top:1px solid var(--rj-border,rgba(255,255,255,.08));font-size:11.5px;color:var(--rj-text-faint,#8e8e8e)}@media (pointer:coarse){#rjp .f{display:none}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var mag = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
  var root = document.createElement('div'); root.id = 'rjp'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'command palette');
  root.innerHTML = '<div class="c"><div class="q">' + mag + '<input type="text" placeholder="go anywhere, or search..." autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="command palette"></div><div class="l"></div><div class="f"><span>&uarr;&darr; move</span><span>enter open</span><span>esc close</span></div></div>';
  document.body.appendChild(root);
  var inp = root.querySelector('input'), list = root.querySelector('.l'), items = [], sel = 0;
  function saving() { try { return localStorage.getItem('rj-save-searches') === 'on'; } catch (e) { return false; } }
  function jget(k) { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; } }
  function openIn(path, key, val) { try { if (key) sessionStorage.setItem(key, val); } catch (e) {} location.href = path; }
  function build(q) {
    var out = [], t = q.trim(), lo = t.toLowerCase();
    var here = location.pathname.replace(/\/$/, '') || '/';
    function has(s) { return !lo || s.toLowerCase().indexOf(lo) >= 0; }
    if (t) {
      out.push({ g: 'search', n: 'search the web for "' + t + '"', d: 'browse', run: function () { try { if (!saving()) throw 0; var a = jget('rj-browse-searches'); a.unshift(t); localStorage.setItem('rj-browse-searches', JSON.stringify(a.filter(function (x, i) { return a.indexOf(x) === i; }).slice(0, 12))); } catch (e) {} openIn('/browse', 'rj-open', t); } });
      out.push({ g: 'search', n: 'search videos for "' + t + '"', d: 'jetstream', run: function () { location.href = '/jetstream?q=' + encodeURIComponent(t); } });
      out.push({ g: 'search', n: 'ask sage: "' + t + '"', d: 'sage', run: function () { openIn('/sage', 'rj-ask', t); } });
    }
    PAGES.forEach(function (p) { if (has(p[0] + ' ' + p[2])) out.push({ g: 'go to', n: p[0], d: p[2], cur: (p[1] === here), run: function () { location.href = p[1]; } }); });
    LAYOUTS.forEach(function (l) { if (has('layout ' + l)) out.push({ g: 'home layout', n: 'layout: ' + l, d: 'switch the home page', run: function () { try { localStorage.setItem('rj-layout', l); } catch (e) {} location.href = '/'; } }); });
    if (has('log out sign out')) out.push({ g: 'account', n: 'log out', d: '', run: function () { fetch('/api/auth/logout', { method: 'POST' }).catch(function () {}).then(function () { location.href = '/login'; }); } });
    var seen = {}, rec = [];
    (saving() ? jget('rj-browse-searches') : []).slice(0, 8).forEach(function (s) { if (typeof s === 'string' && s && !seen[s] && has(s)) { seen[s] = 1; rec.push({ g: 'recent', n: s, d: 'search again', run: function () { openIn('/browse', 'rj-open', s); } }); } });
    jget('rj-browse-recent').slice(0, 8).forEach(function (r) { var u = typeof r === 'string' ? r : (r && (r.url || r.address || r.host)) || ''; var nm = typeof r === 'object' && r && r.title ? r.title : u; if (u && !seen[u] && (has(u) || has(nm))) { seen[u] = 1; rec.push({ g: 'recent', n: String(nm).slice(0, 60), d: String(u).replace(/^https?:\/\//, '').slice(0, 40), run: function () { openIn('/browse', 'rj-open', u); } }); } });
    out = out.concat(rec.slice(0, 6));
    return out.slice(0, 40);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function render() {
    items = build(inp.value); if (sel >= items.length) sel = 0;
    if (!items.length) { list.innerHTML = '<div class="e">nothing here. type something to search.</div>'; return; }
    var h = '', g = '';
    items.forEach(function (it, i) { if (it.g !== g) { g = it.g; h += '<div class="h">' + esc(g) + '</div>'; } h += '<button type="button" class="i' + (i === sel ? ' s' : '') + '" data-i="' + i + '"><b>' + esc(it.n) + '</b><small>' + esc(it.cur ? 'you are here' : it.d) + '</small></button>'; });
    list.innerHTML = h;
    var s = list.querySelector('.s'); if (s && s.scrollIntoView) s.scrollIntoView({ block: 'nearest' });
  }
  function open() { root.classList.add('on'); inp.value = ''; sel = 0; render(); setTimeout(function () { inp.focus(); }, 20); }
  function close() { root.classList.remove('on'); inp.blur(); }
  function run(i) { var it = items[i]; if (it) { close(); it.run(); } }
  inp.addEventListener('input', function () { sel = 0; render(); });
  list.addEventListener('click', function (e) { var b = e.target.closest && e.target.closest('.i'); if (b) run(+b.getAttribute('data-i')); });
  list.addEventListener('mousemove', function (e) { var b = e.target.closest && e.target.closest('.i'); if (b && +b.getAttribute('data-i') !== sel) { sel = +b.getAttribute('data-i'); var o = list.querySelector('.s'); if (o) o.classList.remove('s'); b.classList.add('s'); } });
  root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
  root.addEventListener('touchstart', function (e) { if (e.target === root) close(); }, { passive: true });
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(items.length, 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(items.length, 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
  });
  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); e.stopPropagation(); root.classList.contains('on') ? close() : open(); }
    else if (e.key === 'Escape' && root.classList.contains('on')) { e.preventDefault(); close(); }
  }, true);
  window.rjPalette = { open: open, close: close };
  if ((location.pathname.replace(/\/$/, '') || '/') === '/') {
    var b = document.createElement('button'); b.id = 'rjp-b'; b.type = 'button'; b.setAttribute('aria-label', 'open command palette');
    b.innerHTML = mag + '<span>search or jump</span><kbd>' + (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '&#8984;K' : 'Ctrl K') + '</kbd>';
    b.addEventListener('click', open); document.body.appendChild(b);
  }
})();
