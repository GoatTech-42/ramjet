// Browse default tunnel transport (client): ticket lifecycle, warm proof,
// dispose/teardown. The transport is svelte-inlined, so the suite extracts
// makeTransport from the page source and drives it with fake sockets -
// deterministic, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');
const load = (state) => {
  const fn = SRC.slice(SRC.indexOf('  async function makeTransport('), SRC.indexOf('\n  $effect(', SRC.indexOf('  async function makeTransport(')));
  assert.ok(fn.length > 500, 'makeTransport slice found');
  const c = vm.createContext({
    Date: { now: () => state.now },
    WebSocket: state.WS,
    localStorage: { getItem: () => null },
    fetch: state.fetch,
    Map, Promise, TextDecoder, DataView, Uint8Array, setTimeout, clearTimeout,
    $state: (x) => x, // the sliced region declares state the transport code never reads
  });
  vm.runInContext(fn + ';this.make=makeTransport;', c);
  return c.make;
};
const rig = (opts = {}) => {
  const state = { now: opts.now || 0, fetches: [], sockets: [] };
  state.WS = class {
    constructor(url) { this.url = url; this.readyState = 0; state.sockets.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
    send() {}
  };
  state.fetch = async (url) => { state.fetches.push(url); if (opts.fetchFails) throw new Error('offline'); return { json: async () => opts.noTicket ? {} : { ticket: 'f'.repeat(48) } }; };
  return { state, make: load(state) };
};
const tick = () => new Promise((r) => setImmediate(r));

test('warm uses the seeded boot ticket with no extra fetch', async () => {
  const { state, make } = rig();
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 0 });
  const p = t.warm();
  await tick();
  assert.equal(state.fetches.length, 0);
  assert.equal(state.sockets[0].url, 'wss://site/pws-t/' + 'a'.repeat(48) + '/');
  state.sockets[0].readyState = 1; state.sockets[0].onopen();
  await p; // resolves
});

test('missing boot ticket: warm fetches a ticket and opens a pws url, never /wisp/', async () => {
  const { state, make } = rig();
  const t = await make('wss://site/wisp/', {});
  const p = t.warm();
  await tick(); await tick();
  assert.equal(state.fetches.length, 1);
  assert.match(state.sockets[0].url, /^wss:\/\/site\/pws-t\/[a-f0-9]{48}\/$/);
  state.sockets[0].readyState = 1; state.sockets[0].onopen();
  await p;
});

test('ticket fetch failure rejects warm instead of opening a wrong-protocol socket', async () => {
  const { state, make } = rig({ fetchFails: true });
  const t = await make('wss://site/wisp/', {});
  await assert.rejects(t.warm(), /no proxy ticket|proxy socket|offline|fetch/i);
  assert.equal(state.sockets.length, 0);
});

test('expired seed (received over 60s ago) is refreshed before warm', async () => {
  const { state, make } = rig({ now: 70000 });
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 5000 }); // received 65s ago
  const p = t.warm();
  await tick(); await tick();
  assert.equal(state.fetches.length, 1);
  assert.match(state.sockets[0].url, /pws-t\/f{48}\//);
  state.sockets[0].readyState = 1; state.sockets[0].onopen();
  await p;
});

test('seed is spent on its first socket: a reconnect inside 60s fetches a fresh ticket', async () => {
  const { state, make } = rig({ now: 1000 });
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 0 });
  let p = t.warm();
  await tick();
  state.sockets[0].readyState = 1; state.sockets[0].onopen();
  await p;
  state.sockets[0].close();
  p = t.warm(); // sock is closed -> reopen path
  await tick(); await tick();
  assert.equal(state.fetches.length, 1, 'reconnect refreshes the ticket');
  assert.match(state.sockets[1].url, /pws-t\/f{48}\//);
  state.sockets[1].readyState = 1; state.sockets[1].onopen();
  await p;
});

test('socket closed before open rejects warm instead of hanging', async () => {
  const { state, make } = rig();
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 0 });
  const p = t.warm();
  await tick();
  state.sockets[0].close();
  await assert.rejects(p, /closed before open/);
});

test('dispose cancels a late-opening socket and kills the transport', async () => {
  const { state, make } = rig();
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 0 });
  const p = t.warm();
  await tick();
  const w = state.sockets[0];
  t.dispose(); // boot timeout path
  w.readyState = 1; w.onopen(); // the socket lands late
  assert.equal(w.readyState, 3, 'late-opening socket is closed');
  await assert.rejects(p, /disposed|closed before open/);
  await assert.rejects(t.warm(), /disposed/);
});

