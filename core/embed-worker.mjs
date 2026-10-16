// MiniLM-L6-v2 embedding worker: JSON lines in, JSON lines out.
// {"id":1,"text":"..."} -> {"id":1,"v":[384 normalized floats]}
import { readFileSync } from 'node:fs';
import readline from 'node:readline';

// IPC disconnect or a closed input pipe means the parent is gone.
process.once('disconnect', () => process.exit(0));
process.stdin.once('end', () => process.exit(0));
process.stdin.once('close', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));

const MODEL = new URL('../models/minilm.onnx', import.meta.url).pathname;
const VOCAB = new URL('../models/vocab.txt', import.meta.url).pathname;
const DIM = 384;

const vocab = new Map();
readFileSync(VOCAB, 'utf8').split('\n').forEach((t, i) => { if (t) vocab.set(t, i); });
const UNK = vocab.get('[UNK]') ?? 100;

function tokenize(text) {
  const words = text.toLowerCase().replace(/([^\w\s])/g, ' $1 ').split(/\s+/).filter(Boolean);
  const ids = [101];
  for (const w of words) {
    if (ids.length >= 126) break;
    if (vocab.has(w)) { ids.push(vocab.get(w)); continue; }
    let start = 0; const pieces = []; let ok = true;
    while (start < w.length) {
      let end = w.length; let hit = false;
      while (end > start) {
        const piece = (start === 0 ? '' : '##') + w.slice(start, end);
        if (vocab.has(piece)) { pieces.push(vocab.get(piece)); start = end; hit = true; break; }
        end--;
      }
      if (!hit) { ok = false; break; }
    }
    if (!ok) ids.push(UNK); else ids.push(...pieces);
  }
  ids.push(102);
  return ids;
}

const ort = await import('onnxruntime-node');
const session = await ort.InferenceSession.create(MODEL, { executionProviders: ['cpu'] });

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  if (!line.trim()) continue;
  let out;
  try {
    const { id, text } = JSON.parse(line);
    const ids = tokenize(String(text || '').slice(0, 1000));
    const n = ids.length;
    const inputIds = new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, n]);
    const mask = new ort.Tensor('int64', BigInt64Array.from(new Array(n).fill(1n)), [1, n]);
    const typeIds = new ort.Tensor('int64', new BigInt64Array(n), [1, n]);
    const res = await session.run({ input_ids: inputIds, attention_mask: mask, token_type_ids: typeIds });
    const emb = res.last_hidden_state.data;
    const vec = new Float64Array(DIM);
    for (let t = 0; t < n; t++) for (let d = 0; d < DIM; d++) vec[d] += emb[t * DIM + d];
    for (let d = 0; d < DIM; d++) vec[d] /= n;
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    out = { id, v: Array.from(vec, (x) => Math.round((x / norm) * 10000) / 10000) };
  } catch (e) {
    out = { id: -1, error: String((e && e.message) || e) };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
