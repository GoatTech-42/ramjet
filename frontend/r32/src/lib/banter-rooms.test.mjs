// room-isolation coverage for banter: an async response started in one room session must never
// paint another. the real component script is evaluated with stubbed browser surface (the same
// extraction idiom as the browse tests); the api layer is a deferred-promise fake so the exact
// interleavings - A->B, A->B->A, close-pending, cross-room reload - are driven deterministically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (apiImpl) => {
  const src = readFileSync(new URL('../pages/banter/Banter.svelte', import.meta.url), 'utf8');
  const script = src.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .*;\n/gm, '')
    .replace(/\$state\(/g, '(')
    .replace(/\$derived\(/g, '(')
    .replace(/\$effect\(/g, 'stubEffect(');
  assert.ok(!script.includes('$state') && !script.includes('$derived') && !script.includes('$effect'), 'runes stripped');
  const suffix = '\n;return { openRoom, closeRoom, pull, reloadAll, markRead, loadState, leaveGroup, delRoom, sendText, startEdit, startReply, pickPhoto, react, delMsg, vote, inviteTo, gifInput, sendPoll, showGroup, get: { get cur() { return cur; }, get msgs() { return msgs; }, get lastId() { return lastId; }, get rooms() { return rooms; }, get readSent() { return readSent; }, get composer() { return composer; }, get replyTo() { return replyTo; }, get sheetErr() { return sheetErr; }, get err() { return err; }, get sheet() { return sheet; }, get gifs() { return gifs; }, get members() { return members; }, get pollQ() { return pollQ; } }, set: { rooms(v) { rooms = v; }, loaded(v) { loaded = v; }, deferred(v) { deferred = v; }, composer(v) { composer = v; }, sheet(v) { sheet = v; }, gifQ(v) { gifQ = v; }, pollQ(v) { pollQ = v; }, pollOpts(v) { pollOpts = v; } } };';
  let mountFn = null;
  const comp = new Function('onMount', 'tick', 'api', 'errCopy', 'stubEffect', 'location', 'history', 'document', 'window', 'navigator', 'confirm', 'createImageBitmap', script + suffix)(
    (fn) => { mountFn = fn; }, async () => {}, apiImpl, (r, m) => m, () => {},
    { pathname: '/banter', hash: '' }, { replaceState: () => {} },
    { createElement: () => ({ getContext: () => ({ drawImage: () => {} }), toDataURL: () => 'data:image/webp;base64,xxxx' }), querySelector: () => null, head: { appendChild: () => {} } },
    { innerWidth: 800, innerHeight: 600 }, {}, () => true, async () => ({ width: 100, height: 100 })
  );
  comp.__runMount = () => (mountFn ? mountFn() : undefined);
  return comp;
};

const defer = () => { let res, rej; const p = new Promise((r, j) => { res = r; rej = j; }); return { p, res, rej }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const m = (id, from, text) => ({ id, from, type: 'text', text: text || ('msg ' + id) });
const room = (id) => ({ id, title: 'room ' + id, kind: 'group', unread: 0, last: id });

const harness = () => {
  const calls = [];
  const api = (path, opts) => { const d = defer(); calls.push({ path, opts, ...d }); return d.p; };
  const c = load(api);
  const lastCall = (frag) => { for (let i = calls.length - 1; i >= 0; i--) if (calls[i].path.includes(frag)) return calls[i]; return null; };
  return { c, calls, lastCall };
};
const okMsgs = (msgs) => ({ ok: true, data: { msgs } });

test('a stale pull from the previous room cannot paint the new room (A->B)', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  c.openRoom(room(2));
  assert.equal(calls.length, 2);
  assert.ok(calls[0].path.includes('room=1') && calls[1].path.includes('room=2'));
  calls[0].res(okMsgs([m(11, 'x', 'old a')])); // A's pull lands while B is open
  await flush();
  assert.deepEqual(c.get.msgs, [], "A's late reply did not reach B's screen");
  assert.equal(c.get.lastId, 0, "B's cursor was not moved by A's reply");
  calls[1].res(okMsgs([m(21, 'y', 'b hey')]));
  await flush();
  assert.equal(c.get.msgs.length, 1);
  assert.equal(c.get.msgs[0].text, 'b hey');
  assert.equal(c.get.lastId, 21);
});

test('a stale pull from a previous session of the same room is discarded (A->B->A)', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1)); // first A session
  c.openRoom(room(2));
  c.openRoom(room(1)); // back to A: new session, fresh cursor
  assert.equal(calls.length, 3);
  calls[0].res(okMsgs([m(99, 'x', 'first-session a')]));
  await flush();
  assert.deepEqual(c.get.msgs, [], "the first A session's reply did not append to the new A session");
  assert.equal(c.get.lastId, 0, "the new session's cursor was not clobbered");
  calls[2].res(okMsgs([m(31, 'z', 'current a')]));
  await flush();
  assert.equal(c.get.msgs.length, 1);
  assert.equal(c.get.msgs[0].text, 'current a');
  assert.equal(c.get.lastId, 31);
});

