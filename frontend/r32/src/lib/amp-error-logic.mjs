// Reference logic for the amp client error path (paper for frontend; port into Amp.svelte or import as-is).
// Everything the browser provides is injected, so it is testable without a DOM.
// Contract (from main, 3:41 PM): whyStopped probe + a single retry on network error before skipping.

const BW = 'the streaming limit has been reached.';

// Ask the stream route why the audio element failed. Returns { kind, msg }.
//  kind 'bandwidth' : 429. msg is always the fixed house line (server text never renders). Do NOT retry, fall back or skip.
//  kind 'http'      : any other non-2xx status. Real server answer (400/502/503/416...). Not a network error.
//  kind 'ok'        : probe got 200/206. The failure was in the element, not the route.
//  kind 'network'   : fetch threw or timed out. Transient candidate.
// No response body is ever read: every branch cancels the unread 1-byte body. One deadline covers the headers.
export async function whyStopped(stream, { fetchFn, timeoutMs = 8000 } = {}) {
  // one deadline covers headers AND the 429 body: a stalled body must not leave the ui pending.
  const ac = new AbortController();
  let timer; const deadline = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error('timeout')); }, timeoutMs); });
  deadline.catch(() => {});
  try {
    let r;
    try { r = await Promise.race([fetchFn(stream, { headers: { range: 'bytes=0-0' }, credentials: 'same-origin', signal: ac.signal }), deadline]); }
    catch { return { kind: 'network', msg: '' }; }
    if (r.status === 429) {
      try { r.body?.cancel?.(); } catch {}          // the body is never read
      return { kind: 'bandwidth', msg: BW };   // house copy only: server text never renders; no retry offered here
    }
    try { r.body?.cancel?.(); } catch {}          // never leave the 1-byte body hanging
    if (r.status === 200 || r.status === 206) return { kind: 'ok', msg: '' };
    return { kind: 'http', status: r.status, msg: '' };
  } finally { clearTimeout(timer); }
}

// Decide what to do after an audio error. `s` is per-track state { retried:boolean, fellBack:boolean }.
// Returns one of: 'show-bandwidth' | 'retry' | 'fallback' | 'skip' | 'give-up'.
// Order: bandwidth beats everything; ONE retry for network or 'ok' (element hiccup) errors; then fallback copy; then skip.
export function decide(why, s, { hasAlt, canSkip }) {
  if (why.kind === 'bandwidth') return 'show-bandwidth';
  if ((why.kind === 'network' || why.kind === 'ok') && !s.retried) return 'retry';
  if (!s.fellBack && hasAlt) return 'fallback';
  if (canSkip) return 'skip';
  return 'give-up';
}

// ---- queue-level logic, mirrors Amp.svelte onTrackError (3:33 PM source) so QA goldens pin CURRENT behaviour ----
export function normTitle(t) {
  return (t || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/feat\.?.*$/, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// Other-source copy of the same song in the current list, or undefined. Same two rules as the client.
export function findAlt(sections, now) {
  const want = normTitle(now.title);
  if (!want) return undefined;   // untitled rows never match each other
  return sections.find((x) => x.src !== now.src && x.stream && normTitle(x.title) === want)
    || sections.find((x) => x.src !== now.src && x.stream && want.length >= 8 && normTitle(x.title).startsWith(want.slice(0, Math.max(8, want.length - 6))));
}
// One audio error, end to end. Pure: returns the next state and what the UI shows.
//  s = { now:{title,src,qi,__fellBack?}, sections, queue, errStreak, retried }, why = whyStopped() result.
// Returns { action, errStreak, retried, trackErr, note, altKey }.
// Order: bandwidth -> one retry (network/ok) -> other-source fallback (once per track) -> skip (streak < 3, not last) -> message.
export function handleTrackError(s, why) {
  const out = { action: '', errStreak: s.errStreak, retried: s.retried, trackErr: '', note: '', altKey: '' };
  if (why.kind === 'bandwidth') { out.action = 'show-bandwidth'; out.trackErr = why.msg; return out; }   // streak NOT bumped
  if ((why.kind === 'network' || why.kind === 'ok') && !s.retried) { out.action = 'retry'; out.retried = true; return out; }
  out.errStreak = s.errStreak + 1;
  if (!s.now.__fellBack) {
    const alt = findAlt(s.queue.concat(s.sections), s.now);   // DIV-18: queue first, then the visible list
    if (alt) {
      out.action = 'fallback'; out.altKey = alt.key; out.retried = false;
      out.note = 'playing the ' + ({ yt: 'youtube', sc: 'soundcloud', au: 'audius' }[alt.src] || alt.src) + ' copy instead';
      return out;
    }
  }
  if (out.errStreak < 3 && s.now.qi + 1 < s.queue.length) { out.action = 'skip'; out.retried = false; out.note = "this song wouldn't play, so it's been skipped."; return out; }
  out.action = 'give-up';
  out.trackErr = "this song couldn't play.";
  return out;
}
