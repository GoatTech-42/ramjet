// behavioural boot/deadline/reconnect coverage for the browse engine.
// engine.js is browser-coupled, so its source is evaluated with stubbed browser surface (the same
// extraction idiom as the browse-sw tests), driving the real tickets.mjs. mock timers drive the
// deadlines; sockets/fetches are fakes that record what the engine actually did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mintTicketUrl } from '../pages/browse/tickets.mjs';

const T1 = 'aa'.repeat(24), T2 = 'bb'.repeat(24), T3 = 'cc'.repeat(24);
const BRIDGE = 'wss://ramjet.test/api/media-bridge/';

const loadEngine = (pin, epoxyModule) => {
  const src = readFileSync(new URL('../pages/browse/engine.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export async function connect', 'async function connect')
    .replace("import(/* @vite-ignore */ '/assets/net/index.mjs')", '__deps.epoxyModule');
  assert.ok(!src.includes('import '), 'imports stripped: ' + src.match(/import[^;]*;/g));
  return new Function('pinControllerWorker', 'mintTicketUrl', '__deps', src + '\nreturn { connect, makeTransport };')(pin, mintTicketUrl, { epoxyModule });
};

class FakeEpoxy {
  constructor(o) { this.opts = o; this.connectCalls = []; FakeEpoxy.instances.push(this); }
  async init() {}
  meta() { return null; }
  async request() { return { status: 200, headers: [], body: null, statusText: '' }; }
  connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
    this.connectCalls.push({ url, protocols });
    this.cbs = { onopen, onmessage, onclose, onerror };
    const sent = this.sent = [];
    const closedWith = this.closedWith = [];
    // real vendor callbacks are async and can arrive late; defer mode leaves the timing to the test
    if (!FakeEpoxy.defer) queueMicrotask(() => onopen('v1', ''));
    return [async (d) => sent.push(d), async (c, r) => closedWith.push([c, r])];
  }
}
FakeEpoxy.defer = false;
class FakeController {
  constructor(o) { this.opts = o; FakeController.instances.push(this); }
  async wait() { if (FakeController.hangWait) await new Promise(() => {}); }
  setupMessagePort() {}
}
class LiveWS {
  constructor(url) { this.url = url; this.closed = false; LiveWS.sockets.push(this); queueMicrotask(() => { if (!this.closed) { this.readyState = 1; this.onopen && this.onopen(); } }); }
  send(raw) {
    const m = JSON.parse(raw);
    if (m.cancel || m.id == null) return;
    queueMicrotask(() => {
      if (this.closed) return;
      const h = new TextEncoder().encode(JSON.stringify({ headers: { 'content-type': 'text/html' }, status: 200, text: 'OK' }));
      const buf = new ArrayBuffer(5 + h.length);
      const dv = new DataView(buf); dv.setUint32(0, m.id); dv.setUint8(4, 0);
      new Uint8Array(buf, 5).set(h);
      this.onmessage && this.onmessage({ data: buf });
      const end = new ArrayBuffer(5);
      const edv = new DataView(end); edv.setUint32(0, m.id); edv.setUint8(4, 2);
      this.onmessage && this.onmessage({ data: end });
    });
  }
  close() { this.closed = true; }
}
class HangingWS { constructor(url) { this.url = url; this.closed = false; HangingWS.sockets.push(this); } send() {} close() { this.closed = true; } }

const reset = () => { FakeEpoxy.instances = []; FakeEpoxy.defer = false; FakeController.instances = []; FakeController.hangWait = false; LiveWS.sockets = []; HangingWS.sockets = []; };

const ticketFetch = (handler) => async (url) => {
  const u = String(url);
  if (u.startsWith('/api/media-bridge/ticket')) return handler(u);
  if (u.startsWith('/api/apps/browse/urlkey')) return new Response('{}', { status: 200 });
  throw new Error('unexpected fetch ' + u);
};
const goodMint = (mints) => ticketFetch(() => { const tk = [T1, T2, T3][mints.count] || T3; mints.count++; return new Response(JSON.stringify({ ticket: tk }), { status: 200 }); });