test('a pull in flight when the room closes is discarded', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  c.closeRoom();
  calls[0].res(okMsgs([m(41, 'x', 'too late')]));
  await flush();
  assert.equal(c.get.cur, null);
  assert.deepEqual(c.get.msgs, []);
});

test('a reload started in one room cannot replace another room\'s messages', async () => {
  const { c, calls, lastCall } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x'), m(2, 'y')]));
  await flush();
  assert.equal(c.get.lastId, 2);
  c.reloadAll(); // full refresh of A in flight...
  const reload = lastCall('after=0');
  assert.ok(reload && reload !== calls[0]);
  c.openRoom(room(2)); // ...but the user moves to B before it lands
  reload.res(okMsgs([m(3, 'x'), m(4, 'y'), m(5, 'z'), m(6, 'w'), m(7, 'v')]));
  await flush();
  assert.deepEqual(c.get.msgs, [], "A's reload did not paint B's screen");
  assert.equal(c.get.lastId, 0, "B's cursor was not moved by A's reload");
  lastCall('room=2').res(okMsgs([m(8, 'b')]));
  await flush();
  assert.equal(c.get.msgs.length, 1);
  assert.equal(c.get.lastId, 8);
});

test('a valid empty reload clears the cursor', async () => {
  const { c, calls, lastCall } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x'), m(2, 'y')]));
  await flush();
  assert.equal(c.get.lastId, 2);
  c.reloadAll();
  lastCall('after=0').res(okMsgs([])); // the room genuinely has no messages now
  await flush();
  assert.deepEqual(c.get.msgs, []);
  assert.equal(c.get.lastId, 0, 'the cursor resets with a valid empty reload');
});

test('reloadAll with no room open is a safe no-op', async () => {
  const { c, calls } = harness();
  const n = calls.length;
  await c.reloadAll();
  assert.equal(calls.length, n, 'no request was issued');
  assert.deepEqual(c.get.msgs, []);
});

test('normal polling still appends, advances the cursor and marks read', async () => {
  const { c, calls, lastCall } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  assert.equal(c.get.lastId, 1);
  const read = lastCall('read');
  assert.ok(read && read.opts.body.room === 1 && read.opts.body.upto === 1, 'the visible tail was marked read');
  c.pull(false); // the poll interval's incremental pull
  const poll = calls[calls.length - 1];
  assert.ok(poll.path.includes('room=1') && poll.path.includes('after=1'), 'incremental pull starts from the cursor');
  poll.res(okMsgs([m(2, 'y')]));
  await flush();
  assert.equal(c.get.msgs.length, 2);
  assert.equal(c.get.lastId, 2);
});

test('a failed pull leaves the room state untouched', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res({ ok: false, status: 500, data: {} });
  await flush();
  assert.deepEqual(c.get.msgs, []);
  assert.equal(c.get.lastId, 0);
});

test('leaving room A while its request is in flight does not close room B', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.leaveGroup(); // confirmed; the leave request for A is in flight
  const leave = calls[calls.length - 1];
  assert.ok(leave.path.includes('leave'));
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  leave.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.cur && c.get.cur.id, 2, 'the new room stayed open - the late leave closed only A');
  assert.equal(c.get.msgs.length, 1);
  assert.equal(c.get.msgs[0].text, 'msg 7');
});

