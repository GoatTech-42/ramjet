import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
const bigBlock = randomBytes(1024 * 1024); // incompressible fixture block

// box-side proxy speed: websocket tunnel compression + the anonymous asset
// cache. loopback upstreams are allowed under RJ_TEST_HOOKS (set before the
// module import); a real ws client drives pwsUpgrade end to end.
const root = mkdtempSync(join(tmpdir(), 'rj-pws-'));
process.env.RJ_DATA = root;
process.env.RJ_TEST_HOOKS = '1';
const { pwsUpgrade, testHooks, tunnelCompressible } = await import('../core/pfetch.js');

let hits = 0;
const big = Buffer.alloc(64 * 1024, 'a').toString();
const bomb = gzipSync(Buffer.alloc(300 * 1024 * 1024)); // a few hundred KB on the wire, ~300MB decoded
const upstream = http.createServer((req, res) => {
  hits++;
  const path = req.url.split('?')[0];
  const body = Buffer.from('asset-body:' + req.url + ':' + big);
  if (path === '/cached.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600' });
    return res.end(body);
  }
  if (path === '/nostore.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (path === '/setcookie.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', 'set-cookie': 'a=b' });
    return res.end(body);
  }
  if (path === '/dupcc.js') { // duplicate response headers: joined evaluation must see no-store
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': ['public, max-age=600', 'no-store'] });
    return res.end(body);
  }
  if (path === '/aged.js') { // Age eats the whole max-age: nothing left to cache
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', age: '600' });
    return res.end(body);
  }
  if (path === '/truncated.js') { // declares more than it sends, then drops the connection
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', 'content-length': body.length * 4 });
    res.write(body);
    return res.socket.end();
  }
  if (path === '/bomb.gz') { // ~300MB of zeros behind a tiny gzip: must hit the decoded cap
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    return res.end(bomb);
  }
  if (path === '/conflictcc.js') { // two max-age claims that disagree: refuse
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600, max-age=0' });
    return res.end(body);
  }
  if (path === '/badage.js') { // unparseable Age: refuse
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', age: 'abc' });
    return res.end(body);
  }
  if (path === '/malformedcc.js') { // max-age with no number: refuse
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=later' });
    return res.end(body);
  }
  if (path === '/zstd.bin') { // an encoding the tunnel cannot decode
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-encoding': 'zstd' });
    return res.end(body);
  }
  if (path === '/aged500.js') { // upstream already aged: max-age 600, Age 500
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', age: '500' });
    return res.end(body);
  }
  if (path === '/badagex.js') { // Age value chosen by ?a= for strict-parse refusals
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', age: new URL(req.url, 'http://x').searchParams.get('a') || '0' });
    return res.end(body);
  }
  if (path === '/quotedcc.js') { // quoted, spaced, uppercase: canonicalized at capture
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, MAX-AGE = "600"' });
    return res.end(body);
  }
  if (path === '/slower.js') { // 2MB cacheable body, ~3s drip: download time must count as age
    const total = 2 * 1024 * 1024;
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', 'content-length': total });
    let sentBytes = 0;
    const t = setInterval(() => {
      const c = Buffer.alloc(Math.min(32 * 1024, total - sentBytes), 's');
      sentBytes += c.length;
      res.write(c);
      if (sentBytes >= total) { clearInterval(t); res.end(); }
    }, 50);
    res.on('close', () => clearInterval(t));
    return;
  }
  if (path === '/big.js') { // 32MB of INCOMPRESSIBLE bytes: deflate cannot shrink the flood's wire size
    const total = 32 * 1024 * 1024;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'content-length': total });
    let sentBytes = 0;
    const t = setInterval(() => {
      const n = Math.min(256 * 1024, total - sentBytes);
      sentBytes += n;
      res.write(bigBlock.subarray(0, n));
      if (sentBytes >= total) { clearInterval(t); res.end(); }
    }, 5);
    res.on('close', () => clearInterval(t));
    return;
  }
  if (path === '/drip.js') { // 2MB no-store body, 32KB/50ms drip: coalescing must not hold it
    const total = 2 * 1024 * 1024;
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'content-length': total });
    let sentBytes = 0;
    const t = setInterval(() => {
      const c = Buffer.alloc(Math.min(32 * 1024, total - sentBytes), 'd');
      sentBytes += c.length;
      res.write(c);
      if (sentBytes >= total) { clearInterval(t); res.end(); }
    }, 50);
    res.on('close', () => clearInterval(t));
    return;
  }
  if (path === '/slow.js') { // 3MB cacheable body, slow drip: cancel mid-capture target
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=600', 'content-length': 3 * 1024 * 1024 });
    let sentBytes = 0;
    const t = setInterval(() => {
      const c = Buffer.alloc(64 * 1024, 's');
      sentBytes += c.length;
      if (sentBytes >= 3 * 1024 * 1024) { clearInterval(t); return res.end(); }
      res.write(c);
    }, 10);
    req.on('close', () => clearInterval(t));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }); // no cache-control: not cacheable
  res.end(body);
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upBase = 'http://127.0.0.1:' + upstream.address().port;

const srv = http.createServer();
srv.on('upgrade', (req, socket, head) => pwsUpgrade(req, socket, head, 'tester', () => {}));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const wsUrl = 'ws://127.0.0.1:' + srv.address().port + '/pws-t/';

test.after(() => new Promise((r) => srv.close(r)).then(() => new Promise((r) => upstream.close(r))).then(() => rmSync(root, { recursive: true, force: true })));

