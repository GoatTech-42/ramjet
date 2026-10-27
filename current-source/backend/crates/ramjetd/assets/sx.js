// Modified from GoatTech Ramjet legacy core/index.js (AGPL-3.0). Modifications 2026-10-26.
(function () {
  var de = document.documentElement;
  var framed = false;
  try { if (window.parent !== window) framed = true; } catch (e) { framed = true; }
  if (framed) de.classList.add('framed');

  function lite() { try { var ds = localStorage.getItem('rj-datasaver'); if (ds === 'on') return true; if (ds === 'off') return false; var c = navigator.connection; if (c) { if (c.saveData || c.type === 'cellular') return true; if (c.type === 'wifi' || c.type === 'ethernet') return false; return /^(slow-2g|2g|3g)$/.test(c.effectiveType || ''); } return /iPhone|Android.*Mobile/.test(navigator.userAgent); } catch (e) { return false; } }

  /* image failures: the img proxy sheds load with a fast 503 when the box is
     busy, so retry a bounded number of times on a slow timer (the 503 carries
     Retry-After 2), then fall back to the alt source, then a plain tile.
     upstream hotlink refusals stay refused - the tile says so, nothing fakes it */
  function sxImageError(e) {
    var t = e.target; if (!t || t.tagName !== 'IMG') return;
    if (t.closest && t.closest('.lb')) return;
    var src = t.getAttribute('src') || '';
    sxCancelRetry(t);
    var tries = +(t.getAttribute('data-rjtry') || '0');
    if (tries < 2 && src.indexOf('/searx/img?') === 0) {
      t.setAttribute('data-rjtry', String(tries + 1));
      var version = t._sxVersion;
      t._sxRetry = setTimeout(function () {
        if (t._sxVersion !== version || t.getAttribute('src') !== src || (t.complete && t.naturalWidth)) return;
        t._sxRetry = 0; t.src = src;
      }, 2100 + Math.random() * 1900);
      return;
    }
    var a = t.getAttribute('data-alt');
    if (a) { t.removeAttribute('data-alt'); t.removeAttribute('data-rjtry'); t.src = a; return; }
    var li = t.closest ? t.closest('li.tile') : null;
    if (li) { li.classList.add('noimg'); t.removeAttribute('src'); }
    else if (t.closest && t.closest('.strip-row a')) { var box = t.closest('.strip-row a'); box.classList.remove('sx-ready'); box.classList.add('sx-failed'); }
    else if (t.classList.contains('hit-th')) t.classList.add('sx-failed');
    else t.style.visibility = 'hidden';
  }
  document.addEventListener('error', sxImageError, true);

  function sxCancelRetry(im) {
    clearTimeout(im._sxRetry); im._sxRetry = 0;
    im._sxVersion = (im._sxVersion || 0) + 1;
  }
  de.classList.add('sx-img-enhanced');

  /* Filmstrip states: reserve space while loading, collapse only final failures. */
  function stripReady(im) {
    if (!im.naturalWidth) return;
    sxCancelRetry(im); im.removeAttribute('data-rjtry');
    im.classList.remove('sx-failed');
    var a = im.closest && im.closest('.strip-row a');
    if (!a) return;
    a.classList.add('sx-ready'); a.classList.remove('sx-failed');
  }
  document.addEventListener('load', function (e) {
    var im = e.target; if (im && im.tagName === 'IMG') stripReady(im);
  }, true);
  document.querySelectorAll('.strip-row img, img.hit-th').forEach(function (im) {
    if (!im.complete) return;
    if (im.naturalWidth) stripReady(im);
    else if (im.getAttribute('src')) sxImageError({ target: im });
  });

  /* error line: shown when a link cannot be carried through the proxy */
  function sxerr(msg) {
    var t = document.getElementById('sxerr');
    if (!t) { t = document.createElement('div'); t.id = 'sxerr'; t.setAttribute('role', 'alert'); document.documentElement.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('on'); }, 4000);
  }

  /* framed in ramjet: every external destination goes through the proxy frame
     via the parent's rjBrowseGo bridge - never a direct navigation. hrefs come
     off so no click form (middle, modifier, context menu) can leave directly.
     if the parent does not ack, that is an error, not a silent raw open.
     standalone (opened outside ramjet) keeps normal links: the proxy bridge
     does not exist there and this says nothing about the browser overall. */
  /* every request carries a nonce; only its own ack/error clears it, so a stale
     or mismatched reply can never silence a newer pending request */
  var ackTimer = 0, reqSeq = 0, pendingNonce = '';
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || e.source !== window.parent) return;
    var d = e.data || {};
    if (pendingNonce === '' || d.rjBrowseNonce !== pendingNonce) return;
    if (d.rjBrowseAck === true) { clearTimeout(ackTimer); pendingNonce = ''; }
    else if (typeof d.rjBrowseErr === 'string') { clearTimeout(ackTimer); pendingNonce = ''; sxerr(String(d.rjBrowseErr).slice(0, 200)); }
  });
  function openProxied(url) {
    if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\//i.test(url)) { sxerr('that link could not be opened through ramjet.'); return; }
    reqSeq += 1; pendingNonce = 'sx' + reqSeq + '-' + Math.random().toString(36).slice(2, 10);
    clearTimeout(ackTimer);
    ackTimer = setTimeout(function () { pendingNonce = ''; sxerr('ramjet did not take that link - reload the app and try again.'); }, 3000);
    try { window.parent.postMessage({ rjBrowseGo: url, rjBrowseNonce: pendingNonce }, location.origin); }
    catch (x) { clearTimeout(ackTimer); pendingNonce = ''; sxerr('that link could not be opened through ramjet.'); }
  }
  function stripHref(a) {
    var h = a.getAttribute('href') || '';
    if (!/^https?:\/\//i.test(h)) return;
    try { if (new URL(h, location.href).origin === location.origin) return; } catch (x) {}
    a.setAttribute('data-rjurl', h);
    a.removeAttribute('href');
    a.removeAttribute('target');
    /* an href-less anchor is not focusable and Enter does nothing: restore
       keyboard operability explicitly, still with no direct navigation path */
    if (!a.hasAttribute('tabindex')) a.setAttribute('tabindex', '0');
    if (!a.hasAttribute('role')) a.setAttribute('role', 'link');
  }
  function keyExternal(e) {
    if (e.key !== 'Enter') return;
    var a = e.target && e.target.closest ? e.target.closest('a[data-rjurl]') : null; if (!a) return;
    e.preventDefault();
    openProxied(a.getAttribute('data-rjurl'));
  }
  function goExternal(e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null; if (!a) return;
    var u = a.getAttribute('data-rjurl'); if (!u) return;
    e.preventDefault(); e.stopPropagation();
    openProxied(u);
  }
  if (framed) {
    document.querySelectorAll('a[href]').forEach(stripHref);
    document.addEventListener('click', goExternal);
    document.addEventListener('auxclick', function (e) { if (e.button === 1) goExternal(e); });
    document.addEventListener('keydown', keyExternal);
  }

  /* pending navigation bar: appears when a same-origin searx navigation is
     actually requested. a successful load unloads this document and ends it;
     a bfcache restore or a bounded timeout ends it otherwise. no simulated
     progress, and focus/visibility never clear it early. */
  var nav = document.createElement('div'); nav.id = 'sxnav'; nav.setAttribute('aria-hidden', 'true'); document.documentElement.appendChild(nav);
  var navT = 0, navT2 = 0;
  function navStop() { nav.classList.remove('on'); nav.classList.remove('slow'); clearTimeout(navT); clearTimeout(navT2); }
  /* after 15s the bar stalls to a dim track: honest "still waiting", never a
     completed-looking bar; a final 30s later it clears without claiming an outcome */
  function navStart() {
    nav.classList.add('on'); nav.classList.remove('slow'); clearTimeout(navT); clearTimeout(navT2);
    navT = setTimeout(function () { nav.classList.add('slow'); navT2 = setTimeout(navStop, 30000); }, 15000);
  }
  window.addEventListener('pageshow', function (e) { if (e.persisted) navStop(); });
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null; if (!a) return;
    var h = a.getAttribute('href') || '';
    if (h.indexOf('/searx/') === 0 && a.getAttribute('target') !== '_blank') navStart();
  });

  if (!lite()) document.querySelectorAll('img[data-full]').forEach(function (im) { var f = im.getAttribute('data-full'); var t = new Image(); t.onload = function () { sxCancelRetry(im); im.removeAttribute('data-rjtry'); im.src = f; im.removeAttribute('data-alt'); }; t.referrerPolicy = 'no-referrer'; t.src = f; });

  /* image preview: click a tile in the images tab to open it big, with next/prev, swipe, and a link to the page it came from */
  (function () {
    var tiles = [].slice.call(document.querySelectorAll('li.tile > a'));
    if (!tiles.length) return;
    var I = function (d) { return '<svg viewBox="0 0 24 24"><path d="' + d + '"/></svg>'; };
    var lb = document.createElement('div'); lb.className = 'lb'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true');
    lb.innerHTML = '<div class="lb-top"><span class="lb-n"></span><span class="lb-t"></span><button class="lb-btn lb-x" type="button" aria-label="close">' + I('M6 6l12 12M18 6L6 18') + '</button></div>' +
      '<div class="lb-stage"><button class="lb-btn lb-nav lb-prev" type="button" aria-label="previous">' + I('M15 5l-7 7 7 7') + '</button><img class="lb-img" alt="" referrerpolicy="no-referrer"><button class="lb-btn lb-nav lb-next" type="button" aria-label="next">' + I('M9 5l7 7-7 7') + '</button></div>' +
      '<div class="lb-bot"><a class="lb-pill go lb-visit" href="#">visit page</a><a class="lb-pill lb-open" href="#" target="_blank" rel="noopener noreferrer">open image</a><button class="lb-pill lb-full" type="button" style="display:none">load full quality</button></div>';
    document.documentElement.appendChild(lb); /* not inside body: the body's entrance animation leaves a transform that would pin fixed children to the page instead of the screen */
    var q = function (c) { return lb.querySelector(c); };
    var img = q('.lb-img'), cur = -1, startX = 0, startY = 0;
    function info(i) { var a = tiles[i], im = a.querySelector('img'); return { thumb: im.getAttribute('src'), full: im.getAttribute('data-full') || im.getAttribute('data-alt') || im.getAttribute('src'), page: a.getAttribute('data-rjurl') || a.getAttribute('href'), title: a.getAttribute('title') || '' }; }
    function show(i, forceFull) {
      if (i < 0 || i >= tiles.length) return;
      cur = i; var d = info(i), small = lite() && !forceFull && d.full !== d.thumb;
      q('.lb-n').textContent = (i + 1) + ' / ' + tiles.length; q('.lb-t').textContent = d.title;
      var va = q('.lb-visit');
      if (framed) { va.setAttribute('data-rjurl', d.page); va.removeAttribute('href'); va.removeAttribute('target'); va.setAttribute('tabindex', '0'); va.setAttribute('role', 'link'); }
      else va.setAttribute('href', d.page);
      /* open image goes to the proxied URL on our own origin, never the raw remote */
      q('.lb-open').setAttribute('href', d.full);
      var fb = q('.lb-full'); fb.style.display = small ? '' : 'none';
      img.classList.add('ld'); img.src = d.thumb;
      if (!small && d.full !== d.thumb) { var t = new Image(), at = i; t.referrerPolicy = 'no-referrer'; t.onload = function () { if (cur === at) { img.src = d.full; img.classList.remove('ld'); } }; t.onerror = function () { if (cur === at) img.classList.remove('ld'); }; t.src = d.full; } else img.classList.remove('ld');
      img.onload = function () { if (small || d.full === d.thumb) img.classList.remove('ld'); };
      [i - 1, i + 1].forEach(function (n) { if (tiles[n]) { var p = new Image(); p.src = info(n).thumb; } });
    }
    var sy = 0;
    function lock() { sy = window.pageYOffset || 0; var b = document.body.style; b.position = 'fixed'; b.top = (-sy) + 'px'; b.left = '0'; b.right = '0'; b.width = '100%'; document.documentElement.style.overflow = 'hidden'; }
    function unlock() { var b = document.body.style; b.position = ''; b.top = ''; b.left = ''; b.right = ''; b.width = ''; document.documentElement.style.overflow = ''; window.scrollTo(0, sy); }
    var opener = null;
    function open(i) { opener = document.activeElement; lb.classList.add('on'); lock(); document.body.inert = true; show(i); q('.lb-x').focus(); } /* the page behind is inert: no tab stops, no screen-reader reach. focus moves into the dialog */
    function close() { if (cur < 0 && !lb.classList.contains('on')) return; lb.classList.remove('on'); document.body.inert = false; unlock(); cur = -1; img.removeAttribute('src'); if (opener && opener.focus) { try { opener.focus({ preventScroll: true }); } catch (x) {} } opener = null; }
    tiles.forEach(function (a, i) { a.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(i); }, true); });
    q('.lb-x').onclick = close; q('.lb-prev').onclick = function () { show(cur - 1); }; q('.lb-next').onclick = function () { show(cur + 1); };
    q('.lb-full').onclick = function () { show(cur, true); };
    q('.lb-stage').addEventListener('click', function (e) { if (e.target === q('.lb-stage')) close(); });
    document.addEventListener('keydown', function (e) { if (cur < 0) return; if (e.key === 'Tab') { var f = [].filter.call(lb.querySelectorAll('button,a[href],a[data-rjurl]'), function (n) { return n.getClientRects().length; }); if (!f.length) return; var a = document.activeElement, i0 = f.indexOf(a); if (i0 < 0 || (e.shiftKey && i0 === 0) || (!e.shiftKey && i0 === f.length - 1)) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0].focus(); } return; } if (e.key === 'Escape') close(); else if (e.key === 'ArrowLeft') show(cur - 1); else if (e.key === 'ArrowRight') show(cur + 1); });
    lb.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });
    lb.addEventListener('wheel', function (e) { e.preventDefault(); }, { passive: false });
    var st = q('.lb-stage');
    st.addEventListener('touchstart', function (e) { var t = e.touches[0]; startX = t.clientX; startY = t.clientY; }, { passive: true });
    st.addEventListener('touchend', function (e) { var t = e.changedTouches[0], dx = t.clientX - startX, dy = t.clientY - startY; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) show(cur + (dx < 0 ? 1 : -1)); else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.4) close(); }, { passive: true });
  })();

  (function () { var el = document.getElementById('sxlite'); if (!el || !lite()) return; var ds = ''; try { ds = localStorage.getItem('rj-datasaver') || ''; } catch (e) {} if (ds === 'on') return; el.innerHTML = '<br>smaller thumbnails to save data. for full quality on wifi: settings, data saver, off.'; })();

  var K = 'rj-browse-searches';
  function on() { try { return localStorage.getItem('rj-save-searches') === 'on'; } catch (e) { return false; } }
  function read() { if (!on()) return []; try { var a = JSON.parse(localStorage.getItem(K) || '[]'); return Array.isArray(a) ? a.slice(0, 12) : []; } catch (e) { return []; } }
  function add(q) { q = String(q || '').trim().slice(0, 120); if (!q || !on()) return; var n = [q].concat(read().filter(function (x) { return x.toLowerCase() !== q.toLowerCase(); })).slice(0, 12); try { localStorage.setItem(K, JSON.stringify(n)); } catch (e) {} }
  var f = document.querySelector('form.box'); var i = f && f.querySelector('input[name=q]');
  if (i && i.value) add(i.value);
  if (f) f.addEventListener('submit', function () { if (i) add(i.value); navStart(); });
  var dl = document.getElementById('sxdl'); var list = read();
  if (dl) dl.innerHTML = list.map(function (x) { return '<option value="' + x.replace(/"/g, '&quot;') + '">'; }).join('');
  var r = document.getElementById('sxrecent');
  if (r && list.length) {
    r.innerHTML = list.slice(0, 8).map(function (x) { return '<a href="/searx/search?q=' + encodeURIComponent(x) + '"></a>'; }).join('') + '<button type="button" id="sxclr">clear</button>';
    r.querySelectorAll('a').forEach(function (a, n) { a.textContent = list[n]; });
    var c = document.getElementById('sxclr'); if (c) c.onclick = function () { try { localStorage.removeItem(K); localStorage.setItem(K, '[]'); } catch (e) {} r.innerHTML = ''; };
  }

})();
