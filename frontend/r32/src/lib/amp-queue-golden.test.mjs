import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleTrackError, normTitle } from './amp-error-logic.mjs';

const cases = JSON.parse(readFileSync(new URL('./amp-queue-golden.json', import.meta.url)));
for (const c of cases) {
  test('golden: ' + c.name, () => {
    const queue = c.queue.map((k) => c.sections.find((x) => x.key === k));
    const now = { ...queue[c.now.qi], qi: c.now.qi, __fellBack: c.now.__fellBack };
    const got = handleTrackError({ now, sections: c.sections, queue, errStreak: c.errStreak, retried: c.retried }, c.why);
    for (const [k, v] of Object.entries(c.expect)) assert.equal(got[k], v, k);
  });
}
test('golden file has not been emptied', () => assert.ok(cases.length >= 16));
test('normTitle pins', () => {
  assert.equal(normTitle('Get Lucky (feat. Pharrell) [Remastered]'), 'get lucky');
  assert.equal(normTitle('A  B-C'), 'a b c');
  assert.equal(normTitle(undefined), '');
});
// sequence: a whole playlist run through repeated failures, as QA would drive it
test('sequence: 4 dead yt tracks in a row, no alts -> skips twice then stops with the yt message', () => {
  const sections = ['a', 'b', 'c', 'd'].map((n, i) => ({ key: 'yt:' + i, src: 'yt', title: 'song ' + n, stream: '/s/' + i }));
  let st = { now: { ...sections[0], qi: 0 }, sections, queue: sections, errStreak: 0, retried: false };
  const log = [];
  for (let step = 0; step < 6; step++) {
    const r = handleTrackError(st, { kind: 'http', status: 503, msg: '' });
    log.push(r.action);
    if (r.action !== 'skip') break;
    st = { ...st, now: { ...sections[st.now.qi + 1], qi: st.now.qi + 1 }, errStreak: r.errStreak, retried: r.retried };
  }
  assert.deepEqual(log, ['skip', 'skip', 'give-up']);
});
test('sequence: bandwidth mid-queue stops everything and keeps the streak', () => {
  const sections = [{ key: 'yt:0', src: 'yt', title: 'a', stream: '/s' }, { key: 'sc:0', src: 'sc', title: 'a', stream: '/s' }];
  const r = handleTrackError({ now: { ...sections[0], qi: 0 }, sections, queue: sections, errStreak: 1, retried: false }, { kind: 'bandwidth', msg: 'the streaming limit has been reached.' });
  assert.equal(r.action, 'show-bandwidth'); assert.equal(r.errStreak, 1);
});
