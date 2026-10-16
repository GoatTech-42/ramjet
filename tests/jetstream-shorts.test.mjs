import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// jetstream /shorts endpoint contract, in-process against the real register()
// with a stubbed InnerTube: no network, no box. pins the reviewer findings:
// EP1 blank query falls back to the feed; EP3 cached feed batches are disjoint
// and a drained feed rebuilds instead of repeating; EP5 a query returns a
// stable, repeatable order; EP6 a total search outage answers 200 + empty,
// never repeats served items, never an error page.
//
// Fixture facts the expectations lean on: parseSearch keeps the first 20
// results per query; the shorts pool per " shorts" query below is 30, so each
// contributes exactly 20 candidates. The module-level search cache (3 min) is
// shared across tests in this file, which is why the cold-outage test runs
// first: its generic seed queries must be uncached for the outage to bite.

const dataRoot = mkdtempSync(join(tmpdir(), 'rj-jetstream-'));
process.env.RJ_DATA = dataRoot;
process.env.YTDLP = '/nonexistent'; // prefetch warmers fail fast instead of probing the network

let OUTAGE = false;
const searchCalls = [];
const qIdx = new Map();
const idxFor = (q) => { if (!qIdx.has(q)) qIdx.set(q, qIdx.size); return qIdx.get(q); };

function searchData(query) {
  const base = idxFor(query) * 1000;
  const shortsQ = / shorts$/.test(query); // shorts phrasing yields short-form, plain yields long
  const n = shortsQ ? 30 : 4;
  const vids = [];
  for (let i = 0; i < n; i++) {
    const num = base + i;
    vids.push({
      videoRenderer: {
        videoId: String(num).padStart(11, '0'),
        title: { runs: [{ text: `${query} number ${num}` }] },
        lengthText: { simpleText: shortsQ ? '0:35' : '8:20' },
        ownerText: { runs: [{ text: 'chan' + (num % 7) }] },
        viewCountText: { simpleText: `${1000 + num} views` },
        publishedTimeText: { simpleText: '3 days ago' },
      },
    });
  }
  return { contents: vids };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://www.youtube.com/youtubei/v1/search')) {
    const body = JSON.parse(opts.body || '{}');
    searchCalls.push(body.query);
    if (OUTAGE) throw new Error('fixture outage');
    return new Response(JSON.stringify(searchData(body.query || '')), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new Error('offline fixture: ' + u.slice(0, 80));
};

const { register } = await import('../core/addons/jetstream/index.js');

async function shorts(user, qs = '') {
  let out;
  const req = { url: '/api/apps/jetstream/shorts' + qs, method: 'GET', headers: {} };
  await register(req, {}, {
    url: new URL(req.url, 'http://fixture.local'),
    sendJson: (res, code, obj) => { out = { code, obj }; },
    guard: { trackBytes() {} },
    session: { user },
  });
  return out;
}
const ids = (out) => out.obj.items.map((v) => v.id);

test('EP6: a total search outage on a cold feed answers 200 + empty, not an error page', async () => {
  // first test on purpose: the generic seed queries must still be uncached
  OUTAGE = true;
  const cold = await shorts('ep6-cold');
  OUTAGE = false;
  assert.equal(cold.code, 200, 'cold outage must not become an error page');
  assert.deepEqual(cold.obj.items, [], 'cold outage must answer empty');
});

test('EP3: cached feed batches are disjoint and never repeat served shorts', async () => {
  const u = 'ep3-feed';
  const b1 = await shorts(u);
  assert.equal(b1.code, 200);
  assert.equal(b1.obj.items.length, 14);
  const before = searchCalls.length;
  const b2 = await shorts(u);
  assert.equal(b2.code, 200);
  assert.equal(b2.obj.items.length, 14);
  assert.equal(searchCalls.length, before, 'second open within the cache TTL must not re-hit search');
  assert.ok(!ids(b2).some((id) => ids(b1).includes(id)), 'batch 2 repeats batch 1');
  // 2 " shorts" seed queries x 20 = 40 cached shorts: 14 + 14 + 12, then the
  // drained cache (rebuild finds only already-served ids) answers empty
  const b3 = await shorts(u); assert.equal(b3.obj.items.length, 12);
  assert.ok(!ids(b3).some((id) => [...ids(b1), ...ids(b2)].includes(id)), 'batch 3 repeats an earlier batch');
  const b4 = await shorts(u);
  assert.equal(b4.code, 200);
  assert.equal(b4.obj.items.length, 0, 'a fully served feed must answer empty, never repeat');
});

test('EP3: a drained feed waits out the rebuild and serves a fresh disjoint batch', async () => {
  writeFileSync(join(dataRoot, 'jetstream-history.json'), JSON.stringify({
    'ep3-profiled': [{ id: 'hhhhhhhhhh1', title: 'skateboard tricks contest', channel: 'tonyhawk', duration: '3:20', secs: 200, ws: 190 }],
  }));
  const u = 'ep3-profiled';
  const seen = new Set();
  let refilled = false;
  let prev = 14;
  for (let i = 0; i < 15; i++) {
    const out = await shorts(u);
    assert.equal(out.code, 200);
    if (out.obj.items.length === 0) break;
    if (out.obj.items.length > prev) refilled = true; // a short batch followed by a full one: the rebuild refilled
    prev = out.obj.items.length;
    for (const id of ids(out)) { assert.ok(!seen.has(id), 'repeat across feed batches'); seen.add(id); }
  }
  // 6 rotated " shorts" seed queries x 20 parseSearch-capped candidates
  assert.equal(seen.size, 120, 'expected the rotated pools to serve 120 distinct shorts');
  assert.ok(refilled, 'a drained feed must rebuild into a fresh batch instead of dead-ending');
});

test('EP5: a query returns a stable, repeatable order', async () => {
  const u = 'ep5-query';
  const r1 = await shorts(u, '?q=lofi');
  assert.equal(r1.code, 200);
  assert.ok(r1.obj.items.length >= 6, 'query pool too small to be meaningful');
  const r2 = await shorts(u, '?q=lofi');
  assert.equal(r2.code, 200);
  assert.deepEqual(ids(r2), ids(r1), 'same query returned a different order');
  assert.equal(new Set(ids(r1)).size, ids(r1).length, 'duplicate ids in one response');
  assert.ok(r1.obj.items.every((v) => v.duration === '0:35'), 'long-form leaked into the shorts query feed');
});

test('EP1: a blank query falls back to the feed', async () => {
  const r = await shorts('ep1-blank', '?q=%20%20%20');
  assert.equal(r.code, 200);
  assert.equal(r.obj.items.length, 14);
});

test('EP6: a drained feed during a search outage answers 200 + empty, never repeats', async () => {
  const u = 'ep6-warm';
  const w1 = await shorts(u);
  assert.equal(w1.obj.items.length, 14);
  OUTAGE = true;
  const w2 = await shorts(u);
  assert.equal(w2.code, 200);
  assert.equal(w2.obj.items.length, 14);
  assert.ok(!ids(w2).some((id) => ids(w1).includes(id)), 'outage batch repeats the previous batch');
  const w3 = await shorts(u); assert.equal(w3.obj.items.length, 12);
  const w4 = await shorts(u); // cache drained; nothing new can be found
  assert.equal(w4.code, 200, 'outage at exhaustion must not become an error page');
  assert.equal(w4.obj.items.length, 0, 'outage at exhaustion must answer empty, not repeat served items');
  OUTAGE = false;
});

test('cleanup', () => { rmSync(dataRoot, { recursive: true, force: true }); });
