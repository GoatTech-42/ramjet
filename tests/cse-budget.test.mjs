import test from 'node:test';
import assert from 'node:assert/strict';
import { createCseGate } from '../core/cse-gate.js';

test('shared gate refuses call 25, spaces concurrent admissions and releases after window', async () => {
  let clock=1000000; const saved=[];
  const gate=createCseGate({now:()=>clock,sleep:async ms=>{clock+=ms;},save:s=>saved.push(s)});
  const approvals=await Promise.all(Array.from({length:30},()=>gate.admit()));
  assert.equal(approvals.filter(Boolean).length,24);assert.equal(gate.left(),0);
  assert(saved.every((s,i)=>i===0||s.last-saved[i-1].last>=3000));
  clock+=600000;assert.equal(await gate.admit(),true);
});
test('cooldown rejects queued/repeated calls and survives state reload', async()=>{
  let clock=1000000, state;const options={now:()=>clock,sleep:async ms=>clock+=ms,save:s=>state=s};
  const gate=createCseGate(options);assert(await gate.admit());gate.fail();
  assert.equal(await gate.admit(),false);assert.equal(gate.cooldown(),600000);
  const restarted=createCseGate({...options,state});assert.equal(await restarted.admit(),false);
  clock+=600000;assert(await restarted.admit());
});
test('budget survives restart and an exhausted gate does not wait or admit',async()=>{
  const state={last:1000000,stamps:Array(24).fill(1000000)};let slept=false;
  const gate=createCseGate({state,now:()=>1000100,sleep:async()=>{slept=true;}});
  assert.equal(await gate.admit(),false);assert.equal(slept,false);
});
