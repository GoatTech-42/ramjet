import {withTempServer}from'./fixtures/start-server.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {writeFileSync}from'node:fs';import{join}from'node:path';import{Auth}from'../core/auth.js';
test('authenticated Shortcut images reuse native cache, preserve source/safe separation, reject unauthenticated',async()=>withTempServer((root)=>{
 const auth=new Auth(root);auth.createUser('reviewer','fixture-password');
 const key=JSON.stringify(['ddg-direct-v1','fixture',1,1]);writeFileSync(join(root,'ddg-images-cache.json'),JSON.stringify({[key]:{expires:Date.now()+60000,data:{results:[{title:'DDG fixture',url:'https://example.com/',img_src:'https://example.com/image.jpg',thumbnail_src:'https://example.com/thumb.jpg',engine:'duckduckgo images'}]}}}));
},async({base})=>{
  const path=base+'/api/lite/imgsearch?q=fixture';assert.equal((await fetch(path)).status,401);
  const header={authorization:'Basic '+Buffer.from('reviewer:fixture-password').toString('base64')};const response=await fetch(path,{headers:header});assert.equal(response.status,200);const data=await response.json();assert.equal(data.results[0].source,'duckduckgo');assert.equal(data.results[0].site,'example.com');assert.equal(data.page,1);assert.equal(data.results[0].title,'DDG fixture');
}));
