import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAlbumPage, albumQuery, runtime } from './album.js';
const row = (o) => ({ key: (o.src || 'yt') + ':' + o.id, src: 'yt', id: 'x', title: 't', artist: '', album: '', dur: '3:00', durSec: 180, art: '', stream: '', ...o });

test('keeps only rows with that album credited to the artist, server order', () => {
  const rows = [
    row({ id: '1', artist: 'Daft Punk', album: 'Discovery', title: 'b' }),
    row({ id: '2', artist: 'Daft Punk', album: 'Homework', title: 'x' }),
    row({ id: '3', artist: 'Other', album: 'Discovery', title: 'y' }),
    row({ id: '4', artist: 'Pharrell, Daft Punk', album: ' discovery', title: 'a' }),
    row({ src: 'sc', id: '5', artist: 'Daft Punk', title: 'no album' }),
  ];
  const p = buildAlbumPage(rows, 'Daft Punk', 'Discovery');
  assert.deepEqual(p.tracks.map((r) => r.title), ['b', 'a']);
  assert.equal(p.total, 2); assert.equal(p.durSec, 360);
  assert.equal(p.name, 'Discovery'); assert.equal(p.artist, 'Daft Punk');
});
test('album name is compared normalised (accents, case, punctuation)', () => {
  assert.equal(buildAlbumPage([row({ artist: 'A', album: 'Café!' })], 'A', 'cafe').total, 1);
});
test('empty or missing album matches nothing (never every blank-album row)', () => {
  const rows = [row({ artist: 'A', album: '' }), row({ artist: 'A' })];
  assert.equal(buildAlbumPage(rows, 'A', '').total, 0);
  assert.equal(buildAlbumPage(rows, 'A', undefined).total, 0);
});
test('art is first non-empty; bad durSec does not poison the total', () => {
  const rows = [row({ artist: 'A', album: 'X', durSec: NaN }), row({ id: '2', artist: 'A', album: 'X', art: '/art?1', durSec: 60 })];
  const p = buildAlbumPage(rows, 'A', 'X');
  assert.equal(p.art, '/art?1'); assert.equal(p.durSec, 60);
});
test('junk input never throws', () => {
  for (const bad of [undefined, null, 5, 'x', [null, undefined, {}]]) assert.equal(buildAlbumPage(bad, 'A', 'X').total, 0);
});
test('albumQuery and runtime', () => {
  assert.equal(albumQuery('Daft Punk, Pharrell', ' Discovery '), 'Daft Punk Discovery');
  assert.equal(albumQuery('', 'X'), 'X');
  assert.equal(runtime(0), '0 min'); assert.equal(runtime(2400), '40 min'); assert.equal(runtime(4500), '1 hr 15 min');
});
