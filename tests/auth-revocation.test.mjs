// r17 auth/secret audit (ramjet-r15-auth-secret-audit): revocation must be
// real. a proxy ticket, a lite credential cache entry, a session cookie or a
// live upgrade must not outlive the authority that minted them (logout, ban,
// removal, password change), and the rename path must enforce the same
// reserved/authority boundary as signup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { once } from 'node:events';
import net from 'node:net';
import { writeFileSync, chmodSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempServer } from './fixtures/start-server.mjs';
import { Auth } from '../core/auth.js';

const PASS = 'fixture-password';
const seed = (...names) => (root) => { const a = new Auth(root); for (const n of names) a.createUser(n, PASS); };
const loginCookie = async (base, user) => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: PASS }) });
  assert.equal(r.status, 200, 'login ' + user);
  return r.headers.get('set-cookie').split(';')[0];
};
const mintTicket = async (base, cookie) => {
  const r = await fetch(base + '/api/wisp-ticket', { headers: { cookie } });
  assert.equal(r.status, 200);
  return (await r.json()).ticket;
};
const tryUpgrade = (base, ticket, cookie, route = 'wisp-t', origin) => new Promise((resolve) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const ws = new WebSocket(base.replace('http', 'ws') + '/' + route + '/' + (ticket || '') + '/', { headers });
  const done = (ok) => { try { ws.terminate(); } catch {} resolve(ok); };
  const t = setTimeout(() => done(false), 5000);
  ws.on('open', () => { clearTimeout(t); done(true); });
  ws.on('error', () => { clearTimeout(t); done(false); });
  ws.on('unexpected-response', () => { clearTimeout(t); done(false); });
});
const liteHealth = (base, user, pass) =>
  fetch(base + '/api/lite/health', { headers: { authorization: 'Basic ' + Buffer.from(user + ':' + pass).toString('base64') } });

test('tickets die with the authority that minted them (ban, logout, password change)', async () => {
  await withTempServer(seed('reviewer', 'second'), async ({ base }) => {
    const admin = await loginCookie(base, 'reviewer');
    const act = (name) => fetch(base + '/api/admin/' + name, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify({ name: 'second' }) });

    // ban: the minted-but-unused ticket must not open either proxy protocol
    let c2 = await loginCookie(base, 'second');
    const tBan = await mintTicket(base, c2);
    assert.equal((await act('ban')).status, 200);
    assert.equal(await tryUpgrade(base, tBan, null), false, 'ticket outlives a ban (wisp)');
    assert.equal(await tryUpgrade(base, tBan, null, 'pws-t'), false, 'ticket outlives a ban (pws)');
    assert.equal((await act('unban')).status, 200);

    // logout: same story for the cookie-less upgrade
    c2 = await loginCookie(base, 'second');
    const tOut = await mintTicket(base, c2);
    await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: c2 } });
    assert.equal(await tryUpgrade(base, tOut, null), false, 'ticket outlives logout (wisp)');
    assert.equal(await tryUpgrade(base, tOut, null, 'pws-t'), false, 'ticket outlives logout (pws)');

    // password change: revoke everything the old credential minted
    c2 = await loginCookie(base, 'second');
    const tPw = await mintTicket(base, c2);
    const ch = await fetch(base + '/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c2 }, body: JSON.stringify({ current: PASS, next: 'replacement-pass' }) });
    assert.equal(ch.status, 200);
    assert.equal(await tryUpgrade(base, tPw, null), false, 'ticket outlives a password change');
    // restore for the next scenario
    const c2b = await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'second', password: 'replacement-pass' }) })).headers.get('set-cookie');
    await fetch(base + '/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c2b.split(';')[0] }, body: JSON.stringify({ current: 'replacement-pass', next: PASS }) });
  });
});

