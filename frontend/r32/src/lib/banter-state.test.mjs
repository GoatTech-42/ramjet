// State-list failures must not look like empty chats. Evaluate the real component
// script with deferred API replies; DOM visibility additionally needs compiled UI QA.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../pages/banter/Banter.svelte',import.meta.url),'utf8');
function harness(){
 const pending=[];
 const script=source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;\n/gm,'').replace(/\$state\(/g,'(').replace(/\$derived\(/g,'(').replace(/\$effect\(/g,'stubEffect(');
 const c=new Function('onMount','tick','api','errCopy','stubEffect',script+';return {loadState,get:()=>({stateErr,stateKnown,stateLoading,deferred,loaded,rooms,err})};')(()=>{},async()=>{},()=>new Promise(res=>pending.push(res)),(r,f)=>r.status===501?"this part isn't ready yet.":f,()=>{});
 return {c,pending};
}
const ok=(title='room')=>({ok:true,data:{me:'fixture',rooms:[{id:1,title}],friends:[],incoming:[],outgoing:[]}});
test('initial failure is distinct from a real empty list and action errors',async()=>{
 const {c,pending}=harness(); const p=c.loadState();pending[0]({ok:false,status:503});await p;
 assert.equal(c.get().loaded,true);assert.equal(c.get().stateKnown,false);assert.ok(c.get().stateErr);assert.equal(c.get().err,'');assert.equal(c.get().stateLoading,false);
});
test('successful retry clears state error and accepts an empty list as known',async()=>{
 const {c,pending}=harness();let p=c.loadState();pending[0]({ok:false,status:503});await p;
 p=c.loadState();assert.equal(c.get().stateLoading,true);pending[1]({...ok(),data:{...ok().data,rooms:[]}});await p;
 assert.equal(c.get().stateErr,'');assert.equal(c.get().stateKnown,true);assert.deepEqual(c.get().rooms,[]);
});
test('501 can recover on explicit retry',async()=>{
 const {c,pending}=harness();let p=c.loadState();pending[0]({ok:false,status:501});await p;assert.equal(c.get().deferred,true);
 p=c.loadState();pending[1](ok());await p;assert.equal(c.get().deferred,false);assert.equal(c.get().stateErr,'');
});
test('refresh failure preserves last known list',async()=>{
 const {c,pending}=harness();let p=c.loadState();pending[0](ok('retained'));await p;
 p=c.loadState();pending[1]({ok:false,status:503});await p;assert.equal(c.get().stateKnown,true);assert.equal(c.get().rooms[0].title,'retained');assert.ok(c.get().stateErr);
});
test('late old failure cannot replace newer success',async()=>{
 const {c,pending}=harness();const a=c.loadState(),b=c.loadState();pending[1](ok('new'));await b;pending[0]({ok:false,status:501});await a;
 assert.equal(c.get().stateErr,'');assert.equal(c.get().deferred,false);assert.equal(c.get().rooms[0].title,'new');
});
test('late old success cannot erase newer failure or mark list known',async()=>{
 const {c,pending}=harness();const a=c.loadState(),b=c.loadState();pending[1]({ok:false,status:503});await b;pending[0](ok('old'));await a;
 assert.ok(c.get().stateErr);assert.equal(c.get().stateKnown,false);assert.deepEqual(c.get().rooms,[]);
});
test('obsolete completion cannot release newest loading state',async()=>{
 const {c,pending}=harness();const a=c.loadState(),b=c.loadState();pending[0](ok('old'));await a;assert.equal(c.get().stateLoading,true);pending[1](ok('new'));await b;assert.equal(c.get().stateLoading,false);
});
test('sidebar has explicit error and retry paths rather than empty-list-only fallback',()=>{
 const aside=source.split('<aside')[1].split('</aside>')[0];assert.ok(aside.includes('!stateKnown && stateErr'));assert.ok(aside.includes('showing your last loaded chats.'));assert.equal((aside.match(/onclick={loadState}/g)||[]).length,2);
});
