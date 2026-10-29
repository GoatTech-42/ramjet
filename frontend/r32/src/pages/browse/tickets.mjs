// media-bridge tickets are single-use: the backend reserves a ticket on first connect and consumes
// it on upgrade. the probe burns ticket 1, so the transport must mint its own - and a failed mint
// fails closed, because the backend rejects an unticketed or burned ticket anyway and falling back
// only hides the real error behind a confusing "connection refused".
export async function mintTicketUrl(fetchImpl, bridgeBase, ab) {
  let r;
  try {
    r = await fetchImpl('/api/media-bridge/ticket' + (ab ? '' : '?ab=0'), { method: 'POST', headers: { 'X-Ramjet-JS': '1' } });
  } catch {
    return { fail: "the tunnel couldn't be reserved - check your connection and reload" };
  }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return { fail: 'your session ended. sign in again.', noRetry: r.status === 401 };
  if (j && j.ticket) return { url: bridgeBase + j.ticket + '/' };
  return { fail: "the tunnel couldn't be reserved - reload to try again" };
}