test('a live proxy connection closes when the account is banned', async () => {
  await withTempServer(seed('reviewer', 'pipeuser'), async ({ base }) => {
    const admin = await loginCookie(base, 'reviewer');
    const cookie = await loginCookie(base, 'pipeuser');
    const ws = new WebSocket(base.replace('http', 'ws') + '/wisp/', { headers: { cookie } });
    await once(ws, 'open');
    const closed = Promise.race([once(ws, 'close').then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
    const ban = await fetch(base + '/api/admin/ban', { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify({ name: 'pipeuser' }) });
    assert.equal(ban.status, 200);
    assert.equal(await closed, true, 'an open proxy pipe survives the ban');
  });
});

test('lite credential cache cannot ride a ban or a password change', async () => {
  await withTempServer(seed('reviewer', 'lite1'), async ({ base }) => {
    const admin = await loginCookie(base, 'reviewer');
    const act = (name) => fetch(base + '/api/admin/' + name, { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify({ name: 'lite1' }) });

    assert.equal((await liteHealth(base, 'lite1', PASS)).status, 200, 'valid credentials authenticate');
    assert.equal((await act('ban')).status, 200);
    assert.equal((await liteHealth(base, 'lite1', PASS)).status, 401, 'banned account authenticates from the cache');
    assert.equal((await act('unban')).status, 200);
    assert.equal((await liteHealth(base, 'lite1', PASS)).status, 200, 'unbanned account authenticates again');

    const web = await loginCookie(base, 'lite1');
    const ch = await fetch(base + '/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: web }, body: JSON.stringify({ current: PASS, next: 'replacement-pass' }) });
    assert.equal(ch.status, 200);
    assert.equal((await liteHealth(base, 'lite1', PASS)).status, 401, 'old password authenticates from the cache after a change');
    assert.equal((await liteHealth(base, 'lite1', 'replacement-pass')).status, 200, 'new password authenticates');
  });
});

test('password change kills every other session and re-mints the current browser', async () => {
  await withTempServer(seed('third'), async ({ base }) => {
    const cookieA = await loginCookie(base, 'third');
    const cookieB = await loginCookie(base, 'third');
    const me = (cookie) => fetch(base + '/api/auth/me', { headers: { cookie } });
    assert.equal((await me(cookieA)).status, 200);
    assert.equal((await me(cookieB)).status, 200);
    const ch = await fetch(base + '/api/auth/change-password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieA }, body: JSON.stringify({ current: PASS, next: 'replacement-pass' }) });
    assert.equal(ch.status, 200);
    const fresh = ch.headers.get('set-cookie');
    assert.ok(fresh && fresh.includes('rj2_session='), 'the changing browser gets a replacement session');
    assert.ok(!fresh.includes('Secure'), 'no Secure flag on a plain http deployment');
    const newCookie = fresh.split(';')[0];
    assert.equal((await me(cookieB)).status, 401, 'the other session survives the password change');
    assert.equal((await me(cookieA)).status, 401, 'the old token of the changing browser survives');
    assert.equal((await me(newCookie)).status, 200, 'the replacement session works');
  });
});

test('rename and signup enforce the reserved/authority boundary', async () => {
  await withTempServer(seed('reviewer', 'fourth'), async ({ base }) => {
    const c4 = await loginCookie(base, 'fourth');
    const claim = (name) => fetch(base + '/api/auth/claim-username', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c4 }, body: JSON.stringify({ name }) });
    assert.equal((await claim('root')).status, 400, 'rename to a reserved name');
    assert.equal((await claim('sync-reviewer')).status, 400, 'rename to the (unoccupied) sync-admin name');
    assert.equal((await claim('reviewer')).status, 400, 'rename to the occupied admin name');
    assert.equal((await claim('fourth2')).status, 200, 'an ordinary rename still works');
    const su = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sync-reviewer', password: PASS }) });
    assert.equal(su.status, 400, 'signup takes the unoccupied sync-admin name');
  }, { RJ_SYNC_ADMIN: 'sync-reviewer' });
});

test('upgrade origin gate: cross-site origins refused, ticket not consumed', async () => {
  await withTempServer(seed('fifth'), async ({ base }) => {
    const cookie = await loginCookie(base, 'fifth');
    const ticket = await mintTicket(base, cookie);
    assert.equal(await tryUpgrade(base, ticket, null, 'wisp-t', 'http://evil.example'), false, 'cross-site ticket upgrade');
    assert.equal(await tryUpgrade(base, ticket, null, 'pws-t', 'http://evil.example'), false, 'cross-site pws upgrade');
    assert.equal(await tryUpgrade(base, ticket, null), true, 'the refused attempt must not consume the ticket');
    assert.equal(await tryUpgrade(base, '', cookie, 'wisp', 'http://evil.example'), false, 'cross-site cookie upgrade');
    assert.equal(await tryUpgrade(base, '', cookie, 'wisp', 'http://127.0.0.1:' + base.split(':').pop()), true, 'same-host origin upgrades');
  });
});

test('a malformed cookie pair is skipped, never a 500', async () => {
  await withTempServer(async ({ base }) => {
    const r = await fetch(base + '/', { headers: { cookie: 'rj2_session=%E0%A4%A; other=ok' }, redirect: 'manual' });
    assert.equal(r.status, 302, 'malformed percent-encoding must not crash the request');
  });
});

test('https-fronted deployments issue Secure cookies', async () => {
  await withTempServer(seed('sixth'), async ({ base }) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'sixth', password: PASS }) });
    const sc = r.headers.get('set-cookie') || '';
    assert.ok(/;\s*Secure(;|$)/i.test(sc), 'Secure flag present when RJ_SECURE_COOKIES=1: ' + sc);
  }, { RJ_SECURE_COOKIES: '1' });
});

