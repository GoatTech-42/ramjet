// regression: the artist read-path cache must never leak caller-specific
// data across requests. the cached channel page is upstream-derived and
// frozen; search-card fallbacks land on a per-request clone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ampInternals } from '../core/addons/amp/index.js';

const UC = 'UCcachetest01';
const card = (browseId, name, art, sub) => ({
  contents: { a: { musicCardShelfRenderer: {
    title: { runs: [{ text: name, navigationEndpoint: { browseEndpoint: { browseId } } }] },
    thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: art }] } } },
    subtitle: { runs: [{ text: sub }] },
  } } },
});
// a browse payload with NO header: name/art/sub stay empty upstream, so the
// caller's search-card fallbacks are what fill them
const browseNoHeader = { contents: { nothing: 'here' } };

const calls = { search: 0, browse: 0 };
const realFetch = globalThis.fetch;
const stub = (searchFor) => {
  globalThis.fetch = async (url, opts) => {
    const endpoint = /youtubei\/v1\/(\w+)/.exec(String(url))?.[1];
    if (endpoint === 'search') {
      calls.search++;
      const q = JSON.parse(opts.body).query;
      return { ok: true, json: async () => searchFor(q) };
    }
    if (endpoint === 'browse') { calls.browse++; return { ok: true, json: async () => browseNoHeader }; }
    throw new Error('unexpected fetch ' + url);
  };
};
test.after(() => { globalThis.fetch = realFetch; });

test('two names resolving to one channel keep their own fallbacks', async () => {
  stub((q) => q === 'artist-alpha'
    ? card(UC, 'Card Alpha', 'https://img/alpha.jpg', 'sub alpha')
    : card(UC, 'Card Beta', 'https://img/beta.jpg', 'sub beta'));
  const a = await ampInternals.ymArtist('artist-alpha');
  assert.equal(a.name, 'Card Alpha');
  assert.equal(a.art, 'https://img/alpha.jpg');
  const b = await ampInternals.ymArtist('artist-beta');
  assert.equal(b.name, 'Card Beta', 'second caller inherited the first caller\'s card - cache keyed wrong or polluted');
  assert.equal(b.art, 'https://img/beta.jpg');
  assert.equal(b.sub, 'sub beta');
  assert.equal(calls.browse, 1, 'channel page should be fetched once and cached');
});

test('cached values are frozen; mutating a returned clone never pollutes the cache', async () => {
  stub(() => card(UC + '2', 'Card Gamma', 'https://img/gamma.jpg', 'sub gamma'));
  const first = await ampInternals.ymArtist('artist-gamma');
  first.name = 'HACKED'; // the per-request clone's own fields are the caller's
  // the clone SHARES the frozen tracks array with the cache by design
  assert.throws(() => first.tracks.push({ id: 'fake' }), TypeError);
  const stored = ampInternals.artistTtl.get('ymid:' + UC + '2');
  assert.ok(Object.isFrozen(stored), 'cached channel page must be frozen');
  assert.ok(Object.isFrozen(stored.tracks), 'cached tracks array must be frozen');
  assert.throws(() => { stored.name = 'x'; }, TypeError, 'mutating the cached value must throw');
  const again = await ampInternals.ymArtist('artist-gamma');
  assert.equal(again.name, 'Card Gamma', 'caller mutation leaked into the cache');
  assert.equal(again.tracks.length, 0, 'caller mutation leaked into cached tracks');
});

test('a failed resolution caches nothing and retries honestly', async () => {
  let down = true;
  globalThis.fetch = async (url) => {
    const endpoint = /youtubei\/v1\/(\w+)/.exec(String(url))?.[1];
    if (endpoint === 'search' && down) return { ok: false, status: 503, json: async () => ({}) };
    if (endpoint === 'search') return { ok: true, json: async () => card(UC + '3', 'Card Delta', '', '') };
    if (endpoint === 'browse') return { ok: true, json: async () => browseNoHeader };
    throw new Error('unexpected fetch ' + url);
  };
  await assert.rejects(() => ampInternals.ymArtist('artist-delta'), /ym 503/);
  down = false;
  const out = await ampInternals.ymArtist('artist-delta');
  assert.equal(out.name, 'Card Delta');
});

test('id-primed empty channel page still takes the card fallback on a later name lookup', async () => {
  // reviewer repro: /artist?id=UC... primes the id cache with a headerless
  // (empty-name) page; a later name lookup must apply its card fallback
  // per-request, and the shared cached object must stay untouched
  stub(() => card(UC + '4', 'Card Eps', 'https://img/eps.jpg', 'sub eps'));
  const primed = await ampInternals.ymArtistById(UC + '4');
  assert.equal(primed.name, '', 'headerless browse should yield an empty upstream name');
  const viaName = await ampInternals.ymArtist('artist-eps');
  assert.equal(viaName.name, 'Card Eps', 'card fallback ignored after id priming');
  assert.equal(viaName.art, 'https://img/eps.jpg');
  const again = await ampInternals.ymArtistById(UC + '4');
  assert.equal(again.name, '', 'fallback leaked into the shared cached object');
});

test('search cache keys are namespaced per provider and legit empty results cache', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('youtubei')) return { ok: true, json: async () => ({ contents: { x: 1 } }) };
    if (u === 'https://soundcloud.com/') return { text: async () => '<script src="https://a-v2.sndcdn.com/app.js"></script>' };
    if (u === 'https://a-v2.sndcdn.com/app.js') return { text: async () => 'x={client_id:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' };
    if (u.includes('api-v2.soundcloud.com')) return { ok: true, json: async () => ({ collection: [] }) };
    throw new Error('unexpected ' + u);
  };
  await ampInternals.ymSearch('wiretest');
  await ampInternals.scSearch('wiretest');
  const ym = ampInternals.searchTtl.get('ym:wiretest');
  const sc = ampInternals.searchTtl.get('sc:wiretest');
  assert.ok(ym !== undefined && sc !== undefined, 'a legit empty result must cache');
  assert.notEqual(ym, sc, 'providers share one cache only through namespaced keys');
});

test('an http-200 error envelope is rejected, never cached, and recovery works', async () => {
  let bad = true;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('youtubei')) return { ok: true, json: async () => (bad ? { error: { code: 500 } } : { contents: { x: 1 } }) };
    if (u === 'https://soundcloud.com/') return { text: async () => '<script src="https://a-v2.sndcdn.com/app.js"></script>' };
    if (u === 'https://a-v2.sndcdn.com/app.js') return { text: async () => 'x={client_id:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' };
    if (u.includes('api-v2.soundcloud.com')) return { ok: true, json: async () => (bad ? {} : { collection: [] }) };
    throw new Error('unexpected ' + u);
  };
  await assert.rejects(() => ampInternals.ymSearch('envtest'), /bad payload/);
  await assert.rejects(() => ampInternals.scSearch('envtest'), /bad payload/);
  assert.equal(ampInternals.searchTtl.get('ym:envtest'), undefined, 'error envelope cached');
  assert.equal(ampInternals.searchTtl.get('sc:envtest'), undefined, 'error envelope cached');
  bad = false;
  await ampInternals.ymSearch('envtest');
  assert.ok(ampInternals.searchTtl.get('ym:envtest') !== undefined, 'recovery did not cache');
});