const setup = (t, over) => {
  const reg = { active: { state: 'activated' }, installing: null, waiting: null };
  const defs = {
    localStorage: { _m: new Map(Object.entries(over.ls || {})), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); } },
    location: { protocol: 'https:', host: 'ramjet.test' },
    navigator: { serviceWorker: { register: async () => reg, addEventListener: () => {}, removeEventListener: (t2, f) => { (setup.removed ||= []).push(f); } } },
    WebSocket: over.WS,
    fetch: over.fetch,
    document: { createElement: () => ({}), head: { appendChild: (el) => { if (!over.hangAssets) queueMicrotask(() => el.onload && el.onload()); } } },
  };
  const saved = {};
  for (const k of Object.keys(defs)) { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: defs[k], configurable: true, writable: true }); }
  saved.$scramjetController = Object.getOwnPropertyDescriptor(globalThis, '$scramjetController');
  if (over.noController) delete globalThis.$scramjetController;
  else Object.defineProperty(globalThis, '$scramjetController', { value: { Controller: FakeController }, configurable: true, writable: true });
  t.after(() => { for (const k of Object.keys(saved)) { if (saved[k]) Object.defineProperty(globalThis, k, saved[k]); else delete globalThis[k]; } });
  return reg;
};
const boot = { setBoot: () => {}, cancelled: () => false, getAdOk: () => true };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('boot: the probe burns ticket 1, the transport mints its own per socket, the controller is pinned', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pins = [];
  const { connect } = loadEngine((...a) => pins.push(a), { default: FakeEpoxy });
  const mints = { count: 0 };
  const reg = setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  assert.ok(r.controller, 'boot produced a controller');
  assert.equal(LiveWS.sockets[0].url, BRIDGE + T1 + '/');
  assert.equal(LiveWS.sockets[0].closed, true, 'probe closed its socket - ticket 1 is burned');
  assert.equal(pins.length, 1); assert.equal(pins[0][0], r.controller); assert.equal(pins[0][1], reg);
  const res = await r.controller.opts.transport.request(new URL('https://example.com/'), 'GET', null, {}, undefined);
  assert.equal(res.status, 200);
  assert.equal(LiveWS.sockets[1].url, BRIDGE + T2 + '/', 'transport socket got its own ticket');
  assert.equal(mints.count, 2);
});

test('boot: a 401 from the ticket endpoint fails closed as no-retry, no socket, no controller', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => new Response(JSON.stringify({ error: 'not signed in' }), { status: 401 })) });
  const r = await connect(boot);
  assert.ok(r.fail.includes('session ended'));
  assert.equal(r.noRetry, true);
  assert.equal(LiveWS.sockets.length, 0);
  assert.equal(FakeController.instances.length, 0);
});

test('boot: a failed ticket mint fails closed instead of probing an unticketed url', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => { throw new Error('offline'); }) });
  const r = await connect(boot);
  assert.ok(r.fail.includes("couldn't be reserved"));
  assert.equal(LiveWS.sockets.length, 0, 'the probe never ran on an unticketed url');
});

test('boot: stalled assets are cut by the total 12s deadline', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  setup(t, { WS: LiveWS, fetch: goodMint({ count: 0 }), noController: true, hangAssets: true });
  const p = connect(boot);
  const settled = { v: false }; p.then(() => settled.v = true, () => settled.v = true);
  await flush();
  assert.equal(settled.v, false, 'still pending before the deadline');
  t.mock.timers.tick(12001);
  await assert.rejects(p, /that took too long/);
});

test('boot: a hanging probe is abandoned at the total deadline, and a late probe open does nothing', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: HangingWS, fetch: goodMint(mints) });
  const p = connect(boot);
  const settled = { v: false }; p.then(() => settled.v = true, () => settled.v = true);
  await flush();
  assert.equal(HangingWS.sockets.length, 1);
  t.mock.timers.tick(12001);
  await assert.rejects(p, /that took too long/);
  assert.equal(HangingWS.sockets[0].closed, true, 'the abandoned probe socket was closed');
  HangingWS.sockets[0].onopen && HangingWS.sockets[0].onopen();
  await flush();
  assert.equal(mints.count, 1, 'no further mints after the deadline');
  assert.equal(FakeController.instances.length, 0, 'no late controller construction');
});

