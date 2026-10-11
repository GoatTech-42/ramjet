// pure parsers for InnerTube search responses (no I/O) so paging is testable.
// parseSearch works on ANDROID and WEB renderers alike.
export function parseSearch(data, cap = 20) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const v = node.videoRenderer || node.compactVideoRenderer;
    if (v) {
      const text = (t) => (t?.runs ? t.runs.map((r) => r.text).join('') : t?.simpleText) || '';
      if (v.videoId && text(v.title) && text(v.lengthText)) { // no length = live or upcoming: not playable here
        const byline = v.ownerText || v.longBylineText || v.shortBylineText;
        let channelId = '';
        try { channelId = byline?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || ''; } catch {}
        out.push({
          id: v.videoId,
          title: text(v.title),
          channel: text(byline),
          channelId,
          duration: text(v.lengthText),
          views: text(v.viewCountText),
          published: text(v.publishedTimeText),
          desc: text(v.descriptionSnippet),
        });
      }
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  const seen = new Set();
  return out.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true))).slice(0, cap);
}

// the continuation token for the RESULT LIST only. WEB search puts it as the
// trailing continuationItemRenderer of the result section list (first page:
// primaryContents.sectionListRenderer.contents; later pages:
// onResponseReceivedCommands[].appendContinuationItemsAction.continuationItems).
// continuation renderers elsewhere (engagement panels, per-item menus,
// chips) are ignored. no match = null, never a guess.
export function searchToken(data) {
  const lists = [];
  const first = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
  if (Array.isArray(first)) lists.push(first);
  for (const cmd of data?.onResponseReceivedCommands || []) {
    const items = cmd?.appendContinuationItemsAction?.continuationItems;
    if (Array.isArray(items)) lists.push(items);
  }
  let tok = null;
  for (const list of lists) {
    for (const el of list) {
      const t = el?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (typeof t === 'string' && t) tok = t;
    }
  }
  return tok;
}
