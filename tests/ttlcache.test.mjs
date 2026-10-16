import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../core/ttlcache.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('hit within ttl, miss after expiry', async () => {
  const c = new TtlCache(40, 10);
  c.set('k', 'v');
  assert.equal(c.get('k'), 'v');
  await sleep(60);
  assert.equal(c.get('k'), undefined);
});

test('fifo cap evicts oldest', () => {
  const c = new TtlCache(60000, 2);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
});

test('through: computes once, caches the value', async () => {
  const c = new TtlCache(60000, 10);
  let n = 0;
  const fn = async () => { n++; return 'x'; };
  assert.equal(await c.through('k', fn), 'x');
  assert.equal(await c.through('k', fn), 'x');
  assert.equal(n, 1);
});

test('through: a rejection caches nothing and the next call retries', async () => {
  const c = new TtlCache(60000, 10);
  let n = 0;
  await assert.rejects(() => c.through('k', async () => { n++; throw new Error('down'); }));
  assert.equal(c.get('k'), undefined);
  assert.equal(await c.through('k', async () => 'back'), 'back');
  assert.equal(n, 1);
});

test('stored values are deep-frozen against caller mutation', () => {
  const c = new TtlCache(1000, 10);
  const v = c.set('k', { a: 1, nested: { list: [1, 2] } });
  assert.ok(Object.isFrozen(v));
  assert.ok(Object.isFrozen(v.nested));
  assert.ok(Object.isFrozen(v.nested.list));
  assert.throws(() => { c.get('k').a = 2; }, TypeError);
  assert.throws(() => { c.get('k').nested.list.push(3); }, TypeError);
});

test('overwriting an existing key at capacity evicts nothing', () => {
  const c = new TtlCache(1000, 3);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  c.set('b', 22); // overwrite while full: no third key may be evicted
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('b'), 22);
  assert.equal(c.get('c'), 3);
  c.set('d', 4); // a genuine insert evicts the oldest (a; b refreshed on overwrite)
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 22);
});

test('through: concurrent misses both compute, late resolution wins the slot', async () => {
  const c = new TtlCache(1000, 10);
  let n = 0;
  const slow = (v, ms) => new Promise((r) => setTimeout(() => r(v), ms));
  const [a, b] = await Promise.all([
    c.through('k', () => { n++; return slow('first', 30); }),
    c.through('k', () => { n++; return slow('second', 5); }),
  ]);
  assert.equal(n, 2, 'misses are not coalesced (documented, accepted)');
  assert.equal(a, 'first');
  assert.equal(b, 'second');
  assert.equal(c.get('k'), 'first', 'the late resolution holds the slot');
});
