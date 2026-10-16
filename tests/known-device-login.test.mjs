import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let proc, base, dir;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const USER = 'kduser', PASS = 'kd-pass-12345';
const KD = '__Host-rj_kd';
let seq = 0;
const uname = (p) => `${p}${seq++}`;

// the server trusts loopback as a proxy, so x-forwarded-for lets a test pick
// its client ip; most tests share one ip pool without tripping the ceiling
async function login(username, password, { kd, ip, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  else if (kd) headers.cookie = `${KD}=${kd}`;
  if (ip) headers['x-forwarded-for'] = ip;
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ username, password }) });
  return { status: r.status, body: await r.json(), setCookies: r.headers.getSetCookie() };
}
const kdOf = (setCookies) => (setCookies.find((c) => c.startsWith(KD + '=')) || '').split(';')[0].slice(KD.length + 1);
const signup = async (u, p = PASS) => {
  const r = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
  assert.equal(r.status, 200, `signup ${u} failed`);
  return r; // note: signup auto-login mints the accounts FIRST known device
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rj-kd-'));
  writeFileSync(join(dir, 'users.json'), '{}');
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ requireApproval: false }));
  // one pre-exhausted general anon bucket, reserved for the NAT guard test
  writeFileSync(join(dir, 'guard.json'), JSON.stringify({ 'anon:192.0.2.200': { windowStart: Date.now(), bytes: 0, requests: 5000 } }));
  const { createServer } = await import('node:net');
  const port = await new Promise((res) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
  base = `http://127.0.0.1:${port}`;
  proc = spawn('node', ['core/index.js'], {
    env: { ...process.env, RJ_HOST: '127.0.0.1', RJ_PORT: String(port), RJ_DATA: dir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let up = false;
  proc.stdout.on('data', (d) => { if (String(d).includes('ramjet2 on')) up = true; });
  for (let i = 0; i < 100 && !up; i++) await sleep(100);
  assert.ok(up, 'server did not boot');
});
after(() => { proc?.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); });

test('successful login mints a __Host- known-device cookie; server stores hash + expiry only', async () => {
  const u = uname('kdmint');
  const su = await signup(u);
  const kd = kdOf(su.headers.getSetCookie());
  assert.ok(kd, 'no kd cookie');
  const r = await login(u, PASS, { kd }); // same device renews, no second entry
  assert.equal(r.status, 200);
  assert.equal(kdOf(r.setCookies), kd, 'a same-device login must renew, not rotate');
  const cookie = su.headers.getSetCookie().find((c) => c.startsWith(KD + '='));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/, '__Host- requires Secure, always');
  assert.match(cookie, /Path=\//);
  assert.ok(!/Domain=/i.test(cookie), '__Host- forbids a Domain attribute');
  assert.match(cookie, /Max-Age=\d+/);
  const stored = JSON.parse(readFileSync(join(dir, 'users.json')))[u].kd;
  assert.ok(Array.isArray(stored) && stored.length === 1, 'one stored kd entry');
  assert.match(stored[0].h, /^[0-9a-f]{64}$/);
  assert.ok(stored[0].exp > Date.now(), 'server-side expiry stored');
  assert.equal(stored[0].fails, 0);
  assert.ok(!JSON.stringify(stored).includes(kd), 'raw token must never be stored');
});

test('attacker failures 429 the attacker; the owner still gets in from a known device', async () => {
  const u = uname('kdatt');
  await signup(u);
  const kd = kdOf((await login(u, PASS)).setCookies);
  for (let i = 0; i < 10; i++) assert.equal((await login(u, 'wrong-password')).status, 401);
  assert.equal((await login(u, PASS)).status, 429, 'over budget: even a correct password 429s an unknown device');
  assert.equal((await login(u, PASS, { kd: 'f'.repeat(64) })).status, 429, 'a forged kd does not help');
  assert.equal((await login(u, PASS, { kd })).status, 200, 'the owners known device still verifies');
});

test('repeat logins from one device renew the same entry instead of evicting others', async () => {
  const u = uname('kdrenew');
  const first = kdOf((await signup(u)).headers.getSetCookie());
  for (let i = 0; i < 9; i++) {
    const kd = kdOf((await login(u, PASS, { kd: first })).setCookies);
    assert.equal(kd, first, 'renewal must keep the same token');
  }
  const stored = JSON.parse(readFileSync(join(dir, 'users.json')))[u].kd;
  assert.equal(stored.length, 1, 'one device, one entry - renewals must not append');
});

test('a successful login resets the failure count', async () => {
  const u = uname('kdreset');
  await signup(u);
  for (let i = 0; i < 9; i++) assert.equal((await login(u, 'wrong-password')).status, 401);
  assert.equal((await login(u, PASS)).status, 200);
  for (let i = 0; i < 10; i++) assert.equal((await login(u, 'wrong-password')).status, 401, `post-reset failure ${i + 1}`);
  assert.equal((await login(u, PASS)).status, 429);
});

test('kd cookie is not a session', async () => {
  const u = uname('kdns');
  await signup(u);
  const kd = kdOf((await login(u, PASS)).setCookies);
  const r = await fetch(`${base}/`, { headers: { cookie: `${KD}=${kd}` }, redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/login');
});

test('password change clears devices and issues the replacement in the same response', async () => {
  const u = uname('kdpw');
  await signup(u);
  const first = await login(u, PASS);
  const kd = kdOf(first.setCookies);
  const sessionCookie = first.setCookies.map((c) => c.split(';')[0]).join('; ');
  const ch = await fetch(`${base}/api/auth/change-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({ current: PASS, next: PASS + '2' }),
  });
  assert.equal(ch.status, 200);
  const chKd = kdOf(ch.headers.getSetCookie());
  assert.ok(chKd && chKd !== kd, 'the change response must mint a fresh kd - the old list is gone');
  for (let i = 0; i < 10; i++) await login(u, 'wrong-password');
  assert.equal((await login(u, PASS + '2', { kd })).status, 429, 'old kd survived a password change');
  assert.equal((await login(u, PASS + '2', { kd: chKd })).status, 200, 'the replacement kd works');
});

test('logout forgets the asking device', async () => {
  const u = uname('kdout');
  const first = await signup(u);
  const kd = kdOf(first.headers.getSetCookie());
  const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const lo = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(lo.status, 200);
  assert.ok(lo.headers.getSetCookie().some((c) => c.startsWith(KD + '=;') && /Max-Age=0/.test(c)), 'kd cookie not cleared on logout');
  const stored = JSON.parse(readFileSync(join(dir, 'users.json')))[u].kd;
  assert.ok(!stored || stored.length === 0, 'server entry survived logout');
  for (let i = 0; i < 10; i++) await login(u, 'wrong-password');
  assert.equal((await login(u, PASS, { kd })).status, 429, 'a logged-out device kept its bypass');
});

test('a stolen kd buys at most 20 verified failures, then the device self-revokes', async () => {
  const u = uname('kdthief');
  const kd = kdOf((await signup(u)).headers.getSetCookie()); // the owners device
  // the thief uses it from another ip: it works (devices roam) but is bounded
  for (let i = 0; i < 20; i++) {
    assert.equal((await login(u, 'wrong-password', { kd, ip: '198.51.100.9' })).status, 401, `theft failure ${i + 1}`);
  }
  // device budget spent: the stolen cookie is revoked, the account is over
  // budget, and even the correct password now 429s from the thieves device
  assert.equal((await login(u, PASS, { kd, ip: '198.51.100.9' })).status, 429, 'stolen kd was not bounded');
  const stored = JSON.parse(readFileSync(join(dir, 'users.json')))[u].kd;
  assert.equal(stored.length, 0, 'self-revoked device still on the list');
});

test('a remembered device skips the exhausted per-ip ceiling (NAT)', async () => {
  const ip = '192.0.2.77';
  // exhaust ip:120 with spray against an invented name (failures + 429s both count)
  for (let i = 0; i < 121; i++) await login('no-such-nat-user', 'x'.repeat(8), { ip });
  const u = uname('kdnat');
  await signup(u);
  const kd = kdOf((await login(u, PASS)).setCookies); // minted from the shared pool
  assert.equal((await login(u, PASS, { ip })).status, 429, 'unknown device behind an exhausted nat ip must wait');
  assert.equal((await login(u, PASS, { kd, ip })).status, 200, 'known device locked out by its own nat');
});

test('enumeration parity: unknown and known names match in status, body, timing, and hot-limit behavior', async () => {
  const u = uname('kdenum');
  await signup(u);
  const ipKnown = '203.0.113.50', ipUnknown = '203.0.113.51';
  // timing: unknown name pays the same scrypt as a wrong password
  const t = async (name, ip) => { const t0 = performance.now(); const r = await login(name, 'wrong-password', { ip }); return [performance.now() - t0, r]; };
  const [tu] = await t('no-such-enum-user', ipUnknown);
  const [tk] = await t(u, ipKnown);
  assert.ok(tu > tk / 3 && tk > tu / 3, `timing gap leaks existence: unknown ${tu.toFixed(0)}ms vs known ${tk.toFixed(0)}ms`);
  // status + body parity, including once both are over their failure budgets
  for (let i = 0; i < 9; i++) { await t('no-such-enum-user', ipUnknown); await t(u, ipKnown); }
  const a = await login('no-such-enum-user', 'wrong-password', { ip: ipUnknown });
  const b = await login(u, 'wrong-password', { ip: ipKnown });
  assert.equal(a.status, b.status);
  assert.deepEqual(a.body, b.body);
  const a2 = await login('no-such-enum-user', 'wrong-password', { ip: ipUnknown });
  const b2 = await login(u, 'wrong-password', { ip: ipKnown });
  assert.equal(a2.status, 429, 'unknown name never hit its hot limit');
  assert.equal(a2.status, b2.status, 'hot-limit status differs by existence');
});

test('malformed and duplicate kd cookies never crash and never bypass', async () => {
  const u = uname('kdmlf');
  await signup(u);
  const kd = kdOf((await login(u, PASS)).setCookies);
  for (let i = 0; i < 10; i++) await login(u, 'wrong-password');
  assert.equal((await login(u, PASS, { cookie: `${KD}=%zz` })).status, 429, 'malformed cookie bypassed');
  assert.equal((await login(u, PASS, { cookie: `${KD}` })).status, 429, 'valueless cookie bypassed');
  // duplicates: the last pair wins (parseCookies), so a trailing forgery
  // must NOT pass while a trailing valid one does
  assert.equal((await login(u, PASS, { cookie: `${KD}=${kd}; ${KD}=${'e'.repeat(64)}` })).status, 429);
  assert.equal((await login(u, PASS, { cookie: `${KD}=${'e'.repeat(64)}; ${KD}=${kd}` })).status, 200);
});

test('change-password verifies spend the account budget, kd gate included', async () => {
  const u = uname('kdcpb');
  await signup(u);
  const first = await login(u, PASS);
  const kd = kdOf(first.setCookies);
  const sess = first.setCookies.find((c) => c.startsWith('rj2_session=')).split(';')[0];
  const cp = (cur, cookie) => fetch(`${base}/api/auth/change-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ current: cur, next: PASS + '9' }),
  });
  for (let i = 0; i < 10; i++) assert.equal((await cp('wrong-current', sess)).status, 401);
  assert.equal((await cp(PASS, sess)).status, 429, 'a stolen session can probe the old password unbounded');
  assert.equal((await cp(PASS, `${sess}; ${KD}=${kd}`)).status, 200, 'owner with kd could not change over budget');
});

