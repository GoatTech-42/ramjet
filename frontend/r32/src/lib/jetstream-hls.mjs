// jetstream hls playback through the media bridge (the reviewed v5 manifest/seg
// routes). the bridge rewrites every upstream url server-side, so this consumer
// only ever hands one same-origin url to the player engine: no googlevideo url
// reaches this file, and there is nothing to re-encode or proxy here.
// everything browser-shaped is injected, so the logic runs under node:test.

// the single entry point. kind is pinned to the route's accepted values; with
// no u= the backend resolves the upstream manifest for the id itself (cached,
// 404 "no such stream" when the video has none).
export function manifestUrl(id, kind = 'hls') {
  if (kind !== 'hls' && kind !== 'dash') throw new RangeError('bad kind');
  return `/api/apps/jetstream/manifest?id=${encodeURIComponent(id)}&kind=${kind}`;
}

// which engine can play hls here: safari's native stack, or any mse browser via
// hls.js. both capabilities are injected predicates so the decision is testable.
export function engineFor({ nativeHls = false, mse = false } = {}) {
  if (nativeHls) return 'native';
  if (mse) return 'mse';
  return null;
}

// hls.js error data -> what the caller should do. only fatal errors arrive here
// (hls.js recovers non-fatal ones itself). a 404 on the manifest fetch means
// this video simply has no hls: that is 'unavailable', not a failure, and it
// must not count as a playback error. 451 is the bridge failing closed on drm.
export function classifyFatal(data) {
  if (!data || data.fatal !== true) return null;
  const code = data.response?.code ?? data.response?.status ?? 0;
  if (code === 404) return { kind: 'unavailable', status: 404 };
  if (code === 451) return { kind: 'drm', status: 451 };
  if (code === 401 || code === 403) return { kind: 'auth', status: code };
  if (data.type === 'networkError') return { kind: 'network', status: code }; // hls.js ErrorTypes.NETWORK_ERROR
  return { kind: 'error', status: code, details: String(data.details || '') };
}

// attach one video element to the bridge manifest. returns a handle with
// destroy(); onFatal(reason) runs at most once, and only after the handle has
// torn itself down, so the caller can fall straight back to its old ladder.
// onReady(engine) runs once the manifest is actually parsed (mse) or metadata
// is loaded (native). startAt restores position for mid-playback recovery.
// Hls is the hls.js default export, injected: this module never imports the
// library, so node tests need no browser dependency.
export function attachBridgeHls({ video, id, Hls = null, onFatal = () => {}, onReady = () => {}, startAt = 0 }) {
  const engine = engineFor({
    nativeHls: (() => { try { return !!video.canPlayType?.('application/vnd.apple.mpegurl'); } catch { return false; } })(),
    mse: (() => { try { return !!Hls?.isSupported?.(); } catch { return false; } })(),
  });
  if (!engine) return null;
  const src = manifestUrl(id, 'hls');
  let done = false;
  let hls = null;
  const fail = (reason) => {
    if (done) return;
    done = true;
    handle.destroy();
    onFatal(reason);
  };
  const seekOnce = () => { if (startAt > 0) { try { video.currentTime = startAt; } catch {} } };
  const handle = {
    engine,
    src,
    destroy() {
      if (hls) { try { hls.destroy(); } catch {} hls = null; }
      else { try { video.removeAttribute('src'); video.load?.(); } catch {} }
    },
  };
  if (engine === 'native') {
    const onErr = () => fail({ kind: 'error', status: 0, details: 'native hls element error' });
    const onMeta = () => { if (!done) { seekOnce(); onReady('native'); } };
    video.addEventListener('error', onErr, { once: true });
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    const baseDestroy = handle.destroy;
    handle.destroy = () => {
      video.removeEventListener('error', onErr);
      video.removeEventListener('loadedmetadata', onMeta);
      baseDestroy();
    };
    video.src = src;
    video.load?.();
    return handle;
  }
  hls = new Hls({}); // hls.js defaults: its own non-fatal retry/recovery stays on
  hls.on(Hls.Events.ERROR, (_ev, data) => {
    const c = classifyFatal(data);
    if (c) fail(c);
  });
  hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!done) { seekOnce(); onReady('mse'); } });
  hls.loadSource(src);
  hls.attachMedia(video);
  return handle;
}

// one adaptive attempt per video. the hd pair's two halves can fail within
// milliseconds of each other (a filtered network kills both): the first
// failure starts the attempt, and a second while it is still starting must
// WAIT for it - dropping to 360p there cancels the very attempt that could
// avoid it. once the attempt has settled (playing, or failed into the old
// ladder), a later failure falls back as before.
export function attemptGate(st, id) {
  if (st.triedFor !== id) return { action: 'start' };
  if (st.inFlight) return { action: 'wait' };
  return { action: 'fallback' };
}