test('credential stores land with private modes and permissive existing files are repaired', async () => {
  const setup = (root) => {
    new Auth(root).createUser('reviewer', PASS);
    chmodSync(join(root, 'users.json'), 0o644); // a formerly permissive store
  };
  await withTempServer(setup, async ({ root, base }) => {
    const cookie = await loginCookie(base, 'reviewer'); // writes sessions.json
    const mode = (f) => statSync(join(root, f)).mode & 0o777;
    assert.equal(mode('users.json') & 0o077, 0, 'users.json must be owner-only (existing file repaired)');
    assert.equal(mode('sessions.json') & 0o077, 0, 'sessions.json must be owner-only');
    const r = await fetch(base + '/api/apps/browse/sync', { method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ cookies: 'a=b', storage: { 'h@k': 'v' } }) });
    assert.equal(r.status, 200, 'sync-admin write');
    assert.equal(mode('browse-sync.json') & 0o077, 0, 'browse-sync.json holds upstream credentials and must be owner-only');
  }, { RJ_SYNC_ADMIN: 'reviewer' });
});

test('urlkey secret: invalid existing secret fails closed; permissive mode is repaired', async () => {
  // invalid existing secret: refuse rather than regenerate over existing state
  await withTempServer((root) => { new Auth(root).createUser('reviewer', PASS); writeFileSync(join(root, '.urlkey-secret'), 'junk', { mode: 0o600 }); }, async ({ root, base }) => {
    const cookie = await loginCookie(base, 'reviewer');
    const r = await fetch(base + '/api/apps/browse/urlkey', { headers: { cookie } });
    assert.equal(r.status, 500, 'a corrupt secret must fail closed');
    assert.equal(readFileSync(join(root, '.urlkey-secret'), 'utf8'), 'junk', 'the bad secret must not be replaced silently');
  });
  // valid but permissively-moded secret: repaired on use
  await withTempServer((root) => { new Auth(root).createUser('reviewer', PASS); writeFileSync(join(root, '.urlkey-secret'), 'a'.repeat(64)); chmodSync(join(root, '.urlkey-secret'), 0o644); }, async ({ root, base }) => {
    const cookie = await loginCookie(base, 'reviewer');
    const r = await fetch(base + '/api/apps/browse/urlkey', { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal(statSync(join(root, '.urlkey-secret')).mode & 0o077, 0, 'existing secret mode repaired');
  });
});

// Staples' cookie study: each upgrade path gets its OWN fixture server - if a
// malformed cookie kills one handler, a shared server would make the second
// probe hit an already-dead process and prove nothing about the other path.
const rawUpgrade = (base, path, cookie) => new Promise((resolve) => {
  const s = net.connect(Number(base.split(':')[2]), '127.0.0.1');
  let data = '';
  s.on('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`));
  s.on('data', (b) => { data += b.toString(); });
  const done = () => resolve(data.includes('101 Switching Protocols'));
  s.on('error', () => done());
  setTimeout(() => { s.destroy(); done(); }, 2000);
});
for (const [label, path] of [['wisp', '/wisp/'], ['pws-t', '/pws-t/' + '0'.repeat(48) + '/']]) {
  test(`malformed cookie on the ${label} upgrade path: rejected, server survives`, async () => {
    await withTempServer(seed('cook' + label), async ({ base }) => {
      assert.equal(await rawUpgrade(base, path, 'x=%E0%A4%A'), false, 'malformed-cookie upgrade must not be accepted');
      const alive = await fetch(base + '/login');
      assert.equal(alive.status, 200, 'the process must survive the malformed cookie');
    });
  });
}

// r18 Sage gaps: rename must rekey live proxy pipes; sensitive stores must
// repair mode on READ, not only on write; a store/key whose mode cannot be
// repaired must be refused, not used.
test('rename migrates live proxy pipes: a ban under the new name cuts connections the old name opened', async () => {
  await withTempServer(seed('reviewer', 'rename1'), async ({ base }) => {
    const admin = await loginCookie(base, 'reviewer');
    const cookie = await loginCookie(base, 'rename1');
    const ws = new WebSocket(base.replace('http', 'ws') + '/wisp/', { headers: { cookie } });
    await once(ws, 'open');
    const rn = await fetch(base + '/api/auth/claim-username', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'rename2' }) });
    assert.equal(rn.status, 200, 'the rename itself works');
    const closed = Promise.race([once(ws, 'close').then(() => true), new Promise((r) => setTimeout(() => r(false), 4000))]);
    const ban = await fetch(base + '/api/admin/ban', { method: 'POST', headers: { 'content-type': 'application/json', cookie: admin }, body: JSON.stringify({ name: 'rename2' }) });
    assert.equal(ban.status, 200);
    assert.equal(await closed, true, 'an open proxy pipe survives a ban after the account was renamed');
  });
});

test('renameUser fires the onRenamed hook with the old and new names', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'rj-rename-'));
  try {
    const a = new Auth(root);
    a.createUser('oldname', PASS);
    const calls = [];
    a.onRenamed = (o, n) => calls.push([o, n]);
    a.renameUser('oldname', 'newname');
    assert.deepEqual(calls, [['oldname', 'newname']], 'onRenamed must fire exactly once with (old, new)');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('browse-sync store mode is repaired on read, not only on write', async () => {
  await withTempServer((root) => {
    new Auth(root).createUser('reviewer', PASS);
    writeFileSync(join(root, 'browse-sync.json'), JSON.stringify({ reviewer: { cookies: 'a=b', at: 1 } }));
    chmodSync(join(root, 'browse-sync.json'), 0o644); // a store a looser era left behind
  }, async ({ root, base }) => {
    const cookie = await loginCookie(base, 'reviewer');
    const r = await fetch(base + '/api/apps/browse/sync', { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).sync.cookies, 'a=b', 'the read still serves the data');
    assert.equal(statSync(join(root, 'browse-sync.json')).mode & 0o077, 0, 'a read must repair the store mode before serving');
  }, { RJ_SYNC_ADMIN: 'reviewer' });
});
