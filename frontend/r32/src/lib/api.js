export async function api(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-ramjet-js': '1' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'no connection - check your wifi' } };
  }
}

// one mapper for failed api() results: server error envelopes never reach the screen except the 429 limit copy.
// `fallback` is the caller's reviewed line for its own action; unknown failures get the generic line.
export function errCopy(r, fallback) {
  const st = r && r.status;
  if (st === 0) return 'no connection. check your network.';
  if (st === 429) return 'slow down a bit.'; // fixed copy: server text never renders
  if (st === 403) return "this device can't do that";
  if (st === 401) return 'your session ended. sign in again.';
  if (st === 404) return "that isn't there anymore.";
  if (st === 501) return "this part isn't ready yet.";
  return fallback || 'something went wrong. try again.';
}
