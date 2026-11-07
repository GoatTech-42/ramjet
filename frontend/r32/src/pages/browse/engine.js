import { pinControllerWorker } from './sw-worker-pin.js';
import { mintTicketUrl } from './tickets.mjs';

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

  async function makeTransport(Epoxy, bridgeBase, getAdOk) {
    // tickets are single-use and every mint fails closed - connecting on a burned or unticketed url
    // only hides the real error behind a refusal. the ws transport mints per socket open; curl and
    // epoxy modes mint once at construction and their internal reconnects reuse that url, so a
    // dropped underlying socket in those modes needs a reload.
    const mint = async () => {
      const m = await mintTicketUrl(fetch, bridgeBase, localStorage.getItem('rj-adblock') !== 'off');
      if (m.fail) {
        // keep the classification: a 401 stays no-retry through the throw
        const e = new TypeError(m.fail);
        e.noRetry = !!m.noRetry;
        throw e;
      }
      return m.url;
    };
    // mints after boot (socket open, proxied connect) get their own bound, so a stalled
    // ticket endpoint cannot hang a page load forever
    const boundedMint = () => Promise.race([mint(), new Promise((_, rej) => setTimeout(() => rej(new TypeError("the tunnel couldn't be reserved - try again")), 12000))]);
    // close() is terminal and shared by both branches that vend sockets: an in-flight mint never
    // publishes, a socket that opens late is shut instead of going live, and every proxied client
    // this transport handed out is closed with it.
    const state = { closed: false, proxied: new Set() };
    // per-socket terminal handling, centralized and idempotent. one record per connect,
    // registered the moment the tuple is handed out; one state: connecting -> terminal.
    // exactly-once rules: the handshake settles once (vendor onopen, or onerror - the vendored
    // connect rpc awaits one of those two and cannot settle on onclose alone); the page onclose
    // fires once; the vendor close runs once. late vendor open/message/close/error after
    // terminal are suppressed.
    const closeVendor = (ps, code, reason) => {
      if (ps.vendorClosed || !ps.tuple) return;
      ps.vendorClosed = true;
      // the vendored close is async (it awaits the handshake socket): consume both a
      // synchronous throw and a rejection of the promise it returns, or either escapes
      try { Promise.resolve(ps.tuple[1](code, reason)).catch(() => {}); } catch {}
    };
    const terminate = (ps, code, reason) => {
      if (ps.phase === 'terminal') return;
      ps.phase = 'terminal';
      state.proxied.delete(ps);
      if (!ps.settled) {
        // settle the handshake the vendored rpc is awaiting, then the close event the page needs
        ps.settled = true;
        try { ps.onerrorCb('connection dropped'); } catch {}
      }
      closeVendor(ps, code, reason);
      try { ps.pageClose(code, reason); } catch {}
    };
    const closeProxied = () => { for (const ps of [...state.proxied]) terminate(ps, 1000, ''); };
    const proxiedConnect = (url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) => {
      // the vendored controller destructures [send, close] from this return WITHOUT awaiting
      // it, so the tuple must come back synchronously. a ticket is single-use and epoxy binds
      // its url at init, so each proxied connect mints its own ticketed client behind the
      // closures - the same idiom the vendored epoxy transport uses for its own socket.
      if (state.closed) {
        try { onerror('connection dropped'); } catch {}
        try { onclose(1006, ''); } catch {}
        return [async () => { throw new TypeError('connection dropped'); }, async () => {}];
      }
      const ps = { phase: 'connecting', settled: false, vendorClosed: false, tuple: null, pageClose: onclose, onerrorCb: onerror };
      const dead = () => state.closed || ps.phase === 'terminal';
      state.proxied.add(ps); // registered at first call: a transport close owes this socket its settlement even while the mint pends
      const inner = (async () => {
        const wisp = await boundedMint();
        if (dead()) return null;
        const e = new Epoxy({ wisp });
        await e.init();
        if (dead()) return null;
        return e.connect(
          url, protocols, requestHeaders,
          (...a) => { if (dead()) return; ps.settled = true; onopen(...a); },
          (...a) => { if (!dead()) onmessage(...a); },
          (code, reason) => {
            // a vendor-initiated close is a terminal event; mid-handshake it also settles the rpc
            if (ps.phase === 'terminal') return;
            ps.phase = 'terminal';
            state.proxied.delete(ps);
            if (!ps.settled) { ps.settled = true; try { onerror('connection dropped'); } catch {} }
            try { onclose(code, reason); } catch {}
          },
          (...a) => {
            if (dead()) return;
            const unsettled = !ps.settled;
            ps.settled = true;
            if (unsettled) {
              // ownership ends BEFORE any external callback: a consumer reentering close from
              // its onerror finds a terminal record and cannot double-notify. the failed
              // handshake's socket is closed here too - owned, not assumed of the vendor
              ps.phase = 'terminal';
              state.proxied.delete(ps);
              closeVendor(ps, 1000, ''); // 1006 is reserved and not sendable on the wire; the page event below keeps it
            }
            try { onerror(...a); } catch {}
            // a failed handshake is followed by the close event - from us if the vendor sends none
            if (unsettled) { try { onclose(1006, ''); } catch {} }
          }
        );
      })();
      inner.then((t) => {
        if (!t) return;
        ps.tuple = t;
        // terminated while the vendor was still connecting: close its socket quietly - the
        // settlement and page close already happened
        if (dead()) closeVendor(ps, 1000, '');
      }, () => {});
      inner.catch((err) => {
        // initialization failed: settle the handshake, then the close event - never an
        // unhandled rejection, never a lost notification
        if (ps.phase === 'terminal') return;
        ps.phase = 'terminal';
        state.proxied.delete(ps);
        ps.settled = true;
        try { onerror(String((err && err.message) || err)); } catch {}
        try { onclose(1006, ''); } catch {}
      });
      return [
        async (data) => {
          if (dead()) throw new TypeError('connection dropped');
          const t = await inner.catch(() => null);
          if (!t || dead()) throw new TypeError('connection dropped');
          return t[0](data);
        },
        async (code, reason) => {
          // never rejects: the vendored consumer ignores this promise, so the terminal
          // notification must not depend on initialization succeeding. terminate first so a
          // pending mint or init aborts instead of constructing a socket nobody wants
          terminate(ps, code, reason);
          const t = await inner.catch(() => null);
          if (t) { if (!ps.tuple) ps.tuple = t; closeVendor(ps, code, reason); }
        },
      ];
    };
    // supported selections: 'ws' (the default) multiplexes pws frames over the ticketed bridge
    // socket, and 'server' relays through /api/pfetch - the two contracts the backend bridge
    // this page dials implements. it offers no stock wisp endpoint, so the vendored epoxy and
    // libcurl experiments, and any unrecognized value, would dial a socket that never answers.
    // fail closed with a clear message: no mint, no socket, and never silently substitute ws
    // for an explicit choice.
    const selectedTransport = localStorage.getItem('rj-transport');
    if (selectedTransport && selectedTransport !== 'ws' && selectedTransport !== 'server') {
      const e = new TypeError(
        `the '${selectedTransport === 'curl' ? 'libcurl' : selectedTransport}' transport selection isn't supported by this tunnel - its media bridge speaks only the multiplexed pws relay protocol, with no stock wisp endpoint to reach. set rj-transport back to 'ws' and reload`
      );
      e.noRetry = true;
      throw e;
    }
    if ((selectedTransport || 'ws') === 'ws') {
      const epoxy = new Epoxy({ wisp: bridgeBase });
      const ab = localStorage.getItem('rj-adblock') !== 'off';
      const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      let sock = null, opening = null, openingRej = null, pendingSock = null, nextId = 1;
      const pend = new Map();
      // the box tickets every socket open; a fresh ticket per open also spreads load across bridge backends
      const freshUrl = boundedMint;
      const open = () => {
        if (state.closed) return Promise.reject(new TypeError('connection dropped'));
        return sock && sock.readyState === 1 ? Promise.resolve(sock) : opening || (opening = freshUrl().then((url) => {
        if (state.closed) throw new TypeError('connection dropped'); // closed while the ticket minted: never open the socket
        return new Promise((res, rej) => {
        openingRej = rej; // close() rejects the opening request itself - no reliance on a late onopen
        const w = pendingSock = new WebSocket(url); w.binaryType = 'arraybuffer';
        w.onopen = () => { if (state.closed) { opening = null; openingRej = null; pendingSock = null; try { w.close(); } catch {} rej(new TypeError('connection dropped')); return; } pendingSock = null; openingRej = null; sock = w; opening = null; res(w); };
        w.onerror = () => { opening = null; openingRej = null; pendingSock = null; rej(new TypeError('connection failed')); };
        w.onclose = () => { sock = null; if (pendingSock === w) pendingSock = null; for (const [, p] of pend) p.fail('connection dropped'); pend.clear(); };
        w.onmessage = (ev) => {
          const dv = new DataView(ev.data); const id = dv.getUint32(0); const type = dv.getUint8(4); const p = pend.get(id);
          if (!p) return;
          if (type === 0) { const h = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 5))); p.head(h); }
          else if (type === 1) p.ctl?.enqueue(new Uint8Array(ev.data, 5));
          else if (type === 2) { pend.delete(id); try { p.ctl?.close(); } catch {} }
          else { pend.delete(id); p.fail(new TextDecoder().decode(new Uint8Array(ev.data, 5))); }
        };
        });
        }).catch((e) => { opening = null; throw e; }));
      };
      return {
        ready: false,
        async init() { await epoxy.init(); this.ready = true; },
        meta: () => epoxy.meta?.(),
        connect: proxiedConnect,
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
              fail: (m) => { if (!headed) reject(new TypeError('page failed to load: ' + m)); else { try { ctl.error(new TypeError(m)); } catch {} } },
            };
            pend.set(id, rec);
            if (signal) signal.addEventListener('abort', () => { pend.delete(id); try { w.send(JSON.stringify({ id, cancel: true })); } catch {} rec.fail('aborted'); }, { once: true });
            w.send(JSON.stringify({ id, url: remote.href, method, headers, body: b, ab: ab && !getAdOk() }));
          });
        },
        close() {
          state.closed = true;
          try { sock && sock.close(); } catch {}
          try { pendingSock && pendingSock.close(); } catch {}
          sock = null; pendingSock = null;
          if (openingRej) { const r = openingRej; openingRej = null; opening = null; r(new TypeError('connection dropped')); }
          for (const [, p] of pend) p.fail('connection dropped');
          pend.clear();
          closeProxied();
        },
      };
    }
    if (selectedTransport === 'server') {
      const epoxy = new Epoxy({ wisp: bridgeBase });
      const ab = localStorage.getItem('rj-adblock') !== 'off';
      const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      return {
        ready: false,
        async init() { await epoxy.init(); this.ready = true; },
        meta: () => epoxy.meta?.(),
        connect: proxiedConnect,
        async request(remote, method, body, headers, signal) {
          let b = null;
          if (body != null) {
            if (typeof body === 'string') b = btoa(unescape(encodeURIComponent(body)));
            else b = toB64(body instanceof Blob ? await body.arrayBuffer() : body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer());
          }
          if (state.closed) throw new TypeError('connection dropped');
          const r = await fetch('/api/pfetch', { method: 'POST', signal, body: JSON.stringify({ url: remote.href, method, headers, body: b, ab }) });
          const st = r.headers.get('x-rj-status');
          if (!st) throw new TypeError('page failed to load: ' + (r.headers.get('x-rj-error') || r.status));
          const raw = JSON.parse(atob(r.headers.get('x-rj-headers') || 'W10='));
          return { body: r.body, headers: raw, status: +st, statusText: decodeURIComponent(r.headers.get('x-rj-text') || '') };
        },
        close() { state.closed = true; closeProxied(); },
      };
    }
  }

  const loadScript = (src) => new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src; el.onload = () => res(); el.onerror = () => rej(new Error('some files did not load - check your connection and reload'));
    document.head.appendChild(el);
  });