const openWs = (base) => new Promise((resolve, reject) => {
  const ws = new WebSocket((base || wsUrl) + 'a'.repeat(48) + '/', { perMessageDeflate: true });
  ws.on('open', () => resolve(ws));
  ws.on('error', reject);
});
// a TCP relay that throttles the server->client direction to an adjustable
// drip (and pulls from the server only at that rate): the tunnel's send
// queue builds REAL sustained backpressure, no kernel-timing guesswork
const makeThrottle = (target) => new Promise((resolve) => {
  let rate = 64 * 1024; // bytes pulled per 25ms tick
  const srv = net.createServer((down) => {
    const up = net.connect(new URL(target || wsUrl).port, '127.0.0.1');
    up.on('readable', () => {}); // arm the pull buffer: without a listener the handle never reads
    // readable-mode EOF must be consumed by a read() that returns null: when
    // the server destroys its socket with the pump buffer already drained,
    // skipping read() leaves the FIN unconsumed and 'end'/'close' never fire
    // (zombie tunnel; test 86 flaked on exactly this). read() unconditionally.
    const t = setInterval(() => { const n = Math.min(rate, up.readableLength); if (n > 0) down.write(up.read(n)); else up.read(0); }, 25);
    up.on('error', () => down.destroy());
    down.on('data', (c) => { try { up.write(c); } catch {} });
    down.on('error', () => { clearInterval(t); up.destroy(); });
    down.on('close', () => { clearInterval(t); up.destroy(); });
    up.on('close', () => down.destroy());
  });
  srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'ws://127.0.0.1:' + srv.address().port + '/pws-t/', setRate: (r) => { rate = r; } }));
});
// one tunneled GET: reassemble head + body frames, resolve { status, headers, body }
const poll = async (fn, ms) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('poll timeout'); await new Promise((r) => setTimeout(r, 25)); } };
const wsGet = (ws, url, headers = [], forcedId) => new Promise((resolve, reject) => {
  const id = forcedId || Math.floor(Math.random() * 1e9);
  const chunks = [];
  let head = null;
  const onMsg = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const mid = buf.readUInt32BE(0), type = buf.readUInt8(4);
    if (mid !== id) return;
    if (type === 0) head = JSON.parse(buf.subarray(5).toString('utf8'));
    else if (type === 1) chunks.push(buf.subarray(5));
    else if (type === 2) { ws.off('message', onMsg); resolve({ ...head, body: Buffer.concat(chunks) }); }
    else { ws.off('message', onMsg); reject(new Error('upstream error frame: ' + buf.subarray(5).toString('utf8'))); }
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id, url, method: 'GET', headers }));
});

test('pws: permessage-deflate is negotiated so tunnel payloads are compressed', async () => {
  const ws = await openWs();
  try {
    assert.match(ws.extensions || '', /permessage-deflate/, 'server offers permessage-deflate');
    const r = await wsGet(ws, upBase + '/plain.txt');
    assert.equal(r.status, 200, 'binary framing survives deflate end to end');
    assert.ok(r.body.toString('utf8').startsWith('asset-body:/plain.txt:'));
  } finally { ws.close(); }
});

test('pws: an anonymous cacheable GET is served from the box cache on repeat', async () => {
  const ws = await openWs();
  try {
    const before = hits;
    const r1 = await wsGet(ws, upBase + '/cached.js');
    assert.equal(r1.status, 200);
    assert.equal(hits, before + 1, 'first fetch reaches upstream');
    const r2 = await wsGet(ws, upBase + '/cached.js');
    assert.equal(r2.status, 200);
    assert.equal(hits, before + 1, 'repeat fetch is a cache hit - no upstream round trip');
    assert.deepEqual(r2.body, r1.body, 'cached bytes are identical');
    assert.equal(r2.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1], 'text/javascript');
  } finally { ws.close(); }
});

test('pws: no-store, set-cookie, headerless and credentialed responses are never cached', async () => {
  const ws = await openWs();
  try {
    for (const path of ['/nostore.js', '/setcookie.js', '/plain.txt']) {
      const before = hits;
      await wsGet(ws, upBase + path);
      await wsGet(ws, upBase + path);
      assert.equal(hits, before + 2, path + ' hit upstream twice');
    }
    const before = hits;
    await wsGet(ws, upBase + '/cached.js?cred=1', [['cookie', 'session=abc']]);
    await wsGet(ws, upBase + '/cached.js?cred=1', [['cookie', 'session=abc']]);
    assert.equal(hits, before + 2, 'a request carrying cookies never caches');
  } finally { ws.close(); }
});

test('pws: a warmed anonymous response is never served to a credentialed, ranged, or exotic-header request', async () => {
  const ws = await openWs();
  try {
    await wsGet(ws, upBase + '/cached.js'); // warm anonymously
    let before = hits;
    const r = await wsGet(ws, upBase + '/cached.js', [['cookie', 'session=abc']]);
    assert.equal(r.status, 200);
    assert.equal(hits, before + 1, 'cookie request bypasses the anonymous cache entry');
    before = hits;
    await wsGet(ws, upBase + '/cached.js', [['range', 'bytes=0-9']]);
    assert.equal(hits, before + 1, 'range request bypasses the cache');
    before = hits;
    await wsGet(ws, upBase + '/cached.js', [['x-user', 'victim']]);
    assert.equal(hits, before + 1, 'any header outside the allowlist bypasses the cache');
  } finally { ws.close(); }
});

test('pws: the cache key partitions on allowlisted header values', async () => {
  const ws = await openWs();
  try {
    const before = hits;
    await wsGet(ws, upBase + '/cached.js?lang=1', [['accept-language', 'en']]);
    await wsGet(ws, upBase + '/cached.js?lang=1', [['accept-language', 'de']]);
    assert.equal(hits, before + 2, 'different accept-language is a different entry');
    await wsGet(ws, upBase + '/cached.js?lang=1', [['accept-language', 'de']]);
    assert.equal(hits, before + 2, 'same url + same context is a hit');
  } finally { ws.close(); }
});

