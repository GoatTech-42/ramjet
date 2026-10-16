import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// the worker's proxy-failure page must always offer a way back without
// hunting for the browser reload button (phone users, fullscreen tabs)
test('browse-sw errPage includes a try-again reload', () => {
  const sw = readFileSync(new URL('../web/src/public/browse-sw.js', import.meta.url), 'utf8');
  assert.match(sw, /location\.reload\(\)/);
  assert.match(sw, /try again/);
});

test('browse failed state offers an in-app retry (bootCycle restart)', () => {
  const svelte = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');
  assert.match(svelte, /try again/);
  assert.match(svelte, /bootCycle \+= 1/);
});

test('browse retry: revision failures reload the document, transient reboot in place', () => {
  const svelte = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');
  // the retry must branch on failure kind
  assert.match(svelte, /failedKind === 'revision'\) \{ location\.reload\(\)/);
  // revision kind is set at each unrecoverable-in-page failure site
  assert.match(svelte, /engine files did not load[^`]*?failedKind = 'revision'/s);
  assert.match(svelte, /out of date - close this tab[^`]*?failedKind = 'revision'/s);
  assert.match(svelte, /ramjet updated - reload[^`]*?failedKind = 'revision'/s);
  // worker bootstrap errors classify as revision in the catch
  assert.match(svelte, /\/worker\/i\.test\(failed\)\) failedKind = 'revision'/);
  // the engine global is read with a safe lookup: an undefined
  // $scramjetController must hit the revision-marked branch, never throw
  assert.match(svelte, /globalThis\.\$scramjetController\?\.Controller/);
  assert.doesNotMatch(svelte, /const \{ Controller \} = globalThis/);
  // a (re)boot always resets to transient
  assert.match(svelte, /failed = ''; failedKind = 'transient'/);
});

test('raw /api/ fetches in browse and sage route through the 401 bounce', () => {
  const browse = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');
  assert.doesNotMatch(browse, /[^b]fetch\('\/api\//, 'bare fetch to /api/ left in Browse.svelte');
  const sage = readFileSync(new URL('../web/src/pages/sage/Sage.svelte', import.meta.url), 'utf8');
  assert.match(sage, /bounceToLoginOn401\('\/api\/apps\/sage\/chat', res\.status\)/);
});