test('deleting room A while its request is in flight does not close room B', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.delRoom();
  const del = calls[calls.length - 1];
  assert.ok(del.path.includes('delete'));
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  del.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.cur && c.get.cur.id, 2);
  assert.equal(c.get.msgs.length, 1);
});

test('a failed send restores the draft only in the session it was written in', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.set.composer('draft for A');
  c.sendText();
  const send = calls[calls.length - 1];
  assert.ok(send.path.includes('msg'));
  assert.equal(c.get.composer, '', 'composer cleared optimistically');
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  send.res({ ok: false, status: 500, data: {} });
  await flush();
  assert.notEqual(c.get.composer, 'draft for A', "A's failed draft was not stuffed into B's composer");
});

test('a failed send in the same session still restores the draft', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.set.composer('keep me');
  c.sendText();
  calls[calls.length - 1].res({ ok: false, status: 500, data: {} });
  await flush();
  assert.equal(c.get.composer, 'keep me');
});

test('two overlapping same-session pulls never duplicate a message', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  c.pull(false); // both pulls asked from cursor 0
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  calls[1].res(okMsgs([m(1, 'x')])); // the same tail arrives twice
  await flush();
  assert.equal(c.get.msgs.length, 1, 'no duplicate appended');
  assert.equal(c.get.lastId, 1);
});

test('a late full reload cannot roll back newer messages or the cursor', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x'), m(2, 'y'), m(3, 'z'), m(4, 'w'), m(5, 'v')]));
  await flush();
  c.reloadAll(); // the slow full refresh, asked first...
  const reload = calls[calls.length - 1];
  c.pull(false); // ...but a newer incremental pull lands first
  const pull = calls[calls.length - 1];
  pull.res(okMsgs([m(6, 'new')]));
  await flush();
  assert.equal(c.get.lastId, 6);
  reload.res(okMsgs([m(1, 'x'), m(2, 'y'), m(3, 'z'), m(4, 'w'), m(5, 'v')])); // the stale full list arrives late
  await flush();
  assert.equal(c.get.msgs.length, 6, 'the newer message survived');
  assert.equal(c.get.msgs[5].text, 'msg 6');
  assert.equal(c.get.lastId, 6, 'the cursor did not move backwards');
});

test('the normal poll overlap still applies the reload when it is newest', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.pull(false); // the interval fires pull then reload without awaiting
  c.reloadAll();
  const pull = calls[calls.length - 2], reload = calls[calls.length - 1];
  pull.res(okMsgs([m(2, 'y')]));
  reload.res(okMsgs([m(1, 'x'), m(2, 'y'), m(3, 'z')])); // full state, asked last, lands last
  await flush();
  assert.equal(c.get.msgs.length, 3, 'the newer full state won');
  assert.equal(c.get.lastId, 3);
});

test('a state refresh that drops the open room ends its session', async () => {
  const { c, calls, lastCall } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.pull(false); // in flight
  const pending = calls[calls.length - 1];
  c.loadState();
  lastCall('state').res({ ok: true, data: { me: 'me', rooms: [], friends: [], incoming: [], outgoing: [] } });
  await flush();
  assert.equal(c.get.cur, null, 'the dropped room closed');
  assert.deepEqual(c.get.msgs, [], 'the view reset with the drop');
  assert.equal(c.get.lastId, 0);
  pending.res(okMsgs([m(2, 'stale')]));
  await flush();
  assert.deepEqual(c.get.msgs, [], 'the pull from the interrupted session was discarded');
  assert.equal(c.get.lastId, 0);
  c.openRoom(room(1)); // the user reopens it: a genuinely fresh session
  calls[calls.length - 1].res(okMsgs([m(5, 'fresh')]));
  await flush();
  assert.equal(c.get.msgs.length, 1);
  assert.equal(c.get.msgs[0].text, 'msg 5', 'only the new session paints');
  assert.equal(c.get.lastId, 5);
});

