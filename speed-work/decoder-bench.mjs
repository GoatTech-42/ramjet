import { gzipSync, brotliCompressSync, deflateSync, createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const targetBytes = Number(process.env.BENCH_MB || 16) * 1024 * 1024;
const rounds = Number(process.env.BENCH_ROUNDS || 5);
const seed = Buffer.from(Array.from({ length: 4096 }, (_, i) => `<article id="p${i}"><a href="/news/${i}">story ${i * 37}</a><p>Local decoder benchmark text and markup ${i % 19}.</p></article>\n`).join(''));
const raw = Buffer.alloc(targetBytes); for (let p = 0; p < raw.length; p += seed.length) seed.copy(raw, p, 0, Math.min(seed.length, raw.length - p));
const digest = createHash('sha256').update(raw).digest('hex');
const cases = [['gzip', gzipSync(raw), createGunzip], ['br', brotliCompressSync(raw), createBrotliDecompress], ['deflate', deflateSync(raw), createInflate]];
const rows = [];
for (const [encoding, packed, factory] of cases) {
  const samples = new Map([16384, 65536, 262144].map(n => [n, []]));
  for (let round = -1; round < rounds; round++) {
    // Rotate size order so a warming CPU does not favor one configuration.
    const sizes = [16384, 65536, 262144]; if (round % 2 === 0) sizes.reverse();
    for (const chunkSize of sizes) {
      const start = performance.now(); let bytes = 0, chunks = 0; const hash = createHash('sha256');
      const source = Readable.from((function* () { for (let p = 0; p < packed.length; p += 65536) yield packed.subarray(p, p + 65536); })());
      for await (const c of source.pipe(factory({ chunkSize }))) { bytes += c.length; chunks++; hash.update(c); }
      if (bytes !== raw.length || hash.digest('hex') !== digest) throw Error('decoded bytes differ');
      if (round >= 0) samples.get(chunkSize).push({ ms: performance.now() - start, chunks });
    }
  }
  for (const [chunkSize, values] of samples) { const sorted = values.map(v => v.ms).sort((a,b) => a-b); rows.push({ encoding, chunkSize, decodedBytes: raw.length, wireBytes: packed.length, medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(2), medianChunks: values.map(v => v.chunks).sort((a,b) => a-b)[Math.floor(values.length / 2)] }); }
}
console.log(JSON.stringify({ node: process.version, rounds, note: 'Local decoder microbenchmark, not page load or production throughput. Every run verifies SHA-256.', rows }, null, 2));
