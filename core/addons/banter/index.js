import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readBody } from '../../util.js';

// banter: small private chat inside ramjet. people are ramjet accounts, so
// there is no separate signup. groups join by code, dms need a friend
// request accepted. message text and images are encrypted at rest.
const DIR = fileURLToPath(new URL('../../../data/banter2', import.meta.url));
const MSGS = join(DIR, 'msgs');
const MEDIA = join(DIR, 'media');
const STATE = join(DIR, 'state.json');
const KEYF = join(DIR, 'key');
mkdirSync(MSGS, { recursive: true });
mkdirSync(MEDIA, { recursive: true });

const KEEP = 500;                    // messages kept per room
const GROUP_MAX = 30;
const IMG_MAX = 450 * 1024;
const MEDIA_DAYS = 30;

const key = (() => {
  if (existsSync(KEYF)) return Buffer.from(readFileSync(KEYF, 'utf8').trim(), 'hex');
  const k = randomBytes(32);
  writeFileSync(KEYF, k.toString('hex'), { mode: 0o600 });
  return k;
})();
const seal = (buf) => {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
};
const open = (buf) => {
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
};

let st = { rooms: {}, friends: {}, reqs: {}, reads: {}, codes: {}, seq: 1 };
try { st = { ...st, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}
const save = () => {
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, STATE);
};
const fl = (u) => (st.friends[u] ||= []);
const rq = (u) => (st.reqs[u] ||= { in: [], out: [] });
const drop = (a, v) => { const i = a.indexOf(v); if (i >= 0) a.splice(i, 1); };

// keeps the worst slurs out; ordinary swearing is fine
const BAD = /\b(n[i1!]gg(a|er)s?|f[a@]gg?[o0]ts?|k[i1]kes?|tr[a@]nn(y|ies)|ch[i1]nks?|sp[i1]cs?|wetbacks?)\b/gi;
const clean = (s, n = 2000) => String(s || '').replace(BAD, '***').trim().slice(0, n);

