import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBounceToLogin } from '../web/src/lib/api.js';

test('401 on a dead-session api call bounces', () => {
  assert.equal(shouldBounceToLogin('/api/apps/browse/bookmarks', 401), true);
  assert.equal(shouldBounceToLogin('/api/apps/amp/queue', 401), true);
  assert.equal(shouldBounceToLogin('/api/me', 401), true);
});

test('auth endpoints never bounce (login renders its own 401)', () => {
  assert.equal(shouldBounceToLogin('/api/auth/login', 401), false);
  assert.equal(shouldBounceToLogin('/api/auth/signup', 401), false);
  assert.equal(shouldBounceToLogin('/api/auth/password', 401), false);
});

test('non-401 statuses never bounce', () => {
  assert.equal(shouldBounceToLogin('/api/me', 403), false);
  assert.equal(shouldBounceToLogin('/api/me', 429), false);
  assert.equal(shouldBounceToLogin('/api/me', 500), false);
  assert.equal(shouldBounceToLogin('/api/me', 0), false);
});

test('bounceToLoginOn401: redirects on covered 401, leaves auth endpoints and other statuses', async () => {
  const { bounceToLoginOn401 } = await import('../web/src/lib/api.js');
  const loc = {};
  globalThis.window = { location: loc };
  bounceToLoginOn401('/api/apps/browse/sync', 401);
  assert.equal(loc.href, '/login');
  loc.href = '';
  bounceToLoginOn401('/api/wisp-ticket', 401);
  assert.equal(loc.href, '/login');
  loc.href = '';
  bounceToLoginOn401('/api/auth/login', 401);
  assert.equal(loc.href, '');
  bounceToLoginOn401('/api/apps/sage/chat', 403);
  assert.equal(loc.href, '');
  delete globalThis.window;
});
