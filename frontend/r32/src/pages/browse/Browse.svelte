<script>
  import { readSearches, addSearch, clearSearches } from '../../lib/searchhist.js';
  import Recent from '../../lib/Recent.svelte';
  let qf = $state(false);
  import '../../tokens.css';
  import { onMount } from 'svelte';
  import { api } from '../../lib/api.js';
  import { isCloaked, setCloak } from '../../lib/cloak.js';

  let address = $state('');
  let boot = $state('');
  let ready = $state(true);
  let failed = $state('');
  let stageEl = $state(null);
  let ctrl = null;

  // tabs (Luke 1:34 PM "add tabs"): every tab is its own proxied iframe, kept
  // alive (hidden) while you are on another tab so pages keep their state.
  let tabs = $state([]);
  let activeId = $state(0);
  let nextId = 1;
  const live = new Map(); // id -> { el, frame }
  const active = $derived(tabs.find((t) => t.id === activeId));
  const surfing = $derived(!!active?.surfing);
  const cur = () => live.get(activeId);

  function syncDisplay() {
    for (const [k, v] of live) {
      const t = tabs.find((x) => x.id === k);
      v.el.style.display = k === activeId && t?.surfing ? 'block' : 'none';
    }
  }
  // per-site "allow ads" (Luke 9:17 AM): the block list stays on everywhere
  // else. the choice is per device, kept in localStorage rj-ads-allow.
  let menuOpen = $state(false);
  let tabsOpen = $state(false);
  $effect(() => { if (ready && !surfing && typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches) document.getElementById('br-omni')?.focus(); });
  let adAllow = $state((() => { try { const v = JSON.parse(localStorage.getItem('rj-ads-allow') || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 200) : []; } catch { return []; } })());
  function siteOf(t) {
    const p = hostOf(t).split('.').filter(Boolean);
    if (p.length <= 2) return p.join('.');
    const n = /^(co|com|org|net|gov|ac|edu)$/.test(p[p.length - 2]) && p[p.length - 1].length === 2 ? 3 : 2;
    return p.slice(-n).join('.');
  }
  const adSite = $derived(active && active.surfing ? siteOf(active) : '');
  const adOk = $derived(!!adSite && adAllow.includes(adSite));
  const adCanToggle = $derived(!!adSite && localStorage.getItem('rj-adblock') !== 'off' && (localStorage.getItem('rj-transport') || 'ws') === 'ws');
  function toggleAds() {
    if (!adSite) return;
    adAllow = adAllow.includes(adSite) ? adAllow.filter((x) => x !== adSite) : [...adAllow, adSite];
    try { localStorage.setItem('rj-ads-allow', JSON.stringify(adAllow)); } catch {}
    const v = cur(), t = active, seq = t ? t.navSeq : 0;
    setTimeout(() => {
      if (!v || !t || !tabs.includes(t) || t.navSeq !== seq) return;
      watchNav(v, t, Promise.resolve().then(() => v.frame.reload()));
    }, 60);
  }
  function hostOf(t) {
    try { return new URL(/^[a-z]+:\/\//i.test(t.address || '') ? t.address : 'https://' + t.address).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
  function favLetter(t) { const h = t.surfing ? hostOf(t) : ''; if (!h) return ''; const p = h.split('.'); return (p.length > 1 ? p[p.length - 2] : p[0])[0].toUpperCase(); }
  function titleFor(t) {
    if (t.title) return t.title;
    return t.surfing ? 'loading...' : 'new tab';
  }
  // address bar follows the page (Luke 7:39 AM): the proxied frame's document
  // url is the real address, so read it on load and while the page lives
  // (covers link clicks, redirects, pushState, back/forward).
  function syncAddr(id) {
    const v = live.get(id);
    const tb = tabs.find((x) => x.id === id);
    if (!v || !tb || !tb.surfing) return;
    let u = '';
    try { u = v.el.contentDocument?.URL || ''; } catch { return; }
    if (!/^https?:\/\//i.test(u)) return;
    try { if (new URL(u).origin === location.origin) return; } catch { return; }
    if (u === tb.url) return;
    tb.url = u; tb.address = u;
    if (id === activeId && document.activeElement?.id !== 'br-omni') address = u;
    try { if (tb.seen !== u) { tb.seen = u; noteVisit(u, v.el.contentDocument?.title || ''); } } catch {}
  }
  function newTab(addr) {
    if (!ctrl || !stageEl || tabs.length >= 12) return;
    const id = nextId++;
    const el = document.createElement('iframe');
    el.title = 'tab ' + id;
    el.className = 'tabframe';
    el.style.display = 'none';
    stageEl.appendChild(el);
    const fr = ctrl.createFrame(el);
    el.addEventListener('load', () => {
      try {
        syncAddr(id);
        if (loadT0 && id === activeId) { loadMs = Math.round(performance.now() - loadT0); loadT0 = 0; }
        const t = el.contentDocument?.title;
        const tb = tabs.find((x) => x.id === id);
        if (t && tb) tb.title = t.slice(0, 60);
        const u = tb?.url || '';
        if (tb && /^https?:\/\//i.test(u) && tb.seen !== u) { tb.seen = u; noteVisit(u, t || ''); }
        if (t && id === activeId && !cloaked) document.title = t;
      } catch {}
    });
    live.set(id, { el, frame: fr, poll: setInterval(() => syncAddr(id), 400) });
    tabs.push({ id, title: '', address: '', surfing: false, navSeq: 0, navError: '' });
    switchTab(id);
    if (addr) { address = addr; go(); }
  }
  function revealTab() {
    requestAnimationFrame(() => { const el = document.querySelector('.tab.cur'); if (el && el.scrollIntoView) el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' }); });
  }
  function switchTab(id) {
    activeId = id; revealTab();
    const t = tabs.find((x) => x.id === id);
    address = t ? t.address : '';
    syncDisplay();
    if (t && t.title && !cloaked) document.title = t.title;
  }
  function closeTab(id, e) {
    e?.stopPropagation();
    const i = tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const v = live.get(id);
    { const ct = tabs[i]; const cu = ct.url || ''; if (ct.surfing && !cloaked && /^https?:\/\//i.test(cu)) closed = [{ url: cu, title: ct.title || hostOf({ address: cu, surfing: true }) }, ...closed].slice(0, 10); }
    try { if (v?.poll) clearInterval(v.poll); } catch {}
    try { v?.el.remove(); } catch {}
    live.delete(id);
    tabs.splice(i, 1);
    if (!tabs.length) { newTab(); return; }
    if (id === activeId) switchTab(tabs[Math.min(i, tabs.length - 1)].id);
  }

  const quick = [
    { name: 'wikipedia', url: 'https://www.wikipedia.org' },
    { name: 'google', url: 'https://www.google.com' },
    { name: 'duckduckgo', url: 'https://duckduckgo.com' },
    { name: 'github', url: 'https://github.com' },
    { name: 'reddit', url: 'https://www.reddit.com' },
  ];

  function normalize(input) {
    const v = input.trim();
    if (!v) return null;
    const looksLikeUrl = /^[a-z]+:\/\//i.test(v) || (/^[^\s]+\.[^\s]{2,}/.test(v) && !v.includes(' '));
    if (looksLikeUrl) return /^[a-z]+:\/\//i.test(v) ? v : 'https://' + v;
    // self-hosted searxng, reverse-proxied same-origin at /searx/ (Luke 8:57
    // "i hate bing" + captcha-free): his own instance, aggregates brave/bing/
    // google-cse. same-origin keeps result clicks routable back into the proxy.
    return '/searx/search?q=' + encodeURIComponent(v);
  }


  // url encryption (Luke 9:52 AM): a proxied address must not be readable in
  // the url itself - a filter or a glance at the bar sees gibberish, not the
  // destination. scramjet serializes these with .toString() into the service
  // worker and proxied frames, so the session key is baked into the source
  // and everything they touch is defined inside - no closures.


  // tab cloak: one tap (or the ` key) and the tab reads as homework -
  // innocuous title + a docs-look icon, and proxied page titles stop
  // reaching the tab (and browser history) while it is on. the shared
  // lib owns applying and guarding it across every app.
  let cloaked = $state(isCloaked());
  function toggleCloak() {
    setCloak(!isCloaked());
    cloaked = isCloaked();
  }

  // cookie + localStorage cloud sync (Luke 11:26 AM): admin account only -
  // the server 403s everyone else, so this silently turns itself off for
  // other users. restores before the first navigation, pushes every 15s and
  // on tab close. last writer wins.
  function startSync(controller) {
    (async () => {
      let on = false;
      try {
        const r = await fetch('/api/apps/browse/sync');
        if (!r.ok) return; // 403: not the admin account - stay local-only
        const d = await r.json();
        if (d && d.sync) {
          if (typeof d.sync.cookies === 'string' && d.sync.cookies) {
            try { controller.cookieJar.load(d.sync.cookies); } catch {}
          }
          if (d.sync.storage && typeof d.sync.storage === 'object') {
            for (const [k, v] of Object.entries(d.sync.storage)) {
              try { localStorage.setItem(k, v); } catch {}
            }
          }
        }
        on = true;
      } catch { return; }
      if (!on) return;
      const push = async (beacon) => {
        try {
          const storage = {};
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.includes('@')) storage[k] = localStorage.getItem(k);
          }
          const body = JSON.stringify({ cookies: controller.cookieJar.dump(), storage });
          if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon('/api/apps/browse/sync', new Blob([body], { type: 'application/json' }));
          } else {
            await fetch('/api/apps/browse/sync', { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
          }
        } catch {}
      };
      setInterval(() => push(false), 15000);
      addEventListener('pagehide', () => push(true));
    })();
  }

  // transport: ws (default, box-side fetch over one multiplexed socket, with a box-side asset cache), epoxy (set rj-transport=epoxy) or libcurl (http/2 + connection reuse). pick with
  // localStorage rj-transport = 'curl' while it is being compared.
  // nothing engine-side loads until the first submit: no scripts, worker,
  // ticket fetch or socket at tab-open. startEngine() is the first-submit boot.
  let engineP = null;
  function startEngine() {
    if (engineP) return engineP;
    failed = '';
    engineP = runBoot().finally(() => { if (!ctrl) engineP = null; });
    return engineP;
  }
  async function runBoot() {
    let cancelled = false;
    let attempts = 0;
    const bootOnce = async () => {
      try {
        const { connect } = await import('./engine.js');
        const r = await connect({ setBoot: (s) => { boot = s; }, cancelled: () => cancelled, getAdOk: () => adOk });
        if (r.fail) { failed = r.fail; return; }
        if (!r.controller || cancelled) return;
        const controller = r.controller;
        ctrl = controller;
        startSync(controller);
        newTab();
        boot = '';
      } catch (e) {
        if (!cancelled && attempts < 2 && !(e && e.noRetry)) { // one automatic retry for retryable errors, then give up loudly
          attempts += 1;
          boot = 'retrying...';
          await new Promise((r) => setTimeout(r, 2500));
          if (!cancelled) return bootOnce();
        }
        failed = (e && e.message) ? e.message : 'browse could not start - reload to try again';
        boot = '';
      }
    };
    await bootOnce();
  }

  // recent sites: this device only (localStorage), host-level, never recorded
  // while the tab cloak is on, one tap to clear.
  let recents = $state([]);
  try { const a = JSON.parse(localStorage.getItem('rj-browse-recent') || '[]'); recents = (Array.isArray(a) ? a : []).filter((r) => r && typeof r.name === 'string' && typeof r.url === 'string').slice(0, 30); } catch {}
  function noteRecent(url) {
    if (cloaked || !/^https?:\/\//i.test(url)) return;
    try {
      const u = new URL(url);
      const name = u.hostname.replace(/^www\./, '');
      const prev = recents.find((r) => r.name === name);
      recents = [{ name, url: u.origin + '/', n: Math.min((prev?.n || 0) + 1, 9999) }, ...recents.filter((r) => r.name !== name)].slice(0, 30);
      localStorage.setItem('rj-browse-recent', JSON.stringify(recents));
    } catch {}
  }
  let allRecents = $state(false);
  // most visited: the same device-local list, ranked by opens instead of
  // recency, so the sites he keeps coming back to stay put instead of
  // scrolling off the recent row. needs three opens before a site earns a tile.
  const topVisited = $derived([...recents].filter((r) => (r.n || 1) >= 3).sort((a, b) => (b.n || 1) - (a.n || 1)).slice(0, 6));
  function dropRecent(n) { recents = recents.filter((r) => r.name !== n); try { localStorage.setItem('rj-browse-recent', JSON.stringify(recents)); } catch {} }
  function clearRecents() { recents = []; try { localStorage.removeItem('rj-browse-recent'); } catch {} }
  // history (this device only, never recorded while the cloak is on) and recently closed tabs
  const HKEY = 'rj-browse-history';
  let hist = $state([]);
  try { hist = JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch {}
  let closed = $state([]);
  let histOpen = $state(false), histQ = $state('');
  // downloads: the service worker streams the file to the browser's own download manager and reports progress here
  let dlOpen = $state(false);
  let dls = $state([]);
  const dlActive = $derived(dls.filter((d) => d.state === 'active').length);
  function fmtSize(n) { if (!n) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i]; }
  function onDl(m) {
    if (!m || !m.id) return;
    const i = dls.findIndex((d) => d.id === m.id);
    if (i < 0) { dls = [{ id: m.id, name: m.name || 'download', size: m.size || 0, got: m.got || 0, state: m.state || 'active', ts: m.ts || Date.now() }, ...dls].slice(0, 30); dlOpen = true; const at = tabs.find((x) => x.id === activeId); if (at && at.surfing && !at.title) at.title = m.name || 'download'; }
    else { const d = dls[i]; d.got = m.got ?? d.got; d.state = m.state || d.state; if (m.state === 'done' && !d.size) d.size = d.got; }
  }
  // the worker's scope is /a/, so this page is never controlled: post through the registration instead.
  function swPost(m) { try { navigator.serviceWorker.getRegistration('/a/').then((r) => r && r.active && r.active.postMessage(m)).catch(() => {}); } catch {} }
  function dlCancel(id) { swPost({ rjdlCancel: id }); }
  // server staging: the worker copies the proxied file to the server while the browser saves nothing. it talks to this page only over the port
  // it got with the ping (no broadcast). rows here are progress only; the staged copy then shows in the server list below.
  function onStage(m) {
    if (!m || typeof m.id !== 'string' || !m.id) return;
    const i = dls.findIndex((d) => d.id === m.id);
    if (m.state === 'start') { if (i < 0) { dls = [{ id: m.id, name: m.name || 'download', size: m.total || 0, got: 0, state: 'active', auto: true, ts: Date.now() }, ...dls].slice(0, 30); dlOpen = true; } return; }
    if (m.state === 'staged') { dls = dls.filter((d) => d.id !== m.id); fxPoll(); return; }
    if (i < 0) return;
    const d = dls[i];
    if (m.state === 'staging') { d.got = m.got ?? d.got; if (m.total) d.size = m.total; }
    else if (m.state === 'cancelled') { d.state = 'cancelled'; fxPoll(); }
    else if (m.state === 'failed') { d.state = 'error'; d.note = 'not saved - ' + (m.msg || 'the server could not take it') + '. the file was not downloaded'; fxPoll(); }
  }
  function dlClear() { dls = dls.filter((d) => d.state === 'active'); }
  // DownloadInbox: server-held fetches (manual URL). Contract: cookie auth, POST needs X-Ramjet-JS:1, copy kept 5 min after the fetch finishes.
  let fx = $state([]), fxSeen = 0, fxNow = $state(Date.now()), fxUrl = $state(''), fxMsg = $state(''), fxAsked = $state({}), fxSending = $state(false);
  let fxExpPoll = 0;
  const fxUrls = new Map(); // id -> url, memory only, for retry
  const FX_ERR = { 400: 'that is not a valid link', 413: 'download limit reached', 429: 'one fetch at a time - wait for the current one', 503: 'server is busy, try again soon' };
  function fxPost(p, body) { return fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Ramjet-JS': '1' }, credentials: 'same-origin', body: JSON.stringify(body) }); }
  async function fxPoll() { const t0 = Date.now(); try { const r = await fetch('/api/apps/downloads/list', { credentials: 'same-origin' }); const j = await r.json(); if (j && j.ok) { fxSeen = t0; fxNow = Date.now(); fx = j.items || []; return true; } } catch {} return false; }
  async function fxStart(url) {
    try { const r = await fxPost('/api/apps/downloads/enqueue', { url }); let j = null; try { j = await r.json(); } catch {}
      if (r.ok && j && j.ok && typeof j.id === 'string' && j.id) { fxUrls.set(j.id, url); fxMsg = ''; return true; }
      if (r.ok) { fxMsg = 'unexpected reply from the server'; return false; }
      fxMsg = FX_ERR[r.status] || ('could not start (' + r.status + ')'); } catch { fxMsg = 'no connection - check your wifi'; }
    return false;
  }
  async function fxAdd(e) { e.preventDefault(); const u = fxUrl.trim(); if (!u || fxSending) return; fxSending = true; if (await fxStart(u)) fxUrl = ''; fxSending = false; fxPoll(); }
  async function fxCancel(id) { try { await fxPost('/api/apps/downloads/cancel', { id }); } catch {} fxUrls.delete(id); fxPoll(); }
  async function fxRetry(id) { const u = fxUrls.get(id); if (!u) return; try { await fxPost('/api/apps/downloads/cancel', { id }); } catch {} if (await fxStart(u)) fxUrls.delete(id); else if (!fxUrl) fxUrl = u; fxPoll(); }
  const fxSaving = {};   // revalidation makes fxSave async across one RTT; no double navigation
  async function fxSave(id) {
    const it = fx.find((x) => x.id === id);
    if (!it || fxLeft(it) <= 0 || fxSaving[id]) return;
    fxSaving[id] = true;
    try {
      // the server, not the local countdown, decides whether the copy still exists:
      // re-check right before navigating, so an expired copy's 404 JSON is never saved as a file
      if (!(await fxPoll())) { fxMsg = 'no connection - check your wifi'; return; }
      const cur = fx.find((x) => x.id === id);
      if (!cur || cur.state !== 'ready' || cur.expires_in_ms - (Date.now() - fxSeen) <= 2000) return;
      fxAsked[id] = true;
      const a = document.createElement('a'); a.href = '/api/apps/downloads/file?id=' + encodeURIComponent(id); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
    } finally { fxSaving[id] = false; }
  }
  function fxLeft(d) { return Math.max(0, d.expires_in_ms - (fxNow - fxSeen)); }
  function fxClock(ms) { const t = Math.ceil(ms / 1000); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }
  $effect(() => { if (!dlOpen) return; fxNow = Date.now(); fxPoll(); const p = setInterval(fxPoll, 1500), t = setInterval(() => { fxNow = Date.now(); if (fx.some((d) => d.state === 'ready' && fxLeft(d) <= 0) && fxNow - fxExpPoll > 3000) { fxExpPoll = fxNow; fxPoll(); } }, 1000); return () => { clearInterval(p); clearInterval(t); }; });   // fxNow fresh at open: pairs with the first poll's fresh fxSeen (no stale-clock inflation)
  function noteVisit(url, title) {
    if (cloaked) return;
    try {
      const u = new URL(url);
      if (u.origin === location.origin) return;
      if (hist[0] && hist[0].url === url) { if (title && !hist[0].title) hist[0].title = title; return; }
      hist = [{ url, title: (title || '').slice(0, 120), ts: Date.now() }, ...hist].slice(0, 300);
      localStorage.setItem(HKEY, JSON.stringify(hist));
    } catch {}
  }
  function clearHist() { hist = []; closed = []; try { localStorage.removeItem(HKEY); } catch {} }
  function dropVisit(h) { hist = hist.filter((x) => x !== h); try { localStorage.setItem(HKEY, JSON.stringify(hist)); } catch {} }
  function reopenClosed(i = 0) {
    const c = closed[i]; if (!c) return;
    closed = closed.filter((_, k) => k !== i);
    histOpen = false;
    newTab(c.url);
  }
  function openVisit(h) { histOpen = false; address = h.url; go(); }
  const histShown = $derived.by(() => {
    const q = histQ.trim().toLowerCase();
    const list = q ? hist.filter((h) => (h.title + ' ' + h.url).toLowerCase().includes(q)) : hist;
    const out = []; let day = '';
    for (const h of list.slice(0, 150)) {
      const d = new Date(h.ts).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      if (d !== day) { out.push({ head: d }); day = d; }
      out.push({ h });
    }
    return out;
  });
  const hostShort = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  import { techOn } from '../../lib/tech.js';
  let loadMs = $state(0), loadT0 = 0;
  let findOpen = $state(false);
  let findQ = $state('');
  let findMiss = $state(false);
  let findEl = $state(null);
  function toggleFind() {
    findOpen = !findOpen; findMiss = false;
    if (findOpen) setTimeout(() => findEl?.focus(), 30);
    else { try { cur()?.el.contentWindow.getSelection()?.removeAllRanges(); } catch {} }
  }
  function findNext(back = false) {
    const w = cur()?.el.contentWindow;
    if (!w || !findQ) return;
    try { findMiss = !w.find(findQ, false, back, true, false, false, false); } catch { findMiss = true; }
  }

  function ytId(a) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(a || '') ? a : 'https://' + a);
      const h = u.hostname.replace(/^(www|m|music)\./, '');
      let id = '';
      if (h === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
      else if (h === 'youtube.com') id = u.pathname === '/watch' ? (u.searchParams.get('v') || '') : (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1] || '';
      return /^[\w-]{11}$/.test(id) ? id : '';
    } catch { return ''; }
  }
  const ytCur = $derived(surfing ? ytId(active?.address || address) : '');
  function openJetstream() { if (ytCur) window.open('/jetstream?v=' + ytCur, '_blank', 'noopener'); }

  // every new nav intent - typed, searched, reader, quick-chip - invalidates
  // any nav still in flight and clears a prior failure BEFORE we decide
  // whether this one goes through the proxy or straight into the iframe.
  // without it a late proxy rejection can land on the new page, and a stale
  // error panel can sit over a fresh direct load forever.
  function navIntent(t) { t.navSeq = (t.navSeq || 0) + 1; t.navError = ''; }

  // a proxied nav can reject (transport drop, sidecar error) - land it as an
  // honest per-tab error with a manual retry instead of a tab stuck "loading"
  // forever. a late failure never overwrites a newer nav or a closed tab.
  async function watchNav(v, t, p) {
    navIntent(t);
    const seq = t.navSeq;
    try {
      await p;
    } catch (err) {
      if (t.navSeq !== seq || !tabs.includes(t)) return;
      t.surfing = false;
      t.title = '';
      t.navError = (err && err.message) || 'page failed to load';
      syncDisplay();
    }
  }
  function goFrame(v, t, url) {
    watchNav(v, t, Promise.resolve().then(() => v.frame.go(url)));
  }
  // reload is a re-navigation of the same page, so it gets the same honest
  // failure state; back/forward never change our tab state, so a rejected hop
  // just stays put - small toast, no error page over a page still there.
  function navReload() {
    const v = cur(), t = active;
    if (v && t) watchNav(v, t, Promise.resolve().then(() => v.frame.reload()));
  }
  function navBack() { const v = cur(); if (v) try { Promise.resolve(v.frame.back()).catch(() => bmNote("couldn't go back")); } catch { bmNote("couldn't go back"); } }
  function navForward() { const v = cur(); if (v) try { Promise.resolve(v.frame.forward()).catch(() => bmNote("couldn't go forward")); } catch { bmNote("couldn't go forward"); } }
  function retryNav() {
    const t = active;
    if (!t || !t.navError) return;
    address = t.address;
    go();
  }

  function openReader() {
    const v = cur(), t = active;
    if (!v || !t) return;
    const u = normalize(t.address || '');
    if (!u || u.startsWith('/')) return;
    navIntent(t);
    t.title = 'reader';
    v.el.src = '/searx/reader?u=' + encodeURIComponent(u);
  }

  let recentQ = $state(readSearches('rj-browse-searches'));
  async function go(e) {
    e?.preventDefault();
    const url = normalize(address);
    if (!url) return;
    if (!ctrl) {
      const typed = address;
      boot = 'warming up...';
      await startEngine();
      if (!ctrl) return;
      address = typed;
    }
    if (/\s/.test(address.trim()) || !address.includes('.')) recentQ = addSearch('rj-browse-searches', address);
    noteRecent(url);
    swPost({ rjdlHint: url });
    const v = cur();
    const t = active;
    if (!v || !t) return;
    t.surfing = true; t.url = url; loadT0 = performance.now(); loadMs = 0;
    t.address = address;
    t.title = '';
    try { document.getElementById('br-omni')?.blur(); } catch {}
    syncDisplay();
    navIntent(t);
    if (url.startsWith('/searx/')) { v.el.src = url; return; }
    goFrame(v, t, url);
  }

  function open(link) {
    address = link.url;
    go();
  }

  // bookmarks follow the account - star the page you are on
  let bookmarks = $state([]);
  let bmMsg = $state('');
  let bmT = null;

  onMount(async () => {
    cloaked = isCloaked();
    try { const h = sessionStorage.getItem('rj-open'); if (h) { sessionStorage.removeItem('rj-open'); address = h; go(); } } catch {}
    window.addEventListener('keydown', (e) => {
      if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) toggleCloak();
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyF') { e.preventDefault(); toggleFind(); }
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT') { e.preventDefault(); reopenClosed(); return; }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyY') { e.preventDefault(); histOpen = !histOpen; }
      if (e.key === 'Escape' && histOpen) histOpen = false;
      if (e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT') { e.preventDefault(); newTab(); }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyW') { e.preventDefault(); closeTab(activeId); }
      // alt+L jumps to the address bar, alt+1..9 switch tabs
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyL') { e.preventDefault(); const a = document.querySelector('.bar input, input[placeholder*=address]'); if (a) { a.focus(); a.select(); } }
      if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) { const t = tabs[+e.code.slice(5) - 1]; if (t) { e.preventDefault(); switchTab(t.id); } }
    });
    // the /searx/ results page is same-origin, so its external links message
    // up here instead of navigating - send them through the proxy frame.
    try { navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.rjdlPing && e.ports && e.ports[0]) { const pt = e.ports[0]; if (ctrl && typeof e.data.prefix === 'string' && ctrl.prefix === e.data.prefix) { pt.onmessage = (ev) => onStage(ev.data); pt.postMessage({ cap: 2 }); } return; } onDl(e.data && e.data.rjdl); }); } catch {}
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin) return;
      const u = e.data && e.data.rjBrowseGo;
      if (typeof u === 'string' && /^https?:\/\//i.test(u)) {
        // route the click back to the tab whose page sent it
        let id = activeId;
        for (const [k, v] of live) if (v.el.contentWindow === e.source) id = k;
        const v = live.get(id);
        const t = tabs.find((x) => x.id === id);
        if (!v || !t) return;
        t.surfing = true; t.address = u; t.title = '';
        if (id === activeId) address = u;
        syncDisplay();
        goFrame(v, t, u);
      }
    });
    const r = await api('/api/apps/browse/bookmarks');
    if (r.ok) bookmarks = r.data.bookmarks || [];
  });

  function bmNote(msg) {
    bmMsg = msg;
    clearTimeout(bmT);
    bmT = setTimeout(() => { bmMsg = ''; }, 2500);
  }

  async function star() {
    const url = normalize(address);
    if (!url) return;
    let name = '';
    try { name = (cur()?.el.contentDocument?.title || '').trim(); } catch {}
    const r = await api('/api/apps/browse/bookmarks', { method: 'POST', body: { url, name } });
    if (!r.ok) { bmNote(r.data?.error || 'could not save it'); return; }
    bmNote(r.data.already ? 'already in your bookmarks' : 'bookmarked');
    const lr = await api('/api/apps/browse/bookmarks');
    if (lr.ok) bookmarks = lr.data.bookmarks || [];
  }

  async function unstar(b) {
    const r = await api('/api/apps/browse/bookmarks/delete', { method: 'POST', body: { id: b.id } });
    if (!r.ok) { bmNote(r.data?.error || 'could not remove it'); return; }
    bookmarks = bookmarks.filter((x) => x.id !== b.id);
  }

