import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { planPreloadReload, installPreloadRecovery } from '../web/src/lib/preload-recover.js';

const fakeStore = (init = {}, opts = {}) => ({
  m: new Map(Object.entries(init)),
  getItem(k) { if (opts.readDenied) throw new Error('denied'); return this.m.has(k) ? this.m.get(k) : null; },
  setItem(k, v) { if (opts.writeDenied) throw new Error('denied'); this.m.set(k, String(v)); },
});

// an installed-handler harness: fake window + fake event, no browser needed
function harness(storeOpts = {}) {
  const store = fakeStore({}, storeOpts);
  const calls = { reload: 0, prevented: 0, dispatched: 0 };
  let listener = null;
  const target = { addEventListener: (type, fn) => { assert.equal(type, 'vite:preloadError'); listener = fn; } };
  installPreloadRecovery({ store, reload: () => { calls.reload++; }, target });
  const fire = () => {
    calls.dispatched++;
    const ev = { preventDefault() { calls.prevented++; } };
    listener(ev);
  };
  return { store, calls, fire };
}

test('handler: first stale-chunk error reloads, prevents the error, persists the guard', () => {
  const h = harness();
  h.fire();
  assert.equal(h.calls.reload, 1);
  assert.equal(h.calls.prevented, 1);
  assert.ok(Number(h.store.getItem('rj-preload-reload')) > 0, 'guard not persisted');
});

test('handler: second error inside the gap does nothing - no reload, error untouched', () => {
  const h = harness();
  h.fire();
  h.fire();
  assert.equal(h.calls.reload, 1);
  assert.equal(h.calls.prevented, 1, 'second error must NOT be preventDefaulted');
});

test('handler: write-denied storage never reloads and never swallows the error (loop-proof)', () => {
  const h = harness({ writeDenied: true });
  for (let i = 0; i < 5; i++) h.fire();
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.prevented, 0);
});

test('handler: read-denied storage fails closed the same way', () => {
  const h = harness({ readDenied: true });
  h.fire();
  assert.equal(h.calls.reload, 0);
  assert.equal(h.calls.prevented, 0);
});

test('predicate: reloads again after the gap (self-healing)', () => {
  const s = fakeStore();
  const t0 = 1_000_000;
  assert.equal(planPreloadReload(s, t0), true);
  assert.equal(planPreloadReload(s, t0 + 30_000), false);
  assert.equal(planPreloadReload(s, t0 + 61_000), true);
});

test('handler: storage getter-denied browser installs harmless and never fires', () => {
  const calls = { reload: 0, prevented: 0 };
  let listener = null;
  const target = {
    addEventListener: (type, fn) => { listener = fn; },
    get sessionStorage() { throw new Error('SecurityError'); },
  };
  // install must not throw even though the getter is denied
  installPreloadRecovery({ reload: () => { calls.reload++; }, target });
  assert.ok(listener, 'listener not installed');
  listener({ preventDefault() { calls.prevented++; } });
  assert.equal(calls.reload, 0);
  assert.equal(calls.prevented, 0);
});

test('every page entry installs the recovery hook', () => {
  const dir = new URL('../web/src/pages', import.meta.url).pathname;
  let n = 0;
  for (const name of readdirSync(dir)) {
    let entry;
    try { entry = readFileSync(`${dir}/${name}/${name}.js`, 'utf8'); } catch { continue; }
    n++;
    assert.match(entry, /preload-recover/, `${name} entry does not install installPreloadRecovery`);
  }
  assert.ok(n >= 10, `expected 10 page entries, found ${n}`);
});
