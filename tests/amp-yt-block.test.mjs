// ytBlock fetches each 1MB audio block from googlevideo exactly once and
// caches it. these tests pin the failure handling of that single read:
// a null fetch (transient), an error page (403 html must never be cached
// as audio - it decodes as garbage and kills playback at the block
// boundary), and a truncated body all count as failed attempts that fall
// through to the re-resolve, never as data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ampInternals } from '../core/addons/amp/index.js';

const { ytBlock } = ampInternals;

const realFetch = globalThis.fetch;

// one scripted fetch: calls[i] describes the i-th response
function stubFetch(calls) {
  let n = 0;
  globalThis.fetch = async () => {
    const spec = calls[Math.min(n++, calls.length - 1)];
    if (spec === 'null') throw new Error('socket hang up');
    if (spec === 403) {
      return new Response('<html>403 forbidden</html>', { status: 403, headers: { 'content-type': 'text/html' } });
    }
    if (spec === 'truncated') {
      // declares a full block, dies with half of it
      const half = Buffer.alloc((1 << 20) / 2, 7);
      return new Response(half, {
        status: 206,
        headers: { 'content-length': String(1 << 20), 'content-range': `bytes 0-${(1 << 20) - 1}/${4 << 20}` },
      });
    }
    // good 206: 1KB block standing in for 1MB (spec.n bytes of spec.fill)
    const body = Buffer.alloc(spec.n, spec.fill ?? 1);
    return new Response(body, {
      status: 206,
      headers: { 'content-length': String(spec.n), 'content-range': `bytes 0-${spec.n - 1}/${spec.n}` },
    });
  };
  return () => { globalThis.fetch = realFetch; };
}

const resolver = async () => 'https://googlevideo.test/videoplayback?sig=fake';
let seq = 0;
const uid = () => 't' + String(seq++).padStart(10, '0');

test('transient null fetch on attempt 1 retries and returns the block', async () => {
  const un = stubFetch(['null', { n: 1024, fill: 3 }]);
  const id = uid();
  const buf = await ytBlock(id, 0, resolver);
  assert.equal(buf.length, 1024);
  assert.equal(buf[0], 3);
  un();
});

test('a 403 error page is never cached as audio; attempt 2 succeeds', async () => {
  const un = stubFetch([403, { n: 2048, fill: 9 }]);
  const id = uid();
  const buf = await ytBlock(id, 0, resolver);
  assert.equal(buf.length, 2048);
  assert.equal(buf[0], 9);
  un();
});

test('all attempts failing marks the track failed and throws honestly', async () => {
  const un = stubFetch([403, 403]);
  const id = uid();
  await assert.rejects(() => ytBlock(id, 0, resolver), /yt throttled/);
  // and the failure sticks: a later ask rejects without refetching
  await assert.rejects(() => ytBlock(id, 0, resolver), /yt throttled/);
  un();
});

test('a truncated body (content-length lie) is a failed attempt, not data', async () => {
  const un = stubFetch(['truncated', { n: 1024, fill: 5 }]);
  const id = uid();
  const buf = await ytBlock(id, 0, resolver);
  assert.equal(buf.length, 1024);
  assert.equal(buf[0], 5);
  un();
});
