// Fetch the exact public MiniLM artifacts used by the embedding worker.
// Weights stay out of Git. Existing files must match before they are reused.
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
const root = new URL('../models/', import.meta.url);
const files = [
  ['onnx/model_quantized.onnx', 'minilm.onnx', 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1'],
  ['vocab.txt', 'vocab.txt', '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3'],
];
const sha = b => createHash('sha256').update(b).digest('hex');
await mkdir(root, { recursive: true });
for (const [remote, name, expected] of files) {
  const dest = new URL(name, root);
  let existing;
  try { existing = await readFile(dest); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (existing) {
    if (sha(existing) !== expected) throw Error(`Refusing mismatched model file: ${name}`);
    console.log(`verified ${name} ${expected}`);
    continue;
  }
  const response = await fetch(`https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/${revision}/${remote}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error(`Model fetch failed: ${name} HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 40 * 1024 * 1024 || sha(bytes) !== expected) throw Error(`Model checksum mismatch: ${name}`);
  const tmp = fileURLToPath(dest) + '.part';
  try { await writeFile(tmp, bytes); await rename(tmp, dest); } finally { await rm(tmp, { force: true }); }
  console.log(`downloaded and verified ${name} ${expected}`);
}
