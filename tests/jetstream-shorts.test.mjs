import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShortsFeed, shortsSeeds } from '../core/addons/jetstream/shorts-rank.js';

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

// Main now uses rotating seeds and a 28-item pool, rather than two fixed
// 20-item searches. Feed-contract tests pin seed randomness for repeatable
// exhaustion; ranker tests cover rotation independently.
const originalRandom = Math.random; Math.random = () => 0;
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

const { register, shutdownJetstream } = await import('../core/addons/jetstream/index.js');

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
  // Main may refill early when diversity leaves fewer than minLeft candidates.
  assert.ok(searchCalls.length >= before);
  assert.ok(!ids(b2).some((id) => ids(b1).includes(id)), 'batch 2 repeats batch 1');
  // With deterministic generic rotation the pool refills from successive
  // seed queries; assert no repeats and bounded exhaustion, not old 2x20 shape.
  const seen = new Set([...ids(b1), ...ids(b2)]);
  for (let i = 0; i < 30; i++) {
    const batch = await shorts(u); assert.equal(batch.code, 200);
    for (const id of ids(batch)) { assert.ok(!seen.has(id), 'repeat before pool exhaustion'); seen.add(id); }
    if (!batch.obj.items.length) break;
  }
  assert.ok(seen.size >= 28);

});

test('EP3: a drained feed waits out the rebuild and serves a fresh disjoint batch', async () => {
  writeFileSync(join(dataRoot, 'jetstream-history.json'), JSON.stringify({
    'ep3-profiled': [{ id: 'hhhhhhhhhh1', title: 'skateboard tricks contest', channel: 'tonyhawk', duration: '3:20', secs: 200, ws: 190 }],
  }));
  const u = 'ep3-profiled';
  const seen = new Set();
  const beforeSeeds = new Set(searchCalls);
  const batches = [];
  for (let i = 0; i < 15; i++) {
    const out = await shorts(u);
    assert.equal(out.code, 200);
    if (out.obj.items.length === 0) break;
    batches.push(ids(out));
    for (const id of ids(out)) { assert.ok(!seen.has(id), 'repeat across feed batches'); seen.add(id); }
  }
  // 6 rotated " shorts" seed queries x 20 parseSearch-capped candidates
  assert.ok(seen.size >= 120, 'rotated pools must serve at least 120 distinct shorts');
  assert.ok(batches.length >= 9, 'serve enough disjoint batches to require multiple builds');
  assert.ok(new Set(searchCalls.filter(q => !beforeSeeds.has(q))).size >= 2, 'real endpoint explores distinct uncached seed queries');
  // Batch sizes need not dip before a refill. Count actual builds at the feed
  // seam and use the real seed rotation instead of a monotonic-size oracle.
  let builds = 0;
  const seedBuilds = [];
  const profile = { topic: new Map(), chan: new Map() };
  const feed = createShortsFeed({ build: async (user, hit) => {
    builds++;
    const seeds = shortsSeeds(profile, hit.n, () => 0);
    seedBuilds.push(seeds);
    return Array.from({ length: 28 }, (_, i) => ({ id: `${seeds.join('|')}:${i}` }));
  }});
  const served = new Set();
  for (let i = 0; i < 6; i++) {
    const batch = await feed.get('explicit-build-fixture');
    assert.equal(batch.length, 14);
    for (const v of batch) { assert.ok(!served.has(v.id), 'explicit build repeats a prior batch'); served.add(v.id); }
    feed.serve('explicit-build-fixture', batch);
  }
  assert.equal(builds, 3, 'six 14-item batches consume three 28-item builds');
  assert.deepEqual(seedBuilds, [['satisfying shorts'], ['skill shorts'], ['animals shorts']], 'build count advances the real deterministic seed rotation');
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
  const seen = new Set([...ids(w1), ...ids(w2)]);
  let empty = false;
  for (let i = 0; i < 30; i++) {
    const batch = await shorts(u); assert.equal(batch.code, 200);
    for (const id of ids(batch)) { assert.ok(!seen.has(id)); seen.add(id); }
    if (!batch.obj.items.length) { empty = true; break; }
  }
  assert.ok(empty, 'outage at exhaustion answers empty, never repeats');
  OUTAGE = false;
});

test('cleanup', () => { Math.random = originalRandom; shutdownJetstream(); rmSync(dataRoot, { recursive: true, force: true }); });