const logFile = (id) => join(MSGS, id + '.jsonl');
const roomCache = new Map(); // id -> { sig, rows }
function readRoom(id) {
  try {
    const stt = statSync(logFile(id));
    const sig = stt.mtimeMs + ':' + stt.size;
    const hit = roomCache.get(id);
    if (hit && hit.sig === sig) return hit.rows.map((r) => ({ ...r }));
    const rows = readRoomRaw(id);
    roomCache.set(id, { sig, rows });
    return rows.map((r) => ({ ...r }));
  } catch { return []; }
}
function readRoomRaw(id) {
  try {
    return readFileSync(logFile(id), 'utf8').split('\n').filter(Boolean).map((l) => {
      try { const r = JSON.parse(l); return { ...r, ...JSON.parse(open(Buffer.from(r.b, 'base64')).toString()), b: undefined }; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
function writeRoom(id, rows) {
  const lines = rows.slice(-KEEP).map((r) => {
    const { id: mid, from, ts, type, ...rest } = r;
    return JSON.stringify({ id: mid, from, ts, type, b: seal(Buffer.from(JSON.stringify(rest))).toString('base64') });
  });
  writeFileSync(logFile(id), lines.join('\n') + '\n');
}
function addMsg(room, from, type, body) {
  const row = { id: st.seq++, from, ts: Date.now(), type, ...body };
  const { id, from: f, ts, type: t, ...rest } = row;
  appendFileSync(logFile(room.id), JSON.stringify({ id, from: f, ts, type: t, b: seal(Buffer.from(JSON.stringify(rest))).toString('base64') }) + '\n');
  room.last = ts;
  return row;
}
const mine = (u) => Object.values(st.rooms).filter((r) => r.members.includes(u));
const other = (r, me) => r.members.find((m) => m !== me) || me;
const gifCache = new Map();
const prevOf = (m) => (!m ? '' : m.type === 'text' ? m.text : m.type === 'image' ? 'photo' : m.type === 'gif' ? 'gif' : m.type === 'poll' ? 'poll: ' + m.question : m.type === 'invite' ? 'group invite' : m.type === 'deleted' ? 'message deleted' : m.text || '');
function unreadInfo(r, me) {
  const rows = readRoom(r.id);
  const cur = ((st.reads[me] || {})[r.id]) || 0;
  const last = [...rows].reverse().find((m) => m.type !== 'note') || rows[rows.length - 1];
  return {
    unread: rows.filter((m) => m.id > cur && m.from !== me && m.type !== 'note').length,
    preview: last ? (last.from === me ? 'you: ' : (r.kind === 'group' ? last.from + ': ' : '')) + prevOf(last).slice(0, 80) : '',
  };
}
const view = (r, me) => ({
  id: r.id, kind: r.kind, title: r.kind === 'dm' ? other(r, me) : r.name, emoji: r.emoji || '',
  last: r.last || 0, owner: r.owner === me, code: r.kind === 'group' && r.members.includes(me) ? r.code : undefined,
  count: r.members.length, ...unreadInfo(r, me),
});

// media older than the window goes away; run lazily on state loads
let swept = 0;
function sweep() {
  if (Date.now() - swept < 36e5) return;
  swept = Date.now();
  for (const f of readdirSync(MEDIA)) {
    try { if (Date.now() - statSync(join(MEDIA, f)).mtimeMs > MEDIA_DAYS * 864e5) unlinkSync(join(MEDIA, f)); } catch {}
  }
}

export async function register(req, res, ctx) {
  const { sendJson, session } = ctx;
  const me = String(session && session.user || '').toLowerCase();
  if (!me) return sendJson(res, 401, { ok: false, error: 'sign in first' });
  const u = new URL(req.url, 'http://x');
  const route = u.pathname.replace(/^\/api\/(apps\/)?banter\/?/, '');
  const q = (k) => u.searchParams.get(k) || '';
  const json = (c, o) => sendJson(res, c, o);
  const body = async () => { try { return JSON.parse((await readBody(req, 900 * 1024)).toString() || '{}'); } catch { return {}; } };
  const roomFor = (id) => { const r = st.rooms[id]; return r && r.members.includes(me) ? r : null; };
  const get = req.method === 'GET', post = req.method === 'POST';

  if (get && route === 'state') {
    sweep();
    return json(200, {
      ok: true, me,
      rooms: mine(me).map((r) => view(r, me)),
      friends: fl(me), incoming: rq(me).in, outgoing: rq(me).out,
    });
  }

  if (post && route === 'group') {
    const b = await body();
    const name = clean(b.name, 40);
    if (!name) return json(400, { ok: false, error: 'give it a name' });
    if (mine(me).filter((r) => r.kind === 'group').length >= 40) return json(400, { ok: false, error: 'too many groups' });
    const id = 'g' + randomUUID().slice(0, 8);
    st.rooms[id] = { id, kind: 'group', name, emoji: String(b.emoji || '').slice(0, 8), owner: me, members: [me], code: randomBytes(3).toString('hex'), created: Date.now(), last: 0 };
    save();
    return json(200, { ok: true, room: view(st.rooms[id], me) });
  }
  if (post && route === 'join') {
    const b = await body();
    const code = String(b.code || '').trim().toLowerCase();
    const r = Object.values(st.rooms).find((x) => x.kind === 'group' && x.code === code);
    if (!r) return json(404, { ok: false, error: 'no group with that code' });
    if (!r.members.includes(me)) {
      if (r.members.length >= GROUP_MAX) return json(403, { ok: false, error: `that group is full (${GROUP_MAX})` });
      r.members.push(me);
      addMsg(r, me, 'note', { text: me + ' joined' });
      save();
    }
    return json(200, { ok: true, room: view(r, me) });
  }
  if (post && route === 'leave') {
    const r = roomFor((await body()).room);
    if (!r || r.kind !== 'group') return json(404, { ok: false, error: 'not in that group' });
    drop(r.members, me);
    if (!r.members.length) { delete st.rooms[r.id]; try { unlinkSync(logFile(r.id)); } catch {} }
    else { if (r.owner === me) r.owner = r.members[0]; addMsg(r, me, 'note', { text: me + ' left' }); }
    save();
    return json(200, { ok: true });
  }
  if (post && route === 'delete') {
    const r = roomFor((await body()).room);
    if (!r || (r.kind === 'group' && r.owner !== me)) return json(403, { ok: false, error: 'only the owner can delete a group' });
    delete st.rooms[r.id]; try { unlinkSync(logFile(r.id)); } catch {}
    save();
    return json(200, { ok: true });
  }

  // your friend code: share it instead of your username. whoever has it can send you a request,
  // and a request is all they get - nobody can message you until you accept.
  if (route === 'mycode' && (get || post)) {
    const b = post ? await body() : {};
    if (!st.codes[me] || b.reset) st.codes[me] = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    save();
    return json(200, { ok: true, code: st.codes[me] });
  }
  if (post && ['friend', 'accept', 'decline', 'unfriend', 'cancel'].includes(route)) {
    const b = await body();
    let them = String(b.user || '').trim().toLowerCase();
    if (route === 'friend' && b.code) {
      const c = String(b.code).trim().toUpperCase();
      them = Object.keys(st.codes).find((u) => st.codes[u] === c) || '';
    }
    const exists = !!them && them !== me && !!ctx.auth.users[them];
    // asking never reveals who has an account: a request to a name that does not exist looks exactly like a sent one
    if (!exists && /^[a-z0-9_.-]{2,24}$/.test(them) && them !== me && (route === 'friend' || route === 'cancel')) {
      const ao = rq(me).out;
      if (route === 'cancel') drop(ao, them);
      else if (!ao.includes(them)) { if (ao.length >= 20) return json(429, { ok: false, error: 'too many pending requests - wait for some answers' }); ao.push(them); }
      save();
      return json(200, { ok: true, sent: true });
    }
    if (route === 'friend' && !exists) return json(200, { ok: true, sent: true });
    if (!exists) return json(404, { ok: false, error: 'no one with that username' });
    const a = rq(me), t = rq(them);
    if (route === 'friend') {
      if (fl(me).includes(them)) return json(200, { ok: true, sent: true });
      if (a.in.includes(them)) { drop(a.in, them); drop(t.out, me); fl(me).push(them); fl(them).push(me); }
      else if (!a.out.includes(them)) {
        if (a.out.length >= 20) return json(429, { ok: false, error: 'too many pending requests - wait for some answers' });
        if (t.in.length >= 50) return json(200, { ok: true, sent: true });
        a.out.push(them); t.in.push(me);
      }
    } else if (route === 'cancel') { drop(a.out, them); drop(t.in, me); } else if (route === 'accept') {
      if (!a.in.includes(them)) return json(404, { ok: false, error: 'no request from them' });
      drop(a.in, them); drop(t.out, me); fl(me).push(them); fl(them).push(me);
    } else if (route === 'decline') { drop(a.in, them); drop(t.out, me); }
    else { drop(fl(me), them); drop(fl(them), me); }
    save();
    return json(200, { ok: true });
  }
  if (post && route === 'dm') {
    const them = String((await body()).user || '').trim().toLowerCase();
    if (!fl(me).includes(them)) return json(403, { ok: false, error: 'add them as a friend first' });
    let r = Object.values(st.rooms).find((x) => x.kind === 'dm' && x.members.includes(me) && x.members.includes(them));
    if (!r) {
      const id = 'd' + randomUUID().slice(0, 8);
      r = st.rooms[id] = { id, kind: 'dm', members: [me, them], created: Date.now(), last: 0 };
      save();
    }
    return json(200, { ok: true, room: view(r, me) });
  }
  if (post && route === 'invite') {
    const b = await body();
    const r = roomFor(b.room), them = String(b.user || '').toLowerCase();
    if (!r || r.kind !== 'group') return json(404, { ok: false, error: 'not in that group' });
    if (!fl(me).includes(them)) return json(403, { ok: false, error: 'friends only' });
    if (r.members.includes(them)) return json(200, { ok: true });
    let d = Object.values(st.rooms).find((x) => x.kind === 'dm' && x.members.includes(me) && x.members.includes(them));
    if (!d) { const id = 'd' + randomUUID().slice(0, 8); d = st.rooms[id] = { id, kind: 'dm', members: [me, them], created: Date.now(), last: 0 }; }
    addMsg(d, me, 'invite', { group: r.name, code: r.code });
    save();
    return json(200, { ok: true });
  }
  if (get && route === 'members') {
    const r = roomFor(q('room'));
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    return json(200, { ok: true, members: r.members.map((m) => ({ name: m, owner: r.owner === m })) });
  }

  if (post && route === 'read') {
    const b = await body();
    const r = roomFor(b.room);
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    const upto = Math.max(0, parseInt(b.upto) || 0);
    const m = (st.reads[me] ||= {});
    if ((m[r.id] || 0) < upto) { m[r.id] = upto; save(); }
    return json(200, { ok: true });
  }
  if (get && route === 'unread') {
    let n = 0;
    for (const r of mine(me)) n += unreadInfo(r, me).unread;
    return json(200, { ok: true, unread: n });
  }
  if (post && route === 'react') {
    const b = await body();
    const r = roomFor(b.room);
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    const emoji = String(b.emoji || '');
    if (!['\u2764\ufe0f', '\ud83d\ude02', '\ud83d\udc4d', '\ud83d\ude2e', '\ud83d\ude22', '\ud83d\udd25'].includes(emoji)) return json(400, { ok: false, error: 'pick one of the reactions' });
    const rows = readRoom(r.id);
    const m = rows.find((x) => x.id === Number(b.msg));
    if (!m || m.type === 'note' || m.type === 'deleted') return json(404, { ok: false, error: 'no such message' });
    const rx = (m.reacts ||= {});
    const list = (rx[emoji] ||= []);
    const i = list.indexOf(me);
    if (i >= 0) list.splice(i, 1); else list.push(me);
    if (!list.length) delete rx[emoji];
    if (!Object.keys(rx).length) delete m.reacts;
    writeRoom(r.id, rows);
    return json(200, { ok: true });
  }
  if (post && route === 'delmsg') {
    const b = await body();
    const r = roomFor(b.room);
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    const rows = readRoom(r.id);
    const m = rows.find((x) => x.id === Number(b.msg));
    if (!m) return json(404, { ok: false, error: 'no such message' });
    if (m.from !== me) return json(403, { ok: false, error: 'you can only delete your own messages' });
    if (m.type === 'note' || m.type === 'deleted') return json(400, { ok: false, error: 'cannot delete that' });
    if (m.media) { try { unlinkSync(join(MEDIA, m.media)); } catch {} }
    const i = rows.indexOf(m);
    rows[i] = { id: m.id, from: m.from, ts: m.ts, type: 'deleted' };
    writeRoom(r.id, rows);
    return json(200, { ok: true });
  }

  if (post && route === 'editmsg') {
    const b = await body();
    const r = roomFor(b.room);
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    const rows = readRoom(r.id);
    const m = rows.find((x) => x.id === Number(b.msg));
    if (!m) return json(404, { ok: false, error: 'no such message' });
    if (m.from !== me) return json(403, { ok: false, error: 'you can only edit your own messages' });
    if (m.type !== 'text') return json(400, { ok: false, error: 'only text messages can be edited' });
    const text = clean(b.text);
    if (!text) return json(400, { ok: false, error: 'empty message' });
    rows[rows.indexOf(m)] = { ...m, text, edited: true };
    writeRoom(r.id, rows);
    return json(200, { ok: true });
  }

  if (get && route === 'msgs') {
    const r = roomFor(q('room'));
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    const after = parseInt(q('after')) || 0;
    const all = readRoom(r.id);
    // deletions/votes change old rows: clients ask for a full reload when they need it (after=0)
    return json(200, { ok: true, msgs: all.filter((m) => m.id > after) });
  }
  if (post && route === 'msg') {
    const b = await body();
    const r = roomFor(b.room);
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    let row;
    if (b.type === 'text') {
      const text = clean(b.text);
      if (!text) return json(400, { ok: false, error: 'empty message' });
      row = ['text', { text }];
    } else if (b.type === 'poll') {
      const options = (Array.isArray(b.options) ? b.options : []).map((o) => clean(o, 40)).filter(Boolean).slice(0, 6);
      const question = clean(b.question, 120);
      if (!question || options.length < 2) return json(400, { ok: false, error: 'a question and two options' });
      row = ['poll', { question, options, votes: {} }];
    } else if (b.type === 'gif') {
      const url = String(b.url || '');
      if (!/^https:\/\/[a-z0-9.-]*tenor\.com\//.test(url) || url.length > 300) return json(400, { ok: false, error: 'bad gif' });
      row = ['gif', { url }];
    } else if (b.type === 'image') {
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!buf.length || buf.length > IMG_MAX) return json(413, { ok: false, error: 'image too big' });
      const mid = randomBytes(10).toString('hex');
      writeFileSync(join(MEDIA, mid), seal(buf));
      row = ['image', { media: mid }];
    } else return json(400, { ok: false, error: 'unknown message type' });
    if (b.reply) {
      const ref = readRoom(r.id).find((x) => x.id === Number(b.reply));
      if (ref && ref.type !== 'note') row[1].reply = { id: ref.id, from: ref.from, text: prevOf(ref).slice(0, 70) };
    }
    const m = addMsg(r, me, row[0], row[1]);
    save();
    return json(200, { ok: true, id: m.id });
  }
  if (post && route === 'vote') {
    const b = await body();
    const r = roomFor(b.room);
    if (!r) return json(403, { ok: false, error: 'not in that room' });
    const rows = readRoom(r.id);
    const m = rows.find((x) => x.id === b.msg && x.type === 'poll');
    if (!m) return json(404, { ok: false, error: 'no such poll' });
    const o = Number(b.option);
    if (!Number.isInteger(o) || o < 0 || o >= m.options.length) return json(400, { ok: false, error: 'bad option' });
    m.votes[me] = o;
    writeRoom(r.id, rows);
    return json(200, { ok: true });
  }
  if (get && route === 'media') {
    const mid = q('id');
    if (!/^[a-f0-9]{20}$/.test(mid)) return json(400, { ok: false, error: 'bad id' });
    const owns = mine(me).some((r) => readRoom(r.id).some((m) => m.media === mid));
    if (!owns) return json(404, { ok: false, error: 'gone' });
    try {
      res.writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400' });
      return res.end(open(readFileSync(join(MEDIA, mid))));
    } catch { return json(404, { ok: false, error: 'gone' }); }
  }

  if (get && route === 'gifsearch') {
    const term = q('q').trim().slice(0, 60);
    if (!term) return json(200, { ok: true, gifs: [] });
    try {
      // tenor's keyed API was shut down; the public search page lists the same gifs with no key
      const ck = gifCache.get(term.toLowerCase());
      let gifs = ck && Date.now() - ck.at < 600000 ? ck.gifs : null;
      if (!gifs) {
        const r = await fetch('https://tenor.com/search/' + encodeURIComponent(term.toLowerCase().replace(/\s+/g, '-')) + '-gifs', { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'accept-language': 'en' }, signal: AbortSignal.timeout(10000) });
        const html = await r.text();
        const seen = new Set(); gifs = [];
        for (const m of html.matchAll(/https:\/\/media\.tenor\.com\/([A-Za-z0-9_-]+?)AAAAM\/([A-Za-z0-9_-]+)\.gif/g)) {
          if (seen.has(m[1])) continue; seen.add(m[1]);
          gifs.push({ tiny: 'https://media.tenor.com/' + m[1] + 'AAAAS/' + m[2] + '.gif', full: m[0] });
          if (gifs.length >= 18) break;
        }
        if (gifs.length) gifCache.set(term.toLowerCase(), { at: Date.now(), gifs });
        if (gifCache.size > 200) gifCache.delete(gifCache.keys().next().value);
      }
      return json(200, { ok: true, gifs });
    } catch { return json(502, { ok: false, error: 'gif search is down' }); }
  }
  if (get && route === 'gifimg') {
    const url = q('u');
    if (!/^https:\/\/[a-z0-9.-]*tenor\.com\//.test(url)) return json(400, { ok: false, error: 'bad url' });
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) return json(502, { ok: false, error: 'gif fetch failed' });
      const buf = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'image/gif', 'cache-control': 'public, max-age=86400' });
      return res.end(buf);
    } catch { return json(502, { ok: false, error: 'gif fetch failed' }); }
  }

  return json(404, { ok: false, error: 'not found' });
}
