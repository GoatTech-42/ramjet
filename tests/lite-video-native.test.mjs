import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Native fixtures: real liteHop range downloads + real `nice ffmpeg` remux
// against locally generated/served media. No mocks in the download path.
const root = mkdtempSync(join(tmpdir(), 'rj-native-'));
process.env.RJ_DATA = join(root, 'data');
process.env.RJ_TEST_HOOKS = '1'; // loopback fixture server + limits hook
const { liteApi } = await import('../core/addons/jetstream/index.js');

const vPath = join(root, 'v.mp4'), aPath = join(root, 'a.m4a');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=176x144:rate=5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', vPath]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-vn', '-c:a', 'aac', aPath]);
const pvPath = join(root, 'pv.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=144x176:rate=5', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', pvPath]);
const badAPath = join(root, 'a_bad.m4a');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-vn', '-c:a', 'mp3', '-f', 'mp4', badAPath]);
const media = { '/v.mp4': readFileSync(vPath), '/a.m4a': readFileSync(aPath), '/a_bad.m4a': readFileSync(badAPath), '/pv.mp4': readFileSync(pvPath) };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/redir/')) {
    const n = Number(u.pathname.split('/')[2]);
    res.writeHead(302, { location: '/redir/' + (n + 1) });
    return res.end();
  }
  const evil = u.pathname.startsWith('/evil-');
  const body = media[u.pathname] || ((evil || u.pathname === '/trickle.mp4') ? media['/v.mp4'] : null);
  if (!body) { res.writeHead(404); return res.end(); }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { 'content-length': body.length }); return res.end(body); }
  const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
  if (u.pathname === '/evil-probe.mp4' && end === 0) { // probe lies about the 0-0 interval
    res.writeHead(206, { 'content-range': 'bytes 0-1/' + body.length, 'content-length': 2 });
    return res.end(body.subarray(0, 2));
  }
  if (end === 0) { // probe: always honest
    res.writeHead(206, { 'content-range': 'bytes 0-0/' + body.length, 'content-length': 1 });
    return res.end(body.subarray(0, 1));
  }
  if (u.pathname === '/trickle.mp4') { // correct range line, body drips a byte every 10ms
    res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + body.length, 'content-length': end - start + 1 });
    let i = start;
    const iv = setInterval(() => {
      if (i > end) { clearInterval(iv); return res.end(); }
      try { res.write(body.subarray(i, i + 1)); } catch { clearInterval(iv); }
      i++;
    }, 10);
    res.on('close', () => clearInterval(iv));
    return;
  }
  if (u.pathname === '/evil-zero.mp4') { // correct range line, empty body
    res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + body.length, 'content-length': 0 });
    return res.end();
  }
  if (u.pathname === '/evil-oversize.mp4') { // matching range line, body double the interval
    const want = end - start + 1;
    res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + body.length, 'content-length': want * 2 });
    const big = Buffer.concat([body.subarray(start, end + 1), body.subarray(0, want)]);
    return res.end(big);
  }
  if (u.pathname === '/evil-badstart.mp4') {
    res.writeHead(206, { 'content-range': 'bytes ' + (start + 1) + '-' + end + '/' + body.length, 'content-length': end - start });
    return res.end(body.subarray(start + 1, end + 1));
  }
  if (u.pathname === '/evil-badtotal.mp4') {
    res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + (body.length + 1), 'content-length': end - start + 1 });
    return res.end(body.subarray(start, end + 1));
  }
  res.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + body.length, 'content-length': end - start + 1 });
  res.end(body.subarray(start, end + 1));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const vsize = statSync(vPath).size, asize = statSync(aPath).size;
const entry = (vUrl) => ({ duration: 1, lite: { v: [{ h: 360, fps: 30, url: vUrl, size: vsize, tbr: 0 }], a: [{ abr: 128, url: base + '/a.m4a', size: asize }] } });
let prevLimits = null;

test.after(() => new Promise((r) => server.close(r)).then(() => { rmSync(root, { recursive: true, force: true }); }));

