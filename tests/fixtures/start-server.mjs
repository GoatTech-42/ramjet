import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const waitExit = async (child, ms) => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exit = once(child, 'exit').then(() => true, () => true);
  const timeout = new Promise((r) => setTimeout(() => r(false), ms));
  return Promise.race([exit, timeout]);
};

export async function startServer(root, env = {}) {
  const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname], {
    cwd: new URL('../../', import.meta.url),
    env: { ...process.env, RJ_HOST: '127.0.0.1', RJ_PORT: '0', RJ_DATA: root, RJ_ADMIN: 'reviewer', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', b => { log = (log + b).slice(-2000); });
  // SIGTERM, then SIGKILL when the child ignores it - a stuck server must
  // never hang the suite.
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (!(await waitExit(child, 3000))) {
      child.kill('SIGKILL');
      await waitExit(child, 3000);
    }
  };
  try {
    const base = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(Error('fixture startup timeout: ' + log)), 10000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(Error('fixture exited ' + code + ': ' + log)); });
      child.stdout.on('data', b => { output += b; const m = /TEST_READY (\d+)/.exec(output); if (m) { clearTimeout(timer); resolve('http://127.0.0.1:' + m[1]); } });
    });
    return { child, base, stop };
  } catch (e) { await stop(); throw e; }
}

// Cleanup scope: owns the temp root's whole lifecycle. setup(root) runs
// before the server starts (seed caches, users); fn never runs on startup
// failure; the server is stopped and the root removed on every exit path,
// so a failed startup cannot leak a mkdtemp root.
export async function withTempServer(setup, fn, env = {}) {
  if (fn === undefined) { fn = setup; setup = null; }
  const root = mkdtempSync(join(tmpdir(), 'rj-fixture-'));
  let server = null;
  try {
    if (setup) await setup(root);
    server = await startServer(root, env);
    return await fn({ root, base: server.base });
  } finally {
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}