test('dispose during a pending ticket fetch never opens a socket', async () => {
  const state = { now: 0, fetches: [], sockets: [] };
  let release;
  state.WS = class { constructor(url) { this.url = url; this.readyState = 0; state.sockets.push(this); } close() { this.readyState = 3; this.onclose?.(); } send() {} };
  state.fetch = async () => { state.fetches.push(1); await new Promise((r) => { release = r; }); return { json: async () => ({ ticket: 'f'.repeat(48) }) }; };
  const make = load(state);
  const t = await make('wss://site/wisp/', {});
  const p = t.warm();
  await tick();
  assert.equal(state.fetches.length, 1, 'ticket fetch in flight');
  t.dispose();
  release(); // the fetch lands AFTER dispose
  await assert.rejects(p, /disposed|closed before open/);
  await tick();
  assert.equal(state.sockets.length, 0, 'no socket created after dispose');
});

test('dispose closes a CONNECTING socket immediately', async () => {
  const { state, make } = rig();
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 0 });
  const p = t.warm();
  await tick();
  const w = state.sockets[0];
  assert.equal(w.readyState, 0, 'still connecting');
  t.dispose();
  assert.equal(w.readyState, 3, 'connecting socket closed immediately');
  await assert.rejects(p, /disposed|closed before open/);
});

test('a non-finite seed age fails safe: refresh, never trust', async () => {
  const { state, make } = rig({ now: 1000 });
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 'yesterday' });
  const p = t.warm();
  await tick(); await tick();
  assert.equal(state.fetches.length, 1, 'invalid seed age forces a refresh');
  assert.match(state.sockets[0].url, /pws-t\/f{48}\//);
  state.sockets[0].readyState = 1; state.sockets[0].onopen();
  await p;
});

test('dispose closes the live socket', async () => {
  const { state, make } = rig();
  const t = await make('wss://site/wisp-t/' + 'a'.repeat(48) + '/', { ticket: 'a'.repeat(48), at: 0 });
  const p = t.warm();
  await tick();
  state.sockets[0].readyState = 1; state.sockets[0].onopen();
  await p;
  t.dispose();
  assert.equal(state.sockets[0].readyState, 3);
  await assert.rejects(t.warm(), /disposed/);
});

test('server transport: dispose during lazy init never opens a late connection', async () => {
  const SRC = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');
  const a = SRC.indexOf("    if (localStorage.getItem('rj-transport') === 'server')");
  const b = SRC.indexOf('    const inst = new (await loadEpoxy())', a);
  assert.ok(a > 0 && b > a, 'server transport slice found');
  let resolve, opens = 0, closes = 0, frees = 0;
  const gate = new Promise((r) => resolve = r);
  const c = vm.createContext({
    localStorage: { getItem: () => 'server' },
    TypeError, Set,
    loadEpoxy: async () => { await gate; return class { async init() {} free() { frees++; } connect() { opens++; return [() => {}, () => closes++]; } }; },
  });
  vm.runInContext('async function make(wisp){' + SRC.slice(a, b) + '};this.make=make;', c);
  const t = await c.make('fake');
  t.connect('ws://x', [], [], () => {}, () => {}, () => {}, () => {});
  t.dispose();
  resolve();
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(opens, 0, 'no connection opens after dispose');
  assert.equal(closes, 0, 'nothing to close: nothing opened');
  assert.equal(frees, 1, 'the late-arriving epoxy instance is freed');
});

test('server transport: dispose closes a connection that already opened', async () => {
  const SRC = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');
  const a = SRC.indexOf("    if (localStorage.getItem('rj-transport') === 'server')");
  const b = SRC.indexOf('    const inst = new (await loadEpoxy())', a);
  let opens = 0, closes = 0;
  const c = vm.createContext({
    localStorage: { getItem: () => 'server' },
    TypeError, Set,
    loadEpoxy: async () => class { async init() {} free() {} connect() { opens++; return [() => {}, () => closes++]; } },
  });
  vm.runInContext('async function make(wisp){' + SRC.slice(a, b) + '};this.make=make;', c);
  const t = await c.make('fake');
  t.connect('ws://x', [], [], () => {}, () => {}, () => {}, () => {});
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(opens, 1, 'connection opened before dispose');
  t.dispose();
  assert.equal(closes, 1, 'dispose closes the open connection');
  assert.throws(() => t.connect('ws://x', [], [], () => {}, () => {}, () => {}, () => {}), /disposed/, 'connect after dispose refuses');
});
