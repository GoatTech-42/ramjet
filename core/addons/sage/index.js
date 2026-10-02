// sage: ask an AI anything in a clean conversation. the browser never
// talks to the model provider - ramjet relays each turn server-side, so
// the shape of the network stays the same as every other ramjet call.
// provider: pollinations.ai's free openai-compatible endpoint (no key,
// no account). a server-side config can later point the same relay at
// groq with a key for heavier answers - the route does not change.

import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from '../../util.js';

const MAX_TURNS = 40;
const MAX_CHARS = 4000;

// conversations: per-account, so a chat started on the phone is there on
// the laptop. titles come from the first user message; capped small.
const CONV_FILE = fileURLToPath(new URL('../../../data/sage-conversations.json', import.meta.url));
const MAX_CONVS = 20;
const MAX_CONV_MSGS = 100;

function loadConvs() { return readJson(CONV_FILE, {}); }
function userConvs(user) {
  const all = loadConvs();
  return Array.isArray(all[user]) ? all[user] : [];
}
function saveUserConvs(user, list) {
  const all = loadConvs();
  all[user] = list;
  writeJson(CONV_FILE, all);
}
function cleanMessages(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const m of input.slice(0, MAX_CONV_MSGS)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const content = String(m.content || '');
    if (content.length > MAX_CHARS || !content.trim()) continue;
    out.push({ role: m.role, content });
  }
  return out;
}

// provider chain: drop data/sage-provider.json on the box
// ({ "base": "https://api.groq.com/openai/v1", "model": "...", "key": "..." })
// and sage talks to any openai-compatible api with that key instead. no
// file = pollinations.ai's free keyless endpoint (daily anonymous quota).
const CONF = fileURLToPath(new URL('../../../data/sage-provider.json', import.meta.url));

function provider() {
  try {
    if (existsSync(CONF)) {
      const c = JSON.parse(readFileSync(CONF, 'utf8'));
      if (c.base && c.key) {
        return { url: String(c.base).replace(/\/+$/, '') + '/chat/completions', model: c.model || 'openai/gpt-oss-120b', key: c.key };
      }
    }
  } catch {}
  return { url: 'https://text.pollinations.ai/', model: 'openai', key: '' };
}

// sage's voice: a knowledgeable friend, not a corporate assistant
const SYSTEM = {
  role: 'system',
  content: 'You are sage, the assistant inside ramjet. Answer directly and plainly, like a smart friend - no corporate filler, no "as an AI". Short answers for short questions; longer only when the question needs it. Plain text, minimal markdown.',
};

// answer length the user picks in the app: brief / normal / deep
const STYLES = {
  brief: ' Keep every answer to a few sentences at most unless asked for more.',
  deep: ' Go thorough: explain the reasoning, give examples, and cover edge cases.',
};
const sysFor = (body) => {
  const extra = STYLES[String(body?.style || '')];
  return extra ? { role: 'system', content: SYSTEM.content + extra } : SYSTEM;
};

