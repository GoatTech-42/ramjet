import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTrack, serializeQueue, restoreQueue, loadQueue, QKEY } from './queue-persist.js';
const NOW = 1_800_000_000_000;
const row = (dur) => ['yt', 'abcdefghijk', 't', 'a', 'b', dur, ''];
const raw = (o) => JSON.stringify({ v: 1, t: NOW, qi: 0, pos: 0, sh: false, rp: 'off', q: [row(200)], ...o });

test('non-finite and absurd durations are clamped', () => {
  assert.equal(cleanTrack({ src: 'yt', id: 'abcdefghijk', title: 't', durSec: Infinity }).durSec, 0);
  assert.equal(cleanTrack({ src: 'yt', id: 'abcdefghijk', title: 't', durSec: NaN }).durSec, 0);
  assert.equal(cleanTrack({ src: 'yt', id: 'abcdefghijk', title: 't', durSec: 1e9 }).durSec, 86400);
  assert.equal(cleanTrack({ src: 'yt', id: 'abcdefghijk', title: 't', durSec: -5 }).durSec, 0);
  assert.equal(restoreQueue(raw({ q: [row(null)] }), NOW).queue[0].durSec, 0);
});
test('future-dated saves are rejected, small clock skew is fine', () => {
  assert.equal(restoreQueue(raw({ t: NOW + 7 * 24 * 3600 * 1000 }), NOW), null);
  assert.ok(restoreQueue(raw({ t: NOW + 60000 }), NOW));
});
test('loadQueue removes unusable entries and keeps good ones', () => {
  const m = new Map(); const st = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  m.set(QKEY, raw({ t: NOW - 8 * 24 * 3600 * 1000 })); assert.equal(loadQueue(st, NOW), null); assert.equal(m.has(QKEY), false);
  m.set(QKEY, '{not json'); assert.equal(loadQueue(st, NOW), null); assert.equal(m.has(QKEY), false);
  m.set(QKEY, raw()); assert.ok(loadQueue(st, NOW)); assert.equal(m.has(QKEY), true);
});
