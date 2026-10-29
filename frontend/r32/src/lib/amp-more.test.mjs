// behavioural pins for amp search continuation + source-level guards that Amp.svelte wires it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeMore, moreBump, moreFirstPage, moreCapture, moreApply, moreAutoOk, moreAutoSpend, AUTO_PAGE_BUDGET } from './amp-more.mjs';
import { errCopy } from './api.js';
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

test('400/502 copy is the reviewed fallback, never the server envelope', () => {
  assert.equal(errCopy({ ok: false, status: 400, data: { error: 'that cursor is not understood - only audius pages continue' } }, 'those results stopped answering.'), 'those results stopped answering.');
  assert.equal(errCopy({ ok: false, status: 502, data: { error: 'the catalog timed out - try again' } }, "couldn't load more songs."), "couldn't load more songs.");
});
test('viewport recheck + narrow-list guards: bounded, view-checked after await', () => {
  const s = rd('../pages/amp/Amp.svelte');
  assert.match(s, /await tick\(\);\n    if \(searched && view === 'search' && more\.cursor && !auBusy && moreAutoOk\(more\) && window\.innerHeight \+ window\.scrollY > document\.documentElement\.scrollHeight - 900\) \{ moreAutoSpend\(more\); moreAudius\(\); \}/);
  assert.match(s, /moreFirstPage\(more, r\.data\.next\);[^\n]*\n    recheckMore\(\);/);
  assert.match(s, /auBusy = false;\n    if \(view !== 'search'\) return;/);
  assert.match(s, /if \(add\.length\) \{ sections = \[\.\.\.sections, \.\.\.add\]; recheckMore\(\); \}/);
});

test('autofill budget: three automatic pages per search, then the chain stops; a new search refills it', () => {
  const m = makeMore();
  for (let i = 0; i < AUTO_PAGE_BUDGET; i++) { assert.ok(moreAutoOk(m), 'page ' + i + ' inside budget'); moreAutoSpend(m); }
  assert.equal(moreAutoOk(m), false);
  moreBump(m);
  assert.ok(moreAutoOk(m));
});
test('manual scroll path stays unbudgeted: onScroll calls moreAudius directly, only recheckMore spends', () => {
  const s = rd('../pages/amp/Amp.svelte');
  const onScroll = /const onScroll = \(\) => \{[^}]*\}/.exec(s)[0];
  assert.doesNotMatch(onScroll, /moreAuto|recheckMore/);
  assert.match(onScroll, /moreAudius\(\)/);
  assert.match(s, /\{ moreAutoSpend\(more\); moreAudius\(\); \}/);
});