export async function register(req, res, ctx) {
  const { sendJson, guard, session, readBody } = ctx;
  const sub = req.url.split('?')[0].replace(/^\/api\/apps\/sage/, '') || '/';

  if (sub === '/chat' && req.method === 'POST') {
    let body;
    try { body = JSON.parse((await readBody(req)).toString() || '{}'); }
    catch { return sendJson(res, 400, { ok: false, error: 'bad request' }); }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length || messages.length > MAX_TURNS) return sendJson(res, 400, { ok: false, error: 'bad conversation' });
    const clean = [];
    for (const m of messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
      const content = String(m.content || '');
      if (content.length > MAX_CHARS) return sendJson(res, 400, { ok: false, error: 'keep messages under 4,000 characters' });
      if (content.trim()) clean.push({ role: m.role, content });
    }
    if (!clean.length || clean[clean.length - 1].role !== 'user') {
      return sendJson(res, 400, { ok: false, error: 'bad conversation' });
    }
    const p = provider();
    // streamed path (keyed provider): relay tokens as they arrive so the
    // reply types out instead of landing all at once.
    if (body.stream && p.key) {
      let up;
      try {
        up = await fetch(p.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + p.key },
          body: JSON.stringify({ messages: [sysFor(body), ...clean], model: p.model, max_tokens: 2048, temperature: 0.7, stream: true }),
          signal: AbortSignal.timeout(90000),
        });
      } catch { up = null; }
      if (!up || !up.ok || !up.body) {
        if (up) console.error('sage stream upstream', up.status);
        if (up && up.status === 402) return sendJson(res, 502, { ok: false, error: "sage is resting - the free model hit its daily limit, back soon" });
        if (up && up.status === 429) { const w = Math.min(120, Math.max(1, Math.ceil(parseFloat(up.headers.get('retry-after')) || 10))); return sendJson(res, 429, { ok: false, error: 'sage is busy right now - give it about ' + w + ' seconds' }); }
        return sendJson(res, 502, { ok: false, error: "couldn't reach the model - try again" });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      let total = 0, buf = '', sent = false;
      const out = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      req.on('close', () => { try { up.body.cancel(); } catch {} });
      try {
        const dec = new TextDecoder();
        for await (const chunk of up.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const d = line.slice(5).trim();
            if (d === '[DONE]') continue;
            try {
              const t = JSON.parse(d).choices?.[0]?.delta?.content;
              if (t) { total += t.length; sent = true; out({ t }); }
            } catch {}
          }
        }
      } catch { /* cut mid-reply: fall through and tell the client */ }
      guard.trackBytes(session.user, total);
      out(sent ? { done: true } : { error: 'the model said nothing - try again' });
      return res.end();
    }
    const payload = p.key
      ? { messages: [sysFor(body), ...clean], model: p.model, max_tokens: 2048, temperature: 0.7 }
      : { messages: [sysFor(body), ...clean], model: p.model, private: true };
    // the free provider flakes occasionally - one quiet retry before
    // the user ever hears about it
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(p.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(p.key ? { authorization: 'Bearer ' + p.key } : {}) },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) {
          const detail = (await r.text().catch(() => '')).slice(0, 200);
          console.error('sage upstream', r.status, detail);
          // 402 = the anonymous daily quota is spent; retrying changes nothing
          if (r.status === 429) { const w = Math.min(120, Math.max(1, Math.ceil(parseFloat(r.headers.get('retry-after')) || 10))); return sendJson(res, 429, { ok: false, error: 'sage is busy right now - give it about ' + w + ' seconds' }); }
          if (r.status === 402) return sendJson(res, 502, { ok: false, error: "sage is resting - the free model hit its daily limit, back soon" });
          if (attempt === 0) { await new Promise((d) => setTimeout(d, 1200)); continue; }
          return sendJson(res, 502, { ok: false, error: "couldn't reach the model - try again" });
        }
        let reply = '';
        const raw = (await r.text()).trim();
        if (p.key) {
          try { reply = JSON.parse(raw).choices?.[0]?.message?.content?.trim() || ''; } catch {}
        } else reply = raw;
        if (!reply) return sendJson(res, 502, { ok: false, error: 'the model said nothing - try again' });
        guard.trackBytes(session.user, reply.length);
        return sendJson(res, 200, { ok: true, reply });
      } catch {
        if (attempt === 0) { await new Promise((d) => setTimeout(d, 1200)); continue; }
        return sendJson(res, 502, { ok: false, error: "couldn't reach the model - try again" });
      }
    }
  }

  if (sub === '/conversations' && req.method === 'GET') {
    const list = userConvs(session.user);
    return sendJson(res, 200, {
      ok: true,
      conversations: list.map((c) => ({ id: c.id, title: c.title, count: c.messages.length, at: c.at })),
    });
  }

  if (sub === '/conversations/messages' && req.method === 'GET') {
    const id = (ctx.url.searchParams.get('id') || '').trim();
    const conv = userConvs(session.user).find((c) => c.id === id);
    if (!conv) return sendJson(res, 404, { ok: false, error: 'that conversation is gone' });
    return sendJson(res, 200, { ok: true, conversation: { id: conv.id, title: conv.title, messages: conv.messages } });
  }

  if (sub === '/conversations' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const messages = cleanMessages(body.messages);
    if (!messages || !messages.length) return sendJson(res, 400, { ok: false, error: 'nothing to save yet' });
    const list = userConvs(session.user);
    const firstUser = messages.find((m) => m.role === 'user');
    const title = String(firstUser?.content || 'conversation').replace(/\s+/g, ' ').trim().slice(0, 60);
    const id = /^[0-9a-f]{8}$/.test(String(body.id || '')) ? String(body.id) : randomBytes(4).toString('hex');
    const existing = list.find((c) => c.id === id);
    if (existing) {
      existing.messages = messages;
      if (!existing.custom) existing.title = title;
      existing.at = Date.now();
    } else {
      list.unshift({ id, title, messages, at: Date.now() });
    }
    list.sort((a, b) => b.at - a.at);
    saveUserConvs(session.user, list.slice(0, MAX_CONVS));
    return sendJson(res, 200, { ok: true, id });
  }

  if (sub === '/conversations/delete' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const list = userConvs(session.user);
    const kept = list.filter((c) => c.id !== String(body.id || ''));
    if (kept.length === list.length) return sendJson(res, 404, { ok: false, error: 'that conversation is gone' });
    saveUserConvs(session.user, kept);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/conversations/rename' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString('utf8') || '{}'); } catch {}
    const title = String(body.title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!title) return sendJson(res, 400, { ok: false, error: 'give it a name' });
    const list = userConvs(session.user);
    const c = list.find((x) => x.id === String(body.id || ''));
    if (!c) return sendJson(res, 404, { ok: false, error: 'that conversation is gone' });
    c.title = title; c.custom = true;
    saveUserConvs(session.user, list);
    return sendJson(res, 200, { ok: true });
  }

  if (sub === '/conversations/clear' && req.method === 'POST') {
    saveUserConvs(session.user, []);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { ok: false, error: 'unknown sage call' });
}
