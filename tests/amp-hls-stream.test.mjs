// HTTP integration for the sc hls proxy walk: first-part failures must reach
// the caller with headers untouched (the route's 403/410 re-resolve depends
// on it), midstream failures must terminate the response, and a client
// closing under backpressure must settle the drain wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { ampInternals } from '../core/addons/amp/index.js';

const { pipeScHls } = ampInternals;

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => server.close(r));

// scripted upstream: map of path -> status | {status, body} | 'hang'
const upstream = async (script) => {
  const server = http.createServer((req, res) => {
    const v = script[req.url];
    if (v === 'hang') return; // never answer
    if (typeof v === 'number') { res.writeHead(v); res.end(); return; }
    res.writeHead(v.status || 200, { 'content-length': v.body.length });
    res.end(v.body);
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
};

// downstream serving one pipeScHls plan, mimicking the route tail
const serve = (plan) => {
  let settled = null;
  const server = http.createServer(async (req, res) => {
    const r = await pipeScHls(plan, 0, plan.total - 1, req, res, () => {});
    if (!res.headersSent) { res.writeHead(r.status); res.end(); }
    settled = r;
  });
  return { server, settled: () => settled };
};

// resolve on clean end OR an aborted mid-body connection - both prove the
// server terminated the response instead of hanging
const get = (port) => new Promise((resolve, reject) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
    const chunks = [];
    let ended = false;
    const fin = (aborted) => { if (!ended) { ended = true; resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), aborted }); } };
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => fin(false));
    res.on('aborted', () => fin(true));
    res.on('close', () => fin(true));
    res.on('error', () => fin(true));
  });
  req.setTimeout(8000, () => { req.destroy(new Error('client timeout - server hung')); });
  req.on('error', (e) => { if (/hung/.test(e.message)) reject(e); });
});

const planFor = (base, sizes) => {
  const parts = sizes.map((_, i) => `${base}/seg${i}`);
  const offs = []; let acc = 0;
  for (const n of sizes) { offs.push(acc); acc += n; }
  return { kind: 'hls', parts, sizes, offs, total: acc };
};

test('initial upstream 403: caller sees the status, headers untouched, response ends', async () => {
  const up = await upstream({ '/seg0': 403, '/seg1': 403 });
  const plan = planFor(up.url, [100, 100]);
  const d = serve(plan);
  const port = await listen(d.server);
  const r = await get(port);
  assert.equal(r.status, 403); // the route tail wrote it - pipeScHls leaked no headers
  assert.equal(r.body.length, 0);
  assert.deepEqual(d.settled(), { bytes: 0, status: 403 });
  d.server.closeAllConnections?.(); up.server.closeAllConnections?.(); await close(d.server); await close(up.server);
});

test('initial upstream 410 gone: same clean contract as 403', async () => {
  const up = await upstream({ '/seg0': 410 });
  const plan = planFor(up.url, [100]);
  const d = serve(plan);
  const port = await listen(d.server);
  const r = await get(port);
  assert.equal(r.status, 410);
  assert.deepEqual(d.settled(), { bytes: 0, status: 410 });
  d.server.closeAllConnections?.(); up.server.closeAllConnections?.(); await close(d.server); await close(up.server);
});

test('midstream failure terminates the response instead of hanging', async () => {
  const seg0 = Buffer.alloc(5000, 1);
  const up = await upstream({ '/seg0': { body: seg0 }, '/seg1': 403, '/seg2': { body: Buffer.alloc(5000, 3) } });
  const plan = planFor(up.url, [5000, 5000, 5000]);
  const d = serve(plan);
  const port = await listen(d.server);
  const r = await get(port); // resolves on end/abort - a hang trips the client timeout
  assert.equal(r.status, 206);
  assert.equal(r.aborted, true); // truncated responses cannot end cleanly - the socket must die
  assert.equal(r.body.length, 5000);
  assert.ok(r.body.equals(seg0));
  assert.equal(d.settled().status, 206);
  d.server.closeAllConnections?.(); up.server.closeAllConnections?.(); await close(d.server); await close(up.server);
});

test('client close under backpressure settles the drain wait', async () => {
  const big = Buffer.alloc(4 * 1024 * 1024, 7); // far beyond socket buffers
  const up = await upstream({ '/seg0': { body: big } });
  const plan = planFor(up.url, [big.length]);
  const d = serve(plan);
  const port = await listen(d.server);
  const sock = net.connect(port, '127.0.0.1', () => {
    sock.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  });
  await new Promise((r) => setTimeout(r, 500)); // let the server fill every buffer and park on drain
  sock.destroy(); // gone without reading
  const verdict = await Promise.race([
    new Promise((r) => { const t = setInterval(() => { if (d.settled()) { clearInterval(t); r(d.settled()); } }, 25); }),
    new Promise((r) => setTimeout(() => r('still parked'), 5000)),
  ]);
  assert.notEqual(verdict, 'still parked', 'drain wait must settle on close');
  sock.removeAllListeners();
  d.server.closeAllConnections?.(); up.server.closeAllConnections?.(); await close(d.server); await close(up.server);
});

// upstream answers 200 with a full content-length, then kills the body early
const truncated = async (sendBytes, declared) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': declared });
    res.write(Buffer.alloc(sendBytes, 9), () => res.socket.destroy());
  });
  const port = await listen(server);
  return { server, url: `http://127.0.0.1:${port}` };
};

test('200-then-truncated-body on the first part: clean 502, headers untouched', async () => {
  const up = await truncated(100, 5000);
  const plan = { kind: 'hls', parts: [up.url + '/seg0'], sizes: [5000], offs: [0], total: 5000 };
  const d = serve(plan);
  const port = await listen(d.server);
  const r = await get(port);
  assert.equal(r.status, 502);
  assert.equal(r.body.length, 0);
  assert.deepEqual(d.settled(), { bytes: 0, status: 502 });
  d.server.closeAllConnections?.(); up.server.closeAllConnections?.();
  await close(d.server); await close(up.server);
});

test('200-then-truncated-body after a good part: 206 out, socket destroyed, no hang', async () => {
  const seg0 = Buffer.alloc(5000, 1);
  const good = await upstream({ '/seg0': { body: seg0 } });
  const bad = await truncated(100, 5000);
  const plan = { kind: 'hls', parts: [good.url + '/seg0', bad.url + '/seg1'], sizes: [5000, 5000], offs: [0, 5000], total: 10000 };
  const d = serve(plan);
  const port = await listen(d.server);
  const r = await get(port);
  assert.equal(r.status, 206);
  assert.equal(r.aborted, true);
  assert.equal(r.body.length, 5000);
  assert.ok(r.body.equals(seg0));
  assert.deepEqual(d.settled(), { bytes: 5000, status: 206 });
  d.server.closeAllConnections?.(); good.server.closeAllConnections?.(); bad.server.closeAllConnections?.();
  await close(d.server); await close(good.server); await close(bad.server);
});