test('fail-fast: experimental and unrecognized transport selections are refused before any mint or socket', async (t) => {
  // regression: epoxy/curl and any unknown value used to open a stock-wisp socket the backend never answers (0 frames, hang).
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  for (const mode of ['epoxy', 'curl', 'auto']) {
    const { makeTransport } = loadEngine(() => {}, { default: FakeEpoxy });
    const mints = { count: 0 };
    setup(t, { WS: LiveWS, ls: { 'rj-transport': mode }, fetch: goodMint(mints) });
    FakeEpoxy.instances.length = 0;
    let err = null;
    await makeTransport(FakeEpoxy, BRIDGE, () => true).then(() => { throw new Error('should have failed fast'); }, (e) => { err = e; });
    assert.ok(err instanceof TypeError, mode + ': TypeError');
    assert.match(err.message, /isn't supported by this tunnel/, mode + ': clear unsupported message');
    assert.equal(err.noRetry, true, mode + ': no automatic retry for a deterministic refusal');
    assert.equal(mints.count, 0, mode + ': no ticket minted');
    assert.equal(FakeEpoxy.instances.length, 0, mode + ': no vendored client constructed');
    reset();
  }
});

test('fail-fast: normalization - missing and empty rj-transport still mean ws, and server is untouched', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  for (const ls of [{}, { 'rj-transport': '' }]) {
    const { makeTransport } = loadEngine(() => {}, { default: FakeEpoxy });
    const mints = { count: 0 };
    setup(t, { WS: LiveWS, ls, fetch: goodMint(mints) });
    FakeEpoxy.instances.length = 0;
    const tr = await makeTransport(FakeEpoxy, BRIDGE, () => true);
    assert.ok(tr, JSON.stringify(ls) + ': ws transport built');
    assert.equal(FakeEpoxy.instances.length, 1, JSON.stringify(ls) + ': ws mode constructs its unticketed helper');
    assert.equal(mints.count, 0, JSON.stringify(ls) + ': ws mode mints no ticket at construction');
    reset();
  }
});

test('fail-fast: epoxy mode boot surfaces the refusal, and only the probe mint happened', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let n = 0;
  setup(t, { WS: LiveWS, ls: { 'rj-transport': 'epoxy' }, fetch: ticketFetch(() => (++n, new Response(JSON.stringify({ ticket: T1 }), { status: 200 }))) });
  let err = null;
  await connect(boot).then(() => { throw new Error('should have failed fast'); }, (e) => { err = e; });
  assert.match(err && err.message, /isn't supported by this tunnel/);
  assert.equal(err.noRetry, true);
  assert.equal(n, 1, 'the boot probe minted its ticket; the transport never minted');
  assert.equal(LiveWS.sockets.length, 1, 'only the probe socket was opened');
});

test('reconnect: a dropped transport socket mints a fresh ticket on the next request', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  await r.controller.opts.transport.request(new URL('https://example.com/'), 'GET', null, {}, undefined);
  assert.equal(LiveWS.sockets[1].url, BRIDGE + T2 + '/');
  LiveWS.sockets[1].onclose(); // simulate the network dropping the multiplexed socket
  await r.controller.opts.transport.request(new URL('https://example.com/two'), 'GET', null, {}, undefined);
  assert.equal(LiveWS.sockets[2].url, BRIDGE + T3 + '/', 'the reopened socket minted ticket 3');
  assert.equal(mints.count, 3);
});

