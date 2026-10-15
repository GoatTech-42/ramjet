// tickets ride in the websocket url path and can land in logs, so a valid
// ticket must be consumed by the upgrade that uses it: a replay within its
// 90s life, without a session cookie, must be refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { withTempServer } from './fixtures/start-server.mjs';
import { Auth } from '../core/auth.js';

const loginCookie = async (base) => {
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'reviewer', password: 'fixture-password' }) });
  assert.equal(r.status, 200);
  return r.headers.get('set-cookie').split(';')[0];
};
const tryUpgrade = (base, ticket, cookie, route = 'wisp-t') => new Promise((resolve) => {
  const headers = cookie ? { cookie } : {};
  const ws = new WebSocket(base.replace('http', 'ws') + '/' + route + '/' + ticket + '/', { headers });
  const done = (ok) => { try { ws.terminate(); } catch {} resolve(ok); };
  const t = setTimeout(() => done(false), 5000);
  ws.on('open', () => { clearTimeout(t); done(true); });
  ws.on('error', () => { clearTimeout(t); done(false); });
  ws.on('unexpected-response', () => { clearTimeout(t); done(false); });
});

test('wisp ticket is single-use', async () => {
  await withTempServer((root) => new Auth(root).createUser('reviewer', 'fixture-password'), async ({ base }) => {
    const cookie = await loginCookie(base);
    const r = await fetch(base + '/api/wisp-ticket', { headers: { cookie } });
    const { ticket } = await r.json();
    assert.ok(/^[a-f0-9]{48}$/.test(ticket));
    assert.equal(await tryUpgrade(base, ticket, cookie), true, 'first use upgrades');
    assert.equal(await tryUpgrade(base, ticket, null), false, 'replay without a cookie is refused');
  });
});

test('wisp ticket authenticates once without any cookie', async () => {
  await withTempServer((root) => new Auth(root).createUser('reviewer', 'fixture-password'), async ({ base }) => {
    const cookie = await loginCookie(base);
    const { ticket } = await (await fetch(base + '/api/wisp-ticket', { headers: { cookie } })).json();
    assert.equal(await tryUpgrade(base, ticket, null), true, 'first cookie-less use upgrades on the ticket');
    assert.equal(await tryUpgrade(base, ticket, null), false, 'second cookie-less use is refused');
  });
});

test('pws ticket is single-use on its own route', async () => {
  await withTempServer((root) => new Auth(root).createUser('reviewer', 'fixture-password'), async ({ base }) => {
    const cookie = await loginCookie(base);
    const { ticket } = await (await fetch(base + '/api/wisp-ticket', { headers: { cookie } })).json();
    assert.equal(await tryUpgrade(base, ticket, null, 'pws-t'), true, 'first pws use upgrades on the ticket');
    assert.equal(await tryUpgrade(base, ticket, null, 'pws-t'), false, 'cookie-less pws replay is refused');
    // a replay WITH a session cookie upgrades on the cookie, not the ticket:
    // same design as /wisp-t/ ("the cookie fallback below still covers
    // anything else" in the server)
    assert.equal(await tryUpgrade(base, ticket, cookie, 'pws-t'), true, 'pws replay with a session cookie upgrades on the cookie');
  });
});
