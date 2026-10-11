import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{spawn}from'node:child_process';import{once}from'node:events';import{Auth}from'../core/auth.js';
test('authenticated Shortcut images reuse native cache, preserve source/safe separation, reject unauthenticated',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rj-shortcut-'));const auth=new Auth(root);auth.createUser('reviewer','fixture-password');
 const key=JSON.stringify(['ddg-direct-v1','fixture',1,1]);writeFileSync(join(root,'ddg-images-cache.json'),JSON.stringify({[key]:{expires:Date.now()+60000,data:{results:[{title:'DDG fixture',url:'https://example.com/',img_src:'https://example.com/image.jpg',thumbnail_src:'https://example.com/thumb.jpg',engine:'duckduckgo images'}]}}}));
 const child=spawn(process.execPath,['core/index.js'],{env:{...process.env,RJ_DATA:root,RJ_PORT:'15327',RJ_HOST:'127.0.0.1',RJ_ADMIN:'reviewer'},stdio:'ignore'});try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:15327/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const path='http://127.0.0.1:15327/api/lite/imgsearch?q=fixture';assert.equal((await fetch(path)).status,401);
  const header={authorization:'Basic '+Buffer.from('reviewer:fixture-password').toString('base64')};const response=await fetch(path,{headers:header});assert.equal(response.status,200);const data=await response.json();assert.equal(data.results[0].source,'duckduckgo');assert.equal(data.results[0].site,'example.com');assert.equal(data.page,1);assert.equal(data.results[0].title,'DDG fixture');
 }finally{child.kill();await once(child,'exit');rmSync(root,{recursive:true,force:true});}
});
