import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { negotiateEncoding, compressed } from '../core/staticzip.js';

test('negotiateEncoding: prefers br over gzip', () => {
  assert.equal(negotiateEncoding('gzip, deflate, br'), 'br');
  assert.equal(negotiateEncoding('gzip'), 'gzip');
  assert.equal(negotiateEncoding(''), '');
  assert.equal(negotiateEncoding('deflate'), '');
  assert.equal(negotiateEncoding(undefined), '');
});

test('negotiateEncoding: q=0 means not acceptable', () => {
  assert.equal(negotiateEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(negotiateEncoding('gzip;q=0, br;q=0'), '');
  assert.equal(negotiateEncoding('br;q=0.5'), 'br');
  assert.equal(negotiateEncoding('*;q=1.0'), 'br');
  assert.equal(negotiateEncoding('*;q=0'), '');
});

test('compressed: br and gzip round-trip the raw buffer', async () => {
  const raw = Buffer.from('x'.repeat(5000) + 'ramjet');
  const e = { raw, br: null, gz: null };
  const br = await compressed(e, 'br');
  assert.ok(Buffer.isBuffer(e.br)); // slot settled into the cached Buffer
  assert.deepEqual(brotliDecompressSync(br).toString(), raw.toString());
  const gz = await compressed(e, 'gzip');
  assert.ok(Buffer.isBuffer(e.gz));
  assert.deepEqual(gunzipSync(gz).toString(), raw.toString());
});

test('compressed: concurrent callers share one promise and one buffer', async () => {
  const e = { raw: Buffer.alloc(10000, 7), br: null, gz: null };
  const [a, b] = await Promise.all([compressed(e, 'br'), compressed(e, 'br')]);
  assert.equal(a, b); // same Buffer, compressed once
  const c = await compressed(e, 'br'); // after resolution: no promise slot churn
  assert.equal(c, a);
});

test('compressed: unknown encoding rejects', async () => {
  const e = { raw: Buffer.from('a'.repeat(2000)), br: null, gz: null };
  await assert.rejects(() => compressed(e, 'deflate'));
  // slot reset to null so a later valid call is unaffected
  const gz = await compressed(e, 'gzip');
  assert.ok(gz.length > 0);
});
