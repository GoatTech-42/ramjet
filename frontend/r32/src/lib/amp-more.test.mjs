// behavioural pins for amp search continuation + source-level guards that Amp.svelte wires it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeMore, moreBump, moreFirstPage, moreCapture, moreApply } from './amp-more.mjs';
const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('ABA: a same-query re-search re-minting the same cursor still rejects the late page', () => {
  const m = makeMore();
  moreFirstPage(m, { audius: 'au:12' });
  const cap = moreCapture(m);           // continuation for au:12 goes in flight
  moreBump(m);                          // user re-searches the SAME query
  moreFirstPage(m, { audius: 'au:12' }); // the new first page mints au:12 again - cursor equality alone would pass
  const d = moreApply(m, cap, 200, { results: { audius: [{ key: 'au:x' }] }, next: { audius: 'au:24' } });
  assert.equal(d.type, 'stale');
  assert.equal(m.cursor, 'au:12');      // the live cursor is untouched by the late page
});
test('same generation: rows apply and the next cursor is taken; null next is the truthful end', () => {
  const m = makeMore();
  moreFirstPage(m, { audius: 'au:12' });
  const d = moreApply(m, moreCapture(m), 200, { results: { audius: [{ key: 'au:a' }, { key: 'au:b' }] }, next: { audius: 'au:24' } });
  assert.equal(d.type, 'rows'); assert.equal(d.rows.length, 2); assert.equal(m.cursor, 'au:24');
  const d2 = moreApply(m, moreCapture(m), 200, { results: { audius: [] }, next: { audius: null } });
  assert.equal(d2.type, 'rows'); assert.equal(m.cursor, null);
});
test('400 invalid cursor: continuation ends, cursor cleared, nothing retryable', () => {
  const m = makeMore();
  moreFirstPage(m, { audius: 'au:12' });
  const d = moreApply(m, moreCapture(m), 400, { error: 'that cursor is not understood - only audius pages continue' });
  assert.equal(d.type, 'end'); assert.equal(m.cursor, null);
});
test('502 catalog timeout: cursor kept so the retry can continue', () => {
  const m = makeMore();
  moreFirstPage(m, { audius: 'au:12' });
  const d = moreApply(m, moreCapture(m), 502, { error: 'the catalog timed out - try again' });
  assert.equal(d.type, 'error'); assert.equal(m.cursor, 'au:12');
});
test('component wiring: gen bumped on search, back-home and playlist open; no yt/sc continuation', () => {
  const s = rd('../pages/amp/Amp.svelte');
  assert.match(s, /searchedQ = q\.trim\(\); moreBump\(more\);/);
  assert.match(s, /function backHome\(\) \{\n    plGen\+\+;\n    moreBump\(more\);/);
  assert.match(s, /const g = \+\+plGen;\n    moreBump\(more\);/);
  assert.match(s, /cap = moreCapture\(more\)/);
  assert.match(s, /moreApply\(more, cap, r\.status, r\.data\)/);
  assert.match(s, /if \(d\.type === 'stale'\) return;/);
  assert.match(s, /if \(d\.type === 'end'\)/);
  assert.doesNotMatch(s, /cursor=yt|cursor=sc|next\.youtube|next\.soundcloud/);
});
