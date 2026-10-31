// behavioural pins for the amp partial-source error consumer + source-level guards
// that Amp.svelte wires it. envelope contract (backend amp_media combine): failed[]
// names only attempted-and-failed catalogs in stable order; a cursored page's
// unattempted sources are absent from it; all-fail stays a 502 (handled as an error,
// never reaches sourceSplit).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceSplit, AMP_SOURCES } from './amp-sources.mjs';
const sv = readFileSync(new URL('../pages/amp/Amp.svelte', import.meta.url), 'utf8');

test('a failed catalog with no rows is "couldn\'t load", never "no results"', () => {
  const r = sourceSplit({ youtube: [], soundcloud: [], audius: [] }, ['youtube', 'audius']);
  assert.deepEqual(r.failed, ['youtube', 'audius']);
  assert.deepEqual(r.empty, ['soundcloud']);   // the only true empty
});

test('a source that answered empty and did not fail truly had no results', () => {
  const r = sourceSplit({ youtube: [{ key: 'yt:1' }], soundcloud: [], audius: [] }, []);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.empty, ['soundcloud', 'audius']);
});

test('nothing failed and everything answered: no messages at all', () => {
  const r = sourceSplit({ youtube: [{ key: 'a' }], soundcloud: [{ key: 'b' }], audius: [{ key: 'c' }] }, []);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.empty, []);
});

test('older backend without the field: failed=[] and empty derivation is unchanged', () => {
  const r = sourceSplit({ youtube: [], soundcloud: [{ key: 's:1' }], audius: [] }, undefined);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.empty, ['youtube', 'audius']);
});

test('unknown names in failed are dropped; output order stays the source order', () => {
  const r = sourceSplit({ youtube: [], soundcloud: [], audius: [] }, ['audius', 'napster', 'youtube']);
  assert.deepEqual(r.failed, ['youtube', 'audius']);   // stable AMP_SOURCES order, 'napster' dropped
  assert.deepEqual(r.empty, ['soundcloud']);
});

test('failed wins over rows-present garbage: a named failure is never reclassified', () => {
  const r = sourceSplit({ youtube: [{ key: 'yt:9' }], soundcloud: [], audius: [] }, ['youtube']);
  assert.deepEqual(r.failed, ['youtube']);
  assert.deepEqual(r.empty, ['soundcloud', 'audius']);   // youtube is in neither empty list
});

test('AMP_SOURCES stays exactly the three catalogs the envelope knows', () => {
  assert.deepEqual(AMP_SOURCES, ['youtube', 'soundcloud', 'audius']);
});

// source-level guards: the page actually wires the split and the two distinct copies
test('Amp.svelte wires sourceSplit into the first page and resets the failed list per search', () => {
  assert.match(sv, /import \{ sourceSplit \} from '\.\.\/\.\.\/lib\/amp-sources\.mjs';/);
  assert.match(sv, /sourceSplit\(r\.data\.results, r\.data\.failed\)/);
  assert.match(sv, /srcEmpty = \[\]; srcFailed = \[\]; searched = false/);
});
test('Amp.svelte renders the two outcomes with distinct copy', () => {
  assert.match(sv, /\{#each srcFailed as s\}<p class="dim">couldn't load \{s\}\.<\/p>\{\/each\}/);
  assert.match(sv, /\{#each srcEmpty as s\}<p class="dim">no results from \{s\}<\/p>\{\/each\}/);
  assert.ok(sv.indexOf('srcFailed as s') < sv.indexOf('srcEmpty as s'), 'failures read before empties');
});
test('the artist narrowing never reclassifies a failed source as empty', () => {
  assert.match(sv, /!srcFailed\.includes\(k\) && !page\.counts/);
});
