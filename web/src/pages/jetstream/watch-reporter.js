// Per-video cumulative watch reporting. Keyed by video id (not slide index, so a
// list swap can't mix videos). Every post carries the cumulative total and a
// monotonic seq (the server ignores older seqs, so a late beacon can't overwrite
// a newer post). A total only counts as sent once the post is acknowledged: a
// failed fetch or a sendBeacon that returned false stays pending and retries on
// the next report. post(body, beacon) returns boolean | Promise<boolean>.
import { createWatchTracker } from './watch-tracker.js';
export function createWatchReporter(post, { keep = 60, clock = Date.now } = {}) {
  const m = new Map();
  let lastSeq = 0;
  const ent = (v) => {
    let e = m.get(v.id);
    if (!e) { e = { v, tr: createWatchTracker(), acked: -1, inflight: -1, body: null }; m.set(v.id, e); if (m.size > keep) { const k = m.keys().next().value; m.delete(k); } }
    return e;
  };
  const send = (e, beacon) => {
    const ws = Math.round(e.tr.total());
    if (ws <= e.acked) return;                        // already delivered
    if (ws === e.inflight) {                          // this exact total is already on its way
      // ...but a fetch can die with the page: at unload, also queue a beacon with the SAME body (same seq)
      if (beacon && e.body) { try { post(e.body, true); } catch {} }
      return;
    }
    e.inflight = ws;
    lastSeq = Math.max(clock(), lastSeq + 1);
    const body = { id: e.v.id, title: e.v.title || '', channel: e.v.channel || '', duration: e.v.duration || '', watched: ws, seq: lastSeq };
    e.body = body;
    const done = (ok) => { if (e.inflight === ws) e.inflight = -1; if (ok && ws > e.acked) e.acked = ws; };
    let r;
    try { r = post(body, !!beacon); } catch { r = false; }
    if (r && typeof r.then === 'function') return r.then((ok) => done(!!ok), () => done(false));
    done(r !== false);
  };
  return {
    sample(v, t, now, dur) { ent(v).tr.sample(t, now, dur); },
    seek(v, t, now, dur) { if (m.has(v.id)) m.get(v.id).tr.seek(t, now, dur); },
    pause(v) { m.get(v?.id)?.tr.pause(); },
    pauseAll() { for (const e of m.values()) e.tr.pause(); },
    report(v, beacon) { const e = m.get(v?.id); if (e) return send(e, beacon); },
    flushAll(beacon) { for (const e of m.values()) send(e, beacon); },
    total(v) { return m.get(v.id)?.tr.total() || 0; },
  };
}
