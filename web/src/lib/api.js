// a 401 outside the auth endpoints means the session died under the tab
// (revoked, banned, password changed): bounce to login instead of leaving
// the app silently broken. auth endpoints are excluded - a wrong password
// is a 401 the login page renders itself.
export function shouldBounceToLogin(path, status) {
  return status === 401 && !String(path).startsWith('/api/auth/');
}

// for the places that must use raw fetch (streams, one-shot tickets):
// same rule as api(), without wrapping the whole call
export function bounceToLoginOn401(path, status) {
  if (shouldBounceToLogin(path, status)) { try { window.location.href = '/login'; } catch {} }
}

export async function api(path, { method = 'GET', body } = {}) {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    bounceToLoginOn401(path, res.status);
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'no connection - check your wifi' } };
  }
}