test('change-password spends the DEVICE budget too: stolen session+kd is bounded', async () => {
  const u = uname('kdcps');
  const su = await signup(u);
  const kd = kdOf(su.headers.getSetCookie());
  const sess = su.headers.getSetCookie().find((c) => c.startsWith('rj2_session=')).split(';')[0];
  // push the account over budget with login failures from elsewhere
  for (let i = 0; i < 10; i++) await login(u, 'wrong-password');
  const cp = (cur) => fetch(`${base}/api/auth/change-password`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `${sess}; ${KD}=${kd}` },
    body: JSON.stringify({ current: cur, next: PASS + '9' }),
  });
  // the stolen kd passes the gate, but every wrong current spends the
  // device's lifetime budget: 20 probes, then the device is gone
  for (let i = 0; i < 20; i++) assert.equal((await cp('wrong-current')).status, 401, `probe ${i + 1}`);
  assert.equal((await cp(PASS)).status, 429, 'probe 21: the stolen kd was not bounded');
  const stored = JSON.parse(readFileSync(join(dir, 'users.json')))[u].kd;
  assert.equal((stored || []).length, 0, 'probed-out device still on the list');
});

test('a copied token never regains budget when the owner logs in', async () => {
  const u = uname('kdcopy');
  const kd = kdOf((await signup(u)).headers.getSetCookie());
  // the copy spends 19 of the 20 lifetime failures
  for (let i = 0; i < 19; i++) assert.equal((await login(u, 'wrong-password', { kd })).status, 401);
  // the owner logs in successfully (renewal): the account budget resets,
  // the DEVICE budget must not
  assert.equal((await login(u, PASS, { kd })).status, 200);
  let stored = JSON.parse(readFileSync(join(dir, 'users.json')))[u].kd;
  assert.equal(stored[0].fails, 19, 'owner login reset the copied tokens spent budget');
  assert.equal((await login(u, 'wrong-password', { kd })).status, 401, '20th cumulative failure');
  stored = JSON.parse(readFileSync(join(dir, 'users.json')))[u].kd;
  assert.equal((stored || []).length, 0, 'device not revoked at the cumulative cap');
});

test('a remembered device is exempt from the exhausted general anon bucket (NAT), keyed to the account instead', async () => {
  const ip = '192.0.2.200'; // seeded at 5000/5000 requests before boot
  const denied = await login('no-such-bucket-user', 'x'.repeat(8), { ip });
  assert.equal(denied.status, 429);
  assert.match(denied.body.error, /slow down/, 'the general anon bucket should deny unknown devices here');
  const u = uname('kdbucket');
  const kd = kdOf((await signup(u)).headers.getSetCookie());
  const ok = await login(u, PASS, { kd, ip });
  assert.equal(ok.status, 200, 'remembered device locked out by its nat neighbors general bucket');
  // the spend is keyed to the account bucket (kd:<name>) inside the guard;
  // its state file flushes on a 15s cadence, so the routing is proven by
  // behavior alone: the exhausted ip bucket denied, the kd login passed.
});
