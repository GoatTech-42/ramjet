import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanTrack, serializeQueue, restoreQueue, saveQueue, loadQueue, QKEY, MAX_TRACKS, MAX_CHARS, MAX_AGE_MS } from './queue-persist.js';
import { encodeShare, decodeShare, importPlaylist, MAX_SONGS } from './share.js';

const NOW = 1_800_000_000_000;
const yt = (n, o = {}) => ({ src: 'yt', id: String(n).padStart(11, 'a').slice(-11), title: 'song ' + n, artist: 'A', album: 'X', durSec: 200, art: '/api/apps/amp/art?src=yt&id=abc', ...o });
const mk = (n, o) => cleanTrack(yt(n, o));
const queueOf = (n) => Array.from({ length: n }, (_, i) => mk(i));

// ---------- queue persistence ----------
test('reload mid-song: same queue, same song, same position, modes kept', () => {
  const q = queueOf(5);
  const s = serializeQueue({ queue: q, qi: 3, pos: 61.37, shuffleOn: true, repeatMode: 'all' }, NOW);
  const r = restoreQueue(s, NOW + 60_000);
  assert.equal(r.qi, 3); assert.equal(r.pos, 61.4); assert.equal(r.shuffleOn, true); assert.equal(r.repeatMode, 'all');
  assert.deepEqual(r.queue.map((x) => x.key), q.map((x) => x.key));
  assert.equal(r.queue[3].stream, '/api/apps/amp/stream?src=yt&id=' + q[3].id);
  assert.equal(r.dropped, 0);
});
test('restore never trusts stored stream/key/dur: they are rebuilt from src+id', () => {
  const evil = JSON.stringify({ v: 1, t: NOW, qi: 0, pos: 0, sh: false, rp: 'off', q: [['yt', 'aaaaaaaaaaa', 'x', '', '', 90, '/api/apps/amp/art?q=1', 'https://evil.example/s.mp3']] });
  const r = restoreQueue(evil, NOW);
  assert.equal(r.queue[0].stream, '/api/apps/amp/stream?src=yt&id=aaaaaaaaaaa');
  assert.equal(r.queue[0].dur, '1:30'); assert.equal(r.queue[0].key, 'yt:aaaaaaaaaaa');
});
test('art must be the amp art relay or it is blanked', () => {
  const r = restoreQueue(JSON.stringify({ v: 1, t: NOW, qi: 0, pos: 0, sh: false, rp: 'off', q: [['yt', 'aaaaaaaaaaa', 'x', '', '', 9, 'https://evil.example/a.jpg']] }), NOW);
  assert.equal(r.queue[0].art, '');
});
test('dead/invalid entries are dropped; current song survives with its position', () => {
  const rows = [['yt', 'bad', 'x', '', '', 1, ''], ['yt', 'aaaaaaaaaaa', 'ok1', '', '', 200, ''], ['sc', '12', 'short sc id', '', '', 1, ''], ['au', 'abc123', 'ok2', '', '', 200, '']];
  const r = restoreQueue(JSON.stringify({ v: 1, t: NOW, qi: 3, pos: 42, sh: false, rp: 'off', q: rows }), NOW);
  assert.deepEqual(r.queue.map((x) => x.title), ['ok1', 'ok2']); assert.equal(r.qi, 1); assert.equal(r.pos, 42); assert.equal(r.dropped, 2);
});
test('current song invalid: moves to the next valid song at position 0', () => {
  const rows = [['yt', 'aaaaaaaaaaa', 'before', '', '', 200, ''], ['yt', 'bad', 'dead', '', '', 1, ''], ['au', 'abc123', 'after', '', '', 200, '']];
  const r = restoreQueue(JSON.stringify({ v: 1, t: NOW, qi: 1, pos: 77, sh: false, rp: 'off', q: rows }), NOW);
  assert.equal(r.queue[r.qi].title, 'after'); assert.equal(r.pos, 0);
});
test('current invalid and nothing after it: falls back to the last valid song', () => {
  const rows = [['yt', 'aaaaaaaaaaa', 'only', '', '', 200, ''], ['yt', 'bad', 'dead', '', '', 1, '']];
  const r = restoreQueue(JSON.stringify({ v: 1, t: NOW, qi: 1, pos: 5, sh: false, rp: 'off', q: rows }), NOW);
  assert.equal(r.queue[r.qi].title, 'only'); assert.equal(r.pos, 0);
});
test('all invalid, corrupt, wrong version, empty, wrong types -> null, never throws', () => {
  for (const raw of [null, undefined, '', 'not json', '{}', '[]', '{"v":2,"t":1,"q":[]}', JSON.stringify({ v: 1, t: NOW, q: [] }),
    JSON.stringify({ v: 1, t: NOW, q: [['yt', 'bad', 'x']] }), JSON.stringify({ v: 1, t: 'x', q: [['yt', 'aaaaaaaaaaa', 'x']] }), 5, {}]) {
    assert.equal(restoreQueue(raw, NOW), null, String(raw));
  }
});
test('stale: older than 7 days is ignored, exactly at the limit is kept', () => {
  const s = serializeQueue({ queue: queueOf(2), qi: 0, pos: 1 }, NOW);
  assert.ok(restoreQueue(s, NOW + MAX_AGE_MS));
  assert.equal(restoreQueue(s, NOW + MAX_AGE_MS + 1), null);
});
test('position clamps: junk -> 0, at/near the end -> restart the song', () => {
  const mkRaw = (pos, dur = 200) => JSON.stringify({ v: 1, t: NOW, qi: 0, pos, sh: false, rp: 'off', q: [['yt', 'aaaaaaaaaaa', 'x', '', '', dur, '']] });
  for (const p of [-5, 'x', null, NaN, undefined]) assert.equal(restoreQueue(mkRaw(p), NOW).pos, 0);
  assert.equal(restoreQueue(mkRaw(150), NOW).pos, 150);
  assert.equal(restoreQueue(mkRaw(197), NOW).pos, 0);
  assert.equal(restoreQueue(mkRaw(5000, 0), NOW).pos, 5000, 'unknown duration: keep, the element clamps');
});
test('bad repeat/shuffle values fall back to off/false', () => {
  const r = restoreQueue(JSON.stringify({ v: 1, t: NOW, qi: 0, pos: 0, sh: 'yes', rp: 'weird', q: [['yt', 'aaaaaaaaaaa', 'x', '', '', 9, '']] }), NOW);
  assert.equal(r.shuffleOn, false); assert.equal(r.repeatMode, 'off');
});
test('500+ queue: stored as a 200-song window around the current song, current song preserved', () => {
  const q = queueOf(600);
  for (const qi of [0, 10, 300, 599]) {
    const s = serializeQueue({ queue: q, qi, pos: 12 }, NOW);
    const r = restoreQueue(s, NOW);
    assert.equal(r.queue.length, MAX_TRACKS);
    assert.equal(r.queue[r.qi].key, q[qi].key, 'qi=' + qi);
  }
});
test('window keeps songs after the current one (so "next" still works)', () => {
  const q = queueOf(600); const r = restoreQueue(serializeQueue({ queue: q, qi: 300 }, NOW), NOW);
  assert.ok(r.queue.length - 1 - r.qi >= 100);
});
test('oversized payload sheds art first, then shrinks the window; stays under MAX_CHARS', () => {
  const fat = Array.from({ length: 200 }, (_, i) => ({ ...mk(i), title: 't'.repeat(200), artist: 'a'.repeat(200), album: 'b'.repeat(200) }));
  const s = serializeQueue({ queue: fat, qi: 100, pos: 1 }, NOW);
  assert.ok(s.length <= MAX_CHARS, String(s.length));
  const r = restoreQueue(s, NOW); assert.equal(r.queue[r.qi].key, fat[100].key);
});
test('serialize refuses nothing-to-save states', () => {
  assert.equal(serializeQueue({ queue: [], qi: 0 }, NOW), null);
  assert.equal(serializeQueue({ queue: queueOf(2), qi: -1 }, NOW), null);
  assert.equal(serializeQueue({ queue: queueOf(2), qi: 2 }, NOW), null);
  assert.equal(serializeQueue(null, NOW), null);
});
test('storage failures never throw: quota, disabled, throwing getItem', () => {
  const full = { setItem() { throw new DOMException('quota', 'QuotaExceededError'); }, removeItem() {}, getItem() { return null; } };
  assert.equal(saveQueue(full, { queue: queueOf(2), qi: 0 }, NOW), false);
  const dead = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(saveQueue(dead, { queue: queueOf(2), qi: 0 }, NOW), false);
  assert.equal(loadQueue(dead, NOW), null);
});
test('save then load through a storage object; empty state removes the key', () => {
  const m = new Map(); const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  assert.equal(saveQueue(st, { queue: queueOf(3), qi: 1, pos: 9 }, NOW), true);
  assert.equal(loadQueue(st, NOW).qi, 1);
  assert.equal(saveQueue(st, { queue: [], qi: 0 }, NOW), false);
  assert.equal(m.has(QKEY), false);
});
test('rows beyond the read cap are ignored and counted as dropped', () => {
  const q = Array.from({ length: 700 }, (_, i) => ['yt', String(i).padStart(11, 'a'), 's' + i, '', '', 9, '']);
  const r = restoreQueue(JSON.stringify({ v: 1, t: NOW, qi: 0, pos: 0, sh: false, rp: 'off', q }), NOW);
  assert.equal(r.queue.length, 500); assert.equal(r.dropped, 200);
});

