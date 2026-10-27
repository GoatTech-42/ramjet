// source-level guards for the svelte-side race fixes (the components cannot be imported under node), plus a behavioural test of the SW marker sniff
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rd = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('jetstream: a superseded search never clears busy', () => {
  const s = rd('../pages/jetstream/Jetstream.svelte');
  assert.match(s, /const sid = \+\+searchSeq;/);
  assert.ok(s.indexOf('if (sid !== searchSeq) return;') < s.indexOf('if (!intent.ok(mine)) { busy = false; return; }'));
});
test('amp: the resume seek is one-shot, url-checked and removed when another song starts', () => {
  const s = rd('../pages/amp/Amp.svelte');
  assert.match(s, /if \(el\.src === url\)/);
  assert.match(s, /if \(seekH && el\) \{ el\.removeEventListener\('loadedmetadata', seekH\)/);
});
test('browse: tickets fail closed, probe and transport get separate tickets, boot has a total deadline', () => {
  const s = rd('../pages/browse/Browse.svelte');
  assert.doesNotMatch(s, /return pwsUrl;/);
  assert.match(s, /ticket 2: the probe burned ticket 1/);
  assert.match(s, /bootDeadline - 12000/);
  assert.match(s, /noRetry: r\.status === 401/);
});
test('sw: only the first bytes of a 5xx page load are read for the marker', async () => {
  const src = rd('../public/browse-sw.js');
  const fn = /const MARKER[\s\S]*$/.exec(src)[0];
  const startsWithMarker = new Function(fn + '; return startsWithMarker;')();
  assert.equal(await startsWithMarker(new Response('Internal Service Worker Error: boom', { status: 500 })), true);
  assert.equal(await startsWithMarker(new Response('<html>real site 500</html>', { status: 500 })), false);
  // an endless body must not hang or be read in full
  let pulls = 0;
  const endless = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new TextEncoder().encode('xxxxxxxx')); } }), { status: 500 });
  assert.equal(await startsWithMarker(endless), false);
  assert.ok(pulls < 20);
  assert.match(src, /e\.request\.destination === "document"/);
});

test('jetstream search: the intent token is taken after back() (back bumps), so a plain search keeps its results', async () => {
  const s = rd('../pages/jetstream/Jetstream.svelte');
  const body = s.slice(s.indexOf('async function search(e)'), s.indexOf('async function moreSearch'));
  assert.ok(body.indexOf('back();') > 0 && body.indexOf('back();') < body.indexOf('intent.begin()'));
  assert.ok(body.indexOf('busy = true;') < body.indexOf('const sid = ++searchSeq;'));
  // and the contract the order relies on: a token taken before a bump is dead, one taken after is live
  const { createIntent } = await import('../pages/jetstream/fresh-gate.js');
  const i = createIntent(); const before = i.begin(); i.bump(); const after = i.begin();
  assert.equal(i.ok(before), false); assert.equal(i.ok(after), true);
});

test('search pager: a 429 or 403 is marked noRetry, an ordinary failure is not', async () => {
  const { createSearchPager } = await import('../pages/jetstream/search-pager.js');
  for (const [status, want] of [[429, true], [403, true], [500, false], [0, false]]) {
    const p = createSearchPager(async () => ({ ok: false, status, data: {} }));
    const v = await p.start('x');
    assert.equal(v.noRetry, want, 'status ' + status);
    assert.ok(v.err);
  }
});
