import test from 'node:test';import assert from 'node:assert/strict';
import {createQwantImages,createImageCache} from '../core/qwant-images.js';
test('direct Qwant only, native page/mode mapping and bounded safe fields',async()=>{
 for(const safe of [0,1,2]){let url,admissions=0;const search=createQwantImages({admit:async()=>{admissions++;return true;},fetcher:async raw=>{url=new URL(raw);return new Response(JSON.stringify({status:'success',data:{result:{items:[{title:'Fixture',url:'https://example.com/',media:'https://example.com/image.png',thumbnail:'https://example.com/thumb.png'}]}}}));}});const result=await search('goat',2,safe);assert.equal(url.hostname,'api.qwant.com');assert.equal(url.searchParams.get('offset'),'50');assert.equal(url.searchParams.get('safesearch'),String(safe));assert.equal(admissions,1);assert.equal(result.results[0].engine,'qwant images');}
});
test('repeated/concurrent/reloaded cache avoids admission; safe levels separate; failures cache',async()=>{
 let saved={},calls=0,clock=1000;const options={load:()=>saved,save:s=>saved=s,now:()=>clock,search:async()=>{calls++;return {results:[{title:'fixture'}]};}};const search=createImageCache(options);await Promise.all([search('goat',1,1),search('GOAT',1,1)]);assert.equal(calls,1);await createImageCache(options)('goat',1,1);assert.equal(calls,1);await search('goat',1,0);assert.equal(calls,2);clock+=1800001;await search('goat',1,1);assert.equal(calls,3);
 const bad=createImageCache({...options,load:()=>({}),search:async()=>{calls++;throw Error('private provider detail');}});await assert.rejects(bad('bad',1,1),/unavailable/);await assert.rejects(bad('bad',1,1),/unavailable/);assert.equal(calls,4);
});
test('denied admission and bot wall do not trigger hidden fallback',async()=>{
 let calls=0,failures=0;const denied=createQwantImages({admit:async()=>false,fetcher:()=>{calls++;assert.fail();}});await assert.rejects(denied('q',1,0));assert.equal(calls,0);
 const blocked=createQwantImages({fail:()=>failures++,fetcher:async()=>{calls++;return new Response(JSON.stringify({status:'error',url:'captcha'}));}});await assert.rejects(blocked('q',1,0),/unavailable/);assert.equal(calls,1);assert.equal(failures,1);
});
