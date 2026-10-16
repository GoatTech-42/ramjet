import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const configured of ['', 'owner-fixture, backup-fixture']) {
  test('byte exemptions are explicit configuration: ' + (configured ? 'configured' : 'empty default'), () => {
    const source = `
      import { Guard } from './core/guard.js';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      const root = mkdtempSync(join(tmpdir(), 'rj-guard-config-'));
      try {
        const guard = new Guard(root);
        console.log(JSON.stringify(['owner-fixture', 'backup-fixture', 'ordinary-fixture'].map(n => guard.bytesLeft(n))));
      } finally { rmSync(root, { recursive: true, force: true }); }
    `;
    const env = { ...process.env };
    if (configured) env.RJ_BYTE_EXEMPT = configured;
    else delete env.RJ_BYTE_EXEMPT;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: new URL('../', import.meta.url), env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const normal = 1024 * 1024 * 1024;
    assert.deepEqual(JSON.parse(result.stdout), configured ? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, normal] : [normal, normal, normal]);
  });
}
