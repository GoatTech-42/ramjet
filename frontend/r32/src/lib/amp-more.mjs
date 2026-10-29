// amp search continuation state. audius is the only source with a real cursor (au:offset);
// youtube music and soundcloud stay first-page - no verified continuation shape is held.
// the generation decides whether a late answer still belongs to the list on screen: every new
// search and every view change bumps it, so a page requested before can never land after.
// the same query re-minting the same cursor (au:12 after au:12) does not reopen the window.
export function makeMore() { return { gen: 0, cursor: null }; }
export function moreBump(m) { m.gen++; m.cursor = null; }
export function moreFirstPage(m, next) { m.cursor = (next && next.audius) || null; }
export function moreCapture(m) { return { gen: m.gen, cursor: m.cursor }; }
// what a continuation answer means for the list:
// 'stale' drop it, 'end' stop offering more with no retry (an unrecognized cursor fails
// identically on retry), 'error' offer retry (cursor kept), 'rows' append and take the next cursor.
export function moreApply(m, cap, status, data) {
  if (m.gen !== cap.gen || !cap.cursor) return { type: 'stale' };
  if (status === 400) { m.cursor = null; return { type: 'end' }; }
  if (status !== 200) return { type: 'error' };
  const rows = (data && data.results && data.results.audius) || [];
  m.cursor = (data && data.next && data.next.audius) || null;
  return { type: 'rows', rows };
}
