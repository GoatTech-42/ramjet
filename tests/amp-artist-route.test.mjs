import test from 'node:test';
import assert from 'node:assert/strict';
import { hashForArtist, parseArtistHash } from '../web/src/lib/artist-route.js';

test('round-trips a provider id', () => {
  for (const [src, id] of [['yt', 'UCX6OQ3DkcsbYNE6H8uQQuVA'], ['sc', '12345'], ['au', 'aB9xZ']]) {
    assert.deepEqual(parseArtistHash(hashForArtist(src, id)), { src, id });
  }
});

test('round-trips a youtube name lookup', () => {
  const h = hashForArtist('yt', 'name~lofi girl');
  assert.deepEqual(parseArtistHash(h), { src: 'yt', name: 'lofi girl' });
});

test('keeps opaque ids with reserved characters intact', () => {
  assert.deepEqual(parseArtistHash(hashForArtist('yt', 'UC:a/b?c')), { src: 'yt', id: 'UC:a/b?c' });
});

test('rejects junk', () => {
  for (const h of ['', '#', '#/amp', '#/amp/artist/', '#/amp/artist/xx:1', '#/amp/artist/yt:', '#/other/yt:1', '#/amp/artist/yt:name~', '#/amp/artist/%ZZ']) {
    assert.equal(parseArtistHash(h), null, h);
  }
});

test('rejects names that are only whitespace', () => {
  assert.equal(parseArtistHash(hashForArtist('yt', 'name~   ')), null);
});
