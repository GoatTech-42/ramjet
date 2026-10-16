// profiles the proxy's hot paths against a locally booted server.
// run: node bench/profile-server.mjs [--quick]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const QUICK = process.argv.includes('--quick');
const dir = mkdtempSync(join(tmpdir(), 'rj-prof-'));
writeFileSync(join(dir, 'users.json'), '{}');
writeFileSync(join(dir, 'config.json'), JSON.stringify({ requireApproval: false }));
const { createServer } = await import('node:net');
const port = await new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const base = `http://127.0.0.1:${port}`;
const proc = spawn('node', ['core/index.js'], { env: { ...process.env, RJ_HOST: '127.0.0.1', RJ_PORT: String(port), RJ_DATA: dir }, stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
proc.stdout.on('data', (d) => { if (String(d).includes('ramjet2 on')) up = true; });
for (let i = 0; i < 100 && !up; i++) await sleep(100);
if (!up) { console.error('no boot'); process.exit(1); }

await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'prof', password: 'prof-pass-123' }) });
const lr = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'prof', password: 'prof-pass-123' }) });
const cookie = lr.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

// find two hashed bundles: biggest + smallest
const assets = readdirSync('web/dist/assets').filter((f) => f.endsWith('.js')).map((f) => [f, statSync('web/dist/assets/' + f).size]).sort((a, b) => b[1] - a[1]);
const bigAsset = '/assets/' + assets[0][0], smallAsset = '/assets/' + assets[assets.length - 1][0];

async function time(path, opts = {}, n = QUICK ? 30 : 200) {
  const lat = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const r = await fetch(base + path, { headers: { cookie, ...opts.headers } });
    await r.arrayBuffer();
    lat.push(performance.now() - t0);
  }
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))].toFixed(2);
  return `p50 ${p(0.5)}ms p95 ${p(0.95)}ms`;
}

console.log('--- full-response / asset fetch (headers + body) (n=' + (QUICK ? 30 : 200) + ') ---');
console.log('page /login (public):        ', await time('/login'));
console.log('page / (authed):             ', await time('/'));
console.log('page /amp (authed):          ', await time('/amp'));
console.log(`asset big ${(assets[0][1]/1e3).toFixed(0)}KB br:    `, await time(bigAsset, { headers: { 'accept-encoding': 'br' } }));
console.log(`asset small ${(assets[assets.length-1][1]/1e3).toFixed(1)}KB ident:`, await time(smallAsset));
console.log('palette.js br:               ', await time('/cloak/palette.js', { headers: { 'accept-encoding': 'br' } }));

console.log('--- search (external): 5 cold (distinct queries) then 5 warm (first query repeated) ---');
const COLDS = {
  'amp search    ': ['lofi%20beats', 'jazz%20vibes', 'ambient%20sleep', 'synthwave%2084', 'piano%20relax'].map((q) => '/api/apps/amp/search?q=' + q),
  'amp artist    ': ['daft%20punk', 'justice', 'gorillaz', 'air%20french', 'deadmau5'].map((q) => '/api/apps/amp/artist?src=yt&name=' + q),
  'jetstream search': ['lofi', 'jazz', 'ambient', 'synthwave', 'piano'].map((q) => '/api/apps/jetstream/search?q=' + q),
};
for (const [label, paths] of Object.entries(COLDS)) {
  const one = async (p) => {
    const t0 = performance.now();
    const r = await fetch(base + p, { headers: { cookie } });
    await r.json();
    return `${(performance.now() - t0).toFixed(0)}ms/${r.status}`;
  };
  const cold = [], warm = [];
  for (const p of paths) cold.push(await one(p));
  for (let i = 0; i < 5; i++) warm.push(await one(paths[0]));
  console.log(`${label}: cold [${cold.join(' ')}] warm [${warm.join(' ')}]`);
}
proc.kill('SIGKILL');
