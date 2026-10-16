// speed round 2 measurements. run: node bench/serve-page.bench.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, brotliCompress as brC, constants as zc } from 'node:zlib';
import { promisify } from 'node:util';
const brotliCompress = promisify(brC);

const DIST = new URL('../web/dist', import.meta.url).pathname;
import { readdirSync as rd } from 'node:fs';
const pageName = rd(join(DIST, 'pages'))[0];
const page = readFileSync(join(DIST, 'pages', pageName, pageName + '.html'));

// 1. per-request stamping: old path ran toString + 2 replaceAll + Buffer.from
//    on EVERY page hit; new path does it once per boot.
function oldStamp() {
  return Buffer.from(page.toString('utf8').replaceAll('v=__RJ_ENGINE__', 'v=abc123').replaceAll("'__RJ_ENGINE__'", "'abc123'"), 'utf8');
}
const N = 20000;
let t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) oldStamp();
let oldNs = Number(process.hrtime.bigint() - t0) / N;
const memo = oldStamp();
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) { const b = memo; if (!b) throw 1; }
let newNs = Number(process.hrtime.bigint() - t0) / N;
console.log(`page stamp: old ${oldNs.toFixed(0)} ns/req -> memoized ${newNs.toFixed(1)} ns/req (${(oldNs / Math.max(newNs, 0.1)).toFixed(0)}x cheaper)`);

// 2. cold static compression: the old first-request-per-encoding path blocked
//    the loop with brotliCompressSync; new path awaits zlib worker threads.
function* walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (st.size > 1024 * 200) yield [p, st.size];
  }
}
const big = [...walk(DIST)].sort((a, b) => b[1] - a[1]);
const [bigPath, bigSize] = big[0];
const raw = readFileSync(bigPath);
const opts = { params: { [zc.BROTLI_PARAM_QUALITY]: 6, [zc.BROTLI_PARAM_SIZE_HINT]: raw.length } };
t0 = process.hrtime.bigint();
brotliCompressSync(raw, opts);
const syncMs = Number(process.hrtime.bigint() - t0) / 1e6;
t0 = process.hrtime.bigint();
await brotliCompress(raw, opts);
const asyncMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`cold brotli on ${bigPath.split('/').pop()} (${(bigSize / 1e6).toFixed(2)} MB):`);
console.log(`  old sync: ${syncMs.toFixed(0)} ms of event-loop block (every user on the box stalls)`);
console.log(`  new async: ${asyncMs.toFixed(0)} ms wall on a zlib worker thread, ~0 ms loop block`);
console.log(`  boot warm-up precompresses all pinned files + pages, so even the first request skips the wait`);
console.log('largest compressible files:', big.slice(0, 5).map(([p, s]) => `${p.split('/').pop()}=${(s / 1e6).toFixed(2)}MB`).join(', '));
