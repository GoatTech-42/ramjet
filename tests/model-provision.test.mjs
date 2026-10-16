import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('clean Docker provisions pinned weights instead of copying untracked host models', () => {
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../scripts/provision-models.mjs', import.meta.url), 'utf8');
  assert.match(docker, /RUN node scripts\/provision-models\.mjs/);
  assert.match(docker, /COPY --from=build \/app\/models \.\/models/);
  assert.doesNotMatch(docker, /^COPY models /m);
  assert.match(script, /afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1/);
  assert.match(script, /07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3/);
  assert.match(script, /sha\(bytes\) !== expected/);
  assert.match(script, /Refusing mismatched model file/);
});

test('container avoids optional CUDA downloads for the CPU-only embedding worker', () => {
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../core/embed-worker.mjs', import.meta.url), 'utf8');
  assert.match(docker, /ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci/);
  assert.match(worker, /executionProviders: \['cpu'\]/);
});
