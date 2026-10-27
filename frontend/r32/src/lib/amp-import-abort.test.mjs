import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
import { importPlaylist } from './share.js';
const src = readFileSync(process.env.AMP_SVELTE || new URL('../pages/amp/Amp.svelte', import.meta.url), 'utf8');
const nm = src.slice(src.indexOf('const PL_CAP = 20;'), src.indexOf('async function createPlaylist(e)'));
const ri = src.slice(src.indexOf('async function runImport()'), src.indexOf('async function sharePlaylist()'));
assert.ok(nm.length > 100 && ri.length > 100);
const track = { src: 'yt', id: 'abcdefghijk', title: 't', artist: '', album: '', durSec: 1, key: 'yt:abcdefghijk' };
function harness({ apiFn, playlists = [] }) {
  const env = { playlists, impDecoded: { ok: true, name: 'mix', tracks: [track] }, impBusy: false, impMsg: '', impDone: 0, impTotal: 0, impCtl: null, showImport: true, impText: 'x',
    api: apiFn, errCopy: (r, f) => f, note: () => {}, loadPlaylists: async () => {}, IMP_STOP: (() => { const m = /const IMP_STOP = (\{[^\n]*\});/.exec(src); return new Function('return ' + m[1])(); })(), importPlaylist };
  const run = new Function('env', `with (env) { ${nm}\n ${ri}\n return runImport; }`)(env);
  return { env, run };
}
test('importPlaylist: an already-aborted signal makes no create call', async () => {
  const calls = []; const ac = new AbortController(); ac.abort();
  const res = await importPlaylist(async (u) => { calls.push(u); return { ok: true, status: 200, data: {} }; }, { name: 'x', tracks: [track] }, { signal: ac.signal });
  assert.equal(calls.length, 0); assert.equal(res.stopped, 'aborted');
});
test('runImport: cancel during a duplicate-name refusal makes no second create', async () => {
  const creates = [];
  let h;
  const apiFn = async (u, o) => {
    if (u.endsWith('/playlists') && o.method === 'POST') { creates.push(o.body.name); h.env.impCtl.abort(); return { ok: false, status: 400, data: { error: 'you already have one called that' } }; }
    return { ok: true, status: 200, data: {} };
  };
  h = harness({ apiFn });
  await h.run();
  assert.equal(creates.length, 1, 'only the first create went out');
});
test('runImport: duplicate name retries with the next suffix and succeeds', async () => {
  const creates = [];
  const apiFn = async (u, o) => {
    if (u.endsWith('/playlists/add')) return { ok: true, status: 200, data: {} };
    creates.push(o.body.name);
    return creates.length === 1 ? { ok: false, status: 400, data: { error: 'you already have one called that' } } : { ok: true, status: 200, data: { playlist: { id: 'p2' } } };
  };
  const h = harness({ apiFn });
  await h.run();
  assert.deepEqual(creates, ['mix', 'mix (2)']);
});
test('uniqueName: tryN forces the next suffix even when the list says the plain name is free', () => {
  const m = new Function('playlists', 'errCopy', nm + '; return { uniqueName };')([], (r, f) => f);
  assert.equal(m.uniqueName('mix', 1), 'mix'); assert.equal(m.uniqueName('mix', 2), 'mix (2)'); assert.equal(m.uniqueName('mix', 3), 'mix (3)');
});
test('runImport: a throw inside the import never leaves impBusy stuck', async () => {
  const h = harness({ apiFn: async () => { throw new Error('boom'); } });
  h.env.importPlaylist = async () => { throw new Error('boom'); };
  await h.run().catch(() => {});
  assert.equal(h.env.impBusy, false);
  assert.equal(h.env.impCtl, null);
  assert.equal(h.env.impMsg, 'import stopped. check your playlists.');
});