test('pws: duplicate response headers are joined before eligibility (max-age + no-store never caches)', async () => {
  const ws = await openWs();
  try {
    const before = hits;
    await wsGet(ws, upBase + '/dupcc.js');
    await wsGet(ws, upBase + '/dupcc.js');
    assert.equal(hits, before + 2, 'doubled cache-control with no-store hit upstream twice');
  } finally { ws.close(); }
});

test('pws: Age counts against max-age - a fully aged response is not cached', async () => {
  const ws = await openWs();
  try {
    const before = hits;
    await wsGet(ws, upBase + '/aged.js');
    await wsGet(ws, upBase + '/aged.js');
    assert.equal(hits, before + 2, 'Age == max-age leaves nothing to cache');
  } finally { ws.close(); }
});

test('pws: a truncated upstream body is an error and never cached', async () => {
  const ws = await openWs();
  try {
    const before = hits;
    // premature close surfaces as an error frame (stream/hang up/truncated)...
    await assert.rejects(wsGet(ws, upBase + '/truncated.js'), /stream|hang up|premature|truncated/);
    await assert.rejects(wsGet(ws, upBase + '/truncated.js'), /stream|hang up|premature|truncated/);
    assert.equal(hits, before + 2, 'truncated responses hit upstream every time, never the cache');
    // ...and an over-long declared body on an otherwise clean end is caught by the completeness check
    const id = 24680;
    const got = new Promise((resolve, reject) => {
      const onMsg = (data) => {
        const buf = Buffer.from(data);
        if (buf.readUInt32BE(0) !== id) return;
        const t = buf.readUInt8(4);
        if (t === 2) { ws.off('message', onMsg); reject(new Error('clean end - should not happen')); }
        if (t === 3) { ws.off('message', onMsg); resolve(buf.subarray(5).toString('utf8')); }
      };
      ws.on('message', onMsg);
    });
    ws.send(JSON.stringify({ id, url: upBase + '/truncated.js', method: 'GET', headers: [] }));
    assert.ok((await got).length > 0, 'an error frame, never a clean end');
  } finally { ws.close(); }
});

test('pws: a gzip bomb hits the decoded cap; cancel mid-bomb destroys upstream cleanly', async () => {
  const ws = await openWs();
  try {
    await assert.rejects(wsGet(ws, upBase + '/bomb.gz'), /too big/, 'decoded cap refuses the bomb');
    // cancel path: start the bomb, cancel on the first data frame, then prove the tunnel is healthy
    const id = 987654;
    const started = new Promise((resolve) => {
      const onMsg = (data) => { const buf = Buffer.from(data); if (buf.readUInt32BE(0) === id && buf.readUInt8(4) === 1) { ws.off('message', onMsg); resolve(); } };
      ws.on('message', onMsg);
    });
    ws.send(JSON.stringify({ id, url: upBase + '/bomb.gz', method: 'GET', headers: [] }));
    await started;
    ws.send(JSON.stringify({ id, cancel: true }));
    await new Promise((r) => setTimeout(r, 200));
    const r = await wsGet(ws, upBase + '/plain.txt');
    assert.equal(r.status, 200, 'tunnel healthy after cancel');
  } finally { ws.close(); }
});

test('pws: conflicting or malformed freshness claims are never cached', async () => {
  const ws = await openWs();
  try {
    for (const path of ['/conflictcc.js', '/badage.js', '/malformedcc.js']) {
      const before = hits;
      await wsGet(ws, upBase + path);
      await wsGet(ws, upBase + path);
      assert.equal(hits, before + 2, path + ' hit upstream twice');
    }
  } finally { ws.close(); }
});

test('pws: a cache hit reports a live Age, not the captured one', async () => {
  const ws = await openWs();
  try {
    const r1 = await wsGet(ws, upBase + '/cached.js?agecheck=1');
    assert.equal(r1.headers.find(([k]) => k.toLowerCase() === 'age'), undefined, 'live upstream fetch carries no synthesized Age');
    await new Promise((r) => setTimeout(r, 1200));
    const r2 = await wsGet(ws, upBase + '/cached.js?agecheck=1');
    assert.ok(Number(r2.headers.find(([k]) => k.toLowerCase() === 'age')?.[1]) >= 1, 'hit Age reflects time since capture');
  } finally { ws.close(); }
});

test('pws: an undecodable content-encoding is refused, not silently stripped', async () => {
  const ws = await openWs();
  try {
    await assert.rejects(wsGet(ws, upBase + '/zstd.bin'), /encoding/);
  } finally { ws.close(); }
});

test('pws: a reused stream id is rejected and the original stream survives', async () => {
  const ws = await openWs();
  try {
    const id = 777777;
    wsGet(ws, upBase + '/slow.js', [], id).catch(() => {});
    await new Promise((r) => setTimeout(r, 150)); // let the first stream start
    const err = await new Promise((resolve) => {
      const onMsg = (data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.readUInt32BE(0) !== id || buf.readUInt8(4) !== 3) return;
        ws.off('message', onMsg);
        resolve(buf.subarray(5).toString('utf8'));
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, url: upBase + '/plain.txt', method: 'GET', headers: [] }));
    });
    assert.equal(err, 'id in use');
    ws.send(JSON.stringify({ id, cancel: true }));
    await new Promise((r) => setTimeout(r, 150));
    const r = await wsGet(ws, upBase + '/plain.txt');
    assert.equal(r.status, 200, 'socket healthy after the collision');
  } finally { ws.close(); }
});

