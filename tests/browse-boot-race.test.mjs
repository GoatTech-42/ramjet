// Boot-cycle generation ownership: a restarted boot must own its own
// cancellation + transport. Drives the $effect slice with two cycles, holds
// both boots mid-warm, then resolves the OLD boot's warm after the restart:
// the old cycle must not commit (newTab count stays 1), its transport is
// disposed by its own cleanup, and the NEW cycle's transport is untouched.
// (Regression: component-global cancelled/bootTransport let the old boot
// resume uncancelled after the restart reset shared state -> double commit.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');

test('old boot cannot commit or dispose the new transport after a restart', async () => {
  const fn = SRC.slice(SRC.indexOf('  // every boot cycle owns its generation:'), SRC.indexOf('  // recent sites:'));
  assert.ok(fn.length > 500, 'boot slice found');
  let effect;
  const waits = [], ts = [], sw = { scriptURL: 'https://fixture/browse-sw.js?v=same' };
  let commits = 0;
  const c = vm.createContext({
    $state: (x) => x, $effect: (f) => effect = f, stageEl: {}, failed: '', boot: '', ready: false, ctrl: null,
    window: {}, navigator: { serviceWorker: { ready: Promise.resolve(), controller: sw } },
    globalThis: { $scramjetController: { Controller: class { wait() { return Promise.resolve(); } } }, __RJ_ENGINE__: 'same' },
    waitForController: async () => {}, waitForWorker: async () => sw, verifyWorkerVersion: async () => true,
    fetch: async (url) => ({ json: async () => url.includes('urlkey') ? {} : { ticket: 'fake' } }),
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null, removeItem: () => {} },
    location: { protocol: 'https:', host: 'fixture', search: '' },
    sameWorker: (a, b) => a === b,
    makeTransport: async () => { let resolve; const p = new Promise((r) => resolve = r); const t = { warm: () => p, dispose() { this.dead = true; }, dead: false }; ts.push(t); waits.push(resolve); return t; },
    Date, setTimeout, clearTimeout, Promise, URLSearchParams, startSync: () => {}, newTab: () => commits++,
  });
  vm.runInContext(fn, c);
  const tick = () => new Promise((r) => setImmediate(r));
  const cleanup = effect();
  await tick();
  assert.equal(waits.length, 1, 'first boot reached warm');
  cleanup();
  effect();
  await tick();
  assert.equal(waits.length, 2, 'second boot reached warm');
  waits[1]();
  await tick(); await tick();
  assert.equal(commits, 1, 'new boot commits');
  waits[0]();
  await tick(); await tick();
  assert.equal(commits, 1, 'old boot must not commit after the restart');
  assert.equal(ts[0].dead, true, 'old transport disposed by its own cleanup');
  assert.equal(ts[1].dead, false, 'new transport never touched by the old cycle');
});

// shared driver: one effect cycle with stubbed boot dependencies; each
// stub's gate lets the test hold a specific await before resolving it
const drive = (overrides) => {
  const fn = SRC.slice(SRC.indexOf('  // every boot cycle owns its generation:'), SRC.indexOf('  // recent sites:'));
  let effect;
  const state = { commits: 0, ts: [] };
  const c = vm.createContext({
    $state: (x) => x, $effect: (f) => effect = f, stageEl: {}, failed: '', boot: '', ready: false, ctrl: null,
    window: {}, navigator: { serviceWorker: { ready: Promise.resolve(), controller: overrides.sw } },
    globalThis: { $scramjetController: { Controller: overrides.Controller }, __RJ_ENGINE__: 'same' },
    waitForController: async () => {}, waitForWorker: async () => overrides.sw, verifyWorkerVersion: async () => true,
    fetch: async (url) => ({ json: async () => url.includes('urlkey') ? {} : { ticket: 'fake' } }),
    localStorage: { getItem: () => null }, sessionStorage: { getItem: () => null, removeItem: () => {} },
    location: { protocol: 'https:', host: 'fixture', search: '' },
    sameWorker: (a, b) => a === b,
    makeTransport: overrides.makeTransport,
    Date, setTimeout, clearTimeout, Promise, URLSearchParams, startSync: () => {}, newTab: () => state.commits++,
  });
  vm.runInContext(fn, c);
  return { effect, state };
};
const tick = () => new Promise((r) => setImmediate(r));

test('cleanup during makeTransport disposes the late construction, never warms it', async () => {
  const sw = { scriptURL: 'https://fixture/browse-sw.js?v=same' };
  let resolve;
  const gate = new Promise((r) => resolve = r);
  const t = { warm: () => { throw new Error('warm must never run for a cancelled cycle'); }, dispose() { this.dead = true; }, dead: false };
  const { effect, state } = drive({
    sw,
    Controller: class { wait() { return Promise.resolve(); } },
    makeTransport: async () => { state.ts.push(t); await gate; return t; }, // defers INSIDE construction
  });
  const cleanup = effect();
  await tick(); await tick();
  cleanup(); // unmount/swap while makeTransport is still in flight
  resolve(); // construction lands late, into the cancelled cycle
  await tick(); await tick(); await tick();
  assert.equal(t.dead, true, 'late-constructed transport is disposed');
  assert.equal(state.commits, 0, 'no commit from a cancelled cycle');
});

test('cleanup during the controller handshake commits nothing', async () => {
  const sw = { scriptURL: 'https://fixture/browse-sw.js?v=same' };
  let resolve;
  const gate = new Promise((r) => resolve = r);
  const t = { warm: () => Promise.resolve(), dispose() { this.dead = true; }, dead: false };
  const { effect, state } = drive({
    sw,
    Controller: class { wait() { return gate; } },
    makeTransport: async () => { state.ts.push(t); return t; },
  });
  const cleanup = effect();
  await tick(); await tick(); await tick();
  cleanup(); // unmount/swap while controller.wait() is in flight
  resolve(); // handshake lands late
  await tick(); await tick(); await tick();
  assert.equal(state.commits, 0, 'no commit after a cancelled handshake');
  assert.equal(t.dead, true, 'cleanup disposed the transport');
});
