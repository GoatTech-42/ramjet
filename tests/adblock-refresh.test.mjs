import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'rj-adblock-'));
process.env.RJ_DATA = root;
process.env.RJ_TEST_HOOKS = '1';

const { testHooks, isAdHost } = await import('../core/adblock.js');
const { getText, refresh, refreshUbo, files, timers } = testHooks;

test.after(() => rmSync(root, { recursive: true, force: true }));

const serve = (handler) => new Promise((resolve) => {
  const srv = http.createServer(handler);
  srv.listen(0, '127.0.0.1', () => resolve(srv));
});
const port = (srv) => srv.address().port;

test('getText: a trickling body dies at the absolute deadline, not at socket inactivity', async () => {
  // 1 byte every 20ms keeps the socket busy forever; only a wall-clock
  // deadline stops it (r15 review repro: 40ms budget completed in 313ms)
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let n = 0;
    const t = setInterval(() => { res.write('x'); if (++n === 100) { clearInterval(t); res.end(); } }, 20);
    res.on('close', () => clearInterval(t));
  });
  try {
    const start = Date.now();
    await assert.rejects(getText(`http://127.0.0.1:${port(srv)}/`, 50), /deadline/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `trickle must die near the 50ms deadline, took ${elapsed}ms`);
  } finally { srv.close(); }
});

test('getText: one deadline spans every redirect hop (no per-hop reset)', async () => {
  // three 60ms redirect hops = 180ms total; a per-hop 150ms budget would let
  // this chain through, a single absolute deadline must kill it
  const srv = await serve((req, res) => {
    const hop = { '/a': '/b', '/b': '/c', '/c': '/d' }[req.url];
    setTimeout(() => {
      if (hop) { res.writeHead(302, { location: hop }); res.end(); }
      else { res.writeHead(200); res.end('reached'); }
    }, 60);
  });
  try {
    const start = Date.now();
    await assert.rejects(getText(`http://127.0.0.1:${port(srv)}/a`, 150), /deadline/);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1000, `redirect chain must die near the 150ms deadline, took ${elapsed}ms`);
  } finally { srv.close(); }
});

test('getText: redirects within budget still follow to the body', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/r1') { res.writeHead(302, { location: '/r2' }); res.end(); }
    else if (req.url === '/r2') { res.writeHead(302, { location: '/final' }); res.end(); }
    else { res.writeHead(200); res.end('||ads.example^\n'); }
  });
  try {
    const body = await getText(`http://127.0.0.1:${port(srv)}/r1`, 5000);
    assert.equal(body, '||ads.example^\n');
  } finally { srv.close(); }
});

test('refresh: the production path loads a loopback Peter Lowe list into the live matcher', async () => {
  const hosts = [];
  for (let i = 0; i < 1500; i++) hosts.push(`tracker${String(i).padStart(4, '0')}.example`);
  const srv = await serve((req, res) => { res.writeHead(200); res.end('# loopback list\n' + hosts.join('\n') + '\n'); });
  try {
    assert.equal(existsSync(files().FILE), false, 'no cached list before refresh');
    await refresh(`http://127.0.0.1:${port(srv)}/list.txt`);
    assert.equal(existsSync(files().FILE), true, 'refresh writes the cache file');
    assert.equal(isAdHost('tracker0001.example'), true, 'refreshed host blocks');
    assert.equal(isAdHost('example.com'), false, 'unrelated host passes');
  } finally { srv.close(); }
});

test('refreshUbo: the production path loads a loopback uBO list into the live matcher', async () => {
  const lines = [];
  for (let i = 0; i < 6000; i++) lines.push(`||ubad${String(i).padStart(4, '0')}.example^`);
  const srv = await serve((req, res) => { res.writeHead(200); res.end(lines.join('\n') + '\n'); });
  try {
    assert.equal(existsSync(files().UBO_FILE), false, 'no cached ubo list before refresh');
    await refreshUbo([`http://127.0.0.1:${port(srv)}/ubo.txt`]);
    assert.equal(existsSync(files().UBO_FILE), true, 'refreshUbo writes the cache file');
    assert.equal(isAdHost('ubad0001.example'), true, 'ubo host blocks');
    const onDisk = readFileSync(files().UBO_FILE, 'utf8');
    assert.ok(onDisk.includes('ubad0001.example'), 'host persisted to the cache file');
  } finally { srv.close(); }
});