test('pws: malformed stream ids are ignored without a peep', async () => {
  const ws = await openWs();
  try {
    let frames = 0;
    ws.on('message', () => frames++);
    for (const bad of [0, -3, 1.5, 'x', 2 ** 33, '1', true, [1], null]) ws.send(JSON.stringify({ id: bad, url: upBase + '/plain.txt', method: 'GET', headers: [] }));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(frames, 0, 'no frames for malformed ids');
    const r = await wsGet(ws, upBase + '/plain.txt');
    assert.equal(r.status, 200, 'socket still healthy');
  } finally { ws.close(); }
});

test('pws: invalid method and junk header entries fail cleanly', async () => {
  const ws = await openWs();
  try {
    const err = await new Promise((resolve) => {
      const id = 888881;
      ws.on('message', (data) => { const buf = Buffer.isBuffer(data) ? data : Buffer.from(data); if (buf.readUInt32BE(0) === id && buf.readUInt8(4) === 3) resolve(buf.subarray(5).toString('utf8')); });
      ws.send(JSON.stringify({ id, url: upBase + '/plain.txt', method: 'G<T', headers: [] }));
    });
    assert.equal(err, 'method');
    const r = await wsGet(ws, upBase + '/plain.txt', [42, 'x', ['accept', 'text/plain'], null]);
    assert.equal(r.status, 200, 'junk header entries are ignored, request proceeds');
  } finally { ws.close(); }
});

test('pws: cancelling mid-capture releases the in-flight cache budget every time', async () => {
  const ws = await openWs();
  try {
    for (let round = 0; round < 3; round++) {
      const id = Math.floor(Math.random() * 1e9);
      let got = 0;
      await new Promise((resolve) => {
        ws.on('message', (data) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.readUInt32BE(0) !== id) return;
          if (buf.readUInt8(4) === 1) {
            got += buf.length - 5;
            if (got >= 1024 * 1024) { ws.send(JSON.stringify({ id, cancel: true })); resolve(); }
          }
        });
        ws.send(JSON.stringify({ id, url: upBase + '/slow.js', method: 'GET', headers: [] }));
      });
      await new Promise((r) => setTimeout(r, 200)); // let the cancel land
      assert.equal(testHooks.collectingBytes(), 0, 'capture budget released after cancel, round ' + round);
    }
    assert.equal(testHooks.upstreams(), 0, 'no leaked upstream slots');
    const before = hits;
    await wsGet(ws, upBase + '/cached.js?aftercancel=1');
    await wsGet(ws, upBase + '/cached.js?aftercancel=1');
    assert.equal(hits, before + 1, 'cache works after repeated cancels');
  } finally { ws.close(); }
});

test('pws: proxied websocket targets pass the net-safe guard (bracket literals classified)', async () => {
  const ws = await openWs();
  try {
    for (const bad of ['ws://[::ffff:127.0.0.1]:9/echo', 'ws://10.0.0.1:80/echo', 'ws://[fe80::1]:80/echo']) {
      const id = Math.floor(Math.random() * 1e9);
      const err = await new Promise((resolve) => {
        const onMsg = (data) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.readUInt32BE(0) !== id || buf.readUInt8(4) !== 3) return;
          ws.off('message', onMsg);
          resolve(buf.subarray(5).toString('utf8'));
        };
        ws.on('message', onMsg);
        ws.send(JSON.stringify({ id, ws: bad }));
      });
      assert.equal(err, 'blocked address', bad);
    }
  } finally { ws.close(); }
});

test('pws: a proxied websocket relays a real echo roundtrip and the close code', { timeout: 15000 }, async () => {
  const echo = new WebSocketServer({ port: 0 });
  echo.on('connection', (c) => c.on('message', (m) => c.send('echo:' + m)));
  await new Promise((r) => echo.on('listening', r));
  const ws = await openWs();
  try {
    const id = 424242;
    const frames = [];
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.readUInt32BE(0) === id) frames.push(buf);
    });
    const waitFor = (type) => new Promise((resolve, reject) => {
      const t0 = Date.now();
      const t = setInterval(() => {
        const f = frames.find((b) => b.readUInt8(4) === type);
        if (f) { clearInterval(t); resolve(f); }
        else if (Date.now() - t0 > 8000) { clearInterval(t); reject(new Error('no frame type ' + type)); }
      }, 10);
    });
    ws.send(JSON.stringify({ id, ws: 'ws://127.0.0.1:' + echo.address().port + '/echo' }));
    const head = JSON.parse((await waitFor(0)).subarray(5).toString('utf8'));
    assert.equal(head.status, 101, 'relay reports the upstream upgrade');
    ws.send(JSON.stringify({ id, wssend: Buffer.from('ping-123', 'utf8').toString('base64'), text: true }));
    const data = (await waitFor(1)).subarray(5);
    assert.equal(data[0], 0, 'text frame kind byte');
    assert.equal(data.subarray(1).toString('utf8'), 'echo:ping-123');
    ws.send(JSON.stringify({ id, wsclose: { code: 1000, reason: 'done' } }));
    const end = JSON.parse((await waitFor(2)).subarray(5).toString('utf8'));
    assert.equal(end.code, 1000, 'upstream close code relayed');
  } finally { ws.close(); echo.close(); }
});

test('pws: a hit on an upstream-aged entry reports the true Age and a shrunken max-age', async () => {
  const ws = await openWs();
  try {
    await wsGet(ws, upBase + '/aged500.js?corr=1');
    await new Promise((r) => setTimeout(r, 1200));
    const r2 = await wsGet(ws, upBase + '/aged500.js?corr=1');
    const age = Number(r2.headers.find(([k]) => k.toLowerCase() === 'age')?.[1]);
    assert.ok(age >= 501, 'hit Age includes the corrected initial age, got ' + age);
    const cc = r2.headers.find(([k]) => k.toLowerCase() === 'cache-control')?.[1] || '';
    const m = /max-age=(\d+)/.exec(cc);
    assert.ok(m && Number(m[1]) <= 100, 'served max-age is what the entry has left, got ' + cc);
  } finally { ws.close(); }
});