test('a mutation follow-up reload targets its origin room, not wherever the user is now', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.react(m(1, 'x'), '❤️');
  const react = calls[calls.length - 1];
  assert.ok(react.path.includes('react'));
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  const before = calls.filter((x) => x.path.includes('room=2&after=0')).length; // B's own open pull
  react.res({ ok: true, data: {} });
  await flush();
  const stray = calls.filter((x) => x.path.includes('room=2&after=0')).length - before;
  assert.equal(stray, 0, "A's reaction triggered no full reload of B");
  assert.equal(c.get.msgs.length, 1, "B's list was not replaced");
});

test('a failed leave after A->B->A closes nothing - the new A session stays', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  c.leaveGroup(); // leave request for A in flight
  const leave = calls[calls.length - 1];
  assert.ok(leave.path.includes('leave'));
  c.openRoom(room(2));
  c.openRoom(room(1)); // back to A: a new session
  leave.res({ ok: false, status: 500, data: {} });
  await flush();
  assert.equal(c.get.cur && c.get.cur.id, 1, 'the failed leave closed nothing');
});

test('a successful leave after A->B->A still closes nothing - only the list refreshes', async () => {
  const { c, calls, lastCall } = harness();
  c.openRoom(room(1));
  c.leaveGroup();
  const leave = calls[calls.length - 1];
  c.openRoom(room(2));
  c.openRoom(room(1));
  leave.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.cur && c.get.cur.id, 1, 'the new A session survived the late success');
  assert.ok(lastCall('state'), 'the room list refreshed instead');
});

test('a failed delete after A->B->A closes nothing', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  c.delRoom();
  const del = calls[calls.length - 1];
  assert.ok(del.path.includes('delete'));
  c.openRoom(room(2));
  c.openRoom(room(1));
  del.res({ ok: false, status: 500, data: {} });
  await flush();
  assert.equal(c.get.cur && c.get.cur.id, 1);
});

test('an edit started in room A cannot be submitted into room B', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(11, 'x', 'A secret')]));
  await flush();
  c.startEdit(m(11, 'x', 'A secret'));
  assert.equal(c.get.composer, 'A secret');
  c.openRoom(room(2));
  assert.equal(c.get.composer, '', 'the edit draft did not follow into B');
  c.set.composer('B text');
  c.sendText();
  const req = calls[calls.length - 1];
  assert.ok(!req.path.includes('editmsg'), 'a plain send, not an edit');
  assert.equal(req.opts.body.room, 2);
  assert.equal(req.opts.body.text, 'B text');
  assert.equal(req.opts.body.msg, undefined, "no message id - A's edit target did not leak");
});

test('an unsent draft does not follow into the next room', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.set.composer('A draft');
  c.openRoom(room(2));
  assert.equal(c.get.composer, '');
});

test('unmounting the view invalidates in-flight responses', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  c.pull(false);
  const cleanup = c.__runMount(); // mount body: starts the interval, returns the destroy cleanup
  cleanup(); // destroy
  calls[0].res(okMsgs([m(1, 'x')]));
  calls[1].res(okMsgs([m(2, 'y')]));
  await flush();
  assert.deepEqual(c.get.msgs, [], 'nothing painted after destroy');
  assert.equal(c.get.lastId, 0);
});

test("a stale send success does not clear the new room's reply reference", async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.set.composer('A text');
  c.sendText();
  const send = calls[calls.length - 1];
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(22, 'B', 'B reply')]));
  await flush();
  c.startReply(m(22, 'B', 'B reply'));
  assert.equal(c.get.replyTo && c.get.replyTo.id, 22);
  send.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.replyTo && c.get.replyTo.id, 22, "B's reply reference survived A's late success");
});

test("a same-session send success still clears its own reply reference", async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(5, 'x')]));
  await flush();
  c.startReply(m(5, 'x'));
  c.set.composer('reply text');
  c.sendText();
  const send = calls[calls.length - 1];
  assert.equal(send.opts.body.reply, 5, 'the reply reference rode the send');
  send.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.replyTo, null);
});