test('consumer boundary: the vendored controller destructures [send, close] synchronously - the tuple survives, ticketed and live', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  let opened = null;
  // exactly the vendored controller.api.js call shape: destructure without await
  const [n, a] = r.controller.opts.transport.connect(
    new URL('wss://example.com/socket'), ['v1'], [],
    (pr, ex) => { opened = { protocol: pr, extensions: ex }; }, () => {}, () => {}, () => {}
  );
  assert.equal(typeof n, 'function', 'send comes back synchronously');
  assert.equal(typeof a, 'function', 'close comes back synchronously');
  await n(new Uint8Array([1, 2, 3]).buffer);
  await a(1000, 'done');
  await flush();
  assert.deepEqual(opened, { protocol: 'v1', extensions: '' }, 'onopen was wired through');
  assert.equal(FakeEpoxy.instances.length, 2, 'a fresh client was created for the proxied connect');
  const fresh = FakeEpoxy.instances[1];
  assert.equal(fresh.opts.wisp, BRIDGE + T2 + '/', 'the fresh client is ticketed');
  assert.equal(fresh.sent.length, 1, 'send reached the real ticketed client');
  assert.deepEqual(fresh.closedWith, [[1000, 'done']], 'close reached the real ticketed client');
  assert.equal(FakeEpoxy.instances[0].connectCalls.length, 0, 'the unticketed shared client was never connected');
});

test('consumer boundary: a failed connect mint reports through onerror, not a hung open', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let n = 0;
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => ++n === 1 ? new Response(JSON.stringify({ ticket: T1 }), { status: 200 }) : new Response(JSON.stringify({ error: 'not signed in' }), { status: 401 })) });
  const r = await connect(boot);
  let failed = null;
  r.controller.opts.transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => {}, (e) => { failed = e; });
  await flush();
  assert.ok(failed && String(failed).includes('session ended'), 'onerror carried the session failure');
});

test('close during an in-flight mint never publishes a socket', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let release;
  let n = 0;
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => ++n === 1 ? new Response(JSON.stringify({ ticket: T1 }), { status: 200 }) : new Promise((res) => { release = res; })) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  const req = transport.request(new URL('https://example.com/'), 'GET', null, {}, undefined);
  req.catch(() => {});
  await flush();
  transport.close(); // teardown while the second mint is still stalled
  release(new Response(JSON.stringify({ ticket: T2 }), { status: 200 }));
  await flush();
  assert.equal(LiveWS.sockets.length, 1, 'only the probe socket exists - the late mint opened nothing');
  await assert.rejects(req, /connection dropped/);
});

test('close is terminal: a socket that opens late is shut, and later requests reject', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: HangingWS, fetch: goodMint(mints) });
  // hang only the probe: boot needs a live probe, so drive it manually
  const r = await (async () => {
    const p = connect(boot);
    await flush();
    HangingWS.sockets[0].onopen && (HangingWS.sockets[0].readyState = 1, HangingWS.sockets[0].onopen());
    return p;
  })();
  const transport = r.controller.opts.transport;
  const req = transport.request(new URL('https://example.com/'), 'GET', null, {}, undefined);
  req.catch(() => {});
  await flush();
  assert.equal(HangingWS.sockets.length, 2, 'transport socket created, still opening');
  transport.close();
  HangingWS.sockets[1].onopen && HangingWS.sockets[1].onopen(); // opens after close
  await flush();
  await assert.rejects(req, /connection dropped/);
  assert.equal(HangingWS.sockets[1].closed, true, 'the late-opening socket was closed, not published');
  await assert.rejects(transport.request(new URL('https://example.com/two'), 'GET', null, {}, undefined), /connection dropped/);
});

test('proxied late mint after close: nothing constructed, nothing connected, no callbacks', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let release;
  let n = 0;
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => ++n === 1 ? new Response(JSON.stringify({ ticket: T1 }), { status: 200 }) : new Promise((res) => { release = res; })) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let opened = 0;
  const tuple = transport.connect(new URL('wss://example.com/socket'), [], [], () => opened++, () => {}, () => {}, () => {});
  assert.ok(Array.isArray(tuple), 'tuple returned synchronously');
  transport.close();
  release(new Response(JSON.stringify({ ticket: T2 }), { status: 200 }));
  await flush();
  assert.equal(FakeEpoxy.instances.length, 1, 'no client was constructed after close');
  assert.equal(opened, 0, 'onopen never fired');
  await assert.rejects(tuple[0](new Uint8Array([1]).buffer), /connection dropped/);
});