test('pws: non-digits Age values are refused', async () => {
  const ws = await openWs();
  try {
    for (const a of ['0x0', '1e2', '-0', '5 0']) {
      const before = hits;
      await wsGet(ws, upBase + '/badagex.js?a=' + encodeURIComponent(a));
      await wsGet(ws, upBase + '/badagex.js?a=' + encodeURIComponent(a));
      assert.equal(hits, before + 2, 'age=' + JSON.stringify(a) + ' never caches');
    }
  } finally { ws.close(); }
});

test('pws: identity;q=0.5 is not an identity refusal, identity;q=0 is', async () => {
  const ws = await openWs();
  try {
    const h = [['accept-encoding', 'gzip, identity;q=0.5']];
    let before = hits;
    await wsGet(ws, upBase + '/cached.js?q05=1', h);
    await wsGet(ws, upBase + '/cached.js?q05=1', h);
    assert.equal(hits, before + 1, 'identity;q=0.5 stays cache-eligible');
    const h0 = [['accept-encoding', 'gzip, identity;q=0']];
    before = hits;
    await wsGet(ws, upBase + '/cached.js?q00=1', h0);
    await wsGet(ws, upBase + '/cached.js?q00=1', h0);
    assert.equal(hits, before + 2, 'identity;q=0 is never cache-eligible');
  } finally { ws.close(); }
});

test('pws: relay idle wall watches both directions', { timeout: 15000 }, async () => {
  const echo = new WebSocketServer({ port: 0 });
  echo.on('connection', () => {}); // silent upstream: never speaks
  await new Promise((r) => echo.on('listening', r));
  testHooks.setTunables({ wsIdleMs: 400 });
  const ws = await openWs();
  try {
    const id = 515151;
    const frames = [];
    ws.on('message', (data) => { const buf = Buffer.isBuffer(data) ? data : Buffer.from(data); if (buf.readUInt32BE(0) === id) frames.push(buf); });
    ws.send(JSON.stringify({ id, ws: 'ws://127.0.0.1:' + echo.address().port + '/' }));
    await new Promise((r) => { const t = setInterval(() => { if (frames.some((f) => f.readUInt8(4) === 0)) { clearInterval(t); r(); } }, 10); });
    // outbound traffic resets the idle wall: 900ms of talking, idle is 400ms
    for (let i = 0; i < 6; i++) { ws.send(JSON.stringify({ id, wssend: Buffer.from('x').toString('base64'), text: true })); await new Promise((r) => setTimeout(r, 150)); }
    assert.ok(!frames.some((f) => f.readUInt8(4) === 3), 'no idle kill while the client is talking');
    await new Promise((r) => setTimeout(r, 800)); // true silence now exceeds the wall
    const err = frames.find((f) => f.readUInt8(4) === 3);
    assert.ok(err && err.subarray(5).toString('utf8') === 'idle', 'idle kill after true silence');
  } finally { ws.close(); echo.close(); testHooks.setTunables({ wsIdleMs: 30 * 60 * 1000 }); }
});

test('pws: relay message rate is bounded', { timeout: 15000 }, async () => {
  const echo = new WebSocketServer({ port: 0 });
  echo.on('connection', () => {});
  await new Promise((r) => echo.on('listening', r));
  testHooks.setTunables({ wsRatePerSec: 5 });
  const ws = await openWs();
  try {
    const id = 525252;
    const frames = [];
    ws.on('message', (data) => { const buf = Buffer.isBuffer(data) ? data : Buffer.from(data); if (buf.readUInt32BE(0) === id) frames.push(buf); });
    ws.send(JSON.stringify({ id, ws: 'ws://127.0.0.1:' + echo.address().port + '/' }));
    await new Promise((r) => { const t = setInterval(() => { if (frames.some((f) => f.readUInt8(4) === 0)) { clearInterval(t); r(); } }, 10); });
    for (let i = 0; i < 12; i++) ws.send(JSON.stringify({ id, wssend: Buffer.from('x').toString('base64'), text: true }));
    await new Promise((r) => setTimeout(r, 500));
    const err = frames.find((f) => f.readUInt8(4) === 3);
    assert.ok(err && err.subarray(5).toString('utf8') === 'rate', 'flood killed with rate');
  } finally { ws.close(); echo.close(); testHooks.setTunables({ wsRatePerSec: 240 }); }
});

test('pws: browser-to-upstream queue is prospectively capped', { timeout: 15000 }, async () => {
  const echo = new WebSocketServer({ port: 0 });
  echo.on('connection', () => {});
  await new Promise((r) => echo.on('listening', r));
  testHooks.setTunables({ wsQueueCap: 100 });
  const ws = await openWs();
  try {
    const id = 535353;
    const frames = [];
    ws.on('message', (data) => { const buf = Buffer.isBuffer(data) ? data : Buffer.from(data); if (buf.readUInt32BE(0) === id) frames.push(buf); });
    ws.send(JSON.stringify({ id, ws: 'ws://127.0.0.1:' + echo.address().port + '/' }));
    await new Promise((r) => { const t = setInterval(() => { if (frames.some((f) => f.readUInt8(4) === 0)) { clearInterval(t); r(); } }, 10); });
    ws.send(JSON.stringify({ id, wssend: Buffer.alloc(200, 120).toString('base64'), text: false }));
    await new Promise((r) => setTimeout(r, 400));
    const err = frames.find((f) => f.readUInt8(4) === 3);
    assert.ok(err && err.subarray(5).toString('utf8') === 'busy', 'a 200-byte message over a 100-byte cap is shed');
  } finally { ws.close(); echo.close(); testHooks.setTunables({ wsQueueCap: 4e6 }); }
});