test('native mux over the byte cap is rejected after the remux, under it succeeds', async () => {
  const prev = liteApi.setLiteLimits(Math.max(vsize, asize) + 256);
  await assert.rejects(liteApi.makeVideo('nativecap001', 360, entry(base + '/v.mp4')), /too big/);
  liteApi.setLiteLimits(prev.maxBytes, prev.maxSecs, prev.deadlineMs);
  const out = await liteApi.makeVideo('nativecap002', 360, entry(base + '/v.mp4'));
  assert.ok(existsSync(out) && statSync(out).size > 0, 'real remux produced a playable file under the cap');
  const probe = String(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out]));
  assert.ok(probe.includes('video') && probe.includes('audio'), 'muxed file carries both streams');
});

test('liteHop: chunk larger than the requested interval is rejected before write', async () => {
  await assert.rejects(liteApi.makeVideo('nativeevil1', 360, entry(base + '/evil-oversize.mp4')), /too big/);
});

test('liteHop: content-range start mismatch is rejected', async () => {
  await assert.rejects(liteApi.makeVideo('nativeevil2', 360, entry(base + '/evil-badstart.mp4')), /bad content-range/);
});

test('liteHop: content-range total mismatch is rejected', async () => {
  await assert.rejects(liteApi.makeVideo('nativeevil3', 360, entry(base + '/evil-badtotal.mp4')), /bad content-range/);
});

test('liteHop: zero-byte 206 fails instead of looping forever', async () => {
  await assert.rejects(liteApi.makeVideo('nativeevil4', 360, entry(base + '/evil-zero.mp4')), /chunk failed/);
});

test('liteHop: redirect chains beyond five hops are rejected', async () => {
  await assert.rejects(liteApi.makeVideo('nativeevil5', 360, entry(base + '/redir/0')), /too many redirects/);
});

test('liteHop: a bounded total deadline aborts the download', async () => {
  const prev = liteApi.setLiteLimits(undefined, undefined, 1);
  await assert.rejects(liteApi.makeVideo('nativeevil6', 360, entry(base + '/v.mp4')), /download deadline/);
  liteApi.setLiteLimits(prev.maxBytes, prev.maxSecs, prev.deadlineMs);
});

test('liteHop: one wall deadline aborts a trickling body (repro: 30ms deadline once finished at 217ms)', async () => {
  const prev = liteApi.setLiteLimits(undefined, undefined, 200);
  await assert.rejects(liteApi.makeVideo('nativetrickle1', 360, entry(base + '/trickle.mp4')), /download deadline/);
  liteApi.setLiteLimits(prev.maxBytes, prev.maxSecs, prev.deadlineMs);
});

test('liteHop: a probe lying about the requested 0-0 interval is rejected', async () => {
  await assert.rejects(liteApi.makeVideo('nativeprobe1', 360, entry(base + '/evil-probe.mp4')), /probe 206/);
});

test('lite cache: a pre-fix file under the old id+q key is invalidated, never served', async () => {
  const legacy = join(process.env.RJ_DATA, 'stream-cache', 'nativecache1.lite360');
  writeFileSync(legacy, 'garbage');
  const out = await liteApi.makeVideo('nativecache1', 360, entry(base + '/v.mp4'));
  assert.ok(out.endsWith('.lite2-360'), 'new versioned cache key');
  assert.ok(!existsSync(legacy), 'legacy pre-fix file removed');
  const probe = String(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out]));
  assert.ok(probe.includes('h264') && probe.includes('aac'), 'served bytes are a real mux, not the stale file');
});

test('mux: pulled "m4a" audio that is not really aac is rejected by post ffprobe', async () => {
  const badAsize = statSync(badAPath).size;
  const badEntry = { duration: 1, lite: { v: [{ h: 360, fps: 30, url: base + '/v.mp4', size: vsize, tbr: 0 }], a: [{ abr: 128, url: base + '/a_bad.m4a', size: badAsize }] } };
  await assert.rejects(liteApi.makeVideo('nativebadaudio1', 360, badEntry), /probe: audio not aac/);
});

test('mux: portrait video is measured by its short side, like the resolver (720x1280 fits q720)', async () => {
  const pvsize = statSync(pvPath).size;
  const pEntry = { duration: 1, lite: { v: [{ h: 144, fps: 30, url: base + '/pv.mp4', size: pvsize, tbr: 0 }], a: [{ abr: 128, url: base + '/a.m4a', size: asize }] } };
  const out = await liteApi.makeVideo('nativeportrait1', 144, pEntry);
  assert.ok(existsSync(out) && statSync(out).size > 0, 'portrait short-side 144 passes at q144');
});