test('terminal close suppresses late vendor callbacks and a retained send never reaches the vendor', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true; // faithful vendor: callbacks arrive whenever the network says so
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let opened = 0, messages = 0;
  const [send] = transport.connect(new URL('wss://example.com/socket'), [], [], () => opened++, () => messages++, () => {}, () => {});
  await flush();
  const fresh = FakeEpoxy.instances[1];
  assert.equal(fresh.connectCalls.length, 1, 'vendor connect happened while live');
  transport.close();
  assert.deepEqual(fresh.closedWith, [[1000, '']], 'the intentional terminal close reached the vendor');
  fresh.cbs.onopen('v1', '');
  fresh.cbs.onmessage(new Uint8Array([1]).buffer);
  await assert.rejects(send('after-close'), /connection dropped/);
  assert.equal(opened, 0, 'late vendor onopen was suppressed');
  assert.equal(messages, 0, 'late vendor onmessage was suppressed');
  assert.equal(fresh.sent.length, 0, 'retained send never reached the vendor');
});

test('per-socket close while the mint is pending cancels before any vendor connect', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let release;
  let n = 0;
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => ++n === 1 ? new Response(JSON.stringify({ ticket: T1 }), { status: 200 }) : new Promise((res) => { release = res; })) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let opened = 0;
  const [, a] = transport.connect(new URL('wss://example.com/socket'), [], [], () => opened++, () => {}, () => {}, () => {});
  const closing = a(1000, ''); // synchronous cancel while the mint is still stalled
  release(new Response(JSON.stringify({ ticket: T2 }), { status: 200 }));
  await closing;
  await flush();
  assert.equal(FakeEpoxy.instances.length, 1, 'no client was constructed for the cancelled socket');
  assert.equal(opened, 0, 'no onopen fired');
});

test('a vendor handshake completing after per-socket close publishes nothing', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true;
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let opened = 0, messages = 0;
  const [send, a] = transport.connect(new URL('wss://example.com/socket'), [], [], () => opened++, () => messages++, () => {}, () => {});
  await flush();
  const fresh = FakeEpoxy.instances[1];
  await a(1000, 'gone'); // user closes while the vendor handshake is still pending
  fresh.cbs.onopen('v1', ''); // the handshake completes late anyway
  fresh.cbs.onmessage(new Uint8Array([2]).buffer);
  await assert.rejects(send('x'), /connection dropped/);
  assert.equal(opened, 0);
  assert.equal(messages, 0);
  assert.deepEqual(fresh.closedWith, [[1000, 'gone']], 'the intentional close reached the vendor once');
  assert.equal(fresh.sent.length, 0);
});

test('user close: the page close event fires exactly once and the record leaves the live set', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true;
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let pageClosed = 0;
  const [, a] = transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => pageClosed++, () => {});
  await flush();
  const fresh = FakeEpoxy.instances[1];
  await a(1000, 'bye');
  await a(1000, 'bye'); // duplicate close is a no-op
  fresh.cbs.onclose(1000, 'Closed by remote'); // the vendor's reactive close arrives late
  transport.close(); // must not double-close the vendor socket or re-notify
  await flush();
  assert.equal(pageClosed, 1, 'page close event exactly once');
  assert.deepEqual(fresh.closedWith, [[1000, 'bye']], 'vendor closed exactly once');
});

test('transport close delivers the page close event for a live proxied socket', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true;
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let pageClosed = 0;
  transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => pageClosed++, () => {});
  await flush();
  const fresh = FakeEpoxy.instances[1];
  transport.close();
  await flush();
  assert.equal(pageClosed, 1, 'the deliberate terminal notification reached the consumer');
  assert.deepEqual(fresh.closedWith, [[1000, '']]);
  fresh.cbs.onclose(1000, 'Closed by remote');
  assert.equal(pageClosed, 1, 'the late vendor close callback is suppressed');
});

