import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(process.env.AMP_SVELTE || new URL('../pages/amp/Amp.svelte', import.meta.url), 'utf8');
const a = src.indexOf('const PL_CAP = 20;'), b = src.indexOf('async function createPlaylist(e)');
assert.ok(a > 0 && b > a);
const mk = (names) => new Function('playlists', 'errCopy', src.slice(a, b) + '; return { uniqueName, createErr, nameTaken, CAP_COPY, DUP_COPY };')(names.map((name) => ({ name })), (r, f) => f);
test('unique names get (2), (3), case-insensitive, and stay within 40 chars', () => {
  const m = mk(['Road Mix', 'road mix (2)']);
  assert.equal(m.uniqueName('road mix'), 'road mix (3)');
  assert.equal(m.uniqueName('fresh'), 'fresh');
  const long = 'x'.repeat(40); const m2 = mk([long]);
  const u = m2.uniqueName(long); assert.equal(u.length, 40); assert.ok(u.endsWith(' (2)'));
});
test('create refusals map to fixed local copy; unknown text is never shown', () => {
  const m = mk([]);
  assert.equal(m.createErr({ status: 400, data: { error: 'twenty playlists is plenty - delete one first' } }), m.CAP_COPY);
  assert.equal(m.createErr({ status: 400, data: { error: 'you already have one called that' } }), m.DUP_COPY);
  assert.equal(m.createErr({ status: 400, data: { error: 'something odd from the server' } }), "playlist couldn't be created.");
});
test('uniqueName: emoji are cut by code point, 2-digit suffix fits, undefined/blank name is safe', () => {
  const e = '😀'.repeat(40);
  const m = mk([e]);
  const u = m.uniqueName(e); assert.equal(Array.from(u).length, 40); assert.ok(u.endsWith(' (2)')); assert.ok(!/[\uD800-\uDBFF]$/.test(u.replace(' (2)', '')));
  const taken = [e]; for (let i = 2; i <= 9; i++) taken.push(Array.from(e).slice(0, 36).join('') + ' (' + i + ')');
  const m2 = mk(taken); const u2 = m2.uniqueName(e); assert.ok(u2.endsWith(' (10)')); assert.equal(Array.from(u2).length, 40);
  assert.equal(mk([]).uniqueName(undefined), 'imported playlist');
  assert.equal(mk([]).uniqueName('   '), 'imported playlist');
});
