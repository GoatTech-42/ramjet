// engine build stamp: pages must reference engine/boot urls under the
// deploy stamp so a stale edge or browser cache can never mix one deploy's
// page with another deploy's engine (the r8 cutover regression).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withTempServer } from './fixtures/start-server.mjs';

test('pages serve engine urls under the deploy build stamp', async () => {
  await withTempServer(null, async ({ base }) => {
    const r = await fetch(base + '/login');
    const html = await r.text();
    assert.ok(!html.includes('__RJ_ENGINE__'), 'placeholder fully replaced at serve time');
    const stamps = [...html.matchAll(/\?v=([0-9a-f]{12})/g)].map((m) => m[1]);
    assert.ok(stamps.length >= 1, 'login page carries stamped cloak urls');
    assert.ok(stamps.every((v) => v === stamps[0]), 'one consistent stamp per page');
    // engine files answer under the stamped url (routing ignores the query)
    const e = await fetch(base + '/browse-sw.js?v=' + stamps[0]);
    assert.equal(e.status, 200);
    const sw = await e.text();
    assert.ok(sw.includes('"/controller/controller.sw.js" + self.location.search'), 'worker inherits its own stamp for imports');
  });
});

test('an old stamp never serves new bytes (immutable stamped urls)', async () => {
  await withTempServer(null, async ({ base }) => {
    const html = await (await fetch(base + '/login')).text();
    const cur = html.match(/\?v=([0-9a-f]{12})/)[1];
    const stale = 'deadbeef0000';
    assert.notEqual(stale, cur);
    // unknown stamp -> loud 404, never the current bytes
    const old1 = await fetch(base + '/browse-sw.js?v=' + stale);
    assert.equal(old1.status, 404);
    const old2 = await fetch(base + '/cloak/theme-boot.js?v=' + stale);
    assert.equal(old2.status, 404);
    const old3 = await fetch(base + '/scramjet/scramjet.js?v=' + stale);
    assert.equal(old3.status, 404);
    // current stamp and unversioned callers still serve
    assert.equal((await fetch(base + '/browse-sw.js?v=' + cur)).status, 200);
    assert.equal((await fetch(base + '/browse-sw.js')).status, 200);
    // hashed bundle assets are outside the stamped set: untouched
    const asset = html.match(/\/assets\/[A-Za-z0-9_.-]+\.js/);
    if (asset) assert.equal((await fetch(base + asset[0] + '?v=' + stale)).status, 200);
  });
});

test('browse page template stamps the engine scripts and exposes the stamp to the bundle', () => {
  const html = readFileSync(new URL('../web/dist/pages/browse/browse.html', import.meta.url), 'utf8');
  assert.ok(html.includes("/scramjet/scramjet.js?v=__RJ_ENGINE__"), 'scramjet stamped');
  assert.ok(html.includes("/controller/controller.api.js?v=__RJ_ENGINE__"), 'controller stamped');
  assert.ok(html.includes("self.__RJ_ENGINE__ = '__RJ_ENGINE__'"), 'stamp exposed to the page bundle');
});
