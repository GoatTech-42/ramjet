// behavioural model of Amp's serialized mutation queue, extracted from Amp.svelte so the real code is what runs
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const src = readFileSync(process.env.AMP_SVELTE || new URL('../pages/amp/Amp.svelte', import.meta.url), 'utf8');
const a = src.indexOf('let mutP = Promise.resolve();'), b = src.indexOf('let renaming = $state(false);');
const body = src.slice(a, b);
function make() {
  const calls = [];
  const env = { plId: 'A', plGen: 1, sections: [{ key: 'k1' }, { key: 'k2' }], calls, notes: [] };
  const api = async (u, o) => { calls.push(o.body); await new Promise((r) => setTimeout(r, 5)); return { ok: true }; };
  const f = new Function('env', 'api', 'note', 'errCopy', `
    let mutP = Promise.resolve();
    const serial = (fn) => (mutP = mutP.then(fn, fn));
    ${body.replace('let mutP = Promise.resolve();', '').replace(/const serial = .*\n/, '').replace(/\bplId\b/g, 'env.plId').replace(/\bplGen\b/g, 'env.plGen').replace(/\bsections\b/g, 'env.sections')}
    return { movePl, removeFromPlaylist };`);
  return { env, ...f(env, api, () => {}, () => '') };
}
test('a queued remove from playlist A does nothing after leaving and reopening A', async () => {
  const m = make();
  const p1 = m.removeFromPlaylist(0);           // runs now (api in flight)
  const p2 = m.removeFromPlaylist(1);           // queued behind it, captured at click time
  await new Promise((r) => setTimeout(r, 1));   // let the first closure start and send
  m.env.plGen++;                                // user leaves A ...
  m.env.plGen++; m.env.plId = 'A';              // ... and reopens A (same id, new gen)
  await p1; await p2;
  assert.equal(m.env.calls.length, 1);          // only the in-flight one was sent; the queued stale click never went out
});
test('extraction boundaries are real: the queue code and both functions were found', () => {
  assert.ok(a > 0 && b > a, 'markers found in order');
  assert.match(body, /function movePl\(/); assert.match(body, /function removeFromPlaylist\(/);
  assert.match(body, /g !== plGen/);
});
test('without leaving, queued ops run one at a time, in click order, by key', async () => {
  const m = make();
  m.env.sections = [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }];
  const p1 = m.removeFromPlaylist(0);   // k1
  const p2 = m.removeFromPlaylist(2);   // k3, queued behind; index shifts after k1 goes, so it must be found by key
  await p1; await p2;
  assert.deepEqual(m.env.calls, [{ id: 'A', index: 0 }, { id: 'A', index: 1 }]);
  assert.deepEqual(m.env.sections.map((x) => x.key), ['k2']);
});
test('movePl: found by key after an earlier removal shifted it, sent as the current index', async () => {
  const m = make();
  m.env.sections = [{ key: 'k1' }, { key: 'k2' }, { key: 'k3' }];
  const p1 = m.removeFromPlaylist(0);   // k1 gone
  const p2 = m.movePl(2, -1);           // k3 up: now index 1 -> index 0 swap with k2
  await p1; await p2;
  assert.deepEqual(m.env.calls, [{ id: 'A', index: 0 }, { id: 'A', index: 1, dir: -1 }]);
  assert.deepEqual(m.env.sections.map((x) => x.key), ['k3', 'k2']);
});
test('a queued move is also dropped after leaving and reopening', async () => {
  const m = make();
  const p1 = m.removeFromPlaylist(0);
  const p2 = m.movePl(1, -1);
  await new Promise((r) => setTimeout(r, 1));
  m.env.plGen++; m.env.plGen++;
  await p1; await p2;
  assert.equal(m.env.calls.length, 1);
});
