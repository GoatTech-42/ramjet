import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestUrl, engineFor, classifyFatal, attachBridgeHls } from './jetstream-hls.mjs';

// a dom-free video element: event registry + the calls the wrapper may make
function fakeVideo({ nativeHls = false } = {}) {
  const listeners = {};
  return {
    src: '', currentTime: 0,
    canPlayType: (t) => (nativeHls && t === 'application/vnd.apple.mpegurl' ? 'maybe' : ''),
    addEventListener: (n, f) => { (listeners[n] ||= []).push(f); },
    removeEventListener: (n, f) => { listeners[n] = (listeners[n] || []).filter((x) => x !== f); },
    removeAttribute() { this.src = ''; },
    load() { this.loaded = (this.loaded || 0) + 1; },
    fire(n) { (listeners[n] || []).slice().forEach((f) => f()); },
    count(n) { return (listeners[n] || []).length; },
  };
}

// a dom-free hls.js: statics + the exact methods/events the wrapper uses
function fakeHlsClass(log) {
  return class FakeHls {
    static Events = { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
    static isSupported() { return true; }
    static instances = [];
    constructor(cfg) { this.cfg = cfg; this.handlers = {}; FakeHls.instances.push(this); log.push(['new', cfg]); }
    on(ev, f) { (this.handlers[ev] ||= []).push(f); }
    loadSource(src) { log.push(['loadSource', src]); this.src = src; }
    attachMedia(v) { log.push(['attachMedia', v === undefined ? 'missing' : 'video']); }
    destroy() { log.push(['destroy']); this.destroyed = true; }
    emit(ev, data) { (this.handlers[ev] || []).forEach((f) => f(ev, data)); }
  };
}

test('manifestUrl pins the bridge entry contract', () => {
  assert.equal(manifestUrl('abcDEF12345'), '/api/apps/jetstream/manifest?id=abcDEF12345&kind=hls');
  assert.equal(manifestUrl('abcDEF12345', 'dash'), '/api/apps/jetstream/manifest?id=abcDEF12345&kind=dash');
  assert.equal(manifestUrl('a b'), '/api/apps/jetstream/manifest?id=a%20b&kind=hls');
  assert.throws(() => manifestUrl('x', 'mp4'), RangeError);
});

test('engineFor matrix', () => {
  assert.equal(engineFor({ nativeHls: true, mse: true }), 'native'); // safari: native wins, no hls.js boot
  assert.equal(engineFor({ nativeHls: false, mse: true }), 'mse');
  assert.equal(engineFor({ nativeHls: false, mse: false }), null);
  assert.equal(engineFor({}), null);
});

test('classifyFatal: non-fatal stays internal to hls.js', () => {
  assert.equal(classifyFatal({ fatal: false, type: 'mediaError' }), null);
  assert.equal(classifyFatal(null), null);
  assert.equal(classifyFatal({}), null);
});

test('classifyFatal: 404 is unavailable, not an error', () => {
  assert.deepEqual(classifyFatal({ fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 404 } }), { kind: 'unavailable', status: 404 });
});

test('classifyFatal: drm/auth/network/error shapes', () => {
  assert.deepEqual(classifyFatal({ fatal: true, type: 'networkError', response: { code: 451 } }), { kind: 'drm', status: 451 });
  assert.deepEqual(classifyFatal({ fatal: true, type: 'networkError', response: { code: 401 } }), { kind: 'auth', status: 401 });
  assert.deepEqual(classifyFatal({ fatal: true, type: 'networkError', response: { code: 502 } }), { kind: 'network', status: 502 });
  assert.deepEqual(classifyFatal({ fatal: true, type: 'mediaError', details: 'bufferAppendError' }), { kind: 'error', status: 0, details: 'bufferAppendError' });
});

test('native path: src set to the bridge url, error reaches onFatal once, teardown unbinds', () => {
  const v = fakeVideo({ nativeHls: true });
  const fatal = []; const ready = [];
  const h = attachBridgeHls({ video: v, id: 'abcDEF12345', Hls: fakeHlsClass([]), onFatal: (r) => fatal.push(r), onReady: (e) => ready.push(e) });
  assert.equal(h.engine, 'native');
  assert.equal(v.src, '/api/apps/jetstream/manifest?id=abcDEF12345&kind=hls');
  v.fire('loadedmetadata');
  assert.deepEqual(ready, ['native']);
  v.fire('error'); v.fire('error');
  assert.equal(fatal.length, 1);
  assert.equal(v.src, ''); // torn down before the caller's fallback
  assert.equal(v.count('error'), 0); // listeners unbound: a stale error can never fire twice
});

test('mse path: loadSource gets the bridge url, manifest parsed -> ready, fatal -> destroy then onFatal', () => {
  const log = [];
  const Hls = fakeHlsClass(log);
  const v = fakeVideo();
  const fatal = []; const ready = [];
  const h = attachBridgeHls({ video: v, id: 'vid00000001', Hls, onFatal: (r) => fatal.push(r), onReady: (e) => ready.push(e), startAt: 42 });
  assert.equal(h.engine, 'mse');
  assert.deepEqual(log[1], ['loadSource', '/api/apps/jetstream/manifest?id=vid00000001&kind=hls']);
  assert.deepEqual(log[2], ['attachMedia', 'video']);
  const inst = Hls.instances[0];
  inst.emit('hlsError', { fatal: false, type: 'mediaError' }); // non-fatal stays with hls.js
  assert.equal(fatal.length, 0);
  inst.emit('hlsManifestParsed');
  assert.deepEqual(ready, ['mse']);
  assert.equal(v.currentTime, 42); // mid-playback recovery position restored
  inst.emit('hlsError', { fatal: true, type: 'networkError', response: { code: 404 } });
  assert.deepEqual(fatal, [{ kind: 'unavailable', status: 404 }]);
  assert.ok(log.some((e) => e[0] === 'destroy'), 'hls.js instance destroyed before onFatal');
  inst.emit('hlsError', { fatal: true, type: 'networkError', response: { code: 502 } });
  assert.equal(fatal.length, 1, 'onFatal fires once');
});

test('no engine -> null handle, no side effects', () => {
  const v = fakeVideo();
  class NoMse { static isSupported() { return false; } }
  assert.equal(attachBridgeHls({ video: v, id: 'x', Hls: NoMse }), null);
  assert.equal(v.src, '');
});

test('sequence: hls 404 then caller fallback runs the old ladder exactly once', () => {
  const log = [];
  const Hls = fakeHlsClass(log);
  const v = fakeVideo();
  const ladder = [];
  const handle = attachBridgeHls({
    video: v, id: 'vid00000002', Hls,
    onFatal: (r) => { ladder.push('fallback:' + r.kind); },
  });
  Hls.instances[0].emit('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code: 404 } });
  assert.deepEqual(ladder, ['fallback:unavailable']);
  assert.ok(handle.destroyed !== true); // handle object itself is caller-facing; the inner hls.js instance was destroyed
  assert.ok(log.some((e) => e[0] === 'destroy'));
});
