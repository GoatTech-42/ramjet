import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
const worker = new URL('../core/embed-worker.mjs', import.meta.url);
async function exercise(close) {
  const child = spawn(process.execPath, [worker.pathname], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', d => errors += d);
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout });
  const line = once(lines, 'line');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20000);
  try {
    child.stdin.write(JSON.stringify({ id: 1, text: 'embedding lifecycle fixture' }) + '\n');
    const [raw] = await line;
    const row = JSON.parse(raw);
    assert.equal(row.id, 1);
    assert.equal(row.v?.length, 384, errors);
    assert.ok(row.v.every(Number.isFinite));
    close(child);
    const [code, signal] = await exit;
    assert.equal(code, 0, errors);
    assert.equal(signal, null);
  } finally { clearTimeout(deadline); lines.close(); if (child.exitCode === null) child.kill(); }
}
test('embedding worker returns 384 finite values and exits on parent IPC disconnect', { timeout: 25000 }, () => exercise(c => c.disconnect()));
test('embedding worker exits on stdin close', { timeout: 25000 }, () => exercise(c => c.stdin.end()));
