<script>
  import { readSearches, addSearch } from '../../lib/searchhist.js';
  import '../../tokens.css';
  import { onMount } from 'svelte';
  import { api } from '../../lib/api.js';

  let address = $state('');
  let boot = $state('setting up...');
  let ready = $state(false);
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
  function hostOf(t) {
    try { return new URL(/^[a-z]+:\/\//i.test(t.address || '') ? t.address : 'https://' + t.address).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
  function favLetter(t) { const h = t.surfing ? hostOf(t) : ''; if (!h) return ''; const p = h.split('.'); return (p.length > 1 ? p[p.length - 2] : p[0])[0].toUpperCase(); }
  function favHue(t) { const q = hostOf(t).split('.'); const h = q.length > 1 ? q[q.length - 2] : q[0]; let n = 0; for (const c of h) n = (n * 31 + c.charCodeAt(0)) % 360; return n; }
  function titleFor(t) {
    if (t.title) return t.title;
    return t.surfing ? 'loading...' : 'new tab';
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
        if (loadT0 && id === activeId) { loadMs = Math.round(performance.now() - loadT0); loadT0 = 0; }
        const t = el.contentDocument?.title;
        const tb = tabs.find((x) => x.id === id);
        if (t && tb) tb.title = t.slice(0, 60);
        const u = tb?.url || '';
        if (tb && /^https?:\/\//i.test(u) && tb.seen !== u) { tb.seen = u; noteVisit(u, t || ''); }
        if (t && id === activeId && !cloaked) document.title = t + ' - browse';
      } catch {}
    });
    live.set(id, { el, frame: fr });
    tabs.push({ id, title: '', address: '', surfing: false });
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
    if (t && t.title && !cloaked) document.title = t.title + ' - browse';
  }
  function closeTab(id, e) {
    e?.stopPropagation();
    const i = tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const v = live.get(id);
    { const ct = tabs[i]; const cu = ct.url || ''; if (ct.surfing && !cloaked && /^https?:\/\//i.test(cu)) closed = [{ url: cu, title: ct.title || hostOf({ address: cu, surfing: true }) }, ...closed].slice(0, 10); }
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
  function makeUrlCodec(keyHex) {
    const body =
      'var KH="' + keyHex + '";var K=[];for(var i=0;i<KH.length;i+=2)K.push(parseInt(KH.slice(i,i+2),16));' +
      'var B="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";' +
      'function ks(nc,n){var s=2166136261,i,x;for(i=0;i<K.length;i++){s^=K[i];s=Math.imul(s,16777619)>>>0;}for(i=0;i<nc.length;i++){s^=nc[i];s=Math.imul(s,16777619)>>>0;}x=s||88675123;var o=new Uint8Array(n);for(i=0;i<n;i++){x^=x<<13;x>>>=0;x^=x>>17;x^=x<<5;x>>>=0;o[i]=(x^K[i%K.length])&255;}return o;}' +
      'function be(a){var s="",i,v;for(i=0;i<a.length;i+=3){v=(a[i]<<16)|((i+1<a.length?a[i+1]:0)<<8)|(i+2<a.length?a[i+2]:0);s+=B[(v>>18)&63]+B[(v>>12)&63];if(i+1<a.length)s+=B[(v>>6)&63];if(i+2<a.length)s+=B[v&63];}return s;}' +
      'function bd(t){var v=[],o=[],i,n;for(i=0;i<t.length;i++)v.push(B.indexOf(t[i]));for(i=0;i<v.length;i+=4){n=(v[i]<<18)|((v[i+1]||0)<<12)|((v[i+2]||0)<<6)|(v[i+3]||0);o.push((n>>16)&255);if(i+2<v.length)o.push((n>>8)&255);if(i+3<v.length)o.push(n&255);}return new Uint8Array(o);}';
    const encode = new Function('u', body +
      'if(!u)return u;' +
      'var raw=new TextEncoder().encode(String(u));' +
      'var nc=new Uint8Array(4);crypto.getRandomValues(nc);' +
      'var st=ks(nc,raw.length),ct=new Uint8Array(raw.length),i;' +
      'for(i=0;i<raw.length;i++)ct[i]=raw[i]^st[i];' +
      'var out=new Uint8Array(4+ct.length);out.set(nc,0);out.set(ct,4);' +
      'return be(out);');
    const decode = new Function('e', body +
      'if(!e)return e;' +
      'var b=bd(String(e));' +
      'if(b.length<4)return "";' +
      'var st=ks(b.slice(0,4),b.length-4),raw=new Uint8Array(b.length-4),i;' +
      'for(i=0;i<raw.length;i++)raw[i]=b[i+4]^st[i];' +
      'return new TextDecoder().decode(raw);');
    return { encode, decode };
  }


  // tab cloak (Luke 11:26 AM): one tap (or the ` key) and the tab reads as
  // homework - innocuous title + a docs-look icon, and proxied page titles
  // stop reaching the tab (and browser history) while it is on.
  const CLOAK_TITLE = 'Google Docs';
  const CLOAK_ICON = '/cloak/docs-32.png';
  let cloaked = $state(true);
  function applyCloak() {
    let link = document.querySelector("link[rel~='icon']");
    if (!link) { link = document.createElement('link'); link.setAttribute('rel', 'icon'); document.head.appendChild(link); }
    if (cloaked) { document.title = CLOAK_TITLE; link.href = CLOAK_ICON; }
    else { document.title = 'browse - ramjet'; link.href = '/favicon.svg'; }
  }
  function toggleCloak() {
    cloaked = !cloaked;
    try { localStorage.setItem('rj-cloak', cloaked ? '1' : '0'); } catch {}
    applyCloak();
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
  async function makeTransport(Epoxy, wisp) {
    if ((localStorage.getItem('rj-transport') || 'ws') === 'ws') {
      const epoxy = new Epoxy({ wisp });
      const ab = localStorage.getItem('rj-adblock') !== 'off';
      const pwsUrl = wisp.replace('/wisp-t/', '/pws-t/');
      const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      let sock = null, opening = null, nextId = 1;
      const pend = new Map();
      const freshUrl = async () => { try { const r = await fetch('/api/wisp-ticket' + (ab ? '' : '?ab=0')); const j = await r.json(); if (j && j.ticket) return pwsUrl.replace(/\/pws-t\/[a-f0-9]+/, '/pws-t/' + j.ticket); } catch {} return pwsUrl; };
      const open = () => sock && sock.readyState === 1 ? Promise.resolve(sock) : opening || (opening = freshUrl().then((url) => new Promise((res, rej) => {
        const w = new WebSocket(url); w.binaryType = 'arraybuffer';
        w.onopen = () => { sock = w; opening = null; res(w); };
        w.onerror = () => { opening = null; rej(new TypeError('proxy socket failed')); };
        w.onclose = () => { sock = null; for (const [, p] of pend) p.fail('proxy socket closed'); pend.clear(); };
        w.onmessage = (ev) => {
          const dv = new DataView(ev.data); const id = dv.getUint32(0); const type = dv.getUint8(4); const p = pend.get(id);
          if (!p) return;
          if (type === 0) { const h = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 5))); p.head(h); }
          else if (type === 1) p.ctl?.enqueue(new Uint8Array(ev.data, 5));
          else if (type === 2) { pend.delete(id); try { p.ctl?.close(); } catch {} }
          else { pend.delete(id); p.fail(new TextDecoder().decode(new Uint8Array(ev.data, 5))); }
        };
      })).catch((e) => { opening = null; throw e; }));
      return {
        ready: false,
        async init() { await epoxy.init(); this.ready = true; },
        meta: () => epoxy.meta?.(),
        connect: (...a) => epoxy.connect(...a),
        async request(remote, method, body, headers, signal) {
          let b = null;
          if (body != null) {
            if (typeof body === 'string') b = btoa(unescape(encodeURIComponent(body)));
            else b = toB64(body instanceof Blob ? await body.arrayBuffer() : body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
          }
          const w = await open();
          const id = nextId++;
          return await new Promise((resolve, reject) => {
            let ctl = null, headed = false;
            const stream = new ReadableStream({ start(c) { ctl = c; }, cancel() { pend.delete(id); try { w.send(JSON.stringify({ id, cancel: true })); } catch {} } });
            const rec = {
              get ctl() { return ctl; },
              head: (h) => { headed = true; resolve({ body: stream, headers: h.headers, status: h.status, statusText: h.text || '' }); },
              fail: (m) => { if (!headed) reject(new TypeError('proxy fetch failed: ' + m)); else { try { ctl.error(new TypeError(m)); } catch {} } },
            };
            pend.set(id, rec);
            if (signal) signal.addEventListener('abort', () => { pend.delete(id); try { w.send(JSON.stringify({ id, cancel: true })); } catch {} rec.fail('aborted'); }, { once: true });
            w.send(JSON.stringify({ id, url: remote.href, method, headers, body: b, ab }));
          });
        },
      };
    }
    if (localStorage.getItem('rj-transport') === 'curl') {
      const url = '/libcurl/index.mjs';
      const m = await import(/* @vite-ignore */ url);
      return new m.default({ wisp });
    }
    if (localStorage.getItem('rj-transport') === 'server') {
      const epoxy = new Epoxy({ wisp });
      const ab = localStorage.getItem('rj-adblock') !== 'off';
      const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      return {
        ready: false,
        async init() { await epoxy.init(); this.ready = true; },
        meta: () => epoxy.meta?.(),
        connect: (...a) => epoxy.connect(...a),
        async request(remote, method, body, headers, signal) {
          let b = null;
          if (body != null) {
            if (typeof body === 'string') b = btoa(unescape(encodeURIComponent(body)));
            else b = toB64(body instanceof Blob ? await body.arrayBuffer() : body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
          }
          const r = await fetch('/api/pfetch', { method: 'POST', signal, body: JSON.stringify({ url: remote.href, method, headers, body: b, ab }) });
          const st = r.headers.get('x-rj-status');
          if (!st) throw new TypeError('proxy fetch failed: ' + (r.headers.get('x-rj-error') || r.status));
          const raw = JSON.parse(atob(r.headers.get('x-rj-headers') || 'W10='));
          return { body: r.body, headers: raw, status: +st, statusText: decodeURIComponent(r.headers.get('x-rj-text') || '') };
        },
      };
    }
    return new Epoxy({ wisp });
  }

  $effect(() => {
    if (!stageEl) return;
    let cancelled = false;
    let attempts = 0;
    const bootOnce = async () => {
      try {
        if (!('serviceWorker' in navigator)) { failed = 'this browser is too old for browse'; return; }
        boot = 'loading the engine...';
        const { Controller } = globalThis.$scramjetController;
        const EpoxyTransport = window.EpoxyTransport;
        if (!Controller || !EpoxyTransport) { failed = 'engine files did not load - check your connection and reload'; return; }
        boot = 'starting the worker...';
        // the worker, the tunnel ticket and the url key are independent, so
        // they load together instead of one after another.
        // some browsers (iOS Safari) withhold cookies on websocket upgrades,
        // so the tunnel authenticates with a short-lived ticket instead.
        const tkP = fetch('/api/wisp-ticket' + (localStorage.getItem('rj-adblock') === 'off' ? '?ab=0' : '')).then((r) => r.json()).catch(() => ({}));
        const kkP = fetch('/api/apps/browse/urlkey').then((r) => r.json()).catch(() => ({}));
        const swP = (async () => {
          const reg = await navigator.serviceWorker.register('/browse-sw.js');
          const w0 = reg.active || await new Promise((res, rej) => {
            const w = reg.installing || reg.waiting;
            if (!w) return rej(new Error('no service worker'));
            const t = setTimeout(() => rej(new Error('worker did not start in time')), 12000);
            w.addEventListener('statechange', () => {
              if (w.state === 'activated') { clearTimeout(t); res(w); }
              if (w.state === 'redundant') { clearTimeout(t); rej(new Error('service worker failed')); }
            });
          });
          await navigator.serviceWorker.ready;
          return w0;
        })();
        const [sw, tk, kk] = await Promise.all([swP, tkP, kkP]);
        if (cancelled) return;
        boot = 'connecting...';
        const urlCodec = kk.key ? makeUrlCodec(kk.key) : undefined;
        const wispBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
        const wispUrl = tk.ticket ? `${wispBase}/wisp-t/${tk.ticket}/` : `${wispBase}/wisp/`;
        await new Promise((res, rej) => {
          const probe = new WebSocket(wispUrl);
          const t = setTimeout(() => { try { probe.close(); } catch {} ; rej(new Error('the tunnel timed out after 15s - this network may be blocking websockets')); }, 15000);
          probe.onopen = () => { clearTimeout(t); probe.close(); res(); };
          probe.onerror = () => { /* onclose carries the detail */ };
          probe.onclose = (ev) => { clearTimeout(t); rej(new Error(`the tunnel was refused (code ${ev.code || 'none'})`)); };
        });
        if (cancelled) return;
        boot = 'waking the proxy...';
        const controller = new Controller({ serviceworker: sw, transport: await makeTransport(EpoxyTransport, wispUrl), ...(urlCodec ? { config: { codec: urlCodec } } : {}) });
        await Promise.race([
          controller.wait(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('the proxy did not wake in time - reload to try again')), 15000)),
        ]);
        if (cancelled) return;
        ctrl = controller;
        startSync(controller);
        newTab();
        ready = true; boot = '';
        try { const h = sessionStorage.getItem('rj-open'); if (h) { sessionStorage.removeItem('rj-open'); setTimeout(() => { address = h; go(); }, 80); } } catch {}
      } catch (e) {
        if (!cancelled && attempts < 2) { // one automatic retry, then give up loudly
          attempts += 1;
          boot = 'retrying...';
          await new Promise((r) => setTimeout(r, 2500));
          if (!cancelled) return bootOnce();
        }
        failed = (e && e.message) ? e.message : 'browse could not start - reload to try again';
        boot = '';
      }
    };
    bootOnce();
    return () => { cancelled = true; };
  });

  // recent sites: this device only (localStorage), host-level, never recorded
  // while the tab cloak is on, one tap to clear.
  let recents = $state([]);
  try { recents = JSON.parse(localStorage.getItem('rj-browse-recent') || '[]').slice(0, 30); } catch {}
  function noteRecent(url) {
    if (cloaked || !/^https?:\/\//i.test(url)) return;
    try {
      const u = new URL(url);
      const name = u.hostname.replace(/^www\./, '');
      recents = [{ name, url: u.origin + '/' }, ...recents.filter((r) => r.name !== name)].slice(0, 30);
      localStorage.setItem('rj-browse-recent', JSON.stringify(recents));
    } catch {}
  }
  let allRecents = $state(false);
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
  function dlCancel(id) { try { navigator.serviceWorker.controller?.postMessage({ rjdlCancel: id }); } catch {} }
  function dlClear() { dls = dls.filter((d) => d.state === 'active'); }
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

  function openReader() {
    const v = cur(), t = active;
    if (!v || !t) return;
    const u = normalize(t.address || '');
    if (!u || u.startsWith('/')) return;
    t.title = 'reader';
    v.el.src = '/searx/reader?u=' + encodeURIComponent(u);
  }

  let recentQ = $state(readSearches('rj-browse-searches'));
  function go(e) {
    e?.preventDefault();
    const url = normalize(address);
    if (!url) return;
    if (/\s/.test(address.trim()) || !address.includes('.')) recentQ = addSearch('rj-browse-searches', address);
    noteRecent(url);
    try { navigator.serviceWorker.controller?.postMessage({ rjdlHint: url }); } catch {}
    const v = cur();
    const t = active;
    if (!v || !t) return;
    t.surfing = true; t.url = url; loadT0 = performance.now(); loadMs = 0;
    t.address = address;
    t.title = '';
    syncDisplay();
    if (url.startsWith('/searx/')) { v.el.src = url; return; }
    v.frame.go(url);
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
    try { cloaked = localStorage.getItem('rj-cloak') !== '0'; } catch {}
    if (cloaked) applyCloak();
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
    try { navigator.serviceWorker.addEventListener('message', (e) => onDl(e.data && e.data.rjdl)); } catch {}
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
        v.frame.go(u);
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

<div class="shell" class:surfing>
  <header>
    <a class="back" href="/" title="back to ramjet" aria-label="back to ramjet"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></a>
    <span class="brand">browse</span>
    <div class="navbtns">
      <button onclick={() => cur()?.frame.back()} title="back" aria-label="back"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg></button>
      <button onclick={() => cur()?.frame.forward()} title="forward" aria-label="forward"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-6-6m6 6-6 6" /></svg></button>
      <button onclick={() => cur()?.frame.reload()} title="reload" aria-label="reload"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg></button>
      <button onclick={toggleCloak} title={cloaked ? 'uncloak this tab' : 'cloak this tab'} aria-label={cloaked ? 'uncloak this tab' : 'cloak this tab'} class:on={cloaked}><svg viewBox="0 0 24 24"><path d="M12 4c-5 0-9 4-10 9 1-5 5-8 10-8s9 3 10 8c-1-5-5-9-10-9zm0 5a4 4 0 1 0 4 4 4 4 0 0 0-4-4zm0 2a2 2 0 1 1-2 2 2 2 0 0 1 2-2z" /></svg></button>
      <button onclick={() => (dlOpen = !dlOpen)} title="downloads" aria-label="downloads" class:on={dlOpen} class="dlb"><svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" /></svg>{#if dlActive}<i class="dlbadge">{dlActive}</i>{/if}</button>
      {#if surfing}
        {#if ytCur}<button onclick={openJetstream} title="open in jetstream" aria-label="open in jetstream" class="jsb"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg></button>{/if}
        <button onclick={toggleFind} title="find in page (alt+f)" aria-label="find in page" class:on={findOpen}><svg viewBox="0 0 24 24"><path d="M10.5 4a6.5 6.5 0 1 0 4 11.6l4.6 4.6 1.4-1.4-4.6-4.6A6.5 6.5 0 0 0 10.5 4z" /></svg></button>
        <button onclick={() => { histOpen = true; histQ = ''; }} title="history and recently closed (alt+y)" aria-label="history" class:on={histOpen}><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" /></svg></button>
        <button onclick={openReader} title="reader mode" aria-label="reader mode"><svg viewBox="0 0 24 24"><path d="M4 5h16M4 10h16M4 15h10M4 20h7" /></svg></button>
        <button onclick={star} title="bookmark this page" aria-label="bookmark this page"><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8z" /></svg></button>
      {/if}
    </div>
    <form onsubmit={go}>
      <input bind:value={address} list="br-recent-q" placeholder="search or type an address" autocomplete="off" autocapitalize="off" spellcheck="false" />
      <datalist id="br-recent-q">{#each recentQ as r}<option value={r}></option>{/each}</datalist>
      <button class="go" type="submit" disabled={!ready}>go</button>
    </form>
  </header>

  {#if ready}
    <div class="tabbar" role="tablist">
      {#each tabs as t (t.id)}
        <div class="tab" class:cur={t.id === activeId} class:load={t.surfing && !t.title} role="tab" tabindex="0" aria-selected={t.id === activeId}
          onclick={() => switchTab(t.id)} onkeydown={(e) => e.key === 'Enter' && switchTab(t.id)}>
          <span class="tabfav" style={favLetter(t) ? `--h:${favHue(t)}` : ''} class:blank={!favLetter(t)}>{favLetter(t)}</span>
          <span class="tt">{titleFor(t)}</span>
          <button class="tx" onclick={(e) => closeTab(t.id, e)} aria-label="close tab"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17" /></svg></button>
        </div>
      {/each}
      <button class="tplus" onclick={() => newTab()} aria-label="new tab" title="new tab (alt+t)" disabled={tabs.length >= 12}><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></button>
    </div>
  {/if}

  {#if failed}
    <div class="center"><p class="dim">{failed}</p></div>
  {:else if !surfing}
    <div class="center home">
      <h1>browse</h1>
      <p class="dim">{boot || 'the open web, through ramjet'}</p>
      <form class="hero" onsubmit={go}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input bind:value={address} list="br-recent-q" placeholder="search or type an address" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="search or type an address" /><button class="go" type="submit" disabled={!ready}>go</button></form>
      <div class="chips">
        {#each quick as s}
          <button class="chip" onclick={() => open(s)} disabled={!ready}>{s.name}</button>
        {/each}
      </div>
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
        <div class="hlist">
          {#each dls as d (d.id)}
            <div class="dlrow">
              <div class="dltop"><span class="ht">{d.name}</span>
                {#if d.state === 'active'}<button class="dlx" onclick={() => dlCancel(d.id)}>cancel</button>{/if}</div>
              <div class="dlbar" class:done={d.state === 'done'} class:bad={d.state === 'error' || d.state === 'cancelled'}><i style={'width:' + (d.state === 'done' ? 100 : d.size ? Math.min(100, d.got / d.size * 100) : 40) + '%'} class:ind={d.state === 'active' && !d.size}></i></div>
              <span class="hu">{d.state === 'active' ? (fmtSize(d.got) + (d.size ? ' of ' + fmtSize(d.size) : '') + ' - saving') : d.state === 'done' ? (fmtSize(d.got) + ' - saved by your browser, check its downloads list') : d.state === 'cancelled' ? 'cancelled' : 'failed - try again'}</span>
            </div>
          {:else}
            <p class="hint">nothing downloaded yet. when a site sends a file, it saves to this device and shows up here.</p>
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
            <p class="hint">{hist.length ? 'nothing matches' : 'nothing here yet. pages you visit show up here, on this device only, and not while the cloak is on'}</p>
          {/each}
        </div>
        {#if hist.length}<button class="hclear" onclick={clearHist}>clear history</button>{/if}
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
  {#if surfing && loadMs && techOn()}<span class="techchip">loaded in {(loadMs / 1000).toFixed(1)} s · via scramjet</span>{/if}
</div>

<style>
  .jsb { color: var(--rj-accent); }
  .findbar { position: fixed; z-index: 30; right: 12px; top: 108px; display: flex; gap: 4px; align-items: center; padding: 6px; background: var(--rj-surface-2); border: 1px solid var(--rj-border); border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.5); max-width: calc(100vw - 24px); }
  .findbar input { width: 190px; min-width: 0; font-size: 16px; background: transparent; border: 0; outline: 0; color: var(--rj-text); padding: 6px 8px; }
  @media (max-width: 640px) { .findbar { top: 146px; } }
  .findbar.miss input { color: #ff7a7a; }
  .findbar button { background: transparent; border: 0; color: var(--rj-text-dim); font-size: 16px; padding: 6px 9px; border-radius: 8px; cursor: pointer; }
  .findbar button:hover { background: rgba(255,255,255,.08); color: var(--rj-text); }
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
  input:focus { border-color: rgba(255,255,255,0.25); }
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
  .hclear { margin-top: 10px; height: 44px; border-radius: var(--rj-pill); border: 1px solid var(--rj-border); background: none; color: #ff6b6b; font-size: 14px; font-weight: 600; }
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
  .tab:hover { background: rgba(255,255,255,.05); color: var(--rj-text-dim); }
  .tab.cur { background: var(--rj-surface); color: var(--rj-text); }
  .tab.cur::after { content: ''; position: absolute; left: 12px; right: 12px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--rj-accent); }
  .tab:not(.cur):not(:hover) + .tab:not(.cur):not(:hover)::before { content: ''; position: absolute; left: -3px; top: 11px; bottom: 11px; width: 1px; background: var(--rj-border); }
  .tabfav { flex: none; width: 18px; height: 18px; border-radius: 6px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: hsl(var(--h, 0) 38% 36%); }
  .tabfav.blank { background: rgba(255,255,255,.1); }
  .tabfav.blank::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--rj-text-faint); }
  .tab.load .tabfav { animation: tabpulse 1.1s ease-in-out infinite; }
  @keyframes tabpulse { 50% { opacity: .35; } }
  .tt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 14px), transparent); }
  .tx { flex: none; width: 24px; height: 24px; display: grid; place-items: center; border: 0; background: none; color: inherit; border-radius: 8px; opacity: 0; transition: opacity .12s, background .12s; }
  .tx svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; }
  .tab:hover .tx, .tab.cur .tx { opacity: 1; }
  .tx:hover { background: rgba(255,255,255,.12); color: var(--rj-text); }
  .tplus { flex: none; align-self: center; width: 30px; height: 30px; margin-left: 4px; display: grid; place-items: center; border-radius: 10px; background: transparent; border: 0; color: var(--rj-text-dim); }
  .tplus svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; }
  .tplus:hover { background: rgba(255,255,255,.08); color: var(--rj-text); }
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
</style>
