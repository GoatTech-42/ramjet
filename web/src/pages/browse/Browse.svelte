<script>
  import { modal } from '../../lib/modal.js';
  import { readSearches, addSearch, clearSearches } from '../../lib/searchhist.js';
  import Recent from '../../lib/Recent.svelte';
  let qf = $state(false);
  import '../../tokens.css';
  import AppFrame from '../../lib/AppFrame.svelte';
  import { onMount } from 'svelte';
  import { api, bounceToLoginOn401 } from '../../lib/api.js';
  // raw fetch sites (streams, one-shot tickets) get the same dead-session
  // bounce as the shared api helper
  const bfetch = async (path, opts) => { const r = await fetch(path, opts); bounceToLoginOn401(path, r.status); return r; };

  let address = $state('');
  let boot = $state('setting up...');
  let ready = $state(false);
  let failed = $state('');
  // revision failures (stale page scripts, superseded engine, worker swap)
  // can only converge with a fresh document: the retry button reloads.
  // transient same-revision failures (tunnel timeout, refused) just reboot.
  let failedKind = $state('transient');
  let stageEl = $state(null);
  let ctrl = null;

  // tabs: every tab is its own proxied iframe, kept
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
  // per-site "allow ads": the block list stays on everywhere
  // else. the choice is per device, kept in localStorage rj-ads-allow.
  let menuOpen = $state(false);
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
    setTimeout(() => cur()?.frame.reload(), 60);
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
  // address bar follows the page: the proxied frame's document
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
        if (t && id === activeId && !cloaked) document.title = t + ' - browse';
      } catch {}
    });
    live.set(id, { el, frame: fr, poll: setInterval(() => syncAddr(id), 400) });
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
    return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
  }


  // url encryption: a proxied address must not be readable in
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


  // tab cloak: one tap (or the ` key) and the tab reads as
  // homework - innocuous title + a docs-look icon, and proxied page titles
  // stop reaching the tab (and browser history) while it is on.
  const CLOAK_TITLE = 'Google Docs';
  const CLOAK_ICON = '/cloak/docs-32.png';
  let cloaked = $state(true);
  function applyCloak() {
    let link = document.querySelector("link[rel~='icon']");
    if (!link) { link = document.createElement('link'); link.setAttribute('rel', 'icon'); document.head.appendChild(link); }
    if (cloaked) { document.title = CLOAK_TITLE; link.href = CLOAK_ICON; }
    else { document.title = 'browse - ramjet'; link.href = '/favicon-32.png'; }
  }
  function toggleCloak() {
    cloaked = !cloaked;
    try { localStorage.setItem('rj-cloak', cloaked ? '1' : '0'); } catch {}
    applyCloak();
  }

  // cookie + localStorage cloud sync: admin account only -
  // the server 403s everyone else, so this silently turns itself off for
  // other users. restores before the first navigation, pushes every 15s and
  // on tab close. last writer wins.
  function startSync(controller) {
    (async () => {
      let on = false;
      try {
        const r = await bfetch('/api/apps/browse/sync');
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
            await bfetch('/api/apps/browse/sync', { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
          }
        } catch {}
      };
      setInterval(() => push(false), 15000);
      addEventListener('pagehide', () => push(true));
    })();
  }

  // the epoxy engine (~1.7MB of wasm/js) is only fetched and parsed when a
  // transport actually needs it: the default tunnel transport fetches and
  // relays websockets box-side over the one multiplexed socket, so epoxy
  // only lazy-loads when rj-transport = 'epoxy' (or when the server fallback
  // transport's connect path is exercised).
  let epoxyP = null;
  const loadEpoxy = () => epoxyP || (epoxyP = import(/* @vite-ignore */ '/epoxy/index.mjs?v=' + ((globalThis.__RJ_ENGINE__) || '0')).then((m) => m.default));
  // transport: ws (default, box-side fetch over one multiplexed socket, with a box-side asset cache), epoxy (set rj-transport=epoxy) or libcurl (http/2 + connection reuse). pick with
  // localStorage rj-transport = 'curl' while it is being compared.
  // version handshake with the active worker: the script url carrying the
  // stamp is necessary but the worker must also ANSWER at that stamp - an
  // old worker still controlling this tab says its own (old) version and
  // boot must not proceed mixed.
  async function verifyWorkerVersion(w, stamp, timeoutMs = 3000) {
    const got = await new Promise((res) => {
      const t = setTimeout(() => res(''), timeoutMs);
      let ch;
      try { ch = new MessageChannel(); } catch { clearTimeout(t); res(''); return; }
      ch.port1.onmessage = (ev) => { clearTimeout(t); res((ev.data && ev.data.$rjVersion) || ''); };
      try { w.postMessage({ $rjVersionCheck: 1 }, [ch.port2]); } catch { clearTimeout(t); res(''); }
    });
    return got === stamp;
  }

  // register() alone can hand back last deploy's ACTIVE worker while the new
  // stamped revision is still installing, and navigator.serviceWorker.ready
  // doesn't wait for the new revision either - wiring the controller against
  // the old worker pairs new page code with the old engine. wait until the
  // active worker's script url is exactly the requested stamped one.
  async function waitForWorker(swUrl, timeoutMs = 12000) {
    const wanted = new URL(swUrl, location.href).href;
    const reg = await navigator.serviceWorker.register(swUrl);
    if (reg.active && reg.active.scriptURL === wanted && reg.active.state === 'activated') return reg.active;
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('worker did not start in time')), timeoutMs);
      const checkActive = () => {
        const a = reg.active;
        if (a && a.scriptURL === wanted && a.state === 'activated') { clearTimeout(t); res(a); return true; }
        return false;
      };
      let watched = null;
      const watch = (w) => {
        if (!w || w === watched) return;
        watched = w;
        w.addEventListener('statechange', () => {
          if (w.state === 'activated') checkActive();
          if (w.state === 'redundant' && w.scriptURL === wanted) { clearTimeout(t); rej(new Error('service worker failed')); }
        });
      };
      if (!checkActive()) {
        watch(reg.installing || reg.waiting);
        reg.addEventListener('updatefound', () => watch(reg.installing));
      }
    });
  }

  // Activation and clients.claim() are separate lifecycle steps. A returning
  // page can see the new reg.active while its controller is still the old
  // worker. Never build a transport until the exact worker owns this page.
  async function waitForController(worker, timeoutMs = 12000) {
    const service = navigator.serviceWorker;
    if (service.controller === worker) return;
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); service.removeEventListener('controllerchange', check); };
      const check = () => { if (service.controller === worker) { cleanup(); resolve(); } };
      timer = setTimeout(() => { cleanup(); reject(new Error('proxy worker takeover timed out')); }, timeoutMs);
      service.addEventListener('controllerchange', check);
      check(); // closes the check/listener race
    });
  }

  // a new worker taking over mid-session means a deploy landed: this tab's
  // page code is now paired with a worker it never handshook with. the first
  // controllerchange is just the initial claim at boot - only a takeover
  // after that tears the tunnel down and asks for a reload.
  function makeControllerGuard(onTakeover) {
    let had = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    return () => { if (!had) { had = true; return; } onTakeover(); };
  }

  // the committing worker must be the controller that actually holds the
  // page: strict identity, so even a same-scriptURL replacement (a restart
  // that re-installed identical bytes) can never double-publish ready
  // against the worker that left
  function sameWorker(a, b) {
    return !!(a && b) && a === b;
  }

  async function makeTransport(wisp, seed) {
    if ((localStorage.getItem('rj-transport') || 'ws') === 'ws') {
      const ab = localStorage.getItem('rj-adblock') !== 'off';
      // tunnel urls are built from the base + a real ticket, never by
      // rewriting the wisp url in place: without a ticket there is no valid
      // pws url at all, and opening one anyway would silently land on the
      // wrong (wisp) protocol endpoint and falsely "prove" connectivity.
      const wm = /^(.*)\/wisp-t\/([^/]+)\//.exec(wisp) || /^(.*)\/wisp\//.exec(wisp) || [null, wisp, null];
      const wsBase = wm[1];
      const ticketUrl = (t) => `${wsBase}/pws-t/${t}/`;
      // the seeded boot ticket is spent on its FIRST socket and only while it
      // cannot have expired server-side: the seed carries the ticket's
      // receipt time (90s server life, 30s safety margin), and every later
      // open (reconnects included) fetches a fresh ticket.
      let seedTicket = (seed && seed.ticket) || wm[2] || null;
      // an unverifiable seed age must fail safe: treat it as expired and
      // refresh, never as fresh
      const seedAt = (seed && Number.isFinite(seed.at)) ? seed.at : -Infinity;
      let seedUsed = false;
      const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      let sock = null, opening = null, openingSock = null, nextId = 1, disposed = false;
      const pend = new Map();
      const urlForOpen = async () => {
        if (!seedUsed && seedTicket && Date.now() - seedAt <= 60000) { seedUsed = true; return ticketUrl(seedTicket); }
        seedUsed = true;
        const r = await bfetch('/api/wisp-ticket' + (ab ? '' : '?ab=0'));
        const j = await r.json();
        if (!j || !j.ticket) throw new TypeError('no proxy ticket');
        return ticketUrl(j.ticket);
      };
      const wsMsg = (obj) => open().then((w) => { if (w.readyState === 1) w.send(JSON.stringify(obj)); }).catch(() => {});
      const open = () => {
        if (disposed) return Promise.reject(new TypeError('proxy socket disposed'));
        if (sock && sock.readyState === 1) return Promise.resolve(sock);
        return opening || (opening = urlForOpen().then((url) => {
          // disposed while the ticket fetch was in flight: never open
          if (disposed) throw new TypeError('proxy socket disposed');
          return new Promise((res, rej) => {
          const w = new WebSocket(url); openingSock = w; w.binaryType = 'arraybuffer';
          w.onopen = () => { opening = null; openingSock = null; if (disposed) { try { w.close(); } catch {} rej(new TypeError('proxy socket disposed')); return; } sock = w; res(w); };
          w.onerror = () => { opening = null; openingSock = null; rej(new TypeError('proxy socket failed')); };
          w.onclose = () => {
            if (openingSock === w) openingSock = null;
            if (sock === w) sock = null;
            else { opening = null; rej(new TypeError('proxy socket closed before open')); }
            for (const [, p] of pend) p.fail('proxy socket closed'); pend.clear();
          };
        w.onmessage = (ev) => {
          const dv = new DataView(ev.data); const id = dv.getUint32(0); const type = dv.getUint8(4); const p = pend.get(id);
          if (!p) return;
          if (p.ws) {
            // relayed websocket stream: head carries the negotiated protocol,
            // data frames are [kind, ...bytes] (0 text / 1 binary), end
            // carries the close code/reason, fail is the error text
            if (type === 0) { clearTimeout(p.wall); const h = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 5))); p.ws.onopen(h.protocol || '', ''); }
            else if (type === 1) { const u8 = new Uint8Array(ev.data, 5); if (u8[0] === 0) p.ws.onmessage(new TextDecoder().decode(u8.subarray(1))); else p.ws.onmessage(ev.data.slice(6)); }
            else if (type === 2) { clearTimeout(p.wall); pend.delete(id); let c = 1006, r = ''; try { const j = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 5))); c = j.code; r = j.reason; } catch {} p.ws.onclose(c, r); }
            else { clearTimeout(p.wall); pend.delete(id); p.ws.onerror(new TextDecoder().decode(new Uint8Array(ev.data, 5))); }
            return;
          }
          if (type === 0) { const h = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 5))); p.head(h); }
          else if (type === 1) p.ctl?.enqueue(new Uint8Array(ev.data, 5));
          else if (type === 2) { clearTimeout(p.wall); pend.delete(id); try { p.ctl?.close(); } catch {} }
          else { clearTimeout(p.wall); pend.delete(id); p.fail(new TextDecoder().decode(new Uint8Array(ev.data, 5))); }
        };
          });
        }).catch((e) => { opening = null; throw e; }));
      };
      return {
        ready: true,
        async init() {}, // nothing to warm: requests ride the one tunnel socket
        // opens the multiplexed tunnel socket up front so boot can prove
        // connectivity (and the first page never pays the connect cost)
        // without a disposable probe socket or a second ticket fetch.
        warm: () => open(),
        // full teardown: close the live socket, cancel a socket still
        // opening (a late open is closed the moment it lands), and fail
        // every pending request. after dispose the transport is dead:
        // boot calls this on warm timeout/failure and on page teardown so
        // no orphan socket can survive a retry or an unmount.
        dispose: () => {
          disposed = true;
          const w = sock; sock = null;
          if (w) { try { w.close(); } catch {} }
          // a socket still CONNECTING is closed now, not when it lands
          const c = openingSock; openingSock = null;
          if (c) { try { c.close(); } catch {} }
          const o = opening; opening = null;
          if (o) o.then((late) => { try { late.close(); } catch {} }, () => {});
          for (const [, p] of pend) p.fail('transport disposed');
          pend.clear();
        },
        meta: () => undefined, // epoxy meta only exists after a lazy connect
        // proxied websockets ride the same multiplexed socket: one browser
        // connection, box-side relay, no epoxy on the default path. connect
        // must return the [send, close] tuple synchronously (the controller
        // destructures it); sends queue behind the tunnel opening.
        connect: (url, protocols, headers, onopen, onmessage, onclose, onerror) => {
          const id = nextId++;
          // the tunnel always answers a connect - but when it cannot (a shed
          // terminal frame on a flooded socket), the page must not hang
          const wall = setTimeout(() => { if (pend.delete(id)) { wsMsg({ id, cancel: true }); try { onerror('proxy connect timed out'); } catch {} } }, 60000);
          pend.set(id, { ws: { onopen, onmessage, onclose, onerror }, wall, fail: (m) => { clearTimeout(wall); try { onerror(m); } catch {} } });
          // a connect that timed out while the tunnel was opening must never
          // reach the box late: the pend is gone, so this send is blocked
          open().then((w) => { if (w.readyState === 1 && pend.has(id)) w.send(JSON.stringify({ id, ws: url.href, protocols: protocols || [], headers: headers || [] })); }).catch(() => {});
          return [
            async (d) => {
              let b64; const text = typeof d === 'string';
              if (text) b64 = btoa(unescape(encodeURIComponent(d)));
              else { const buf = d instanceof Blob ? await d.arrayBuffer() : d instanceof ArrayBuffer ? d : ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d; b64 = toB64(buf); }
              await wsMsg({ id, wssend: b64, text });
            },
            async (c, r) => { await wsMsg({ id, wsclose: { code: c || 1000, reason: r || '' } }); },
          ];
        },
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
            const stream = new ReadableStream({ start(c) { ctl = c; }, cancel() { pend.delete(id); clearTimeout(rec.wall); try { w.send(JSON.stringify({ id, cancel: true })); } catch {} } });
            const rec = {
              get ctl() { return ctl; },
              // slightly past the box's own 300s request wall: the answer
              // always arrives - but a dropped terminal frame must not hang
              // the page forever
              wall: setTimeout(() => { if (pend.delete(id)) { wsMsg({ id, cancel: true }); rec.fail('proxy request timed out'); } }, 330000),
              head: (h) => { headed = true; resolve({ body: stream, headers: h.headers, status: h.status, statusText: h.text || '' }); },
              fail: (m) => { clearTimeout(rec.wall); if (!headed) reject(new TypeError('proxy fetch failed: ' + m)); else { try { ctl.error(new TypeError(m)); } catch {} } },
            };
            pend.set(id, rec);
            if (signal) signal.addEventListener('abort', () => { pend.delete(id); try { w.send(JSON.stringify({ id, cancel: true })); } catch {} rec.fail('aborted'); }, { once: true });
            w.send(JSON.stringify({ id, url: remote.href, method, headers, body: b, ab: ab && !adOk }));
          });
        },
      };
    }
    if (localStorage.getItem('rj-transport') === 'curl') {
      const url = '/libcurl/index.mjs?v=' + ((globalThis.__RJ_ENGINE__) || '0');
      const m = await import(/* @vite-ignore */ url);
      return new m.default({ wisp });
    }
    if (localStorage.getItem('rj-transport') === 'server') {
      let disposed = false;
      const openConns = new Set();
      let epP = null;
      // dispose owns freeing the instance (via epP) so it happens exactly once
      const epoxyForConnect = () => epP || (epP = (async () => { const inst = new (await loadEpoxy())({ wisp }); await inst.init?.(); return inst; })());
      const ab = localStorage.getItem('rj-adblock') !== 'off';
      const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      return {
        ready: true,
        async init() {},
        meta: () => undefined, // epoxy meta only exists after a lazy connect
        // takeover and teardown call dispose() unconditionally: close every
        // tracked connection and refuse new ones
        dispose: () => {
          disposed = true;
          for (const close of openConns) { try { close(1000, 'transport disposed'); } catch {} }
          openConns.clear();
          if (epP) epP.then((inst) => { try { inst.free?.(); } catch {} }, () => {});
        },
        // connect must return the [send, close] tuple synchronously (the
        // controller destructures it); only send/close may await the lazy
        // epoxy init.
        connect: (...a) => {
          if (disposed) throw new TypeError('proxy transport disposed');
          let inner = null;
          const ready = epoxyForConnect().then((inst) => {
            // dispose can land while the lazy init is in flight: a late
            // continuation must never open a connection teardown gave up on
            if (disposed) { try { a[6]?.(new TypeError('proxy transport disposed')); } catch {} return; }
            inner = inst.connect(...a);
            openConns.add(inner[1]);
          }).catch((e) => { try { a[6]?.(e); } catch {} });
          // epoxy's wasm send accepts string/ArrayBuffer/Blob but rejects
          // Uint8Array views; normalize views to a sliced ArrayBuffer.
          const norm = async (d) => {
            if (d instanceof Blob) return await d.arrayBuffer();
            if (typeof d === 'string' || d instanceof ArrayBuffer) return d;
            if (ArrayBuffer.isView(d)) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
            return d;
          };
          return [
            async (d) => { await ready; if (!inner) throw new TypeError('proxy transport disposed'); return inner[0](await norm(d)); },
            async (c, r) => { await ready; if (!inner) return; return inner[1](c, r); },
          ];
        },
        async request(remote, method, body, headers, signal) {
          let b = null;
          if (body != null) {
            if (typeof body === 'string') b = btoa(unescape(encodeURIComponent(body)));
            else b = toB64(body instanceof Blob ? await body.arrayBuffer() : body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
          }
          if (disposed) throw new TypeError('proxy transport disposed');
          const r = await bfetch('/api/pfetch', { method: 'POST', signal, body: JSON.stringify({ url: remote.href, method, headers, body: b, ab }) });
          const st = r.headers.get('x-rj-status');
          if (!st) throw new TypeError('proxy fetch failed: ' + (r.headers.get('x-rj-error') || r.status));
          const raw = JSON.parse(atob(r.headers.get('x-rj-headers') || 'W10='));
          return { body: r.body, headers: raw, status: +st, statusText: decodeURIComponent(r.headers.get('x-rj-text') || '') };
        },
      };
    }
    const inst = new (await loadEpoxy())({ wisp });
    await inst.init?.();
    return inst;
  }

  // every boot cycle owns its generation: cancellation and the transport
  // live in a per-cycle closure, never component-global - an old cycle's
  // awaited work can never resume "uncancelled" after a restart resets
  // shared state, nor dispose the new cycle's transport. the guard reaches
  // the live cycle through currentCycle only.
  let currentCycle = null;
  // bumped by the controllerchange guard on a mid-boot worker swap: the
  // effect depends on it, so a swap tears the in-flight boot down (cleanup
  // cancels + disposes) and boots again against the new controller instead
  // of ever publishing ready against the worker that just left
  let bootCycle = $state(0);

  $effect(() => {
    if (!stageEl) return;
    void bootCycle; // tracked: the controllerchange guard restarts the boot by bumping this
    const cycle = { cancelled: false, transport: null };
    currentCycle = cycle;
    let attempts = 0;
    const bootOnce = async () => {
      try {
        failed = ''; failedKind = 'transient'; // a (re)boot supersedes any earlier failure copy
        if (!('serviceWorker' in navigator)) { failed = 'this browser is too old for browse'; return; }
        boot = 'loading the engine...'; window.__rjBootPhase = 'engine';
        // safe lookup: the engine script not loading at all (deploy swapped
        // the stamped urls, blocked script) must not throw into the catch as
        // a generic transient error - it is exactly the revision case
        const Controller = globalThis.$scramjetController?.Controller;
        if (!Controller) { failed = 'engine files did not load - check your connection and reload'; failedKind = 'revision'; return; }
        boot = 'starting the worker...'; window.__rjBootPhase = 'worker';
        // the worker, the tunnel ticket and the url key are independent, so
        // they load together instead of one after another.
        // some browsers (iOS Safari) withhold cookies on websocket upgrades,
        // so the tunnel authenticates with a short-lived ticket instead.
        // stamped at request START: the server mints the ticket when the
        // request lands, so a slow response must not make the ticket look
        // younger than it is
        const tkAt = Date.now();
        const tkP = bfetch('/api/wisp-ticket' + (localStorage.getItem('rj-adblock') === 'off' ? '?ab=0' : '')).then(async (r) => ({ ...(await r.json()), at: tkAt })).catch(() => ({}));
        const kkP = bfetch('/api/apps/browse/urlkey').then((r) => r.json()).catch(() => ({}));
        const swP = (async () => {
          const w0 = await waitForWorker('/browse-sw.js?v=' + ((globalThis.__RJ_ENGINE__) || '0'));
          await navigator.serviceWorker.ready;
          await waitForController(w0);
          return w0;
        })();
        const [sw, tk, kk] = await Promise.all([swP, tkP, kkP]);
        if (cycle.cancelled) return;
        // the worker must answer at this page's stamp before any engine
        // wiring: a mismatch means a stale worker/tab mix - reload once to
        // converge, then fail loudly instead of ever running mixed.
        if (!(await verifyWorkerVersion(sw, (globalThis.__RJ_ENGINE__) || '0'))) {
          if (!sessionStorage.getItem('rj-sw-reload')) { try { sessionStorage.setItem('rj-sw-reload', '1'); } catch {} location.reload(); return; }
          failed = 'the proxy engine is out of date - close this tab and open browse again';
          failedKind = 'revision';
          return;
        }
        try { sessionStorage.removeItem('rj-sw-reload'); } catch {}
        if (cycle.cancelled) return; // the handshake await is a cancellation window too
        boot = 'connecting...'; window.__rjBootPhase = 'warm';
        const urlCodec = kk.key ? makeUrlCodec(kk.key) : undefined;
        const wispBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
        const wispUrl = tk.ticket ? `${wispBase}/wisp-t/${tk.ticket}/` : `${wispBase}/wisp/`;
        const transport = await makeTransport(wispUrl, { ticket: tk.ticket, at: tk.at });
        // every transport carries a dispose: takeover/teardown must never
        // depend on what a vendor transport happens to implement. a vendor
        // transport without one gets a dead switch (late calls reject) plus
        // a best-effort wasm free.
        if (typeof transport.dispose !== 'function') {
          let dead = false;
          for (const k of ['request', 'connect']) {
            if (typeof transport[k] === 'function') { const orig = transport[k].bind(transport); transport[k] = (...a) => { if (dead) throw new TypeError('proxy transport disposed'); return orig(...a); }; }
          }
          transport.dispose = () => { dead = true; try { transport.free?.(); } catch {} };
        }
        // construction is itself async (curl import / epoxy init): a cleanup
        // during it disposed nothing (cycle.transport was still null), so the
        // late-arriving resource is this cycle's to tear down - never warm it
        if (cycle.cancelled) { try { transport.dispose?.(); } catch {} return; }
        cycle.transport = transport;
        // connectivity proof: the default tunnel proves itself by opening the
        // one multiplexed socket it will actually use - no disposable probe
        // socket, no second ticket fetch. the throwaway probe only remains
        // for the wisp-based transports, which need it. a timed-out or
        // refused warm tears the transport down so no late-opening orphan
        // socket can leak into the retry.
        if ((localStorage.getItem('rj-transport') || 'ws') === 'ws') {
          await new Promise((res, rej) => {
            const bail = (e) => { try { transport.dispose?.(); } catch {} rej(e); };
            const t = setTimeout(() => bail(new Error('the tunnel timed out after 15s - this network may be blocking websockets')), 15000);
            transport.warm().then(() => { clearTimeout(t); res(); }, () => { clearTimeout(t); bail(new Error('the tunnel was refused')); });
          });
        } else {
          // the probe must burn its OWN ticket: tickets are single-use
          // server-side, so a probe on wispUrl would consume the ticket the
          // real transport is about to connect with. no fresh ticket ->
          // probe the bare endpoint (never wispUrl, which holds the ticket)
          const pt = await bfetch('/api/wisp-ticket' + (localStorage.getItem('rj-adblock') === 'off' ? '?ab=0' : '')).then((r) => r.json()).catch(() => ({}));
          if (cycle.cancelled) return;
          const probeUrl = pt.ticket ? `${wispBase}/wisp-t/${pt.ticket}/` : `${wispBase}/wisp/`;
          await new Promise((res, rej) => {
            const probe = new WebSocket(probeUrl);
            const t = setTimeout(() => { try { probe.close(); } catch {} ; rej(new Error('the tunnel timed out after 15s - this network may be blocking websockets')); }, 15000);
            probe.onopen = () => { clearTimeout(t); probe.close(); res(); };
            probe.onerror = () => { /* onclose carries the detail */ };
            probe.onclose = (ev) => { clearTimeout(t); rej(new Error(`the tunnel was refused (code ${ev.code || 'none'})`)); };
          });
        }
        if (cycle.cancelled) return;
        boot = 'waking the proxy...'; window.__rjBootPhase = 'controllerwait';
        // every engine asset the controller loads (engine, inject, wasm)
        // rides the build stamp - unversioned defaults could pair this
        // deploy's page with whatever bytes a cache kept from the last one
        const ev = '?v=' + ((globalThis.__RJ_ENGINE__) || '0');
        const controller = new Controller({ serviceworker: sw, transport, config: { scramjetPath: '/scramjet/scramjet.js' + ev, injectPath: '/controller/controller.inject.js' + ev, wasmPath: '/scramjet/scramjet.wasm' + ev, ...(urlCodec ? { codec: urlCodec } : {}) } });
        await Promise.race([
          controller.wait(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('the proxy did not wake in time - reload to try again')), 15000)),
        ]);
        if (cycle.cancelled) return;
        // bind the commit to the handshook controller: a swap that slipped
        // past the event guard (or raced it) must restart the boot, never
        // publish ready against a dead page/worker pairing
        if (!sameWorker(navigator.serviceWorker.controller, sw)) {
          // An event can race controller.wait(). Re-enter the lifecycle wait
          // with a new cycle instead of retrying the stale worker/transport.
          bootCycle += 1;
          return;
        }
        ctrl = controller;
        startSync(controller);
        newTab();
        ready = true; boot = ''; window.__rjBootPhase = 'ready';
        try { const h = new URLSearchParams(location.search).get('q') || sessionStorage.getItem('rj-open'); if (h) { sessionStorage.removeItem('rj-open'); setTimeout(() => { address = h; go(); }, 80); } } catch {}
      } catch (e) {
        // a failed boot attempt must not leave its transport (and its
        // socket) alive behind the retry
        try { cycle.transport?.dispose?.(); } catch {}
        cycle.transport = null;
        // a cancelled boot (worker swap restart / unmount) owns no state:
        // the next cycle must never see its failure copy
        if (cycle.cancelled) return;
        if (attempts < 2) { // one automatic retry, then give up loudly
          attempts += 1;
          boot = 'retrying...';
          await new Promise((r) => setTimeout(r, 2500));
          if (!cycle.cancelled) return bootOnce();
          return;
        }
        failed = (e && e.message) ? e.message : 'browse could not start - reload to try again';
        // a worker that will not start for this page's stamp is a revision
        // problem (deploy swapped the stamped urls) - only a reload converges
        if (/worker/i.test(failed)) failedKind = 'revision';
        boot = '';
      }
    };
    bootOnce();
    return () => {
      cycle.cancelled = true;
      try { cycle.transport?.dispose?.(); } catch {}
      if (currentCycle === cycle) currentCycle = null;
    };
  });

  // recent sites: this device only (localStorage), host-level, never recorded
  // while the tab cloak is on, one tap to clear.
  let recents = $state([]);
  try { const a = JSON.parse(localStorage.getItem('rj-browse-recent') || '[]'); recents = (Array.isArray(a) ? a : []).filter((r) => r && typeof r.name === 'string' && typeof r.url === 'string').slice(0, 30); } catch {}
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
    v.el.src = '/browse-reader/reader?u=' + encodeURIComponent(u);
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
    try { document.getElementById('br-omni')?.blur(); } catch {}
    syncDisplay();
    if (url.startsWith('/browse-reader/')) { v.el.src = url; return; }
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
    try { navigator.serviceWorker.addEventListener('message', (e) => onDl(e.data && e.data.rjdl)); } catch {}
    try {
      navigator.serviceWorker.addEventListener('controllerchange', makeControllerGuard(() => {
        if (!ready) {
          // a controller swap mid-boot is NOT safe to ignore: once the page
          // has verified and handshook a worker, that pairing is captured -
          // if the controller changes before ready publishes, the boot must
          // restart against the new worker (the effect cleanup cancels the
          // in-flight boot and disposes its transport)
          bootCycle += 1;
          return;
        }
        // a takeover of a RUNNING session is a mixed-revision hazard
        if (currentCycle) currentCycle.cancelled = true;
        try { currentCycle?.transport?.dispose?.(); } catch {}
        ready = false; boot = '';
        failed = 'ramjet updated - reload to pick up the new version';
        failedKind = 'revision';
      }));
    } catch {}
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

