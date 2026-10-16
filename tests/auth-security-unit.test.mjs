// r17 unit-level fixes: forwarded-identity trust boundary, Secure cookie
// flag, malformed cookie tolerance, private credential-store modes, and the
// sage provider transport guard + log scrubbing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientIp, parseCookies } from '../core/util.js';
import { Auth } from '../core/auth.js';
import { providerBaseOk, scrubSecrets } from '../core/addons/sage/index.js';

test('x-forwarded-for is honored only from a trusted proxy peer', () => {
  const req = (peer, fwd) => ({ socket: { remoteAddress: peer }, headers: fwd ? { 'x-forwarded-for': fwd } : {} });
  assert.equal(clientIp(req('127.0.0.1', '1.2.3.4, 10.0.0.1')), '1.2.3.4', 'on-box proxy passes the client through');
  assert.equal(clientIp(req('10.9.9.9', '1.2.3.4')), '10.9.9.9', 'a direct remote client cannot rotate its identity');
  assert.equal(clientIp(req('10.9.9.9')), '10.9.9.9', 'no header: the socket peer');
  assert.equal(clientIp(req('::ffff:127.0.0.1', '1.2.3.4')), '1.2.3.4', 'v4-mapped loopback proxy');
});

test('session cookies carry Secure only when the deployment is https-fronted', () => {
  const root = mkdtempSync(join(tmpdir(), 'rj-cookie-'));
  try {
    const a = new Auth(root);
    delete process.env.RJ_SECURE_COOKIES;
    assert.ok(!a.cookieHeader('t').includes('Secure'));
    assert.ok(!a.clearCookieHeader().includes('Secure'));
    process.env.RJ_SECURE_COOKIES = '1';
    assert.ok(a.cookieHeader('t').includes('; Secure'));
    assert.ok(a.clearCookieHeader().includes('; Secure'));
    delete process.env.RJ_SECURE_COOKIES;
    const httpsHop = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https' } };
    assert.ok(a.cookieHeader('t', httpsHop).includes('; Secure'), 'trusted proxy reports an https client hop');
    const spoofed = { socket: { remoteAddress: '10.9.9.9' }, headers: { 'x-forwarded-proto': 'https' } };
    assert.ok(!a.cookieHeader('t', spoofed).includes('Secure'), 'a direct client cannot spoof the https signal');
  } finally { delete process.env.RJ_SECURE_COOKIES; rmSync(root, { recursive: true }); }
});

test('malformed cookie pairs are skipped without throwing', () => {
  const cookies = parseCookies({ headers: { cookie: 'rj2_session=%E0%A4%A; other=ok' } });
  assert.equal(cookies.other, 'ok');
  assert.equal(cookies.rj2_session, undefined);
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('auth stores are written owner-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'rj-modes-'));
  try {
    const a = new Auth(root);
    a.createUser('someone', 'fixture-password');
    a.createSession('someone');
    assert.equal(statSync(join(root, 'users.json')).mode & 0o077, 0, 'users.json');
    assert.equal(statSync(join(root, 'sessions.json')).mode & 0o077, 0, 'sessions.json');
  } finally { rmSync(root, { recursive: true }); }
});

test('sage keyed providers require https (loopback dev exception)', () => {
  assert.equal(providerBaseOk('https://api.groq.com/openai/v1'), true);
  assert.equal(providerBaseOk('http://api.groq.com/openai/v1'), false, 'plaintext key transport');
  assert.equal(providerBaseOk('http://127.0.0.1:8080/v1'), true, 'local development exception');
  assert.equal(providerBaseOk('http://localhost:8080'), true, 'local development exception');
  assert.equal(providerBaseOk('not a url'), false);
});

test('provider error logs never echo the key or credential-looking material', () => {
  const key = 'gsk_secretkey123';
  const echoed = scrubSecrets(`401 invalid key: ${key} was rejected; authorization: Bearer ${key}`, key);
  assert.ok(!echoed.includes(key), 'the provider key must never land in logs');
  assert.equal(scrubSecrets('plain failure', key), 'plain failure');
});