test('a remote close delivers once, cleans the live record, and transport close does not re-close', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true;
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let pageClosed = 0;
  transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => pageClosed++, () => {});
  await flush();
  const fresh = FakeEpoxy.instances[1];
  fresh.cbs.onclose(1006, 'dropped'); // the remote end closed
  assert.equal(pageClosed, 1);
  transport.close();
  await flush();
  assert.equal(pageClosed, 1, 'no duplicate terminal');
  assert.equal(fresh.closedWith.length, 0, 'the already-closed socket was not closed again');
});

test('pending socket is owned: close rejects the opening request and closes the CONNECTING socket', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: HangingWS, fetch: goodMint(mints) });
  const r = await (async () => {
    const p = connect(boot);
    await flush();
    HangingWS.sockets[0].readyState = 1;
    HangingWS.sockets[0].onopen && HangingWS.sockets[0].onopen();
    return p;
  })();
  const transport = r.controller.opts.transport;
  const req = transport.request(new URL('https://example.com/'), 'GET', null, {}, undefined);
  req.catch(() => {});
  await flush();
  assert.equal(HangingWS.sockets.length, 2, 'transport socket created, still CONNECTING');
  transport.close();
  await flush();
  await assert.rejects(req, /connection dropped/, 'the opening request rejected at close, not at some later timeout');
  assert.equal(HangingWS.sockets[1].closed, true, 'the CONNECTING socket was closed');
});

test('server mode: request after close rejects instead of fetching', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { makeTransport } = loadEngine(() => {}, { default: FakeEpoxy });
  let pfetch = 0;
  setup(t, { WS: LiveWS, ls: { 'rj-transport': 'server' }, fetch: async (u) => { if (String(u).startsWith('/api/pfetch')) { pfetch++; return new Response('x'); } throw new Error('unexpected ' + u); } });
  const tr = await makeTransport(FakeEpoxy, BRIDGE, () => true);
  tr.close();
  await assert.rejects(tr.request(new URL('https://example.com/'), 'GET', null, {}, undefined), /connection dropped/);
  assert.equal(pfetch, 0, 'no pfetch call went out after close');
});


test('close tears down live proxied clients, and a proxied connect after close fails fast', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => {}, () => {});
  await flush();
  const fresh = FakeEpoxy.instances[1];
  assert.equal(fresh.connectCalls.length, 1);
  transport.close();
  await flush();
  assert.deepEqual(fresh.closedWith, [[1000, '']], 'the live proxied client was closed with the transport');
  let failed = null;
  transport.connect(new URL('wss://example.com/other'), [], [], () => {}, () => {}, () => {}, (e) => { failed = e; });
  assert.ok(failed, 'onerror fired immediately for a connect on a closed transport');
  assert.equal(mints.count, 2, 'no ticket was minted for the rejected connect');
});

test('classification: a 401 on a transport mint survives the throw as noRetry', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let n = 0;
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => ++n === 1 ? new Response(JSON.stringify({ ticket: T1 }), { status: 200 }) : new Response(JSON.stringify({ error: 'not signed in' }), { status: 401 })) });
  const r = await connect(boot);
  await assert.rejects(
    r.controller.opts.transport.request(new URL('https://example.com/'), 'GET', null, {}, undefined),
    (e) => { assert.equal(e.noRetry, true); assert.ok(e.message.includes('session ended')); return true; }
  );
});

