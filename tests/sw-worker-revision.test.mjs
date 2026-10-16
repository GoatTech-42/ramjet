// Boot must wire the controller against the requested stamped worker
// revision, never whatever old worker happens to be active while the new
// one installs. vm-extracts waitForWorker from the browse page and drives
// it with a fake registration - deterministic, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../web/src/pages/browse/Browse.svelte', import.meta.url), 'utf8');
const load = (reg) => {
  const fn = SRC.slice(SRC.indexOf('  async function waitForWorker('), SRC.indexOf('  async function makeTransport('));
  assert.ok(fn.length > 200, 'waitForWorker slice found');
  const c = vm.createContext({
    navigator: { serviceWorker: { register: async () => reg, ready: Promise.resolve(reg) } },
    location: { href: 'https://site/browse' },
    URL, Promise, setTimeout, clearTimeout,
  });
  vm.runInContext(fn + ';this.waitForWorker=waitForWorker;', c);
  return c.waitForWorker;
};
const loadGuard = (hasController) => {
  const fn = SRC.slice(SRC.indexOf('  function makeControllerGuard('), SRC.indexOf('  async function makeTransport('));
  assert.ok(fn.length > 100, 'makeControllerGuard slice found');
  const c = vm.createContext({ navigator: { serviceWorker: { controller: hasController ? {} : null } } });
  vm.runInContext(fn + ';this.makeControllerGuard=makeControllerGuard;this.sameWorker=sameWorker;', c);
  return c;
};
const worker = (url, state) => {
  const ls = [];
  return { scriptURL: url, state, addEventListener: (_t, cb) => ls.push(cb), setState(s) { this.state = s; ls.forEach((cb) => cb()); } };
};
const registration = () => {
  const ls = [];
  return { active: null, installing: null, waiting: null, addEventListener: (_t, cb) => ls.push(cb), fireUpdate() { ls.forEach((cb) => cb()); } };
};
const tick = () => new Promise((r) => setImmediate(r));
const WANTED = 'https://site/browse-sw.js?v=newstamp123';

test('resolves immediately when the active worker is already the wanted revision', async () => {
  const reg = registration();
  reg.active = worker(WANTED, 'activated');
  const w = await load(reg)('/browse-sw.js?v=newstamp123');
  assert.equal(w.scriptURL, WANTED);
});

test('old worker active + new installing: pending until the NEW revision activates', async () => {
  const reg = registration();
  reg.active = worker('https://site/browse-sw.js?v=oldstamp000', 'activated');
  const cand = worker(WANTED, 'installing');
  reg.installing = cand;
  const p = load(reg)('/browse-sw.js?v=newstamp123');
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await tick(); await tick();
  assert.equal(settled, false, 'must not settle on the old active worker');
  cand.state = 'activating';
  cand.setState('activating');
  await tick();
  assert.equal(settled, false, 'must not settle while merely activating');
  reg.active = cand;
  cand.setState('activated');
  const w = await p;
  assert.equal(w.scriptURL, WANTED);
});

test('old worker active + no candidate yet: waits for updatefound, then activation', async () => {
  const reg = registration();
  reg.active = worker('https://site/browse-sw.js?v=oldstamp000', 'activated');
  const p = load(reg)('/browse-sw.js?v=newstamp123');
  await tick();
  const cand = worker(WANTED, 'installing');
  reg.installing = cand;
  reg.fireUpdate();
  await tick();
  reg.active = cand;
  cand.setState('activated');
  const w = await p;
  assert.equal(w.scriptURL, WANTED);
});

test('wanted revision going redundant rejects', async () => {
  const reg = registration();
  const cand = worker(WANTED, 'installing');
  reg.installing = cand;
  const p = load(reg)('/browse-sw.js?v=newstamp123');
  await tick();
  cand.setState('redundant');
  await assert.rejects(p, /service worker failed/);
});

test('never activating rejects on timeout', async () => {
  const reg = registration();
  reg.active = worker('https://site/browse-sw.js?v=oldstamp000', 'activated');
  await assert.rejects(load(reg)('/browse-sw.js?v=newstamp123', 25), /did not start in time/);
});

test('controllerchange: first activation after page load is not a takeover', () => {
  let fired = 0;
  const guard = loadGuard(false).makeControllerGuard(() => fired++);
  guard(); // initial claim at boot
  assert.equal(fired, 0);
  guard(); // a later worker taking over mid-session
  assert.equal(fired, 1);
});

test('controllerchange: any change fires when a controller was already present', () => {
  let fired = 0;
  const guard = loadGuard(true).makeControllerGuard(() => fired++);
  guard();
  assert.equal(fired, 1);
});

test('sameWorker binds the commit to the handshook controller by identity', () => {
  const { sameWorker } = loadGuard(false);
  const a = { scriptURL: 'https://site/browse-sw.js?v=newstamp123' };
  const b = { scriptURL: 'https://site/browse-sw.js?v=oldstamp000' };
  assert.equal(sameWorker(a, a), true, 'the same worker object binds');
  assert.equal(sameWorker(a, b), false, 'a swapped controller does not bind');
  // strict identity: a same-scriptURL replacement is a different worker and
  // must not bind (a same-worker restart can never double-publish ready)
  assert.equal(sameWorker(a, { scriptURL: a.scriptURL }), false, 'same scriptURL, different object does not bind');
  assert.equal(sameWorker(null, a), false, 'no controller does not bind');
  assert.equal(sameWorker(a, null), false, 'no handshook worker does not bind');
  assert.equal(sameWorker(null, null), false);
});
