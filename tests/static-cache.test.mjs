import test from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import http from 'node:http';
import { writeFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { withTempServer } from './fixtures/start-server.mjs';

const PROBE = new URL('../web/dist/assets/rj-cache-probe.txt', import.meta.url);

// raw GET with a caller-controlled accept-encoding (undici would transparently
// decompress and hide the wire bytes this test asserts on)
const rawGet = (url, headers) => new Promise((resolve, reject) => {
  http.get(url, { headers }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', reject);
  }).on('error', reject);
});

// static engine files are several MB and ride every browse page open: they
// must carry etags (cheap 304 revalidation under no-cache) and pre-compressed
// variants that never go stale across a rebuild.
test('static engine files: etag 304 revalidation, compressed variants, no stale bytes after rebuild', async () => {
  await withTempServer(async ({ base }) => {
    const plain = await fetch(base + '/scramjet/scramjet.js', { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.status, 200);
    const etag = plain.headers.get('etag');
    assert.ok(etag, 'etag present');
    assert.match(plain.headers.get('cache-control') || '', /no-cache/, 'engine files stay no-cache');
    const body = await plain.text();

    const re = await fetch(base + '/scramjet/scramjet.js', { headers: { 'if-none-match': etag, 'accept-encoding': 'identity' } });
    assert.equal(re.status, 304, 'matching etag revalidates with a 304');
    await re.arrayBuffer();

    const br = await rawGet(base + '/scramjet/scramjet.js', { 'accept-encoding': 'br' });
    assert.equal(br.headers['content-encoding'], 'br');
    assert.ok(br.body.length < Buffer.byteLength(body), 'br variant is actually smaller on the wire');
    assert.equal(brotliDecompressSync(br.body).toString('utf8'), body, 'br decodes to the identity body');

    const gz = await rawGet(base + '/scramjet/scramjet.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(gunzipSync(gz.body).toString('utf8'), body, 'gzip decodes to the identity body');

    const missed = await fetch(base + '/scramjet/scramjet.js', { headers: { 'if-none-match': 'W/"0-0"', 'accept-encoding': 'identity' } });
    assert.equal(missed.status, 200, 'a stale etag gets the full body');
    await missed.arrayBuffer();
  });
});

test('static cache: a same-length rebuild changes the etag and yields fresh bytes', async () => {
  await withTempServer(async ({ base }) => {
    const u = base + '/assets/rj-cache-probe.txt';
    try {
      writeFileSync(PROBE, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); // 32 bytes
      const r1 = await fetch(u, { headers: { 'accept-encoding': 'identity' } });
      const etag1 = r1.headers.get('etag');
      assert.equal(await r1.text(), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      writeFileSync(PROBE, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'); // same length, new content
      const r2 = await fetch(u, { headers: { 'if-none-match': etag1, 'accept-encoding': 'identity' } });
      assert.equal(r2.status, 200, 'old etag after rebuild gets the full body, not a 304');
      assert.equal(await r2.text(), 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'fresh bytes served');
      assert.notEqual(r2.headers.get('etag'), etag1, 'content-hash etag changed on same-length rebuild');
    } finally { rmSync(PROBE, { force: true }); }
  });
});

test('static cache: a same-length rebuild with a PRESERVED mtime still yields fresh bytes', async () => {
  await withTempServer(async ({ base }) => {
    const u = base + '/assets/rj-cache-probe.txt';
    try {
      writeFileSync(PROBE, 'cccccccccccccccccccccccccccccccc'); // 32 bytes
      const r1 = await fetch(u, { headers: { 'accept-encoding': 'identity' } });
      const etag1 = r1.headers.get('etag');
      assert.equal(await r1.text(), 'cccccccccccccccccccccccccccccccc');
      const old = statSync(PROBE);
      writeFileSync(PROBE, 'dddddddddddddddddddddddddddddddd'); // same length, new content
      utimesSync(PROBE, old.atime, old.mtime); // mtime preserved; ctime still bumps
      const r2 = await fetch(u, { headers: { 'if-none-match': etag1, 'accept-encoding': 'identity' } });
      assert.equal(r2.status, 200, 'preserved-mtime rewrite gets the full body, not a 304');
      assert.equal(await r2.text(), 'dddddddddddddddddddddddddddddddd', 'ctime revalidation caught the rewrite');
    } finally { rmSync(PROBE, { force: true }); }
  });
});

test('static cache: deleted warm entries and missing files remain 404s', async () => {
  await withTempServer(async ({ base }) => {
    try {
      writeFileSync(PROBE, 'warm-then-delete');
      const warm = await fetch(base + '/assets/rj-cache-probe.txt');
      assert.equal(warm.status, 200);
      assert.equal(await warm.text(), 'warm-then-delete');
      rmSync(PROBE);
      const gone = await fetch(base + '/assets/rj-cache-probe.txt');
      assert.equal(gone.status, 404);
      await gone.arrayBuffer();
      const missing = await fetch(base + '/assets/rj-speed-no-such-file.txt');
      assert.equal(missing.status, 404);
      await missing.arrayBuffer();
    } finally { rmSync(PROBE, { force: true }); }
  });
});
