import test from 'node:test';import assert from 'node:assert/strict';import{lazySocketTransport}from'../web/src/lib/lazy-transport.js';
test('HTTP/meta needs no Epoxy; concurrent remote sockets share init and preserve pair/callback contract',async()=>{
 let loads=0,connections=0;const sent=[];const transport=lazySocketTransport(async()=>{loads++;return {connect:()=>{connections++;return [data=>sent.push(data),(code,reason)=>sent.push([code,reason])];}};});await transport.meta();assert.equal(loads,0);const a=transport.connect(),b=transport.connect();await a[0]('payload');await b[1](1000,'done');assert.equal(loads,1);assert.equal(connections,2);assert.deepEqual(sent,['payload',[1000,'done']]);
});
test('failed lazy init reports error and can retry on new connection',async()=>{
 let calls=0,errors=0;const transport=lazySocketTransport(async()=>{if(++calls===1)throw Error('fixture');return {connect:()=>[()=>{},()=>{}]};});const a=transport.connect(null,null,null,null,null,null,()=>errors++);await assert.rejects(a[0]('payload'));assert.equal(errors,1);await transport.connect()[0]('retry');assert.equal(calls,2);
});
