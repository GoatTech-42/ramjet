import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Auth } from '../core/auth.js';
import { Guard } from '../core/guard.js';
import { clientIp } from '../core/util.js';

test('known-device list is a fifo capped at 8, entries carry hash+expiry only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-kdu-'));
  try {
    const a = new Auth(dir);
    a.createUser('capuser', 'pass12345');
    const tokens = [];
    for (let i = 0; i < 11; i++) tokens.push(a.mintKnownDevice('capuser'));
    const u = a.users.capuser;
    assert.equal(u.kd.length, 8);
    for (const t of tokens.slice(0, 3)) assert.equal(a.kdEntry('capuser', t), null, 'evicted token still matched');
    for (const t of tokens.slice(3)) assert.ok(a.kdEntry('capuser', t), 'live token rejected');
    for (const e of u.kd) {
      assert.match(e.h, /^[0-9a-f]{64}$/);
      assert.ok(e.exp > Date.now());
      assert.equal(e.fails, 0);
    }
    assert.ok(!JSON.stringify(u.kd).match(tokens[10]), 'raw token stored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('server-side expiry: an aged-out entry stops matching and is pruned from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-kdu-'));
  try {
    const a = new Auth(dir);
    a.createUser('expuser', 'pass12345');
    const t = a.mintKnownDevice('expuser');
    a.users.expuser.kd[0].exp = Date.now() - 1000; // aged out last second
    writeJsonSync(a);
    assert.equal(a.kdEntry('expuser', t), null, 'expired kd still matched');
    const onDisk = JSON.parse(readFileSync(join(dir, 'users.json'), 'utf8'));
    assert.equal((onDisk.expuser.kd || []).length, 0, 'expired entry left on disk');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
const writeJsonSync = (a) => { writeFileSync(join(a.usersPath), JSON.stringify(a.users)); };

test('kd state survives a restart (users.json is the store)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-kdu-'));
  try {
    const a = new Auth(dir);
    a.createUser('reboot', 'pass12345');
    const t = a.mintKnownDevice('reboot');
    a.users.reboot.kd[0].fails = 3;
    writeFileSync(a.usersPath, JSON.stringify(a.users));
    const b = new Auth(dir); // a fresh process would read the same file
    const e = b.kdEntry('reboot', t);
    assert.ok(e, 'known device forgotten across a restart');
    assert.equal(e.fails, 3, 'device failure budget reset by a restart');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('renewal extends expiry but NEVER resets the lifetime failure budget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-kdu-'));
  try {
    const a = new Auth(dir);
    a.createUser('renuser', 'pass12345');
    const t = a.mintKnownDevice('renuser');
    a.recordKdFailure('renuser', t);
    a.recordKdFailure('renuser', t);
    a.users.renuser.kd[0].exp = Date.now() + 1000; // about to age out
    assert.ok(a.renewKnownDevice('renuser', t));
    const e = a.kdEntry('renuser', t);
    assert.equal(e.fails, 2, 'a success must not hand a copied token its budget back');
    assert.ok(e.exp > Date.now() + 80 * 24 * 3600 * 1000, 'renewal did not extend the expiry');
    assert.equal(a.users.renuser.kd.length, 1, 'renewal appended an entry');
    // the budget is cumulative ACROSS renewals: 18 more failures, each
    // followed by a successful renewal, still revoke the device at 20
    for (let i = 0; i < 18; i++) { a.recordKdFailure('renuser', t); a.renewKnownDevice('renuser', t); }
    assert.equal(a.kdEntry('renuser', t), null, 'cumulative budget across renewals did not revoke');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a device self-revokes at 20 failures; revocation paths clear what they must', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-kdu-'));
  try {
    const a = new Auth(dir);
    a.createUser('buduser', 'pass12345');
    const t = a.mintKnownDevice('buduser');
    for (let i = 0; i < 19; i++) a.recordKdFailure('buduser', t);
    assert.ok(a.kdEntry('buduser', t), 'revoked early');
    a.recordKdFailure('buduser', t);
    assert.equal(a.kdEntry('buduser', t), null, 'not revoked at the budget cap');
    // logout revokes one device, killSessions (logout-all/ban/removal) clears all
    const t1 = a.mintKnownDevice('buduser');
    const t2 = a.mintKnownDevice('buduser');
    a.revokeKnownDevice('buduser', t1);
    assert.equal(a.kdEntry('buduser', t1), null, 'logout did not forget the device');
    assert.ok(a.kdEntry('buduser', t2), 'logout forgot the WRONG device');
    a.killSessions('buduser');
    assert.equal(a.kdEntry('buduser', t2), null, 'logout-all left a device behind');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard: failures limit, success resets, window expiry clears', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-gd-'));
  try {
    const g = new Guard(dir);
    const key = 'acct:x';
    assert.equal(g.accountLoginLimited(key), false);
    for (let i = 0; i < 9; i++) g.recordLoginFailure(key);
    assert.equal(g.accountLoginLimited(key), false, 'limited early at 9');
    g.recordLoginFailure(key);
    assert.equal(g.accountLoginLimited(key), true, 'not limited at 10');
    g.resetLoginFailures(key);
    assert.equal(g.accountLoginLimited(key), false);
    for (let i = 0; i < 12; i++) g.recordLoginFailure(key);
    g.loginTries.get(key).start = Date.now() - 11 * 60 * 1000;
    assert.equal(g.accountLoginLimited(key), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('forwarded identity: x-forwarded-for counts only from a trusted proxy peer', () => {
  const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  // the on-box proxy (loopback) vouches for the real client ip
  assert.equal(clientIp(req('127.0.0.1', '203.0.113.7')), '203.0.113.7');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '203.0.113.7, 10.0.0.1')), '10.0.0.1', 'default one-hop chain selects the right-most appended entry');
  // a direct client can write any header it wants: it must be ignored
  assert.equal(clientIp(req('198.51.100.23', '1.1.1.1')), '198.51.100.23', 'spoofed xff honored');
  assert.equal(clientIp(req('198.51.100.23')), '198.51.100.23');
});