test('a photo picked in room A is aborted, not redirected, when the room changes mid-decode', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  const picking = c.pickPhoto({ target: { files: [{}], value: 'x' } }); // decode in flight
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  await picking;
  await flush();
  const photos = calls.filter((x) => x.opts && x.opts.body && x.opts.body.type === 'image');
  assert.equal(photos.length, 0, 'the photo was not posted anywhere - not to B, not back to A');
  assert.equal(c.get.err, "room changed - the photo wasn't sent.");
});

test('a failed leave writes the sheet error only in its origin session, the banner elsewhere', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.leaveGroup();
  const leave = calls[calls.length - 1];
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  leave.res({ ok: false, status: 500, data: {} });
  await flush();
  assert.equal(c.get.sheetErr, '', "no sheet status write into B's view");
  assert.equal(c.get.err, 'failed', 'the global banner carries the late failure');
});

test('a failed leave in its own session writes the sheet error there', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.leaveGroup();
  calls[calls.length - 1].res({ ok: false, status: 500, data: {} });
  await flush();
  assert.equal(c.get.sheetErr, 'failed');
  assert.equal(c.get.cur && c.get.cur.id, 1, 'the room stayed open');
});

test('a late leave success does not dismiss the sheet open in the new room', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.leaveGroup();
  const leave = calls[calls.length - 1];
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  await flush();
  c.set.sheet('group');
  leave.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.sheet, 'group', "B's sheet survived A's late leave success");
  assert.equal(c.get.cur && c.get.cur.id, 2, 'still in B');
});

test('a late delete success does not dismiss the sheet open in the new room', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.delRoom();
  const del = calls[calls.length - 1];
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  await flush();
  c.set.sheet('group');
  del.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.sheet, 'group');
  assert.equal(c.get.cur && c.get.cur.id, 2);
});

test('a same-session leave success still dismisses its sheet and closes the room', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.set.sheet('group');
  c.leaveGroup();
  calls[calls.length - 1].res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.sheet, '');
  assert.equal(c.get.cur, null, 'the room closed');
});

test('a late invite result writes the banner, not the new room\'s sheet status', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.inviteTo('sam');
  const invite = calls[calls.length - 1];
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  invite.res({ ok: false, status: 500, data: {} });
  await flush();
  assert.equal(c.get.sheetErr, '', "no sheet status write into B's view");
  assert.equal(c.get.err, 'failed');
});

test('a same-session invite result still writes the sheet status there', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.inviteTo('sam');
  calls[calls.length - 1].res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.sheetErr, 'invite sent to sam');
});

test('a gif search started in room A drops its results after the room changes', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.set.gifQ('cats');
  c.gifInput();
  await new Promise((r) => setTimeout(r, 400));
  const search = calls[calls.length - 1];
  assert.ok(search.path.includes('gifsearch'), 'the search fired');
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  search.res({ ok: true, data: { gifs: [{ full: 'g1' }] } });
  await flush();
  assert.equal(c.get.gifs.length, 0, "A's results never painted into B");
});

test('a poll sent from room A does not clear the poll draft started in room B', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.set.pollQ('A question');
  c.set.pollOpts(['one', 'two']);
  c.sendPoll();
  const send = calls[calls.length - 1];
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  await flush();
  c.set.pollQ('B draft');
  send.res({ ok: true, data: {} });
  await flush();
  assert.equal(c.get.pollQ, 'B draft', "B's poll draft survived A's late success");
});

test('a members reply for room A does not open the group sheet in room B', async () => {
  const { c, calls } = harness();
  c.openRoom(room(1));
  calls[0].res(okMsgs([m(1, 'x')]));
  await flush();
  c.showGroup();
  const mem = calls[calls.length - 1];
  assert.ok(mem.path.includes('members'));
  c.openRoom(room(2));
  calls[calls.length - 1].res(okMsgs([m(7, 'b')]));
  mem.res({ ok: true, data: { members: ['luke', 'a'] } });
  await flush();
  assert.equal(c.get.sheet, '', "A's stale members reply opened nothing in B");
  assert.equal(c.get.members.length, 0, "A's member list never painted into B");
});