</script>

<div class="shell" class:surfing class:hasmtb={tabs.length > 0}>
  <div class="chrome">
  <header>
    <a class="back" href="/" title="back" aria-label="back"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></a>
    <div class="navbtns dnav">
      <button onclick={navBack} title="back" aria-label="back"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg></button>
      <button onclick={navForward} title="forward" aria-label="forward"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-6-6m6 6-6 6" /></svg></button>
      <button onclick={navReload} title="reload" aria-label="reload"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg></button>
    </div>
    <form class="omni" onsubmit={go}>
      <input id="br-omni" bind:value={address} onfocus={() => (qf = true)} onblur={() => setTimeout(() => (qf = false), 150)} placeholder="search or type a site" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="search or type an address" />
      <Recent items={recentQ} query={address} focused={qf && !surfing || qf && address === ""} onpick={(r) => { address = r; qf = false; go({ preventDefault() {} }); }} onclear={() => (recentQ = clearSearches('rj-browse-searches'))} />
      <button class="go" type="submit" disabled={!ready}>go</button>
    </form>
    <button class="menub" class:on={menuOpen || dlActive} onclick={() => (menuOpen = !menuOpen)} aria-label="more" aria-expanded={menuOpen} title="more"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>{#if dlActive}<i class="dlbadge">{dlActive}</i>{/if}</button>
    {#if menuOpen}
      <button class="menuscrim" aria-label="close menu" onclick={() => (menuOpen = false)}></button>
      <div class="menu" role="menu">
        <div class="mnav">
          <button onclick={navBack} aria-label="back"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg></button>
          <button onclick={navForward} aria-label="forward"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-6-6m6 6-6 6" /></svg></button>
          <button onclick={navReload} aria-label="reload"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg></button>
        </div>
        <button class="mi" onclick={() => { menuOpen = false; dlOpen = true; }}><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg><span>downloads</span>{#if dlActive}<i class="mcount">{dlActive}</i>{/if}</button>
        <button class="mi" onclick={() => { menuOpen = false; histOpen = true; histQ = ''; }}><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" /></svg><span>history</span></button>
        {#if surfing}
          <button class="mi" onclick={() => { menuOpen = false; toggleFind(); }}><svg viewBox="0 0 24 24"><path d="M10.5 4a6.5 6.5 0 1 0 4 11.6l4.6 4.6 1.4-1.4-4.6-4.6A6.5 6.5 0 0 0 10.5 4z" /></svg><span>find in page</span></button>
          <button class="mi" onclick={() => { menuOpen = false; openReader(); }}><svg viewBox="0 0 24 24"><path d="M4 5h16M4 10h16M4 15h10M4 20h7" /></svg><span>reader mode</span></button>
          <button class="mi" onclick={() => { menuOpen = false; star(); }}><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8z" /></svg><span>bookmark this page</span></button>
          {#if adCanToggle}<button class="mi" class:on={adOk} onclick={() => { menuOpen = false; toggleAds(); }}><svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />{#if adOk}<path d="M9 12l2 2 4-4" />{:else}<path d="M9 9l6 6M15 9l-6 6" />{/if}</svg><span>ads on this site</span><i class="mstate">{adOk ? 'allowed' : 'blocked'}</i></button>{/if}
          {#if ytCur}<button class="mi" onclick={() => { menuOpen = false; openJetstream(); }}><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg><span>open in jetstream</span></button>{/if}
        {/if}
        <button data-testid="menu-cloak" class="mi" class:on={cloaked} onclick={() => { menuOpen = false; toggleCloak(); }}><svg viewBox="0 0 24 24"><path d="M12 4c-5 0-9 4-10 9 1-5 5-8 10-8s9 3 10 8c-1-5-5-9-10-9zm0 5a4 4 0 1 0 4 4 4 4 0 0 0-4-4zm0 2a2 2 0 1 1-2 2 2 2 0 0 1 2-2z" /></svg><span>{cloaked ? 'back to normal' : 'look like docs'}</span></button>
      </div>
    {/if}
  </header>

  {#if tabs.length}
    <div class="tabbar" role="tablist">
      {#each tabs as t (t.id)}
        <div class="tab" class:cur={t.id === activeId} class:load={t.surfing && !t.title} role="tab" tabindex="0" aria-selected={t.id === activeId}
          onclick={() => switchTab(t.id)} onkeydown={(e) => e.key === 'Enter' && switchTab(t.id)}>
          <span class="tabfav" class:blank={!favLetter(t)}>{favLetter(t)}</span>
          <span class="tt">{titleFor(t)}</span>
          <button class="tx" onclick={(e) => closeTab(t.id, e)} aria-label="close tab"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" /></svg></button>
        </div>
      {/each}
      <button class="tplus" onclick={() => newTab()} aria-label="new tab" title="new tab (alt+t)" disabled={tabs.length >= 12}><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></button>
    </div>
  {/if}
  </div>

  {#if failed}
    <div class="center"><p class="dim">{failed}</p></div>
  {:else if active?.navError}
    <div class="center naverr">
      <p class="dim">{active.navError}</p>
      <p class="dim naverr-url">{active.address}</p>
      <button class="rtry" data-testid="nav-retry" onclick={retryNav}>try again</button>
    </div>
  {:else if !surfing}
    <div class="center home">
      <h1>browse</h1>
      <p class="dim">{boot || 'the open web'}</p>
      <div class="chips">
        {#each quick as s}
          <button class="chip" onclick={() => open(s)} disabled={!ready}>{s.name}</button>
        {/each}
      </div>
      {#if topVisited.length}
        <div class="recents">
          <p class="bm-h">most visited</p>
          <div class="chips">
            {#each topVisited as r (r.name)}<button class="chip" onclick={() => open(r)} disabled={!ready}>{r.name}</button>{/each}
          </div>
        </div>
      {/if}
      {#if recents.length}
        <div class="recents">
          <p class="bm-h">recent <button class="rc-clear" onclick={clearRecents}>clear</button></p>
          <div class="chips">
            {#each (allRecents ? recents : recents.slice(0, 6)) as r (r.name)}<button class="chip" onclick={() => open(r)} disabled={!ready}>{r.name}</button>{#if allRecents}<button class="chip rc-x" onclick={() => dropRecent(r.name)} aria-label={'remove ' + r.name}>&times;</button>{/if}{/each}
            {#if recents.length > 6}<button class="chip" onclick={() => (allRecents = !allRecents)}>{allRecents ? 'less' : 'all ' + recents.length}</button>{/if}
          </div>
        </div>
      {/if}
      {#if bookmarks.length}
        <div class="bms">
          <p class="bm-h">your bookmarks</p>
          {#each bookmarks as b (b.id)}
            <div class="bm-row">
              <button class="bm-open" onclick={() => open(b)} disabled={!ready}>{b.name}</button>
              <button class="bm-x" onclick={() => unstar(b)} aria-label="remove bookmark">x</button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
  {#if bmMsg}<div class="bm-toast">{bmMsg}</div>{/if}

  {#if dlOpen}
    <div class="hov" role="presentation" onclick={() => (dlOpen = false)}>
      <div class="hsheet" role="dialog" aria-label="downloads" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <div class="hhead"><b>downloads</b><button class="hclose" onclick={() => (dlOpen = false)} aria-label="close">&times;</button></div>
        <form class="fxadd" onsubmit={fxAdd}>
          <input type="url" inputmode="url" placeholder="paste a file link to fetch" aria-label="file link" bind:value={fxUrl} required />
          <button class="fxb fxpri" disabled={fxSending}>fetch</button>
        </form>
        {#if fxMsg}<p class="fxerr">{fxMsg}</p>{/if}
        {#each fx.filter((x) => !dls.some((a) => a.auto && a.state === 'active' && a.id === x.id)) as d (d.id)}
          <div class="dlrow">
            <div class="dltop"><span class="ht">{d.name || 'download'}</span>
              <span class="fxbt">
                {#if d.state === 'fetching'}<button class="dlx" onclick={() => fxCancel(d.id)}>cancel</button>
                {:else if d.state === 'ready' && fxLeft(d) <= 0}<button class="dlx" onclick={() => fxCancel(d.id)}>dismiss</button>
                {:else if d.state === 'ready'}<button class="fxb fxpri" onclick={() => fxSave(d.id)}>{fxAsked[d.id] ? 'save again' : 'save to device'}</button>
                {:else}{#if fxUrls.has(d.id)}<button class="dlx" onclick={() => fxRetry(d.id)}>retry</button>{/if}<button class="dlx" onclick={() => fxCancel(d.id)}>dismiss</button>{/if}
              </span></div>
            <div class="dlbar" class:bad={d.state === 'failed'}><i class:ind={d.state === 'fetching'} style={d.state === 'fetching' ? 'width:35%' : 'width:100%'}></i></div>
            <span class="hu">{#if d.state === 'fetching'}fetching - the server is downloading it{:else if d.state === 'ready' && fxLeft(d) <= 0}{fmtSize(d.size) || '0 B'} - expired{:else if d.state === 'ready'}{fmtSize(d.size) || '0 B'} - {fxAsked[d.id] ? 'download requested. ' : 'ready. '}deleted from the server in <b class="fxcd" class:urg={fxLeft(d) < 60000}>{fxClock(fxLeft(d))}</b>{:else}failed{/if}</span>
          </div>
        {/each}
        <div class="hlist">
          {#each dls as d (d.id)}
            <div class="dlrow">
              <div class="dltop"><span class="ht">{d.name}</span>
                {#if d.state === 'active'}<button class="dlx" onclick={() => dlCancel(d.id)}>cancel</button>{/if}</div>
              <div class="dlbar" class:done={d.state === 'done'} class:bad={d.state === 'error' || d.state === 'cancelled'}><i style={'width:' + (d.state === 'done' ? 100 : d.size ? Math.min(100, d.got / d.size * 100) : 40) + '%'} class:ind={d.state === 'active' && !d.size}></i></div>
              <span class="hu">{d.state === 'active' ? (fmtSize(d.got) + (d.size ? ' of ' + fmtSize(d.size) : '') + (d.auto ? ' - saving to the server' : ' - saving')) : d.state === 'done' ? (fmtSize(d.got) + ' - saved by your browser, check its downloads list') : d.state === 'cancelled' ? 'cancelled' : (d.note || 'failed - try again')}</span>
            </div>
          {:else}
            {#if !fx.length}<p class="hint">nothing downloaded yet. when a site sends a file, it is copied to the server and held here for 5 minutes - save it to your device before then. if the server can't take it, your browser saves it directly. you can also paste a link above (links that need you to be logged in to a site can't be fetched that way).</p>{/if}
          {/each}
        </div>
        {#if dls.some((d) => d.state !== 'active')}<button class="hclear" onclick={dlClear}>clear list</button>{/if}
      </div>
    </div>
  {/if}

  {#if histOpen}
    <div class="hov" role="presentation" onclick={() => (histOpen = false)}>
      <div class="hsheet" role="dialog" aria-label="history" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <div class="hhead"><b>history</b><button class="hclose" onclick={() => (histOpen = false)} aria-label="close">&times;</button></div>
        {#if closed.length}
          <p class="hsec">recently closed</p>
          {#each closed as c, i}
            <button class="hrow" onclick={() => reopenClosed(i)}><span class="ht">{c.title || hostShort(c.url)}</span><span class="hu">{hostShort(c.url)}</span></button>
          {/each}
        {/if}
        <input class="hq" placeholder="search your history" bind:value={histQ} />
        <div class="hlist">
          {#each histShown as r}
            {#if r.head}<p class="hsec">{r.head}</p>
            {:else}<div class="hrow2"><button class="hrow" onclick={() => openVisit(r.h)}><span class="ht">{r.h.title || hostShort(r.h.url)}</span><span class="hu">{hostShort(r.h.url)}</span></button><button class="hx" onclick={() => dropVisit(r.h)} aria-label="remove from history">&times;</button></div>{/if}
          {:else}
            <p class="hint">{hist.length ? 'nothing matches' : 'nothing here yet. pages you visit show up here, on this device only, and not while disguised'}</p>
          {/each}
        </div>
        {#if hist.length}<button class="hclear" onclick={clearHist}>clear history</button>{/if}
      </div>
    </div>
  {/if}

  {#if tabsOpen}
    <div class="hov" role="presentation" onclick={() => (tabsOpen = false)}>
      <div class="hsheet tsheet" role="dialog" aria-label="tabs" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <div class="hhead"><b>tabs</b><button class="hclose" onclick={() => (tabsOpen = false)} aria-label="close">&times;</button></div>
        <div class="hlist">
          {#each tabs as t (t.id)}
            <div class="hrow2">
              <button class="hrow trow" class:cur={t.id === activeId} onclick={() => { switchTab(t.id); tabsOpen = false; }}>
                <span class="tabfav" class:blank={!favLetter(t)}>{favLetter(t)}</span>
                <span class="tcol"><span class="ht">{titleFor(t)}</span><span class="hu">{t.surfing ? (hostOf(t) || t.address) : 'new tab'}</span></span>
              </button>
              <button class="hx" onclick={(e) => { closeTab(t.id, e); if (!tabs.length) tabsOpen = false; }} aria-label="close tab">&times;</button>
            </div>
          {/each}
        </div>
        <button class="tnew" onclick={() => { newTab(); tabsOpen = false; }} disabled={tabs.length >= 12}>{tabs.length >= 12 ? 'tab limit reached' : 'new tab'}</button>
      </div>
    </div>
  {/if}

  {#if findOpen && surfing}
    <div class="findbar" class:miss={findMiss}>
      <input bind:this={findEl} bind:value={findQ} placeholder="find in page" aria-label="find in page" autocomplete="off" autocapitalize="off" spellcheck="false"
        oninput={() => { findMiss = false; findNext(); }}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); findNext(e.shiftKey); } else if (e.key === 'Escape') toggleFind(); }} />
      <button onclick={() => findNext(true)} aria-label="previous match">&uarr;</button>
      <button onclick={() => findNext(false)} aria-label="next match">&darr;</button>
      <button onclick={toggleFind} aria-label="close find">x</button>
    </div>
  {/if}
  <div class="stage" class:off={!surfing} bind:this={stageEl}></div>
  {#if surfing && loadMs && techOn()}<span class="techchip">loaded in {(loadMs / 1000).toFixed(1)} s</span>{/if}
  {#if tabs.length}
    <div class="mtoolbar">
      <button data-testid="mnav-back" onclick={navBack} aria-label="back" title="back"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg></button>
      <button data-testid="mnav-forward" onclick={navForward} aria-label="forward" title="forward"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-6-6m6 6-6 6" /></svg></button>
      <button data-testid="mnav-reload" onclick={navReload} aria-label="reload" title="reload"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg></button>
      <button data-testid="mnav-tabs" class:on={tabsOpen} onclick={() => (tabsOpen = !tabsOpen)} aria-label="tabs" aria-expanded={tabsOpen} title="tabs"><span class="mtb-n">{tabs.length}</span></button>
      <button data-testid="mnav-menu" class:on={menuOpen || dlActive} onclick={() => (menuOpen = !menuOpen)} aria-label="more" aria-expanded={menuOpen} title="more"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>{#if dlActive}<i class="dlbadge">{dlActive}</i>{/if}</button>
    </div>
  {/if}
</div>

<style>
  .jsb { color: var(--rj-accent); }
  .adb.on { color: var(--rj-accent); }
  .findbar { position: fixed; z-index: 30; right: 12px; top: 108px; display: flex; gap: 4px; align-items: center; padding: 6px; background: var(--rj-surface-2); border: 1px solid var(--rj-border); border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.5); max-width: calc(100vw - 24px); }
  .findbar input { width: 190px; min-width: 0; font-size: 16px; background: transparent; border: 0; outline: 0; color: var(--rj-text); padding: 6px 8px; }
  @media (max-width: 640px) { .findbar { top: 146px; } }
  .findbar.miss input { color: var(--rj-danger); text-decoration: underline; text-decoration-style: wavy; text-underline-offset: 2px; }
  .findbar button { background: transparent; border: 0; color: var(--rj-text-dim); font-size: 16px; padding: 6px 9px; border-radius: 8px; cursor: pointer; }
  .findbar button:hover { background: var(--rj-hover); color: var(--rj-text); }
  .shell { display: flex; flex-direction: column; min-height: 100dvh; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; max-width: 100vw; }
  .back { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; flex: none; }
  .back:hover { background: var(--rj-surface); }
  .back svg { width: 18px; height: 18px; fill: none; stroke: var(--rj-text-dim); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .brand { font-weight: 700; font-size: 17px; letter-spacing: 0.2px; }
  .navbtns { display: flex; gap: 4px; margin-left: 6px; }
  .navbtns button {
    background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text);
    width: 32px; height: 32px; border-radius: var(--rj-pill); font-size: 14px; line-height: 1;
  }
  .navbtns button:hover { background: var(--rj-surface-2); }
  .navbtns button { display: grid; place-items: center; }
  .navbtns button.on { background: var(--rj-accent); color: var(--rj-accent-ink); border-color: var(--rj-accent); }
  .navbtns svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  form { flex: 1; display: flex; gap: 8px; min-width: 0; }
  input {
    flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text);
    border-radius: var(--rj-pill); padding: 9px 16px; font-size: 14px; outline: none;
  }
  input:focus { border-color: var(--rj-hairline-strong); }
  .go {
    background: var(--rj-accent); color: var(--rj-accent-ink); border: 0;
    border-radius: var(--rj-pill); padding: 0 20px; font-weight: 700; font-size: 14px;
  }
  .go:disabled { opacity: 0.4; cursor: default; }
  .center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; }
  .home h1 { margin: 0; font-size: 44px; letter-spacing: -1px; }
  .dim { color: var(--rj-text-dim); margin: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 8px; }
  .chip {
    background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text);
    border-radius: var(--rj-pill); padding: 8px 16px; font-size: 14px;
  }
  .chip:hover { background: var(--rj-surface-2); }
  .chip:disabled { opacity: 0.4; }
  .bms { margin-top: 22px; width: 100%; max-width: 420px; display: flex; flex-direction: column; gap: 6px; }
  .recents { margin-top: 18px; width: 100%; max-width: 420px; }
  .dlb { position: relative; }
  .dlbadge { position: absolute; top: -3px; right: -3px; min-width: 16px; height: 16px; border-radius: 8px; background: var(--rj-accent); color: var(--rj-accent-ink); font-size: 10px; font-style: normal; font-weight: 800; display: grid; place-items: center; padding: 0 4px; }
  .dlrow { display: flex; flex-direction: column; gap: 6px; padding: 10px 6px; border-bottom: 1px solid var(--rj-border); }
  .dltop { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .dltop .ht { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .dlx { border: 1px solid var(--rj-border); background: none; color: var(--rj-text-dim); border-radius: 999px; padding: 4px 12px; font-size: 12px; }
  .dlbar { height: 6px; border-radius: 3px; background: var(--rj-surface-2); overflow: hidden; }
  .dlbar i { display: block; height: 100%; background: var(--rj-accent); border-radius: 3px; transition: width .25s; }
  .dlbar.done i { background: var(--rj-accent); opacity: .55; }
  .dlbar.bad i { background: var(--rj-text-faint); }
  .dlbar i.ind { animation: dlind 1.1s ease-in-out infinite alternate; }
  .hsheet form.fxadd { order: 0; flex: none; }
  .hint { margin: 0; padding: 4px 6px; font-size: 13px; line-height: 1.45; color: var(--rj-text-faint); }
  .fxadd { display: flex; gap: 8px; padding: 4px 6px 8px; }
  .fxadd input { flex: 1; min-width: 0; min-height: 40px; padding: 0 12px; border-radius: 10px; border: 1px solid var(--rj-border); background: var(--rj-surface); color: var(--rj-text); font: inherit; font-size: 14px; }
  .fxb { min-height: 40px; padding: 0 14px; border-radius: 999px; border: 1px solid var(--rj-border); background: none; color: var(--rj-text); font: inherit; font-size: 13px; }
  .fxpri { background: var(--rj-accent); color: var(--rj-accent-ink); border-color: transparent; font-weight: 600; }
  .fxbt { display: flex; gap: 6px; flex: none; }
  .fxerr { margin: 0; padding: 0 6px 8px; font-size: 12px; color: var(--rj-danger); }
  .fxcd { font-family: var(--rj-mono, monospace); }
  .fxcd.urg { color: var(--rj-danger); }
  @keyframes dlind { from { margin-left: 0; } to { margin-left: 60%; } }
  .hov { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.6); display: flex; align-items: flex-end; justify-content: center; }
  .hsheet { width: min(560px, 100%); max-height: 82vh; overflow: auto; background: var(--rj-bg, #000); border: 1px solid var(--rj-border); border-radius: 22px 22px 0 0; padding: 16px 16px 24px; display: flex; flex-direction: column; gap: 6px; }
  @media (min-width: 700px) { .hov { align-items: center; } .hsheet { border-radius: 22px; } }
  .hhead { display: flex; align-items: center; justify-content: space-between; font-size: 17px; }
  .hclose, .hx { border: 0; background: none; color: var(--rj-text-dim); font-size: 22px; line-height: 1; padding: 4px 10px; }
  .hsec { margin: 10px 0 2px; font-size: 12px; font-weight: 700; color: var(--rj-text-dim); text-transform: lowercase; }
  .hq { margin: 8px 0 2px; height: 42px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--rj-border); background: var(--rj-surface); color: var(--rj-text); font-size: 15px; }
  .hrow2 { display: flex; align-items: center; }
  .hrow { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left; border: 0; background: none; color: var(--rj-text); padding: 8px 6px; border-radius: 10px; }
  .hrow:hover { background: var(--rj-hover); }
  .ht { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hu { font-size: 12px; color: var(--rj-text-dim); }
  .hclear { margin-top: 10px; height: 44px; border-radius: var(--rj-pill); border: 1px solid var(--rj-border); background: none; color: var(--rj-danger); font-size: 14px; font-weight: 600; }
  .rc-clear { background: none; border: 0; color: var(--rj-text-dim); font-size: 12px; text-decoration: underline; padding: 4px 6px; margin-left: 6px; }
  .bm-h { margin: 0 0 4px; font-size: 13px; font-weight: 700; color: var(--rj-text-dim); text-align: center; }
  .bm-row { display: flex; gap: 6px; }
  .bm-open { flex: 1; min-width: 0; background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 12px; padding: 10px 14px; font-size: 14px; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bm-open:hover { border-color: var(--rj-accent); }
  .bm-open:disabled { opacity: 0.4; }
  .bm-x { width: 38px; flex: none; background: none; border: 1px solid var(--rj-border); color: var(--rj-text-dim); border-radius: 12px; font-size: 13px; }
  .bm-x:hover { color: var(--rj-danger); border-color: var(--rj-danger); }
  .bm-toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 28px; z-index: 50; background: var(--rj-surface-2); border: 1px solid var(--rj-border); color: var(--rj-text); border-radius: 999px; padding: 10px 18px; font-size: 14px; white-space: nowrap; }
  .techchip { position: fixed; left: 10px; bottom: calc(10px + env(safe-area-inset-bottom)); z-index: 5; padding: 4px 9px; border-radius: var(--rj-pill); background: rgba(0,0,0,.6); color: var(--rj-text-dim); font: 11px var(--rj-mono); pointer-events: none; }
  .stage { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .stage.off { display: none; }
  .stage :global(.tabframe) { width: 100%; flex: 1; border: 0; background: #fff; }
  .tabbar { display: flex; gap: 4px; padding: 8px 14px 0; overflow-x: auto; scrollbar-width: none; align-items: flex-end; scroll-padding: 0 40px; -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); mask-image: linear-gradient(90deg, transparent 0, #000 14px, #000 calc(100% - 14px), transparent 100%); }
  .tabbar::-webkit-scrollbar { display: none; }
  .tab { position: relative; display: flex; align-items: center; gap: 8px; flex: 0 0 auto; width: 168px; height: 38px; padding: 0 6px 0 10px; background: transparent; border: 0; border-radius: 12px 12px 0 0; font-size: 13px; font-weight: 500; color: var(--rj-text-faint); cursor: pointer; transition: background .15s, color .15s; }
  .tab:hover { background: var(--rj-hover); color: var(--rj-text-dim); }
  .tab.cur { background: var(--rj-surface); color: var(--rj-text); }
  .tab.cur::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--rj-accent); }
  .tab:not(.cur):not(:hover) + .tab:not(.cur):not(:hover)::before { content: ''; position: absolute; left: -3px; top: 11px; bottom: 11px; width: 1px; background: var(--rj-border); }
  .tabfav { flex: none; width: 18px; height: 18px; border-radius: 6px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: var(--rj-text); background: var(--rj-surface-2); }
  .tabfav.blank { background: var(--rj-hover); }
  .tabfav.blank::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--rj-text-faint); }
  .tab.load .tabfav { animation: tabpulse 1.1s ease-in-out infinite; }
  @keyframes tabpulse { 50% { opacity: .35; } }
  .tt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent); }
  .tx { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border: 0; background: none; color: inherit; border-radius: 8px; opacity: 0; transition: opacity .12s, background .12s; }
  .tx svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; }
  .tab:hover .tx, .tab.cur .tx { opacity: 1; }
  .tx:hover { background: var(--rj-hover); color: var(--rj-text); }
  .tplus { flex: none; align-self: center; width: 30px; height: 30px; margin-left: 4px; display: grid; place-items: center; border-radius: 10px; background: transparent; border: 0; color: var(--rj-text-dim); }
  .tplus svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
  .tplus:hover { background: var(--rj-hover); color: var(--rj-text); }
  .tplus:disabled { opacity: 0.35; }
  @media (hover: none) { .tx { opacity: 1; } .tab:not(.cur) .tx { opacity: .6; } }
  @media (max-width: 640px) { .tab { width: 148px; } }
  .surfing header { border-bottom: 1px solid var(--rj-border); }
  @media (max-width: 640px) {
    .brand { display: none; }
    header { flex-wrap: wrap; }
    form { order: 3; flex: 1 1 100%; }
    .navbtns { flex: 1; margin-left: 0; }
    .home h1 { font-size: 34px; }
  }
  input { font-size: 16px; }
  input::placeholder { color: var(--rj-text-faint); opacity: 1; }
  input:focus { border-color: var(--rj-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rj-accent) 22%, transparent); }
  header form input { padding: 10px 18px; }
  .hero { flex: none; width: min(640px, 100%); display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 6px 6px 6px 18px; height: 56px; border-radius: var(--rj-pill); background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text-faint); backdrop-filter: blur(var(--rj-g-blur, 0px)); -webkit-backdrop-filter: blur(var(--rj-g-blur, 0px)); }
  .hero:focus-within { border-color: var(--rj-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rj-accent) 22%, transparent); }
  .hero input { background: none; border: 0; box-shadow: none; padding: 0; height: 100%; font-size: 17px; }
  .hero input:focus { border: 0; box-shadow: none; }
  .hero .go { height: 44px; padding: 0 24px; }
  @media (max-width: 700px) {
    header { flex-wrap: wrap; row-gap: 8px; }
    header form { order: 5; flex: 1 1 100%; }
    header form input { height: 44px; }
    header form .go { height: 44px; }
    .navbtns { margin-left: auto; }
    .hero { height: 52px; }
  }
  @media (max-width: 520px) { .hero { padding-left: 14px; gap: 8px; } .hero .go { padding: 0 18px; } .hero input { font-size: 16px; } }

  /* one chrome: bar + tabs share a surface, the active tab is the page's own colour, one overflow menu replaces the row of icon buttons */
  header form.omni { position: relative; }
  .chrome { position: relative; z-index: 20; background: var(--rj-surface); border-bottom: 1px solid var(--rj-border); }
  .surfing header { border-bottom: 0; }
  header { position: relative; flex-wrap: nowrap; row-gap: 0; gap: 8px; padding: 10px 12px 8px; }
  header form, header form.omni { order: 0; flex: 1 1 auto; gap: 0; align-items: center; background: var(--rj-bg); border: 1px solid var(--rj-border); border-radius: var(--rj-pill); padding: 3px 3px 3px 4px; min-width: 0; }
  header form:focus-within { border-color: var(--rj-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rj-accent) 22%, transparent); }
  header form input, header form input:focus { background: none; border: 0; box-shadow: none; padding: 7px 14px; height: 36px; font-size: 16px; }
  header form .go { height: 34px; padding: 0 16px; font-size: 13px; }
  .navbtns { margin-left: 0; flex: none; }
  .navbtns button { background: transparent; border-color: transparent; }
  .navbtns button:hover { background: var(--rj-surface-2); }
  .menub { position: relative; flex: none; width: 36px; height: 36px; display: grid; place-items: center; border-radius: 50%; background: transparent; border: 0; color: var(--rj-text-dim); }
  .menub svg { width: 20px; height: 20px; fill: currentColor; }
  .menub:hover, .menub.on { background: var(--rj-surface-2); color: var(--rj-text); }
  .menuscrim { position: fixed; inset: 0; z-index: 40; background: transparent; border: 0; padding: 0; }
  .menu { position: absolute; z-index: 41; right: 10px; top: calc(100% - 2px); width: min(268px, calc(100vw - 20px)); padding: 6px; display: flex; flex-direction: column; gap: 1px; background: linear-gradient(var(--rj-surface-2), var(--rj-surface-2)), #101012; border: 1px solid var(--rj-border); border-radius: calc(var(--rj-radius) - 2px); box-shadow: 0 16px 44px rgba(0,0,0,.55); }
  .mnav { display: none; justify-content: space-between; padding: 2px 2px 6px; margin-bottom: 4px; border-bottom: 1px solid var(--rj-border); }
  .mnav button { flex: 1; height: 40px; display: grid; place-items: center; background: none; border: 0; border-radius: 10px; color: var(--rj-text); }
  .mnav button:active { background: var(--rj-surface); }
  .mnav svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .mi { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; height: 42px; padding: 0 12px; border: 0; border-radius: 10px; background: none; color: var(--rj-text); font-size: 15px; text-align: left; }
  .mi:hover, .mi:active { background: var(--rj-surface); }
  .mi svg { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; color: var(--rj-text-dim); }
  .mi.on svg, .mi.on .mstate { color: var(--rj-accent); }
  .mi span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mstate { font-style: normal; font-size: 12px; color: var(--rj-text-faint); }
  .mcount { font-style: normal; min-width: 18px; height: 18px; border-radius: 9px; background: var(--rj-accent); color: var(--rj-accent-ink); font-size: 11px; font-weight: 800; display: grid; place-items: center; padding: 0 5px; }
  .tabbar { padding: 0 12px; }
  .tab { height: 36px; }
  .tab.cur { background: var(--rj-bg); }
  .tab.cur::after { display: none; }
  .tab:hover:not(.cur) { background: var(--rj-hover); }
  .home { gap: 10px; }
  .home h1 { font-size: 34px; }
  .findbar { top: 104px; }
  @media (max-width: 700px) {
    header { flex-wrap: nowrap; padding: 8px 10px 6px; gap: 6px; }
    header form { order: 0; flex: 1 1 auto; }
    .dnav { display: none; }
    .mnav { display: flex; }
    header form input { height: 38px; }
    .tabbar { padding: 0 10px; }
    .findbar { top: 100px; }
  }

  /* phone chrome: bottom toolbar + tab sheet. desktop unchanged - toolbar hidden, pill tabbar stays. */
  .mtoolbar { display: none; }
  .tsheet .trow { flex-direction: row; align-items: center; gap: 10px; }
  .tsheet .tcol { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .tsheet .trow.cur .ht { color: var(--rj-accent); }
  .tnew { margin-top: 10px; height: 44px; border-radius: var(--rj-pill); border: 1px solid var(--rj-border); background: none; color: var(--rj-text); font-size: 14px; font-weight: 600; }
  .tnew:disabled { opacity: .4; }
  @media (max-width: 700px) {
    .shell.hasmtb { padding-bottom: calc(54px + env(safe-area-inset-bottom)); }
    .tabbar { display: none; }
    .mtoolbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 35; display: flex; align-items: center; justify-content: space-around; height: calc(54px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom); background: var(--rj-surface); border-top: 1px solid var(--rj-border); }
    .mtoolbar button { position: relative; width: 44px; height: 44px; display: grid; place-items: center; background: none; border: 0; border-radius: 12px; color: var(--rj-text-dim); }
    .mtoolbar button:active, .mtoolbar button.on { background: var(--rj-surface-2); color: var(--rj-text); }
    .mtoolbar svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .mtoolbar .mtb-n { min-width: 22px; height: 22px; padding: 0 5px; display: grid; place-items: center; border: 1.6px solid currentColor; border-radius: 7px; font-size: 12px; font-weight: 700; }
    .mtoolbar .dlbadge { top: 2px; right: 2px; }
    .menu { position: fixed; top: auto; right: 10px; bottom: calc(62px + env(safe-area-inset-bottom)); }
    .bm-toast { bottom: calc(76px + env(safe-area-inset-bottom)); }
    .techchip { bottom: calc(64px + env(safe-area-inset-bottom)); }
  }

  /* touch hit-slop: pseudo-element grows tap targets toward 44px on coarse/no-hover pointers, where layout/stacking allow; visual size and desktop unchanged. exceptions: see review notes */
  @media (hover: none), (pointer: coarse) {
    .back { position: relative; } .back::after { content: ''; position: absolute; inset: -6px; }
    .go { position: relative; } .go::after { content: ''; position: absolute; left: 0; right: 0; top: -5px; bottom: -5px; }
    .menub { position: relative; } .menub::after { content: ''; position: absolute; inset: -4px; }
    .tx { position: relative; } .tx::after { content: ''; position: absolute; inset: -10px -4px -10px -10px; } /* right capped at own tab padding: no theft from the next tab */
    .tab.cur .tx::after { left: -16px; } /* current tab: body tap is a no-op, so the wider left slop steals nothing */
    .tplus { position: relative; } .tplus::after { content: ''; position: absolute; inset: -7px; }
    .chip { position: relative; } .chip::after { content: ''; position: absolute; left: 0; right: 0; top: -5px; bottom: -5px; }
    .chip.rc-x::after { left: -10px; right: -10px; }
  }
  .naverr p { margin: 0 0 10px; }
  .naverr-url { opacity: .65; font-size: 13px; word-break: break-all; }
  .rtry { margin-top: 6px; padding: 8px 22px; border-radius: 999px; border: 1px solid var(--rj-border, rgba(255,255,255,.14)); background: none; color: inherit; font: inherit; cursor: pointer; }
  .rtry:hover { background: var(--rj-surface-2, rgba(255,255,255,.07)); }
</style>
