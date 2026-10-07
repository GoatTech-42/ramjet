import test from 'node:test';
import assert from 'node:assert/strict';
import { imageSources } from '../core/search-upstream.js';
const rows=engine=>({results:[{engine,title:engine,url:'https://example.com/',img_src:'https://example.com/image.png'}]});
test('Qwant primary success never calls Google, SerpApi or Brave; safe passes unchanged',async()=>{
 const calls=[];const data=await imageSources('q',2,1,{qwant:{admit:async()=>true,fail:()=>assert.fail()},admitCse:()=>assert.fail(),backup:()=>assert.fail(),read:async(q,p,c,s,e)=>{calls.push([p,s,e]);return rows(e);}});
 assert.equal(data.data.results[0].engine,'qwant images');assert.deepEqual(calls,[[2,1,'qwant images']]);
});
test('Qwant failure then Google success stops before API/Brave',async()=>{
 let failures=0;const calls=[];const data=await imageSources('q',1,0,{qwant:{admit:async()=>true,fail:()=>failures++},admitCse:async()=>true,failCse:()=>assert.fail(),backup:()=>assert.fail(),read:async(q,p,c,s,e)=>{calls.push(e);return e==='qwant images'?{results:[],unresponsive_engines:[['qwant images','CAPTCHA']]}:rows(e);}});
 assert.equal(failures,1);assert.deepEqual(calls,['qwant images','google cse images']);assert.equal(data.data.results[0].engine,'google cse images');
});
test('Google unavailable uses API before Brave; all unavailable reaches Brave',async()=>{
 const options={qwant:{admit:async()=>false},admitCse:async()=>false,backup:async()=>rows('serp').results,brave:{admit:async()=>true,fail:()=>assert.fail()},read:()=>assert.fail()};
 assert.equal((await imageSources('q',1,2,options)).data.results[0].engine,'serp');
 const calls=[];assert.equal((await imageSources('q',1,2,{...options,backup:async()=>null,read:async(q,p,c,s,e)=>{calls.push([e,s]);return rows(e);}})).data.results[0].engine,'brave images');assert.deepEqual(calls,[['brave images',2]]);
});
