import test from 'node:test';
import assert from 'node:assert/strict';
import { norm, primaryArtist, credit, buildArtistPage, summary } from './artist.js';

const row = (o) => ({ key: o.src + ':' + o.id, src: 'yt', id: 'x', title: 't', artist: '', dur: '3:00', durSec: 180, art: '', stream: '', ...o });

test('norm: case, accents, punctuation', () => {
  assert.equal(norm('  Beyoncé!! '), 'beyonce');
  assert.equal(norm('AC/DC'), 'ac dc');
  assert.equal(norm(null), '');
});
test('primaryArtist uses the same splitter as the player bar', () => {
  assert.equal(primaryArtist('Daft Punk, Pharrell Williams'), 'Daft Punk');
  assert.equal(primaryArtist('A & B'), 'A');
  assert.equal(primaryArtist('A feat. B'), 'A');
  assert.equal(primaryArtist('  Tyler, The Creator'), 'Tyler');   // known limit of the shared splitter
  assert.equal(primaryArtist(undefined), '');
});
test('credit: lead 2, featured 1, other 0, exact name only', () => {
  assert.equal(credit(row({ artist: 'Daft Punk' }), 'daft punk'), 2);
  assert.equal(credit(row({ artist: 'Pharrell Williams, Daft Punk' }), 'Daft Punk'), 1);
  assert.equal(credit(row({ artist: 'Prince Royce' }), 'Prince'), 0);
  assert.equal(credit(row({ artist: 'Daft Punk Official' }), 'Daft Punk'), 0);
  assert.equal(credit(row({ artist: '' }), 'Daft Punk'), 0);
  assert.equal(credit(null, 'x'), 0);
  assert.equal(credit(row({ artist: 'x' }), ''), 0);
});
test('buildArtistPage: lead before featured, server order kept inside groups, others dropped', () => {
  const rows = [
    row({ id: '1', artist: 'Pharrell, Daft Punk', title: 'feat1' }),
    row({ id: '2', artist: 'Daft Punk', title: 'lead1' }),
    row({ id: '3', artist: 'Someone Else', title: 'no' }),
    row({ id: '4', src: 'sc', artist: 'daft punk', title: 'lead2' }),
  ];
  const p = buildArtistPage(rows, 'Daft Punk');
  assert.deepEqual(p.tracks.map((r) => r.title), ['lead1', 'lead2', 'feat1']);
  assert.equal(p.total, 3); assert.equal(p.leadCount, 2);
  assert.deepEqual(p.counts, { yt: 2, sc: 1, au: 0 });
});
test('no dedupe across sources (player fallback needs the other-source copy)', () => {
  const rows = [row({ id: '1', artist: 'A', title: 'Song' }), row({ src: 'sc', id: '2', artist: 'A', title: 'Song' })];
  assert.equal(buildArtistPage(rows, 'A').tracks.length, 2);
});
test('header art is the first non-empty art; name keeps catalog casing', () => {
  const rows = [row({ id: '1', artist: 'daft punk', art: '' }), row({ id: '2', artist: 'Daft Punk', art: '/api/apps/amp/art?src=yt&id=abc' })];
  const p = buildArtistPage(rows, 'DAFT PUNK');
  assert.equal(p.art, '/api/apps/amp/art?src=yt&id=abc');
  assert.equal(p.name, 'daft punk');
  assert.equal(p.query, 'DAFT PUNK');
});
test('albums: grouped by normalised name, most songs first, blanks ignored', () => {
  const rows = [
    row({ id: '1', artist: 'A', album: 'Discovery' }), row({ id: '2', artist: 'A', album: 'discovery ' }),
    row({ id: '3', artist: 'A', album: 'Homework' }), row({ id: '4', artist: 'A', album: '' }), row({ id: '5', artist: 'A' }),
  ];
  const a = buildArtistPage(rows, 'A').albums;
  assert.deepEqual(a.map((x) => [x.name, x.count]), [['Discovery', 2], ['Homework', 1]]);
});
test('empty and junk input never throws', () => {
  for (const bad of [undefined, null, [], 'x', 5]) {
    const p = buildArtistPage(bad, 'A');
    assert.equal(p.total, 0); assert.deepEqual(p.tracks, []); assert.equal(p.art, '');
  }
  assert.equal(buildArtistPage([row({ artist: 'A' })], '').total, 0);
});
test('does not mutate the input rows', () => {
  const rows = [row({ id: '1', artist: 'A' })]; const snap = JSON.stringify(rows);
  buildArtistPage(rows, 'A'); assert.equal(JSON.stringify(rows), snap);
});
test('summary lists only sources that have songs', () => {
  assert.equal(summary({ counts: { yt: 2, sc: 0, au: 1 } }), '2 on youtube music · 1 on audius');
  assert.equal(summary({ counts: { yt: 0, sc: 0, au: 0 } }), '');
});