test('teardown: a warmup timeout unpins the controller and closes the transport socket', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const unpins = [];
  const { connect } = loadEngine(() => () => unpins.push(1), { default: FakeEpoxy });
  setup(t, { WS: LiveWS, fetch: goodMint({ count: 0 }) });
  FakeController.hangWait = true;
  const p = connect(boot);
  await flush();
  assert.equal(FakeController.instances.length, 1, 'controller constructed and pinned');
  t.mock.timers.tick(12001);
  await assert.rejects(p, /that took too long/);
  assert.equal(unpins.length, 1, 'the pin listener was removed');
  const transport = FakeController.instances[0].opts.transport;
  await assert.rejects(transport.request(new URL('https://example.com/'), 'GET', null, {}, undefined), /connection dropped/, 'the torn-down transport is terminal - a retry cannot overlap it');
});

test('transport close during a pending mint settles the handshake and closes the page exactly once', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let release;
  let n = 0;
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => ++n === 1 ? new Response(JSON.stringify({ ticket: T1 }), { status: 200 }) : new Promise((res) => { release = res; })) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  const before = FakeEpoxy.instances.length;
  let opened = 0, errors = 0, closed = 0;
  transport.connect(new URL('wss://example.com/socket'), [], [], () => opened++, () => {}, () => closed++, () => errors++);
  transport.close(); // the whole transport dies while the socket's mint is still stalled
  release(new Response(JSON.stringify({ ticket: T2 }), { status: 200 }));
  await flush();
  assert.equal(errors, 1, 'the pending handshake settled through onerror - the rpc it feeds cannot hang');
  assert.equal(closed, 1, 'the page close event fired exactly once');
  assert.equal(opened, 0);
  assert.equal(FakeEpoxy.instances.length, before, 'no vendor client was constructed after the close');
});

test('per-socket close with a failing mint resolves cleanly and still notifies once', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  let release;
  let n = 0;
  setup(t, { WS: LiveWS, fetch: ticketFetch(() => ++n === 1 ? new Response(JSON.stringify({ ticket: T1 }), { status: 200 }) : new Promise((res, rej) => { release = rej; })) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let errors = 0, closed = 0;
  const [, a] = transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => closed++, () => errors++);
  const closing = a(1000, ''); // user closes while the mint is about to fail
  release(new Error('network down'));
  await closing; // must resolve: the vendored consumer ignores this promise, so a rejection would escape unhandled
  await flush();
  assert.equal(errors, 1, 'the handshake settled exactly once');
  assert.equal(closed, 1, 'the page close event fired exactly once');
});

test('a close reentering from inside the vendor connect closes the vendor exactly once', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pageCloseRef = { fn: null };
  class ReentrantEpoxy {
    constructor(o) { this.opts = o; ReentrantEpoxy.instances.push(this); }
    async init() {}
    meta() { return null; }
    async request() { return { status: 200, headers: [], body: null, statusText: '' }; }
    connect() {
      const closes = this.closes = [];
      const tuple = [async () => {}, async (c, r) => closes.push([c, r])];
      if (pageCloseRef.fn) pageCloseRef.fn(1000, ''); // the page closes reentrantly, before the tuple is handed back
      return tuple;
    }
  }
  ReentrantEpoxy.instances = [];
  const { connect } = loadEngine(() => {}, { default: ReentrantEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let terminal = 0, errors = 0;
  const [, a] = transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => terminal++, () => errors++);
  pageCloseRef.fn = a; // the vendor connect runs after the async mint, so this is set in time
  await flush();
  const fresh = ReentrantEpoxy.instances[ReentrantEpoxy.instances.length - 1];
  assert.equal(fresh.closes.length, 1, 'the vendor close ran exactly once for the reentrant close');
  assert.equal(terminal, 1, 'the page close event fired exactly once');
  assert.equal(errors, 1, 'the unopened handshake was settled through onerror');
});

test('closing an opened socket settles nothing extra: vendor close once, page close once, no error', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true;
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let opened = 0, errors = 0, closed = 0;
  const [, a] = transport.connect(new URL('wss://example.com/socket'), [], [], () => opened++, () => {}, () => closed++, () => errors++);
  await flush();
  const fresh = FakeEpoxy.instances[1];
  fresh.cbs.onopen('v1', ''); // the handshake completes
  await a(1000, 'done');
  await flush();
  assert.equal(opened, 1);
  assert.equal(errors, 0, 'an opened socket closes without a synthetic error');
  assert.equal(closed, 1);
  assert.deepEqual(fresh.closedWith, [[1000, 'done']], 'the vendor got the intentional close with the page code');
});

