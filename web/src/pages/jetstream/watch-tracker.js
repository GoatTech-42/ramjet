// Active-play watch tracker. Replaces "max currentTime reached", which a
// looping short never raises past its duration and which counts a seek to the
// end as a full watch.
// sample(): from timeupdate while playing. A forward step only counts if it fits
//   in the wall time that passed (+tol). A wrap end->start counts as a loop only
//   if the distance travelled across the wrap also fits in the wall time, so a
//   user seeking from the end to the start earns nothing.
// seek(): from the 'seeking' event. Re-anchors with no credit, unless the
//   position change is itself a natural loop wrap (browsers may fire seeking
//   for loop=true playback).
// pause(): paused / waiting / hidden. The next sample only re-anchors.
// total() is cumulative active seconds and can exceed the duration.
export function createWatchTracker({ tol = 0.35, maxStep = 2.5 } = {}) {
  let prev = null, sum = 0, loops = 0;
  const wrapCredit = (t, nowMs, dur) => {
    if (!prev || !(dur > 0) || t >= prev.t) return -1;
    const el = Math.max(0, (nowMs - prev.now) / 1000);
    const dist = Math.max(dur - prev.t, 0) + t;
    return dist <= Math.min(el + tol + 0.25, maxStep + 0.25) ? dist : -1;
  };
  return {
    sample(t, nowMs, dur = 0) {
      if (!Number.isFinite(t)) return;
      if (prev) {
        const d = t - prev.t;
        const el = Math.max(0, (nowMs - prev.now) / 1000);
        const cap = Math.min(el + tol, maxStep);
        if (d > 0) { if (d <= cap) sum += d; }
        else if (d < 0) { const w = wrapCredit(t, nowMs, dur); if (w >= 0) { loops++; sum += Math.min(w, cap); } }
      }
      prev = { t, now: nowMs };
    },
    seek(t, nowMs, dur = 0) {
      if (!Number.isFinite(t)) { prev = null; return; }
      const w = wrapCredit(t, nowMs, dur);
      if (w >= 0) { loops++; sum += Math.min(w, Math.min((nowMs - prev.now) / 1000 + tol, maxStep)); }
      prev = { t, now: nowMs };
    },
    pause() { prev = null; },
    total() { return sum; },
    loops() { return loops; },
  };
}
