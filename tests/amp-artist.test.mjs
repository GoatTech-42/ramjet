import test from 'node:test';
import assert from 'node:assert/strict';
import { ampInternals } from '../core/addons/amp/index.js';

const { ymRow, scTrackOk, scMap, auMap, parseM3U8, patchInitDuration } = ampInternals;

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

const scTrack2 = (tcs) => ({
  id: 101, title: 'Awake', streamable: true, duration: 283000,
  user: { id: 833415, username: 'Tycho' },
  artwork_url: 'https://i1.sndcdn.com/artworks-abc-large.jpg',
  media: { transcodings: tcs },
});

test('scTrackOk keeps progressive and hls-aac rows, drops dead variants', () => {
  const prog = { format: { protocol: 'progressive', mime_type: 'audio/mpeg' }, url: 'https://x' };
  const hlsAac = { format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' }, url: 'https://x' };
  const hlsMp3 = { format: { protocol: 'hls', mime_type: 'audio/mpegurl' }, url: 'https://x' }; // 404s at resolve upstream
  assert.equal(scTrackOk(scTrack2([prog])), true);
  assert.equal(scTrackOk(scTrack2([hlsAac])), true);
  assert.equal(scTrackOk(scTrack2([hlsMp3])), false);
  assert.equal(scTrackOk(scTrack2([hlsMp3, hlsMp3])), false);
  assert.equal(scTrackOk({ ...scTrack2([hlsAac]), streamable: false }), false);
  assert.equal(scTrackOk({ ...scTrack2([hlsAac]), id: null }), false);
  assert.equal(scTrackOk(scTrack2([])), true); // unknown shape - let /stream try
});

test('parseM3U8 reads init map, segments, relative urls, master unwrap', () => {
  const base = 'https://cdn.example/x/playlist.m3u8?sig=1';
  const media = [
    '#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MAP:URI="init.mp4?sig=1"',
    '#EXTINF:10.0,', 'data000.m4s?sig=1',
    '#EXTINF:10.0,', 'https://cdn.example/x/data001.m4s?sig=1',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const pl = parseM3U8(media, base);
  assert.equal(pl.init, 'https://cdn.example/x/init.mp4?sig=1');
  assert.deepEqual(pl.segs, ['https://cdn.example/x/data000.m4s?sig=1', 'https://cdn.example/x/data001.m4s?sig=1']);
  const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'var.m3u8?sig=2'].join('\n');
  assert.deepEqual(parseM3U8(master, base), { variant: 'https://cdn.example/x/var.m3u8?sig=2' });
  assert.throws(() => parseM3U8('#EXTM3U\n#EXT-X-VERSION:7', base), /empty playlist/);
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

test('patchInitDuration writes the real duration into mvhd/tkhd/mdhd and inserts mehd', () => {
  const box = (type, payload) => {
    const b = Buffer.alloc(8 + payload.length);
    b.writeUInt32BE(b.length, 0); b.write(type, 4, 'latin1');
    payload.copy(b, 8);
    return b;
  };
  const v0box = (type, fields) => box(type, Buffer.concat([Buffer.alloc(4), ...fields])); // version+flags
  const mvhd = v0box('mvhd', [Buffer.alloc(8), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(1000); return b; })(), Buffer.alloc(4)]); // ts=1000, dur=0
  const mdhd = v0box('mdhd', [Buffer.alloc(8), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(44100); return b; })(), Buffer.alloc(4)]); // ts=44100, dur=0
  const tkhd = v0box('tkhd', [Buffer.alloc(16), Buffer.alloc(4)]); // ... reserved + dur=0
  const init = Buffer.concat([
    box('ftyp', Buffer.from('iso5\0\0\0\0', 'latin1')),
    box('moov', Buffer.concat([mvhd, tkhd, box('trak', box('mdia', mdhd)), box('mvex', box('trex', Buffer.alloc(24)))])),
  ]);
  const out = patchInitDuration(init, 283682);
  assert.ok(out.length === init.length + 16, 'moov grew by one mehd');
  const moovOff = 16; // ftyp box: 8 header + 8 payload
  assert.equal(out.readUInt32BE(moovOff), init.readUInt32BE(moovOff) + 16);
  assert.equal(out.toString('latin1', moovOff + 4, moovOff + 8), 'moov');
  // mvhd duration @ mvhd.off+24 : mvhd is first child of moov
  const mvhdOff = moovOff + 8;
  assert.equal(out.readUInt32BE(mvhdOff + 24), 283682);
  // tkhd duration @ tkhd.off+28
  const tkhdOff = mvhdOff + out.readUInt32BE(mvhdOff);
  assert.equal(out.toString('latin1', tkhdOff + 4, tkhdOff + 8), 'tkhd');
  assert.equal(out.readUInt32BE(tkhdOff + 28), 283682);
  // mdhd duration in media timescale
  const s = out.toString('latin1');
  const mdhdOff = s.indexOf('mdhd') - 4;
  assert.equal(out.readUInt32BE(mdhdOff + 24), Math.round(283682 * 44.1));
  // mehd inserted inside mvex with the movie-timescale duration
  const mehdOff = s.indexOf('mehd') - 4;
  assert.ok(mehdOff > 0);
  assert.equal(out.readUInt32BE(mehdOff + 12), 283682);
  // original buffer untouched
  assert.equal(init.readUInt32BE(mvhdOff + 24), 0);
  // zero/short inputs pass through unchanged
  assert.equal(patchInitDuration(init, 0).equals(init), true);
  assert.equal(patchInitDuration(Buffer.alloc(4), 100).length, 4);
});
