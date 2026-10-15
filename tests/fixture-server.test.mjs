import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTempServer } from './fixtures/start-server.mjs';

test('concurrent fixture servers use distinct ports and isolated roots', async () => {
  const user = { username: 'isolation-user', password: 'isolation-password' };
  await Promise.all([
    withTempServer(async ({ root, base }) => {
      assert.equal((await fetch(base + '/login')).status, 200);
      // write real account data through this server's own API
      const signup = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user) });
      assert.equal(signup.status, 200);
      const stored = JSON.parse(readFileSync(join(root, 'users.json'), 'utf8'))[user.username];
      assert.ok(stored, 'own root holds the created user');
      // known-but-pending (403) here proves the account lives in THIS root's store
      const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user) });
      assert.equal(login.status, stored.status === 'pending' ? 403 : 200);
    }),
    withTempServer(async ({ root, base }) => {
      assert.equal((await fetch(base + '/login')).status, 200);
      // the other server's user must not exist here: not on disk, not by login
      const usersPath = join(root, 'users.json');
      assert.ok(!existsSync(usersPath) || !JSON.parse(readFileSync(usersPath, 'utf8'))[user.username], 'this root never sees the other server\'s user');
      // unknown-account 401 (not the pending 403) proves it never leaked into this root
      const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(user) });
      assert.equal(login.status, 401);
    }),
    withTempServer(async ({ base }) => {
      assert.equal((await fetch(base + '/login')).status, 200);
    }),
  ]);
});
