import test from 'node:test';
import assert from 'node:assert/strict';
import { ampInternals } from '../core/addons/amp/index.js';

const { ymRow, scTrackOk, scMap, auMap } = ampInternals;

const ymItem = (over = {}) => ({
  playlistItemData: { videoId: 'XFkzRNyygfk' },
  flexColumns: [
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'Creep' }] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [
      { text: 'Radiohead', navigationEndpoint: { browseEndpoint: { browseId: 'UCr_iyUANcn9OX_yy9piYoLw' } } },
      { text: ' \u2022 ' },
      { text: 'Pablo Honey' },
      { text: ' \u2022 ' },
      { text: '3:58' },
    ] } } },
    { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '2.3B plays' }] } } },
  ],
  ...over,
});

test('ymRow maps a YM songs row with artist channel id, album, plays, duration', () => {
  const row = ymRow(ymItem());
  assert.equal(row.src, 'yt');
  assert.equal(row.id, 'XFkzRNyygfk');
  assert.equal(row.title, 'Creep');
  assert.equal(row.artist, 'Radiohead');
  assert.equal(row.artistId, 'UCr_iyUANcn9OX_yy9piYoLw');
  assert.equal(row.album, 'Pablo Honey');
  assert.equal(row.plays, '2.3B plays');
  assert.equal(row.dur, '3:58');
  assert.equal(row.durSec, 238);
  assert.equal(row.art, '/api/apps/amp/art?src=yt&id=XFkzRNyygfk');
  assert.equal(row.stream, '/api/apps/amp/stream?src=yt&id=XFkzRNyygfk');
});

test('ymRow drops rows with no video id or no title', () => {
  assert.equal(ymRow({ flexColumns: [] }), null);
  const noVid = ymItem({ playlistItemData: { videoId: 'short' } });
  assert.equal(ymRow(noVid), null);
});

test('ymRow leaves artistId empty when the artist run does not link a UC channel', () => {
  const it = ymItem();
  delete it.flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs[0].navigationEndpoint;
  const row = ymRow(it);
  assert.equal(row.artist, 'Radiohead');
  assert.equal(row.artistId, '');
});

const scTrack = (protocols) => ({
  id: 101, title: 'Awake', streamable: true, duration: 283000,
  user: { id: 833415, username: 'Tycho' },
  artwork_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
  media: { transcodings: protocols.map((p) => ({ format: { protocol: p, mime_type: 'audio/mpeg' }, url: 'https://api-v2.soundcloud.com/x' })) },
});

test('scTrackOk keeps progressive rows and drops hls-only rows (today upstream shape)', () => {
  assert.equal(scTrackOk(scTrack(['progressive', 'hls'])), true);
  assert.equal(scTrackOk(scTrack(['hls', 'hls'])), false);
  assert.equal(scTrackOk({ ...scTrack(['progressive']), streamable: false }), false);
  assert.equal(scTrackOk({ ...scTrack(['progressive']), id: null }), false);
});

test('scMap carries the user id as artistId and proxies art', () => {
  const row = scMap(scTrack(['progressive']));
  assert.equal(row.artistId, '833415');
  assert.equal(row.artist, 'Tycho');
  assert.ok(row.art.startsWith('/api/apps/amp/art?src=sc&u='));
  const decoded = Buffer.from(row.art.split('u=')[1], 'base64url').toString();
  assert.ok(decoded.includes('t500x500'));
});

test('auMap carries the user id as artistId and proxies art', () => {
  const row = auMap({
    id: 'xjadX', title: 'Higher Ground', duration: 228,
    user: { id: '2oNg1', name: 'ODESZA' },
    artwork: { '480x480': 'https://audius.example/480.jpg', '150x150': 'https://audius.example/150.jpg' },
  });
  assert.equal(row.src, 'au');
  assert.equal(row.artistId, '2oNg1');
  assert.equal(row.artist, 'ODESZA');
  assert.equal(row.dur, '3:48');
  assert.ok(row.art.startsWith('/api/apps/amp/art?src=au&u='));
});
