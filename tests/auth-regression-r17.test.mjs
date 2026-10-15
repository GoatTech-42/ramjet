// r17 auth regression tests - FAIL-FIRST against r15 (auth-secret audit,
// Oct 15 2026). Each test maps to an audit finding and must FAIL on r15
// (vulnerability present) and PASS once the finding is fixed. Test-only:
// no source changes. Findings not covered here and why:
//  - F10 sage provider HTTPS guard: refusal-vs-DNS-failure is not
//    distinguishable offline without a config-validation route.
//  - F5 cookie Secure: covered as policy assertion under an https-terminator
//    header (see last test); deployment-dependent by design.
// v2 (Crystal): malformed-cookie test accepts any non-crash rejection (was:
//    exactly 400); upgrade-handler malformed-cookie coverage added for /wisp/
//    and /pws-t.
// v3 (Staples): separate fixture per upgrade path (a /wisp/ crash made the
//    shared-fixture /pws-t/ probe vacuous against a dead server); valid-SID
//    + malformed-sibling assertions on HTTP and both upgrade paths to kill
//    swallow-decode survivors (lenient per-field policy - see test comment).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import net from 'node:net';
import { withTempServer } from './fixtures/start-server.mjs';

const PW = 'regress-password-1';
const entry = (pw) => { const salt = randomBytes(16).toString('hex'); return { salt, key: scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex'), created: Date.now() }; };
const seed = (users) => (root) => writeFileSync(join(root, 'users.json'), JSON.stringify(Object.fromEntries(Object.entries(users).map(([n, pw]) => [n, entry(pw)]))));
const jpost = (base, path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function login(base, username, password = PW, headers = {}) {
  const r = await jpost(base, '/api/auth/login', { username, password }, headers);
  assert.equal(r.status, 200, `login ${username}: ${r.status}`);
  return { cookie: r.headers.get('set-cookie').split(';')[0], res: r };
}
// raw upgrade probe: resolves { got101, head } - 101 means the proxy ACCEPTED
// the upgrade; a destroyed socket means rejected.
function probeUpgrade(base, path, headers = {}) {
  const port = Number(base.split(':')[2]);
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let data = '';
    const hs = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    s.on('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${hs}\r\n`));
    s.on('data', (b) => { data += b.toString(); });
    const done = () => resolve({ got101: data.includes('101 Switching Protocols'), head: data.slice(0, 120) });
    s.on('error', () => done());
    setTimeout(() => { s.destroy(); done(); }, 2000);
  });
}

// F1: proxy tickets outlive the authority that minted them. A ticket minted
// before logout must not redeem after logout (currently: accepted, 101).
test('F1: wisp ticket minted before logout is rejected at upgrade', async () => {
  await withTempServer(seed({ tickuser: PW }), async ({ base }) => {
    const { cookie } = await login(base, 'tickuser');
    const { ticket } = await (await fetch(base + '/api/wisp-ticket', { headers: { cookie } })).json();
    await jpost(base, '/api/auth/logout', {}, { cookie });
    const p = await probeUpgrade(base, `/wisp-t/${ticket}/`);
    assert.ok(!p.got101, `ticket redeemed after logout (got 101): ${p.head}`);
  });
});

test('F1b: browse proxy ticket minted before logout is rejected at upgrade', async () => {
  await withTempServer(seed({ tickuser: PW }), async ({ base }) => {
    const { cookie } = await login(base, 'tickuser');
    const { ticket } = await (await fetch(base + '/api/wisp-ticket', { headers: { cookie } })).json();
    await jpost(base, '/api/auth/logout', {}, { cookie });
    const p = await probeUpgrade(base, `/pws-t/${ticket}/`);
    assert.ok(!p.got101, `browse ticket redeemed after logout (got 101): ${p.head}`);
  });
});

// F8: no Origin check on upgrades (cross-site WS hijack surface). A foreign
// Origin must be rejected on both ticket and cookie paths.
test('F8: upgrade with a foreign Origin is rejected', async () => {
  await withTempServer(seed({ origuser: PW }), async ({ base }) => {
    const { cookie } = await login(base, 'origuser');
    const { ticket } = await (await fetch(base + '/api/wisp-ticket', { headers: { cookie } })).json();
    const t = await probeUpgrade(base, `/wisp-t/${ticket}/`, { Origin: 'https://evil.example' });
    assert.ok(!t.got101, `foreign-Origin ticket upgrade accepted (got 101): ${t.head}`);
    const c = await probeUpgrade(base, '/wisp/', { Origin: 'https://evil.example', Cookie: cookie });
    assert.ok(!c.got101, `foreign-Origin cookie upgrade accepted (got 101): ${c.head}`);
  });
});

// F3: password change leaves existing 30-day sessions valid.
test('F3: password change revokes existing sessions', async () => {
  await withTempServer(seed({ passuser: PW }), async ({ base }) => {
    const { cookie } = await login(base, 'passuser');
    const ch = await jpost(base, '/api/auth/change-password', { current: PW, next: 'regress-password-2' }, { cookie });
    assert.equal(ch.status, 200);
    const me = await fetch(base + '/api/auth/me', { headers: { cookie } });
    assert.equal(me.status, 401, `pre-change session still valid after password change (${me.status})`);
    // the account itself still works with the new password
    await login(base, 'passuser', 'regress-password-2');
  });
});

// F4: rename bypasses the reserved/admin signup boundary. Fixture admin name
// is 'reviewer' (RJ_ADMIN); RESERVED includes 'root'.
test('F4: rename to reserved or admin names is rejected', async () => {
  await withTempServer(seed({ plainuser: PW }), async ({ base }) => {
    const { cookie } = await login(base, 'plainuser');
    const r1 = await jpost(base, '/api/auth/claim-username', { name: 'root' }, { cookie });
    assert.equal(r1.status, 400, `rename to reserved name 'root' accepted (${r1.status})`);
    const r2 = await jpost(base, '/api/auth/claim-username', { name: 'reviewer' }, { cookie });
    assert.equal(r2.status, 400, `rename to admin name accepted (${r2.status})`);
    const me = await (await fetch(base + '/api/auth/me', { headers: { cookie } })).json();
    assert.equal(me.admin, false, 'account gained name-based admin authority via rename');
  });
});

// F6: password hashes + session bearers written with ambient file modes.
test('F6: credential stores are not group/other-readable', async () => {
  const oldUmask = process.umask(0o022); // worst case: prove the code sets modes explicitly
  try {
    await withTempServer(seed({ modeuser: PW }), async ({ root, base }) => {
      await login(base, 'modeuser');
      for (const f of ['users.json', 'sessions.json']) {
        const mode = statSync(join(root, f)).mode & 0o777;
        assert.equal(mode & 0o077, 0, `${f} mode ${mode.toString(8)} is group/other-accessible`);
      }
    });
  } finally { process.umask(oldUmask); }
});

// F2: lite successful-credential cache bypasses ban/removal for 5 minutes.
test('F2: lite credentials stop working when the account is banned', async () => {
  await withTempServer(seed({ reviewer: PW, liteuser: PW }), async ({ base }) => {
    const auth = { authorization: `Bearer liteuser:${PW}` };
    const before = await fetch(base + '/api/lite/', { headers: auth });
    assert.notEqual(before.status, 401, 'valid lite credentials rejected before ban');
    const admin = await login(base, 'reviewer');
    const ban = await jpost(base, '/api/admin/ban', { name: 'liteuser' }, { cookie: admin.cookie });
    assert.equal(ban.status, 200);
    const after = await fetch(base + '/api/lite/', { headers: auth });
    assert.equal(after.status, 401, `lite accepted cached credentials after ban (${after.status})`);
  });
});

// F9: lite failed-auth lockout keyed by spoofable X-Forwarded-For. Direct
// requests must key on the socket address, so rotating XFF cannot dodge it.
test('F9: lite lockout cannot be dodged by rotating X-Forwarded-For', async () => {
  await withTempServer(seed({ reviewer: PW }), async ({ base }) => {
    for (let i = 1; i <= 10; i++) {
      const r = await fetch(base + '/api/lite/', { headers: { authorization: 'Bearer nobody:wrong-password', 'x-forwarded-for': `10.9.9.${i}` } });
      assert.equal(r.status, 401, `attempt ${i}: ${r.status}`);
    }
    const r11 = await fetch(base + '/api/lite/', { headers: { authorization: 'Bearer nobody:wrong-password', 'x-forwarded-for': '10.9.9.1' } });
    assert.equal(r11.status, 429, `11th failure from the same socket not locked out (${r11.status})`);
  });
});

// F7a: an existing weak/corrupt .urlkey-secret must fail closed, not serve.
test('F7a: a weak existing urlkey secret fails closed', async () => {
  await withTempServer((root) => { seed({ keyuser: PW })(root); writeFileSync(join(root, '.urlkey-secret'), 'weak'); }, async ({ base }) => {
    const { cookie } = await login(base, 'keyuser');
    const r = await fetch(base + '/api/apps/browse/urlkey', { headers: { cookie } });
    assert.notEqual(r.status, 200, `weak existing urlkey secret served (status ${r.status})`);
  });
});

// F7b: an existing valid-format secret with loose modes must be repaired.
test('F7b: urlkey secret file permissions are repaired on use', async () => {
  const valid = randomBytes(32).toString('hex');
  await withTempServer((root) => { seed({ keyuser: PW })(root); writeFileSync(join(root, '.urlkey-secret'), valid, { mode: 0o644 }); }, async ({ root, base }) => {
    const { cookie } = await login(base, 'keyuser');
    await fetch(base + '/api/apps/browse/urlkey', { headers: { cookie } });
    const mode = statSync(join(root, '.urlkey-secret')).mode & 0o777;
    assert.equal(mode & 0o077, 0, `.urlkey-secret mode ${mode.toString(8)} left group/other-accessible`);
  });
});

// Additional boundary (audit: util.js parseCookies before the request
// try/catch): malformed percent-encoding must not escape error handling.
// Crystal v2: do not over-specify the status - any non-crash rejection is
// acceptable; what must never happen is an unanswered connection (crash) or
// a success response to garbage.
test('malformed cookie encoding is rejected, never a crash', async () => {
  await withTempServer(seed({ cookuser: PW }), async ({ base }) => {
    let status = 0;
    try { status = (await fetch(base + '/api/auth/me', { headers: { cookie: 'x=%E0%A4%A' } })).status; }
    catch { status = -1; }
    assert.ok(status !== -1, 'malformed cookie killed the connection with no response (possible crash)');
    assert.ok(status < 200 || status >= 300, `malformed cookie produced a success response (${status})`);
    let aliveStatus = 0;
    try { aliveStatus = (await fetch(base + '/login')).status; } catch { aliveStatus = -1; }
    assert.equal(aliveStatus, 200, `server did not survive the malformed cookie (login probe: ${aliveStatus === -1 ? 'connection refused - server process dead' : aliveStatus})`);
  });
});

// Same malformed-cookie boundary on the UPGRADE handler, which calls
// parseCookies outside any try/catch on BOTH protocols (index.js ~477 pws-t
// cookie fallback, ~487 wisp-t/wisp). Rejection = socket destroyed without a
// 101; a crash = the whole server dies. Staples v3: SEPARATE fixture per
// path - a /wisp/ crash kills the server a shared-fixture /pws-t probe would
// then vacuously "reject" against.
for (const [label, path] of [['/wisp/', '/wisp/'], ['/pws-t/', '/pws-t/' + '0'.repeat(48) + '/']]) {
  test(`malformed cookie on ${label} upgrade is rejected, never a crash`, async () => {
    await withTempServer(seed({ cookuser: PW }), async ({ base }) => {
      const p = await probeUpgrade(base, path, { Cookie: 'x=%E0%A4%A' });
      assert.ok(!p.got101, `malformed-cookie ${label} upgrade accepted (101)`);
      let aliveStatus = 0;
      try { aliveStatus = (await fetch(base + '/login')).status; } catch { aliveStatus = -1; }
      assert.equal(aliveStatus, 200, `server did not survive the malformed-cookie ${label} upgrade (login probe: ${aliveStatus === -1 ? 'connection refused - server process dead' : aliveStatus})`);
    });
  });
}

// Staples v3: swallow-decode survivors. A fix that catches the decode error
// and drops ALL cookies (or the session) passes the crash tests but breaks
// real users: a VALID session cookie next to a malformed sibling must still
// authenticate. POLICY ASSUMPTION (lenient per-field): the malformed cookie
// is ignored, valid ones honored; if r17 chooses strict-reject instead, flip
// these expectations - the crash tests above hold under either policy.
test('valid session survives a malformed sibling cookie (HTTP)', async () => {
  await withTempServer(seed({ cookuser: PW }), async ({ base }) => {
    const { cookie } = await login(base, 'cookuser');
    let me = null, fetchErr = null;
    try { me = await fetch(base + '/api/auth/me', { headers: { cookie: cookie + '; x=%E0%A4%A' } }); }
    catch (e) { fetchErr = e; }
    let aliveStatus = 0;
    try { aliveStatus = (await fetch(base + '/login')).status; } catch { aliveStatus = -1; }
    assert.ok(me && me.status === 200,
      fetchErr && aliveStatus === -1
        ? 'server crashed on valid SID + malformed sibling (request dropped, process dead)'
        : `valid SID + malformed sibling not honored (${me ? me.status : fetchErr}) - swallow-decode drops the session`);
  });
});
for (const [label, path] of [['/wisp/', '/wisp/'], ['/pws-t/', '/pws-t/' + '0'.repeat(48) + '/']]) {
  test(`valid session survives a malformed sibling cookie (${label} upgrade)`, async () => {
    await withTempServer(seed({ cookuser: PW }), async ({ base }) => {
      const { cookie } = await login(base, 'cookuser');
      const p = await probeUpgrade(base, path, { Cookie: cookie + '; x=%E0%A4%A' });
      let aliveStatus = 0;
      try { aliveStatus = (await fetch(base + '/login')).status; } catch { aliveStatus = -1; }
      assert.ok(p.got101,
        aliveStatus === -1
          ? `server crashed on valid SID + malformed sibling at ${label} (no 101, process dead)`
          : `valid SID + malformed sibling rejected at ${label} - swallow-decode drops the session`);
    });
  });
}

// F5 (deployment policy): behind an https terminator, session cookies must
// carry Secure. Asserts the policy under a forwarded-proto signal.
test('F5: session cookie is Secure behind an https terminator', async () => {
  await withTempServer(seed({ secuser: PW }), async ({ base }) => {
    const r = await jpost(base, '/api/auth/login', { username: 'secuser', password: PW }, { 'x-forwarded-proto': 'https' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie') || '', /;\s*Secure/i, 'set-cookie lacks Secure behind an https terminator');
  });
});


