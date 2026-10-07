import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJson, writeJson } from '../core/util.js';

test('JSON missing is distinct from corrupt or unreadable; writes never replace corrupt state', () => {
  const root = mkdtempSync(join(tmpdir(), 'rj-storage-'));
  try {
    const p = join(root, 'state.json');
    assert.deepEqual(readJson(p, {}), {});
    writeJson(p, { saved: true });
    assert.deepEqual(readJson(p, {}), { saved: true });
    writeFileSync(p, '{broken');
    assert.throws(() => readJson(p, {}), { code: 'RJ_STORE_INVALID' });
    assert.throws(() => writeJson(p, {}), { code: 'RJ_STORE_INVALID' });
    assert.equal(readFileSync(p, 'utf8'), '{broken');
    try { readJson(p, {}); } catch(error) { assert.equal(error.cause, undefined);assert(!String(error.stack).includes('{broken')); }
    mkdirSync(join(root, 'directory'));
    assert.throws(() => readJson(join(root, 'directory'), {}), { code: 'RJ_STORE_INVALID' });
  } finally { rmSync(root, { recursive: true }); }
});

test('two data roots stay isolated across fresh processes and restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'rj-roots-'));
  try {
    const code = `import {dataPath,DATA_ROOT} from './core/data.js'; import {writeJson,readJson} from './core/util.js'; import assert from 'node:assert/strict'; assert.throws(()=>dataPath('../escape')); const p=dataPath('nested','state.json'); if(process.env.WRITE)writeJson(p,{value:process.env.WRITE}); console.log(JSON.stringify(readJson(p,null)));`;
    const run = (name, value) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, RJ_DATA: join(root,name), WRITE: value || '' }, encoding: 'utf8' }).trim();
    assert.equal(run('one','one'), '{"value":"one"}');
    assert.equal(run('two'), 'null');
    assert.equal(run('two','two'), '{"value":"two"}');
    assert.equal(run('one'), '{"value":"one"}');
  } finally { rmSync(root, { recursive: true }); }
});


test('chat import does not create a new key over existing encrypted state or corrupt key/state', () => {
  const root = mkdtempSync(join(tmpdir(), 'rj-chat-invalid-'));
  const dir = join(root, 'banter2');
  try {
    mkdirSync(dir);writeFileSync(join(dir,'state.json'), '{}');
    const run = () => execFileSync(process.execPath, ['--input-type=module','-e', "await import('./core/addons/banter/index.js');"], {env:{...process.env,RJ_DATA:root},stdio:'pipe'});
    assert.throws(run);assert.throws(()=>readFileSync(join(dir,'key')), {code:'ENOENT'});
    writeFileSync(join(dir,'key'), 'invalid');assert.throws(run);assert.equal(readFileSync(join(dir,'key'),'utf8'),'invalid');
    writeFileSync(join(dir,'key'), 'ab'.repeat(32));writeFileSync(join(dir,'state.json'), '{broken');assert.throws(run);assert.equal(readFileSync(join(dir,'state.json'),'utf8'),'{broken');
  } finally {rmSync(root,{recursive:true});}
});
