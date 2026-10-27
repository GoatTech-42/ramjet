import test from 'node:test';
import assert from 'node:assert/strict';
import { whyStopped } from './amp-error-logic.mjs';

test('429 with a stalled body resolves to the fixed bandwidth copy within the deadline', async () => {
  const fetchFn = async () => ({ status: 429, json: () => new Promise(() => {}), body: null });
  const t0 = Date.now();
  const w = await whyStopped('/s', { fetchFn, timeoutMs: 50 });
  assert.equal(w.kind, 'bandwidth');
  assert.equal(w.msg, 'the streaming limit has been reached.');
  assert.ok(Date.now() - t0 < 1000);
});
test('429 json error text never renders: house copy only', async () => {
  const w = await whyStopped('/s', { fetchFn: async () => ({ status: 429, json: async () => ({ error: 'x y' }) }) });
  assert.equal(w.msg, 'the streaming limit has been reached.');
});
test('hung headers resolve to network after the deadline', async () => {
  const w = await whyStopped('/s', { fetchFn: () => new Promise(() => {}), timeoutMs: 50 });
  assert.equal(w.kind, 'network');
});
test('200 is ok, 502 is http', async () => {
  assert.equal((await whyStopped('/s', { fetchFn: async () => ({ status: 206 }) })).kind, 'ok');
  assert.equal((await whyStopped('/s', { fetchFn: async () => ({ status: 502 }) })).kind, 'http');
});
import { handleTrackError } from './amp-error-logic.mjs';
test('DIV-18: fallback finds the other-source copy in the queue, not only the visible sections', () => {
  const now = { title: 'Some Song', src: 'yt', qi: 0, key: 'a' };
  const alt = { title: 'Some Song', src: 'sc', stream: '/x', key: 'b' };
  const r = handleTrackError({ now, sections: [], queue: [now, alt], errStreak: 0, retried: true }, { kind: 'http' });
  assert.equal(r.action, 'fallback'); assert.equal(r.altKey, 'b');
});