test('pws: the shared tunnel hard cap sheds streams but never orphans the client', async () => {
  const ws = await openWs();
  try {
    testHooks.setTunables({ tunnelHardCap: 10 });
    // terminal errors carry a bounded budget past the cap: the client always
    // hears the outcome instead of hanging on a dropped frame
    await assert.rejects(wsGet(ws, 'http://10.0.0.1/x'), /blocked address/, 'pre-entry error still delivered over the cap');
    await assert.rejects(wsGet(ws, upBase + '/slow.js'), /busy/, 'a stream shed at the head still terminates with an error');
    testHooks.setTunables({ tunnelHardCap: 24e6 });
    const r = await wsGet(ws, upBase + '/plain.txt');
    assert.equal(r.status, 200, 'socket healthy once the cap is restored');
  } finally { ws.close(); }
});

test('pws: an established ws stream shed over a saturated reserve still gets its terminal frame', { timeout: 30000 }, async () => {
  const echo = new WebSocketServer({ port: 0 });
  echo.on('connection', (c) => c.on('message', (m) => c.send('echo:' + m)));
  await new Promise((r) => echo.on('listening', r));
  const th = await makeThrottle();
  const ws = await openWs(th.url);
  try {
    const wsId = 717171;
    let opened = false, closed = null, errored = null;
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.readUInt32BE(0) !== wsId) return;
      const t = buf.readUInt8(4);
      if (t === 0) opened = true;
      else if (t === 2) closed = buf.subarray(5).toString('utf8');
      else if (t === 3) errored = buf.subarray(5).toString('utf8');
    });
    ws.send(JSON.stringify({ id: wsId, ws: 'ws://127.0.0.1:' + echo.address().port + '/echo', protocols: [], headers: [] }));
    await poll(() => opened, 5000);
    // the throttled relay turns the flood into REAL sustained queue pressure
    const flood = wsGet(ws, upBase + '/big.js').catch((e) => e);
    await poll(() => testHooks.tunnelBuffered() > 3e6, 10000);
    testHooks.setTunables({ tunnelHardCap: 10 });
    ws.send(JSON.stringify({ id: wsId, cancel: true })); // deletion while the reserve is saturated
    await poll(() => testHooks.tunnelPending() >= 1, 5000); // the terminal really took the pending path
    th.setRate(64 * 1024 * 1024); // open the tap: the queue drains
    await poll(() => closed || errored, 8000); // drained, then delivered
    assert.ok(closed || errored, 'terminal frame reached the established stream after drain');
    testHooks.setTunables({ tunnelHardCap: 24e6 });
    await flood;
    const r = await wsGet(ws, upBase + '/plain.txt');
    assert.equal(r.status, 200, 'tunnel healthy afterwards');
  } finally { testHooks.setTunables({ tunnelHardCap: 24e6 }); ws.close(); echo.close(); th.srv.close(); }
});



test('pws: shed terminals form one bounded deduped queue; overflow closes the tunnel', { timeout: 30000 }, async () => {
  const th = await makeThrottle();
  const ws = await openWs(th.url);
  try {
    const flood = wsGet(ws, upBase + '/big.js').catch((e) => e); // sustained queue pressure via the relay
    await poll(() => testHooks.tunnelBuffered() > 3e6, 10000);
    testHooks.setTunables({ tunnelHardCap: 10 }); // reserve (65546) sits far under the saturated queue
    // duplicate-id errors dedup to one queued terminal
    for (let i = 0; i < 100; i++) ws.send(JSON.stringify({ id: 950001, url: 'http://10.0.0.1/x', method: 'GET', headers: [] }));
    await poll(() => testHooks.tunnelPending() >= 1, 5000);
    assert.ok(testHooks.tunnelPending() <= 64, 'retained terminal count bounded, got ' + testHooks.tunnelPending());
    assert.ok(testHooks.tunnelPendingBytes() <= 256 * 1024, 'retained terminal bytes bounded, got ' + testHooks.tunnelPendingBytes());
    // a flood of unique-id errors overflows the bounded queue: the tunnel closes
    let closed = false; ws.on('close', () => { closed = true; });
    for (let i = 0; i < 1000; i++) ws.send(JSON.stringify({ id: 960000 + i, url: 'http://10.0.0.1/x', method: 'GET', headers: [] }));
    // direct server-side termination receipt: does not depend on the relay
    // forwarding anything (a relay fault must not mask a missing closeTunnel)
    await poll(() => testHooks.tunnelClosed(), 5000);
    assert.ok(testHooks.tunnelClosed(), 'server terminated the tunnel after overflow');
    await poll(() => closed, 8000);
    assert.ok(closed, 'overflow close reached the client through the relay');
    await poll(() => testHooks.tunnelPending() === 0, 5000); // queue cleared on close
    assert.equal(testHooks.upstreams(), 0, 'upstream entries reaped on close');
    testHooks.setTunables({ tunnelHardCap: 24e6 });
    // the tunnel is dead by design: the flood's frames stop without a terminal
  } finally { testHooks.setTunables({ tunnelHardCap: 24e6 }); ws.close(); th.srv.close(); }
});



