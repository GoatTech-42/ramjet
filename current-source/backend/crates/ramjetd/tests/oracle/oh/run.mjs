// usage: node run.mjs scenarios.json golden.json  (env ORACLE_DATA set by caller)
import fs from 'node:fs';
import crypto from 'node:crypto';
const fx = JSON.parse(fs.readFileSync('/tmp/oracle2/fixtures.json', 'utf8'));
const scen = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const DATA = process.env.ORACLE_DATA;
let NOW = 0;
Date.now = () => NOW;
let calls = [];
const canon = (o) => JSON.stringify(sortKeys(o));
function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])); return v; }
globalThis.fetch = async (url, opts = {}) => {
  let key;
  if (opts.method === 'POST' && /youtubei\/v1\//.test(url)) {
    const ep = /v1\/([a-z]+)\?/.exec(url)[1];
    const b = JSON.parse(opts.body); const ctx = b.context; delete b.context;
    key = `IT|${ctx.client.clientName === 'WEB' ? 'web' : 'android'}|${ep}|${canon(b)}`;
  } else key = 'GET|' + url;
  calls.push(key);
  const f = fx[key];
  if (!f || f.throw) throw new Error('network');
  const body = f.json !== undefined ? JSON.stringify(f.json) : f.rep ? Buffer.alloc(f.rep[1], f.rep[0]) : Buffer.from(f.b64, 'base64');
  return new Response(body, { status: f.status || 200, headers: f.json !== undefined ? { 'content-type': 'application/json' } : (f.ct ? { 'content-type': f.ct } : {}) });
};
process.env.YTDLP = '/tmp/oracle2/fake-ytdlp.mjs';
const m = await import('/tmp/oracle/app/core/addons/jetstream/index.js');
const files = ['jetstream-history.json', 'jetstream-subs.json', 'jetstream-dead.json', 'jetstream-blocked.json'];
const gold = [];
for (const st of scen) {
  NOW = st.now; calls = [];
  try { fs.unlinkSync('/tmp/oracle2/ytdlp-calls.log'); } catch {}
  if (st.setup) for (const [f, v] of Object.entries(st.setup)) fs.writeFileSync(DATA + '/' + f, JSON.stringify(v));
  const req = { url: '/api/apps/jetstream' + st.sub, method: st.method || 'GET', __body: '', headers: {} };
  let out = { status: null, body: '' };
  const chunks = [];
  const res = { writeHead(s, h) { out.status = s; out.h = h; }, write(b) { chunks.push(Buffer.from(b)); return true; }, end(b) { if (b) chunks.push(Buffer.from(b)); out.buf = Buffer.concat(chunks); }, on() { return res; }, once() { return res; }, emit() { return true; } };
  const sendJson = (r, s, o) => { out.status = s; out.body = JSON.stringify(o); };
  try { await m.register(req, res, { url: new URL('http://x' + req.url), sendJson, guard: { trackBytes() {} }, session: { user: st.user || 'luke' } }); } catch (e) { out.status = 'THROW'; }
  await new Promise((r) => setTimeout(r, 60));   // let fire-and-forget disk writes land
  if (out.buf) { out.sha = crypto.createHash('sha256').update(out.buf).digest('hex'); out.len = out.buf.length; out.ct = out.h?.['content-type']; out.cc = out.h?.['cache-control']; delete out.buf; delete out.h; }
  let yd = []; try { yd = fs.readFileSync('/tmp/oracle2/ytdlp-calls.log', 'utf8').trim().split('\n').filter(Boolean); } catch {}
  const stores = {}; for (const f of files) { try { stores[f] = JSON.parse(fs.readFileSync(DATA + '/' + f, 'utf8')); } catch {} }
  gold.push({ step: st, status: out.status, body: out.body, sha: out.sha, len: out.len, ct: out.ct, cc: out.cc, calls: [...calls, ...yd].sort(), stores });
}
fs.writeFileSync(process.argv[3], JSON.stringify(gold));
process.exit(0);
