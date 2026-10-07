import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveSerp,serpSafe,createSerpImages} from '../core/serp-images.js';
test('rolling 31day and hourly caps refuse before network, retain full CSE state',()=>{
 const now=1e12;let state={last:55,stamps:[9],serp:{stamps:[]}};
 for(let i=0;i<200;i++){state=reserveSerp(state,now+i*900000);assert(state);}
 assert.equal(state.last,55);assert.equal(state.stamps[0],9);assert.equal(reserveSerp(state,now+200*900000),null);
 assert(reserveSerp(state,now+32*86400000));
 const hour={serp:{stamps:Array(40).fill(now)}};assert.equal(reserveSerp(hour,now+1),null);
 assert.equal(serpSafe(0),'off');assert.equal(serpSafe(1),'active');assert.equal(serpSafe(2),'active');
});
test('optional adapter retains public fields, maps paging/safe, counts failures and cools down',async()=>{
 let state={last:12},calls=0,failed=0,url;const now=()=>1e12;
 const options={key:()=> 'fixture-key',load:()=>state,save:s=>state=s,now,fail:()=>failed++,fetcher:async u=>{calls++;url=new URL(u);return new Response(JSON.stringify({images_results:[{title:'Image',link:'https://example.com/',original:'https://example.com/image.png',thumbnail:'https://example.com/thumb.png',serpapi_link:'secret-bearing-unused'}]}));}};
 const images=createSerpImages(options);const rows=await images('q',2,1);assert.equal(calls,1);assert.equal(url.searchParams.get('ijn'),'1');assert.equal(url.searchParams.get('safe'),'active');assert.equal(rows[0].engine,'google images (SerpApi)');assert(!JSON.stringify(rows).includes('fixture-key'));assert.equal(state.last,12);
 const bad=createSerpImages({...options,fetcher:async()=>new Response('{}',{status:500})});assert.equal(await bad('q',1,0),null);assert.equal(failed,1);assert.equal(state.serp.stamps.length,2);assert.equal(await bad('q',1,0),null);assert.equal(state.serp.stamps.length,2);
 assert.equal(await createSerpImages({...options,key:()=>''})('q',1,0),null);
});