test('pws: a transport error tears the tunnel down like a close', { timeout: 15000 }, async () => {
  const ws = await openWs();
  try {
    wsGet(ws, upBase + '/slow.js').catch(() => {}); // an in-flight upstream to reap
    await poll(() => testHooks.upstreams() >= 1, 5000);
    ws._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0])); // reserved opcode: a real protocol error server-side
    let closed = false; ws.on('close', () => { closed = true; });
    await poll(() => closed, 8000);
    await poll(() => testHooks.upstreams() === 0, 5000); // entries destroyed, not just the pending queue cleared
    assert.equal(testHooks.tunnelPending(), 0, 'pending queue cleared too');
  } finally { ws.close(); }
});

test('pws: a stream id with a queued terminal stays taken until delivery', { timeout: 30000 }, async () => {
  const th = await makeThrottle();
  const ws = await openWs(th.url);
  try {
    const flood = wsGet(ws, upBase + '/big.js').catch(() => {}); // sustained queue pressure via the relay
    await poll(() => testHooks.tunnelBuffered() > 3e6, 10000);
    testHooks.setTunables({ tunnelHardCap: 10 });
    const id = 881122;
    wsGet(ws, 'http://10.0.0.1/x', [], id).catch(() => {}); // its error terminal queues
    await poll(() => testHooks.tunnelPending() >= 1, 5000);
    const frames = [];
    ws.on('message', (data) => { const buf = Buffer.from(data); if (buf.readUInt32BE(0) === id) frames.push(buf); });
    ws.send(JSON.stringify({ id, url: upBase + '/plain.txt', method: 'GET', headers: [] })); // reuse while the old terminal is queued
    th.setRate(64 * 1024 * 1024); // open the tap
    await poll(() => frames.some((f) => f.readUInt8(4) === 3), 8000);
    const errs = frames.filter((f) => f.readUInt8(4) === 3).map((f) => f.subarray(5).toString('utf8'));
    assert.deepEqual(errs, ['id in use'], 'the stale terminal is superseded by the reuse rejection, got ' + JSON.stringify(errs));
    assert.ok(!frames.some((f) => f.readUInt8(4) === 2), 'no stale end frame lands on the reused id');
    testHooks.setTunables({ tunnelHardCap: 24e6 });
    const r = await wsGet(ws, upBase + '/plain.txt');
    assert.equal(r.status, 200, 'tunnel healthy afterwards');
  } finally { testHooks.setTunables({ tunnelHardCap: 24e6 }); ws.close(); th.srv.close(); }
});

// throttle-relay EOF/reset propagation controls: the relay pumps a readable-
// mode socket with a rate-limited tick, and a zero-length read is what
// consumes an already-drained FIN. these pin that mechanism directly so a
// relay fault can never again masquerade as a production close bug
test('relay: finite body + FIN forwards exact bytes, then close - no cleanup assist', async () => {
  const payload = Buffer.alloc(200 * 1024, 'x');
  const up = net.createServer((s) => { s.write(payload.subarray(0, 1000)); s.end(payload.subarray(1000)); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const th = await makeThrottle('ws://127.0.0.1:' + up.address().port + '/');
  const down = net.connect(Number(th.url.split(':')[2].split('/')[0]), '127.0.0.1');
  try {
    const chunks = [];
    let sawClose = false;
    down.on('data', (c) => chunks.push(c));
    down.on('close', () => { sawClose = true; });
    await poll(() => sawClose, 5000);
    assert.ok(sawClose, 'close propagated without any cleanup from this side');
    assert.deepEqual(Buffer.concat(chunks), payload, 'every byte forwarded exactly once');
  } finally { down.destroy(); th.srv.close(); up.close(); }
});

test('relay: empty FIN (no bytes at all) still propagates close', async () => {
  const up = net.createServer((s) => s.end());
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const th = await makeThrottle('ws://127.0.0.1:' + up.address().port + '/');
  const down = net.connect(Number(th.url.split(':')[2].split('/')[0]), '127.0.0.1');
  try {
    let bytes = 0, sawClose = false;
    down.on('data', (c) => { bytes += c.length; });
    down.on('close', () => { sawClose = true; });
    await poll(() => sawClose, 5000);
    assert.ok(sawClose, 'empty FIN propagated');
    assert.equal(bytes, 0, 'no phantom bytes');
  } finally { down.destroy(); th.srv.close(); up.close(); }
});

test('relay: idle-but-open upstream does NOT close just because the buffer is empty', async () => {
  const up = net.createServer(() => {}); // accepts, says nothing, stays open
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const th = await makeThrottle('ws://127.0.0.1:' + up.address().port + '/');
  const down = net.connect(Number(th.url.split(':')[2].split('/')[0]), '127.0.0.1');
  try {
    let sawClose = false;
    down.on('close', () => { sawClose = true; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sawClose, false, 'readableLength 0 is not EOF - idle streams must survive');
    down.write('ping');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(down.destroyed, false, 'still writable after the idle window');
  } finally { down.destroy(); th.srv.close(); up.close(); }
});

test('relay: throttled body keeps the rate cap, delivers exact bytes, then closes', async () => {
  const payload = Buffer.alloc(64 * 1024 * 4, 'y'); // 4 rate-ticks of data
  const up = net.createServer((s) => s.end(payload));
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const th = await makeThrottle('ws://127.0.0.1:' + up.address().port + '/');
  const down = net.connect(Number(th.url.split(':')[2].split('/')[0]), '127.0.0.1');
  try {
    const chunks = [];
    let sawClose = false;
    down.on('data', (c) => chunks.push(c));
    down.on('close', () => { sawClose = true; });
    const t0 = Date.now();
    await poll(() => sawClose, 10000);
    const ms = Date.now() - t0;
    assert.deepEqual(Buffer.concat(chunks), payload, 'exact bytes');
    assert.ok(ms >= 75, 'rate cap still shapes delivery (4 ticks at 25ms), got ' + ms + 'ms');
  } finally { down.destroy(); th.srv.close(); up.close(); }
});

test('relay: abrupt upstream reset propagates and closes the client side', async () => {
  const up = net.createServer((s) => { s.write('partial'); setTimeout(() => s.destroy(), 50); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const th = await makeThrottle('ws://127.0.0.1:' + up.address().port + '/');
  const down = net.connect(Number(th.url.split(':')[2].split('/')[0]), '127.0.0.1');
  try {
    let sawClose = false;
    down.resume(); // a paused socket never consumes its own FIN: no 'end', no 'close'
    down.on('close', () => { sawClose = true; });
    down.on('error', () => {});
    await poll(() => sawClose, 5000);
    assert.ok(sawClose, 'reset propagated to the client');
    assert.ok(th.srv, 'relay server handle exists');
  } finally { down.destroy(); th.srv.close(); up.close(); }
});

test('pws: quoted/spaced/uppercase max-age is canonicalized at capture', async () => {
  const ws = await openWs();
  try {
    const before = hits;
    await wsGet(ws, upBase + '/quotedcc.js');
    const r2 = await wsGet(ws, upBase + '/quotedcc.js');
    assert.equal(hits, before + 1, 'second fetch is a cache hit');
    const cc = r2.headers.find(([k]) => k.toLowerCase() === 'cache-control')?.[1] || '';
    assert.match(cc, /^public, max-age=\d+$/, 'canonical lowercase unquoted directive: ' + cc);
    assert.ok(Number(/max-age=(\d+)/.exec(cc)[1]) <= 600, 'served max-age never exceeds the parsed value');
  } finally { ws.close(); }
});

test('pws: download time counts toward a hit Age', { timeout: 20000 }, async () => {
  const ws = await openWs();
  try {
    await wsGet(ws, upBase + '/slower.js'); // ~3s download
    const r2 = await wsGet(ws, upBase + '/slower.js');
    const age = Number(r2.headers.find(([k]) => k.toLowerCase() === 'age')?.[1]);
    assert.ok(age >= 2, 'Age includes the download duration, got ' + age);
  } finally { ws.close(); }
});

test('pws: tunnel per-message deflate skipped only for incompressible content types', () => {
  const ct = (v) => [['content-type', v]];
  // text: compression earns its CPU (wire savings on real pages)
  assert.equal(tunnelCompressible(ct('text/html')), true);
  assert.equal(tunnelCompressible(ct('text/html; charset=utf-8')), true);
  assert.equal(tunnelCompressible(ct('application/javascript')), true);
  assert.equal(tunnelCompressible(ct('text/css')), true);
  assert.equal(tunnelCompressible(ct('application/json; charset=utf-8')), true);
  assert.equal(tunnelCompressible(ct('image/svg+xml')), true); // svg is xml
  assert.equal(tunnelCompressible([]), true); // unknown: status quo
  // already-compressed payloads: zlib CPU is pure waste (23.5 vs 127 MB/s measured)
  assert.equal(tunnelCompressible(ct('image/png')), false);
  assert.equal(tunnelCompressible(ct('image/jpeg; quality=80')), false);
  assert.equal(tunnelCompressible(ct('IMAGE/WEBP')), false); // case-insensitive
  assert.equal(tunnelCompressible(ct('video/mp4')), false);
  assert.equal(tunnelCompressible(ct('audio/mpeg')), false);
  assert.equal(tunnelCompressible(ct('font/woff2')), false);
  assert.equal(tunnelCompressible(ct('application/octet-stream')), false);
  assert.equal(tunnelCompressible(ct('application/zip')), false);
  assert.equal(tunnelCompressible(ct('application/pdf')), false);
  assert.equal(tunnelCompressible(ct('application/wasm')), false);
});

const wsGetFramed = (ws, url) => new Promise((resolve, reject) => {
  const id = Math.floor(Math.random() * 1e9);
  const frames = [];
  let head = null;
  const onMsg = (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const mid = buf.readUInt32BE(0), type = buf.readUInt8(4);
    if (mid !== id) return;
    if (type === 0) head = JSON.parse(buf.subarray(5).toString('utf8'));
    else if (type === 1) frames.push(buf.subarray(5));
    else if (type === 2) { ws.off('message', onMsg); resolve({ ...head, frames }); }
    else { ws.off('message', onMsg); reject(new Error('upstream error frame: ' + buf.subarray(5).toString('utf8'))); }
  };
  ws.on('message', onMsg);
  ws.send(JSON.stringify({ id, url, method: 'GET', headers: [] }));
});

test('pws: bursts coalesce into large frames, drips still flow', { timeout: 30000 }, async () => {
  const ws = await openWs();
  try {
    const big = await wsGetFramed(ws, upBase + '/big.js'); // 32MB flood
    const bigBytes = big.frames.reduce((a, c) => a + c.length, 0);
    assert.equal(bigBytes, 32 * 1024 * 1024, 'coalescing never loses bytes');
    assert.ok(big.frames.length <= 160, '32MB arrives in <=160 frames (>=200KB avg), got ' + big.frames.length);
    assert.ok(big.frames.every((c) => c.length <= 256 * 1024 + 64 * 1024), 'frames stay near the 256KB target');
    const drip = await wsGetFramed(ws, upBase + '/drip.js'); // 32KB every 50ms, no-store: never a cache replay
    const dripBytes = drip.frames.reduce((a, c) => a + c.length, 0);
    assert.equal(dripBytes, 2 * 1024 * 1024, 'drip bytes intact');
    assert.ok(drip.frames.length >= 20, 'a slow stream is not held back waiting for full frames, got ' + drip.frames.length + ' frames');
  } finally { ws.close(); }
});