// ---------- share / import ----------
test('encode/decode round trip keeps order and fields, incl. unicode', () => {
  const tr = [mk(1, { title: 'Beyoncé - 日本語 🎵' }), mk(2), mk(3, { src: 'sc', id: '123456' })];
  const c = encodeShare('  My   Mix  ', tr);
  assert.ok(c.startsWith('amp1:'));
  const d = decodeShare(c);
  assert.equal(d.ok, true); assert.equal(d.name, 'My Mix');
  assert.deepEqual(d.tracks.map((x) => x.key), tr.map((x) => x.key)); assert.equal(d.tracks[0].title, 'Beyoncé - 日本語 🎵');
  assert.equal(d.tracks[2].src, 'sc');
});
test('share code carries no art or stream (smaller, nothing to trust)', () => {
  const c = encodeShare('x', [mk(1)]); const raw = Buffer.from(c.slice(5).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
  assert.ok(!raw.includes('/api/apps/amp/'));
});
test('decode tolerates chat-style paste: whitespace, line breaks, quotes, surrounding text', () => {
  const c = encodeShare('p', [mk(1), mk(2)]);
  const wrapped = c.slice(0, 20) + '\n  ' + c.slice(20, 40) + ' \r\n' + c.slice(40);
  for (const t of [wrapped, '"' + c + '"', 'here you go: ' + c + ' enjoy!', '<' + c + '>', '`' + c + '`']) assert.equal(decodeShare(t).ok, true, t.slice(0, 30));
});
test('decode errors are plain and never throw', () => {
  const bad = (t) => decodeShare(t).error;
  assert.equal(bad(''), 'that is not an amp playlist code'); assert.equal(bad(undefined), 'that is not an amp playlist code');
  assert.equal(bad('amp1:'), 'that is not an amp playlist code'); assert.equal(bad('hello'), 'that is not an amp playlist code');
  assert.equal(bad('amp1:%%%'), 'that is not an amp playlist code');
  assert.equal(bad('amp1:AAAA'), 'that code is damaged');
  assert.equal(bad('amp1:' + 'A'.repeat(60001)), 'that code is too long');
  const enc = (o) => 'amp1:' + Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(bad(enc({ v: 2, n: 'x', t: [] })), 'that code came from a newer amp');
  assert.equal(bad(enc({ v: 1, n: 'x', t: 'no' })), 'that code is damaged');
  assert.equal(bad(enc({ v: 1, n: 'x', t: [] })), 'no playable songs in that code');
  assert.equal(bad(enc({ v: 1, n: 'x', t: [['yt', 'bad', 'x']] })), 'no playable songs in that code');
});
test('invalid rows dropped, duplicates collapsed, counts reported', () => {
  const enc = (o) => 'amp1:' + Buffer.from(JSON.stringify(o)).toString('base64url');
  const d = decodeShare(enc({ v: 1, n: 'x', t: [['yt', 'aaaaaaaaaaa', 'a'], ['yt', 'aaaaaaaaaaa', 'a again'], ['yt', 'bad', 'z'], 'junk', null, ['au', 'abc123', 'b']] }));
  assert.equal(d.tracks.length, 2); assert.equal(d.dropped, 3); assert.equal(d.duplicates, 1); assert.equal(d.total, 6); assert.equal(d.truncated, 0);
});
test('500+ song code is cut to the server cap of 100 and says how many were left out', () => {
  const t = Array.from({ length: 650 }, (_, i) => ['yt', String(i).padStart(11, 'a'), 's' + i, '', '', 9]);
  const d = decodeShare('amp1:' + Buffer.from(JSON.stringify({ v: 1, n: 'big', t })).toString('base64url'));
  assert.equal(d.tracks.length, MAX_SONGS); assert.equal(d.truncated, 550); assert.equal(d.tracks[0].title, 's0'); assert.equal(d.tracks[99].title, 's99');
});
test('code with more than 1000 rows only reads 1000 (rest counted as truncated)', () => {
  const t = Array.from({ length: 1200 }, (_, i) => ['yt', String(i).padStart(11, 'a'), 's' + i, '', '', 9]);
  const d = decodeShare('amp1:' + Buffer.from(JSON.stringify({ v: 1, n: 'huge', t })).toString('base64url'));
  assert.equal(d.tracks.length, 100); assert.equal(d.truncated, 900 + 200);
});
test('name is cleaned like the server: collapsed, trimmed, 40 chars, default when empty', () => {
  const enc = (n) => 'amp1:' + Buffer.from(JSON.stringify({ v: 1, n, t: [['yt', 'aaaaaaaaaaa', 'a']] })).toString('base64url');
  assert.equal(decodeShare(enc('x'.repeat(80))).name.length, 40);
  assert.equal(decodeShare(enc('   ')).name, 'imported playlist'); assert.equal(decodeShare(enc(5)).name, '5'); assert.equal(decodeShare(enc(null)).name, 'imported playlist');
});
test('encode caps at 100 songs and skips invalid ones', () => {
  const many = queueOf(150); many.splice(3, 0, { src: 'yt', id: 'bad', title: 'x' });
  assert.equal(decodeShare(encodeShare('p', many)).tracks.length, 100);
});

// ---------- importPlaylist against a fake server with the real limits ----------
function fakeApi({ lists = 0, cap = 100, failAt = [], netFailAt = [], status = {} } = {}) {
  const s = { lists, tracks: [], calls: [], netSeen: new Map() };
  const api = async (path, { body } = {}) => {
    s.calls.push(path);
    if (path.endsWith('/playlists')) {
      if (s.lists >= 20) return { ok: false, status: 400, data: { ok: false, error: 'twenty playlists is plenty - delete one first' } };
      s.lists++; return { ok: true, status: 200, data: { ok: true, playlist: { id: 'p1', name: body.name, count: 0, art: '' } } };
    }
    const n = s.tracks.length + (s.dupes || 0);
    const key = body.track.key;
    if (netFailAt.includes(key)) { const c = (s.netSeen.get(key) || 0) + 1; s.netSeen.set(key, c); if (c <= (status.netTimes ?? 1)) throw new Error('net'); }
    if (status[key]) return { ok: false, status: status[key].status, data: { ok: false, error: status[key].error } };
    if (failAt.includes(key)) return { ok: false, status: 400, data: { ok: false, error: 'that song could not be saved' } };
    if (s.tracks.some((t) => t.key === key)) return { ok: true, status: 200, data: { ok: true, already: true } };
    if (s.tracks.length >= cap) return { ok: false, status: 400, data: { ok: false, error: 'this playlist is full (100 songs)' } };
    s.tracks.push(body.track); return { ok: true, status: 200, data: { ok: true, already: false, count: s.tracks.length } };
  };
  return { api, s };
}
const dec = (n) => ({ ok: true, name: 'imp', total: n, tracks: queueOf(n) });
test('import: happy path adds every song in order, progress reported', async () => {
  const { api, s } = fakeApi(); const prog = [];
  const r = await importPlaylist(api, dec(5), { onProgress: (d, t) => prog.push([d, t]) });
  assert.deepEqual([r.ok, r.added, r.already, r.failed, r.stopped], [true, 5, 0, 0, '']);
  assert.deepEqual(s.tracks.map((x) => x.key), dec(5).tracks.map((x) => x.key)); assert.deepEqual(prog.at(-1), [5, 5]);
});
test('import: full 100-song playlist works end to end (the real maximum)', async () => {
  const { api } = fakeApi(); const r = await importPlaylist(api, dec(100));
  assert.equal(r.added, 100); assert.equal(r.stopped, '');
});
test('import: 20 playlists already -> stops at create with the server words, nothing else called', async () => {
  const { api, s } = fakeApi({ lists: 20 }); const r = await importPlaylist(api, dec(3));
  assert.deepEqual([r.ok, r.stopped, r.error], [false, 'create', 'twenty playlists is plenty - delete one first']); assert.equal(s.calls.length, 1);
});
test('import: already-saved songs count as already, not failed', async () => {
  const { api } = fakeApi(); const d = dec(3); d.tracks.push(d.tracks[0]);
  const r = await importPlaylist(api, d); assert.deepEqual([r.added, r.already, r.failed], [3, 1, 0]);
});
test('import: a refused song is skipped; three refusals in a row stop it', async () => {
  const d = dec(10); const k = d.tracks.map((t) => t.key);
  let r = await importPlaylist(fakeApi({ failAt: [k[2]] }).api, d); assert.deepEqual([r.added, r.failed, r.stopped], [9, 1, '']);
  r = await importPlaylist(fakeApi({ failAt: [k[2], k[3], k[4]] }).api, d); assert.deepEqual([r.added, r.failed, r.stopped], [2, 3, 'errors']);
  r = await importPlaylist(fakeApi({ failAt: [k[2], k[4], k[6]] }).api, d); assert.equal(r.stopped, '', 'non-consecutive failures never stop it');
});
test('import: stops on 404 gone, 413, 429 and "full", keeping what was added', async () => {
  const d = dec(6); const k = d.tracks.map((t) => t.key);
  for (const [st, err, why] of [[404, 'that playlist is gone', 'gone'], [413, 'too big', 'too-large'], [429, 'out of bandwidth', 'rate'], [400, 'this playlist is full (100 songs)', 'full']]) {
    const r = await importPlaylist(fakeApi({ status: { [k[3]]: { status: st, error: err } } }).api, d);
    assert.deepEqual([r.stopped, r.added, r.error], [why, 3, err], why);
  }
});
test('import: one network failure is retried once, two in a row count as a failed song', async () => {
  const d = dec(4); const k = d.tracks.map((t) => t.key);
  let r = await importPlaylist(fakeApi({ netFailAt: [k[1]] }).api, d); assert.deepEqual([r.added, r.failed], [4, 0]);
  r = await importPlaylist(fakeApi({ netFailAt: [k[1]], status: { netTimes: 2 } }).api, d); assert.deepEqual([r.added, r.failed], [3, 1]);
});
test('import: create throwing is reported, never thrown', async () => {
  const r = await importPlaylist(async () => { throw new Error('net'); }, dec(2));
  assert.deepEqual([r.ok, r.stopped], [false, 'create']);
});
test('import: abort stops before the next add and keeps the partial playlist', async () => {
  const ac = new AbortController(); const { api, s } = fakeApi();
  const wrapped = async (p, o) => { const r = await api(p, o); if (s.tracks.length === 2) ac.abort(); return r; };
  const r = await importPlaylist(wrapped, dec(6), { signal: ac.signal });
  assert.deepEqual([r.stopped, r.added], ['aborted', 2]);
});
test('import: sequential, one add in flight at a time', async () => {
  let live = 0, max = 0;
  const api = async (p) => { live++; max = Math.max(max, live); await new Promise((r) => setTimeout(r, 1)); live--; return p.endsWith('/playlists') ? { ok: true, status: 200, data: { playlist: { id: 'p' } } } : { ok: true, status: 200, data: { already: false } }; };
  await importPlaylist(api, dec(8)); assert.equal(max, 1);
});

// api() shape confirmed by frontend: HTTP answers {ok,status,data}; network failure {ok:false,status:0,data:{error:'no connection - check your wifi'}}; non-JSON body data:null
test('import: api network shape (status 0) is retried once, then counts as a failed song; data:null never throws', async () => {
  const d = dec(3); const k = d.tracks.map((t) => t.key); const calls = [];
  const api = async (p, o) => {
    calls.push(p);
    if (p.endsWith('/playlists')) return { ok: true, status: 200, data: { playlist: { id: 'p' } } };
    if (o.body.track.key === k[1]) return { ok: false, status: 0, data: { error: 'no connection - check your wifi' } };
    return { ok: true, status: 200, data: null };               // non-JSON success body
  };
  const r = await importPlaylist(api, d);
  assert.deepEqual([r.added, r.failed, r.stopped], [2, 1, '']);
  assert.equal(calls.filter((c) => c.endsWith('/add')).length, 4, 'k[1] tried twice, others once');
});
test('import: three status-0 failures in a row stop it with the connection message', async () => {
  const api = async (p) => p.endsWith('/playlists') ? { ok: true, status: 200, data: { playlist: { id: 'p' } } } : { ok: false, status: 0, data: { error: 'no connection - check your wifi' } };
  const r = await importPlaylist(api, dec(6));
  assert.deepEqual([r.stopped, r.failed, r.error], ['errors', 3, 'no connection - check your wifi']);
});
test('import: create returning non-JSON (data:null) is a clean failure', async () => {
  const r = await importPlaylist(async () => ({ ok: false, status: 502, data: null }), dec(2));
  assert.deepEqual([r.ok, r.stopped, r.error], [false, 'create', 'could not create the playlist']);
});

test('share names are cut by code point, not UTF-16 unit', () => {
  const name = '😀'.repeat(45);
  const d = decodeShare(encodeShare(name, [mk(1)]));
  assert.equal(Array.from(d.name).length, 40);
  assert.ok(!/[\uD800-\uDBFF]$/.test(d.name));
});
