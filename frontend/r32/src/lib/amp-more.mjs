// amp search continuation state. audius is the only source with a real cursor (au:offset);
// youtube music and soundcloud stay first-page - no verified continuation shape is held.
// the generation decides whether a late answer still belongs to the list on screen: every new
// search and every view change bumps it, so a page requested before can never land after.
// the same query re-minting the same cursor (au:12 after au:12) does not reopen the window.
// automatic viewport-fill has a per-search page budget; manual scrolling past it still loads more.
export const AUTO_PAGE_BUDGET = 3;
export function makeMore() { return { gen: 0, cursor: null, auto: 0 }; }
export function moreBump(m) { m.gen++; m.cursor = null; m.auto = 0; }
export function moreAutoOk(m) { return m.auto < AUTO_PAGE_BUDGET; }
export function moreAutoSpend(m) { m.auto++; }
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
