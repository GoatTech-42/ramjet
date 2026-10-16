// the styled 404 page and the /signup route. unit level: the page is
// self-contained (no external requests), themed, and always links home.
// integration level: a booted server serves it on unknown paths with the
// right status and content type, and /signup serves the login app.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notFoundPage } from '../core/notfound.js';

test('404 page is self-contained, themed and links home', () => {
  const html = notFoundPage();
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport"/);
  assert.ok(html.includes('Nothing here'), 'heading');
  assert.ok(html.includes('href="/"'), 'link back home');
  assert.ok(html.includes('prefers-color-scheme: light'), 'light theme support');
  assert.ok(html.includes('--bg: #111318'), 'dark token inline');
  // no external requests of any kind: the page must render on its own
  assert.ok(!/<(script|img|link|iframe)\b/i.test(html), 'no external resources');
  assert.ok(!/url\(/i.test(html), 'no css url() fetches');
});

// boot the real server on a probed port with a throwaway data dir
const freePort = () => new Promise((r) => {
  const s = http.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});
const get = (port, path) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
  }).on('error', reject);
});

test('server: /signup serves the login app, unknown paths serve the styled 404', async (t) => {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'rj-404-'));
  const child = spawn(process.execPath, ['core/index.js'], {
    env: { ...process.env, RJ_HOST: '127.0.0.1', RJ_PORT: String(port), RJ_DATA: data },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let boot = '';
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('server did not boot: ' + boot)), 15000);
      child.stdout.on('data', (c) => {
        boot += c;
        if (boot.includes('ramjet2 on')) { clearTimeout(to); resolve(); }
      });
      child.on('exit', () => { clearTimeout(to); reject(new Error('server exited during boot: ' + boot)); });
    });

    const signup = await get(port, '/signup');
    assert.equal(signup.status, 200);
    assert.match(signup.type, /text\/html/);
    assert.ok(signup.body.length > 200, 'login app html');

    const missing = await get(port, '/definitely-not-a-page');
    assert.equal(missing.status, 404);
    assert.match(missing.type, /text\/html/);
    assert.ok(missing.body.includes('Nothing here'), 'styled 404 body');
    assert.ok(missing.body.includes('href="/"'), 'link back home');

    const login = await get(port, '/login');
    assert.equal(login.status, 200);
    assert.match(login.type, /text\/html/);
  } finally {
    child.kill('SIGKILL');
    rmSync(data, { recursive: true, force: true });
  }
});