test('guard anti-churn: live throttle state is never evicted; a full map fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-gd-'));
  try {
    const g = new Guard(dir);
    // the victim's cap is LIVE before the churn begins
    for (let i = 0; i < 10; i++) g.recordLoginFailure('acct:victim');
    assert.equal(g.accountLoginLimited('acct:victim'), true);
    // churn 10001 invented keys: the victim's entry must survive
    for (let i = 0; i < 10001; i++) g.recordLoginFailure(`acct:fake${i}`);
    assert.equal(g.accountLoginLimited('acct:victim'), true, 'churn erased the victims cap - silent security-state reset');
    // unknown keys under a full live map fail CLOSED: no verify, no request
    assert.equal(g.accountLoginLimited('acct:brand-new'), true, 'churn bought a verify for an unknown key');
    assert.equal(g.allowLogin('ip:1.2.3.4', 120), false, 'churn bought ip-ceiling admission');
    assert.equal(g.allowLogin('signup:1.2.3.4', 40), false, 'churn bought signup admission');
    assert.equal(g.loginTries.size, 10000, 'map grew past its bound');
    // after the windows age out, admission recovers (expired shed first)
    for (const [, v] of g.loginTries) v.start = Date.now() - 11 * 60 * 1000;
    assert.equal(g.allowLogin('ip:1.2.3.4', 120), true, 'expired windows were not shed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard anti-churn: request/byte buckets bounded, fail closed, no silent reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-gd-'));
  try {
    const g = new Guard(dir);
    assert.equal(g.allowRequest('victim'), true);
    for (let i = 0; i < 4999; i++) g.allowRequest('victim');
    assert.equal(g.allowRequest('victim'), false, 'victim should be at its own budget');
    // churn 10001 distinct anon buckets
    for (let i = 0; i < 10001; i++) g.allowRequest(`anon:10.0.${i >> 8}.${i & 255}`);
    // the victim's exhausted bucket was NOT reset by eviction
    assert.equal(g.allowRequest('victim'), false, 'churn reset the victims request budget');
    // a brand-new key under a full live map is denied, not admitted
    assert.equal(g.allowRequest('anon:9.9.9.9'), false, 'churn admitted a new bucket');
    assert.equal(g.bytesLeft('anon:9.9.9.9'), 0, 'unknown key under churn has bytes to spend');
    // aged-out buckets are shed and admission recovers
    for (const k of Object.keys(g.state)) g.state[k].windowStart = Date.now() - 3700 * 1000;
    assert.equal(g.allowRequest('anon:9.9.9.9'), true, 'expired buckets were not shed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard: a full-but-expired login map sheds on lookup instead of denying', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-gd-'));
  try {
    const g = new Guard(dir);
    for (let i = 0; i < 10000; i++) g.recordLoginFailure(`acct:fake${i}`);
    assert.equal(g.loginTries.size, 10000);
    // every window ages out; an unknown key (the change-password lookup for
    // an account with no live entry) must shed, not fail closed
    for (const [, v] of g.loginTries) v.start = Date.now() - 11 * 60 * 1000;
    assert.equal(g.accountLoginLimited('acct:no-live-entry'), false, 'full-but-expired map denied a lookup');
    assert.ok(g.loginTries.size < 10000, 'expired entries were not pruned');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('guard: an inherited oversized state file shrinks to live buckets at boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rj-gd-'));
  try {
    const stale = {};
    for (let i = 0; i < 12000; i++) stale[`anon:10.1.${i >> 8}.${i & 255}`] = { windowStart: Date.now() - 3700 * 1000, bytes: 0, requests: 1 };
    stale['anon:live'] = { windowStart: Date.now(), bytes: 0, requests: 3 };
    writeFileSync(join(dir, 'guard.json'), JSON.stringify(stale));
    const g = new Guard(dir);
    assert.equal(Object.keys(g.state).length, 1, 'expired buckets survived boot');
    assert.equal(g.allowRequest('anon:live'), true, 'the one live bucket was pruned');
    assert.equal(g.allowRequest('anon:fresh'), true, 'admission did not recover after the boot prune');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