test('getText: no settle path leaves an upstream socket or deadline timer behind', async () => {
  // r16 review: a slow redirect body and a trickled 404 each leaked one
  // incomplete upstream socket+timer after settle (res.resume on non-final
  // paths, deadline cleared on settle). every settle path - redirect,
  // non-200, success, error - must return to zero.
  const open = new Set();
  const srv = await serve((req, res) => {
    // slow bodies that would hold the socket for ~2s if left resumed
    const trickle = () => {
      res.writeHead(res.statusCode === 200 ? 200 : res.statusCode, { 'content-type': 'text/plain' });
      const t = setInterval(() => res.write('x'), 25);
      setTimeout(() => { clearInterval(t); res.end(); }, 2000).unref();
      res.on('close', () => clearInterval(t));
    };
    if (req.url === '/redir') { res.statusCode = 302; res.setHeader('location', '/final'); trickle(); }
    else if (req.url === '/nf') { res.statusCode = 404; trickle(); }
    else if (req.url === '/final') { res.writeHead(200); res.end('landed'); }
    else { res.writeHead(200); res.end('plain-ok'); }
  });
  for (const c of [srv]) c.on('connection', (sock) => { open.add(sock); sock.on('close', () => open.delete(sock)); });
  const settled = async () => { for (let i = 0; i < 40 && (open.size || timers()); i++) await new Promise((r) => setTimeout(r, 25)); };
  try {
    const base = `http://127.0.0.1:${port(srv)}`;
    assert.equal(await getText(`${base}/redir`, 5000), 'landed', 'redirect follows');
    await settled();
    assert.equal(timers(), 0, 'redirect settle leaves a deadline timer');
    assert.equal(open.size, 0, 'redirect settle leaves an upstream socket');

    await assert.rejects(getText(`${base}/nf`, 5000), /status 404/);
    await settled();
    assert.equal(timers(), 0, 'non-200 settle leaves a deadline timer');
    assert.equal(open.size, 0, 'non-200 settle leaves an upstream socket');

    assert.equal(await getText(`${base}/ok`, 5000), 'plain-ok');
    await settled();
    assert.equal(timers(), 0, 'success settle leaves a deadline timer');
    assert.equal(open.size, 0, 'success settle leaves an upstream socket');

    await assert.rejects(getText('http://127.0.0.1:1/', 5000), /ECONNREFUSED/);
    assert.equal(timers(), 0, 'error settle leaves a deadline timer');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('refresh/refreshUbo: concurrent triggers share one in-flight pass (single-flight)', async () => {
  // r16 review: 14 concurrent refreshes ran 14 in-flight upstream passes and
  // grew live timers 18 -> 30. one pass owns the work; the rest share it.
  rmSync(files().FILE, { force: true });
  rmSync(files().UBO_FILE, { force: true });
  const lowe = []; for (let i = 0; i < 1500; i++) lowe.push(`sf-lowe${i}.example`);
  const ubo = []; for (let i = 0; i < 6000; i++) ubo.push(`||sf-ubo${i}.example^`);
  let loweHits = 0, uboHits = 0;
  const srv = await serve((req, res) => {
    if (req.url === '/lowe') { loweHits++; res.writeHead(200); res.end(lowe.join('\n')); }
    else { uboHits++; res.writeHead(200); res.end(ubo.join('\n')); }
  });
  try {
    await Promise.all(Array.from({ length: 14 }, () => refresh(`http://127.0.0.1:${port(srv)}/lowe`)));
    assert.equal(loweHits, 1, 'concurrent refreshes must coalesce to one upstream pass');
    await Promise.all(Array.from({ length: 14 }, () => refreshUbo([`http://127.0.0.1:${port(srv)}/ubo`])));
    assert.equal(uboHits, 1, 'concurrent ubo refreshes must coalesce to one upstream pass');
    assert.equal(timers(), 0, 'no deadline timers retained after the coalesced passes');
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('getText: a redirect to an unparseable Location rejects cleanly (no crash, no retention)', async () => {
  // Location: http://[ throws ERR_INVALID_URL synchronously inside the
  // response callback - uncaught, that is a process exit (Sage r16b probe).
  const srv = await serve((req, res) => { res.writeHead(302, { location: 'http://[' }); res.end(); });
  try {
    await assert.rejects(getText(`http://127.0.0.1:${port(srv)}/`, 5000), /bad redirect location/);
    assert.equal(timers(), 0, 'no deadline timer retained');
  } finally { srv.close(); }
});

test('getText: oversize body rejects as "too big" at once - not "deadline" at the timeout', async () => {
  // mutation-backed: the r16b form (destroy res+req, no reject) hangs to the
  // deadline and reports the wrong cause (Sage repro); the fixed form must
  // reject near-instantly with the real cause and keep no timer.
  const srv = await serve((req, res) => res.end(Buffer.alloc(17 * 1024 * 1024, 120)));
  try {
    const start = Date.now();
    await assert.rejects(getText(`http://127.0.0.1:${port(srv)}/`, 30000), /too big/);
    assert.ok(Date.now() - start < 5000, 'must reject when the cap trips, not at the deadline');
    assert.equal(timers(), 0, 'no deadline timer retained');
  } finally { srv.close(); }
});

test('getText: a non-http(s) url rejects up front with no hanging timer', async () => {
  // ftp:// used to pick the http module and throw synchronously inside the
  // promise executor - rejecting the promise but leaving the deadline timer
  // live until it fired (Sage r17 probe).
  await assert.rejects(getText('ftp://127.0.0.1/a', 30000), /bad url/);
  assert.equal(timers(), 0, 'no deadline timer retained');
});
