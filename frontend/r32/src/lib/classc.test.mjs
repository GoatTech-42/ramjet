import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const flush = () => new Promise((r) => setImmediate(r));
let n = 0;
async function fresh({ filtered = false, always = false, fetchFn } = {}) {
  globalThis.sessionStorage = store(); globalThis.localStorage = store();
  if (filtered) sessionStorage.setItem('rj-filtered-net', '1');
  if (always) localStorage.setItem('rj-proxy-always', '1');
  globalThis.location = { host: 'app.test', href: 'https://app.test/' };
  globalThis.fetch = fetchFn || (() => Promise.resolve({}));
  return import('./classc.js?t=' + (++n));
}
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

test('1 a probe in flight does not switch off a proxy the user forced on', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let pending = [];
    const m = await fresh({ filtered: true, fetchFn: () => { const d = deferred(); pending.push(d); return d.p; } });
    mock.timers.tick(15 * 60000); await flush();              // probe 1 starts: two fetches
    pending.splice(0).forEach((d) => d.res({})); await flush(); // both answer: 'open', probeOk = 1
    mock.timers.tick(15 * 60000); await flush();              // probe 2 starts
    m.setAlways(true);                                         // user forces it while probe 2 is in flight
    pending.splice(0).forEach((d) => d.res({})); await flush();
    assert.equal(m.status().filtered, true);
    assert.equal(m.status().always, true);
  } finally { mock.timers.reset(); }
});

test('2 a stale image probe cannot retry a newer url', async () => {
  let pending = [];
  const m = await fresh({ fetchFn: () => { const d = deferred(); pending.push(d); return d.p; } });
  let onErr; const node = { style: {}, src: '', addEventListener: (e, f) => { if (e === 'error') onErr = f; }, removeEventListener() {} };
  const act = m.cimg(node, 'https://cdn.example/a.png');
  node.src = 'https://cdn.example/a.png'; onErr();             // a fails, reach(a) in flight
  act.update('https://cdn.example/b.png');
  pending.splice(0).forEach((d) => d.rej(new TypeError('net'))); await flush(); // reach(a) says unreachable
  assert.equal(node.src, 'https://cdn.example/b.png');
});

test('3 turning always off while filtered keeps the proxy on', async () => {
  const m = await fresh({ filtered: true, always: true });
  m.setAlways(false);
  assert.equal(m.status().filtered, true);
  assert.equal(m.status().always, false);
});

test('4 cfetch: caller abort is honoured, proxied retry has its own signal and no retry after abort', async () => {
  const calls = [];
  const m = await fresh({ fetchFn: (u, o) => { calls.push({ u, o }); return Promise.reject(new TypeError('net')); } });
  await assert.rejects(m.cfetch('https://cdn.example/x.json'));
  assert.equal(calls.length, 2);
  assert.ok(calls[1].u.includes('/api/apps/browse/proxy'));
  assert.ok(calls[1].o.signal && typeof calls[1].o.signal.aborted === 'boolean');
  calls.length = 0;
  const ac = new AbortController(); ac.abort();
  await assert.rejects(m.cfetch('https://cdn.example/y.json', { signal: ac.signal }));
  assert.equal(calls.length, 1);                               // aborted by the caller: no proxied retry
  assert.equal(calls[0].o.signal.aborted, true);               // and the caller's abort reached fetch
});

// the module's 15-minute re-probe timers would keep the runner alive
test.after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });
