// pipeMedia relays an upstream audio stream to the element. hardening
// parity with the hls walker: an upstream body dying mid-reply must
// destroy the committed response (never hang it), and a client closing
// under backpressure must settle the drain wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { ampInternals } from '../core/addons/amp/index.js';

const { pipeMedia } = ampInternals;

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));

// downstream: one pipeMedia relay per request, capturing the settled result
const serve = (getUp) => {
  let settled = null;
  const server = http.createServer(async (req, res) => {
    const r = await pipeMedia(getUp(), req, res, {});
    settled = r;
  });
  return { server, settled: () => settled };
};

// resolve on clean end or aborted body, and report what happened
const read = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { range: 'bytes=0-' } }, (res) => {
    const parts = [];
    res.on('data', (c) => parts.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts), aborted: false }));
    res.on('aborted', () => resolve({ status: res.statusCode, body: Buffer.concat(parts), aborted: true }));
  });
  req.on('error', () => resolve({ status: 0, body: Buffer.alloc(0), aborted: true }));
  req.setTimeout(10000, () => { req.destroy(); resolve({ status: -1, body: Buffer.alloc(0), aborted: true }); });
});

test('upstream 200 headers then dying body: response destroyed, not hung', async () => {
  const up = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': 5000, 'content-type': 'audio/mpeg' });
    res.write(Buffer.alloc(100, 4), () => res.socket.destroy());
  });
  const upPort = await listen(up);
  const d = serve(() => `http://127.0.0.1:${upPort}/audio`);
  const port = await listen(d.server);
  const r = await read(port);
  assert.equal(r.status, 200);
  assert.equal(r.aborted, true); // the client sees a dropped body, fast
  assert.equal(r.body.length, 100);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.deepEqual(d.settled(), { status: 200, bytes: 100 });
  d.server.closeAllConnections?.(); up.closeAllConnections?.();
  await close(d.server); await close(up);
});

test('client close under backpressure settles the drain wait', async () => {
  // endless upstream, faster than the client reads
  const up = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    const tick = setInterval(() => { if (!res.write(Buffer.alloc(65536, 8))) { /* keep pushing */ } }, 5);
    res.on('close', () => clearInterval(tick));
  });
  const upPort = await listen(up);
  const d = serve(() => `http://127.0.0.1:${upPort}/audio`);
  const port = await listen(d.server);
  // raw client: read a little, never drain properly, then vanish
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write('GET / HTTP/1.1\r\nHost: x\r\nRange: bytes=0-\r\n\r\n');
  });
  let got = 0;
  sock.on('data', (c) => { got += c.length; if (got > 200000) sock.destroy(); });
  await new Promise((r2) => {
    sock.on('close', r2);
    setTimeout(() => { sock.destroy(); }, 8000);
  });
  await new Promise((r2) => setTimeout(r2, 300));
  const s = d.settled();
  assert.ok(s, 'pipeMedia must settle after the client vanished');
  assert.equal(s.status, 200);
  d.server.closeAllConnections?.(); up.closeAllConnections?.();
  await close(d.server); await close(up);
});

test('upstream refusing connection: clean 502 before headers', async () => {
  const d = serve(() => 'http://127.0.0.1:1/nothing');
  const port = await listen(d.server);
  const r = await read(port);
  assert.equal(r.status, 502);
  assert.equal(r.body.length, 0);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.deepEqual(d.settled(), { status: 502, bytes: 0 });
  d.server.closeAllConnections?.();
  await close(d.server);
});
