import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, brotliCompressSync, deflateSync, createGzip, createBrotliCompress, createDeflate, constants as Z } from 'node:zlib';
import WebSocket from 'ws';
const root = mkdtempSync(join(tmpdir(), 'rj-decoder-test-'));
process.env.RJ_DATA = root;
process.env.RJ_TEST_HOOKS = '1';
const { pwsUpgrade, testHooks } = await import('../core/pfetch.js');
const raw = Buffer.from('Decoded bytes remain exact, including the final partial chunk.\n'.repeat(20001));
const variants = { gzip: gzipSync(raw), br: brotliCompressSync(raw), deflate: deflateSync(raw) };
const factories = { gzip: createGzip, br: createBrotliCompress, deflate: createDeflate };
let dripEnded = false;
const upstream = http.createServer((req, res) => {
  const [enc, mode] = req.url.slice(1).split('/');
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': enc, 'cache-control': 'no-store', ...(mode === 'drip' ? {} : { 'content-length': variants[enc].length }) });
  if (mode !== 'drip') return res.end(variants[enc]);
  // First bytes must get through with no full 64KB output buffer and no EOF.
  const zip = factories[enc](); zip.pipe(res); zip.write('first few bytes\n');
  zip.flush(enc === 'br' ? Z.BROTLI_OPERATION_FLUSH : Z.Z_SYNC_FLUSH);
  const t = setTimeout(() => { dripEnded = true; zip.end('last bytes\n'); }, 500);
  res.on('close', () => { clearTimeout(t); zip.destroy(); });
});
const tunnel = http.createServer();
tunnel.on('upgrade', (req, socket, head) => pwsUpgrade(req, socket, head, 'decoder-tester', () => {}));
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
await new Promise(r => tunnel.listen(0, '127.0.0.1', r));
let id = 0;
const get = async (enc, mode, first) => {
  const ws = new WebSocket(`ws://127.0.0.1:${tunnel.address().port}/pws-t/${'a'.repeat(48)}/`);
  try {
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
    return await new Promise((resolve, reject) => {
      const mine = ++id, chunks = []; let headed = false;
      const timer = setTimeout(() => reject(Error('decoder response timeout')), 5000);
      ws.on('message', b => {
        if (b.readUInt32BE(0) !== mine) return;
        try {
          if (b[4] === 0) { const h = JSON.parse(b.subarray(5)); assert.equal(h.status, 200); headed = true; }
          if (b[4] === 1) { assert.ok(headed); if (!chunks.length) first?.(); chunks.push(b.subarray(5)); }
          if (b[4] === 2) { clearTimeout(timer); resolve(Buffer.concat(chunks)); }
          if (b[4] === 3) throw Error(b.subarray(5).toString());
        } catch (e) { clearTimeout(timer); reject(e); }
      });
      ws.send(JSON.stringify({ id: mine, url: `http://127.0.0.1:${upstream.address().port}/${enc}/${mode}`, method: 'GET', headers: [], ab: false }));
    });
  } finally { ws.terminate(); }
};
for (const enc of Object.keys(variants)) {
  test(`decoder ${enc}: exact bytes and partial tail through the real tunnel`, async () => assert.deepEqual(await get(enc, 'full'), raw));
  test(`decoder ${enc}: short flushed chunks arrive before upstream EOF`, async () => {
    dripEnded = false;
    const body = await get(enc, 'drip', () => assert.equal(dripEnded, false, 'first bytes arrived before final upstream chunk'));
    assert.equal(body.toString(), 'first few bytes\nlast bytes\n');
  });
}
test.after(async () => {
  await new Promise(r => setTimeout(r, 25));
  assert.equal(testHooks.upstreams(), 0, 'all stream slots released');
  await new Promise(r => tunnel.close(r));
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  rmSync(root, { recursive: true, force: true });
});
