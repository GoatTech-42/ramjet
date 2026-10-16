import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortsFeed } from '../core/addons/jetstream/shorts-rank.js';
test('served IDs cover 120 unique items and are capped at 500 per account', async () => {
  const items = Array.from({ length: 600 }, (_, i) => ({ id: String(i) }));
  const feed = createShortsFeed({ build: async () => items });
  const seen = new Set();
  for (let i = 0; i < 9; i++) {
    const batch = await feed.get('fixture');
    for (const v of batch) { assert.ok(!seen.has(v.id)); seen.add(v.id); }
    feed.serve('fixture', batch);
  }
  assert.equal(seen.size, 126);
  feed.serve('fixture', items);
  assert.equal(feed._cache.get('fixture').served.size, 500);
  assert.ok(!feed._cache.get('fixture').served.has('0'));
  assert.ok(feed._cache.get('fixture').served.has('599'));
});
