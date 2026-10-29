import { pinControllerWorker } from './sw-worker-pin.js';

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

  async function makeTransport(Epoxy, wisp, getAdOk) {
    if ((localStorage.getItem('rj-transport') || 'ws') === 'ws') {
      const epoxy = new Epoxy({ wisp });
      const ab = localStorage.getItem('rj-adblock') !== 'off';
      const pwsUrl = wisp;
      const toB64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
      let sock = null, opening = null, nextId = 1;
      const pend = new Map();
      const freshUrl = async () => { try { const r = await fetch('/api/media-bridge/ticket' + (ab ? '' : '?ab=0'), { method: 'POST', headers: { 'X-Ramjet-JS': '1' } }); const j = await r.json(); if (j && j.ticket) return pwsUrl.replace(/\/api\/media-bridge\/[a-f0-9]+/, '/api/media-bridge/' + j.ticket); } catch {} return pwsUrl; };
      const open = () => sock && sock.readyState === 1 ? Promise.resolve(sock) : opening || (opening = freshUrl().then((url) => new Promise((res, rej) => {
        const w = new WebSocket(url); w.binaryType = 'arraybuffer';
        w.onopen = () => { sock = w; opening = null; res(w); };
        w.onerror = () => { opening = null; rej(new TypeError('connection failed')); };
        w.onclose = () => { sock = null; for (const [, p] of pend) p.fail('connection dropped'); pend.clear(); };
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
              fail: (m) => { if (!headed) reject(new TypeError('page failed to load: ' + m)); else { try { ctl.error(new TypeError(m)); } catch {} } },
            };
            pend.set(id, rec);
            if (signal) signal.addEventListener('abort', () => { pend.delete(id); try { w.send(JSON.stringify({ id, cancel: true })); } catch {} rec.fail('aborted'); }, { once: true });
            w.send(JSON.stringify({ id, url: remote.href, method, headers, body: b, ab: ab && !getAdOk() }));
          });
        },
      };
    }
    if (localStorage.getItem('rj-transport') === 'curl') {
      const url = '/assets/net2/index.mjs';
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
          if (!st) throw new TypeError('page failed to load: ' + (r.headers.get('x-rj-error') || r.status));
          const raw = JSON.parse(atob(r.headers.get('x-rj-headers') || 'W10='));
          return { body: r.body, headers: raw, status: +st, statusText: decodeURIComponent(r.headers.get('x-rj-text') || '') };
        },
      };
    }
    return new Epoxy({ wisp });
  }

  const loadScript = (src) => new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src; el.onload = () => res(); el.onerror = () => rej(new Error('some files did not load - check your connection and reload'));
    document.head.appendChild(el);
  });

export async function connect({ setBoot, cancelled, getAdOk }) {
        if (!('serviceWorker' in navigator)) return { fail: 'this browser is too old for browse' };
        setBoot('loading...');
        if (!globalThis.$scramjetController) {
          await loadScript('/assets/codec/codec.js');
          await loadScript('/assets/player/api.js');
        }
        const { Controller } = globalThis.$scramjetController || {};
        const EpoxyTransport = (await import(/* @vite-ignore */ '/assets/net/index.mjs')).default;
        if (!Controller || !EpoxyTransport) return { fail: 'some files did not load - check your connection and reload' };
        setBoot('starting...');
        // the worker, the tunnel ticket and the url key are independent, so
        // they load together instead of one after another.
        // some browsers (iOS Safari) withhold cookies on websocket upgrades,
        // so the tunnel authenticates with a short-lived ticket instead.
        const tkP = fetch('/api/media-bridge/ticket' + (localStorage.getItem('rj-adblock') === 'off' ? '?ab=0' : ''), { method: 'POST', headers: { 'X-Ramjet-JS': '1' } }).then((r) => r.json()).catch(() => ({}));
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
        const [swR, tk, kk] = await Promise.all([swP, tkP, kkP]);
        const sw = swR.worker;
        if (cancelled()) return {};
        setBoot('connecting...');
        const urlCodec = kk.key ? makeUrlCodec(kk.key) : undefined;
        const wispBase = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
        const wispUrl = tk.ticket ? `${wispBase}/api/media-bridge/${tk.ticket}/` : `${wispBase}/api/media-bridge/`;
        await new Promise((res, rej) => {
          const probe = new WebSocket(wispUrl);
          const t = setTimeout(() => { try { probe.close(); } catch {} ; rej(new Error('connection timed out - this network may be blocking it')); }, 15000);
          probe.onopen = () => { clearTimeout(t); probe.close(); res(); };
          probe.onerror = () => { /* onclose carries the detail */ };
          probe.onclose = (ev) => { clearTimeout(t); rej(new Error(`connection refused (code ${ev.code || 'none'})`)); };
        });
        if (cancelled()) return {};
        setBoot('warming up...');
        const controller = new Controller({ serviceworker: sw, transport: await makeTransport(EpoxyTransport, wispUrl, getAdOk), config: { prefix: '/a/r/', ...(urlCodec ? { codec: urlCodec } : {}) } });
        // an update replaces the worker object captured above; keep the
        // controller registering with the live worker of this registration.
        pinControllerWorker(controller, swR.reg);
        await Promise.race([
          controller.wait(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('that took too long - reload to try again')), 15000)),
        ]);
        if (cancelled()) return {};
  return { controller };
}