test('a vendor close arriving mid-handshake settles the rpc and notifies exactly once', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true;
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let opened = 0, errors = 0, closed = 0;
  transport.connect(new URL('wss://example.com/socket'), [], [], () => opened++, () => {}, () => closed++, () => errors++);
  await flush();
  const fresh = FakeEpoxy.instances[1];
  fresh.cbs.onclose(1006, 'dropped'); // the remote end closes before the handshake completes
  transport.close();
  await flush();
  assert.equal(opened, 0);
  assert.equal(errors, 1, 'the unopened handshake was settled through onerror');
  assert.equal(closed, 1, 'the page close event fired exactly once across both teardown paths');
  assert.equal(fresh.closedWith.length, 0, 'the already-closed socket was not closed again');
});

test('a vendor init failure settles the handshake and notifies the page close once', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  class InitFailEpoxy extends FakeEpoxy { async init() { throw new Error('init blew up'); } }
  const { connect } = loadEngine(() => {}, { default: InitFailEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let errors = 0, closed = 0;
  const [send] = transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => closed++, () => errors++);
  await flush();
  assert.equal(errors, 1, 'the handshake settled through onerror');
  assert.equal(closed, 1, 'the page close event fired exactly once');
  await assert.rejects(send('x'), /connection dropped/);
});

test('a consumer reentering close from the handshake error still notifies exactly once', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  FakeEpoxy.defer = true;
  const { connect } = loadEngine(() => {}, { default: FakeEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let errors = 0, closed = 0;
  let a;
  const pair = transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => closed++, () => { errors++; a(1000, ''); });
  a = pair[1];
  await flush();
  const fresh = FakeEpoxy.instances[1];
  fresh.cbs.onerror('refused'); // the handshake fails; the consumer closes reentrantly from inside its onerror
  await flush();
  assert.equal(errors, 1, 'the handshake settled through onerror exactly once');
  assert.equal(closed, 1, 'the page close event fired exactly once despite the reentrant close');
  assert.deepEqual(fresh.closedWith, [[1000, '']], 'the failed socket was closed once with a sendable code, owned by the error path');
});

test('a rejecting async vendor close is consumed - no unhandled rejection escapes', async (t) => {
  reset(); t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const unhandled = [];
  const onUnhandled = (r) => unhandled.push(String(r));
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  class RejectCloseEpoxy extends FakeEpoxy {
    connect(url, protocols, headers, onopen, onmessage, onclose, onerror) {
      this.cbs = { onopen, onmessage, onclose, onerror };
      this.closedWith = [];
      this.sent = [];
      // the real vendor close awaits its handshake socket; a rejected handshake rejects the close
      const pending = Promise.reject(new Error('handshake failed'));
      pending.catch(() => {});
      return [async (d) => this.sent.push(d), async (c, r) => { this.closedWith.push([c, r]); (await pending).close(c, r); }];
    }
  }
  const { connect } = loadEngine(() => {}, { default: RejectCloseEpoxy });
  const mints = { count: 0 };
  setup(t, { WS: LiveWS, fetch: goodMint(mints) });
  const r = await connect(boot);
  const transport = r.controller.opts.transport;
  let errors = 0, closed = 0;
  const pair = transport.connect(new URL('wss://example.com/socket'), [], [], () => {}, () => {}, () => closed++, () => errors++);
  await flush();
  const fresh = RejectCloseEpoxy.instances[1];
  fresh.cbs.onerror('refused'); // error path owns the vendor close - whose promise rejects
  for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res)); // let any unhandled rejection surface
  assert.equal(errors, 1);
  assert.equal(closed, 1);
  assert.deepEqual(fresh.closedWith, [[1000, '']]);
  assert.deepEqual(unhandled, [], 'the rejected vendor close promise was consumed');
});
