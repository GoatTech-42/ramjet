import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

let proc, base, dir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rj-speed-'));
  writeFileSync(join(dir, 'users.json'), '{}');
  // probe a free port
  const { createServer } = await import('node:net');
  const port = await new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', ['core/index.js'], {
    env: { ...process.env, RJ_HOST: '127.0.0.1', RJ_PORT: String(port), RJ_DATA: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('ramjet2 on')) up = true; });
  for (let i = 0; i < 100 && !up; i++) await sleep(100);
  assert.ok(up, 'server did not boot');
});

after(() => { proc?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('login page: br compressed with etag and vary', async () => {
  const r = await fetch(`${base}/login`, { headers: { 'accept-encoding': 'br' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('vary'), 'Accept-Encoding');
  const body = Buffer.from(await r.arrayBuffer());
  assert.match(body.toString(), /ramjet/i); // undici decodes for us
  const etag = r.headers.get('etag');
  assert.ok(etag?.startsWith('W/"'));
  // conditional revalidation
  const r2 = await fetch(`${base}/login`, { headers: { 'if-none-match': etag } });
  assert.equal(r2.status, 304);
});

test('static pinned asset: negotiated br/gzip, q=0 honored', async () => {
  // undici transparently decompresses, so compare decoded bodies against the
  // identity response instead of re-decompressing wire bytes
  const ident = Buffer.from(await (await fetch(`${base}/cloak/palette.js`, { headers: { 'accept-encoding': 'identity' } })).arrayBuffer());

  const r = await fetch(`${base}/cloak/palette.js`, { headers: { 'accept-encoding': 'br, gzip' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-encoding'), 'br');
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), ident);

  const r2 = await fetch(`${base}/cloak/palette.js`, { headers: { 'accept-encoding': 'br;q=0, gzip' } });
  assert.equal(r2.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(Buffer.from(await r2.arrayBuffer()), ident);

  const r3 = await fetch(`${base}/cloak/palette.js`, { headers: { 'accept-encoding': 'gzip;q=0, br;q=0' } });
  assert.equal(r3.headers.get('content-encoding'), null);
  assert.equal(r3.headers.get('vary'), 'Accept-Encoding');
  assert.deepEqual(Buffer.from(await r3.arrayBuffer()), ident);
});

test('pages are byte-stable across requests (memoized, not re-stamped)', async () => {
  const a = Buffer.from(await (await fetch(`${base}/login`)).arrayBuffer());
  const b = Buffer.from(await (await fetch(`${base}/login`)).arrayBuffer());
  assert.deepEqual(a, b);
});