<AppFrame active="/browse">
<div class="shell" class:surfing>
  <div class="chrome">
  <header>
    <a class="back" href="/" title="back to ramjet" aria-label="back to ramjet"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg></a>
    <div class="navbtns dnav">
      <button onclick={() => cur()?.frame.back()} title="back" aria-label="back"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg></button>
      <button onclick={() => cur()?.frame.forward()} title="forward" aria-label="forward"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-6-6m6 6-6 6" /></svg></button>
      <button onclick={() => cur()?.frame.reload()} title="reload" aria-label="reload"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg></button>
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
          <button onclick={() => cur()?.frame.back()} aria-label="back"><svg viewBox="0 0 24 24"><path d="M19 12H5m0 0 6-6m-6 6 6 6" /></svg></button>
          <button onclick={() => cur()?.frame.forward()} aria-label="forward"><svg viewBox="0 0 24 24"><path d="M5 12h14m0 0-6-6m6 6-6 6" /></svg></button>
          <button onclick={() => cur()?.frame.reload()} aria-label="reload"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg></button>
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
        <button class="mi" class:on={cloaked} onclick={() => { menuOpen = false; toggleCloak(); }}><svg viewBox="0 0 24 24"><path d="M12 4c-5 0-9 4-10 9 1-5 5-8 10-8s9 3 10 8c-1-5-5-9-10-9zm0 5a4 4 0 1 0 4 4 4 4 0 0 0-4-4zm0 2a2 2 0 1 1-2 2 2 2 0 0 1 2-2z" /></svg><span>{cloaked ? 'uncloak this tab' : 'cloak this tab'}</span></button>
      </div>
    {/if}
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
  </div>

  {#if failed}
    <div class="center">
      <p class="dim">{failed}</p>
      <!-- same restart the worker-takeover guard uses: bump bootCycle, the
           boot effect tears down and starts clean - no full page reload -->
      <div class="chips"><button class="chip" onclick={() => { if (failedKind === 'revision') { location.reload(); } else { failed = ''; bootCycle += 1; } }}>try again</button></div>
    </div>
  {:else if !surfing}
    <div class="center home">
      <h1>Browse</h1>
      <p class="dim">{boot || 'The open web. Your way.'}</p>
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
      <div class="hsheet" role="dialog" aria-modal="true" aria-label="downloads" tabindex="-1" use:modal={() => { dlOpen = false; }} onkeydown={(e) => e.stopPropagation()} onclick={(e) => e.stopPropagation()}>
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
      <div class="hsheet" role="dialog" aria-modal="true" aria-label="history" tabindex="-1" use:modal={() => { histOpen = false; }} onkeydown={(e) => e.stopPropagation()} onclick={(e) => e.stopPropagation()}>
        <div class="hhead"><b>history</b><button class="hclose" onclick={() => (histOpen = false)} aria-label="close">&times;</button></div>
        {#if closed.length}
          <p class="hsec">recently closed</p>
          {#each closed as c, i}
            <button class="hrow" onclick={() => reopenClosed(i)}><span class="ht">{c.title || hostShort(c.url)}</span><span class="hu">{hostShort(c.url)}</span></button>
          {/each}
        {/if}
        <input class="hq" aria-label="Search your history" placeholder="search your history" bind:value={histQ} />
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

</AppFrame>

<style>
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
  .navbtns { display: flex; gap: 4px; margin-left: 6px; }
  .navbtns button {
    background: var(--rj-surface); border: 1px solid var(--rj-border); color: var(--rj-text);
    width: 32px; height: 32px; border-radius: var(--rj-pill); font-size: 14px; line-height: 1;
  }
  .navbtns button:hover { background: var(--rj-surface-2); }
  .navbtns button { display: grid; place-items: center; }
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
  .hov { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.6); display: flex; align-items: flex-end; justify-content: center; }
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
    header { flex-wrap: wrap; }
    form { order: 3; flex: 1 1 100%; }
    .navbtns { flex: 1; margin-left: 0; }
    .home h1 { font-size: 34px; }
  }
  input { font-size: 16px; }
  input::placeholder { color: var(--rj-text-faint); opacity: 1; }
  input:focus { border-color: var(--rj-accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--rj-accent) 22%, transparent); }
  header form input { padding: 10px 18px; }
  @media (max-width: 700px) {
    header { flex-wrap: wrap; row-gap: 8px; }
    header form { order: 5; flex: 1 1 100%; }
    header form input { height: 44px; }
    header form .go { height: 44px; }
    .navbtns { margin-left: auto; }
  }

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
  .tab:hover:not(.cur) { background: rgba(255,255,255,.06); }
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

  .shell { height: 100dvh; min-height: 0; }
  .chrome { padding: 12px 12px 0; background: var(--rj-glass); border-bottom: 1px solid var(--rj-border); }
  header { padding: 4px 4px 12px; max-width: 100%; } header>.back { display: none; }
  header form.omni { border-radius: 16px; background: var(--rj-surface); padding: 5px; gap: 4px; }
  header form.omni input { height: 42px; padding: 0 12px; } header form.omni .go { border-radius: 11px; height: 42px; }
  .navbtns button,.menub { width: 40px; height: 40px; } .tabbar { padding: 4px 4px 0; } .tab { border-radius: 12px 12px 0 0; }
  .home { width: min(740px,100%); margin: 0 auto; align-items: flex-start; gap: 16px; padding: 48px 32px; }
  .home h1 { font-size: 38px; font-weight: 600; letter-spacing: -.045em; } .home>.dim { margin: 0 0 20px; font-size: 16px; line-height: 1.6; }
  .home .chips { justify-content: flex-start; gap: 10px; } .chip { padding: 10px 16px; min-height: 40px; }
  .menu { background: var(--rj-surface); box-shadow: var(--rj-shadow); border-radius: 16px; } .menu .mi { min-height: 44px; }
  .bm-toast { bottom: 28px; } .techchip { left: 120px; }
  @media(max-width:760px) { .shell { height: calc(100dvh - 90px - env(safe-area-inset-bottom)); } .chrome { padding: 10px 8px 0; } header { gap: 6px; } .home { padding: 36px 24px; } .home h1 { font-size: 32px; } .bm-toast { bottom: calc(100px + env(safe-area-inset-bottom)); } .techchip { left: 12px; bottom: calc(94px + env(safe-area-inset-bottom)); } }
  .chrome { background: linear-gradient(to bottom, color-mix(in srgb, var(--rj-glass) 35%, transparent), transparent); border-bottom-color: color-mix(in srgb, var(--rj-border) 45%, transparent); }
</style>