export async function connect({ setBoot, cancelled, getAdOk }) {
        if (!('serviceWorker' in navigator)) return { fail: 'this browser is too old for browse' };
        // one total budget across everything below - assets, transport code, worker, ticket, probe,
        // warmup - not four separate clocks. every stage is raced against what is left, and when the
        // budget is spent an in-flight probe is closed so nothing keeps loading after the failure.
        const bootDeadline = Date.now() + 12000;
        const within = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('that took too long - reload to try again')), Math.max(1, bootDeadline - Date.now())))]);
        let abandonProbe = null;
        const kill = setTimeout(() => { try { abandonProbe && abandonProbe(); } catch {} }, 12000);
        setBoot('loading...');
        if (!globalThis.$scramjetController) {
          await within(loadScript('/assets/codec/codec.js'));
          await within(loadScript('/assets/player/api.js'));
        }
        const { Controller } = globalThis.$scramjetController || {};
        const EpoxyTransport = (await within(import(/* @vite-ignore */ '/assets/net/index.mjs'))).default;
        if (!Controller || !EpoxyTransport) return { fail: 'some files did not load - check your connection and reload' };
        setBoot('starting...');
        // the worker, the tunnel ticket and the url key are independent, so
        // they load together instead of one after another.
        // some browsers (iOS Safari) withhold cookies on websocket upgrades,
        // so the tunnel authenticates with a short-lived single-use ticket instead.
        const bridgeBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/media-bridge/';
        const t1P = mintTicketUrl(fetch, bridgeBase, localStorage.getItem('rj-adblock') !== 'off');
        const kkP = fetch('/api/apps/browse/urlkey').then((r) => r.json()).catch(() => ({}));
        const swP = (async () => {
          const reg = await navigator.serviceWorker.register('/a/player-boot.js');
          // the page sits outside the worker's /a/ scope, so serviceWorker.ready never settles here:
          // wait on this registration's own worker instead, with a timeout and a plain retryable error.
          if (reg.active && reg.active.state === 'activated') return { reg, worker: reg.active };
          return await new Promise((res, rej) => {
            const w = reg.installing || reg.waiting || reg.active;
            if (!w) return rej(new Error('worker did not start - reload to try again'));
            const t = setTimeout(() => rej(new Error('worker did not start in time - reload to try again')), 12000);
            const check = () => {
              if (w.state === 'activated') { clearTimeout(t); res({ reg, worker: w }); }
              else if (w.state === 'redundant') { clearTimeout(t); rej(new Error('worker failed - reload to try again')); }
            };
            w.addEventListener('statechange', check);
            check(); // it may have activated before the listener attached
          });
        })();
        const [swR, t1, kk] = await within(Promise.all([swP, t1P, kkP]));
        const sw = swR.worker;
        if (cancelled()) return {};
        if (t1.fail) { clearTimeout(kill); return { fail: t1.fail, noRetry: !!t1.noRetry }; }
        setBoot('connecting...');
        const urlCodec = kk.key ? makeUrlCodec(kk.key) : undefined;
        await within(new Promise((res, rej) => {
          const probe = new WebSocket(t1.url);
          const t = setTimeout(() => { try { probe.close(); } catch {} ; rej(new Error('connection timed out - this network may be blocking it')); }, 15000);
          abandonProbe = () => { clearTimeout(t); try { probe.close(); } catch {} };
          probe.onopen = () => { clearTimeout(t); probe.close(); res(); };
          probe.onerror = () => { /* onclose carries the detail */ };
          probe.onclose = (ev) => { clearTimeout(t); rej(new Error(`connection refused (code ${ev.code || 'none'})`)); };
        }));
        abandonProbe = null;
        if (cancelled()) return {};
        setBoot('warming up...');
        // ticket 2: the probe burned ticket 1 - the transport mints its own.
        const transport = await within(makeTransport(EpoxyTransport, bridgeBase, getAdOk));
        const controller = new Controller({ serviceworker: sw, transport, config: { prefix: '/a/r/', ...(urlCodec ? { codec: urlCodec } : {}) } });
        // an update replaces the worker object captured above; keep the
        // controller registering with the live worker of this registration.
        const unpin = pinControllerWorker(controller, swR.reg);
        try {
          await within(Promise.race([
            controller.wait(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('that took too long - reload to try again')), 15000)),
          ]));
        } catch (e) {
          // teardown for a failed or expired warmup: unpin (our added listener off), neuter the
          // vendored port setup so a late revive lands on a no-op, and close the transport, so the
          // next boot attempt does not overlap live work from this one. residual, flagged for
          // review rather than claimed gone: the vendored controller has no destroy api - its
          // anonymous sw message listener stays registered and its message ports stay open until
          // the page unloads, but the revive path now points at a no-op and the ui never
          // references this controller (ctrl is only set on success).
          unpin();
          try { controller.setupMessagePort = () => {}; } catch {}
          try { transport.close && transport.close(); } catch {}
          throw e;
        }
        if (cancelled()) { clearTimeout(kill); unpin(); try { controller.setupMessagePort = () => {}; } catch {} try { transport.close && transport.close(); } catch {} return {}; }
  clearTimeout(kill);
  return { controller };
}
